import {isDeepStrictEqual} from 'node:util'
import type {Pool,PoolClient} from 'pg'
import {WorkError,taskInput,readWorkBudgetPolicy,type WorkBudgetPolicy,type BudgetReservation} from '@teloa/contract'
import {authorizeOwnerWork,type OwnerWorkAuthority} from './twin-execution-consents.ts'
import type {WorkAccessLease} from './work-access.ts'

const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v)
const integer=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0
const identity=(v:unknown):v is string=>typeof v==='string'&&!!v.trim()&&v===v.trim()&&v.length<=256&&!/[\x00-\x1f]/.test(v)
const denied=()=>new WorkError('teloa/forbidden','工作额度不属于本人，或当前工作已暂停。')
const exhausted=()=>new WorkError('teloa/conflict','本次工作的累计额度已用完，请调整额度后继续。')
const invalid=()=>new WorkError('teloa/invalid-input','工作额度请求格式不正确。')
const epochs=new WeakMap<Pool,Map<string,number>>()
const reservationStates=new WeakMap<Pool,Map<string,{state:BudgetReservation['state'];epoch:number}>>()
/** 默认有限；本人可在工作设置确认新额度。闲置等待不消耗模型 token。 */
export const defaultWorkBudgetPolicy:WorkBudgetPolicy=Object.freeze({maxGoalRounds:32,maxTokens:2_000_000,maxElapsedMs:21_600_000,maxConcurrent:4,maxRetries:3,stagnationRounds:3,money:null})
const ownerPolicy:WorkBudgetPolicy={...defaultWorkBudgetPolicy,maxTokens:8_000_000,maxConcurrent:8}
type ReserveInput={budgetAccountId:string;controlGeneration:number;modelRequestId:string;kind:BudgetReservation['kind'];tokens:number;rounds:number}
type SettleInput={reservationId:string;modelRequestId:string;provider?:string|null;providerRequestId:string|null;tokens:number|null;moneyMinorUnits:number|null;currency:string|null;receiptId:string}
function reservation(row:Record<string,any>):BudgetReservation{
 if(!uuid(row.id)||!identity(row.owner_id)||!uuid(row.budget_account_id)||!identity(row.model_request_id)||!integer(row.control_generation)||row.control_generation<1||!integer(row.reserved_tokens)||!integer(row.reserved_rounds)||!['goal','team','routing','retry'].includes(row.kind)||!['reserved','settled','unknown','released'].includes(row.state))throw new WorkError('teloa/storage-corrupt','工作额度回执损坏。')
 return {id:row.id,ownerId:row.owner_id,budgetAccountId:row.budget_account_id,controlGeneration:row.control_generation,modelRequestId:row.model_request_id,providerRequestId:row.provider_request_id,kind:row.kind,reservedTokens:row.reserved_tokens,reservedRounds:row.reserved_rounds,state:row.state}
}
export async function initializeWorkBudgets(pool:Pool):Promise<void>{await pool.query(`
 alter table teloa_work_budget_accounts add column if not exists policy jsonb;
 alter table teloa_work_budget_accounts add column if not exists version integer not null default 1 check(version>0);
 create table if not exists teloa_work_budget_reservations(
  id uuid primary key,owner_id text not null,budget_account_id uuid not null,control_generation integer not null check(control_generation>0),model_request_id text not null,
  kind text not null check(kind in ('goal','team','routing','retry')),reserved_tokens integer not null check(reserved_tokens>=0),reserved_rounds integer not null check(reserved_rounds>=0),
  state text not null check(state in ('reserved','settled','unknown','released')),provider_request_id text,actual_tokens integer check(actual_tokens>=0),money_minor_units bigint,currency text,
  receipt_id text,receipt jsonb,created_at timestamptz not null,settled_at timestamptz,
  unique(owner_id,model_request_id),unique(owner_id,receipt_id),foreign key(owner_id,budget_account_id) references teloa_work_budget_accounts(owner_id,id)
 );
 create table if not exists teloa_work_budget_changes(owner_id text not null,request_id uuid not null,request jsonb not null,result jsonb not null,primary key(owner_id,request_id));
 alter table teloa_work_budget_reservations add column if not exists provider text;
 create unique index if not exists teloa_work_budget_provider_operation on teloa_work_budget_reservations(owner_id,provider,provider_request_id) where provider is not null and provider_request_id is not null;
 create table if not exists teloa_owner_work_budgets(owner_id text primary key,policy jsonb not null,version integer not null default 1 check(version>0));
 create table if not exists teloa_owner_routing_budget_accounts(owner_id text primary key,budget_account_id uuid not null,foreign key(owner_id,budget_account_id) references teloa_work_budget_accounts(owner_id,id));
`)}
export class WorkBudgetService{
 readonly pool:Pool;readonly clock:{id:()=>string;now:()=>string};readonly authority:OwnerWorkAuthority|undefined
 constructor(pool:Pool,clock:{id:()=>string;now:()=>string},authority?:OwnerWorkAuthority){this.pool=pool;this.clock=clock;this.authority=authority;if(!epochs.has(pool))epochs.set(pool,new Map());if(!reservationStates.has(pool))reservationStates.set(pool,new Map())}
 private epoch(owner:string,id:string){return epochs.get(this.pool)!.get(owner+'\0'+id)??0}
 private invalidate(owner:string,id:string){epochs.get(this.pool)!.set(owner+'\0'+id,this.epoch(owner,id)+1)}
 private remember(r:BudgetReservation,invalidate=false){const states=reservationStates.get(this.pool)!,key=r.ownerId+'\0'+r.id,prior=states.get(key);states.set(key,{state:r.state,epoch:(prior?.epoch??0)+(invalidate?1:0)});return r}
 private async ownerPolicy(db:PoolClient,owner:string){const row=(await db.query('select policy,version from teloa_owner_work_budgets where owner_id=$1',[owner])).rows[0];return {policy:row?readWorkBudgetPolicy(row.policy):ownerPolicy,version:row?.version??1}}
 private assertCapacity(stats:{tokens:number;rounds:number;concurrent:number;elapsed:number},policy:WorkBudgetPolicy,tokens=0,rounds=0){if(stats.tokens+tokens>policy.maxTokens||stats.rounds+rounds>policy.maxGoalRounds||tokens>0&&stats.concurrent>=policy.maxConcurrent||stats.elapsed>=policy.maxElapsedMs)throw exhausted()}
 private async lock(db:PoolClient,owner:string,id:string){
  if(!identity(owner)||!uuid(id))throw invalid()
  // 本人总额先锁，再锁职责账户；所有孩子和续轮同序，不能并行透支。
  await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',['teloa/work-budget/'+owner])
  const row=(await db.query('select * from teloa_work_budget_accounts where owner_id=$1 and id=$2 for update',[owner,id])).rows[0]
  if(!row)throw denied()
  return {row,policy:row.policy===null?defaultWorkBudgetPolicy:readWorkBudgetPolicy(row.policy)}
 }
 private async stats(db:PoolClient,owner:string,id:string|null){
  const row=(await db.query(`select coalesce(sum(case when state='settled' then actual_tokens else reserved_tokens end),0) as tokens,coalesce(sum(reserved_rounds),0) as rounds,count(*) filter(where state in ('reserved','unknown') and reserved_tokens>0) as concurrent,coalesce(sum(case when reserved_tokens>0 then greatest(0,extract(epoch from(coalesce(settled_at,now())-created_at))*1000) else 0 end),0) as elapsed from teloa_work_budget_reservations where owner_id=$1 and ($2::uuid is null or budget_account_id=$2) and state<>'released'`,[owner,id])).rows[0]
  return {tokens:Number(row.tokens),rounds:Number(row.rounds),concurrent:Number(row.concurrent),elapsed:Number(row.elapsed)}
 }
 async configure(owner:string,input:unknown){
  const a=taskInput(input,['requestId','budgetAccountId','expectedVersion','policy']),policy=readWorkBudgetPolicy(a.policy)
  if(!uuid(a.requestId)||!uuid(a.budgetAccountId)||!integer(a.expectedVersion)||a.expectedVersion<1)throw invalid()
  if(policy.money!==null)throw new WorkError('teloa/invalid-input','目前使用 token 和轮次额度；尚无可靠费用计价，不设置金额保证。')
  const db=await this.pool.connect();try{await db.query('begin');const {row}=await this.lock(db,owner,a.budgetAccountId)
   const prior=(await db.query('select * from teloa_work_budget_changes where owner_id=$1 and request_id=$2',[owner,a.requestId])).rows[0]
   if(prior){if(!isDeepStrictEqual(prior.request,a))throw new WorkError('teloa/conflict','原额度请求已保存其他设置。');await db.query('commit');return prior.result}
   if(row.version!==a.expectedVersion)throw new WorkError('teloa/version-conflict','工作额度已变化，请核对新版本。')
   const lease=await authorizeOwnerWork(this.authority,owner,{requestId:a.requestId,roleId:a.budgetAccountId,operation:'confirm'});lease.assertCurrent()
   const result={budgetAccountId:a.budgetAccountId,version:row.version+1,policy}
   await db.query('update teloa_work_budget_accounts set policy=$3,version=version+1 where owner_id=$1 and id=$2',[owner,a.budgetAccountId,JSON.stringify(policy)])
   await db.query('insert into teloa_work_budget_changes values($1,$2,$3,$4)',[owner,a.requestId,JSON.stringify(a),JSON.stringify(result)])
   lease.assertCurrent();await db.query('commit');this.invalidate(owner,a.budgetAccountId);return result
  }catch(e){await db.query('rollback');throw e}finally{db.release()}
 }
 /** 本人累计上限与职责上限分别可见、可配置，不把默认值变成隐藏终身门槛。 */
 async configureOwner(owner:string,input:unknown){
  const a=taskInput(input,['requestId','expectedVersion','policy']),policy=readWorkBudgetPolicy(a.policy)
  if(!identity(owner)||!uuid(a.requestId)||!integer(a.expectedVersion)||a.expectedVersion<1||policy.money!==null)throw invalid()
  const db=await this.pool.connect();try{await db.query('begin');await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',['teloa/work-budget/'+owner])
   const prior=(await db.query('select * from teloa_work_budget_changes where owner_id=$1 and request_id=$2',[owner,a.requestId])).rows[0]
   if(prior){if(!isDeepStrictEqual(prior.request,a))throw new WorkError('teloa/conflict','原额度请求已保存其他设置。');await db.query('commit');return prior.result}
   const current=await this.ownerPolicy(db,owner);if(current.version!==a.expectedVersion)throw new WorkError('teloa/version-conflict','本人累计额度已变化。')
   const lease=await authorizeOwnerWork(this.authority,owner,{requestId:a.requestId,roleId:a.requestId,operation:'confirm'}),result={version:current.version+1,policy}
   lease.assertCurrent();await db.query('insert into teloa_owner_work_budgets(owner_id,policy,version) values($1,$2,$3) on conflict(owner_id) do update set policy=excluded.policy,version=excluded.version',[owner,JSON.stringify(policy),result.version])
   await db.query('insert into teloa_work_budget_changes values($1,$2,$3,$4)',[owner,a.requestId,JSON.stringify(a),JSON.stringify(result)]);lease.assertCurrent();await db.query('commit');this.invalidate(owner,'owner');return result
  }catch(e){await db.query('rollback');throw e}finally{db.release()}
 }
 async readOwner(owner:string){if(!identity(owner))throw invalid();const db=await this.pool.connect();try{await db.query('begin');await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',['teloa/work-budget/'+owner]);const policy=await this.ownerPolicy(db,owner),used=await this.stats(db,owner,null);await db.query('commit');return {...policy,usedTokens:used.tokens,usedRounds:used.rounds,concurrent:used.concurrent,moneyMinorUnits:null}}catch(e){await db.query('rollback');throw e}finally{db.release()}}
 /** 恢复事务复用原连接。此许可只核额度，不能自行激活控制或派发模型。 */
 async admissionInTransaction(db:PoolClient,owner:string,budgetAccountId:string):Promise<WorkAccessLease>{
  const {policy}=await this.lock(db,owner,budgetAccountId),total=await this.ownerPolicy(db,owner)
  const accountStats=await this.stats(db,owner,budgetAccountId),ownerStats=await this.stats(db,owner,null)
  this.assertCapacity(accountStats,policy);this.assertCapacity(ownerStats,total.policy)
  const epoch=this.epoch(owner,budgetAccountId),ownerEpoch=this.epoch(owner,'owner')
  return Object.freeze({assertCurrent:()=>{if(this.epoch(owner,budgetAccountId)!==epoch||this.epoch(owner,'owner')!==ownerEpoch)throw exhausted()}})
 }
 async reserveInTransaction(db:PoolClient,owner:string,input:ReserveInput):Promise<BudgetReservation>{
  return this.reserveWithContext(db,owner,input,true)
 }
 private async reserveWithContext(db:PoolClient,owner:string,input:ReserveInput,requireControl:boolean):Promise<BudgetReservation>{
  const a=taskInput(input,['budgetAccountId','controlGeneration','modelRequestId','kind','tokens','rounds']) as ReserveInput
  if(!uuid(a.budgetAccountId)||!integer(a.controlGeneration)||a.controlGeneration<1||!identity(a.modelRequestId)||!['goal','team','routing','retry'].includes(a.kind)||!integer(a.tokens)||!integer(a.rounds))throw invalid()
  const {policy}=await this.lock(db,owner,a.budgetAccountId)
  const prior=(await db.query('select * from teloa_work_budget_reservations where owner_id=$1 and model_request_id=$2',[owner,a.modelRequestId])).rows[0]
  if(prior){const r=reservation(prior);if(r.budgetAccountId!==a.budgetAccountId||r.controlGeneration!==a.controlGeneration||r.kind!==a.kind||r.reservedTokens!==a.tokens||r.reservedRounds!==a.rounds)throw new WorkError('teloa/conflict','原模型请求已有其他额度预留。');return this.remember(r)}
  // 控制许可另在最终发布点同步核验；这里不反向锁 control，避免恢复持 control→budget 时死锁。
  // 修改长期定义会沿用累计账户；历史已结束定义不能封住新版本，只核当前 round 的真实祖先。
  const admitted=requireControl?await db.query(`select 1 from teloa_work_controls c
   join teloa_task_work_lineage l on l.owner_id=c.owner_id and l.round_control_id=c.id
   left join teloa_work_controls d on d.owner_id=l.owner_id and d.id=l.definition_control_id
   where c.owner_id=$1 and c.budget_account_id=$2 and c.kind='round' and c.state='active' and c.generation=$3
   and (l.definition_control_id is null or d.state='active') limit 1`,[owner,a.budgetAccountId,a.controlGeneration]):null
  if(requireControl&&!admitted?.rowCount)throw denied()
  const [account,total]=await Promise.all([this.stats(db,owner,a.budgetAccountId),this.stats(db,owner,null)])
  if(requireControl)this.assertCapacity(account,policy,a.tokens,a.rounds)
  // 本人消息的路由账户仅固定回执归属；它不引入额外、不可见的职责额度。
  this.assertCapacity(total,(await this.ownerPolicy(db,owner)).policy,a.tokens,a.rounds)
  return this.remember(reservation((await db.query(`insert into teloa_work_budget_reservations(id,owner_id,budget_account_id,control_generation,model_request_id,kind,reserved_tokens,reserved_rounds,state,created_at) values($1,$2,$3,$4,$5,$6,$7,$8,'reserved',$9) returning *`,[this.clock.id(),owner,a.budgetAccountId,a.controlGeneration,a.modelRequestId,a.kind,a.tokens,a.rounds,this.clock.now()])).rows[0]))
 }
 async reserve(owner:string,input:ReserveInput){const db=await this.pool.connect();try{await db.query('begin');const r=await this.reserveInTransaction(db,owner,input);await db.query('commit');return r}catch(e){await db.query('rollback');throw e}finally{db.release()}}
 /** 仅供已核验本人群消息的固定路由生产口；不伪造 Task/Run，仍与所有工作共享本人总额。 */
 async reserveOwnerRouting(owner:string,input:{modelRequestId:string;tokens:number}):Promise<BudgetReservation>{
  const a=taskInput(input,['modelRequestId','tokens']);if(!identity(owner)||!identity(a.modelRequestId)||!integer(a.tokens))throw invalid()
  const db=await this.pool.connect();try{
   await db.query('begin');await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',['teloa/work-budget/'+owner])
   let account=(await db.query('select budget_account_id from teloa_owner_routing_budget_accounts where owner_id=$1',[owner])).rows[0]?.budget_account_id
   if(!account){account=this.clock.id();await db.query('insert into teloa_work_budget_accounts(id,owner_id,created_at) values($1,$2,$3)',[account,owner,this.clock.now()]);await db.query('insert into teloa_owner_routing_budget_accounts(owner_id,budget_account_id) values($1,$2)',[owner,account])}
   const r=await this.reserveWithContext(db,owner,{budgetAccountId:account,controlGeneration:1,modelRequestId:a.modelRequestId,kind:'routing',tokens:a.tokens,rounds:0},false)
   await db.query('commit');return r
  }catch(e){await db.query('rollback');throw e}finally{db.release()}
 }
 lease(owner:string,r:BudgetReservation):WorkAccessLease{
  const key=owner+'\0'+r.id,states=reservationStates.get(this.pool)!,state=states.get(key)
  if(r.ownerId!==owner||r.state!=='reserved'||state?.state!=='reserved')throw exhausted()
  const epoch=this.epoch(owner,r.budgetAccountId),ownerEpoch=this.epoch(owner,'owner'),reservationEpoch=state.epoch
  return Object.freeze({assertCurrent:()=>{const current=states.get(key);if(this.epoch(owner,r.budgetAccountId)!==epoch||this.epoch(owner,'owner')!==ownerEpoch||!current||current.epoch!==reservationEpoch||!['reserved','unknown'].includes(current.state))throw exhausted()}})
 }
 async read(owner:string,input:unknown){const a=taskInput(input,['budgetAccountId']);if(!uuid(a.budgetAccountId))throw invalid();const db=await this.pool.connect();try{await db.query('begin');const {row,policy}=await this.lock(db,owner,a.budgetAccountId),s=await this.stats(db,owner,a.budgetAccountId);await db.query('commit');return {budgetAccountId:a.budgetAccountId,version:row.version,policy,usedTokens:s.tokens,usedRounds:s.rounds,concurrent:s.concurrent,moneyMinorUnits:null}}catch(e){await db.query('rollback');throw e}finally{db.release()}}
 async markDispatched(owner:string,input:unknown){const a=taskInput(input,['reservationId']);if(!uuid(a.reservationId))throw invalid();const result=await this.pool.query("update teloa_work_budget_reservations set state='unknown' where owner_id=$1 and id=$2 and state='reserved' returning *",[owner,a.reservationId]);if(!result.rows[0])throw new WorkError('teloa/conflict','本次请求未持有可派发的额度。');return this.remember(reservation(result.rows[0]))}
 async releaseUnaccepted(owner:string,input:unknown){const a=taskInput(input,['reservationId']);if(!uuid(a.reservationId))throw invalid();const rows=await this.pool.query("update teloa_work_budget_reservations set state='released',settled_at=$3 where owner_id=$1 and id=$2 and state in ('reserved','released') returning *",[owner,a.reservationId,this.clock.now()]);if(!rows.rows[0])throw new WorkError('teloa/conflict','请求已可能消耗额度，须核对真实回执，不能释放。');return this.remember(reservation(rows.rows[0]),true)}
 async settle(owner:string,input:SettleInput){
  const parsed=taskInput(input,['reservationId','modelRequestId','provider','providerRequestId','tokens','moneyMinorUnits','currency','receiptId']) as SettleInput,a={...parsed,provider:parsed.provider??null}
  if(!uuid(a.reservationId)||!identity(a.modelRequestId)||!identity(a.receiptId)||a.provider!==null&&!identity(a.provider)||a.providerRequestId!==null&&(!identity(a.providerRequestId)||a.provider===null)||a.tokens!==null&&!integer(a.tokens)||a.moneyMinorUnits!==null&&!integer(a.moneyMinorUnits)||a.currency!==null&&!/^[A-Z]{3}$/.test(a.currency))throw invalid()
  const db=await this.pool.connect();try{await db.query('begin');const hint=(await db.query('select budget_account_id from teloa_work_budget_reservations where owner_id=$1 and id=$2',[owner,a.reservationId])).rows[0];if(!hint)throw denied();await this.lock(db,owner,hint.budget_account_id)
   const row=(await db.query('select * from teloa_work_budget_reservations where owner_id=$1 and id=$2 for update',[owner,a.reservationId])).rows[0],r=reservation(row)
   if(r.modelRequestId!==a.modelRequestId||r.state==='released')throw new WorkError('teloa/conflict','模型回执与原预留不一致。')
   if(row.receipt){
    const previous={...row.receipt,provider:row.receipt.provider??null}
    if(isDeepStrictEqual(previous,a)){await db.query('commit');return this.remember(r)}
    // 只补同一提供方操作的未知用量，不接受换身份、降低已知用量或改写终态。
    const filled={...previous,tokens:previous.tokens===null?a.tokens:previous.tokens,moneyMinorUnits:previous.moneyMinorUnits===null?a.moneyMinorUnits:previous.moneyMinorUnits,currency:previous.currency===null?a.currency:previous.currency}
    if(r.state!=='unknown'||a.tokens===null||!isDeepStrictEqual(filled,a))throw new WorkError('teloa/conflict','本次模型请求已有不同的消耗回执。')
   }
   if(a.providerRequestId!==null&&(await db.query('select id from teloa_work_budget_reservations where owner_id=$1 and provider=$2 and provider_request_id=$3 and id<>$4',[owner,a.provider,a.providerRequestId,r.id])).rowCount)throw new WorkError('teloa/conflict','同一提供方操作已计入原工作，不重复结算。')
   const saved=reservation((await db.query("update teloa_work_budget_reservations set state=$3,actual_tokens=$4,provider_request_id=$5,money_minor_units=$6,currency=$7,receipt_id=$8,receipt=$9,settled_at=$10,provider=$11 where owner_id=$1 and id=$2 returning *",[owner,r.id,a.tokens===null?'unknown':'settled',a.tokens,a.providerRequestId,a.moneyMinorUnits,a.currency,a.receiptId,JSON.stringify(a),this.clock.now(),a.provider])).rows[0])
   await db.query('commit');if(a.tokens!==null&&a.tokens>r.reservedTokens)this.invalidate(owner,r.budgetAccountId);return this.remember(saved,true)
  }catch(e){await db.query('rollback');throw e}finally{db.release()}
 }
}

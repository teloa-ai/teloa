import type {Pool,PoolClient} from 'pg'
import {WorkError,taskInput,securityExecutionInput,securityObservationInput,readSecurityActionExecution,securityExecutionStates,securityExecutionTransitions,type SecurityPrincipal,type SecurityActionExecution,type SecurityExecutionReceipt,type SecurityExecutionState} from '@teloa/contract'
import {securityParamFingerprint} from './action-authorization.ts'
import {SecurityRequestJournal,type SecurityIdentity} from './request-journal.ts'
import {SecurityApprovalService,readStoredSecurityApproval} from './approvals.ts'
import {securityPrincipal,securityRequestSpec,securityStorageError,lockSecurityAction,readStoredSecurityAction,type SecurityExecutionExistsReader} from './actions.ts'

const marker='teloa.security-action-execution/v2'
const executionTable='teloa_security_action_executions'
const auditTable='teloa_security_action_execution_audit'
const legacyColumns:Record<string,string[]>={
 [executionTable]:['operation_id','owner_id','request_id','request_spec','action_id','approval_id','approval_version','action_snapshot','state','revision','receipt','unknown_reason','created_at','updated_at'],
 [auditTable]:['id','owner_id','operation_id','at','event','detail'],
}
const same=(a:Record<string,unknown>,b:Record<string,unknown>)=>securityParamFingerprint(a)===securityParamFingerprint(b)
const actionState=(state:SecurityExecutionState)=>state==='dispatching'||state==='accepted'?'executing':state
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)

/** 迁移检查和 DDL 共用事务与排他锁；有历史事实时绝不自动猜测转换。 */
export async function initializeSecurityActionExecutions(pool:Pool):Promise<void>{
 const db=await pool.connect()
 try{
  await db.query('begin')
  await db.query("select pg_advisory_xact_lock(hashtextextended('teloa/security-action-execution/v2',0))")
  const legacy:string[]=[],versions:string[]=[]
  for(const table of [executionTable,auditTable]){
   const relationSql=`select c.oid id,c.relkind,c.relispartition,obj_description(c.oid) marker,
    exists(select 1 from pg_inherits where inhparent=c.oid or inhrelid=c.oid) inherited
    from pg_class c where c.oid=to_regclass($1)`
   const existing=(await db.query(relationSql,[table])).rows[0]
   if(!existing)continue
   // marker 和列签名不证明它是独立普通表；ONLY 会漏掉分区或继承子表的数据。
   if(existing.relkind!=='r'||existing.relispartition||existing.inherited)throw securityStorageError()
   try{await db.query(`lock table only ${table} in access exclusive mode`)}
   catch(error){
    if(error&&typeof error==='object'&&'code' in error&&['42P01','42809','0A000'].includes(String(error.code)))throw securityStorageError()
    throw error
   }
   // 排他锁阻止后续附加/移除继承；重查也覆盖首次读取到取得锁之间的 DDL。
   const locked=(await db.query(relationSql,[table])).rows[0]
   if(!locked||locked.id!==existing.id||locked.relkind!=='r'||locked.relispartition||locked.inherited)throw securityStorageError()
   const version=locked.marker
   if(version===marker){versions.push(table);continue}
   const columns=(await db.query('select column_name,data_type from information_schema.columns where table_schema=current_schema() and table_name=$1 order by ordinal_position',[table])).rows
   const types:Record<string,string>={operation_id:'uuid',request_id:'uuid',request_spec:'jsonb',approval_version:'integer',action_snapshot:'jsonb',revision:'integer',receipt:'jsonb',created_at:'timestamp with time zone',updated_at:'timestamp with time zone',id:'bigint',at:'timestamp with time zone',detail:'jsonb'}
   if(version!==null||JSON.stringify(columns.map(r=>r.column_name))!==JSON.stringify(legacyColumns[table])||columns.some(r=>r.data_type!==(types[r.column_name]??'text')))throw securityStorageError()
   legacy.push(table)
  }
  if(legacy.length&&versions.length||versions.length===1)throw securityStorageError()
  for(const table of legacy)if((await db.query(`select exists(select 1 from only ${table}) present`)).rows[0].present)throw new WorkError('teloa/storage-corrupt',`${table} 含历史数据，需显式人工迁移。`)
  if(legacy.includes(auditTable))await db.query('drop table teloa_security_action_execution_audit')
  if(legacy.includes(executionTable))await db.query('drop table teloa_security_action_executions')
  await db.query(`
   create table if not exists teloa_security_action_execution_transitions(from_state text not null,to_state text not null,primary key(from_state,to_state));
   create table if not exists teloa_security_action_executions(
    operation_id uuid primary key,owner_id text not null,request_id uuid not null,request_spec_digest text not null check(request_spec_digest~'^sha256:[a-f0-9]{64}$'),action_id uuid not null,approval_id uuid not null,
    approval_version integer not null check(approval_version>0),frozen jsonb not null check(jsonb_typeof(frozen)='object'),
    dispatch_spec jsonb not null check(jsonb_typeof(dispatch_spec)='object'),dispatch_spec_digest text not null check(dispatch_spec_digest~'^sha256:[a-f0-9]{64}$'),
    state text not null check(state in (${securityExecutionStates.map(s=>"'"+s+"'").join(',')})),revision integer not null check(revision>0),
    created_at timestamptz not null,updated_at timestamptz not null check(updated_at>=created_at),
    unique(owner_id,action_id),unique(owner_id,request_id),unique(operation_id,owner_id),
    foreign key(action_id,owner_id) references teloa_security_actions(id,owner_id),
    foreign key(approval_id,owner_id) references teloa_security_approvals(id,owner_id),
    foreign key(owner_id,request_id) references teloa_security_requests(owner_id,request_id)
   );
   create table if not exists teloa_security_action_execution_receipts(
    operation_id uuid not null references teloa_security_action_executions(operation_id),kind text not null check(kind in ('acceptance','effect')),
    receipt jsonb not null check(jsonb_typeof(receipt)='object'),created_at timestamptz not null,primary key(operation_id,kind),
    check(receipt ? 'status' and jsonb_typeof(receipt->'status')='string' and
     ((kind='acceptance' and receipt->>'status'='accepted') or (kind='effect' and receipt->>'status' in ('succeeded','failed'))))
   );
   create table if not exists teloa_security_action_execution_audit(
    owner_id text not null,operation_id uuid not null,revision integer not null check(revision>0),event text not null,at timestamptz not null,
    detail jsonb not null check(jsonb_typeof(detail)='object'),result_snapshot jsonb not null check(jsonb_typeof(result_snapshot)='object'),
    result_digest text not null check(result_digest~'^sha256:[a-f0-9]{64}$'),primary key(operation_id,revision),
    foreign key(operation_id,owner_id) references teloa_security_action_executions(operation_id,owner_id)
   );
   create table if not exists teloa_security_action_execution_requests(
    owner_id text not null,request_id uuid not null,operation_id uuid not null,expected_action_version integer not null check(expected_action_version>0),
    result_snapshot jsonb not null check(jsonb_typeof(result_snapshot)='object'),primary key(owner_id,request_id),
    foreign key(owner_id,request_id) references teloa_security_requests(owner_id,request_id),
    foreign key(operation_id,owner_id) references teloa_security_action_executions(operation_id,owner_id)
   );
   create table if not exists teloa_security_action_observation_requests(
    owner_id text not null,request_id uuid not null,operation_id uuid not null,expected_revision integer not null check(expected_revision>0),
    state text not null check(state in ('pending','completed')),result_operation_id uuid,result_revision integer,result_snapshot jsonb,result_digest text check(result_digest~'^sha256:[a-f0-9]{64}$'),created_at timestamptz not null,completed_at timestamptz,
    primary key(owner_id,request_id),foreign key(owner_id,request_id) references teloa_security_requests(owner_id,request_id),
    foreign key(operation_id,owner_id) references teloa_security_action_executions(operation_id,owner_id),
    check((state='pending' and num_nonnulls(result_operation_id,result_revision,result_snapshot,result_digest,completed_at)=0) or
     (state='completed' and num_nonnulls(result_operation_id,result_revision,result_snapshot,result_digest,completed_at)=5 and result_operation_id=operation_id and result_revision>=expected_revision and jsonb_typeof(result_snapshot)='object'))
   );
   create table if not exists teloa_security_action_observation_audit(
    owner_id text not null,request_id uuid not null,operation_id uuid not null,revision integer not null check(revision>0),
    result_digest text not null check(result_digest~'^sha256:[a-f0-9]{64}$'),completed_at timestamptz not null,
    primary key(owner_id,request_id),foreign key(owner_id,request_id) references teloa_security_action_observation_requests(owner_id,request_id),
    foreign key(operation_id,revision) references teloa_security_action_execution_audit(operation_id,revision)
   );
   comment on table teloa_security_action_executions is 'teloa.security-action-execution/v2';
   comment on table teloa_security_action_execution_audit is 'teloa.security-action-execution/v2';
   create or replace function teloa_guard_security_execution() returns trigger language plpgsql as $$ begin
    if (to_jsonb(new)-array['state','revision','updated_at']) is distinct from (to_jsonb(old)-array['state','revision','updated_at']) then raise exception '安全执行身份、批准与派发内容不可修改'; end if;
    if new.state is distinct from old.state and not exists(select 1 from teloa_security_action_execution_transitions where from_state=old.state and to_state=new.state) then raise exception '非法的安全执行状态转移'; end if;
    if new.revision<>old.revision+1 or new.updated_at<old.updated_at then raise exception '安全执行修订必须单向递增'; end if;
    return new;
   end $$;
   create or replace trigger teloa_guard_security_execution before update on teloa_security_action_executions for each row execute function teloa_guard_security_execution();
   create or replace function teloa_guard_security_observation() returns trigger language plpgsql as $$ begin
    if tg_op='DELETE' then raise exception '观察请求不可删除'; end if;
    if old.state<>'pending' or new.state<>'completed' or
     (to_jsonb(new)-array['state','result_operation_id','result_revision','result_snapshot','result_digest','completed_at']) is distinct from
     (to_jsonb(old)-array['state','result_operation_id','result_revision','result_snapshot','result_digest','completed_at']) then raise exception '观察请求仅可完成一次且不可改写身份'; end if;
    return new;
   end $$;
   create or replace trigger teloa_guard_security_observation before update or delete on teloa_security_action_observation_requests for each row execute function teloa_guard_security_observation();
   create or replace trigger teloa_security_observation_audit_immutable before update or delete on teloa_security_action_observation_audit for each row execute function teloa_security_append_only();
   create or replace trigger teloa_security_execution_receipts_immutable before update or delete on teloa_security_action_execution_receipts for each row execute function teloa_security_append_only();
   create or replace trigger teloa_security_execution_audit_immutable before update or delete on teloa_security_action_execution_audit for each row execute function teloa_security_append_only();
   create or replace trigger teloa_security_execution_requests_immutable before update or delete on teloa_security_action_execution_requests for each row execute function teloa_security_append_only();
   create or replace function teloa_check_security_execution_pair(owner_arg text,action_arg uuid) returns void language plpgsql as $$
   declare a teloa_security_actions%rowtype; e teloa_security_action_executions%rowtype; ac jsonb; ef jsonb; begin
    select * into a from teloa_security_actions where owner_id=owner_arg and id=action_arg;
    select * into e from teloa_security_action_executions where owner_id=owner_arg and action_id=action_arg;
    if a.id is null then if e.operation_id is not null then raise exception '安全动作与执行不一致：动作不存在'; end if; return; end if;
    if e.operation_id is null then
     if a.state not in ('proposed','pending_approval','approved','rejected','withdrawn') then raise exception '安全动作与执行不一致：缺少执行意图'; end if;
     return;
    end if;
    if a.state<>(case when e.state in ('dispatching','accepted') then 'executing' else e.state end) then raise exception '安全动作与执行状态不一致'; end if;
    select receipt into ac from teloa_security_action_execution_receipts where operation_id=e.operation_id and kind='acceptance';
    select receipt into ef from teloa_security_action_execution_receipts where operation_id=e.operation_id and kind='effect';
    if (e.state='dispatching' and (ac is not null or ef is not null)) or
     (e.state='accepted' and (ac is null or ef is not null)) or
     (e.state='effect_unknown' and ef is not null) or
     (e.state in ('succeeded','failed') and (ef is null or ef->>'status'<>e.state)) then raise exception '安全执行状态与双回执不一致'; end if;
   end $$;
   create or replace function teloa_security_action_pair_trigger() returns trigger language plpgsql as $$ begin
    if tg_op<>'INSERT' then perform teloa_check_security_execution_pair(old.owner_id,old.id); end if;
    if tg_op<>'DELETE' then perform teloa_check_security_execution_pair(new.owner_id,new.id); end if;
    return null;
   end $$;
   create or replace function teloa_security_execution_pair_trigger() returns trigger language plpgsql as $$ begin
    if tg_op<>'INSERT' then perform teloa_check_security_execution_pair(old.owner_id,old.action_id); end if;
    if tg_op<>'DELETE' then perform teloa_check_security_execution_pair(new.owner_id,new.action_id); end if;
    return null;
   end $$;
   create or replace function teloa_security_receipt_pair_trigger() returns trigger language plpgsql as $$
   declare e teloa_security_action_executions%rowtype; begin
    select * into e from teloa_security_action_executions where operation_id=new.operation_id;
    perform teloa_check_security_execution_pair(e.owner_id,e.action_id);return null;
   end $$;
   drop trigger if exists teloa_security_actions_execution_pair on teloa_security_actions;
   create constraint trigger teloa_security_actions_execution_pair after insert or update or delete on teloa_security_actions
    deferrable initially deferred for each row execute function teloa_security_action_pair_trigger();
   drop trigger if exists teloa_security_executions_action_pair on teloa_security_action_executions;
   create constraint trigger teloa_security_executions_action_pair after insert or update or delete on teloa_security_action_executions
    deferrable initially deferred for each row execute function teloa_security_execution_pair_trigger();
   drop trigger if exists teloa_security_receipts_execution_pair on teloa_security_action_execution_receipts;
   create constraint trigger teloa_security_receipts_execution_pair after insert on teloa_security_action_execution_receipts
    deferrable initially deferred for each row execute function teloa_security_receipt_pair_trigger();
  `)
  for(const [from,targets] of Object.entries(securityExecutionTransitions))for(const to of targets)await db.query('insert into teloa_security_action_execution_transitions values($1,$2) on conflict do nothing',[from,to])
  const actual=(await db.query('select from_state,to_state from teloa_security_action_execution_transitions')).rows.map(r=>r.from_state+'->'+r.to_state).sort()
  const expected=Object.entries(securityExecutionTransitions).flatMap(([from,to])=>to.map(target=>from+'->'+target)).sort()
  if(JSON.stringify(actual)!==JSON.stringify(expected))throw securityStorageError()
  await db.query('commit')
 }catch(error){await db.query('rollback');throw error}finally{db.release()}
}

export class PgSecurityExecutionExistsReader implements SecurityExecutionExistsReader{
 async existsForAction(db:PoolClient,ownerId:string,actionId:string):Promise<boolean>{
  return (await db.query('select exists(select 1 from teloa_security_action_executions where owner_id=$1 and action_id=$2) present',[ownerId,actionId])).rows[0].present===true
 }
}

export function readStoredSecurityExecution(row:Record<string,unknown>):SecurityActionExecution{
 try{
  const result=readSecurityActionExecution({operationId:row.operation_id,ownerId:row.owner_id,actionId:row.action_id,approvalId:row.approval_id,approvalVersion:row.approval_version,
   frozen:row.frozen,dispatch:row.dispatch_spec,state:row.state,revision:row.revision,acceptanceReceipt:row.acceptance_receipt??null,effectReceipt:row.effect_receipt??null,
   createdAt:(row.created_at as Date).toISOString(),updatedAt:(row.updated_at as Date).toISOString()})
  if(securityParamFingerprint(result.dispatch)!==row.dispatch_spec_digest)throw Error()
  return result
 }catch{throw securityStorageError()}
}
const executionSelect=`select e.*,
 (select receipt from teloa_security_action_execution_receipts where operation_id=e.operation_id and kind='acceptance') acceptance_receipt,
 (select receipt from teloa_security_action_execution_receipts where operation_id=e.operation_id and kind='effect') effect_receipt
 from teloa_security_action_executions e where e.owner_id=$1 and e.operation_id=$2`

export class SecurityActionExecutionService{
 private readonly pool:Pool
 private readonly identity:SecurityIdentity
 private readonly approvals:Pick<SecurityApprovalService,'readForExecution'>
 private readonly journal:SecurityRequestJournal
 constructor(pool:Pool,identity:SecurityIdentity,approvals:Pick<SecurityApprovalService,'readForExecution'>,journal:SecurityRequestJournal){this.pool=pool;this.identity=identity;this.approvals=approvals;this.journal=journal}

 async toolForAction(principal:SecurityPrincipal,input:{actionId:string}):Promise<string>{
  securityPrincipal(principal);if(!uuid(input.actionId))throw new WorkError('teloa/invalid-input','安全动作身份无效。')
  const row=(await this.pool.query('select * from teloa_security_actions where id=$1 and owner_id=$2',[input.actionId,principal.ownerId])).rows[0]
  if(!row)throw new WorkError('teloa/forbidden','安全动作不存在或不属于本人。')
  return readStoredSecurityAction(row).tool
 }

 /** 所有执行写操作先锁 Action，再锁 Execution，和撤回批准共用锁顺序。 */
 private async load(db:PoolClient,principal:SecurityPrincipal,operationId:string,verifyAudit=true):Promise<SecurityActionExecution>{
  const pointer=(await db.query('select action_id from teloa_security_action_executions where owner_id=$1 and operation_id=$2',[principal.ownerId,operationId])).rows[0]
  if(!pointer)throw new WorkError('teloa/not-found','安全执行意图不存在。')
  const {action}=await lockSecurityAction(db,principal,pointer.action_id)
  const row=(await db.query(executionSelect+' for update of e',[principal.ownerId,operationId])).rows[0]
  if(!row)throw securityStorageError()
  const execution=readStoredSecurityExecution(row)
  const approvalRow=(await db.query('select * from teloa_security_approvals where owner_id=$1 and id=$2',[principal.ownerId,execution.approvalId])).rows[0]
  if(!approvalRow)throw securityStorageError()
  const approval=readStoredSecurityApproval(approvalRow)
  if(approval.actionId!==action.id||approval.actionVersion!==execution.approvalVersion||approval.decision!=='approved'||!approval.impactConfirmed||
   !same(approval.frozen,execution.frozen)||action.frozen===null||!same(action.frozen,execution.frozen)||action.state!==actionState(execution.state)||
   !same(execution.dispatch,{operationId,actionId:action.id,tool:action.tool,playbookVersion:action.playbookVersion,targets:action.targetSet,params:action.params}))throw securityStorageError()
  const request=(await db.query('select command,request_spec from teloa_security_requests where owner_id=$1 and request_id=$2',[principal.ownerId,row.request_id])).rows[0]
  if(!request||request.command!=='execute'||securityParamFingerprint(request.request_spec)!==row.request_spec_digest||
   request.request_spec.command!=='execute'||request.request_spec.actionId!==execution.actionId||request.request_spec.expectedActionVersion!==execution.approvalVersion+1)throw securityStorageError()
  if(verifyAudit){
   const audit=(await db.query('select result_digest,result_snapshot from teloa_security_action_execution_audit where operation_id=$1 and revision=$2',[operationId,execution.revision])).rows[0]
   if(!audit||audit.result_digest!==securityParamFingerprint(execution)||audit.result_digest!==securityParamFingerprint(audit.result_snapshot))throw securityStorageError()
  }
  return execution
 }

 private async audit(db:PoolClient,execution:SecurityActionExecution,event:string,detail:Record<string,unknown>):Promise<void>{
  await db.query('insert into teloa_security_action_execution_audit(owner_id,operation_id,revision,event,at,detail,result_snapshot,result_digest) values($1,$2,$3,$4,$5,$6,$7,$8)',
   [execution.ownerId,execution.operationId,execution.revision,event,execution.updatedAt,JSON.stringify(detail),JSON.stringify(execution),securityParamFingerprint(execution)])
 }
 private async historical(db:PoolClient,principal:SecurityPrincipal,snapshot:unknown,operationId:string,revision:number):Promise<SecurityActionExecution>{
  try{
   const value=readSecurityActionExecution(snapshot)
   if(value.ownerId!==principal.ownerId||value.operationId!==operationId||value.revision!==revision)throw Error()
   const current=await this.load(db,principal,operationId)
   const audit=(await db.query('select * from teloa_security_action_execution_audit where operation_id=$1 and revision=$2',[operationId,revision])).rows[0]
   if(!audit||audit.owner_id!==principal.ownerId||audit.result_digest!==securityParamFingerprint(value)||audit.result_digest!==securityParamFingerprint(readSecurityActionExecution(audit.result_snapshot))||
    value.actionId!==current.actionId||value.approvalId!==current.approvalId||value.approvalVersion!==current.approvalVersion||!same(value.frozen,current.frozen)||!same(value.dispatch,current.dispatch)||
    value.createdAt!==current.createdAt||value.updatedAt!==(audit.at as Date).toISOString()||value.revision>current.revision)throw Error()
   return value
  }catch{throw securityStorageError()}
 }

 async claim(principal:SecurityPrincipal,input:unknown):Promise<{execution:SecurityActionExecution;dispatch:boolean}>{
  securityPrincipal(principal);const request=securityExecutionInput(input)
  return this.journal.transaction(async db=>{
   const now=this.identity.now(),spec=securityRequestSpec('execute',principal,request)
   if(await this.journal.reserve(db,principal.ownerId,request.requestId,'execute',spec,now)){
    const row=(await db.query('select * from teloa_security_action_execution_requests where owner_id=$1 and request_id=$2',[principal.ownerId,request.requestId])).rows[0]
    if(!row||row.expected_action_version!==request.expectedActionVersion)throw securityStorageError()
    const execution=await this.historical(db,principal,row.result_snapshot,row.operation_id,1)
    const intent=(await db.query('select request_id from teloa_security_action_executions where operation_id=$1',[execution.operationId])).rows[0]
    if(execution.actionId!==request.actionId||execution.state!=='dispatching'||execution.approvalVersion+1!==request.expectedActionVersion||intent.request_id!==request.requestId)throw securityStorageError()
    return {execution,dispatch:false}
   }
   const {action,approval}=await this.approvals.readForExecution(db,principal,{actionId:request.actionId,expectedActionVersion:request.expectedActionVersion})
   const operationId=this.identity.id(),dispatch={operationId,actionId:action.id,tool:action.tool,playbookVersion:action.playbookVersion,targets:action.targetSet,params:action.params}
   const proposed=readSecurityActionExecution({operationId,ownerId:principal.ownerId,actionId:action.id,approvalId:approval.id,approvalVersion:approval.actionVersion,frozen:approval.frozen,
    dispatch,state:'dispatching',revision:1,acceptanceReceipt:null,effectReceipt:null,createdAt:now,updatedAt:now})
   await db.query("update teloa_security_actions set state='executing',version=version+1,updated_at=$2 where id=$1",[action.id,now])
   await db.query("insert into teloa_security_action_executions(operation_id,owner_id,request_id,action_id,approval_id,approval_version,frozen,dispatch_spec,dispatch_spec_digest,request_spec_digest,state,revision,created_at,updated_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'dispatching',1,$11,$11)",
    [operationId,principal.ownerId,request.requestId,action.id,approval.id,approval.actionVersion,JSON.stringify(approval.frozen),JSON.stringify(dispatch),securityParamFingerprint(dispatch),securityParamFingerprint(spec),now])
   const execution=await this.load(db,principal,operationId,false)
   if(!same(execution,proposed))throw securityStorageError()
   await this.audit(db,execution,'dispatch-claimed',{requestId:request.requestId,expectedActionVersion:request.expectedActionVersion})
   await db.query('insert into teloa_security_action_execution_requests(owner_id,request_id,operation_id,expected_action_version,result_snapshot) values($1,$2,$3,$4,$5)',
    [principal.ownerId,request.requestId,operationId,request.expectedActionVersion,JSON.stringify(execution)])
   return {execution,dispatch:true}
  })
 }
 async get(principal:SecurityPrincipal,input:unknown):Promise<SecurityActionExecution>{
  securityPrincipal(principal);const row=taskInput(input,['operationId']);if(!uuid(row.operationId))throw new WorkError('teloa/invalid-input','安全执行身份无效。')
  const operationId=row.operationId.toLowerCase()
  return this.journal.transaction(async db=>this.load(db,principal,operationId))
 }
 /**
  * 只读待恢复执行身份。单轮上限 50 既是内存保护也是告警风暴保护：
  * 一次异常不该让宿主在两秒内向外部安全系统打出上百个请求（规格 §7.2）。
  *
  * 一分钟冷却：用户点"派发"走的是 claim 落库 + 立刻 POST，这一次外部调用完全可能在途十几秒；
  * 而后台恢复扫描两秒一轮，它在库里看到的只是一条 dispatching，分不出"在途"和"进程被杀了"。
  * 没有冷却，恢复循环会抢在用户那次 POST 之前先 GET，查无结果就判定"从未派发"而补发第二次 POST。
  * 刚落库的记录先晾一分钟，把这两件事分开。
  * effect_unknown 同样适用：它也是刚写下的一条在途结论，晚一分钟再去核对只会更准。
  */
 async outstanding(principal:SecurityPrincipal):Promise<string[]>{
  securityPrincipal(principal)
  // 冷却判据要与 claim/advance 写 updated_at 用同一把钟（this.identity.now()），
  // 不能一边写应用时钟一边用库的 now() 判断，两钟一旦漂移冷却窗口就会跟着伸缩。
  const rows=await this.pool.query("select operation_id from teloa_security_action_executions where owner_id=$1 and state in ('dispatching','accepted','effect_unknown') and updated_at < $2::timestamptz - interval '1 minute' order by created_at,operation_id limit 50",[principal.ownerId,this.identity.now()])
  if(rows.rows.some(row=>!uuid(row.operation_id)))throw new WorkError('teloa/storage-corrupt','待恢复安全执行身份损坏。')
  return rows.rows.map(row=>String(row.operation_id))
 }

 private async advance(db:PoolClient,principal:SecurityPrincipal,current:SecurityActionExecution,state:SecurityExecutionState,event:string,detail:Record<string,unknown>):Promise<SecurityActionExecution>{
  const now=this.identity.now()
  if(actionState(current.state)!==actionState(state))await db.query('update teloa_security_actions set state=$2,version=version+1,updated_at=$3 where id=$1',[current.actionId,actionState(state),now])
  await db.query('update teloa_security_action_executions set state=$2,revision=revision+1,updated_at=$3 where operation_id=$1',[current.operationId,state,now])
  const execution=await this.load(db,principal,current.operationId,false);await this.audit(db,execution,event,detail);return execution
 }
 async markUnknown(principal:SecurityPrincipal,input:unknown):Promise<SecurityActionExecution>{
  securityPrincipal(principal);const row=taskInput(input,['operationId','reason'])
  if(!uuid(row.operationId)||typeof row.reason!=='string'||!row.reason.trim()||row.reason.length>4000)throw new WorkError('teloa/invalid-input','未知执行结果说明无效。')
  const operationId=row.operationId.toLowerCase(),reason=row.reason
  return this.journal.transaction(async db=>{
   const current=await this.load(db,principal,operationId)
   if(['succeeded','failed','effect_unknown'].includes(current.state))return current
   return this.advance(db,principal,current,'effect_unknown','effect-unknown',{reason})
  })
 }
 async recordAccepted(principal:SecurityPrincipal,input:unknown):Promise<SecurityActionExecution>{return this.recordReceipt(principal,input,'acceptance')}
 async recordEffect(principal:SecurityPrincipal,input:unknown):Promise<SecurityActionExecution>{return this.recordReceipt(principal,input,'effect')}
 private async recordReceipt(principal:SecurityPrincipal,input:unknown,kind:'acceptance'|'effect'):Promise<SecurityActionExecution>{
  securityPrincipal(principal);const row=taskInput(input,['operationId','receipt'])
  if(!uuid(row.operationId))throw new WorkError('teloa/invalid-input','安全执行身份无效。')
  const operationId=row.operationId.toLowerCase()
  return this.journal.transaction(async db=>{
   const current=await this.load(db,principal,operationId)
   const status=(row.receipt as SecurityExecutionReceipt|null)?.status
   if(kind==='acceptance'?status!=='accepted':status!=='succeeded'&&status!=='failed')throw new WorkError('teloa/invalid-host-response','回执类别不正确。')
   const parsed=readSecurityActionExecution({...current,state:status,...(kind==='acceptance'?{acceptanceReceipt:row.receipt,effectReceipt:null}:{effectReceipt:row.receipt})})
   const value=(kind==='acceptance'?parsed.acceptanceReceipt:parsed.effectReceipt)!,prior=kind==='acceptance'?current.acceptanceReceipt:current.effectReceipt
   if(prior&&!same(prior,value))throw new WorkError('teloa/conflict','同类安全回执已绑定不同的不可变事实。')
   if(current.state==='succeeded'||current.state==='failed'){
    if(prior)return current
    throw new WorkError('teloa/conflict','终态不能追加迟到的另一类回执。')
   }
   if(prior&&!(kind==='acceptance'&&current.state==='effect_unknown'))return current
   if(!prior)await db.query('insert into teloa_security_action_execution_receipts(operation_id,kind,receipt,created_at) values($1,$2,$3,$4)',[operationId,kind,JSON.stringify(value),this.identity.now()])
   return this.advance(db,principal,current,value.status,kind==='acceptance'?'external-accepted':'effect-recorded',{receiptId:value.receiptId})
  })
 }

 private async observationResult(db:PoolClient,principal:SecurityPrincipal,row:Record<string,unknown>,expectedRevision:number):Promise<SecurityActionExecution>{
  try{
   const snapshot=readSecurityActionExecution(row.result_snapshot)
   const audit=(await db.query('select * from teloa_security_action_observation_audit where owner_id=$1 and request_id=$2',[principal.ownerId,row.request_id])).rows[0]
   if(!audit||row.state!=='completed'||row.result_operation_id!==row.operation_id||row.result_revision!==snapshot.revision||snapshot.revision<expectedRevision||
    row.result_digest!==securityParamFingerprint(snapshot)||audit.result_digest!==row.result_digest||audit.operation_id!==row.operation_id||audit.revision!==row.result_revision||
    (audit.completed_at as Date).toISOString()!==(row.completed_at as Date).toISOString())throw Error()
   return await this.historical(db,principal,snapshot,String(row.operation_id),snapshot.revision)
  }catch{throw securityStorageError()}
 }

 async observeWithJournal(principal:SecurityPrincipal,input:unknown,recover:()=>Promise<SecurityActionExecution>):Promise<SecurityActionExecution>{
  securityPrincipal(principal);const request=securityObservationInput(input)
  const prior=await this.journal.transaction(async db=>{
   const now=this.identity.now(),existing=await this.journal.reserve(db,principal.ownerId,request.requestId,'observe',securityRequestSpec('observe',principal,request),now)
   if(existing){
    const row=(await db.query('select * from teloa_security_action_observation_requests where owner_id=$1 and request_id=$2 for update',[principal.ownerId,request.requestId])).rows[0]
    if(!row||row.operation_id!==request.operationId||row.expected_revision!==request.expectedRevision)throw securityStorageError()
    if(row.state==='completed')return this.observationResult(db,principal,row,request.expectedRevision)
    if(row.state!=='pending'||row.result_snapshot!==null||row.result_operation_id!==null||row.result_revision!==null||row.completed_at!==null||row.result_digest!==null)throw securityStorageError()
    return null
   }
   const current=await this.load(db,principal,request.operationId)
   if(current.revision!==request.expectedRevision)throw new WorkError('teloa/version-conflict','执行修订已变化，请重新核对。')
   await db.query("insert into teloa_security_action_observation_requests(owner_id,request_id,operation_id,expected_revision,state,created_at) values($1,$2,$3,$4,'pending',$5)",[principal.ownerId,request.requestId,request.operationId,request.expectedRevision,now])
   return null
  })
  if(prior)return prior
  // 外部恢复不占数据库连接；失败保持 pending，后续只恢复同一 operation。
  await recover()
  return this.journal.transaction(async db=>{
   await this.journal.reserve(db,principal.ownerId,request.requestId,'observe',securityRequestSpec('observe',principal,request),this.identity.now())
   const row=(await db.query('select * from teloa_security_action_observation_requests where owner_id=$1 and request_id=$2 for update',[principal.ownerId,request.requestId])).rows[0]
   if(!row||row.operation_id!==request.operationId||row.expected_revision!==request.expectedRevision)throw securityStorageError()
   if(row.state==='completed')return this.observationResult(db,principal,row,request.expectedRevision)
   if(row.state!=='pending')throw securityStorageError()
   const execution=await this.load(db,principal,request.operationId),completedAt=this.identity.now()
   await db.query("update teloa_security_action_observation_requests set state='completed',result_operation_id=$3,result_revision=$4,result_snapshot=$5,result_digest=$6,completed_at=$7 where owner_id=$1 and request_id=$2",
    [principal.ownerId,request.requestId,execution.operationId,execution.revision,JSON.stringify(execution),securityParamFingerprint(execution),completedAt])
   await db.query('insert into teloa_security_action_observation_audit(owner_id,request_id,operation_id,revision,result_digest,completed_at) values($1,$2,$3,$4,$5,$6)',
    [principal.ownerId,request.requestId,execution.operationId,execution.revision,securityParamFingerprint(execution),completedAt])
   return execution
  })
 }
}

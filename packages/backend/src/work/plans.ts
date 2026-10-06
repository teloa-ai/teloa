import type {Pool,PoolClient} from 'pg'
import {WorkError,isRecord,readScheduleTrigger,roleDefinition,roleSupportsScope,taskDefinition,type ScheduleTrigger} from '@teloa/contract'
import type {MarketContent} from '../market/content-store.ts'
import {assertBusinessScopeRegistered} from './business-scopes.ts'
import {workAccess} from './work-access.ts'

export const planNotificationPolicies=['always','attention','failure','silent'] as const
export type PlanNotificationPolicy=typeof planNotificationPolicies[number]
type PlanFieldValues={title:string;goal:string;scope:string;dataScope:string;delivery:string;roleId:string;trigger:ScheduleTrigger}
export type PlanFields=PlanFieldValues&{notificationPolicy:PlanNotificationPolicy}
export type PlanUpdateFields=Pick<PlanFields,'title'|'goal'|'dataScope'|'delivery'|'trigger'|'notificationPolicy'>
type StoredPlanFields=PlanFieldValues&{notificationPolicy?:PlanNotificationPolicy}
export type PlanSource={kind:'manual'}|{kind:'market-content';contentId:string;contentHash:string;resourceId:string;resourceVersion:string}|{kind:'system-digest';roleId:string}
export type PersistentPlan=StoredPlanFields&{id:string;ownerId:string;roleVersion:number;source:PlanSource;version:number;configVersion:number;state:'paused'|'active'|'archived';archivedReason:string|null;archivedAt:string|null;createdAt:string;updatedAt:string}
export type PlanMarketSources={get:(actor:{ownerId:string;kind:'human'},input:{contentId:string})=>Promise<MarketContent>;getInTransaction?:(client:PoolClient,actor:{ownerId:string;kind:'human'},input:{contentId:string})=>Promise<MarketContent>}

const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
const semver=(value:unknown):value is string=>typeof value==='string'&&value.length<=80&&/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value)
const hash=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value)
const stableId=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9-]{0,119}$/.test(value)
const invalid=()=>new WorkError('teloa/invalid-input','持续计划请求包含未知字段或格式不正确。')
const corrupt=()=>new WorkError('teloa/storage-corrupt','持续计划记录或固定回执损坏，已停止读取。')
const object=(value:unknown,keys:readonly string[]):Record<string,unknown>=>{if(!isRecord(value)||Object.keys(value).some(key=>!keys.includes(key)))throw invalid();return value}
const text=(value:unknown,max:number):string=>{if(typeof value!=='string'||!value.trim()||value.length>max)throw invalid();return value.trim()}
const owner=(value:string):void=>{if(typeof value!=='string'||!value.trim()||value.length>128)throw new WorkError('teloa/forbidden','需要有效的本人身份。')}
const stamp=(value:unknown):string=>{if(!(value instanceof Date)||!Number.isFinite(value.getTime()))throw corrupt();return value.toISOString()}

function source(value:unknown):PlanSource{
 if(!isRecord(value)||typeof value.kind!=='string')throw invalid()
 if(value.kind==='manual'){object(value,['kind']);return {kind:'manual'}}
 // Auto Dream 的系统计划由服务端自建，roleId 必须与计划负责岗位一致。
 if(value.kind==='system-digest'){const row=object(value,['kind','roleId']);if(!uuid(row.roleId))throw invalid();return {kind:'system-digest',roleId:row.roleId}}
 if(value.kind!=='market-content')throw invalid()
 const row=object(value,['kind','contentId','contentHash','resourceId','resourceVersion'])
 if(!uuid(row.contentId)||!hash(row.contentHash)||!stableId(row.resourceId)||!semver(row.resourceVersion))throw invalid()
 return {kind:'market-content',contentId:row.contentId,contentHash:row.contentHash,resourceId:row.resourceId,resourceVersion:row.resourceVersion}
}
export {source as planSource}
function trigger(value:unknown):ScheduleTrigger{try{return readScheduleTrigger(value)}catch{throw invalid()}}
function policy(value:unknown):PlanNotificationPolicy{if(!planNotificationPolicies.includes(value as PlanNotificationPolicy))throw invalid();return value as PlanNotificationPolicy}
function definition(value:unknown,requirePolicy:true):PlanFields
function definition(value:unknown,requirePolicy?:false):StoredPlanFields
function definition(value:unknown,requirePolicy=false):StoredPlanFields{
 const row=object(value,['title','goal','scope','dataScope','delivery','roleId','trigger','notificationPolicy']),task=taskDefinition({title:row.title,goal:row.goal,scope:row.scope})
 if(!uuid(row.roleId))throw invalid()
 const notificationPolicy=row.notificationPolicy===undefined?undefined:policy(row.notificationPolicy)
 if(requirePolicy&&notificationPolicy===undefined)throw invalid()
 return {title:task.title,goal:task.goal,scope:task.scope,dataScope:text(row.dataScope,8000),delivery:text(row.delivery,8000),roleId:row.roleId,trigger:trigger(row.trigger),...(notificationPolicy?{notificationPolicy}:{})}
}
function creationSpec(value:unknown):{fields:PlanFields;expectedRoleVersion:number;source:PlanSource;normalized:Record<string,unknown>}{
 const row=object(value,['fields','source']),raw=object(row.fields,['title','goal','scope','dataScope','delivery','roleId','expectedRoleVersion','trigger','notificationPolicy'])
 if(!Number.isSafeInteger(raw.expectedRoleVersion)||Number(raw.expectedRoleVersion)<1)throw invalid()
 const {expectedRoleVersion:rawExpectedRoleVersion,...rawFields}=raw
 const fields=definition(rawFields,true),expectedRoleVersion=Number(rawExpectedRoleVersion),fixedSource=source(row.source)
 return {fields,expectedRoleVersion,source:fixedSource,normalized:{fields:{...fields,expectedRoleVersion},source:fixedSource}}
}
function updateFields(value:unknown):PlanUpdateFields{
 const row=object(value,['title','goal','dataScope','delivery','trigger','notificationPolicy'])
 const base=taskDefinition({title:row.title,goal:row.goal,scope:'general'})
 if(!text(row.dataScope,8000)||!text(row.delivery,8000)||!planNotificationPolicies.includes(row.notificationPolicy as PlanNotificationPolicy))throw invalid()
 return {title:base.title,goal:base.goal,dataScope:text(row.dataScope,8000),delivery:text(row.delivery,8000),trigger:trigger(row.trigger),notificationPolicy:row.notificationPolicy as PlanNotificationPolicy}
}
function createInput(input:unknown):{requestId:string;fields:PlanFields;expectedRoleVersion:number;source:PlanSource;spec:Record<string,unknown>}{
 const row=object(input,['requestId','fields','source']);if(!uuid(row.requestId))throw invalid()
 const parsed=creationSpec({fields:row.fields,source:row.source})
 return {requestId:row.requestId,fields:parsed.fields,expectedRoleVersion:parsed.expectedRoleVersion,source:parsed.source,spec:parsed.normalized}
}
export function readStoredPlan(row:Record<string,unknown>):PersistentPlan{
 try{
  const fields=definition(row.definition),fixedSource=source(row.source),storedPolicy=row.notification_policy===null||row.notification_policy===undefined?undefined:policy(row.notification_policy)
  if(fields.notificationPolicy!==storedPolicy)throw Error()
  if(!uuid(row.id)||typeof row.owner_id!=='string'||!row.owner_id||!Number.isSafeInteger(row.role_version)||Number(row.role_version)<1||row.role_id!==fields.roleId||row.scope!==fields.scope||!Number.isSafeInteger(row.version)||Number(row.version)<1||!Number.isSafeInteger(row.config_version)||Number(row.config_version)<1||!['paused','active','archived'].includes(String(row.state)))throw Error()
  const hasRequestId=row.request_id!==undefined,hasRequestSpec=row.request_spec!==undefined
  if(hasRequestId!==hasRequestSpec)throw Error()
  if(hasRequestId){
   if(!uuid(row.request_id))throw Error()
   const requestFields=object((object(row.request_spec,['fields','source'])).fields,['title','goal','scope','dataScope','delivery','roleId','expectedRoleVersion','trigger','notificationPolicy'])
   const expectedRoleVersion=requestFields.expectedRoleVersion,{expectedRoleVersion:_expected,...rawFields}=requestFields,request={fields:definition(rawFields),expectedRoleVersion,source:source((row.request_spec as Record<string,unknown>).source)}
   if(!Number.isSafeInteger(request.expectedRoleVersion)||Number(request.expectedRoleVersion)<1||request.expectedRoleVersion!==row.role_version||request.fields.roleId!==fields.roleId||request.fields.scope!==fields.scope||JSON.stringify(request.source)!==JSON.stringify(fixedSource)||(Number(row.config_version)===1&&JSON.stringify(request.fields)!==JSON.stringify(fields)))throw Error()
  }
  const archived=row.state==='archived'
  if(archived?(typeof row.archived_reason!=='string'||!row.archived_reason.trim()||row.archived_reason.length>4000||row.archived_at===null):(row.archived_reason!==null||row.archived_at!==null))throw Error()
  return {...fields,id:row.id,ownerId:row.owner_id,roleVersion:Number(row.role_version),source:fixedSource,version:Number(row.version),configVersion:Number(row.config_version),state:row.state as PersistentPlan['state'],archivedReason:archived?row.archived_reason as string:null,archivedAt:archived?stamp(row.archived_at):null,createdAt:stamp(row.created_at),updatedAt:stamp(row.updated_at)}
 }catch(error){if(error instanceof WorkError&&error.code==='teloa/storage-corrupt')throw error;throw corrupt()}
}
function receiptPlan(value:unknown):PersistentPlan{
 try{
  const row=object(value,['id','ownerId','title','goal','scope','dataScope','delivery','roleId','roleVersion','trigger','notificationPolicy','source','version','configVersion','state','archivedReason','archivedAt','createdAt','updatedAt'])
  const date=(stampValue:unknown):Date=>{if(typeof stampValue!=='string')throw Error();const parsed=new Date(stampValue);if(!Number.isFinite(parsed.getTime())||parsed.toISOString()!==stampValue)throw Error();return parsed}
  return readStoredPlan({id:row.id,owner_id:row.ownerId,definition:{title:row.title,goal:row.goal,scope:row.scope,dataScope:row.dataScope,delivery:row.delivery,roleId:row.roleId,trigger:row.trigger,...(Object.hasOwn(row,'notificationPolicy')?{notificationPolicy:row.notificationPolicy}:{})},notification_policy:row.notificationPolicy??null,source:row.source,role_id:row.roleId,role_version:row.roleVersion,scope:row.scope,version:row.version,config_version:row.configVersion,state:row.state,archived_reason:row.archivedReason,archived_at:row.archivedAt===null?null:date(row.archivedAt),created_at:date(row.createdAt),updated_at:date(row.updatedAt)})
 }catch{throw corrupt()}
}
function immutablePlan(plan:PersistentPlan):string{return JSON.stringify({title:plan.title,goal:plan.goal,scope:plan.scope,dataScope:plan.dataScope,delivery:plan.delivery,roleId:plan.roleId,roleVersion:plan.roleVersion,trigger:plan.trigger,...(plan.notificationPolicy?{notificationPolicy:plan.notificationPolicy}:{}),source:plan.source,configVersion:plan.configVersion,createdAt:plan.createdAt})}
function validateRole(row:Record<string,unknown>,fields:PlanFieldValues,expectedVersion:number):void{
 let value:ReturnType<typeof roleDefinition>;try{value=roleDefinition(row.definition)}catch{throw new WorkError('teloa/storage-corrupt','负责员工定义损坏，已停止持续计划操作。')}
 if(row.version!==expectedVersion)throw new WorkError('teloa/version-conflict','负责员工版本已变化，请重新核对计划。')
 if(row.state!=='active'||value.kind!=='employee')throw new WorkError('teloa/conflict','只有在岗员工可以负责持续计划。')
 if(!roleSupportsScope(value.scopes,fields.scope))throw new WorkError('teloa/forbidden','负责员工不支持计划所属业务。')
}

export async function initializePlans(pool:Pool):Promise<void>{
 await pool.query(`create unique index if not exists teloa_roles_identity_owner on teloa_roles(id,owner_id);
 create table if not exists teloa_plans(
  id uuid primary key,owner_id text not null,request_id uuid not null,request_spec jsonb not null check(jsonb_typeof(request_spec)='object'),
  definition jsonb not null check(jsonb_typeof(definition)='object'),source jsonb not null check(jsonb_typeof(source)='object'),notification_policy text check(notification_policy in ('always','attention','failure','silent')),
  role_id uuid not null,role_version integer not null check(role_version>0),scope text not null,
  version integer not null check(version>0),config_version integer not null check(config_version>0),
  state text not null check(state in ('paused','active','archived')),archived_reason text,archived_at timestamptz,
  created_at timestamptz not null,updated_at timestamptz not null,unique(owner_id,request_id),unique(id,owner_id),
  foreign key(role_id,owner_id) references teloa_roles(id,owner_id),
  check((state='archived' and archived_reason is not null and archived_at is not null) or (state<>'archived' and archived_reason is null and archived_at is null))
 );
 create table if not exists teloa_plan_changes(
  owner_id text not null,request_id uuid not null,plan_id uuid not null,request_spec jsonb not null check(jsonb_typeof(request_spec)='object'),
  result jsonb not null check(jsonb_typeof(result)='object'),created_at timestamptz not null,primary key(owner_id,request_id),
  foreign key(plan_id,owner_id) references teloa_plans(id,owner_id)
 );
 alter table teloa_plans add column if not exists notification_policy text;
 do $$ begin if not exists(select 1 from pg_constraint where conrelid='teloa_plans'::regclass and conname='teloa_plans_notification_policy_check') then alter table teloa_plans add constraint teloa_plans_notification_policy_check check(notification_policy in ('always','attention','failure','silent')); end if; end $$;
 create index if not exists teloa_plans_scheduler_order on teloa_plans(owner_id,id)`)
}

export async function verifyPlanSource(ownerId:string,value:PlanSource,marketSources?:PlanMarketSources,client?:PoolClient):Promise<void>{
  // 系统计划的来源由服务端自建，无外部来源可核。
  if(value.kind==='manual'||value.kind==='system-digest')return
  if(!marketSources)throw new WorkError('teloa/source-unavailable','市场来源服务尚未接入。')
  let content:MarketContent
  try{content=client&&marketSources.getInTransaction?await marketSources.getInTransaction(client,{ownerId,kind:'human'},{contentId:value.contentId}):await marketSources.get({ownerId,kind:'human'},{contentId:value.contentId})}catch(error){if(error instanceof WorkError&&error.code==='teloa/storage-corrupt')throw error;throw new WorkError('teloa/source-unavailable','计划来源不存在或当前本人不可读取。')}
  const provided=content.provides.find(item=>item.resourceId===value.resourceId)
  if(content.hash!==value.contentHash||!provided||!['plan','work-template'].includes(provided.kind)||provided.version!==value.resourceVersion)throw new WorkError('teloa/source-unavailable','计划来源身份、版本或内容摘要不匹配。')
}

export class PlanService{
 readonly pool:Pool
 readonly identity:{id:()=>string;now:()=>string}
 readonly marketSources:PlanMarketSources|undefined
 constructor(pool:Pool,identity:{id:()=>string;now:()=>string},marketSources?:PlanMarketSources){this.pool=pool;this.identity=identity;this.marketSources=marketSources}
 private verifySource(ownerId:string,value:PlanSource,client?:PoolClient):Promise<void>{return verifyPlanSource(ownerId,value,this.marketSources,client)}
 /**
  * 行业模板创建的计划只能在仍在生效的加载上重新启用：加载已卸载或已被升级替代时，卸载与升级都把它暂停过，
  * 再启用等于让失效血缘继续派工。缺表即视为该装配没有行业来源，判据无从成立，照常放行。
  */
 private async verifyIndustryLoad(client:PoolClient,ownerId:string,planId:string):Promise<void>{
  const names=['teloa_industry_plan_sources','teloa_industry_loads']
  const present=(await client.query('select name from unnest($1::text[]) as name where to_regclass(name) is not null',[names])).rows.length
  if(present!==names.length)return
  const row=(await client.query(`select l.status from teloa_industry_plan_sources s join teloa_industry_loads l on l.id::text=s.source_snapshot->>'loadId' and l.owner_id=s.owner_id where s.plan_id=$1 and s.owner_id=$2`,[planId,ownerId])).rows[0]
  if(row&&row.status!=='active')throw new WorkError('teloa/conflict','行业模板已卸载或已被升级替代，不能重新启用该持续计划。')
 }
 async list(ownerId:string,input:unknown):Promise<PersistentPlan[]>{owner(ownerId);object(input,[]);return (await this.pool.query('select * from teloa_plans where owner_id=$1 order by created_at,id',[ownerId])).rows.map(readStoredPlan)}
 /** 宿主调度目录逐行报告坏记录，不改变客户端 list 的完整读取约束。 */
 async schedulerPlans(ownerId:string,input:unknown):Promise<{items:PersistentPlan[];errors?:{planId:string;code:'teloa/storage-corrupt'}[];cursor?:{id:string}}>{
  owner(ownerId);const value=object(input,['limit','cursor'])
  if(!Number.isSafeInteger(value.limit)||Number(value.limit)<1||Number(value.limit)>100)throw invalid()
  const limit=Number(value.limit)
  let cursor:string|undefined
  if(value.cursor!==undefined){
   const row=object(value.cursor,['id']);if(!uuid(row.id))throw invalid();cursor=row.id
   if(!(await this.pool.query('select id from teloa_plans where id=$1 and owner_id=$2',[cursor,ownerId])).rowCount)throw new WorkError('teloa/forbidden','计划扫描游标不存在或不属于当前本人。')
  }
  const rows=(await this.pool.query('select * from teloa_plans where owner_id=$1 and ($2::uuid is null or id>$2::uuid) order by id limit $3',[ownerId,cursor??null,limit+1])).rows
  const entries=rows.slice(0,limit).map(row=>{
   if(!uuid(row.id)||row.owner_id!==ownerId)throw corrupt()
   try{return {id:row.id,plan:readStoredPlan(row)}}
   catch(error){if(!(error instanceof WorkError)||error.code!=='teloa/storage-corrupt')throw error;return {id:row.id,error:{planId:row.id,code:'teloa/storage-corrupt' as const}}}
  })
  const errors=entries.flatMap(entry=>entry.error?[entry.error]:[])
  return {items:entries.flatMap(entry=>entry.plan?[entry.plan]:[]),...(errors.length?{errors}:{}),...(rows.length>limit?{cursor:{id:entries.at(-1)!.id}}:{})}
 }
 async get(ownerId:string,input:unknown):Promise<PersistentPlan>{
  owner(ownerId);const row=object(input,['planId']);if(!uuid(row.planId))throw invalid()
  const found=(await this.pool.query('select * from teloa_plans where id=$1 and owner_id=$2',[row.planId,ownerId])).rows[0]
  if(!found)throw new WorkError('teloa/forbidden','持续计划不存在或不属于当前本人。')
  return readStoredPlan(found)
 }
 /**
  * 人类入口（`plan/create` 端点直达）不接受 Auto Dream 的系统计划来源：
  * 系统计划由服务端随员工在岗自动建出（`auto-dream-plans.ts`），且按 `changeInTransaction` 的判据不能归档，
  * 手工建出来的一条会删不掉。服务端自建走 `createInTransaction`，不经这道门。
  */
 async create(ownerId:string,input:unknown):Promise<PersistentPlan>{
  owner(ownerId)
  if(isRecord(input)&&isRecord(input.source)&&input.source.kind==='system-digest')throw new WorkError('teloa/forbidden','Auto Dream 的系统计划随员工在岗自动建立，不能手工新建。')
  const client=await this.pool.connect()
  try{await client.query('begin')
   const plan=await this.createInTransaction(client,ownerId,input);await client.query('commit');return plan
  }catch(error){await client.query('rollback');throw error}finally{client.release()}
 }
 async createInTransaction(client:PoolClient,ownerId:string,input:unknown):Promise<PersistentPlan>{
   owner(ownerId);const value=createInput(input)
   // 系统计划的来源身份必须就是它负责的那位员工：不一致会让每日小结的运行判据与闸永远判不出来。
   if(value.source.kind==='system-digest'&&value.source.roleId!==value.fields.roleId)throw invalid()
   await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['plan-create',ownerId,value.requestId])])
   const prior=await client.query('select *,request_spec=$3::jsonb same_request from teloa_plans where owner_id=$1 and request_id=$2',[ownerId,value.requestId,JSON.stringify(value.spec)])
   if(prior.rows[0]){if(!prior.rows[0].same_request)throw new WorkError('teloa/conflict','同一请求不能创建不同的持续计划。');return readStoredPlan(prior.rows[0])}
   // 一位员工至多一条系统计划：多出来的第二条会让同一天被领取两次。原请求重放已在上一行返回，不受这条影响。
   // 「查不到就建」这一段必须按员工串起来，否则两次并发招聘/复岗各自查空、各插一条。
   if(value.source.kind==='system-digest'){
    await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['plan-system-digest',ownerId,value.source.roleId])])
    if((await client.query("select 1 from teloa_plans where owner_id=$1 and source->>'kind'='system-digest' and source->>'roleId'=$2 limit 1",[ownerId,value.source.roleId])).rowCount)throw new WorkError('teloa/conflict','这位员工已经有一条 Auto Dream 的系统计划。')
   }
   // 业务范围必须已登记在标签表（规格 §3.2）；判据在任何写之前，未登记时整笔事务不留痕迹。
   await assertBusinessScopeRegistered(client,ownerId,value.fields.scope)
   await this.verifySource(ownerId,value.source,client)
   const role=(await client.query('select * from teloa_roles where id=$1 and owner_id=$2 for share',[value.fields.roleId,ownerId])).rows[0] as Record<string,unknown>|undefined
   if(!role)throw new WorkError('teloa/forbidden','负责员工不存在或不属于当前本人。')
   validateRole(role,value.fields,value.expectedRoleVersion)
   const admission=await workAccess.authorize({kind:'capability',capability:'automation',ownerId,sessionId:null,objectId:value.requestId,operation:'create'})
   admission.assertCurrent()
   const now=this.identity.now(),inserted=(await client.query(`insert into teloa_plans(id,owner_id,request_id,request_spec,definition,source,notification_policy,role_id,role_version,scope,version,config_version,state,archived_reason,archived_at,created_at,updated_at)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,1,'paused',null,null,$11,$11) returning *`,[this.identity.id(),ownerId,value.requestId,JSON.stringify(value.spec),JSON.stringify(value.fields),JSON.stringify(value.source),value.fields.notificationPolicy,value.fields.roleId,value.expectedRoleVersion,value.fields.scope,now])).rows[0]
   admission.assertCurrent();return readStoredPlan(inserted)
 }
 async change(ownerId:string,input:unknown):Promise<PersistentPlan>{
  owner(ownerId);const client=await this.pool.connect()
  try{await client.query('begin')
   const plan=await this.changeInTransaction(client,ownerId,input);await client.query('commit');return plan
  }catch(error){await client.query('rollback');throw error}finally{client.release()}
 }
 /**
  * 与 `create`/`createInTransaction` 同构：调用方已开事务时复用同一连接，
  * 卸载行业模板要在同一事务里把该加载的计划置为暂停，因此不能自己 `begin`/`commit`。
  * `pause` 的 `note` 只记在变更台账 `teloa_plan_changes.request_spec` 里，
  * `archived_reason` 仍由数据库约束限定为归档专用，计划本身的对外形状不变。
  */
 async changeInTransaction(client:PoolClient,ownerId:string,input:unknown):Promise<PersistentPlan>{
  owner(ownerId);const row=object(input,['planId','requestId','expectedVersion','expectedConfigVersion','action','note','fields'])
  if(!uuid(row.planId)||!uuid(row.requestId)||!Number.isSafeInteger(row.expectedVersion)||Number(row.expectedVersion)<1||!['enable','pause','archive','update'].includes(String(row.action)))throw invalid()
  const action=row.action as 'enable'|'pause'|'archive'|'update';let note:string|undefined,fields:PlanUpdateFields|undefined
  if(action==='archive')note=text(row.note,4000)
  else if(action==='pause'&&row.note!==undefined)note=text(row.note,4000)
  else if(row.note!==undefined)throw invalid()
  if(action==='update'){if(!Number.isSafeInteger(row.expectedConfigVersion)||Number(row.expectedConfigVersion)<1)throw invalid();fields=updateFields(row.fields)}else if(row.fields!==undefined||row.expectedConfigVersion!==undefined)throw invalid()
  const spec={planId:row.planId,expectedVersion:Number(row.expectedVersion),action,...(action==='update'?{expectedConfigVersion:Number(row.expectedConfigVersion)}:{}),...(note?{note}:{}),...(fields?{fields}:{})}
  await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['plan-change',ownerId,row.requestId])])
  const currentRow=(await client.query('select * from teloa_plans where id=$1 and owner_id=$2',[row.planId,ownerId])).rows[0] as Record<string,unknown>|undefined
  if(!currentRow)throw new WorkError('teloa/forbidden','持续计划不存在或不属于当前本人。')
  const current=readStoredPlan(currentRow)
  const prior=(await client.query('select *,request_spec=$3::jsonb same_request from teloa_plan_changes where owner_id=$1 and request_id=$2',[ownerId,row.requestId,JSON.stringify(spec)])).rows[0]
  if(prior){
   if(!prior.same_request||prior.plan_id!==current.id)throw new WorkError('teloa/conflict','原请求已记录其他计划操作。')
   const saved=receiptPlan(prior.result),target=action==='enable'?'active':action==='pause'?'paused':action==='archive'?'archived':current.state,receiptAt=stamp(prior.created_at)
   const sameUpdate=action!=='update'||(saved.title===fields!.title&&saved.goal===fields!.goal&&saved.dataScope===fields!.dataScope&&saved.delivery===fields!.delivery&&JSON.stringify(saved.trigger)===JSON.stringify(fields!.trigger)&&saved.notificationPolicy===fields!.notificationPolicy&&saved.roleId===current.roleId&&saved.scope===current.scope)
   if(saved.id!==current.id||saved.ownerId!==ownerId||saved.version!==Number(row.expectedVersion)+1||saved.state!==target||!sameUpdate||saved.configVersion!==(action==='update'?Number(row.expectedConfigVersion)+1:current.configVersion)||action!=='update'&&immutablePlan(saved)!==immutablePlan(current)||saved.updatedAt!==receiptAt||saved.archivedReason!==(action==='archive'?note!:null)||action==='archive'&&saved.archivedAt!==receiptAt)throw corrupt()
   return saved
  }
  const role=(await client.query('select * from teloa_roles where id=$1 and owner_id=$2 for share',[current.roleId,ownerId])).rows[0] as Record<string,unknown>|undefined
  if(!role)throw corrupt()
  const locked=readStoredPlan((await client.query('select * from teloa_plans where id=$1 and owner_id=$2 for update',[current.id,ownerId])).rows[0])
  if(locked.roleId!==current.roleId||locked.scope!==current.scope)throw corrupt()
  if(locked.version!==row.expectedVersion||action==='update'&&locked.configVersion!==row.expectedConfigVersion)throw new WorkError('teloa/version-conflict','持续计划版本已变化，请重新核对。')
  if(locked.state==='archived'||action==='enable'&&locked.state!=='paused'||action==='pause'&&locked.state!=='active')throw new WorkError('teloa/conflict','当前持续计划状态不能执行此操作。')
  if(locked.source.kind==='system-digest'){
   if(action==='archive')throw new WorkError('teloa/forbidden','Auto Dream 的系统计划不能归档；请暂停它，或暂停这位员工。')
   if(action==='update'){
    const next=fields!
    // 只放行时刻与时区；其余字段任何差异一律 teloa/forbidden，不静默忽略。
    if(next.title!==locked.title||next.goal!==locked.goal||next.dataScope!==locked.dataScope||next.delivery!==locked.delivery||next.notificationPolicy!==locked.notificationPolicy||next.trigger.kind!==locked.trigger.kind||next.trigger.cadence!==locked.trigger.cadence||next.trigger.weekday!==locked.trigger.weekday)throw new WorkError('teloa/forbidden','Auto Dream 的系统计划只能改时刻与时区。')
   }
  }
  /**
   * 用户建的计划按创建时固定的岗位版本核对：岗位改过就该由本人重新核对再启用。
   * Auto Dream 的系统计划相反——它是随岗位生命周期走的附属物，而暂停与复岗本身各把岗位版本加一，
   * 按固定版本核对会让「复岗」这条路径永远启用不回来。改按岗位当前版本核对，
   * `validateRole` 的其余三条（在岗、AI 员工、范围仍覆盖计划所属业务）一字不变。
   */
  if(action==='enable'){await this.verifyIndustryLoad(client,ownerId,locked.id);validateRole(role,locked,locked.source.kind==='system-digest'?Number(role.version):locked.roleVersion);await this.verifySource(ownerId,locked.source,client)}
  const admission=action==='enable'||action==='update'?await workAccess.authorize({kind:'capability',capability:'automation',ownerId,sessionId:null,objectId:locked.id,operation:action==='enable'?'resume':'edit'}):undefined
  admission?.assertCurrent()
  const state=action==='enable'?'active':action==='pause'?'paused':action==='archive'?'archived':locked.state,now=this.identity.now(),definition=action==='update'?{...locked,...fields}:locked
  const saved=readStoredPlan((await client.query(`update teloa_plans set definition=$3,notification_policy=$4,state=$5,version=version+1,config_version=config_version+$6,archived_reason=$7,archived_at=$8,updated_at=$9 where id=$1 and owner_id=$2 returning *`,[locked.id,ownerId,JSON.stringify({title:definition.title,goal:definition.goal,scope:locked.scope,dataScope:definition.dataScope,delivery:definition.delivery,roleId:locked.roleId,trigger:definition.trigger,notificationPolicy:definition.notificationPolicy}),definition.notificationPolicy,state,action==='update'?1:0,action==='archive'?note!:null,action==='archive'?now:null,now])).rows[0])
  await client.query('insert into teloa_plan_changes(owner_id,request_id,plan_id,request_spec,result,created_at) values($1,$2,$3,$4,$5,$6)',[ownerId,row.requestId,locked.id,JSON.stringify(spec),JSON.stringify(saved),now])
  admission?.assertCurrent();return saved
 }
}

import {createHash,randomUUID} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import type {Pool,PoolClient} from 'pg'
import {roleSupportsScope,artifactContent,WorkError} from '@teloa/contract'
import {EmployeeApiError,employeeApiId,readEmployeeApiRequest,type EmployeeModelSelection,type EmployeePermissionMode,type EmployeeWork,type EmployeeWorkResult} from '../../../sdk/contract.mjs'
import {EmployeeIntegrationService,readEmployeeIntegration,type EmployeeIntegrationIdentity} from './employee-integrations.ts'
import {TaskService,readStoredTask} from './tasks.ts'
import {TaskTransitions} from './task-transitions.ts'
import {readStoredRole} from './roles.ts'
import {ArtifactService} from './artifacts.ts'
import {taskArtifactSource} from './artifact-task-source.ts'
import {WorkProgressService} from './work-progress.ts'
import {WorkLineageService} from './work-lineage.ts'
import {workRequestChildId} from './conversation-work-task-protection.ts'
import type {TaskRun} from './task-runs.ts'

type Db=Pool|PoolClient
const hash=(value:string)=>createHash('sha256').update(value).digest('hex')
const terminal=new Set(['succeeded','failed','cancelled'])
/** 升级前的 API 工作在默认 workspace-write/ask 会话中执行；不清空为完全权限。 */
export const legacyEmployeePermissionMode:EmployeePermissionMode='workspace-write'
const artifactTextLimit=64000
const artifactSectionLimit=16000
type RoundConfig={permissionMode:EmployeePermissionMode;model:EmployeeModelSelection|null}
type DeliveryResult={ok:true;artifactId:string;artifactVersion:number;taskVersion:number}|{ok:false;error:string}
export type EmployeeApiRuntime={
 prepare:(owner:string,input:{requestId:string;taskId:string;expectedTaskVersion:number;permissionMode?:EmployeePermissionMode;model?:EmployeeModelSelection},signal:AbortSignal)=>Promise<TaskRun>
 start:(owner:string,runId:string,signal:AbortSignal)=>Promise<TaskRun>
 read:(owner:string,runId:string,signal:AbortSignal)=>Promise<TaskRun>
 stop:(owner:string,runId:string,signal:AbortSignal)=>Promise<TaskRun>
 withdraw:(owner:string,runId:string,signal:AbortSignal)=>Promise<TaskRun>
 waiting?:(run:TaskRun)=>Promise<boolean>
 result:(run:TaskRun)=>Promise<{text:string;review:'accepted'|'unreviewed'}|undefined>
 /** 命令落库前核对原生权限预设与平台模型目录；不读取密钥，也不改员工档案。 */
 check?:(options:{permissionMode:EmployeePermissionMode;model:EmployeeModelSelection|null},signal:AbortSignal)=>Promise<void>
}
export async function initializeEmployeeApiWork(pool:Pool){
 await pool.query(`
 create table if not exists teloa_employee_api_work(
  id uuid primary key,owner_id text not null,integration_id uuid not null,title text not null,
  employee_id uuid not null,employee_version integer not null check(employee_version>0),scope text not null,
  version integer not null check(version>0),round integer not null check(round>0),
  state text not null check(state in ('queued','running','waiting','succeeded','failed','cancel_requested','cancelled')),
  result_version integer,error text,created_at timestamptz not null,updated_at timestamptz not null,next_check_at timestamptz not null default now(),
  unique(owner_id,id),foreign key(owner_id,integration_id) references teloa_employee_integrations(owner_id,id)
 );
 create table if not exists teloa_employee_api_rounds(
  work_id uuid not null references teloa_employee_api_work(id),round integer not null check(round>0),
  request_id uuid not null unique,task_id uuid,task_version integer,run_id uuid,
  input text not null,primary key(work_id,round),foreign key(task_id) references teloa_tasks(id)
 );
 create table if not exists teloa_employee_api_commands(
  integration_id uuid not null references teloa_employee_integrations(id),request_id uuid not null,
  request_spec jsonb not null,response jsonb not null,primary key(integration_id,request_id)
 );
 create table if not exists teloa_employee_api_results(
  work_id uuid not null references teloa_employee_api_work(id),version integer not null,round integer not null,
  text text not null,sha256 text not null,review text not null check(review in ('accepted','unreviewed')),
  created_at timestamptz not null,primary key(work_id,version)
 );
 create table if not exists teloa_employee_api_events(
  cursor bigserial primary key,id uuid not null unique,work_id uuid not null references teloa_employee_api_work(id),
  version integer not null,body jsonb not null,created_at timestamptz not null,unique(work_id,version)
 );
 create table if not exists teloa_employee_api_deliveries(
  event_id uuid primary key references teloa_employee_api_events(id),integration_id uuid not null references teloa_employee_integrations(id),
  attempts integer not null default 0,state text not null check(state in ('pending','delivered','failed','cancelled')),
  next_at timestamptz not null,lease_until timestamptz,lease_id uuid,last_status integer,updated_at timestamptz not null
 );
 create table if not exists teloa_employee_api_round_deliveries(
  work_id uuid not null,round integer not null,request_id uuid not null unique,task_id uuid not null references teloa_tasks(id),
  artifact_id uuid not null references teloa_artifacts(id),artifact_version integer not null check(artifact_version>0),
  task_version integer not null check(task_version>1),result_version integer not null check(result_version>0),
  note text not null,delivered_at timestamptz not null,primary key(work_id,round),
  foreign key(work_id,round) references teloa_employee_api_rounds(work_id,round)
 );
 create index if not exists teloa_employee_api_pending on teloa_employee_api_work(updated_at) where state in ('queued','running','waiting','cancel_requested');
 alter table teloa_employee_api_work add column if not exists delivery_required boolean not null default false;
 alter table teloa_employee_api_rounds add column if not exists permission_mode text;
 alter table teloa_employee_api_rounds add column if not exists model_provider text;
 alter table teloa_employee_api_rounds add column if not exists model_id text;
 alter table teloa_employee_api_rounds add column if not exists model_reasoning_effort text;
 `)
 // 只补已经保存固定结果、任务仍等待验收的旧工作；任务已有结论时不改写历史状态。
 await pool.query(`update teloa_employee_api_work w set delivery_required=true,next_check_at=now()
  where w.state='succeeded' and w.result_version is not null and w.delivery_required=false
  and not exists(select 1 from teloa_employee_api_round_deliveries d where d.work_id=w.id and d.round=w.round)
  and exists(select 1 from teloa_employee_api_rounds r join teloa_tasks t on t.id=r.task_id and t.owner_id=w.owner_id
   where r.work_id=w.id and r.round=w.round and t.state='waiting')`)
}
function roundConfig(row:Record<string,any>|undefined):RoundConfig{
 const mode=row?.permission_mode
 return {
  permissionMode:mode==='danger-full-access'||mode==='workspace-write'||mode==='read-only'?mode:legacyEmployeePermissionMode,
  model:typeof row?.model_provider==='string'&&row.model_provider&&typeof row.model_id==='string'&&row.model_id
   ?{provider:row.model_provider,model:row.model_id,...(typeof row.model_reasoning_effort==='string'&&row.model_reasoning_effort?{reasoningEffort:row.model_reasoning_effort}:{})}
   :null,
 }
}
function sameModel(a:EmployeeModelSelection|null,b:EmployeeModelSelection|null){return JSON.stringify(a)===JSON.stringify(b)}
function publicWork(row:Record<string,any>,config?:RoundConfig):EmployeeWork{
 const id=employeeApiId(row.id),round=row.round
 return {id,employeeId:row.employee_id,employeeVersion:row.employee_version,version:row.version,round,state:row.state,title:row.title,createdAt:new Date(row.created_at).toISOString(),updatedAt:new Date(row.updated_at).toISOString(),resultVersion:row.result_version??null,error:row.error??null,permissionMode:config?.permissionMode??legacyEmployeePermissionMode,model:config?.model??null,links:{self:'/api/v1/works/'+id,result:'/api/v1/works/'+id+'/result',events:'/api/v1/works/'+id+'/events'}}
}
/** 完整正文按码点分段，超过成果容量上限时明确失败，绝不截断后冒充完整交付。 */
function artifactSections(text:string){
 const chunks:string[]=[];let chunk=''
 for(const character of text){if(chunk.length+character.length>artifactSectionLimit){chunks.push(chunk);chunk=''}chunk+=character}
 if(chunk)chunks.push(chunk)
 return chunks.map((value,index)=>({id:'api-result-'+(index+1),title:chunks.length===1?'报告正文':'报告正文（'+(index+1)+'/'+chunks.length+'）',text:value}))
}
export class EmployeeApiWorkService{
 readonly pool:Pool;readonly integrations:EmployeeIntegrationService;readonly runtime:EmployeeApiRuntime;readonly owner:string;readonly now:()=>Date
 constructor(pool:Pool,integrations:EmployeeIntegrationService,runtime:EmployeeApiRuntime,owner:string,now:()=>Date=()=>new Date()){this.pool=pool;this.integrations=integrations;this.runtime=runtime;this.owner=owner;this.now=now}
 private async owned(db:Db,identity:EmployeeIntegrationIdentity,id:string,lock=false){
  const row=(await db.query('select * from teloa_employee_api_work where owner_id=$1 and integration_id=$2 and id=$3'+(lock?' for update':''),[identity.ownerId,identity.id,employeeApiId(id)])).rows[0]
  if(!row)throw new EmployeeApiError('not_found','Work was not found in this integration.',404)
  return row
 }
 private async round(db:Db,workId:string,round:number){
  return (await db.query('select * from teloa_employee_api_rounds where work_id=$1 and round=$2',[workId,round])).rows[0]
 }
 private async availableRole(db:Db,identity:EmployeeIntegrationIdentity){
  const row=(await db.query('select * from teloa_roles where owner_id=$1 and id=$2',[identity.ownerId,identity.employeeId])).rows[0]
  if(!row)throw new EmployeeApiError('employee_unavailable','The employee is unavailable.',409)
  const role=readStoredRole(row)
  if(role.kind!=='employee'||role.state!=='active'||!role.responsibility||role.version!==identity.employeeVersion||!roleSupportsScope(role.scopes,identity.scope))throw new EmployeeApiError('employee_changed','Employee configuration changed. The owner must create a new integration grant.',409)
  return role
 }
 async employees(identity:EmployeeIntegrationIdentity){
  await this.integrations.current(this.pool,identity,'read')
  const role=await this.availableRole(this.pool,identity)
  return {items:[{id:role.id,version:role.version,name:role.name,description:role.duty,scope:identity.scope,state:'active' as const}]}
 }
 async get(identity:EmployeeIntegrationIdentity,id:string){await this.integrations.current(this.pool,identity,'read');const work=await this.owned(this.pool,identity,id);return publicWork(work,roundConfig(await this.round(this.pool,work.id,work.round)))}
 async result(identity:EmployeeIntegrationIdentity,id:string,version?:number):Promise<EmployeeWorkResult>{
  await this.integrations.current(this.pool,identity,'read');const work=await this.owned(this.pool,identity,id)
  const wanted=version??work.result_version
  if(wanted===null||wanted===undefined)throw new EmployeeApiError('result_not_ready','No fixed result has been saved yet.',409)
  if(!Number.isSafeInteger(wanted)||wanted<1)throw new EmployeeApiError('invalid_request','Invalid result version.')
  const row=(await this.pool.query('select * from teloa_employee_api_results where work_id=$1 and version=$2',[work.id,wanted])).rows[0]
  if(!row)throw new EmployeeApiError('not_found','Result version was not found.',404)
  if(hash(row.text)!==row.sha256)throw new EmployeeApiError('result_unavailable','The fixed result failed its integrity check.',503)
  return {workId:work.id,version:row.version,round:row.round,text:row.text,sha256:row.sha256,review:row.review,createdAt:new Date(row.created_at).toISOString()}
 }
 async events(identity:EmployeeIntegrationIdentity,id:string,after=0){
  if(!Number.isSafeInteger(after)||after<0)throw new EmployeeApiError('invalid_request','Invalid event cursor.')
  await this.integrations.current(this.pool,identity,'read');const work=await this.owned(this.pool,identity,id)
  const rows=(await this.pool.query('select cursor,body from teloa_employee_api_events where work_id=$1 and cursor>$2 order by cursor limit 100',[work.id,after])).rows
  return {items:rows.map(row=>({cursor:Number(row.cursor),event:row.body})),nextCursor:rows.length?Number(rows.at(-1)!.cursor):after}
 }
 private async event(db:PoolClient,row:Record<string,any>,config:RoundConfig){
  const time=this.now(),id=randomUUID(),work=publicWork(row,config)
  const body={specversion:'1.0',id,source:'urn:teloa:employee-integration:'+row.integration_id,type:'ai.teloa.work.changed.v1',subject:'works/'+row.id,time:time.toISOString(),datacontenttype:'application/json',data:work}
  await db.query('insert into teloa_employee_api_events(id,work_id,version,body,created_at) values($1,$2,$3,$4,$5)',[id,row.id,row.version,JSON.stringify(body),time])
  await db.query("insert into teloa_employee_api_deliveries(event_id,integration_id,state,next_at,updated_at) select $1,id,'pending',$3,$3 from teloa_employee_integrations where id=$2 and webhook_url is not null and revoked_at is null and expires_at>$3",[id,row.integration_id,time])
  return work
 }
 private async capacity(db:PoolClient,identity:EmployeeIntegrationIdentity){
  const count=Number((await db.query("select count(*) from teloa_employee_api_work where integration_id=$1 and state in ('queued','running','waiting','cancel_requested')",[identity.id])).rows[0].count)
  if(count>=identity.maxConcurrent)throw new EmployeeApiError('concurrency_limit','This integration has reached its granted concurrent work limit.',429)
 }
 private async task(db:PoolClient,identity:EmployeeIntegrationIdentity,workId:string,round:number,input:string,requestId:string,title:string){
  const task=await new TaskService(this.pool,{id:randomUUID,now:()=>this.now().toISOString()}).createInTransaction(db,identity.ownerId,{requestId,fields:{title,goal:input,scope:identity.scope},assignee:{roleId:identity.employeeId,expectedVersion:identity.employeeVersion}},{kind:'integration',workId,round})
  await db.query('update teloa_employee_api_rounds set task_id=$3,task_version=$4 where work_id=$1 and round=$2',[workId,round,task.id,task.version])
 }
 private async check(options:{permissionMode:EmployeePermissionMode;model:EmployeeModelSelection|null},signal?:AbortSignal){
  await this.runtime.check?.(options,signal??new AbortController().signal)
 }
 /** 命令与 Task 在同一事务落定；同幂等键的不同正文、对象、权限模式、模型或动作返回冲突。 */
 async command(identity:EmployeeIntegrationIdentity,kind:'start'|'continue'|'cancel',requestId:string,input:unknown,workId?:string,signal?:AbortSignal){
  requestId=employeeApiId(requestId)
  const body=kind==='start'?readEmployeeApiRequest('StartWork',input):kind==='continue'?readEmployeeApiRequest('ContinueWork',input):readEmployeeApiRequest('CancelWork',input)
  const spec=JSON.stringify({kind,workId:workId===undefined?null:employeeApiId(workId),body}),db=await this.pool.connect()
  try{
   await db.query('begin');await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',['employee-api:'+identity.id])
   identity=await this.integrations.current(db,identity,kind==='cancel'?'cancel':'execute',true)
   const prior=(await db.query('select request_spec,response from teloa_employee_api_commands where integration_id=$1 and request_id=$2',[identity.id,requestId])).rows[0]
   if(prior){if(!isDeepStrictEqual(prior.request_spec,JSON.parse(spec)))throw new EmployeeApiError('idempotency_conflict','This Idempotency-Key was used for another command.',409);await db.query('commit');return prior.response as EmployeeWork}
   let row:Record<string,any>
   let changed=true
   let config:RoundConfig={permissionMode:legacyEmployeePermissionMode,model:null}
   if(kind==='start'){
    const start=readEmployeeApiRequest('StartWork',body)
    if(start.employeeId!==identity.employeeId)throw new EmployeeApiError('forbidden','This employee is outside the integration grant.',403)
    const role=await this.availableRole(db,identity);await this.capacity(db,identity)
    config={permissionMode:start.permissionMode??'danger-full-access',model:start.model??null}
    await this.check(config,signal)
    const id=randomUUID(),now=this.now(),title=start.title??role.name+'：'+start.input.trim().slice(0,72)
    row=(await db.query("insert into teloa_employee_api_work(id,owner_id,integration_id,title,employee_id,employee_version,scope,version,round,state,created_at,updated_at,next_check_at) values($1,$2,$3,$4,$5,$6,$7,1,1,'queued',$8,$8,$8) returning *",[id,identity.ownerId,identity.id,title,identity.employeeId,identity.employeeVersion,identity.scope,now])).rows[0]
    const runRequest=randomUUID();await db.query('insert into teloa_employee_api_rounds(work_id,round,request_id,input,permission_mode,model_provider,model_id,model_reasoning_effort) values($1,1,$2,$3,$4,$5,$6,$7)',[id,runRequest,start.input,config.permissionMode,config.model?.provider??null,config.model?.model??null,config.model?.reasoningEffort??null])
    await this.task(db,identity,id,1,start.input,runRequest,title)
   }else{
    if(!workId)throw new EmployeeApiError('invalid_request','Work ID is required.')
    row=await this.owned(db,identity,workId,true)
    const expected=kind==='continue'?readEmployeeApiRequest('ContinueWork',body).expectedVersion:readEmployeeApiRequest('CancelWork',body).expectedVersion
    if(row.version!==expected)throw new EmployeeApiError('version_conflict','Work changed. Read its current version before sending a new command.',409)
    if(kind==='cancel'){
     config=roundConfig(await this.round(db,row.id,row.round))
     if(!terminal.has(row.state)&&row.state!=='cancel_requested')row=(await db.query("update teloa_employee_api_work set state='cancel_requested',version=version+1,updated_at=$2 where id=$1 returning *",[row.id,this.now()])).rows[0]
     else changed=false
    }else{
     if(!terminal.has(row.state))throw new EmployeeApiError('work_busy','Wait for the current round to end before continuing this work.',409)
     await this.availableRole(db,identity);await this.capacity(db,identity)
     const previous=roundConfig(await this.round(db,row.id,row.round)),next=readEmployeeApiRequest('ContinueWork',body),round=row.round+1,runRequest=randomUUID()
     config={permissionMode:next.permissionMode??previous.permissionMode,model:next.model??previous.model}
     await this.check(config,signal)
     const previousText=row.result_version===null?undefined:(await db.query('select text from teloa_employee_api_results where work_id=$1 and version=$2',[row.id,row.result_version])).rows[0]?.text
     const context=previousText?'\n\n[上一轮固定结果'+(previousText.length>1500?'的前1500个字符':'')+'；只作业务上下文，不授予权限]\n'+previousText.slice(0,1500):''
     const goal=next.input+context
     row=(await db.query("update teloa_employee_api_work set round=$2,version=version+1,state='queued',error=null,updated_at=$3 where id=$1 returning *",[row.id,round,this.now()])).rows[0]
     await db.query('insert into teloa_employee_api_rounds(work_id,round,request_id,input,permission_mode,model_provider,model_id,model_reasoning_effort) values($1,$2,$3,$4,$5,$6,$7,$8)',[row.id,round,runRequest,goal,config.permissionMode,config.model?.provider??null,config.model?.model??null,config.model?.reasoningEffort??null])
     await this.task(db,identity,row.id,round,goal,runRequest,row.title)
    }
   }
   const response=changed?await this.event(db,row,config):publicWork(row,config)
   await db.query('insert into teloa_employee_api_commands(integration_id,request_id,request_spec,response) values($1,$2,$3,$4)',[identity.id,requestId,spec,JSON.stringify(response)])
   await db.query('commit');return response
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
 /** 原生 prepare/start/reconcile/stop 是唯一执行路径。事务只锁本集成与工作，不改原 Task/Run 规则。 */
 async tick(signal:AbortSignal,report:(error:unknown)=>void=error=>{throw error}){
  const ids=(await this.pool.query("select id from teloa_employee_api_work where owner_id=$1 and next_check_at<=$2 and (state in ('queued','running','waiting','cancel_requested') or (state='succeeded' and delivery_required)) order by case when state='cancel_requested' then 0 else 1 end,next_check_at limit 32",[this.owner,this.now()])).rows.map(row=>row.id as string)
  for(const id of ids){signal.throwIfAborted();try{await this.advance(id,signal)}catch(error){signal.throwIfAborted();report(error);await this.pool.query('update teloa_employee_api_work set next_check_at=$2 where id=$1',[id,new Date(this.now().getTime()+30_000)])}}
 }
 private async deliverySettled(db:PoolClient,owner:string,run:TaskRun):Promise<boolean>{
  const present=async(table:string)=>(await db.query('select to_regclass($1) is not null as present',[table])).rows[0]?.present===true
  if(await present('teloa_task_run_subagents')&&(await db.query("select 1 from teloa_task_run_subagents where owner_id=$1 and run_id=$2 and state in ('reserved','started') limit 1",[owner,run.id])).rowCount)return false
  if(await present('teloa_task_run_runtime_links')&&(await db.query("select 1 from teloa_task_run_runtime_links where owner_id=$1 and run_id=$2 and kind='external' and payload->>'status' in ('reserved','running','stopping','unknown') limit 1",[owner,run.id])).rowCount)return false
  if(await present('teloa_task_run_flows')&&(await db.query("select 1 from teloa_task_run_flows where owner_id=$1 and run_id=$2 and state not in ('completed','compensated') limit 1",[owner,run.id])).rowCount)return false
  if(await present('teloa_security_actions')&&(await db.query("select 1 from teloa_security_actions where owner_id=$1 and task_id=$2 and state not in ('succeeded','rejected','withdrawn','failed') limit 1",[owner,run.taskId])).rowCount)return false
  return true
 }
 private async deliver(db:PoolClient,work:Record<string,any>,round:Record<string,any>,run:TaskRun,result:{text:string;review:'accepted'|'unreviewed'},resultVersion:number):Promise<DeliveryResult>{
  const owner=work.owner_id,taskId=round.task_id
  if(run.taskId!==taskId||run.roleId!==work.employee_id||run.roleVersion!==work.employee_version||run.state!=='ended'||run.evidence?.state!=='ended'||run.evidence.reason!=='completed'||run.stopRequestedAt!==null)throw new Error('employee-api delivery requires the fixed successful run')
  const existing=(await db.query('select * from teloa_employee_api_round_deliveries where work_id=$1 and round=$2',[work.id,round.round])).rows[0]
  if(existing){
   if(existing.result_version!==resultVersion)throw new Error('employee-api delivery result version changed')
   const saved=await new ArtifactService(this.pool,{id:randomUUID,now:()=>this.now().toISOString()},async(_owner,expected)=>({source:expected,sessionIds:[]})).readVersion(db,owner,existing.artifact_id,existing.artifact_version)
   if(saved.content.sections.map(section=>section.text).join('')!==result.text)throw new Error('employee-api delivered artifact differs from the fixed result')
   return {ok:true,artifactId:existing.artifact_id,artifactVersion:existing.artifact_version,taskVersion:existing.task_version}
  }
  if(round.run_id!==run.id)throw new Error('employee-api delivery run differs from the saved round')
  // 子工作、外部执行、流程、安全动作与待处理审批必须已收尾；未收尾时回滚后按同一轮次重试。
  const settled=await this.deliverySettled(db,owner,run)
  if(!settled)throw new WorkError('teloa/conflict','本轮仍有子工作、流程、审批或安全动作未收尾，暂不能自动交付。')
  const taskRow=(await db.query('select * from teloa_tasks where owner_id=$1 and id=$2 for update',[owner,taskId])).rows[0]
  if(!taskRow)return {ok:false,error:'delivery_task_missing'}
  const task=readStoredTask(taskRow)
  if(task.id!==taskId||task.scope!==work.scope||task.assigneeRoleId!==work.employee_id||task.assigneeRoleVersion!==work.employee_version)return {ok:false,error:'delivery_task_mismatch'}
  if(task.state!=='waiting')return {ok:false,error:'delivery_task_closed'}
  const lineage=await new WorkLineageService(this.pool,{id:randomUUID,now:()=>this.now().toISOString()}).readInTransaction(db,owner,{taskId})
  if(!lineage)return {ok:false,error:'delivery_lineage_missing'}
  const source=await taskArtifactSource(db,owner,taskId,true)
  const content=artifactContent({title:task.title,sections:artifactSections(result.text),snapshotIds:[],note:`API 报告已自动交付 · 第 ${round.round} 轮 · 结果 v${resultVersion} · 复核 ${result.review} · 正文摘要 sha256 ${hash(result.text)}`})
  if(content.sections.map(section=>section.text).join('')!==result.text)throw new Error('employee-api artifact content does not preserve the fixed result')
  const artifacts=new ArtifactService(this.pool,{id:randomUUID,now:()=>this.now().toISOString()},async(_owner,expected)=>({source:expected,sessionIds:[]}))
  const artifact=await artifacts.createInTransaction(db,owner,{requestId:workRequestChildId(round.request_id,'employee-api-artifact'),source,content})
  if(artifact.content.sections.map(section=>section.text).join('')!==result.text)throw new Error('employee-api artifact receipt differs from the fixed result')
  const transitions=new TaskTransitions(this.pool,{id:randomUUID,now:()=>this.now().toISOString()})
  const completed=await transitions.changeInTransaction(db,owner,{taskId,requestId:workRequestChildId(round.request_id,'employee-api-completion'),expectedVersion:task.version,action:'complete',artifact:{id:artifact.artifactId,version:artifact.number},note:`API 报告已自动交付 · 第 ${round.round} 轮 · 结果 v${resultVersion} · 成果 v${artifact.number}`})
  const progress=new WorkProgressService(this.pool,{id:randomUUID,now:()=>this.now().toISOString()})
  const current=await progress.readInTransaction(db,owner,lineage.rootTaskId,true)
  await progress.changeInTransaction(db,owner,{requestId:workRequestChildId(round.request_id,'employee-api-progress'),rootTaskId:lineage.rootTaskId,expectedVersion:current?.version??0,progress:{stage:'报告已自动交付',completedStepIds:current?.completedStepIds??[],nextStep:null,wait:null,artifactIds:[...new Set([...(current?.artifactIds??[]),artifact.artifactId])],pendingActionIds:current?.pendingActionIds??[]}})
  await db.query('insert into teloa_employee_api_round_deliveries(work_id,round,request_id,task_id,artifact_id,artifact_version,task_version,result_version,note,delivered_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[work.id,round.round,workRequestChildId(round.request_id,'employee-api-delivery'),taskId,artifact.artifactId,artifact.number,completed.version,resultVersion,`API 报告已自动交付 · 第 ${round.round} 轮`,this.now()])
  return {ok:true,artifactId:artifact.artifactId,artifactVersion:artifact.number,taskVersion:completed.version}
 }
 /** 旧版本已将工作置为 succeeded 但没有正式交付；只消费原结果补齐，不重新调用模型。 */
 private async repairDelivery(db:PoolClient,row:Record<string,any>,round:Record<string,any>,signal:AbortSignal){
  const fail=async(code:string)=>{
   const config=roundConfig(round),time=this.now(),updated=(await db.query("update teloa_employee_api_work set state='failed',error=$2,delivery_required=false,version=version+1,updated_at=$3,next_check_at=$3::timestamptz+interval '1 hour' where id=$1 returning *",[row.id,code,time])).rows[0]
   await this.event(db,updated,config)
  }
  if(row.result_version===null||row.result_version===undefined||!round.run_id){await fail('result_unavailable');return}
  const saved=(await db.query('select * from teloa_employee_api_results where work_id=$1 and version=$2',[row.id,row.result_version])).rows[0]
  if(!saved||hash(saved.text)!==saved.sha256||!['accepted','unreviewed'].includes(saved.review)){await fail('result_unavailable');return}
  const run=await this.runtime.read(row.owner_id,round.run_id,signal)
  let delivery:DeliveryResult
  try{delivery=await this.deliver(db,row,round,run,{text:saved.text,review:saved.review},saved.version)}
  catch(error){if(error instanceof WorkError)throw error;await fail('delivery_failed');return}
  if(!delivery.ok){await fail(delivery.error);return}
  const config=roundConfig(round),time=this.now(),updated=(await db.query("update teloa_employee_api_work set delivery_required=false,version=version+1,updated_at=$2,next_check_at=$2::timestamptz+interval '1 hour' where id=$1 returning *",[row.id,time])).rows[0]
  await this.event(db,updated,config)
 }
 private async advance(id:string,signal:AbortSignal){
  const db=await this.pool.connect()
  try{
   await db.query('begin');const row=(await db.query('select * from teloa_employee_api_work where id=$1 for update skip locked',[id])).rows[0]
   if(!row||terminal.has(row.state)&&!(row.state==='succeeded'&&row.delivery_required)){await db.query('commit');return}
   const integrationRow=(await db.query('select * from teloa_employee_integrations where id=$1 for share',[row.integration_id])).rows[0],identity=readEmployeeIntegration(integrationRow)
   const round=(await db.query('select * from teloa_employee_api_rounds where work_id=$1 and round=$2',[id,row.round])).rows[0]
   if(!round?.task_id)throw new EmployeeApiError('work_unavailable','The saved work round is unavailable.',503)
   const config=roundConfig(round)
   if(row.state==='succeeded'&&row.delivery_required){await this.repairDelivery(db,row,round,signal);await db.query('commit');return}
   // prepare/start的原生事务可能已提交而本轮状态事务曾回滚；先恢复同一请求，不能遗弃真实在途执行。
   if(!round.run_id){const recovered=(await db.query('select id from teloa_task_runs where owner_id=$1 and task_id=$2 and request_id=$3',[row.owner_id,round.task_id,round.request_id])).rows[0];if(recovered){round.run_id=recovered.id;await db.query('update teloa_employee_api_rounds set run_id=$3 where work_id=$1 and round=$2',[id,row.round,recovered.id])}}
   let run:TaskRun|undefined,state=row.state,error:string|null=null,result:{text:string;review:'accepted'|'unreviewed'}|undefined,delivered=false
   const revoked=identity.revokedAt!==null||Date.parse(identity.expiresAt)<=this.now().getTime()
   if(row.state==='queued'&&revoked&&!round.run_id)state='cancelled'
   else if(row.state==='cancel_requested'&&!round.run_id)state='cancelled'
   else try{
    if(!round.run_id){
     await this.availableRole(db,identity)
     run=await this.runtime.prepare(identity.ownerId,{requestId:round.request_id,taskId:round.task_id,expectedTaskVersion:round.task_version,...(round.permission_mode?{permissionMode:round.permission_mode as EmployeePermissionMode}:{}),...(config.model?{model:config.model}:{})},signal)
     await db.query('update teloa_employee_api_rounds set run_id=$3 where work_id=$1 and round=$2',[id,row.round,run.id])
     const resolved=run.modelPolicy?.primary
     if(resolved&&!sameModel(config.model,{provider:resolved.provider,model:resolved.model,...(resolved.reasoningEffort===undefined?{}:{reasoningEffort:resolved.reasoningEffort})})){
      config.model={provider:resolved.provider,model:resolved.model,...(resolved.reasoningEffort===undefined?{}:{reasoningEffort:resolved.reasoningEffort})}
      await db.query('update teloa_employee_api_rounds set model_provider=$3,model_id=$4,model_reasoning_effort=$5 where work_id=$1 and round=$2',[id,row.round,resolved.provider,resolved.model,resolved.reasoningEffort??null])
     }
    }else run=await this.runtime.read(identity.ownerId,round.run_id,signal)
    if(row.state==='cancel_requested'||revoked&&run.state==='prepared')run=await (run.state==='prepared'?this.runtime.withdraw(identity.ownerId,run.id,signal):this.runtime.stop(identity.ownerId,run.id,signal))
    else if(run.state==='prepared')run=await this.runtime.start(identity.ownerId,run.id,signal)
    if(run.state==='ended'&&run.evidence?.state==='ended'){
     if(run.stopRequestedAt!==null||run.evidence.reason==='cancelled')state='cancelled'
     else if(run.evidence.reason==='completed'){
      result=await this.runtime.result(run)
      if(result?.text.trim()){
       if(result.text.length>artifactTextLimit){state='failed';error='artifact_too_large'}
       else{
        const resultVersion=(row.result_version??0)+1
        try{
         const delivery=await this.deliver(db,row,round,run,result,resultVersion)
         if(delivery.ok){state='succeeded';delivered=true}else{state='failed';error=delivery.error}
        }catch(cause){
         if(cause instanceof WorkError)throw cause
         state='failed';error='delivery_failed'
        }
       }
      }else{state='failed';error='empty_result'}
     }else{state='failed';error='execution_failed'}
    }else if(run.state==='configuration_failed'){state='failed';error=run.configurationError?.code==='teloa/permission-mode-unavailable'?'permission_mode_unavailable':run.configurationError?.code==='teloa/model-unavailable'?'model_unavailable':'configuration_failed'}
    else if(run.state==='withdrawn')state='cancelled'
    else{const taskState=(await db.query('select state from teloa_tasks where owner_id=$1 and id=$2',[row.owner_id,round.task_id])).rows[0]?.state;state=row.state==='cancel_requested'?'cancel_requested':taskState==='paused'||taskState==='blocked'||await this.runtime.waiting?.(run)?'waiting':'running'}
   }catch(cause){
    signal.throwIfAborted()
    if(cause instanceof EmployeeApiError&&['employee_changed','employee_unavailable'].includes(cause.code)){state='failed';error=cause.code}
    else if(cause instanceof WorkError&&cause.code==='teloa/permission-mode-unavailable'){state='failed';error='permission_mode_unavailable'}
    else if(cause instanceof WorkError&&cause.code==='teloa/model-unavailable'){state='failed';error='model_unavailable'}
    else throw cause // 短暂存储/宿主故障保留队列与同一原生幂等请求，下一次只恢复，不另造运行。
   }
   if(state==='cancelled'){
    const task=(await db.query('select version,state from teloa_tasks where owner_id=$1 and id=$2 for update',[row.owner_id,round.task_id])).rows[0]
    if(task&&task.state!=='cancelled'&&task.state!=='completed')await new TaskTransitions(this.pool,{id:randomUUID,now:()=>this.now().toISOString()}).changeInTransaction(db,row.owner_id,{requestId:round.request_id,taskId:round.task_id,expectedVersion:task.version,action:'cancel'})
   }
   const persistResult=state==='succeeded'||state==='failed'&&(error==='artifact_too_large'||(error??'').startsWith('delivery_'))
   if(state!==row.state||error!==row.error||delivered){
    let resultVersion=row.result_version
    if(result&&persistResult){
     resultVersion=(row.result_version??0)+1
     await db.query('insert into teloa_employee_api_results(work_id,version,round,text,sha256,review,created_at) values($1,$2,$3,$4,$5,$6,$7)',[id,resultVersion,row.round,result.text,hash(result.text),result.review,this.now()])
    }
    const saved=(await db.query("update teloa_employee_api_work set state=$2,error=$3,result_version=$4,delivery_required=false,version=version+1,updated_at=$5,next_check_at=$5::timestamptz+interval '2 seconds' where id=$1 returning *",[id,state,error,resultVersion,this.now()])).rows[0]
    await this.event(db,saved,config)
   }else await db.query('update teloa_employee_api_work set next_check_at=$2 where id=$1',[id,new Date(this.now().getTime()+2000)])
   await db.query('commit')
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
}

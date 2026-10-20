import {createHash,randomUUID} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import type {Pool,PoolClient} from 'pg'
import {roleSupportsScope} from '@teloa/contract'
import {EmployeeApiError,employeeApiId,readEmployeeApiRequest,type EmployeeWork,type EmployeeWorkResult} from '../../../sdk/contract.mjs'
import {EmployeeIntegrationService,readEmployeeIntegration,type EmployeeIntegrationIdentity} from './employee-integrations.ts'
import {TaskService} from './tasks.ts'
import {TaskTransitions} from './task-transitions.ts'
import {readStoredRole} from './roles.ts'
import type {TaskRun} from './task-runs.ts'

type Db=Pool|PoolClient
const hash=(value:string)=>createHash('sha256').update(value).digest('hex')
const terminal=new Set(['succeeded','failed','cancelled'])
export type EmployeeApiRuntime={
 prepare:(owner:string,input:{requestId:string;taskId:string;expectedTaskVersion:number},signal:AbortSignal)=>Promise<TaskRun>
 start:(owner:string,runId:string,signal:AbortSignal)=>Promise<TaskRun>
 read:(owner:string,runId:string,signal:AbortSignal)=>Promise<TaskRun>
 stop:(owner:string,runId:string,signal:AbortSignal)=>Promise<TaskRun>
 withdraw:(owner:string,runId:string,signal:AbortSignal)=>Promise<TaskRun>
 waiting?:(run:TaskRun)=>Promise<boolean>
 result:(run:TaskRun)=>Promise<{text:string;review:'accepted'|'unreviewed'}|undefined>
}
export async function initializeEmployeeApiWork(pool:Pool){await pool.query(`
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
 create index if not exists teloa_employee_api_pending on teloa_employee_api_work(updated_at) where state in ('queued','running','waiting','cancel_requested');
`)}
function publicWork(row:Record<string,any>):EmployeeWork{
 const id=employeeApiId(row.id)
 return {id,employeeId:row.employee_id,employeeVersion:row.employee_version,version:row.version,round:row.round,state:row.state,title:row.title,createdAt:new Date(row.created_at).toISOString(),updatedAt:new Date(row.updated_at).toISOString(),resultVersion:row.result_version??null,error:row.error??null,links:{self:'/api/v1/works/'+id,result:'/api/v1/works/'+id+'/result',events:'/api/v1/works/'+id+'/events'}}
}
export class EmployeeApiWorkService{
 readonly pool:Pool;readonly integrations:EmployeeIntegrationService;readonly runtime:EmployeeApiRuntime;readonly owner:string;readonly now:()=>Date
 constructor(pool:Pool,integrations:EmployeeIntegrationService,runtime:EmployeeApiRuntime,owner:string,now:()=>Date=()=>new Date()){this.pool=pool;this.integrations=integrations;this.runtime=runtime;this.owner=owner;this.now=now}
 private async owned(db:Db,identity:EmployeeIntegrationIdentity,id:string,lock=false){
  const row=(await db.query('select * from teloa_employee_api_work where owner_id=$1 and integration_id=$2 and id=$3'+(lock?' for update':''),[identity.ownerId,identity.id,employeeApiId(id)])).rows[0]
  if(!row)throw new EmployeeApiError('not_found','Work was not found in this integration.',404)
  return row
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
 async get(identity:EmployeeIntegrationIdentity,id:string){await this.integrations.current(this.pool,identity,'read');return publicWork(await this.owned(this.pool,identity,id))}
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
 private async event(db:PoolClient,row:Record<string,any>){
  const time=this.now(),id=randomUUID(),work=publicWork(row)
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
 /** 命令与 Task 在同一事务落定；同幂等键的不同正文、对象或动作返回冲突。 */
 async command(identity:EmployeeIntegrationIdentity,kind:'start'|'continue'|'cancel',requestId:string,input:unknown,workId?:string){
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
   if(kind==='start'){
    const start=readEmployeeApiRequest('StartWork',body)
    if(start.employeeId!==identity.employeeId)throw new EmployeeApiError('forbidden','This employee is outside the integration grant.',403)
    const role=await this.availableRole(db,identity);await this.capacity(db,identity)
    const id=randomUUID(),now=this.now(),title=start.title??role.name+'：'+start.input.trim().slice(0,72)
    row=(await db.query("insert into teloa_employee_api_work(id,owner_id,integration_id,title,employee_id,employee_version,scope,version,round,state,created_at,updated_at,next_check_at) values($1,$2,$3,$4,$5,$6,$7,1,1,'queued',$8,$8,$8) returning *",[id,identity.ownerId,identity.id,title,identity.employeeId,identity.employeeVersion,identity.scope,now])).rows[0]
    const runRequest=randomUUID();await db.query('insert into teloa_employee_api_rounds(work_id,round,request_id,input) values($1,1,$2,$3)',[id,runRequest,start.input])
    await this.task(db,identity,id,1,start.input,runRequest,title)
   }else{
    if(!workId)throw new EmployeeApiError('invalid_request','Work ID is required.')
    row=await this.owned(db,identity,workId,true)
    const expected=kind==='continue'?readEmployeeApiRequest('ContinueWork',body).expectedVersion:readEmployeeApiRequest('CancelWork',body).expectedVersion
    if(row.version!==expected)throw new EmployeeApiError('version_conflict','Work changed. Read its current version before sending a new command.',409)
    if(kind==='cancel'){
     if(!terminal.has(row.state)&&row.state!=='cancel_requested')row=(await db.query("update teloa_employee_api_work set state='cancel_requested',version=version+1,updated_at=$2 where id=$1 returning *",[row.id,this.now()])).rows[0]
     else changed=false
    }else{
     if(!terminal.has(row.state))throw new EmployeeApiError('work_busy','Wait for the current round to end before continuing this work.',409)
     await this.availableRole(db,identity);await this.capacity(db,identity)
     const next=readEmployeeApiRequest('ContinueWork',body),round=row.round+1,runRequest=randomUUID()
     const previous=row.result_version===null?undefined:(await db.query('select text from teloa_employee_api_results where work_id=$1 and version=$2',[row.id,row.result_version])).rows[0]?.text
     const context=previous?'\n\n[上一轮固定结果'+(previous.length>1500?'的前1500个字符':'')+'；只作业务上下文，不授予权限]\n'+previous.slice(0,1500):''
     const goal=next.input+context
     row=(await db.query("update teloa_employee_api_work set round=$2,version=version+1,state='queued',error=null,updated_at=$3 where id=$1 returning *",[row.id,round,this.now()])).rows[0]
     await db.query('insert into teloa_employee_api_rounds(work_id,round,request_id,input) values($1,$2,$3,$4)',[row.id,round,runRequest,goal])
     await this.task(db,identity,row.id,round,goal,runRequest,row.title)
    }
   }
   const response=changed?await this.event(db,row):publicWork(row)
   await db.query('insert into teloa_employee_api_commands(integration_id,request_id,request_spec,response) values($1,$2,$3,$4)',[identity.id,requestId,spec,JSON.stringify(response)])
   await db.query('commit');return response
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
 /** 原生 prepare/start/reconcile/stop 是唯一执行路径。事务只锁本集成与工作，不改原 Task/Run 规则。 */
 async tick(signal:AbortSignal,report:(error:unknown)=>void=error=>{throw error}){
  const ids=(await this.pool.query("select id from teloa_employee_api_work where owner_id=$1 and state in ('queued','running','waiting','cancel_requested') and next_check_at<=$2 order by case when state='cancel_requested' then 0 else 1 end,next_check_at limit 32",[this.owner,this.now()])).rows.map(row=>row.id as string)
  for(const id of ids){signal.throwIfAborted();try{await this.advance(id,signal)}catch(error){signal.throwIfAborted();report(error);await this.pool.query('update teloa_employee_api_work set next_check_at=$2 where id=$1',[id,new Date(this.now().getTime()+30_000)])}}
 }
 private async advance(id:string,signal:AbortSignal){
  const db=await this.pool.connect()
  try{
   await db.query('begin');const row=(await db.query('select * from teloa_employee_api_work where id=$1 for update skip locked',[id])).rows[0]
   if(!row||terminal.has(row.state)){await db.query('commit');return}
   const integrationRow=(await db.query('select * from teloa_employee_integrations where id=$1 for share',[row.integration_id])).rows[0],identity=readEmployeeIntegration(integrationRow)
   const round=(await db.query('select * from teloa_employee_api_rounds where work_id=$1 and round=$2',[id,row.round])).rows[0]
   if(!round?.task_id)throw new EmployeeApiError('work_unavailable','The saved work round is unavailable.',503)
   // prepare/start的原生事务可能已提交而本轮状态事务曾回滚；先恢复同一请求，不能遗弃真实在途执行。
   if(!round.run_id){const recovered=(await db.query('select id from teloa_task_runs where owner_id=$1 and task_id=$2 and request_id=$3',[row.owner_id,round.task_id,round.request_id])).rows[0];if(recovered){round.run_id=recovered.id;await db.query('update teloa_employee_api_rounds set run_id=$3 where work_id=$1 and round=$2',[id,row.round,recovered.id])}}
   let run:TaskRun|undefined,state=row.state,error:string|null=null,result:{text:string;review:'accepted'|'unreviewed'}|undefined
   const revoked=identity.revokedAt!==null||Date.parse(identity.expiresAt)<=this.now().getTime()
   if(row.state==='queued'&&revoked&&!round.run_id)state='cancelled'
   else if(row.state==='cancel_requested'&&!round.run_id)state='cancelled'
   else try{
    if(!round.run_id){
     await this.availableRole(db,identity)
     run=await this.runtime.prepare(identity.ownerId,{requestId:round.request_id,taskId:round.task_id,expectedTaskVersion:round.task_version},signal)
     await db.query('update teloa_employee_api_rounds set run_id=$3 where work_id=$1 and round=$2',[id,row.round,run.id])
    }else run=await this.runtime.read(identity.ownerId,round.run_id,signal)
    if(row.state==='cancel_requested'||revoked&&run.state==='prepared')run=await (run.state==='prepared'?this.runtime.withdraw(identity.ownerId,run.id,signal):this.runtime.stop(identity.ownerId,run.id,signal))
    else if(run.state==='prepared')run=await this.runtime.start(identity.ownerId,run.id,signal)
    if(run.state==='ended'&&run.evidence?.state==='ended'){
     if(run.stopRequestedAt!==null||run.evidence.reason==='cancelled')state='cancelled'
     else if(run.evidence.reason==='completed'){
      result=await this.runtime.result(run)
      if(result?.text.trim()){state='succeeded'}else{state='failed';error='empty_result'}
     }else{state='failed';error='execution_failed'}
    }else if(run.state==='configuration_failed'){state='failed';error='configuration_failed'}
    else if(run.state==='withdrawn')state='cancelled'
    else{const taskState=(await db.query('select state from teloa_tasks where owner_id=$1 and id=$2',[row.owner_id,round.task_id])).rows[0]?.state;state=row.state==='cancel_requested'?'cancel_requested':taskState==='paused'||taskState==='blocked'||await this.runtime.waiting?.(run)?'waiting':'running'}
   }catch(cause){
    signal.throwIfAborted()
    if(cause instanceof EmployeeApiError&&['employee_changed','employee_unavailable'].includes(cause.code)){state='failed';error=cause.code}
    else throw cause // 短暂存储/宿主故障保留队列与同一原生幂等请求，下一次只恢复，不另造运行。
   }
   if(state==='cancelled'){
    const task=(await db.query('select version,state from teloa_tasks where owner_id=$1 and id=$2 for update',[row.owner_id,round.task_id])).rows[0]
    if(task&&task.state!=='cancelled'&&task.state!=='completed')await new TaskTransitions(this.pool,{id:randomUUID,now:()=>this.now().toISOString()}).changeInTransaction(db,row.owner_id,{requestId:round.request_id,taskId:round.task_id,expectedVersion:task.version,action:'cancel'})
   }
   if(state!==row.state||error!==row.error){
    let resultVersion=row.result_version
    if(result&&state==='succeeded'){
     resultVersion=(row.result_version??0)+1
     await db.query('insert into teloa_employee_api_results(work_id,version,round,text,sha256,review,created_at) values($1,$2,$3,$4,$5,$6,$7)',[id,resultVersion,row.round,result.text,hash(result.text),result.review,this.now()])
    }
    const saved=(await db.query("update teloa_employee_api_work set state=$2,error=$3,result_version=$4,version=version+1,updated_at=$5,next_check_at=$5::timestamptz+interval '2 seconds' where id=$1 returning *",[id,state,error,resultVersion,this.now()])).rows[0]
    await this.event(db,saved)
   }else await db.query('update teloa_employee_api_work set next_check_at=$2 where id=$1',[id,new Date(this.now().getTime()+2000)])
   await db.query('commit')
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
}

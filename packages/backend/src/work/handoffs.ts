import type {Pool} from 'pg'
import {WorkError,isTaskHandoffChange,readTaskHandoffChangeInput,roleSupportsScope,taskInput,type TaskHandoffChange,type TaskHandoffChangeResult,type TaskHandoffParty,type WorkTask} from '@teloa/contract'
import {readStoredRole} from './roles.ts'
import {readStoredTask} from './tasks.ts'
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v)
export type TaskHandoff={id:string;taskId:string;fromRoleId:string;ownerId:string;roleVersion:number;taskVersion:number;reason:string;createdAt:string;status:'pending'|'resolved'}
export type HandoffResult={task:WorkTask;handoffId:string;appliedVersion:number}
export async function initializeHandoffs(pool:Pool){await pool.query(`create table if not exists teloa_handoff_resolutions (
 handoff_id uuid primary key references teloa_task_handoffs(id),request_spec jsonb not null check(jsonb_typeof(request_spec)='object'),
 applied_version integer not null check(applied_version>1),created_at timestamptz not null
);
create table if not exists teloa_task_handoff_changes (
 owner_id text not null,request_id uuid not null,task_id uuid not null,base_version integer not null check(base_version>0),
 request_spec jsonb not null check(jsonb_typeof(request_spec)='object'),from_party jsonb not null check(jsonb_typeof(from_party)='object'),
 to_party jsonb not null check(jsonb_typeof(to_party)='object'),applied_version integer not null check(applied_version=base_version+1),
 note text not null check(length(note)>0 and length(note)<=4000),created_at timestamptz not null,
 primary key(owner_id,request_id),unique(task_id,base_version),foreign key(task_id,owner_id) references teloa_tasks(id,owner_id)
)`)}
function ownerId(owner:string){if(typeof owner!=='string'||!owner.trim()||owner.length>128)throw new WorkError('teloa/forbidden','需要有效的本人身份。')}
function read(row:Record<string,unknown>):TaskHandoff{
 if(!uuid(row.id)||!uuid(row.task_id)||!uuid(row.from_role_id)||typeof row.owner_id!=='string'||!row.owner_id||!Number.isSafeInteger(row.role_version)||(row.role_version as number)<1||!Number.isSafeInteger(row.task_version)||(row.task_version as number)<1||typeof row.reason!=='string'||!row.reason.trim()||!(row.created_at instanceof Date)||!Number.isFinite(row.created_at.getTime())||(row.status!=='pending'&&row.status!=='resolved'))throw new WorkError('teloa/storage-corrupt','交接记录损坏，请核对原记录。')
 return {id:row.id,taskId:row.task_id,fromRoleId:row.from_role_id,ownerId:row.owner_id,roleVersion:row.role_version as number,taskVersion:row.task_version as number,reason:row.reason,createdAt:row.created_at.toISOString(),status:row.status}
}
function readChange(row:Record<string,unknown>):TaskHandoffChange{
 try{
  const createdAt=row.created_at instanceof Date?row.created_at.toISOString():'',change={requestId:row.request_id,taskId:row.task_id,baseVersion:row.base_version,appliedVersion:row.applied_version,from:row.from_party,to:row.to_party,note:row.note,createdAt}
  if(!isTaskHandoffChange(change))throw Error()
  const request=readTaskHandoffChangeInput(row.request_spec)
  if(request.requestId!==change.requestId||request.taskId!==change.taskId||request.expectedTaskVersion!==change.baseVersion||request.note!==change.note||JSON.stringify(request.target)!==JSON.stringify(change.to.kind==='self'?{kind:'self'}:{kind:'role',roleId:change.to.roleId,expectedRoleVersion:change.to.roleVersion}))throw Error()
  return change
 }catch{throw new WorkError('teloa/storage-corrupt','主动改派回执损坏，请核对原记录。')}
}
async function rejectOpenRuns(client:{query:Pool['query']},owner:string,taskId:string){if((await client.query("select id from teloa_task_runs where owner_id=$1 and task_id=$2 and state not in ('ended','withdrawn','configuration_failed') limit 1",[owner,taskId])).rows[0])throw new WorkError('teloa/conflict','任务仍有未结束的执行，请先完成或停止该执行。')}
export class HandoffService{
 readonly pool:Pool
 readonly identity:{id:()=>string;now:()=>string}
 constructor(pool:Pool,identity:{id:()=>string;now:()=>string}){this.pool=pool;this.identity=identity}
 async list(owner:string,input:unknown):Promise<TaskHandoff[]>{
  ownerId(owner);taskInput(input,[])
  const rows=await this.pool.query('select h.*,r.applied_version from teloa_task_handoffs h left join teloa_handoff_resolutions r on r.handoff_id=h.id where h.owner_id=$1 order by h.created_at,h.id',[owner])
  return rows.rows.map(row=>{const handoff=read(row);if(handoff.status==='resolved'?(!Number.isSafeInteger(row.applied_version)||row.applied_version<=handoff.taskVersion):row.applied_version!==null)throw new WorkError('teloa/storage-corrupt','交接状态与接任回执不一致。');return handoff})
 }
 async change(owner:string,input:unknown):Promise<TaskHandoffChangeResult>{
  ownerId(owner);const request=readTaskHandoffChangeInput(input),spec=JSON.stringify(request),client=await this.pool.connect()
  try{
   await client.query('begin')
   await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['task-handoff-change',owner,request.requestId])])
   const prior=(await client.query('select *,request_spec=$3::jsonb as same_request from teloa_task_handoff_changes where owner_id=$1 and request_id=$2',[owner,request.requestId,spec])).rows[0]
   if(prior){
    if(!prior.same_request)throw new WorkError('teloa/conflict','同一请求已记录其他改派安排。')
    const change=readChange(prior),stored=(await client.query('select * from teloa_tasks where id=$1 and owner_id=$2',[change.taskId,owner])).rows[0]
    if(!stored)throw new WorkError('teloa/storage-corrupt','改派回执引用的任务不存在。')
    const task=readStoredTask(stored);if(task.version<change.appliedVersion)throw new WorkError('teloa/storage-corrupt','任务版本早于主动改派回执。')
    await client.query('commit');return {task,change}
   }
   const hint=(await client.query('select assignee_role_id from teloa_tasks where id=$1 and owner_id=$2',[request.taskId,owner])).rows[0]
   if(!hint)throw new WorkError('teloa/forbidden','任务不存在或不属于当前本人。')
   const roleIds=[...new Set([hint.assignee_role_id,request.target.kind==='role'?request.target.roleId:null].filter(uuid) as string[])].sort()
   const roleRows=roleIds.length?(await client.query('select * from teloa_roles where owner_id=$1 and id=any($2::uuid[]) order by id for update',[owner,roleIds])).rows:[]
   if(roleRows.length!==roleIds.length)throw new WorkError('teloa/forbidden','改派员工不存在或不属于当前本人。')
   const roles=new Map(roleRows.map(row=>{const role=readStoredRole(row);return [role.id,role]}))
   const stored=(await client.query('select * from teloa_tasks where id=$1 and owner_id=$2 for update',[request.taskId,owner])).rows[0]
   if(!stored)throw new WorkError('teloa/forbidden','任务不存在或不属于当前本人。')
   const task=readStoredTask(stored)
   if(task.version!==request.expectedTaskVersion)throw new WorkError('teloa/version-conflict','任务已变化，请读取新版本后复核负责人。')
   if(!['ready','paused','blocked','waiting'].includes(task.state))throw new WorkError('teloa/conflict','执行中或已结束的任务不能调整负责人。')
   await rejectOpenRuns(client,owner,task.id)
   if((await client.query("select id from teloa_task_handoffs where owner_id=$1 and task_id=$2 and status='pending' limit 1",[owner,task.id])).rows[0])throw new WorkError('teloa/conflict','任务已有待交接记录，请先完成既有交接。')
   const from:TaskHandoffParty=task.assigneeRoleId===null?{kind:'self'}:{kind:'role',roleId:task.assigneeRoleId,roleVersion:task.assigneeRoleVersion!}
   let to:TaskHandoffParty
   if(request.target.kind==='self'){
    if(task.assigneeRoleId===null)throw new WorkError('teloa/conflict','本人已经是当前负责人。')
    to={kind:'self'}
   }else{
    if(task.assigneeRoleId===request.target.roleId)throw new WorkError('teloa/conflict','所选员工已经是当前负责人。')
    const role=roles.get(request.target.roleId)
    if(!role)throw new WorkError('teloa/forbidden','改派员工不存在或不属于当前本人。')
    if(role.version!==request.target.expectedRoleVersion)throw new WorkError('teloa/version-conflict','接任员工已变化，请读取新版本后复核。')
    if(role.state!=='active'||role.kind!=='employee'||!roleSupportsScope(role.scopes,task.scope))throw new WorkError('teloa/conflict','需要支持该业务的在岗正式员工接任。')
    to={kind:'role',roleId:role.id,roleVersion:role.version}
   }
   const now=this.identity.now(),updated=await client.query('update teloa_tasks set assignee_role_id=$3,assignee_role_version=$4,version=version+1,updated_at=$5 where id=$1 and owner_id=$2 returning *',[task.id,owner,to.kind==='role'?to.roleId:null,to.kind==='role'?to.roleVersion:null,now]),current=readStoredTask(updated.rows[0])
   const change:TaskHandoffChange={requestId:request.requestId,taskId:task.id,baseVersion:task.version,appliedVersion:current.version,from,to,note:request.note,createdAt:now}
   await client.query('insert into teloa_task_handoff_changes(owner_id,request_id,task_id,base_version,request_spec,from_party,to_party,applied_version,note,created_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[owner,request.requestId,task.id,task.version,spec,JSON.stringify(from),JSON.stringify(to),current.version,request.note,now])
   await client.query('commit');return {task:current,change}
  }catch(error){await client.query('rollback');throw error}finally{client.release()}
 }
 async resolve(owner:string,input:unknown):Promise<HandoffResult>{
  ownerId(owner);const selfTarget=typeof input==='object'&&input!==null&&Object.hasOwn(input,'target')
  const row=taskInput(input,selfTarget?['handoffId','expectedTaskVersion','target','note']:['handoffId','expectedTaskVersion','toRoleId','expectedRoleVersion','note'])
  const target=selfTarget?taskInput(row.target,['kind']):undefined
  if(!uuid(row.handoffId)||!Number.isSafeInteger(row.expectedTaskVersion)||(row.expectedTaskVersion as number)<1||typeof row.note!=='string'||!row.note.trim()||row.note.length>4000||(selfTarget?target?.kind!=='self':!uuid(row.toRoleId)||!Number.isSafeInteger(row.expectedRoleVersion)||(row.expectedRoleVersion as number)<1))throw new WorkError('teloa/invalid-input','接任目标、版本或说明不合法。')
  const normalized=selfTarget?{handoffId:row.handoffId,expectedTaskVersion:row.expectedTaskVersion,target:{kind:'self'},note:row.note.trim()}:{...row,note:row.note.trim()}
  const spec=JSON.stringify(normalized),client=await this.pool.connect()
  try{
   await client.query('begin')
   const hint=await client.query('select task_id,from_role_id from teloa_task_handoffs where id=$1 and owner_id=$2',[row.handoffId,owner]);if(!hint.rows[0])throw new WorkError('teloa/forbidden','交接不存在或不属于当前本人。')
   const {task_id,from_role_id}=hint.rows[0]
   if(!selfTarget&&row.toRoleId===from_role_id)throw new WorkError('teloa/conflict','需要选择另一位接任员工。')
   // 固定岗位ID顺序，再锁任务和交接；与退役的岗位→任务顺序兼容。
   const roleIds=selfTarget?[from_role_id]:[from_role_id,row.toRoleId]
   const roles=await client.query('select * from teloa_roles where owner_id=$1 and id=any($2::uuid[]) order by id for update',[owner,roleIds])
   if(roles.rowCount!==roleIds.length)throw new WorkError('teloa/forbidden','接任员工不属于当前本人。')
   const targetRole=selfTarget?undefined:readStoredRole(roles.rows.find(value=>value.id===row.toRoleId))
   const tasks=await client.query('select * from teloa_tasks where id=$1 and owner_id=$2 for update',[task_id,owner]);if(!tasks.rows[0])throw new WorkError('teloa/storage-corrupt','交接引用的任务不存在。')
   const task=readStoredTask(tasks.rows[0])
   const handoffs=await client.query('select * from teloa_task_handoffs where id=$1 and owner_id=$2 for update',[row.handoffId,owner]),handoff=read(handoffs.rows[0])
   if(handoff.taskId!==task.id||handoff.fromRoleId!==from_role_id)throw new WorkError('teloa/storage-corrupt','交接来源在核对期间发生变化。')
   const receipts=await client.query('select *,request_spec=$2::jsonb as same_request from teloa_handoff_resolutions where handoff_id=$1',[handoff.id,spec]),receipt=receipts.rows[0]
   if(handoff.status==='resolved'){
    if(!receipt||!Number.isSafeInteger(receipt.applied_version)||receipt.applied_version<=handoff.taskVersion||receipt.applied_version>task.version)throw new WorkError('teloa/storage-corrupt','接任回执损坏。')
    if(!receipt.same_request)throw new WorkError('teloa/conflict','交接已按其他安排完成，请核对当前负责人。')
    if(receipt.applied_version!==(row.expectedTaskVersion as number)+1)throw new WorkError('teloa/storage-corrupt','接任回执版本与原请求不一致。')
    await client.query('commit');return {task,handoffId:handoff.id,appliedVersion:receipt.applied_version}
   }
   if(receipt)throw new WorkError('teloa/storage-corrupt','待交接记录存在不一致的接任回执。')
   if(task.version!==row.expectedTaskVersion||targetRole&&targetRole.version!==row.expectedRoleVersion)throw new WorkError('teloa/version-conflict','任务或接任员工已变化，请读取新版本后复核。')
   if(task.assigneeRoleId!==handoff.fromRoleId||['running','completed','cancelled'].includes(task.state))throw new WorkError('teloa/conflict','任务负责人或执行状态不允许直接接任。')
   await rejectOpenRuns(client,owner,task.id)
   if(targetRole&&(targetRole.state!=='active'||targetRole.kind!=='employee'||!roleSupportsScope(targetRole.scopes,task.scope)))throw new WorkError('teloa/conflict','需要支持该业务的在岗员工接任。')
   const now=this.identity.now(),updated=await client.query('update teloa_tasks set assignee_role_id=$3,assignee_role_version=$4,version=version+1,updated_at=$5 where id=$1 and owner_id=$2 returning *',[task.id,owner,targetRole?.id??null,targetRole?.version??null,now]),current=readStoredTask(updated.rows[0])
   await client.query("update teloa_task_handoffs set status='resolved' where id=$1",[handoff.id])
   await client.query('insert into teloa_handoff_resolutions(handoff_id,request_spec,applied_version,created_at) values($1,$2,$3,$4)',[handoff.id,spec,current.version,now])
   await client.query('commit');return {task:current,handoffId:handoff.id,appliedVersion:current.version}
  }catch(error){await client.query('rollback');throw error}finally{client.release()}
 }
}

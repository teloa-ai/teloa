import {createHash,randomUUID} from 'node:crypto'
import type {Pool,PoolClient} from 'pg'
import {WorkError,taskInput,roleDefinition,roleSupportsScope,readBusinessReassignmentInstruction,readBusinessReassignmentSnapshot,readBusinessReassignmentReceipt,canonicalBusinessReassignmentSnapshot,type BusinessReassignmentInstruction,type BusinessReassignmentSnapshot,type BusinessReassignmentReceipt} from '@teloa/contract'
import {ConversationWorkService,initializeConversationWork,readStoredConversationWorkRequest,readStoredConversationWorkContext,reserveConversationWorkInTransaction,type ConversationWorkRequest,type ConversationWorkReserveInput} from './conversation-work.ts'
import {workRequestChildId,lockConversationTaskChild} from './conversation-work-task-protection.ts'
import type {BusinessConversationBindingService} from './business-conversation-bindings.ts'
import {readStoredRole} from './roles.ts'
import {lockBusinessConfiguration} from './business-configuration-lock.ts'
import {readBusinessConfigurationManagement} from './business-configuration-store.ts'
import {BusinessResponsibilityService} from './business-responsibility.ts'
import type {WorkAccessLease} from './work-access.ts'
import {BusinessTaskService} from './business-tasks.ts'
import {TaskService} from './tasks.ts'
import {initializeTaskRunAbortProofs} from './task-run-abort-proof.ts'
import {assertReassignmentRunsSettled,readReassignmentRunTargets,type ReassignmentRunTargets} from './business-reassignment-store.ts'
import {authorizeRoleTaskAssignment} from './role-task-authorization.ts'
export type {ReassignmentRunIdentity,ReassignmentRunTargets} from './business-reassignment-store.ts'

type Input={oldRequestId:string;instruction:BusinessReassignmentInstruction}
const conflict=()=>new WorkError('teloa/conflict','原交办或改派指令已有不同安排，请重新核对并确认。')
const forbidden=()=>new WorkError('teloa/forbidden','当前本人未获准在这两个日常业务会话之间改派。')
const changed=()=>new WorkError('teloa/version-conflict','改派审批期间业务、员工或固定依据已变化，请重新确认。')
const corrupt=()=>new WorkError('teloa/storage-corrupt','改派后继记录与固定快照不一致，请核对原请求。')
const byteSorted=(values:readonly string[])=>[...new Set(values)].sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b)))
function ownerValid(owner:string):void{
 if(typeof owner!=='string'||!owner.trim()||owner!==owner.trim()||owner.length>128||/[\x00-\x1f\x7f]/.test(owner))throw forbidden()
}
function inputValue(owner:string,value:unknown):Input{
 ownerValid(owner)
 const row=taskInput(value,['oldRequestId','instruction']),instruction=readBusinessReassignmentInstruction(row.instruction)
 if(typeof row.oldRequestId!=='string'||row.oldRequestId.toLowerCase()!==instruction.selection.oldRequestId||instruction.requestId===instruction.selection.oldRequestId)throw new WorkError('teloa/invalid-input','改派来源或新本人消息身份不正确。')
 return {oldRequestId:instruction.selection.oldRequestId,instruction}
}
/** 改派指令只负责新消息身份；材料/目标/引用全部来自服务端原交办快照。 */
export function reserveInputFromReassignment(value:BusinessReassignmentSnapshot):ConversationWorkReserveInput{
 const snapshot=readBusinessReassignmentSnapshot(value),{instruction,newTarget}=snapshot
 return {requestId:instruction.requestId,sessionId:instruction.sessionId,messageId:instruction.messageId,messageSeq:instruction.messageSeq,kind:'task',scope:snapshot.scope,title:snapshot.title,goal:snapshot.goal,roleId:newTarget.roleId,expectedRoleVersion:newTarget.roleVersion,...(snapshot.sourceText===undefined?{}:{sourceText:snapshot.sourceText}),...(snapshot.reference===undefined?{}:{reference:{...snapshot.reference}}),...(snapshot.responsibility===null?{}:{responsibility:{...snapshot.responsibility}})}
}
function fixedSnapshot(value:Omit<BusinessReassignmentSnapshot,'snapshotHash'>):BusinessReassignmentSnapshot{
 const snapshotHash=createHash('sha256').update(canonicalBusinessReassignmentSnapshot(value)).digest('hex')
 return readBusinessReassignmentSnapshot({...value,snapshotHash})
}
export async function initializeBusinessReassignments(pool:Pool):Promise<void>{
 await initializeConversationWork(pool);await initializeTaskRunAbortProofs(pool)
 await pool.query(`create table if not exists teloa_conversation_work_successors(
  owner_id text not null,old_request_id uuid not null,new_request_id uuid not null,
  snapshot jsonb not null check(jsonb_typeof(snapshot)='object'),snapshot_hash text not null check(snapshot_hash~'^[a-f0-9]{64}$'),
  created_at timestamptz not null,primary key(owner_id,old_request_id),unique(owner_id,new_request_id),
  check(old_request_id<>new_request_id),
  foreign key(owner_id,old_request_id) references teloa_conversation_work_requests(owner_id,request_id),
  foreign key(owner_id,new_request_id) references teloa_conversation_work_requests(owner_id,request_id)
 )`)
}
type Preparation={input:Input;old:ConversationWorkRequest;guard:(db:PoolClient)=>Promise<void>}
export class BusinessReassignmentService{
 readonly pool:Pool;readonly now:()=>string;readonly work:ConversationWorkService;readonly bindings:BusinessConversationBindingService
 constructor(pool:Pool,now:()=>string,work:ConversationWorkService,bindings:BusinessConversationBindingService){this.pool=pool;this.now=now;this.work=work;this.bindings=bindings}
 private async preflight(owner:string,value:unknown,revalidateInstruction:()=>Promise<void>):Promise<Preparation>{
  const input=inputValue(owner,value);await revalidateInstruction()
  const raw=(await this.pool.query('select * from teloa_conversation_work_requests where owner_id=$1 and request_id=$2',[owner,input.oldRequestId])).rows[0]
  if(!raw)throw forbidden()
  const old=readStoredConversationWorkRequest(raw)
  if(old.kind!=='task'||old.scope==='general'||old.targets.length!==1||old.allBusinesses)throw forbidden()
  for(const id of byteSorted([old.sessionId,input.instruction.sessionId])){
   let observed:Awaited<ReturnType<ConversationWorkService['inspect']>>
   try{observed=await this.work.inspect(owner,id)}catch(error){if(error instanceof WorkError)throw error;throw new WorkError('teloa/host-unavailable','暂时无法核对改派会话。')}
   if(observed.ownerId!==owner||observed.sessionId!==id||observed.status!=='ready')throw forbidden()
  }
  const guard=await this.bindings.prepareReassignmentGuard(owner,old.sessionId,input.instruction.sessionId)
  return {input,old,guard}
 }
 private async locks(db:PoolClient,owner:string,prepared:Preparation):Promise<void>{
  const {input,old}=prepared,children=[workRequestChildId(input.oldRequestId,'task',old.targets[0]!.roleId),workRequestChildId(input.instruction.requestId,'task',input.instruction.selection.newRoleId)]
  for(const id of byteSorted(children))await lockConversationTaskChild(db,owner,id)
  for(const id of byteSorted([input.oldRequestId,input.instruction.requestId]))await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['teloa/conversation-work',owner,'request:'+id])])
  for(const id of byteSorted([old.sessionId,input.instruction.sessionId]))await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['teloa/conversation-work',owner,'context:'+id])])
  await lockBusinessConfiguration(db,owner,old.scope,'shared')
  await prepared.guard(db)
  if(!this.work.scopes||!(await this.work.scopes(db,owner)).includes(old.scope))throw forbidden()
  const {managed}=await readBusinessConfigurationManagement(db,owner,old.scope)
  if(managed)await new BusinessResponsibilityService(this.pool).readInTransaction(db,{ownerId:owner,scopeIds:[old.scope]},{scope:old.scope})
  const roleIds=byteSorted([old.targets[0]!.roleId,input.instruction.selection.newRoleId])
  const hints=(await db.query('select id,definition from teloa_roles where owner_id=$1 and id=any($2::uuid[]) order by id',[owner,roleIds])).rows
  // 员工沿既有共享锁；Twin新目标提前持排他锁，随后统一资格闸不在共享锁上升级。
  // kind在创建后不可变，最终版本与完整定义仍由snapshot从锁内记录重新核对。
  for(const id of roleIds){const hint=hints.find(row=>row.id===id),lock=id===input.instruction.selection.newRoleId&&hint&&roleDefinition(hint.definition).kind==='twin'?'update':'share';await db.query('select id from teloa_roles where owner_id=$1 and id=$2 for '+lock,[owner,id])}
 }
 private async transaction<T>(owner:string,prepared:Preparation,operation:(db:PoolClient,old:ConversationWorkRequest)=>Promise<T>,beforeCommit?:()=>void):Promise<T>{
  const db=await this.pool.connect()
  try{
   await db.query('begin');await this.locks(db,owner,prepared)
   const rows=(await db.query('select * from teloa_conversation_work_requests where owner_id=$1 and request_id=any($2::uuid[]) order by request_id for update',[owner,byteSorted([prepared.input.oldRequestId,prepared.input.instruction.requestId])])).rows
   const row=rows.find(candidate=>candidate.request_id===prepared.input.oldRequestId)
   if(!row)throw forbidden()
   const old=readStoredConversationWorkRequest(row)
   if(old.sessionId!==prepared.old.sessionId||old.scope!==prepared.old.scope||old.kind!=='task'||old.targets.length!==1||JSON.stringify(old.targets)!==JSON.stringify(prepared.old.targets)||row.task_child_request_id!==workRequestChildId(old.requestId,'task',old.targets[0]!.roleId))throw corrupt()
   const result=await operation(db,old);beforeCommit?.();await db.query('commit');return result
  }catch(error){await db.query('rollback').catch(()=>{});if(error&&typeof error==='object'&&'code' in error&&error.code==='23505')throw conflict();throw error}finally{db.release()}
 }
 private async saved(db:PoolClient,owner:string,input:Input):Promise<{snapshot:BusinessReassignmentSnapshot;receipt:BusinessReassignmentReceipt}|null>{
  const rows=(await db.query('select * from teloa_conversation_work_successors where owner_id=$1 and (old_request_id=$2 or new_request_id=$3)',[owner,input.oldRequestId,input.instruction.requestId])).rows
  if(!rows.length){if((await db.query('select 1 from teloa_conversation_work_requests where owner_id=$1 and request_id=$2',[owner,input.instruction.requestId])).rowCount)throw conflict();return null}
  if(rows.length!==1||rows[0].old_request_id!==input.oldRequestId||rows[0].new_request_id!==input.instruction.requestId)throw conflict()
  const row=rows[0],snapshot=readBusinessReassignmentSnapshot(row.snapshot),{snapshotHash,...fixed}=snapshot
  if(row.snapshot_hash!==snapshotHash||fixedSnapshot(fixed).snapshotHash!==snapshotHash||snapshot.instruction.requestId!==row.new_request_id||snapshot.instruction.selection.oldRequestId!==row.old_request_id||!(row.created_at instanceof Date))throw corrupt()
  if(JSON.stringify(snapshot.instruction)!==JSON.stringify(input.instruction))throw conflict()
  const reserve=reserveInputFromReassignment(snapshot),newRow=(await db.query('select *,request_spec=$3::jsonb same from teloa_conversation_work_requests where owner_id=$1 and request_id=$2',[owner,row.new_request_id,JSON.stringify(reserve)])).rows[0]
  if(!newRow?.same)throw corrupt()
  const successor=readStoredConversationWorkRequest(newRow),target=successor.targets[0]
  if(!target||successor.targets.length!==1||target.roleId!==snapshot.newTarget.roleId||target.roleVersion!==snapshot.newTarget.roleVersion||target.name!==snapshot.newTarget.name||target.scope!==snapshot.scope)throw corrupt()
  const oldRow=(await db.query('select * from teloa_conversation_work_requests where owner_id=$1 and request_id=$2',[owner,input.oldRequestId])).rows[0]
  if(!oldRow)throw corrupt()
  const old=readStoredConversationWorkRequest(oldRow),originalTarget=old.targets[0]
  if(!originalTarget||old.targets.length!==1||old.sessionId!==snapshot.oldSessionId||old.scope!==snapshot.scope||old.title!==snapshot.title||old.goal!==snapshot.goal||old.sourceText!==snapshot.sourceText||JSON.stringify(old.reference)!==JSON.stringify(snapshot.reference)||JSON.stringify({roleId:originalTarget.roleId,roleVersion:originalTarget.roleVersion,name:originalTarget.name})!==JSON.stringify(snapshot.oldTarget))throw corrupt()
  return {snapshot,receipt:readBusinessReassignmentReceipt({oldRequestId:row.old_request_id,newRequestId:row.new_request_id,oldSessionId:snapshot.oldSessionId,newSessionId:snapshot.instruction.sessionId,scope:snapshot.scope,snapshotHash,createdAt:row.created_at.toISOString()})}
 }
 /** 仅供已授权 dispatch/publisher 恢复固定关联；不读取宿主或开放旧会话正文。 */
 async readReceiptForRequest(owner:string,newRequestId:string):Promise<BusinessReassignmentReceipt|null>{
  ownerValid(owner)
  if(typeof newRequestId!=='string'||! /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(newRequestId))throw new WorkError('teloa/invalid-input','改派后继请求身份不正确。')
  newRequestId=newRequestId.toLowerCase()
  const db=await this.pool.connect()
  try{
   await db.query('begin isolation level repeatable read read only')
   const row=(await db.query('select * from teloa_conversation_work_successors where owner_id=$1 and new_request_id=$2',[owner,newRequestId])).rows[0]
   if(!row){await db.query('commit');return null}
   const snapshot=readBusinessReassignmentSnapshot(row.snapshot),input=inputValue(owner,{oldRequestId:row.old_request_id,instruction:snapshot.instruction})
   if(input.instruction.requestId!==newRequestId)throw corrupt()
   const saved=await this.saved(db,owner,input)
   if(!saved)throw corrupt()
   await db.query('commit');return saved.receipt
  }catch(error){await db.query('rollback').catch(()=>{});throw error}finally{db.release()}
 }
 private async snapshot(db:PoolClient,owner:string,input:Input,old:ConversationWorkRequest):Promise<BusinessReassignmentSnapshot>{
  const oldRow=(await db.query('select * from teloa_conversation_work_contexts where owner_id=$1 and session_id=$2',[owner,old.sessionId])).rows[0],newRow=(await db.query('select * from teloa_conversation_work_contexts where owner_id=$1 and session_id=$2',[owner,input.instruction.sessionId])).rows[0]
  if(!oldRow||!newRow)throw forbidden()
  const oldContext=readStoredConversationWorkContext(oldRow),newContext=readStoredConversationWorkContext(newRow)
  if(oldContext.scopeId!==old.scope||newContext.scopeId!==old.scope||newContext.roleId!==null&&newContext.roleId!==input.instruction.selection.newRoleId)throw conflict()
  const {managed}=await readBusinessConfigurationManagement(db,owner,old.scope)
  const selected=managed?await new BusinessResponsibilityService(this.pool).readInTransaction(db,{ownerId:owner,scopeIds:[old.scope]},{scope:old.scope}):null
  const responsibility=selected?{version:selected.version,roleId:selected.roleId}:null
  const roles=(await db.query('select * from teloa_roles where owner_id=$1 and id=any($2::uuid[]) order by id for share',[owner,byteSorted([old.targets[0]!.roleId,input.instruction.selection.newRoleId])])).rows.map(readStoredRole)
  const oldRole=roles.find(role=>role.id===old.targets[0]!.roleId),newRole=roles.find(role=>role.id===input.instruction.selection.newRoleId)
  if(!newRole||!roleSupportsScope(newRole.scopes,old.scope))throw forbidden()
  if(newRole.version!==input.instruction.selection.expectedNewRoleVersion)throw changed()
  if(newRole.state!=='active')throw conflict()
  const execution=await authorizeRoleTaskAssignment(db,this.pool,owner,newRole,old.scope)
  if(old.reference)await new BusinessTaskService(this.pool,{now:this.now},new TaskService(this.pool,{id:randomUUID,now:this.now})).referenceInTransaction(db,{ownerId:owner,scopeIds:[old.scope]},old.reference)
  const target=old.targets[0]!
  execution.assertCurrent();return fixedSnapshot({instruction:input.instruction,oldSessionId:old.sessionId,scope:old.scope,oldContext:{version:oldContext.version,roleId:oldContext.roleId},newContext:{version:newContext.version,roleId:newContext.roleId},oldTarget:{roleId:target.roleId,roleVersion:target.roleVersion,name:target.name},oldRoleCurrent:oldRole?{version:oldRole.version,state:oldRole.state}:null,newTarget:{roleId:newRole.id,roleVersion:newRole.version,name:newRole.name},responsibility,title:old.title,goal:old.goal,...(old.sourceText===undefined?{}:{sourceText:old.sourceText}),...(old.reference===undefined?{}:{reference:old.reference})})
 }
 async prepare(owner:string,value:Input,revalidateInstruction:()=>Promise<void>):Promise<BusinessReassignmentSnapshot>{
  const prepared=await this.preflight(owner,value,revalidateInstruction)
  return this.transaction(owner,prepared,async(db,old)=>{const saved=await this.saved(db,owner,prepared.input);return saved?saved.snapshot:this.snapshot(db,owner,prepared.input,old)})
 }
 async readReassignmentRuns(owner:string,value:Input,revalidateInstruction:()=>Promise<void>):Promise<ReassignmentRunTargets>{
  const prepared=await this.preflight(owner,value,revalidateInstruction)
  return this.transaction(owner,prepared,async(db,old)=>{await this.saved(db,owner,prepared.input);await this.snapshot(db,owner,prepared.input,old);return readReassignmentRunTargets(db,owner,old)})
 }
 async commit(owner:string,value:Input,approvedValue:BusinessReassignmentSnapshot,revalidateInstruction:()=>Promise<void>):Promise<BusinessReassignmentReceipt>{
  const prepared=await this.preflight(owner,value,revalidateInstruction),approved=readBusinessReassignmentSnapshot(approvedValue),{snapshotHash,...fixed}=approved
  if(fixedSnapshot(fixed).snapshotHash!==snapshotHash||approved.instruction.selection.oldRequestId!==prepared.input.oldRequestId||JSON.stringify(approved.instruction)!==JSON.stringify(prepared.input.instruction))throw conflict()
  let admission:WorkAccessLease|undefined
  return this.transaction(owner,prepared,async(db,old)=>{
   const saved=await this.saved(db,owner,prepared.input)
   if(saved){if(saved.snapshot.snapshotHash!==snapshotHash)throw conflict();return saved.receipt}
   const current=await this.snapshot(db,owner,prepared.input,old)
   if(current.snapshotHash!==snapshotHash)throw changed()
   if(old.stoppedAt===null)throw conflict()
   await assertReassignmentRunsSettled(db,owner,old)
   await reserveConversationWorkInTransaction(db,owner,reserveInputFromReassignment(current),{pool:this.pool,onAdmission:lease=>{admission=lease},guard:async connection=>{await prepared.guard(connection);if(!this.work.scopes||!(await this.work.scopes(connection,owner)).includes(old.scope))throw forbidden()},now:this.now,...(this.work.scopes?{scopes:this.work.scopes}:{}),responsibility:new BusinessResponsibilityService(this.pool)})
   admission?.assertCurrent()
   const createdAt=this.now()
   await db.query('insert into teloa_conversation_work_successors(owner_id,old_request_id,new_request_id,snapshot,snapshot_hash,created_at) values($1,$2,$3,$4,$5,$6)',[owner,old.requestId,current.instruction.requestId,JSON.stringify(current),current.snapshotHash,createdAt])
   return readBusinessReassignmentReceipt({oldRequestId:old.requestId,newRequestId:current.instruction.requestId,oldSessionId:old.sessionId,newSessionId:current.instruction.sessionId,scope:old.scope,snapshotHash:current.snapshotHash,createdAt})
  },()=>admission?.assertCurrent())
 }
}

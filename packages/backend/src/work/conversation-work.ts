import {initializeConversationWorkRequests,workRequestChildId,lockConversationTaskChild,assertConversationTaskChildUnoccupied} from './conversation-work-task-protection.ts'
export {workRequestChildId} from './conversation-work-task-protection.ts'
import type {Pool,PoolClient} from 'pg'
import {WorkError,businessObjectReference,roleSupportsScope,taskDefinition,taskInput,type BusinessObjectReference} from '@teloa/contract'
import {assertBusinessScopeRegistered} from './business-scopes.ts'
import {readStoredRole} from './roles.ts'
import {BusinessResponsibilityService} from './business-responsibility.ts'
import {lockBusinessConfiguration} from './business-configuration-lock.ts'
import {readBusinessConfigurationManagement} from './business-configuration-store.ts'
import {workAccess,type WorkAccessLease} from './work-access.ts'

export type ConversationWorkContext={sessionId:string;scopeId:string;roleId:string|null;version:number;locked:boolean}
export type WorkRequestTarget={roleId:string;roleVersion:number;name:string;scope:string;unavailable:null|'paused'|'retired'}
export type WorkResponsibilitySnapshot={version:number;roleId:string|null}
export type WorkRequestFailure={code:string;message:string}
export type ConversationWorkRequest={requestId:string;sessionId:string;messageId:string;messageSeq:number;kind:'task'|'report';scope:string;title:string;goal:string;sourceText?:string;responsibility?:WorkResponsibilitySnapshot;expectedReportTargets?:WorkRequestTarget[];allBusinesses?:true;targets:WorkRequestTarget[];failures:Record<string,WorkRequestFailure>;reference?:BusinessObjectReference;stoppedAt:string|null;createdAt:string}
export type ConversationWorkReserveInput={requestId:string;sessionId:string;messageId:string;messageSeq:number;kind:'task'|'report';scope:string;title:string;goal:string;sourceText?:string;responsibility?:WorkResponsibilitySnapshot;expectedReportTargets?:WorkRequestTarget[];allBusinesses?:true;roleId?:string;expectedRoleVersion?:number;reference?:BusinessObjectReference}
type Inspect=(owner:string,sessionId:string)=>Promise<{ownerId:string;sessionId:string;status:string;submitted:boolean}>
export type ConversationWorkGuardOperation={kind:'read'|'freeze'|'reserve'}|{kind:'set';scopeId:string;roleId:string|null;hasContext:boolean}
export type ConversationWorkPreparedGuard=(db:PoolClient,operation:ConversationWorkGuardOperation)=>Promise<void>
export type ConversationWorkGuard=(owner:string,sessionId:string)=>Promise<ConversationWorkPreparedGuard>
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v)
const session=(v:unknown):v is string=>typeof v==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(v)
const positive=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0
const corrupt=()=>new WorkError('teloa/storage-corrupt','会话交办记录损坏，请先核对原请求。')
function actor(owner:string){if(typeof owner!=='string'||!owner.trim()||owner.length>128)throw new WorkError('teloa/forbidden','需要有效的本人身份。')}
function location(owner:string,input:unknown,request=false){actor(owner);const row=taskInput(input,request?['sessionId','requestId']:['sessionId']);if(!session(row.sessionId)||request&&!uuid(row.requestId))throw new WorkError('teloa/invalid-input','会话或交办请求身份不正确。');return {sessionId:row.sessionId,requestId:typeof row.requestId==='string'?row.requestId.toLowerCase():row.requestId as string}}
export async function initializeConversationWork(pool:Pool):Promise<void>{await initializeConversationWorkRequests(pool);await pool.query(`
 create table if not exists teloa_conversation_work_contexts(
  owner_id text not null,session_id text not null,scope_id text not null,role_id uuid,
  version integer not null check(version>0),locked boolean not null default false,
  primary key(owner_id,session_id)
 );
 create table if not exists teloa_conversation_work_frozen_sessions(
  owner_id text not null,session_id text not null,primary key(owner_id,session_id)
 );
 create table if not exists teloa_conversation_work_context_requests(
  owner_id text not null,request_id uuid not null,request_spec jsonb not null,
  primary key(owner_id,request_id)
 );
 `)}
export function readStoredConversationWorkContext(row:Record<string,unknown>):ConversationWorkContext{
 if(!session(row.session_id)||!session(row.scope_id)||row.role_id!==null&&!uuid(row.role_id)||!positive(row.version)||typeof row.locked!=='boolean')throw corrupt()
 return {sessionId:row.session_id,scopeId:row.scope_id,roleId:row.role_id as string|null,version:row.version,locked:row.locked}
}
const readContext=readStoredConversationWorkContext
function reportTargets(input:unknown):WorkRequestTarget[]{
 if(!Array.isArray(input)||input.length>1000)throw new WorkError('teloa/invalid-input','汇报确认名单格式不正确或超过1000人。')
 const rows=input.map(value=>{
  const t=taskInput(value,['roleId','roleVersion','name','scope','unavailable'])
  if(!uuid(t.roleId)||!positive(t.roleVersion)||Number(t.roleVersion)>2147483647||typeof t.name!=='string'||!t.name.trim()||t.name.length>120||!session(t.scope)||![null,'paused','retired'].includes(t.unavailable as null))throw new WorkError('teloa/invalid-input','汇报确认名单内容不正确。')
  return {roleId:t.roleId.toLowerCase(),roleVersion:t.roleVersion,name:t.name,scope:t.scope,unavailable:t.unavailable} as WorkRequestTarget
 }).sort((a,b)=>a.roleId.localeCompare(b.roleId))
 if(new Set(rows.map(t=>t.roleId)).size!==rows.length)throw new WorkError('teloa/invalid-input','汇报确认名单存在重复员工。')
 return rows
}
function reserveInput(input:unknown):ConversationWorkReserveInput{
 const row=taskInput(input,['requestId','sessionId','messageId','messageSeq','kind','scope','title','goal','roleId','expectedRoleVersion','reference','allBusinesses','sourceText','responsibility','expectedReportTargets'])
 const fields=taskDefinition({title:row.title,goal:row.goal,scope:row.scope})
 if(!uuid(row.requestId)||!session(row.sessionId)||typeof row.messageId!=='string'||!row.messageId||row.messageId.length>200||!Number.isSafeInteger(row.messageSeq)||Number(row.messageSeq)<0||!['task','report'].includes(String(row.kind)))throw new WorkError('teloa/invalid-input','交办来源或类型不正确。')
 if(row.kind==='task'? !uuid(row.roleId)||!positive(row.expectedRoleVersion):row.roleId!==undefined||row.expectedRoleVersion!==undefined||row.reference!==undefined)throw new WorkError('teloa/invalid-input','明确交办需要真实负责人及版本，汇报集合由服务端固定。')
 if(row.allBusinesses!==undefined&&(row.allBusinesses!==true||row.kind!=='report'||fields.scope!=='general'))throw new WorkError('teloa/invalid-input','跨业务汇报必须明确选择全部业务，并由通用工作承载协调。')
 if(row.sourceText!==undefined&&(typeof row.sourceText!=='string'||!row.sourceText.trim()||row.sourceText.length+fields.goal.length>7400))throw new WorkError('teloa/invalid-input','完整原指令与任务目标超过本次交办上限，请将长材料保存为资料后引用。')
 let responsibility:WorkResponsibilitySnapshot|undefined
 if(row.responsibility!==undefined){
  const selected=taskInput(row.responsibility,['version','roleId'])
  if(row.kind!=='task'||fields.scope==='general'||!Number.isSafeInteger(selected.version)||Number(selected.version)<0||Number(selected.version)>2147483647||(selected.roleId!==null&&(!uuid(selected.roleId)||selected.version===0)))throw new WorkError('teloa/invalid-input','业务负责人快照格式不正确。')
  responsibility={version:Number(selected.version),roleId:selected.roleId===null?null:(selected.roleId as string).toLowerCase()}
 }
 const expectedReportTargets=row.expectedReportTargets===undefined?undefined:reportTargets(row.expectedReportTargets)
 if(expectedReportTargets&&row.kind!=='report')throw new WorkError('teloa/invalid-input','只有汇报请求可以固定员工名单。')
 const reference=row.reference===undefined?undefined:businessObjectReference(row.reference)
 if(reference&&reference.scope!==fields.scope)throw new WorkError('teloa/invalid-input','调查事件与责任业务不一致。')
 return {requestId:row.requestId.toLowerCase(),sessionId:row.sessionId,messageId:row.messageId,messageSeq:Number(row.messageSeq),kind:row.kind as 'task'|'report',scope:fields.scope,title:fields.title,goal:fields.goal,...(row.sourceText===undefined?{}:{sourceText:row.sourceText as string}),...(row.allBusinesses===true?{allBusinesses:true}:{}),...(row.kind==='task'?{roleId:(row.roleId as string).toLowerCase(),expectedRoleVersion:Number(row.expectedRoleVersion)}:{}),...(reference?{reference}:{}),...(responsibility?{responsibility}:{}),...(expectedReportTargets?{expectedReportTargets}:{})}
}
export function readStoredConversationWorkRequest(row:Record<string,unknown>):ConversationWorkRequest{
 try{
  const input=reserveInput(row.request_spec)
  if(input.requestId!==row.request_id||input.sessionId!==row.session_id||!Array.isArray(row.targets)||row.targets.length>1000||!(row.created_at instanceof Date)||row.stopped_at!==null&&!(row.stopped_at instanceof Date))throw Error()
  const targets=row.targets.map(value=>{
   const t=taskInput(value,['roleId','roleVersion','name','scope','unavailable'])
   if(!uuid(t.roleId)||!positive(t.roleVersion)||typeof t.name!=='string'||!t.name.trim()||!session(t.scope)||![null,'paused','retired'].includes(t.unavailable as null))throw Error()
   return t as WorkRequestTarget
  })
  if(new Set(targets.map(t=>t.roleId)).size!==targets.length||input.kind==='task'&&(targets.length!==1||targets[0]!.roleId!==input.roleId||targets[0]!.roleVersion!==input.expectedRoleVersion||targets[0]!.scope!==input.scope))throw Error()
  if(input.expectedReportTargets&&JSON.stringify(input.expectedReportTargets)!==JSON.stringify(reportTargets(targets)))throw Error()
  const failures=taskInput(row.failures,targets.map(target=>target.roleId)) as Record<string,WorkRequestFailure>
  for(const failure of Object.values(failures)){taskInput(failure,['code','message']);if(typeof failure.code!=='string'||!/^teloa\/[a-z0-9-]+$/.test(failure.code)||typeof failure.message!=='string'||!failure.message.trim()||failure.message.length>1000)throw Error()}
  return {requestId:input.requestId,sessionId:input.sessionId,messageId:input.messageId,messageSeq:input.messageSeq,kind:input.kind,scope:input.scope,title:input.title,goal:input.goal,...(input.sourceText?{sourceText:input.sourceText}:{}),...(input.allBusinesses?{allBusinesses:true}:{}),targets,failures,...(input.reference?{reference:input.reference}:{}),...(input.responsibility?{responsibility:input.responsibility}:{}),...(input.expectedReportTargets?{expectedReportTargets:input.expectedReportTargets}:{}),stoppedAt:row.stopped_at===null?null:(row.stopped_at as Date).toISOString(),createdAt:row.created_at.toISOString()}
 }catch{throw corrupt()}
}
export type ConversationWorkReservationPrepared={
 onAdmission:(lease:WorkAccessLease)=>void
 guard?:ConversationWorkPreparedGuard
 now:()=>string
 scopes?: (db:PoolClient,owner:string)=>Promise<readonly string[]>
 responsibility:Pick<BusinessResponsibilityService,'readInTransaction'>
}
/** 调用者已按 C→P→context 取得保护；只使用传入连接，不借池或提交事务。 */
export async function reserveConversationWorkInTransaction(db:PoolClient,owner:string,value:unknown,preparedGuard:ConversationWorkReservationPrepared):Promise<ConversationWorkRequest>{
 actor(owner);const input=reserveInput(value),spec=JSON.stringify(input),taskChild=input.kind==='task'?workRequestChildId(input.requestId,'task',input.roleId!):null,guard=preparedGuard.guard
   await guard?.(db,{kind:'reserve'})
   const previous=(await db.query('select *,request_spec=$3::jsonb as same from teloa_conversation_work_requests where owner_id=$1 and request_id=$2',[owner,input.requestId,spec])).rows[0]
   if(previous){if(!previous.same)throw new WorkError('teloa/conflict','同一用户消息已有不同交办，请先核对原请求。');return readStoredConversationWorkRequest(previous)}
   if(taskChild)await assertConversationTaskChildUnoccupied(db,owner,taskChild)
   const context=(await db.query('select * from teloa_conversation_work_contexts where owner_id=$1 and session_id=$2',[owner,input.sessionId])).rows[0]
   if(context&&((context.scope_id!==input.scope&&!input.allBusinesses)||context.role_id!==null&&(input.kind==='report'||context.role_id!==input.roleId)))throw new WorkError('teloa/conflict','交办与当前会话选定的业务或负责人不一致。')
   if(input.kind==='report'&&!input.expectedReportTargets)throw new WorkError('teloa/invalid-input','新汇报必须提供本人确认的完整员工名单。')
   // 新交办的业务负责人只在同事务内核对；旧回执已在上方返回，不重新挑选执行人。
   if(input.kind==='task'&&input.scope!=='general'){
    await lockBusinessConfiguration(db,owner,input.scope,'shared')
    const {managed}=await readBusinessConfigurationManagement(db,owner,input.scope)
    if(managed){
     if(!input.responsibility)throw new WorkError('teloa/conflict','请先读取当前业务负责人并明确本次执行人。')
     const current=await preparedGuard.responsibility.readInTransaction(db,{ownerId:owner,scopeIds:[input.scope]},{scope:input.scope})
     if(current.version!==input.responsibility.version||current.roleId!==input.responsibility.roleId)throw new WorkError('teloa/version-conflict','业务负责人已变化，请重新核对后交办。')
    }else if(input.responsibility)throw new WorkError('teloa/invalid-input','此业务尚未采用负责人配置，不能附加负责人快照。')
   }
   await assertBusinessScopeRegistered(db,owner,input.scope)
   const roles=(await db.query('select * from teloa_roles where owner_id=$1 and ($2::uuid is null or id=$2) order by id for share',[owner,input.roleId??null])).rows.map(readStoredRole)
   await guard?.(db,{kind:'reserve'})
   const allowed=input.kind==='report'?(preparedGuard.scopes?await preparedGuard.scopes(db,owner):input.allBusinesses?null:[input.scope]):null
   if(input.kind==='report'&&(!allowed||!Array.isArray(allowed)||allowed.some(scope=>!session(scope))||!allowed.includes(input.scope)))throw new WorkError('teloa/forbidden','无法核对汇报当前业务授权范围。')
   const eligible=roles.filter(role=>role.kind==='employee'&&(input.kind==='report'?input.allBusinesses===true?role.scopes.some(scope=>allowed!.includes(scope)):role.scopes.includes(input.scope):roleSupportsScope(role.scopes,input.scope)))
   if(input.kind==='task'){
    const role=eligible[0];if(!role)throw new WorkError('teloa/forbidden','指定员工不存在或不支持责任业务。')
    if(role.version!==input.expectedRoleVersion)throw new WorkError('teloa/version-conflict','指定员工版本已变化，请核对。')
    if(role.state!=='active')throw new WorkError('teloa/conflict','指定员工已暂停或退役，不能接手新工作。')
   }
   if(eligible.length>1000)throw new WorkError('teloa/invalid-input','本次员工范围过大，请缩小业务范围。')
   const targets:WorkRequestTarget[]=eligible.map(role=>({roleId:role.id,roleVersion:role.version,name:role.name,scope:input.allBusinesses===true?role.scopes.find(scope=>allowed!.includes(scope))!:input.scope,unavailable:role.state==='active'?null:role.state}))
   if(input.expectedReportTargets&&JSON.stringify(targets)!==JSON.stringify(input.expectedReportTargets))throw new WorkError('teloa/version-conflict','汇报员工名单、版本、状态或授权范围已变化，请重新确认。')
   const admission=await workAccess.authorize({kind:'conversation-work-reserve',ownerId:owner,requestId:input.requestId,sessionId:input.sessionId})
   preparedGuard.onAdmission(admission);admission.assertCurrent()
   const saved=(await db.query('insert into teloa_conversation_work_requests(owner_id,request_id,session_id,request_spec,targets,created_at,task_child_request_id) values($1,$2,$3,$4,$5,$6,$7) returning *',[owner,input.requestId,input.sessionId,spec,JSON.stringify(targets),preparedGuard.now(),taskChild])).rows[0]
   admission.assertCurrent()
   await db.query('update teloa_conversation_work_contexts set locked=true where owner_id=$1 and session_id=$2',[owner,input.sessionId]);admission.assertCurrent();return readStoredConversationWorkRequest(saved)
}
export type ConversationWorkLockConnections={connect:()=>Promise<PoolClient>}
export class ConversationWorkService{
 readonly dispatchLocks:ConversationWorkLockConnections|undefined
 readonly pool:Pool;readonly now:()=>string;readonly inspect:Inspect;readonly guard:ConversationWorkGuard|undefined;readonly scopes:((db:PoolClient,owner:string)=>Promise<readonly string[]>)|undefined
 constructor(pool:Pool,now:()=>string,inspect:Inspect,guard?:ConversationWorkGuard,scopes?:(db:PoolClient,owner:string)=>Promise<readonly string[]>,dispatchLocks?:ConversationWorkLockConnections){this.pool=pool;this.now=now;this.inspect=inspect;this.guard=guard;this.scopes=scopes;this.dispatchLocks=dispatchLocks}
 private async inspectSession(owner:string,sessionId:string){
  try{const value=await this.inspect(owner,sessionId);if(value.ownerId!==owner||value.sessionId!==sessionId||value.status!=='ready')throw new WorkError('teloa/forbidden','当前会话不属于本人或尚未就绪。');return value}
  catch(error){if(error instanceof WorkError)throw error;throw new WorkError('teloa/host-unavailable','暂时无法核对发起会话。')}
 }
 private async inspectReadSession(owner:string,sessionId:string){
  const observed=await this.inspectSession(owner,sessionId)
  if(this.guard){const guard=await this.guard(owner,sessionId),db=await this.pool.connect();try{await guard(db,{kind:'read'})}finally{db.release()}}
  return observed
 }
 private async lock(db:PoolClient,owner:string,key:string){await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['teloa/conversation-work',owner,key])])}
 /** 长期session锁独占专用连接域；回调的短事务仍用主业务池，不能持主池连接再借同池。 */
 async withDispatchLock<T>(owner:string,requestId:string,operation:(lockSignal:AbortSignal)=>Promise<T>):Promise<T>{
  actor(owner);if(!uuid(requestId))throw new WorkError('teloa/invalid-input','交办请求身份不正确。')
  if(!this.dispatchLocks||this.dispatchLocks===this.pool)throw new WorkError('teloa/dependency-unavailable','交办锁连接尚未独立装配，请先恢复宿主后核对原请求。')
  const db=await this.dispatchLocks.connect(),key=JSON.stringify(['teloa/conversation-dispatch',owner,requestId.toLowerCase()]),controller=new AbortController()
  let locked=false,destroy:Error|undefined
  const lost=(error?:unknown)=>{destroy=error instanceof Error?error:new Error('dispatch lock connection lost');if(!controller.signal.aborted)controller.abort(new WorkError('teloa/storage-unavailable','交办独占连接已失效，请核对原请求；不能继续视为成功。'))}
  const ended=()=>lost()
  db.on('error',lost);db.on('end',ended)
  try{
   await db.query('select pg_advisory_lock(hashtextextended($1,0))',[key]);locked=true;controller.signal.throwIfAborted()
   const result=await operation(controller.signal);controller.signal.throwIfAborted();return result
  }catch(error){if(!locked)lost(error);if(controller.signal.aborted)throw controller.signal.reason;throw error}
  finally{
   if(locked&&!destroy)try{const result=await db.query('select pg_advisory_unlock(hashtextextended($1,0)) as released',[key]);if(result.rows[0]?.released!==true)lost()}catch(error){lost(error)}
   db.off('error',lost);db.off('end',ended);db.release(destroy)
   if(controller.signal.aborted)throw controller.signal.reason
  }
 }

 async context(owner:string,input:unknown):Promise<ConversationWorkContext|null>{
  const {sessionId}=location(owner,input),observed=await this.inspectReadSession(owner,sessionId)
  const row=(await this.pool.query('select * from teloa_conversation_work_contexts where owner_id=$1 and session_id=$2',[owner,sessionId])).rows[0]
  return row?{...readContext(row),locked:row.locked||observed.submitted}:null
 }
 /** 原生 pre-step 消费本人消息之前，与设置共用同一事务锁固定上下文。 */
 async freeze(owner:string,input:unknown):Promise<ConversationWorkContext|null>{
  const {sessionId}=location(owner,input);await this.inspectSession(owner,sessionId);const guard=await this.guard?.(owner,sessionId),db=await this.pool.connect()
  try{await db.query('begin');await this.lock(db,owner,'context:'+sessionId);await guard?.(db,{kind:'freeze'});const row=(await db.query('update teloa_conversation_work_contexts set locked=true where owner_id=$1 and session_id=$2 returning *',[owner,sessionId])).rows[0];if(!row)await db.query('insert into teloa_conversation_work_frozen_sessions(owner_id,session_id) values($1,$2) on conflict do nothing',[owner,sessionId]);await db.query('commit');return row?readContext(row):null}
  catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
 async setContext(owner:string,input:unknown):Promise<ConversationWorkContext>{
  actor(owner);const row=taskInput(input,['requestId','sessionId','scopeId','roleId','expectedVersion'])
  if(!uuid(row.requestId)||!session(row.sessionId)||!session(row.scopeId)||row.roleId!==null&&!uuid(row.roleId)||!Number.isSafeInteger(row.expectedVersion)||Number(row.expectedVersion)<0)throw new WorkError('teloa/invalid-input','会话业务、负责人或版本不正确。')
  const spec=JSON.stringify({sessionId:row.sessionId,scopeId:row.scopeId,roleId:row.roleId,expectedVersion:row.expectedVersion}),observed=await this.inspectSession(owner,row.sessionId),guard=await this.guard?.(owner,row.sessionId),db=await this.pool.connect()
  try{
   await db.query('begin');await this.lock(db,owner,'context-request:'+row.requestId);await this.lock(db,owner,'context:'+row.sessionId)
   const current=(await db.query('select * from teloa_conversation_work_contexts where owner_id=$1 and session_id=$2',[owner,row.sessionId])).rows[0]
   await guard?.(db,{kind:'set',scopeId:row.scopeId,roleId:row.roleId as string|null,hasContext:!!current})
   const receipt=(await db.query('select request_spec=$3::jsonb as same from teloa_conversation_work_context_requests where owner_id=$1 and request_id=$2',[owner,row.requestId,spec])).rows[0]
   if(receipt){if(!receipt.same)throw new WorkError('teloa/conflict','同一请求不能修改会话归属。');if(!current)throw corrupt();await db.query('commit');return {...readContext(current),locked:current.locked||observed.submitted}}
   const frozen=(await db.query('select 1 from teloa_conversation_work_frozen_sessions where owner_id=$1 and session_id=$2',[owner,row.sessionId])).rowCount
   if(observed.submitted||current?.locked||frozen)throw new WorkError('teloa/conflict','已发送的工作不能改变业务或指定负责人，请开始新工作。')
   if((current?.version??0)!==row.expectedVersion)throw new WorkError('teloa/version-conflict','会话业务设置已变化，请先核对。')
   await assertBusinessScopeRegistered(db,owner,row.scopeId)
   if(row.roleId!==null){const raw=(await db.query('select * from teloa_roles where owner_id=$1 and id=$2 for share',[owner,row.roleId])).rows[0];if(!raw)throw new WorkError('teloa/forbidden','指定员工不存在或不属于本人。');const role=readStoredRole(raw);if(role.kind!=='employee'||role.state!=='active')throw new WorkError('teloa/conflict','指定员工当前不能接手。');if(!roleSupportsScope(role.scopes,row.scopeId))throw new WorkError('teloa/forbidden','指定员工不支持此业务。')}
   const saved=(await db.query('insert into teloa_conversation_work_contexts(owner_id,session_id,scope_id,role_id,version,locked) values($1,$2,$3,$4,$5,false) on conflict(owner_id,session_id) do update set scope_id=excluded.scope_id,role_id=excluded.role_id,version=excluded.version returning *',[owner,row.sessionId,row.scopeId,row.roleId,Number(row.expectedVersion)+1])).rows[0]
   await db.query('insert into teloa_conversation_work_context_requests values($1,$2,$3)',[owner,row.requestId,spec]);await db.query('commit');return readContext(saved)
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
 async reserve(owner:string,value:unknown):Promise<ConversationWorkRequest>{
  actor(owner);const input=reserveInput(value),taskChild=input.kind==='task'?workRequestChildId(input.requestId,'task',input.roleId!):null
  await this.inspectSession(owner,input.sessionId);const guard=await this.guard?.(owner,input.sessionId),db=await this.pool.connect()
  let admission:WorkAccessLease|undefined
  try{
   await db.query('begin');if(taskChild)await lockConversationTaskChild(db,owner,taskChild);await this.lock(db,owner,'request:'+input.requestId);await this.lock(db,owner,'context:'+input.sessionId)
   const result=await reserveConversationWorkInTransaction(db,owner,input,{onAdmission:lease=>{admission=lease},...(guard?{guard}:{}),now:this.now,...(this.scopes?{scopes:this.scopes}:{}),responsibility:new BusinessResponsibilityService(this.pool)})
   admission?.assertCurrent();await db.query('commit');return result
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
 async get(owner:string,input:unknown):Promise<ConversationWorkRequest|null>{
  const {sessionId,requestId}=location(owner,input,true);await this.inspectReadSession(owner,sessionId)
  const row=(await this.pool.query('select * from teloa_conversation_work_requests where owner_id=$1 and request_id=$2',[owner,requestId])).rows[0]
  if(row&&row.session_id!==sessionId)throw new WorkError('teloa/forbidden','交办不属于当前会话。')
  return row?readStoredConversationWorkRequest(row):null
 }
 async list(owner:string,input:unknown):Promise<ConversationWorkRequest[]>{
  const {sessionId}=location(owner,input);await this.inspectReadSession(owner,sessionId)
  return (await this.pool.query('select * from teloa_conversation_work_requests where owner_id=$1 and session_id=$2 order by created_at,request_id',[owner,sessionId])).rows.map(readStoredConversationWorkRequest)
 }
 async stop(owner:string,input:unknown):Promise<ConversationWorkRequest>{
  const {sessionId,requestId}=location(owner,input,true)
  return this.withDispatchLock(owner,requestId,async signal=>{
   signal.throwIfAborted();const current=await this.get(owner,{sessionId,requestId});signal.throwIfAborted()
   if(!current)throw new WorkError('teloa/not-found','没有找到本次交办。')
   const db=await this.pool.connect()
   try{
    await db.query('begin');await this.lock(db,owner,'request:'+requestId);signal.throwIfAborted()
    const saved=readStoredConversationWorkRequest((await db.query('update teloa_conversation_work_requests set stopped_at=coalesce(stopped_at,$3) where owner_id=$1 and request_id=$2 returning *',[owner,requestId,this.now()])).rows[0])
    await db.query('commit');return saved
   }catch(error){await db.query('rollback');throw error}finally{db.release()}
  })
 }
 async failure(owner:string,requestId:string,roleId:string,failure:WorkRequestFailure|null):Promise<void>{
  actor(owner);if(!uuid(requestId)||!uuid(roleId))throw new WorkError('teloa/invalid-input','交办成员身份不正确。')
  if(failure&&(typeof failure.code!=='string'||!/^teloa\/[a-z0-9-]+$/.test(failure.code)||typeof failure.message!=='string'||!failure.message.trim()||failure.message.length>1000))throw new WorkError('teloa/invalid-input','交办失败原因不正确。')
  await this.pool.query(`update teloa_conversation_work_requests set failures=case when $4::jsonb is null then failures-$3 else jsonb_set(failures,array[$3],$4::jsonb) end,notified_at=null where owner_id=$1 and request_id=$2 and targets @> $5::jsonb`,[owner,requestId,roleId,failure===null?null:JSON.stringify(failure),JSON.stringify([{roleId}])])
 }
 async pendingNotifications(owner:string):Promise<ConversationWorkRequest[]>{actor(owner);return (await this.pool.query('select * from teloa_conversation_work_requests where owner_id=$1 and notified_at is null order by created_at,request_id',[owner])).rows.map(readStoredConversationWorkRequest)}
 async notified(owner:string,requestId:string):Promise<void>{actor(owner);if(!uuid(requestId))throw new WorkError('teloa/invalid-input','交办身份不正确。');await this.pool.query('update teloa_conversation_work_requests set notified_at=$3 where owner_id=$1 and request_id=$2',[owner,requestId,this.now()])}
}

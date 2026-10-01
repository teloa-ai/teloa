import {createHash} from 'node:crypto'
import type {Pool,PoolClient} from 'pg'
import {WorkError,isBusinessScopeKey,readBusinessConversationReserve,readBusinessConversationRequest,readBusinessConversationSession,readBusinessConversationBind,readBusinessConversationList,readBusinessConversationRecentDaily,type BusinessConversationBinding,type Conversation} from '@teloa/contract'
import type {BusinessConfigurationActor,BusinessConfigurationDraftService} from './business-configuration-drafts.ts'
import type {ConversationService} from './conversations.ts'
import {readStoredConversationWorkRequest,type ConversationWorkService,type ConversationWorkGuardOperation,type ConversationWorkPreparedGuard} from './conversation-work.ts'
import {readStoredTask} from './tasks.ts'
import {workRequestChildId} from './conversation-work-task-protection.ts'
type Ports={drafts:Pick<BusinessConfigurationDraftService,'begin'|'get'>;conversations:Pick<ConversationService,'bySession'>&Partial<Pick<ConversationService,'list'|'snapshotBySession'>>;contexts:Pick<ConversationWorkService,'context'>;visibleSessions?:(signal?:AbortSignal)=>Promise<readonly {sessionId:string;origin?:string}[]>}
const forbidden=()=>new WorkError('teloa/forbidden','当前本人未获准访问该业务会话。')
const conflict=()=>new WorkError('teloa/conflict','业务会话预约与当前目标或上下文不一致。')
const invalid=()=>new WorkError('teloa/invalid-input','业务会话分页身份不正确。')
const corrupt=()=>new WorkError('teloa/storage-corrupt','业务会话预约存储不一致。')
function actorValid(a:BusinessConfigurationActor){
 if(!a||typeof a.ownerId!=='string'||!a.ownerId.trim()||a.ownerId!==a.ownerId.trim()||a.ownerId.length>128||/[\x00-\x1f\x7f]/.test(a.ownerId)||!Array.isArray(a.scopeIds)||new Set(a.scopeIds).size!==a.scopeIds.length||a.scopeIds.some(s=>!isBusinessScopeKey(s)))throw forbidden()
}
function decode(r:Record<string,unknown>):BusinessConversationBinding{
 try{
  const spec=readBusinessConversationReserve({requestId:r.request_id,kind:r.kind,title:r.title,...(r.workspace_id===null?{}:{workspaceId:r.workspace_id}),...(r.scope_id===null?{}:{scope:r.scope_id})})
  if(!(r.created_at instanceof Date)||!(r.updated_at instanceof Date)||(r.draft_id!==null&&(typeof r.draft_id!=='string'||! /^[a-f0-9-]{36}$/i.test(r.draft_id)))||(r.kind==='daily'&&r.draft_id!==null)||(r.kind==='builder'&&r.session_id!==null&&r.draft_id===null))throw corrupt()
  if(r.session_id!==null)readBusinessConversationSession({sessionId:r.session_id})
  return {...spec,...(r.draft_id===null?{}:{draftId:r.draft_id as string}),...(r.session_id===null?{}:{sessionId:r.session_id as string}),createdAt:r.created_at.toISOString(),updatedAt:r.updated_at.toISOString()}
 }catch{throw corrupt()}
}
/** 固定派生身份让 begin 成功、写回失败的预约可恢复；无需跨端口持有连接或锁。 */
function beginRequest(owner:string,request:string):string{
 const h=createHash('sha256').update(JSON.stringify(['teloa.business-conversation.begin',owner,request])).digest('hex')
 return h.slice(0,8)+'-'+h.slice(8,12)+'-5'+h.slice(13,16)+'-8'+h.slice(17,20)+'-'+h.slice(20,32)
}
export async function initializeBusinessConversationBindings(pool:Pool):Promise<void>{await pool.query(`
 create table if not exists teloa_business_conversation_bindings(
 owner_id text not null,request_id text not null,kind text not null check(kind in ('builder','daily')),
 title text not null,workspace_id text,scope_id text,draft_id uuid,session_id text,
 created_at timestamptz not null,updated_at timestamptz not null,
 primary key(owner_id,request_id),unique(owner_id,session_id),
 check(kind<>'daily' or (scope_id is not null and draft_id is null)),
 check(kind<>'builder' or session_id is null or draft_id is not null));
 create index if not exists teloa_business_conversations_list on teloa_business_conversation_bindings(owner_id,created_at,request_id);
 `)}
export class BusinessConversationBindingService{
 readonly pool:Pool;readonly identity:{id:()=>string;now:()=>string};readonly ports:Ports
 constructor(pool:Pool,identity:{id:()=>string;now:()=>string},ports:Ports){this.pool=pool;this.identity=identity;this.ports=ports}
 private async raw(owner:string,request:string):Promise<BusinessConversationBinding|undefined>{
  const row=(await this.pool.query('select * from teloa_business_conversation_bindings where owner_id=$1 and request_id=$2',[owner,request])).rows[0]
  return row?decode(row):undefined
 }
 private async forNative(owner:string,n:Conversation,db:Pick<PoolClient,'query'>=this.pool):Promise<BusinessConversationBinding|undefined>{
  const rows=(await db.query('select * from teloa_business_conversation_bindings where owner_id=$1 and (session_id=$2 or request_id=$3)',[owner,n.sessionId,n.requestId??null])).rows
  if(rows.length>1)throw conflict()
  return rows[0]?decode(rows[0]):undefined
 }
 private async scope(a:BusinessConfigurationActor,r:Pick<BusinessConversationBinding,'scope'>,db:Pick<PoolClient,'query'>=this.pool){
  if(r.scope!==undefined&&(!a.scopeIds.includes(r.scope)||!(await db.query('select 1 from teloa_business_scopes where owner_id=$1 and scope=$2',[a.ownerId,r.scope])).rowCount))throw forbidden()
 }
 private async authorize(a:BusinessConfigurationActor,r:BusinessConversationBinding){
  await this.scope(a,r)
  if(r.draftId){
   const draft=await this.ports.drafts.get(a,{draftId:r.draftId})
   if(draft.ownerId!==a.ownerId||draft.id!==r.draftId||(r.scope!==undefined&&draft.scope!==r.scope))throw corrupt()
  }
  if(r.sessionId)await this.native(a.ownerId,r,r.sessionId)
  return r
 }
 private async native(owner:string,r:BusinessConversationBinding,sessionId:string):Promise<Conversation>{
  const n=await this.ports.conversations.bySession(owner,sessionId)
  this.matches(owner,r,n,sessionId)
  if(r.kind==='daily'){
   const context=await this.ports.contexts.context(owner,{sessionId})
   if(!context||context.sessionId!==sessionId||context.scopeId!==r.scope)throw conflict()
  }
  return n
 }
 private matches(owner:string,r:BusinessConversationBinding,n:Conversation,sessionId:string){
  if(n.ownerId!==owner||n.status!=='ready'||n.sessionId!==sessionId)throw forbidden()
  if(n.purpose==='task-run'||n.requestId!==r.requestId||n.title!==r.title||n.requestedWorkspaceId!==r.workspaceId||(r.sessionId!==undefined&&r.sessionId!==sessionId))throw conflict()
 }
 async reserve(a:BusinessConfigurationActor,input:unknown):Promise<BusinessConversationBinding>{
  actorValid(a);const spec=readBusinessConversationReserve(input)
  let r=await this.raw(a.ownerId,spec.requestId)
  if(r&&JSON.stringify(readBusinessConversationReserve(rToSpec(r)))!==JSON.stringify(spec))throw conflict()
  if(!r){
   await this.scope(a,spec)
   await this.pool.query('insert into teloa_business_conversation_bindings(owner_id,request_id,kind,title,workspace_id,scope_id,created_at,updated_at) values($1,$2,$3,$4,$5,$6,$7,$7) on conflict(owner_id,request_id) do nothing',[a.ownerId,spec.requestId,spec.kind,spec.title,spec.workspaceId??null,spec.scope??null,this.identity.now()])
   r=(await this.raw(a.ownerId,spec.requestId))!
   if(JSON.stringify(rToSpec(r))!==JSON.stringify(spec))throw conflict()
  }
  await this.authorize(a,r)
  if(r.kind==='builder'&&!r.draftId){
   const draft=await this.ports.drafts.begin(a,{requestId:beginRequest(a.ownerId,r.requestId),title:r.title,...(r.scope===undefined?{}:{scope:r.scope})})
   if(draft.ownerId!==a.ownerId||(r.scope!==undefined&&draft.scope!==r.scope))throw corrupt()
   await this.pool.query('update teloa_business_conversation_bindings set draft_id=$3,updated_at=$4 where owner_id=$1 and request_id=$2 and draft_id is null',[a.ownerId,r.requestId,draft.id,this.identity.now()])
   r=(await this.raw(a.ownerId,r.requestId))!
   if(r.draftId!==draft.id)throw conflict()
  }
  return this.authorize(a,r)
 }
 async bind(a:BusinessConfigurationActor,input:unknown):Promise<BusinessConversationBinding>{
  actorValid(a);const {requestId,sessionId}=readBusinessConversationBind(input),r=await this.raw(a.ownerId,requestId)
  if(!r)throw forbidden()
  await this.authorize(a,r)
  if(r.kind==='builder'&&!r.draftId)throw conflict()
  // matches 已核对固定 requestId；此后 ConversationService 不再改变该普通会话身份。
  const native=await this.native(a.ownerId,r,sessionId)
  const db=await this.pool.connect()
  try{
   await db.query('begin')
   await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['teloa/conversation-work',a.ownerId,'context:'+sessionId])])
   const current=(await db.query('select * from teloa_business_conversation_bindings where owner_id=$1 and request_id=$2 for update',[a.ownerId,requestId])).rows[0]
   if(!current)throw conflict()
   const fixed=decode(current);this.matches(a.ownerId,fixed,native,sessionId);await this.scope(a,fixed,db)
   if(fixed.kind==='daily'){
    const context=(await db.query('select scope_id from teloa_conversation_work_contexts where owner_id=$1 and session_id=$2',[a.ownerId,sessionId])).rows[0]
    if(!context||context.scope_id!==fixed.scope)throw conflict()
   }
   await db.query('update teloa_business_conversation_bindings set session_id=$3,updated_at=$4 where owner_id=$1 and request_id=$2 and session_id is null',[a.ownerId,requestId,sessionId,this.identity.now()]);await db.query('commit')
  }catch(e){await db.query('rollback');if((e as {code?:string}).code==='23505')throw conflict();throw e}finally{db.release()}
  const saved=(await this.raw(a.ownerId,requestId))!
  if(saved.sessionId!==sessionId)throw conflict()
  return this.authorize(a,saved)
 }
 async byRequest(a:BusinessConfigurationActor,input:unknown):Promise<BusinessConversationBinding|undefined>{
  actorValid(a);const r=await this.raw(a.ownerId,readBusinessConversationRequest(input).requestId)
  return r?this.authorize(a,r):undefined
 }
 async bySession(a:BusinessConfigurationActor,input:unknown):Promise<BusinessConversationBinding|undefined>{
  actorValid(a);const {sessionId}=readBusinessConversationSession(input),n=await this.ports.conversations.bySession(a.ownerId,sessionId)
  if(n.ownerId!==a.ownerId||n.status!=='ready')throw forbidden()
  const r=await this.forNative(a.ownerId,n)
  if(!r)return undefined
  this.matches(a.ownerId,r,n,sessionId)
  if(r.kind==='daily'&&r.sessionId===undefined){await this.scope(a,r);return r}
  await this.native(a.ownerId,r,sessionId)
  return this.authorize(a,r)
 }
 async isBuilder(owner:string,sessionId:string):Promise<boolean>{
  actorValid({ownerId:owner,scopeIds:[]});readBusinessConversationSession({sessionId})
  // 不调用 contexts 或 drafts：交办上下文 inspect 也会使用此守卫，必须保持单向依赖。
  const n=await this.ports.conversations.bySession(owner,sessionId)
  if(n.ownerId!==owner||n.status!=='ready')throw forbidden()
  const r=await this.forNative(owner,n)
  if(!r)return false
  this.matches(owner,r,n,sessionId)
  return r.kind==='builder'
 }
 async isPendingDaily(owner:string,sessionId:string):Promise<boolean>{
  actorValid({ownerId:owner,scopeIds:[]});readBusinessConversationSession({sessionId})
  const n=await this.ports.conversations.bySession(owner,sessionId),r=await this.forNative(owner,n)
  if(!r)return false
  this.matches(owner,r,n,sessionId)
  return r.kind==='daily'&&r.sessionId===undefined
 }
 /** 已有 requestId 的 ready 普通会话身份不再修改；未入目录会话仍可能被 adopt。
  * checkout 前离开串行队列。未入目录身份在锁内只读原子文件快照，不进入串行队列或借池。 */
 async prepareWorkGuard(owner:string,sessionId:string):Promise<ConversationWorkPreparedGuard>{
  const native=Object.freeze({...await this.ports.conversations.bySession(owner,sessionId)})
  return async(db,operation)=>{
   const current=native.requestId===undefined?await this.ports.conversations.snapshotBySession?.(owner,sessionId):native
   if(!current)throw new WorkError('teloa/host-unavailable','暂时无法核对会话的目录身份。')
   if(current.id!==native.id||current.ownerId!==owner||current.sessionId!==sessionId)throw forbidden()
   await this.guardWorkInTransaction(db,owner,current,operation)
  }
 }
 /** 两端都必须是完整绑定的日常主会话；事务外读取 native，锁内仅用同一连接复验。 */
 async prepareReassignmentGuard(owner:string,oldSessionId:string,newSessionId:string):Promise<(db:PoolClient)=>Promise<void>>{
  const ids=[...new Set([oldSessionId,newSessionId])].sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b)))
  const native=await Promise.all(ids.map(id=>this.ports.conversations.bySession(owner,id)))
  for(let i=0;i<ids.length;i++)if(native[i]!.ownerId!==owner||native[i]!.sessionId!==ids[i]||native[i]!.status!=='ready'||native[i]!.purpose==='task-run'||!native[i]!.requestId)throw forbidden()
  return async db=>{
   let scope:string|undefined
   for(let i=0;i<ids.length;i++){
    const id=ids[i]!,n=native[i]!,rows=(await db.query('select * from teloa_business_conversation_bindings where owner_id=$1 and (session_id=$2 or request_id=$3) order by request_id for share',[owner,id,n.requestId])).rows
    if(rows.length!==1)throw forbidden()
    const r=decode(rows[0]);this.matches(owner,r,n,id)
    if(r.kind!=='daily'||r.sessionId!==id||r.draftId!==undefined||r.scope===undefined||r.scope==='general')throw forbidden()
    if(scope!==undefined&&scope!==r.scope)throw forbidden();scope=r.scope
    await this.scope({ownerId:owner,scopeIds:[r.scope]},r,db)
    const context=(await db.query('select scope_id from teloa_conversation_work_contexts where owner_id=$1 and session_id=$2 for share',[owner,id])).rows[0]
    if(!context||context.scope_id!==r.scope)throw conflict()
    await this.assertMainSourceLinks(db,owner,n,r.scope)
   }
  }
 }
 /** 主助手可保留其交办的确定 Task source link；独立任务/角色关系不能据此冒充主会话。 */
 private async assertMainSourceLinks(db:PoolClient,owner:string,native:Conversation,scope:string):Promise<void>{
  if(!(await db.query("select to_regclass('teloa_object_conversations') relation")).rows[0]?.relation)return
  const links=(await db.query('select kind,object_id,conversation_id,scope_id from teloa_object_conversations where owner_id=$1 and session_id=$2 and active=true order by kind,object_id',[owner,native.sessionId])).rows
  if(!links.length)return
  if(links.some(link=>link.kind!=='task'||link.conversation_id!==native.id||link.scope_id!==null&&link.scope_id!==scope))throw forbidden()
  // context 锁已阻止 link/unlink phantom；这里不提前锁 Task，保持 commit 的 Run→Task 顺序。
  const requests=(await db.query('select * from teloa_conversation_work_requests where owner_id=$1 and session_id=$2 order by request_id',[owner,native.sessionId])).rows.map(readStoredConversationWorkRequest)
  const tasks=(await db.query('select * from teloa_tasks where owner_id=$1 and id=any($2::uuid[]) order by id',[owner,links.map(link=>link.object_id)])).rows
  for(const link of links){
   const row=tasks.find(task=>task.id===link.object_id)
   if(!row)throw forbidden()
   const task=readStoredTask(row)
   if(task.ownerId!==owner||task.scope!==scope||!requests.some(request=>request.targets.some(target=>target.scope===scope&&target.roleId===task.assigneeRoleId&&target.roleVersion===task.assigneeRoleVersion&&row.request_id===workRequestChildId(request.requestId,'task',target.roleId))))throw forbidden()
  }
 }
 private async guardWorkInTransaction(db:PoolClient,owner:string,n:Conversation,operation:ConversationWorkGuardOperation):Promise<void>{
  const sessionId=n.sessionId,r=await this.forNative(owner,n,db)
  if(!r)return
  this.matches(owner,r,n,sessionId)
  if(r.kind==='builder')throw forbidden()
  await this.scope({ownerId:owner,scopeIds:[r.scope!]},r,db)
  if(operation.kind==='set'){
   if(operation.scopeId!==r.scope||!operation.hasContext&&operation.roleId!==null)throw conflict()
  }else if(operation.kind!=='read'&&r.sessionId===undefined)throw new WorkError('teloa/binding-pending','日常业务会话尚未完成归属，请先恢复原预约。')
  if(r.sessionId!==undefined){
   const context=(await db.query('select scope_id from teloa_conversation_work_contexts where owner_id=$1 and session_id=$2',[owner,sessionId])).rows[0]
   if(!context||context.scope_id!==r.scope)throw conflict()
  }
 }
 async recentDaily(a:BusinessConfigurationActor,input:unknown,signal?:AbortSignal):Promise<BusinessConversationBinding|null>{
  actorValid(a);const {scope}=readBusinessConversationRecentDaily(input),target={scope}
  signal?.throwIfAborted();await this.scope(a,target)
  const {visibleSessions,conversations}=this.ports
  if(!visibleSessions||!conversations.list)throw new WorkError('teloa/host-unavailable','原生会话目录尚未就绪。')
  const visible=(await visibleSessions(signal)).filter(item=>item.origin!=='subagent');signal?.throwIfAborted()
  const native=await conversations.list(a.ownerId,{});signal?.throwIfAborted()
  const pending=(await this.pool.query("select * from teloa_business_conversation_bindings where owner_id=$1 and kind='daily' and scope_id=$2 and session_id is null order by created_at,request_id limit 1",[a.ownerId,scope])).rows[0]
  const row=pending??(await this.pool.query("select b.* from unnest($3::text[]) with ordinality as visible(session_id,position) join teloa_business_conversation_bindings b on b.session_id=visible.session_id where b.owner_id=$1 and b.kind='daily' and b.scope_id=$2 order by visible.position limit 1",[a.ownerId,scope,visible.map(item=>item.sessionId)])).rows[0]
  if(!row){await this.scope(a,target);signal?.throwIfAborted();return null}
  const selected=decode(row),n=native.find(item=>item.requestId===selected.requestId)
  if(selected.sessionId!==undefined){
   if(!n)throw forbidden()
   this.matches(a.ownerId,selected,n,selected.sessionId)
   const context=(await this.pool.query('select scope_id from teloa_conversation_work_contexts where owner_id=$1 and session_id=$2',[a.ownerId,n.sessionId])).rows[0]
   if(!context||context.scope_id!==scope)throw conflict()
  }else if(n){
   // 文件预约可以先于原生创建；ready 后不可见则必须显式处理，不能新开另一个会话。
   this.matches(a.ownerId,selected,{...n,status:'ready'},n.sessionId)
   if(n.status==='ready'&&!visible.some(item=>item.sessionId===n.sessionId))throw new WorkError('teloa/conflict','待恢复的日常会话当前不可见。',{reason:'daily-session-unavailable'})
  }
  await this.scope(a,target)
  const current=await this.raw(a.ownerId,selected.requestId)
  if(!current||JSON.stringify(current)!==JSON.stringify(selected))throw conflict()
  signal?.throwIfAborted();return selected
 }
 async list(a:BusinessConfigurationActor,input:unknown):Promise<{items:BusinessConversationBinding[];nextCursor?:string}>{
  actorValid(a);const q=readBusinessConversationList(input),filter=JSON.stringify([a.ownerId,q.kind??null,q.scope??null])
  let after:{createdAt:string;requestId:string}|undefined
  if(q.cursor){
   try{
    const c=JSON.parse(Buffer.from(q.cursor,'base64url').toString('utf8'))
    if(c.filter!==filter||Object.keys(c).sort().join(',')!=='createdAt,filter,requestId'||typeof c.createdAt!=='string'||new Date(c.createdAt).toISOString()!==c.createdAt)throw invalid()
    readBusinessConversationRequest({requestId:c.requestId});after=c
   }catch{throw invalid()}
  }
  const rows=(await this.pool.query('select * from teloa_business_conversation_bindings where owner_id=$1 and ($2::text is null or kind=$2) and ($3::text is null or scope_id=$3) and ($4::timestamptz is null or (created_at,request_id)>($4::timestamptz,$5::text)) order by created_at,request_id limit $6',[a.ownerId,q.kind??null,q.scope??null,after?.createdAt??null,after?.requestId??null,q.limit+1])).rows
  const items:BusinessConversationBinding[]=[]
  for(const row of rows.slice(0,q.limit))items.push(await this.authorize(a,decode(row)))
  const last=items.at(-1)
  return {items,...(rows.length>q.limit&&last?{nextCursor:Buffer.from(JSON.stringify({filter,createdAt:last.createdAt,requestId:last.requestId})).toString('base64url')}:{})}
 }
}
function rToSpec(r:BusinessConversationBinding){return {requestId:r.requestId,kind:r.kind,title:r.title,...(r.workspaceId===undefined?{}:{workspaceId:r.workspaceId}),...(r.scope===undefined?{}:{scope:r.scope})}}

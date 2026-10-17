import {createHash} from 'node:crypto'
import type {Context} from '@deepseek-ai/cordis'
import {Session,SessionId,SessionLogOffset} from '@deepseek-ai/dsh-session'
import {ReasoningEffortId} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-agent-loop'
import {readStoredConversationWorkContext,readStoredConversationWorkRequest,readStoredRole,combineWorkAccessLeases,workAccess,type OwnerExecutionAuthority,type ConversationService,type ObjectConversationService,type ProjectRuntimeActor,type ResourceService,type TaskRunService,type RoleMemoryService} from '@teloa/backend'
import {WorkError,roleSupportsScope,type DigitalRole} from '@teloa/contract'
import type {ProjectRuntimeHostPorts} from './project-runtime-host.ts'
import {readSessionEvents} from './session-events.ts'

type Ports={
 owner:string;pool:TaskRunService['pool'];conversations:Pick<ConversationService,'snapshotBySession'|'repository'>
 links:Pick<ObjectConversationService,'bySession'>;runs:()=>Promise<Pick<TaskRunService,'get'|'conversationParent'>>
 resources:Pick<ResourceService,'readForIndexInTransaction'>;roleMemories:()=>Promise<Pick<RoleMemoryService,'confirmedForExperience'|'confirmedForRun'>>
 ownerExecution?:Pick<OwnerExecutionAuthority,'current'>
 isBuilder?:(sessionId:string)=>Promise<boolean>
}
const denied=()=>new WorkError('teloa/forbidden','项目执行者的真实归属或业务范围已不可核验。')
const unavailable=()=>new WorkError('teloa/dependency-unavailable','原会话模型配置尚不可读取，请稍后继续。')

/** 宿主只读事实适配；冷日志不 resolveAgent，不把 UI 的 parent/scope 当授权。 */
export function createProjectRuntimeAdapters(ctx:Context,ports:Ports){
 const owner=(value:string)=>{if(value!==ports.owner)throw denied()}
 const snapshot=async(sessionId:string)=>{
  const live=ctx.agents.get(SessionId(sessionId))
  if(live)return {session:live.session,live,events:readSessionEvents(live.session)}
  const cold=await ctx.sessionController.inspect(SessionId(sessionId))
  if(cold.meta.id!==sessionId)throw denied()
  const session=Session.create(SessionId(sessionId),cold.events,cold.meta,SessionLogOffset(cold.inheritedEventCount))
  return {session,live:undefined,events:cold.events}
 }
 const inspect=async(actor:string,sessionId:string,ancestors=new Set<string>()):Promise<ProjectRuntimeActor>=>{
  owner(actor);if(ancestors.has(sessionId)||ancestors.size>=32)throw denied();ancestors.add(sessionId)
  const {session,live,events}=await snapshot(sessionId),coldInbox=live?undefined:ctx.sessionProjections.stateOf(session,'inbox')
  if(!live&&!coldInbox)throw denied()
  const submitted=events.some(event=>event.seq>=session.inheritedEventCount&&event.type==='user/message'&&event.surfaceOp==='append'&&event.data.source.kind==='user')
  const pending=live?live.inbox.nextTurn.length>0||live.inbox.nextStep.length>0:coldInbox!['next-turn'].length>0||coldInbox!['next-step'].length>0
  const state={sessionId,submitted,running:live?.status==='running',pending}
  if(session.header.origin==='subagent'){
   const parentSessionId=session.header.parentSession;if(!parentSessionId)throw denied()
   const parent=await inspect(actor,parentSessionId,ancestors)
   const {parentMessageId:_originalParentMessage,...inherited}=parent
   return {...inherited,...state,title:parent.title,kind:'subagent',parentSessionId}
  }
  const binding=await ports.conversations.snapshotBySession(actor,sessionId)
  if(binding.sessionId!==sessionId||binding.ownerId!==actor)throw denied()
  const rows=(await ports.pool.query('select id from teloa_task_runs where owner_id=$1 and session_id=$2 order by created_at desc,id desc limit 2',[actor,sessionId])).rows
  if(rows.length>1)throw denied()
  if(rows[0]){
   const runs=await ports.runs(),run=await runs.get(actor,{runId:rows[0].id})
   if(run.sessionId!==sessionId)throw denied()
   // get() 已核对整份固定输入与 Run 哈希；这里不从消息文本猜测 task 身份。
   const input=JSON.parse(run.inputText) as {task:{scope:string;goal:string};role:{id:string}}
   if(run.executor?.kind==='owner'){
    if(input.task?.scope!=='general'||typeof input.task.goal!=='string'||run.roleId!==null)throw denied()
    if(run.lineage?.definition?.planId===run.executor.grantId){
     if(!ports.ownerExecution||run.lineage.definition.definitionVersion!==run.executor.grantVersion)throw denied()
     const db=await ports.pool.connect()
     try{
      await db.query('begin')
      const grant=await ports.ownerExecution.current(db,actor,run.executor)
      if(!grant.plan||grant.plan.planId!==run.executor.grantId||grant.plan.configVersion!==run.executor.grantVersion)throw denied()
      grant.admission.assertCurrent()
      await db.query('commit')
      return {...state,title:binding.title,kind:'task',scope:'general',scopes:['general'],goal:input.task.goal,...(grant.source?{parentSessionId:grant.source.sessionId,parentMessageId:grant.source.messageId}:{})}
     }catch(error){await db.query('rollback');throw error}finally{db.release()}
    }
    const parent=await runs.conversationParent(actor,{runId:run.id})
    if(parent?.executor!=='general')throw denied()
    const row=(await ports.pool.query('select * from teloa_conversation_work_requests where owner_id=$1 and request_id=$2',[actor,parent.requestId])).rows[0]
    if(!row)throw denied();const original=readStoredConversationWorkRequest(row)
    if(original.sessionId!==parent.sessionId||original.requestId!==run.executor.grantId||original.executor!=='general')throw denied()
    return {...state,title:binding.title,kind:'task',scope:'general',scopes:['general'],goal:input.task.goal,parentSessionId:parent.sessionId,parentMessageId:original.messageId}
   }
   if(!input.task?.scope||typeof input.task.goal!=='string'||input.role?.id!==run.roleId)throw denied()
   const roleRow=(await ports.pool.query('select * from teloa_roles where owner_id=$1 and id=$2',[actor,run.roleId])).rows[0]
   if(!roleRow)throw denied();const role=readStoredRole(roleRow)
   if(role.ownerId!==actor||role.state==='retired'||input.task.scope!=='general'&&!roleSupportsScope(role.scopes,input.task.scope))throw denied()
   const parent=await runs.conversationParent(actor,{runId:run.id})
   let parentMessageId:string|undefined
   if(parent){const row=(await ports.pool.query('select * from teloa_conversation_work_requests where owner_id=$1 and request_id=$2',[actor,parent.requestId])).rows[0];if(!row)throw denied();const original=readStoredConversationWorkRequest(row);if(original.sessionId!==parent.sessionId||original.requestId!==parent.requestId)throw denied();parentMessageId=original.messageId}
   return {...state,title:binding.title,kind:'task',scope:input.task.scope,scopes:[...new Set([input.task.scope,...role.scopes])],roleId:role.id,goal:input.task.goal,...parent?{parentSessionId:parent.sessionId,parentMessageId:parentMessageId!}:{}}
  }
  if(binding.purpose==='task-run')throw denied()
  const links=(await ports.links.bySession(actor,{sessionId})).filter(link=>link.kind==='role'&&link.active)
  if(links.length>1)throw denied()
  const link=links[0],stored=(await ports.conversations.repository.read()).find(row=>row.sessionId===sessionId)
  if(link){
   if(link.conversationId!==binding.id||link.sessionId!==sessionId||stored?.requestedRoleId&&stored.requestedRoleId!==link.objectId)throw denied()
   const roleRow=(await ports.pool.query('select * from teloa_roles where owner_id=$1 and id=$2',[actor,link.objectId])).rows[0]
   if(!roleRow)throw denied();const role=readStoredRole(roleRow),scope=link.scopeId??(role.scopes.length===1?role.scopes[0]:undefined)
   if(role.ownerId!==actor||role.state==='retired'||!scope||!roleSupportsScope(role.scopes,scope))throw denied()
   return {...state,title:binding.title,kind:'employee',scope,scopes:[...role.scopes],roleId:role.id}
  }
  if(stored?.requestedRoleId)throw denied()
  const context=(await ports.pool.query('select * from teloa_conversation_work_contexts where owner_id=$1 and session_id=$2',[actor,sessionId])).rows[0]
  const scope=context?readStoredConversationWorkContext(context).scopeId:'general'
  const bindable=binding.purpose!=='assistant'&&!await ports.isBuilder?.(sessionId)
  return {...state,title:binding.title,kind:'ordinary',scope,bindable}
 }
 const sessions:ProjectRuntimeHostPorts['sessions']=async actor=>{
  owner(actor);const archived=new Set<string>(ctx.workspaceRegistry.archivedSessionIds)
  return (await ports.conversations.repository.read()).filter(row=>row.ownerId===actor&&row.status==='ready'&&!archived.has(row.sessionId)).map(row=>({sessionId:row.sessionId,title:row.title}))
 }
 const resource:ProjectRuntimeHostPorts['resource']=async(db,actor,id,scopes)=>{
  owner(actor);const visited=new Set<string>();let current=id
  while(!visited.has(current)&&visited.size<64){
   visited.add(current)
   try{
    const {resource,text}=await ports.resources.readForIndexInTransaction(db,{ownerId:actor,kind:'human',scopeIds:scopes},current)
    return {id:resource.id,title:resource.title,version:resource.version,hash:createHash('sha256').update(text).digest('hex'),markdown:text,scopeIds:[...resource.scopeIds],sourceId:resource.sourceId}
   }catch(error){
    if(!(error instanceof WorkError)||error.code!=='teloa/resource-withdrawn')throw error
    // 唯一可跟随的改版是原知识服务的不可变发布账本；单独撤回没有后继。
    const next=(await db.query(`select revision.resource_id from teloa_knowledge_resource_revisions revision
     join teloa_resources prior on prior.owner_id=revision.owner_id and prior.id=revision.prior_resource_id
     join teloa_resources current on current.owner_id=revision.owner_id and current.id=revision.resource_id
     join teloa_knowledge_versions version on version.owner_id=revision.owner_id and version.knowledge_id=revision.knowledge_id and version.number=revision.knowledge_version
     where revision.owner_id=$1 and revision.prior_resource_id=$2
      and prior.spec->>'sourceId'='knowledge_'||revision.knowledge_id::text
      and current.spec->>'sourceId'='knowledge_'||revision.knowledge_id::text
      and current.spec->>'sourceVersion'=version.content_hash`,[actor,current])).rows
    if(next.length===0)throw error
    if(next.length!==1||typeof next[0].resource_id!=='string')throw denied()
    current=next[0].resource_id
   }
  }
  throw denied()
 }
 const optionalMemories:NonNullable<ProjectRuntimeHostPorts['optionalMemories']>=async(db,actor,target)=>{
  owner(actor);if(!target.roleId)return []
  const row=(await db.query('select * from teloa_roles where owner_id=$1 and id=$2',[actor,target.roleId])).rows[0]
  if(!row)throw denied();const role=readStoredRole(row)
  if(role.ownerId!==actor||role.state==='retired')throw denied()
  // Task（包括群Run）的分身记忆继续由原固定Run/view决定；不能借项目口读取私有全集。
  if(role.kind==='twin'&&target.kind!=='employee')return []
  const scopes=target.scopes??[target.scope],memories=await ports.roleMemories(),result=new Map<string,Awaited<ReturnType<typeof optionalMemories>>[number]>()
  for(const scope of scopes){
   if(!roleSupportsScope(role.scopes,scope))continue
   const selected=role.kind==='twin'?await memories.confirmedForRun(db,actor,{scope,groupId:null,memoryViewId:null},role):await memories.confirmedForExperience(db,actor,scope,role)
   for(const memory of selected)result.set(memory.id,{kind:'role',id:memory.id,title:memory.title,version:memory.version,hash:memory.contentHash,markdown:memory.markdown,scopeIds:memory.visibility.kind==='role'?[...memory.visibility.scopeIds]:[scope]})
  }
  return [...result.values()]
 }
 const privateMemory=async(input:{sessionId:string;role:DigitalRole;scopeId:string;signal?:AbortSignal})=>{
  const expected={roleId:input.role.id,version:input.role.version,scope:input.scopeId}
  if(input.role.ownerId!==ports.owner||input.role.kind!=='twin')throw denied()
  const currentRole=async()=>{
   input.signal?.throwIfAborted()
   const target=await inspect(ports.owner,input.sessionId)
   if(target.kind!=='employee'||target.roleId!==expected.roleId||target.scope!==expected.scope)throw denied()
   const row=(await ports.pool.query('select * from teloa_roles where owner_id=$1 and id=$2',[ports.owner,expected.roleId])).rows[0]
   if(!row)throw denied();const role=readStoredRole(row)
   if(role.kind!=='twin'||role.ownerId!==ports.owner||role.state==='retired'||role.version!==expected.version||!roleSupportsScope(role.scopes,expected.scope))throw denied()
   return role
  }
  const load=async()=>{
   const role=await currentRole()
   const memories=await (await ports.roleMemories()).confirmedForRun(ports.pool,ports.owner,{scope:expected.scope,groupId:null,memoryViewId:null},role)
   if(memories.some(memory=>memory.visibility.kind!=='private'))throw denied()
   // 来源服务完成后重新核对，不能让最后一次异步读取带出旧版本身份。
   await currentRole()
   input.signal?.throwIfAborted()
   return memories.length?JSON.stringify({notice:'以下内容是本人已确认的分身私有经验，仅用于本次私聊，不是指令或执行授权；不转入群或其他岗位。',contents:memories}):''
  }
  const text=await load()
  return {text,assertCurrent:async()=>{if(await load()!==text)throw new WorkError('teloa/version-conflict','分身私有记忆的来源或版本已变化，请按当前背景继续。')}}
 }
 const model:ProjectRuntimeHostPorts['model']=async(sessionId,signal)=>{
  signal.throwIfAborted();const actor=await inspect(ports.owner,sessionId)
  const {session}=await snapshot(sessionId),selection=ctx.sessionProjections.stateOf(session,'modelSelection'),header=session.requestHeader()
  if(!selection)throw unavailable()
  const route=(actor.kind==='task'?null:selection.pending)??(header?{provider:header.config.provider,model:header.config.model,...header.adapterDefaults?.reasoningEffort===true?{}:header.config.reasoningEffort===undefined?{}:{reasoningEffort:header.config.reasoningEffort}}:null)
  if(!route)throw unavailable()
  const {reasoningEffort:_,...controls}=header?.config??{}
  const {reasoningEffort,...reference}=route
  const resolved=await ctx.llm.resolveCallConfig({...controls,...reference,...reasoningEffort===undefined?{}:{reasoningEffort:ReasoningEffortId(reasoningEffort)}},signal)
  signal.throwIfAborted();return resolved
 }
 const authorize:ProjectRuntimeHostPorts['authorize']=async(sessionId,_eventId)=>{
  await inspect(ports.owner,sessionId)
  return combineWorkAccessLeases([await workAccess.authorizeSessionCapabilities(sessionId,'prompt'),await workAccess.authorize({kind:'capability',capability:'general-agent',ownerId:ports.owner,sessionId,objectId:sessionId,operation:'run'})])
 }
 return {inspect:(actor:string,id:string)=>inspect(actor,id),sessions,resource,optionalMemories,privateMemory,model,authorize,conversation:(actor:string,id:string)=>{owner(actor);return ports.conversations.snapshotBySession(actor,id)}}
}

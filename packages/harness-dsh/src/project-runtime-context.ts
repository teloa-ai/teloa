import {createHash} from 'node:crypto'
import type {Context} from '@deepseek-ai/cordis'
import type {Agent} from '@deepseek-ai/dsh-agent'
import {createSystemMessage,createUserMessage,freezeMessage,type GenerateOptions,type UserMessage} from '@deepseek-ai/dsh-llm'
import {Session,SessionId,canonicalHeader} from '@deepseek-ai/dsh-session'
import {renderPrompt,renderContextSections,joinContextSections} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-token-meter'
import type {ToolRunContext} from '@deepseek-ai/dsh-tools'
import type {WorkAccessLease,ProjectRuntimePrepared as BackendProjectRuntimePrepared} from '@teloa/backend'
import {WorkError} from '@teloa/contract'
import {readSessionEvents} from './session-events.ts'
import {taskInputWithoutMemory} from './task-memory-input.ts'
import {roleMemoryProposalToolName} from './role-memory.ts'
import type {NativeInputRestoreInput} from './native-input-checkpoint.ts'

export type ProjectRuntimePrepared=BackendProjectRuntimePrepared
export type ProjectRuntimeContextPorts={
 owner:string
 readBinding?:(sessionId:string)=>Promise<ProjectRuntimePrepared['binding']|Pick<ProjectRuntimePrepared['binding'],'sessionId'|'projectId'|'memoryMode'>|null>
 prepare:(input:{sessionId:string;messageId:string;query:string;requestId?:string;parentSessionId?:string;parentMessageId?:string;signal?:AbortSignal})=>Promise<ProjectRuntimePrepared|null>
 assertCurrent:(input:{sessionId:string;projectId:string|null;bindingVersion:number;generation:number;contextVersion:number;settingsVersion:number;signal?:AbortSignal})=>Promise<void>
 assertPreparedCurrentSync:(prepared:ProjectRuntimePrepared)=>void
 recordUsed:(input:{manifestId:string;promptHash:string;generation:number;stage:'prepared'|'dispatched'|'failed';signal?:AbortSignal})=>Promise<void>
 ackGeneration?:(input:{sessionId:string;generation:number})=>Promise<void>
}
/** 仅宿主最终受理与私有因果链使用；不提供浏览器或模型授权入口。 */
export type ProjectRuntimeInputHooks={
 acquire:(agent:Agent,message:UserMessage,signal?:AbortSignal,parent?:Agent)=>Promise<WorkAccessLease|null>
 accepted:(agent:Agent,message:UserMessage,inherited?:boolean)=>void
 turnStart:(agent:Agent)=>void
 claim:(agent:Agent,message:UserMessage)=>void
 assertTool:(exec:ToolRunContext)=>Promise<void>
 restore?:(input:NativeInputRestoreInput)=>Promise<WorkAccessLease|null>
}
/** 仅在宿主内部使用：辅助模型调用需要"当前会话已准备上下文"这一准入证明。 */
export type ProjectRuntimeExposure={
 preparedForSession:(sessionId:string)=>ProjectRuntimePrepared|null
 assertPreparedCurrent:(prepared:ProjectRuntimePrepared)=>Promise<void>
 assertPreparedCurrentSync:(prepared:ProjectRuntimePrepared)=>void
 withAuxiliaryContext:(prepared:ProjectRuntimePrepared,options:Readonly<GenerateOptions>,dispatch:()=>AsyncIterable<import('@deepseek-ai/dsh-llm').StreamChunk>,onDispatched?:()=>void|Promise<void>)=>AsyncIterable<import('@deepseek-ai/dsh-llm').StreamChunk>
}
let projectRuntimeExposureValue:ProjectRuntimeExposure|undefined
/** 供宿主内部模块（如输入框建议）取用；不对外暴露任何授权入口。 */
export function projectRuntimeExposure():ProjectRuntimeExposure|undefined{return projectRuntimeExposureValue}
const markerName='teloa/project-context-generation'
const projectContextName='teloa/project-context'
const retainedOwnerInputNotice='Earlier owner input retained after a role update'
// 固定 DSH 的许可/委派上下文及本宿主的必要工作状态；新增 provider 必须先审核其无记忆语义。
const memoryOffContexts=new Set(['sandbox:policy','approval:policy','subagent:delegation','teloa:product-identity','teloa:work-behavior-runtime','teloa/role-identity','teloa/saved-draft-state'])
const denied=()=>new WorkError('teloa/conflict','项目上下文已更新，当前工作等待使用可用资料重新继续。')
const projectDefinitionTool='teloa_projects_change'
const definitionBoundaryName='teloa/project-definition-boundary'
const definitionBoundaryText="The project title and goal are the owner's project definition, not a memory store. Never write decisions, remembered facts or notes into the project goal or title, and never call project change tools to remember anything. Edit the definition only when the owner explicitly asks for that definition change in this turn; ordinary decisions are captured by project memory extraction."
const definitionWrite=()=>new WorkError('teloa/forbidden','项目定义（标题与目标）只由本人在项目页核对修改；项目会话中的长期记忆由自动提炼生成候选，不写入项目目标或标题。其他项目字段修改不受影响。')
const sha256=(text:string)=>createHash('sha256').update(text).digest('hex')
const definitionFields=(args:unknown):Record<string,unknown>|undefined=>{
 if(!args||typeof args!=='object'||Array.isArray(args))return undefined
 const fields=Reflect.get(args,'fields')
 return fields&&typeof fields==='object'&&!Array.isArray(fields)?fields as Record<string,unknown>:undefined
}
/**
 * 项目定义是本轮注入背景的事实正文，不是记忆载体：项目会话中拒绝模型借 teloa_projects_change 改写标题/目标。
 * 只比较本轮真实输入来源里的项目标题与目标摘要；状态、期限、关联等其余字段修改照常放行。
 */
export function assertProjectDefinitionWrite(prepared:ProjectRuntimePrepared,name:string,args:unknown):void{
 if(name!==projectDefinitionTool||!prepared.binding.projectId)return
 const fields=definitionFields(args)
 if(!fields)return
 const project=prepared.sources.find(source=>source.kind==='project'&&source.id===prepared.binding.projectId)
 if(!project)return
 const title=Reflect.get(fields,'title'),goal=Reflect.get(fields,'goal')
 if(typeof title==='string'&&title!==project.title)throw definitionWrite()
 if(typeof goal==='string'&&sha256(goal)!==project.hash)throw definitionWrite()
}
const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(Reflect.get(value,key))])):value
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
const promptHash=(options:Readonly<GenerateOptions>)=>hash({messages:options.messages,system:options.system??null,tools:options.tools??null,toolHistory:options.toolHistory??null,sessionId:options.sessionId??null})

function generationMarker(session:Session):string|undefined{
 for(const event of [...readSessionEvents(session)].reverse()){
  if(event.type!=='user/message'||event.data.source.kind!=='runtime-context'||event.data.source.form!=='snapshot')continue
  const marker=event.data.source.sections.find(section=>section.name===markerName)
  if(marker)return marker.text
 }
 return undefined
}

/** 只规划官方 surface 替换；容量与许可复核通过前不写原会话。 */
function projectSurfaceRebuild(session:Session,generation:number|string,retainUserInputFromGeneration?:number){
 const key=String(generation)
 const previous=generationMarker(session)
 if(previous===key)return
 let retainInput=false
 if(previous!==undefined&&retainUserInputFromGeneration!==undefined&&Number.isSafeInteger(retainUserInputFromGeneration)&&retainUserInputFromGeneration>0){
  try{
   const before:unknown=JSON.parse(previous),after:unknown=JSON.parse(key)
   retainInput=Array.isArray(before)&&Array.isArray(after)&&before.length===3&&after.length===3&&before[0]===session.id&&after[0]===session.id&&before[1]===after[1]&&Number.isSafeInteger(before[2])&&Number.isSafeInteger(after[2])&&before[2]>=retainUserInputFromGeneration&&before[2]<after[2]
  }catch{/* 旧或无法核对的代次标记沿完整重建处理。 */}
 }
 const nodes=[...session.surface.nodes],events=readSessionEvents(session),head=nodes[0]===undefined?undefined:events.find(event=>event.seq===nodes[0])
 // 系统头保留给官方 step/start 后的 SystemPromptProjection；装配阶段不能写 system/message。
 const shadowed=head?.type==='system/message'?nodes.slice(1):nodes
 // 新会话的首个 surface 节点必须由官方 system/message 保留；代次标记随本步上下文落盘。
 if(!shadowed.length)return
 const bySeq=new Map(events.map(event=>[event.seq,event])),groups:Array<typeof shadowed>=[],retained:UserMessage[]=[]
 const restoredNodes:Array<{seq:typeof nodes[number];message:UserMessage;sources:typeof nodes}>=[]
 // 固定 DSH 的 compact-checkpoint 是已提交压缩节点；其他replacement（尤其撤回重建）不可穿透。
 const recoverable=(event:typeof events[number])=>event.type==='user/message'&&event.surfaceOp!==undefined&&event.surfaceOp!=='append'&&(event.data.source.kind==='compact-checkpoint'||event.data.source.kind==='runtime-context'&&event.data.source.form==='notice'&&event.data.source.summary===retainedOwnerInputNotice)
 const recoveredOwners=(root:typeof nodes[number])=>{
  const owners=new Map<typeof root,UserMessage>(),visited=new Set<typeof root>(),pending=[root]
  while(pending.length){
   const seq=pending.pop()!
   if(visited.has(seq)||seq<session.inheritedEventCount)continue
   visited.add(seq)
   const event=bySeq.get(seq);if(!event||event.type!=='user/message')continue
   if(event.data.source.kind==='user'){
    const message=session.deriveEventMessage(event)
    if(message?.role==='user')owners.set(seq,message)
   }else if(recoverable(event))for(const source of event.sourceEventSeqs??[])pending.push(source)
  }
  return [...owners].sort(([a],[b])=>a-b)
 }
 let group:typeof shadowed=[]
 for(const seq of shadowed){
  const event=bySeq.get(seq)
  // 仅保留本会话当前仍可见的本人输入；不从append历史复活撤回资料、旧摘要或父会话输入。
  if(retainInput&&seq>=session.inheritedEventCount&&event?.type==='user/message'&&event.data.source.kind==='user'){
   const message=session.deriveEventMessage(event);if(message?.role==='user')retained.push(message)
   if(group.length)groups.push(group);group=[]
  }else if(retainInput&&event&&recoverable(event)){
   const owners=recoveredOwners(seq)
   if(!owners.length){group.push(seq);continue}
   if(group.length)groups.push(group);group=[]
   const content:UserMessage['content'][number][]=[{type:'text',text:'Earlier owner input, retained verbatim. Apply the current role instructions and source permissions.'}]
   for(const [,message] of owners)content.push({type:'text',text:'Prior owner message:'},...message.content)
   const restored=createUserMessage({source:{kind:'runtime-context',form:'notice',summary:retainedOwnerInputNotice},content})
   retained.push(restored);restoredNodes.push({seq,message:restored,sources:[seq,...owners.map(([source])=>source)]})
  }else group.push(seq)
 }
 if(group.length)groups.push(group)
 const replacements=groups.map(replaced=>{
  const message=createUserMessage({source:{kind:'runtime-context',form:'snapshot',sections:[{name:markerName,text:key}]},content:[{type:'text',text:retainInput?'Role context updated: use current authorized materials and the retained owner input. Earlier responses and tool results have been removed.':'Project context updated: use only currently available materials and explicit input from this turn.'}]})
  return {replaced,message}
 })
 const appended=!groups.length?createUserMessage({source:{kind:'runtime-context',form:'snapshot',sections:[{name:markerName,text:key}]},content:[{type:'text',text:'Role context updated; retained owner input remains available under current instructions.'}]}):undefined
 const apply=(pending=false)=>{
  for(const {seq,message,sources} of restoredNodes){
   const value=pending?createUserMessage({source:{kind:'runtime-context',form:'notice',summary:retainedOwnerInputNotice},content:[{type:'text',text:'Earlier owner input is awaiting restoration under the current model capacity. Earlier responses and tool results have been removed.'}]}):message
   session.append('user/message',value,{surfaceOp:{op:'replace',startSeq:seq,endSeq:seq},sourceEventSeqs:sources})
  }
  const marker=(message:UserMessage)=>pending?createUserMessage({source:{kind:'runtime-context',form:'snapshot',sections:[{name:markerName,text:previous!}]},content:[{type:'text',text:'Role context is being updated; earlier responses and tool results are no longer active.'}]}):message
  for(const {replaced,message} of replacements)session.append('user/message',marker(message),{surfaceOp:{op:'replace',startSeq:replaced[0]!,endSeq:replaced.at(-1)!},sourceEventSeqs:replaced})
  if(appended)session.append('user/message',marker(appended),{surfaceOp:'append'})
 }
 return {restored:restoredNodes.length>0,messages:[...retained,...replacements.map(row=>row.message),...appended?[appended]:[]],apply}
}
/** 官方 surface replacement 只更新模型视图；原 append 来源仍是人工历史真源。 */
export function rebuildProjectModelSurface(session:Session,generation:number|string,retainUserInputFromGeneration?:number):void{
 projectSurfaceRebuild(session,generation,retainUserInputFromGeneration)?.apply()
}

function currentInput(prepared:ProjectRuntimePrepared,signal?:AbortSignal){
 const binding=prepared.binding
 return {sessionId:binding.sessionId,projectId:binding.projectId,bindingVersion:binding.version,generation:binding.generation,contextVersion:binding.contextVersion,settingsVersion:binding.settingsVersion,...signal?{signal}: {}}
}
function currentProjectSnapshot(message:Readonly<GenerateOptions>['messages'][number],generation:string):boolean{
 return message.role==='user'&&message.source?.kind==='runtime-context'&&message.source.form==='snapshot'&&message.source.sections.some(section=>section.name===projectContextName)&&message.source.sections.some(section=>section.name===markerName&&section.text===generation)
}
function providerEnvelope(resolved:Readonly<GenerateOptions>,prepared:ProjectRuntimePrepared,currentSystem?:string):Readonly<GenerateOptions>{
 const generation=JSON.stringify([prepared.binding.sessionId,prepared.binding.projectId,prepared.binding.generation])
 const sourceMessages=resolved.messages.filter(message=>currentSystem===undefined||message.role!=='system')
 let currentContext=-1
 sourceMessages.forEach((message,index)=>{if(currentProjectSnapshot(message,generation))currentContext=index})
 const messages=sourceMessages.map((message,index)=>{
  if(message.role==='assistant'&&message.source.replayState!==undefined){
   const {replayState:_replay,...source}=message.source
   return freezeMessage({...message,source})
  }
  // 旧 TaskRun 的冻结memory不是项目召回真源；启用时也只由prepared.text携带本轮获准记忆。
  if(message.role==='user'){
   // 代次标记保留在原生快照元数据中供恢复核验，仅从模型正文移除，避免被当成资料来源。
   const sections=message.source?.kind==='runtime-context'&&message.source.form==='snapshot'?message.source.sections:undefined
   const marked=sections?.some(section=>section.name===markerName)
   const superseded=index!==currentContext&&currentProjectSnapshot(message,generation)
   const rendered=marked?joinContextSections(sections!):undefined
   const priorVisible=marked?joinContextSections(sections!.filter(section=>section.name!==markerName)):undefined
   // 只替换本会话同代次的旧受管段落；来源审计、本人原话、模型答复与工具读取均保持原样。
   const visible=marked?joinContextSections(sections!.filter(section=>section.name!==markerName&&(!superseded||section.name!==projectContextName)))||(superseded?'Previous automatically supplied project context is superseded by the current authorized snapshot.':''):undefined
   const content=message.content.map(block=>{
    if(block.type!=='text')return block
    let text=taskInputWithoutMemory(block.text)
    // 已移除代次正文的投影可再次进入固定闸口；两种合法表示使用同一段落替换，保持幂等。
    const prior=[rendered,priorVisible].find(value=>value&&(text===value||text.endsWith('\n\n'+value)))
    if(prior)text=text.slice(0,-prior.length)+visible
    return Object.freeze({...block,text})
   })
   Object.freeze(content);return Object.freeze({...message,content})
  }
  return message
 })
 if(currentSystem!==undefined){
  const system=resolved.messages.find(message=>message.role==='system')
  if(!system||system.id===undefined||system.source===undefined)throw denied()
  messages.unshift(freezeMessage({...system,content:currentSystem?[{type:'text',text:currentSystem}]:[]}))
 }
 Object.freeze(messages)
 const {toolHistory:_history,...retained}=resolved
 // 保留真实逻辑请求作为 admission proof；只有发往 provider 的 envelope 使用代次身份。
 return Object.freeze({...retained,messages,sessionId:SessionId(prepared.providerSessionId)})
}
export function projectRuntimeInputHooks(ctx:Context):ProjectRuntimeInputHooks|undefined{return ctx.get('teloaProjectRuntime' as never) as ProjectRuntimeInputHooks|undefined}

/** 项目上下文沿原 Session/Task/审批链执行；受理根、模型与工具门禁仍由 native-work-causality 维护。 */
export function registerProjectRuntimeContext(ctx:Context,ports:ProjectRuntimeContextPorts){
 let closed=false
 const candidates=new Map<string,{agent:Agent|undefined;prepared:ProjectRuntimePrepared|null}>()
 const acceptedPrepared=new Map<string,ProjectRuntimePrepared>()
 const preparedMessages=new WeakMap<ProjectRuntimePrepared,string>()
 const accepted=new WeakMap<UserMessage,ProjectRuntimePrepared|null>(),active=new WeakMap<Agent,ProjectRuntimePrepared[]>()
 const claimed=new WeakMap<Agent,UserMessage[]>()
 const pendingRestores=new WeakMap<Agent,(messages:readonly UserMessage[])=>Promise<void>>()
 const requests=new WeakMap<object,{prepared:ProjectRuntimePrepared;projected:Readonly<GenerateOptions>;promptHash:string;dispatched:boolean}>()
 const auxiliaryContexts=new WeakMap<object,{prepared:ProjectRuntimePrepared;onDispatched?:()=>void|Promise<void>;entered:boolean}>(),usedAuxiliary=new WeakSet<object>()
 const assembledSystems=new WeakMap<Agent,string>()
 const acknowledged=new WeakSet<ProjectRuntimePrepared>()
 const key=(agent:Agent,message:UserMessage)=>JSON.stringify([agent.id,message.id])
 const sync=(prepared:ProjectRuntimePrepared)=>{if(closed)throw denied();ports.assertPreparedCurrentSync(prepared)}
 const assertUnbound=async(sessionId:string)=>{if(closed||!ports.readBinding)throw denied();const binding=await ports.readBinding(sessionId);if(binding&&binding.sessionId!==sessionId)throw denied();return binding===null}
 const check=async(prepared:ProjectRuntimePrepared,signal?:AbortSignal)=>{signal?.throwIfAborted();sync(prepared);await ports.assertCurrent(currentInput(prepared,signal));signal?.throwIfAborted();sync(prepared)}
 const selected=(agent:Agent):ProjectRuntimePrepared|null=>{
  const rows=active.get(agent)??[...agent.inbox.nextTurn,...agent.inbox.nextStep].map(message=>accepted.get(message)).filter((value):value is ProjectRuntimePrepared=>value!==null&&value!==undefined)
  if(!rows.length)return null
  const first=rows[0]!
  if(rows.some(row=>row.binding.generation!==first.binding.generation||row.providerSessionId!==first.providerSessionId||row.binding.projectId!==first.binding.projectId))throw denied()
  rows.forEach(sync);return first
 }
 const hooks:ProjectRuntimeInputHooks={
  async acquire(agent,message,signal,parent){
   if(closed)throw denied()
   const rpc=Reflect.get(message.source,'rpcId')
   const parentPrepared=parent?selected(parent):null,parentMessageId=parentPrepared?preparedMessages.get(parentPrepared):undefined
   if(parentPrepared&&!parentMessageId)throw denied()
   const prepared=await ports.prepare({sessionId:agent.id,messageId:message.id,query:message.content.filter(block=>block.type==='text').map(block=>block.text).join('\n'),...(typeof rpc==='string'?{requestId:rpc}:{}),...(parent?{parentSessionId:parent.id}:{}),...parentMessageId?{parentMessageId}:{},...signal?{signal}: {}})
   signal?.throwIfAborted()
   if(prepared){
    if(prepared.binding.sessionId!==agent.id||!prepared.providerSessionId||!prepared.manifestId||!Number.isSafeInteger(prepared.binding.generation)||prepared.binding.generation<0||!['enabled','off'].includes(prepared.binding.memoryMode))throw denied()
    await check(prepared,signal)
   }
   const identity=key(agent,message);candidates.set(identity,{agent,prepared})
   if(!prepared)return null
   return Object.freeze({assertCurrent(){signal?.throwIfAborted();sync(prepared)},assertContinuationCurrent(){sync(prepared)},releaseUnaccepted(){candidates.delete(identity)}})
  },
  accepted(agent,message,inherited=false){
   const identity=key(agent,message),candidate=candidates.get(identity)
   if(inherited){accepted.set(message,selected(agent));return}
   if(!candidate||candidate.agent!==undefined&&candidate.agent!==agent)throw denied()
   if(candidate.prepared)sync(candidate.prepared)
   if(candidate.prepared){acceptedPrepared.set(identity,candidate.prepared);preparedMessages.set(candidate.prepared,message.id)}
   while(acceptedPrepared.size>256)acceptedPrepared.delete(acceptedPrepared.keys().next().value!)
   accepted.set(message,candidate.prepared);candidates.delete(identity)
  },
  turnStart(agent){active.delete(agent);claimed.delete(agent);pendingRestores.delete(agent)},
  claim(agent,message){
   if(!accepted.has(message))throw denied()
   const prepared=accepted.get(message)
   if(!prepared)return
   claimed.set(agent,[...claimed.get(agent)??[],message])
   sync(prepared);const rows=active.get(agent)??[];rows.push(prepared);active.set(agent,rows);selected(agent)
  },
  async assertTool(exec){if(!exec.agent)return;const prepared=selected(exec.agent);if(prepared){await check(prepared,exec.signal);if(prepared.binding.memoryMode==='off'&&exec.name===roleMemoryProposalToolName)throw new WorkError('teloa/forbidden','此会话已关闭长期记忆，不能提交员工记忆候选。');assertProjectDefinitionWrite(prepared,exec.name,exec.arguments)}},
  async restore(input){
   const rows:ProjectRuntimePrepared[]=[]
   for(const message of input.messages){
    const rpc=Reflect.get(message.source,'rpcId')
    const prepared=await ports.prepare({sessionId:input.sessionId,messageId:message.id,query:message.content.filter(block=>block.type==='text').map(block=>block.text).join('\n'),...(typeof rpc==='string'?{requestId:rpc}:{}),signal:input.signal})
    if(prepared){await check(prepared,input.signal);rows.push(prepared)}
    candidates.set(JSON.stringify([input.sessionId,message.id]),{agent:undefined,prepared})
   }
   if(!rows.length)return null
   return Object.freeze({assertCurrent(){input.signal.throwIfAborted();rows.forEach(sync)}})
  },
 }
 if(projectRuntimeInputHooks(ctx))throw denied()
 ctx.provide('teloaProjectRuntime' as never,hooks as never)
 const releaseContext=ctx.on('system-prompt/assemble',async(_assembly,context,next)=>{
  const result=await next(),agent=context.agent
  if(!agent)return result
  const prepared=selected(agent)
  if(!prepared){if(generationMarker(agent.session)!==undefined)throw denied();return result}
  await check(prepared,context.signal)
  assembledSystems.set(agent,renderPrompt(result))
  const generation=JSON.stringify([prepared.binding.sessionId,prepared.binding.projectId,prepared.binding.generation])
  if(result.contexts.some(row=>row.name==='teloa/project-context')||Object.hasOwn(result.variables,'teloa_project_context'))throw denied()
  // 本轮显式@员工的来源与指定知识不是长期记忆；保留来源，下一轮才能完整撤回旧身份。
  let selectedEmployee=false
  try{const value=JSON.parse(String(result.variables.teloa_employee_mention??''));selectedEmployee=value?.schema==='teloa.employee-mention/v1'&&value.boundTo==='current-owner-message'}catch{/* 没有可信宿主来源时仍用原memory-off白名单。 */}
  const contexts=prepared.binding.memoryMode==='off'?result.contexts.filter(row=>memoryOffContexts.has(row.name)||selectedEmployee&&(row.name==='teloa/employee-mention'||row.name==='teloa/role-knowledge')):result.contexts
  if(contexts.some(row=>row.name===markerName)||contexts.some(row=>row.name===definitionBoundaryName)||Object.hasOwn(result.variables,'teloa_project_generation'))throw denied()
  const assembled:typeof result={...result,contexts:[...contexts,{name:'teloa/project-context',text:'{{teloa_project_context}}'},{name:definitionBoundaryName,text:definitionBoundaryText},{name:markerName,text:'{{teloa_project_generation}}'}],variables:{...result.variables,teloa_project_context:prepared.text,teloa_project_generation:generation}}
  const validateRestored=async(messages:readonly UserMessage[],nextMessages?:readonly UserMessage[])=>{
   const recover='请在当前会话选择上下文窗口更大的模型后重新发送当前请求，或新建对话并附上本轮所需材料。原始消息和压缩记录已保留。'
   const unavailable=()=>new WorkError('teloa/invalid-input','暂不能核对岗位更新后恢复历史所需的模型容量。'+recover,{reason:'employee-history-capacity-unavailable'})
   const meter=agent.ctx.get('tokenMeter'),provider=assembled.variables.provider??agent.options.provider,model=assembled.variables.model??agent.options.model
   if(!meter||!provider||!model)throw unavailable()
   const info=await agent.ctx.llm.resolveModelInfo(provider,model,context.signal),capacity=info.context?.contextWindow
   if(capacity===undefined||!Number.isSafeInteger(capacity)||capacity<=0)throw unavailable()
   // 仅作官方 token-meter 的脱离注册表预验；不创建持久会话、不读额外来源或发送模型请求。
   const preview=Session.create(agent.id)
   preview.append('system/message',{turn:1,step:1,message:createSystemMessage(renderPrompt(assembled))},{surfaceOp:'append'})
   for(const message of messages)preview.append('user/message',message,{surfaceOp:'append'})
   if(nextMessages){for(const message of nextMessages)preview.append('user/message',message,{surfaceOp:'append'})}
   else{
    const written=new Set(readSessionEvents(agent.session).flatMap(event=>event.type==='user/message'?[event.data.id]:[]))
    for(const message of claimed.get(agent)??[])if(!written.has(message.id))preview.append('user/message',message,{surfaceOp:'append'})
    preview.append('user/message',createUserMessage({source:{kind:'runtime-context',form:'notice',summary:'Current authorized context'},content:[{type:'text',text:joinContextSections(renderContextSections(assembled))}]}),{surfaceOp:'append'})
   }
   const inputTokens=meter.measure(preview,canonicalHeader({config:{provider,model},tools:assembled.tools})).totalTokens
   // 与官方 requestProposal 一致：已落盘的显式上限继续生效；adapter 默认值才随新模型重取。
   const header=agent.session.requestHeader(),explicitOutput=header?header.adapterDefaults?.maxTokens===true?undefined:header.config.maxTokens:agent.options.maxTokens
   const outputTokens=explicitOutput??info.defaultMaxTokens??0
   if(inputTokens+outputTokens>capacity)throw new WorkError('teloa/invalid-input','岗位更新后需要恢复的本人历史超过当前模型的上下文窗口。'+recover,{reason:'employee-history-context-limit'})
   await check(prepared,context.signal)
  }
  const rebuild=async(defer:boolean,nextMessages?:readonly UserMessage[])=>{
   const plan=projectSurfaceRebuild(agent.session,generation,prepared.retainUserInputFromGeneration)
   if(!plan)return
   if(plan.restored)await validateRestored(plan.messages,nextMessages)
   context.signal?.throwIfAborted();sync(prepared)
   // 原生压力压缩仍按上一 request/header 选模。先清理旧混合内容，仅留可恢复seq，
   // 待 pre-step 结束后再展开到已预验的新模型窗口，避免旧小模型先吃到展开后的长输入。
   if(defer&&plan.restored){plan.apply(true);pendingRestores.set(agent,messages=>rebuild(false,messages))}
   else plan.apply()
  }
  await rebuild(true)
  return assembled
 },{prepend:true})
 const releaseRestore=ctx.on('agent/pre-step',async({agent,signal},next)=>{
  const decision=await next(),restore=pendingRestores.get(agent);pendingRestores.delete(agent)
  signal.throwIfAborted()
  if(decision.kind!=='reject'&&restore)await restore(decision.messages)
  return decision
 },{prepend:true})
 const projection=Reflect.get(Object.getPrototypeOf(ctx.llm) as object,'installStreamProjection') as unknown
 if(typeof projection!=='function')throw new WorkError('teloa/unavailable','项目输入隔离能力尚未就绪，当前工作等待恢复。')
 Reflect.apply(projection,ctx.llm,[(original:Readonly<GenerateOptions>,resolved:Readonly<GenerateOptions>)=>{
  const state=requests.get(original)
  if(!state)return resolved
  sync(state.prepared)
  const agent=original.sessionId?ctx.agents.get(original.sessionId):undefined
  const projected=providerEnvelope(resolved,state.prepared,auxiliaryContexts.has(original)?undefined:agent?assembledSystems.get(agent):undefined)
  if(promptHash(projected)!==state.promptHash)throw denied()
  state.projected=projected;return projected
 },async(original:Readonly<GenerateOptions>,projected:Readonly<GenerateOptions>,admitted:Readonly<GenerateOptions>)=>{
  const state=requests.get(original);if(!state)return
  sync(state.prepared)
  if(promptHash(admitted)!==state.promptHash)throw denied()
  const auxiliary=auxiliaryContexts.get(original)
  if(auxiliary){
   if(auxiliary.entered)throw denied()
   await check(state.prepared,original.signal)
   auxiliary.entered=true
   await auxiliary.onDispatched?.()
   original.signal?.throwIfAborted();sync(state.prepared)
  }
  if(!auxiliaryContexts.has(original)&&!acknowledged.has(state.prepared)&&ports.ackGeneration){
   await ports.ackGeneration({sessionId:state.prepared.binding.sessionId,generation:state.prepared.binding.generation});acknowledged.add(state.prepared)
  }
  await check(state.prepared,original.signal)
 },async(original:Readonly<GenerateOptions>,projected:Readonly<GenerateOptions>)=>{
  const state=requests.get(original);if(!state)return
  // 首次 iterator.next 已尝试进入 adapter；此后的取消或零 delta 失败不能撤销使用事实。
  state.dispatched=true
  await ports.recordUsed({manifestId:state.prepared.manifestId,promptHash:promptHash(projected),generation:state.prepared.binding.generation,stage:'dispatched'})
 }])
 // 不另装私有 admission；本监听器在既有 causality 包装内等待真源复核。
 const releaseStream=ctx.on('llm/stream',async function*(original,next){
  const agent=original.sessionId?ctx.agents.get(original.sessionId):undefined,prepared=auxiliaryContexts.get(original)?.prepared??(agent?selected(agent):null)
  if(!prepared){if(original.sessionId&&!await assertUnbound(original.sessionId))throw denied();yield* next();return}
  await check(prepared,original.signal)
  const projected=providerEnvelope(original,prepared,auxiliaryContexts.has(original)?undefined:agent?assembledSystems.get(agent):undefined),hashOfPrompt=promptHash(projected)
  const state={prepared,projected,promptHash:hashOfPrompt,dispatched:false};requests.set(original,state)
  await ports.recordUsed({manifestId:prepared.manifestId,promptHash:hashOfPrompt,generation:prepared.binding.generation,stage:'prepared',...original.signal?{signal:original.signal}: {}})
  try{for await(const chunk of next()){original.signal?.throwIfAborted();sync(prepared);if(chunk.type==='finish')await check(prepared,original.signal);yield chunk}await check(prepared,original.signal)}
  catch(error){if(!state.dispatched)await ports.recordUsed({manifestId:prepared.manifestId,promptHash:hashOfPrompt,generation:prepared.binding.generation,stage:'failed'}).catch(()=>{});throw error}
  finally{requests.delete(original)}
 },{global:true})
 const runtime=Object.freeze({
  hooks,
  /** 当前会话仍有效的已准备上下文（回合结束后、下一轮开始前可用）。 */
  preparedForSession(sessionId:string):ProjectRuntimePrepared|null{const agent=ctx.agents.get(SessionId(sessionId));return agent?selected(agent):null},
  preparedForMessage(sessionId:string,messageId:string):ProjectRuntimePrepared|null{const value=acceptedPrepared.get(JSON.stringify([sessionId,messageId]));if(!value)return null;sync(value);return value},
  assertPreparedCurrent:check,
  async *withAuxiliaryContext(prepared:ProjectRuntimePrepared,options:Readonly<GenerateOptions>,dispatch:()=>AsyncIterable<import('@deepseek-ai/dsh-llm').StreamChunk>,onDispatched?:()=>void|Promise<void>){
   if(closed||options.sessionId!==prepared.binding.sessionId||!Object.isFrozen(options)||usedAuxiliary.has(options)||auxiliaryContexts.has(options)||options.tools!==undefined||options.toolHistory!==undefined)throw denied()
   usedAuxiliary.add(options);await check(prepared,options.signal);auxiliaryContexts.set(options,{prepared,entered:false,...onDispatched?{onDispatched}:{}})
   try{yield* dispatch();await check(prepared,options.signal)}finally{auxiliaryContexts.delete(options)}
  },
  async memoryEnabled(sessionId:string):Promise<boolean>{const agent=ctx.agents.get(SessionId(sessionId)),prepared=agent?selected(agent):null;if(!prepared)return assertUnbound(sessionId);await check(prepared);return prepared.binding.memoryMode!=='off'},
  async legacyRoleExperienceEnabled(sessionId:string):Promise<boolean>{const agent=ctx.agents.get(SessionId(sessionId)),prepared=agent?selected(agent):null;if(!prepared)return assertUnbound(sessionId);await check(prepared);return false},
  async assertResultCurrent(sessionId:string):Promise<void>{const agent=ctx.agents.get(SessionId(sessionId)),prepared=agent?selected(agent):null;if(prepared)await check(prepared);else if(!await assertUnbound(sessionId))throw denied()},
  close(){closed=true;candidates.clear();acceptedPrepared.clear();releaseContext();releaseRestore();releaseStream()},
 })
 projectRuntimeExposureValue={preparedForSession:sessionId=>{const agent=ctx.agents.get(SessionId(sessionId));return agent?selected(agent):null},assertPreparedCurrent:check,assertPreparedCurrentSync:sync,withAuxiliaryContext:runtime.withAuxiliaryContext}
 return runtime
}

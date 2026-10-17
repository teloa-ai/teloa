import {createHash} from 'node:crypto'
import type {Context} from '@deepseek-ai/cordis'
import type {Agent} from '@deepseek-ai/dsh-agent'
import {createUserMessage,freezeMessage,type GenerateOptions,type UserMessage} from '@deepseek-ai/dsh-llm'
import type {Session} from '@deepseek-ai/dsh-session'
import {SessionId} from '@deepseek-ai/dsh-session'
import {renderPrompt} from '@deepseek-ai/dsh-system-prompt'
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
const markerName='teloa/project-context-generation'
// 固定 DSH 的许可/委派上下文及本宿主的必要工作状态；新增 provider 必须先审核其无记忆语义。
const memoryOffContexts=new Set(['sandbox:policy','approval:policy','subagent:delegation','teloa:work-behavior-runtime','teloa/role-identity','teloa/saved-draft-state'])
const denied=()=>new WorkError('teloa/conflict','项目上下文已更新，当前工作等待使用可用资料重新继续。')
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

/** 官方 surface replacement 只更新模型视图；原 append 来源仍是人工历史真源。 */
export function rebuildProjectModelSurface(session:Session,generation:number|string):void{
 const key=String(generation)
 if(generationMarker(session)===key)return
 const nodes=[...session.surface.nodes],events=readSessionEvents(session),head=nodes[0]===undefined?undefined:events.find(event=>event.seq===nodes[0])
 // 系统头保留给官方 step/start 后的 SystemPromptProjection；装配阶段不能写 system/message。
 const shadowed=head?.type==='system/message'?nodes.slice(1):nodes
 // 新会话的首个 surface 节点必须由官方 system/message 保留；代次标记随本步上下文落盘。
 if(!shadowed.length)return
 const message=createUserMessage({source:{kind:'runtime-context',form:'snapshot',sections:[{name:markerName,text:key}]},content:[{type:'text',text:'项目上下文已更新；后续仅采用当前可用资料与本轮明确输入。'}]})
 session.append('user/message',message,{surfaceOp:{op:'replace',startSeq:shadowed[0]!,endSeq:shadowed.at(-1)!},sourceEventSeqs:shadowed})
}

function currentInput(prepared:ProjectRuntimePrepared,signal?:AbortSignal){
 const binding=prepared.binding
 return {sessionId:binding.sessionId,projectId:binding.projectId,bindingVersion:binding.version,generation:binding.generation,contextVersion:binding.contextVersion,settingsVersion:binding.settingsVersion,...signal?{signal}: {}}
}
function providerEnvelope(resolved:Readonly<GenerateOptions>,prepared:ProjectRuntimePrepared,currentSystem?:string):Readonly<GenerateOptions>{
 const messages=resolved.messages.filter(message=>currentSystem===undefined||message.role!=='system').map(message=>{
  if(message.role==='assistant'&&message.source.replayState!==undefined){
   const {replayState:_replay,...source}=message.source
   return freezeMessage({...message,source})
  }
  // 旧 TaskRun 的冻结memory不是项目召回真源；启用时也只由prepared.text携带本轮获准记忆。
  if(message.role==='user'){
   const content=message.content.map(block=>block.type==='text'?Object.freeze({...block,text:taskInputWithoutMemory(block.text)}):block)
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
  turnStart(agent){active.delete(agent)},
  claim(agent,message){
   if(!accepted.has(message))throw denied()
   const prepared=accepted.get(message)
   if(!prepared)return
   sync(prepared);const rows=active.get(agent)??[];rows.push(prepared);active.set(agent,rows);selected(agent)
  },
  async assertTool(exec){if(!exec.agent)return;const prepared=selected(exec.agent);if(prepared){await check(prepared,exec.signal);if(prepared.binding.memoryMode==='off'&&exec.name===roleMemoryProposalToolName)throw new WorkError('teloa/forbidden','此会话已关闭长期记忆，不能提交员工记忆候选。')}},
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
  rebuildProjectModelSurface(agent.session,generation)
  if(result.contexts.some(row=>row.name==='teloa/project-context')||Object.hasOwn(result.variables,'teloa_project_context'))throw denied()
  const contexts=prepared.binding.memoryMode==='off'?result.contexts.filter(row=>memoryOffContexts.has(row.name)):result.contexts
  if(contexts.some(row=>row.name===markerName)||Object.hasOwn(result.variables,'teloa_project_generation'))throw denied()
  return {...result,contexts:[...contexts,{name:'teloa/project-context',text:'{{teloa_project_context}}'},{name:markerName,text:'{{teloa_project_generation}}'}],variables:{...result.variables,teloa_project_context:prepared.text,teloa_project_generation:generation}}
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
  await ports.recordUsed({manifestId:state.prepared.manifestId,promptHash:promptHash(projected),generation:state.prepared.binding.generation,stage:'dispatched',...original.signal?{signal:original.signal}: {}})
  if(!auxiliaryContexts.has(original)&&!acknowledged.has(state.prepared)&&ports.ackGeneration){
   await ports.ackGeneration({sessionId:state.prepared.binding.sessionId,generation:state.prepared.binding.generation});acknowledged.add(state.prepared)
  }
  await check(state.prepared,original.signal);state.dispatched=true
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
 return Object.freeze({
  hooks,
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
  close(){closed=true;candidates.clear();acceptedPrepared.clear();releaseContext();releaseStream()},
 })
}

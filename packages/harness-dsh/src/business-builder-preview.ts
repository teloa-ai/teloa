import {createHash} from 'node:crypto'
import type {Context} from '@deepseek-ai/cordis'
import type {Agent} from '@deepseek-ai/dsh-agent'
import {SessionId,appendPluginRecord,pluginRecordOf} from '@deepseek-ai/dsh-session'
import {createUserMessage,type ContextFormed} from '@deepseek-ai/dsh-llm'
import {WorkError,taskInput,readBusinessBuilderRequest,readBusinessBuilderGenerationState,readBusinessConfigurationPatchVersioned,businessConfigurationLimits,type BusinessBuilderGenerationMode} from '@teloa/contract'
import {authorizeOrdinaryConversationMutation} from './conversation-mutation.ts'
import {readConversationInstructionIdentity} from './conversation-instruction-identity.ts'
import {readSessionEvents} from './session-events.ts'
import {businessBuilderGenerationSchema,businessBuilderMutationReceipt,type BusinessBuilderToolsPorts} from './business-builder-tools.ts'

const recordType='plugin:teloa/business-builder-preview' as const
const source='plugin:teloa.business-builder-preview' as const
type Intent={kind:'mode';owner:string;sessionId:string;draftId:string;requestId:string;revision:number;mode:BusinessBuilderGenerationMode}
type Prepared={kind:'prepared';owner:string;sessionId:string;draftId:string;messageId:string;turn:number;step:number;revision:number;draftHash:string;fingerprint:string;requestId:string;modeRequestId:string}
type Settlement={kind:'settled';owner:string;sessionId:string;draftId:string;requestId:string;state:'saved'|'unknown'|'failed';revision:number;hash?:string;code?:string}
type Record=Intent|Prepared|Settlement
declare module '@deepseek-ai/dsh-session'{interface PluginRecordMap{'plugin:teloa/business-builder-preview':Record}}
declare module '@deepseek-ai/dsh-llm'{interface MessageSourceMap{'plugin:teloa.business-builder-preview':{kind:typeof source}&ContextFormed}}
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
const denied=()=>new WorkError('teloa/forbidden','当前本人、会话或预览草案身份已变化，请恢复原草案。')
const invalid=()=>new WorkError('teloa/invalid-input','这次预览未返回有效的业务草案；原草案已保留，可修改说明后重新生成。')
function requestId(value:unknown){const h=hash(value);return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`}
function records(agent:Agent):Record[]{
 return readSessionEvents(agent.session).flatMap(event=>{
  const record=pluginRecordOf(event);if(record?.type!==recordType||event.seq<agent.session.inheritedEventCount)return []
  const value=record.data as Partial<Record>|null
  if(!value||!['mode','prepared','settled'].includes(value.kind??'')||value.sessionId!==agent.id||typeof value.owner!=='string'||typeof value.draftId!=='string'||typeof value.requestId!=='string')throw new WorkError('teloa/storage-corrupt','原预览请求记录损坏，已停止生成。')
  const checked=taskInput(value,value.kind==='mode'?['kind','owner','sessionId','draftId','requestId','revision','mode']:value.kind==='prepared'?['kind','owner','sessionId','draftId','requestId','messageId','turn','step','revision','draftHash','fingerprint','modeRequestId']:['kind','owner','sessionId','draftId','requestId','state','revision','hash','code'])
  if(!Number.isSafeInteger(checked.revision)||Number(checked.revision)<1||checked.kind==='mode'&&checked.mode!=='preview'&&checked.mode!=='assisted'||checked.kind==='prepared'&&(['turn','step'].some(key=>!Number.isSafeInteger(checked[key])||Number(checked[key])<1)||['messageId','modeRequestId'].some(key=>typeof checked[key]!=='string'||!checked[key])||['draftHash','fingerprint'].some(key=>typeof checked[key]!=='string'||!/^[a-f0-9]{64}$/.test(checked[key] as string)))||checked.kind==='settled'&&!['saved','unknown','failed'].includes(String(checked.state)))throw new WorkError('teloa/storage-corrupt','原预览请求记录损坏，已停止生成。')
  return [checked as Record]
 })
}
const policy='这是本人选择的业务草案预览生成。只根据本次本人原文和宿主给出的同一草案/当前能力生成一个完整 JSON patch 对象。不要调用任何工具，不申请审批，不读取代码、员工、连接或外部数据，不采用或创建正式业务。不返回 owner、draftId、sessionId 或 expectedRevision 包装；直接返回 patchProtocol 对应的 patch。保留已有范围、来源和未修改配置；遵守正式字段/数值/引用/容量规则，不把字符串当数字或布尔。无法形成合法修改时如实失败，不能伪称保存。此 JSON 仅交给产品校验并保存可恢复预览，采用仍由本人另行确认。'

/** 原生模型轮次的宿主分支；这里只拥有预览草案与会话记录，不持有正式写入端口。 */
export function registerBusinessBuilderPreview(ctx:Context,ports:BusinessBuilderToolsPorts){
 const active=new WeakMap<Agent,Prepared>()
 const authorize=async(agent:Agent,signal:AbortSignal)=>{
  await authorizeOrdinaryConversationMutation({...ports,agent,signal},'业务草案预览')
  if(await ports.isRoleConversation(agent.id)||await ports.isTaskConversation(agent.id))throw denied()
  const binding=await ports.binding(agent.id)
  if(!binding||binding.kind!=='builder'||binding.sessionId!==agent.id||!binding.draftId)throw denied()
  const draft=await ports.draft(binding.draftId)
  if(draft.ownerId!==ports.owner||draft.id!==binding.draftId||draft.scope!==draft.candidate.scope||binding.scope!==undefined&&binding.scope!==draft.scope)throw denied()
  signal.throwIfAborted()
  return {binding,draft,fingerprint:hash([ports.owner,binding,draft.id,draft.scope,draft.baseVersion,draft.candidate.format,draft.candidate.sources])}
 }
 const intent=(agent:Agent,draftId?:string)=>{
  const value=records(agent).filter((r):r is Intent=>r.kind==='mode').at(-1)
  if(value&&(value.owner!==ports.owner||draftId!==undefined&&value.draftId!==draftId))throw denied()
  return value
 }
 const isPreviewOnly=async(sessionId:string)=>{
  const agent=ctx.agents.get(SessionId(sessionId));return !!agent&&intent(agent)?.mode==='preview'
 }
 const mode=async(payload:unknown,signal=AbortSignal.timeout(15000))=>{
  const input=readBusinessBuilderRequest('business-configuration/generation-mode',payload)
  const resolved=await ctx.sessionController.resolveAgent(SessionId(String(input.sessionId)))
  if('error'in resolved)throw denied()
  const agent=resolved.agent;if(agent.id!==input.sessionId)throw denied()
  const current=await authorize(agent,signal)
  if(current.draft.id!==input.draftId)throw denied()
  if(input.action==='set'){
   if(agent.status!=='idle'||current.draft.status!=='draft')throw new WorkError('teloa/conflict','请等待当前对话结束，再切换草案生成方式。')
   const prior=records(agent).find(r=>r.kind==='mode'&&r.requestId===input.requestId)
   if(prior){if(prior.kind!=='mode'||prior.owner!==ports.owner||prior.draftId!==input.draftId||prior.revision!==input.expectedRevision||prior.mode!==input.mode)throw new WorkError('teloa/conflict','同一预览方式请求不能改变原目标或正文。')}
   else{
    if(current.draft.revision!==input.expectedRevision)throw new WorkError('teloa/version-conflict','草案已更新，请刷新后切换生成方式。')
    appendPluginRecord(agent.session,recordType,{kind:'mode',owner:ports.owner,sessionId:agent.id,draftId:current.draft.id,requestId:String(input.requestId),revision:current.draft.revision,mode:input.mode as BusinessBuilderGenerationMode})
   }
   active.delete(agent)
  }
  return readBusinessBuilderGenerationState({sessionId:agent.id,draftId:current.draft.id,revision:current.draft.revision,mode:intent(agent,current.draft.id)?.mode??'assisted'})
 }
 const offStep=ctx.on('agent/pre-step',async({agent,signal,turn,step},next)=>{
  const decision=await next();if(decision.kind==='reject'||intent(agent)?.mode!=='preview'){active.delete(agent);return decision}
  const current=await authorize(agent,signal),selected=intent(agent,current.draft.id)!
  if(current.draft.status!=='draft')throw denied()
  const messages=decision.messages.filter(message=>message.source.kind==='user')
  if(messages.length!==1||messages[0]!.content.some(part=>part.type!=='text')||Reflect.get(messages[0]!.source,'principal')!==undefined)throw denied()
  const message=messages[0]!,schema=businessBuilderGenerationSchema(current.draft,'preview'),text=JSON.stringify(schema)
  if(Buffer.byteLength(text,'utf8')>businessConfigurationLimits.canonicalBytes)throw invalid()
  const prepared:Prepared={kind:'prepared',owner:ports.owner,sessionId:agent.id,draftId:current.draft.id,messageId:message.id,turn,step,revision:current.draft.revision,draftHash:current.draft.hash,fingerprint:current.fingerprint,modeRequestId:selected.requestId,requestId:requestId(['business-builder-host-preview/v1',ports.owner,agent.id,message.id,current.draft.id,current.draft.revision])}
  const prior=records(agent).find(r=>r.kind==='prepared'&&r.messageId===message.id)
  if(prior&&JSON.stringify(prior)!==JSON.stringify(prepared))throw new WorkError('teloa/conflict','原预览请求版本已固定，请先回读草案，不要重发。')
  if(!prior)appendPluginRecord(agent.session,recordType,prepared)
  active.set(agent,prepared)
  const notice=createUserMessage({source:{kind:source,form:'notice',summary:'当前业务预览草案与能力'},content:[{type:'text',text}]})
  // startsRequestSeries 只重开请求头，不能清空旧消息。用官方 surface replacement 隔离本轮模型窗口；原 append 历史与原答案完整保留。
  const nodes=[...agent.session.surface.nodes],events=readSessionEvents(agent.session),first=events.find(event=>event.seq===nodes[0]),shadowed=first?.type==='system/message'?nodes.slice(1):nodes
  if(shadowed.length)agent.session.append('user/message',notice,{surfaceOp:{op:'replace',startSeq:shadowed[0]!,endSeq:shadowed.at(-1)!},sourceEventSeqs:shadowed})
  return {...decision,startsRequestSeries:true as const,messages:shadowed.length?[message]:[message,notice]}
 })
 const offAssembly=ctx.on('system-prompt/assemble',async(_assembly,context,next)=>{
  const assembly=await next(),agent=context.agent
  // rc.2 的真实 loop 先 assemble、后 pre-step；不能用尚未创建的轮次 WeakMap 决定工具目录。
  if(!agent||intent(agent)?.mode!=='preview')return assembly
  await authorize(agent,context.signal??AbortSignal.timeout(15000))
  // 原生组装结果仍进入原因果/模型准入链；没有新 HTTP 模型客户端或工具执行器。
  return {...assembly,tools:[],sections:[{name:'teloa:business-preview',text:policy,interpolate:false}],contexts:[]}
 },{prepend:true})
 const offTools=ctx.on('tools/pre-execute',async(exec,next)=>exec.agent&&active.has(exec.agent)?{kind:'deny' as const,reason:'这次本人请求只生成草案预览，不执行工具。'}:next(),{prepend:true})
 const offStop=ctx.on('agent/turn-stopping',async({agent,signal})=>{
  const prepared=active.get(agent);if(!prepared)return
  let saving=false
  try{
   const current=await authorize(agent,signal),identity=readConversationInstructionIdentity(agent)
   if(identity.messageId!==prepared.messageId||current.fingerprint!==prepared.fingerprint||intent(agent,current.draft.id)?.requestId!==prepared.modeRequestId)throw denied()
   const events=readSessionEvents(agent.session),message=events.filter(event=>event.type==='assistant/message'&&event.seq>identity.seq).at(-1)
   if(message?.type!=='assistant/message'||message.data.message.content.some(part=>part.type!=='text'&&part.type!=='reasoning'))throw invalid()
   const text=message.data.message.content.filter(part=>part.type==='text').map(part=>part.text).join('')
   if(Buffer.byteLength(text,'utf8')>businessConfigurationLimits.canonicalBytes)throw invalid()
   let raw:unknown
   try{
    raw=JSON.parse(text)
    // 兼容模型把完整 JSON patch 再编码成一个 JSON 字符串；只解包一层，仍交给原严格读取器。
    if(typeof raw==='string'){
     if(Buffer.byteLength(raw,'utf8')>businessConfigurationLimits.canonicalBytes)throw invalid()
     raw=JSON.parse(raw)
    }
   }catch{throw invalid()}
   const patch=readBusinessConfigurationPatchVersioned(raw,current.draft.candidate.format),input={draftId:prepared.draftId,expectedRevision:prepared.revision,requestId:prepared.requestId,patch}
   const prior=await ports.reviseReceipt(input)
   signal.throwIfAborted()
   if(!prior&&(current.draft.revision!==prepared.revision||current.draft.hash!==prepared.draftHash))throw new WorkError('teloa/version-conflict','生成期间草案已修改，原草案已保留，请刷新后重新描述。')
   saving=true
   const saved=businessBuilderMutationReceipt(prior??await ports.revise(input),current.draft,prepared.revision,'保存')
   if(saved.ownerId!==ports.owner||saved.id!==prepared.draftId||saved.scope!==current.draft.scope||saved.status!=='draft'||saved.revision!==prepared.revision+1||saved.candidate.format!==current.draft.candidate.format)throw new WorkError('teloa/invalid-host-response','预览保存回执未能核对，请先刷新原草案。')
   appendPluginRecord(agent.session,recordType,{kind:'settled',owner:ports.owner,sessionId:agent.id,draftId:prepared.draftId,requestId:prepared.requestId,state:'saved',revision:saved.revision,hash:saved.hash})
  }catch(error){
   appendPluginRecord(agent.session,recordType,{kind:'settled',owner:ports.owner,sessionId:agent.id,draftId:prepared.draftId,requestId:prepared.requestId,state:saving?'unknown':'failed',revision:prepared.revision,code:error instanceof WorkError?error.code:'teloa/host-unavailable'})
   throw error instanceof WorkError?error:new WorkError('teloa/host-unavailable','预览保存结果尚未确认，请先刷新原草案，不要重复发送。')
  }finally{active.delete(agent)}
 })
 const offError=ctx.on('agent/error',({agent})=>{active.delete(agent)})
 const offIdle=ctx.on('agent/status',({agent,status})=>{if(status==='idle')active.delete(agent)})
 return {mode,isPreviewOnly,dispose(){offStep();offAssembly();offTools();offStop();offError();offIdle()}}
}

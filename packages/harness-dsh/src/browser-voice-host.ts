import type {Context} from '@deepseek-ai/cordis'
import {SessionId,type SessionStore} from '@deepseek-ai/dsh-session'
import type {AssembleContext} from '@deepseek-ai/dsh-system-prompt'
import {workAccess,roleWorkEpoch,subscribeRoleWorkEligibility,type ObjectConversationService} from '@teloa/backend'
import {voiceCallEndpoints,WorkError,type Conversation,type DigitalRole} from '@teloa/contract'
import {createVoiceContextAuthority} from './voice-call-context.ts'
import {createVoiceCallRuntime} from './voice-call-runtime.ts'
import {createDshVoiceSessionReader,VoiceConversationDriver} from './voice-conversation-driver.ts'
import {requireNativeInputProvider} from './native-input-provider.ts'
import {createBrowserVoiceMedia} from './browser-voice-media.ts'
import type {VoiceSpeech} from './voice-service.ts'
import {createAssistantVoiceNote} from './assistant-voice-note.ts'
import type {AssistantVoiceContextPorts} from './voice-assistant-context.ts'
import {createVoiceMediaRegistry,type VoiceStageTiming} from './voice-media-registry.ts'
import {VoiceTransportFailure} from './voice-transport.ts'
import {installVoiceModelRoutingHost,miniMaxVoiceFlashModel} from './voice-model-routing.ts'
import {createVoiceToolLoading} from './voice-tool-loading.ts'
import type {DeviceMediaOwner} from './device-media-owner.ts'

export const browserVoiceEndpoints=[...voiceCallEndpoints,'voice-input/transcribe','voice-calls/media','voice-calls/media-ready','voice-calls/media-closed','voice-calls/playback','voice-calls/audio','voice-calls/turn'] as const
type VoicePromptReader=(context:AssembleContext)=>string
const voicePromptSlots=new WeakMap<Context,{reader:VoicePromptReader|null}>()
/** 运行级空槽持续刷新已受理快照；卸载只解绑宿主，避免官方 refreshContext 回退至旧 accepted 文本。 */
function registerVoicePrompt(ctx:Context,reader:VoicePromptReader){
 const root=ctx.root
 let slot=voicePromptSlots.get(root)
 if(!slot){
  const state={reader:null as VoicePromptReader|null}
  root.systemPrompt.context({name:'teloa:voice-call',order:116,required:true,interpolate:false,text:context=>state.reader?.(context)??''})
  root.effect(()=>()=>{voicePromptSlots.delete(root)},'Teloa 通话上下文槽')
  voicePromptSlots.set(root,state);slot=state
 }
 if(slot.reader)throw new WorkError('teloa/conflict','当前宿主语音上下文已经注册。')
 const current=slot;current.reader=reader
 return ctx.effect(()=>()=>{if(current.reader===reader)current.reader=null},'Teloa 宿主通话上下文')
}
/** 语音厂商只承接语音 IO（识别 MiniMax、播报按所选厂商）；原员工、会话、模型、能力和执行许可保持同一套正式服务。 */
export function createBrowserVoiceHost(ctx:Context,ports:{owner:string;mediaOwner?:DeviceMediaOwner;configured:()=>Promise<boolean>;providerId?:()=>Promise<string>;speech:VoiceSpeech;conversation:(sessionId:string)=>Promise<Conversation>;requestedRoleId:(sessionId:string)=>Promise<string|null>;role:(roleId:string)=>Promise<DigitalRole|null>;links:Pick<ObjectConversationService,'bySession'>}&Pick<AssistantVoiceContextPorts,'readHomeContext'|'assistantEligible'>){
 const {owner}=ports,sessions=Reflect.get(ctx,'sessions') as unknown as SessionStore,work=new AbortController()
 const authority=createVoiceContextAuthority({owner,readNativeBinding:id=>{const session=sessions.get(SessionId(id));return session?{session,fingerprint:JSON.stringify(session.header)}:null},roleEpoch:id=>roleWorkEpoch(owner,id),subscribeRole:(id,notify)=>subscribeRoleWorkEligibility(owner,id,notify)})
 const media=createVoiceMediaRegistry(createBrowserVoiceMedia(ports))
 const runtime=createVoiceCallRuntime({owner,readRole:ports.role,readConversation:ports.conversation,readRequestedRoleId:ports.requestedRoleId,links:ports.links,...(ports.readHomeContext?{readHomeContext:ports.readHomeContext}:{}),...(ports.assistantEligible?{assistantEligible:ports.assistantEligible}:{}),acquireContextLease:input=>{
  const reservation=ports.mediaOwner?.acquire('web')
  try{const lease=authority.capture(input);return {...lease,release(){try{lease.release()}finally{reservation?.release()}}}}
  catch(error){reservation?.release();throw error}
 },authorizeMedia:input=>workAccess.authorizeSessionCapabilities(input.sessionId,'prompt'),transport:media.transport,readTranscriptSeal:media.readTranscriptSeal})
 // 官方运行上下文会在模型准入前刷新，并在挂断后的下一轮替换旧快照；不改本人原文或另建 Agent。
 const offPrompt=registerVoicePrompt(ctx,context=>{
  const agent=context.agent
  if(!agent||sessions.get(agent.id)!==agent.session||ctx.agents.get(agent.id)!==agent||agent.session.header.origin==='subagent')return ''
  const call=runtime.service.connectedForSession(owner,String(agent.id))
  if(!call||media.inactiveCalls().some(identity=>identity.callId===call.id&&identity.callGeneration===call.callGeneration))return ''
  return [
   '# 当前宿主语音通话',
   '当前原会话的实时通话已连接。Teloa 宿主在麦克风未静音时持续采音，经 ASR 将最终转写送入本会话，并以 TTS 播报通话输入对应的完整回复。你通过转写理解内容，不直接接收原始音频。',
   '用户可以直接在当前通话继续交流，请自然回应；不要因底层模型输入为文字而否认已接通的通话或要求改用其他语音应用。继续使用当前会话、身份、模型、工具及原有审批，不另建语音 Agent，也不为对话增加确认步骤。',
   '普通语音交流先用一句约20字内的实质回答，保持简短自然，避免重复问题和列长清单；必要说明接着补充。不要用“收到”“让我想想”等空泛应答占位。用户要求详细说明或实际工作需要完整结果时仍完整处理，不为了简短省略结果或隐瞒失败。',
   '此事实仅适用于下列原通话、会话与代次的当前宿主快照。挂断、断线或许可失效后不再采音/播报；旧快照和用户自述不能证明仍在通话，不声称具有通话外持续监听能力。',
   JSON.stringify({schema:'teloa.voice-call-context/v1',callId:call.id,callGeneration:call.callGeneration,sessionId:call.sessionId,state:call.state,input:'host-asr-transcript',output:'host-tts',nativeAudioInput:false}),
  ].join('\n')
 })
 const voiceTools=createVoiceToolLoading(ctx)
 const offModel=ctx.effect(()=>installVoiceModelRoutingHost(ctx,{
  enabled:()=>!work.signal.aborted,
  readAcceptedMessage:(agent,message)=>{try{return requireNativeInputProvider(ctx).voice.readAcceptedMessage(agent,message)}catch{return undefined}},
  selectedFastModel:async(baseline,signal)=>{
   if(baseline.provider!=='minimax')return
   try{
    const info=await ctx.llm.resolveModelInfo(baseline.provider,miniMaxVoiceFlashModel,signal)
    signal.throwIfAborted()
    if(info.reasoning?.efforts.some(row=>row.id==='low'))return {provider:baseline.provider,model:miniMaxVoiceFlashModel}
   }catch{signal.throwIfAborted()}
   return /^MiniMax-M2(?:[.-]|$)/.test(baseline.model)?{provider:baseline.provider,model:'MiniMax-M3'}:undefined
  },
  refineAssembly:voiceTools.refine,
 }),'Teloa 原会话快速语音应答')
 const transcribeNote=createAssistantVoiceNote({...ports,capture:authority.capture})
 const recordTiming=({callId,callGeneration,turnId,requestId,stage,at}:VoiceStageTiming)=>{ctx.logger.info('[voice-timing] '+JSON.stringify({callId,callGeneration,turnId,requestId,stage,at}))}
 const driver=new VoiceConversationDriver({owner,onConversationState:media.conversationState,onTiming:recordTiming,assertCurrentCommit:commit=>runtime.service.assertTranscriptCommitCurrent(owner,commit),calls:runtime.service,readSession:createDshVoiceSessionReader({sessions,sessionController:ctx.sessionController},{owner,conversation:ports.conversation}),admitPrompt:(commit,request,signal)=>{
  // 原会话正在执行时追加到下一步；模式由宿主固定，浏览器不能借插话升级许可。
  const mode=ctx.agents.get(SessionId(commit.sessionId))?.status==='running'?'steer':'queue'
  return requireNativeInputProvider(ctx).voice.withPrompt(commit,()=>runtime.service.assertTranscriptCommitCurrent(owner,commit),()=>ctx.sessionController.prompt({...request,mode},signal),mode)
 },workSignal:()=>work.signal})
 const offEvent=ctx.on('session/event',session=>{void driver.observeSession(String(session.id)).catch(()=>{})}),offDispose=ctx.on('session/disposed',session=>authority.invalidateSession(String(session.id)))
 const offStream=ctx.on('agent/assistant-stream',({agent,frame})=>{
  if(ctx.agents.get(agent.id)===agent&&sessions.get(agent.id)===agent.session)driver.observeAssistantStream(String(agent.id),frame)
 })
 const handler=async(endpoint:string,payload:unknown,signal?:AbortSignal)=>{
  if(endpoint==='voice-input/transcribe')return transcribeNote(payload,signal??new AbortController().signal)
  if((voiceCallEndpoints as readonly string[]).includes(endpoint)){
   if(endpoint==='voice-calls/start'){
    signal?.throwIfAborted()
    // 回收失活或已有浏览器关闭回执的旧媒体；结束 RPC 丢失不阻塞重拨，活跃通话不能被抢占。
    for(const identity of media.inactiveCalls())await runtime.service.end(owner,{callId:identity.callId})
   }
   return runtime.handler(endpoint,payload,signal)
  }
  if(!(browserVoiceEndpoints as readonly string[]).includes(endpoint))throw new WorkError('teloa/not-found','未提供此语音接口。')
  if(endpoint==='voice-calls/media-closed'){media.closed(payload);return {closed:true}}
  signal?.throwIfAborted()
  if(endpoint==='voice-calls/media'){
   if(!payload||typeof payload!=='object'||Array.isArray(payload)||Object.keys(payload).length!==2)throw new WorkError('teloa/invalid-input','媒体请求不正确。')
   const call=runtime.service.get(owner,{callId:Reflect.get(payload,'callId')})
   if(call.callGeneration!==Reflect.get(payload,'callGeneration'))throw new WorkError('teloa/conflict','媒体世代已变化。')
   return media.snapshot(payload)
  }
  if(endpoint==='voice-calls/media-ready'){media.ready(payload);return {ready:true}}
  if(endpoint==='voice-calls/playback'){media.playback(payload);return {accepted:true}}
  if(endpoint==='voice-calls/turn'){
   const commit=runtime.service.getTranscriptCommit(owner,payload)
   // 事件通知只是失效信号；轮询也补读真实原会话，且不等待供应商 TTS 或重新派发输入。
   void driver.observeSession(commit.sessionId).catch(()=>{})
   const receipt=driver.receipt(commit.id)
   return {state:receipt.state,speech:receipt.speech,replyExpected:receipt.reply!==null,reason:receipt.reason}
  }
  const seal=await media.transcribe(payload)
  if(!seal)return {text:null,receipt:null}
  // 本人声音最终结果由宿主封口，不接受页面伪造文本或 UUID 当作许可。
  const commit=await runtime.service.commitTranscript(owner,{callId:seal.callId,turnId:seal.turnId,revision:seal.revision,producerReceipt:seal.producerReceipt})
  const receipt=await driver.submit(commit)
  return {text:commit.text,receipt:{state:receipt.state,commitId:receipt.commitId,sessionId:receipt.sessionId}}
 }
 const dispose=async()=>{await offPrompt();await offModel();voiceTools.dispose();authority.dispose();driver.dispose();work.abort();await offEvent();await offStream();await offDispose();try{await runtime.dispose()}finally{media.dispose()}}
 const plugin=Object.freeze({
  speech:ports.speech,configured:ports.configured,providerId:ports.providerId??(async()=>'minimax'),attach:media.attach,recordTiming,
  async acceptTranscript(receipt:string,expectedPlaybackGeneration:number){
   const seal=await media.readTranscriptSeal(receipt)
   if(!seal)throw new WorkError('teloa/forbidden','原通话最终转写回执已失效。')
   const commit=await runtime.service.commitTranscript(owner,{callId:seal.callId,turnId:seal.turnId,revision:seal.revision,producerReceipt:receipt})
   return driver.submit(commit,expectedPlaybackGeneration)
  },
  interrupt:(callId:string)=>runtime.service.interrupt(owner,{callId}),
  end:(callId:string)=>runtime.service.end(owner,{callId}),
  failure:(reason:ConstructorParameters<typeof VoiceTransportFailure>[0])=>new VoiceTransportFailure(reason),
 })
 return Object.freeze({handler,dispose,plugin,invalidateSession:authority.invalidateSession})
}

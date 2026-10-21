import test,{type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {Context} from '@deepseek-ai/cordis'
import {LlmRuntime,LlmAdapter,LlmError,ReasoningEffortId,ToolCallId,createUserMessage,type GenerateOptions,type StreamChunk} from '@deepseek-ai/dsh-llm'
import {AgentRegistry,type Agent} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {SessionStore,SessionId,pluginRecordOf,type UserMessage} from '@deepseek-ai/dsh-session'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {ToolRuntime,defineTool,type ToolRunContext} from '@deepseek-ai/dsh-tools'
import type {TranscriptCommit} from '@teloa/contract'
import {NativeVoiceInputAdmissions} from '../src/native-voice-input-admission.ts'
import {createNativeProducerAdmissions} from '../src/native-producer-admission.ts'
import {installTaskModelRouting} from '../src/task-model-routing.ts'
import {installVoiceModelRoutingHost,miniMaxVoiceFlashModel,type VoiceModelRoutingPorts} from '../src/voice-model-routing.ts'
import {createVoiceToolLoading,voiceToolsName} from '../src/voice-tool-loading.ts'
import {textAnswer,toolAnswer,hotGate,type HotGate} from './fixtures/native-hot-causality.ts'
import {patchedControllerPackage,promptRequest,type AdmittingSessionController} from './fixtures/native-controller-admission.ts'

const base={provider:'minimax',model:'MiniMax-M2.7-highspeed',reasoningEffort:ReasoningEffortId('high')}
const fast={provider:'minimax',model:'MiniMax-M3',reasoningEffort:ReasoningEffortId('off')}
class Adapter extends LlmAdapter{
 readonly requests:GenerateOptions[]=[]
 readonly scripts:Array<readonly StreamChunk[]>=[]
 missingFast=false
 missingFlash=false
 resolveFastGate:HotGate|undefined
 async listModels(provider:string){return (provider==='minimax'?['MiniMax-M2.7-highspeed','MiniMax-M2.5',...this.missingFast?[]:['MiniMax-M3']]:['other-model']).map(id=>this.info(provider,id))}
 info(provider:string,model:string){return {provider,id:model,name:model,reasoning:{efforts:(model===miniMaxVoiceFlashModel?['low','high']:['off','high']).map(id=>({id:ReasoningEffortId(id),name:id}))}}}
 async resolveModel(provider:string,model:string){
  if(this.missingFast&&model==='MiniMax-M3')throw new LlmError('本地目录不含该模型','UNKNOWN_MODEL')
  if(this.missingFlash&&model===miniMaxVoiceFlashModel)throw new LlmError('未声明预览模型','UNKNOWN_MODEL')
  if(model==='MiniMax-M3')await this.resolveFastGate?.wait()
  return this.info(provider,model)
 }
 async *stream(request:GenerateOptions){this.requests.push(request);const script=this.scripts.shift();assert.ok(script,'外部推理已被本地脚本完全替代');yield* script}
}
function commit(agent:Agent):TranscriptCommit{
 return Object.freeze<TranscriptCommit>({target:'assistant',contextVersion:1,ownerId:randomUUID(),sessionId:String(agent.id),scope:'general',callId:randomUUID(),callGeneration:randomUUID(),turnId:'synthetic-owner',speaker:'owner',source:{kind:'sealed-audio-stt',providerId:'host',audioSha256:'a'.repeat(64),sealReceiptId:'seal',sttReceiptId:'stt'},revision:1,text:'合成语音输入',closed:true,complete:true,producerReceipt:'synthetic-receipt',id:randomUUID(),contentSha256:'b'.repeat(64)})
}
async function setup(t:TestContext,initial=base){
 const ctx=new Context(),adapter=new Adapter(),counters={tools:0};t.after(()=>ctx.fiber.dispose())
 for(const plugin of [LlmRuntime,SessionStore,SessionProjectionRegistry,SystemPrompt,ToolRuntime,AgentRegistry])await ctx.plugin(plugin)
 ctx.llm.registerAdapter(['minimax','other-vendor'],adapter)
 let toolAction:(exec:ToolRunContext)=>Promise<void>=async()=>{}
 ctx.tools.register(defineTool({name:'hot_result',description:'本地工具回执',parameters:{},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},async execute(_args,exec){counters.tools++;await toolAction(exec);return 'synthetic-result'}}))
 await ctx.plugin(AgentLoop,{agents:[]})
 const {agent}=await ctx.agents.create({sessionId:SessionId('voice-route'),agentOptions:initial})
 const noop=()=>()=>{}
 ctx.provide('typert',{lookups:{register:noop,configure:noop},contexts:{configureHost:noop},resources:{register:noop}} as never)
 ctx.provide('agentDefaultModel',{currentSelection:()=>initial,saveSelection:async()=>{}} as never)
 ctx.provide('workspaceRegistry',{get:()=>undefined,list:()=>[],archivedSessionIds:[]} as never)
 ctx.provide('attachments',{imageLimits:{maxImageBytes:1000,maxImagePixels:1000,maxImageDimension:100},admitPromptContent:async(content:readonly unknown[])=>structuredClone(content)} as never)
 ctx.provide('fileUploads',{registerAgentResolver:noop,resolve:()=>undefined,bindPrompt:()=>({commit(){},[Symbol.dispose](){}}),retirePrompt(){}} as never)
 const controllerPackage=await patchedControllerPackage(t),controller=new controllerPackage.SessionController(ctx,{nativeOpen:false}) as AdmittingSessionController
 const voice=new NativeVoiceInputAdmissions();t.after(()=>voice.close())
 const inserted:Array<{agent:Agent;message:UserMessage}>=[]
 ctx.on('agent/inbox/inserted',({agent,message})=>{voice.captureInserted(agent,message);inserted.push({agent,message})})
 // 这里只替代已单独验收的工作许可端口；Controller、Inbox、Session、Loop 与选模均为真实官方实现。
 const admission=createNativeProducerAdmissions({async withNewInput(_agent,_message,_binding,dispatch,_signal,lease){lease?.assertCurrent();dispatch()}},undefined,voice)
 controller.requireInputAdmission();controller.installInputAdmission(admission.controller)
 let enabled=true
 const options:VoiceModelRoutingPorts={enabled:()=>enabled,readAcceptedMessage:(target,message)=>voice.readAcceptedMessage(target,message),selectedFastModel:()=>({provider:'minimax',model:'MiniMax-M3'})}
 const dispose=installVoiceModelRoutingHost(ctx,options);t.after(dispose)
 async function sendVoice(target:Agent=agent,mode:'queue'|'steer'='queue'){
  const input=commit(target)
  await voice.withPrompt(input,()=>{},()=>controller.prompt(promptRequest(target,input.id,input.text,mode),new AbortController().signal),mode)
  return input
 }
 async function plain(target:Agent=agent,id:string=randomUUID(),mode:'queue'|'steer'='queue'){
  await controller.prompt(promptRequest(target,id,'合成普通输入',mode),new AbortController().signal)
 }
 const routes=()=>adapter.requests.map(row=>({provider:row.provider,model:row.model,reasoningEffort:row.reasoningEffort}))
 return {ctx,agent,adapter,voice,controller,options,dispose,sendVoice,plain,routes,inserted,counters,setToolAction(action:typeof toolAction){toolAction=action},disable(){enabled=false}}
}

test('已有M3会话的真实语音与工具续步可用已声明Flash/low，普通输入仍恢复M3/off',async t=>{
 const f=await setup(t,fast),flash={provider:'minimax',model:miniMaxVoiceFlashModel,reasoningEffort:ReasoningEffortId('low')}
 const info=f.adapter.info.bind(f.adapter)
 f.adapter.info=(provider,model)=>({...info(provider,model),defaultMaxTokens:model===miniMaxVoiceFlashModel?32768:512000})
 f.options.selectedFastModel=()=>flash
 f.adapter.scripts.push(toolAnswer,textAnswer,textAnswer)
 const before=f.ctx.agents.list().length
 await f.sendVoice();await f.agent.whenIdle();await f.plain();await f.agent.whenIdle()
 assert.deepEqual(f.routes(),[flash,flash,fast]);assert.equal(f.counters.tools,1)
 assert.deepEqual(f.adapter.requests.map(row=>row.maxTokens),[32768,32768,512000],'模型默认预算不能从语音请求泄漏到普通工作')
 assert.equal(f.ctx.agents.list().length,before,'快速语音必须仍由原Agent工作')
})

test('Flash未配置时保留原M3；冷恢复只还原已记录M3选择，不恢复旧语音信任',async t=>{
 for(const missing of [false,true]){
  const f=await setup(t,fast),flash={provider:'minimax',model:miniMaxVoiceFlashModel,reasoningEffort:ReasoningEffortId('low')}
  f.options.selectedFastModel=()=>flash;f.adapter.missingFlash=missing
  f.adapter.scripts.push(textAnswer,textAnswer)
  await f.sendVoice();await f.agent.whenIdle()
  const {agent}=await f.ctx.agents.create({sessionId:SessionId('flash-restored'),seed:JSON.parse(JSON.stringify(f.agent.session.snapshotEvents())),agentOptions:fast})
  await f.plain(agent);await agent.whenIdle()
  assert.deepEqual(f.routes(),[missing?fast:flash,fast])
 }
})

test('同一真实Controller/Loop：voice工具续步用M3/off，普通文字恢复原模型档位且无虚假切换通知',async t=>{
 const f=await setup(t)
 f.ctx.systemPrompt.section({name:'route-model',order:0,text:'MODEL={{model}}'})
 const proposals:unknown[]=[]
 f.agent.ctx.on('agent/request',async(_payload,next)=>{const value=await next();proposals.push({provider:value.provider,model:value.model,reasoningEffort:value.reasoningEffort});return {...value,temperature:0.2,maxTokens:256,stop:['END']}})
 f.adapter.scripts.push(textAnswer,toolAnswer,textAnswer,textAnswer)
 await f.plain();await f.agent.whenIdle()
 await f.sendVoice();await f.agent.whenIdle()
 assert.deepEqual(f.agent.session.snapshotEvents().flatMap(row=>{const record=pluginRecordOf(row);return record?[record.data]:[]}),[{baseline:base,fast,selectionSeq:-1}])
 assert.deepEqual(f.agent.session.requestHeader()?.config,{...fast,temperature:0.2,maxTokens:256,stop:['END']})
 await f.plain();await f.agent.whenIdle()
 assert.deepEqual(f.agent.session.snapshotEvents().filter(row=>row.type==='turn/end'&&row.data.reason.kind==='error'),[])
 assert.equal(f.voice.readAcceptedMessage(f.agent,f.inserted[1]!.message)?.standalone,true)
 assert.deepEqual(proposals,[base,base,fast,fast])
 assert.deepEqual(f.routes(),[base,fast,fast,base])
 assert.deepEqual(f.adapter.requests.map(row=>row.messages.filter(message=>message.role==='system').at(-1)?.content.flatMap(block=>block.type==='text'?[block.text]:[]).join('\n').split('\n').at(-1)),['MODEL=MiniMax-M2.7-highspeed','MODEL=MiniMax-M3','MODEL=MiniMax-M3','MODEL=MiniMax-M2.7-highspeed'])
 assert.equal(f.counters.tools,1)
 assert.ok(f.adapter.requests.every(row=>row.temperature===0.2&&row.maxTokens===256&&JSON.stringify(row.stop)==='["END"]'))
 assert.equal(f.agent.session.snapshotEvents().filter(row=>row.type==='user/message'&&row.data.source.kind==='model-selection').length,0)
})

test('可信标记只认原Session实际入队对象；复制对象、同rpcId普通输入与错Agent均不能成为voice',async t=>{
 const f=await setup(t),input=commit(f.agent)
 f.adapter.scripts.push(textAnswer,textAnswer)
 await f.plain(f.agent,input.id);await f.agent.whenIdle()
 const forged=f.agent.session.snapshotEvents().find(row=>row.type==='user/message'&&row.data.source.kind==='user')!
 assert.equal(forged.type,'user/message')
 if(forged.type==='user/message')assert.equal(f.voice.readAcceptedMessage(f.agent,forged.data),undefined)
 const real=await f.sendVoice();await f.agent.whenIdle()
 const accepted=f.inserted.find(row=>'rpcId'in row.message.source&&row.message.source.rpcId===real.id)!
 assert.deepEqual(f.voice.readAcceptedMessage(f.agent,accepted.message),{sessionId:String(f.agent.id),callId:real.callId,callGeneration:real.callGeneration,inputId:real.id,standalone:true})
 assert.equal(f.voice.readAcceptedMessage(f.agent,{...accepted.message}),undefined)
 const {agent:other}=await f.ctx.agents.create({sessionId:SessionId('voice-wrong-agent'),agentOptions:base})
 assert.equal(f.voice.readAcceptedMessage(other,accepted.message),undefined)
 const event=f.agent.session.snapshotEvents().find(row=>row.type==='user/message'&&row.data.source.kind==='user'&&'rpcId'in row.data.source&&row.data.source.rpcId===real.id)!
 assert.equal(event.type,'user/message')
 // user/message 再次拥有 Session 快照，只有被 Inbox 消费的 canonical 对象保留来源。
 if(event.type==='user/message')assert.equal(f.voice.readAcceptedMessage(f.agent,event.data),undefined)
 assert.deepEqual(f.routes(),[base,fast])
})

test('真实语音原Agent按需加载工具，下一步照常执行，普通输入恢复完整工具',async t=>{
 const f=await setup(t),loading=createVoiceToolLoading(f.ctx);t.after(loading.dispose)
 f.options.refineAssembly=loading.refine
 f.ctx.on('tools/post-execute',async(exec,_result,next)=>{
  const decision=await next()
  return exec.name===voiceToolsName&&decision.kind==='accept'?{...decision,additionalContexts:[...decision.additionalContexts??[],createUserMessage({source:{kind:'plugin:teloa.work',form:'notice',summary:'宿主说明'},content:[{type:'text',text:'这不是本人追加输入。'}]})]}:decision
 })
 const args=JSON.stringify({names:['hot_result']}),id=ToolCallId('voice-load')
 const load:readonly StreamChunk[]=[{type:'block-start',index:0,blockType:'tool-call'},{type:'tool-call-delta',index:0,id,name:voiceToolsName,argumentsDelta:args},{type:'block-end',index:0,block:{type:'tool-call',id,name:voiceToolsName,arguments:args}},{type:'finish',reason:{kind:'tool-calls'}}]
 f.adapter.scripts.push(load,toolAnswer,textAnswer,textAnswer,textAnswer)
 await f.sendVoice();await f.agent.whenIdle()
 assert.deepEqual(f.adapter.requests[0]!.tools?.map(t=>t.name),[voiceToolsName])
 assert.deepEqual(f.adapter.requests[1]!.tools?.map(t=>t.name).sort(),['hot_result',voiceToolsName].sort())
 assert.equal(f.counters.tools,1,'加载目录本身不能执行业务，正式工具仍由原Loop执行')
 assert.deepEqual(f.routes(),[fast,fast,fast],'宿主补充说明不能丢掉原语音轮次归属')
 assert.ok(f.adapter.requests[0]!.messages.some(message=>JSON.stringify(message.content).includes('Tool loading for this voice turn')))
 await f.plain();await f.agent.whenIdle()
 assert.deepEqual(f.adapter.requests[3]!.tools?.map(t=>t.name),['hot_result'])
 await f.sendVoice();await f.agent.whenIdle()
 assert.deepEqual(f.adapter.requests[4]!.tools?.map(t=>t.name),[voiceToolsName],'上一轮加载的工具不继承为新轮默认')
 assert.equal(f.agent.session.snapshotEvents().filter(e=>e.type==='turn/end'&&e.data.reason.kind==='error').length,0)
})

test('语音工具装配只取本轮许可交集，角色未许可加载端口时保留原工具面',async t=>{
 const f=await setup(t),loading=createVoiceToolLoading(f.ctx);t.after(loading.dispose)
 const visible={name:'hot_result',description:'已允许',parameters:{type:'object',properties:{}}} as const
 const discovery={name:voiceToolsName,description:'加载',parameters:{type:'object',properties:{}}} as const
 const assembly={sections:[{name:'tool:hot_result',text:'原工具执行规则'},{name:'identity',text:'身份与权限'},{name:'tool:unknown',text:'未知规则保留'}],contexts:[{name:'tool:hot_result:depth',text:'工具动态范围'},{name:'approval',text:'审批规则'}],variables:{},tools:[visible,discovery]} as never
 const slim=loading.refine(f.agent,assembly,{voice:true,turn:1});assert.deepEqual(slim.tools.map(t=>t.name),[voiceToolsName])
 assert.deepEqual(slim.sections.map(s=>s.name),['identity','tool:unknown'])
 assert.ok(!slim.contexts.some(c=>c.name==='tool:hot_result:depth'));assert.ok(slim.contexts.some(c=>c.name==='approval'))
 const forbidden=f.ctx.tools.get(voiceToolsName,f.agent)!
 const searched=JSON.parse(await forbidden.execute({query:'hot result'},{agent:f.agent,signal:new AbortController().signal} as never) as string)
 assert.ok(searched.loaded.some((tool:{name:string})=>tool.name==='hot_result'))
 const loaded=loading.refine(f.agent,assembly,{voice:true,turn:1});assert.ok(loaded.tools.some(tool=>tool.name==='hot_result'))
 assert.equal(loaded.sections.find(s=>s.name==='tool:hot_result')?.text,'原工具执行规则')
 assert.equal(loaded.contexts.find(c=>c.name==='tool:hot_result:depth')?.text,'工具动态范围')
 const revoked=loading.refine(f.agent,{...(assembly as object),tools:[discovery]} as never,{voice:true,turn:1});assert.deepEqual(revoked.tools.map(tool=>tool.name),[voiceToolsName])
 await assert.rejects(forbidden.execute({names:['hot_result']},{agent:f.agent,signal:new AbortController().signal} as never),{code:'teloa/forbidden'})
 loading.refine(f.agent,assembly,{voice:true,turn:1})
 await assert.rejects(forbidden.execute({names:['unavailable_write']},{agent:f.agent,signal:new AbortController().signal} as never),{code:'teloa/forbidden'})
 const restricted=loading.refine(f.agent,{...(assembly as object),tools:[visible]} as never,{voice:true,turn:1});assert.deepEqual(restricted.tools.map(t=>t.name),['hot_result'])
 await assert.rejects(forbidden.execute({names:['hot_result']},{agent:f.agent,signal:new AbortController().signal} as never),{code:'teloa/forbidden'})
})

test('语音先聊天、按需恢复工作规则；猜测未加载工具不能执行',async t=>{
 const f=await setup(t),loading=createVoiceToolLoading(f.ctx);t.after(loading.dispose)
 f.options.refineAssembly=loading.refine
 f.adapter.scripts.push(toolAnswer,textAnswer)
 await f.sendVoice();await f.agent.whenIdle()
 assert.equal(f.counters.tools,0)
 assert.ok(JSON.stringify(f.agent.session.snapshotEvents()).includes('nothing executed'))
 const project={name:'teloa_projects_read',description:'读取项目配置',parameters:{type:'object',properties:{}}}
 const discovery={name:voiceToolsName,description:'加载',parameters:{type:'object',properties:{}}}
 const assembly={sections:[{name:'teloa:work-behavior',text:'原完整规则'},{name:'identity',text:'原身份与权限'}],contexts:[{name:'teloa:work-behavior-runtime',text:''},{name:'role',text:'原职责'}],variables:{},tools:[project,discovery]} as never
 const first=loading.refine(f.agent,assembly,{voice:true,turn:10})
 assert.ok(first.sections[0]!.text.includes('# Core'))
 assert.ok(!first.sections[0]!.text.includes('# Project configuration'))
 assert.equal(first.sections[1]!.text,'原身份与权限')
 assert.equal(first.contexts.find(c=>c.name==='role')!.text,'原职责')
 await f.ctx.tools.get(voiceToolsName,f.agent)!.execute({query:'读取项目'},{agent:f.agent,signal:new AbortController().signal} as never)
 const work=loading.refine(f.agent,assembly,{voice:true,turn:10})
 assert.ok(work.tools.some(tool=>tool.name===project.name))
 assert.ok(work.sections[0]!.text.includes('# Project configuration'))
})

test('原许可工具名被提前调用时只加载参数，下一步才执行，不再绕一次目录搜索',async t=>{
 const f=await setup(t),loading=createVoiceToolLoading(f.ctx);t.after(loading.dispose)
 f.options.refineAssembly=loading.refine
 f.adapter.scripts.push(toolAnswer,toolAnswer,textAnswer)
 await f.sendVoice();await f.agent.whenIdle()
 assert.deepEqual(f.adapter.requests[0]!.tools?.map(t=>t.name),[voiceToolsName])
 assert.ok(f.adapter.requests[1]!.tools?.some(t=>t.name==='hot_result'))
 assert.equal(f.counters.tools,1)
 assert.equal(f.agent.session.snapshotEvents().filter(e=>e.type==='tool/result'&&e.data.message.isError).length,1)
})

test('普通工作在途的voice插话和voice回合中的普通插话都保留原任务路由',async t=>{
 const f=await setup(t),gate=hotGate();t.after(gate.release)
 f.setToolAction(()=>gate.wait());f.adapter.scripts.push(toolAnswer,textAnswer)
 await f.plain();await gate.entered;await f.sendVoice(f.agent,'steer');gate.release();await f.agent.whenIdle()
 assert.deepEqual(f.routes(),[base,base])
 const next=hotGate();t.after(next.release);f.setToolAction(()=>next.wait());f.adapter.scripts.push(toolAnswer,textAnswer)
 await f.sendVoice();await next.entered;await f.plain(f.agent,randomUUID(),'steer');next.release();await f.agent.whenIdle()
 assert.deepEqual(f.routes(),[base,base,fast,base])
})

test('本人真实手动选模在voice之后保留新selection/effort，不能被旧baseline覆盖',async t=>{
 const f=await setup(t),gate=hotGate();t.after(gate.release)
 f.setToolAction(()=>gate.wait());f.adapter.scripts.push(toolAnswer,textAnswer,textAnswer)
 await f.sendVoice();await gate.entered
 const chosen={provider:'minimax',model:'MiniMax-M2.5',reasoningEffort:ReasoningEffortId('off')}
 await f.controller.selectModel({sessionId:f.agent.id,...chosen});gate.release();await f.agent.whenIdle()
 await f.plain();await f.agent.whenIdle()
 assert.deepEqual(f.routes(),[fast,chosen,chosen])
 assert.equal(f.agent.session.snapshotEvents().filter(row=>row.type==='model/selection').length,1)
 assert.equal(f.agent.session.snapshotEvents().filter(row=>row.type==='user/message'&&row.data.source.kind==='model-selection').length,1,'本人真实改选的通知必须保留')
})

test('缺M3、非MiniMax和固定task策略均不启用快速语音',async t=>{
 const f=await setup(t)
 f.adapter.missingFast=true;f.adapter.scripts.push(textAnswer);await f.sendVoice();await f.agent.whenIdle()
 f.adapter.missingFast=false
 const chosen={provider:'other-vendor',model:'other-model',reasoningEffort:ReasoningEffortId('high')}
 await f.controller.selectModel({sessionId:f.agent.id,...chosen});f.adapter.scripts.push(textAnswer);await f.sendVoice();await f.agent.whenIdle()
 const policy=installTaskModelRouting(f.agent,{primary:base},{isRemote:async()=>false,requiresImages:()=>false,recordRecovery:async()=>{}});t.after(policy.dispose)
 f.adapter.scripts.push(textAnswer);await f.sendVoice();await f.agent.whenIdle();policy.dispose()
 assert.deepEqual(f.routes(),[base,chosen,base])
})

test('真实Session序列化后以新Agent恢复：只撤销本模块fast请求头，不恢复voice信任',async t=>{
 const f=await setup(t)
 f.adapter.scripts.push(textAnswer);await f.sendVoice();await f.agent.whenIdle()
 assert.deepEqual(f.routes(),[fast]);f.dispose()
 const dispose=installVoiceModelRoutingHost(f.ctx,{...f.options,readAcceptedMessage:()=>undefined});t.after(dispose)
 const {agent:restored}=await f.ctx.agents.create({sessionId:SessionId('voice-restored'),seed:JSON.parse(JSON.stringify(f.agent.session.snapshotEvents())),agentOptions:base})
 f.adapter.scripts.push(textAnswer);await f.plain(restored);await restored.whenIdle()
 assert.deepEqual(f.routes(),[fast,base])
 assert.equal(restored.session.snapshotEvents().flatMap(row=>pluginRecordOf(row)??[]).length,1,'冷记录只恢复baseline，不签发新的voice路由')
})

test('host installer覆盖以后创建的原Agent；停用后普通消息恢复且不创建额外Agent',async t=>{
 const f=await setup(t),before=f.ctx.agents.list().length
 const {agent}=await f.ctx.agents.create({sessionId:SessionId('voice-new-existing'),agentOptions:base})
 f.adapter.scripts.push(textAnswer,textAnswer)
 await f.sendVoice(agent);await agent.whenIdle();f.disable();await f.plain(agent);await agent.whenIdle()
 assert.deepEqual(f.routes(),[fast,base]);assert.equal(f.ctx.agents.list().length,before+1)
})

test('原生selection未指定思考档位时普通文字清掉临时off，不把档位写回本人选择',async t=>{
 const f=await setup(t)
 await f.controller.selectModel({sessionId:f.agent.id,provider:'minimax',model:'MiniMax-M2.5'})
 f.adapter.scripts.push(textAnswer,textAnswer)
 await f.sendVoice();await f.agent.whenIdle();await f.plain();await f.agent.whenIdle()
 assert.deepEqual(f.routes(),[fast,{provider:'minimax',model:'MiniMax-M2.5',reasoningEffort:undefined}])
 assert.equal(Object.hasOwn(f.agent.session.requestHeader()!.config,'reasoningEffort'),false)
})

test('installer卸载后原Agent的普通输入仍撤销fast；后继挂载不受旧dispose影响',async t=>{
 const f=await setup(t)
 f.adapter.scripts.push(textAnswer,textAnswer,textAnswer,textAnswer)
 await f.sendVoice();await f.agent.whenIdle();f.dispose()
 await f.plain();await f.agent.whenIdle()
 assert.deepEqual(f.routes(),[fast,base])
 const dispose=installVoiceModelRoutingHost(f.ctx,f.options);t.after(dispose)
 f.dispose();await f.sendVoice();await f.agent.whenIdle();await f.plain();await f.agent.whenIdle()
 assert.deepEqual(f.routes(),[fast,base,fast,base])
})

test('M3元数据等待期间本人改同模型effort：交还原生当步快照，后续普通输入保留新档位',async t=>{
 const f=await setup(t),gate=hotGate();t.after(gate.release)
 f.adapter.scripts.push(textAnswer,textAnswer,textAnswer)
 await f.plain();await f.agent.whenIdle();f.adapter.resolveFastGate=gate
 await f.sendVoice();await gate.entered
 const chosen={...base,reasoningEffort:ReasoningEffortId('off')}
 await f.controller.selectModel({sessionId:f.agent.id,...chosen});gate.release();await f.agent.whenIdle()
 await f.plain();await f.agent.whenIdle()
 assert.deepEqual(f.routes(),[base,base,chosen],'官方assembly已快照旧effort，本步直接继承原生；新selection在下一次assembly生效')
 assert.equal(f.agent.session.snapshotEvents().flatMap(row=>pluginRecordOf(row)??[]).length,0,'失效语音快照不能写入恢复记录')
})

test('候选模型等待期间卸载不恢复旧fast，也不取消已受理的原会话工作',async t=>{
 const f=await setup(t),gate=hotGate();t.after(gate.release)
 f.options.selectedFastModel=async()=>{await gate.wait();return {provider:'minimax',model:'MiniMax-M3'}}
 f.adapter.scripts.push(textAnswer,textAnswer)
 await f.sendVoice();await gate.entered;f.dispose();gate.release();await f.agent.whenIdle()
 await f.plain();await f.agent.whenIdle()
 assert.deepEqual(f.routes(),[base,base])
 assert.equal(f.agent.session.snapshotEvents().filter(row=>row.type==='turn/end'&&row.data.reason.kind!=='completed').length,0)
 assert.equal(f.agent.session.snapshotEvents().flatMap(row=>pluginRecordOf(row)??[]).length,0)
})

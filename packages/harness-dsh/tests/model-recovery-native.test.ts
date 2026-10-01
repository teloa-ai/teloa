import {createTaskRunModelReader} from '../src/task-run-model-status.ts'
import test,{type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import {Context} from '@deepseek-ai/cordis'
import {AgentRegistry,installModelSelection,type Agent} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {LlmRuntime,LlmAdapter,LlmError,ToolCallId,createUserMessage,type GenerateOptions,type StreamChunk,type LlmCallConfig} from '@deepseek-ai/dsh-llm'
import {SessionStore,SessionId} from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {ToolRuntime,defineTool} from '@deepseek-ai/dsh-tools'
import {installTaskModelRouting} from '../src/task-model-routing.ts'
import type {ModelRecovery} from '@teloa/contract'
import type {TaskRun} from '@teloa/backend'
import {dshTaskRunPorts} from '../src/task-run-dsh.ts'
import {createTaskModelRouting,taskModelRecoverySource} from '../src/task-model-dsh.ts'
import TeloaAttachmentStore from '../src/attachment-guard.ts'
import {tempHome,rand} from './fixtures/credentials.ts'

// 真实 DSH loop/工具/事件 + 产品模型路由；只用本地脚本替代外部推理。
const text:StreamChunk[]=[{type:'block-start',index:0,blockType:'text'},{type:'text-delta',index:0,text:'done'},{type:'block-end',index:0,block:{type:'text',text:'done'}},{type:'finish',reason:{kind:'stop'}}]
const tool:StreamChunk[]=[{type:'block-start',index:0,blockType:'tool-call'},{type:'tool-call-delta',index:0,id:ToolCallId('write-once'),name:'write_result',argumentsDelta:'{}'},{type:'block-end',index:0,block:{type:'tool-call',id:ToolCallId('write-once'),name:'write_result',arguments:'{}'}},{type:'finish',reason:{kind:'tool-calls'}}]
class Adapter extends LlmAdapter{
 requests:GenerateOptions[]=[]
 scripts:(StreamChunk[]|Error)[]=[]
 override async resolveModel(provider:string,model:string){if(model==='missing')throw new LlmError('missing','UNKNOWN_MODEL');return {provider,id:model,name:model,inputModalities:provider==='default'||model==='text-only'?['text'] as const:['text','image'] as const}}
 async *stream(options:GenerateOptions):AsyncIterable<StreamChunk>{this.requests.push(options);const result=this.scripts.shift();assert.ok(result,'模型调用超出预期');if(result instanceof Error)throw result;yield* result}
}
async function setup(t:TestContext,persistent=false){
 const ctx=new Context();t.after(()=>ctx.fiber.dispose())
 if(persistent)await ctx.plugin(JsonlSessionPersistence,{root:(await tempHome(t))+'/sessions',compression:'none'})
 await ctx.plugin(LlmRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 const adapter=new Adapter();ctx.llm.registerAdapter(['local','remote','default'],adapter)
 let writes=0
 ctx.tools.register(defineTool({name:'write_result',description:'一次副作用',parameters:{},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async()=>{writes++;return 'saved-once'}}))
 const {agent}=await ctx.agents.create({sessionId:SessionId('recovery-test'),agentOptions:{provider:'default',model:'default-model'}})
 // 与 SessionController 使用同一官方选择 middleware；不得通过 selectModel 改全局默认。
 const selection={current:{provider:'default',model:'default-model'},assembled:undefined}
 installModelSelection(agent.ctx,selection)
 return {ctx,agent,adapter,selection,writes:()=>writes}
}
function scopedRecovery(agent:Agent,initial:LlmCallConfig,fallback:LlmCallConfig){
 const switches:ModelRecovery[]=[]
 const routing=installTaskModelRouting(agent,{primary:initial,fallback},{isRemote:async()=>true,requiresImages:()=>false,recordRecovery:async recovery=>{switches.push(recovery)}})
 return {...routing,switches}
}
async function run(agent:Agent){agent.followup(createUserMessage({source:{kind:'user',rpcId:'same-request'},content:[{type:'text',text:'先保存，再整理结果'}]}));await agent.whenIdle()}

test('官方同一步重试只切模型，已完成工具和原消息不重放，其他 Agent 不受影响',async t=>{
 const {ctx,agent,adapter,selection,writes}=await setup(t)
 agent.ctx.on('agent/request',async(_payload,next)=>({...await next(),temperature:0.2,maxTokens:256,stop:['END']}))
 const recovery=scopedRecovery(agent,{provider:'local',model:'small'},{provider:'remote',model:'large'});t.after(recovery.dispose)
 adapter.scripts.push(tool,new LlmError('本地推理超时','TIMEOUT'),text)
 await run(agent)
 assert.deepEqual(adapter.requests.map(row=>[row.provider,row.model]),[['local','small'],['local','small'],['remote','large']])
 assert.equal(writes(),1)
 assert.ok(adapter.requests.every(request=>request.temperature===0.2&&request.maxTokens===256&&JSON.stringify(request.stop)===JSON.stringify(['END'])),'切换保留岗位输出预算和采样参数')
 assert.ok(JSON.stringify(adapter.requests[2]!.messages).includes('saved-once'))
 const events=agent.session.snapshotEvents()
 assert.equal(events.filter(row=>row.type==='user/message'&&row.data.source.kind==='model-selection').length,0,'部署默认不得在受管任务里生成错误的切回通知')
 assert.equal(events.filter(row=>row.type==='turn/start').length,1)
 assert.equal(events.filter(row=>row.type==='step/start').length,2)
 assert.equal(events.filter(row=>row.type==='user/message'&&row.data.source.kind==='user').length,1)
 assert.equal(events.at(-1)?.type,'turn/end')
 assert.deepEqual(recovery.switches,[{from:{provider:'local',model:'small'},to:{provider:'remote',model:'large'},reason:'TIMEOUT'}])
 assert.deepEqual(selection.current,{provider:'default',model:'default-model'})
 const {agent:other}=await ctx.agents.create({sessionId:SessionId('untouched'),agentOptions:{provider:'default',model:'default-model'}})
 adapter.scripts.push(text);await run(other)
 assert.equal(adapter.requests.at(-1)?.provider,'default')
})

test('真实首个 prepare 前不可用可局部换模型；备用也失败时不再重试',async t=>{
 const {agent,adapter}=await setup(t)
 const recovery=scopedRecovery(agent,{provider:'local',model:'missing'},{provider:'remote',model:'large'});t.after(recovery.dispose)
 adapter.scripts.push(new LlmError('备用也超时','TIMEOUT'))
 await run(agent)
 assert.deepEqual(adapter.requests.map(row=>row.provider),['remote'])
 assert.equal(recovery.switches.length,1)
 const end=agent.session.snapshotEvents().filter(row=>row.type==='turn/end').at(-1)
 assert.equal(end?.data.reason.kind,'error')
})

for(const code of ['AUTH','ABORTED','INVALID_REQUEST','UNKNOWN','PI_AI_ERROR'])test(`官方故障码 ${code} 不误切远程`,async t=>{
 const {agent,adapter}=await setup(t)
 const recovery=scopedRecovery(agent,{provider:'local',model:'small'},{provider:'remote',model:'large'});t.after(recovery.dispose)
 adapter.scripts.push(new LlmError('失败',code))
 await run(agent)
 assert.deepEqual(adapter.requests.map(row=>row.provider),['local']);assert.equal(recovery.switches.length,0)
})

test('岗位未配置远程备用：本地故障直接失败并说明原因，零远程请求、无切换记录',async t=>{
 const {agent,adapter}=await setup(t)
 const switches:ModelRecovery[]=[]
 const routing=installTaskModelRouting(agent,{primary:{provider:'local',model:'small'}},{isRemote:async()=>true,requiresImages:()=>false,recordRecovery:async recovery=>{switches.push(recovery)}});t.after(routing.dispose)
 adapter.scripts.push(new LlmError('本地模型服务异常','SERVER'))
 await run(agent)
 assert.deepEqual(adapter.requests.map(row=>[row.provider,row.model]),[['local','small']]);assert.equal(switches.length,0)
 const end=agent.session.snapshotEvents().filter(event=>event.type==='turn/end').at(-1) as {data:{reason:{kind:string;error?:{code:string}}}}|undefined
 assert.equal(end?.data.reason.kind,'error');assert.equal(end?.data.reason.error?.code,'SERVER')
})

test('显式取消不经过故障兜底，也不会发送远程请求',async t=>{
 const {agent,adapter}=await setup(t)
 const recovery=scopedRecovery(agent,{provider:'local',model:'small'},{provider:'remote',model:'large'});t.after(recovery.dispose)
 let began!:()=>void;const started=new Promise<void>(resolve=>{began=resolve})
 adapter.stream=async function*(options:GenerateOptions):AsyncIterable<StreamChunk>{adapter.requests.push(options);began();await new Promise<void>((_resolve,reject)=>{if(options.signal?.aborted)reject(options.signal.reason);else options.signal?.addEventListener('abort',()=>reject(options.signal!.reason),{once:true})})}
 const running=run(agent);await started;agent.cancel({kind:'user'});await running
 assert.equal(recovery.switches.length,0);assert.equal(adapter.requests.length,1)
 assert.equal(agent.session.snapshotEvents().filter(row=>row.type==='turn/end').at(-1)?.data.reason.kind,'aborted')
})

test('备用不支持本轮图片时保留失败，不能静默去图再答',async t=>{
 const {agent,adapter}=await setup(t),switches:ModelRecovery[]=[]
 const routing=installTaskModelRouting(agent,{primary:{provider:'local',model:'small'},fallback:{provider:'remote',model:'text-only'}},{isRemote:async()=>true,requiresImages:()=>true,recordRecovery:async row=>{switches.push(row)}})
 t.after(routing.dispose);adapter.scripts.push(new LlmError('超时','TIMEOUT'))
 await run(agent);assert.equal(adapter.requests.length,1);assert.deepEqual(switches,[])
})

async function runPorts(t:TestContext){
 const fixture=await setup(t,true),{ctx,agent}=fixture
 await ctx.plugin(TeloaAttachmentStore,{dshHome:await tempHome(t)})
 ctx.llm.registerConfigurableProviders([{provider:'remote',displayName:'远程',settingsNs:'llm-pi-ai',settingsPath:['providers','remote'],declared:true}])
 let controllerCalls=0
 const host={sessions:ctx.sessions,agents:ctx.agents,attachments:ctx.attachments,llm:ctx.llm,settings:{describe:()=>[{ns:'llm-pi-ai',value:{providers:{remote:{baseURL:'https://example.test'}}}}]},sessionController:{resolveAgent:async()=>({agent}),prompt:async()=>{controllerCalls++;throw Error('不能沿用部署默认的准入')}}} as unknown as Context
 const ports=dshTaskRunPorts(host,'owner',async()=>({ownerId:'owner',sessionId:'recovery-test',status:'ready'}))
 const task:TaskRun={id:'run-one',roleId:'role',taskId:'task',taskVersion:1,roleVersion:1,linkVersion:1,sessionId:'recovery-test',nativeRequestId:'native-request',state:'prepared',evidence:null,stopRequestedAt:null,allowedTools:['write_result'],skills:[],knowledge:[],memory:[],inputText:'先保存，再整理结果',createdAt:new Date().toISOString(),modelPolicy:{primary:{provider:'local',model:'small'},fallback:{provider:'remote',model:'large'}}}
 const target={taskId:'task',taskVersion:1,sessionId:'recovery-test',linkVersion:1,scope:'general'}
 return {...fixture,host,ports,task,target,controllerCalls:()=>controllerCalls}
}

test('真实 Run 发送经过附件密钥闸、原生队列与产品恢复器；收到同一轮切换记录',async t=>{
 const {ctx,host,agent,adapter,ports,task,target,writes,selection,controllerCalls}=await runPorts(t)
 const models=createTaskRunModelReader(host)
 assert.deepEqual(await models.read(task),{state:'unobserved'})
 adapter.scripts.push(tool,new LlmError('本地故障','TRANSPORT'),text)
 await ports.send(task,new AbortController().signal,target);await agent.whenIdle()
 assert.equal(controllerCalls(),0);assert.equal(writes(),1)
 assert.deepEqual(adapter.requests.map(row=>row.provider),['local','local','remote'])
 const events=agent.session.snapshotEvents(),notices=events.filter(event=>event.type==='user/message'&&event.data.source.kind===taskModelRecoverySource)
 assert.equal(notices.length,1);assert.equal(events.filter(event=>event.type==='turn/start').length,1)
 assert.ok(JSON.stringify(adapter.requests.at(-1)!.messages).includes('已切换到 large'))
 assert.equal(events.filter(event=>event.type==='user/message'&&event.data.source.kind==='user').length,1)
 assert.deepEqual(selection.current,{provider:'default',model:'default-model'})
 assert.equal(agent.session.requestHeader()?.config.provider,'remote')
 const status=await models.read(task)
 assert.equal(status?.state,'observed')
 if(status?.state==='observed'){
  assert.equal(status.model.provider,'remote');assert.equal(status.recovery?.reason,'TRANSPORT')
  assert.equal(events[status.requestSeq]?.type,'request/header')
 }
 await (Reflect.get(ctx,'sessions') as unknown as SessionStore).flush(agent.session)
 // 强制走真实 JSONL 只读句柄，证明卸载/重启后的持久读取不需要恢复 Agent。
 const unloaded={sessions:{get:()=>undefined},sessionPersistence:ctx.sessionPersistence} as unknown as Context
 assert.deepEqual(await createTaskRunModelReader(unloaded).read(task),status)

})

test('任务纯文本也经过凭据拦截，失败不入队、不落用户消息、不发送远程',async t=>{
 const {agent,adapter,ports,task,target}=await runPorts(t)
 await assert.rejects(ports.send({...task,inputText:'key gh'+'p_'+rand(36)},new AbortController().signal,target),(error:any)=>error.code==='gateway/bad-request')
 assert.equal(adapter.requests.length,0)
 assert.equal(agent.session.snapshotEvents().filter(event=>event.type==='user/message').length,0)
})

test('持久切换记录恢复后从远程继续，不重新用本机模型；父任务不能覆盖子 Agent 的选模',async t=>{
 const {ctx,host,agent,adapter,task}=await runPorts(t)
 const first=createTaskModelRouting(host)(agent,task)!
 adapter.scripts.push(new LlmError('超时','TIMEOUT'),text)
 await run(agent);first.dispose()
 const restored=createTaskModelRouting(host),state=restored(agent,task)!
 assert.deepEqual(state.routing.current(),task.modelPolicy!.fallback)
 adapter.scripts.push(new LlmError('备用也失败','TIMEOUT'))
 await run(agent)
 assert.deepEqual(adapter.requests.map(row=>row.provider),['local','remote','remote'])
 assert.equal(agent.session.snapshotEvents().filter(event=>event.type==='user/message'&&event.data.source.kind===taskModelRecoverySource).length,1)
 const {agent:child}=await ctx.agents.create({sessionId:SessionId('separate-child'),agentOptions:{provider:'default',model:'child-choice'}})
 assert.equal(restored(child,task),undefined)
 adapter.scripts.push(text);await run(child)
 assert.equal(adapter.requests.at(-1)!.model,'child-choice')
})

test('任务选视觉模型时图片经原生附件存储进同一请求，不受部署默认纯文本模型影响',async t=>{
 const {agent,adapter,ports,task,target}=await runPorts(t)
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC','base64')
 const file={kind:'attachment',id:'image-one',mime:'image/png',name:'test.png',bytes:png.length,width:1,height:1}
 task.groupContext={files:[file]} as NonNullable<TaskRun['groupContext']>
 let reads=0,noVision=0
 ports.groupPrompt={readAttachmentImageBytes:async()=>{reads++;return png},readArtifactImageBytes:async()=>{throw Error('未授权的读取')},markNoVision:()=>{noVision++}}
 adapter.scripts.push(text)
 await ports.send(task,new AbortController().signal,target);await agent.whenIdle()
 assert.equal(reads,1);assert.equal(noVision,0);assert.equal(adapter.requests.length,1)
 const input=agent.session.snapshotEvents().find(event=>event.type==='user/message'&&event.data.source.kind==='user')
 assert.ok(input?.type==='user/message'&&input.data.content.some(part=>part.type==='image'))
 assert.equal(adapter.requests[0]!.provider,'local')
})

test('首选在模型解析阶段不可用，首次远程请求也能显示持久原因',async t=>{
 const {host,agent,adapter,ports,task,target}=await runPorts(t)
 const fixed={...task,modelPolicy:{primary:{provider:'local',model:'missing'},fallback:task.modelPolicy!.fallback!}}
 adapter.scripts.push(text)
 await ports.send(fixed,new AbortController().signal,target);await agent.whenIdle()
 assert.deepEqual(adapter.requests.map(row=>row.provider),['remote'])
 const status=await createTaskRunModelReader(host).read(fixed)
 assert.equal(status?.state,'observed')
 if(status?.state==='observed'){
  assert.equal(status.model.provider,'remote');assert.equal(status.recovery?.reason,'UNKNOWN_MODEL')
  assert.deepEqual(status.recovery?.from,fixed.modelPolicy.primary)
 }
})

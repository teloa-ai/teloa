import test from 'node:test'
import assert from 'node:assert/strict'
import {setImmediate as immediate} from 'node:timers/promises'
import {mkdtemp,rm} from 'node:fs/promises'
import {Context} from '@deepseek-ai/cordis'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {SessionStore,SessionId,SessionSeq,SessionLogOffset,type SessionEvent} from '@deepseek-ai/dsh-session'
import {SessionController} from '@deepseek-ai/dsh-api-session-controller'
import {SubagentRuntime} from '@deepseek-ai/dsh-subagent'
import {createUserMessage,LlmAdapter} from '@deepseek-ai/dsh-llm'
import Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as SpawnProvider from '@deepseek-ai/dsh-subagent-spawn-in-process'
import {workAccess,type WorkAccessRequest} from '@teloa/backend'
import {TeloaNativeInput} from '../src/native-input-provider.ts'
import {createManagedSessionController,ManagedSessionController} from '../src/managed-session-controller.ts'
import {createManagedSubagentRuntime,ManagedSubagentRuntime} from '../src/managed-subagent.ts'
import {nativeProviderFixture,nativeProviderKernel} from './fixtures/native-input-provider.ts'
import {patchedCorePackages} from './fixtures/native-final-session.ts'
import {patchedControllerPackage,promptRequest,queueRequest,type AdmittingSessionController} from './fixtures/native-controller-admission.ts'
import {patchedSubagent,deferred,until} from './fixtures/native-subagent-admission.ts'

class NoModel extends LlmAdapter{
 calls=0
 override async resolveModel(provider:string,model:string){return {provider,id:model,name:model}}
 async *stream():AsyncIterable<never>{this.calls++;throw Error('本批禁止模型请求')}
}
const signal=new AbortController().signal,forbidden={code:'teloa/forbidden'},unavailable={code:'teloa/unavailable'}
let valid=true,epoch=0
let waiting:undefined|{entered:ReturnType<typeof deferred>;release:ReturnType<typeof deferred>}
const seen:WorkAccessRequest[]=[]
// 与正式 Service 一样消费 backend 单例；每个 Node test 文件的隔离 module graph 只安装一次。
workAccess.requirePolicy()
workAccess.installPolicy(async request=>{
 const issuedAt=epoch,wait=waiting;seen.push(request)
 if(wait){wait.entered.resolve(undefined);await wait.release.promise}
 return {assertCurrent(){if(!valid||issuedAt!==epoch)throw Error('revoked')}}
})
const reset=()=>{valid=true;epoch++;waiting=undefined;seen.length=0}
const message=(rpcId:string)=>createUserMessage({source:{kind:'user',rpcId},content:[{type:'text',text:'私有输入'}]})
const managedController=async(f:Awaited<ReturnType<typeof nativeProviderFixture>>,t:Parameters<typeof nativeProviderFixture>[0])=>{
 const sdk=await patchedControllerPackage(t),Managed=createManagedSessionController(sdk.SessionController)
 const fiber=f.ctx.plugin(Managed,{nativeOpen:false});await fiber
 return {fiber,controller:Reflect.get(f.ctx,'sessionController') as AdmittingSessionController,Managed,sdk}
}

for(const delayed of ['llm','tools'] as const)test(`真实 Cordis 延迟 ${delayed} 时 provider 等待，补齐后允许依赖 provider 的 Loop 启动`,{timeout:10000},async t=>{
 reset()
 const {sessionPackage,llmPackage,toolsPackage,loopPackage}=await patchedCorePackages(t),ctx=new Context()
 t.after(()=>ctx.fiber.dispose())
 const delayedPlugin=delayed==='llm'?llmPackage.LlmRuntime:toolsPackage.ToolRuntime
 for(const plugin of [sessionPackage.SessionStore,SessionProjectionRegistry,SystemPrompt,AgentRegistry,llmPackage.LlmRuntime,toolsPackage.ToolRuntime]){
  if(plugin!==delayedPlugin)await ctx.plugin(plugin)
 }
 const provider=ctx.plugin(TeloaNativeInput);await provider
 assert.equal(ctx.get(delayed),undefined);assert.equal(ctx.get('teloaNativeInput'),undefined)
 await ctx.plugin(delayedPlugin);await provider
 assert.ok(ctx.get('teloaNativeInput'));assert.equal(ctx.get('agentLoop'),undefined)
 // Loop 依赖已发布的 provider；provider 不能反向静态依赖 Loop 而形成启动环。
 const configured={inject:[...loopPackage.AgentLoop.inject,'teloaNativeInput'],Config:loopPackage.AgentLoop.Config,
  apply(child:Context,config:ConstructorParameters<typeof loopPackage.AgentLoop>[1]){new loopPackage.AgentLoop(child,config)}}
 await ctx.plugin(configured,{agents:[]})
 const model=new NoModel();ctx.llm.registerAdapter(['test'],model)
 const {agent}=await ctx.agents.create({sessionId:SessionId('delayed-'+delayed),agentOptions:{provider:'test',model:'fixed'}})
 void agent.runMaintenance(abort=>new Promise<void>(done=>abort.addEventListener('abort',()=>done(),{once:true})))
 const input=message('ready-'+delayed)
 await ctx.teloaNativeInput.input.withNewInput(agent,input,{producer:'task-run',identity:'first-ready'},()=>{agent.inbox.append('next-turn',input)})
 assert.equal(agent.inbox.nextTurn[0]?.id,input.id);assert.equal(seen.length,1);assert.equal(model.calls,0)
})

test('真实 plugin graph 在 provider 发布前等待；首次 Controller service 通知就使用固定策略',async t=>{
 reset()
 const f=await nativeProviderFixture(t),sdk=await patchedControllerPackage(t),Managed=createManagedSessionController(sdk.SessionController)
 assert.deepEqual(Managed.inject,[...sdk.SessionController.inject,'teloaNativeInput'])
 const fiber=f.ctx.plugin(Managed,{nativeOpen:false});await fiber
 assert.equal(f.ctx.get('sessionController'),undefined)
 let first:Promise<unknown>|undefined,observations=0,proved=false
 const stopObserver=f.ctx.on('internal/service',(name,value)=>{
  if(name!=='sessionController'||!value)return
  observations++
  const controller=value as AdmittingSessionController
  assert.throws(()=>controller.installInputAdmission(async()=>{}),{name:'Error',message:'Session input admission is already installed or invalid'})
  proved=true
  first=controller.prompt(promptRequest(f.agent,'first-service'),signal)
 })
 try{await f.ctx.plugin(TeloaNativeInput);await fiber;await first}finally{await stopObserver()}
 assert.equal(observations,1);assert.equal(proved,true);assert.equal(seen.length,1);assert.equal(f.agent.inbox.nextTurn.length,1)
 assert.equal(seen[0]?.kind,'native-input')
 if(seen[0]?.kind==='native-input')assert.equal(seen[0].producer,'prompt')
})

test('单一 Service holder 原始与scoped不可替换；Controller queue-edit 与Task共享一个input',async t=>{
 reset()
 const f=await nativeProviderFixture(t)
 await f.ctx.plugin(TeloaNativeInput)
 const provider=f.ctx.teloaNativeInput,scoped=f.ctx.extend().teloaNativeInput,{controller}=await managedController(f,t)
 assert.equal(provider.input,scoped.input);assert.equal(provider.admissions,scoped.admissions)
 assert.equal(Object.isFrozen(provider.input),true);assert.equal(Object.isFrozen(provider.admissions),true)
 for(const receiver of [provider,scoped]){
  assert.equal(Reflect.set(receiver,'input',{}),false);assert.equal(Reflect.set(receiver,'admissions',{}),false)
  assert.throws(()=>Object.defineProperty(receiver,'input',{value:{}}))
 }
 await controller.prompt(promptRequest(f.agent,'new-prompt','原稿'),signal)
 const original=f.agent.inbox.nextTurn[0]!
 await controller.updateQueue(queueRequest(f.agent,original.id,'已编辑'))
 const input=message('task-run')
 await provider.input.withNewInput(f.other,input,{producer:'task-run',identity:'exact-run'},()=>{f.other.inbox.append('next-turn',input)})
 assert.deepEqual(seen.map(row=>row.kind==='native-input'?row.producer:row.kind),['prompt','queue','task-run'])
 assert.equal(f.agent.inbox.nextTurn.length,1);assert.equal(f.other.inbox.nextTurn[0]?.id,input.id)
 assert.ok(!JSON.stringify(seen).includes('已编辑'))
})

test('Service 许可await期间撤销：真实首次输入零写，旧本目标receipt仍可只读返回',async t=>{
 reset()
 const f=await nativeProviderFixture(t);await f.ctx.plugin(TeloaNativeInput)
 const {controller}=await managedController(f,t)
 await controller.prompt(promptRequest(f.agent,'accepted'),signal)
 const before=f.agent.session.seq,original=f.agent.inbox.nextTurn[0]!
 waiting={entered:deferred(),release:deferred()};t.after(()=>waiting?.release.resolve(undefined))
 const pending=controller.prompt(promptRequest(f.agent,'revoked'),signal),denied=assert.rejects(pending,forbidden)
 await waiting.entered.promise;valid=false;epoch++;waiting.release.resolve(undefined);await denied;waiting=undefined
 assert.equal(f.agent.session.seq,before);assert.equal(f.agent.inbox.nextTurn[0],original)
 const calls=seen.length
 await controller.prompt(promptRequest(f.agent,'accepted'),signal);assert.equal(seen.length,calls);assert.equal(f.agent.session.seq,before)
 await assert.rejects(controller.updateQueue(queueRequest(f.agent,original.id,'撤销编辑')),forbidden)
 assert.equal(f.agent.inbox.nextTurn[0],original)
})

test('provider 官方dispose关闭共享guard；cached input与controller均不能新增，read/remove保持',async t=>{
 reset()
 const f=await nativeProviderFixture(t),fiber=f.ctx.plugin(TeloaNativeInput);await fiber
 const provider=f.ctx.teloaNativeInput,{controller}=await managedController(f,t)
 await controller.prompt(promptRequest(f.agent,'accepted'),signal)
 const original=f.agent.inbox.nextTurn[0]!,before=f.agent.session.seq
 await fiber.dispose()
 assert.equal(f.ctx.get('teloaNativeInput'),undefined);assert.equal(f.ctx.get('sessionController'),undefined)
 await assert.rejects(controller.prompt(promptRequest(f.agent,'after-dispose'),signal),/inactive context/)
 const input=message('cached')
 await assert.rejects(provider.input.withNewInput(f.agent,input,{producer:'task-run',identity:'cached'},()=>{f.agent.inbox.append('next-turn',input)}))
 assert.equal(f.agent.session.seq,before);assert.equal(f.agent.inbox.nextTurn[0],original)
 f.agent.inbox.remove(original.id)
 assert.equal(f.agent.inbox.nextTurn.length,0)
})

test('缺最终Session补口不发布provider；缺官方Controller/Subagent补口在super之前拒绝',async t=>{
 reset()
 const {llmPackage,toolsPackage}=await patchedCorePackages(t)
 const bare=new Context();t.after(()=>bare.fiber.dispose())
 for(const plugin of [llmPackage.LlmRuntime,SystemPrompt,toolsPackage.ToolRuntime,SessionStore])await bare.plugin(plugin)
 assert.ok(bare.get('llm'));assert.ok(bare.get('tools'))
 bare.provide('agents',{} as never)
 await assert.rejects(bare.plugin(TeloaNativeInput).await(),forbidden)
 assert.equal(bare.get('teloaNativeInput'),undefined)
 const f=await nativeProviderFixture(t);await f.ctx.plugin(TeloaNativeInput)
 assert.throws(()=>new ManagedSessionController(f.ctx,{nativeOpen:false}),unavailable)
 assert.equal(f.ctx.get('sessionController'),undefined)
 assert.throws(()=>new ManagedSubagentRuntime(f.ctx,{maxDepth:{get:()=>2},maxActiveSubagents:{get:()=>8}}),unavailable)
 assert.equal(f.ctx.get('subagents'),undefined)
 assert.equal(seen.length,0)
})

test('真实 managed Subagent plugin 在provider之前等待，首次通知已有固定构造policy/manager',async t=>{
 reset()
 const f=await nativeProviderFixture(t),sdk=await patchedSubagent(t),Managed=createManagedSubagentRuntime(sdk.SubagentRuntime as typeof SubagentRuntime)
 assert.deepEqual(Reflect.get(Managed,'inject'),['teloaNativeInput'])
 const fiber=f.ctx.plugin(Managed,{maxDepth:2,maxActiveSubagents:8});await fiber
 assert.equal(f.ctx.get('subagents'),undefined)
 let notifications=0,proved=false
 f.ctx.on('internal/service',(name,value)=>{
  if(name!=='subagents'||!value)return
  notifications++
  const service=value as SubagentRuntime&{requirePromptAdmission:()=>void;installPromptAdmission:(policy:unknown)=>void}
  assert.throws(()=>service.installPromptAdmission(async()=>{}),{name:'SubagentError',code:'CONTINUATION_UNAVAILABLE',message:'subagent prompt admission provider is unavailable'})
  assert.equal(Reflect.set(service,'promptAdmission',{}),false)
  proved=true
 })
 await f.ctx.plugin(TeloaNativeInput);await fiber;await immediate()
 assert.equal(notifications,1);assert.equal(proved,true);assert.ok(Reflect.get(f.ctx.subagents,'continuations'))
 assert.equal(seen.length,0)
})

test('managed Subagent首次start核对独立初始许可，拒绝零写、恢复后唯一受理',async t=>{
 reset()
 const f=await nativeProviderFixture(t),sdk=await patchedSubagent(t),Managed=createManagedSubagentRuntime(sdk.SubagentRuntime as typeof SubagentRuntime)
 const root=await mkdtemp('/private/tmp/teloa-provider-persistence-')
 t.after(()=>rm(root,{recursive:true,force:true}))
 await f.ctx.plugin(Persistence,{root});await f.ctx.plugin(TeloaNativeInput);await f.ctx.plugin(Managed,{maxDepth:2,maxActiveSubagents:8})
 await f.ctx.plugin(SpawnProvider,{providerName:'spawn'})
 valid=false
 const id=SessionId('initial-admission-denied')
 await assert.rejects(f.ctx.subagents.startContinuable({provider:'spawn',childId:id,label:'initial admission denied',request:{parent:f.agent,prompt:[{type:'text',text:'不能凭seed放行'}]},signal}),forbidden)
 assert.equal(seen.length,1)
 assert.equal(seen[0]?.kind,'native-input')
 if(seen[0]?.kind==='native-input')assert.equal(seen[0].producer,'subagent')
 const child=f.ctx.agents.get(id)
 if(child)assert.equal(child.inbox.nextTurn.length,0)
 // Session setup 本身不授予许可；首次 prompt 必须通过独立许可，失败时没有 Inbox 写入。
 assert.equal(f.agent.inbox.nextTurn.length,0)
 const acceptedId=SessionId('initial-admission-accepted')
 const model=new NoModel();f.ctx.llm.registerAdapter(['test'],model)
 waiting={entered:deferred(),release:deferred()};t.after(()=>waiting?.release.resolve(undefined))
 valid=true
 const starting=f.ctx.subagents.startContinuable({provider:'spawn',childId:acceptedId,label:'initial admission accepted',request:{parent:f.agent,prompt:[{type:'text',text:'真实首次许可通过'}]},signal})
 await waiting.entered.promise
 // 官方 initializeAgent 的 maintenance 已退出，首次准入尚未放行，此时才持有测试屏障。
 const admitted=f.ctx.agents.get(acceptedId)!
 void admitted.runMaintenance(abort=>new Promise<void>(done=>abort.addEventListener('abort',()=>done(),{once:true})))
 waiting.release.resolve(undefined);const accepted=await starting;waiting=undefined
 assert.equal(accepted.childId,admitted.id);assert.equal(model.calls,0)
 assert.equal(seen.length,2);assert.equal(admitted.inbox.nextTurn.length,1)
 assert.deepEqual(admitted.inbox.nextTurn[0]?.content,[{type:'text',text:'真实首次许可通过'}])
 assert.equal(admitted.session.snapshotEvents().filter(event=>event.type==='agent/inbox/spliced'&&event.data.inserted.length).length,1)
})

test('Free原官方Controller缺provider仍可发送；managed类不替换官方原型/静态Config',async t=>{
 reset()
 const f=await nativeProviderFixture(t),controller=new SessionController(f.ctx,{nativeOpen:false})
 await controller.prompt(promptRequest(f.agent,'free'),signal)
 assert.equal(f.agent.inbox.nextTurn.length,1);assert.equal(seen.length,0)
 assert.equal(Reflect.get(SessionController.prototype,'requireInputAdmission'),undefined)
 assert.equal(Reflect.get(SubagentRuntime.prototype,'requirePromptAdmission'),undefined)
 assert.equal(ManagedSessionController.Config,SessionController.Config)
 assert.equal(ManagedSubagentRuntime.Config,SubagentRuntime.Config)
})

test('过渡创建屏障：fresh/fork seed任意pending与真实持久冷resume都拒绝，保留已落seed且零模型',async t=>{
 reset()
 const f=await nativeProviderFixture(t),model=new NoModel(),root=await mkdtemp('/private/tmp/teloa-provider-seed-')
 t.after(()=>rm(root,{recursive:true,force:true}))
 f.ctx.llm.registerAdapter(['controlled'],model)
 await f.ctx.plugin(Persistence,{root});await f.ctx.plugin(TeloaNativeInput)
 for(const target of ['next-turn','next-step'] as const)for(const inherited of [false,true]){
  const id=SessionId('pending-'+target+'-'+inherited),input=message('seed-not-a-permit')
  const seed:SessionEvent[]=[{type:'agent/inbox/spliced',seq:SessionSeq(0),time:1,data:{target,start:0,removedCount:0,inserted:[input]}}]
  const options={sessionId:id,agentOptions:{provider:'controlled',model:'fixed'},seed,
   ...(inherited?{meta:{isSeeded:true,parentSession:f.agent.id},inheritedEventCount:SessionLogOffset(seed.length)}:{})}
  await assert.rejects(f.ctx.agents.create(options),forbidden)
  assert.equal(f.ctx.agents.get(id),undefined);assert.equal(f.sessions.get(id),undefined)
  const snapshot=await f.ctx.sessionPersistence.stat(id);assert.ok(snapshot)
  const reader=await f.ctx.sessionPersistence.open(id,'read')
  const stored=await reader.read();await reader.close()
  assert.equal(stored.events[0]?.type,'agent/inbox/spliced')
  if(stored.events[0]?.type==='agent/inbox/spliced')assert.equal(stored.events[0].data.inserted[0]?.id,input.id)
  // 创建拒绝后的官方 dispose 会取消 pending，并追加移除日志；不能把此残留冒充 cold pending。
  const coldId=SessionId('cold-'+target+'-'+inherited)
  const header={...f.sessionPackage.Session.create(coldId).header,...inherited?{isSeeded:true,parentSession:f.agent.id}:{}}
  const cold=f.sessionPackage.Session.create(coldId,seed,header,SessionLogOffset(inherited?seed.length:0))
  const writer=await f.ctx.sessionPersistence.create(cold.header,{inheritedEventCount:cold.inheritedEventCount})
  await writer.append(cold.snapshotEvents());await writer.flush();await writer.close()
  await assert.rejects(f.ctx.agents.resume({resumeSessionId:coldId,agentOptions:{provider:'controlled',model:'fixed'}}),forbidden)
  assert.equal(f.ctx.agents.get(coldId),undefined);assert.equal(f.sessions.get(coldId),undefined)
  const after=await f.ctx.sessionPersistence.open(coldId,'read'),rejected=(await after.read()).events
  await after.close()
  assert.deepEqual(rejected.slice(0,seed.length),seed)
  assert.equal(rejected.filter(event=>event.type==='agent/inbox/spliced'&&event.data.inserted.length>0).length,1)
 }
 assert.equal(model.calls,0);assert.equal(seen.length,0)
})

test('空seed及已完成history正常创建但不获得新工作许可，空Agent后续合法prompt照常受理',async t=>{
 reset()
 const f=await nativeProviderFixture(t),model=new NoModel()
 f.ctx.llm.registerAdapter(['controlled'],model);await f.ctx.plugin(TeloaNativeInput)
 const {controller}=await managedController(f,t)
 const blank=await f.ctx.agents.create({sessionId:SessionId('empty-seed'),agentOptions:{provider:'controlled',model:'fixed'},seed:[]})
 const historical=message('already-completed'),seed=[
  {type:'turn/start',seq:SessionSeq(0),time:1,data:{turn:1}},
  {type:'user/message',seq:SessionSeq(1),time:1,data:historical,surfaceOp:'append'},
  {type:'turn/end',seq:SessionSeq(2),time:1,data:{turn:1,reason:{kind:'completed'}}},
 ] as const
 const completed=await f.ctx.agents.create({sessionId:SessionId('completed-history'),agentOptions:{provider:'controlled',model:'fixed'},seed})
 for(const handle of [blank,completed]){
  void handle.agent.runMaintenance(abort=>new Promise<void>(done=>abort.addEventListener('abort',()=>done(),{once:true})))
  t.after(()=>handle.dispose())
  assert.equal(handle.agent.inbox.nextTurn.length,0);assert.equal(handle.agent.inbox.nextStep.length,0)
 }
 valid=false
 await assert.rejects(controller.prompt(promptRequest(completed.agent,'fresh-history'),signal),forbidden)
 assert.equal(completed.agent.session.snapshotEvents().filter(event=>event.type==='user/message').length,1)
 valid=true;await controller.prompt(promptRequest(blank.agent,'first-empty'),signal)
 assert.equal(blank.agent.inbox.nextTurn.length,1);assert.equal(model.calls,0)
})

test('profile等价真实依赖图：agent-loop配置冷pending必须等待provider，created屏障拒绝自动wake', {timeout:10000},async t=>{
 reset()
 const f=await nativeProviderKernel(t),model=new NoModel(),root=await mkdtemp('/private/tmp/teloa-provider-configured-')
 t.after(()=>rm(root,{recursive:true,force:true}))
 f.ctx.llm.registerAdapter(['controlled'],model);await f.ctx.plugin(Persistence,{root})
 const id=SessionId('configured-pending'),input=message('configuration-not-a-permit')
 const seeded=f.sessionPackage.Session.create(id,[{type:'agent/inbox/spliced',seq:SessionSeq(0),time:1,data:{target:'next-turn',start:0,removedCount:0,inserted:[input]}}])
 const writer=await f.ctx.sessionPersistence.create(seeded.header)
 await writer.append(seeded.snapshotEvents());await writer.flush();await writer.close()
 const failed=deferred<unknown>()
 f.ctx.on('agent-loop/config-start-failed',({sessionId,error})=>{assert.equal(sessionId,id);failed.resolve(error)})
 // 和官方loader profile行相同：保留原class和Config，只追加明确的服务依赖。
 const configured={name:'managed-configured-loop',inject:[...f.loopPackage.AgentLoop.inject,'teloaNativeInput'],Config:f.loopPackage.AgentLoop.Config,
  apply(ctx:Context,config:ConstructorParameters<typeof f.loopPackage.AgentLoop>[1]){new f.loopPackage.AgentLoop(ctx,config)}}
 const loop=f.ctx.plugin(configured,{agents:[{id:'configured-label',resumeSessionId:id,provider:'controlled',model:'fixed'}]})
 await loop;assert.equal(f.ctx.get('agentLoop'),undefined);assert.equal(model.calls,0)
 await f.ctx.plugin(TeloaNativeInput);await loop
 const failure=await failed.promise
 assert.equal((failure as {code?:string}).code,'teloa/forbidden')
 assert.equal(f.ctx.agents.get(id),undefined);assert.equal(f.sessions.get(id),undefined)
 assert.equal(model.calls,0);assert.equal(seen.length,0)
})

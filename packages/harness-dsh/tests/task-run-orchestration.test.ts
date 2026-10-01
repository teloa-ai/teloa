import test,{type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {Context} from '@deepseek-ai/cordis'
import {LlmRuntime,LlmAdapter,ToolCallId,type GenerateOptions,type StreamChunk} from '@deepseek-ai/dsh-llm'
import {SessionStore,SessionId} from '@deepseek-ai/dsh-session'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {ToolRuntime,defineTool,type ToolExecution} from '@deepseek-ai/dsh-tools'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {LocalJobRegistry} from '@deepseek-ai/dsh-jobs-local'
import type {JobKind,JobOutcome} from '@deepseek-ai/dsh-jobs'
import {SubagentRuntime} from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import type {TaskRun,TaskRunRuntimeLinks,TaskRunRuntimeLink} from '@teloa/backend'
import {createTaskRunOrchestration} from '../src/task-run-orchestration.ts'
import type {TaskToolPolicy} from '../src/task-tool-guard.ts'
import type {SubagentDelegationPorts} from '../src/subagent-delegation.ts'

const deferred=<T=void>()=>{let resolve!:(value:T|PromiseLike<T>)=>void,reject!:(reason?:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject}}
class WaitingAdapter extends LlmAdapter{
 private ready=deferred()
 finish(){this.ready.resolve()}
 override async resolveModel(provider:string,model:string){return {provider,id:model,name:model}}
 async *stream(options:GenerateOptions):AsyncIterable<StreamChunk>{
  await Promise.race([this.ready.promise,new Promise<void>((_,reject)=>{if(options.signal?.aborted)reject(options.signal.reason);else options.signal?.addEventListener('abort',()=>reject(options.signal!.reason),{once:true})})])
  yield {type:'block-start',index:0,blockType:'text'}
  yield {type:'text-delta',index:0,text:'完成'}
  yield {type:'block-end',index:0,block:{type:'text',text:'完成'}}
  yield {type:'finish',reason:{kind:'stop'}}
 }
}
async function setup(t:TestContext,options:{timeoutMs?:number}={}){
 const directory=await mkdtemp(join(tmpdir(),'teloa-orchestration-')),ctx=new Context()
 t.after(async()=>{await ctx.fiber.dispose();await rm(directory,{recursive:true,force:true})})
 await ctx.plugin(LlmRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 await ctx.plugin(JsonlSessionPersistence,{root:directory,compression:'none'});await ctx.plugin(LocalJobRegistry,{})
 ctx.jobs.attachController('orchestration-test')
 const adapter=new WaitingAdapter();ctx.llm.registerAdapter(['test'],adapter)
 await ctx.plugin(SubagentRuntime,{maxDepth:1,maxActiveSubagents:6});await ctx.plugin(Spawn,{providerName:'spawn'})
 const {agent:root}=await ctx.agents.create({sessionId:SessionId('orchestration-root'),agentOptions:{provider:'test',model:'test'}})
 const rows=new Map<string,TaskRunRuntimeLink>(),calls:Array<{kind:string;input:unknown}>=[]
 const links:TaskRunRuntimeLinks={list:async input=>[...rows.values()].filter(row=>row.runId===input.runId&&(!input.kind||row.kind===input.kind)),put:async row=>{rows.set(row.kind+':'+row.nativeId,structuredClone(row))}}
 let beforeBind=async()=>{},beforeReserve=async()=>{}
 const delegation:SubagentDelegationPorts={limits:{maxDepth:1,maxPerRun:6},runId:async()=> 'run',reserve:async input=>{await beforeReserve();calls.push({kind:'reserve',input})},release:async input=>{calls.push({kind:'release',input})},bind:async input=>{calls.push({kind:'bind',input});await beforeBind()},settle:async input=>{calls.push({kind:'settle',input})},abandon:async input=>{calls.push({kind:'abandon',input})}}
 let policy:TaskToolPolicy|null={allowedTools:['workflow','ralph'],nativeRequestId:'native'}
 const orchestration=createTaskRunOrchestration(ctx,delegation,async()=>policy,links,options);t.after(async()=>{await orchestration.dispose()})
 const start=(schema=false,parent=root)=>ctx.subagents.start('teloa-workflow-spawn',{parent,signal:AbortSignal.timeout(5000),prompt:[{type:'text',text:'整理'}],...(schema?{outputSchema:{type:'object' as const,properties:{done:{type:'boolean' as const}},required:['done'],additionalProperties:false}}:{})})
 const run={id:'run',sessionId:root.id,nativeRequestId:'native',state:'active',stopRequestedAt:null} as unknown as TaskRun
 const call=(name:string,args:Record<string,unknown>={})=>ctx.tools.execute({agent:root,name,arguments:args,callId:ToolCallId(name+'-call'),signal:AbortSignal.timeout(5000)})
 return {ctx,root,run,start,call,orchestration,calls,links,finish:()=>adapter.finish(),setPolicy:(next:TaskToolPolicy|null)=>{policy=next},policy:()=>policy!,beforeBind:(work:()=>Promise<void>)=>{beforeBind=work},beforeReserve:(work:()=>Promise<void>)=>{beforeReserve=work}}
}

test('官方 fresh provider 保持一套生命周期并将子运行绑定到共用配额',async t=>{
 const env=await setup(t),events:string[]=[]
 env.ctx.on('subagent/start',info=>{events.push(info.provider)},{global:true})
 const child=await env.start()
 assert.deepEqual(events,['teloa-workflow-spawn'])
 assert.equal(child.localAgent!.session.header.parentSession,env.root.id)
 assert.equal(env.calls.filter(call=>call.kind==='reserve').length,1)
 assert.deepEqual(env.calls.find(call=>call.kind==='bind')?.input,{reservationId:(env.calls[0]!.input as {reservationId:string}).reservationId,childSessionId:child.id,depth:1})
 assert.equal((await env.orchestration.state(env.run)).outstanding,true)
 env.finish();assert.equal((await child.result).stopReason,'completed');await child.dispose()
 assert.equal(env.calls.filter(call=>call.kind==='settle').length,1)
 assert.deepEqual(await env.orchestration.state(env.run),{outstanding:false,interrupted:false})
})

test('绑定尚未写入时 child 授权等待；绑定完成后才放行精确子级',async t=>{
 const env=await setup(t),entered=deferred(),release=deferred()
 env.beforeBind(async()=>{entered.resolve();await release.promise})
 const start=env.start(true);await entered.promise
 const childId=(env.calls.find(call=>call.kind==='bind')!.input as {childSessionId:string}).childSessionId,child=env.ctx.agents.get(SessionId(childId))!
 let authorized=false
 const waiting=env.orchestration.authorizeChild(child,env.policy(),AbortSignal.timeout(5000)).then(value=>{authorized=value})
 await new Promise(resolve=>setImmediate(resolve));assert.equal(authorized,false)
 release.resolve();await start;await waiting;assert.equal(authorized,true)
 const exec={name:'structured_output',agent:child} as ToolExecution
 assert.equal(env.orchestration.ownsStructuredOutput(exec),true)
 assert.equal(env.orchestration.ownsStructuredOutput({...exec,agent:env.root}),false)
 assert.equal(env.orchestration.ownsStructuredOutput({...exec,name:'other'}),false)
 await env.orchestration.stop(env.run,AbortSignal.timeout(5000))
 assert.equal((await env.orchestration.state(env.run)).outstanding,false)
})

test('岗位无授权、累计配额拒绝及深度超限都发生在创建官方子级之前',async t=>{
 const env=await setup(t),events:string[]=[]
 env.ctx.on('subagent/start',info=>{events.push(String(info.id))},{global:true})
 env.setPolicy({allowedTools:[],nativeRequestId:'native'})
 await assert.rejects(env.start(),/授权/);assert.equal(events.length,0)
 env.setPolicy({allowedTools:['workflow'],nativeRequestId:'native'});env.beforeReserve(async()=>{throw Error('quota reached')})
 await assert.rejects(env.start(),/quota reached/);assert.equal(events.length,0)
 env.beforeReserve(async()=>{});const child=await env.start()
 await assert.rejects(env.start(false,child.localAgent!),/层数/)
 assert.equal(events.length,1)
 await child.dispose()
})

test('绑定失败撤回已发布 child 并保守保留 abandoned 配额',async t=>{
 const env=await setup(t)
 env.beforeBind(async()=>{throw Error('database unavailable')})
 await assert.rejects(env.start(),/database unavailable/)
 const id=(env.calls.find(call=>call.kind==='bind')!.input as {childSessionId:string}).childSessionId
 assert.equal(env.ctx.agents.get(SessionId(id)),undefined)
 assert.equal(env.calls.filter(call=>call.kind==='abandon').length,1)
 assert.equal(env.calls.filter(call=>call.kind==='release').length,0)
})

test('停止也取消尚未发布身份的官方 startup，不等待原始工具长超时',async t=>{
 const env=await setup(t),entered=deferred(),provider=env.ctx.subagents.getProvider('spawn')!
 provider.start=async request=>{
  entered.resolve()
  await new Promise<void>((_,reject)=>request.signal.addEventListener('abort',()=>reject(Error('startup aborted')),{once:true}))
  throw Error('unreachable')
 }
 const started=env.start(),rejected=assert.rejects(started,/startup aborted/)
 await entered.promise
 await env.orchestration.stop(env.run,AbortSignal.timeout(250))
 await rejected
 assert.equal(env.calls.filter(call=>call.kind==='release').length,1)
})

test('普通会话委托官方 spawn，仍不冒充业务 Run 或写岗位配额',async t=>{
 const env=await setup(t);env.setPolicy(null)
 const child=await env.start(true)
 assert.equal(env.calls.length,0)
 assert.equal(env.orchestration.ownsStructuredOutput({name:'structured_output',agent:child.localAgent} as ToolExecution),false)
 await child.dispose()
})

test('原生 descriptor 声明受管 provider 的孤儿 child 不回退旧子工具授权',async t=>{
 const env=await setup(t);env.setPolicy(null)
 const orphan=await env.start(),legacy=await env.ctx.subagents.start('spawn',{parent:env.root,signal:AbortSignal.timeout(5000),prompt:[]})
 await new Promise(resolve=>setImmediate(resolve))
 const policy={allowedTools:['workflow'],nativeRequestId:'native'}
 await assert.rejects(env.orchestration.authorizeChild(orphan.localAgent!,policy,AbortSignal.timeout(5000)),/未登记/)
 assert.equal(await env.orchestration.authorizeChild(legacy.localAgent!,policy,AbortSignal.timeout(5000)),false)
 await orphan.dispose();await legacy.dispose()
})

test('旧宿主世代禁止重新派发；停止后精确 child 授权失效',async t=>{
 const env=await setup(t),child=await env.start()
 env.setPolicy({...env.policy(),stopRequested:true})
 await assert.rejects(env.orchestration.authorizeChild(child.localAgent!,env.policy(),AbortSignal.timeout(5000)),/停止/)
 env.setPolicy({allowedTools:['workflow'],nativeRequestId:'native'})
 await env.links.put({runId:'run',kind:'job',nativeId:'owner:old:root',sessionId:env.root.id,payload:{record:'owner',runtimeId:'old',requestId:'native'}})
 await assert.rejects(env.start(),/重启/)
 assert.equal((await env.orchestration.state(env.run)).interrupted,true)
 await child.dispose()
})

test('旧 root owner 的纯文本结果不被编排层改为中断，派发仍受世代闸约束',async t=>{
 const env=await setup(t)
 await env.links.put({runId:'run',kind:'job',nativeId:'owner:old:'+env.root.id,sessionId:env.root.id,payload:{record:'owner',runtimeId:'old',requestId:'native'}})
 const run={...env.run,allowedTools:[],skills:[],subagents:[]}
 assert.deepEqual(await env.orchestration.state(run),{outstanding:false,interrupted:false})
 await assert.rejects(env.start(),/重启/)
 assert.equal((await env.orchestration.state({...run,allowedTools:['workflow']})).interrupted,true)
 await env.links.put({runId:'run',kind:'team',nativeId:'team',sessionId:env.root.id,payload:{requestId:'native',reservationId:'team',name:'helper'}})
 assert.equal((await env.orchestration.state(run)).interrupted,true)
})

test('前台原生编排在总耗时达到上限后由调用 signal 收敛',async t=>{
 const env=await setup(t,{timeoutMs:20});env.setPolicy(null)
 let aborted=false
 env.ctx.tools.register(defineTool({name:'ralph',description:'等待',parameters:{},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async(_args,exec)=>{await new Promise<void>(resolve=>{exec.signal.addEventListener('abort',()=>{aborted=true;resolve()},{once:true})});return 'stopped'}}))
 assert.equal((await env.call('ralph')).isError,true);assert.equal(aborted,true)
})

test('后台 workflow 返回后保留耗时约束，只取消此次返回的 owner job',async t=>{
 const env=await setup(t,{timeoutMs:30});env.setPolicy(null)
 let foreignCancelled=false,ownedCancelled=false
 const foreignDone=deferred<JobOutcome>()
 env.ctx.jobs.start({kind:'bash',label:'other',owner:env.root.id,run:()=>({done:foreignDone.promise,cancel:()=>{foreignCancelled=true;foreignDone.resolve({status:'killed'})}})})
 t.after(()=>foreignDone.resolve({status:'completed'}))
 env.ctx.tools.register(defineTool({name:'workflow',description:'后台',parameters:{},output:{schema:{type:'object',additionalProperties:false,properties:{kind:{type:'string',required:true},jobId:{type:'string',required:true}}},render:()=>[]},execute:async()=>{
  const done=deferred<JobOutcome>(),jobId=env.ctx.jobs.start({kind:'workflow' as JobKind,label:'owned',owner:env.root.id,run:()=>({done:done.promise,cancel:()=>{ownedCancelled=true;done.resolve({status:'killed'})}})})
  return {kind:'background',jobId}
 }}))
 const result=await env.call('workflow');assert.equal(result.isError,false)
 await new Promise(resolve=>setTimeout(resolve,80))
 assert.equal(ownedCancelled,true);assert.equal(foreignCancelled,false)
})

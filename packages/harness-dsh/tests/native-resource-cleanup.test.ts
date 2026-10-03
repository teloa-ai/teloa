import assert from 'node:assert/strict'
import test,{type TestContext} from 'node:test'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {Context} from '@deepseek-ai/cordis'
import type {Agent} from '@deepseek-ai/dsh-agent'
import {ToolCallId,createUserMessage,type StreamChunk} from '@deepseek-ai/dsh-llm'
import {defineTool,type ToolExecutionInput,type ToolExecutionResult,type ToolRunContext} from '@deepseek-ai/dsh-tools'
import type {TaskRunRuntimeLink,TaskRunRuntimeLinks} from '@teloa/backend'
import {createNativeResourceCleanupOwner,admitNativeResourceCleanup,enterNativeResourceCleanup,isNativeResourceCleanupScope} from '../src/native-resource-cleanup.ts'
import {createTaskRunBrowser} from '../src/task-run-browser.ts'
import {registerTaskToolGuard,type TaskToolPolicyReader} from '../src/task-tool-guard.ts'
import {nativeHotKernel,hotGate} from './fixtures/native-hot-causality.ts'
import {nativeHotSubagentFixture,type ChildMode} from './fixtures/native-hot-subagent.ts'
import {deferred} from './fixtures/native-subagent-admission.ts'

const options={timeout:15000}
const navigate='mcp__playwright-mcp__browser_navigate',close='mcp__playwright-mcp__browser_close'
type Admission=Parameters<typeof admitNativeResourceCleanup>[1]
const forbidden=()=>Object.assign(Error('fixture work has no admission'),{code:'teloa/forbidden'})
async function rejected(operation:Promise<ToolExecutionResult>){
 const outcome=await operation.then(result=>({result}),error=>({error}))
 assert.ok('error' in outcome||outcome.result.isError,'拒绝必须反映为异常或官方工具错误结果')
}

/** 单独验证官方 Tools 最后同步补口；不伪造 exec/token 或替换工具运行器。 */
async function cleanupFixture(t:TestContext){
 const f=await nativeHotKernel(t),{ctx}=f
 await ctx.plugin(f.loopPackage.namespace.AgentLoop,{agents:[]})
 const {agent}=await ctx.agents.create({sessionId:f.sessionPackage.SessionId('cleanup-owner')})
 const {agent:other}=await ctx.agents.create({sessionId:f.sessionPackage.SessionId('cleanup-other')})
 const policyContext=ctx.extend()
 const policy=(request:Admission)=>{
  if(admitNativeResourceCleanup(policyContext,request))return
  if(request.kind!=='body-end'&&request.exec.agent)throw forbidden()
 }
 const prototype=Object.getPrototypeOf(ctx.tools) as object
 Reflect.apply(Reflect.get(prototype,'requireWorkAdmission') as (...args:unknown[])=>unknown,ctx.tools,[])
 Reflect.apply(Reflect.get(prototype,'installWorkAdmission') as (...args:unknown[])=>unknown,ctx.tools,[policy])
 ctx.on('tools/execute',(exec,next)=>{
  if(enterNativeResourceCleanup(ctx,exec))return next()
  if(exec.agent)throw forbidden()
  return next()
 },{global:true,prepend:true})
 let owned=true,body:(exec:ToolRunContext)=>Promise<void>=async()=>{},sequence=0
 const calls:ToolRunContext[]=[]
 const owner=createNativeResourceCleanupOwner(ctx,target=>owned&&target===agent);t.after(owner.close)
 for(const name of [close,navigate])ctx.tools.register(defineTool({name,description:name,parameters:{},
  output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},
  async execute(_args,exec){calls.push(exec);await body(exec);return 'done'},
 }))
 return {...f,agent,other,owner,calls,
  setOwned(value:boolean){owned=value},setBody(action:typeof body){body=action},
  close:()=>owner.execute(agent,ToolCallId('cleanup-'+ ++sequence),AbortSignal.timeout(5000)),
  input:(target:Agent|null=agent,name=close):ToolExecutionInput=>({...(target?{agent:target}:{}),name,arguments:{},callId:ToolCallId('public-'+ ++sequence),signal:AbortSignal.timeout(5000)}),
 }
}

test('回收票据仅授权既有owner的真实空参关闭，公开无agent工具保持原行为',options,async t=>{
 const f=await cleanupFixture(t)
 assert.equal((await f.close()).isError,false);assert.equal(f.calls.length,1)
 await rejected(f.ctx.tools.execute(f.input()));assert.equal(f.calls.length,1)
 assert.equal((await f.ctx.tools.execute(f.input(null))).isError,false);assert.equal(f.calls.length,2)
 f.setOwned(false);await rejected(f.close());assert.equal(f.calls.length,2)
})

test('owner在官方wrapper等待后失效，最终body补口零关闭',options,async t=>{
 const f=await cleanupFixture(t),entered=deferred(),release=deferred()
 t.after(()=>release.resolve())
 f.ctx.on('tools/execute',async(_exec,next)=>{entered.resolve();await release.promise;return next()})
 const pending=f.close();await entered.promise;f.setOwned(false);release.resolve();await rejected(pending)
 assert.equal(f.calls.length,0)
})

for(const change of ['agent','no-agent','session','signal','arguments','callId','rootCallId','parent','name','token'] as const)test('回收最终复核拒绝wrapper改写 '+change,options,async t=>{
 const f=await cleanupFixture(t),session=f.agent.session
 f.ctx.on('tools/execute',(exec,next)=>{
  if(change==='session')Reflect.set(f.agent,'session',f.other.session)
  else{
   const value={agent:f.other,'no-agent':undefined,signal:new AbortController().signal,arguments:{},callId:ToolCallId('changed'),rootCallId:ToolCallId('changed-root'),parent:{},name:navigate,token:{}}[change]
   Reflect.set(exec,change==='no-agent'?'agent':change,value)
  }
  return next()
 })
 try{await rejected(f.close());assert.equal(f.calls.length,0)}finally{Reflect.set(f.agent,'session',session)}
})

test('精确input不能克隆或重放，其他Context不能消费exec',options,async t=>{
 const f=await cleanupFixture(t),foreign=new Context();t.after(()=>foreign.fiber.dispose())
 let captured:ToolExecutionInput|undefined
 const runtime=f.ctx.tools,execute=runtime.execute
 runtime.execute=async function(input){captured=input;await rejected(execute.call(this,{...input}));return execute.call(this,input)}
 t.after(()=>{runtime.execute=execute})
 f.ctx.on('tools/pre-execute',(exec,next)=>{
  assert.throws(()=>enterNativeResourceCleanup(foreign,exec),{code:'teloa/forbidden'})
  return next()
 })
 assert.equal((await f.close()).isError,false);assert.equal(f.calls.length,1)
 await rejected(execute.call(f.ctx.tools,captured!));assert.equal(f.calls.length,1)
})

test('回收体不能继承票据派发其他工具，迟到scope不能降级，附加上下文不返回owner',options,async t=>{
 const f=await cleanupFixture(t),gate=deferred();let late:Promise<void>|undefined
 t.after(()=>gate.resolve())
 f.setBody(async exec=>{
  assert.equal(isNativeResourceCleanupScope(),true)
  await rejected(f.ctx.tools.execute(f.input(f.agent,navigate)))
  await rejected(f.ctx.tools.execute({...f.input(),parent:exec.token,rootCallId:exec.rootCallId}))
  late=(async()=>{await gate.promise;assert.equal(isNativeResourceCleanupScope(),true);await rejected(f.ctx.tools.execute(f.input()))})()
  exec.deferContext(createUserMessage({source:{kind:'user'},content:[{type:'text',text:'cleanup must not enqueue'}]}))
 })
 await rejected(f.close());gate.resolve();await late
 assert.equal(f.calls.length,1);assert.equal(f.agent.inbox.nextTurn.length,0);assert.equal(f.agent.inbox.nextStep.length,0)
 assert.equal(isNativeResourceCleanupScope(),false)
})

function toolAnswer(name:string):readonly StreamChunk[]{
 const id=ToolCallId('child-browser')
 return [{type:'block-start',index:0,blockType:'tool-call'},{type:'tool-call-delta',index:0,id,name,argumentsDelta:'{}'},
  {type:'block-end',index:0,block:{type:'tool-call',id,name,arguments:'{}'}},{type:'finish',reason:{kind:'tool-calls'}}]
}

/** 真Subagent/Loop/Tools/Session；浏览器体为内存计数，不启动浏览器、数据库或网络。 */
async function browserFixture(t:TestContext,managed:boolean,mode:ChildMode='one-shot'){
 const f=await nativeHotSubagentFixture(t,mode),rows=new Map<string,TaskRunRuntimeLink>(),calls:Array<{name:string;agent:Agent|undefined}>=[]
 const require=createRequire(import.meta.url),approval=await import(pathToFileURL(createRequire(require.resolve('@deepseek-ai/dsh-subagent')).resolve('@deepseek-ai/dsh-user-approval')).href)
 await f.ctx.plugin(approval.ApprovalService,{policy:'ask'})
 const run={id:'cleanup-run',sessionId:f.parent.id,nativeRequestId:'hot-child-input'}
 let stopping=false,closeBody:(exec:ToolRunContext)=>Promise<void>=async()=>{},navigateBody:typeof closeBody=async()=>{}
 const names=['hot_delegate',navigate,close]
 const links={list:async()=>[...rows.values()],put:async(row:TaskRunRuntimeLink)=>{rows.set(row.nativeId,structuredClone(row))}} as unknown as TaskRunRuntimeLinks
 const readPolicy:TaskToolPolicyReader=async()=>managed?{allowedTools:stopping?[]:names,nativeRequestId:run.nativeRequestId,stopRequested:stopping,argumentRules:names.map(name=>({name,anyArguments:true,allowed:[]}))}:null
 const controller={cancel({sessionId}:{sessionId:Agent['id']}){f.ctx.agents.get(sessionId)!.cancel({kind:'user'},{keepInbox:true});return {accepted:true}}}
 f.ctx.provide('sessionController',controller as never)
 const browser=createTaskRunBrowser(f.ctx,links,readPolicy);t.after(browser.dispose)
 if(managed)browser.bind(run)
 f.ctx.provide('browserUse',{providerName:'playwright-mcp'} as never)
 let guarded=false
 const guard=()=>{if(!guarded){guarded=true;registerTaskToolGuard(f.ctx,readPolicy,[],undefined,undefined,undefined,undefined,browser.cleanup)}}
 for(const name of [navigate,close])f.ctx.tools.register(defineTool({name,description:name,parameters:{},
  output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},
  async execute(_args,exec){calls.push({name,agent:exec.agent});if(name===close)await closeBody(exec);else{if(managed)guard();await navigateBody(exec)}return 'done'},
 }))
 // 本组只验证资源回收：首个确定性导航体后安装原任务守卫，不改变官方child的never审批策略。
 // 完整导航审批不在本组成功断言内；关闭仍经过原cleanup.consume/decision/guard及持久账本。
 f.setAdmission(async(candidate,dispatch)=>{if(managed)browser.bind({...run,sessionId:candidate.agent.id});await f.defaultAdmission(candidate,dispatch)})
 const navigateParent=()=>f.setToolAction(async exec=>{
  assert.ok(exec.agent)
  const result=await f.ctx.tools.execute({agent:exec.agent,name:navigate,arguments:{},callId:ToolCallId('parent-navigation'),parent:exec.token,rootCallId:exec.rootCallId,signal:exec.signal})
  assert.equal(result.isError,false)
 })
 return {...f,run,browser,rows,calls,controller,navigateParent,
  stop(){stopping=true},setCloseBody(action:typeof closeBody){closeBody=action},setNavigateBody(action:typeof navigateBody){navigateBody=action},
  approvalPolicy(agent:Agent){return (Reflect.get(f.ctx,'approval') as {overrideOf:(session:Agent['session'])=>unknown}).overrideOf(agent.session)},
 }
}

test('真实热图普通停止在撤销后仍关闭既有资源，重复停止不重关',options,async t=>{
 const f=await browserFixture(t,false);f.navigateParent();await f.send()
 f.rights.revoked=true;f.controller.cancel({sessionId:f.parent.id});await f.parent.whenIdle()
 assert.deepEqual(f.calls.map(call=>call.name),[navigate,close])
 assert.deepEqual(f.browser.sessionState(f.parent.id),{state:'ready'})
 f.controller.cancel({sessionId:f.parent.id});await f.parent.whenIdle();assert.equal(f.calls.length,2)
})

test('真实热图正在执行的浏览器被用户取消后，独立回收signal仍关闭既有资源',options,async t=>{
 const f=await browserFixture(t,false),gate=hotGate();t.after(gate.release)
 f.setNavigateBody(exec=>gate.wait(exec.signal));f.navigateParent()
 const running=f.send();await gate.entered
 f.rights.revoked=true;f.controller.cancel({sessionId:f.parent.id});await running
 assert.deepEqual(f.calls.map(call=>call.name),[navigate,close])
 assert.deepEqual(f.browser.sessionState(f.parent.id),{state:'ready'})
 assert.equal(f.adapter.parentCalls,1);assert.equal(f.counts.fresh,1)
})

test('真实热图受管Run撤销后仍关闭并结清dirty，回收不能附带新工具或子任务',options,async t=>{
 const f=await browserFixture(t,true);f.navigateParent();await f.send();f.stop();f.rights.revoked=true
 f.setCloseBody(async exec=>{
  await rejected(f.ctx.tools.execute({agent:f.parent,name:navigate,arguments:{},callId:ToolCallId('cleanup-new-navigation'),parent:exec.token,rootCallId:exec.rootCallId,signal:exec.signal}))
  await assert.rejects(f.start(),{code:'teloa/forbidden'})
 })
 assert.equal((await f.browser.cancel(f.run,AbortSignal.timeout(5000))).closed,true)
 assert.deepEqual(f.calls.map(call=>call.name),[navigate,close])
 assert.deepEqual(await f.browser.state(f.run),{dirty:false,outstanding:false,interrupted:false})
 assert.equal(f.childRequests().length,0);assert.ok(f.candidates.every(candidate=>f.inserted(candidate.agent).length===0))
 assert.equal(f.counts.fresh,1)
})

for(const mode of ['one-shot','continuable'] as const)test('真实热图 '+mode+' child释放时撤销仍关闭，父根不被回收续作放宽',options,async t=>{
 const f=await browserFixture(t,true,mode)
 f.adapter.childScripts.push(toolAnswer(navigate))
 f.ctx.on('agent/status',({agent,status})=>{if(agent!==f.parent&&status==='idle')f.rights.revoked=true},{global:true,prepend:true})
 await f.send()
 const child=f.candidates[0]!.agent
 assert.equal(f.approvalPolicy(child),'never','保持官方子任务的审批限制')
 assert.deepEqual(f.calls.map(call=>[call.name,call.agent]),[[navigate,child],[close,child]])
 assert.deepEqual(await f.browser.state(f.run),{dirty:false,outstanding:false,interrupted:false})
 assert.equal(f.childRequests().length,2);assert.equal(f.adapter.parentCalls,1);assert.equal(f.counts.fresh,1)
})

test('回收作用域内即使新许可有效也不能发布新工作输入',options,async t=>{
 const f=await browserFixture(t,false);f.navigateParent();await f.send()
 f.setCloseBody(async()=>{
  await assert.rejects(f.start(),{code:'teloa/forbidden'})
  const message=createUserMessage({source:{kind:'user'},content:[{type:'text',text:'cleanup is not new work'}]})
  await assert.rejects(f.work.withNewInput(f.parent,message,{producer:'prompt',identity:'cleanup-fresh'},()=>f.parent.followup(message)),{code:'teloa/forbidden'})
 })
 f.controller.cancel({sessionId:f.parent.id});await f.parent.whenIdle()
 assert.deepEqual(f.calls.map(call=>call.name),[navigate,close]);assert.equal(f.counts.fresh,1)
 assert.deepEqual(f.browser.sessionState(f.parent.id),{state:'ready'})
 assert.equal(f.childRequests().length,0);assert.equal(f.inserted(f.parent).length,1)
})

test('回收重入候选：官方 Agent data 字段及 Session 原型 id getter 保持可用',options,async t=>{
 const f=await cleanupFixture(t),session=f.agent.session,header=session.header
 for(const key of ['ctx','id','session'])assert.ok(Object.hasOwn(Object.getOwnPropertyDescriptor(f.agent,key)!,'value'))
 assert.equal(Object.getOwnPropertyDescriptor(session,'id'),undefined)
 assert.equal(typeof Object.getOwnPropertyDescriptor(Object.getPrototypeOf(session) as object,'id')?.get,'function')
 assert.equal(Object.getOwnPropertyDescriptor(session,'header')?.value,header)
 assert.equal(Object.getOwnPropertyDescriptor(header,'id')?.value,f.agent.id)
 assert.equal(Object.isFrozen(header),true)
 assert.equal((await f.close()).isError,false);assert.equal(f.calls.length,1)
 t.diagnostic('Agent.ctx/id/session=own data; Session.id=prototype getter; header.id=frozen data; close body=1')
})

test('回收重入候选：最后 identity getter 撤销 owner 后不得执行 close body',options,async t=>{
 const f=await cleanupFixture(t),session=f.agent.session,descriptor=Object.getOwnPropertyDescriptor(f.agent,'session')!
 let reads=0,lost=false,bodyAfterLost=false
 f.setBody(async()=>{bodyAfterLost=lost})
 f.ctx.on('tools/execute',(_exec,next)=>{
  Object.defineProperty(f.agent,'session',{configurable:true,get(){if(++reads===4){lost=true;f.setOwned(false)}return session}})
  return next()
 })
 try{
  const outcome=await f.close().then(result=>({isError:result.isError}),()=>({isError:true}))
  t.diagnostic(JSON.stringify({reads,lost,bodyCalls:f.calls.length,bodyAfterLost,...outcome}))
  assert.equal(f.calls.length,0,'final owner 后不得再次触发身份 getter 并带着失效 owner 执行关闭')
  assert.equal(outcome.isError,true)
 }finally{Object.defineProperty(f.agent,'session',descriptor)}
})

for(const field of ['ctx','id','session','header','session-id'] as const)test('回收重入候选：最后 owner 回调把 '+field+' 换为 getter，纯 descriptor 拒绝',options,async t=>{
 const f=await cleanupFixture(t),session=f.agent.session
 const target=field==='header'||field==='session-id'?session:f.agent,key=field==='session-id'?'id':field
 const descriptor=Object.getOwnPropertyDescriptor(target,key),value=Reflect.get(target,key)
 let armed=false,ownerChecks=0,getterReads=0
 const owner=createNativeResourceCleanupOwner(f.ctx,agent=>{
  assert.equal(agent,f.agent)
  // body admission 有两次原有检查；只在最后一次返回 true 前改字段，不追加 owner 循环。
  if(armed&&++ownerChecks===2)Object.defineProperty(target,key,{configurable:true,get(){getterReads++;return value}})
  return true
 })
 t.after(owner.close)
 f.ctx.on('tools/execute',(_exec,next)=>{armed=true;return next()})
 try{
  const outcome=await owner.execute(f.agent,ToolCallId('owner-reentrant-'+field),AbortSignal.timeout(5000)).then(result=>({isError:result.isError}),()=>({isError:true}))
  t.diagnostic(JSON.stringify({field,ownerChecks,getterReads,bodyCalls:f.calls.length,...outcome}))
  assert.equal(ownerChecks,2,'不得通过重复 owner callback 形成检查循环')
  assert.equal(f.calls.length,0);assert.equal(outcome.isError,true)
 }finally{
  if(descriptor)Object.defineProperty(target,key,descriptor)
  else Reflect.deleteProperty(target,key)
 }
})

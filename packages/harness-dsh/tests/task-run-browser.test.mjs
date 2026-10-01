import test from 'node:test'
import assert from 'node:assert/strict'
import {createRuntime,defineTool,ToolCallId,createUserMessage} from '../../../tests/native-auto-review-fixture.mjs'
import {createTaskRunBrowser} from '../src/task-run-browser.ts'
import {registerTaskToolGuard} from '../src/task-tool-guard.ts'
import {readSessionEvents} from '../src/session-events.ts'

const navigate='mcp__playwright-mcp__browser_navigate',close='mcp__playwright-mcp__browser_close'
async function fixture(t,{bind=true}={}){
 const {ctx,create,adapter}=await createRuntime(t),agent=await create('browser-owner'),other=await create('browser-foreign')
 ctx.provide('browserUse',{providerName:'playwright-mcp'})
 const run={id:'run',sessionId:agent.session.id,nativeRequestId:'request'},rows=new Map(),calls=[]
 let stopping=false,grantClose=true,asks=0,failWrite=false,failClose=false,seq=0,policyPause
 const links={list:async input=>[...rows.values()].filter(row=>row.runId===input.runId&&(!input.kind||row.kind===input.kind)),put:async row=>{if(failWrite)throw Error('synthetic storage failure');rows.set(row.nativeId,structuredClone(row))}}
 const readPolicy=async id=>{await policyPause?.();return id===agent.session.id?{allowedTools:stopping?[]:[navigate,close],nativeRequestId:run.nativeRequestId,stopRequested:stopping,argumentRules:[navigate,...grantClose?[close]:[]].map(name=>({name,anyArguments:true,allowed:[]}))}:null}
 const browser=createTaskRunBrowser(ctx,links,readPolicy);t.after(browser.dispose);if(bind)browser.bind(run)
 registerTaskToolGuard(ctx,readPolicy,[],undefined,undefined,undefined,undefined,browser.cleanup)
 for(const name of [navigate,close])ctx.tools.register(defineTool({name,description:name,parameters:{},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async(_args,exec)=>{
  calls.push({name,agent:exec.agent});if(exec.agent===agent)assert.ok([...rows.values()].some(row=>row.payload.status==='dirty'),'真实派发前已持久化')
  if(name===close&&failClose)throw Error('synthetic close failure');return 'executed'
 }}))
 ctx.on('approval/request',async()=>{asks++;return 'allowed-once'})
 agent.session.append('turn/start',{turn:0});agent.session.append('user/message',createUserMessage({content:[],source:{kind:'user',rpcId:run.nativeRequestId}}),{surfaceOp:'append'})
 const call=(name=navigate,target=agent,args={})=>ctx.tools.execute({agent:target,name,arguments:args,callId:ToolCallId('call-'+ ++seq),signal:AbortSignal.timeout(5000)})
 return {ctx,create,adapter,agent,other,run,rows,links,readPolicy,browser,calls,call,get asks(){return asks},set policyPause(value){policyPause=value},set stopping(value){stopping=value},set grantClose(value){grantClose=value},set failWrite(value){failWrite=value},set failClose(value){failClose=value},stop(){stopping=true;agent.session.append('turn/end',{turn:0,reason:{kind:'aborted',reason:{kind:'user'}}})}}
}

test('派发先落盘；正常留页不阻塞交付；停止只由 host 清理本会话且不追加假轮次',async t=>{
 const f=await fixture(t)
 assert.equal((await f.call()).isError,false);assert.equal(f.asks,1)
 assert.deepEqual(await f.browser.state(f.run),{dirty:true,outstanding:false,interrupted:false})
 await f.call(navigate,f.other);f.stop()
 assert.equal((await f.browser.state(f.run)).outstanding,true)
 assert.equal((await f.call(close)).isError,true,'模型调用不能借停止取得权限')
 const events=[...readSessionEvents(f.agent.session)]
 assert.equal((await f.browser.cancel(f.run,AbortSignal.timeout(5000))).closed,true)
 assert.equal(f.asks,1,'host 收尾不产生 Teloa 逐动作审批')
 assert.deepEqual([...readSessionEvents(f.agent.session)],events,'不伪造 Session 工具日志或轮次')
 assert.deepEqual(await f.browser.state(f.run),{dirty:false,outstanding:false,interrupted:false})
 assert.equal(f.calls.filter(row=>row.name===close).length,1)
 assert.equal(f.calls.at(-1).agent,f.agent)
 assert.equal((await f.call(close)).isError,true,'私有授权一次消费后不残留')
})

for(const boundary of ['ungranted','deny','ask','ask-approved','guard','failure','write'])test(`收尾 ${boundary} 不得清除 dirty`,async t=>{
 const f=await fixture(t);await f.call();if(boundary==='ask-approved')f.stopping=true;else f.stop()
 if(boundary==='ungranted')f.grantClose=false
 if(boundary==='failure')f.failClose=true
 if(boundary==='write')f.failWrite=true
 if(boundary==='deny'||boundary.startsWith('ask'))f.ctx.on('tools/pre-execute',async(exec,next)=>exec.name===close?{kind:boundary==='deny'?'deny':'ask',reason:'synthetic downstream decision'}:next())
 if(boundary==='guard')f.ctx.tools.guard(exec=>exec.name===close?'synthetic monotonic denial':undefined)
 assert.equal((await f.browser.cancel(f.run,AbortSignal.timeout(5000))).closed,false)
 assert.equal((await f.browser.state(f.run)).outstanding,true)
 assert.ok([...f.rows.values()].some(row=>row.payload.status==='dirty'))
})

test('存储未确认前不执行；重建适配不能把旧记录当作已清理',async t=>{
 const f=await fixture(t);f.failWrite=true
 assert.equal((await f.call()).isError,true);assert.equal(f.calls.length,0)
 f.failWrite=false;await f.call();f.stop()
 const recovered=createTaskRunBrowser(f.ctx,f.links,f.readPolicy,'different-runtime');t.after(recovered.dispose);recovered.bind(f.run)
 assert.equal((await recovered.state(f.run)).interrupted,true)
 assert.equal((await recovered.cancel(f.run,AbortSignal.timeout(5000))).closed,false)
 assert.equal(f.calls.length,1)
})

test('清理 token 不能被下游复用给嵌套调用、其他 Agent 或带参 close',async t=>{
 const f=await fixture(t);await f.call();f.stop();const nested=[]
 f.ctx.on('tools/pre-execute',async(exec,next)=>{
  if(exec.name===close&&exec.agent===f.agent&&nested.length===0){
   nested.push('entered');nested.push(await f.call(close),await f.call(close,f.agent,{unexpected:true}))
  }
  return next()
 })
 assert.equal((await f.browser.cancel(f.run,AbortSignal.timeout(5000))).closed,true)
 assert.ok(nested.slice(1).every(result=>result.isError))
 assert.equal(f.calls.filter(row=>row.name===close).length,1)
})

test('关闭后重新导航形成新的 dirty；同世代丢失私有派发归属仍判中断',async t=>{
 const f=await fixture(t);await f.call();await f.call(close)
 assert.equal((await f.browser.state(f.run)).dirty,false)
 await f.call();assert.equal((await f.browser.state(f.run)).dirty,true)
 const recovered=createTaskRunBrowser(f.ctx,f.links,f.readPolicy);t.after(recovered.dispose);recovered.bind(f.run)
 assert.equal((await recovered.state(f.run)).interrupted,true)
})

test('已绑定父子会话分别关闭；未绑定的受管子会话不能派发；其他 Run 不受影响',async t=>{
 const f=await fixture(t),child=await f.create('browser-child',{origin:'subagent',parentSession:f.agent.session.id,delegationDepth:1})
 child.session.append('turn/start',{turn:0})
 assert.equal((await f.call(navigate,child)).isError,true,'父策略不能代替 child 持久归属')
 f.browser.bind({...f.run,sessionId:child.session.id})
 assert.equal((await f.call(navigate,child)).isError,false);await f.call();f.stop()
 // 官方 Team 在停止后的继续派发闸不能吞掉已经登记的子会话收尾。
 f.ctx.provide('agentTeams',{tryMembership:agent=>agent===child?{role:'teammate'}:undefined})
 assert.equal((await f.browser.cancel(f.run,AbortSignal.timeout(5000))).closed,true)
 assert.deepEqual(new Set(f.calls.filter(row=>row.name===close).map(row=>row.agent.session.id)),new Set([f.agent.session.id,child.session.id]))
 assert.equal((await f.browser.state(f.run)).outstanding,false)
})

test('审批期间请求停止时，即使旧审批通过也不得再派发',async t=>{
 const f=await fixture(t),asked=Promise.withResolvers(),answer=Promise.withResolvers()
 f.ctx.on('approval/request',async()=>{asked.resolve();return answer.promise},{prepend:true})
 const pending=f.call();await asked.promise;f.stopping=true;answer.resolve('allowed-once')
 assert.equal((await pending).isError,true);assert.equal(f.calls.length,0);assert.equal(f.rows.size,0)
})

test('Run 端口实际接入：发送建立归属，停止等待浏览器回收，失败不能发布已完成',async t=>{
 const {attachTaskRunBrowser}=await import('../src/task-run-browser.ts')
 const {TaskRunDriver}=await import('../src/task-run-driver.ts')
 const f=await fixture(t,{bind:false}),states=[]
 let current={...f.run,state:'active',stopRequestedAt:null},sent=false
 const ports={
  check:async()=>{},
  send:async()=>{sent=true;assert.equal((await f.call()).isError,false)},
  stop:async()=>{if(!readSessionEvents(f.agent.session).some(event=>event.type==='turn/end'))f.stop()},stopChildren:async()=>{},
  stopState:async()=>({running:false,settledSeq:2}),
  events:async()=>readSessionEvents(f.agent.session),
  backgroundState:async()=>({outstanding:false,interrupted:false}),
 }
 assert.equal(typeof attachTaskRunBrowser,'function','宿主必须将浏览器生命周期接进业务 Run')
 attachTaskRunBrowser(ports,f.browser)
 await ports.send(f.run,AbortSignal.timeout(5000),{});assert.equal(sent,true)
 const driver=new TaskRunDriver({get:async()=>current,requestStop:async()=>current={...current,stopRequestedAt:'2026-09-24T00:00:00Z'},record:async(_owner,input)=>{states.push(input.evidence);return current}},ports)
 f.failClose=true
 await assert.rejects(driver.stop('owner',{},AbortSignal.timeout(5000)))
 await driver.reconcile('owner',{})
 assert.equal(states.at(-1).state,'active')
 assert.deepEqual(await ports.stopState(f.run),{running:true,settledSeq:null})
 f.failClose=false
 await driver.stop('owner',{},AbortSignal.timeout(5000))
 assert.equal(states.at(-1).state,'ended');assert.equal(states.at(-1).reason,'aborted')
 assert.equal((await ports.backgroundState(f.run)).outstanding,false)
})

test('浏览器包装保留无页面的旧 owner 文本候选，存在派发记录就撤销候选',async t=>{
 const {attachTaskRunBrowser}=await import('../src/task-run-browser.ts')
 const f=await fixture(t)
 const ports={send:async()=>{},backgroundState:async()=>({outstanding:false,interrupted:true,ownerOnly:true})}
 attachTaskRunBrowser(ports,f.browser)
 assert.deepEqual(await ports.backgroundState(f.run),{outstanding:false,interrupted:true,ownerOnly:true})
 assert.equal((await f.call()).isError,false)
 assert.deepEqual(await ports.backgroundState(f.run),{outstanding:false,interrupted:true})
})

for(const cancelled of [false,true])test(`受管子会话${cancelled?'取消':'自然完成'}进入 idle 时先关闭页面，whenIdle 等待维护回执`,async t=>{
 const {textResponse}=await import('../../../tests/native-auto-review-fixture.mjs')
 const f=await fixture(t),child=await f.create('closing-child',{origin:'subagent',parentSession:f.agent.session.id,delegationDepth:1})
 f.browser.bind({...f.run,sessionId:child.session.id})
 child.session.append('turn/start',{turn:0})
 assert.equal((await f.call(navigate,child)).isError,false)
 child.session.append('turn/end',{turn:0,reason:{kind:'completed'}})
 if(cancelled){
  // 真实 loop 请求一个尚未提供脚本的响应，取消走非正常 stop-boundary 路径。
  child.followup(createUserMessage({content:[],source:{kind:'user'}}));child.cancel({kind:'user'})
 }else{
  f.adapter.script.push(textResponse('done'))
  child.followup(createUserMessage({content:[],source:{kind:'user'}}))
 }
 await child.whenIdle()
 assert.equal((await f.browser.state(f.run)).dirty,false,'必须在官方 owner 可以卸载前取得 close 成功回执')
 assert.equal(f.calls.filter(row=>row.name===close&&row.agent===child).length,1)
 assert.equal(f.asks,1,'生命周期回收不再次请求审批')
})


test('子级收尾读取策略尚未回包时也阻止 Run 收口；再次取消不打断资源回收',async t=>{
 const {textResponse}=await import('../../../tests/native-auto-review-fixture.mjs')
 const f=await fixture(t),child=await f.create('pending-close-child',{origin:'subagent',parentSession:f.agent.session.id,delegationDepth:1})
 f.browser.bind({...f.run,sessionId:child.session.id});child.session.append('turn/start',{turn:0})
 await f.call(navigate,child);child.session.append('turn/end',{turn:0,reason:{kind:'completed'}})
 const entered=Promise.withResolvers(),release=Promise.withResolvers()
 let reads=0;f.policyPause=()=>{if(reads++===0){entered.resolve();return release.promise}}
 f.adapter.script.push(textResponse('done'));child.followup(createUserMessage({content:[],source:{kind:'user'}}))
 await entered.promise
 try{assert.equal((await f.browser.state(f.run)).outstanding,true,'私有维护已领取，即使关闭工具尚未派发也不能先交付')}finally{release.resolve()}
 f.stopping=true;child.cancel({kind:'parent'})
 release.resolve();await child.whenIdle()
 assert.equal((await f.browser.state(f.run)).dirty,false)
})

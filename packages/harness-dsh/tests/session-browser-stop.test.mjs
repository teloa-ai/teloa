import test from 'node:test'
import assert from 'node:assert/strict'
import {setTimeout as delay} from 'node:timers/promises'
import {createRuntime,defineTool,ToolCallId,createUserMessage,toolResponse,textResponse,official} from '../../../tests/native-auto-review-fixture.mjs'
import {createTaskRunBrowser} from '../src/task-run-browser.ts'
import {readSessionEvents} from '../src/session-events.ts'

const navigate='mcp__playwright-mcp__browser_navigate',close='mcp__playwright-mcp__browser_close'
const source='plugin:teloa.browser-stop'
async function fixture(t){
 const {ctx,create,adapter}=await createRuntime(t),agent=await create('ordinary-browser'),other=await create('other-browser')
 // 仅替代 RPC 服务装配；取消、队列、轮次、审批和工具执行使用官方真实实现。
 const controller={cancel({sessionId}){const target=ctx.agents.get(sessionId);if(!target)throw Error('not attached');target.cancel({kind:'user'},{keepInbox:true});return {accepted:true}}}
 ctx.provide('sessionController',controller)
 const original=controller.cancel,links={list:async()=>{throw Error('no Run')},put:async()=>{throw Error('no Run')}}
 const browser=createTaskRunBrowser(ctx,links,async()=>null);t.after(browser.dispose)
 const calls=[],closeStarted=Promise.withResolvers(),navigationStarted=Promise.withResolvers()
 let closeBody=async()=>{},navigationBody=async()=>{},sequence=0
 for(const name of [navigate,close])ctx.tools.register(defineTool({name,description:name,parameters:{},output:{schema:{type:'string'},render:(_args,text)=>[{type:'text',text}]},execute:async(_args,exec)=>{
  calls.push({name,agent:exec.agent})
  if(name===close){closeStarted.resolve();await closeBody(exec)}else {navigationStarted.resolve();await navigationBody(exec)}
  return 'done'
 }}))
 const execute=(name=navigate,target=agent)=>ctx.tools.execute({name,agent:target,arguments:{},callId:ToolCallId('ordinary-'+ ++sequence),signal:AbortSignal.timeout(30000)})
 return {ctx,agent,other,create,adapter,browser,controller,original,calls,execute,closeStarted,navigationStarted,
  set closeBody(fn){closeBody=fn},set navigationBody(fn){navigationBody=fn},
  stop:()=>controller.cancel({sessionId:agent.session.id}),
  message:text=>createUserMessage({source:{kind:'user'},content:[{type:'text',text}]}),
  notices:()=>readSessionEvents(agent.session).filter(event=>event.type==='user/message'&&event.data.source.kind===source&&event.data.source.state!=='ready'),
 }
}

test('正常浏览保留页面；晚到停止关闭当前 Agent，重复空闲停止不重复关闭',async t=>{
 const f=await fixture(t)
 assert.equal((await f.execute()).isError,false);await f.execute(navigate,f.other)
 assert.equal(f.calls.filter(call=>call.name===close).length,0)
 assert.deepEqual(f.stop(),{accepted:true});await f.agent.whenIdle()
 assert.deepEqual(f.calls.filter(call=>call.name===close).map(call=>call.agent),[f.agent])
 f.stop();await f.agent.whenIdle()
 assert.equal(f.calls.filter(call=>call.name===close).length,1)
 assert.equal(f.notices().length,0)
 assert.equal(f.ctx.agents.get(f.agent.session.id),f.agent)
 await f.browser.dispose();assert.equal(f.controller.cancel,f.original)
})

test('连续停止不打断关闭，立即发送保留在队列且只继续一次',async t=>{
 const f=await fixture(t),finishClose=Promise.withResolvers()
 f.navigationBody=exec=>delay(30000,undefined,{signal:exec.signal})
 f.closeBody=()=>finishClose.promise
 t.after(()=>finishClose.resolve())
 f.adapter.script=[toolResponse(navigate,'navigate'),textResponse('continued')]
 f.agent.followup(f.message('navigate'));await f.navigationStarted.promise
 f.stop();await f.closeStarted.promise
 f.agent.followup(f.message('continue'));f.stop();f.stop()
 assert.equal(f.adapter.requests.length,1,'关闭期间下一条消息还未开始模型请求')
 finishClose.resolve();await f.agent.whenIdle()
 assert.equal(f.adapter.requests.length,2)
 assert.equal(f.calls.filter(call=>call.name===close).length,1)
 assert.equal(readSessionEvents(f.agent.session).filter(event=>event.type==='user/message'&&event.data.source.kind==='user').length,2)
 assert.equal(f.notices().length,0)
})

for(const kind of ['deny','ask'])test(`关闭派发前 ${kind} 保留真实失败提示，授权恢复后可重试`,async t=>{
 const f=await fixture(t);await f.execute()
 const off=f.ctx.on('tools/pre-execute',async(exec,next)=>exec.name===close?{kind,reason:'fixture approval boundary'}:next())
 let approvals=0;f.ctx.on('approval/request',()=>{approvals++;return 'allowed-once'})
 f.stop();await f.agent.whenIdle()
 assert.equal(f.calls.filter(call=>call.name===close).length,0)
 assert.equal(f.notices().length,1)
 assert.match(f.notices()[0].data.content[0].text,/未成功|未获授权/)
 assert.equal(approvals,0,'维护阶段没有 open turn，不得伪造审批轮次')
 off();f.stop();await f.agent.whenIdle()
 assert.equal(f.calls.filter(call=>call.name===close).length,1)
 assert.equal(f.notices().length,1)
})

test('关闭已派发却超时后禁止复用同一浏览器，普通聊天及其他会话继续',{timeout:20000},async t=>{
 const f=await fixture(t);await f.execute()
 f.closeBody=exec=>delay(30000,undefined,{signal:exec.signal})
 f.stop();await f.agent.whenIdle()
 assert.equal(f.notices().length,1)
 assert.equal((await f.execute()).isError,true,'超时不能让迟到关闭误关下一次新页面')
 f.closeBody=async()=>{}
 assert.equal((await f.execute(close)).isError,true,'不能以重入 close 的提前成功掩盖未知关闭结果')
 assert.equal((await f.execute(navigate,f.other)).isError,false)
 f.adapter.script=[textResponse('chat still available')]
 f.agent.followup(f.message('hello'));await f.agent.whenIdle()
 assert.equal(f.adapter.requests.length,1)
 assert.equal(f.calls.filter(call=>call.name===navigate&&call.agent===f.agent).length,1)
})

test('普通 fork 也清理；没有派发浏览器的会话不产生清理或提示',async t=>{
 const f=await fixture(t),fork=await f.create('ordinary-fork',{parentSession:f.agent.session.id})
 f.stop();await f.agent.whenIdle();assert.equal(f.calls.length,0);assert.equal(f.notices().length,0)
 await f.execute(navigate,fork);f.controller.cancel({sessionId:fork.session.id});await fork.whenIdle()
 assert.deepEqual(f.calls.filter(call=>call.name===close).map(call=>call.agent),[fork])
})

test('模型正常完成不关闭浏览器，工具自行成功关闭后无需重复收尾',async t=>{
 const f=await fixture(t)
 f.adapter.script=[toolResponse(navigate,'navigate'),textResponse('done')]
 f.agent.followup(f.message('browse'));await f.agent.whenIdle()
 assert.equal(f.calls.filter(call=>call.name===close).length,0)
 assert.equal((await f.execute(close)).isError,false)
 f.stop();await f.agent.whenIdle()
 assert.equal(f.calls.filter(call=>call.name===close).length,1)
})

test('卸载等待尚未派发的关闭；关闭异常后重装不能解除同一 Agent 的隔离',async t=>{
 const f=await fixture(t);await f.execute()
 const entered=Promise.withResolvers(),gate=Promise.withResolvers()
 t.after(()=>gate.resolve())
 f.ctx.on('tools/pre-execute',async(exec,next)=>{if(exec.name===close){entered.resolve();await gate.promise}return next()})
 f.closeBody=async()=>{throw Error('close failed after dispatch')}
 f.stop();await entered.promise
 const disposal=f.browser.dispose()
 gate.resolve();await disposal;await f.agent.whenIdle()
 const installed=createTaskRunBrowser(f.ctx,{list:async()=>[],put:async()=>{}},async()=>null)
 t.after(installed.dispose)
 assert.equal((await f.execute()).isError,true,'在途收尾不能因卸载跳过未知关闭结果登记')
 assert.equal(f.calls.filter(call=>call.name===navigate).length,1)
})

test('关闭工具不可见时不标记在途未知，恢复工具后仍可重试',async t=>{
 const f=await fixture(t);await f.execute()
 const off=f.agent.ctx.tools.restrict({deny:[close]})
 f.stop();await f.agent.whenIdle()
 assert.equal(f.calls.filter(call=>call.name===close).length,0)
 assert.equal(f.notices().length,1)
 off();f.stop();await f.agent.whenIdle()
 assert.equal(f.calls.filter(call=>call.name===close).length,1)
})

test('当前状态来自 live Agent，成功重试追加恢复事件，不把旧失败当新会话状态',async t=>{
 const f=await fixture(t);await f.execute()
 const off=f.ctx.on('tools/pre-execute',async(exec,next)=>exec.name===close?{kind:'deny',reason:'fixture'}:next())
 f.stop();await f.agent.whenIdle()
 assert.equal(f.browser.sessionState?.(f.agent.session.id)?.state,'unconfirmed')
 assert.equal(f.browser.sessionState?.(f.other.session.id)?.state,'ready')
 off();f.stop();await f.agent.whenIdle()
 assert.equal(f.browser.sessionState?.(f.agent.session.id)?.state,'ready')
 assert.ok(readSessionEvents(f.agent.session).some(event=>event.type==='user/message'&&event.data.source.kind===source&&event.data.source.state==='ready'),'恢复事件令客户端刷新可见状态')
})

test('官方 PTC 缺少轮外关闭入口时如实提示，不伪造脚本轮次绕过工具面',async t=>{
 const f=await fixture(t)
 for(const name of ['dsh-subprocess-local','dsh-sandbox-local','dsh-fs-sandbox','dsh-ptc-runtime-node']){const module=await official(name);await f.ctx.plugin(module.default??module,{})}
 await f.execute();f.agent.ctx.tools.presentAs('ptc')
 f.stop();await f.agent.whenIdle()
 assert.equal(f.calls.filter(call=>call.name===close).length,0,'PTC 不应直接调用已折叠的浏览器工具')
 assert.equal(f.notices().length,1)
 assert.equal(f.browser.sessionState(f.agent.session.id).state,'unconfirmed')
 assert.equal(readSessionEvents(f.agent.session).filter(event=>event.type==='tool/ptc-dispatch-start'||event.type==='turn/start').length,0)
})

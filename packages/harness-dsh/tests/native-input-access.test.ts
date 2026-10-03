import test from 'node:test'
import assert from 'node:assert/strict'
import {Context} from '@deepseek-ai/cordis'
import {SessionStore,Session,SessionId,SessionSeq,snapshotSessionEvent,type UserMessage} from '@deepseek-ai/dsh-session'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {LlmRuntime,createUserMessage} from '@deepseek-ai/dsh-llm'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import type {WorkAccessLease} from '@teloa/backend'
import {createNativeInputGuard,nativeInputIdentity} from '../src/native-input-access.ts'

const forbidden={code:'teloa/forbidden',message:'当前暂不能提交新输入，请核对运行许可后重试。'}
const allow=():WorkAccessLease=>({assertCurrent:()=>{}})
const message=(requestId='request',text='固定输入')=>createUserMessage({content:[{type:'text' as const,text}],source:{kind:'user' as const,rpcId:requestId}})
const deferred=()=>{let resolve:()=>void=()=>{};const promise=new Promise<void>(done=>{resolve=done});return {promise,resolve}}
async function fixture(t:{after:(action:()=>unknown)=>void}){
 const ctx=new Context();t.after(()=>ctx.fiber.dispose())
 for(const plugin of [LlmRuntime,SessionStore,SessionProjectionRegistry,SystemPrompt,ToolRuntime,AgentRegistry])await ctx.plugin(plugin)
 await ctx.plugin(AgentLoop,{agents:[]})
 const {agent}=await ctx.agents.create({sessionId:SessionId('guard-a'),agentOptions:{provider:'test',model:'test'}})
 const {agent:other}=await ctx.agents.create({sessionId:SessionId('guard-b'),agentOptions:{provider:'test',model:'test'}})
 return {ctx,agent,other}
}

test('Free 未安装守卫时保留官方真实 inbox 行为',async t=>{
 const {agent}=await fixture(t),input=message()
 agent.inbox.append('next-turn',input)
 assert.equal(agent.inbox.nextTurn[0]?.id,input.id)
})

test('真实 Inbox.mutate 无 proof 时追加前否决，许可只包围原对象与冻结快照',async t=>{
 const {ctx,agent}=await fixture(t),guard=createNativeInputGuard(ctx),input=message(),before=agent.session.snapshotEvents().length
 let inserted=0,events=0
 agent.ctx.on('agent/inbox/inserted',()=>{inserted++})
 ctx.on('session/event',()=>{events++},{global:true})
 assert.throws(()=>agent.inbox.append('next-turn',input),forbidden)
 assert.equal(agent.session.snapshotEvents().length,before);assert.equal(agent.inbox.nextTurn.length,0);assert.equal(inserted,0);assert.equal(events,0)
 const identity=nativeInputIdentity(input,'request')
 assert.equal(await guard.withLease(agent.session,identity,allow(),()=>{agent.inbox.append('next-turn',input);return 'accepted'}),'accepted')
 assert.equal(ctx.agents.get(agent.id),agent);assert.equal(ctx.sessions.get(agent.id),agent.session)
 assert.equal(agent.inbox.nextTurn[0]?.id,input.id);assert.notEqual(agent.inbox.nextTurn[0],input)
 assert.ok(Object.isFrozen(agent.inbox.nextTurn[0]));assert.equal(inserted,1);assert.equal(events,1)
})

test('摘要复用官方 JSON 快照，克隆及对象键顺序相同，载荷变化不同',()=>{
 const input=message(),identity=nativeInputIdentity(input,'request')
 const clone={source:{rpcId:'request',kind:'user'},content:input.content,role:'user',id:input.id} as UserMessage
 const snapshot=snapshotSessionEvent({type:'user/message',seq:SessionSeq(0),time:0,data:input,surfaceOp:'append'}).data
 assert.deepEqual(nativeInputIdentity(clone,'request'),identity);assert.deepEqual(nativeInputIdentity(snapshot,'request'),identity)
 assert.notEqual(nativeInputIdentity({...clone,content:[{type:'text',text:'改动'}]},'request').payloadSha256,identity.payloadSha256)
 assert.throws(()=>nativeInputIdentity(input,'other'),forbidden)
 assert.throws(()=>nativeInputIdentity({...input,content:[{type:'text',text:'x',extra:undefined}]} as unknown as UserMessage),forbidden)
})

test('异步 action 只准许固定克隆；remove/clear 不需要新许可',async t=>{
 const {ctx,agent}=await fixture(t),guard=createNativeInputGuard(ctx),input=message(),clone=structuredClone(input)
 await guard.withLease(agent.session,nativeInputIdentity(input,'request'),allow(),async()=>{
  await Promise.resolve();agent.inbox.append('next-step',clone)
 })
 assert.equal(agent.inbox.nextStep[0]?.id,input.id)
 assert.equal(agent.inbox.remove(input.id),true);agent.inbox.clear()
 assert.throws(()=>agent.inbox.append('next-step',input),forbidden)
})

test('不能以同 id 的 detached Session 或别的 Session 借用 proof',async t=>{
 const {ctx,agent,other}=await fixture(t),guard=createNativeInputGuard(ctx),input=message(),identity=nativeInputIdentity(input,'request')
 await assert.rejects(guard.withLease(Session.create(agent.id),identity,allow(),()=>{}),forbidden)
 const before=other.session.snapshotEvents().length
 await guard.withLease(agent.session,identity,allow(),()=>{
  assert.throws(()=>other.inbox.append('next-turn',input),forbidden)
 })
 assert.equal(other.session.snapshotEvents().length,before);assert.deepEqual(other.inbox.nextTurn,[])
})

test('消息 id、原生请求或载荷不同均零写入，之后原输入仍可追加',async t=>{
 const {ctx,agent}=await fixture(t),guard=createNativeInputGuard(ctx),input=message(),before=agent.session.snapshotEvents().length
 await guard.withLease(agent.session,nativeInputIdentity(input,'request'),allow(),()=>{
  for(const changed of [message(),{...input,source:{kind:'user',rpcId:'other'}},{...input,content:[{type:'text',text:'别的工作'}]}] as UserMessage[]){
   assert.throws(()=>agent.inbox.append('next-turn',changed),forbidden)
  }
  assert.equal(agent.session.snapshotEvents().length,before);agent.inbox.append('next-turn',input)
 })
 assert.equal(agent.inbox.nextTurn.length,1)
})

test('单条许可不能放行多消息混入或同消息重复的批次',async t=>{
 const {ctx,agent}=await fixture(t),guard=createNativeInputGuard(ctx),input=message(),before=agent.session.snapshotEvents().length
 await guard.withLease(agent.session,nativeInputIdentity(input,'request'),allow(),()=>{
  assert.throws(()=>agent.inbox.splice('next-turn',0,0,[input,message('other')]),forbidden)
  // Inbox 自身先拒绝重复 id；直接 Session 路径也必须被最终守卫拒绝。
  assert.throws(()=>agent.inbox.splice('next-turn',0,0,[input,structuredClone(input)]),/already pending/)
  assert.throws(()=>agent.session.append('agent/inbox/spliced',{target:'next-turn',start:0,removedCount:0,inserted:[input,structuredClone(input)]}),forbidden)
 })
 assert.equal(agent.session.snapshotEvents().length,before);assert.equal(agent.inbox.nextTurn.length,0)
})

test('并发 ALS 调用互不借用 proof，原各自消息可以追加',async t=>{
 const {ctx,agent,other}=await fixture(t),guard=createNativeInputGuard(ctx),a=message('a'),b=message('b'),readyA=deferred(),readyB=deferred()
 await Promise.all([
  guard.withLease(agent.session,nativeInputIdentity(a,'a'),allow(),async()=>{
   readyA.resolve();await readyB.promise
   assert.throws(()=>agent.inbox.append('next-turn',b),forbidden)
   assert.throws(()=>other.inbox.append('next-turn',b),forbidden)
   agent.inbox.append('next-turn',a)
  }),
  guard.withLease(other.session,nativeInputIdentity(b,'b'),allow(),async()=>{
   readyB.resolve();await readyA.promise
   assert.throws(()=>other.inbox.append('next-turn',a),forbidden)
   other.inbox.append('next-turn',b)
  }),
 ])
 assert.equal(agent.inbox.nextTurn[0]?.id,a.id);assert.equal(other.inbox.nextTurn[0]?.id,b.id)
})

test('action 成功结束后继承 ALS 的迟到回调不能再写入',async t=>{
 const {ctx,agent}=await fixture(t),guard=createNativeInputGuard(ctx),input=message(),before=agent.session.snapshotEvents().length
 let pending:Promise<void>=Promise.resolve()
 await guard.withLease(agent.session,nativeInputIdentity(input,'request'),allow(),()=>{
  pending=new Promise<void>((resolve,reject)=>setImmediate(()=>{
   try{assert.throws(()=>agent.inbox.append('next-turn',input),forbidden);resolve()}catch(error){reject(error)}
  }))
 })
 await pending;assert.equal(agent.session.snapshotEvents().length,before)
})

test('action 拒绝后迟到 microtask 的 ticket 也关闭',async t=>{
 const {ctx,agent}=await fixture(t),guard=createNativeInputGuard(ctx),input=message(),release=deferred()
 let pending:Promise<void>=Promise.resolve()
 await assert.rejects(guard.withLease(agent.session,nativeInputIdentity(input),allow(),async()=>{
  pending=release.promise.then(()=>{assert.throws(()=>agent.inbox.append('next-turn',input),forbidden)})
  throw Error('producer failed')
 }),/producer failed/)
 release.resolve();await pending;assert.equal(agent.inbox.nextTurn.length,0)
})

test('许可在 await 期间失效，本守卫执行时拒绝且零写入',async t=>{
 const {ctx,agent}=await fixture(t),guard=createNativeInputGuard(ctx),input=message(),release=deferred(),before=agent.session.snapshotEvents().length
 let current=true
 const action=guard.withLease(agent.session,nativeInputIdentity(input),{assertCurrent:()=>{if(!current)throw Error('private identity expired')}},async()=>{
  await release.promise;agent.inbox.append('next-turn',input)
 })
 current=false;release.resolve();await assert.rejects(action,forbidden)
 assert.equal(agent.session.snapshotEvents().length,before);assert.equal(agent.inbox.nextTurn.length,0)
})

test('异步 assertion、非空返回及异常 getter 都以固定错误拒绝',async t=>{
 const {ctx,agent}=await fixture(t),guard=createNativeInputGuard(ctx),input=message(),identity=nativeInputIdentity(input)
 let calls=0
 const bad=[{assertCurrent:()=>Promise.reject(Error('private rejected'))},{assertCurrent:()=>false},{get assertCurrent(){throw Error('private getter')}},{assertCurrent:()=>{throw Error('private clock')}}]
 for(const lease of bad)await assert.rejects(guard.withLease(agent.session,identity,lease as unknown as WorkAccessLease,()=>{calls++;agent.inbox.append('next-turn',input)}),forbidden)
 await new Promise<void>(done=>setImmediate(done));assert.equal(calls,0);assert.equal(agent.inbox.nextTurn.length,0)
})

test('固定 assertion 引用，不能在 await 后替换成允许函数',async t=>{
 const {ctx,agent}=await fixture(t),guard=createNativeInputGuard(ctx),input=message(),release=deferred()
 let current=true
 const lease={assertCurrent:()=>{if(!current)throw Error('revoked')}}
 const action=guard.withLease(agent.session,nativeInputIdentity(input),lease,async()=>{await release.promise;agent.inbox.append('next-turn',input)})
 current=false;lease.assertCurrent=()=>{};release.resolve();await assert.rejects(action,forbidden);assert.equal(agent.inbox.nextTurn.length,0)
})

test('后续官方 listener 否决不消费 proof，同 scope 可以重试相同候选',async t=>{
 const {ctx,agent}=await fixture(t),guard=createNativeInputGuard(ctx),input=message(),before=agent.session.snapshotEvents().length
 let veto=true
 ctx.on('internal/dispatch',(_mode,name,args)=>{
  if(name==='session/event'&&args[1]?.type==='agent/inbox/spliced'&&veto){veto=false;throw Error('later veto')}
 })
 await guard.withLease(agent.session,nativeInputIdentity(input),allow(),()=>{
  assert.throws(()=>agent.inbox.append('next-turn',input),/later veto/)
  assert.equal(agent.session.snapshotEvents().length,before);assert.equal(agent.inbox.nextTurn.length,0)
  agent.inbox.append('next-turn',input)
 })
 assert.equal(agent.session.snapshotEvents().length,before+1);assert.equal(agent.inbox.nextTurn[0]?.id,input.id)
})

test('已知官方顺序边界：后续 listener 只使许可失效但不否决，候选仍会提交',async t=>{
 const {ctx,agent}=await fixture(t),guard=createNativeInputGuard(ctx),input=message(),before=agent.session.snapshotEvents().length
 let current=true
 const lease={assertCurrent:()=>{if(!current)throw Error('revoked after guard')}}
 // 保存真实限制：这不是最终 commit 屏障，不能把改注册顺序当作完整修复。
 ctx.on('internal/dispatch',(_mode,name,args)=>{
  if(name==='session/event'&&args[1]?.type==='agent/inbox/spliced')current=false
 })
 await guard.withLease(agent.session,nativeInputIdentity(input),lease,()=>agent.inbox.append('next-turn',input))
 assert.equal(current,false)
 assert.equal(agent.session.snapshotEvents().length,before+1)
 assert.equal(agent.inbox.nextTurn[0]?.id,input.id)
 assert.throws(()=>lease.assertCurrent(),/revoked after guard/)
})

test('关闭永久拒绝新的与在途 scope 插入，允许已受理的清空且不能重复安装',async t=>{
 const {ctx,agent}=await fixture(t),guard=createNativeInputGuard(ctx),input=message(),later=message('later'),release=deferred()
 await guard.withLease(agent.session,nativeInputIdentity(input),allow(),()=>agent.inbox.append('next-turn',input))
 const action=guard.withLease(agent.session,nativeInputIdentity(later),allow(),async()=>{await release.promise;agent.inbox.append('next-turn',later)})
 guard.close();guard.close();release.resolve();await assert.rejects(action,forbidden)
 await assert.rejects(guard.withLease(agent.session,nativeInputIdentity(later),allow(),()=>agent.inbox.append('next-turn',later)),forbidden)
 assert.throws(()=>agent.inbox.append('next-turn',later),forbidden);assert.throws(()=>createNativeInputGuard(ctx),forbidden)
 agent.inbox.clear();assert.equal(agent.inbox.nextTurn.length,0)
})

test('已受理 seed 恢复不重验许可，关闭之后新输入仍拒绝',async t=>{
 const {ctx,agent}=await fixture(t),guard=createNativeInputGuard(ctx),input=message()
 let assertions=0
 await guard.withLease(agent.session,nativeInputIdentity(input),{assertCurrent:()=>{assertions++}},()=>agent.inbox.append('next-turn',input))
 const before=assertions,seed=agent.session.snapshotEvents();guard.close()
 const replay=ctx.sessions.create(SessionId('history-copy'),{seed})
 assert.equal(assertions,before)
 assert.equal(replay.snapshotEvents().filter(event=>event.type==='agent/inbox/spliced').length,1)
 assert.throws(()=>replay.append('agent/inbox/spliced',{target:'next-turn',start:1,removedCount:0,inserted:[message('new')]}),forbidden)
 replay.append('agent/inbox/spliced',{target:'next-turn',start:0,removedCount:1,inserted:[]})
})

test('官方 JSON 与 surface 校验先于准入钩子，非法候选不进入 dispatch',async t=>{
 const {ctx,agent}=await fixture(t),guard=createNativeInputGuard(ctx),input=message(),before=agent.session.snapshotEvents().length
 let assertions=0,dispatches=0
 ctx.on('internal/dispatch',(_mode,name)=>{if(name==='session/event')dispatches++})
 await guard.withLease(agent.session,nativeInputIdentity(input),{assertCurrent:()=>{assertions++}},()=>{
  const invalid={...input,content:[{type:'text',text:undefined}]} as unknown as UserMessage
  assert.throws(()=>agent.session.append('agent/inbox/spliced',{target:'next-turn',start:0,removedCount:0,inserted:[invalid]}),/non-JSON-serializable/)
  assert.throws(()=>agent.session.append('user/message',input,{surfaceOp:{op:'replace',startSeq:SessionSeq(0),endSeq:SessionSeq(999)}}))
 })
 assert.equal(assertions,1);assert.equal(dispatches,0);assert.equal(agent.session.snapshotEvents().length,before)
})

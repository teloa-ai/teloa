import test from 'node:test'
import assert from 'node:assert/strict'
import {Context} from '@deepseek-ai/cordis'
import {SessionStore,SessionId,Session,type UserMessage} from '@deepseek-ai/dsh-session'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import type {WorkAccessLease} from '@teloa/backend'
import {createNativeInputGuard,nativeInputIdentity} from '../src/native-input-access.ts'
import {patchedSessionFixture,type AppendAdmissionPolicy,type FinalSessionStore} from './fixtures/native-final-session.ts'

const forbidden={code:'teloa/forbidden',message:'当前暂不能提交新输入，请核对运行许可后重试。'}
const allow=():WorkAccessLease=>({assertCurrent:()=>{}})
const message=(rpcId='request',text='固定输入')=>createUserMessage({content:[{type:'text' as const,text}],source:{kind:'user' as const,rpcId}})
const deferred=()=>{let resolve:()=>void=()=>{};const promise=new Promise<void>(done=>{resolve=done});return {promise,resolve}}

test('final:true 要求补口能力；原 npm 不会被悄悄降级或修改',async t=>{
 const ctx=new Context();t.after(()=>ctx.fiber.dispose());await ctx.plugin(SessionStore)
 assert.equal(Reflect.get(Reflect.get(ctx,'sessions'),'requireAppendAdmission'),undefined)
 assert.throws(()=>createNativeInputGuard(ctx,{final:true}),forbidden)
 const guard=createNativeInputGuard(ctx)
 assert.equal(typeof guard.withLease,'function')
})

test('补口未安装时 Free 保留真实 AgentLoop/Inbox 同实例及官方提交',async t=>{
 const {ctx,agent,other}=await patchedSessionFixture(t),input=message()
 agent.inbox.append('next-turn',input)
 assert.equal(agent.inbox.nextTurn[0]?.id,input.id)
 assert.equal(ctx.agents.get(agent.id),agent);assert.equal((Reflect.get(ctx,'sessions') as unknown as SessionStore).get(other.id),other.session)
})

test('require 单向、缺 policy 拒绝、唯一 policy 且同函数幂等，共享 scoped store',async t=>{
 const {agent,other,sessions}=await patchedSessionFixture(t),input=message(),before=agent.session.snapshotEvents().length
 sessions.requireAppendAdmission();sessions.requireAppendAdmission()
 assert.throws(()=>agent.inbox.append('next-turn',input),/admission is unavailable/)
 assert.equal(agent.session.snapshotEvents().length,before)
 let calls=0
 const policy:AppendAdmissionPolicy=(session,event)=>{
  assert.ok(session===agent.session||session===other.session)
  assert.ok(Object.isFrozen(event));assert.ok(Object.isFrozen(event.data));calls++
 }
 sessions.installAppendAdmission(policy);sessions.installAppendAdmission(policy)
 ;(Reflect.get(agent.ctx,'sessions') as unknown as FinalSessionStore).installAppendAdmission(policy)
 assert.throws(()=>sessions.installAppendAdmission(()=>{}),/already installed/)
 assert.throws(()=>sessions.installAppendAdmission(undefined as unknown as AppendAdmissionPolicy),/must be a function/)
 agent.inbox.append('next-turn',input);other.inbox.append('next-turn',message('other'))
 assert.equal(calls,2)
})

test('原 store 与 scoped receiver 都不能替换 holder，已有与新 enter 仍 required 拒绝',async t=>{
 const {agent,sessions}=await patchedSessionFixture(t),input=message(),before=agent.session.snapshotEvents().length
 sessions.requireAppendAdmission()
 const holder=Reflect.get(sessions,'appendAdmission')
 assert.ok(Object.isFrozen(holder))
 const replacement={require:()=>{},install:()=>{},assert:()=>{}}
 for(const receiver of [sessions,Reflect.get(agent.ctx,'sessions')]){
  const descriptor=Object.getOwnPropertyDescriptor(receiver,'appendAdmission')
  assert.equal(descriptor?.writable,false);assert.equal(descriptor?.configurable,false)
  assert.equal(Reflect.set(receiver,'appendAdmission',replacement),false)
  assert.equal(Reflect.deleteProperty(receiver,'appendAdmission'),false)
  assert.throws(()=>Object.defineProperty(receiver,'appendAdmission',{value:replacement}),TypeError)
  assert.equal(Reflect.get(receiver,'appendAdmission'),holder)
 }
 assert.equal(Reflect.set(holder,'assert',()=>{}),false)
 assert.throws(()=>agent.inbox.append('next-turn',input),/admission is unavailable/)
 assert.equal(agent.session.snapshotEvents().length,before);assert.equal(agent.inbox.nextTurn.length,0)
 // 不能靠更换 holder 令后续 scoped enter 捕获允许闭包。
 const entered=(Reflect.get(agent.ctx,'sessions') as unknown as FinalSessionStore).create(SessionId('holder-new-enter')),created=entered.snapshotEvents().length
 assert.throws(()=>entered.append('agent/inbox/spliced',{target:'next-turn',start:0,removedCount:0,inserted:[input]}),/admission is unavailable/)
 assert.equal(entered.snapshotEvents().length,created)
})

test('最终 validator 拒绝全部非 undefined 返回并接住异步拒绝，零写入',async t=>{
 for(const returned of [()=>false,()=>1,()=>null,()=>Promise.reject(Error('test rejected')),()=>({then(_resolve:unknown,reject:(error:Error)=>void){reject(Error('thenable rejected'))}})]){
  const {agent,sessions}=await patchedSessionFixture(t),before=agent.session.snapshotEvents().length
  sessions.installAppendAdmission(returned as unknown as AppendAdmissionPolicy)
  assert.throws(()=>agent.inbox.append('next-turn',message()),/must return undefined/)
  assert.equal(agent.session.snapshotEvents().length,before);assert.equal(agent.inbox.nextTurn.length,0)
 }
 await new Promise<void>(done=>setImmediate(done))
})

test('后续 dispatch listener 只令 lease 失效，最终核对仍在 log.push 前零写入',async t=>{
 const {ctx,agent}=await patchedSessionFixture(t),guard=createNativeInputGuard(ctx,{final:true}),input=message(),before=agent.session.snapshotEvents().length
 let current=true,invalidate=true,observed=0,inserted=0
 const lease={assertCurrent:()=>{if(!current)throw Error('revoked after pre-append')}}
 ctx.on('internal/dispatch',(_mode,name,args)=>{if(name==='session/event'&&args[1]?.type==='agent/inbox/spliced'&&invalidate)current=false})
 ctx.on('session/event',()=>{observed++},{global:true});agent.ctx.on('agent/inbox/inserted',()=>{inserted++})
 await guard.withLease(agent.session,nativeInputIdentity(input,'request'),lease,()=>{
  assert.throws(()=>agent.inbox.append('next-turn',input),forbidden)
  assert.equal(agent.session.snapshotEvents().length,before);assert.equal(agent.inbox.nextTurn.length,0)
  assert.equal(observed,0);assert.equal(inserted,0)
  invalidate=false;current=true;agent.inbox.append('next-turn',input)
 })
 assert.equal(agent.session.snapshotEvents().length,before+1);assert.equal(observed,1);assert.equal(inserted,1)
})

test('callback bind 的同步副作用同样发生在最终核对之前',async t=>{
 const {ctx,agent}=await patchedSessionFixture(t),guard=createNativeInputGuard(ctx,{final:true}),input=message(),before=agent.session.snapshotEvents().length
 let current=true,bound=0
 const observer=()=>{}
 Reflect.set(observer,'bind',()=>{bound++;current=false;return ()=>{}})
 ctx.on('session/event',observer,{global:true})
 await guard.withLease(agent.session,nativeInputIdentity(input),{assertCurrent:()=>{if(!current)throw Error('expired during bind')}},()=>{
  assert.throws(()=>agent.inbox.append('next-turn',input),forbidden)
 })
 assert.equal(bound,1);assert.equal(agent.session.snapshotEvents().length,before);assert.equal(agent.inbox.nextTurn.length,0)
})

test('final proof 只准 exact Session 和固定克隆；不同消息及批量混入拒绝',async t=>{
 const {ctx,agent,other}=await patchedSessionFixture(t),guard=createNativeInputGuard(ctx,{final:true}),input=message(),before=agent.session.snapshotEvents().length
 assert.throws(()=>agent.inbox.append('next-turn',input),forbidden)
 await assert.rejects(guard.withLease(Session.create(agent.id),nativeInputIdentity(input),allow(),()=>{}),forbidden)
 await guard.withLease(agent.session,nativeInputIdentity(input,'request'),allow(),()=>{
  assert.throws(()=>other.inbox.append('next-turn',input),forbidden)
  assert.throws(()=>agent.inbox.append('next-turn',{...input,content:[{type:'text',text:'changed'}]} as UserMessage),forbidden)
  assert.throws(()=>agent.inbox.splice('next-turn',0,0,[input,message('other')]),forbidden)
  assert.equal(agent.session.snapshotEvents().length,before)
  agent.inbox.append('next-turn',structuredClone(input))
 })
 assert.equal(agent.inbox.nextTurn[0]?.id,input.id);assert.equal(other.inbox.nextTurn.length,0)
})

test('最终检查遇到 async lease/动态返回拒绝，不能用 pre-append 成功掩盖',async t=>{
 const {ctx,agent}=await patchedSessionFixture(t),guard=createNativeInputGuard(ctx,{final:true}),input=message(),before=agent.session.snapshotEvents().length
 let asynchronous=false
 ctx.on('internal/dispatch',(_mode,name,args)=>{if(name==='session/event'&&args[1]?.type==='agent/inbox/spliced')asynchronous=true})
 const lease={assertCurrent:()=>asynchronous?Promise.reject(Error('late asynchronous assertion')):undefined}
 await assert.rejects(guard.withLease(agent.session,nativeInputIdentity(input),lease as unknown as WorkAccessLease,()=>agent.inbox.append('next-turn',input)),forbidden)
 await new Promise<void>(done=>setImmediate(done));assert.equal(agent.session.snapshotEvents().length,before)
})

test('关闭仍拒绝在途和迟到 scope，已受理删除与 replay 不做新许可检查',async t=>{
 const {ctx,agent,sessions}=await patchedSessionFixture(t),guard=createNativeInputGuard(ctx,{final:true}),input=message(),later=message('later'),release=deferred()
 let assertions=0
 await guard.withLease(agent.session,nativeInputIdentity(input),{assertCurrent:()=>{assertions++}},()=>agent.inbox.append('next-turn',input))
 const accepted=agent.session.snapshotEvents(),before=assertions
 const action=guard.withLease(agent.session,nativeInputIdentity(later),allow(),async()=>{await release.promise;agent.inbox.append('next-turn',later)})
 guard.close();release.resolve();await assert.rejects(action,forbidden)
 const replay=sessions.create(SessionId('replay-accepted'),{seed:accepted})
 assert.equal(assertions,before)
 assert.deepEqual(replay.snapshotEvents().filter(event=>event.type==='agent/inbox/spliced'),accepted.filter(event=>event.type==='agent/inbox/spliced'))
 replay.append('agent/inbox/spliced',{target:'next-turn',start:0,removedCount:1,inserted:[]})
 agent.inbox.clear();assert.equal(agent.inbox.nextTurn.length,0)
 assert.throws(()=>replay.append('agent/inbox/spliced',{target:'next-turn',start:0,removedCount:0,inserted:[later]}),forbidden)
 assert.throws(()=>createNativeInputGuard(ctx,{final:true}),forbidden)
})

test('后续同步 listener 抛错不消费 proof，官方 finally 复位后相同候选可重试',async t=>{
 const {ctx,agent}=await patchedSessionFixture(t),guard=createNativeInputGuard(ctx,{final:true}),input=message(),before=agent.session.snapshotEvents().length
 let veto=true
 ctx.on('internal/dispatch',(_mode,name,args)=>{if(name==='session/event'&&args[1]?.type==='agent/inbox/spliced'&&veto){veto=false;throw Error('dispatch veto')}})
 await guard.withLease(agent.session,nativeInputIdentity(input),allow(),()=>{
  assert.throws(()=>agent.inbox.append('next-turn',input),/dispatch veto/)
  assert.equal(agent.session.snapshotEvents().length,before);agent.inbox.append('next-turn',input)
 })
 assert.equal(agent.inbox.nextTurn[0]?.id,input.id)
})

test('已提交 observer 的同步及异步异常保留官方隔离，其后 observer 仍收到同一事件',async t=>{
 const {ctx,agent}=await patchedSessionFixture(t),guard=createNativeInputGuard(ctx,{final:true}),input=message(),before=agent.session.snapshotEvents().length
 let observed=0
 ctx.on('session/event',()=>{throw Error('test observer threw')},{global:true})
 ctx.on('session/event',()=>Promise.reject(Error('test observer rejected')),{global:true})
 ctx.on('session/event',(_session,event)=>{if(event.type==='agent/inbox/spliced')observed++},{global:true})
 await guard.withLease(agent.session,nativeInputIdentity(input),allow(),()=>agent.inbox.append('next-turn',input))
 await new Promise<void>(done=>setImmediate(done))
 assert.equal(agent.session.snapshotEvents().length,before+1);assert.equal(observed,1);assert.equal(agent.inbox.nextTurn[0]?.id,input.id)
})

test('并发 async proof 互相隔离且 action 结束后的 ALS 回调不能写入',async t=>{
 const {ctx,agent,other}=await patchedSessionFixture(t),guard=createNativeInputGuard(ctx,{final:true}),a=message('a'),b=message('b'),readyA=deferred(),readyB=deferred()
 await Promise.all([
  guard.withLease(agent.session,nativeInputIdentity(a),allow(),async()=>{readyA.resolve();await readyB.promise;assert.throws(()=>agent.inbox.append('next-turn',b),forbidden);agent.inbox.append('next-turn',a)}),
  guard.withLease(other.session,nativeInputIdentity(b),allow(),async()=>{readyB.resolve();await readyA.promise;assert.throws(()=>other.inbox.append('next-turn',a),forbidden);other.inbox.append('next-turn',b)}),
 ])
 const late=message('late'),before=agent.session.snapshotEvents().length
 let callback:Promise<void>=Promise.resolve()
 await guard.withLease(agent.session,nativeInputIdentity(late),allow(),()=>{
  callback=new Promise<void>((resolve,reject)=>setImmediate(()=>{try{assert.throws(()=>agent.inbox.append('next-turn',late),forbidden);resolve()}catch(error){reject(error)}}))
 })
 await callback;assert.equal(agent.session.snapshotEvents().length,before)
})

test('同步入口保留正常同 scope 入队及返回值，返回后立即关闭 ticket',async t=>{
 const {ctx,agent}=await patchedSessionFixture(t),guard=createNativeInputGuard(ctx,{final:true}),input=message()
 const returned=guard.withSyncLease(agent.session,nativeInputIdentity(input),allow(),()=>{agent.inbox.append('next-turn',input);return 'accepted'})
 assert.equal(returned,'accepted');assert.equal(agent.inbox.nextTurn[0]?.id,input.id)
 const late=message('late'),before=agent.session.snapshotEvents().length
 let callback:Promise<void>=Promise.resolve()
 guard.withSyncLease(agent.session,nativeInputIdentity(late),allow(),()=>{
  callback=Promise.resolve().then(()=>{assert.throws(()=>agent.inbox.append('next-turn',late),forbidden)})
 })
 await callback;assert.equal(agent.session.snapshotEvents().length,before)
})

test('普通同步函数返回 Promise 并排定入队时先关闭 scope，迟到输入零写',async t=>{
 const {ctx,agent}=await patchedSessionFixture(t),guard=createNativeInputGuard(ctx,{final:true}),input=message(),before=agent.session.snapshotEvents().length
 let pending:Promise<void>=Promise.resolve()
 assert.throws(()=>guard.withSyncLease(agent.session,nativeInputIdentity(input),allow(),function(){
  pending=Promise.resolve().then(()=>{assert.throws(()=>agent.inbox.append('next-turn',input),forbidden)})
  return pending
 }),forbidden)
 await pending;assert.equal(agent.session.snapshotEvents().length,before);assert.equal(agent.inbox.nextTurn.length,0)
})

test('同步入口拒绝 Promise.reject 并接住拒绝，自定义 thenable 同样不持有 ticket',async t=>{
 const {ctx,agent}=await patchedSessionFixture(t),guard=createNativeInputGuard(ctx,{final:true}),input=message(),before=agent.session.snapshotEvents().length
 assert.throws(()=>guard.withSyncLease(agent.session,nativeInputIdentity(input),allow(),()=>Promise.reject(Error('test synchronous producer rejected'))),forbidden)
 let called=0
 assert.throws(()=>guard.withSyncLease(agent.session,nativeInputIdentity(input),allow(),()=>({then(_resolve:unknown,reject:(error:Error)=>void){
  called++;assert.throws(()=>agent.inbox.append('next-turn',input),forbidden);reject(Error('test thenable rejected'))
 }})),forbidden)
 await new Promise<void>(done=>setImmediate(done))
 assert.equal(called,1);assert.equal(agent.session.snapshotEvents().length,before);assert.equal(agent.inbox.nextTurn.length,0)
})

test('返回 thenable 的 callback 已同步提交的写入仍存在，拒绝不冒称回滚',async t=>{
 const {ctx,agent}=await patchedSessionFixture(t),guard=createNativeInputGuard(ctx,{final:true}),input=message(),before=agent.session.snapshotEvents().length
 assert.throws(()=>guard.withSyncLease(agent.session,nativeInputIdentity(input),allow(),()=>{
  agent.inbox.append('next-turn',input)
  assert.equal(agent.inbox.remove(input.id),true)
  assert.throws(()=>agent.inbox.append('next-turn',input),forbidden)
  return Promise.reject(Error('test after synchronous commit'))
 }),forbidden)
 await new Promise<void>(done=>setImmediate(done))
 const appended=agent.session.snapshotEvents().slice(before).filter(event=>event.type==='agent/inbox/spliced'&&event.data.inserted.length!==0)
 assert.equal(appended.length,1);assert.equal(agent.inbox.nextTurn.length,0)
})

test('最终票据第一次提交才消费，remove 后相同消息也不能再次插入',async t=>{
 const {ctx,agent}=await patchedSessionFixture(t),guard=createNativeInputGuard(ctx,{final:true}),input=message(),before=agent.session.snapshotEvents().length
 guard.withSyncLease(agent.session,nativeInputIdentity(input),allow(),()=>{
  agent.inbox.append('next-turn',input)
  assert.equal(agent.inbox.remove(input.id),true)
  assert.throws(()=>agent.inbox.append('next-turn',input),forbidden)
  assert.throws(()=>agent.session.append('agent/inbox/spliced',{target:'next-turn',start:0,removedCount:0,inserted:[structuredClone(input)]}),forbidden)
 })
 const history=agent.session.snapshotEvents().slice(before)
 assert.equal(history.filter(event=>event.type==='agent/inbox/spliced'&&event.data.inserted.length!==0).length,1)
 assert.equal(history.filter(event=>event.type==='agent/inbox/spliced'&&event.data.inserted.length===0).length,1)
 assert.equal(agent.inbox.nextTurn.length,0)
})

test('final:false 只提供原版检查点，保留同 proof 多次插入的明确对照',async t=>{
 const {ctx,agent}=await patchedSessionFixture(t),guard=createNativeInputGuard(ctx),input=message(),before=agent.session.snapshotEvents().length
 guard.withSyncLease(agent.session,nativeInputIdentity(input),allow(),()=>{
  agent.inbox.append('next-turn',input);assert.equal(agent.inbox.remove(input.id),true)
  agent.inbox.append('next-turn',input)
 })
 const history=agent.session.snapshotEvents().slice(before)
 assert.equal(history.filter(event=>event.type==='agent/inbox/spliced'&&event.data.inserted.length!==0).length,2)
 assert.equal(agent.inbox.nextTurn[0]?.id,input.id)
})

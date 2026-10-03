import test from 'node:test'
import assert from 'node:assert/strict'
import {SessionId,SessionSeq,type SessionEvent,type Session} from '@deepseek-ai/dsh-session'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import type {WorkAccessLease} from '@teloa/backend'
import * as access from '../src/native-input-access.ts'
import type {NativeInputAcceptance,NativeInputGuardOptions} from '../src/native-input-access.ts'
import {patchedSessionFixture} from './fixtures/native-final-session.ts'

const forbidden={code:'teloa/forbidden',message:'当前暂不能提交新输入，请核对运行许可后重试。'}
const allow=():WorkAccessLease=>({assertCurrent(){}})
const message=(rpcId='receipt')=>createUserMessage({content:[{type:'text',text:'固定受理输入'}],source:{kind:'user',rpcId}})
const append=(session:Session,input:ReturnType<typeof message>,start=0)=>session.append('agent/inbox/spliced',{target:'next-turn',start,removedCount:0,inserted:[input]})

test('真实final提交回执绑定官方返回的完整event同一对象，并只发布一次',async t=>{
 const {ctx,agent}=await patchedSessionFixture(t),receipts:NativeInputAcceptance[]=[],input=message()
 const guard=access.createNativeInputGuard(ctx,{final:true,onAccepted(receipt){receipts.push(receipt)}})
 const event=guard.withSyncLease(agent.session,access.nativeInputIdentity(input,'receipt'),allow(),()=>append(agent.session,input))
 assert.equal(receipts.length,1)
 const receipt=receipts[0]!
 assert.equal(receipt.session,agent.session);assert.equal(receipt.event,event)
 assert.deepEqual(receipt.event,{type:'agent/inbox/spliced',seq:event.seq,time:event.time,data:{target:'next-turn',start:0,removedCount:0,inserted:[input]}})
 assert.equal(Object.isFrozen(receipt),true);assert.equal(Object.isFrozen(receipt.event),true)
 assert.equal(Object.isFrozen(receipt.event.data),true)
 access.assertNativeInputAcceptanceCurrent(receipt);access.assertNativeInputAcceptanceCurrent(receipt)
 assert.equal(receipt.assertContinuationCurrent(),undefined)
 assert.throws(()=>ctx.emit('session/event',agent.session,event),forbidden)
 assert.equal(receipts.length,1)
})
test('非法onAccepted和非final组合在安装前拒绝，不改变Free Store或占用guard',async t=>{
 const {ctx,agent}=await patchedSessionFixture(t)
 const bad=[{onAccepted(){}},{final:false,onAccepted(){}},{final:true,onAccepted:null},{final:true,onAccepted:false},{final:true,onAccepted:{}},{final:true,get onAccepted(){throw Error('private getter')}}]
 for(const options of bad)assert.throws(()=>access.createNativeInputGuard(ctx,options as unknown as NativeInputGuardOptions),forbidden)
 const first=message('free');agent.inbox.append('next-turn',first)
 let count=0
 const guard=access.createNativeInputGuard(ctx,{final:true,onAccepted(){count++}}),next=message('guarded')
 await guard.withLease(agent.session,access.nativeInputIdentity(next),allow(),()=>append(agent.session,next,agent.inbox.nextTurn.length))
 assert.equal(count,1)
})
test('原非回执调用不读取continuation getter，保持严格准入兼容',async t=>{
 const {ctx,agent}=await patchedSessionFixture(t),input=message()
 const guard=access.createNativeInputGuard(ctx,{final:true})
 const lease={assertCurrent(){},get assertContinuationCurrent():()=>void{throw Error('unused continuation getter')}}
 await guard.withLease(agent.session,access.nativeInputIdentity(input),lease,()=>append(agent.session,input))
 assert.equal(agent.inbox.nextTurn[0]?.id,input.id)
})
test('序列化失败或末监听器否决不发布，未消费scope重试才有真实回执',async t=>{
 const {ctx,agent}=await patchedSessionFixture(t),input=message(),receipts:NativeInputAcceptance[]=[]
 const guard=access.createNativeInputGuard(ctx,{final:true,onAccepted(receipt){receipts.push(receipt)}})
 let veto=true
 ctx.on('internal/dispatch',(_mode,name,args)=>{if(name==='session/event'&&(args[1] as SessionEvent)?.type==='agent/inbox/spliced'&&veto)throw Error('later veto')},{global:true})
 const before=agent.session.seq
 await guard.withLease(agent.session,access.nativeInputIdentity(input),allow(),()=>{
  assert.throws(()=>append(agent.session,{...input,invalid:undefined} as typeof input),/non-JSON-serializable/)
  assert.throws(()=>append(agent.session,input),/later veto/)
  assert.equal(agent.session.seq,before);assert.equal(receipts.length,0)
  veto=false;append(agent.session,input)
 })
 assert.equal(receipts.length,1)
})
test('公开emit伪造或clone feed不经过真实final提交，不能生成受理证明',async t=>{
 const {ctx,agent,other}=await patchedSessionFixture(t),input=message(),receipts:NativeInputAcceptance[]=[]
 const guard=access.createNativeInputGuard(ctx,{final:true,onAccepted(receipt){receipts.push(receipt)}})
 const event:SessionEvent<'agent/inbox/spliced'>={type:'agent/inbox/spliced',seq:SessionSeq(0),time:1,data:{target:'next-turn',start:0,removedCount:0,inserted:[input]}}
 const before=agent.session.seq
 await guard.withLease(agent.session,access.nativeInputIdentity(input),allow(),()=>{
  ctx.emit('session/event',agent.session,event)
  ctx.emit('session/event',agent.session,structuredClone(event))
  assert.throws(()=>ctx.emit('session/event',other.session,event),forbidden)
 })
 assert.equal(agent.session.seq,before);assert.equal(receipts.length,0)
})
test('未插入、删除以及consumed票据重放均不能新发布回执',async t=>{
 const {ctx,agent}=await patchedSessionFixture(t),input=message(),receipts:NativeInputAcceptance[]=[]
 const guard=access.createNativeInputGuard(ctx,{final:true,onAccepted(receipt){receipts.push(receipt)}})
 await guard.withLease(agent.session,access.nativeInputIdentity(input),allow(),()=>{
  agent.session.append('agent/inbox/spliced',{target:'next-turn',start:0,removedCount:0,inserted:[]})
  assert.equal(receipts.length,0)
  const event=append(agent.session,input);assert.equal(receipts.length,1)
  assert.equal(agent.inbox.remove(input.id),true)
  assert.throws(()=>append(agent.session,structuredClone(input)),forbidden)
  assert.throws(()=>ctx.emit('session/event',agent.session,event),forbidden)
 })
 assert.equal(receipts.length,1)
})
test('同步scope结束后的异步迟到append/feed不能形成回执',async t=>{
 const {ctx,agent}=await patchedSessionFixture(t),input=message(),receipts:NativeInputAcceptance[]=[]
 const guard=access.createNativeInputGuard(ctx,{final:true,onAccepted(receipt){receipts.push(receipt)}})
 let late:Promise<void>|undefined
 const before=agent.session.seq
 guard.withSyncLease(agent.session,access.nativeInputIdentity(input),allow(),()=>{
  late=Promise.resolve().then(()=>{assert.throws(()=>append(agent.session,input),forbidden)})
 })
 await late
 assert.equal(agent.session.seq,before);assert.equal(receipts.length,0)
})
test('受理后自然到期使用捕获的原continuation和receiver，撤销或后改函数不能绕过',async t=>{
 const {ctx,agent}=await patchedSessionFixture(t),input=message(),receipts:NativeInputAcceptance[]=[]
 const guard=access.createNativeInputGuard(ctx,{final:true,onAccepted(receipt){receipts.push(receipt)}})
 let fresh=true,current=true
 const lease={marker:'original',assertCurrent(){assert.equal(this.marker,'original');if(!fresh)throw Error('expired')},assertContinuationCurrent(){assert.equal(this.marker,'original');if(!current)throw Error('revoked')}}
 await guard.withLease(agent.session,access.nativeInputIdentity(input),lease,()=>append(agent.session,input))
 fresh=false
 access.assertNativeInputAcceptanceCurrent(receipts[0]!)
 lease.assertContinuationCurrent=()=>{};current=false
 assert.throws(()=>access.assertNativeInputAcceptanceCurrent(receipts[0]!),forbidden)
 assert.throws(()=>receipts[0]!.assertContinuationCurrent(),forbidden)
})
test('缺少continuation时严格fallback保持原函数；Promise或thenable断言同步拒绝',async t=>{
 for(const mode of ['fallback','promise','thenable']){
  const {ctx,agent}=await patchedSessionFixture(t),input=message(mode),receipts:NativeInputAcceptance[]=[]
  const guard=access.createNativeInputGuard(ctx,{final:true,onAccepted(receipt){receipts.push(receipt)}})
  let current=true
  const lease:WorkAccessLease={assertCurrent(){if(!current)throw Error('expired')}}
  if(mode==='promise')lease.assertContinuationCurrent=(async()=>{throw Error('late reject')}) as ()=>void
  if(mode==='thenable')lease.assertContinuationCurrent=(()=>({then(_resolve:unknown,reject:(error:unknown)=>void){reject(Error('late thenable'))}})) as unknown as ()=>void
  await guard.withLease(agent.session,access.nativeInputIdentity(input),lease,()=>append(agent.session,input))
  if(mode==='fallback'){lease.assertCurrent=()=>{};current=false}
  assert.throws(()=>access.assertNativeInputAcceptanceCurrent(receipts[0]!),forbidden)
 }
 await new Promise<void>(resolve=>setImmediate(resolve))
})
test('固定helper只认模块注册回执，stub/clone/恶意getter不触发字段授权',async t=>{
 const {ctx,agent}=await patchedSessionFixture(t),input=message(),receipts:NativeInputAcceptance[]=[]
 const guard=access.createNativeInputGuard(ctx,{final:true,onAccepted(receipt){receipts.push(receipt)}})
 await guard.withLease(agent.session,access.nativeInputIdentity(input),allow(),()=>append(agent.session,input))
 let reads=0,calls=0
 const forged={get session(){reads++;throw Error('private getter')},get event(){reads++;throw Error('private getter')},get assertContinuationCurrent(){reads++;return ()=>{calls++}}}
 for(const fake of [{...receipts[0]!},forged,{session:agent.session,event:receipts[0]!.event,assertContinuationCurrent(){calls++}},null])assert.throws(()=>access.assertNativeInputAcceptanceCurrent(fake as unknown as NativeInputAcceptance),forbidden)
 assert.equal(reads,0);assert.equal(calls,0)
 assert.throws(()=>Object.defineProperty(receipts[0]!,'assertContinuationCurrent',{value:()=>{calls++}}))
 access.assertNativeInputAcceptanceCurrent(receipts[0]!)
})
test('guard关闭或原Session被同id真实替换，已注册受理proof永久失效',async t=>{
 for(const mode of ['close','replace']){
  const {ctx}=await patchedSessionFixture(t),handle=await ctx.agents.create({sessionId:SessionId('receipt-'+mode),agentOptions:{provider:'test',model:'test'}}),agent=handle.agent,input=message(mode),receipts:NativeInputAcceptance[]=[]
  const guard=access.createNativeInputGuard(ctx,{final:true,onAccepted(receipt){receipts.push(receipt)}})
  await guard.withLease(agent.session,access.nativeInputIdentity(input),allow(),()=>append(agent.session,input))
  if(mode==='close')guard.close()
  else{await handle.dispose();await ctx.agents.create({sessionId:agent.id,agentOptions:{provider:'test',model:'test'}})}
  assert.throws(()=>access.assertNativeInputAcceptanceCurrent(receipts[0]!),forbidden)
 }
})


test('非法continuation getter或非函数在scope开始前拒绝，零事件与零回执',async t=>{
 const {ctx,agent}=await patchedSessionFixture(t),input=message(),receipts:NativeInputAcceptance[]=[]
 const guard=access.createNativeInputGuard(ctx,{final:true,onAccepted(receipt){receipts.push(receipt)}}),before=agent.session.seq
 let actions=0
 for(const lease of [{assertCurrent(){},get assertContinuationCurrent(){throw Error('private getter')}},{assertCurrent(){},assertContinuationCurrent:null},{assertCurrent(){},assertContinuationCurrent:false},{assertCurrent(){},assertContinuationCurrent:{}}]){
  await assert.rejects(guard.withLease(agent.session,access.nativeInputIdentity(input),lease as unknown as WorkAccessLease,()=>{actions++;append(agent.session,input)}),forbidden)
 }
 assert.equal(actions,0);assert.equal(agent.session.seq,before);assert.equal(receipts.length,0)
})
test('捕获options回调和原continuation不受后改函数或call影子属性影响',async t=>{
 const {ctx,agent}=await patchedSessionFixture(t),input=message(),receipts:NativeInputAcceptance[]=[]
 const options:NativeInputGuardOptions={final:true,onAccepted(receipt){assert.equal(this,options);receipts.push(receipt)}}
 const guard=access.createNativeInputGuard(ctx,options)
 Reflect.set(options,'onAccepted',()=>{throw Error('replaced notification')})
 let current=true
 const continuation=function(this:{marker:string}){assert.equal(this.marker,'fixed');if(!current)throw Error('revoked')}
 Object.defineProperty(continuation,'call',{value:()=>{}})
 const lease={marker:'fixed',assertCurrent(){},assertContinuationCurrent:continuation}
 await guard.withLease(agent.session,access.nativeInputIdentity(input),lease,()=>append(agent.session,input))
 assert.equal(receipts.length,1);access.assertNativeInputAcceptanceCurrent(receipts[0]!)
 current=false
 assert.throws(()=>access.assertNativeInputAcceptanceCurrent(receipts[0]!),forbidden)
})
test('回执通知同步异常或异步拒绝仍保留真实已提交事实，且不重复发布',async t=>{
 for(const mode of ['throw','promise','thenable']){
  const {ctx,agent}=await patchedSessionFixture(t),input=message(mode),receipts:NativeInputAcceptance[]=[]
  const options:NativeInputGuardOptions={final:true,onAccepted(receipt){
   receipts.push(receipt)
   if(mode==='throw')throw Error('consumer failure')
   if(mode==='promise')return Promise.reject(Error('late consumer failure'))
   return {then(_resolve:unknown,reject:(error:unknown)=>void){reject(Error('late thenable failure'))}}
  }}
  const guard=access.createNativeInputGuard(ctx,options)
  const event=await guard.withLease(agent.session,access.nativeInputIdentity(input),allow(),()=>append(agent.session,input))
  assert.equal(agent.inbox.nextTurn[0]?.id,input.id);assert.equal(receipts[0]?.event,event)
  access.assertNativeInputAcceptanceCurrent(receipts[0]!)
  assert.throws(()=>ctx.emit('session/event',agent.session,event),forbidden)
  assert.equal(receipts.length,1)
 }
 await new Promise<void>(resolve=>setImmediate(resolve))
})

import test from 'node:test'
import assert from 'node:assert/strict'
import {SessionId,SessionSeq,type SessionEvent,type UserMessage} from '@deepseek-ai/dsh-session'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import {nativeInputRecoveryCandidate,nativeInputRecoveryCandidateVersion,type NativeInputRecoveryCandidateInput} from '../src/native-input-provider.ts'
import {nativeInputIdentity} from '../src/native-input-access.ts'
import {nativeProviderKernel} from './fixtures/native-input-provider.ts'

test('共享只读候选使用官方完整 Inbox 投影筛选全部原始根', {timeout:15000},async t=>{
 const f=await nativeProviderKernel(t);await f.ctx.plugin(f.loopPackage.AgentLoop,{agents:[]})
 const first=createUserMessage({source:{kind:'user',rpcId:'request-a'},content:[{type:'text',text:'root a'}]})
 const second=createUserMessage({source:{kind:'user',rpcId:'request-b'},content:[{type:'text',text:'root b'}]})
 const tool=createUserMessage({source:{kind:'tool',callId:'tool-call' as never},content:[{type:'text',text:'derived tool context'}]})
 type Event=Omit<SessionEvent,'seq'|'time'>
 const insert=(messages:UserMessage[],target:'next-turn'|'next-step'='next-turn',start=0):Event=>({type:'agent/inbox/spliced',data:{target,start,removedCount:0,inserted:messages}})
 const remove:Event={type:'agent/inbox/spliced',data:{target:'next-turn',start:0,removedCount:1,inserted:[]}}
 const start:Event={type:'turn/start',data:{turn:1}},end:Event={type:'turn/end',data:{turn:1,reason:{kind:'completed'}}}
 let serial=0
 const input=(raw:Event[],inherited=false):NativeInputRecoveryCandidateInput=>{
  const id=SessionId('candidate-'+serial++),events=raw.map((event,index)=>({...event,seq:SessionSeq(index),time:index+1}) as SessionEvent)
  const header={...f.sessionPackage.Session.create(id).header,...inherited?{isSeeded:true,parentSession:SessionId('parent')}:{}}
  const session=f.sessionPackage.Session.create(id,events,header,f.sessionPackage.SessionLogOffset(inherited?events.length:0))
  return {snapshot:{header:session.header,events:session.snapshotEvents(),inheritedEventCount:session.inheritedEventCount},inbox:f.ctx.sessionProjections.stateOf(session,'inbox')}
 }

 await t.test('两个根顺序和原插入事件精确对应，候选没有许可方法',()=>{
  const source=input([insert([first]),insert([second],'next-turn',1)]),candidate=nativeInputRecoveryCandidate(source)
  assert.equal(nativeInputRecoveryCandidateVersion,1);assert.ok(candidate)
  assert.equal(candidate.sessionId,source.snapshot.header.id)
  assert.deepEqual(candidate.messages,source.inbox!['next-turn'])
  assert.deepEqual(candidate.acceptedEvents,source.snapshot.events.slice(0,2))
  for(const [index,message] of candidate.messages.entries()){
   const identity=nativeInputIdentity(message,Reflect.get(message.source,'rpcId'))
   assert.deepEqual(candidate.roots[index],{sessionId:candidate.sessionId,messageId:identity.messageId,nativeRequestId:identity.nativeRequestId,payloadSha256:identity.payloadSha256})
  }
  assert.deepEqual(Object.keys(candidate).sort(),['acceptedEvents','messages','roots','sessionId'])
  assert.equal(Reflect.get(candidate,'assertCurrent'),undefined)
  assert.equal(Reflect.get(candidate,'wakePending'),undefined)
 })

 await t.test('集合独立冻结，不修改或冻结输入对象，消息数据不转为权限证明',()=>{
  const borrowed=structuredClone(input([insert([first])])),before=structuredClone(borrowed)
  const candidate=nativeInputRecoveryCandidate(borrowed);assert.ok(candidate)
  for(const collection of [candidate,candidate.messages,candidate.roots,candidate.acceptedEvents,...candidate.roots])assert.equal(Object.isFrozen(collection),true)
  assert.notEqual(candidate.messages,borrowed.inbox!['next-turn']);assert.notEqual(candidate.acceptedEvents,borrowed.snapshot.events)
  for(const value of [borrowed,borrowed.snapshot,borrowed.snapshot.header,borrowed.snapshot.events,borrowed.snapshot.events[0],borrowed.inbox,borrowed.inbox!['next-turn'],borrowed.inbox!['next-turn'][0]])assert.equal(Object.isFrozen(value),false)
  assert.deepEqual(borrowed,before)
 })

 await t.test('没有 rpcId 的原始输入保持明确的 null 请求身份',()=>{
  const message=createUserMessage({source:{kind:'user'},content:[{type:'text',text:'local native root'}]})
  const candidate=nativeInputRecoveryCandidate(input([insert([message])]));assert.ok(candidate)
  assert.equal(candidate.roots[0]!.nativeRequestId,null)
 })

 await t.test('未领取的中断轮次仍可候选，已结束轮次不污染后来待办',()=>{
  assert.ok(nativeInputRecoveryCandidate(input([insert([first]),start])))
  const candidate=nativeInputRecoveryCandidate(input([insert([first]),start,remove,end,insert([second])]));assert.ok(candidate)
  assert.equal(candidate.messages.length,1);assert.equal(candidate.messages[0]!.id,second.id)
 })

 for(const [name,events,inherited] of [
  ['空闲历史',[],false],
  ['所有输入已移出', [insert([first]),remove],false],
  ['只有 next-step',[insert([first],'next-step')],false],
  ['混合 next-step',[insert([first]),insert([second],'next-step')],false],
  ['唯一原根属于继承前缀',[insert([first])],true],
  ['未结束轮次已领取且仍有别的待办',[insert([first]),insert([second],'next-turn',1),start,remove],false],
  ['原插入一次放入多个根',[insert([first,second])],false],
  ['同一 id 历史重新插入',[insert([first]),remove,insert([first])],false],
  ['有效根与工具派生混合',[insert([first]),insert([tool],'next-turn',1)],false],
 ] as const)await t.test(name+' 整体不候选',()=>{assert.equal(nativeInputRecoveryCandidate(input([...events],inherited)),undefined)})

 await t.test('重复 pending id、缺少对应原事件或载荷不一致均不返回部分候选',()=>{
  const source=input([insert([first]),insert([second],'next-turn',1)]),nextTurn=source.inbox!['next-turn']
  const cases=[
   {...source,inbox:{'next-turn':[nextTurn[0]!,nextTurn[0]!],'next-step':[]}},
   {...source,snapshot:{...source.snapshot,events:source.snapshot.events.slice(0,1)}},
   {...source,inbox:{'next-turn':[nextTurn[0]!,{...nextTurn[1]!,content:[{type:'text' as const,text:'changed'}]}],'next-step':[]}},
   {...source,inbox:undefined},
  ]
  for(const value of cases)assert.equal(nativeInputRecoveryCandidate(value),undefined)
 })

 await t.test('未完整连续快照、无效继承边界和非法请求身份不候选',()=>{
  const source=input([insert([first])])
  for(const inheritedEventCount of [-1,0.5,source.snapshot.events.length+1])assert.equal(nativeInputRecoveryCandidate({...source,snapshot:{...source.snapshot,inheritedEventCount}}),undefined)
  const events=source.snapshot.events.map((event,index)=>index===0?{...event,seq:SessionSeq(1)}:event)
  assert.equal(nativeInputRecoveryCandidate({...source,snapshot:{...source.snapshot,events}}),undefined)
  for(const rpcId of ['',42,null]){
   const message={...first,source:{kind:'user',rpcId}} as unknown as UserMessage
   assert.equal(nativeInputRecoveryCandidate(input([insert([message])])),undefined)
  }
 })
 assert.equal(f.ctx.agents.list().length,0)
})

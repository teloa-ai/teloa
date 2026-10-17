import test from 'node:test'
import assert from 'node:assert/strict'
import {nativeHotSubagentFixture} from './fixtures/native-hot-subagent.ts'
import {until,deferred} from './fixtures/native-subagent-admission.ts'

const notices=(f:Awaited<ReturnType<typeof nativeHotSubagentFixture>>)=>f.events(f.parent).filter(event=>event.type==='agent/inbox/spliced').flatMap(event=>event.data.inserted).filter(message=>message.source.kind==='subagent-settled')

test('真实受管子任务完成通知沿原工具受理根进入父 Inbox，不被最终输入门丢弃',async t=>{
 const f=await nativeHotSubagentFixture(t,'continuable')
 await f.send();await until(()=>notices(f).length===1);await f.parent.whenIdle()
 assert.equal(notices(f).length,1);assert.equal(f.counts.fresh,1)
 assert.equal(notices(f)[0]!.source.kind,'subagent-settled')
})

test('完成通知等待期间自然到期仍续原工作，显式撤销则零新输入',{timeout:10000},async t=>{
 for(const change of ['expired','revoked'] as const){
  const f=await nativeHotSubagentFixture(t,'continuable'),entered=deferred(),release=deferred()
  f.setCompletion(async(_candidate,publish)=>{entered.resolve();await release.promise;await publish()})
  const running=f.send();await entered.promise
  if(change==='expired')f.rights.valid=false;else f.rights.revoked=true
  release.resolve();await running
  if(change==='expired'){await until(()=>notices(f).length===1);assert.equal(f.counts.fresh,1)}
  else{await new Promise(resolve=>setImmediate(resolve));assert.equal(notices(f).length,0)}
 }
})

test('通知准入未完成时仍保留原生收口所有权，父停止后只保留消息而不唤醒',{timeout:10000},async t=>{
 const f=await nativeHotSubagentFixture(t,'continuable'),entered=deferred(),release=deferred()
 t.after(()=>release.resolve())
 f.setCompletion(async(_candidate,publish)=>{entered.resolve();await release.promise;await publish()})
 const running=f.send();await entered.promise
 let joined=false
 const join=f.service.waitForChildren(f.parent).then(()=>{joined=true})
 await new Promise(resolve=>setImmediate(resolve));assert.equal(joined,false,'异步通知仍是子任务未结清的一部分')
 f.parent.cancel({kind:'user'},{keepInbox:true})
 const stopping=f.service.drainDescendants([f.parent])
 const requests=f.adapter.parentCalls
 release.resolve();await Promise.all([running,join,stopping])
 assert.equal(notices(f).length,1)
 assert.equal(f.adapter.parentCalls,requests)
 assert.equal(f.parent.inbox.nextTurn.length+f.parent.inbox.nextStep.length,1)
})

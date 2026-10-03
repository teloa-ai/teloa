import test,{type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import {Session} from '@deepseek-ai/dsh-session'
import type {NativeInputCheckpoint,NativeInputCheckpointInput} from '../src/native-input-checkpoint.ts'
import {nativeHotCausalityFixture,hotGate,textAnswer} from './fixtures/native-hot-causality.ts'
import {loopWorkFixture} from './fixtures/native-loop-work-admission.ts'

const options={timeout:10000}
async function fixture(t:TestContext,checkpoint:NativeInputCheckpoint){
 const root=await mkdtemp(join(tmpdir(),'teloa-input-checkpoint-'))
 t.after(()=>rm(root,{recursive:true,force:true}))
 const f=await nativeHotCausalityFixture(t,{checkpoint,persistenceRoot:root})
 return {...f,root,
  async persistedInbox(){
   const reader=await f.ctx.sessionPersistence.open(f.agent.id,'read')
   try{
    const {events}=await reader.read()
    const carrier=Session.create(f.agent.id,events,reader.header,reader.inheritedEventCount)
    return {events,inbox:f.ctx.sessionProjections.stateOf(carrier,'inbox')!}
   }finally{await reader.close()}
  },
 }
}

test('真实JSONL持久快照确认前保留Inbox且零模型/工具，确认后执行一次',options,async t=>{
 const gate=hotGate();t.after(gate.release)
 const seen:NativeInputCheckpointInput[]=[]
 const f=await fixture(t,async input=>{
  seen.push(input);input.assertCurrent()
  assert.equal(Object.isFrozen(input),true);assert.equal(Object.isFrozen(input.snapshot.events),true)
  assert.equal(Object.isFrozen(input.snapshot.header),true)
  await gate.wait(input.signal);input.assertCurrent()
 })
 f.adapter.scripts.push(textAnswer)
 const message=await f.send('durable-before-claim');await gate.entered
 assert.equal(seen[0]!.agent,f.agent);assert.deepEqual(seen[0]!.messages[0],message)
 assert.equal(seen[0]!.messages[0],f.agent.inbox.nextTurn[0])
 assert.equal(f.adapter.requests.length,0);assert.equal(f.adapter.prepares.length,0);assert.equal(f.counters.tools,0)
 const stored=await f.persistedInbox()
 assert.equal(stored.inbox['next-turn'][0]!.id,message.id)
 assert.deepEqual(stored.events,seen[0]!.snapshot.events)
 const files=(await readdir(f.root,{recursive:true})).filter(path=>path.endsWith('.jsonl'))
 assert.equal(files.length,1,'只有已flush的真实工作会话物化JSONL')
 const bytes=await Promise.all(files.map(path=>readFile(join(f.root,path),'utf8')))
 assert.ok(bytes.some(text=>text.includes('durable-before-claim')))
 gate.release();await f.agent.whenIdle()
 assert.equal(f.agent.inbox.nextTurn.length,0);assert.equal(f.adapter.requests.length,1);assert.equal(seen.length,1)
 assert.equal(f.events().filter(event=>event.type==='turn/end').at(-1)?.data.reason.kind,'completed')
})

test('持久确认拒绝保留真实Inbox和磁盘待办，零模型/工具',options,async t=>{
 let attempts=0
 const f=await fixture(t,async()=>{attempts++;throw Error('持久受理保存失败')})
 f.adapter.scripts.push(textAnswer);const message=await f.send('ledger-rejected');await f.agent.whenIdle()
 assert.equal(attempts,1);assert.equal(f.adapter.requests.length,0);assert.equal(f.counters.tools,0)
 assert.deepEqual(f.agent.inbox.nextTurn[0],message)
 await f.sessions.flush(f.agent.session)
 assert.equal((await f.persistedInbox()).inbox['next-turn'][0]!.id,message.id)
 assert.equal(f.events().filter(event=>event.type==='step/start').length,0)
})

test('持久确认等待时撤销，迟到成功不能领取Inbox或调用模型',options,async t=>{
 const gate=hotGate();t.after(gate.release)
 const f=await fixture(t,async input=>{await gate.wait(input.signal)})
 f.adapter.scripts.push(textAnswer);const message=await f.send('revoke-before-claim');await gate.entered
 f.rights.revoked=true;gate.release();await f.agent.whenIdle()
 assert.deepEqual(f.agent.inbox.nextTurn[0],message);assert.equal(f.adapter.requests.length,0)
 assert.equal(f.events().filter(event=>event.type==='step/start').length,0)
 await f.sessions.flush(f.agent.session)
 assert.equal((await f.persistedInbox()).inbox['next-turn'][0]!.id,message.id)
})

test('已真实受理的输入在持久等待期间自然到期仍可续作，新输入拒绝',options,async t=>{
 const gate=hotGate();t.after(gate.release)
 const f=await fixture(t,async input=>{await gate.wait(input.signal);input.assertCurrent()})
 f.adapter.scripts.push(textAnswer);await f.send('expiry-before-claim');await gate.entered
 f.rights.valid=false;gate.release();await f.agent.whenIdle()
 assert.equal(f.adapter.requests.length,1)
 await assert.rejects(f.send('new-after-checkpoint-expiry'),{code:'teloa/forbidden'})
})

test('等待时追加的新next-step输入保留到下一轮独立持久确认，不夹入旧批次',options,async t=>{
 const gate=hotGate();t.after(gate.release)
 const seen:NativeInputCheckpointInput[]=[]
 const f=await fixture(t,async input=>{seen.push(input);if(seen.length===1)await gate.wait(input.signal)})
 f.adapter.scripts.push(textAnswer,textAnswer)
 const first=await f.send('first-fixed-batch');await gate.entered
 const later=createUserMessage({source:{kind:'user',rpcId:'later-fixed-batch'},content:[{type:'text',text:'等待时新增输入'}]})
 await f.work.withNewInput(f.agent,later,{producer:'queue',identity:'later-fixed-batch'},()=>f.agent.inbox.append('next-step',later))
 assert.deepEqual(seen[0]!.messages,[first]);assert.deepEqual(f.agent.inbox.nextStep[0],later)
 gate.release();await f.agent.whenIdle()
 assert.equal(seen.length,2);assert.deepEqual(seen[1]!.messages,[later])
 assert.equal(seen[1]!.snapshot.events.some(event=>event.type==='agent/inbox/spliced'&&event.data.inserted.some(message=>message.id===later.id)),true)
 assert.equal(f.adapter.requests.length,2);assert.equal(f.agent.inbox.hasPending,false)
})

test('没有实际持久writer时拒绝领取，不调用持久确认或模型',options,async t=>{
 let attempts=0
 const f=await nativeHotCausalityFixture(t,{checkpoint:async()=>{attempts++}})
 f.adapter.scripts.push(textAnswer);const message=await f.send('missing-writer');await f.agent.whenIdle()
 assert.equal(attempts,0);assert.equal(f.adapter.requests.length,0);assert.deepEqual(f.agent.inbox.nextTurn[0],message)
})

test('等待时前插不同next-turn输入，旧确认不能领取替换后的批次',options,async t=>{
 const gate=hotGate();t.after(gate.release)
 const f=await fixture(t,async input=>{await gate.wait(input.signal)})
 f.adapter.scripts.push(textAnswer)
 const first=await f.send('before-prepend');await gate.entered
 const later=createUserMessage({source:{kind:'user',rpcId:'prepended-after-snapshot'},content:[{type:'text',text:'改变待领取顺序'}]})
 await f.work.withNewInput(f.agent,later,{producer:'queue',identity:'prepend'},()=>f.agent.inbox.prepend('next-turn',later))
 gate.release();await f.agent.whenIdle()
 assert.deepEqual(f.agent.inbox.nextTurn,[later,first]);assert.equal(f.adapter.requests.length,0)
 await f.sessions.flush(f.agent.session)
 assert.deepEqual((await f.persistedInbox()).inbox['next-turn'].map(message=>message.id),[later.id,first.id])
})

test('实际运行取消不等待不响应signal的确认策略，迟到完成维持零领取',options,async t=>{
 const gate=hotGate();t.after(gate.release)
 const f=await fixture(t,async()=>{await gate.wait()})
 f.adapter.scripts.push(textAnswer);const message=await f.send('cancel-while-confirming');await gate.entered
 f.agent.cancel({kind:'hook',reason:'测试显式取消等待'},{keepInbox:true})
 await f.agent.whenIdle()
 assert.deepEqual(f.agent.inbox.nextTurn,[message]);assert.equal(f.adapter.requests.length,0)
 gate.release();await new Promise<void>(resolve=>setImmediate(resolve))
 assert.deepEqual(f.agent.inbox.nextTurn,[message]);assert.equal(f.adapter.requests.length,0)
})

test('官方session/flush任一监听器失败则不调用持久确认，保留待办',options,async t=>{
 let attempts=0
 const f=await fixture(t,async()=>{attempts++})
 const stop=f.ctx.on('session/flush',()=>{throw Error('真实flush监听器失败')},{global:true})
 t.after(stop)
 f.adapter.scripts.push(textAnswer);const message=await f.send('flush-listener-failure');await f.agent.whenIdle()
 assert.equal(attempts,0);assert.equal(f.adapter.requests.length,0);assert.deepEqual(f.agent.inbox.nextTurn,[message])
 stop();await f.sessions.flush(f.agent.session)
 assert.deepEqual((await f.persistedInbox()).inbox['next-turn'].map(input=>input.id),[message.id])
})

test('SDK required缺确认提供方拒绝领取，scoped实例共用唯一策略且不能重复安装',options,async t=>{
 const f=await loopWorkFixture(t),scoped=f.ctx.extend().agentLoop as typeof f.loop
 assert.equal(typeof scoped.requireInputCheckpoint,'function');assert.equal(typeof scoped.installInputCheckpoint,'function')
 scoped.requireInputCheckpoint()
 const message=await f.send('required-missing-checkpoint')
 assert.equal(f.adapter.requests.length,0);assert.deepEqual(f.agent.inbox.nextTurn,[message])
 for(const invalid of [null,false,{},Promise.resolve()])assert.throws(()=>scoped.installInputCheckpoint(invalid as never))
 scoped.installInputCheckpoint(()=>Object.freeze({assertCurrent(){return undefined}}))
 assert.throws(()=>f.loop.installInputCheckpoint(()=>{}))
})

test('公开claimed/pre-step事件不能执行私有持久确认策略',options,async t=>{
 let attempts=0
 const f=await fixture(t,async()=>{attempts++}),signal=new AbortController().signal
 const message=createUserMessage({source:{kind:'user'},content:[]})
 f.ctx.emit('agent/inbox/claimed',{agent:f.agent,message,turn:42})
 await f.ctx.waterfall('agent/pre-step',{agent:f.agent,messages:[message],turn:42,step:1,signal},()=>Promise.resolve({kind:'enter' as const,messages:[message]}))
 assert.equal(attempts,0);assert.equal(f.adapter.requests.length,0);assert.equal(f.agent.inbox.hasPending,false)
})

test('SDK 最后同步lease断言重入改变Inbox后，仍核对实际批次并拒绝领取',options,async t=>{
 const root=await mkdtemp(join(tmpdir(),'teloa-checkpoint-reentrant-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const f=await loopWorkFixture(t,false,root)
 const later=createUserMessage({source:{kind:'user',rpcId:'reentrant-prepend'},content:[]})
 let assertions=0
 f.loop.requireInputCheckpoint();f.loop.installInputCheckpoint(()=>Object.freeze({assertCurrent(){
  if(++assertions===2)f.agent.inbox.prepend('next-turn',later)
  return undefined
 }}))
 const first=await f.send('original-before-reentrant-lease')
 assert.equal(assertions,2);assert.equal(f.adapter.requests.length,0);assert.deepEqual(f.agent.inbox.nextTurn,[later,first])
})

for(const kind of ['unfrozen','getter','promise'])test(`SDK ${kind}确认lease不能进入同步领取`,options,async t=>{
 const root=await mkdtemp(join(tmpdir(),'teloa-checkpoint-invalid-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const f=await loopWorkFixture(t,false,root);let getters=0
 f.loop.requireInputCheckpoint();f.loop.installInputCheckpoint(()=>{
  if(kind==='unfrozen')return {assertCurrent(){return undefined}}
  if(kind==='getter')return Object.freeze({get assertCurrent(){getters++;return ()=>{}}})
  return Object.freeze({assertCurrent(){return Promise.reject(Error('异步断言不能领取'))}})
 })
 const message=await f.send('invalid-checkpoint-'+kind)
 assert.equal(f.adapter.requests.length,0);assert.deepEqual(f.agent.inbox.nextTurn,[message]);assert.equal(getters,0)
})

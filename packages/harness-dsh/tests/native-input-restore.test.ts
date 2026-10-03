import test,{type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {SessionId,SessionSeq,type SessionEvent} from '@deepseek-ai/dsh-session'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import {TeloaNativeInput,type NativeInputRestore,type NativeInputRestoreInput,type NativeInputRestoreLease} from '../src/native-input-provider.ts'
import {nativeInputIdentity} from '../src/native-input-access.ts'
import {nativeProviderKernel} from './fixtures/native-input-provider.ts'
import {HotAdapter,textAnswer,hotGate} from './fixtures/native-hot-causality.ts'
import {deferred} from './fixtures/native-subagent-admission.ts'

const options={timeout:15000},denied={code:'teloa/forbidden'},route={provider:'restore-test',model:'fixed'}
const immediate=()=>new Promise<void>(resolve=>setImmediate(resolve))
function roots(input:NativeInputRestoreInput){return Object.freeze(input.messages.map(message=>{
 const rpcId=Reflect.get(message.source,'rpcId'),identity=nativeInputIdentity(message,rpcId)
 return Object.freeze({sessionId:input.sessionId,messageId:identity.messageId,nativeRequestId:identity.nativeRequestId??null,payloadSha256:identity.payloadSha256})
}))}
const permit=(input:NativeInputRestoreInput,assertCurrent:()=>undefined=()=>undefined):NativeInputRestoreLease=>Object.freeze({roots:roots(input),assertCurrent})

/** 真实固定官方 JSONL/Loop/Registry 图；策略模拟部署持久许可，不代表公网模型质量。 */
async function fixture(t:TestContext,restore?:NativeInputRestore){
 const f=await nativeProviderKernel(t),root=await mkdtemp(join(tmpdir(),'teloa-input-restore-'))
 t.after(()=>rm(root,{recursive:true,force:true}))
 await f.ctx.plugin(f.persistencePackage.default,{root,compression:'none'})
 const provider=f.ctx.plugin(TeloaNativeInput,{restore});await provider
 const adapter=new HotAdapter();f.ctx.llm.registerAdapter([route.provider],adapter)
 await f.ctx.plugin(f.loopPackage.AgentLoop,{agents:[]})
 const id=SessionId('cold-input'),messages=[1,2].map(index=>createUserMessage({source:{kind:'user',rpcId:'cold-'+index},content:[{type:'text',text:'pending root '+index}]}))
 const seed=async({count=1,nextStep=false,interrupted=false,claimed=false,inherited=false}={})=>{
  const events:SessionEvent[]=messages.slice(0,count).map((message,index)=>({type:'agent/inbox/spliced',seq:SessionSeq(index),time:index+1,data:{target:nextStep?'next-step':'next-turn',start:index,removedCount:0,inserted:[message]}}))
  if(interrupted){events.push({type:'turn/start',seq:SessionSeq(events.length),time:3,data:{turn:1}});events.push({type:'step/start',seq:SessionSeq(events.length),time:4,data:{turn:1,step:1}})}
  if(claimed){events.push({type:'agent/inbox/spliced',seq:SessionSeq(events.length),time:5,data:{target:'next-turn',start:0,removedCount:1,inserted:[]}})}
  const header={...f.sessionPackage.Session.create(id).header,...inherited?{isSeeded:true,parentSession:SessionId('parent')}:{}}
  const cold=f.sessionPackage.Session.create(id,events,header,f.sessionPackage.SessionLogOffset(inherited?events.length:0))
  const writer=await f.ctx.sessionPersistence.create(cold.header,{inheritedEventCount:cold.inheritedEventCount})
  await writer.append(cold.snapshotEvents());await writer.flush();await writer.close()
  return cold
 }
 const bytes=async()=>{const files=(await readdir(root,{recursive:true})).filter(file=>file.endsWith('.jsonl')).sort();return Promise.all(files.map(async file=>[file,await readFile(join(root,file))]))}
 const resume=(signal?:AbortSignal)=>f.ctx.agents.resume({resumeSessionId:id,agentOptions:route,signal})
 const reopened=async()=>{const writer=await f.ctx.sessionPersistence.open(id,'write');await writer.close()}
 return {...f,root,provider,adapter,id,messages,seed,bytes,resume,reopened}
}

for(const count of [1,2])for(const interrupted of [false,true])test(`真实 JSONL ${count} 根 interrupted=${interrupted} 一次恢复，原历史保留并由官方 Loop 完成`,options,async t=>{
 let calls=0
 const f=await fixture(t,input=>{calls++;assert.ok(Object.isFrozen(input));assert.ok(Object.isFrozen(input.messages));assert.ok(Object.isFrozen(input.snapshot));assert.ok(Object.isFrozen(input.snapshot.events));return permit(input)})
 const cold=await f.seed({count,interrupted});f.adapter.scripts.push(...Array.from({length:count},()=>textAnswer))
 const handle=await f.resume();await handle.agent.whenIdle()
 assert.equal(calls,1);assert.equal(f.adapter.requests.length,count)
 assert.deepEqual(handle.agent.session.snapshotEvents().slice(0,cold.seq),cold.snapshotEvents())
 assert.equal(handle.agent.inbox.nextTurn.length,0);assert.equal(handle.agent.inbox.nextStep.length,0)
 for(const message of f.messages.slice(0,count))assert.equal(handle.agent.session.snapshotEvents().filter(event=>event.type==='user/message'&&event.data.id===message.id).length,1)
 await handle.dispose()
 const complete=await f.resume();assert.equal(calls,1);await complete.agent.whenIdle();assert.equal(f.adapter.requests.length,count);await complete.dispose()
})

test('无恢复策略：公开 roots JSON 和创建通知不授予 pending 许可，首写前保持原日志',options,async t=>{
 const f=await fixture(t);await f.seed();const before=await f.bytes()
 await assert.rejects(f.resume(),denied);assert.deepEqual(await f.bytes(),before);assert.equal(f.adapter.requests.length,0);await f.reopened()
})

for(const kind of ['next-step','inherited','claimed'] as const)test(`${kind} 派生或未知成果不因有根策略而重放`,options,async t=>{
 let calls=0;const f=await fixture(t,input=>{calls++;return permit(input)})
 await f.seed({count:kind==='claimed'?2:1,nextStep:kind==='next-step',inherited:kind==='inherited',interrupted:kind==='claimed',claimed:kind==='claimed'})
 const before=await f.bytes();await assert.rejects(f.resume(),denied);assert.equal(calls,0);assert.deepEqual(await f.bytes(),before);await f.reopened()
})

for(const invalid of ['partial','wrong-log','clone','getter','async'] as const)test(`恢复回复 ${invalid} 不发布 Agent 或改写历史`,options,async t=>{
 const f=await fixture(t,(input=>{
  const grant=permit(input)
  if(invalid==='partial')return Object.freeze({...grant,roots:Object.freeze(grant.roots.slice(0,1))})
  if(invalid==='wrong-log')return Object.freeze({...grant,roots:Object.freeze(grant.roots.map(root=>Object.freeze({...root,payloadSha256:'0'.repeat(64)})))})
  if(invalid==='clone')return JSON.parse(JSON.stringify(grant))
  if(invalid==='getter')return Object.freeze({roots:grant.roots,get assertCurrent(){return ()=>undefined}})
  return Object.freeze({roots:grant.roots,async assertCurrent(){return undefined}})
 }) as NativeInputRestore)
 await f.seed({count:2});const before=await f.bytes();await assert.rejects(f.resume(),denied);await immediate()
 assert.deepEqual(await f.bytes(),before);assert.equal(f.ctx.agents.get(f.id),undefined);assert.equal(f.adapter.requests.length,0);await f.reopened()
})

for(const cause of ['abort','close'] as const)test(`等待策略时 ${cause}，释放真实 writer；晚到回复不能复活`,options,async t=>{
 const entered=deferred<NativeInputRestoreInput>(),late=deferred<NativeInputRestoreLease>()
 const f=await fixture(t,input=>{entered.resolve(input);return late.promise});await f.seed();const before=await f.bytes(),controller=new AbortController()
 const restoring=f.resume(controller.signal),rejected=assert.rejects(restoring)
 const input=await entered.promise;assert.equal(f.adapter.requests.length,0)
 if(cause==='abort')controller.abort(Error('stop restore'));else f.ctx.teloaNativeInput.input.close()
 await rejected;assert.equal(input.signal.aborted,true);await f.reopened();assert.deepEqual(await f.bytes(),before)
 late.resolve(permit(input));await immediate();assert.equal(f.ctx.agents.get(f.id),undefined);assert.equal(f.adapter.requests.length,0)
})

test('真实发布中改变 Inbox 或日志，精确候选证明拒绝新对象',options,async t=>{
 const f=await fixture(t,permit);await f.seed()
 await assert.rejects(f.ctx.agents.resume({resumeSessionId:f.id,agentOptions:route,setup:async(_ctx,agent)=>{
  agent.session.append('agent/inbox/spliced',{target:'next-turn',start:0,removedCount:1,inserted:[]});return undefined
 }}))
 assert.equal(f.ctx.agents.get(f.id),undefined);assert.equal(f.adapter.requests.length,0);await f.reopened()
})

test('setup 中公开创建通知不能消费尚未绑定的恢复证明；官方恢复仍执行一次',options,async t=>{
 const f=await fixture(t,permit);await f.seed();f.adapter.scripts.push(textAnswer)
 let publicRejected=false
 const handle=await f.ctx.agents.resume({resumeSessionId:f.id,agentOptions:route,setup:async(_ctx,agent)=>{
  try{await f.ctx.serial('agent/created',{agent,source:'resume'})}catch{publicRejected=true}
  return undefined
 }})
 await handle.agent.whenIdle();assert.equal(publicRejected,true);assert.equal(f.adapter.requests.length,1)
 assert.equal(handle.agent.session.snapshotEvents().filter(event=>event.type==='user/message'&&event.data.id===f.messages[0]!.id).length,1)
 await handle.dispose()
})

test('session/created 窗口公开创建通知只观察已绑定因果，不抢占官方发布或重复执行',options,async t=>{
 const f=await fixture(t,permit);await f.seed();f.adapter.scripts.push(textAnswer)
 let publicSuccess=false,publicAttempt:Promise<void>|undefined
 f.ctx.on('session/created',session=>{
  if(session.id!==f.id)return
  const agent=f.ctx.agents.get(f.id);assert.ok(agent)
  publicAttempt=f.ctx.serial('agent/created',{agent,source:'resume'}).then(()=>{publicSuccess=true})
 })
 const handle=await f.resume();await publicAttempt;await handle.agent.whenIdle()
 assert.equal(publicSuccess,true);assert.equal(f.adapter.requests.length,1)
 assert.equal(handle.agent.session.snapshotEvents().filter(event=>event.type==='user/message'&&event.data.id===f.messages[0]!.id).length,1)
 await handle.dispose()
})

test('恢复后模型 prepare 等待期间撤销，保留真实已领取历史且零模型；新根需新工作策略',options,async t=>{
 let current=true;const f=await fixture(t,input=>permit(input,()=>{if(!current)throw Error('revoked');return undefined}))
 await f.seed();const gate=hotGate();f.adapter.prepareGate=gate;f.adapter.scripts.push(textAnswer)
 const handle=await f.resume();await gate.entered;current=false;gate.release();await handle.agent.whenIdle()
 assert.equal(f.adapter.requests.length,0);assert.equal(handle.agent.inbox.nextTurn.length,0)
 assert.equal(handle.agent.session.snapshotEvents().filter(event=>event.type==='user/message'&&event.data.id===f.messages[0]!.id).length,1)
 const cloned=structuredClone(f.messages[0]!);assert.throws(()=>handle.agent.followup(cloned),denied)
 await handle.dispose()
})

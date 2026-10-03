import test from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {setImmediate as immediate} from 'node:timers/promises'
import type {Agent} from '@deepseek-ai/dsh-agent'
import type {SessionStore} from '@deepseek-ai/dsh-session'
import {initialSubagentFixture,deferred,until,type AdmissionRequest} from './fixtures/native-subagent-admission.ts'
import {patchedSessionPackage} from './fixtures/native-final-session.ts'
import {createNativeWorkInput} from '../src/native-work-input.ts'
import {WorkAccess} from '../../backend/src/work/work-access.ts'

type Fixture=Awaited<ReturnType<typeof initialSubagentFixture>>
const start=(f:Fixture,mode:'continuable'|'one-shot',signal?:AbortSignal)=>mode==='continuable'?f.startContinuable('initial-child',signal):f.startOneShot(signal)
const inserted=(request:AdmissionRequest)=>request.agent.session.snapshotEvents().filter(event=>event.type==='agent/inbox/spliced').flatMap(event=>event.data.inserted)
const cause=(f:Fixture,request:AdmissionRequest)=>{
 assert.equal(request.kind,'initial');assert.equal(request.sender,f.parent);assert.equal(request.delivery,'queue')
 assert.ok(Object.isFrozen(request));assert.ok(Object.isFrozen(request.message));assert.ok(Object.isFrozen(request.message.content));assert.ok(Object.isFrozen(request.message.source))
 const sessions=Reflect.get(f.ctx,'sessions') as unknown as SessionStore
 assert.equal(request.agent.session,sessions.get(request.agent.id));assert.equal(f.ctx.agents.isOwnedBy(request.agent.id,f.parent),true)
}

test('原完整npm图与patched Free保留continuable/one-shot官方初始受理和真实Inbox',{timeout:10000},async t=>{
 for(const patched of [false,true]){
  const f=await initialSubagentFixture(t,{}, {patched}),initial=await f.startContinuable()
  const child=f.ctx.agents.get(initial.childId)!;assert.equal(f.ledger(child)[0]!.id,initial.messageId)
  const run=await f.startOneShot();t.after(()=>run.dispose());await until(()=>f.ledger(run.localAgent).length===1)
  assert.equal(f.ledger(run.localAgent)[0]!.source.kind,'user');assert.equal(f.modelCalls(),0)
 }
})

test('required无provider：continuable回滚且one-shot返回已发布handle、拒绝仅走result',{timeout:10000},async t=>{
 const f=await initialSubagentFixture(t,{requirePromptAdmission:true})
 await assert.rejects(f.startContinuable(),/provider is unavailable/)
 assert.equal(f.ctx.agents.get('initial-child' as never),undefined)
 const run=await f.startOneShot(),denied=assert.rejects(run.result,/provider is unavailable/)
 assert.equal(f.ctx.agents.get(run.id),run.localAgent);assert.equal(f.ledger(run.localAgent).length,0)
 await denied;await run.dispose();assert.equal(f.ctx.agents.get(run.id),undefined)
})

test('continuable首次策略得到冻结exact候选，等待零输入，同一dispatch只消费一次',{timeout:10000},async t=>{
 const entered=deferred<AdmissionRequest>(),release=deferred();let late:(()=>void)|undefined,calls=0
 const f=await initialSubagentFixture(t,{requirePromptAdmission:true,admitPrompt:async(request,dispatch)=>{calls++;entered.resolve(request);late=dispatch;await release.promise;dispatch();assert.throws(dispatch,/scope is closed/)}})
 const pending=f.startContinuable(),request=await entered.promise;cause(f,request)
 assert.equal(request.kind==='initial'&&request.mode,'continuable');assert.equal(inserted(request).length,0)
 const session=request.agent.session;release.resolve();const receipt=await pending
 assert.equal(receipt.messageId,request.message.id);assert.equal(f.ctx.agents.get(receipt.childId),request.agent);assert.equal(request.agent.session,session)
 assert.deepEqual(inserted(request),[request.message]);assert.equal(calls,1);assert.throws(()=>late!(),/scope is closed/)
})

test('one-shot许可await留在真实result IIFE，start先返回已发布handle再唯一写入',{timeout:10000},async t=>{
 const entered=deferred<AdmissionRequest>(),release=deferred();let calls=0
 const f=await initialSubagentFixture(t,{requirePromptAdmission:true,admitPrompt:async(request,dispatch)=>{calls++;entered.resolve(request);await release.promise;dispatch()}})
 const run=await f.startOneShot();t.after(()=>run.dispose());const request=await entered.promise;cause(f,request)
 assert.equal(request.kind==='initial'&&request.mode,'one-shot');assert.equal(run.localAgent,request.agent);assert.equal(inserted(request).length,0)
 let settled=false;void run.result.finally(()=>{settled=true}).catch(()=>{})
 await immediate();assert.equal(settled,false);release.resolve();await until(()=>inserted(request).length===1)
 assert.deepEqual(inserted(request),[request.message]);assert.equal(calls,1);f.releaseSteps();await run.result
})

test('两种initial未dispatch不冒称受理，回调scope结束后迟到提交仍拒绝',{timeout:10000},async t=>{
 for(const mode of ['continuable','one-shot'] as const){
  let request:AdmissionRequest|undefined,late:(()=>void)|undefined
  const f=await initialSubagentFixture(t,{admitPrompt:async(candidate,dispatch)=>{request=candidate;late=dispatch}})
  if(mode==='continuable')await assert.rejects(f.startContinuable(),/not admitted/)
  else{const run=await f.startOneShot();await assert.rejects(run.result,/not admitted/);await run.dispose()}
  assert.equal(inserted(request!).length,0);assert.throws(()=>late!(),/scope is closed/);assert.equal(inserted(request!).length,0)
 }
})

test('初始实际受理后provider抛错仍返回真receipt，一次性run不增加第二条',{timeout:10000},async t=>{
 for(const mode of ['continuable','one-shot'] as const){
  let request:AdmissionRequest|undefined
  const f=await initialSubagentFixture(t,{admitPrompt:async(candidate,dispatch)=>{request=candidate;dispatch();throw Error('test after actual input')}}),value=await start(f,mode)
  assert.deepEqual(inserted(request!),[request!.message])
  if(mode==='continuable')assert.equal(value.messageId,request!.message.id)
  else{f.releaseSteps();await value.result;await value.dispose()}
 }
})

test('许可等待撤销：两种真实初始发布均零输入，拒绝及回滚渠道保持',{timeout:10000},async t=>{
 for(const mode of ['continuable','one-shot'] as const){
  const entered=deferred<AdmissionRequest>(),release=deferred();let valid=true
  const f=await initialSubagentFixture(t,{admitPrompt:async(request,dispatch)=>{entered.resolve(request);await release.promise;if(!valid)throw Error('test revoked');dispatch()}})
  const pending=start(f,mode),request=await entered.promise
  const outcome=mode==='continuable'?pending:(await pending).result,denied=assert.rejects(outcome,/test revoked/)
  assert.equal(inserted(request).length,0);valid=false;release.resolve();await denied;assert.equal(inserted(request).length,0)
  if(mode==='one-shot'){const run=await pending;assert.equal(f.ctx.agents.get(run.id),run.localAgent);await run.dispose()}
  else assert.equal(f.ctx.agents.get(request.agent.id),undefined)
 }
})

test('caller等待取消与one-shot dispose先关闭投递，迟到dispatch不能写入',{timeout:10000},async t=>{
 for(const mode of ['continuable','one-shot','dispose'] as const){
  const entered=deferred<AdmissionRequest>(),release=deferred(),abort=new AbortController()
  const f=await initialSubagentFixture(t,{admitPrompt:async(request,dispatch)=>{entered.resolve(request);await release.promise;dispatch()}})
  const pending=start(f,mode==='continuable'?mode:'one-shot',abort.signal),request=await entered.promise
  const run=mode==='continuable'?undefined:await pending,denied=assert.rejects(run?run.result:pending)
  const disposing=mode==='dispose'?run!.dispose():undefined
  if(!disposing)abort.abort(Error('test caller aborted'))
  release.resolve();await denied;await disposing;assert.equal(inserted(request).length,0)
  if(run&&!disposing)await run.dispose()
 }
})

test('两种初始发布最终复核exact child/parent Session和真实runtime ownership',{timeout:10000},async t=>{
 for(const mode of ['continuable','one-shot'] as const)for(const change of ['child-session','parent-session','ownership'] as const){
  const entered=deferred<AdmissionRequest>(),release=deferred();let restore=()=>{}
  const f=await initialSubagentFixture(t,{admitPrompt:async(request,dispatch)=>{entered.resolve(request);await release.promise;try{dispatch()}finally{restore()}}})
  const pending=start(f,mode),request=await entered.promise,run=mode==='one-shot'?await pending:undefined
  const denied=assert.rejects(run?run.result:pending,/residency changed/)
  if(change==='ownership'){
   const entries=Reflect.get(f.ctx.agents,'store') as Map<string,{owner:Agent|undefined}>,entry=entries.get(request.agent.id)!,owner=entry.owner
   entry.owner=undefined;restore=()=>{entry.owner=owner}
  }else{
   const target=change==='child-session'?request.agent:f.parent,session=target.session
   Reflect.set(target,'session',change==='child-session'?f.parent.session:request.agent.session);restore=()=>{Reflect.set(target,'session',session)}
  }
  release.resolve();await denied;assert.equal(inserted(request).length,0);if(run)await run.dispose()
 }
})

test('managed service缺public方法必须failclosed；原Free无service directdriver保留受理',{timeout:10000},async t=>{
 const unknown=await initialSubagentFixture(t,{}, {service:'original'}),run=await unknown.startOneShot()
 await assert.rejects(run.result,/initial prompt admission is unavailable/)
 assert.equal(unknown.ctx.agents.get(run.id),run.localAgent);assert.equal(unknown.ledger(run.localAgent).length,0);await run.dispose()
 const free=await initialSubagentFixture(t,{}, {service:'none'}),direct=await free.startDirect();t.after(()=>direct.dispose())
 assert.equal(free.ctx.get('subagents'),undefined);assert.equal(free.ledger(direct.localAgent).length,1)
})

test('public admitPrompt不扩Remote；原始/scoped仍复用一个不可替换holder',{timeout:10000},async t=>{
 const provider=async(_request:AdmissionRequest,dispatch:()=>void)=>dispatch(),f=await initialSubagentFixture(t,{admitPrompt:provider}),scoped=Reflect.get(f.ctx.extend(),'subagents') as typeof f.service
 f.service.installPromptAdmission(provider);scoped.installPromptAdmission(provider);assert.throws(()=>scoped.installPromptAdmission(async()=>{}),/provider is unavailable/)
 assert.equal(Reflect.set(scoped,'promptAdmission',{}),false)
 const require=createRequire(import.meta.url),entry=createRequire(require.resolve('@deepseek-ai/dsh-subagent')).resolve('@deepseek-ai/dsh-typert-protocol'),protocol=await import(pathToFileURL(entry).href)
 assert.deepEqual(protocol.remoteMethods(f.service).map((row:{method:string})=>row.method),['prompt','interruptByParent'])
 assert.ok(!protocol.remoteMethods(f.service).some((row:{method:string})=>row.method==='admitPrompt'))
})

test('真实coldResume经过resume策略，不能标成initial或凭持久父链放行',{timeout:10000},async t=>{
 const seen:AdmissionRequest[]=[],f=await initialSubagentFixture(t,{admitPrompt:async(request,dispatch)=>{seen.push(request);dispatch()}})
 const first=await f.startContinuable();f.releaseSteps();await until(()=>f.ctx.agents.get(first.childId)===undefined)
 const id=await f.service.sendMessage(f.parent,first.childId,[{type:'text',text:'真实恢复新递送'}],{signal:new AbortController().signal})
 assert.deepEqual(seen.map(row=>row.kind),['initial','resume']);assert.equal(seen[1]!.message.id,id);assert.notEqual(seen[1]!.agent,seen[0]!.agent)
 assert.equal(seen[1]!.sender,f.parent);assert.equal(Reflect.get(seen[1]!,'mode'),undefined)
 assert.ok(inserted(seen[1]!).some(message=>message.id===id));assert.equal(f.modelCalls(),0)
})

test('coldResume等待撤销零新消息；已有历史消息不充当本次真实受理',{timeout:10000},async t=>{
 const entered=deferred<AdmissionRequest>(),release=deferred();let valid=true
 const f=await initialSubagentFixture(t,{admitPrompt:async(request,dispatch)=>{if(request.kind==='resume'){entered.resolve(request);await release.promise;if(!valid)throw Error('test resume revoked')}dispatch()}})
 const first=await f.startContinuable();f.releaseSteps();await until(()=>f.ctx.agents.get(first.childId)===undefined)
 const pending=f.service.sendMessage(f.parent,first.childId,[{type:'text',text:'不得借旧输入受理'}],{signal:new AbortController().signal}),denied=assert.rejects(pending,/test resume revoked/)
 const request=await entered.promise;assert.equal(request.kind,'resume');assert.ok(inserted(request).some(message=>message.id===first.messageId));assert.ok(!inserted(request).some(message=>message.id===request.message.id))
 valid=false;release.resolve();await denied;assert.ok(!inserted(request).some(message=>message.id===request.message.id))
})

test('真实初始插入后dispatch collector抛错保留唯一receipt；普通observer亦不重复',{timeout:10000},async t=>{
 for(const mode of ['continuable','one-shot'] as const)for(const fault of ['observer','collector'] as const){
  let request:AdmissionRequest|undefined,notifications=0
  const f=await initialSubagentFixture(t,{admitPrompt:async(candidate,dispatch)=>{request=candidate;dispatch()}},{beforeService({ctx}){
   if(fault==='collector')ctx.on('internal/dispatch',(_mode,name)=>{if(name==='agent/inbox/inserted'){notifications++;throw Error('test committed collector')}})
   else ctx.on('agent/inbox/inserted',()=>{notifications++;throw Error('test contained observer')})
  }})
  const value=await start(f,mode);await until(()=>request!==undefined&&inserted(request).length===1)
  assert.deepEqual(inserted(request!),[request!.message]);assert.equal(notifications,1)
  if(mode==='continuable')assert.equal(value.messageId,request!.message.id)
  else{f.releaseSteps();await value.result;await value.dispose()}
 }
})

test('相同id/source但不同正文的真实splice不构成initial候选受理',{timeout:10000},async t=>{
 for(const mode of ['continuable','one-shot'] as const){
  let request:AdmissionRequest|undefined
  const f=await initialSubagentFixture(t,{admitPrompt:async(candidate,dispatch)=>{
   request=candidate;const followup=candidate.agent.followup
   candidate.agent.followup=message=>followup.call(candidate.agent,{...message,content:[{type:'text',text:'其他真实正文'}]})
   try{dispatch()}finally{candidate.agent.followup=followup}
  }},{beforeService({ctx}){ctx.on('internal/dispatch',(_mode,name)=>{if(name==='agent/inbox/inserted')throw Error('test different committed collector')})}})
  if(mode==='continuable')await assert.rejects(f.startContinuable(),/test different committed collector/)
  else{const run=await f.startOneShot();await assert.rejects(run.result,/test different committed collector/);await run.dispose()}
  const actual=inserted(request!)[0]!;assert.equal(actual.id,request!.message.id);assert.deepEqual(actual.source,request!.message.source);assert.notDeepEqual(actual,request!.message)
 }
})

test('真patched Session + NativeWorkInput + WorkAccess最终撤销，两种初始输入均零写',{timeout:10000},async t=>{
 for(const mode of ['continuable','one-shot'] as const){
  const sessionPackage=await patchedSessionPackage(t),access=new WorkAccess(),entered=deferred(),release=deferred();let valid=true,input:ReturnType<typeof createNativeWorkInput>,request:AdmissionRequest|undefined
  access.requirePolicy();access.installPolicy(async()=>{entered.resolve();await release.promise;return {assertCurrent(){if(!valid)throw Error('test final revoked')}}})
  const f=await initialSubagentFixture(t,{admitPrompt:async(candidate,dispatch)=>{request=candidate;await input.withNewInput(candidate.agent,candidate.message,{producer:'subagent',identity:JSON.stringify([candidate.kind,candidate.sender.id,candidate.agent.id])},dispatch,candidate.signal)}},{sessionPackage,beforeService({ctx}){input=createNativeWorkInput(ctx,access);t.after(()=>input.close())}})
  const pending=start(f,mode);await entered.promise;const run=mode==='one-shot'?await pending:undefined,denied=assert.rejects(run?run.result:pending)
  assert.equal(inserted(request!).length,0);valid=false;release.resolve();await denied;assert.equal(inserted(request!).length,0);if(run)await run.dispose()
 }
})

test('真patched Session + 同一NativeWorkInput允许exact initial；无最终lease不能直接写',{timeout:10000},async t=>{
 const sessionPackage=await patchedSessionPackage(t),access=new WorkAccess();let calls=0,input:ReturnType<typeof createNativeWorkInput>,candidate:AdmissionRequest|undefined
 access.requirePolicy();access.installPolicy(async()=>{calls++;return {assertCurrent(){}}})
 const f=await initialSubagentFixture(t,{admitPrompt:async(request,dispatch)=>{candidate=request;await input.withNewInput(request.agent,request.message,{producer:'subagent',identity:'exact-initial'},dispatch,request.signal)}},{sessionPackage,beforeService({ctx}){input=createNativeWorkInput(ctx,access);t.after(()=>input.close())}})
 const first=await f.startContinuable();assert.equal(first.messageId,candidate!.message.id);assert.deepEqual(inserted(candidate!),[candidate!.message]);assert.equal(calls,1)
 assert.throws(()=>candidate!.agent.followup(candidate!.message),{code:'teloa/forbidden'});assert.equal(inserted(candidate!).length,1)
})

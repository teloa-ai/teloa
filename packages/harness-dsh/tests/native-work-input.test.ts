import test from 'node:test'
import assert from 'node:assert/strict'
import type {Agent} from '@deepseek-ai/dsh-agent'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import {WorkAccess,type WorkAccessRequest} from '../../backend/src/work/work-access.ts'
import {createNativeWorkInput} from '../src/native-work-input.ts'
import {patchedSessionFixture} from './fixtures/native-final-session.ts'
import {nativeProviderKernel} from './fixtures/native-input-provider.ts'
const message=(id='request')=>({...createUserMessage({source:{kind:'user',rpcId:id},content:[{type:'text',text:'固定原生输入'}]})})
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done});return {promise,resolve}}
const forbidden={code:'teloa/forbidden'}
test('实际append前取消释放未受理lease，最终真实受理后失败不释放执行预约',async t=>{
 for(const accepted of [false,true]){
  const {ctx,agent}=await patchedSessionFixture(t),access=new WorkAccess(),controller=new AbortController(),input=message(),before=agent.session.snapshotEvents().length
  let releases=0
  access.installPolicy(async()=>({assertCurrent(){},releaseUnaccepted(){releases++}}))
  const work=createNativeWorkInput(ctx,access)
  if(!accepted)ctx.on('internal/dispatch',(_mode,name,args)=>{if(name==='session/event'&&args[1]?.type==='agent/inbox/spliced')controller.abort()})
  await assert.rejects(work.withNewInput(agent,input,{producer:'prompt',identity:'reservation'},()=>{agent.inbox.append('next-turn',input);if(accepted)throw Error('after actual append')},controller.signal))
  assert.equal(releases,accepted?0:1)
  assert.equal(agent.session.snapshotEvents().length>before,accepted)
  assert.equal(agent.inbox.nextTurn.length,accepted?1:0)
 }
})

test('真实prompt按可信员工能力拒绝，基础会话受理；禁止renderer以prompt绕过分类',async t=>{
 const {ctx,agent,other}=await patchedSessionFixture(t),access=new WorkAccess(),seen:WorkAccessRequest[]=[]
 access.installSessionCapabilities(async id=>({ownerId:'actual-owner',capabilities:id===agent.id?['people']:['general-agent']}))
 access.installPolicy(async request=>{seen.push(request);if(request.kind==='capability'&&request.capability==='people')throw Error('locked');return {assertCurrent(){}}})
 const work=createNativeWorkInput(ctx,access),input=message('locked-employee'),before=agent.session.snapshotEvents().length
 await assert.rejects(work.withNewInput(agent,input,{producer:'prompt',identity:'general-claimed'},()=>agent.inbox.append('next-turn',input)),forbidden)
 assert.equal(agent.inbox.nextTurn.length,0);assert.equal(agent.session.snapshotEvents().length,before)
 const basic=message('basic-work')
 await work.withNewInput(other,basic,{producer:'prompt',identity:'ordinary'},()=>other.inbox.append('next-turn',basic))
 assert.equal(other.inbox.nextTurn[0]?.id,basic.id)
 assert.ok(seen.some(request=>request.kind==='capability'&&request.capability==='people'&&request.ownerId==='actual-owner'))
})

test('创建后立即提交等待真实 Loop 注入及策略，exact消息与上下文只发送摘要，最终真实入Inbox',{timeout:10000},async t=>{
 const {ctx,agent}=await patchedSessionFixture(t),access=new WorkAccess(),entered=deferred(),release=deferred(),seen:WorkAccessRequest[]=[],before=agent.session.snapshotEvents().length
 access.requirePolicy();access.installPolicy(async request=>{seen.push(request);entered.resolve();await release.promise;return {assertCurrent:()=>{}}})
 const work=createNativeWorkInput(ctx,access),input=message(),context={producer:'prompt' as const,identity:'private-context'},pending=work.withNewInput(agent,input,context,()=>{agent.inbox.append('next-turn',input)})
 await entered.promise;assert.equal(agent.session.snapshotEvents().length,before);assert.equal(agent.inbox.nextTurn.length,0)
 context.identity='changed-after-request';release.resolve();await pending
 assert.equal(agent.inbox.nextTurn[0]?.id,input.id);assert.equal(seen.length,1);assert.equal(Object.isFrozen(seen[0]),true)
 assert.equal(seen[0]?.kind,'native-input');assert.ok(!JSON.stringify(seen).includes('private-context'));assert.ok(!JSON.stringify(seen).includes('固定原生输入'))
})
test('等待许可期间撤销、消息变化或目标替换，均无原生日志/Inbox写入',async t=>{
 for(const change of ['lease','payload','agent']){
  const {ctx,agent,other}=await patchedSessionFixture(t),access=new WorkAccess(),entered=deferred(),release=deferred(),before=agent.session.snapshotEvents().length
  let valid=true
  access.requirePolicy();access.installPolicy(async()=>{entered.resolve();await release.promise;return {assertCurrent:()=>{if(!valid)throw Error('revoked')}}})
  const work=createNativeWorkInput(ctx,access),input=message(),pending=work.withNewInput(agent,input,{producer:'task-run',identity:'run'},()=>{(change==='agent'?other:agent).inbox.append('next-turn',input)}),rejected=assert.rejects(pending,forbidden)
  await entered.promise;if(change==='lease')valid=false;if(change==='payload')input.content=[{type:'text',text:'changed'}]
  release.resolve();await rejected;assert.equal(agent.session.snapshotEvents().length,before);assert.equal(agent.inbox.nextTurn.length,0);assert.equal(other.inbox.nextTurn.length,0)
 }
})
test('缺策略与关闸不执行submit',async t=>{
 const {ctx,agent}=await patchedSessionFixture(t),access=new WorkAccess(),work=createNativeWorkInput(ctx,access),input=message()
 access.requirePolicy();let calls=0
 await assert.rejects(work.withNewInput(agent,input,{producer:'prompt',identity:'request'},()=>{calls++}),{code:'teloa/unavailable'})
 access.installPolicy(async()=>({assertCurrent:()=>{}}));work.close()
 await assert.rejects(work.withNewInput(agent,input,{producer:'prompt',identity:'request'},()=>{calls++;agent.inbox.append('next-turn',input)}),forbidden)
 assert.equal(calls,0);assert.equal(agent.inbox.nextTurn.length,0)
})
test('等待真实 Loop 注入时关闸或取消，不请求许可且不写入',{timeout:10000},async t=>{
 for(const reason of ['closed','aborted']){
  const {ctx,agent}=await patchedSessionFixture(t),access=new WorkAccess(),abort=new AbortController(),input=message(),before=agent.session.snapshotEvents().length
  let calls=0,submits=0
  access.installPolicy(async()=>{calls++;return {assertCurrent(){}}})
  const work=createNativeWorkInput(ctx,access)
  const pending=work.withNewInput(agent,input,{producer:'prompt',identity:'startup'},()=>{submits++;agent.inbox.append('next-turn',input)},abort.signal)
  const rejected=assert.rejects(pending)
  if(reason==='closed')work.close();else abort.abort()
  await rejected
  assert.equal(calls,0);assert.equal(submits,0);assert.equal(agent.session.snapshotEvents().length,before);assert.equal(agent.inbox.nextTurn.length,0)
 }
})
test('缺 Loop 的真实注入及时拒绝，不请求许可、不提交且 Session 零写',{timeout:10000},async t=>{
 const {ctx,sessions,sessionPackage}=await nativeProviderKernel(t),access=new WorkAccess(),input=message('missing-loop')
 const session=sessions.create(sessionPackage.SessionId('missing-loop'))
 // 无 Loop 时没有 Agent factory；只登记最小目标以通过 exact-target 前置检查。
 // Session、Registry、Cordis 注入和最终守卫均使用真实实现。
 const agent={id:session.id,session,ctx} as Agent
 t.after(ctx.agents.enter(agent,undefined))
 assert.equal(ctx.agents.get(agent.id),agent);assert.equal(sessions.get(agent.id),session)
 assert.equal(ctx.get('agentLoop'),undefined)
 let authorizations=0,submits=0
 access.requirePolicy();access.installPolicy(async()=>{authorizations++;return {assertCurrent(){}}})
 const work=createNativeWorkInput(ctx,access),before=session.snapshotEvents(),seq=session.seq
 t.after(()=>work.close())
 let timer:ReturnType<typeof setTimeout>|undefined
 const deadline=new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(Error('缺 Loop 的 whenReady 未在 1 秒内结算')),1000)})
 try{
  await assert.rejects(Promise.race([work.withNewInput(agent,input,{producer:'prompt',identity:'missing-loop'},()=>{
   submits++;session.append('agent/inbox/spliced',{target:'next-turn',start:0,removedCount:0,inserted:[input]})
  }),deadline]),{code:'teloa/forbidden',message:'工作许可或实际受理因果已失效。'})
 }finally{clearTimeout(timer)}
 assert.equal(ctx.get('agentLoop'),undefined);assert.equal(authorizations,0);assert.equal(submits,0)
 assert.equal(session.seq,seq);assert.deepEqual(session.snapshotEvents(),before)
})
test('producer上下文或异步submit无效时不向许可策略请求',async t=>{
 const {ctx,agent}=await patchedSessionFixture(t),access=new WorkAccess();let calls=0
 access.installPolicy(async()=>{calls++;return {assertCurrent:()=>{}}})
 const work=createNativeWorkInput(ctx,access),input=message()
 for(const context of [{producer:'other',identity:'x'},{producer:'prompt',identity:''}])await assert.rejects(work.withNewInput(agent,input,context as never,()=>{}),forbidden)
 await assert.rejects(work.withNewInput(agent,input,{producer:'prompt',identity:'x'},async()=>{}),forbidden);assert.equal(calls,0)
})
test('最终dispatch之后仍同步复核signal，后续listener取消时真实零写',async t=>{
 const {ctx,agent}=await patchedSessionFixture(t),access=new WorkAccess(),controller=new AbortController(),input=message(),before=agent.session.snapshotEvents().length
 access.installPolicy(async()=>({assertCurrent:()=>{}}));const work=createNativeWorkInput(ctx,access)
 ctx.on('internal/dispatch',(_mode,name,args)=>{if(name==='session/event'&&args[1]?.type==='agent/inbox/spliced')controller.abort()})
 await assert.rejects(work.withNewInput(agent,input,{producer:'subagent',identity:'parent'},()=>{agent.inbox.append('next-turn',input)},controller.signal),forbidden)
 assert.equal(agent.session.snapshotEvents().length,before);assert.equal(agent.inbox.nextTurn.length,0)
})

test('rpcId取自唯一官方快照，getter后续不同值不能污染发给主进程的身份',async t=>{
 const {ctx,agent}=await patchedSessionFixture(t),access=new WorkAccess(),input=message('a'),seen:WorkAccessRequest[]=[],before=agent.session.snapshotEvents().length
 let reads=0
 Object.defineProperty(input,'source',{enumerable:true,get(){reads++;return {kind:'user',rpcId:reads===2?'b':'a'}}})
 access.installPolicy(async request=>{seen.push(request);return {assertCurrent:()=>{}}})
 const work=createNativeWorkInput(ctx,access)
 await assert.rejects(work.withNewInput(agent,input,{producer:'prompt',identity:'request'},()=>{agent.inbox.append('next-turn',input)}),forbidden)
 assert.equal(seen.length,1);assert.equal((seen[0] as Extract<WorkAccessRequest,{kind:'native-input'}>).nativeRequestId,'a')
 assert.equal(agent.session.snapshotEvents().length,before);assert.equal(agent.inbox.nextTurn.length,0)
})
test('普通function返回Promise的迟到提交被真正同步ticket拒绝，拒绝被接住',async t=>{
 const {ctx,agent}=await patchedSessionFixture(t),access=new WorkAccess(),input=message(),before=agent.session.snapshotEvents().length
 access.installPolicy(async()=>({assertCurrent:()=>{}}));const work=createNativeWorkInput(ctx,access)
 await assert.rejects(work.withNewInput(agent,input,{producer:'prompt',identity:'request'},()=>Promise.resolve().then(()=>{agent.inbox.append('next-turn',input)})),forbidden)
 await new Promise<void>(done=>setImmediate(done));assert.equal(agent.session.snapshotEvents().length,before);assert.equal(agent.inbox.nextTurn.length,0)
 await assert.rejects(work.withNewInput(agent,input,{producer:'prompt',identity:'request'},()=>Promise.reject(Error('private callback rejected'))),forbidden)
 await new Promise<void>(done=>setImmediate(done))
})

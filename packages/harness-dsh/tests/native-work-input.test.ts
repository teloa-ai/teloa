import test from 'node:test'
import assert from 'node:assert/strict'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import {WorkAccess,type WorkAccessRequest} from '../../backend/src/work/work-access.ts'
import {createNativeWorkInput} from '../src/native-work-input.ts'
import {patchedSessionFixture} from './fixtures/native-final-session.ts'
const message=(id='request')=>({...createUserMessage({source:{kind:'user',rpcId:id},content:[{type:'text',text:'固定原生输入'}]})})
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done});return {promise,resolve}}
const forbidden={code:'teloa/forbidden'}

test('首次原生输入等待实际策略后，exact消息与上下文只发送摘要，最终真实入Inbox',async t=>{
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

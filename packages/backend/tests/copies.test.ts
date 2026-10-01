import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CopyPendingError, CopyRejectedError, CopyService, FileCopyRepository } from '../src/work/copies.ts'

const owner='local:teloa-owner'
const source='source-session'
const requestId='12345678-1234-4234-8234-123456789012'
const secondRequestId='22345678-1234-4234-8234-123456789012'

async function fixture() {
  const path=join(await mkdtemp(join(tmpdir(),'teloa-copies-')),'copies.json')
  const repository=new FileCopyRepository(path)
  const forked:string[]=[]
  const inspected:string[]=[]
  const authorized:string[]=[]
  const children=new Map<string,{parentSession?:string;origin?:string}>()
  const host={
    async fork(sourceSessionId:string) {forked.push(sourceSessionId);const child=`copy-${forked.length}`;children.set(child,{parentSession:sourceSessionId});return child},
    async inspect(childSessionId:string) {inspected.push(childSessionId);const value=children.get(childSessionId);if(!value)throw Error('会话不存在');return value},
  }
  const authorize=async(sourceSessionId:string)=>{authorized.push(sourceSessionId);if(sourceSessionId==='forbidden-source')throw Error('无权读取来源')}
  const identity={now:()=> '2026-09-11T08:00:00.000Z'}
  const service=new CopyService(repository,host,identity,authorize)
  return {path,repository,forked,inspected,authorized,children,host,authorize,identity,service}
}

test('fork 前先持久保存 pending，成功后核对普通副本血缘并保存 ready',async()=>{
  const f=await fixture()
  let pendingSeen=false
  const service=new CopyService(f.repository,{
    ...f.host,
    fork:async(sourceSessionId:string)=>{
      const rows=await f.repository.read()
      pendingSeen=rows.length===1&&rows[0]?.state==='pending'&&rows[0].sourceSessionId===sourceSessionId
      f.forked.push(sourceSessionId);f.children.set('copy-success',{parentSession:sourceSessionId});return 'copy-success'
    },
  },f.identity,f.authorize)
  const row=await service.create(owner,{sourceSessionId:source,requestId})
  assert.equal(pendingSeen,true)
  assert.deepEqual(row,{ownerId:owner,requestId,sourceSessionId:source,state:'ready',childSessionId:'copy-success',createdAt:'2026-09-11T08:00:00.000Z'})
  assert.deepEqual(await f.repository.read(),[row])
  assert.deepEqual(f.authorized,[source])
  assert.deepEqual(f.inspected,['copy-success'])
})

test('ready 记录重启后直接恢复，同一请求不会再次 fork',async()=>{
  const f=await fixture()
  const ready=await f.service.create(owner,{sourceSessionId:source,requestId})
  const restarted=new CopyService(new FileCopyRepository(f.path),f.host,f.identity,f.authorize)
  assert.deepEqual(await restarted.create(owner,{sourceSessionId:source,requestId}),ready)
  assert.deepEqual(f.forked,[source])
})

test('未知失败保留 pending，重启后同请求及同来源新请求都不再 fork',async()=>{
  const f=await fixture()
  const failing=new CopyService(f.repository,{...f.host,fork:async(sourceSessionId:string)=>{f.forked.push(sourceSessionId);throw Error('连接中断')}},f.identity,f.authorize)
  await assert.rejects(failing.create(owner,{sourceSessionId:source,requestId}),/连接中断/)
  assert.equal((await f.repository.read())[0]?.state,'pending')
  const restarted=new CopyService(new FileCopyRepository(f.path),f.host,f.identity,f.authorize)
  await assert.rejects(restarted.create(owner,{sourceSessionId:source,requestId}),{code:'teloa/copy-result-unknown'})
  await assert.rejects(restarted.create(owner,{sourceSessionId:source,requestId:secondRequestId}),{code:'teloa/copy-result-unknown'})
  await assert.rejects(restarted.create(owner,{sourceSessionId:'another-source',requestId}),{code:'teloa/conflict'})
  assert.deepEqual(f.forked,[source])
})

test('宿主已知副本但尚未就绪时持久保存 child，重启不再 fork',async()=>{
  const f=await fixture()
  const pending=new CopyService(f.repository,{...f.host,fork:async(sourceSessionId:string)=>{f.forked.push(sourceSessionId);throw new CopyPendingError('known-child','工作区挂载尚未完成')}},f.identity,f.authorize)
  await assert.rejects(pending.create(owner,{sourceSessionId:source,requestId}),CopyPendingError)
  assert.deepEqual((await f.repository.read())[0],{ownerId:owner,requestId,sourceSessionId:source,state:'pending',childSessionId:'known-child',createdAt:'2026-09-11T08:00:00.000Z'})
  const restarted=new CopyService(new FileCopyRepository(f.path),f.host,f.identity,f.authorize)
  await assert.rejects(restarted.create(owner,{sourceSessionId:source,requestId}),{code:'teloa/copy-result-unknown'})
  assert.deepEqual(f.forked,[source])
})

test('宿主明确拒绝时保存 rejected，重复请求不 fork 且不阻断来源的新请求',async()=>{
  const f=await fixture()
  let reject=true
  const host={...f.host,fork:async(sourceSessionId:string)=>{f.forked.push(sourceSessionId);if(reject)throw new CopyRejectedError('宿主确认未创建');const child='copy-after-rejection';f.children.set(child,{parentSession:sourceSessionId});return child}}
  const service=new CopyService(f.repository,host,f.identity,f.authorize)
  await assert.rejects(service.create(owner,{sourceSessionId:source,requestId}),CopyRejectedError)
  const rejected=(await f.repository.read())[0]!
  assert.equal(rejected.state,'rejected')
  assert.deepEqual(await service.create(owner,{sourceSessionId:source,requestId}),rejected)
  reject=false
  assert.equal((await service.create(owner,{sourceSessionId:source,requestId:secondRequestId})).state,'ready')
  assert.deepEqual(f.forked,[source,source])
})

test('单宿主并发创建串行化，同一意图只 fork 一次',async()=>{
  const f=await fixture()
  const [a,b]=await Promise.all([
    f.service.create(owner,{sourceSessionId:source,requestId}),
    f.service.create(owner,{sourceSessionId:source,requestId}),
  ])
  assert.deepEqual(a,b)
  assert.deepEqual(f.forked,[source])
  assert.deepEqual(f.authorized,[source,source])
})

test('同一来源的不同请求并发到达时不在首个 ready 后再次 fork',async()=>{
  const f=await fixture()
  let release:()=>void=()=>{}
  const gate=new Promise<void>(resolve=>{release=resolve})
  const service=new CopyService(f.repository,{...f.host,fork:async(sourceSessionId:string)=>{f.forked.push(sourceSessionId);await gate;f.children.set('only-child',{parentSession:sourceSessionId});return 'only-child'}},f.identity,f.authorize)
  const first=service.create(owner,{sourceSessionId:source,requestId})
  const second=service.create(owner,{sourceSessionId:source,requestId:secondRequestId})
  await assert.rejects(second,{code:'teloa/copy-result-unknown'})
  release()
  assert.equal((await first).state,'ready')
  assert.deepEqual(f.forked,[source])
  assert.equal((await f.repository.read()).length,1)
})

test('resolve 显式确认 pending 的已有普通副本，ready 对同一 child 幂等',async()=>{
  const f=await fixture()
  const failing=new CopyService(f.repository,{...f.host,fork:async()=>{throw Error('响应丢失')}},f.identity,f.authorize)
  await assert.rejects(failing.create(owner,{sourceSessionId:source,requestId}),/响应丢失/)
  f.children.set('recovered-child',{parentSession:source})
  const restarted=new CopyService(new FileCopyRepository(f.path),f.host,f.identity,f.authorize)
  const ready=await restarted.resolve(owner,{requestId,childSessionId:'recovered-child'})
  assert.equal(ready.state,'ready');assert.equal(ready.childSessionId,'recovered-child')
  assert.deepEqual(await restarted.resolve(owner,{requestId,childSessionId:'recovered-child'}),ready)
  await assert.rejects(restarted.resolve(owner,{requestId,childSessionId:'other-child'}),{code:'teloa/conflict'})
  assert.deepEqual(f.forked,[])
})

test('resolve 不允许把已知 pending child 改绑到另一会话',async()=>{
  const f=await fixture()
  const pending=new CopyService(f.repository,{...f.host,fork:async()=>{throw new CopyPendingError('known-child','刷新失败')}},f.identity,f.authorize)
  await assert.rejects(pending.create(owner,{sourceSessionId:source,requestId}),CopyPendingError)
  f.children.set('known-child',{parentSession:source})
  f.children.set('different-child',{parentSession:source})
  await assert.rejects(pending.resolve(owner,{requestId,childSessionId:'different-child'}),{code:'teloa/conflict'})
  assert.equal(f.inspected.length,0)
  assert.equal((await pending.resolve(owner,{requestId,childSessionId:'known-child'})).state,'ready')
})

test('resolve 刷新仍未就绪时持久保存宿主确认的 child 并禁止后续改绑',async()=>{
  const f=await fixture()
  const unknown=new CopyService(f.repository,{...f.host,fork:async()=>{throw Error('响应丢失')},inspect:async(childSessionId:string)=>{throw new CopyPendingError(childSessionId,'刷新仍未完成')}},f.identity,f.authorize)
  await assert.rejects(unknown.create(owner,{sourceSessionId:source,requestId}))
  await assert.rejects(unknown.resolve(owner,{requestId,childSessionId:'selected-child'}),CopyPendingError)
  assert.equal((await f.repository.read())[0]?.childSessionId,'selected-child')
  await assert.rejects(unknown.resolve(owner,{requestId,childSessionId:'different-child'}),{code:'teloa/conflict'})
})

test('宿主返回另一条 pending 已记录的 child 时报告冲突',async()=>{
  const f=await fixture()
  const first=new CopyService(f.repository,{...f.host,fork:async()=>{throw new CopyPendingError('shared-child','刷新失败')}},f.identity,f.authorize)
  await assert.rejects(first.create(owner,{sourceSessionId:source,requestId}),CopyPendingError)
  const second=new CopyService(f.repository,{...f.host,fork:async()=> 'shared-child'},f.identity,f.authorize)
  await assert.rejects(second.create(owner,{sourceSessionId:'other-source',requestId:secondRequestId}),{code:'teloa/conflict'})
})

test('resolve 拒绝错误血缘、子 Agent、错误主体和未知请求，且 pending 保持不变',async()=>{
  const f=await fixture()
  const failing=new CopyService(f.repository,{...f.host,fork:async()=>{throw Error('响应丢失')}},f.identity,f.authorize)
  await assert.rejects(failing.create(owner,{sourceSessionId:source,requestId}))
  f.children.set('wrong-parent',{parentSession:'someone-else'})
  f.children.set('subagent-child',{parentSession:source,origin:'subagent'})
  f.children.set('special-child',{parentSession:source,origin:'future-special-origin'})
  await assert.rejects(failing.resolve(owner,{requestId,childSessionId:'wrong-parent'}),{code:'teloa/copy-lineage-mismatch'})
  await assert.rejects(failing.resolve(owner,{requestId,childSessionId:'subagent-child'}),{code:'teloa/copy-lineage-mismatch'})
  await assert.rejects(failing.resolve(owner,{requestId,childSessionId:'special-child'}),{code:'teloa/copy-lineage-mismatch'})
  await assert.rejects(failing.resolve('another-owner',{requestId,childSessionId:'subagent-child'}),{code:'teloa/not-found'})
  await assert.rejects(failing.resolve(owner,{requestId:secondRequestId,childSessionId:'subagent-child'}),{code:'teloa/not-found'})
  assert.equal((await f.repository.read())[0]?.state,'pending')
})

test('create、list 与 resolve 严格拒绝未知字段和非法身份',async()=>{
  const f=await fixture()
  await assert.rejects(f.service.create(owner,{sourceSessionId:source,requestId,ownerId:'other'}),{code:'teloa/invalid-input'})
  await assert.rejects(f.service.create(owner,{sourceSessionId:'../escape',requestId}),{code:'teloa/invalid-input'})
  await assert.rejects(f.service.create('',{sourceSessionId:source,requestId}),{code:'teloa/invalid-input'})
  await assert.rejects(f.service.list(owner,{state:'ready'}),{code:'teloa/invalid-input'})
  await assert.rejects(f.service.resolve(owner,{requestId,childSessionId:'../escape'}),{code:'teloa/invalid-input'})
  assert.deepEqual(await f.repository.read(),[])
})

test('list 持久返回本人全部历史，隔离其他主体',async()=>{
  const f=await fixture()
  await f.service.create(owner,{sourceSessionId:source,requestId})
  await f.service.create('another-owner',{sourceSessionId:'other-source',requestId})
  const restarted=new CopyService(new FileCopyRepository(f.path),f.host,f.identity,f.authorize)
  assert.deepEqual((await restarted.list(owner,{})).map(row=>row.ownerId),[owner])
  assert.deepEqual((await restarted.list('another-owner',{})).map(row=>row.ownerId),['another-owner'])
})

test('损坏文件显式失败且原文不被覆盖',async()=>{
  const f=await fixture()
  await writeFile(f.path,'broken')
  await assert.rejects(f.service.create(owner,{sourceSessionId:source,requestId}),{code:'teloa/storage-corrupt'})
  assert.equal(await readFile(f.path,'utf8'),'broken')
  await writeFile(f.path,JSON.stringify({schema:'teloa.copies/v1',rows:[{ownerId:owner,requestId,sourceSessionId:source,state:'ready',createdAt:'bad-date'}]}))
  await assert.rejects(f.repository.read(),{code:'teloa/storage-corrupt'})
})

test('明确允许独立新建保留原未知记录，重启后新请求才可创建',async()=>{
 const f=await fixture();const failing=new CopyService(f.repository,{...f.host,fork:async()=>{throw Error('未知结果')}},f.identity,f.authorize)
 await assert.rejects(failing.create(owner,{sourceSessionId:source,requestId}),/未知结果/)
 await assert.rejects(failing.release(owner,{requestId,acceptPossibleDuplicate:false}),{code:'teloa/invalid-input'})
 const released=await failing.release(owner,{requestId,acceptPossibleDuplicate:true})
 assert.equal(released.state,'pending');assert.equal(released.releasedAt,f.identity.now());assert.deepEqual(f.forked,[])
 const restarted=new CopyService(f.repository,f.host,f.identity,f.authorize)
 const created=await restarted.create(owner,{sourceSessionId:source,requestId:secondRequestId})
 assert.equal(created.state,'ready');assert.equal((await f.repository.read()).length,2)
 f.children.set('late-copy',{parentSession:source})
 assert.equal((await restarted.resolve(owner,{requestId,childSessionId:'late-copy'})).state,'ready')
 assert.deepEqual(f.forked,[source])
})
test('不能释放正在创建或已完成的尝试，错误主体不能解除旧锁',async()=>{
 const f=await fixture();let done!:(value:string)=>void
 const service=new CopyService(f.repository,{...f.host,fork:()=>new Promise(resolve=>{done=resolve})},f.identity,f.authorize)
 const creating=service.create(owner,{sourceSessionId:source,requestId})
 await assert.rejects(service.release(owner,{requestId,acceptPossibleDuplicate:true}),{code:'teloa/copy-in-progress'})
 while(!done)await new Promise(resolve=>setImmediate(resolve))
 f.children.set('created',{parentSession:source});done('created');await creating
 await assert.rejects(service.release(owner,{requestId,acceptPossibleDuplicate:true}),{code:'teloa/conflict'})
 await assert.rejects(service.release('another-owner',{requestId,acceptPossibleDuplicate:true}),{code:'teloa/not-found'})
})

import test from 'node:test'
import assert from 'node:assert/strict'
import type {WorkResource} from '@teloa/contract'
import {createLocalRetrievalApi,type RetrievalModelStatus,type RetrievalStatus} from '../src/client/local-retrieval-api.ts'
import {unwrapWorkRpcResult} from '../src/client/work-rpc-result.ts'
import {createEmployeeRetrievalBatch,type RetrievalBatchJournal} from '../src/client/employee-retrieval-batch.ts'

// 仅验证客户端调度、恢复与不重发约束；这些受控端口不证明真实 RPC、PG、索引或模型验收。
const roleId='11111111-1111-4111-8111-111111111111'
const model:RetrievalModelStatus={enabled:true,provider:{id:'local',location:'host-local',catalogId:'test',catalogVersion:'1',profileHash:'a'.repeat(64),variant:'fp32',totalMemoryBytes:1,memoryRisk:false,preparation:{phase:'ready'}},building:false,guidance:null}
const resource=(sourceId:string,status='active')=>({id:'resource-'+sourceId,sourceId,title:'资料 '+sourceId,status}) as WorkResource
const group=(...ids:string[])=>({roleId,roleName:'测试员工',resources:ids.map(id=>resource(id))})
const status=(ids:Iterable<string>):RetrievalStatus=>({items:[...ids].map(sourceId=>({sourceId,resourceId:'resource-'+sourceId,title:'资料 '+sourceId,version:1,state:'stale',chunkCount:null})),enrolled:[...ids].length,chunks:0,building:false})
function fixture(){
 const enrolled=new Set<string>(),calls:string[]=[]
 const api={modelStatus:async()=>model,status:async()=>status(enrolled),enroll:async(sourceId:string)=>{calls.push(sourceId);enrolled.add(sourceId);return status(enrolled)}}
 return {api,enrolled,calls}
}
function journal(identity='owner/space'){
 let raw:string|null=null
 const store:RetrievalBatchJournal={identity,read:()=>raw,write:value=>{raw=value}}
 return {store,raw:()=>raw,replace:(value:string|null)=>{raw=value}}
}
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done});return {promise,resolve}}
const rows=(controller:ReturnType<typeof createEmployeeRetrievalBatch>)=>controller.getSnapshot().items.map(row=>[row.sourceId,row.state])

test('部分明确拒绝逐项显示，成功项保留，失败项目不自动重试',async()=>{
 const f=fixture(),j=journal()
 const api=createLocalRetrievalApi(async(endpoint,payload)=>{
  if(endpoint==='retrieval-model/status')return unwrapWorkRpcResult({ok:true,value:model})
  if(endpoint==='retrieval/status')return unwrapWorkRpcResult({ok:true,value:status(f.enrolled)})
  const id=(payload as {sourceIds:string[]}).sourceIds[0]!
  if(id==='B'){f.calls.push(id);return unwrapWorkRpcResult({ok:true,value:{enrollment:{outcome:'not-committed',sourceIds:[id],errorCode:'teloa/not-found'}}})}
  return unwrapWorkRpcResult({ok:true,value:{...await f.api.enroll(id),enrollment:{outcome:'committed',sourceIds:[id]}}})
 })
 const batch=createEmployeeRetrievalBatch(api,j.store)
 await batch.start(group('A','B','C'))
 assert.deepEqual(f.calls,['A','B','C']);assert.deepEqual(rows(batch),[['A','added'],['B','failed'],['C','added']])
 assert.deepEqual([...f.enrolled],['A','C']);assert.equal(batch.getSnapshot().running,false)
 assert.equal(JSON.parse(j.raw()!).roleId,roleId)
})

test('取消只停止未开始项，等待原在途回包，不回滚成功项',async()=>{
 const f=fixture(),entered=deferred<void>(),reply=deferred<RetrievalStatus>(),ordinary=f.api.enroll
 f.api.enroll=async id=>{if(id!=='B')return ordinary(id);f.calls.push(id);entered.resolve();return reply.promise}
 const batch=createEmployeeRetrievalBatch(f.api),pending=batch.start(group('A','B','C'))
 await entered.promise;batch.cancel()
 assert.deepEqual(rows(batch),[['A','added'],['B','sending'],['C','cancelled']]);assert.equal(batch.getSnapshot().running,true)
 reply.resolve(status(['A','B']));await pending
 assert.deepEqual(rows(batch),[['A','added'],['B','added'],['C','cancelled']]);assert.deepEqual(f.calls,['A','B'])
 assert.equal(batch.getSnapshot().running,false);assert.equal(batch.getSnapshot().cancelRequested,true)
})

test('普通拒绝码和自贴无副作用flag仍按未知处理；缺项不解锁，正向登记只读恢复',async()=>{
 const f=fixture(),ordinary=f.api.enroll
 f.api.enroll=async id=>{if(id==='B'){f.calls.push(id);throw {code:'teloa/forbidden',rejected:true,noSideEffect:true}}return ordinary(id)}
 const batch=createEmployeeRetrievalBatch(f.api)
 await batch.start(group('A','B','C'));assert.deepEqual(rows(batch),[['A','added'],['B','unknown'],['C','unattempted']])
 await batch.start(group('A','B','C'));await batch.review()
 assert.equal(batch.blocked(),true);assert.deepEqual(f.calls,['A','B']);assert.equal(batch.getSnapshot().items[1]!.state,'unknown')
 f.enrolled.add('B');await batch.review()
 assert.deepEqual(rows(batch),[['A','added'],['B','present'],['C','unattempted']]);assert.equal(batch.blocked(),false);assert.deepEqual(f.calls,['A','B']);assert.equal(batch.getSnapshot().items[1]!.error,undefined)
 // 只有用户明确再发起，才处理剩余项；成功或已登记来源不再发送。
 await batch.start(group('A','B','C'));assert.deepEqual(f.calls,['A','B','C']);assert.deepEqual(rows(batch),[['A','present'],['B','present'],['C','added']]);assert.equal(batch.getSnapshot().items[1]!.error,undefined)
})

test('新批次清除前次检查错误和逐项旧错误，恢复记录也不保留旧错误',async()=>{
 const f=fixture(),j=journal();let first=true
 f.api.modelStatus=async()=>{if(first){first=false;throw {code:'teloa/dependency-unavailable'}}return model}
 const batch=createEmployeeRetrievalBatch(f.api,j.store)
 await batch.start(group('A'));const priorId=batch.getSnapshot().batchId
 assert.ok(batch.getSnapshot().error);assert.deepEqual(rows(batch),[['A','unattempted']]);assert.deepEqual(f.calls,[])
 await batch.start(group('A'))
 assert.equal(batch.getSnapshot().error,undefined);assert.notEqual(batch.getSnapshot().batchId,priorId);assert.equal(batch.getSnapshot().items[0]!.error,undefined)
 assert.equal(JSON.parse(j.raw()!).errorCode,undefined);assert.deepEqual(f.calls,['A'])
})

test('刷新保留原批次、员工及来源；sending变未知，未发项变未处理，不自动恢复执行',async()=>{
 const f=fixture(),j=journal(),entered=deferred<void>(),reply=deferred<RetrievalStatus>(),ordinary=f.api.enroll
 f.api.enroll=async id=>{if(id!=='B')return ordinary(id);f.calls.push(id);entered.resolve();return reply.promise}
 const original=createEmployeeRetrievalBatch(f.api,j.store),pending=original.start(group('A','B','C'))
 await entered.promise
 const id=original.getSnapshot().batchId,restored=createEmployeeRetrievalBatch(f.api,j.store)
 assert.equal(restored.getSnapshot().batchId,id);assert.equal(restored.getSnapshot().roleId,roleId);assert.equal(restored.getSnapshot().restored,true)
 assert.equal(restored.getSnapshot().running,false);assert.deepEqual(rows(restored),[['A','added'],['B','unknown'],['C','unattempted']])
 assert.deepEqual(f.calls,['A','B']);await restored.start(group('D'));assert.deepEqual(f.calls,['A','B'])
 await restored.review();assert.equal(restored.getSnapshot().items[1]!.state,'unknown');assert.deepEqual(f.calls,['A','B'])
 original.cancel();f.enrolled.add('B');reply.resolve(status(f.enrolled));await pending
 await restored.review();assert.equal(restored.getSnapshot().items[1]!.state,'present');assert.deepEqual(f.calls,['A','B'])
 assert.equal(JSON.parse(j.raw()!).batchId,id)
})

test('取消状态刷新后保留：在途仍未知，取消项不复活',async()=>{
 const f=fixture(),j=journal(),entered=deferred<void>(),reply=deferred<RetrievalStatus>()
 f.api.enroll=async id=>{f.calls.push(id);entered.resolve();return reply.promise}
 const original=createEmployeeRetrievalBatch(f.api,j.store),pending=original.start(group('A','B'))
 await entered.promise;original.cancel()
 const restored=createEmployeeRetrievalBatch(f.api,j.store)
 assert.deepEqual(rows(restored),[['A','unknown'],['B','cancelled']]);assert.equal(restored.getSnapshot().cancelRequested,true)
 reply.resolve(status(['A']));await pending;assert.deepEqual(f.calls,['A'])
})

test('恢复记录身份不符、格式损坏或无法读取时阻断，不覆盖原记录、不发送',async()=>{
 const f=fixture(),j=journal(),first=createEmployeeRetrievalBatch(f.api,j.store)
 await first.start(group('A'));const saved=j.raw()!,calls=f.calls.slice()
 for(const raw of [saved.replace('owner/space','other/space'),'{broken',saved.replace('"state":"added"','"state":"invented"')]){
  j.replace(raw);const blocked=createEmployeeRetrievalBatch(f.api,j.store)
  assert.equal(blocked.blocked(),true);assert.equal(blocked.getSnapshot().storageBlocked,true);assert.deepEqual(blocked.getSnapshot().items,[])
  await blocked.start(group('B'));await blocked.review();assert.deepEqual(f.calls,calls);assert.equal(j.raw(),raw)
 }
 const unreadable=createEmployeeRetrievalBatch(f.api,{identity:'owner/space',read:()=>{throw Error('storage blocked')},write:()=>assert.fail('must not overwrite')})
 await unreadable.start(group('C'));assert.equal(unreadable.blocked(),true);assert.deepEqual(f.calls,calls)
})

test('已存在空字符串在初始化与首次写入前均视为损坏，0保存/0模型检查/0加入',async()=>{
 for(const truncateAfterCreate of [false,true]){
  const f=fixture(),j=journal();let writes=0,checks=0
  f.api.modelStatus=async()=>{checks++;return model}
  const write=j.store.write;j.store.write=raw=>{writes++;write(raw)}
  if(!truncateAfterCreate)j.replace('')
  const batch=createEmployeeRetrievalBatch(f.api,j.store)
  if(truncateAfterCreate)j.replace('')
  await batch.start(group('A'));await batch.review()
  assert.equal(batch.getSnapshot().storageBlocked,true);assert.equal(batch.blocked(),true)
  assert.equal(j.raw(),'');assert.equal(writes,0);assert.equal(checks,0);assert.deepEqual(f.calls,[])
 }
})

test('保存原身份失败时不做模型检查或加入；保存sending失败时也不发送该项目',async()=>{
 for(const failAt of ['initial','sending'] as const){
  const f=fixture(),j=journal();let checks=0,blocked=false
  f.api.modelStatus=async()=>{checks++;return model}
  const write=j.store.write
  j.store.write=raw=>{if(blocked||failAt==='initial'||JSON.parse(raw).items.some((row:{state:string})=>row.state==='sending')){blocked=true;throw Error('quota')}write(raw)}
  const batch=createEmployeeRetrievalBatch(f.api,j.store);await batch.start(group('A','B'))
  assert.deepEqual(f.calls,[]);assert.equal(checks,failAt==='initial'?0:1);assert.equal(batch.getSnapshot().storageBlocked,true)
  assert.deepEqual(rows(batch),[['A','unattempted'],['B','unattempted']]);assert.equal(batch.blocked(),true)
 }
})

test('已收成功回包但保存失败：保留内存成功，停止后续，刷新按原sending未知恢复',async()=>{
 const f=fixture(),j=journal(),write=j.store.write
 j.store.write=raw=>{if(JSON.parse(raw).items.some((row:{state:string})=>row.state==='added'))throw Error('quota');write(raw)}
 const batch=createEmployeeRetrievalBatch(f.api,j.store);await batch.start(group('A','B'))
 assert.deepEqual(rows(batch),[['A','added'],['B','unattempted']]);assert.deepEqual(f.calls,['A']);assert.equal(batch.blocked(),true)
 j.store.write=write
 const restored=createEmployeeRetrievalBatch(f.api,j.store)
 assert.deepEqual(rows(restored),[['A','unknown'],['B','unattempted']]);await restored.review()
 assert.deepEqual(rows(restored),[['A','present'],['B','unattempted']]);assert.deepEqual(f.calls,['A'])
})

test('同来源去重并保留标题，不可用项逐项可见；已登记来源不发送',async()=>{
 const f=fixture();f.enrolled.add('A')
 const batch=createEmployeeRetrievalBatch(f.api)
 await batch.start({...group('A','B'),resources:[resource('A'),resource('B'),{...resource('B'),title:'同源另一版'},resource('C','withdrawn')]})
 assert.deepEqual(rows(batch),[['A','present'],['B','added'],['C','unavailable']]);assert.deepEqual(f.calls,['B']);assert.match(batch.getSnapshot().items[1]!.title,/同源另一版/)
})

test('归属在检查期间变化时不发请求，也不自动接续',async()=>{
 const f=fixture(),ready=deferred<RetrievalModelStatus>();let current=true
 f.api.modelStatus=()=>ready.promise
 const batch=createEmployeeRetrievalBatch(f.api),pending=batch.start(group('A','B'),()=>current)
 current=false;ready.resolve(model);await pending
 assert.deepEqual(f.calls,[]);assert.deepEqual(rows(batch),[['A','cancelled'],['B','cancelled']])
})

test('另一页写入新批次后，旧控制器不覆盖其原身份或重新发送',async()=>{
 const f=fixture(),j=journal(),ready=deferred<RetrievalModelStatus>()
 const stale=createEmployeeRetrievalBatch(f.api,j.store),active=createEmployeeRetrievalBatch(f.api,j.store)
 f.api.modelStatus=()=>ready.promise
 const pending=active.start(group('A'));const saved=j.raw()!
 await stale.start(group('B'));assert.equal(stale.getSnapshot().storageBlocked,true);assert.equal(j.raw(),saved);assert.deepEqual(f.calls,[])
 ready.resolve(model);await pending;assert.deepEqual(f.calls,['A'])
})


test('IDX14 1001项以不超过500项子批持久化，保留总量且每份只发一次',async()=>{
 const f=fixture(),j=journal(),sizes:number[]=[],bytes:number[]=[]
 const write=j.store.write;j.store.write=raw=>{sizes.push(JSON.parse(raw).items.length);bytes.push(Buffer.byteLength(raw));write(raw)}
 const batch=createEmployeeRetrievalBatch(f.api,j.store)
 await batch.start(group(...Array.from({length:1001},(_,i)=>'scale_'+i)))
 assert.equal(f.calls.length,1001);assert.equal(new Set(f.calls).size,1001)
 assert.ok(Math.max(...sizes)<=500);assert.ok(Math.max(...bytes)<=1024*1024)
 const snapshot=batch.getSnapshot()
 assert.deepEqual(snapshot.progress,{total:1001,offset:1000,remaining:0,priorCounts:{added:1000}})
 assert.equal(snapshot.items.length,1);assert.equal(snapshot.items[0]!.state,'added')
 const restored=createEmployeeRetrievalBatch(f.api,j.store)
 assert.deepEqual(restored.getSnapshot().progress,snapshot.progress)
 assert.equal(restored.getSnapshot().running,false);assert.equal(f.calls.length,1001)
})

test('IDX14 跨子批的unknown刷新不重发，后续未发送保留计数且核对不自动执行',async()=>{
 const f=fixture(),j=journal(),entered=deferred<void>(),reply=deferred<RetrievalStatus>(),ordinary=f.api.enroll
 f.api.enroll=async id=>{if(id!=='scale_500')return ordinary(id);f.calls.push(id);entered.resolve();return reply.promise}
 const original=createEmployeeRetrievalBatch(f.api,j.store),pending=original.start(group(...Array.from({length:1001},(_,i)=>'scale_'+i)))
 await entered.promise
 const restored=createEmployeeRetrievalBatch(f.api,j.store)
 assert.equal(restored.getSnapshot().progress?.offset,500);assert.equal(restored.getSnapshot().progress?.remaining,1)
 assert.equal(restored.getSnapshot().items[0]!.state,'unknown')
 assert.equal(restored.getSnapshot().items[1]!.state,'unattempted')
 await restored.start(group('other'));await restored.review();assert.equal(f.calls.length,501)
 original.cancel();f.enrolled.add('scale_500');reply.resolve(status(f.enrolled));await pending
 await restored.review();assert.equal(restored.getSnapshot().items[0]!.state,'present')
 assert.equal(restored.getSnapshot().progress?.remaining,1);assert.equal(f.calls.length,501)
})


test('IDX14 子批有明确失败时保留失败来源详情，后续子批不被静默折叠',async()=>{
 const f=fixture(),j=journal()
 const api=createLocalRetrievalApi(async(endpoint,payload)=>{
  if(endpoint==='retrieval-model/status')return model
  if(endpoint==='retrieval/status')return status(f.enrolled)
  const id=(payload as {sourceIds:string[]}).sourceIds[0]!
  if(id==='scale_499'){f.calls.push(id);return {enrollment:{outcome:'not-committed',sourceIds:[id],errorCode:'teloa/forbidden'}}}
  return {...await f.api.enroll(id),enrollment:{outcome:'committed',sourceIds:[id]}}
 })
 const batch=createEmployeeRetrievalBatch(api,j.store)
 await batch.start(group(...Array.from({length:1001},(_,i)=>'scale_'+i)))
 assert.equal(f.calls.length,500);assert.equal(batch.getSnapshot().progress?.remaining,501)
 assert.equal(batch.getSnapshot().items[499]!.sourceId,'scale_499');assert.equal(batch.getSnapshot().items[499]!.state,'failed')
 assert.equal(createEmployeeRetrievalBatch(api,j.store).getSnapshot().items[499]!.state,'failed')
})

test('IDX14 旧子批页面不能覆盖已前进的新子批；只读核对不发新请求',async()=>{
 const f=fixture(),j=journal(),at499=deferred<void>(),reply499=deferred<RetrievalStatus>(),at500=deferred<void>(),reply500=deferred<RetrievalStatus>(),ordinary=f.api.enroll
 f.api.enroll=async id=>{if(id==='scale_499'){f.calls.push(id);at499.resolve();return reply499.promise}if(id==='scale_500'){f.calls.push(id);at500.resolve();return reply500.promise}return ordinary(id)}
 const current=createEmployeeRetrievalBatch(f.api,j.store),pending=current.start(group(...Array.from({length:1001},(_,i)=>'scale_'+i)))
 await at499.promise;const stale=createEmployeeRetrievalBatch(f.api,j.store)
 f.enrolled.add('scale_499');reply499.resolve(status(f.enrolled));await at500.promise
 const raw=j.raw();await stale.review()
 assert.equal(stale.getSnapshot().storageBlocked,true);assert.equal(j.raw(),raw);assert.equal(f.calls.length,501)
 current.cancel();f.enrolled.add('scale_500');reply500.resolve(status(f.enrolled));await pending
})

test('IDX14 子批恢复拒绝伪造总量、跨批offset和超500项；UTF8记录仍限1MiB',async()=>{
 const f=fixture(),j=journal(),batch=createEmployeeRetrievalBatch(f.api,j.store)
 await batch.start(group(...Array.from({length:501},(_,i)=>'scale_'+i)))
 const valid=j.raw()!,baseline=f.calls.length
 for(const change of [(v:any)=>{v.progress.total++},(v:any)=>{v.progress.offset++},(v:any)=>{delete v.progress},(v:any)=>{v.progress.priorCounts={sending:500}},(v:any)=>{v.items=Array.from({length:501},(_,i)=>({...v.items[0],sourceId:'bad_'+i}));v.progress.total=v.progress.offset+501;v.progress.remaining=0}]){
  const v=JSON.parse(valid);change(v);j.replace(JSON.stringify(v));const bad=createEmployeeRetrievalBatch(f.api,j.store)
  assert.equal(bad.blocked(),true);await bad.start(group('new'));assert.equal(f.calls.length,baseline)
 }
 const bytes=journal(),big=group('oversized');big.resources[0]!.title='中'.repeat(400000)
 const blocked=createEmployeeRetrievalBatch(f.api,bytes.store);await blocked.start(big)
 assert.equal(blocked.getSnapshot().storageBlocked,true);assert.equal(bytes.raw(),null);assert.equal(f.calls.length,baseline)
})

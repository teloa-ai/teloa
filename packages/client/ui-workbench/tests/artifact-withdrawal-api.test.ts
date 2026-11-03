import test from 'node:test'
import assert from 'node:assert/strict'
import {createArtifactApi} from '../src/client/artifact-api.ts'

const id='11111111-1111-4111-8111-111111111111',taskId='22222222-2222-4222-8222-222222222222'
const source={kind:'task' as const,id:taskId,scope:'general',version:'saved-task-v6',title:'已完成的原工作'}
const rows=[1,2].map(number=>({artifactId:id,ownerId:'owner',number,source:{...source,version:number===1?'saved-task-v4':source.version},content:{title:'交付文件',sections:[{id:'body',title:'正文',text:'保留原件与历史'}],snapshotIds:[],note:'保存版本'},createdAt:'2026-10-29T00:00:00.000Z'}))
const at='2026-10-29T01:00:00.000Z'
const journal=()=>{
 let record:string|null=null
 return {read:()=>record,write:(value:string)=>{record=value},clear:()=>{record=null}}
}

test('整对象撤回固定最新已保存版本的来源，不从已完成Task重新取来源',async()=>{
 const storage=journal(),writes:any[]=[]
 const api=createArtifactApi(async(method,payload:any)=>{
  if(method==='artifacts/versions')return structuredClone(rows)
  if(method==='artifacts/withdraw'){
   assert.ok(storage.read(),'本机原请求必须先持久化再发送')
   writes.push(structuredClone(payload));return {...payload,withdrawnAt:at}
  }
  throw Error('不得另取当前来源或更改内容：'+method)
 },storage)
 const receipt=await api.withdraw(id)
 assert.equal(writes.length,1)
 assert.deepEqual({...writes[0],requestId:'fixed'}, {requestId:'fixed',artifactId:id,expectedVersion:2,source})
 assert.deepEqual(receipt,{...writes[0],withdrawnAt:at})
 assert.equal(storage.read(),null)
})

test('撤回丢回包后重建API仍恢复原nonce与来源，后台出现新head也不漂移',async()=>{
 const storage=journal(),writes:any[]=[];let first=true,headReads=0
 const call=async(method:string,payload:any)=>{
  if(method==='artifacts/versions'){headReads++;assert.equal(headReads,1,'恢复原请求不重新读取并改造head');return structuredClone(rows)}
  if(method==='artifacts/withdraw'){writes.push(structuredClone(payload));if(first){first=false;throw Error('原回包丢失')}return {...payload,withdrawnAt:at}}
  throw Error(method)
 }
 const api=createArtifactApi(call,storage)
 await assert.rejects(api.withdraw(id),/原回包丢失/)
 assert.equal(api.withdrawalPending(id),true)
 const restored=createArtifactApi(call,storage)
 assert.equal(restored.withdrawalPending(id),true)
 const receipt=await restored.recoverWithdrawal(id)
 assert.equal(receipt.withdrawnAt,at)
 assert.deepEqual(writes[1],writes[0])
 assert.equal(headReads,1)
 assert.equal(storage.read(),null)
 assert.equal(restored.withdrawalPending(id),false)
})

test('存储失败阻止撤回发送；损坏恢复日志同样不能开始另一个请求',async()=>{
 let writes=0
 const call=async(method:string,payload:any)=>{if(method==='artifacts/versions')return structuredClone(rows);if(method==='artifacts/withdraw'){writes++;return {...payload,withdrawnAt:at}}throw Error(method)}
 const api=createArtifactApi(call,{read:()=>null,write:()=>{throw Error('日志不可写')}})
 await assert.rejects(api.withdraw(id),/日志不可写/)
 assert.equal(writes,0)
 const corrupt=createArtifactApi(call,{read:()=>'{broken',write:()=>{throw Error('不应写入')}})
 await assert.rejects(corrupt.withdraw(id),error=>(error as {code?:string}).code==='teloa/storage-corrupt')
 assert.equal(writes,0)
})

test('撤回回执身份不一致时保留原请求，显式核对使用同一payload',async()=>{
 const storage=journal(),writes:any[]=[];let mismatch=true
 const api=createArtifactApi(async(method,payload:any)=>{
  if(method==='artifacts/versions')return structuredClone(rows)
  if(method==='artifacts/withdraw'){writes.push(structuredClone(payload));return {...payload,source:{...payload.source,title:mismatch?'错误来源':payload.source.title},withdrawnAt:at}}
  throw Error(method)
 },storage)
 await assert.rejects(api.withdraw(id),/不一致/)
 assert.equal(api.withdrawalPending(id),true)
 mismatch=false
 await api.recoverWithdrawal(id)
 assert.deepEqual(writes[0],writes[1])
 assert.equal(storage.read(),null)
})

test('确定性拒绝清除该撤回原请求，不自动换nonce再发',async()=>{
 const storage=journal();let writes=0
 const api=createArtifactApi(async(method)=>{
  if(method==='artifacts/versions')return structuredClone(rows)
  if(method==='artifacts/withdraw'){writes++;throw Object.assign(Error('成果版本已变化'),{rejected:true,code:'teloa/version-conflict'})}
  throw Error(method)
 },storage)
 await assert.rejects(api.withdraw(id),/版本已变化/)
 assert.equal(writes,1)
 assert.equal(api.withdrawalPending(id),false)
 assert.equal(storage.read(),null)
})

test('撤回状态必须属于指定对象，正常状态和已撤回状态均严格读取',async()=>{
 let state:any={artifactId:id,state:'available',withdrawal:null}
 const api=createArtifactApi(async(method,payload:any)=>{assert.equal(method,'artifacts/availability');assert.deepEqual(payload,{artifactId:id});return state})
 assert.deepEqual(await api.availability(id),state)
 state={artifactId:id,state:'withdrawn',withdrawal:{requestId:'33333333-3333-4333-8333-333333333333',artifactId:id,expectedVersion:2,source,withdrawnAt:at}}
 assert.deepEqual(await api.availability(id),state)
 state={artifactId:taskId,state:'available',withdrawal:null}
 await assert.rejects(api.availability(id),/不一致/)
})

test('两个API共享日志，迟到A只完成自身请求，未知B刷新后仍恢复原nonce',async()=>{
 const storage=journal(),otherId='33333333-3333-4333-8333-333333333333',writes:any[]=[]
 let releaseA!:(value:unknown)=>void,startedA!:()=>void
 const aStarted=new Promise<void>(resolve=>startedA=resolve)
 const call=async(method:string,payload:any)=>{
  if(method==='artifacts/versions')return rows.map(row=>({...row,artifactId:payload.artifactId}))
  if(method==='artifacts/withdraw'){
   writes.push(structuredClone(payload))
   if(payload.artifactId===id){startedA();return new Promise(resolve=>releaseA=resolve)}
   throw Error('B回包未知')
  }
  throw Error(method)
 }
 // 两标签都在任何请求发生前创建，防止旧Map写入覆盖别人已经持久化的请求。
 const a=createArtifactApi(call,storage),b=createArtifactApi(call,storage)
 const first=a.withdraw(id);await aStarted
 await assert.rejects(b.withdraw(otherId),/B回包未知/)
 const before=JSON.parse(storage.read()!).requests
 assert.equal(before.length,2,'B持久化不能丢掉A')
 releaseA({...writes[0],withdrawnAt:at});await first
 const remaining=JSON.parse(storage.read()!).requests
 assert.equal(remaining.length,1);assert.equal(remaining[0].key,'withdraw:'+otherId)
 const restored=createArtifactApi(async(method,payload:any)=>{assert.equal(method,'artifacts/withdraw');assert.deepEqual(payload,writes[1]);return {...payload,withdrawnAt:at}},storage)
 await restored.recoverWithdrawal(otherId);assert.equal(storage.read(),null)
})

test('读取后共享日志变损坏，撤回不能覆盖其他未决现场或调用RPC',async()=>{
 const storage=journal();let writes=0
 const api=createArtifactApi(async(method,payload:any)=>{if(method==='artifacts/versions')return structuredClone(rows);writes++;return {...payload,withdrawnAt:at}},storage)
 storage.write('{broken-by-other-tab')
 await assert.rejects(api.withdraw(id))
 assert.equal(writes,0);assert.equal(storage.read(),'{broken-by-other-tab')
})

test('同对象另一标签已持久化原请求，旧API拒新nonce并转为明确核对原请求',async()=>{
 const storage=journal();let release!:(value:unknown)=>void,started!:()=>void,accepted:any
 const ready=new Promise<void>(resolve=>started=resolve)
 const a=createArtifactApi(async(method,payload:any)=>{if(method==='artifacts/versions')return structuredClone(rows);accepted=payload;started();return new Promise(resolve=>release=resolve)},storage)
 let bWrites=0;const b=createArtifactApi(async(method,payload:any)=>{if(method==='artifacts/versions')return structuredClone(rows);bWrites++;assert.deepEqual(payload,accepted);return {...payload,withdrawnAt:at}},storage)
 const pending=a.withdraw(id);await ready
 try{
  await assert.rejects(b.withdraw(id))
  assert.equal(bWrites,0,'第二个新意图未发送')
  assert.equal(b.withdrawalPending(id),true)
  await b.recoverWithdrawal(id)
  assert.equal(bWrites,1,'核对沿用共享原nonce')
 }finally{release({...accepted,withdrawnAt:at});await pending}
 assert.equal(storage.read(),null)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import {WorkError,readRetrievalEnrollmentReceipt,type WorkResource} from '@teloa/contract'
import {RetrievalIndexService} from '../../backend/src/capabilities/retrieval-index.ts'
import type {ResourceService} from '../../backend/src/capabilities/resources.ts'
import {retrievalEnrollmentResponse} from '../src/retrieval-enrollment-response.ts'
import {createLocalRetrievalApi,retrievalEnrollmentOutcome,type RetrievalModelStatus,type RetrievalStatus} from '../../client/ui-workbench/src/client/local-retrieval-api.ts'
import {unwrapWorkRpcResult} from '../../client/ui-workbench/src/client/work-rpc-result.ts'
import {createEmployeeRetrievalBatch} from '../../client/ui-workbench/src/client/employee-retrieval-batch.ts'

// 正常生产 service→handler helper→JSON RPC envelope→client adapter→controller。
// SQL 端口受控，不启动 PG/宿主/浏览器/模型；这些结果不冒充真实事务或 installed 验收。
const actor={ownerId:'test-owner',kind:'human' as const,scopeIds:['general']}
const model:RetrievalModelStatus={enabled:true,provider:{id:'local',location:'host-local',catalogId:'test',catalogVersion:'1',profileHash:'a'.repeat(64),variant:'fp32',totalMemoryBytes:1,memoryRisk:false,preparation:{phase:'ready'}},building:false,guidance:null}
const group={roleId:'11111111-1111-4111-8111-111111111111',roleName:'测试员工',resources:['A','B','C'].map(sourceId=>({id:'resource-'+sourceId,sourceId,title:'资料 '+sourceId,status:'active'} as WorkResource))}
type Faults={inactive?:Set<string>;lostCommitAck?:{sourceId:string;applied:boolean};rollbackFailure?:boolean;statusFailure?:string;releaseFailure?:string;connectFailure?:boolean}
function system(faults:Faults={}){
 const enrolled=new Set<string>(),calls:string[]=[],sql:{sourceId:string;query:string}[]=[],responses:Record<string,unknown>[]=[],inactive=faults.inactive??new Set<string>()
 let currentSource='',builds=0
 const pool={connect:async()=>{
  if(faults.connectFailure)throw Error('connection failed')
  const sourceId=currentSource;let staged:string[]=[]
  return {
   query:async(query:string,values:unknown[]=[])=>{
    sql.push({sourceId,query})
    if(query.includes('from teloa_resources'))return {rows:(values[1] as string[]).filter(id=>!inactive.has(id)).map(id=>({source_id:id,scope_ids:['general']}))}
    if(query.startsWith('select source_id from teloa_retrieval_enrollments'))return {rows:[...enrolled].map(id=>({source_id:id}))}
    if(query.startsWith('insert into teloa_retrieval_enrollments'))staged=[...values[1] as string[]]
    if(query==='commit'){
     if(faults.lostCommitAck?.sourceId===sourceId){if(faults.lostCommitAck.applied)for(const id of staged)enrolled.add(id);throw Error('commit acknowledgement lost')}
     for(const id of staged)enrolled.add(id)
    }
    if(query==='rollback'){if(faults.rollbackFailure)throw Error('rollback acknowledgement lost');staged=[]}
    return {rows:[]}
   },
   release(){if(faults.releaseFailure===sourceId)throw Error('release failed after commit')},
  }
 }}
 const service=new RetrievalIndexService(pool as unknown as ConstructorParameters<typeof RetrievalIndexService>[0],{} as ResourceService,{id:()=>crypto.randomUUID(),now:()=>new Date().toISOString()})
 const status=():RetrievalStatus=>({items:[...enrolled].map(sourceId=>({sourceId,resourceId:'resource-'+sourceId,title:'资料 '+sourceId,version:1,state:'stale',chunkCount:null})),enrolled:enrolled.size,chunks:0,building:false})
 const response=async(payload:unknown)=>{
  currentSource=(payload as {sourceIds:string[]}).sourceIds[0]!
  const value=await retrievalEnrollmentResponse(payload,{
   prepare:async()=>outcome=>service.enroll(actor,payload,outcome),
   afterCommit:()=>{builds++},
   status:async()=>{if(faults.statusFailure===currentSource)throw new WorkError('teloa/storage-unavailable','状态读取失败');return status()},
  })
  // 真正跨 JSON 边界，不依赖 Error 实例、私有 flag 或原对象引用幸存。
  const wire=JSON.parse(JSON.stringify(value)) as Record<string,unknown>;responses.push(wire);return wire
 }
 const api=createLocalRetrievalApi(async(endpoint,payload)=>{
  if(endpoint==='retrieval-model/status')return unwrapWorkRpcResult({ok:true,value:model})
  if(endpoint==='retrieval/status')return unwrapWorkRpcResult({ok:true,value:status()})
  assert.equal(endpoint,'retrieval/enroll');calls.push((payload as {sourceIds:string[]}).sourceIds[0]!)
  return unwrapWorkRpcResult({ok:true,value:await response(payload)})
 })
 return {api,enrolled,calls,sql,responses,inactive,builds:()=>builds}
}

test('真实事务边界回滚拒绝经正常API成为failed，显式新批次才重试，成功项不重发',async()=>{
 const e=system({inactive:new Set(['B'])}),batch=createEmployeeRetrievalBatch(e.api)
 await batch.start(group)
 assert.deepEqual(batch.getSnapshot().items.map(row=>row.state),['added','failed','added'])
 assert.deepEqual(e.calls,['A','B','C']);assert.deepEqual([...e.enrolled],['A','C']);assert.equal(batch.blocked(),false)
 assert.deepEqual(e.sql.filter(row=>row.sourceId==='B'&&['commit','rollback'].includes(row.query)).map(row=>row.query),['rollback'])
 assert.equal(readRetrievalEnrollmentReceipt(e.responses[1]!.enrollment).outcome,'not-committed')
 e.inactive.delete('B');await batch.start(group)
 assert.deepEqual(e.calls,['A','B','C','B']);assert.deepEqual(batch.getSnapshot().items.map(row=>row.state),['present','added','present'])
})

test('COMMIT已确认但后续status失败，正常API仍保留已加入，不误解锁为失败',async()=>{
 const e=system({statusFailure:'A'}),batch=createEmployeeRetrievalBatch(e.api)
 await batch.start(group)
 assert.deepEqual(e.calls,['A','B','C']);assert.deepEqual(batch.getSnapshot().items.map(row=>row.state),['added','added','added'])
 assert.deepEqual(e.responses[0],{enrollment:{outcome:'committed',sourceIds:['A'],errorCode:'teloa/storage-unavailable'}})
 assert.equal(e.builds(),3)
})

test('COMMIT后release异常不抹掉已确认提交事实',async()=>{
 const e=system({releaseFailure:'A'}),batch=createEmployeeRetrievalBatch(e.api)
 await batch.start(group)
 assert.deepEqual(batch.getSnapshot().items.map(row=>row.state),['added','added','added']);assert.deepEqual(e.calls,['A','B','C'])
 assert.equal(readRetrievalEnrollmentReceipt(e.responses[0]!.enrollment).outcome,'committed')
})

test('COMMIT回包丢失即使随后rollback成功仍未知；不重发，缺项不解锁',async()=>{
 for(const applied of [false,true]){
  const e=system({lostCommitAck:{sourceId:'B',applied}}),batch=createEmployeeRetrievalBatch(e.api)
  await batch.start(group);assert.deepEqual(batch.getSnapshot().items.map(row=>row.state),['added','unknown','unattempted'])
  assert.deepEqual(e.calls,['A','B']);assert.equal(readRetrievalEnrollmentReceipt(e.responses[1]!.enrollment).outcome,'unknown')
  assert.deepEqual(e.sql.filter(row=>row.sourceId==='B'&&['commit','rollback'].includes(row.query)).map(row=>row.query),['commit','rollback'])
  await batch.start(group);assert.deepEqual(e.calls,['A','B']);await batch.review();assert.deepEqual(e.calls,['A','B'])
  assert.equal(batch.getSnapshot().items[1]!.state,applied?'present':'unknown');assert.equal(batch.blocked(),!applied)
  assert.equal(batch.getSnapshot().items[2]!.state,'unattempted')
 }
})

test('提交前拒绝但rollback确认失败时仍未知，不按not-found猜测未提交',async()=>{
 const e=system({inactive:new Set(['B']),rollbackFailure:true}),batch=createEmployeeRetrievalBatch(e.api)
 await batch.start(group);await batch.review()
 assert.deepEqual(batch.getSnapshot().items.map(row=>row.state),['added','unknown','unattempted']);assert.deepEqual(e.calls,['A','B'])
 assert.equal(readRetrievalEnrollmentReceipt(e.responses[1]!.enrollment).outcome,'unknown');assert.equal(batch.blocked(),true)
})

test('连接尚未建立的明确拒绝可重试，不触发事务或后台整理',async()=>{
 const e=system({connectFailure:true}),batch=createEmployeeRetrievalBatch(e.api)
 await batch.start(group)
 assert.deepEqual(batch.getSnapshot().items.map(row=>row.state),['failed','failed','failed']);assert.deepEqual(e.sql,[]);assert.equal(e.builds(),0)
})

test('回执来源不符、缺错误码或多余字段不能变成可信可重试失败',async()=>{
 for(const enrollment of [
  {outcome:'not-committed',sourceIds:['B'],errorCode:'teloa/not-found'},
  {outcome:'not-committed',sourceIds:['A']},
  {outcome:'not-committed',sourceIds:['A'],errorCode:'teloa/not-found',noSideEffect:true},
  {outcome:['not-committed'],sourceIds:['A'],errorCode:'teloa/not-found'},
 ]){
  const api=createLocalRetrievalApi(async()=>({enrollment}))
  await assert.rejects(api.enroll('A'),error=>{assert.equal(retrievalEnrollmentOutcome(error),undefined);return true})
 }
})

test('通用RPC错误和自贴flag不能伪造提交前拒绝',async()=>{
 const api=createLocalRetrievalApi(async()=>unwrapWorkRpcResult({ok:false,error:{code:'teloa/not-found',message:'资料拒绝'}}))
 await assert.rejects(api.enroll('A'),error=>{assert.equal(retrievalEnrollmentOutcome(error),undefined);return true})
 assert.equal(retrievalEnrollmentOutcome({code:'teloa/not-found',rejected:true,noSideEffect:true}),undefined)
})

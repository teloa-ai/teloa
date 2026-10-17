import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {WorkError} from '@teloa/contract'
import {createProjectMemoryVerifiedAdapter} from '../src/project-memory-verified-adapter.ts'

function fixture(code:string,failures:number){
 const owner=randomUUID(),sourceId='project-completion:'+randomUUID(),state={connects:0,reads:0,rollbacks:0,releases:0}
 const client={async query(sql:string){
  if(sql==='rollback')state.rollbacks++
  if(sql.startsWith('select * from teloa_task_transitions')){state.reads++;if(state.reads<=failures)throw Object.assign(new Error('controlled concurrency failure'),{code})}
  return {rows:[]}
 },release(){state.releases++}}
 const adapter=createProjectMemoryVerifiedAdapter({owner,pool:{async connect(){state.connects++;return client}} as never,runs:async()=>({}) as never,inspect:async()=>{throw Error('empty receipt does not need actor')}})
 return {owner,sourceId,state,client,adapter}
}
test('核验自有事务仅重试一次序列化/死锁冲突，第二次成功不丢回执读取',async()=>{
 for(const code of ['40001','40P01']){
  const f=fixture(code,1)
  assert.equal(await f.adapter.loadVerifiedEvidence(f.owner,f.sourceId),null)
  assert.deepEqual(f.state,{connects:2,reads:2,rollbacks:1,releases:2})
 }
})
test('核验冲突耗尽映射可重试WorkError，调用者已有事务不自行重开或重试',async()=>{
 const retryable=(error:unknown)=>error instanceof WorkError&&error.code==='teloa/dependency-unavailable'&&error.details?.retryable===true
 for(const code of ['40001','40P01']){
  const f=fixture(code,3)
  await assert.rejects(f.adapter.loadVerifiedEvidence(f.owner,f.sourceId),retryable)
  assert.deepEqual(f.state,{connects:2,reads:2,rollbacks:2,releases:2})
  const caller=fixture(code,3)
  await assert.rejects(caller.adapter.loadVerifiedEvidence(caller.owner,caller.sourceId,caller.client as never),retryable)
  assert.deepEqual(caller.state,{connects:0,reads:1,rollbacks:0,releases:0})
 }
})

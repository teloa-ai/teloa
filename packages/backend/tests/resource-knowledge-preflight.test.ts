import test from 'node:test'
import assert from 'node:assert/strict'
import type {Pool} from 'pg'
import {ResourceService,type ResourceActor,type ResourceSourceCatalog} from '../src/capabilities/resources.ts'

test('岗位资料非法主体、身份或预取消在借用连接前拒绝',async()=>{
  let checkouts=0
  const pool={connect:async()=>{checkouts++;throw Error('database unavailable')}} as unknown as Pool
  const sources={} as ResourceSourceCatalog
  const service=new ResourceService(pool,sources,{id:()=>'',now:()=>''})
  const actor:ResourceActor={ownerId:'owner',kind:'agent',scopeIds:['general']}
  await assert.rejects(service.executionKnowledge({...actor,scopeIds:['invalid scope']},['general'],[]),{code:'teloa/forbidden'})
  await assert.rejects(service.executionKnowledgeReferences(actor,['general'],['invalid-id']),{code:'teloa/invalid-input'})
  const canceled=new AbortController();canceled.abort()
  await assert.rejects(service.executionKnowledge(actor,['general'],[],canceled.signal),{name:'AbortError'})
  assert.equal(checkouts,0)
})

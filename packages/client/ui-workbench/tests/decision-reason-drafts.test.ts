
import assert from 'node:assert/strict'
import test from 'node:test'
import {readDecisionReason,writeDecisionReason} from '../src/client/decision-reason-drafts.ts'
test('审核意见可跨挂载读取，版本与本人隔离，清空不残留',()=>{
 const key=JSON.stringify(['owner-a','request-a',1])
 writeDecisionReason(key,'核对过本次文档')
 assert.equal(readDecisionReason(key),'核对过本次文档')
 assert.equal(readDecisionReason(JSON.stringify(['owner-a','request-a',2])),'')
 assert.equal(readDecisionReason(JSON.stringify(['owner-b','request-a',1])),'')
 writeDecisionReason(key,'')
 assert.equal(readDecisionReason(key),'')
})

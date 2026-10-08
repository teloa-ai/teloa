import test from 'node:test'
import assert from 'node:assert/strict'

test('本轮完成策略默认人工，未知验证器或版本及伪候选字段拒绝',async()=>{
 const api=await import('../src/task-completion.ts').catch(()=>null)
 assert.ok(api,'缺少明确的本轮完成策略契约')
 assert.deepEqual(api.readTaskCompletionPolicy(undefined),{kind:'manual'})
 assert.deepEqual(api.readTaskCompletionPolicy({kind:'verified',verifier:'system-digest',verifierVersion:1,authorizationVersion:1}),{kind:'verified',verifier:'system-digest',verifierVersion:1,authorizationVersion:1})
 for(const value of [{kind:'verified',verifier:'file-exists',verifierVersion:1,authorizationVersion:1},{kind:'verified',verifier:'system-digest',verifierVersion:0,authorizationVersion:1},{kind:'manual',verified:true}])assert.throws(()=>api.readTaskCompletionPolicy(value))
 assert.throws(()=>api.readCompletionCandidate({runId:'11111111-1111-4111-8111-111111111111',terminalEventSeq:3,artifactIds:[],receiptIds:[],completed:true}))
})

import {randomUUID} from 'node:crypto'
import test from 'node:test'
import assert from 'node:assert/strict'
import {unpublishedFollowupFixture} from './fixtures/source-followup-unpublished.ts'
import {sourceFollowupCandidate} from '../src/work/task-run-source-followups.ts'

test('仅typed未发布取消来源可显式新请求续办，原withdrawn及来源锚不改',async()=>{
 const f=unpublishedFollowupFixture(),before=structuredClone({run:f.run,receipt:f.receipt,update:f.update})
 const candidate=await sourceFollowupCandidate(f.db,f.owner,f.run,6)
 assert.equal(candidate.kind,'error-recovery');assert.equal(candidate.runId,f.run.id);assert.equal(candidate.sessionId,f.run.sessionId);assert.equal(candidate.sourceUpdateId,f.update.id)
 assert.deepEqual({run:f.run,receipt:f.receipt,update:f.update},before)
})

test('取消证明不完整、published/unknown、后果或源版本漂移均拒绝',async()=>{
 for(const change of ['receipt','input','published','unknown','effect','unknown-budget','new-source','ordinary-stop'] as const){
  const f=unpublishedFollowupFixture()
  if(change==='receipt')f.mutations.receipt=false
  if(change==='input')f.run.inputText+=' '
  if(change==='published')f.attempt.state='accepted'
  if(change==='unknown')f.attempt.state='dispatching'
  if(change==='effect')f.mutations.effect=true
  if(change==='unknown-budget'){f.mutations.unknownBudget=true;f.run.lineage={budgetAccountId:randomUUID()} as never}
  if(change==='new-source')f.mutations.sourceVersion=3
  if(change==='ordinary-stop')f.run.state='ended'
  await assert.rejects(sourceFollowupCandidate(f.db,f.owner,f.run,6),{code:'teloa/conflict'},change)
 }
})

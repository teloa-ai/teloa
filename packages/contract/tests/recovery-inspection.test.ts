import test from 'node:test'
import assert from 'node:assert/strict'
import {readRecoveryCandidate,readRecoveryInspection} from '../src/work-control.ts'

const candidate={controlId:'00000000-0000-4000-8000-000000000001',expectedGeneration:2,runId:'00000000-0000-4000-8000-000000000002',nativeRequestId:'00000000-0000-4000-8000-000000000003',goal:null,reason:'accepted',safeRecovery:false}

test('恢复检查回包带服务端可恢复判定；持久候选形状不变，旧回包不带判定时按未知读取',()=>{
 assert.deepEqual(readRecoveryInspection({...candidate,resumable:false}),{...candidate,resumable:false})
 assert.deepEqual(readRecoveryInspection(candidate),candidate,'旧回包仍可读，resumable 为 undefined')
 assert.throws(()=>readRecoveryInspection({...candidate,resumable:'no'}),{code:'teloa/invalid-input'})
 assert.throws(()=>readRecoveryInspection({...candidate,resumable:true,extra:1}),{code:'teloa/invalid-input'})
 assert.throws(()=>readRecoveryCandidate({...candidate,resumable:true}),{code:'teloa/invalid-input'},'随恢复票据持久化的候选仍拒绝多余字段')
})

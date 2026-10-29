import test from 'node:test'
import assert from 'node:assert/strict'
import {taskRunStopRequestedAt} from '../src/task-runs.ts'

test('停止请求时间缺字段回落 null，只接受规范化 ISO 串',()=>{
 assert.equal(taskRunStopRequestedAt(undefined),null)
 assert.equal(taskRunStopRequestedAt(null),null)
 assert.equal(taskRunStopRequestedAt('2026-09-20T09:00:00.000Z'),'2026-09-20T09:00:00.000Z')
 for(const bad of ['2026-09-20T09:00:00Z','2026-09-20 09:00:00','','昨天',0,new Date(),{}])assert.throws(()=>taskRunStopRequestedAt(bad),{code:'teloa/invalid-input'})
})

test('准备条件读口绑定任务版本，拒绝身份替换、未确认结果和额外授权字段',async()=>{
 const {taskRunReadinessInput,readTaskRunReadiness}=await import('../src/task-runs.ts')
 const taskId='11111111-1111-4111-8111-111111111111'
 assert.deepEqual(taskRunReadinessInput({taskId,expectedTaskVersion:2}),{taskId,expectedTaskVersion:2})
 const ready={schema:'teloa.task-run-readiness/v1',taskId,taskVersion:2,ready:true}
 assert.deepEqual(readTaskRunReadiness(ready),ready)
 for(const bad of [{taskId,expectedTaskVersion:0},{taskId,expectedTaskVersion:2,allowedTools:['*']},{taskId,expectedTaskVersion:2,requestId:taskId}])assert.throws(()=>taskRunReadinessInput(bad))
 for(const bad of [{...ready,ready:false},{...ready,taskVersion:0},{...ready,roleId:taskId},{...ready,schema:'untrusted'}])assert.throws(()=>readTaskRunReadiness(bad))
})

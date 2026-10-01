import test from 'node:test'
import assert from 'node:assert/strict'
import {taskRunStopRequestedAt} from '../src/task-runs.ts'

test('停止请求时间缺字段回落 null，只接受规范化 ISO 串',()=>{
 assert.equal(taskRunStopRequestedAt(undefined),null)
 assert.equal(taskRunStopRequestedAt(null),null)
 assert.equal(taskRunStopRequestedAt('2026-09-20T09:00:00.000Z'),'2026-09-20T09:00:00.000Z')
 for(const bad of ['2026-09-20T09:00:00Z','2026-09-20 09:00:00','','昨天',0,new Date(),{}])assert.throws(()=>taskRunStopRequestedAt(bad),{code:'teloa/invalid-input'})
})

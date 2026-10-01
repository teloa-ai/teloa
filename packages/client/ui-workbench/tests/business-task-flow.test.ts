import test from 'node:test'
import assert from 'node:assert/strict'
import {openSavedBusinessTask} from '../src/client/business-task-flow.ts'
import type {BusinessTaskResult} from '../src/client/business-task-api.ts'

const result={task:{id:'33333333-3333-4333-8333-333333333333'},source:{}} as BusinessTaskResult

test('真实业务任务保存后合并投影并打开刚返回的任务',()=>{
 const merged:unknown[][]=[],opened:string[]=[]
 assert.equal(openSavedBusinessTask(result,rows=>merged.push(rows),id=>opened.push(id)),result)
 assert.deepEqual(merged,[[result.task]])
 assert.deepEqual(opened,[result.task.id])
})

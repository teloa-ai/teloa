import test from 'node:test'
import assert from 'node:assert/strict'
import {businessCompletedTasks,businessCurrentTasks,businessCurrentWaiting,businessScopeTasks} from '../src/client/business-current-presentation.ts'
import type {PreviewTask} from '../src/client/task-preview.ts'

const task=(id:string,scope:string,state:PreviewTask['state'],updatedAt:string,options:{storage?:PreviewTask['storage'];need?:PreviewTask['need']}={}):PreviewTask=>({
 id,scope:scope as PreviewTask['scope'],state,updatedAt,storage:options.storage,need:options.need??null,
} as PreviewTask)

test('业务当前工作只读取同范围已保存任务，并以最近更新排序',()=>{
 const tasks=[
  task('old','SOC','running','2026-09-16T08:00:00.000Z',{storage:'persistent'}),
  task('new','SOC','ready','2026-09-16T09:00:00.000Z',{storage:'persistent'}),
  task('example','SOC','running','2026-09-16T10:00:00.000Z'),
  task('other','AppSec','running','2026-09-16T11:00:00.000Z',{storage:'persistent'}),
 ]
 assert.deepEqual(businessScopeTasks(tasks,'SOC').map(item=>item.id),['new','old'])
})

test('结项任务进入历史；等待清单覆盖显式待办、等待与阻塞',()=>{
 const tasks=[
  task('running','SOC','running','2026-09-16T08:00:00.000Z',{storage:'persistent'}),
  task('need','SOC','ready','2026-09-16T09:00:00.000Z',{storage:'persistent',need:'materials'}),
  task('waiting','SOC','waiting','2026-09-16T10:00:00.000Z',{storage:'persistent'}),
  task('blocked','SOC','blocked','2026-09-16T11:00:00.000Z',{storage:'persistent'}),
  task('done','SOC','completed','2026-09-16T12:00:00.000Z',{storage:'persistent',need:'approval'}),
  task('cancelled','SOC','cancelled','2026-09-16T13:00:00.000Z',{storage:'persistent'}),
 ]
 assert.deepEqual(businessCurrentTasks(tasks,'SOC').map(item=>item.id),['blocked','waiting','need','running'])
 assert.deepEqual(businessCurrentWaiting(tasks,'SOC').map(item=>item.id),['blocked','waiting','need'])
 assert.deepEqual(businessCompletedTasks(tasks,'SOC').map(item=>item.id),['cancelled','done'])
})

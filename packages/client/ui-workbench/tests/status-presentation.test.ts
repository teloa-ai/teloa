import test from 'node:test'
import assert from 'node:assert/strict'
import {planLifecycle,taskStatusMark} from '../src/client/status-presentation.ts'

test('生命周期只由自动化自身决定，暂不能执行不伪装成暂停',()=>{
 const plan={archived:false,enabled:true,handoff:{fromId:'former',reason:'交接'},fields:{roleId:'paused-role'}}
 assert.equal(planLifecycle(plan),'active')
 assert.equal(planLifecycle({...plan,enabled:false}),'paused')
 assert.equal(planLifecycle({...plan,archived:true}),'archived')
})

test('任务状态同时有不同形状，不仅依赖颜色',()=>{
 assert.equal(taskStatusMark('ready'),'inactive')
 assert.equal(taskStatusMark('running'),'running')
 assert.equal(taskStatusMark('waiting'),'waiting')
 assert.equal(taskStatusMark('paused'),'paused')
 assert.equal(taskStatusMark('blocked'),'blocked')
 assert.equal(taskStatusMark('completed'),'complete')
 assert.equal(taskStatusMark('cancelled'),'retired')
})

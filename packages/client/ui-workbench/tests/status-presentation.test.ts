import test from 'node:test'
import assert from 'node:assert/strict'
import {planLifecycle,taskStatusMark} from '../src/client/status-presentation.ts'
import * as runPresentation from '../src/client/task-run-presentation.ts'

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

test('AD09 原生completed缺交付回执时显示等待验收而非绿色完成',()=>{
 const row={state:'ended' as const,reason:'completed',deliveryCheck:{state:'unknown' as const}}
 assert.equal(runPresentation.taskRunTone(row,false),'warn')
 assert.equal(runPresentation.taskRunStatusKey(row),'taskCompletion.verificationWaiting.title')
 assert.equal(row.reason,'completed')
 assert.equal(runPresentation.taskRunTone({...row,deliveryCheck:{state:'review-required'}},false),'warn')
})

test('AD09 已保存交付与原有非日结状态保持原有语义',()=>{
 const row={state:'ended' as const,reason:'completed',deliveryCheck:{state:'saved' as const}}
 assert.equal(runPresentation.taskRunTone(row,false),'good')
 assert.equal(runPresentation.taskRunStatusKey(row),'taskExecution.reason.completed')
 assert.equal(runPresentation.taskRunTone({state:'active'},false),'info')
 assert.equal(runPresentation.taskRunStatusKey({state:'active'}),'taskExecution.phase.active')
 assert.equal(runPresentation.taskRunTone({...row,reason:'error'},false),'danger')
})

import test from 'node:test'
import assert from 'node:assert/strict'
import {taskRunControls} from '../src/client/task-run-presentation.ts'

test('运行配置失败的真实控制模型不提供会话和状态操作',()=>{
 assert.deepEqual(taskRunControls('configuration_failed'),[])
 assert.deepEqual(taskRunControls('prepared'),['open','start','withdraw'])
 assert.deepEqual(taskRunControls('active'),['open','stop','reconcile'])
})

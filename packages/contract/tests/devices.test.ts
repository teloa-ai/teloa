import test from 'node:test'
import assert from 'node:assert/strict'
import * as devices from '../src/devices.ts'

test('硬件工具拒绝自报会话与身份，文本按码点限制且不改正文',()=>{
 assert.equal(typeof devices.readHardwarePrepare,'function')
 assert.deepEqual(devices.readHardwarePrepare({text:'  整理今天的任务。  '}),{text:'整理今天的任务。'})
 assert.throws(()=>devices.readHardwarePrepare({text:'任务',sessionId:'foreign'}))
 assert.throws(()=>devices.readHardwarePrepare({text:'任务',ownerId:'self'}))
 assert.throws(()=>devices.readHardwarePrepare({text:'\u0000'}))
 assert.throws(()=>devices.readHardwarePrepare({text:'😀'.repeat(4001)}))
 assert.equal(devices.readHardwarePrepare({text:'😀'.repeat(4000)}).text.length,8000)
})

test('原操作查询只接受操作编号，不能替换正文或模糊查会话',()=>{
 assert.equal(typeof devices.readHardwareOperationId,'function')
 const id='b3442f0c-4c42-4c2c-b50f-acb0353b019f'
 assert.deepEqual(devices.readHardwareOperationId({operationId:id}),{operationId:id})
 assert.deepEqual(devices.readHardwareOperationId({},true),{})
 for(const input of [{},{operationId:'x'},{operationId:id,text:'替换'},{sessionId:'other'}])assert.throws(()=>devices.readHardwareOperationId(input))
})

import test from 'node:test'
import assert from 'node:assert/strict'
import {businessObjectSnapshotHash} from '../src/work/business-data.ts'
import {readRunBusinessContext} from '../src/work/task-run-business-context.ts'

test('合法最长 MCP 工具来源进入固定 Run 上下文，超过契约上限仍拒绝',()=>{
 const object={scope:'SOC',type:'alert',id:'SOC-2026-001',version:1,title:'告警',source:'受管来源',observedAt:'2026-09-30T00:00:00.000Z',receivedAt:'2026-09-30T00:00:00.000Z',quality:'complete' as const,summary:'待研判',fields:[]}
 const sourceId='s'.repeat(64)+'/'+'t'.repeat(128)
 const context={taskId:'11111111-1111-4111-8111-111111111111',sourceId,object:{...object,snapshotHash:businessObjectSnapshotHash(object)}}
 assert.deepEqual(readRunBusinessContext(context),context)
 assert.throws(()=>readRunBusinessContext({...context,sourceId:sourceId+'x'}),{code:'teloa/storage-corrupt'})
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { executionRouteLabel } from '../src/client/business-operation-presentation.ts'
import { businessExamples, type BusinessOperation } from '../src/client/business-preview.ts'

const operation=(id:string):BusinessOperation=>{
  const item=businessExamples('2026-09-12T08:00:00.000Z').operations.find(candidate=>candidate.id===id)
  if(!item)throw new Error(`缺少操作样例：${id}`)
  return item
}

test('执行列表区分自动判据和人工审批路径',()=>{
  assert.equal(executionRouteLabel(operation('op-auto')),'business.execution.route.policy')
  assert.equal(executionRouteLabel(operation('op-contain')),'business.execution.route.approval')
})

test('没有判据或审批卡的操作不伪称为自动或已审批',()=>{
  const {approval:_approval,...manual}=operation('op-contain')
  assert.equal(executionRouteLabel(manual),'business.execution.route.manual')
})

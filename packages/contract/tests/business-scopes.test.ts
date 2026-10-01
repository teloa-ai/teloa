import test from 'node:test'
import assert from 'node:assert/strict'
import { roleSupportsScope } from '../src/index.ts'

test('通用工作对任何岗位都成立，业务范围仍要求岗位声明含该范围',()=>{
  assert.equal(roleSupportsScope([],'general'),true)
  assert.equal(roleSupportsScope(['AppSec'],'SOC'),false)
  assert.equal(roleSupportsScope(['SOC'],'SOC'),true)
})

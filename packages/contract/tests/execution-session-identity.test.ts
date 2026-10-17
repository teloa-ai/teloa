import test from 'node:test'
import assert from 'node:assert/strict'
import {isReservedExecutionSessionId} from '../src/execution-session-identity.ts'

test('只按编排器保留身份分类，不按标题、父会话或任意文字前缀封禁普通会话',()=>{
 assert.equal(isReservedExecutionSessionId('task-run-12345678-1234-4234-8234-123456789012'),true)
 assert.equal(isReservedExecutionSessionId('group-routing-12345678-1234-5234-a234-123456789012'),true)
 for(const id of ['ordinary-fork','task-run-notes','12345678-1234-4234-8234-123456789012','group-routing-discussion'])assert.equal(isReservedExecutionSessionId(id),false)
})

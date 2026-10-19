import test from 'node:test'
import assert from 'node:assert/strict'
import {failureOutcome} from '../src/resident-model-budget.ts'

// 3110 实跑：复核步 MiniMax 返回 529 overloaded_error（无输出、无用量），适配器只给 code SERVER，状态码在消息开头。
test('服务端明确过载或限流且无任何输出时可有限重试；其余服务端错误、已有输出仍保留未知',()=>{
 const overloaded={message:'529 {"type":"error","error":{"type":"overloaded_error","message":"The server cluster is currently under high load."}}',code:'SERVER'} as never
 assert.equal(failureOutcome(overloaded,false),'transient')
 assert.equal(failureOutcome({message:'503 Service Unavailable',code:'SERVER'} as never,false),'transient')
 assert.equal(failureOutcome({message:'x',code:'SERVER',status:529} as never,false),'transient')
 assert.equal(failureOutcome({message:'500 internal error',code:'SERVER'} as never,false),'unknown','普通 500 可能已处理，不自动重放')
 assert.equal(failureOutcome({message:'529 overloaded',code:'TRANSPORT'} as never,false),'unknown','只认服务端错误码下的状态前缀')
 assert.equal(failureOutcome(overloaded,true),'unknown','已有输出时不能重放')
 assert.equal(failureOutcome({message:'401',code:'AUTHENTICATION_ERROR'} as never,false),'authentication')
})

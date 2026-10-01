import test from 'node:test'
import assert from 'node:assert/strict'
import {maxReconnectAttempts,reconnectDelayMs} from '../src/core/backoff.ts'

test('重连退避：1000*2^(attempt-1)，上限 60000',()=>{
 assert.deepEqual([1,2,3,7,8].map(reconnectDelayMs),[1000,2000,4000,60000,60000])
})

test('最大重连次数为 10',()=>{
 assert.equal(maxReconnectAttempts,10)
})

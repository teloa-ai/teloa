import test from 'node:test'
import assert from 'node:assert/strict'
import {createRateLimiter} from '../src/core/rate-limit.ts'

test('30/min：前 30 次放行，第 31 次返回 false',()=>{
 let t=1_000_000
 const limiter=createRateLimiter(30,()=>t)
 for(let index=0;index<30;index+=1){assert.equal(limiter.take('a'),true);t+=100}
 assert.equal(limiter.take('a'),false)
})

test('60 s 后窗口恢复',()=>{
 let t=0
 const limiter=createRateLimiter(30,()=>t)
 for(let index=0;index<30;index+=1)assert.equal(limiter.take('a'),true)
 assert.equal(limiter.take('a'),false)
 t=59_999
 assert.equal(limiter.take('a'),false)
 t=60_000
 assert.equal(limiter.take('a'),true)
})

test('不同 key 互不影响',()=>{
 const limiter=createRateLimiter(30,()=>0)
 for(let index=0;index<30;index+=1)limiter.take('a')
 assert.equal(limiter.take('a'),false)
 assert.equal(limiter.take('b'),true)
})

test('L4 hits 表有上限：超出先淘汰窗口外的键，仍超出再淘汰最久未放行的键；窗口内的限流状态保留',()=>{
 let t=0
 const limiter=createRateLimiter(1,()=>t,3)
 assert.equal(limiter.take('old'),true)
 t=30_000
 assert.equal(limiter.take('b'),true)
 assert.equal(limiter.take('c'),true)
 t=61_000
 assert.equal(limiter.take('d'),true)
 assert.equal(limiter.size(),3,'old 已过期被淘汰')
 assert.equal(limiter.take('b'),false,'b 仍在窗口内，限流状态保留')
 assert.equal(limiter.take('e'),true)
 assert.equal(limiter.size(),3,'无过期键时淘汰最久未放行的 b')
 assert.equal(limiter.take('d'),false)
})

test('L4 默认上限 1000 个键',()=>{
 const limiter=createRateLimiter(30,()=>0)
 for(let index=0;index<1500;index+=1)limiter.take(`k${index}`)
 assert.equal(limiter.size(),1000)
})

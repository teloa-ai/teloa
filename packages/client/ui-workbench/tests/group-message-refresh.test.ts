import test from 'node:test'
import assert from 'node:assert/strict'
import {scheduleGroupMessageRefresh} from '../src/client/group-message-refresh.ts'

test('已打开的群在延迟后重读服务端消息目录',async()=>{
 let scheduled:(()=>void)|undefined,calls=0
 let done:()=>void=()=>{}
 const completed=new Promise<void>(resolve=>{done=resolve})
 scheduleGroupMessageRefresh(async()=>{calls++;done()},work=>{scheduled=work;return ()=>{}})
 scheduled!()
 await completed
 assert.equal(calls,1)
})

test('切群或离开页面取消尚未开始的消息重读',()=>{
 let scheduled:(()=>void)|undefined,calls=0
 const cancel=scheduleGroupMessageRefresh(async()=>{calls++},work=>{scheduled=work;return ()=>{}})
 cancel()
 scheduled!()
 assert.equal(calls,0)
})

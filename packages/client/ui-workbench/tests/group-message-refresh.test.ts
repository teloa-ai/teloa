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

test('单次重读失败后仍按原节奏继续；前次结束前不安排下一次',async()=>{
 const queue:(()=>void)[]=[],events:string[]=[]
 let release:()=>void=()=>{}
 const held=new Promise<void>(resolve=>{release=resolve})
 const cancel=scheduleGroupMessageRefresh(async()=>{events.push('read');if(events.length===1){await held;throw Error('offline')}},work=>{queue.push(work);return ()=>{}})
 queue.shift()!()
 await new Promise(resolve=>setImmediate(resolve))
 assert.deepEqual(events,['read']);assert.equal(queue.length,0,'同一群不重叠读取')
 release()
 await new Promise(resolve=>setImmediate(resolve))
 assert.equal(queue.length,1,'读取失败后仍应安排下一轮')
 queue.shift()!()
 await new Promise(resolve=>setImmediate(resolve))
 assert.deepEqual(events,['read','read']);assert.equal(queue.length,1)
 cancel()
})

test('读取中离开群，迟到完成不再续排；同步失败也不会中断后续重读',async()=>{
 const queue:(()=>void)[]=[]
 let release:()=>void=()=>{}
 const held=new Promise<void>(resolve=>{release=resolve})
 const cancel=scheduleGroupMessageRefresh(()=>held,work=>{queue.push(work);return ()=>{}})
 queue.shift()!();cancel();release()
 await new Promise(resolve=>setImmediate(resolve))
 assert.equal(queue.length,0)
 const cancelSync=scheduleGroupMessageRefresh(()=>{throw Error('offline')},work=>{queue.push(work);return ()=>{}})
 assert.doesNotThrow(()=>queue.shift()!())
 await new Promise(resolve=>setImmediate(resolve))
 assert.equal(queue.length,1,'同步失败也保留下一轮')
 cancelSync()
})

test('定时器已到但读取尚未开始时关闭，不启动迟到的读取',async()=>{
 let tick:()=>void=()=>{},calls=0
 const cancel=scheduleGroupMessageRefresh(async()=>{calls++},work=>{tick=work;return ()=>{}})
 tick();cancel()
 await new Promise(resolve=>setImmediate(resolve))
 assert.equal(calls,0)
})

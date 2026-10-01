import test from 'node:test'
import assert from 'node:assert/strict'
import {reconcileInterruptedPluginInstallations} from '../src/plugin-startup-reconcile.ts'
import {withProfileLock} from '../src/pending-plugins.ts'

test('启动核对逐条推进，单条失败只记一次告警且不阻塞其余',async()=>{
 const done:string[]=[],warned:string[]=[]
 await reconcileInterruptedPluginInstallations({
  list:async()=>['a','b','c'],
  reconcile:async id=>{done.push(id);if(id==='b')throw Object.assign(Error('盘上读不到'),{code:'teloa/source-unavailable'})},
  report:(id,code)=>warned.push(id+':'+code),
 })
 assert.deepEqual(done,['a','b','c'])
 assert.deepEqual(warned,['b:teloa/source-unavailable'])
})

test('目录读不出来时只记一条告警，不抛给装配流程',async()=>{
 const warned:string[]=[]
 await reconcileInterruptedPluginInstallations({
  list:async()=>{throw Object.assign(Error('库不可读'),{code:'teloa/storage-corrupt'})},
  reconcile:async()=>{},
  report:(id,code)=>warned.push(id+':'+code),
 })
 assert.deepEqual(warned,['directory:teloa/storage-corrupt'])
})

test('核对期间 profile 锁未被持有：observe() 自己去拿同一把锁也不会自锁（规格 §7.4）',async()=>{
 // reconcile 会调 observe()，命中"待启用记录还在、包却已进 bundles"分支时它会自己去拿 profile 锁
 // 重新压制。withProfileLock 是进程内队列，不可重入：启动核对若是在某个锁回调里发起的，
 // 这次内层获取会排在外层之后，而外层要等 reconcile 返回——双方互等，装配期直接挂死。
 // 探针就按那次内层获取来写：在 reconcile 回调里真去拿一次锁，看它能不能立刻拿到。
 const profileDir='/tmp/teloa-启动核对锁探针',held:boolean[]=[]
 await reconcileInterruptedPluginInstallations({
  list:async()=>['a','b'],
  reconcile:async()=>{
   let acquired=false
   const inner=withProfileLock(profileDir,async()=>{acquired=true})
   // 拿不到就是被外层占着：给它一整轮宏任务的机会，仍然没拿到即判为持锁。
   await Promise.race([inner,new Promise(resolve=>setTimeout(resolve,20))])
   held.push(!acquired)
  },
  report:()=>assert.fail('探针不该报错'),
 })
 assert.deepEqual(held,[false,false],'每一条的核对都在锁外发起')
})

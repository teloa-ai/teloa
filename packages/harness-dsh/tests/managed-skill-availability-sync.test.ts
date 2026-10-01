import test from 'node:test'
import assert from 'node:assert/strict'
import {createManagedAvailabilitySync} from '../src/managed-skill-availability-sync.ts'

test('维护先关闭读取，提交后刷新；刷新失败不宣称成功并保留关闭',async()=>{
 const events:string[]=[];let failed=true
 const sync=createManagedAvailabilitySync({deny:()=>events.push('deny'),read:async()=>{events.push('read');if(failed)throw Error('offline');return 'disabled'},replace:value=>events.push(value)})
 await assert.rejects(sync.change(async()=>{events.push('commit');return 'receipt'}),/offline/)
 assert.deepEqual(events,['deny','commit','read'])
 failed=false;assert.equal(await sync.change(async()=>{events.push('replay');return 'receipt'}),'receipt')
 assert.deepEqual(events.slice(3),['deny','replay','read','disabled'])
})
test('并行维护按顺序完成，失败操作也核对当前状态，后续操作不被堵死',async()=>{
 const events:string[]=[];let release!:()=>void
 const gate=new Promise<void>(done=>{release=done})
 const sync=createManagedAvailabilitySync({deny:()=>events.push('deny'),read:async()=>{events.push('read');return 'enabled'},replace:value=>events.push(value)})
 const first=sync.change(async()=>{events.push('first');await gate;throw Error('conflict')})
 const second=sync.change(async()=>{events.push('second');return 2})
 await Promise.resolve();await Promise.resolve();assert.equal(events.includes('second'),false)
 release();await assert.rejects(first,/conflict/);assert.equal(await second,2)
 assert.deepEqual(events,['deny','first','read','enabled','deny','second','read','enabled'])
})
test('完整任务启动与维护共享队列，领取到发送期间不被目录刷新打断',async()=>{
 const events:string[]=[];let release!:()=>void
 const gate=new Promise<void>(done=>{release=done})
 const sync=createManagedAvailabilitySync({deny:()=>events.push('deny'),read:async()=>{events.push('read');return 'disabled'},replace:value=>events.push(value)})
 const start=sync.stable(async()=>{events.push('claim');await gate;events.push('send');return 'accepted'})
 const change=sync.change(async()=>{events.push('disable');return 'receipt'})
 await Promise.resolve();await Promise.resolve();assert.deepEqual(events,['claim'])
 release();assert.equal(await start,'accepted');assert.equal(await change,'receipt')
 assert.deepEqual(events,['claim','send','deny','disable','read','disabled'])
})

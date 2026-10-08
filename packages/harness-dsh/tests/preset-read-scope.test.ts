import test from 'node:test'
import assert from 'node:assert/strict'
import {withPresetReadScope} from '../src/preset-read-scope.ts'

test('预设只读作用域在读取结束前保持有效，之后释放官方租约',async()=>{
 const key={},events:string[]=[]
 const registry={acquireScope:async()=>({key,async [Symbol.asyncDispose](){events.push('released')}})}
 const result=await withPresetReadScope(registry,async scope=>{assert.equal(scope,key);events.push('read');await Promise.resolve();assert.deepEqual(events,['read']);return 'catalog'})
 assert.equal(result,'catalog');assert.deepEqual(events,['read','released'])
})

test('读取失败仍释放预设租约，并保留失败原因',async()=>{
 const failure=new Error('catalog-unavailable');let released=0
 const registry={acquireScope:async()=>({key:{},async [Symbol.asyncDispose](){released++}})}
 await assert.rejects(withPresetReadScope(registry,async()=>{throw failure}),error=>error===failure)
 assert.equal(released,1)
})

test('岗位目录持有本人选择预设的真实作用域，默认读取与失败释放保持',async()=>{
 const selected='role-preset',key={},ids:Array<string|undefined>=[];let released=0
 const registry={acquireScope:async(id?:string)=>{ids.push(id);return {key,async [Symbol.asyncDispose](){released++}}}}
 assert.equal(await withPresetReadScope(registry,async scope=>{assert.equal(scope,key);assert.equal(released,0);return 'actual-selected-layer'},selected),'actual-selected-layer')
 assert.deepEqual(ids,[selected]);assert.equal(released,1)
 await assert.rejects(withPresetReadScope(registry,async()=>{throw Error('layer unavailable')},selected),/layer unavailable/)
 assert.equal(released,2)
})

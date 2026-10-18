import test from 'node:test'
import assert from 'node:assert/strict'
import {Pool,stopTestContainer} from './postgres-test-lifecycle.ts'

test('连接池结束须等真实 remove，期间不得停止容器',async()=>{
 const pool=new Pool(),client={} as never,events:string[]=[]
 pool.emit('connect',client)
 const ending=pool.end().then(()=>events.push('pool-ended'))
 await new Promise(resolve=>setImmediate(resolve));assert.equal(events.length,0)
 pool.emit('remove',client);await ending
 await stopTestContainer({stop:async()=>{events.push('container-stopped')}})
 assert.deepEqual(events,['pool-ended','container-stopped'])
})
test('容器收尾仅重试明确 running 409，永久失败及其他错误仍拒绝',async()=>{
 const conflict=Object.assign(Error('container removal is already in progress'),{statusCode:409})
 // 不把其他 409 误作本批已定位的 running 删除竞态。
 let attempts=0
 await stopTestContainer({stop:async()=>{if(++attempts===1)throw Object.assign(Error('container is running'),{statusCode:409})}})
 assert.equal(attempts,2)
 await assert.rejects(stopTestContainer({stop:async()=>{throw conflict}}),error=>error===conflict)
 for(const error of [Object.assign(Error('permission denied'),{statusCode:403}),Object.assign(Error('conflict'),{statusCode:409})])await assert.rejects(stopTestContainer({stop:async()=>{throw error}}),cause=>cause===error)
 attempts=0;await assert.rejects(stopTestContainer({stop:async()=>{attempts++;throw Object.assign(Error('container is running'),{statusCode:409})}}));assert.equal(attempts,3)
})

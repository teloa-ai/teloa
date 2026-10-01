import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import test from 'node:test'
import {WorkError} from '@teloa/contract'
import {createHandoffHandler,handoffEndpoints} from '../src/index.ts'

const requestId='12345678-1234-4234-8234-123456789012',taskId='22345678-1234-4234-8234-123456789012',roleId='32345678-1234-4234-8234-123456789012'

test('交接 RPC 保留被动端点，并以托管 owner 转发两种严格主动目标',async()=>{
 const calls:unknown[]=[],service={
  list:async(owner:string,input:unknown)=>{calls.push(['list',owner,input]);return []},
  resolve:async(owner:string,input:unknown)=>{calls.push(['resolve',owner,input]);return {task:{} as never,handoffId:'id',appliedVersion:2}},
  change:async(owner:string,input:unknown)=>{calls.push(['change',owner,input]);return {task:{} as never,change:{} as never}},
 }
 const handle=createHandoffHandler('local:owner',async()=>service)
 assert.deepEqual(handoffEndpoints,['handoffs/list','handoffs/resolve','handoffs/change'])
 await handle('handoffs/list',{});await handle('handoffs/resolve',{handoffId:taskId,expectedTaskVersion:1,target:{kind:'self'},note:'接管'})
 await handle('handoffs/change',{requestId,taskId,expectedTaskVersion:1,target:{kind:'self'},note:'  本人接管  '})
 await handle('handoffs/change',{requestId,taskId,expectedTaskVersion:1,target:{kind:'role',roleId,expectedRoleVersion:2},note:'岗位接续'})
 assert.deepEqual(calls,[
  ['list','local:owner',{}],['resolve','local:owner',{handoffId:taskId,expectedTaskVersion:1,target:{kind:'self'},note:'接管'}],
  ['change','local:owner',{requestId,taskId,expectedTaskVersion:1,target:{kind:'self'},note:'本人接管'}],
  ['change','local:owner',{requestId,taskId,expectedTaskVersion:1,target:{kind:'role',roleId,expectedRoleVersion:2},note:'岗位接续'}],
 ])
})

test('交接 RPC 在服务调用前拒绝 owner 和未知字段，并透传业务错误',async()=>{
 let calls=0
 const expected=new WorkError('teloa/version-conflict','任务已变化')
 const handle=createHandoffHandler('local:owner',async()=>({list:async()=>[],resolve:async()=>({task:{} as never,handoffId:'id',appliedVersion:2}),change:async()=>{calls++;throw expected}}))
 await assert.rejects(handle('handoffs/change',{requestId,taskId,expectedTaskVersion:1,target:{kind:'self'},note:'接管',ownerId:'other'}),{code:'teloa/invalid-input'});assert.equal(calls,0)
 await assert.rejects(handle('handoffs/change',{requestId,taskId,expectedTaskVersion:1,target:{kind:'self',roleId},note:'接管'}),{code:'teloa/invalid-input'});assert.equal(calls,0)
 await assert.rejects(handle('handoffs/change',{requestId,taskId,expectedTaskVersion:1,target:{kind:'self'},note:'接管'}),error=>error===expected);assert.equal(calls,1)
})

test('Harness 启动阶段显式初始化岗位生命周期和交接表',async()=>{
 const source=await readFile(new URL('../src/index.ts',import.meta.url),'utf8')
 const sequence=await readFile(new URL('../../backend/src/work/initialize-database.ts',import.meta.url),'utf8')
 assert.match(source,/await initializeTeloaDatabase\(database\.pool[,)]/)
 assert.match(sequence,/await initializeRoleLifecycle\(pool\)/)
 assert.match(sequence,/await initializeHandoffs\(pool\)/)
 assert.doesNotMatch(source,/createHandoffHandler[\s\S]{0,500}initializeHandoffs/)
})

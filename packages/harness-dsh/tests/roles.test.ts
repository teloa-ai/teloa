import test from 'node:test'
import assert from 'node:assert/strict'
import {createRoleHandler} from '../src/roles.ts'
test('岗位 RPC 固定使用宿主本人身份，三条操作分派独立',async()=>{
 const calls:unknown[]=[],backend={list:async(owner:string,input:unknown)=>{calls.push(['list',owner,input]);return []},create:async(owner:string,input:unknown)=>{calls.push(['create',owner,input]);return {id:'created'}},edit:async(owner:string,input:unknown)=>{calls.push(['edit',owner,input]);return {id:'edited'}}}
 const handle=createRoleHandler('local:owner',async()=>backend)
 await handle('roles/list',{});await handle('roles/create',{requestId:'r',fields:{}});await handle('roles/edit',{roleId:'a',expectedVersion:1,fields:{}})
 assert.deepEqual(calls.map(row=>(row as unknown[]).slice(0,2)),[['list','local:owner'],['create','local:owner'],['edit','local:owner']])
})
test('未知接口和伪造主体在请求数据库前拒绝；数据库失败可以重试',async()=>{
 let reads=0
 const handle=createRoleHandler('local:owner',async()=>{reads++;throw Error('数据库不可用')})
 await assert.rejects(handle('roles/retire',{}),{code:'teloa/not-found'})
 await assert.rejects(handle('roles/list',{ownerId:'other'}),{code:'teloa/invalid-input'})
 assert.equal(reads,0)
 await assert.rejects(handle('roles/list',{}),/数据库不可用/);await assert.rejects(handle('roles/list',{}),/数据库不可用/);assert.equal(reads,2)
})
test('分身由个人空间默认提供，岗位创建端点在接触服务前拒绝',async()=>{
 let reads=0
 const handle=createRoleHandler('local:owner',async()=>{reads++;throw Error('不该读取服务')})
 await assert.rejects(handle('roles/create',{requestId:'r',fields:{kind:'twin'}}),{code:'teloa/conflict'})
 assert.equal(reads,0)
})
test('岗位保存前先按资料体积预检，超限时不写岗位；列表与无资料保存不预检',async()=>{
 const checked:unknown[]=[],calls:string[]=[]
 const backend={list:async()=>{calls.push('list');return []},create:async()=>{calls.push('create');return {}},edit:async()=>{calls.push('edit');return {}}}
 const handle=createRoleHandler('local:owner',async()=>backend,async ids=>{checked.push(ids);if(ids.includes('big'))throw Object.assign(Error('资料「大」有 300 KiB，超过同事/任务全文上限 256 KiB，只能加入本地检索使用。'),{code:'teloa/invalid-input'})})
 await handle('roles/list',{})
 await handle('roles/create',{requestId:'r',fields:{knowledge:['a','b']}})
 await handle('roles/edit',{roleId:'x',expectedVersion:1,fields:{knowledge:['c']}})
 await handle('roles/edit',{roleId:'x',expectedVersion:2,fields:{knowledge:[]}})
 await handle('roles/create',{requestId:'s',fields:{}})
 await assert.rejects(handle('roles/create',{requestId:'t',fields:{knowledge:['big']}}),{code:'teloa/invalid-input'})
 await assert.rejects(handle('roles/edit',{roleId:'x',expectedVersion:3,fields:{knowledge:['a','big']}}),/只能加入本地检索使用/)
 assert.deepEqual(checked,[['a','b'],['c'],['big'],['a','big']])
 assert.deepEqual(calls,['list','create','edit','edit','create'])
})

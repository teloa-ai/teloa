import test from 'node:test'
import assert from 'node:assert/strict'
import {createGroupHandler} from '../src/groups.ts'
const groupId='11111111-1111-4111-8111-111111111111',rootId='22222222-2222-4222-8222-222222222222',messageId='33333333-3333-4333-8333-333333333333'
test('群提及只读接口绑定宿主本人，拒绝额外本人字段和不存在的写入口',async()=>{
 const calls:unknown[]=[],service={attention:async(owner:string,input:unknown)=>{calls.push([owner,input]);return {}},mentionMessages:async(owner:string,input:unknown)=>{calls.push([owner,input]);return {}}}
 const handle=createGroupHandler('fixed-owner',async()=>service as never,()=>{})
 await handle('groups/attention',{});await handle('groups/mentions/list',{groupId,unreadOnly:true})
 assert.deepEqual(calls,[['fixed-owner',{}],['fixed-owner',{groupId,unreadOnly:true}]])
 await assert.rejects(handle('groups/attention',{owner:'other'}),{code:'teloa/invalid-input'})
 await assert.rejects(handle('groups/mentions/list',{groupId,owner:'other'}),{code:'teloa/invalid-input'})
 await assert.rejects(handle('groups/mentions/send',{groupId,target:'self'}),{code:'teloa/not-found'})
 assert.equal(calls.length,2)
})
test('群阅读 RPC 只使用宿主本人，先拒绝伪造参数，再调用原服务',async()=>{
 const calls:unknown[]=[],service={reading:async function(owner:string,input:unknown){assert.equal(this,service);calls.push(['read',owner,input]);return {}},markRead:async function(owner:string,input:unknown){assert.equal(this,service);calls.push(['mark',owner,input]);return {}}}
 const handle=createGroupHandler('local:actual-owner',async()=>service as never,()=>{})
 await handle('groups/reading/get',{groupId});await handle('groups/reading/mark',{groupId,rootId,messageId})
 assert.deepEqual(calls,[['read','local:actual-owner',{groupId}],['mark','local:actual-owner',{groupId,rootId,messageId}]])
 await assert.rejects(handle('groups/reading/get',{groupId,ownerId:'other'}),{code:'teloa/invalid-input'})
 await assert.rejects(handle('groups/reading/mark',{groupId,messageId,createdAt:'2026-10-15T00:00:00.000Z'}),{code:'teloa/invalid-input'})
 assert.equal(calls.length,2)
 const unavailable=createGroupHandler('local:actual-owner',async()=>({}) as never,()=>{})
 await assert.rejects(unavailable('groups/reading/get',{groupId}),{code:'teloa/host-unavailable'})
 await assert.rejects(unavailable('groups/reading/mark',{groupId,messageId}),{code:'teloa/host-unavailable'})
})

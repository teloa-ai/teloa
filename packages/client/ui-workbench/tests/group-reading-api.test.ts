import test from 'node:test'
import assert from 'node:assert/strict'
import {createGroupApi} from '../src/client/group-api.ts'
import {groupReadingInput,groupMarkReadInput,readGroupReadingState} from '@teloa/contract'

const groupId='11111111-1111-4111-8111-111111111111',rootId='22222222-2222-4222-8222-222222222222',messageId='33333333-3333-4333-8333-333333333333',createdAt='2026-10-15T00:00:00.000Z'
const state={schema:'teloa.group-reading/v1' as const,groupId,rootId:null,cursor:null,latest:{messageId,createdAt},unreadCount:1}
test('群阅读 API 固定原群/话题，写口只提交真实消息身份，拒绝跨目标回执',async()=>{
 const calls:unknown[]=[],api=createGroupApi(async(endpoint,input)=>{calls.push([endpoint,input]);return {...state,rootId:(input as {rootId?:string}).rootId??null}})
 assert.deepEqual(await api.reading(groupId),state)
 assert.equal((await api.markRead(groupId,messageId,rootId)).rootId,rootId)
 assert.deepEqual(calls,[['groups/reading/get',{groupId}],['groups/reading/mark',{groupId,rootId,messageId}]])
 await assert.rejects(createGroupApi(async()=>({...state,groupId:rootId})).reading(groupId),{code:'teloa/invalid-host-response'})
 await assert.rejects(createGroupApi(async()=>({...state,rootId})).markRead(groupId,messageId),{code:'teloa/invalid-host-response'})
})
test('阅读契约不接受客户端本人、时间、未知字段或伪造游标回包',()=>{
 for(const input of [{groupId,ownerId:'other'},{groupId,rootId:''},{groupId,createdAt}])assert.throws(()=>groupReadingInput(input),{code:'teloa/invalid-input'})
 for(const input of [{groupId,messageId,createdAt},{groupId,messageId,ownerId:'other'},{groupId,messageId:'wrong'}])assert.throws(()=>groupMarkReadInput(input),{code:'teloa/invalid-input'})
 for(const result of [{...state,unreadCount:-1},{...state,unreadCount:0.5},{...state,cursor:{messageId,createdAt:'2026-10-15T00:01:00.000Z'}},{...state,cursor:{messageId,createdAt},latest:null},{...state,ownerId:'other'},{...state,latest:{messageId,createdAt:'2026-10-15T00:00:00Z'}}])assert.throws(()=>readGroupReadingState(result),{code:'teloa/invalid-input'})
})

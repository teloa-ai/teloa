import test from 'node:test'
import assert from 'node:assert/strict'
import { createResourceApi } from '../src/client/resource-api.ts'

test('引用历史拒绝跨会话响应、错序分页及损坏元数据',async()=>{
  const page={sessionId:'session-a',items:[{seq:4,messageId:'message',turn:1,at:'2026-09-11T00:00:00Z',references:[{id:'11111111-1111-4111-a111-111111111111',version:1,metadata:{title:'冻结标题',sourceId:'workbench',sourceVersion:'a'.repeat(64),scopeIds:['general']}}]}],nextBeforeSeq:null}
  const api=createResourceApi(async()=>page)
  assert.deepEqual(await api.history('session-a',undefined,new AbortController().signal),page)
  await assert.rejects(api.history('session-b',undefined,new AbortController().signal),/格式/)
  await assert.rejects(createResourceApi(async()=>({...page,nextBeforeSeq:5})).history('session-a',undefined,new AbortController().signal),/格式/)
  await assert.rejects(createResourceApi(async()=>({...page,items:[...page.items,...page.items]})).history('session-a',undefined,new AbortController().signal),/格式/)
  await assert.rejects(createResourceApi(async()=>({...page,items:[{...page.items[0],references:[{...page.items[0]!.references[0],metadata:{...page.items[0]!.references[0]!.metadata,sourceVersion:'bad'}}]}]})).history('session-a',undefined,new AbortController().signal),/格式/)
})

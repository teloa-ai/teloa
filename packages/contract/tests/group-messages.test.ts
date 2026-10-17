import test from 'node:test'
import assert from 'node:assert/strict'
import * as contract from '../src/index.ts'
const id='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222'
test('群消息分页和全文检索只接受单一真实消息游标与有限窗口',()=>{
 const api=contract as unknown as {groupMessagePageInput:(value:unknown)=>unknown;groupMessageSearchInput:(value:unknown)=>unknown}
 assert.equal(typeof api.groupMessagePageInput,'function','应提供主群/话题有界分页契约')
 assert.deepEqual(api.groupMessagePageInput({groupId:id}),{groupId:id,limit:50})
 assert.deepEqual(api.groupMessagePageInput({groupId:id,rootId:other,before:id,limit:20}),{groupId:id,rootId:other,before:id,limit:20})
 for(const value of [{groupId:id,limit:101},{groupId:id,before:id,after:other},{groupId:id,owner:'other'},{groupId:id,createdAt:'2026-10-15T00:00:00.000Z'},{groupId:id,before:'missing'}])assert.throws(()=>api.groupMessagePageInput(value))
 assert.deepEqual(api.groupMessageSearchInput({groupId:id,query:'  原告警  '}),{groupId:id,query:'原告警',limit:50})
 for(const value of [{groupId:id,query:''},{groupId:id,query:'x'.repeat(241)},{groupId:id,query:'目标',limit:0},{groupId:id,query:'目标',ownerId:'other'}])assert.throws(()=>api.groupMessageSearchInput(value))
})

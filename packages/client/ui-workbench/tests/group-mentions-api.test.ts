import test from 'node:test'
import assert from 'node:assert/strict'
import {createGroupApi} from '../src/client/group-api.ts'
import {createConversationGroupDirectory} from '../src/client/conversation-group-directory.ts'
import {groupMentionsInput,readGroupAttention,readGroupMentionsPage} from '@teloa/contract'

const groupId='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222',messageId='33333333-3333-4333-8333-333333333333'
const message={id:messageId,groupId,rootId:null,authorId:other,taskId:other,runId:other,text:'@Max 只是正文',mentionSelf:true,createdAt:'2026-10-16T00:00:00.000Z',references:[]}
const summary={schema:'teloa.group-attention/v1',items:[{groupId,unreadCount:2,mentionCount:1}]},page={schema:'teloa.group-mentions/v1',groupId,rootId:null,unreadOnly:true,items:[{message,rootId:null,excerpt:'原提醒',unread:true}],next:null}
test('提及RPC回包精确核对群、话题、筛选和结构化真值，参数不可伪造本人',async()=>{
 const calls:unknown[]=[],api=createGroupApi(async(endpoint,input)=>{calls.push([endpoint,input]);return endpoint==='groups/attention'?summary:page})
 assert.deepEqual(await api.attention(),summary)
 assert.deepEqual(await api.mentions(groupId,true),page)
 assert.deepEqual(calls,[['groups/attention',{}],['groups/mentions/list',{groupId,limit:50,unreadOnly:true}]])
 for(const response of [{...page,groupId:other},{...page,rootId:other},{...page,unreadOnly:false}])await assert.rejects(createGroupApi(async()=>response).mentions(groupId,true))
 for(const input of [{groupId,ownerId:'other'},{groupId,name:'Max'},{groupId,unreadOnly:'true'},{groupId,before:'unknown'}])assert.throws(()=>groupMentionsInput(input))
 for(const input of [{...summary,items:[{groupId,unreadCount:0,mentionCount:1}]},{...summary,ownerId:'other'}])assert.throws(()=>readGroupAttention(input))
 assert.throws(()=>readGroupMentionsPage({...page,items:[{...page.items[0],message:{...message,mentionSelf:undefined}}]}))
 assert.throws(()=>readGroupMentionsPage({...page,items:[{...page.items[0],unread:false}]}))
})
test('目录提及摘要失败不伪装0，迟到旧请求不覆盖最新摘要',async()=>{
 let resolve!:(value:any)=>void,call=0
 const directory=createConversationGroupDirectory({list:async()=>({items:[]}),attention:async()=>{if(++call===1)return new Promise(yes=>resolve=yes);if(call===3)throw Error('private');return summary as never}})
 const first=directory.refreshAttention();await directory.refreshAttention();resolve({schema:summary.schema,items:[]});await first
 assert.deepEqual(directory.getSnapshot().attention,summary.items)
 await directory.refreshAttention();assert.equal(directory.getSnapshot().attention,undefined);assert.equal(directory.getSnapshot().attentionFailed,true)
})

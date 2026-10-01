import test from 'node:test'
import assert from 'node:assert/strict'
import * as api from '../src/index.ts'
const requestId='12345678-1234-4234-8234-123456789012'
test('最近日常查询只接受业务scope，客户端不能提供owner或候选会话',()=>{
 assert.equal(typeof api.readBusinessConversationRecentDaily,'function')
 assert.deepEqual(api.readBusinessConversationRecentDaily({scope:'SOC'}),{scope:'SOC'})
 for(const input of [{},{scope:'general'},{scope:''},{scope:'SOC',ownerId:'other'},{scope:'SOC',sessionIds:['s']},{scope:'SOC',kind:'daily'},{scope:'SOC',limit:100},{scope:'SOC',cursor:'x'}])assert.throws(()=>api.readBusinessConversationRecentDaily(input),{code:'teloa/invalid-input'})
})
test('最近日常回包只接受null或当前scope的daily固定预约，包括未绑定恢复',()=>{
 assert.equal(typeof api.readBusinessConversationRecentDailyResponse,'function')
 const binding={requestId,kind:'daily',scope:'SOC',title:'日常',createdAt:'2026-09-29T00:00:00.000Z',updatedAt:'2026-09-29T00:00:00.000Z'}
 assert.equal(api.readBusinessConversationRecentDailyResponse(null,'SOC'),null)
 assert.deepEqual(api.readBusinessConversationRecentDailyResponse(binding,'SOC'),binding)
 assert.deepEqual(api.readBusinessConversationRecentDailyResponse({...binding,sessionId:'session'},'SOC'),{...binding,sessionId:'session'})
 for(const value of [undefined,{...binding,kind:'builder'},{...binding,scope:'sales'},{...binding,draftId:requestId},{...binding,ownerId:'other'}])assert.throws(()=>api.readBusinessConversationRecentDailyResponse(value,'SOC'),{code:'teloa/invalid-host-response'})
})
test('业务会话预约严格校验固定参数、daily范围与原生UUID口径',()=>{
 assert.equal(typeof api.readBusinessConversationReserve,'function')
 const read=api.readBusinessConversationReserve
 assert.deepEqual(read({requestId,kind:'builder',title:' 搭建 '}),{requestId,kind:'builder',title:'搭建'})
 for(const change of [{kind:'other'},{kind:'daily'},{scope:'general'},{requestId:requestId.replace('-4234','-7234')},{title:'x'.repeat(201)},{workspaceId:'../x'},{unknown:true}])
  assert.throws(()=>read({requestId,kind:'builder',title:'搭建',...change}),{code:'teloa/invalid-input'})
 assert.equal(read({requestId,kind:'daily',title:'工作',scope:'SOC'}).scope,'SOC')
})
test('列表和绑定输入严格且分页有界',()=>{
 assert.equal(typeof api.readBusinessConversationList,'function')
 assert.deepEqual(api.readBusinessConversationList({}),{limit:20})
 for(const value of [{limit:null},{limit:0},{limit:101},{limit:1.5},{cursor:''},{ownerId:'other'},{scope:'general'}])assert.throws(()=>api.readBusinessConversationList(value),{code:'teloa/invalid-input'})
 assert.throws(()=>api.readBusinessConversationBind({requestId,sessionId:'ok',scope:'SOC'}),{code:'teloa/invalid-input'})
})
test('绑定和恢复目录回包严格且显示草案标题不改变预约fingerprint',()=>{
 assert.equal(typeof api.readBusinessConversationBinding,'function')
 const binding={requestId,kind:'builder',title:'初始标题',draftId:'11111111-1111-4111-8111-111111111111',sessionId:'session',createdAt:'2026-09-29T00:00:00.000Z',updatedAt:'2026-09-29T00:00:00.000Z'}
 assert.deepEqual(api.readBusinessConversationBinding(binding),binding)
 const item={binding,draft:{id:binding.draftId,title:'新名称',scope:'sales',revision:2,status:'draft',updatedAt:binding.updatedAt}}
 const result=api.readBusinessConversationDirectory({items:[item]})
 assert.equal(result.items[0]!.binding.title,'初始标题')
 assert.equal(result.items[0]!.draft?.title,'新名称')
 assert.throws(()=>api.readBusinessConversationDirectory({items:[{...item,draft:{...item.draft,candidate:{}}}]}),{code:'teloa/invalid-host-response'})
})

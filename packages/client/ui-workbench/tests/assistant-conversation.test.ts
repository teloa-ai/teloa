import assert from 'node:assert/strict'
import test from 'node:test'
import {findAssistantConversation,rememberAssistantConversation,assistantConversationTitle,assistantConversationKey,beginAssistantCreation,pendingAssistantCreation} from '../src/client/assistant-conversation.ts'
const rows=new Map<string,string>(),storage={getItem:(key:string)=>rows.get(key)??null,setItem:(key:string,value:string)=>{rows.set(key,value)},removeItem:(key:string)=>{rows.delete(key)}}
const conversation=(id:string)=>({sessionId:id,title:assistantConversationTitle,status:'ready',createdAt:'2026-10-11T00:00:00Z'}) as any
const context=(id:string,scopeId='general',roleId:string|null=null)=>({sessionId:id,scopeId,roleId,version:1,locked:false})
test('服务端默认用途优先于过期浏览器缓存，主聊归档或上下文变化不另找同名会话',async()=>{
 rows.clear();rows.set(assistantConversationKey,'stale');const canonical={...conversation('canonical'),purpose:'assistant'}
 const ordinary=conversation('stale'),read=async(id:string)=>context(id)
 assert.equal((await findAssistantConversation({storage,conversations:[ordinary,canonical],archived:[],read}))?.sessionId,'canonical')
 assert.equal(rows.get(assistantConversationKey),'canonical')
 await assert.rejects(findAssistantConversation({storage,conversations:[ordinary,canonical],archived:['canonical'],read}))
 await assert.rejects(findAssistantConversation({storage,conversations:[ordinary,canonical],archived:[],read:async id=>context(id,'sales')}))
})
test('助手只复用自己的普通通用会话，不把当前SOC或员工聊天当助手',async()=>{
 rows.clear();const candidates=[conversation('soc'),conversation('role'),conversation('assistant')]
 const read=async(id:string)=>id==='soc'?context(id,'soc'):id==='role'?context(id,'general','employee'):context(id)
 assert.equal((await findAssistantConversation({storage,conversations:candidates,archived:[],read}))?.sessionId,'assistant')
 rows.clear();assert.equal(await findAssistantConversation({storage,conversations:candidates.slice(0,2),archived:[],read}),undefined)
})
test('刷新后恢复同一助手创建requestId和工作区，未知结果不换身份',async()=>{
 rows.clear();const request=beginAssistantCreation(storage,'workspace')
 assert.deepEqual(pendingAssistantCreation(storage),request)
 assert.deepEqual(beginAssistantCreation(storage,'workspace'),request)
 assert.throws(()=>beginAssistantCreation(storage,'other'),/原工作区/)
 await rememberAssistantConversation({...conversation('original'),requestId:request.requestId},storage,{read:async id=>context(id),set:async()=>{throw Error('unexpected write')}})
 assert.equal(pendingAssistantCreation(storage),undefined)
})
test('重命名不丢助手身份；已归档或上下文被修改不悄悄改投或创建',async()=>{
 rows.set(assistantConversationKey,'original');const row={...conversation('original'),title:'我的助理'}
 assert.equal((await findAssistantConversation({storage,conversations:[row],archived:[],read:async id=>context(id)}))?.sessionId,'original')
 await assert.rejects(findAssistantConversation({storage,conversations:[row],archived:['original'],read:async id=>context(id)}))
 await assert.rejects(findAssistantConversation({storage,conversations:[row],archived:[],read:async id=>context(id,'soc')}))
 await assert.rejects(findAssistantConversation({storage,conversations:[],archived:[],read:async id=>context(id)}))
})
test('创建上下文回执核实后才保存；未知回包保持原请求重试，不能登记业务会话',async()=>{
 rows.clear();let writes=0
 const api={read:async()=>null,set:async(input:any)=>{writes++;assert.equal(input.roleId,null);assert.equal(input.scopeId,'general');return context(input.sessionId)}}
 await rememberAssistantConversation(conversation('new'),storage,api)
 assert.equal(rows.get(assistantConversationKey),'new');assert.equal(writes,1)
 await rememberAssistantConversation(conversation('new'),storage,{...api,read:async id=>context(id)})
 assert.equal(writes,1)
 rows.clear();await assert.rejects(rememberAssistantConversation(conversation('wrong'),storage,{...api,read:async id=>context(id,'soc')}));assert.equal(rows.size,0)
 await assert.rejects(rememberAssistantConversation(conversation('unknown'),storage,{...api,set:async()=>{throw Error('lost receipt')}}));assert.equal(rows.size,0)
})

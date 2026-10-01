import assert from 'node:assert/strict'
import test from 'node:test'
import {createObjectConversationApi} from '../src/client/object-conversation-api.ts'
import {ensureHomeObjectContext} from '../src/client/home-object-context.ts'
const id='16057272-ed9d-44a3-abe4-2ab04e056105',object={kind:'task' as const,id,title:'真实任务',version:1,canStart:true}
const link={kind:'task',objectId:id,objectVersion:1,conversationId:'conversation',sessionId:'native',scopeId:'SOC',version:1,active:true,updatedAt:'2026-09-25T00:00:00Z'}

test('关联回包丢失后独立恢复，再续办创建只核对真实关联，不重复link',async()=>{
 let saved=false,lost=true;const commands:any[]=[],receipts=new Set<string>()
 const api=createObjectConversationApi(async(endpoint,payload:any)=>{
  if(endpoint.endsWith('/list'))return saved?[link]:[]
  if(endpoint.endsWith('/change')){
   commands.push(payload)
   if(receipts.has(payload.requestId))return link
   if(saved)throw Error('already active')
   saved=true;receipts.add(payload.requestId)
   if(lost){lost=false;throw Error('response lost')}
   return link
  }
  throw Error(endpoint)
 })
 await assert.rejects(ensureHomeObjectContext(api,object,'native','SOC'),/response lost/)
 await api.recover();assert.equal(api.pending(),undefined)
 const result=await ensureHomeObjectContext(api,object,'native','SOC')
 assert.equal(result.sessionId,'native');assert.equal(commands.length,2);assert.equal(commands[0].requestId,commands[1].requestId)
})

test('创建续办可直接恢复原关联，但不能改投其他业务',async()=>{
 let saved=false
 const api=createObjectConversationApi(async(endpoint)=>{if(endpoint.endsWith('/list'))return [];if(!saved){saved=true;throw Error('lost')}return link})
 await assert.rejects(ensureHomeObjectContext(api,object,'native','SOC'))
 await assert.rejects(ensureHomeObjectContext(api,object,'native','Other'),/原请求/)
 assert.equal((await ensureHomeObjectContext(api,object,'native','SOC')).active,true)
})

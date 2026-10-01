import test from 'node:test'
import assert from 'node:assert/strict'
import * as module from '../src/business-builder.ts'
import {randomUUID} from 'node:crypto'
const requestId=randomUUID(),draftId=randomUUID(),now='2026-09-29T00:00:00.000Z'
const binding={requestId,kind:'builder' as const,title:'初始名称',draftId,sessionId:'builder',createdAt:now,updatedAt:now}
function fixture(){
 let scopeIds:string[]=[],reads=0
 const result={scope:'sales',version:1,configurationHash:'a'.repeat(64),requestId}
 const services={
  bindings:{bySession:async()=>binding,byRequest:async()=>binding,list:async()=>({items:[binding]}),reserve:async()=>binding,bind:async()=>binding},
  drafts:{get:async()=>({ownerId:'owner',id:draftId,scope:'sales',revision:2,baseVersion:0,status:'draft',hash:'a'.repeat(64),createdAt:now,updatedAt:now,candidate:{format:'teloa.business-configuration/v1',scope:'sales',title:'新名称',sources:[{sourceId:'records',kind:'local-records'}],definitions:[],pages:[]}})},
  configuration:{receipt:async(actor:{scopeIds:string[]})=>{assert.deepEqual(actor.scopeIds,['sales']);return result},apply:async()=>result,current:async()=>undefined},
  preview:{preview:async()=>{reads++;throw Error('不得触达')}},
  pages:{read:async()=>{throw Error()},preview:async()=>{throw Error()}},
  records:{create:async()=>{throw Error()},edit:async()=>{throw Error()},archive:async()=>{throw Error()},get:async()=>{throw Error()},list:async()=>{throw Error()},receipt:async()=>undefined},
 }
 assert.equal(typeof module.createBusinessBuilderHandler,'function')
 const handler=module.createBusinessBuilderHandler('owner',async()=>scopeIds,async()=>services as never)
 return {handler,setScopes:(values:string[])=>scopeIds=values,reads:()=>reads,services,result}
}
test('失回包后每次刷新真实scope并读取完整回执；不存在显式null',async()=>{
 const f=fixture();f.setScopes(['sales'])
 assert.deepEqual(await f.handler('business-configuration/receipt',{requestId}),f.result)
 assert.deepEqual(await f.handler('business-configuration/receipt',{requestId}),f.result)
 assert.equal(await f.handler('business-configuration/current',{scope:'sales'}),null)
 assert.equal(await f.handler('business-records/receipt',{requestId}),null)
})
test('跨会话或草案、额外owner和公开revise在触达服务前拒绝',async()=>{
 const f=fixture()
 for(const change of [{sessionId:'other'},{draftId:randomUUID()},{owner:'other'}])await assert.rejects(f.handler('business-configuration/preview',{sessionId:'builder',draftId,expectedRevision:2,...change}))
 assert.equal(f.reads(),0)
 await assert.rejects(f.handler('business-configuration/revise',{}),{code:'teloa/not-found'})
 await assert.rejects(f.handler('business-records/list',{scope:'sales',type:'customer',limit:10,ownerId:'other'}),{code:'teloa/invalid-input'})
})
test('恢复列表从草案真源投影标题、更新时间，保留预约标题且不传正文',async()=>{
 const f=fixture(),result=await f.handler('business-conversations/list',{}) as {items:Array<{binding:typeof binding;draft:{title:string}}> }
 assert.equal(result.items[0]!.binding.title,'初始名称');assert.equal(result.items[0]!.draft.title,'新名称')
 assert.equal(JSON.stringify(result).includes('definitions'),false)
 f.services.drafts.get=async()=>{throw Error('读取失败')}
 await assert.rejects(f.handler('business-conversations/list',{}),/读取失败/)
})
test('不同请求的合法形状回执不能伪造成功',async()=>{
 const f=fixture();f.setScopes(['sales'])
 f.services.configuration.receipt=async()=>({...f.result,requestId:randomUUID()})
 await assert.rejects(f.handler('business-configuration/receipt',{requestId}),{code:'teloa/invalid-host-response'})
 f.services.bindings.byRequest=async()=>({...binding,requestId:randomUUID()})
 await assert.rejects(f.handler('business-conversations/by-request',{requestId}),{code:'teloa/invalid-host-response'})
})
test('原生已ready但最终bind未完成时by-session保留预约可恢复，草案端点仍拒绝',async()=>{
 const f=fixture(),{sessionId:_,...pending}=binding
 f.services.bindings.bySession=async()=>pending as typeof binding
 const result=await f.handler('business-conversations/by-session',{sessionId:'builder'})
 assert.deepEqual(result,pending)
 await assert.rejects(f.handler('business-configuration/draft',{sessionId:'builder',draftId}),{code:'teloa/forbidden'})
})

test('最近日常scope-only端点传真实actor和signal，回包必须同scope daily；失败不变null',async()=>{
 const f=fixture();f.setScopes(['SOC']);const abort=new AbortController(),daily={requestId,kind:'daily',title:'继续日常',scope:'SOC',createdAt:now,updatedAt:now}
 let result:unknown=daily,calls=0
 Object.assign(f.services.bindings,{recentDaily:async(actor:unknown,input:unknown,signal:AbortSignal)=>{calls++;assert.deepEqual(actor,{ownerId:'owner',scopeIds:['SOC']});assert.deepEqual(input,{scope:'SOC'});assert.equal(signal,abort.signal);return result}})
 assert.deepEqual(await f.handler('business-conversations/recent-daily',{scope:'SOC'},abort.signal),daily)
 result=null;assert.equal(await f.handler('business-conversations/recent-daily',{scope:'SOC'},abort.signal),null)
 for(const bad of [{...daily,scope:'sales'},{...daily,kind:'builder'},undefined]){result=bad;await assert.rejects(f.handler('business-conversations/recent-daily',{scope:'SOC'},abort.signal),{code:'teloa/invalid-host-response'})}
 const previous=calls;await assert.rejects(f.handler('business-conversations/recent-daily',{scope:'SOC',sessionIds:['fake']},abort.signal),{code:'teloa/invalid-input'});assert.equal(calls,previous)
 Object.assign(f.services.bindings,{recentDaily:async()=>{throw Error('目录不可读')}});await assert.rejects(f.handler('business-conversations/recent-daily',{scope:'SOC'},abort.signal),/目录不可读/)
})

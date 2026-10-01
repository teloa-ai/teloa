import test from 'node:test'
import assert from 'node:assert/strict'
import {WorkError} from '@teloa/contract'
import {createBusinessDashboardResourceHandler} from '../src/business-dashboard-resource.ts'
import {dashboardBody} from '../../backend/tests/fixtures/business-dashboard.ts'

const ownerId='local:owner',id='11111111-1111-4111-8111-111111111111',stamp='2026-10-01T00:00:00.000Z'
const draft=(owner=ownerId)=>({ownerId:owner,id,scope:'SOC',revision:1,baseVersion:0,candidate:dashboardBody().configuration,hash:'a'.repeat(64),status:'draft',createdAt:stamp,updatedAt:stamp})
function setup(options:{draftOwner?:string;invalidResult?:boolean;scopeIds?:()=>Promise<string[]>}={}){
 const calls:{operation:string;actor:unknown;input:unknown;signal?:AbortSignal|undefined}[]=[],opened={value:0}
 const service={exportCurrent:async(actor:unknown,input:unknown)=>{calls.push({operation:'export',actor,input});return {resource:options.invalidResult?{format:'bad'}:dashboardBody(),excluded:[],configurationHash:'a'.repeat(64)}},prepare:async(actor:unknown,input:unknown)=>{calls.push({operation:'prepare',actor,input});return draft(options.draftOwner)},preview:async()=>{throw new WorkError('teloa/version-conflict','草案已更新')},apply:async(actor:unknown,input:unknown,signal?:AbortSignal)=>{calls.push({operation:'apply',actor,input,signal});signal?.throwIfAborted();throw new WorkError('teloa/forbidden','需要本人确认')},page:async(actor:unknown,input:unknown,signal?:AbortSignal)=>{calls.push({operation:'page',actor,input,signal});signal?.throwIfAborted();throw new WorkError('teloa/not-found','页面不存在')}}
 const handler=createBusinessDashboardResourceHandler(ownerId,options.scopeIds??(async()=>['general','SOC','AppSec']),async()=>{opened.value++;return service as never})
 return {handler,calls,opened}
}
test('看板端点固定本人和登记范围，export/prepare 不调用采用；拒绝跨本人和坏正文回包',async()=>{
 const e=setup(),input={requestId:id,contentId:id,contentHash:'a'.repeat(64),resourceId:'soc-overview',target:{kind:'new',title:'安全运营'}}
 assert.deepEqual(await e.handler('business-dashboard-resources/prepare',input),draft())
 const exported=await e.handler('business-dashboard-resources/export',{scope:'SOC',id:'soc-overview',version:'1.0.0'}) as {resource:unknown}
 assert.deepEqual(exported.resource,dashboardBody())
 assert.deepEqual(e.calls.map(call=>call.operation),['prepare','export'])
 for(const call of e.calls)assert.deepEqual(call.actor,{ownerId,scopeIds:['SOC','AppSec']})
 assert.deepEqual(e.calls[0]?.input,input)
 await assert.rejects(setup({draftOwner:'other'}).handler('business-dashboard-resources/prepare',input),{code:'teloa/invalid-host-response'})
 await assert.rejects(setup({invalidResult:true}).handler('business-dashboard-resources/export',{scope:'SOC',id:'soc-overview',version:'1.0.0'}))
})
test('未知端点和外部身份字段在打开服务前拒绝',async()=>{
 const e=setup()
 await assert.rejects(e.handler('business-dashboard-resources/delete',{}),{code:'teloa/not-found'})
 for(const endpoint of ['export','prepare','prepare-upgrade','adoption','preview','apply','page'])for(const field of ['ownerId','scopeIds','unexpected'])await assert.rejects(e.handler('business-dashboard-resources/'+endpoint,{[field]:'forged'}),{code:'teloa/invalid-input'})
 assert.equal(e.opened.value,0);assert.equal(e.calls.length,0)
})

test('升级和已采用恢复校验本人、范围和冻结配置身份，不重新调用采用',async()=>{
 const calls:string[]=[],actor={ownerId,scopeIds:['SOC']}
 let returned:unknown={draft:draft(),conflicts:[],changed:['page:home']}
 const service={prepareUpgrade:async(actual:unknown)=>{assert.deepEqual(actual,actor);calls.push('upgrade');return returned},adoption:async(actual:unknown)=>{assert.deepEqual(actual,actor);calls.push('adoption');return returned}}
 const handler=createBusinessDashboardResourceHandler(ownerId,async()=>['general','SOC'],async()=>service as never)
 assert.deepEqual(await handler('business-dashboard-resources/prepare-upgrade',{requestId:id}),returned)
 returned={draft:draft('other'),conflicts:[],changed:[]}
 await assert.rejects(handler('business-dashboard-resources/prepare-upgrade',{requestId:id}),{code:'teloa/invalid-host-response'})
 returned={draft:draft(),conflicts:[{key:'page:home',entity:'page',id:'home'}],changed:[]}
 await assert.rejects(handler('business-dashboard-resources/prepare-upgrade',{requestId:id}),{code:'teloa/invalid-host-response'})
 returned={draft:null,conflicts:[{key:'page:home',entity:'page',id:'home'}],changed:[]}
 assert.deepEqual(await handler('business-dashboard-resources/prepare-upgrade',{requestId:id}),returned)
 returned=null
 assert.equal(await handler('business-dashboard-resources/adoption',{draftId:id}),null)
 returned={draftId:id,scope:'SOC',version:2,configurationHash:'b'.repeat(64)}
 assert.deepEqual(await handler('business-dashboard-resources/adoption',{draftId:id.toUpperCase()}),returned)
 for(const invalid of [{...returned as object,scope:'other'},{...returned as object,draftId:'22222222-2222-4222-8222-222222222222'},{...returned as object,requestId:id},{...returned as object,version:0}]){
  returned=invalid
  await assert.rejects(handler('business-dashboard-resources/adoption',{draftId:id}),{code:'teloa/invalid-host-response'})
 }
 assert.ok(calls.every(call=>call==='upgrade'||call==='adoption'))
})
test('取消在打开服务前终止，等待范围时取消也不派发，apply/page 传递原信号和真实服务错误',async()=>{
 const stopped=new AbortController();stopped.abort(new Error('已取消'))
 const e=setup()
 await assert.rejects(e.handler('business-dashboard-resources/prepare',{},stopped.signal),/已取消/)
 assert.equal(e.opened.value,0)
 const waiting=new AbortController(),delayed=setup({scopeIds:async()=>{waiting.abort(new Error('等待期间取消'));return ['SOC']}})
 await assert.rejects(delayed.handler('business-dashboard-resources/prepare',{},waiting.signal),/等待期间取消/)
 assert.equal(delayed.opened.value,0)
 const active=new AbortController(),live=setup()
 await assert.rejects(live.handler('business-dashboard-resources/apply',{requestId:id,draftId:id},active.signal),{code:'teloa/forbidden'})
 await assert.rejects(live.handler('business-dashboard-resources/page',{draftId:id,pageId:'home'},active.signal),{code:'teloa/not-found'})
 await assert.rejects(live.handler('business-dashboard-resources/preview',{draftId:id}),{code:'teloa/version-conflict'})
 assert.equal(live.calls[0]?.signal,active.signal);assert.equal(live.calls[1]?.signal,active.signal)
})

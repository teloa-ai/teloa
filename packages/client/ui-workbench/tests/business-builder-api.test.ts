import test from 'node:test'
import assert from 'node:assert/strict'
import * as module from '../src/client/business-builder-api.ts'
const requestId='11111111-1111-4111-8111-111111111111',draftId='22222222-2222-4222-8222-222222222222',now='2026-09-29T00:00:00.000Z'
const binding={requestId,kind:'builder',title:'新业务',draftId,createdAt:now,updatedAt:now}
test('v2 配置通过正式 API 读取草案、保存声明和记录页；错业务或页面仍拒绝',async()=>{
 const hash='a'.repeat(64),objectType={format:'teloa.business-object-type/v2',id:'customer',version:'1.0.0',domain:'sales',title:'客户',unit:'位',lead:'客户',sourceId:'records',fields:[{format:'teloa.business-rich-field/v2',name:'amount',label:'金额',type:'money',from:'金额',required:false,currencies:['CNY']}]}
 const definition={id:'customers',kind:'records',title:'客户',objectType:'customer',fields:['amount'],allowCreate:true,allowEdit:true,allowArchive:true}
 const candidate={format:'teloa.business-configuration/v2',scope:'sales',title:'业务',sources:[{sourceId:'records',kind:'local-records'}],definitions:[{kind:'object-type',definition:objectType}],pages:[definition],homePageId:'customers'}
 const draft={ownerId:'owner',id:draftId,scope:'sales',revision:2,baseVersion:0,status:'draft',hash,createdAt:now,updatedAt:now,candidate}
 const current={scope:'sales',version:1,manifest:{...candidate,definitions:[{kind:'object-type',localId:'customer',version:1,definitionHash:hash}]},hash,createdAt:now}
 const page={format:'teloa.business-configuration-page/v2',mode:'saved',scope:'sales',configurationHash:hash,configurationVersion:1,page:{kind:'records',definition,objectType,emptyState:'no-records'}}
 const api=module.createBusinessBuilderApi(async endpoint=>endpoint==='business-configuration/draft'?draft:endpoint==='business-configuration/current'?current:page)
 assert.deepEqual(await api.draft({sessionId:'session',draftId}),draft)
 assert.deepEqual(await api.current({scope:'sales'}),current)
 assert.deepEqual(await api.page({scope:'sales',pageId:'customers'}),page)
 for(const input of [{scope:'other',pageId:'customers'},{scope:'sales',pageId:'other'},{sessionId:'session',draftId,expectedRevision:2,pageId:'customers'}])await assert.rejects(api.page(input),{code:'teloa/invalid-host-response'})
})
test('最近日常只接受scope并严格核同范围daily，pending和明确null保持原义',async()=>{
 const pending={requestId,kind:'daily',scope:'sales',title:'销售工作',createdAt:now,updatedAt:now},calls:unknown[]=[]
 const api=module.createBusinessBuilderApi(async(e,r)=>{calls.push([e,r]);return pending})
 assert.deepEqual(await api.recentDaily({scope:'sales'}),pending)
 assert.deepEqual(calls,[['business-conversations/recent-daily',{scope:'sales'}]])
 await assert.rejects(api.recentDaily({scope:'sales',sessionIds:['foreign']} as never),{code:'teloa/invalid-input'})
 assert.equal(calls.length,1)
 for(const value of [undefined,{...pending,scope:'other'},binding,{...pending,draftId}])await assert.rejects(module.createBusinessBuilderApi(async()=>value).recentDaily({scope:'sales'}),{code:'teloa/invalid-host-response'})
 assert.equal(await module.createBusinessBuilderApi(async()=>null).recentDaily({scope:'sales'}),null)
 const failure=Error('directory unavailable')
 await assert.rejects(module.createBusinessBuilderApi(async()=>{throw failure}).recentDaily({scope:'sales'}),e=>e===failure)
})
test('预约指纹和绑定回包身份严格核对，by-session允许尚未最终bind的预约',async()=>{
 const api=module.createBusinessBuilderApi(async()=>binding)
 assert.deepEqual(await api.reserve({requestId,kind:'builder',title:'新业务'}),binding)
 await assert.rejects(api.reserve({requestId,kind:'builder',title:'另一个名称'}),{code:'teloa/invalid-host-response'})
 await assert.rejects(api.bind({requestId,sessionId:'session'}),{code:'teloa/invalid-host-response'})
 assert.deepEqual(await api.bySession({sessionId:'session'}),binding)
})
test('缺值只允许显式null，额外owner在网络调用前拒绝',async()=>{
 let calls=0
 const api=module.createBusinessBuilderApi(async()=>{calls++;return null})
 assert.equal(await api.byRequest({requestId}),null)
 assert.equal(await api.receipt({requestId}),null)
 assert.equal(await api.current({scope:'sales'}),null)
 await assert.rejects(api.reserve({requestId,kind:'builder',title:'新业务',owner:'other'} as never),{code:'teloa/invalid-input'})
 assert.equal(calls,3)
 await assert.rejects(module.createBusinessBuilderApi(async()=>undefined).receipt({requestId}),{code:'teloa/invalid-host-response'})
})
test('回执与列表目标身份不能靠合法外形冒充',async()=>{
 const api=module.createBusinessBuilderApi(async()=>({scope:'sales',version:1,configurationHash:'a'.repeat(64),requestId:draftId}))
 await assert.rejects(api.receipt({requestId}),{code:'teloa/invalid-host-response'})
 const list=module.createBusinessBuilderApi(async()=>({items:[{binding,draft:{id:draftId,title:'当前名称',scope:'sales',revision:2,status:'draft',updatedAt:now}}]}))
 assert.equal((await list.list({kind:'builder'})).items[0]!.draft!.title,'当前名称')
 await assert.rejects(list.list({kind:'daily'}),{code:'teloa/invalid-host-response'})
})
test('草案、预览、采用和页面拒绝错ID/revision/版本；原宿主错误details原样透传',async()=>{
 const hash='a'.repeat(64),candidate={format:'teloa.business-configuration/v1',scope:'sales',title:'业务',sources:[{sourceId:'records',kind:'local-records'}],definitions:[],pages:[]}
 const draft={ownerId:'owner',id:draftId,scope:'sales',revision:2,baseVersion:0,status:'draft',hash,createdAt:now,updatedAt:now,candidate}
 const target={sessionId:'session',draftId},preview={draftId,revision:2,candidateHash:hash,baseVersion:0,dependencyHash:hash,receipt:hash,changes:{rows:[],truncated:false},issues:[]}
 assert.equal((await module.createBusinessBuilderApi(async()=>draft).draft(target)).id,draftId)
 await assert.rejects(module.createBusinessBuilderApi(async()=>({...draft,id:requestId})).draft(target),{code:'teloa/invalid-host-response'})
 await assert.rejects(module.createBusinessBuilderApi(async()=>preview).preview({...target,expectedRevision:3}),{code:'teloa/invalid-host-response'})
 await assert.rejects(module.createBusinessBuilderApi(async()=>({scope:'sales',version:2,configurationHash:hash,requestId})).apply({...target,expectedRevision:2,expectedBaseVersion:0,previewReceipt:hash,requestId}),{code:'teloa/invalid-host-response'})
 const objectType={format:'teloa.business-object-type/v1',id:'customer',version:'1.0.0',domain:'sales',title:'客户',unit:'位',lead:'客户',sourceId:'records',fields:[{name:'stage',label:'阶段',type:'text',from:'阶段',required:true}]}
 const projection={mode:'preview',scope:'sales',configurationHash:hash,draftId,revision:2,page:{kind:'records',definition:{id:'customers',kind:'records',title:'客户',objectType:'customer',fields:['stage'],allowCreate:true,allowEdit:true,allowArchive:true},objectType,emptyState:'no-records'}}
 const pageApi=module.createBusinessBuilderApi(async()=>projection)
 assert.equal((await pageApi.page({...target,expectedRevision:2,pageId:'customers'})).mode,'preview')
 for(const input of [{...target,expectedRevision:3,pageId:'customers'},{...target,expectedRevision:2,pageId:'other'},{scope:'sales',pageId:'customers'}])await assert.rejects(pageApi.page(input),{code:'teloa/invalid-host-response'})
 const rejected=Object.assign(Error('expired'),{code:'teloa/conflict',details:{reason:'preview-receipt-invalid'}})
 await assert.rejects(module.createBusinessBuilderApi(async()=>{throw rejected}).preview({...target,expectedRevision:2}),e=>e===rejected)
})

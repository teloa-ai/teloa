import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {createBusinessBuilderHandler} from '../src/business-builder.ts'

const scope='business_0123456789abcdef0123456789abcdef',stamp='2026-09-30T00:00:00.000Z'
const object={format:'teloa.business-object-type/v2',id:'customer',version:'1.0.0',domain:scope,title:'客户',unit:'位',lead:'客户跟进',sourceId:'records',fields:[{format:'teloa.business-rich-field/v2',name:'amount',label:'金额',type:'money',required:false,from:'原金额',currencies:['CNY']},{format:'teloa.business-rich-field/v2',name:'tags',label:'标签',type:'multi-enum',required:false,from:'原标签',values:['重要','续约']}]}
const definition={id:'customers',title:'客户记录',kind:'records',objectType:'customer',fields:['amount','tags'],allowCreate:true,allowEdit:true,allowArchive:true}
const candidate={format:'teloa.business-configuration/v2',scope,title:'客户跟进',sources:[{sourceId:'records',kind:'local-records'}],definitions:[{kind:'object-type',definition:object}],pages:[definition],homePageId:'customers'}
function fixture(){
 const draftId=randomUUID(),requestId=randomUUID(),hash='a'.repeat(64)
 const binding={requestId,kind:'builder',title:'客户跟进',draftId,sessionId:'builder',createdAt:stamp,updatedAt:stamp}
 const draft={ownerId:'owner',id:draftId,scope,revision:3,baseVersion:0,candidate,hash,status:'draft',createdAt:stamp,updatedAt:stamp}
 const manifest={...candidate,definitions:[{kind:'object-type',localId:'customer',version:1,definitionHash:hash}]}
 const current={scope,version:1,manifest,hash,createdAt:stamp}
 const page={format:'teloa.business-configuration-page/v2',mode:'saved',scope,configurationHash:hash,configurationVersion:1,page:{kind:'records',definition,objectType:object,emptyState:'no-records'}}
 const {configurationVersion:_,...base}=page
 const previewPage={...base,mode:'preview',draftId,revision:3}
 const services={bindings:{bySession:async()=>binding,list:async()=>({items:[binding]})},drafts:{get:async()=>draft},configuration:{current:async()=>current},pages:{read:async()=>page,preview:async()=>previewPage}}
 const handler=createBusinessBuilderHandler('owner',async()=>[scope],async()=>services as never)
 return {handler,services,draftId,draft,current,page,previewPage}
}
test('真实宿主出口按版本读取富字段目录、草案、正式配置及两类记录页，不降级金额、多选',async()=>{
 const f=fixture(),bound={sessionId:'builder',draftId:f.draftId}
 const directory=await f.handler('business-conversations/list',{}) as any
 assert.equal(directory.items[0].draft.id,f.draftId)
 assert.deepEqual(await f.handler('business-configuration/draft',bound),f.draft)
 assert.deepEqual(await f.handler('business-configuration/current',{scope}),f.current)
 assert.deepEqual(await f.handler('business-configuration/page',{scope,pageId:'customers'}),f.page)
 assert.deepEqual(await f.handler('business-configuration/page',{...bound,expectedRevision:3,pageId:'customers'}),f.previewPage)
})
test('版本化宿主仍拒绝未知格式、跨owner、跨scope及不属于原请求的页面',async()=>{
 const bad={code:'teloa/invalid-host-response'},f=fixture(),original=f.services.drafts.get
 for(const draft of [{...f.draft,ownerId:'other'},{...f.draft,candidate:{...candidate,format:'teloa.business-configuration/v3'}}]){
  f.services.drafts.get=async()=>draft as typeof f.draft
  await assert.rejects(f.handler('business-configuration/draft',{sessionId:'builder',draftId:f.draftId}),bad)
 }
 f.services.drafts.get=original
 f.services.configuration.current=async()=>({...f.current,scope:'other'})
 await assert.rejects(f.handler('business-configuration/current',{scope}),bad)
 f.services.pages.read=async()=>({...f.page,page:{...f.page.page,definition:{...definition,id:'other'}}})
 await assert.rejects(f.handler('business-configuration/page',{scope,pageId:'customers'}),bad)
 // 转换只可走有当前本人指令及原生审批的工具，公共接口不能绕过。
 await assert.rejects(f.handler('business-configuration/upgrade-format',{}),{code:'teloa/not-found'})
})

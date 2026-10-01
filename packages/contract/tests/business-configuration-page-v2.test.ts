import test from 'node:test'
import assert from 'node:assert/strict'
import * as api from '../src/index.ts'

const scope='business_0123456789abcdef0123456789abcdef'
const object={format:'teloa.business-object-type/v2',id:'customer',version:'1.0.0',domain:scope,title:'客户',unit:'位',lead:'客户跟进',sourceId:'records',fields:[{format:'teloa.business-rich-field/v2',name:'amount',label:'金额',type:'money',required:false,from:'金额',currencies:['CNY']}]}
const definition={id:'customers',title:'客户记录',kind:'records',objectType:'customer',fields:['amount'],allowCreate:true,allowEdit:true,allowArchive:true}
const candidate={format:'teloa.business-configuration/v2',scope,title:'客户跟进',sources:[{sourceId:'records',kind:'local-records'}],definitions:[{kind:'object-type',definition:object}],pages:[definition],homePageId:'customers'}
const page={kind:'records',definition,objectType:object,emptyState:'no-records'}
const projection={format:'teloa.business-configuration-page/v2',mode:'saved',scope,configurationHash:'a'.repeat(64),configurationVersion:1,page}
const stamp='2026-09-30T00:00:00.000Z'
const id='11111111-1111-4111-8111-111111111111'
const bad={code:'teloa/invalid-host-response'}

test('v2 records 投影用显式版本；旧读取器继续拒收而版本入口保留真实字段',()=>{
 assert.deepEqual(api.readBusinessConfigurationPageProjectionVersioned(projection),projection)
 assert.throws(()=>api.readBusinessConfigurationPageProjection(projection),bad)
})

test('v2 records 投影拒绝缺版本、跨范围、错字段、混旧格式和额外身份',()=>{
 const {format:_,...missing}=projection
 for(const value of [missing,{...projection,owner:'other'},{...projection,format:'teloa.business-configuration-page/v3'},{...projection,page:{...page,objectType:{...object,domain:'other'}}},{...projection,page:{...page,definition:{...definition,fields:['missing']}}},{...projection,page:{...page,objectType:{...object,format:'teloa.business-object-type/v1'}}}])assert.throws(()=>api.readBusinessConfigurationPageProjectionVersioned(value),bad)
 const {configurationVersion:__,...base}=projection
 const preview={...base,mode:'preview',draftId:id,revision:2}
 assert.deepEqual(api.readBusinessConfigurationPageProjectionVersioned(preview),preview)
 assert.throws(()=>api.readBusinessConfigurationPageProjectionVersioned({...preview,configurationVersion:1}),bad)
})

test('v2 draft/current 回包版本入口显式分派，严格校验范围与旧版拒收',()=>{
 const draft={ownerId:'owner',id,scope,revision:2,baseVersion:0,candidate,hash:'a'.repeat(64),status:'draft',createdAt:stamp,updatedAt:stamp}
 const manifest={...candidate,definitions:[{kind:'object-type',localId:'customer',version:1,definitionHash:'a'.repeat(64)}]}
 const current={scope,version:1,manifest,hash:'a'.repeat(64),createdAt:stamp}
 assert.deepEqual(api.readBusinessConfigurationDraftResponseVersioned(draft),draft)
 assert.deepEqual(api.readBusinessConfigurationCurrentResponseVersioned(current),current)
 assert.throws(()=>api.readBusinessConfigurationDraftResponse(draft),bad)
 assert.throws(()=>api.readBusinessConfigurationCurrentResponse(current),bad)
 for(const value of [{...draft,scope:'other'},{...draft,extra:true},{...draft,candidate:{...candidate,format:'teloa.business-configuration/v3'}}])assert.throws(()=>api.readBusinessConfigurationDraftResponseVersioned(value),bad)
 for(const value of [{...current,scope:'other'},{...current,version:0},{...current,extra:true}])assert.throws(()=>api.readBusinessConfigurationCurrentResponseVersioned(value),bad)
})

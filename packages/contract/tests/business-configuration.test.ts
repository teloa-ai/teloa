import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readBusinessConfigurationCandidate,readBusinessConfigurationManifest,readBusinessConfigurationPatch,businessConfigurationLimits} from '../src/business-configuration.ts'
import {businessDefinitionCanonicalBody,readBusinessObjectTypeDefinition} from '../src/business-definitions.ts'

const invalid=(error:unknown)=>(error as {code?:string}).code==='teloa/invalid-input'
const scope='business_0123456789abcdef0123456789abcdef'
const source={sourceId:'records',kind:'local-records'}
const object={format:'teloa.business-object-type/v1',id:'ticket',version:'1.0.0',domain:scope,title:'工单',unit:'条',lead:'跟进事项',sourceId:'records',fields:[{name:'state',label:'状态',type:'text',required:true,from:'状态'}]}
const widget={format:'teloa.business-widget/v1',id:'total',version:'1.0.0',domain:scope,title:'总数',kind:'metric',query:'select count(*) as n from ticket',metric:{valueColumn:'n'}}
const dashboard={format:'teloa.business-dashboard/v1',id:'overview',version:'1.0.0',domain:scope,title:'总览',widgets:['total'],layout:[{widget:'total',x:0,y:0,w:6,h:2}],refresh:{kind:'every',seconds:300},acknowledgeShortInterval:false}
const records={id:'tickets',title:'工单列表',kind:'records',objectType:'ticket',fields:['state'],allowCreate:true,allowEdit:true,allowArchive:false}
const dashboardPage={id:'home',title:'业务总览',kind:'dashboard',dashboardId:'overview'}
const mapping={format:'teloa.business-source-mapping/v1',id:'ticket-sync',version:'1.0.0',domain:scope,title:'工单同步',objectType:'ticket',source:{kind:'business-data-port',sourceId:'security-alert-http'},mapping:[{path:'$.state',field:'state'}],primaryKey:['state'],deletionSemantics:'compare',schedule:{kind:'every',seconds:60},acknowledgeShortInterval:false}
const empty={format:'teloa.business-configuration/v1',scope,title:'我的业务',sources:[source],definitions:[],pages:[]}
const complete={...empty,definitions:[{kind:'object-type',definition:object},{kind:'widget',definition:widget},{kind:'dashboard',definition:dashboard}],pages:[records,dashboardPage],homePageId:'home'}

test('空草案保留中文标题与来源，允许尚无首页和定义',()=>{
 assert.deepEqual(readBusinessConfigurationCandidate(empty),empty)
 assert.equal(businessConfigurationLimits.canonicalBytes,2_097_152)
 assert.equal(businessConfigurationLimits.definitions,256)
 assert.equal(businessConfigurationLimits.pages,24)
 assert.equal(businessConfigurationLimits.sources,16)
 assert.equal(businessConfigurationLimits.pendingDraftsPerOwner,16)
})

test('records 与 dashboard 页面及既有叶子正文按统一读取器规范化',()=>{
 assert.deepEqual(readBusinessConfigurationCandidate(complete),complete)
 const reordered={...complete,definitions:[{kind:'object-type',definition:{...object,fields:[{from:'状态',required:true,type:'text',label:'状态',name:'state'}]}},...complete.definitions.slice(1)]}
 assert.equal(businessDefinitionCanonicalBody(readBusinessConfigurationCandidate(reordered).definitions[0]!.definition),businessDefinitionCanonicalBody(readBusinessObjectTypeDefinition(object)))
 assert.equal(createHash('sha256').update(businessDefinitionCanonicalBody(readBusinessConfigurationCandidate(complete).definitions[0]!.definition)).digest('hex'),'cc71f08bea4221bc1db6b9c29e4b3af9b9be5a5d10c19f003f534cb70200059a')
})

test('v1 整体配置明确接纳现有 source-mapping 正文、patch 与固定版本引用',()=>{
 const candidate={...complete,definitions:[...complete.definitions,{kind:'source-mapping',definition:mapping}]}
 assert.deepEqual(readBusinessConfigurationCandidate(candidate),candidate)
 assert.deepEqual(readBusinessConfigurationPatch({upsertDefinitions:[{kind:'source-mapping',definition:mapping}]}),{upsertDefinitions:[{kind:'source-mapping',definition:mapping}]})
 const manifest={...candidate,definitions:candidate.definitions.map((item,index)=>({kind:item.kind,localId:item.definition.id,version:1,definitionHash:String(index+1).repeat(64)}))}
 assert.deepEqual(readBusinessConfigurationManifest(manifest),manifest)
 assert.throws(()=>readBusinessConfigurationCandidate({...candidate,definitions:[...complete.definitions,{kind:'source-mapping',definition:{...mapping,schedule:{kind:'every',seconds:0}}}]}),invalid)
})

test('候选拒绝未知键、种类、来源和旧版叶子非法正文',()=>{
 const cases=[
  {...empty,unexpected:true},
  {...empty,sources:[{...source,token:'secret'}]},
  {...empty,sources:[{...source,kind:'mcp'}]},
  {...empty,definitions:[{kind:'action',definition:object}]},
  {...empty,definitions:[{kind:'source-mapping',definition:object}]},
  {...empty,definitions:[{kind:'object-type',definition:{...object,unexpected:true}}]},
  {...empty,definitions:[{kind:'object-type',definition:{...object,domain:'SOC'}}]},
  {...complete,pages:[{...records,label:'中文'}]},
  {...complete,pages:[{...records,fields:['状态']},dashboardPage]},
  {...complete,pages:[{...records,allowCreate:'yes'},dashboardPage]},
 ]
 for(const value of cases)assert.throws(()=>readBusinessConfigurationCandidate(value),invalid)
})

test('候选拒绝重复页、定义身份、字段 name 与 from',()=>{
 for(const value of [
  {...complete,pages:[records,records]},
  {...complete,definitions:[complete.definitions[0],complete.definitions[0]]},
  {...complete,pages:[{...records,fields:['state','state']},dashboardPage]},
  {...complete,definitions:[{kind:'object-type',definition:{...object,fields:[object.fields[0],{...object.fields[0],name:'other'}]}},complete.definitions[1]]},
 ])assert.throws(()=>readBusinessConfigurationCandidate(value),invalid)
})

test('首页与长度上限严格校验，不截断超额数组或 JSON',()=>{
 for(const value of [
  {...complete,homePageId:undefined},
  {...complete,homePageId:'missing'},
  {...empty,homePageId:'home'},
  {...empty,title:'字'.repeat(81)},
  {...empty,pages:Array.from({length:25},(_,i)=>({...dashboardPage,id:'page-'+i})),homePageId:'page-0'},
  {...empty,definitions:Array.from({length:257},(_,i)=>({kind:'object-type',definition:{...object,id:'type-'+i}}))},
  {...empty,title:'字'.repeat(80),sources:[source],extra:'x'.repeat(2_097_152)},
  {...empty,sources:Array.from({length:17},(_,i)=>({sourceId:'source-'+i,kind:'local-records'}))},
 ])assert.throws(()=>readBusinessConfigurationCandidate(value),invalid)
 const longQuery='select 1 as n'+' '.repeat(8192-'select 1 as n'.length)
 const oversized={...empty,definitions:Array.from({length:256},(_,i)=>({kind:'widget',definition:{...widget,id:'metric-'+i,query:longQuery}}))}
 assert.throws(()=>readBusinessConfigurationCandidate(oversized),(error:unknown)=>invalid(error)&&/2 MiB/.test((error as Error).message),'256 个各自合法的叶子合计超过 2 MiB 时必须拒绝整个候选')
})

test('Manifest 只接固定引用，非空且首页绑定存在，不读取叶子正文',()=>{
 const manifest={...complete,definitions:[{kind:'object-type',localId:'ticket',version:1,definitionHash:'a'.repeat(64)},{kind:'widget',localId:'total',version:1,definitionHash:'c'.repeat(64)},{kind:'dashboard',localId:'overview',version:2,definitionHash:'b'.repeat(64)}]}
 assert.deepEqual(readBusinessConfigurationManifest(manifest),manifest)
 for(const value of [
  {...manifest,definitions:complete.definitions},
  {...manifest,definitions:[{...manifest.definitions[0],definition:object}]},
  {...manifest,definitions:[{...manifest.definitions[0],version:0}]},
  {...manifest,definitions:[{...manifest.definitions[0],definitionHash:'bad'}]},
  {...manifest,definitions:[manifest.definitions[0],manifest.definitions[0]]},
  {...manifest,pages:[]},
  {...manifest,pages:[{...dashboardPage,dashboardId:'missing'}]},
 ])assert.throws(()=>readBusinessConfigurationManifest(value),invalid)
 assert.throws(()=>readBusinessConfigurationCandidate(manifest),invalid)
})

test('patch 只接显式变化，拒绝重叠身份和重复排序',()=>{
 const patch={title:'新标题',upsertDefinitions:[{kind:'object-type',definition:object}],removeDefinitions:[{kind:'dashboard',localId:'overview'}],upsertPages:[records],removePageIds:['home'],homePageId:'tickets',pageOrder:['tickets']}
 assert.deepEqual(readBusinessConfigurationPatch(patch),patch)
 for(const value of [
  {...patch,unknown:true},
  {...patch,upsertDefinitions:[{kind:'action',definition:object}]},
  {...patch,removeDefinitions:[{kind:'object-type',localId:'ticket'}]},
  {...patch,removePageIds:['tickets']},
  {...patch,pageOrder:['tickets','tickets']},
  {...patch,pageOrder:['bad_id']},
  {...patch,upsertPages:[{...records,action:'run'}]},
 ])assert.throws(()=>readBusinessConfigurationPatch(value),invalid)
})

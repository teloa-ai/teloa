import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readBusinessConfigurationCandidate,readBusinessConfigurationManifest,readBusinessConfigurationPatch} from '../src/business-configuration.ts'
import {businessDefinitionCanonicalBody,readBusinessObjectTypeDefinition} from '../src/business-definitions.ts'
import {readBusinessConfigurationCandidateV2,readBusinessConfigurationCandidateVersioned,readBusinessConfigurationManifestV2,readBusinessConfigurationManifestVersioned,readBusinessConfigurationPatchVersioned,readBusinessObjectTypeDefinitionV2} from '../src/index.ts'

const invalid=(error:unknown)=>(error as {code?:string}).code==='teloa/invalid-input'
const scope='business_0123456789abcdef0123456789abcdef'
const source={sourceId:'records',kind:'local-records'}
const state={name:'state',label:'阶段',type:'enum',required:true,from:'原阶段',values:['新建','完成']}
const money={format:'teloa.business-rich-field/v2',name:'amount',label:'金额',type:'money',required:false,from:'原金额',currencies:['CNY']}
const object={format:'teloa.business-object-type/v2',id:'customer',version:'1.0.0',domain:scope,title:'客户',unit:'位',lead:'客户跟进',sourceId:'records',fields:[state,money]}
const records={id:'customers',title:'客户记录',kind:'records',objectType:'customer',fields:['state','amount'],allowCreate:false,allowEdit:false,allowArchive:true}
const candidate={format:'teloa.business-configuration/v2',scope,title:'客户跟进',sources:[source],definitions:[{kind:'object-type',definition:object}],pages:[records],homePageId:'customers'}
const view={format:'teloa.business-view/v1',id:'stages',version:'1.0.0',domain:scope,title:'阶段分布',kind:'distribution',chart:'bar',objectType:'customer',dimension:{field:'state',limit:10},measures:[{id:'count',label:'数量',aggregation:'count'}],filters:[],sort:{by:'dimension',direction:'asc'},limit:10}
const widget={format:'teloa.business-widget/v1',id:'total',version:'1.0.0',domain:scope,title:'总数',kind:'view-ref',viewRef:'stages'}
const sqlWidget={format:'teloa.business-widget/v1',id:'total',version:'1.0.0',domain:scope,title:'总数',kind:'metric',query:'select count(*) as n from customer',metric:{valueColumn:'n'}}
const dashboard={format:'teloa.business-dashboard/v1',id:'overview',version:'1.0.0',domain:scope,title:'总览',widgets:['total'],layout:[{widget:'total',x:0,y:0,w:6,h:2}],refresh:{kind:'every',seconds:300},acknowledgeShortInterval:false}
const dashboardPage={id:'home',title:'总览',kind:'dashboard',dashboardId:'overview'}
const mapping={format:'teloa.business-source-mapping/v1',id:'customer-sync',version:'1.0.0',domain:scope,title:'客户同步',objectType:'customer',source:{kind:'business-data-port',sourceId:'security-alert-http'},mapping:[{path:'$.state',field:'state'}],primaryKey:['state'],deletionSemantics:'compare',schedule:{kind:'every',seconds:60},acknowledgeShortInterval:false}

test('v2 候选允许富字段对象和记录页，旧读取器拒收，版本入口显式分派',()=>{
 assert.deepEqual(readBusinessConfigurationCandidateV2(candidate),candidate)
 assert.deepEqual(readBusinessConfigurationCandidateVersioned(candidate),candidate)
 assert.throws(()=>readBusinessConfigurationCandidate(candidate),invalid)
 const legacy={...candidate,format:'teloa.business-configuration/v1',definitions:[{kind:'object-type',definition:{...object,format:'teloa.business-object-type/v1',fields:[state]}}],pages:[{...records,fields:['state']} ]}
 assert.deepEqual(readBusinessConfigurationCandidateVersioned(legacy),readBusinessConfigurationCandidate(legacy))
})

test('v2 候选核对来源、记录页字段及对象定义版本',()=>{
 for(const value of [
  {...candidate,definitions:[{kind:'object-type',definition:{...object,sourceId:'other'}}]},
  {...candidate,pages:[{...records,fields:['missing']}]},
  {...candidate,pages:[{...records,objectType:'missing'}]},
  {...candidate,definitions:[{kind:'object-type',definition:{...object,format:'teloa.business-object-type/v1'}}]},
  {...candidate,definitions:[{kind:'object-type',definition:{...object,domain:'other'}}]},
 ])assert.throws(()=>readBusinessConfigurationCandidateV2(value),invalid)
})

test('v2 整体配置沿用 v1 source-mapping 正文与版本化 patch，不降级富字段对象',()=>{
 const withMapping={...candidate,definitions:[...candidate.definitions,{kind:'source-mapping',definition:mapping}]}
 assert.deepEqual(readBusinessConfigurationCandidateV2(withMapping),withMapping)
 const patch={upsertDefinitions:[{kind:'source-mapping',definition:mapping}]}
 assert.deepEqual(readBusinessConfigurationPatchVersioned(patch,'teloa.business-configuration/v2'),patch)
 const manifest={...withMapping,definitions:[{kind:'object-type',localId:'customer',version:1,definitionHash:'a'.repeat(64)},{kind:'source-mapping',localId:'customer-sync',version:1,definitionHash:'b'.repeat(64)}]}
 assert.deepEqual(readBusinessConfigurationManifestV2(manifest),manifest)
 assert.throws(()=>readBusinessConfigurationCandidateV2({...withMapping,definitions:[...candidate.definitions,{kind:'source-mapping',definition:{...mapping,source:{kind:'unknown'}}}]}),invalid)
})

test('v2 候选核对视图、组件、看板的跨定义身份，并暂拒富字段进入旧视图',()=>{
 const complete={...candidate,definitions:[...candidate.definitions,{kind:'view',definition:view},{kind:'widget',definition:widget},{kind:'dashboard',definition:dashboard}],pages:[records,dashboardPage]}
 assert.deepEqual(readBusinessConfigurationCandidateV2(complete),complete)
 for(const value of [
  {...complete,definitions:complete.definitions.map(item=>item.kind==='view'?{kind:'view',definition:{...view,objectType:'missing'}}:item)},
  {...complete,definitions:complete.definitions.map(item=>item.kind==='view'?{kind:'view',definition:{...view,dimension:{field:'amount',limit:10}}}:item)},
  {...complete,definitions:complete.definitions.map(item=>item.kind==='widget'?{kind:'widget',definition:{...widget,viewRef:'missing'}}:item)},
  {...complete,definitions:complete.definitions.map(item=>item.kind==='dashboard'?{kind:'dashboard',definition:{...dashboard,widgets:['missing'],layout:[{...dashboard.layout[0],widget:'missing'}]}}:item)},
  {...complete,pages:[records,{...dashboardPage,dashboardId:'missing'}]},
 ])assert.throws(()=>readBusinessConfigurationCandidateV2(value),invalid)
 const withSql={...complete,definitions:complete.definitions.map(item=>item.kind==='widget'?{kind:'widget',definition:sqlWidget}:item)}
 assert.throws(()=>readBusinessConfigurationCandidateV2(withSql),(error:unknown)=>invalid(error)&&/SQL/.test((error as Error).message))
})

test('v2 无富字段的旧 SQL 组件仍可读取',()=>{
 const plain={...candidate,definitions:[{kind:'object-type',definition:{...object,fields:[state]}},{kind:'widget',definition:sqlWidget}],pages:[{...records,fields:['state']}]}
 assert.deepEqual(readBusinessConfigurationCandidateV2(plain),plain)
})

test('v2 patch 只放行 v2 对象定义；旧 patch 仍拒收且版本由草案显式指定',()=>{
 const patch={upsertDefinitions:[{kind:'object-type',definition:object}],upsertPages:[records],homePageId:'customers'}
 assert.deepEqual(readBusinessConfigurationPatchVersioned(patch,'teloa.business-configuration/v2'),patch)
 assert.throws(()=>readBusinessConfigurationPatch(patch),invalid)
 assert.throws(()=>readBusinessConfigurationPatchVersioned(patch,'teloa.business-configuration/v1'),invalid)
 assert.throws(()=>readBusinessConfigurationPatchVersioned({...patch,upsertDefinitions:[{kind:'object-type',definition:{...object,format:'teloa.business-object-type/v1'}}]},'teloa.business-configuration/v2'),invalid)
 assert.throws(()=>readBusinessConfigurationPatchVersioned(patch,'teloa.business-configuration/v3'),invalid)
})

test('v2 对象正文从真实富字段定义产生规范字节，字段顺序与值参与哈希',()=>{
 const parsed=readBusinessObjectTypeDefinitionV2(object)
 const bytes=businessDefinitionCanonicalBody(parsed)
 assert.match(bytes,/"format":"teloa\.business-object-type\/v2"/)
 assert.match(bytes,/"type":"money"/)
 assert.equal(bytes,businessDefinitionCanonicalBody(readBusinessConfigurationCandidateV2(candidate).definitions[0]!.definition))
 assert.notEqual(bytes,businessDefinitionCanonicalBody(readBusinessObjectTypeDefinition({...object,format:'teloa.business-object-type/v1',fields:[state]})))
 assert.notEqual(bytes,businessDefinitionCanonicalBody(readBusinessObjectTypeDefinitionV2({...object,fields:[money,state]})))
 assert.equal(createHash('sha256').update(bytes).digest('hex'),'8e5fd469af2764411dfe4925b715031a9c27e2007b08dbf5efa539ccf6937d2d')
})

test('v2 manifest 保持固定引用结构与页面身份校验，旧 manifest 读取器拒收',()=>{
 const manifest={...candidate,definitions:[{kind:'object-type',localId:'customer',version:1,definitionHash:'a'.repeat(64)}]}
 assert.deepEqual(readBusinessConfigurationManifestV2(manifest),manifest)
 assert.deepEqual(readBusinessConfigurationManifestVersioned(manifest),manifest)
 assert.throws(()=>readBusinessConfigurationManifest(manifest),invalid)
 assert.throws(()=>readBusinessConfigurationManifestV2({...manifest,pages:[{...records,objectType:'missing'}]}),invalid)
 assert.throws(()=>readBusinessConfigurationManifestV2({...manifest,definitions:[{...manifest.definitions[0],definitionHash:'bad'}]}),invalid)
})

test('v1 候选和声明规范哈希不受 v2 读取器影响',()=>{
 const legacyObject={...object,format:'teloa.business-object-type/v1',fields:[{name:'state',label:'状态',type:'text',required:true,from:'状态'}],id:'ticket',title:'工单',unit:'条',lead:'跟进事项'}
 const legacy={format:'teloa.business-configuration/v1',scope,title:'我的业务',sources:[source],definitions:[{kind:'object-type',definition:legacyObject}],pages:[{...records,objectType:'ticket',fields:['state']}],homePageId:'customers'}
 const before=businessDefinitionCanonicalBody(readBusinessObjectTypeDefinition(legacyObject))
 assert.equal(createHash('sha256').update(before).digest('hex'),'cc71f08bea4221bc1db6b9c29e4b3af9b9be5a5d10c19f003f534cb70200059a')
 assert.deepEqual(readBusinessConfigurationCandidateVersioned(legacy),readBusinessConfigurationCandidate(legacy))
 assert.throws(()=>readBusinessConfigurationCandidate({...legacy,definitions:[{kind:'object-type',definition:object}]}),invalid)
})

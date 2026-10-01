import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import type {PoolClient} from 'pg'
import {BusinessDefinitionSourceReader} from '../src/work/business-definition-source.ts'

const legacyDb={query:async(sql:string)=>{assert.match(sql,/^select to_regclass/);return {rows:[{scopes:null,heads:null,versions:null,leaves:null,leaf_heads:null}]}}} as unknown as PoolClient
const enc=new TextEncoder()
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex')

/** 规格 §12.1–12.3 的 SOC 声明样例：3 类型 / 3 视图 / 2 动作，外加它们引用的 2 份工作模板与 1 份数据源。 */
function socBundle(){
 return {
  domain:'SOC',
  objectTypes:[
   {format:'teloa.business-object-type/v1',id:'alert-ticket',version:'1.0.0',domain:'SOC',title:'告警工单',unit:'条',lead:'来自告警平台和终端记录，进来之后先归并再判断。',sourceId:'security-alert-http',fields:[
    {name:'severity',label:'严重度',type:'enum',required:true,from:'严重度',values:['高','中','低']},
    {name:'host',label:'主机',type:'text',required:true,from:'主机'},
    {name:'verdict',label:'当前判定',type:'enum',required:true,from:'当前判定',values:['还没有人看','正在核对','等你确认','已确认维护']},
    {name:'first-seen-at',label:'首次出现',type:'datetime',required:true,from:'首次出现'},
    {name:'account-count',label:'涉及账号数',type:'number',required:false,from:'涉及账号数'},
    {name:'incident',label:'关联调查',type:'reference',required:false,from:'关联调查',referenceType:'incident-ticket'},
   ],defaultAction:'assign-alert-review'},
   {format:'teloa.business-object-type/v1',id:'asset',version:'1.0.0',domain:'SOC',title:'资产',unit:'台',lead:'从资产台账同步，告警要落到具体机器上才查得下去。',sourceId:'security-alert-http',fields:[
    {name:'environment',label:'环境',type:'enum',required:true,from:'环境',values:['生产','测试']},
    {name:'owner-name',label:'负责人',type:'text',required:false,from:'负责人'},
    {name:'grade',label:'资产等级',type:'enum',required:false,from:'资产等级',values:['重要','一般']},
    {name:'registered-at',label:'接入时间',type:'datetime',required:false,from:'接入时间'},
   ]},
   {format:'teloa.business-object-type/v1',id:'incident-ticket',version:'1.0.0',domain:'SOC',title:'事件工单',unit:'件',lead:'告警里说不清的，立成一件调查，交给同事查到有结论为止。',sourceId:'security-alert-http',fields:[
    {name:'state',label:'当前状态',type:'enum',required:true,from:'当前状态',values:['进来的事','正在处理','需要你','已完成']},
    {name:'owner',label:'负责同事',type:'text',required:true,from:'负责同事'},
    {name:'opened-at',label:'立案时间',type:'datetime',required:true,from:'立案时间'},
    {name:'object-count',label:'用到的对象数',type:'number',required:false,from:'用到的对象数'},
    {name:'asset',label:'涉及资产',type:'reference',required:false,from:'涉及资产',referenceType:'asset'},
   ]},
  ],
  views:[
   {format:'teloa.business-view/v1',id:'soc-alert-trend',version:'1.0.0',domain:'SOC',title:'告警趋势',kind:'trend',chart:'line',objectType:'alert-ticket',
    dimension:{field:'first-seen-at',bucket:'day',limit:30},
    measures:[
     {id:'high',label:'高',aggregation:'count',where:{field:'severity',op:'eq',values:['高']}},
     {id:'med',label:'中',aggregation:'count',where:{field:'severity',op:'eq',values:['中']}},
     {id:'low',label:'低',aggregation:'count',where:{field:'severity',op:'eq',values:['低']}},
    ],filters:[],sort:{by:'dimension',direction:'asc'},window:{field:'first-seen-at',relative:'last-30d'},limit:30},
   {format:'teloa.business-view/v1',id:'soc-risk-distribution',version:'1.0.0',domain:'SOC',title:'风险分布',kind:'distribution',chart:'bar',objectType:'alert-ticket',
    dimension:{field:'severity',limit:3},measures:[{id:'total',label:'条数',aggregation:'count'}],filters:[{field:'verdict',op:'ne',values:['已确认维护']}],sort:{by:'measure',measureId:'total',direction:'desc'},limit:3},
   {format:'teloa.business-view/v1',id:'soc-pending-board',version:'1.0.0',domain:'SOC',title:'待处理告警',kind:'board-card',chart:'number',objectType:'alert-ticket',
    measures:[{id:'pending',label:'条',aggregation:'count'}],filters:[{field:'verdict',op:'in',values:['还没有人看','正在核对','等你确认']}],limit:1},
  ],
  actions:[
   {format:'teloa.business-action/v1',id:'assign-alert-review',version:'1.0.0',domain:'SOC',title:'交给同事核对',objectType:'alert-ticket',
    target:{kind:'work-template',localId:'alert-triage-review'},
    inputs:[{from:'field',field:'host'},{from:'object',part:'title'},{from:'object',part:'summary'}]},
   {format:'teloa.business-action/v1',id:'isolate-endpoint',version:'1.0.0',domain:'SOC',title:'隔离这台主机',objectType:'alert-ticket',
    target:{kind:'execution-tool',localId:'soc-endpoint-isolation',tool:'security.endpoint.isolate',workTemplate:'endpoint-isolation-record',targetFrom:{from:'field',field:'host'}},
    inputs:[{from:'object',part:'summary'},{from:'literal',value:'按告警工单发起，影响范围以资产台账为准。'}]},
  ],
  workTemplates:[
   {format:'teloa.work-template/v1',id:'alert-triage-review',title:'告警复核任务',version:'1.0.0',domain:'SOC',description:'核对告警并给出结论。',requirements:['主机','工单标题','工单摘要'],output:'复核结论',skills:[]},
   {format:'teloa.work-template/v1',id:'endpoint-isolation-record',title:'端点隔离记录',version:'1.0.0',domain:'SOC',description:'记录隔离动作。',requirements:['工单摘要','隔离说明'],output:'隔离记录',skills:[]},
  ],
  dataSources:[
   {format:'teloa.data-source/v1',sourceId:'security-alert-http',scopes:['SOC']},
  ],
  /** `isolate-endpoint` 的 `target.localId` 指的就是它：动作引用的执行工具必须是同一加载内的加载项（复审 MEDIUM-9）。 */
  executionTools:[{localId:'soc-endpoint-isolation',definition:{format:'teloa.execution-tool/v1',adapterId:'security-action-http',tools:['security.endpoint.isolate']}}],
 }
}

/** 一个只有单个对象类型（含自带数据源、无视图无动作）的最小声明包，用于验证 forScope 按 domain 过滤加载。 */
function appsecBundle(){
 return {
  domain:'AppSec',
  objectTypes:[
   {format:'teloa.business-object-type/v1',id:'vulnerability',version:'1.0.0',domain:'AppSec',title:'漏洞',unit:'个',lead:'来自漏洞扫描，按严重度分级处理。',sourceId:'appsec-scan-http',fields:[
    {name:'severity',label:'严重度',type:'enum',required:true,from:'严重度',values:['高','中','低']},
   ]},
  ],
  views:[],
  actions:[],
  workTemplates:[],
  dataSources:[{format:'teloa.data-source/v1',sourceId:'appsec-scan-http',scopes:['AppSec']}],
  executionTools:[],
 }
}

type SocBundle=ReturnType<typeof socBundle>
type FixtureOptions={
 itemKind?:string;status?:string;contentKind?:string;contentDrift?:boolean;manifestDrift?:boolean
 resourceVersionDrift?:boolean;publicSource?:boolean;providesDrift?:boolean;fileDrift?:boolean
 oversize?:boolean;notUtf8?:boolean;notJson?:boolean;activeSources?:Set<string>
 /** 把某个 localId 对应的加载项标记为合法跳过（required:false 且未打包），验证不拖垮同一加载里其余声明。 */
 skipLocalId?:string
 /** 把数据源加载项的状态设成给定值，钉 data-source 循环自己的状态白名单（复审 MEDIUM-1），与 `status`（只改第一份对象类型）分开。 */
 dataSourceStatus?:string
}

/** 夹具形状逐条照 `industry-data-source-source.test.ts:10-24`：假市场内容 + 假加载 + 计数器，只把资源换成三类声明。 */
function buildLoad(value:SocBundle,options:FixtureOptions={},owner=randomUUID(),loadId=randomUUID()){
 const contentId=randomUUID(),contentHash='a'.repeat(64),templateId='security',templateVersion='1.0.0'
 const bytes:Record<string,Uint8Array>=Object.create(null)
 const resources:Array<{id:string;kind:string;title:string;version:string;required:boolean;source:{kind:'local';path:string}|{kind:'public';id:string;version:string}}>=[]
 const items:Array<{localId:string;instanceId:string;kind:string;title:string;version:string;required:boolean;status:string}>=[]
 const provides:Array<{resourceId:string;kind:string;version:string;path:string}>=[]
 const files:Array<{path:string;hash:string;bytes:Uint8Array}>=[]

 const add=(kind:string,localId:string,version:string,definition:unknown,pathPrefix:string)=>{
  const path=pathPrefix+'/'+localId+'.json'
  const rawBytes=enc.encode(JSON.stringify(definition))
  bytes[path]=rawBytes
  resources.push({id:localId,kind,title:localId,version,required:true,source:{kind:'local',path}})
  provides.push({resourceId:localId,kind,version,path})
  files.push({path,hash:sha(rawBytes),bytes:rawBytes})
  items.push({localId,instanceId:randomUUID(),kind,title:localId,version,required:true,status:'pending-adapter'})
 }
 for(const definition of value.objectTypes)add('object-type',definition.id,definition.version,definition,'object-types')
 for(const definition of value.views)add('business-view',definition.id,definition.version,definition,'views')
 for(const definition of value.actions)add('business-action',definition.id,definition.version,definition,'actions')
 for(const definition of value.workTemplates)add('work-template',definition.id,definition.version,definition,'work-templates')
 for(const definition of value.dataSources)add('data-source',definition.sourceId,'1.0.0',definition,'data-sources')
 for(const tool of value.executionTools)add('execution-tool',tool.localId,'1.0.0',tool.definition,'connections')

 // 单项漂移选项全部作用在第一份对象类型声明（alert-ticket）上，够覆盖读取层共用的那条九步核对。
 if(options.itemKind!==undefined)items[0]!.kind=options.itemKind
 if(options.status!==undefined)items[0]!.status=options.status
 if(options.resourceVersionDrift)resources[0]!.version='9.9.9'
 if(options.publicSource)resources[0]!.source={kind:'public',id:resources[0]!.id,version:resources[0]!.version}
 if(options.providesDrift)provides[0]!.resourceId='wrong-local-id'
 if(options.fileDrift)files[0]!.hash='d'.repeat(64)
 if(options.oversize){const big=enc.encode(JSON.stringify(value.objectTypes[0])+' '.repeat(130*1024));files[0]!.bytes=big;files[0]!.hash=sha(big);bytes[files[0]!.path]=big}
 if(options.notUtf8){const bad=Uint8Array.from([0xff,0xfe,0xfd]);files[0]!.bytes=bad;files[0]!.hash=sha(bad);bytes[files[0]!.path]=bad}
 if(options.notJson){const bad=enc.encode('not json {');files[0]!.bytes=bad;files[0]!.hash=sha(bad);bytes[files[0]!.path]=bad}
 if(options.skipLocalId!==undefined){
  const resource=resources.find(candidate=>candidate.id===options.skipLocalId),item=items.find(candidate=>candidate.localId===options.skipLocalId)
  if(!resource||!item)throw new Error('夹具里没有这个 localId：'+options.skipLocalId)
  resource.required=false;item.required=false;item.status='skipped'
 }
 if(options.dataSourceStatus!==undefined){
  const item=items.find(candidate=>candidate.kind==='data-source')
  if(!item)throw new Error('夹具里没有 data-source 项')
  item.status=options.dataSourceStatus
 }

 const manifest={
  format:'teloa.business-package/v2',id:options.manifestDrift?'wrong-template':templateId,title:'安全运营',
  version:templateVersion,domain:value.domain,scope:value.domain,description:'安全模板',resources,relations:[],entrypoints:[],
 }
 const load={
  id:loadId,ownerId:owner,contentId,contentHash,templateId,templateVersion,templateTitle:'安全运营',domain:value.domain,scope:value.domain,
  description:'安全模板',targetVersion:1,space:{id:randomUUID(),name:value.domain,version:1,scope:value.domain},
  items,relations:[],entrypoints:[],createdAt:new Date().toISOString(),mappingHash:'e'.repeat(64),status:'active' as const,
 }
 const content={
  id:contentId,ownerId:owner,kind:options.contentKind??'industry-template',logicalId:templateId,version:templateVersion,
  hash:options.contentDrift?'b'.repeat(64):contentHash,baseHash:'c'.repeat(64),manifestPath:'teloa.json',metadata:manifest,
  files,provides,references:[],createdAt:new Date().toISOString(),
 }
 const activeSources=options.activeSources??new Set(value.dataSources.map(definition=>definition.sourceId))
 return {owner,loadId,contentId,load,content,bytes,activeSources}
}

function fixture(value:SocBundle,options:FixtureOptions={}){
 const built=buildLoad(value,options)
 const loadsById=new Map([[built.loadId,built.load]])
 const reader=new BusinessDefinitionSourceReader(
  {get:async()=>{throw new Error('未预期调用')},getInTransaction:async()=>built.content as never},
  {get:async()=>{throw new Error('未预期调用')},getInTransaction:async()=>built.load as never,listInTransaction:async()=>({items:[...loadsById.values()]}) as never},
  {activeSourceIds:async()=>built.activeSources},
 )
 return {owner:built.owner,loadId:built.loadId,bytes:built.bytes,reader}
}

function fixtureTwoLoads(a:SocBundle,b:SocBundle,locals?:unknown[]){
 const owner=randomUUID()
 const builtA=buildLoad(a,{},owner),builtB=buildLoad(b,{},owner)
 const loadsById=new Map<string,typeof builtA.load>([[builtA.loadId,builtA.load],[builtB.loadId,builtB.load]])
 const contentsById=new Map<string,typeof builtA.content>([[builtA.contentId,builtA.content],[builtB.contentId,builtB.content]])
 const reader=new BusinessDefinitionSourceReader(
  {get:async()=>{throw new Error('未预期调用')},getInTransaction:async(_db,_actor,input:unknown)=>contentsById.get((input as {contentId:string}).contentId) as never},
  {get:async()=>{throw new Error('未预期调用')},getInTransaction:async(_db,_owner,input:unknown)=>loadsById.get((input as {loadId:string}).loadId) as never,listInTransaction:async()=>({items:[...loadsById.values()]}) as never},
  {activeSourceIds:async()=>builtA.activeSources},
  ...(locals?[{currentInTransaction:async()=>locals as never}]:[]),
 )
 return {owner,reader}
}

test('读出三类声明并算出稳定 definitionHash',async()=>{
 const f=fixture(socBundle()),bundle=await f.reader.bundle({} as PoolClient,f.owner,f.loadId)
 assert.deepEqual(bundle.objectTypes.map(row=>row.definition.id),['alert-ticket','asset','incident-ticket'])
 assert.equal(bundle.views.length,3)
 assert.equal(bundle.actions.length,2)
 const again=await f.reader.bundle({} as PoolClient,f.owner,f.loadId)
 assert.deepEqual(bundle.objectTypes.map(row=>row.source.definitionHash),again.objectTypes.map(row=>row.source.definitionHash),'同一份字节两次读出同一个摘要')
 assert.equal(bundle.objectTypes[0]!.source.fileHash,sha(f.bytes['object-types/alert-ticket.json']!))
})

test('definitionHash 不含 loadId：同一份字节换一个加载仍是同一个摘要',async()=>{
 // 两次 `buildLoad` 各自生成新的 loadId 与 contentId，但字节、localId、版本、contentHash 逐字相同——
 // 这正是"导出后重新导入到另一个空间"的形状。摘要含 loadId 时这里必然不等，界面会把没改过的声明标成「已更新」（复审 HIGH-4）。
 const first=fixture(socBundle()),second=fixture(socBundle())
 assert.notEqual(first.loadId,second.loadId)
 const a=await first.reader.bundle({} as PoolClient,first.owner,first.loadId)
 const b=await second.reader.bundle({} as PoolClient,second.owner,second.loadId)
 assert.deepEqual(a.objectTypes.map(row=>row.source.definitionHash),b.objectTypes.map(row=>row.source.definitionHash))
 assert.deepEqual(a.views.map(row=>row.source.definitionHash),b.views.map(row=>row.source.definitionHash))
 assert.notEqual(a.objectTypes[0]!.source.loadId,b.objectTypes[0]!.source.loadId,'loadId 本身仍如实回报，只是不入摘要')
})

test('动作引用的执行工具必须是同一加载内 kind 对得上的加载项',async()=>{
 // 悬空：声明里写了一个这个加载根本没有的执行工具标识。
 const missing=socBundle();missing.executionTools=[]
 const a=fixture(missing)
 await assert.rejects(a.reader.bundle({} as PoolClient,a.owner,a.loadId),{code:'teloa/source-unavailable'})
 // 撞名：标识确实存在，但那是一个工作模板加载项，不是执行工具。
 const wrongKind=socBundle();wrongKind.executionTools=[]
 ;(wrongKind.actions[1]!.target as {localId:string}).localId='alert-triage-review'
 const b=fixture(wrongKind)
 await assert.rejects(b.reader.bundle({} as PoolClient,b.owner,b.loadId),{code:'teloa/source-unavailable'})
})

test('九步核对逐条失败都落 teloa/source-unavailable',async()=>{
 const cases:FixtureOptions[]=[
  {itemKind:'plan'},{status:'skipped'},{contentKind:'atomic-skill'},{contentDrift:true},{manifestDrift:true},
  {resourceVersionDrift:true},{publicSource:true},{providesDrift:true},{fileDrift:true},{oversize:true},{notUtf8:true},{notJson:true},
 ]
 for(const options of cases){
  const f=fixture(socBundle(),options)
  await assert.rejects(f.reader.bundle({} as PoolClient,f.owner,f.loadId),{code:'teloa/source-unavailable'},JSON.stringify(options))
 }
})

test('四条跨引用核对',async()=>{
 const cases:Array<(bundle:SocBundle)=>void>=[
  bundle=>{bundle.views[0]!.objectType='not-there'},
  bundle=>{(bundle.views[0]!.dimension as {field:string}).field='nope'},
  bundle=>{bundle.views[0]!.measures=[{id:'m',label:'甲',aggregation:'sum',field:'host'}] as unknown as (typeof bundle.views)[number]['measures']},
  bundle=>{(bundle.actions[0]!.target as {localId:string}).localId='not-a-template'},
  bundle=>{bundle.actions[0]!.inputs=bundle.actions[0]!.inputs.slice(1)},
  bundle=>{bundle.objectTypes[0]!.defaultAction='nope'},
  bundle=>{bundle.objectTypes[0]!.sourceId='unknown-source'},
  bundle=>{bundle.views[0]!.domain='AppSec'},
 ]
 // 末条（domain 不一致）是声明本身的问题，不是跨引用；其余七条都带 details.crossReference，预览据此把草案造成的失败改报 invalid-input。
 for(const [index,mutate] of cases.entries()){
  const value=socBundle();mutate(value)
  const f=fixture(value)
  await assert.rejects(f.reader.bundle({} as PoolClient,f.owner,f.loadId),(error:{code:string;details?:Record<string,unknown>})=>error.code==='teloa/source-unavailable'&&(error.details?.crossReference===true)===(index<7),'第 '+index+' 条应被拒绝')
 }
})

test('九步核对与加载列表层的失败不带 crossReference 标记（库里已有的问题不算到草案头上）',async()=>{
 const f=fixture(socBundle(),{fileDrift:true})
 await assert.rejects(f.reader.bundle({} as PoolClient,f.owner,f.loadId),(error:{code:string;details?:unknown})=>error.code==='teloa/source-unavailable'&&error.details===undefined)
 const twice=fixtureTwoLoads(socBundle(),socBundle())
 await assert.rejects(twice.reader.forScope(legacyDb,twice.owner,'SOC'),(error:{code:string;details?:unknown})=>error.code==='teloa/source-unavailable'&&error.details===undefined)
})

test('数据源未连接时对象类型仍可读，只是标未接上',async()=>{
 const f=fixture(socBundle(),{activeSources:new Set<string>()})
 const bundle=await f.reader.bundle({} as PoolClient,f.owner,f.loadId)
 assert.equal(bundle.objectTypes.length,3)
 assert.deepEqual(bundle.sources.get('security-alert-http'),{connected:false})
})

test('同一范围内同 localId 的声明来自两个加载即整条拒绝',async()=>{
 const f=fixtureTwoLoads(socBundle(),socBundle())
 await assert.rejects(f.reader.forScope(legacyDb,f.owner,'SOC'),{code:'teloa/source-unavailable'})
})

test('forScope 按 domain 过滤加载，不属于查询范围的加载不参与也不报错',async()=>{
 const f=fixtureTwoLoads(socBundle(),appsecBundle())
 const bundles=await f.reader.forScope(legacyDb,f.owner,'SOC')
 assert.equal(bundles.length,1)
 assert.equal(bundles[0]!.domain,'SOC')
 assert.deepEqual(bundles[0]!.objectTypes.map(row=>row.definition.id),['alert-ticket','asset','incident-ticket'])
})

test('可选业务视图被合法跳过，其余对象类型与视图正常读出',async()=>{
 const f=fixture(socBundle(),{skipLocalId:'soc-pending-board'})
 const bundle=await f.reader.bundle({} as PoolClient,f.owner,f.loadId)
 assert.equal(bundle.objectTypes.length,3)
 assert.deepEqual(bundle.views.map(row=>row.definition.id),['soc-alert-trend','soc-risk-distribution'])
})

test('数据源加载项处于未授权投影状态（instantiated）时仍可读出全部声明，不判整条加载不可用',async()=>{
 // `needs_authorization` 这类实例态在读取时投影为 `instantiated`（`industry-loads.ts` 的 `projectStatus`），
 // 与「未连接时对象类型仍可见」（规格 §3.3）不冲突——data-source 循环的白名单必须放行它，不能只认 pending-adapter。
 const f=fixture(socBundle(),{dataSourceStatus:'instantiated',activeSources:new Set<string>()})
 const bundle=await f.reader.bundle({} as PoolClient,f.owner,f.loadId)
 assert.equal(bundle.objectTypes.length,3)
 assert.deepEqual(bundle.sources.get('security-alert-http'),{connected:false},'未连接是另一层判据，不代表声明读不出来')
})

test('数据源加载项状态不在白名单内（既非 skipped 也非四个已知投影值）时整条加载拒绝',async()=>{
 const f=fixture(socBundle(),{dataSourceStatus:'bogus'})
 await assert.rejects(f.reader.bundle({} as PoolClient,f.owner,f.loadId),{code:'teloa/source-unavailable'})
})

test('forScope 在同一个调用方事务里取加载列表，不另开一份 list() 快照',async()=>{
 // 行为断言取代此前的源码文本正则匹配（复审 LOW-2）：`loads` 的构造依赖类型本就只有
 // `'get'|'getInTransaction'|'listInTransaction'`（不含 `'list'`），`this.loads.list(` 连编译都过不去——
 // 真正需要钉住的是"同一个 db 句柄"这条运行时事实，改格式、加换行、换变量名都不该让它假红或假绿。
 const built=buildLoad(socBundle())
 const marker={...legacyDb,tag:'调用方事务'} as unknown as PoolClient
 let seenDb:PoolClient|undefined
 const loads={
  get:async()=>{throw new Error('未预期调用')},
  getInTransaction:async()=>built.load as never,
  listInTransaction:async(db:PoolClient)=>{seenDb=db;return {items:[built.load]} as never},
 }
 const reader=new BusinessDefinitionSourceReader(
  {get:async()=>{throw new Error('未预期调用')},getInTransaction:async()=>built.content as never},
  loads,
  {activeSourceIds:async()=>built.activeSources},
 )
 const bundles=await reader.forScope(marker,built.owner,'SOC')
 assert.equal(seenDb,marker,'forScope 必须把调用方传入的 db 原样交给 listInTransaction，不能另开连接取一份独立快照')
 assert.equal(bundles.length,1)
})

/** 本地声明读口的假注入：当前生效的每条都按正文原样带出，由读取器自己再过一遍 read*。 */
function localCurrent(kind:string,definition:{id:string;version:string}){
 const body=JSON.stringify(definition)
 return {kind,localId:definition.id,version:1,semver:definition.version,definitionHash:'f'.repeat(64),bodyHash:createHash('sha256').update(body).digest('hex'),body} as never
}
function fixtureWithLocal(value:SocBundle,locals:unknown[]){
 const built=buildLoad(value)
 const reader=new BusinessDefinitionSourceReader(
  {get:async()=>{throw new Error('未预期调用')},getInTransaction:async()=>built.content as never},
  {get:async()=>{throw new Error('未预期调用')},getInTransaction:async()=>built.load as never,listInTransaction:async()=>({items:[built.load]}) as never},
  {activeSourceIds:async()=>built.activeSources},
  {currentInTransaction:async()=>locals as never},
 )
 return {owner:built.owner,reader}
}
const socMapping=(overrides:Record<string,unknown>={})=>({
 format:'teloa.business-source-mapping/v1',id:'alert-sync',version:'1.0.0',domain:'SOC',title:'告警同步',objectType:'alert-ticket',
 source:{kind:'business-data-port',sourceId:'security-alert-http'},
 mapping:[{path:'$.host',field:'host'},{path:'$.severity',field:'severity'},{path:'$.title',field:'title'},{path:'$.at',field:'observedAt'}],
 primaryKey:['host'],deletionSemantics:'compare',schedule:{kind:'every',seconds:300},acknowledgeShortInterval:false,...overrides,
})
const widgetHead={format:'teloa.business-widget/v1',version:'1.0.0',domain:'SOC',title:'告警'}
const sqlWidget={...widgetHead,id:'alert-count',kind:'metric',query:'select count(*) as n from alert_ticket',metric:{valueColumn:'n'}}
const refWidget=(viewRef='soc-risk-distribution')=>({...widgetHead,id:'risk-ref',kind:'view-ref',viewRef})
const socDashboard=(widgets=['alert-count','risk-ref'])=>({
 format:'teloa.business-dashboard/v1',id:'soc-overview',version:'1.0.0',domain:'SOC',title:'安全运营大盘',widgets,
 layout:widgets.map((widget,index)=>({widget,x:index*6,y:0,w:6,h:2})),refresh:{kind:'every',seconds:300},acknowledgeShortInterval:false,
})

test('forScope 声明包三组扩展：无本地声明时为空数组，台账三类不变',async()=>{
 const f=fixture(socBundle())
 const [bundle]=await f.reader.forScope(legacyDb,f.owner,'SOC')
 assert.deepEqual([bundle!.mappings,bundle!.widgets,bundle!.dashboards],[[],[],[]])
 assert.deepEqual([bundle!.objectTypes.length,bundle!.views.length,bundle!.actions.length],[3,3,2])
})

test('forScope 合并本地数据源映射、组件与看板进对应数组',async()=>{
 const f=fixtureWithLocal(socBundle(),[localCurrent('dashboard',socDashboard()),localCurrent('widget',refWidget()),localCurrent('widget',sqlWidget),localCurrent('source-mapping',socMapping())])
 const bundles=await f.reader.forScope(legacyDb,f.owner,'SOC')
 assert.equal(bundles.length,1)
 const [bundle]=bundles
 assert.deepEqual(bundle!.mappings.map(row=>[row.definition.id,row.source.origin]),[['alert-sync','local']])
 assert.deepEqual(bundle!.widgets.map(row=>row.definition.id).sort(),['alert-count','risk-ref'])
 assert.deepEqual(bundle!.dashboards.map(row=>row.definition.id),['soc-overview'])
})

test('forScope 三组跨引用：看板组件、组件视图、映射对象类型与目标字段缺一即 source-unavailable',async()=>{
 const cases:Array<[string,unknown[]]>=[
  ['看板引用不存在的组件',[localCurrent('widget',sqlWidget),localCurrent('dashboard',socDashboard(['alert-count','nope']))]],
  ['看板第一个组件就不存在',[localCurrent('dashboard',socDashboard(['nope']))]],
  ['组件 viewRef 指向不存在的视图',[localCurrent('widget',refWidget('no-such-view'))]],
  ['映射目标对象类型不存在',[localCurrent('source-mapping',socMapping({objectType:'no-such-type'}))]],
  ['映射目标字段不在对象类型里',[localCurrent('source-mapping',socMapping({mapping:[{path:'$.host',field:'host'},{path:'$.x',field:'no-such-field'}]}))]],
 ]
 for(const [name,locals] of cases){
  const f=fixtureWithLocal(socBundle(),locals)
  await assert.rejects(f.reader.forScope(legacyDb,f.owner,'SOC'),(error:{code:string;details?:Record<string,unknown>})=>error.code==='teloa/source-unavailable'&&error.details?.crossReference===true,name)
 }
 // 合并后加载内核对失败：文案末尾指名本次合并的本地声明，且 crossReference 标记随之保留，不因包装丢掉。
 const wrapped=fixtureWithLocal(socBundle(),[localCurrent('source-mapping',socMapping({mapping:[{path:'$.host',field:'host'},{path:'$.x',field:'no-such-field'}]}))])
 await assert.rejects(wrapped.reader.forScope(legacyDb,wrapped.owner,'SOC'),(error:{message:string;details?:Record<string,unknown>})=>error.message.startsWith('数据源映射的目标字段不在对象类型声明里。（本次合并的本地定制声明：source-mapping:alert-sync）')&&JSON.stringify(error.details)==='{"crossReference":true}','包装只转发 crossReference 一项')
})

test('forScope 看板引用组件按范围核对：view-ref 组件与 SQL 组件分处两个加载时仍可同放一张看板',async()=>{
 // 第二个 SOC 加载：自带对象类型与视图；view-ref 组件落在它这里，SQL 组件落在范围第一个加载（socBundle）。
 const vuln={
  domain:'SOC',
  objectTypes:[{format:'teloa.business-object-type/v1',id:'vulnerability',version:'1.0.0',domain:'SOC',title:'漏洞',unit:'个',lead:'来自漏洞扫描。',sourceId:'soc-vuln-http',fields:[
   {name:'severity',label:'严重度',type:'enum',required:true,from:'严重度',values:['高','中','低']},
  ]}],
  views:[{format:'teloa.business-view/v1',id:'soc-vuln-distribution',version:'1.0.0',domain:'SOC',title:'漏洞分布',kind:'distribution',chart:'bar',objectType:'vulnerability',
   dimension:{field:'severity',limit:3},measures:[{id:'total',label:'个数',aggregation:'count'}],filters:[],sort:{by:'measure',measureId:'total',direction:'desc'},limit:3}],
  actions:[],workTemplates:[],dataSources:[{format:'teloa.data-source/v1',sourceId:'soc-vuln-http',scopes:['SOC']}],executionTools:[],
 } as unknown as SocBundle
 const locals=[localCurrent('widget',refWidget('soc-vuln-distribution')),localCurrent('widget',sqlWidget),localCurrent('dashboard',socDashboard(['risk-ref','alert-count']))]
 const f=fixtureTwoLoads(socBundle(),vuln,locals)
 const bundles=await f.reader.forScope(legacyDb,f.owner,'SOC')
 assert.deepEqual(bundles.map(bundle=>bundle.widgets.map(row=>row.definition.id)),[['alert-count'],['risk-ref']])
 assert.deepEqual(bundles.flatMap(bundle=>bundle.dashboards.map(row=>row.definition.id)),['soc-overview'])
 // 范围内确实没有的组件照样拒绝。
 const missing=fixtureTwoLoads(socBundle(),vuln,[...locals.slice(0,2),localCurrent('dashboard',socDashboard(['risk-ref','nope']))])
 await assert.rejects(missing.reader.forScope(legacyDb,missing.owner,'SOC'),(error:{code:string;details?:Record<string,unknown>})=>error.code==='teloa/source-unavailable'&&error.details?.crossReference===true,'范围级看板核对同样带 crossReference')
})

test('forScope 范围内只有不含业务声明的加载：SQL 组件与看板落在范围第一个加载，列表照常读出',async()=>{
 // 形如市场 teloa.soc：有数据源、工作模板等资源，但没有对象类型/视图/动作。
 const bare={...socBundle(),objectTypes:[],views:[],actions:[]}
 const constant={...sqlWidget,query:'select 42 as n'}
 const built=buildLoad(bare)
 const reader=new BusinessDefinitionSourceReader(
  {get:async()=>{throw new Error('未预期调用')},getInTransaction:async()=>built.content as never},
  {get:async()=>{throw new Error('未预期调用')},getInTransaction:async()=>built.load as never,listInTransaction:async()=>({items:[built.load]}) as never},
  {activeSourceIds:async()=>built.activeSources},
  {currentInTransaction:async()=>[localCurrent('widget',constant),localCurrent('dashboard',socDashboard(['alert-count']))] as never},
 )
 const bundles=await reader.forScope(legacyDb,built.owner,'SOC')
 assert.deepEqual(bundles.map(bundle=>[bundle.origin.kind==='market'?bundle.origin.loadId:null,bundle.widgets.map(row=>row.definition.id),bundle.dashboards.map(row=>row.definition.id)]),[[built.loadId,['alert-count'],['soc-overview']]])
 // 没有本地声明时，不含声明的加载照旧不计入。
 const plain=fixture(bare)
 assert.deepEqual(await plain.reader.forScope(legacyDb,plain.owner,'SOC'),[])
})

test('forScope 范围内没有任何生效加载：本地声明无处挂载按空读出；试算覆盖仍报 source-unavailable',async()=>{
 const reader=new BusinessDefinitionSourceReader(
  {get:async()=>{throw new Error('未预期调用')},getInTransaction:async()=>{throw new Error('未预期调用')}},
  {get:async()=>{throw new Error('未预期调用')},getInTransaction:async()=>{throw new Error('未预期调用')},listInTransaction:async()=>({items:[]}) as never},
  {activeSourceIds:async()=>new Set()},
  {currentInTransaction:async()=>[localCurrent('widget',sqlWidget),localCurrent('dashboard',socDashboard(['alert-count']))] as never},
 )
 assert.deepEqual(await reader.forScope(legacyDb,'owner','SOC'),[])
 await assert.rejects(reader.forScope(legacyDb,'owner','SOC',{kind:'widget',localId:'alert-count',body:JSON.stringify(sqlWidget)}),(error:{code:string;details?:Record<string,unknown>})=>error.code==='teloa/source-unavailable'&&error.details?.crossReference===true,'落点定不下来属范围级合并核对，带 crossReference')
})

test('forScope 时间范围范围级核对：timeFilter 表 / 列须是本范围对象类型的时间字段或系统时间列；带 filters 的看板至少一个组件接入；失败带 crossReference',async()=>{
 const bound=(column:string,table='alert_ticket')=>({...sqlWidget,timeFilter:{table,column}})
 const ranged=(widgets=['alert-count'])=>({...socDashboard(widgets),filters:{timeRange:{options:['7d','30d','all'],default:'7d'}}})
 for(const column of ['first-seen-at','_observed_at','_synced_at']){
  const f=fixtureWithLocal(socBundle(),[localCurrent('widget',bound(column)),localCurrent('dashboard',ranged())])
  const [bundle]=await f.reader.forScope(legacyDb,f.owner,'SOC')
  assert.deepEqual(bundle!.widgets[0]!.definition.timeFilter,{table:'alert_ticket',column},column)
  assert.deepEqual(bundle!.dashboards[0]!.definition.filters,{timeRange:{options:['7d','30d','all'],default:'7d'}})
 }
 // 接入的表在范围里另一个对象类型上同样成立（不要求与组件同一加载）。
 const other=fixtureWithLocal(socBundle(),[localCurrent('widget',bound('opened-at','incident_ticket')),localCurrent('dashboard',ranged())])
 assert.equal((await other.reader.forScope(legacyDb,other.owner,'SOC'))[0]!.widgets.length,1)
 const rejects=async(locals:ReturnType<typeof localCurrent>[],reason:RegExp,name:string)=>{
  const f=fixtureWithLocal(socBundle(),locals)
  await assert.rejects(f.reader.forScope(legacyDb,f.owner,'SOC'),(error:{code:string;message:string;details?:Record<string,unknown>})=>
   error.code==='teloa/source-unavailable'&&error.details?.crossReference===true&&reason.test(error.message)||assert.fail(name+' → '+JSON.stringify(error)),name)
 }
 await rejects([localCurrent('widget',bound('account-count'))],/alert-count.*account-count.*时间字段/,'number 字段')
 await rejects([localCurrent('widget',bound('severity'))],/时间字段/,'enum 字段')
 await rejects([localCurrent('widget',bound('nope'))],/时间字段/,'未声明列')
 await rejects([localCurrent('widget',bound('first-seen-at','no_such_table'))],/no_such_table.*不是本业务范围/,'表不在本范围')
 await rejects([localCurrent('widget',sqlWidget),localCurrent('dashboard',ranged())],/^业务看板 soc-overview 声明了时间范围，但没有任何组件接入/,'带 filters 却无接入组件')
 // 同一范围里没有 filters 的看板放接入组件照常（组件结果按 all 算）。
 const plain=fixtureWithLocal(socBundle(),[localCurrent('widget',bound('first-seen-at')),localCurrent('dashboard',socDashboard(['alert-count']))])
 assert.equal((await plain.reader.forScope(legacyDb,plain.owner,'SOC'))[0]!.dashboards.length,1)
})

test('forScope 下钻范围级核对：目标须是本范围有清单视图的对象类型，match.field 须是可等值的声明字段；失败带 crossReference',async()=>{
 const listView={format:'teloa.business-view/v1',id:'soc-alert-list',version:'1.0.0',domain:'SOC',title:'告警清单',kind:'list',chart:'table',objectType:'alert-ticket',
  measures:[{id:'accounts',label:'涉及账号数',aggregation:'max',field:'account-count'}],filters:[],sort:{by:'dimension',direction:'asc'},limit:100}
 const listed=()=>({...socBundle(),views:[...socBundle().views,listView]}) as SocBundle
 const table=(drilldown:Record<string,unknown>)=>({...widgetHead,id:'alert-table',kind:'table',query:'select _id, severity from alert_ticket',drilldown})
 for(const drilldown of [
  {objectType:'alert-ticket'},
  {objectType:'alert-ticket',idColumn:'_id'},
  {objectType:'alert-ticket',match:{column:'severity',field:'severity'}},
  {objectType:'alert-ticket',match:{column:'host',field:'host'}},
  {objectType:'alert-ticket',match:{column:'incident',field:'incident'}},
 ]){
  const f=fixtureWithLocal(listed(),[localCurrent('widget',table(drilldown))])
  const [bundle]=await f.reader.forScope(legacyDb,f.owner,'SOC')
  assert.deepEqual(bundle!.widgets[0]!.definition.drilldown,drilldown,JSON.stringify(drilldown))
 }
 const rejects=async(value:SocBundle,drilldown:Record<string,unknown>,reason:RegExp,name:string)=>{
  const f=fixtureWithLocal(value,[localCurrent('widget',table(drilldown))])
  await assert.rejects(f.reader.forScope(legacyDb,f.owner,'SOC'),(error:{code:string;message:string;details?:Record<string,unknown>})=>
   error.code==='teloa/source-unavailable'&&error.details?.crossReference===true&&reason.test(error.message)||assert.fail(name+' → '+JSON.stringify(error)),name)
 }
 await rejects(socBundle(),{objectType:'alert-ticket'},/^业务组件 alert-table 的下钻目标对象类型 alert-ticket 没有清单视图/,'目标类型无 list 视图')
 await rejects(listed(),{objectType:'no-such-type'},/no-such-type.*不是本业务范围/,'目标类型不在本范围')
 await rejects(listed(),{objectType:'alert-ticket',match:{column:'seen',field:'first-seen-at'}},/first-seen-at.*取值/,'datetime 字段')
 await rejects(listed(),{objectType:'alert-ticket',match:{column:'n',field:'account-count'}},/account-count.*取值/,'number 字段')
 await rejects(listed(),{objectType:'alert-ticket',match:{column:'x',field:'nope'}},/nope.*取值/,'未声明字段')
})

import {createHash} from 'node:crypto'
import type {PoolClient} from 'pg'
import {
 readBusinessConfigurationCandidate,readBusinessConfigurationCandidateVersioned,businessConfigurationFormatV2,readBusinessObjectTypeDefinitionVersioned,readBusinessViewDefinitionVersioned,assertBusinessViewV2References,WorkError,readIndustryDataSourceDefinition,type IndustryDataSourceDefinition,
 readBusinessObjectTypeDefinition,readBusinessViewDefinition,readBusinessActionDefinition,businessFieldCapabilities,
 readBusinessDefinitionBody,businessDefinitionKinds,businessMappingPlatformFields,businessLedgerLimits,
 type BusinessDefinitionKind,type BusinessFieldType,type BusinessObjectTypeDefinitionV2,type BusinessViewDefinitionV2,
 type BusinessObjectTypeRecord,type BusinessViewRecord,type BusinessActionRecord,type BusinessDefinitionSource,
 type BusinessSourceMappingRecord,type BusinessWidgetRecord,type BusinessDashboardRecord,
} from '@teloa/contract'
import {validateManifest,type MarketContentStore} from '../market/content-store.ts'
import type {IndustryLoadService,IndustryLoadItemStatus,IndustryLoadRecord} from './industry-loads.ts'
import {businessLocalDefinitionHash,businessLocalDefinitionSchema,type BusinessLocalCurrent,type BusinessLocalDefinitionService} from './business-definition-local.ts'
import {BusinessConfigurationStore,businessConfigurationHash,readBusinessConfigurationManagement} from './business-configuration-store.ts'
import {prepareBusinessConfigurationDefinition} from './business-definition-write.ts'
import {rewriteBusinessWidgetSql} from './business-sql-rewrite.ts'
import {IndustryWorkSource} from './industry-work-source.ts'

export type BusinessDefinitionBundle={
 origin:{kind:'market';loadId:string}|{kind:'local-configuration';configurationVersion:number;configurationHash:string}|{kind:'configuration-preview';configurationHash:string}
 scope:string
 domain:string
 objectTypes:BusinessObjectTypeRecord[]
 views:BusinessViewRecord[]
 actions:BusinessActionRecord[]
 /** 数据源映射、组件、看板：一期只来自本地声明，模板来源恒为空数组（方案包 v3 不在本期）。 */
 mappings:BusinessSourceMappingRecord[]
 widgets:BusinessWidgetRecord[]
 dashboards:BusinessDashboardRecord[]
 /** 市场来源记录实例 active 状态；已核验本地记录来源直接可读。 */
 sources:Map<string,{connected:boolean;sourceNoun?:string}>
}
export type BusinessObjectTypeRecordVersioned=Omit<BusinessObjectTypeRecord,'definition'>&{definition:BusinessObjectTypeRecord['definition']|BusinessObjectTypeDefinitionV2}
export type BusinessViewRecordVersioned=Omit<BusinessViewRecord,'definition'>&{definition:BusinessViewRecord['definition']|BusinessViewDefinitionV2}
export type BusinessDefinitionBundleVersioned=Omit<BusinessDefinitionBundle,'objectTypes'|'views'>&{objectTypes:BusinessObjectTypeRecordVersioned[];views:BusinessViewRecordVersioned[]}

const unavailable=(message:string)=>new WorkError('teloa/source-unavailable',message)
/**
 * 跨引用核对失败（加载内四条 + 范围级合并核对）：码与文案同 `unavailable`，另带 `details:{crossReference:true}`。
 * 预览据此区分"草案造成的核对失败"（改报 `teloa/invalid-input` 带原因）与"库里已生效声明本身读不出来"（照旧 `source-unavailable`）。
 */
const unresolved=(message:string)=>new WorkError('teloa/source-unavailable',message,{crossReference:true})
/** 下钻 `match` 与台账 `match` 只对这四种字段做等值（二期规格 §4.2）：两处同一判据，由这里一处给出。 */
export const equatableFieldTypes:ReadonlySet<BusinessFieldType>=new Set(['text','enum','reference','boolean'])

/**
 * 预览试算的不落库覆盖：正文来自入参而不是三张本地表，其余与当前生效的本地声明走**同一段**合并代码
 *（同 localId 原地覆盖、跨引用原样再跑一遍）。只有这样"按草案试算出来的块"才与"确认之后的台账"逐字相同；
 * 另写一条不过跨引用的试算路径，等于让用户预览到一份生效之后台账读不出来的声明（规格 §6.3 四段路径同一条判据）。
 */
export type BusinessLedgerOverride={kind:BusinessDefinitionKind;localId:string;body:string}

/**
 * definitionHash 与 IndustryDataSourceBinding.definitionHash 同规矩：把"这份声明是谁、在哪一份固定内容里、
 * 是哪一版字节"整体入摘要，任何一项变了摘要就变，界面据此整条作废重算（规格 §8 第 5 条）。
 * 不把 definition 正文再塞一遍：fileHash 已经是正文字节的 sha256，重复入摘要只会让两处不一致时更难定位。
 *
 * 不含 `loadId`：加载标识是每次加载新生成的 uuid，把它入摘要等于"同一份声明换个加载就是另一版"，
 * 导出后重新导入到另一个空间、一个字节没改，界面也会被标成「声明已更新」并整条作废重算（复审 HIGH-4）。
 * 声明的身份由"哪一份固定内容（contentHash）里的哪一个 localId 的哪一版（version）的哪一版字节（fileHash）"
 * 唯一确定，加载记录只是这份内容在本人这里的一次挂载。
 */
const definitionHash=(value:{localId:string;version:string;contentHash:string;fileHash:string})=>
 createHash('sha256').update(JSON.stringify([value.localId,value.version,value.contentHash,value.fileHash])).digest('hex')

/**
 * 连接件类加载项的可用状态白名单：显式列出四个非 skipped 取值而不是只挡 `skipped`，
 * 是为了在 `IndustryLoadItemStatus` 未来新增取值时不被悄悄放行（复审 MEDIUM-1）。
 * data-source 声明与动作引用的 execution-tool 共用同一份：两者都是连接件，状态投影同源。
 */
const connectorStatuses:readonly IndustryLoadItemStatus[]=['pending-adapter','instantiated','active','detached']

/**
 * 错误文案里指名是哪一份本地声明的哪一版：合并失败时用户要能一眼看出是哪条定制导致的。
 * `version===0` 是预览试算里那一份尚未生效的草案——版本号要到生效才有，不能对用户谎称"第 0 版"。
 */
const localName=(current:BusinessLocalCurrent)=>'本地定制声明 '+current.kind+':'+current.localId+(current.version?'（第 '+current.version+' 版）':'（本次试算的草案）')

/**
 * 本地声明不属于任何加载，但回包形状与模板声明必须逐字相同（客户端只有一套读取器）。
 * 合成身份：loadId 固定字面量 'local'（回包核对只判 label(...,200)，不是 uuid；客户端不得拿它做跳转），
 * contentHash 取 sha256(['teloa.business-local-definition/v1',scope,kind,localId]) —— 这条本地声明的"内容身份"，
 * fileHash 取正文字节的 sha256，definitionHash 与草案那一份逐字相同（同一份正文必得同一个摘要，
 * 因此回退到字节相同的历史版本不会白白让台账整条作废重算）。
 */
const localSource=(scope:string,current:BusinessLocalCurrent):BusinessDefinitionSource=>({
 loadId:'local',scope,localId:current.localId,version:current.semver,
 contentHash:createHash('sha256').update(JSON.stringify([businessLocalDefinitionSchema,scope,current.kind,current.localId])).digest('hex'),
 fileHash:current.bodyHash,definitionHash:current.definitionHash,origin:'local',
})

type LocalRecord=
 |{kind:'object-type';record:BusinessObjectTypeRecord}
 |{kind:'view';record:BusinessViewRecord}
 |{kind:'action';record:BusinessActionRecord}
 |{kind:'source-mapping';record:BusinessSourceMappingRecord}
 |{kind:'widget';record:BusinessWidgetRecord}
 |{kind:'dashboard';record:BusinessDashboardRecord}
type ConfigurationLocalRecord=Exclude<LocalRecord,{kind:'object-type'|'view'}>|{kind:'object-type';record:BusinessObjectTypeRecordVersioned}|{kind:'view';record:BusinessViewRecordVersioned}

/** 只有版本化整体配置可读取 v2；独立本地定义仍走原 v1 入口。 */
function configurationLocalRecord(scope:string,current:BusinessLocalCurrent,format:string):ConfigurationLocalRecord{
 if(format==='teloa.business-configuration/v1'||current.kind!=='object-type'&&current.kind!=='view')return localRecord(scope,current)
 let definition
 try{definition=current.kind==='object-type'?readBusinessObjectTypeDefinitionVersioned(JSON.parse(current.body)):readBusinessViewDefinitionVersioned(JSON.parse(current.body))}catch{throw unavailable(localName(current)+' 格式不正确。')}
 if(current.kind==='object-type'&&definition.format!=='teloa.business-object-type/v2'||definition.id!==current.localId||definition.version!==current.semver||definition.domain!==scope)throw unavailable(localName(current)+' 正文身份与版本记录不一致。')
 const source=localSource(scope,current)
 if(definition.format==='teloa.business-view/v1'||definition.format==='teloa.business-view/v2')return {kind:'view',record:{source,definition}}
 return {kind:'object-type',record:{source,definition}}
}

/** 库里存的也不信：本地声明的正文再过一遍 `read*`，并与版本记录的身份逐字对上（与第一期同规矩）。 */
function localRecord(scope:string,current:BusinessLocalCurrent):LocalRecord{
 let parsed:unknown
 try{parsed=JSON.parse(current.body)}catch{throw unavailable(localName(current)+' 正文不是有效 JSON。')}
 let definition
 try{definition=readBusinessDefinitionBody(current.kind,parsed)}catch{throw unavailable(localName(current)+' 格式不正确。')}
 if(definition.id!==current.localId||definition.version!==current.semver)throw unavailable(localName(current)+' 正文身份与版本记录不一致。')
 // 跨范围引用禁止：本地声明的 domain 必须等于目标范围（general 已被契约层拒绝）。
 if(definition.domain!==scope)throw unavailable(localName(current)+' 所属业务范围与目标业务范围不一致。')
 const source=localSource(scope,current)
 if(definition.format==='teloa.business-object-type/v1')return {kind:'object-type',record:{source,definition}}
 if(definition.format==='teloa.business-view/v1')return {kind:'view',record:{source,definition}}
 if(definition.format==='teloa.business-source-mapping/v1')return {kind:'source-mapping',record:{source,definition}}
 if(definition.format==='teloa.business-widget/v1')return {kind:'widget',record:{source,definition}}
 if(definition.format==='teloa.business-dashboard/v1')return {kind:'dashboard',record:{source,definition}}
 return {kind:'action',record:{source,definition}}
}

/**
 * 把试算覆盖折成一条"当前生效的本地声明"，随后走与库里那些逐字相同的合并代码。
 * `version` 取 0（尚未生效），其余身份按生效之后必得的同一条公式算：`definitionHash` 因此与草案那一份
 * 逐字相同，试算出来的块与确认之后的台账才对得上（否则界面会把"刚预览过的那一份"判成"声明已更新"）。
 */
function trialCurrent(scope:string,override:BusinessLedgerOverride):BusinessLocalCurrent{
 if(!businessDefinitionKinds.includes(override.kind))throw unavailable('本次试算的业务声明种类不在白名单内。')
 let parsed:unknown
 try{parsed=JSON.parse(override.body)}catch{throw unavailable('本次试算的业务声明正文不是有效 JSON。')}
 let definition
 try{definition=readBusinessDefinitionBody(override.kind,parsed)}catch{throw unavailable('本次试算的业务声明格式不正确。')}
 if(definition.id!==override.localId)throw unavailable('本次试算的业务声明正文标识与草案记录不一致。')
 const bodyHash=createHash('sha256').update(override.body).digest('hex')
 return {
  kind:override.kind,localId:override.localId,version:0,semver:definition.version,
  definitionHash:businessLocalDefinitionHash(scope,override.kind,override.localId,definition.version,bodyHash),
  bodyHash,body:override.body,
 }
}

/** 同 localId 本地优先（D3）：命中即原地覆盖，未命中即作为新增项追加。 */
function overrideOrAppend<Row extends {definition:{id:string}}>(rows:Row[],row:Row):void{
 const index=rows.findIndex(candidate=>candidate.definition.id===row.definition.id)
 if(index<0)rows.push(row);else rows[index]=row
}

/**
 * 从已固定的市场内容读取业务定制层的三类声明（对象类型 / 视图 / 动作），并做四条跨引用核对。
 * 调用方不能提供来源标识或文件路径，授权只能针对加载时已经审阅并持久化的字节——与
 * `IndustryWorkSource`/`IndustryDataSourceSource` 同一形状。
 */
export class BusinessDefinitionSourceReader{
 private readonly configurations:Pick<BusinessConfigurationStore,'currentInTransaction'>|undefined
 private readonly market:Pick<MarketContentStore,'get'|'getInTransaction'>
 private readonly loads:Pick<IndustryLoadService,'get'|'getInTransaction'|'listInTransaction'>
 private readonly dataSources:{activeSourceIds:(db:PoolClient,ownerId:string,loadId:string)=>Promise<Set<string>>}
 private readonly works:IndustryWorkSource
 /**
  * 本地声明读口。缺省即"这个空间没有会话定制"，`forScope` 整段合并跳过——第一期的装配形态
  * （三个参数）因此原样可用，不必为了读一份模板台账先把定制层装起来。
  */
 private readonly local:Pick<BusinessLocalDefinitionService,'currentInTransaction'>|undefined
 constructor(
  market:Pick<MarketContentStore,'get'|'getInTransaction'>,
  loads:Pick<IndustryLoadService,'get'|'getInTransaction'|'listInTransaction'>,
  dataSources:{activeSourceIds:(db:PoolClient,ownerId:string,loadId:string)=>Promise<Set<string>>},
  local?:Pick<BusinessLocalDefinitionService,'currentInTransaction'>,
  configurations?:Pick<BusinessConfigurationStore,'currentInTransaction'>,
 ){
  this.market=market;this.loads=loads;this.dataSources=dataSources;this.local=local;this.configurations=configurations
  /**
   * 工作模板也走不取锁的市场读口：台账整条路径跑在只读事务里，`for share` 与 `read only` 在
   * Postgres 里不能共存（25006）。`IndustryWorkSource` 在写事务里的调用方仍按缺省取锁，
   * 这里只为本读取器换一个不加锁的读口，不改它的签名（复审 MEDIUM-6）。
   */
  this.works=new IndustryWorkSource({
   get:(actor,input)=>market.get(actor,input),
   getInTransaction:(client,actor,input)=>market.getInTransaction(client,actor,input,false),
  },loads)
 }

 /** 一个加载内的全部声明，读完就做四条跨引用核对；任何一步不符即 teloa/source-unavailable。 */
 async bundle(db:PoolClient,owner:string,loadId:string):Promise<BusinessDefinitionBundle>{
  const load=await this.loads.getInTransaction(db,owner,{loadId})
  // 不取行锁（第四个参数 false）：整条台账读取跑在只读事务里，见构造函数里的同一条说明。
  const content=await this.market.getInTransaction(db,{ownerId:owner,kind:'human'},{contentId:load.contentId},false)
  if(content.kind!=='industry-template'||content.hash!==load.contentHash)throw unavailable('业务定制声明固定内容与加载记录不一致。')
  const manifest=validateManifest(content.metadata)
  if(manifest.id!==load.templateId||manifest.version!==load.templateVersion)throw unavailable('业务定制声明所属模板身份或版本不一致。')

  /**
   * 九步核对里与「清单资源 → 加载项 → 包内文件」逐层比对的那部分，三类声明与 data-source 共用同一条读法。
   * 以清单资源（而不是加载项）为准枚举"这个加载里声明了哪些东西"：加载项的 kind 与清单资源的 kind
   * 一旦对不上，说明加载记录已经跟固定内容脱节，必须整条拒绝，不能当成"这项不存在"悄悄跳过。
   */
  const findItem=(resource:{id:string;kind:string})=>{
   const item=load.items.find(candidate=>candidate.localId===resource.id)
   if(!item||item.kind!==resource.kind)throw unavailable('业务定制声明与加载记录不一致。')
   return item
  }
  const readDeclared=(resource:{id:string;version:string;source:{kind:'local';path:string}|{kind:'public';id:string;version:string}},item:{localId:string;kind:string;version:string}):Uint8Array=>{
   if(resource.version!==item.version||resource.source.kind!=='local')throw unavailable('业务定制声明与加载记录不一致。')
   const root=content.manifestPath.includes('/')?content.manifestPath.slice(0,content.manifestPath.lastIndexOf('/')+1):''
   const path=root+resource.source.path
   const provided=content.provides.find(candidate=>candidate.resourceId===item.localId)
   const file=content.files.find(candidate=>candidate.path===path)
   if(!provided||provided.kind!==item.kind||provided.version!==item.version||provided.path!==path||!file||file.bytes.byteLength>128*1024)throw unavailable('业务定制声明文件不存在、过大或身份不一致。')
   const fileHash=createHash('sha256').update(file.bytes).digest('hex')
   if(file.hash!==fileHash)throw unavailable('业务定制声明文件摘要不一致。')
   return file.bytes
  }
  const decode=(bytes:Uint8Array):unknown=>{
   let raw:string
   try{raw=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes)}catch{throw unavailable('业务定制声明不是有效 UTF-8。')}
   try{return JSON.parse(raw)}catch{throw unavailable('业务定制声明不是有效 JSON。')}
  }
  const sourceOf=(localId:string,version:string,fileHash:string):BusinessDefinitionSource=>({
   loadId:load.id,scope:load.space.scope,localId,version,contentHash:load.contentHash,fileHash,
   definitionHash:definitionHash({localId,version,contentHash:load.contentHash,fileHash}),
   // 这一路读的是模板加载来的声明；本地声明那一路在 `forScope` 里另填 'local'（D3）。
   origin:'template',
  })

  const objectTypes:BusinessObjectTypeRecord[]=[],views:BusinessViewRecord[]=[],actions:BusinessActionRecord[]=[]
  for(const resource of manifest.resources){
   if(resource.kind!=='object-type'&&resource.kind!=='business-view'&&resource.kind!=='business-action')continue
   const item=findItem(resource)
   // 可选声明（required:false）合法未打包时加载项落 skipped：跳过这一项，不拖垮同一加载里其余能读出来的声明。
   if(item.status==='skipped')continue
   if(item.status!=='pending-adapter')throw unavailable('业务定制声明不是可使用的加载项。')
   const bytes=readDeclared(resource,item),fileHash=createHash('sha256').update(bytes).digest('hex'),parsed=decode(bytes)
   if(resource.kind==='object-type'){
    let definition
    try{definition=readBusinessObjectTypeDefinition(parsed)}catch{throw unavailable('业务对象类型声明格式不正确。')}
    // 业务数据闸对 general 一律拒绝（readBusinessDataQuery 与 businessObjectReference 都显式排除），
    // 一份 domain:'general' 的声明在数据面上永远取不到一行；工作模板允许 general 是因为它不碰业务数据面，
    // 两者故意不同规矩，这里额外要求声明的 domain 必须等于本加载的 scope（general 已被契约层拒绝）。
    if(definition.domain!==load.scope)throw unavailable('业务对象类型所属业务范围与加载不一致。')
    objectTypes.push({source:sourceOf(resource.id,resource.version,fileHash),definition})
   }else if(resource.kind==='business-view'){
    let definition
    try{definition=readBusinessViewDefinition(parsed)}catch{throw unavailable('业务视图声明格式不正确。')}
    if(definition.domain!==load.scope)throw unavailable('业务视图所属业务范围与加载不一致。')
    views.push({source:sourceOf(resource.id,resource.version,fileHash),definition})
   }else{
    let definition
    try{definition=readBusinessActionDefinition(parsed)}catch{throw unavailable('业务动作声明格式不正确。')}
    if(definition.domain!==load.scope)throw unavailable('业务动作所属业务范围与加载不一致。')
    actions.push({source:sourceOf(resource.id,resource.version,fileHash),definition})
   }
  }

  /**
   * 同一加载内的全部 data-source 声明（未跳过即可读，是否已授权由 activeSourceIds 另判——见下）。
   * 可用状态白名单见模块级 `connectorStatuses`。
   */
  const dataSourceIds=new Set<string>()
  const sourceNouns=new Map<string,string>()
  for(const resource of manifest.resources){
   if(resource.kind!=='data-source')continue
   const item=findItem(resource)
   if(item.status==='skipped')continue
   if(!connectorStatuses.includes(item.status))throw unavailable('业务定制声明与加载记录不一致或不可用。')
   const bytes=readDeclared(resource,item)
   let definition:IndustryDataSourceDefinition
   try{definition=readIndustryDataSourceDefinition(decode(bytes))}catch{throw unavailable('数据源声明格式不正确。')}
   dataSourceIds.add(definition.sourceId)
   if(definition.sourceNoun!==undefined&&!sourceNouns.has(definition.sourceId))sourceNouns.set(definition.sourceId,definition.sourceNoun)
  }

  await this.crossReference(db,owner,load,{objectTypes,views,actions,mappings:[],widgets:[],dashboards:[]},dataSourceIds)
  const activeSourceIds=await this.dataSources.activeSourceIds(db,owner,load.id)
  const sources:BusinessDefinitionBundle['sources']=new Map()
  for(const sourceId of dataSourceIds){
   const sourceNoun=sourceNouns.get(sourceId)
   sources.set(sourceId,{connected:activeSourceIds.has(sourceId),...(sourceNoun===undefined?{}:{sourceNoun})})
  }

  // 模板来源的映射 / 组件 / 看板一期恒为空：清单资源种类里还没有它们（方案包 v3 不在本期）。
  return {origin:{kind:'market',loadId:load.id},scope:load.space.scope,domain:load.domain,objectTypes,views,actions,mappings:[],widgets:[],dashboards:[],sources}
 }

 /**
  * 四条跨引用核对（另加映射 / 组件 / 看板三条，见末尾）：模板声明与本地声明**共用这一处**。本地声明覆盖模板之后必须原样再跑一遍——
  * 一条都不放宽，否则"本地定制"就成了绕过第一期判据的口子（规格 §6.4、本期 Global Constraints）。
  * 只收它真正用到的四样东西（加载身份与加载项、三类声明、本加载声明过的数据源标识），不收整份加载记录。
  */
 private async crossReference(
  db:PoolClient,owner:string,load:Pick<IndustryLoadRecord,'id'|'items'>|undefined,
  rows:Pick<BusinessDefinitionBundleVersioned,'objectTypes'|'views'|'actions'|'mappings'|'widgets'|'dashboards'>,dataSourceIds:ReadonlySet<string>,
 ):Promise<void>{
  const {objectTypes,views,actions,mappings,widgets}=rows
  const objectTypesById=new Map(objectTypes.map(row=>[row.definition.id,row]))
  const actionsById=new Map(actions.map(row=>[row.definition.id,row]))
  const fieldOf=(ownerType:BusinessObjectTypeRecordVersioned,name:string)=>{
   const field=ownerType.definition.fields.find(candidate=>candidate.name===name)
   if(!field)throw unresolved('视图引用的字段不在对象类型声明里。')
   if('format' in field)throw unresolved('业务视图尚不支持金额或多选字段。')
   return field
  }

  // 跨引用核对 1/4：视图的 objectType 必须是同一加载内的对象类型，引用字段按交叉约束表核对。
  for(const view of views){
   const objectType=objectTypesById.get(view.definition.objectType)
   if(!objectType)throw unresolved('业务视图引用的对象类型不在同一加载内。')
   if(view.definition.format==='teloa.business-view/v2'||objectType.definition.format==='teloa.business-object-type/v2'){
    try{assertBusinessViewV2References(view.definition,objectType.definition)}catch(error){throw unresolved(error instanceof Error?error.message:'业务视图引用与字段能力不一致。')}
    continue
   }
   const {dimension,measures,filters,window}=view.definition
   if(dimension){
    const field=fieldOf(objectType,dimension.field)
    if(!businessFieldCapabilities[field.type].dimension)throw unresolved('业务视图维度字段类型不允许作维度。')
    if(field.type==='datetime'&&!dimension.bucket)throw unresolved('时间维度字段必须带分桶。')
   }
   for(const measure of measures){
    if(measure.field){
     const field=fieldOf(objectType,measure.field)
     if(!businessFieldCapabilities[field.type].measure)throw unresolved('业务视图度量字段类型不允许作度量。')
     if(!businessFieldCapabilities[field.type].aggregations.includes(measure.aggregation))throw unresolved('业务视图度量聚合方式与字段类型不匹配。')
    }
    if(measure.where){
     const field=fieldOf(objectType,measure.where.field)
     if(!businessFieldCapabilities[field.type].operators.includes(measure.where.op))throw unresolved('业务视图度量筛选算子与字段类型不匹配。')
    }
   }
   for(const filter of filters){
    const field=fieldOf(objectType,filter.field)
    if(!businessFieldCapabilities[field.type].operators.includes(filter.op))throw unresolved('业务视图筛选算子与字段类型不匹配。')
   }
   if(window){
    const field=fieldOf(objectType,window.field)
    if(field.type!=='datetime')throw unresolved('业务视图时间窗字段必须是 datetime 类型。')
   }
  }

  // 跨引用核对 2/4：动作的 objectType 同上；target 指向的工作模板必须同一加载内可用，inputs 数量对齐 requirements。
  for(const action of actions){
   if(!load)throw unresolved('本地业务配置不支持市场动作。')
   const objectType=objectTypesById.get(action.definition.objectType)
   if(!objectType)throw unresolved('业务动作引用的对象类型不在同一加载内。')
   const hasField=(name:string)=>objectType.definition.fields.some(field=>field.name===name)
   for(const input of action.definition.inputs)if(input.from==='field'&&!hasField(input.field))throw unresolved('业务动作输入引用的字段不在对象类型声明里。')
   /**
    * `execution-tool` 目标的 `target.localId` 指的是本加载里那个执行工具资源，此前一条也没核对过：
    * 声明里随便写一个不存在的标识也能读出来，界面据此画出一个永远无法执行的动作（复审 MEDIUM-9）。
    * 与工作模板同一条规矩——必须是同一加载内、kind 对得上、未被跳过的加载项。
    */
   const target=action.definition.target
   if(target.kind==='execution-tool'){
    if(target.targetFrom.from==='field'&&!hasField(target.targetFrom.field))throw unresolved('业务动作执行目标引用的字段不在对象类型声明里。')
    const toolItem=load.items.find(candidate=>candidate.localId===target.localId)
    if(!toolItem||toolItem.kind!=='execution-tool'||!connectorStatuses.includes(toolItem.status))throw unresolved('业务动作引用的执行工具不是同一加载内可用的声明。')
   }
   const templateLocalId=target.kind==='work-template'?target.localId:target.workTemplate
   const templateItem=load.items.find(candidate=>candidate.localId===templateLocalId)
   if(!templateItem||templateItem.kind!=='work-template'||templateItem.status!=='pending-adapter')throw unresolved('业务动作引用的工作模板不是同一加载内可用的声明。')
   const template=await this.works.read(owner,load.id,templateItem.instanceId,db)
   if(action.definition.inputs.length!==template.requirements.length)throw unresolved('业务动作输入数量与工作模板要求数量不一致。')
  }

  // 跨引用核对 3/4：对象类型的 defaultAction 若存在，必须指向本加载内某个动作，且该动作的 objectType 就是它自己。
  for(const objectType of objectTypes){
   const defaultAction=objectType.definition.defaultAction
   if(defaultAction===undefined)continue
   const action=actionsById.get(defaultAction)
   if(!action||action.definition.objectType!==objectType.definition.id)throw unresolved('对象类型默认动作不指向同一加载内以它为对象类型的业务动作。')
  }

  // 跨引用核对 4/4：对象类型的 sourceId 必须等于同一加载内某个 data-source 声明的 sourceId；未连接不拒绝，只记 false。
  for(const objectType of objectTypes){
   if(!dataSourceIds.has(objectType.definition.sourceId))throw unresolved('对象类型绑定的数据源不是同一加载内的数据源声明。')
  }

  // 数据源映射：目标对象类型必须在同一加载内；每个目标字段必须是它的字段 name 或平台三列之一（契约层只校验格式）。
  for(const mapping of mappings){
   const objectType=objectTypesById.get(mapping.definition.objectType)
   if(!objectType)throw unresolved('数据源映射引用的对象类型不在同一加载内。')
   if(objectType.definition.format==='teloa.business-object-type/v2'&&objectType.definition.fields.some(field=>'format' in field))throw unresolved('旧数据源映射尚不支持富字段对象类型，请使用普通字段。')
   const targets=new Set<string>([...objectType.definition.fields.map(field=>field.name),...businessMappingPlatformFields])
   if(mapping.definition.mapping.some(item=>!targets.has(item.field)))throw unresolved('数据源映射的目标字段不在对象类型声明里。')
  }
  // 组件：viewRef 必须指向同一加载合并后的视图。看板引用组件不在这里按加载核对，见 `merge` 末尾的范围级核对。
  const viewIds=new Set(views.map(row=>row.definition.id))
  for(const widget of widgets){
   if(widget.definition.viewRef!==undefined&&!viewIds.has(widget.definition.viewRef))throw unresolved('业务组件引用的视图不在同一加载内。')
  }
 }

 /**
  * 一个业务范围下全部生效加载的声明，末尾按 localId 合并本地定制声明（本地优先，D3）。
  * 跨加载同 localId 冲突即 teloa/source-unavailable（本地声明是覆盖，不算冲突）。
  * "哪些加载参与本次台账"与随后 `bundle()` 读出的声明、以及调用方在同一个 `db` 上另外查的快照行，
  * 必须来自同一次事务快照，因此这里用 `listInTransaction` 而不是各自另开事务的 `list`——否则加载列表
  * 与随后算出的台账内容可能来自两个互相矛盾的时间点（例如列表里还在、读的瞬间已被卸载）。
  */
 async forScope(db:PoolClient,owner:string,scope:string,override?:BusinessLedgerOverride):Promise<BusinessDefinitionBundle[]>{
  return this.scope(db,owner,scope,false,override) as Promise<BusinessDefinitionBundle[]>
 }
 /** 记录和配置页面读取真实版本化固定正文；旧台账仍由 forScope 严格拒收 v2。 */
 async forScopeVersioned(db:PoolClient,owner:string,scope:string):Promise<BusinessDefinitionBundleVersioned[]>{
  return this.scope(db,owner,scope,true)
 }
 private async scope(db:PoolClient,owner:string,scope:string,versioned:boolean,override?:BusinessLedgerOverride):Promise<BusinessDefinitionBundleVersioned[]>{
  // 正式读口在调用方的只读快照内；采用复核在配置锁内，不把元数据预检当作 Store 的单 SQL 核验。
  const management=await readBusinessConfigurationManagement(db,owner,scope)
  if(management.managed&&(!management.hasConfigurationTables||!management.hasHead))throw new WorkError('teloa/storage-corrupt','业务配置存储不完整，已停止读取。')
  if(this.configurations&&management.managed){
   const current=await this.configurations.currentInTransaction(db,owner,scope)
   if(current){
    if(!versioned&&current.manifest.format!=='teloa.business-configuration/v1')throw new WorkError('teloa/dependency-unavailable','旧业务台账与 SQL 尚不支持富字段配置，请使用记录页面。')
    if(override)throw new WorkError('teloa/conflict','此业务由整体配置管理，请修改业务配置后预览采用。')
    const bundle:BusinessDefinitionBundleVersioned={origin:{kind:'local-configuration',configurationVersion:current.version,configurationHash:current.hash},scope,domain:scope,objectTypes:[],views:[],actions:[],mappings:[],widgets:[],dashboards:[],sources:new Map(current.manifest.sources.map(source=>[source.sourceId,{connected:true}]))}
    for(const leaf of current.leaves)this.appendConfigurationLocal(bundle,configurationLocalRecord(scope,leaf,current.manifest.format))
    this.validateConfigurationCapacity(bundle)
    await this.crossReference(db,owner,undefined,bundle,new Set(bundle.sources.keys()))
    this.validateScope([bundle])
    return [bundle]
   }
   throw new WorkError('teloa/storage-corrupt','受管业务配置缺失，已停止读取。')
  }else if(management.managed){
   throw new WorkError('teloa/dependency-unavailable','整体业务配置读取尚未接入。')
  }
  const page=await this.loads.listInTransaction(db,owner,{})
  const result:BusinessDefinitionBundle[]=[]
  const records=new Map<string,IndustryLoadRecord>()
  const seen={objectTypes:new Map<string,string>(),views:new Map<string,string>(),actions:new Map<string,string>(),mappings:new Map<string,string>(),widgets:new Map<string,string>(),dashboards:new Map<string,string>()}
  /** 范围内第一个不含业务声明、但 scope 自洽的加载：只在范围里一个含声明的加载都没有时，给 SQL 组件兜底落点（见 `merge`）。 */
  let bare:{bundle:BusinessDefinitionBundle;load:IndustryLoadRecord}|undefined
  for(const load of page.items){
   // 先按 scope 过滤出属于本次查询范围的加载：不属于本范围的加载天然不该参与，不是"损坏"，不能报错。
   if(load.scope!==scope)continue
   const found=await this.bundle(db,owner,load.id)
   if(!found.objectTypes.length&&!found.views.length&&!found.actions.length&&!found.mappings.length&&!found.widgets.length&&!found.dashboards.length){
    if(!bare&&load.scope===load.space.scope)bare={bundle:found,load}
    continue
   }
   // 加载 scope 与快照表的 scope_id 各指一处：含声明的加载必须自身 scope===space.scope，
   // 这条自洽判据只施加于已经按 scope===查询范围 选中、确实要计入本次台账的加载。
   if(load.scope!==load.space.scope)throw unavailable('加载 '+load.id+' 的业务范围标签与所属空间不一致，声明无法计入该范围台账。')
   for(const [key,rows] of [['objectTypes',found.objectTypes],['views',found.views],['actions',found.actions],['mappings',found.mappings],['widgets',found.widgets],['dashboards',found.dashboards]] as const){
    for(const row of rows){
     const localId=row.definition.id
     if(seen[key].has(localId))throw unavailable('业务范围 '+scope+' 内存在来自两个加载的重复声明标识 '+localId+'。')
     seen[key].set(localId,load.id)
    }
   }
   records.set(load.id,load)
   result.push(found)
  }
  // 试算覆盖也必须过合并那一段：没有装本地读口的空间（第一期形态）照样能预览，缺的只是库里那些本地声明。
  return this.local||override?this.merge(db,owner,scope,result,records,override,bare):result
 }

 /** 完整候选只覆盖读取；声明、页面、SQL 均重验，不登记版本或调用来源。 */
 async forConfigurationCandidate(db:PoolClient,owner:string,value:unknown):Promise<BusinessDefinitionBundle[]>{
  return this.configurationCandidate(db,owner,value,false) as Promise<BusinessDefinitionBundle[]>
 }
 async forConfigurationCandidateVersioned(db:PoolClient,owner:string,value:unknown):Promise<BusinessDefinitionBundleVersioned[]>{
  return this.configurationCandidate(db,owner,value,true)
 }
 private async configurationCandidate(db:PoolClient,owner:string,value:unknown,versioned:boolean):Promise<BusinessDefinitionBundleVersioned[]>{
  try{
   const candidate=versioned?readBusinessConfigurationCandidateVersioned(value):readBusinessConfigurationCandidate(value)
   if(!candidate.pages.length)throw new WorkError('teloa/invalid-input','正式配置至少须有一页。',{path:'pages'})
   if(candidate.format===businessConfigurationFormatV2){
    const unsupported=candidate.definitions.find(item=>item.kind==='widget'&&item.definition.kind!=='view-ref')
    if(unsupported)throw new WorkError('teloa/dependency-unavailable','富字段配置的看板仅支持已接入的视图组件，草案已保留。',{path:'definitions.widget.'+unsupported.definition.id})
   }
   const bundle:BusinessDefinitionBundleVersioned={origin:{kind:'configuration-preview',configurationHash:businessConfigurationHash(candidate)},scope:candidate.scope,domain:candidate.scope,objectTypes:[],views:[],actions:[],mappings:[],widgets:[],dashboards:[],sources:new Map(candidate.sources.map(source=>[source.sourceId,{connected:true}]))}
   for(const item of candidate.definitions){
    const leaf=prepareBusinessConfigurationDefinition(candidate.scope,item.kind,item.definition,candidate.format)
    this.appendConfigurationLocal(bundle,configurationLocalRecord(candidate.scope,{...leaf,kind:item.kind,version:0},candidate.format))
   }
   if(candidate.format===businessConfigurationFormatV2)for(const mapping of bundle.mappings){
    const target=bundle.objectTypes.find(row=>row.definition.id===mapping.definition.objectType)?.definition
    if(target?.format==='teloa.business-object-type/v2'&&target.fields.some(field=>'format' in field))throw new WorkError('teloa/invalid-input','旧数据源映射尚不支持富字段对象类型，请使用普通字段。')
   }
   this.validateConfigurationCapacity(bundle,true)
   await this.crossReference(db,owner,undefined,bundle,new Set(bundle.sources.keys()))
   this.validateScope([bundle])
   for(const page of candidate.pages){
    if(page.kind!=='records')continue
    const type=bundle.objectTypes.find(row=>row.definition.id===page.objectType)
    if(!type||page.fields.some(name=>!type.definition.fields.some(field=>field.name===name)))throw new WorkError('teloa/invalid-input','记录页面引用的字段不在对象类型声明里。',{path:'pages.'+page.id+'.fields'})
    if(page.allowCreate||page.allowEdit)for(const field of type.definition.fields){
     if(field.type!=='reference'&&field.type!=='multi-reference')continue
     const targets=bundle.objectTypes.filter(row=>row.definition.id===field.referenceType)
     if(targets.length!==1||!bundle.sources.has(targets[0]!.definition.sourceId))throw new WorkError('teloa/invalid-input','可编辑的关联字段须引用当前本地配置已声明的记录类型。',{path:'pages.'+page.id})
    }
   }
   const sqlWidgets=bundle.widgets.filter(row=>row.definition.kind!=='view-ref')
   if(sqlWidgets.length){
    const schema=(await db.query('select current_schema() as schema')).rows[0]?.schema
    const ctx={ownerId:owner,scope:candidate.scope,objectTypes:bundle.objectTypes.map(row=>row.definition)}
    for(const {definition} of sqlWidgets){
     try{
      await rewriteBusinessWidgetSql(ctx,definition,schema)
      if(definition.timeFilter)await rewriteBusinessWidgetSql(ctx,definition,schema,'7d')
     }catch(error){
      if(error instanceof WorkError)throw new WorkError(error.code,error.message,{path:'definitions.widget.'+definition.id+'.query'})
      throw error
     }
    }
   }
   return [bundle]
  }catch(error){
   if(error instanceof WorkError&&!error.details?.path)throw new WorkError(error.code,error.message,{...error.details,path:'configuration'})
   throw error
  }
 }

 /**
  * 把当前生效的本地声明合并进模板声明：同 localId 原地覆盖，未命中的作为新增项追加（D3）。
  *
  * 本地声明不属于任何加载，但它引用的对象类型 / 数据源 / 工作模板都必须落在某一个加载里，
  * 因此落点按"哪一个加载声明了它引用的那一头"定：覆盖时就是模板那一份所在的加载。
  * 落点定不下来即整条拒绝——随便挑一个加载归进去，跨引用会在另一个加载里恰好成立，那就不是一条稳定判据了。
  */
 private async merge(db:PoolClient,owner:string,scope:string,bundles:BusinessDefinitionBundle[],records:Map<string,IndustryLoadRecord>,override?:BusinessLedgerOverride,bare?:{bundle:BusinessDefinitionBundle;load:IndustryLoadRecord}):Promise<BusinessDefinitionBundle[]>{
  const locals=this.local?[...await this.local.currentInTransaction(db,owner,scope)]:[]
  if(override){
   // 试算那一份盖在库里当前那一版之上：预览的是"这份草案生效之后"的样子，不是两份叠在一起的样子。
   const trial=trialCurrent(scope,override)
   const index=locals.findIndex(row=>row.kind===trial.kind&&row.localId===trial.localId)
   if(index<0)locals.push(trial);else locals[index]=trial
  }
  if(!locals.length)return bundles
  // 范围内一个生效加载都没有：本地声明无处挂载，读侧按空读出（看板列表为空、台账为空），不让整份读取失败；
  // 试算覆盖仍走下面的落点判据并报「没有任何生效的加载」，草案因此确认不了。
  if(!bundles.length&&!bare&&!override)return bundles
  const touched=new Map<BusinessDefinitionBundle,string[]>()
  const host=(bundle:BusinessDefinitionBundle|undefined,current:BusinessLocalCurrent,reason:string):BusinessDefinitionBundle=>{
   if(!bundle)throw unresolved(localName(current)+reason)
   const names=touched.get(bundle)
   if(names)names.push(current.kind+':'+current.localId);else touched.set(bundle,[current.kind+':'+current.localId])
   return bundle
  }
  // 按 businessDefinitionKinds 的顺序合并：先对象类型、再视图与动作、再映射、组件、看板——
  // 被引用的一头总在引用它的一头之前落定，同一批里新增的本地声明才能互相引用到。
  for(const kind of businessDefinitionKinds)for(const current of locals){
   if(current.kind!==kind)continue
   const parsed=localRecord(scope,current)
   if(parsed.kind==='object-type'){
    const sourceId=parsed.record.definition.sourceId
    const target=host(
     bundles.find(row=>row.objectTypes.some(item=>item.definition.id===current.localId))??bundles.find(row=>row.sources.has(sourceId)),
     current,' 绑定的数据源 '+sourceId+' 不是本范围任一加载内的数据源声明。',
    )
    overrideOrAppend(target.objectTypes,parsed.record)
   }else if(parsed.kind==='source-mapping'){
    const objectType=parsed.record.definition.objectType
    const target=host(
     bundles.find(row=>row.mappings.some(item=>item.definition.id===current.localId))??bundles.find(row=>row.objectTypes.some(item=>item.definition.id===objectType)),
     current,' 引用的对象类型 '+objectType+' 不在本范围任一加载内。',
    )
    overrideOrAppend(target.mappings,parsed.record)
   }else if(parsed.kind==='widget'){
    /**
     * 组件引用视图时落在视图所在的加载；直接写 SQL 的组件没有单一引用对象（逻辑表跨整个范围），
     * 落在本范围第一个含声明的加载（加载列表顺序稳定）——同一看板里的组件因此默认同处一个加载。
     * 范围里一个含声明的加载都没有（如只加载了市场 teloa.soc）时，落在范围第一个不含声明的加载，并把它计入结果。
     */
    const viewRef=parsed.record.definition.viewRef
    if(viewRef===undefined&&!bundles.length&&bare){
     bundles.push(bare.bundle)
     records.set(bare.load.id,bare.load)
    }
    const target=host(
     bundles.find(row=>row.widgets.some(item=>item.definition.id===current.localId))
      ??(viewRef!==undefined?bundles.find(row=>row.views.some(item=>item.definition.id===viewRef)):bundles[0]),
     current,viewRef!==undefined?' 引用的视图 '+viewRef+' 不在本范围任一加载内。':' 所在业务范围没有任何生效的加载。',
    )
    overrideOrAppend(target.widgets,parsed.record)
   }else if(parsed.kind==='dashboard'){
    const first=parsed.record.definition.widgets[0]!
    const target=host(
     bundles.find(row=>row.dashboards.some(item=>item.definition.id===current.localId))??bundles.find(row=>row.widgets.some(item=>item.definition.id===first)),
     current,' 引用的组件 '+first+' 不在本范围任一加载内。',
    )
    overrideOrAppend(target.dashboards,parsed.record)
   }else{
    const objectType=parsed.record.definition.objectType
    const declared=parsed.kind==='view'
     ?bundles.find(row=>row.views.some(item=>item.definition.id===current.localId))
     :bundles.find(row=>row.actions.some(item=>item.definition.id===current.localId))
    const target=host(
     declared??bundles.find(row=>row.objectTypes.some(item=>item.definition.id===objectType)),
     current,' 引用的对象类型 '+objectType+' 不在本范围任一加载内。',
    )
    if(parsed.kind==='view')overrideOrAppend(target.views,parsed.record);else overrideOrAppend(target.actions,parsed.record)
   }
  }
  for(const [bundle,names] of touched){
   try{
    const load=bundle.origin.kind==='market'?records.get(bundle.origin.loadId):undefined
    if(!load)throw unavailable('业务声明缺少真实市场加载。')
    await this.crossReference(db,owner,load,bundle,new Set(bundle.sources.keys()))
   }catch(error){
    if(!(error instanceof WorkError))throw error
    // 指名是哪几条定制导致的：合并之后跨引用不成立，回一句与模板声明一模一样的文案等于让用户自己猜。
    // 只转发 crossReference 标记：包装文案不能把"这是跨引用失败"这一事实丢掉，内层其余 details 不随之下发。
    throw new WorkError('teloa/source-unavailable',error.message+'（本次合并的本地定制声明：'+names.join('、')+'）',error.details?.crossReference===true?{crossReference:true}:undefined)
   }
  }
  this.validateScope(bundles)
  return bundles
 }

 private validateConfigurationCapacity(bundle:BusinessDefinitionBundleVersioned,candidate=false):void{
  if(bundle.objectTypes.length>businessLedgerLimits.objectTypes||bundle.objectTypes.some(type=>bundle.views.filter(view=>view.definition.objectType===type.definition.id).length>businessLedgerLimits.viewsPerType))
   throw new WorkError(candidate?'teloa/invalid-input':'teloa/source-unavailable','自主业务配置超过台账支持的对象或视图数量，不能截断读取。')
 }
 private appendConfigurationLocal(bundle:BusinessDefinitionBundleVersioned,parsed:ConfigurationLocalRecord):void{
  if(parsed.kind==='object-type')bundle.objectTypes.push(parsed.record)
  else if(parsed.kind==='view')bundle.views.push(parsed.record)
  else if(parsed.kind==='widget')bundle.widgets.push(parsed.record)
  else if(parsed.kind==='dashboard')bundle.dashboards.push(parsed.record)
  else if(parsed.kind==='action')bundle.actions.push(parsed.record)
  else bundle.mappings.push(parsed.record)
 }
 private validateScope(bundles:BusinessDefinitionBundleVersioned[]):void{
  /**
   * 看板引用组件按**范围**核对，不要求同一加载：SQL 组件的逻辑表横跨整个范围、落在范围第一个加载，
   * view-ref 组件落在视图所在加载，两者分处两个加载时同放一张看板是正当用法；看板服务也按范围取组件。
   */
  const scopeWidgets=new Set(bundles.flatMap(bundle=>bundle.widgets.map(row=>row.definition.id)))
  for(const bundle of bundles)for(const dashboard of bundle.dashboards){
   const missing=dashboard.definition.widgets.filter(id=>!scopeWidgets.has(id))
   if(missing.length)throw unresolved('业务看板 '+dashboard.definition.id+' 引用的组件不在本业务范围内：'+missing.join('、')+'。')
  }
  /**
   * 整页时间范围同样按范围核对（二期规格 §3.4）：`timeFilter.table` 是 SQL 逻辑表名，逻辑表横跨整个范围，
   * 因此在全部加载合并后的对象类型里找；列须是该类型的 datetime 字段或两个系统时间列。
   * 带 `filters` 的看板至少一个组件接入，否则声明收下了、页面却不随范围变化。
   */
  const objectTypes=bundles.flatMap(bundle=>bundle.objectTypes.map(row=>row.definition))
  const bound=new Set<string>()
  for(const bundle of bundles)for(const {definition:widget} of bundle.widgets){
   if(!widget.timeFilter)continue
   const {table,column}=widget.timeFilter
   const matches=objectTypes.filter(type=>type.id.replaceAll('-','_')===table)
   if(matches.length!==1)throw unresolved('业务组件 '+widget.id+' 接入时间范围的表 '+table+' 不是本业务范围内的对象类型。')
   if(column!=='_observed_at'&&column!=='_synced_at'&&!matches[0]!.fields.some(field=>field.name===column&&field.type==='datetime'))
    throw unresolved('业务组件 '+widget.id+' 接入时间范围的列 '+column+' 不是表 '+table+' 的时间字段（datetime 字段或 _observed_at / _synced_at）。')
   bound.add(widget.id)
  }
  for(const bundle of bundles)for(const {definition:dashboard} of bundle.dashboards)
   if(dashboard.filters&&!dashboard.widgets.some(id=>bound.has(id)))throw unresolved('业务看板 '+dashboard.id+' 声明了时间范围，但没有任何组件接入。')
  /**
   * 下钻同样按范围核对（二期规格 §4.2）：对象清单与对象详情都由目标类型的 list 视图承载，没有就点了也打不开；
   * match 只对文本 / 枚举 / 引用 / 布尔字段做等值——时间与数值按桶或按区间聚合后的一个点，与对象的精确取值不可能相等。
   */
  const listed=new Set(bundles.flatMap(bundle=>bundle.views.filter(row=>row.definition.kind==='list').map(row=>row.definition.objectType)))
  for(const bundle of bundles)for(const {definition:widget} of bundle.widgets){
   if(!widget.drilldown)continue
   const {objectType,match}=widget.drilldown
   const target=objectTypes.find(type=>type.id===objectType)
   if(!target)throw unresolved('业务组件 '+widget.id+' 的下钻目标 '+objectType+' 不是本业务范围内的对象类型。')
   if(!listed.has(objectType))throw unresolved('业务组件 '+widget.id+' 的下钻目标对象类型 '+objectType+' 没有清单视图。')
   if(match&&!target.fields.some(field=>field.name===match.field&&!('format' in field)&&equatableFieldTypes.has(field.type)))
    throw unresolved('业务组件 '+widget.id+' 下钻按字段 '+match.field+' 的取值过滤，但它不是对象类型 '+objectType+' 里能按取值比较的字段（文本、枚举、引用或布尔）。')
  }
 }
}

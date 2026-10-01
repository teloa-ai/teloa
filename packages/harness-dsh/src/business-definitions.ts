import {createHash} from 'node:crypto'
import {
 WorkError,isRecord,businessLedgerLimits,businessFieldTypes,businessViewKinds,businessViewCharts,
 readBusinessObjectTypeDefinition,readBusinessActionDefinition,readBusinessDefinitionBody,readBusinessViewDefinition,
 businessDefinitionKinds,businessCustomizationLimits,taskInput,localizedMetadata,readBusinessWidgetResult,
 type BusinessDefinitionDraft,type BusinessDefinitionPreview,type BusinessDefinitionKind,type BusinessCustomizationDirectory,type BusinessCustomizationEntry,type BusinessLocalDefinitionVersion,
 type BusinessLedger,type BusinessLedgerBlock,type BusinessViewResult,type BusinessObjectTypeRecord,
 type BusinessActionRecord,type BusinessDefinitionSource,type BusinessLedgerObject,type BusinessViewRow,type BusinessViewCoverage,
 type BusinessChartType,type BusinessFieldType,type BusinessViewKind,
} from '@teloa/contract'
import type {BusinessLedgerService,BusinessLocalDefinitionService,BusinessDefinitionPreviewService} from '@teloa/backend'

export const businessDefinitionEndpoints=['business-definitions/ledger','business-definitions/customization','business-definitions/preview','business-definitions/apply','business-definitions/revert'] as const

const hash=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)
const stamp=(value:unknown):value is string=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value
/** 快照数据用：契约对快照文本本就放行 `\n`（抄自 `business-data.ts` 的 `text()`）。 */
const text=(value:unknown,max:number,empty=false):value is string=>typeof value==='string'&&(empty||!!value.trim())&&value===value.trim()&&value.length<=max&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)
/**
 * 声明派生文本用：在 `text()` 之上额外禁 `\r`/`\n`（契约 `business-definitions.ts` 对声明文本的同一条规矩，
 * 理由逐字抄自那边的注释——声明文本会进模型上下文，允许换行等于允许在那里另起一段，规格 §8 第 1 条）。
 * 本文件里不经 `readBusinessObjectTypeDefinition`/`readBusinessActionDefinition` 的字段（`viewId`、`viewVersion`、
 * `measures[].id/label`、`rows[].label`、`missingFields[]`、`defaultAction.actionId/title`、`source.sourceId`、
 * `BusinessDefinitionSource.loadId/version`）全部用这条，不再用宽松的 `text()`。
 */
const label=(value:unknown,max:number,empty=false):value is string=>text(value,max,empty)&&!/[\r\n]/.test(value)
/** 标识类字段的字符集判据，逐字照抄契约 `business-definitions.ts` 里对应的私有正则（那边未导出，这里各自留一份）。 */
const localIdPattern=/^[a-zA-Z0-9][a-zA-Z0-9-]{0,119}$/
const fieldNamePattern=/^[a-z0-9][a-z0-9_-]{0,62}$/
const sourceIdPattern=/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/
const semverPattern=/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const localId=(value:unknown):value is string=>typeof value==='string'&&value.length<=120&&localIdPattern.test(value)
const fieldName=(value:unknown):value is string=>typeof value==='string'&&value.length<=63&&fieldNamePattern.test(value)
const sourceId=(value:unknown):value is string=>typeof value==='string'&&value.length<=120&&sourceIdPattern.test(value)
const semver=(value:unknown):value is string=>typeof value==='string'&&value.length<=80&&semverPattern.test(value)
function localizedTitle(value:unknown,original:string,max:number){
 const row=exact(value,['title'])
 let title
 try{title=localizedMetadata(row.title)}catch{throw invalid()}
 if(title.original!==original||Object.values(title.locales).some(item=>typeof item==='string'&&!label(item,max)))throw invalid()
 return {title}
}
function localizedLabel(value:unknown,original:string,max:number){
 const row=exact(value,['label'])
 let metadata
 try{metadata=localizedMetadata(row.label)}catch{throw invalid()}
 if(metadata.original!==original||Object.values(metadata.locales).some(item=>typeof item==='string'&&!label(item,max)))throw invalid()
 return {label:metadata}
}
/** 回包核对：形状不符一律 teloa/invalid-host-response，与 readBusinessDataPage 同规矩。 */
const invalid=()=>new WorkError('teloa/invalid-host-response','业务台账回包的来源、范围或声明版本不一致。')
function exact(value:unknown,keys:readonly string[]):Record<string,unknown>{if(!isRecord(value)||Object.keys(value).some(key=>!keys.includes(key))||keys.some(key=>!Object.hasOwn(value,key)))throw invalid();return value}
/** 覆盖率三项：块级与视图级用同一条判据，不各写一份。 */
function coverage(value:unknown):BusinessViewCoverage{
 const row=exact(value,['objects','latestReceivedAt','truncated'])
 if(!Number.isSafeInteger(row.objects)||Number(row.objects)<0||Number(row.objects)>businessLedgerLimits.scanRows||(row.latestReceivedAt!==null&&!stamp(row.latestReceivedAt))||typeof row.truncated!=='boolean')throw invalid()
 return {objects:row.objects as number,latestReceivedAt:row.latestReceivedAt as string|null,truncated:row.truncated}
}

/** 最小可查询接口：只要有 `query(text,values)` 就够，不为此专门依赖 `pg`——调用方传入的真实 `PoolClient` 结构上天然满足。 */
type Queryable={query(text:string,values:readonly unknown[]):Promise<{rows:unknown[]}>}
/**
 * 一个加载内已激活的数据源标识集合：按 `binding->>'sourceId'` 取值——`item_local_id` 是清单资源的本地标识，
 * 与数据源声明自己的 `sourceId` 是两个不同的命名空间（前者不收 `.`/`_`，后者收），两者不保证逐字相同，
 * 曾经拿 `item_local_id` 冒充过 `sourceId`，会让已经授权成功的数据源被判"还没接上来源"（复审 HIGH-1）。
 * 建表约束保证 `state='active'` 时 `binding` 一定是非空 object，因此 `binding is not null` 只是双重保险。
 * 模板升级的继任加载会让 data-source 项的 `carried_from` 指向仍在服役的旧实例；旧加载已是
 * `superseded`，因此不能再按继任加载 ID 直接查实例表。查询从当前加载项出发，沿这条已固定的
 * 实例血缘取状态，既不复制授权绑定，也不会把无关加载的同名来源误判为已连接。
 * `db` 必须是调用方那次只读事务的同一个连接：这张表和快照表一样只在事务外由推进流程改写，
 * 同一批读要看见同一份状态才不会出现"这一块说已连接、那一块说没连接"的自相矛盾。
 */
export async function activeSourceIds(db:Queryable,ownerId:string,loadId:string):Promise<Set<string>>{
 const rows=(await db.query(
  "select distinct source.binding->>'sourceId' as source_id from teloa_industry_load_items item join teloa_industry_loads load on load.id=item.load_id and load.owner_id=$1 and load.status='active' join teloa_industry_data_source_instances source on source.owner_id=load.owner_id and source.item_instance_id=coalesce(item.carried_from,item.instance_id) where item.load_id=$2 and item.kind='data-source' and source.state='active' and source.binding is not null",
  [ownerId,loadId],
 )).rows as Array<{source_id:string|null}>
 return new Set(rows.map(row=>row.source_id).filter((value):value is string=>typeof value==='string'))
}

/** 声明的固定身份：`localId` 必须与所属定义的 `id` 逐字相同，`scope` 必须与本次台账的范围逐字相同——跨范围声明混进来也判不一致。 */
function definitionSource(value:unknown,scope:string,expectedLocalId:string):BusinessDefinitionSource{
 const row=exact(value,['loadId','scope','localId','version','contentHash','fileHash','definitionHash','origin'])
 if(!label(row.loadId,200)||row.scope!==scope||row.localId!==expectedLocalId||!semver(row.version)||!hash(row.contentHash)||!hash(row.fileHash)||!hash(row.definitionHash))throw invalid()
 if(row.origin!=='template'&&row.origin!=='local')throw invalid()
 return {loadId:row.loadId,scope:row.scope,localId:row.localId,version:row.version,contentHash:row.contentHash,fileHash:row.fileHash,definitionHash:row.definitionHash,origin:row.origin} as BusinessDefinitionSource
}

/** 对象类型声明本身复用契约读取函数核对（格式、字段交叉约束等），这里只再钉「来源与本次范围一致」这一层。 */
function objectTypeRecord(value:unknown,scope:string):BusinessObjectTypeRecord{
 const row=exact(value,['source','definition'])
 let definition
 try{definition=readBusinessObjectTypeDefinition(row.definition)}catch{throw invalid()}
 if(definition.domain!==scope)throw invalid()
 return {source:definitionSource(row.source,scope,definition.id),definition}
}

function actionRecord(value:unknown,scope:string):BusinessActionRecord{
 const row=exact(value,['source','definition'])
 let definition
 try{definition=readBusinessActionDefinition(row.definition)}catch{throw invalid()}
 if(definition.domain!==scope)throw invalid()
 return {source:definitionSource(row.source,scope,definition.id),definition}
}

/**
 * `scope`/`type` 由所属块传入并重建进快照做哈希核对，与 `readBusinessDataPage`（business-data.ts:23）同规矩——
 * 只核对哈希格式不够，`BusinessLedgerObject` 相对被哈希的快照形状正好只少这两项，补上后顺带挡住
 * "别的对象类型/别的范围的对象混进这个块"（复审 MEDIUM-5）。
 */
function ledgerObject(value:unknown,scope:string,type:string):BusinessLedgerObject{
 const row=exact(value,['id','title','source','observedAt','receivedAt','quality','version','snapshotHash','summary','fields'])
 if(!text(row.id,200)||!text(row.title,240)||!text(row.source,120)||!stamp(row.observedAt)||!stamp(row.receivedAt)||row.receivedAt<row.observedAt)throw invalid()
 if(row.quality!=='complete'&&row.quality!=='missing')throw invalid()
 if(!Number.isSafeInteger(row.version)||Number(row.version)<1||Number(row.version)>2147483647)throw invalid()
 if(!hash(row.snapshotHash)||!text(row.summary,4000,true)||!Array.isArray(row.fields)||row.fields.length>50)throw invalid()
 const fields=row.fields.map(item=>{
  const field=exact(item,['label','value'])
  if(!text(field.label,120)||!text(field.value,2000,true))throw invalid()
  return {label:field.label,value:field.value}
 })
 if(new Set(fields.map(field=>field.label)).size!==fields.length)throw invalid()
 const snapshot={scope,type,id:row.id,version:row.version,title:row.title,source:row.source,observedAt:row.observedAt,receivedAt:row.receivedAt,quality:row.quality,summary:row.summary,fields}
 if(createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')!==row.snapshotHash)throw invalid()
 return {id:row.id,title:row.title,source:row.source,observedAt:row.observedAt,receivedAt:row.receivedAt,quality:row.quality,version:row.version as number,snapshotHash:row.snapshotHash,summary:row.summary,fields}
}

/** 一个视图结果：`scope`/`objectType` 必须与所属块一致；`rows[].values` 长度必须逐条等于 `measures` 长度；
 * `objects`（仅 list 视图带）必须与 `rows` 同长同序——第 i 个对象的 `id` 就是第 i 行的 `dimension`。 */
function viewResult(value:unknown,scope:string,objectType:string):BusinessViewResult{
 if(!isRecord(value))throw invalid()
 const hasObjects=value.objects!==undefined,hasLocalized=value.localized!==undefined,hasDimensionField=value.dimensionField!==undefined
 const keys=['schema','viewId','viewVersion','kind','chart','title',...(hasLocalized?['localized']:[]),...(hasDimensionField?['dimensionField']:[]),'scope','objectType','computedAt','measures','rows','dimensionValues','coverage','missingFields','definitionHash','origin',...(hasObjects?['objects']:[])]
 if(Object.keys(value).some(key=>!keys.includes(key)))throw invalid()
 const row=value as Record<string,unknown>
 if(row.schema!=='teloa.business-view-result/v1'||!localId(row.viewId)||!semver(row.viewVersion)||!hash(row.definitionHash))throw invalid()
 // 这份结果算的是模板声明还是本地定制声明，由宿主逐字带出来，不从 definitionHash 或 loadId 反推（契约 business-definitions.ts 同一条理由）。
 if(row.origin!=='template'&&row.origin!=='local')throw invalid()
 // kind × chart 用契约那张允许组合表核对，不在这里另抄一份搭配规矩。
 if(!(businessViewKinds as readonly string[]).includes(row.kind as string))throw invalid()
 const kind=row.kind as BusinessViewKind
 if(!businessViewCharts[kind].includes(row.chart as BusinessChartType)||!label(row.title,120))throw invalid()
 const localized=hasLocalized?localizedTitle(row.localized,row.title as string,120):undefined
 if(hasDimensionField&&!fieldName(row.dimensionField))throw invalid()
 // 只有 list 视图带 objects 段：形态位与这条编码必须互相印证，对不上说明回包被拼过。
 if(hasObjects!==(kind==='list'))throw invalid()
 if(row.scope!==scope||row.objectType!==objectType||!stamp(row.computedAt))throw invalid()
 if(!Array.isArray(row.measures)||!row.measures.length||row.measures.length>businessLedgerLimits.measures)throw invalid()
 const measures=row.measures.map(item=>{
  const hasFieldType=isRecord(item)&&item.fieldType!==undefined,hasMeasureLocalized=isRecord(item)&&item.localized!==undefined
  const measure=exact(item,['id','label',...(hasMeasureLocalized?['localized']:[]),...(hasFieldType?['fieldType']:[])])
  if(!fieldName(measure.id)||!label(measure.label,80))throw invalid()
  if(hasFieldType&&!(businessFieldTypes as readonly string[]).includes(measure.fieldType as string))throw invalid()
  const localized=hasMeasureLocalized?localizedLabel(measure.localized,measure.label as string,80):undefined
  return {id:measure.id,label:measure.label,...(localized?{localized}:{}),...(hasFieldType?{fieldType:measure.fieldType as BusinessFieldType}:{})}
 })
 if(new Set(measures.map(measure=>measure.id)).size!==measures.length)throw invalid()
 if(!Array.isArray(row.rows)||row.rows.length>businessLedgerLimits.listRows)throw invalid()
 const rows:BusinessViewRow[]=row.rows.map(item=>{
  const line=exact(item,['dimension','label','values'])
  if(typeof line.dimension!=='string'||!label(line.label,240,true)||!Array.isArray(line.values)||line.values.length!==measures.length||line.values.some(v=>v!==null&&!(typeof v==='number'&&Number.isFinite(v))))throw invalid()
  return {dimension:line.dimension,label:line.label,values:[...line.values] as Array<number|null>}
 })
 // 截断前的组数不可能少于画出来的行数，也不可能多过一次扫描的上限。
 if(!Number.isSafeInteger(row.dimensionValues)||Number(row.dimensionValues)<rows.length||Number(row.dimensionValues)>businessLedgerLimits.scanRows)throw invalid()
 const cov=coverage(row.coverage)
 if(!Array.isArray(row.missingFields)||row.missingFields.some(field=>!fieldName(field)))throw invalid()
 const missingFields=[...row.missingFields] as string[]
 let objects:BusinessLedgerObject[]|undefined
 if(hasObjects){
  if(!Array.isArray(row.objects)||row.objects.length!==rows.length)throw invalid()
  objects=row.objects.map((item,index)=>{
   const value=ledgerObject(item,scope,objectType)
   if(value.id!==rows[index]!.dimension)throw invalid()
   return value
  })
 }
 return {schema:'teloa.business-view-result/v1',viewId:row.viewId,viewVersion:row.viewVersion,definitionHash:row.definitionHash,origin:row.origin,kind,chart:row.chart as BusinessChartType,title:row.title,...(localized?{localized}:{}),...(hasDimensionField?{dimensionField:row.dimensionField as string}:{}),scope,objectType,computedAt:row.computedAt,measures,rows,dimensionValues:row.dimensionValues as number,coverage:cov,missingFields,...(objects?{objects}:{})}
}

/** 一个块：对象类型定义、块级来源、（可选）进度摘要/默认动作、该对象类型下的全部视图结果。 */
function block(value:unknown,scope:string):BusinessLedgerBlock{
 if(!isRecord(value))throw invalid()
 const hasDefaultAction=value.defaultAction!==undefined,hasProgress=value.progress!==undefined
 const keys=['objectType','objects','source','coverage','missingFields','views',...(hasProgress?['progress']:[]),...(hasDefaultAction?['defaultAction']:[])]
 if(Object.keys(value).some(key=>!keys.includes(key)))throw invalid()
 const row=value as Record<string,unknown>
 const objectType=objectTypeRecord(row.objectType,scope)
 if(!Number.isSafeInteger(row.objects)||Number(row.objects)<0)throw invalid()
 const cov=coverage(row.coverage)
 if(cov.objects!==row.objects)throw invalid()
 // 进度摘要是否存在由对象类型声明决定：宿主不能凭空补一份，也不能漏掉已声明的摘要。
 const declaredProgress=objectType.definition.progress
 if(hasProgress!==(declaredProgress!==undefined))throw invalid()
 let progress:BusinessLedgerBlock['progress']
 if(hasProgress){
  const value=exact(row.progress,['unfinished','waitingForYou','latestChangedAt'])
  if(!Number.isSafeInteger(value.unfinished)||!Number.isSafeInteger(value.waitingForYou)||Number(value.unfinished)<0||Number(value.waitingForYou)<0||Number(value.unfinished)>cov.objects||Number(value.waitingForYou)>Number(value.unfinished)||(value.latestChangedAt!==null&&!stamp(value.latestChangedAt)))throw invalid()
  if(declaredProgress!.changedAtField===undefined&&value.latestChangedAt!==null)throw invalid()
  progress={unfinished:value.unfinished as number,waitingForYou:value.waitingForYou as number,latestChangedAt:value.latestChangedAt as string|null}
 }
 // 块级缺失披露是全量的：列出来的每个字段名都必须真的在这份对象类型声明里，多一个就是回包被拼过。
 const declared=new Set(objectType.definition.fields.map(field=>field.name))
 if(!Array.isArray(row.missingFields)||row.missingFields.some(field=>!fieldName(field)||!declared.has(field))||new Set(row.missingFields).size!==row.missingFields.length)throw invalid()
 const hasSourceNoun=isRecord(row.source)&&'sourceNoun' in row.source
 const src=exact(row.source,['sourceId','connected',...(hasSourceNoun?['sourceNoun']:[])])
 if(hasSourceNoun&&(!label(src.sourceNoun,12)||/[\x00-\x1f\x7f]/.test(src.sourceNoun)))throw invalid()
 if(!sourceId(src.sourceId)||typeof src.connected!=='boolean')throw invalid()
 // 块级来源必须就是对象类型声明绑定的那一个；换一个来源混进来即拒收。
 if(src.sourceId!==objectType.definition.sourceId)throw invalid()
 let defaultAction:BusinessLedgerBlock['defaultAction']
 if(hasDefaultAction){
  const da=exact(row.defaultAction,['actionId','title','targetKind','available'])
  if(!localId(da.actionId)||!label(da.title,120)||(da.targetKind!=='work-template'&&da.targetKind!=='execution-tool')||typeof da.available!=='boolean')throw invalid()
  defaultAction={actionId:da.actionId,title:da.title,targetKind:da.targetKind,available:da.available}
 }
 if(!Array.isArray(row.views)||row.views.length>businessLedgerLimits.viewsPerType)throw invalid()
 const views=row.views.map(item=>viewResult(item,scope,objectType.definition.id))
 if(new Set(views.map(view=>view.viewId)).size!==views.length)throw invalid()
 // 同一个块里每张视图的覆盖面来自同一批行：与块级那份对不上说明两处不是同一次计算。
 if(views.some(view=>view.coverage.objects!==cov.objects||view.coverage.latestReceivedAt!==cov.latestReceivedAt||view.coverage.truncated!==cov.truncated))throw invalid()
 return {objectType,objects:row.objects as number,source:{sourceId:src.sourceId,connected:src.connected,...(hasSourceNoun?{sourceNoun:src.sourceNoun as string}:{})},...(defaultAction?{defaultAction}:{}),coverage:cov,...(progress?{progress}:{}),missingFields:[...row.missingFields] as string[],views}
}

/** 回包核对：形状不符一律 teloa/invalid-host-response，与 readBusinessDataPage 同规矩。 */
export function readBusinessLedger(value:unknown,scope:string):BusinessLedger{
 const row=exact(value,['schema','scope','computedAt','blocks','actions'])
 if(row.schema!=='teloa.business-ledger/v1'||row.scope!==scope||!stamp(row.computedAt))throw invalid()
 if(!Array.isArray(row.blocks)||row.blocks.length>businessLedgerLimits.objectTypes)throw invalid()
 const blocks=row.blocks.map(item=>block(item,scope))
 if(new Set(blocks.map(item=>item.objectType.definition.id)).size!==blocks.length)throw invalid()
 // 动作条数没有契约上限（`businessLedgerLimits` 只钉了块与视图），适配层也不自造一个：
 // 凭空多钉一道会把合法声明判成读不出来，比放过一条长数组更伤人。与客户端那一侧同一条口径。
 if(!Array.isArray(row.actions))throw invalid()
 const actions=row.actions.map(item=>actionRecord(item,scope))
 // 同一批里每个视图都必须来自同一次计算（规格 §4.3）：块与块之间不能出现互相矛盾的数字。
 if(blocks.some(item=>item.views.some(view=>view.computedAt!==row.computedAt)))throw invalid()
 return {schema:'teloa.business-ledger/v1',scope,computedAt:row.computedAt,blocks,actions}
}

const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
const positive=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>0
const receipt=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)
const definitionKind=(value:unknown):value is BusinessDefinitionKind=>businessDefinitionKinds.includes(value as BusinessDefinitionKind)
const unique=(values:readonly unknown[])=>new Set(values).size===values.length

/** 草案正文只走契约读取器，再将声明身份与回包身份逐字对齐。 */
export function readBusinessDefinitionDraft(value:unknown,scope:string):BusinessDefinitionDraft{
 const applied=isRecord(value)&&value.status==='applied'
 const row=exact(value,['id','ownerId','requestId','scope','kind','localId','semver','definitionHash','body','status','createdAt','updatedAt',...(applied?['appliedVersion']:[])])
 if(!uuid(row.id)||!uuid(row.requestId)||!label(row.ownerId,128)||row.scope!==scope||!label(scope,120)||scope==='general'||!definitionKind(row.kind)||!localId(row.localId)||!semver(row.semver)||!hash(row.definitionHash)||!stamp(row.createdAt)||!stamp(row.updatedAt)||row.updatedAt<row.createdAt)throw invalid()
 if(row.status!=='draft'&&row.status!=='applied'||applied&&!positive(row.appliedVersion))throw invalid()
 if(typeof row.body!=='string'||Buffer.byteLength(row.body,'utf8')>businessCustomizationLimits.bodyBytes)throw invalid()
 let definition
 try{definition=readBusinessDefinitionBody(row.kind,JSON.parse(row.body))}catch{throw invalid()}
 if(definition.domain!==scope||definition.id!==row.localId||definition.version!==row.semver)throw invalid()
 return {...row} as BusinessDefinitionDraft
}
function localVersion(value:unknown):BusinessLocalDefinitionVersion{
 const row=exact(value,['version','semver','definitionHash','bodyHash','createdAt','draftId'])
 if(!positive(row.version)||!semver(row.semver)||!hash(row.definitionHash)||!hash(row.bodyHash)||!stamp(row.createdAt)||!uuid(row.draftId))throw invalid()
 return {...row} as BusinessLocalDefinitionVersion
}
export function readBusinessCustomizationEntry(value:unknown,scope:string):BusinessCustomizationEntry{
 const hasCurrent=isRecord(value)&&value.current!==undefined
 const row=exact(value,['scope','kind','localId','versions','template',...(hasCurrent?['current']:[])])
 if(row.scope!==scope||!label(scope,120)||scope==='general'||!definitionKind(row.kind)||!localId(row.localId)||!Array.isArray(row.versions)||!row.versions.length||row.versions.length>businessCustomizationLimits.versionsPerDefinition)throw invalid()
 const versions=row.versions.map(localVersion)
 if(versions.some((version,index)=>index>0&&version.version<=versions[index-1]!.version))throw invalid()
 const current=hasCurrent?localVersion(row.current):undefined
 if(current&&!versions.some(version=>Object.keys(current).every(key=>version[key as keyof BusinessLocalDefinitionVersion]===current[key as keyof BusinessLocalDefinitionVersion])))throw invalid()
 const template=exact(row.template,isRecord(row.template)&&row.template.available===true?['available','version']:['available'])
 if(typeof template.available!=='boolean'||template.available&&!semver(template.version))throw invalid()
 return {scope,kind:row.kind,localId:row.localId,versions,...(current?{current}:{}),template:template.available?{available:true,version:template.version as string}:{available:false}}
}
export function readBusinessCustomizationDirectory(value:unknown,scope:string):BusinessCustomizationDirectory{
 const row=exact(value,['schema','scope','readAt','drafts','entries'])
 if(row.schema!=='teloa.business-customization/v1'||row.scope!==scope||!stamp(row.readAt)||!Array.isArray(row.drafts)||!Array.isArray(row.entries))throw invalid()
 const drafts=row.drafts.map(item=>readBusinessDefinitionDraft(item,scope)),entries=row.entries.map(item=>readBusinessCustomizationEntry(item,scope))
 if(drafts.filter(item=>item.status==='draft').length>businessCustomizationLimits.draftsPerScope||!unique(drafts.map(item=>item.id))||!unique(drafts.map(item=>item.requestId))||!unique(entries.map(item=>item.kind+':'+item.localId)))throw invalid()
 return {schema:'teloa.business-customization/v1',scope,readAt:row.readAt,drafts,entries}
}
/**
 * 试算块沿用台账核对，差异与影响范围只允许声明路径、声明值与标识。试算键按草案种类互斥：
 * 对象类型 / 视图 / 动作 → `trial` 或 `trialUnavailable`；数据源映射 → `mappingTrial` 或 `trialUnavailable`；
 * 组件 → 只有 `widgetTrial`；看板 → 只有 `dashboardTrial`。组件与看板不挂靠单一对象类型，`impact.objectType` 必须是空串。
 */
export function readBusinessDefinitionPreview(value:unknown):BusinessDefinitionPreview{
 const kind=isRecord(value)&&isRecord(value.draft)?value.draft.kind:undefined
 const trialKey=kind==='widget'?'widgetTrial':kind==='dashboard'?'dashboardTrial':kind==='source-mapping'?(isRecord(value)&&value.mappingTrial!==undefined?'mappingTrial':'trialUnavailable'):(isRecord(value)&&value.trial!==undefined?'trial':'trialUnavailable')
 const row=exact(value,['schema','draft','receipt','base','diff','diffTruncated','impact','computedAt',trialKey])
 if(row.schema!=='teloa.business-definition-preview/v1'||!isRecord(row.draft)||typeof row.draft.scope!=='string'||!receipt(row.receipt)||!stamp(row.computedAt)||typeof row.diffTruncated!=='boolean'||!Array.isArray(row.diff)||row.diff.length>businessCustomizationLimits.diffRows)throw invalid()
 const draft=readBusinessDefinitionDraft(row.draft,row.draft.scope)
 if(draft.status!=='draft'||draft.kind!==kind)throw invalid()
 const base=exact(row.base,isRecord(row.base)&&row.base.origin==='none'?['origin']:['origin','semver','definitionHash'])
 if(base.origin!=='none'&&(base.origin!=='template'&&base.origin!=='local'||!semver(base.semver)||!hash(base.definitionHash)))throw invalid()
 const diff=row.diff.map(item=>{
  const line=exact(item,['path','before','after'])
  if(!label(line.path,512)||!/^[$a-zA-Z0-9_.\[\]-]+$/.test(line.path)||line.before!==null&&!label(line.before,businessCustomizationLimits.bodyBytes,true)||line.after!==null&&!label(line.after,businessCustomizationLimits.bodyBytes,true)||line.before===line.after)throw invalid()
  return {path:line.path,before:line.before as string|null,after:line.after as string|null}
 })
 if(!unique(diff.map(item=>item.path))||row.diffTruncated&&diff.length!==businessCustomizationLimits.diffRows)throw invalid()
 const boardKind=draft.kind==='widget'||draft.kind==='dashboard'
 const impact=exact(row.impact,['scope','objectType','views','actions','fields','widgets','dashboards'])
 if(impact.scope!==draft.scope||(boardKind?impact.objectType!=='':!localId(impact.objectType)))throw invalid()
 for(const key of ['views','actions','fields','widgets','dashboards'] as const){const values=impact[key];if(!Array.isArray(values)||!unique(values)||values.some(value=>!(key==='fields'?fieldName(value):localId(value))))throw invalid()}
 const definition=readBusinessDefinitionBody(draft.kind,JSON.parse(draft.body))
 if(!boardKind&&impact.objectType!==(definition.format==='teloa.business-object-type/v1'?definition.id:'objectType' in definition?definition.objectType:undefined))throw invalid()
 const head={schema:'teloa.business-definition-preview/v1' as const,draft,receipt:row.receipt as string,base:base as BusinessDefinitionPreview['base'],diff,diffTruncated:row.diffTruncated,impact:impact as BusinessDefinitionPreview['impact'],computedAt:row.computedAt as string}
 if(definition.format==='teloa.business-widget/v1'){
  let widgetTrial
  try{widgetTrial=readBusinessWidgetResult(row.widgetTrial)}catch{throw invalid()}
  if(widgetTrial.widgetId!==definition.id)throw invalid()
  return {...head,widgetTrial}
 }
 if(definition.format==='teloa.business-dashboard/v1'){
  const trial=exact(row.dashboardTrial,['layout'])
  if(JSON.stringify(trial.layout)!==JSON.stringify(definition.layout))throw invalid()
  return {...head,dashboardTrial:{layout:definition.layout}}
 }
 if(definition.format==='teloa.business-source-mapping/v1'&&trialKey==='mappingTrial')return {...head,mappingTrial:mappingTrial(row.mappingTrial)}
 const hasTrial=trialKey==='trial',trial=hasTrial?block(row.trial,draft.scope):undefined
 if(trial&&(trial.objectType.definition.id!==impact.objectType||!trial.source.connected||trial.objects===0))throw invalid()
 // pull-required 只属于受管 MCP 工具来源的映射草案（打开预览不试拉，等用户显式试拉）；pull-failed / config-unreadable 只属于映射草案（试拉调用失败 / 数据源配置文件读不了）。
 const awaitingPull=definition.format==='teloa.business-source-mapping/v1'&&definition.source.kind==='mcp-tool'&&row.trialUnavailable==='pull-required'
 const pullFailed=definition.format==='teloa.business-source-mapping/v1'&&(row.trialUnavailable==='pull-failed'||row.trialUnavailable==='config-unreadable')
 if(!hasTrial&&row.trialUnavailable!=='source-disconnected'&&row.trialUnavailable!=='no-objects'&&!awaitingPull&&!pullFailed)throw invalid()
 return {...head,...(trial?{trial}:{trialUnavailable:row.trialUnavailable as NonNullable<BusinessDefinitionPreview['trialUnavailable']>})}
}
/** 映射试拉：条数与字段只含标识与取值文本，不带来源原文。 */
function mappingTrial(value:unknown):NonNullable<BusinessDefinitionPreview['mappingTrial']>{
 const row=exact(value,['fetched','objects'])
 if(!Number.isSafeInteger(row.fetched)||Number(row.fetched)<0||Number(row.fetched)>100||!Array.isArray(row.objects)||row.objects.length>Number(row.fetched))throw invalid()
 const objects=row.objects.map(item=>{
  const object=exact(item,['objectId','fields'])
  if(!text(object.objectId,200)||!Array.isArray(object.fields)||object.fields.length>64)throw invalid()
  const fields=object.fields.map(entry=>{const field=exact(entry,['field','value']);if(!fieldName(field.field)||!text(field.value,2000,true))throw invalid();return {field:field.field,value:field.value}})
  if(!unique(fields.map(field=>field.field)))throw invalid()
  return {objectId:object.objectId,fields}
 })
 return {fetched:row.fetched as number,objects}
}

/** 模型目录只含声明，禁止快照、试算和取值样例混入上下文。 */
export function readBusinessDefinitionCatalog(value:unknown,scope:string){
 const row=exact(value,['scope','objectTypes','views','actions'])
 if(row.scope!==scope||scope==='general'||!label(scope,120))throw invalid()
 const read=<T extends {domain:string;id:string}>(value:unknown,reader:(value:unknown)=>T):T[]=>{
  if(!Array.isArray(value))throw invalid()
  let values:T[]
  try{values=value.map(reader)}catch{throw invalid()}
  if(values.some(item=>item.domain!==scope)||!unique(values.map(item=>item.id)))throw invalid()
  return values
 }
 return {scope,objectTypes:read(row.objectTypes,readBusinessObjectTypeDefinition),views:read(row.views,readBusinessViewDefinition),actions:read(row.actions,readBusinessActionDefinition)}
}

type CustomizationServices={local:Pick<BusinessLocalDefinitionService,'directory'|'apply'|'revert'>;preview:Pick<BusinessDefinitionPreviewService,'preview'>}
/** 本人和登记范围只取可信服务；apply/preview 由服务内按 owner 查草案，不能信请求里的范围。 */
export function createBusinessDefinitionHandler(owner:string,scopeIds:()=>Promise<readonly string[]>,get:()=>Promise<Pick<BusinessLedgerService,'read'>>,customization?:()=>Promise<CustomizationServices>){
 return async(endpoint:string,payload:unknown,signal?:AbortSignal):Promise<unknown>=>{
  if(!(businessDefinitionEndpoints as readonly string[]).includes(endpoint))throw new WorkError('teloa/not-found','未提供此业务定制层接口。')
  const keys=endpoint==='business-definitions/ledger'?['scope','objectType','match']:endpoint==='business-definitions/customization'?['scope']:endpoint==='business-definitions/preview'?['draftId','pull']:endpoint==='business-definitions/apply'?['requestId','draftId','expectedDefinitionHash','expectedCurrentVersion','previewReceipt']:['requestId','scope','kind','localId','target','expectedCurrentVersion']
  const row=taskInput(payload,keys)
  if(endpoint!=='business-definitions/ledger'&&keys.some(key=>key!=='pull'&&!Object.hasOwn(row,key)))throw new WorkError('teloa/invalid-input','业务定制请求缺少必要参数。')
  // 试拉标记只表达"用户显式点了试拉"：只收 true。
  if(Object.hasOwn(row,'pull')&&row.pull!==true)throw new WorkError('teloa/invalid-input','试拉标记只能为 true。')
  const scopes=(await scopeIds()).filter(scope=>scope!=='general')
  const scoped=endpoint==='business-definitions/ledger'||endpoint==='business-definitions/customization'||endpoint==='business-definitions/revert'
  if(scoped&&typeof row.scope!=='string')throw new WorkError('teloa/invalid-input','需要明确的业务范围。')
  if(scoped&&!scopes.includes(row.scope as string))throw new WorkError('teloa/forbidden','当前主体未获准读取此业务范围。')
  const actor={ownerId:owner,scopeIds:[...scopes]}
  signal?.throwIfAborted()
  if(endpoint==='business-definitions/ledger')return readBusinessLedger(await(await get()).read(actor,payload,signal),row.scope as string)
  if(!customization)throw new WorkError('teloa/host-unavailable','业务定制服务尚未就绪。')
  const services=await customization()
  if(endpoint==='business-definitions/customization'){
   const result=readBusinessCustomizationDirectory(await services.local.directory(actor,payload,signal),row.scope as string)
   if(result.drafts.some(draft=>draft.ownerId!==owner))throw invalid()
   return result
  }
  if(endpoint==='business-definitions/preview'){
   const result=readBusinessDefinitionPreview(await services.preview.preview(actor,payload,signal))
   if(result.draft.id!==row.draftId||result.draft.ownerId!==owner||!scopes.includes(result.draft.scope))throw invalid()
   return result
  }
  if(endpoint==='business-definitions/apply'&&!receipt(row.previewReceipt))throw new WorkError('teloa/invalid-input','业务定制请求缺少有效的预览回执。')
  const result=await(endpoint==='business-definitions/apply'?services.local.apply(actor,payload,signal):services.local.revert(actor,payload,signal))
  if(!isRecord(result)||typeof result.scope!=='string'||!scopes.includes(result.scope))throw invalid()
  const entry=readBusinessCustomizationEntry(result,scoped?row.scope as string:result.scope)
  if(endpoint==='business-definitions/revert'&&(entry.kind!==row.kind||entry.localId!==row.localId))throw invalid()
  if(endpoint==='business-definitions/apply'&&(!entry.current||entry.current.draftId!==row.draftId||entry.current.definitionHash!==row.expectedDefinitionHash))throw invalid()
  return entry
 }
}

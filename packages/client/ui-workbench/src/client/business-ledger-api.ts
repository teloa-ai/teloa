import {
 businessLedgerLimits,businessFieldTypes,businessViewKinds,businessViewCharts,isBusinessMatchField,isBusinessMatchValue,
 readBusinessObjectTypeDefinition,readBusinessActionDefinition,localizedMetadata,
 type BusinessLedger,type BusinessLedgerBlock,type BusinessLedgerObject,type BusinessViewResult,
 type BusinessViewRow,type BusinessObjectTypeRecord,type BusinessActionRecord,type BusinessDefinitionSource,
 type BusinessObjectTypeDefinition,type BusinessViewCoverage,
 type BusinessChartType,type BusinessFieldType,type BusinessViewKind,
} from '@teloa/contract'

/** `match`：组件下钻的对象清单筛选，只能与 `objectType` 同现（服务端在内存里做等值比较，不进 SQL）。 */
export type BusinessLedgerRequest={scope:string;objectType?:string;match?:{field:string;value:string}}

type Call=(method:string,payload:unknown,signal?:AbortSignal)=>Promise<unknown>

function invalid(message='业务台账回包的来源、范围或声明版本不一致。'):Error{return Error(message)}
function isRecord(value:unknown):value is Record<string,unknown>{return typeof value==='object'&&value!==null&&!Array.isArray(value)}
function exact(value:unknown,keys:readonly string[]):Record<string,unknown>{
 if(!isRecord(value)||Object.keys(value).some(key=>!keys.includes(key))||keys.some(key=>!Object.hasOwn(value,key)))throw invalid()
 return value
}
const text=(value:unknown,max:number,empty=false):value is string=>typeof value==='string'&&(empty||!!value.trim())&&value===value.trim()&&value.length<=max&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)
const stamp=(value:unknown):value is string=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value
const hash=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)
function localizedTitle(value:unknown,original:string,max:number){
 const row=exact(value,['title'])
 let title
 try{title=localizedMetadata(row.title)}catch{throw invalid()}
 if(title.original!==original||Object.values(title.locales).some(item=>typeof item==='string'&&(!text(item,max)||/[\r\n]/.test(item))))throw invalid()
 return {title}
}
function localizedLabel(value:unknown,original:string,max:number){
 const row=exact(value,['label'])
 let label
 try{label=localizedMetadata(row.label)}catch{throw invalid()}
 if(label.original!==original||Object.values(label.locales).some(item=>typeof item==='string'&&(!text(item,max)||/[\r\n]/.test(item))))throw invalid()
 return {label}
}

/** 与 `businessObjectSnapshotHash`（packages/backend/src/work/business-data.ts:59）同一条：同键序的 JSON 摘要。 */
async function digest(value:unknown):Promise<string>{
 const bytes=new TextEncoder().encode(JSON.stringify(value))
 const result=await crypto.subtle.digest('SHA-256',bytes)
 return Array.from(new Uint8Array(result),byte=>byte.toString(16).padStart(2,'0')).join('')
}

function definitionSource(value:unknown,scope:string,localId:string):BusinessDefinitionSource{
 const row=exact(value,['loadId','scope','localId','version','contentHash','fileHash','definitionHash','origin'])
 if(!text(row.loadId,200)||row.scope!==scope||row.localId!==localId||!text(row.version,80)||!hash(row.contentHash)||!hash(row.fileHash)||!hash(row.definitionHash))throw invalid()
 if(row.origin!=='template'&&row.origin!=='local')throw invalid()
 return {loadId:row.loadId,scope:row.scope as string,localId:row.localId as string,version:row.version,contentHash:row.contentHash,fileHash:row.fileHash,definitionHash:row.definitionHash,origin:row.origin}
}

function objectTypeRecord(value:unknown,scope:string):BusinessObjectTypeRecord{
 const row=exact(value,['source','definition'])
 let definition:BusinessObjectTypeDefinition
 // 契约读取函数抛的是 WorkError；界面只认一条统一的回包不一致，不把内部错误码透出去。
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
 * 一条对象：形状核对之后必须用 `crypto.subtle.digest` 重算 `snapshotHash`。
 * 判据与 `readBusinessDataPage`（business-data-api.ts:82）逐字相同，不放宽——
 * 台账换了一条读取路径，固定快照的核对强度不该跟着降一档。
 */
async function ledgerObject(value:unknown,scope:string,objectType:string):Promise<BusinessLedgerObject>{
 const row=exact(value,['id','title','source','observedAt','receivedAt','quality','version','snapshotHash','summary','fields'])
 if(!text(row.id,200)||!text(row.title,240)||!text(row.source,120)||!stamp(row.observedAt)||!stamp(row.receivedAt)||String(row.receivedAt)<String(row.observedAt))throw invalid()
 if(row.quality!=='complete'&&row.quality!=='missing')throw invalid()
 if(!Number.isSafeInteger(row.version)||Number(row.version)<1||Number(row.version)>2147483647)throw invalid()
 if(!hash(row.snapshotHash)||!text(row.summary,4000,true)||!Array.isArray(row.fields)||row.fields.length>50)throw invalid()
 const fields:Array<{label:string;value:string}>=[]
 for(const item of row.fields){const field=exact(item,['label','value']);if(!text(field.label,120)||!text(field.value,2000,true))throw invalid();fields.push({label:field.label,value:field.value})}
 if(new Set(fields.map(field=>field.label)).size!==fields.length)throw invalid()
 const snapshot={scope,type:objectType,id:row.id,version:row.version,title:row.title,source:row.source,observedAt:row.observedAt,receivedAt:row.receivedAt,quality:row.quality,summary:row.summary,fields}
 if(await digest(snapshot)!==row.snapshotHash)throw invalid('业务对象固定快照的摘要不一致。')
 return {id:row.id,title:row.title,source:row.source,observedAt:row.observedAt,receivedAt:row.receivedAt,quality:row.quality,version:row.version as number,snapshotHash:row.snapshotHash,summary:row.summary,fields}
}

/** 覆盖率三项：块级与视图级用同一条判据，不各写一份。 */
function coverage(value:unknown):BusinessViewCoverage{
 const row=exact(value,['objects','latestReceivedAt','truncated'])
 if(!Number.isSafeInteger(row.objects)||Number(row.objects)<0||Number(row.objects)>businessLedgerLimits.scanRows||(row.latestReceivedAt!==null&&!stamp(row.latestReceivedAt))||typeof row.truncated!=='boolean')throw invalid()
 return {objects:row.objects as number,latestReceivedAt:row.latestReceivedAt as string|null,truncated:row.truncated}
}

async function viewResult(value:unknown,scope:string,objectType:string):Promise<BusinessViewResult>{
 if(!isRecord(value))throw invalid()
 const hasObjects=value.objects!==undefined,hasLocalized=value.localized!==undefined,hasDimensionField=value.dimensionField!==undefined
 const keys=['schema','viewId','viewVersion','definitionHash','origin','kind','chart','title',...(hasLocalized?['localized']:[]),...(hasDimensionField?['dimensionField']:[]),'scope','objectType','computedAt','measures','rows','dimensionValues','coverage','missingFields',...(hasObjects?['objects']:[])]
 const row=exact(value,keys)
 if(row.schema!=='teloa.business-view-result/v1'||!text(row.viewId,120)||!text(row.viewVersion,80)||!hash(row.definitionHash))throw invalid()
 // 这份结果算的是模板声明还是本地定制声明，由宿主逐字带出来，不从 definitionHash 或 loadId 反推（契约 business-definitions.ts 同一条理由）。
 if(row.origin!=='template'&&row.origin!=='local')throw invalid()
 // 形态与图表按契约那张 kind×chart 允许组合表核对；界面据此选组件，不再从行的形状反推。
 if(!(businessViewKinds as readonly string[]).includes(row.kind as string))throw invalid()
 const kind=row.kind as BusinessViewKind
 if(!businessViewCharts[kind].includes(row.chart as BusinessChartType)||!text(row.title,120))throw invalid()
 const localized=hasLocalized?localizedTitle(row.localized,row.title as string,120):undefined
 if(hasDimensionField&&(typeof row.dimensionField!=='string'||!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(row.dimensionField)))throw invalid()
 // 只有清单视图带 objects 段：形态位与这条编码必须互相印证，对不上即整条拒收。
 if(hasObjects!==(kind==='list'))throw invalid()
 if(row.scope!==scope||row.objectType!==objectType||!stamp(row.computedAt))throw invalid()
 if(!Array.isArray(row.measures)||!row.measures.length||row.measures.length>businessLedgerLimits.measures)throw invalid()
 const measures=row.measures.map(item=>{
  const hasFieldType=isRecord(item)&&item.fieldType!==undefined,hasMeasureLocalized=isRecord(item)&&item.localized!==undefined
  const measure=exact(item,['id','label',...(hasMeasureLocalized?['localized']:[]),...(hasFieldType?['fieldType']:[])])
  if(!text(measure.id,64)||!text(measure.label,80))throw invalid()
  if(hasFieldType&&!(businessFieldTypes as readonly string[]).includes(measure.fieldType as string))throw invalid()
  const localized=hasMeasureLocalized?localizedLabel(measure.localized,measure.label as string,80):undefined
  return {id:measure.id as string,label:measure.label as string,...(localized?{localized}:{}),...(hasFieldType?{fieldType:measure.fieldType as BusinessFieldType}:{})}
 })
 if(new Set(measures.map(measure=>measure.id)).size!==measures.length)throw invalid()
 if(!Array.isArray(row.rows)||row.rows.length>businessLedgerLimits.listRows)throw invalid()
 const rows:BusinessViewRow[]=row.rows.map(item=>{
  const line=exact(item,['dimension','label','values'])
  if(typeof line.dimension!=='string'||!text(line.label,240,true)||!Array.isArray(line.values)||line.values.length!==measures.length)throw invalid()
  if(line.values.some(entry=>entry!==null&&!(typeof entry==='number'&&Number.isFinite(entry))))throw invalid()
  return {dimension:line.dimension,label:line.label as string,values:[...line.values] as Array<number|null>}
 })
 // 截断前的组数不可能少于画出来的行数，也不可能多过一次扫描的上限。
 if(!Number.isSafeInteger(row.dimensionValues)||Number(row.dimensionValues)<rows.length||Number(row.dimensionValues)>businessLedgerLimits.scanRows)throw invalid()
 const cov=coverage(row.coverage)
 if(!Array.isArray(row.missingFields)||row.missingFields.some(field=>!text(field,64)))throw invalid()
 let objects:BusinessLedgerObject[]|undefined
 if(hasObjects){
  if(!Array.isArray(row.objects)||row.objects.length!==rows.length)throw invalid()
  objects=[]
  for(const [index,item] of row.objects.entries()){
   const object=await ledgerObject(item,scope,objectType)
   // 同长同序：第 i 个对象的标识就是第 i 行的维度取值；乱序即拒收，不在界面上重新配对。
   if(object.id!==rows[index]!.dimension)throw invalid()
   objects.push(object)
  }
 }
 return {
  schema:'teloa.business-view-result/v1',viewId:row.viewId,viewVersion:row.viewVersion,definitionHash:row.definitionHash,origin:row.origin,
  kind,chart:row.chart as BusinessChartType,title:row.title,...(localized?{localized}:{}),...(hasDimensionField?{dimensionField:row.dimensionField as string}:{}),
  scope,objectType,computedAt:row.computedAt,measures,rows,dimensionValues:row.dimensionValues as number,coverage:cov,
  missingFields:[...row.missingFields] as string[],...(objects?{objects}:{}),
 }
}

async function block(value:unknown,scope:string):Promise<BusinessLedgerBlock>{
 if(!isRecord(value))throw invalid()
 const hasDefaultAction=value.defaultAction!==undefined,hasProgress=value.progress!==undefined
 const row=exact(value,['objectType','objects','source','coverage','missingFields','views',...(hasProgress?['progress']:[]),...(hasDefaultAction?['defaultAction']:[])])
 const objectType=objectTypeRecord(row.objectType,scope)
 if(!Number.isSafeInteger(row.objects)||Number(row.objects)<0)throw invalid()
 const cov=coverage(row.coverage)
 if(cov.objects!==row.objects)throw invalid()
 const declaredProgress=objectType.definition.progress
 // 摘要是否存在由声明逐字决定；缺声明就不能让宿主塞一份猜出来的数字，声明了也不能悄悄漏掉。
 if(hasProgress!==(declaredProgress!==undefined))throw invalid()
 let progress:BusinessLedgerBlock['progress']
 if(hasProgress){
  const value=exact(row.progress,['unfinished','waitingForYou','latestChangedAt'])
  if(!Number.isSafeInteger(value.unfinished)||!Number.isSafeInteger(value.waitingForYou)||Number(value.unfinished)<0||Number(value.waitingForYou)<0||Number(value.unfinished)>cov.objects||Number(value.waitingForYou)>Number(value.unfinished)||(value.latestChangedAt!==null&&!stamp(value.latestChangedAt)))throw invalid()
  if(declaredProgress!.changedAtField===undefined&&value.latestChangedAt!==null)throw invalid()
  progress={unfinished:value.unfinished as number,waitingForYou:value.waitingForYou as number,latestChangedAt:value.latestChangedAt as string|null}
 }
 // 块级缺失披露是全量的：列出来的每个字段名都必须真在这份对象类型声明里，且不重复。
 const declared=new Set(objectType.definition.fields.map(field=>field.name))
 if(!Array.isArray(row.missingFields)||row.missingFields.some(field=>!text(field,64)||!declared.has(field))||new Set(row.missingFields).size!==row.missingFields.length)throw invalid()
 const hasSourceNoun=isRecord(row.source)&&'sourceNoun' in row.source
 const src=exact(row.source,['sourceId','connected',...(hasSourceNoun?['sourceNoun']:[])])
 // 与宿主 business-definitions.ts 一致：来源称呼是一行标签，不允许快照正文的换行或控制字符。
 if(hasSourceNoun&&(!text(src.sourceNoun,12)||/[\x00-\x1f\x7f]/.test(src.sourceNoun)))throw invalid()
 if(!text(src.sourceId,120)||typeof src.connected!=='boolean')throw invalid()
 // 块级来源必须就是对象类型声明绑定的那一个；换一个来源混进来即拒收。
 if(src.sourceId!==objectType.definition.sourceId)throw invalid()
 let defaultAction:BusinessLedgerBlock['defaultAction']
 if(hasDefaultAction){
  const action=exact(row.defaultAction,['actionId','title','targetKind','available'])
  if(!text(action.actionId,120)||!text(action.title,120)||(action.targetKind!=='work-template'&&action.targetKind!=='execution-tool')||typeof action.available!=='boolean')throw invalid()
  defaultAction={actionId:action.actionId,title:action.title,targetKind:action.targetKind,available:action.available}
 }
 if(!Array.isArray(row.views)||row.views.length>businessLedgerLimits.viewsPerType)throw invalid()
 const views:BusinessViewResult[]=[]
 for(const item of row.views)views.push(await viewResult(item,scope,objectType.definition.id))
 if(new Set(views.map(view=>view.viewId)).size!==views.length)throw invalid()
 // 同一个块里每张视图的覆盖面来自同一批行：与块级那份对不上说明两处不是同一次计算。
 if(views.some(view=>view.coverage.objects!==cov.objects||view.coverage.latestReceivedAt!==cov.latestReceivedAt||view.coverage.truncated!==cov.truncated))throw invalid()
 return {objectType,objects:row.objects as number,source:{sourceId:src.sourceId,connected:src.connected,...(hasSourceNoun?{sourceNoun:src.sourceNoun as string}:{})},...(defaultAction?{defaultAction}:{}),coverage:cov,...(progress?{progress}:{}),missingFields:[...row.missingFields] as string[],views}
}

/** 回包逐条核对：范围、声明身份、固定快照摘要、行与对象同序，任一条不符即整条拒收，不以空台账替代。 */
export async function readBusinessLedger(value:unknown,scope:string):Promise<BusinessLedger>{
 const row=exact(value,['schema','scope','computedAt','blocks','actions'])
 if(row.schema!=='teloa.business-ledger/v1'||row.scope!==scope||!stamp(row.computedAt))throw invalid()
 if(!Array.isArray(row.blocks)||row.blocks.length>businessLedgerLimits.objectTypes)throw invalid()
 const blocks:BusinessLedgerBlock[]=[]
 for(const item of row.blocks)blocks.push(await block(item,scope))
 if(new Set(blocks.map(item=>item.objectType.definition.id)).size!==blocks.length)throw invalid()
 // 动作条数没有契约上限（`businessLedgerLimits` 只钉了块与视图），这里也不自造一个：
 // 凭空多钉一道会把合法声明判成「读不出来」，比放过一条长数组更伤人。
 if(!Array.isArray(row.actions))throw invalid()
 const actions:BusinessActionRecord[]=row.actions.map(item=>actionRecord(item,scope))
 // 同一批里每个视图都必须来自同一次计算（规格 §4.3）：块与块之间不能出现互相矛盾的数字。
 if(blocks.some(item=>item.views.some(view=>view.computedAt!==row.computedAt)))throw invalid()
 return {schema:'teloa.business-ledger/v1',scope,computedAt:row.computedAt,blocks,actions}
}

function ledgerRequest(value:BusinessLedgerRequest):BusinessLedgerRequest{
 if(!text(value.scope,120)||value.scope==='general')throw Error('需要明确的业务台账范围。')
 if(value.objectType!==undefined&&!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,119}$/.test(value.objectType))throw Error('业务对象类型标识不合法。')
 const match=value.match
 if(match!==undefined&&(value.objectType===undefined||!isBusinessMatchField(match.field)||!isBusinessMatchValue(match.value)))throw Error('对象筛选不合法。')
 // 只提交契约白名单字段：多一个键都不往宿主递。
 return {scope:value.scope,...(value.objectType===undefined?{}:{objectType:value.objectType}),...(match===undefined?{}:{match:{field:match.field,value:match.value}})}
}

export function createBusinessLedgerApi(call:Call){
 return {async read(request:BusinessLedgerRequest,signal?:AbortSignal):Promise<BusinessLedger>{
  const input=ledgerRequest(request)
  const value=await call('business-definitions/ledger',input,signal)
  return readBusinessLedger(value,input.scope)
 }}
}

export type BusinessLedgerApi=ReturnType<typeof createBusinessLedgerApi>

/** 一个视图在缓存里的身份：范围 + 对象类型 + 视图标识，**不含**声明版本。 */
export function businessLedgerViewIdentity(scope:string,objectType:string,viewId:string):string{
 return JSON.stringify(['teloa.business-view-result/v1',scope,objectType,viewId])
}

/** 缓存键：声明版本一变旧结果整条作废，不做增量合并（规格 §4.3）。 */
export function businessLedgerCacheKey(scope:string,objectType:string|undefined,view:{viewId:string;definitionHash:string}):string{
 return JSON.stringify(['teloa.business-view-result/v1',scope,objectType??'',view.viewId,view.definitionHash])
}

/**
 * 这一块的声明是不是在上一次渲染之后换过版本。判据是缓存键变了而视图身份没变——
 * 键一变就整条作废重算，界面据此标「声明已更新」，永不静默替换（规格 §8 第 5 条）。
 */
export function businessLedgerBlockUpdated(previous:ReadonlyMap<string,string>|undefined,scope:string,block:BusinessLedgerBlock):boolean{
 if(!previous?.size)return false
 return block.views.some(view=>{
  const identity=businessLedgerViewIdentity(scope,view.objectType,view.viewId),seen=previous.get(identity)
  return seen!==undefined&&seen!==businessLedgerCacheKey(scope,view.objectType,view)
 })
}

/** 本次台账里每个视图的缓存键，交给调用方存起来作为下一次的比对基准。 */
export function businessLedgerCacheKeys(ledger:BusinessLedger):Map<string,string>{
 const keys=new Map<string,string>()
 for(const block of ledger.blocks)for(const view of block.views)keys.set(businessLedgerViewIdentity(ledger.scope,view.objectType,view.viewId),businessLedgerCacheKey(ledger.scope,view.objectType,view))
 return keys
}

/**
 * 读台账失败时该说哪一句。宿主拒绝会带上 `code`（`index.ts` 装配处把它挂在 Error 上），
 * 这里只按码选一条固定文案键，**不碰** `details`——那是服务端的诊断字段，不进界面文案。
 * 认不出来的码退回通用那句，不把内部错误码或原始 message 摆到界面上。
 */
export function businessLedgerFailureKey(error:unknown):'business.ledger.readFailed'|'business.ledger.readFailed.forbidden'|'business.ledger.readFailed.corrupt'{
 const code=error!==null&&typeof error==='object'&&'code' in error?String((error as {code:unknown}).code):''
 if(code==='teloa/forbidden')return 'business.ledger.readFailed.forbidden'
 if(code==='teloa/storage-corrupt')return 'business.ledger.readFailed.corrupt'
 // `teloa/source-unavailable` 与形状核对不过的本地错误共用通用那句：它说的正是"声明读不出来，没有用空台账替代"。
 return 'business.ledger.readFailed'
}

/**
 * 对象目录的完整性筛选是界面这一侧的事，与服务端的行数截断是两回事，不能用同一句话糊弄过去
 * （复审 N-2）：筛选把 `dimensionValues` 压成当前显示行数，会连服务端本来就截断的事实一起抹掉。
 * 服务端截断看 `list.dimensionValues` 与 `list.rows.length`——两个都是筛选前的原始值，不受
 * 筛选影响；筛选造成的差额单独判，只在真被筛掉了东西（`shown` 小于筛选前的行数）时才成立。
 */
export function ledgerListTruncation(list:{dimensionValues:number;rows:readonly unknown[]},shown:number):{serverTruncated:boolean;filtered:boolean}{
 return {serverTruncated:list.dimensionValues>list.rows.length,filtered:shown<list.rows.length}
}

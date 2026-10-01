import {WorkError,workErrorCodes,type WorkErrorCode} from './work-error.ts'
import {isRecord} from './resources.ts'
import {localizedMetadata,type LocalizedMetadata} from './localized-metadata.ts'
import {readBusinessSyncSchedule,type BusinessSyncSchedule} from './business-sync-schedule.ts'
import {readBusinessChartSpec,type BusinessChartSpec} from './business-chart-spec.ts'
import type {BusinessDefinitionSource} from './business-definitions.ts'
import {businessScopeKeyRule,isBusinessScopeKey} from './business-scopes.ts'

/**
 * 组件与看板声明（规格 §4.3/§4.4）：组件 = 只读 SQL + 展示配置，看板 = 12 列网格上的组件布局 + 刷新周期。
 * SQL 在契约层只限长度，语法树白名单与改写由服务端做（`BusinessSqlGuard`）；列名跨声明核对也留给服务端。
 * 看板 `filters`（整页时间范围）与组件 `drilldown`（点击下钻）已在二期放开（二期规格 §3.1、§4.1）。
 */
export const businessWidgetKinds=['chart','metric','table','board','pipeline','list','view-ref'] as const
export type BusinessWidgetKind=typeof businessWidgetKinds[number]
/** 整页时间范围的预设键（二期规格 §3.1）：只给相对区间，区间文本由服务端常量映射，界面只选枚举。 */
export const businessTimeRanges=['24h','7d','30d','90d','all'] as const
export type BusinessTimeRange=typeof businessTimeRanges[number]
export type BusinessDashboardFilters={timeRange:{options:BusinessTimeRange[];default:BusinessTimeRange}}
export type BusinessWidgetThreshold={field:string;op:'gte'|'lte';value:number;tone:'good'|'warn'|'bad'}
export type BusinessWidgetLocalizedMetadata={title?:LocalizedMetadata}
/**
 * 组件点击下钻（二期规格 §4.1）：只写 `objectType` 打开该类型的对象清单；`idColumn` 打开该行此列取值对应的单个对象；
 * `match` 打开只看字段 `field` 等于该行 `column` 取值的对象清单。两者互斥；目标类型须有清单视图、`field` 须可等值（跨声明核对在服务端）。
 */
export type BusinessWidgetDrilldown={objectType:string;idColumn?:string;match?:{column:string;field:string}}
export type BusinessWidgetDefinition={
 format:'teloa.business-widget/v1';id:string;version:string;domain:string;title:string;localized?:BusinessWidgetLocalizedMetadata
 kind:BusinessWidgetKind
 /** 只读 SQL，≤ businessDashboardLimits.sqlBytes 字节；`kind!=='view-ref'` 必填，`view-ref` 禁止。 */
 query?:string
 /** `kind==='view-ref'` 必填，指向 `BusinessViewDefinition.id`。 */
 viewRef?:string
 /** `kind==='chart'` 必填，其余禁止。 */
 chart?:BusinessChartSpec
 /** `kind==='metric'` 必填。 */
 metric?:{valueColumn:string;previousColumn?:string;unit?:string}
 /** `kind==='board'` 必填，statuses 1..12 去重。 */
 board?:{statusColumn:string;titleColumn:string;idColumn:string;statuses:string[]}
 /** `kind==='pipeline'` 必填，stages 1..12 去重。 */
 pipeline?:{stageColumn:string;countColumn:string;durationColumn?:string;stages:string[]}
 /** `kind==='table'|'list'` 可选，缺省全列。 */
 table?:{columns:string[]}
 /** ≤ 4。 */
 thresholds?:BusinessWidgetThreshold[]
 /** 与看板 `refresh` 同口径；短周期确认位写在顶层，不写进 `refresh`。 */
 refresh?:BusinessSyncSchedule;acknowledgeShortInterval?:boolean
 /** 接入整页时间范围：`table` 是 SQL 里写的逻辑表名（对象类型 id 的 `-` 写成 `_`），`column` 是它的 datetime 字段或 `_observed_at` / `_synced_at`（跨声明核对在服务端）。 */
 timeFilter?:{table:string;column:string}
 /** `view-ref` 禁止；`metric` 只许写 `objectType`；`pipeline` 的 `match.column` 即 `stageColumn`；`chart` 用到的列须在图表编码里。 */
 drilldown?:BusinessWidgetDrilldown
}
/** 12 列网格：0≤x<12、1≤w≤12、x+w≤12、1≤h≤12、y≥0。 */
export type BusinessDashboardLayoutItem={widget:string;x:number;y:number;w:number;h:number}
export type BusinessDashboardLocalizedMetadata={title?:LocalizedMetadata}
export type BusinessDashboardDefinition={
 format:'teloa.business-dashboard/v1';id:string;version:string;domain:string;title:string;localized?:BusinessDashboardLocalizedMetadata
 /** 1..12，去重，每项须在 layout 出现且仅一次。 */
 widgets:string[]
 /** 不得重叠。 */
 layout:BusinessDashboardLayoutItem[]
 refresh:BusinessSyncSchedule;acknowledgeShortInterval:boolean
 /** 整页时间范围；至少一个组件带 `timeFilter`（跨声明核对在服务端）。 */
 filters?:BusinessDashboardFilters
}
/** 声明包里的一条组件 / 看板：形状照 `BusinessViewRecord`，来源身份与三种既有声明同一套。 */
export type BusinessWidgetRecord={source:BusinessDefinitionSource;definition:BusinessWidgetDefinition}
export type BusinessDashboardRecord={source:BusinessDefinitionSource;definition:BusinessDashboardDefinition}
/** 资源与执行边界上限，全是字面量常量，不做设置项。 */
export const businessDashboardLimits={widgetsPerDashboard:12,dashboardsPerScope:16,widgetsPerScope:64,sqlBytes:8192,resultRows:10_000,rowBytes:1_048_576,resultBytes:8_388_608,concurrencyPerScope:5,queueWaitMs:10_000,statementTimeoutMs:5_000,workMem:'256MB',tempFileLimit:'512MB',retentionDays:90,scopeRowQuota:500_000} as const

/** 结果快照（读侧）：服务端表 `teloa_business_widget_results` 的一行。一期不截断，超限即 failed。 */
export type BusinessWidgetColumn={name:string;type:'text'|'number'|'boolean'|'datetime'|'null'}
export type BusinessWidgetCell=string|number|boolean|null
export type BusinessWidgetResult={widgetId:string;definitionHash:string;computedAt:string;status:'ok'|'failed';columns:BusinessWidgetColumn[];rows:BusinessWidgetCell[][];rowCount:number;truncated:false;bytes:number;error?:{code:WorkErrorCode;reason:string};stale:boolean}
export type BusinessDashboardPage={schema:'teloa.business-dashboard-page/v1';scope:string;dashboard:BusinessDashboardDefinition;widgets:BusinessWidgetDefinition[];results:BusinessWidgetResult[];updatedAt:string|null;nextRefreshAt:string|null;refreshing:boolean
 /** 看板无 `filters` 时为 null；否则 options 与声明一致、selected 是本页结果所按的范围。 */
 timeRange:{selected:BusinessTimeRange;options:BusinessTimeRange[]}|null
}
export type BusinessDashboardSummary={id:string;title:string;localized?:{title?:LocalizedMetadata};widgets:number;updatedAt:string|null}
export const businessDashboardEndpoints=['business-dashboards/list','business-dashboards/read','business-dashboards/refresh','business-sync/status','business-sync/runs','business-sync/run','business-sync/rules'] as const
/** 持久启用授权只走已认证本人浏览器分发，不能放进普通工具端点白名单。 */
export const businessSyncRuleWriteEndpoint='business-sync/rule-set' as const
export const businessWidgetColumnTypes=['text','number','boolean','datetime','null'] as const

const bad=(message:string)=>new WorkError('teloa/invalid-input',message)
const maxNamedFields=8
/** 缺键/多键都指出具体字段名，照 `business-definitions.ts` 的 `exact`。 */
const exact=(value:unknown,keys:readonly string[],message:string):Record<string,unknown>=>{
 if(!isRecord(value))throw bad(message)
 const missing=keys.filter(key=>!(key in value)),extra=Object.keys(value).filter(key=>!keys.includes(key))
 if(!missing.length&&!extra.length)return value
 const parts:string[]=[]
 if(missing.length)parts.push('缺少字段 '+missing.slice(0,maxNamedFields).join('、'))
 if(extra.length)parts.push('不认识的字段 '+extra.slice(0,maxNamedFields).join('、'))
 throw bad(message.replace(/。$/,'')+'：'+parts.join('；')+'。')
}
/** 可选键：返回取值不是 `undefined` 的那些可选键，供拼进 exact 的键表；键在而取值为 `undefined` 时不列入，exact 会把它报为不认识的字段。 */
const optional=(value:unknown,keys:readonly string[])=>isRecord(value)?keys.filter(key=>value[key]!==undefined):[]
/** 回显原值只取前 80 字：原值来自声明正文，整段回显会把任意长的文本带进错误文案与模型上下文。 */
const invalidEnum=(message:string,value:unknown,allowed:readonly string[]):WorkError=>{const shown=String(value);return bad(message.replace(/。$/,'')+'，当前为「'+(shown.length>80?shown.slice(0,80)+'…':shown)+'」，允许：'+allowed.join(' / ')+'。')}
function atPath<T>(path:string,run:()=>T):T{
 try{return run()}
 catch(error){if(error instanceof WorkError)throw new WorkError(error.code,path+'：'+error.message);throw error}
}
/** 以下判据与 `business-definitions.ts` 逐字相同：本地标识、精确三段号、单行标签、业务范围。 */
const localId=/^[a-zA-Z0-9][a-zA-Z0-9-]{0,119}$/
const exactSemver=/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const label=(value:unknown,max:number):value is string=>typeof value==='string'&&!!value.trim()&&value===value.trim()&&value.length<=max&&!/[\x00-\x08\x0a-\x1f\x7f]/.test(value)
const domainText=(value:unknown):value is string=>isBusinessScopeKey(value)&&value!=='general'
const semver=(value:unknown):value is string=>typeof value==='string'&&value.length<=80&&exactSemver.test(value)
/** SQL 结果列名：PostgreSQL 标识符上限 63 字节，只认 ASCII 标识符（大小写敏感，与 `AS` 别名逐字对应）。 */
const columnName=/^[A-Za-z_][A-Za-z0-9_]{0,62}$/
const column=(value:unknown):value is string=>typeof value==='string'&&columnName.test(value)
const dedup=(value:unknown,min:number,max:number,item:(value:unknown)=>boolean):value is string[]=>Array.isArray(value)&&value.length>=min&&value.length<=max&&new Set(value).size===value.length&&value.every(item)
const utcStamp=(value:unknown):value is string=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)&&!value.startsWith('0000-')&&new Date(value).toISOString()===value
const count=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>=0
const gridInt=(value:unknown,min:number,max:number):value is number=>Number.isSafeInteger(value)&&Number(value)>=min&&Number(value)<=max
const timeRange=(value:unknown):value is BusinessTimeRange=>(businessTimeRanges as readonly unknown[]).includes(value)
/** timeFilter.table：逻辑表名（对象类型 id 的 `-` 已写成 `_`）；column：对象字段标识（与 `business-definitions.ts` 的字段标识同一判据）或两个系统时间列。 */
const logicalTable=/^[a-zA-Z0-9][a-zA-Z0-9_]{0,119}$/
const timeColumn=(value:unknown):value is string=>typeof value==='string'&&(value==='_observed_at'||value==='_synced_at'||/^[a-z0-9][a-z0-9_-]{0,62}$/.test(value))
/** drilldown.match.field：对象字段标识（与 `business-definitions.ts` 的字段标识同一判据）。 */
const fieldName=/^[a-z0-9][a-z0-9_-]{0,62}$/
/**
 * 按字段取值过滤（组件下钻 → 对象清单）的共用判据，客户端台账请求、导航恢复、右栏页签与宿主台账入参都引用这里：
 * 字段是对象字段标识或保留字 `_id`（对象标识）；取值 1–200 字、无控制字符。
 */
export const isBusinessMatchField=(value:unknown):value is string=>typeof value==='string'&&(value==='_id'||fieldName.test(value))
export const isBusinessMatchValue=(value:unknown):value is string=>typeof value==='string'&&value.length>=1&&value.length<=200&&!/[\x00-\x1f\x7f]/.test(value)

function titleLocalized(value:unknown,title:string,message:string):{title?:LocalizedMetadata}{
 if(!isRecord(value)||!Object.keys(value).length||Object.keys(value).some(key=>key!=='title'))throw bad(message)
 const result:{title?:LocalizedMetadata}={}
 if(value.title!==undefined){
  let metadata:LocalizedMetadata
  try{metadata=localizedMetadata(value.title)}catch{throw bad(message)}
  if(metadata.original!==title||Object.values(metadata.locales).some(item=>typeof item==='string'&&!label(item,120)))throw bad(message)
  result.title=metadata
 }
 return result
}
/** 周期与顶层确认位：确认位不得写进周期对象，读时合并后交给同一读取器（照映射声明）。 */
function refreshOf(refresh:unknown,acknowledge:unknown):{refresh:BusinessSyncSchedule;acknowledgeShortInterval:boolean}{
 if(typeof acknowledge!=='boolean')throw bad('acknowledgeShortInterval 必须是布尔值。')
 if(!isRecord(refresh))throw bad('refresh：刷新周期格式不正确。')
 if('acknowledgeShortInterval' in refresh)throw bad('refresh：短周期确认位请写在声明顶层的 acknowledgeShortInterval，不写进 refresh 里。')
 const {schedule,acknowledgeShortInterval}=atPath('refresh',()=>readBusinessSyncSchedule({...refresh,acknowledgeShortInterval:acknowledge}))
 return {refresh:schedule,acknowledgeShortInterval}
}
function head(row:Record<string,unknown>,format:string,noun:string):void{
 if(row.format!==format)throw invalidEnum(noun+'格式不正确。',row.format,[format])
 if(typeof row.id!=='string'||!localId.test(row.id))throw bad(noun+'标识不合法。')
 if(!semver(row.version))throw bad(noun+'版本必须是精确三段号。')
 if(!domainText(row.domain))throw bad(noun+'所属业务范围不合法：'+businessScopeKeyRule+'，general 一律拒绝。')
 if(!label(row.title,120))throw bad(noun+'标题不合法。')
}
const kindOnly=(kind:BusinessWidgetKind,key:string,allowed:readonly BusinessWidgetKind[],present:boolean)=>{
 if(allowed.includes(kind)&&!present&&key!=='table')throw bad(`组件种类 ${kind} 必须声明 ${key}。`)
 if(!allowed.includes(kind)&&present)throw bad(`组件种类 ${kind} 不得声明 ${key}。`)
}

function threshold(value:unknown):BusinessWidgetThreshold{
 const row=exact(value,['field','op','value','tone'],'阈值格式不正确。')
 if(!column(row.field))throw bad('阈值列名不合法。')
 if(row.op!=='gte'&&row.op!=='lte')throw invalidEnum('阈值算子不合法。',row.op,['gte','lte'])
 if(typeof row.value!=='number'||!Number.isFinite(row.value))throw bad('阈值必须是有限数字。')
 if(row.tone!=='good'&&row.tone!=='warn'&&row.tone!=='bad')throw invalidEnum('阈值色调不合法。',row.tone,['good','warn','bad'])
 return {field:row.field,op:row.op,value:row.value,tone:row.tone}
}

export function readBusinessWidgetDefinition(value:unknown):BusinessWidgetDefinition{
 if(!isRecord(value))throw bad('组件声明格式不正确。')
 const present=optional(value,['localized','query','viewRef','chart','metric','board','pipeline','table','thresholds','refresh','acknowledgeShortInterval','timeFilter','drilldown'])
 const row=exact(value,['format','id','version','domain','title','kind',...present],'组件声明格式不正确。')
 head(row,'teloa.business-widget/v1','组件声明')
 if(!(businessWidgetKinds as readonly string[]).includes(row.kind as string))throw invalidEnum('组件种类不合法。',row.kind,businessWidgetKinds)
 const kind=row.kind as BusinessWidgetKind,has=(key:string)=>present.includes(key)
 kindOnly(kind,'query',businessWidgetKinds.filter(item=>item!=='view-ref'),has('query'))
 kindOnly(kind,'viewRef',['view-ref'],has('viewRef'))
 kindOnly(kind,'chart',['chart'],has('chart'))
 kindOnly(kind,'metric',['metric'],has('metric'))
 kindOnly(kind,'board',['board'],has('board'))
 kindOnly(kind,'pipeline',['pipeline'],has('pipeline'))
 kindOnly(kind,'table',['table','list'],has('table'))
 const result:BusinessWidgetDefinition={format:'teloa.business-widget/v1',id:row.id as string,version:row.version as string,domain:row.domain as string,title:row.title as string,kind}
 if(has('localized'))result.localized=titleLocalized(row.localized,result.title,'组件标题本地化元数据不合法。')
 if(has('query')){
  if(typeof row.query!=='string'||!row.query.trim()||row.query.includes('\u0000'))throw bad('组件 SQL 必须是非空文本。')
  if(new TextEncoder().encode(row.query).byteLength>businessDashboardLimits.sqlBytes)throw bad('组件 SQL 超过 '+businessDashboardLimits.sqlBytes+' 字节。')
  result.query=row.query
 }
 if(has('viewRef')){
  if(typeof row.viewRef!=='string'||!localId.test(row.viewRef))throw bad('组件引用的视图标识不合法。')
  result.viewRef=row.viewRef
 }
 if(has('chart'))result.chart=atPath('chart',()=>readBusinessChartSpec(row.chart))
 if(has('metric')){
  const metric=atPath('metric',()=>exact(row.metric,['valueColumn',...optional(row.metric,['previousColumn','unit'])],'指标配置格式不正确。'))
  if(!column(metric.valueColumn)||(metric.previousColumn!==undefined&&!column(metric.previousColumn)))throw bad('metric：指标列名不合法。')
  if(metric.unit!==undefined&&!label(metric.unit,16))throw bad('metric：指标单位不合法。')
  result.metric={valueColumn:metric.valueColumn,...(metric.previousColumn!==undefined?{previousColumn:metric.previousColumn as string}:{}),...(metric.unit!==undefined?{unit:metric.unit as string}:{})}
 }
 if(has('board')){
  const board=atPath('board',()=>exact(row.board,['statusColumn','titleColumn','idColumn','statuses'],'看板卡片配置格式不正确。'))
  if(!column(board.statusColumn)||!column(board.titleColumn)||!column(board.idColumn))throw bad('board：列名不合法。')
  if(!dedup(board.statuses,1,12,item=>label(item,80)))throw bad('board：状态列必须是 1–12 个去重取值。')
  result.board={statusColumn:board.statusColumn,titleColumn:board.titleColumn,idColumn:board.idColumn,statuses:[...board.statuses]}
 }
 if(has('pipeline')){
  const pipeline=atPath('pipeline',()=>exact(row.pipeline,['stageColumn','countColumn',...optional(row.pipeline,['durationColumn']),'stages'],'流水线配置格式不正确。'))
  if(!column(pipeline.stageColumn)||!column(pipeline.countColumn)||(pipeline.durationColumn!==undefined&&!column(pipeline.durationColumn)))throw bad('pipeline：列名不合法。')
  if(!dedup(pipeline.stages,1,12,item=>label(item,80)))throw bad('pipeline：阶段必须是 1–12 个去重取值。')
  result.pipeline={stageColumn:pipeline.stageColumn,countColumn:pipeline.countColumn,...(pipeline.durationColumn!==undefined?{durationColumn:pipeline.durationColumn as string}:{}),stages:[...pipeline.stages]}
 }
 if(has('table')){
  const table=atPath('table',()=>exact(row.table,['columns'],'表格配置格式不正确。'))
  if(!dedup(table.columns,1,64,column))throw bad('table：列必须是 1–64 个去重列名。')
  result.table={columns:[...table.columns]}
 }
 if(has('thresholds')){
  if(!Array.isArray(row.thresholds)||row.thresholds.length>4)throw bad('阈值不得超过 4 条。')
  result.thresholds=row.thresholds.map((item,index)=>atPath(`thresholds[${index}]`,()=>threshold(item)))
 }
 if(has('acknowledgeShortInterval')&&!has('refresh'))throw bad('acknowledgeShortInterval 只能与 refresh 一起声明。')
 if(has('refresh')){
  const refresh=refreshOf(row.refresh,has('acknowledgeShortInterval')?row.acknowledgeShortInterval:false)
  result.refresh=refresh.refresh
  if(has('acknowledgeShortInterval'))result.acknowledgeShortInterval=refresh.acknowledgeShortInterval
 }
 if(has('timeFilter')){
  // view-ref 没有 SQL 可注入；上期对比列要读窗口之外的数据，整页范围一截就把上期截成 0（二期规格 §3.1）。
  if(kind==='view-ref')throw bad('组件种类 view-ref 不得声明 timeFilter：它没有 SQL，整页时间范围无从生效。')
  if(result.metric?.previousColumn!==undefined)throw bad('metric.previousColumn 与 timeFilter 不能同时声明：上期对比要读时间范围之外的数据。')
  const filter=atPath('timeFilter',()=>exact(row.timeFilter,['table','column'],'时间范围接入配置格式不正确。'))
  if(typeof filter.table!=='string'||!logicalTable.test(filter.table))throw bad('timeFilter：表名不合法，须是 SQL 里写的逻辑表名。')
  if(!timeColumn(filter.column))throw bad('timeFilter：列名不合法，须是对象字段标识或 _observed_at / _synced_at。')
  result.timeFilter={table:filter.table,column:filter.column}
 }
 if(has('drilldown'))result.drilldown=drilldownOf(row.drilldown,result)
 return result
}

/** 下钻：点哪一行、取哪一列在各种类里必须说得清，说不清的写法在这里就拒（声明收下即生效）。 */
function drilldownOf(value:unknown,widget:BusinessWidgetDefinition):BusinessWidgetDrilldown{
 const kind=widget.kind
 if(kind==='view-ref')throw bad('组件种类 view-ref 不得声明 drilldown：视图引用本身就是台账视图。')
 const row=atPath('drilldown',()=>exact(value,['objectType',...optional(value,['idColumn','match'])],'下钻配置格式不正确。'))
 if(typeof row.objectType!=='string'||!localId.test(row.objectType))throw bad('drilldown：对象类型标识不合法。')
 if(row.idColumn!==undefined&&row.match!==undefined)throw bad('drilldown：idColumn 与 match 只能写一个。')
 if(kind==='metric'&&(row.idColumn!==undefined||row.match!==undefined))throw bad('组件种类 metric 的 drilldown 只能写 objectType：指标卡只有一行，没有可点的维度。')
 if(kind==='pipeline'&&row.idColumn!==undefined)throw bad('组件种类 pipeline 的 drilldown 不得写 idColumn：阶段是聚合出来的，对不上单个对象。')
 const result:BusinessWidgetDrilldown={objectType:row.objectType}
 if(row.idColumn!==undefined){
  if(!column(row.idColumn))throw bad('drilldown：idColumn 列名不合法。')
  result.idColumn=row.idColumn
 }
 if(row.match!==undefined){
  const match=atPath('drilldown.match',()=>exact(row.match,['column','field'],'下钻取值匹配配置格式不正确。'))
  if(!column(match.column))throw bad('drilldown.match：column 列名不合法。')
  if(typeof match.field!=='string'||!fieldName.test(match.field))throw bad('drilldown.match：field 须是对象字段标识。')
  if(kind==='pipeline'&&match.column!==widget.pipeline!.stageColumn)throw bad('drilldown.match：流水线的 column 须是 stageColumn（'+widget.pipeline!.stageColumn+'），点的是阶段。')
  result.match={column:match.column,field:match.field}
 }
 const used=result.idColumn??result.match?.column
 if(kind==='chart'&&used!==undefined&&!chartFields(widget.chart!.spec).includes(used))throw bad('drilldown：下钻用到的列 '+used+' 不在图表编码字段里，点击图形时数据里没有这一列。')
 return result
}

function filtersOf(value:unknown):BusinessDashboardFilters{
 const row=atPath('filters',()=>exact(value,['timeRange'],'看板筛选格式不正确。'))
 const range=atPath('filters.timeRange',()=>exact(row.timeRange,['options','default'],'时间范围配置格式不正确。'))
 if(!dedup(range.options,1,businessTimeRanges.length,timeRange))throw bad('filters.timeRange：options 必须是 1–'+businessTimeRanges.length+' 个去重取值，允许：'+businessTimeRanges.join(' / ')+'。')
 if(!timeRange(range.default)||!range.options.includes(range.default))throw bad('filters.timeRange：default 必须是 options 中的一项。')
 return {timeRange:{options:[...range.options] as BusinessTimeRange[],default:range.default}}
}

function layoutItem(value:unknown):BusinessDashboardLayoutItem{
 const row=exact(value,['widget','x','y','w','h'],'布局项格式不正确。')
 if(typeof row.widget!=='string'||!localId.test(row.widget))throw bad('布局项的组件标识不合法。')
 if(!gridInt(row.x,0,11)||!gridInt(row.w,1,12)||Number(row.x)+Number(row.w)>12)throw bad('布局项越出 12 列网格：要求 0≤x<12、1≤w≤12、x+w≤12。')
 if(!gridInt(row.h,1,12)||!gridInt(row.y,0,Number.MAX_SAFE_INTEGER))throw bad('布局项高度须为 1–12、纵向位置须为非负整数。')
 return {widget:row.widget,x:row.x as number,y:row.y as number,w:row.w as number,h:row.h as number}
}

export function readBusinessDashboardDefinition(value:unknown):BusinessDashboardDefinition{
 if(!isRecord(value))throw bad('看板声明格式不正确。')
 const present=optional(value,['localized','filters'])
 const row=exact(value,['format','id','version','domain','title','widgets','layout','refresh','acknowledgeShortInterval',...present],'看板声明格式不正确。')
 head(row,'teloa.business-dashboard/v1','看板声明')
 if(!dedup(row.widgets,1,businessDashboardLimits.widgetsPerDashboard,item=>typeof item==='string'&&localId.test(item)))throw bad('看板组件必须是 1–'+businessDashboardLimits.widgetsPerDashboard+' 个去重的组件标识。')
 const widgets=row.widgets
 if(!Array.isArray(row.layout))throw bad('看板布局必须是数组。')
 const layout=row.layout.map((item,index)=>atPath(`layout[${index}]`,()=>layoutItem(item)))
 const placed=layout.map(item=>item.widget)
 if(placed.length!==widgets.length||new Set(placed).size!==placed.length||widgets.some(widget=>!placed.includes(widget)))throw bad('看板布局必须为每个组件恰好放置一次，且不得放置未列出的组件。')
 for(let left=0;left<layout.length;left++)for(let right=left+1;right<layout.length;right++){
  const a=layout[left]!,b=layout[right]!
  if(a.x<b.x+b.w&&b.x<a.x+a.w&&a.y<b.y+b.h&&b.y<a.y+a.h)throw bad(`看板布局重叠：${a.widget} 与 ${b.widget}。`)
 }
 const refresh=refreshOf(row.refresh,row.acknowledgeShortInterval)
 const result:BusinessDashboardDefinition={format:'teloa.business-dashboard/v1',id:row.id as string,version:row.version as string,domain:row.domain as string,title:row.title as string,widgets:[...widgets],layout,...refresh}
 if(present.includes('localized'))result.localized=titleLocalized(row.localized,result.title,'看板标题本地化元数据不合法。')
 if(present.includes('filters'))result.filters=filtersOf(row.filters)
 return result
}

/** 回包读取：宿主给出的看板页形状不对是宿主问题，一律 `teloa/invalid-host-response`。 */
const hostError=(message:string)=>new WorkError('teloa/invalid-host-response',message)
function host<T>(run:()=>T):T{
 try{return run()}
 catch(error){if(error instanceof WorkError&&error.code==='teloa/invalid-input')throw hostError(error.message);throw error}
}
const hash=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)
const cell=(value:unknown)=>value===null||typeof value==='string'||typeof value==='boolean'||(typeof value==='number'&&Number.isFinite(value))

function widgetResult(value:unknown):BusinessWidgetResult{
 const hasError=isRecord(value)&&value.error!==undefined
 const row=exact(value,['widgetId','definitionHash','computedAt','status','columns','rows','rowCount','truncated','bytes',...(hasError?['error']:[]),'stale'],'组件结果格式不正确。')
 if(typeof row.widgetId!=='string'||!localId.test(row.widgetId)||!hash(row.definitionHash)||!utcStamp(row.computedAt))throw bad('组件结果的标识、哈希或计算时刻不合法。')
 if(row.status!=='ok'&&row.status!=='failed')throw invalidEnum('组件结果状态不合法。',row.status,['ok','failed'])
 if(row.status==='ok'?hasError:!hasError)throw bad('组件结果的错误信息与状态不一致：ok 不得带 error，failed 必须带 error。')
 if(!Array.isArray(row.columns)||row.columns.length>256)throw bad('组件结果列不合法。')
 const columns=row.columns.map(item=>{
  const entry=exact(item,['name','type'],'组件结果列格式不正确。')
  if(typeof entry.name!=='string'||!entry.name.length||entry.name.length>63)throw bad('组件结果列名不合法。')
  if(!(businessWidgetColumnTypes as readonly string[]).includes(entry.type as string))throw invalidEnum('组件结果列类型不合法。',entry.type,businessWidgetColumnTypes)
  return {name:entry.name,type:entry.type as BusinessWidgetColumn['type']}
 })
 if(!Array.isArray(row.rows)||row.rows.length>businessDashboardLimits.resultRows||row.rowCount!==row.rows.length)throw bad('组件结果行数不合法。')
 const rows=row.rows.map(item=>{
  if(!Array.isArray(item)||item.length!==columns.length||!item.every(cell))throw bad('组件结果行与列不对应。')
  return [...item] as BusinessWidgetCell[]
 })
 if(row.truncated!==false)throw bad('组件结果不截断，truncated 恒为 false。')
 if(!count(row.bytes)||row.bytes>businessDashboardLimits.resultBytes)throw bad('组件结果字节数不合法。')
 if(typeof row.stale!=='boolean')throw bad('组件结果过期标记必须是布尔值。')
 let error:BusinessWidgetResult['error']
 if(hasError){
  const item=exact(row.error,['code','reason'],'组件结果的错误信息格式不正确。')
  if(!(workErrorCodes as readonly string[]).includes(item.code as string))throw bad('组件结果的错误码不在已知错误码内。')
  if(typeof item.reason!=='string'||!item.reason.trim()||item.reason.length>2000||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(item.reason))throw bad('组件结果的错误原因不合法。')
  error={code:item.code as WorkErrorCode,reason:item.reason}
 }
 return {widgetId:row.widgetId,definitionHash:row.definitionHash,computedAt:row.computedAt,status:row.status,columns,rows,rowCount:row.rowCount as number,truncated:false,bytes:row.bytes,...(error?{error}:{}),stale:row.stale}
}

/** 单条组件结果（回包读侧，如预览里的 widgetTrial）：形状不符即 `teloa/invalid-host-response`。 */
export function readBusinessWidgetResult(value:unknown):BusinessWidgetResult{return host(()=>widgetResult(value))}

export function readBusinessDashboardPage(value:unknown,scope:string):BusinessDashboardPage{
 return host(()=>{
  const row=exact(value,['schema','scope','dashboard','widgets','results','updatedAt','nextRefreshAt','refreshing','timeRange'],'看板页格式不正确。')
  if(row.schema!=='teloa.business-dashboard-page/v1')throw bad('看板页格式版本不正确。')
  if(!isBusinessScopeKey(scope)||row.scope!==scope)throw bad('看板页不属于当前业务范围。')
  const dashboard=readBusinessDashboardDefinition(row.dashboard)
  if(dashboard.domain!==scope)throw bad('看板声明不属于当前业务范围。')
  if(!Array.isArray(row.widgets)||row.widgets.length>dashboard.widgets.length)throw bad('看板页组件声明不合法。')
  const widgets=row.widgets.map(item=>readBusinessWidgetDefinition(item))
  const ids=widgets.map(item=>item.id)
  if(new Set(ids).size!==ids.length||widgets.some(item=>item.domain!==scope||!dashboard.widgets.includes(item.id)))throw bad('看板页组件声明与看板不对应。')
  if(!Array.isArray(row.results)||row.results.length>ids.length)throw bad('看板页组件结果不合法。')
  const results=row.results.map(item=>widgetResult(item))
  const resultIds=results.map(item=>item.widgetId)
  if(new Set(resultIds).size!==resultIds.length||resultIds.some(id=>!ids.includes(id)))throw bad('看板页组件结果与组件声明不对应。')
  if((row.updatedAt!==null&&!utcStamp(row.updatedAt))||(row.nextRefreshAt!==null&&!utcStamp(row.nextRefreshAt)))throw bad('看板页时刻不合法。')
  if(typeof row.refreshing!=='boolean')throw bad('看板页刷新标记必须是布尔值。')
  let range:BusinessDashboardPage['timeRange']=null
  if(dashboard.filters===undefined){if(row.timeRange!==null)throw bad('看板没有声明时间范围，看板页的时间范围必须为 null。')}
  else{
   const item=exact(row.timeRange,['selected','options'],'看板页时间范围格式不正确。')
   const declared=dashboard.filters.timeRange.options
   if(!Array.isArray(item.options)||item.options.length!==declared.length||item.options.some((option,index)=>option!==declared[index]))throw bad('看板页时间范围选项与看板声明不一致。')
   if(!timeRange(item.selected)||!declared.includes(item.selected))throw bad('看板页所选时间范围不在看板声明的选项里。')
   range={selected:item.selected,options:[...declared]}
  }
  return {schema:'teloa.business-dashboard-page/v1',scope,dashboard,widgets,results,updatedAt:row.updatedAt as string|null,nextRefreshAt:row.nextRefreshAt as string|null,refreshing:row.refreshing,timeRange:range}
 })
}

export function readBusinessDashboardSummaries(value:unknown,scope:string):BusinessDashboardSummary[]{
 return host(()=>{
  if(!isBusinessScopeKey(scope))throw bad('看板列表的业务范围不合法。')
  if(!Array.isArray(value)||value.length>businessDashboardLimits.dashboardsPerScope)throw bad('看板列表不合法。')
  const summaries=value.map(item=>{
   const hasLocalized=isRecord(item)&&item.localized!==undefined
   const row=exact(item,['id','title',...(hasLocalized?['localized']:[]),'widgets','updatedAt'],'看板摘要格式不正确。')
   if(typeof row.id!=='string'||!localId.test(row.id)||!label(row.title,120))throw bad('看板摘要的标识或标题不合法。')
   if(!gridInt(row.widgets,1,businessDashboardLimits.widgetsPerDashboard))throw bad('看板摘要的组件数不合法。')
   if(row.updatedAt!==null&&!utcStamp(row.updatedAt))throw bad('看板摘要的更新时刻不合法。')
   const localized=hasLocalized?titleLocalized(row.localized,row.title,'看板标题本地化元数据不合法。'):undefined
   return {id:row.id,title:row.title,...(localized?{localized}:{}),widgets:row.widgets,updatedAt:row.updatedAt as string|null}
  })
  if(new Set(summaries.map(item=>item.id)).size!==summaries.length)throw bad('看板列表有重复标识。')
  return summaries
 })
}

/** 图表编码里引用到的列名，去掉 transform 自己产出的那些（`as`；fold 不写 as 时产出 key/value）。 */
function chartFields(spec:Record<string,unknown>):string[]{
 const produced=new Set<string>()
 const walk=(value:unknown):void=>{
  if(Array.isArray(value)){value.forEach(walk);return}
  if(!isRecord(value))return
  for(const [key,item] of Object.entries(value)){
   if(key==='as')for(const name of Array.isArray(item)?item:[item])if(typeof name==='string')produced.add(name)
   if(key==='fold'&&value.as===undefined){produced.add('key');produced.add('value')}
   walk(item)
  }
 }
 walk(spec.transform)
 const fields:string[]=[]
 const encoding=isRecord(spec.encoding)?spec.encoding:{}
 for(const channel of Object.values(encoding))for(const item of Array.isArray(channel)?channel:[channel])
  if(isRecord(item)&&typeof item.field==='string'&&!produced.has(item.field)&&!fields.includes(item.field))fields.push(item.field)
 return fields
}

/**
 * 原生组件结果形状（服务端落库前、客户端渲染前各调一次）：只看列在不在、metric 行数，不看取值——
 * 比如 board 结果里出现 statuses 之外的状态值照样合格，界面把它归到「其他」。
 * 返回 null 表示合格，否则返回一句可直接作为 `error.reason` 的说明。失败结果与 view-ref（台账投影）不核对。
 */
export function validateWidgetResultShape(widget:BusinessWidgetDefinition,result:BusinessWidgetResult):string|null{
 if(result.status!=='ok'||widget.kind==='view-ref')return null
 const names=new Set(result.columns.map(column=>column.name))
 const required:string[]=[]
 if(widget.metric){
  if(result.rows.length!==1)return `指标组件的查询结果必须恰好 1 行，当前为 ${result.rows.length} 行。`
  required.push(widget.metric.valueColumn,...(widget.metric.previousColumn!==undefined?[widget.metric.previousColumn]:[]))
 }
 if(widget.board)required.push(widget.board.statusColumn,widget.board.titleColumn,widget.board.idColumn)
 if(widget.pipeline)required.push(widget.pipeline.stageColumn,widget.pipeline.countColumn,...(widget.pipeline.durationColumn!==undefined?[widget.pipeline.durationColumn]:[]))
 if(widget.table)required.push(...widget.table.columns)
 if(widget.chart)required.push(...chartFields(widget.chart.spec))
 for(const threshold of widget.thresholds??[])required.push(threshold.field)
 if(widget.drilldown?.idColumn!==undefined)required.push(widget.drilldown.idColumn)
 if(widget.drilldown?.match)required.push(widget.drilldown.match.column)
 const missing=[...new Set(required)].filter(name=>!names.has(name))
 return missing.length?`查询结果缺少组件声明要用的列：${missing.slice(0,maxNamedFields).join('、')}。`:null
}

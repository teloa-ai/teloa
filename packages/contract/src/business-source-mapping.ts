import {WorkError,workErrorCodes,type WorkErrorCode} from './work-error.ts'
import {isRecord} from './resources.ts'
import {localizedMetadata,type LocalizedMetadata} from './localized-metadata.ts'
import {readBusinessSyncSchedule,type BusinessSyncSchedule} from './business-sync-schedule.ts'
import type {BusinessDefinitionSource} from './business-definitions.ts'
import {businessScopeKeyRule,isBusinessScopeKey} from './business-scopes.ts'

/**
 * 数据源映射声明（规格 §4.1）：把一种来源的记录按 JSONPath 子集映射成对象类型的字段，
 * 由同步器按 `schedule` 落到唯一真源快照表。三种来源：既有业务数据端口、受管 MCP 只读工具结果、AI 员工成果。
 */
export type BusinessMappingSource=
 |{kind:'business-data-port';sourceId:string}
 |{kind:'mcp-tool';serverName:string;tool:string;arguments:Record<string,string|number|boolean>;itemsPath:string;pagination?:BusinessMcpPagination}
 |{kind:'role-result';roleId?:string}
/** 受管 MCP 物理来源身份是 `serverName/tool`；分别沿用声明的 64、128 字符上限。 */
export const businessMcpSourceIdMaxLength=64+1+128
/**
 * `mcp-tool` 来源的声明式续页（规格 §7）：MCP `tools/call` 没有官方分页约定，由声明说清「续页参数叫什么、下一页游标在结果哪里」。
 * `cursorArgument` 键名规则同 `arguments`，不得与其已有键重名；映射带 `incrementalCursor` 时不得为 `cursor`（水位固定以参数 `cursor` 透传）。
 * `nextCursorPath` 为 JSONPath 子集且不含 `[*]`。
 */
export type BusinessMcpPagination={cursorArgument:string;nextCursorPath:string}
/** `path` 为 JSONPath 子集：`$`、`.name`、`['name']`、`[0]`；`[*]` 只能是末段且只用于 `itemsPath`。 */
export type BusinessFieldMapping={path:string;field:string}
export type BusinessSourceMappingLocalizedMetadata={title?:LocalizedMetadata}
export type BusinessSourceMappingDefinition={
 format:'teloa.business-source-mapping/v1';id:string;version:string;domain:string;title:string;localized?:BusinessSourceMappingLocalizedMetadata
 objectType:string;source:BusinessMappingSource
 /** 目标 `field` 是对象类型声明里的字段 `name`，或平台三列 `title` / `summary` / `observedAt`；跨声明核对留给读取层。 */
 mapping:BusinessFieldMapping[]
 /** 1–3 个 field；去重键，服务端拼成 object_id（多键用 `\u001f` 连接后 sha256 前 32 位）。 */
 primaryKey:string[]
 incrementalCursor?:{path:string;kind:'timestamp'|'sequence'}
 /** `tombstone` 需 `deletedAtPath`（源返回删除时刻）；`compare` 由平台对比全量缺席。 */
 deletionSemantics:'tombstone'|'compare'
 deletedAtPath?:string
 schedule:BusinessSyncSchedule;acknowledgeShortInterval:boolean
 /** 1..365，缺省 90（缺省值由服务端补，声明里不写就不出现）。 */
 retentionDays?:number
 /** 1..100，缺省 50。 */
 pageSize?:number
}
/** 声明包里的一条数据源映射：形状照 `BusinessViewRecord`。 */
export type BusinessSourceMappingRecord={source:BusinessDefinitionSource;definition:BusinessSourceMappingDefinition}
/** 资源上限，全是字面量常量，不做设置项。 */
export const businessSourceMappingLimits={mappings:64,primaryKeys:3,pathLength:256,mappingsPerScope:32} as const
/** 除对象类型字段 `name` 外可作映射目标的平台列。 */
export const businessMappingPlatformFields=['title','summary','observedAt'] as const

/** 同步记录（读侧契约，服务端表 `teloa_business_sync_runs` 见 功能验证）：只有终态，没有 running。 */
export type BusinessSyncRun={id:string;mappingId:string;scope:string;startedAt:string;finishedAt:string;status:'ok'|'failed'|'throttled';upserted:number;tombstoned:number;fetched:number;durationMs:number;error?:{code:WorkErrorCode;reason:string};nextCursor?:string;trigger:'schedule'|'manual'|'tool'}
export type BusinessSyncStatus={mappingId:string;lastRun?:BusinessSyncRun;nextRunAt?:string;consecutiveFailures:number;backoffUntil?:string;quota:{rows:number;limit:number}}
export type BusinessSyncRuleState={scope:string;mappingId:string;definitionHash:string;enabled:boolean;revision:number}
/** running 是规则授权与业务级持续运行开关共同作用后的实际派发状态。 */
export type BusinessSyncRuleView=BusinessSyncRuleState&{title:string;schedule:BusinessSyncSchedule;running:boolean}
export const businessSyncRunStatuses=['ok','failed','throttled'] as const
export const businessSyncTriggers=['schedule','manual','tool'] as const

const bad=(message:string)=>new WorkError('teloa/invalid-input',message)
const maxNamedFields=8
/** 缺键/多键都指出具体字段名，照 `business-definitions.ts` 的 `exact`。 */
const exactWith=(code:WorkErrorCode)=>(value:unknown,keys:readonly string[],message:string):Record<string,unknown>=>{
 if(!isRecord(value))throw new WorkError(code,message)
 const missing=keys.filter(key=>!(key in value)),extra=Object.keys(value).filter(key=>!keys.includes(key))
 if(!missing.length&&!extra.length)return value
 const parts:string[]=[]
 if(missing.length)parts.push('缺少字段 '+missing.slice(0,maxNamedFields).join('、'))
 if(extra.length)parts.push('不认识的字段 '+extra.slice(0,maxNamedFields).join('、'))
 throw new WorkError(code,message.replace(/。$/,'')+'：'+parts.join('；')+'。')
}
const exact=exactWith('teloa/invalid-input')
/** 回显原值只取前 80 字：原值来自声明正文，整段回显会把任意长的文本带进错误文案与模型上下文。 */
const invalidEnum=(message:string,value:unknown,allowed:readonly string[]):WorkError=>{const shown=String(value);return bad(message.replace(/。$/,'')+'，当前为「'+(shown.length>80?shown.slice(0,80)+'…':shown)+'」，允许：'+allowed.join(' / ')+'。')}
function atPath<T>(path:string,run:()=>T):T{
 try{return run()}
 catch(error){if(error instanceof WorkError)throw new WorkError(error.code,path+'：'+error.message);throw error}
}
/** 以下判据与 `business-definitions.ts` 逐字相同：字段标识、本地标识、数据源标识、精确三段号、单行标签、业务范围。 */
const fieldName=/^[a-z0-9][a-z0-9_-]{0,62}$/
const localId=/^[a-zA-Z0-9][a-zA-Z0-9-]{0,119}$/
const sourceIdPattern=/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/
const exactSemver=/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const label=(value:unknown,max:number):value is string=>typeof value==='string'&&!!value.trim()&&value===value.trim()&&value.length<=max&&!/[\x00-\x08\x0a-\x1f\x7f]/.test(value)
const domainText=(value:unknown):value is string=>isBusinessScopeKey(value)&&value!=='general'
const semver=(value:unknown):value is string=>typeof value==='string'&&value.length<=80&&exactSemver.test(value)
/** MCP 服务器名与 `mcp__<server>__<tool>` 全名里的服务器段同规矩（`isCapabilitySnapshot`）。 */
const mcpServerName=/^[A-Za-z0-9_-]{1,64}$/
/** 角色标识与会话等资源标识同规矩。 */
const roleIdPattern=/^[a-zA-Z0-9_-]{1,128}$/
const positiveInt=(value:unknown,min:number,max:number):value is number=>Number.isSafeInteger(value)&&Number(value)>=min&&Number(value)<=max
/** 规范 UTC 毫秒串，且不被 Date 自动归一化。 */
const utcStamp=(value:unknown):value is string=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)&&!value.startsWith('0000-')&&new Date(value).toISOString()===value

/**
 * JSONPath 子集的段：`$` 起始，随后 `.name`（标识符）、`['name']`（单引号，`\'` 与 `\\` 转义）、
 * `[n]`（非负整数，无前导零）、末段 `[*]`。不支持过滤器、递归下降、脚本、切片、负下标、双引号。
 */
type JsonPathSegment={kind:'key';name:string}|{kind:'index';index:number}|{kind:'all'}
const segmentPattern=/\.([A-Za-z_][A-Za-z0-9_-]*)|\['((?:[^'\\]|\\['\\])*)'\]|\[(0|[1-9]\d*)\]|\[(\*)\]/y
function parseJsonPath(path:string):JsonPathSegment[]|undefined{
 if(typeof path!=='string'||!path.length||path.length>businessSourceMappingLimits.pathLength||path[0]!=='$')return undefined
 const segments:JsonPathSegment[]=[]
 segmentPattern.lastIndex=1
 while(segmentPattern.lastIndex<path.length){
  const start=segmentPattern.lastIndex,match=segmentPattern.exec(path)
  if(!match||match.index!==start)return undefined
  if(match[1]!==undefined)segments.push({kind:'key',name:match[1]})
  else if(match[2]!==undefined)segments.push({kind:'key',name:match[2].replace(/\\(['\\])/g,'$1')})
  else if(match[3]!==undefined)segments.push({kind:'index',index:Number(match[3])})
  else segments.push({kind:'all'})
 }
 // `[*]` 只能出现一次且必须是末段。
 if(segments.some((segment,index)=>segment.kind==='all'&&index!==segments.length-1))return undefined
 return segments
}
export function isValidJsonPath(path:string):boolean{return parseJsonPath(path)!==undefined}
/** JSONPath 子集求值：路径不合法 throw；路径不存在返回 undefined；不沿原型链取值。末段 `[*]` 返回数组本身，非数组即 undefined。 */
export function evaluateJsonPath(root:unknown,path:string):unknown{
 const segments=parseJsonPath(path)
 if(!segments)throw bad('JSONPath 不合法：只支持 $、.name、[\'name\']、[n] 与末段 [*]。')
 let current:unknown=root
 for(const segment of segments){
  if(segment.kind==='key'){if(!isRecord(current)||!Object.hasOwn(current,segment.name))return undefined;current=current[segment.name]}
  else if(segment.kind==='index'){if(!Array.isArray(current)||segment.index>=current.length)return undefined;current=current[segment.index]}
  else if(!Array.isArray(current))return undefined
 }
 return current
}
/** 声明里的单值路径：合法且不带 `[*]`。 */
function valuePath(value:unknown,message:string):string{
 const segments=typeof value==='string'?parseJsonPath(value):undefined
 if(!segments||segments.some(segment=>segment.kind==='all'))throw bad(message)
 return value as string
}

function mappingSource(value:unknown):BusinessMappingSource{
 if(!isRecord(value))throw bad('数据源映射的来源定义格式不正确。')
 if(value.kind==='business-data-port'){
  const row=exact(value,['kind','sourceId'],'数据源映射的来源定义格式不正确。')
  if(typeof row.sourceId!=='string'||!sourceIdPattern.test(row.sourceId))throw bad('业务数据端口标识不合法。')
  return {kind:'business-data-port',sourceId:row.sourceId}
 }
 if(value.kind==='mcp-tool'){
  const hasPagination=value.pagination!==undefined
  const row=exact(value,['kind','serverName','tool','arguments','itemsPath',...(hasPagination?['pagination']:[])],'数据源映射的来源定义格式不正确。')
  if(typeof row.serverName!=='string'||!mcpServerName.test(row.serverName))throw bad('MCP 服务器名不合法。')
  // tool 上限 128 与安全动作提议的 `text(row.tool,128)` 对齐。
  if(!label(row.tool,128))throw bad('MCP 工具名不合法。')
  if(!isRecord(row.arguments)||Object.keys(row.arguments).length>32)throw bad('MCP 工具参数必须是不超过 32 项的对象。')
  const args:Record<string,string|number|boolean>={}
  for(const [key,item] of Object.entries(row.arguments)){
   if(!label(key,64))throw bad('MCP 工具参数名不合法。')
   if(typeof item==='string'){if(item.length>4000||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(item))throw bad('MCP 工具参数「'+key+'」的取值不合法。')}
   else if(typeof item==='number'){if(!Number.isFinite(item))throw bad('MCP 工具参数「'+key+'」的取值不合法。')}
   else if(typeof item!=='boolean')throw bad('MCP 工具参数「'+key+'」只能是字符串、数字或布尔值，不接受对象、数组与 null。')
   args[key]=item
  }
  const itemsPath=typeof row.itemsPath==='string'?parseJsonPath(row.itemsPath):undefined
  if(!itemsPath)throw bad('MCP 工具结果的记录路径（itemsPath）不合法。')
  let pagination:BusinessMcpPagination|undefined
  if(hasPagination){
   const item=atPath('pagination',()=>exact(row.pagination,['cursorArgument','nextCursorPath'],'MCP 工具分页声明格式不正确。'))
   if(!label(item.cursorArgument,64))throw bad('pagination：续页参数名（cursorArgument）不合法。')
   if(Object.hasOwn(args,item.cursorArgument))throw bad('pagination：续页参数名「'+item.cursorArgument+'」与 arguments 里已有的参数重名。')
   const nextCursorPath=atPath('pagination',()=>valuePath(item.nextCursorPath,'下一页游标路径（nextCursorPath）不合法：只支持 $、.name、[\'name\'] 与 [n]，不带 [*]。'))
   pagination={cursorArgument:item.cursorArgument,nextCursorPath}
  }
  return {kind:'mcp-tool',serverName:row.serverName,tool:row.tool,arguments:args,itemsPath:row.itemsPath as string,...(pagination?{pagination}:{})}
 }
 if(value.kind==='role-result'){
  const hasRoleId=value.roleId!==undefined
  const row=exact(value,['kind',...(hasRoleId?['roleId']:[])],'数据源映射的来源定义格式不正确。')
  if(hasRoleId&&(typeof row.roleId!=='string'||!roleIdPattern.test(row.roleId)))throw bad('AI 员工标识不合法。')
  return {kind:'role-result',...(hasRoleId?{roleId:row.roleId as string}:{})}
 }
 throw invalidEnum('数据源映射的来源种类不在白名单内。',value.kind,['business-data-port','mcp-tool','role-result'])
}

function fieldMapping(value:unknown):BusinessFieldMapping{
 const row=exact(value,['path','field'],'字段映射格式不正确。')
 const path=valuePath(row.path,'字段映射路径不合法：只支持 $、.name、[\'name\'] 与 [n]，不带 [*]。')
 if(typeof row.field!=='string'||!(fieldName.test(row.field)||(businessMappingPlatformFields as readonly string[]).includes(row.field)))throw bad('字段映射目标必须是对象类型字段标识或 '+businessMappingPlatformFields.join(' / ')+'。')
 return {path,field:row.field}
}

export function readBusinessSourceMappingDefinition(value:unknown):BusinessSourceMappingDefinition{
 if(!isRecord(value))throw bad('数据源映射声明格式不正确。')
 const hasLocalized=value.localized!==undefined,hasCursor=value.incrementalCursor!==undefined,hasDeletedAt=value.deletedAtPath!==undefined,hasRetention=value.retentionDays!==undefined,hasPageSize=value.pageSize!==undefined
 const keys=['format','id','version','domain','title',...(hasLocalized?['localized']:[]),'objectType','source','mapping','primaryKey',...(hasCursor?['incrementalCursor']:[]),'deletionSemantics',...(hasDeletedAt?['deletedAtPath']:[]),'schedule','acknowledgeShortInterval',...(hasRetention?['retentionDays']:[]),...(hasPageSize?['pageSize']:[])]
 const row=exact(value,keys,'数据源映射声明格式不正确。')
 if(row.format!=='teloa.business-source-mapping/v1')throw invalidEnum('数据源映射声明格式不正确。',row.format,['teloa.business-source-mapping/v1'])
 if(typeof row.id!=='string'||!localId.test(row.id))throw bad('数据源映射标识不合法。')
 if(!semver(row.version))throw bad('数据源映射版本必须是精确三段号。')
 if(!domainText(row.domain))throw bad('数据源映射所属业务范围不合法：'+businessScopeKeyRule+'，general 一律拒绝。')
 if(!label(row.title,120))throw bad('数据源映射标题不合法。')
 if(typeof row.objectType!=='string'||!localId.test(row.objectType))throw bad('数据源映射的目标对象类型标识不合法。')
 const source=atPath('source',()=>mappingSource(row.source))
 /**
  * 空映射 = 原样落库：只给业务数据端口，端口回包已是快照形状、自带 id 与 version（端口是版本权威）。
  * 因此主键固定为快照自身的 `id`，删除语义只有 compare（端口不返回删除时刻）。
  */
 const raw=source.kind==='business-data-port'&&Array.isArray(row.mapping)&&row.mapping.length===0
 if(!Array.isArray(row.mapping)||(!raw&&row.mapping.length<1)||row.mapping.length>businessSourceMappingLimits.mappings)throw bad('字段映射必须是 1–'+businessSourceMappingLimits.mappings+' 项（只有业务数据端口来源可写空数组，表示原样落库）。')
 const mapping=row.mapping.map((item,index)=>atPath(`mapping[${index}]`,()=>fieldMapping(item)))
 const fields=mapping.map(item=>item.field)
 if(new Set(fields).size!==fields.length)throw bad('字段映射的目标字段不得重复。')
 if(!Array.isArray(row.primaryKey)||row.primaryKey.length<1||row.primaryKey.length>businessSourceMappingLimits.primaryKeys||new Set(row.primaryKey).size!==row.primaryKey.length)throw bad('主键必须是 1–'+businessSourceMappingLimits.primaryKeys+' 个去重字段。')
 if(raw){
  if(row.primaryKey.length!==1||row.primaryKey[0]!=='id')throw bad('原样落库的映射主键固定为 [\'id\']（端口快照自带对象标识）。')
  if(row.deletionSemantics!=='compare')throw bad('原样落库的映射只支持 compare 删除语义（业务数据端口不返回删除时刻）。')
 }else if(row.primaryKey.some(key=>typeof key!=='string'||!fields.includes(key)))throw bad('主键引用的字段必须出现在字段映射的目标里。')
 let incrementalCursor:BusinessSourceMappingDefinition['incrementalCursor']
 if(hasCursor){
  const cursor=atPath('incrementalCursor',()=>exact(row.incrementalCursor,['path','kind'],'增量游标格式不正确。'))
  const path=atPath('incrementalCursor',()=>valuePath(cursor.path,'增量游标路径不合法。'))
  if(cursor.kind!=='timestamp'&&cursor.kind!=='sequence')throw invalidEnum('增量游标种类不合法。',cursor.kind,['timestamp','sequence'])
  incrementalCursor={path,kind:cursor.kind}
  // 两个字段在声明两处，只能在顶层判：水位固定以参数 cursor 透传，续页参数再叫 cursor 会把水位覆盖掉。
  if(source.kind==='mcp-tool'&&source.pagination?.cursorArgument==='cursor')throw bad('带增量游标（incrementalCursor）的映射，续页参数名（source.pagination.cursorArgument）不得为 cursor：水位固定以参数 cursor 透传，请换一个续页参数名。')
 }
 if(row.deletionSemantics!=='tombstone'&&row.deletionSemantics!=='compare')throw invalidEnum('删除语义不合法。',row.deletionSemantics,['tombstone','compare'])
 if(row.deletionSemantics==='tombstone'){if(!hasDeletedAt)throw bad('tombstone 删除语义必须声明 deletedAtPath。')}
 else if(hasDeletedAt)throw bad('compare 删除语义不得声明 deletedAtPath。')
 const deletedAtPath=hasDeletedAt?atPath('deletedAtPath',()=>valuePath(row.deletedAtPath,'删除时刻路径不合法。')):undefined
 if(typeof row.acknowledgeShortInterval!=='boolean')throw bad('acknowledgeShortInterval 必须是布尔值。')
 if(!isRecord(row.schedule))throw bad('同步周期格式不正确。')
 if('acknowledgeShortInterval' in row.schedule)throw bad('schedule：短周期确认位请写在声明顶层的 acknowledgeShortInterval，不写进 schedule 里。')
 const {schedule,acknowledgeShortInterval}=atPath('schedule',()=>readBusinessSyncSchedule({...row.schedule as Record<string,unknown>,acknowledgeShortInterval:row.acknowledgeShortInterval}))
 if(hasRetention&&!positiveInt(row.retentionDays,1,365))throw bad('保留天数必须是 1 到 365 之间的整数。')
 if(hasPageSize&&!positiveInt(row.pageSize,1,100))throw bad('每页条数必须是 1 到 100 之间的整数。')
 let localized:BusinessSourceMappingLocalizedMetadata|undefined
 if(hasLocalized){
  if(!isRecord(row.localized)||!Object.keys(row.localized).length||Object.keys(row.localized).some(key=>key!=='title'))throw bad('数据源映射本地化元数据不合法。')
  const result:BusinessSourceMappingLocalizedMetadata={}
  if(row.localized.title!==undefined){
   let metadata:LocalizedMetadata
   try{metadata=localizedMetadata(row.localized.title)}catch{throw bad('数据源映射标题本地化元数据不合法。')}
   if(metadata.original!==row.title||Object.values(metadata.locales).some(item=>typeof item==='string'&&!label(item,120)))throw bad('数据源映射标题本地化元数据不合法。')
   result.title=metadata
  }
  localized=result
 }
 return {
  format:'teloa.business-source-mapping/v1',id:row.id,version:row.version,domain:row.domain,title:row.title,...(localized?{localized}:{}),
  objectType:row.objectType,source,mapping,primaryKey:[...row.primaryKey as string[]],
  ...(incrementalCursor?{incrementalCursor}:{}),
  deletionSemantics:row.deletionSemantics,...(deletedAtPath!==undefined?{deletedAtPath}:{}),
  schedule,acknowledgeShortInterval,
  ...(hasRetention?{retentionDays:row.retentionDays as number}:{}),...(hasPageSize?{pageSize:row.pageSize as number}:{}),
 }
}

/** 回包读取：宿主给出的同步记录形状不对是宿主问题，一律 `teloa/invalid-host-response`。 */
const hostError=(message:string)=>new WorkError('teloa/invalid-host-response',message)
const exactHost=exactWith('teloa/invalid-host-response')
const count=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>=0

export function readBusinessSyncRun(value:unknown,scope:string):BusinessSyncRun{
 if(!isRecord(value))throw hostError('同步记录格式不正确。')
 const hasError=value.error!==undefined,hasCursor=value.nextCursor!==undefined
 const row=exactHost(value,['id','mappingId','scope','startedAt','finishedAt','status','upserted','tombstoned','fetched','durationMs',...(hasError?['error']:[]),...(hasCursor?['nextCursor']:[]),'trigger'],'同步记录格式不正确。')
 if(typeof row.id!=='string'||!roleIdPattern.test(row.id))throw hostError('同步记录标识不合法。')
 if(typeof row.mappingId!=='string'||!localId.test(row.mappingId))throw hostError('同步记录的映射标识不合法。')
 if(!isBusinessScopeKey(scope)||row.scope!==scope)throw hostError('同步记录不属于当前业务范围。')
 if(!utcStamp(row.startedAt)||!utcStamp(row.finishedAt)||Date.parse(row.finishedAt)<Date.parse(row.startedAt))throw hostError('同步记录的起止时刻不合法。')
 if(!(businessSyncRunStatuses as readonly string[]).includes(row.status as string))throw hostError('同步记录状态不合法，当前为「'+String(row.status)+'」，允许：'+businessSyncRunStatuses.join(' / ')+'。')
 const status=row.status as BusinessSyncRun['status']
 if(!count(row.upserted)||!count(row.tombstoned)||!count(row.fetched)||!count(row.durationMs))throw hostError('同步记录的计数必须是非负整数。')
 if(status==='ok'?hasError:status==='failed'&&!hasError)throw hostError('同步记录的错误信息与状态不一致：ok 不得带 error，failed 必须带 error。')
 let error:BusinessSyncRun['error']
 if(hasError){
  const item=exactHost(row.error,['code','reason'],'同步记录的错误信息格式不正确。')
  if(!(workErrorCodes as readonly string[]).includes(item.code as string))throw hostError('同步记录的错误码不在已知错误码内。')
  if(typeof item.reason!=='string'||!item.reason.trim()||item.reason.length>2000||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(item.reason))throw hostError('同步记录的错误原因不合法。')
  error={code:item.code as WorkErrorCode,reason:item.reason}
 }
 if(hasCursor&&(typeof row.nextCursor!=='string'||!row.nextCursor.length||row.nextCursor.length>512))throw hostError('同步记录的游标不合法。')
 if(!(businessSyncTriggers as readonly string[]).includes(row.trigger as string))throw hostError('同步记录的触发方式不合法。')
 return {id:row.id,mappingId:row.mappingId,scope,startedAt:row.startedAt,finishedAt:row.finishedAt,status,upserted:row.upserted,tombstoned:row.tombstoned,fetched:row.fetched,durationMs:row.durationMs,...(error?{error}:{}),...(hasCursor?{nextCursor:row.nextCursor as string}:{}),trigger:row.trigger as BusinessSyncRun['trigger']}
}

export function readBusinessSyncRuleState(value:unknown,scope:string):BusinessSyncRuleState{
 const row=exactHost(value,['scope','mappingId','definitionHash','enabled','revision'],'持续规则状态格式不正确。')
 if(row.scope!==scope||typeof row.mappingId!=='string'||!localId.test(row.mappingId)||typeof row.definitionHash!=='string'||!/^[a-f0-9]{64}$/.test(row.definitionHash)||typeof row.enabled!=='boolean'||!count(row.revision))throw hostError('持续规则状态与业务范围、映射或修订不一致。')
 return {scope,mappingId:row.mappingId,definitionHash:row.definitionHash,enabled:row.enabled,revision:row.revision as number}
}

export function readBusinessSyncRuleView(value:unknown,scope:string):BusinessSyncRuleView{
 const row=exactHost(value,['scope','mappingId','definitionHash','enabled','revision','title','schedule','running'],'持续规则展示状态格式不正确。')
 const state=readBusinessSyncRuleState({scope:row.scope,mappingId:row.mappingId,definitionHash:row.definitionHash,enabled:row.enabled,revision:row.revision},scope)
 if(typeof row.title!=='string'||!label(row.title,80)||typeof row.running!=='boolean'||row.running&&!state.enabled)throw hostError('持续规则展示状态不一致。')
 let schedule:BusinessSyncSchedule
 try{schedule=readBusinessSyncSchedule(row.schedule).schedule}catch{throw hostError('持续规则周期格式不正确。')}
 return {...state,title:row.title,schedule,running:row.running}
}

export function readBusinessSyncStatus(value:unknown,scope:string):BusinessSyncStatus{
 if(!isRecord(value))throw hostError('同步状态格式不正确。')
 const hasLastRun=value.lastRun!==undefined,hasNext=value.nextRunAt!==undefined,hasBackoff=value.backoffUntil!==undefined
 const row=exactHost(value,['mappingId',...(hasLastRun?['lastRun']:[]),...(hasNext?['nextRunAt']:[]),'consecutiveFailures',...(hasBackoff?['backoffUntil']:[]),'quota'],'同步状态格式不正确。')
 if(typeof row.mappingId!=='string'||!localId.test(row.mappingId))throw hostError('同步状态的映射标识不合法。')
 const lastRun=hasLastRun?readBusinessSyncRun(row.lastRun,scope):undefined
 if(lastRun&&lastRun.mappingId!==row.mappingId)throw hostError('同步状态的最近一次记录不属于同一映射。')
 if(hasNext&&!utcStamp(row.nextRunAt))throw hostError('同步状态的下次触发时刻不合法。')
 if(!count(row.consecutiveFailures))throw hostError('同步状态的连续失败次数必须是非负整数。')
 if(hasBackoff&&!utcStamp(row.backoffUntil))throw hostError('同步状态的退避截止时刻不合法。')
 const quota=exactHost(row.quota,['rows','limit'],'同步状态的配额格式不正确。')
 if(!count(quota.rows)||!positiveInt(quota.limit,1,Number.MAX_SAFE_INTEGER))throw hostError('同步状态的配额必须是非负整数且上限为正。')
 return {mappingId:row.mappingId,...(lastRun?{lastRun}:{}),...(hasNext?{nextRunAt:row.nextRunAt as string}:{}),consecutiveFailures:row.consecutiveFailures,...(hasBackoff?{backoffUntil:row.backoffUntil as string}:{}),quota:{rows:quota.rows,limit:quota.limit}}
}

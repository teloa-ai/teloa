import {WorkError} from './work-error.ts'
import {isRecord} from './resources.ts'
import {businessScopeKeyRule,isBusinessScopeKey} from './business-scopes.ts'
import {industryUpdateCanonical} from './industry-update-compare.ts'
import {localizedMetadata,type LocalizedMetadata} from './localized-metadata.ts'
import {readBusinessSourceMappingDefinition,type BusinessSourceMappingDefinition} from './business-source-mapping.ts'
import {readBusinessDashboardDefinition,readBusinessWidgetDefinition,type BusinessDashboardDefinition,type BusinessDashboardLayoutItem,type BusinessWidgetDefinition,type BusinessWidgetResult} from './business-dashboards.ts'

export const businessFieldTypes=['text','number','enum','datetime','reference','duration','boolean'] as const
export type BusinessFieldType=typeof businessFieldTypes[number]
/**
 * 一个字段的声明。`from` 指向固定快照 `fields[].label`（`BusinessObjectSnapshot.fields` 是
 * `{label,value}` 对，值全是字符串），除 `text` 外的类型都要在服务端按本声明解析一次，解析不出来即视为缺失。
 */
export type BusinessObjectFieldLocalizedMetadata={label?:LocalizedMetadata;values?:LocalizedMetadata[]}
export type BusinessObjectFieldDefinition={name:string;label:string;localized?:BusinessObjectFieldLocalizedMetadata;type:BusinessFieldType;required:boolean;from:string;values?:string[];referenceType?:string}
/**
 * 对象目录首页的两项摘要由模板声明，而不是由行业名称或字段标签猜出来。
 * `stageField` 必须是枚举字段；`unfinished` 和 `waitingForYou` 都是那个枚举的取值子集，
 * 后者还是前者的子集。这样“等你”天然也是尚未完成，不会出现两项统计互相打架。
 */
export type BusinessObjectProgressDefinition={stageField:string;unfinished:string[];waitingForYou:string[];changedAtField?:string}
export type BusinessObjectTypeLocalizedMetadata={title?:LocalizedMetadata;unit?:LocalizedMetadata;lead?:LocalizedMetadata}
export type BusinessObjectTypeDefinition={format:'teloa.business-object-type/v1';id:string;version:string;domain:string;title:string;localized?:BusinessObjectTypeLocalizedMetadata;unit:string;lead:string;sourceId:string;fields:BusinessObjectFieldDefinition[];progress?:BusinessObjectProgressDefinition;defaultAction?:string}

export const businessViewKinds=['list','distribution','trend','board-card'] as const
export const businessAggregations=['count','sum','avg','min','max'] as const
export const businessTimeBuckets=['hour','day','week','month'] as const
export const businessChartTypes=['table','bar','pie','line','number'] as const
export const businessFilterOperators=['eq','ne','in','gte','lte'] as const
/**
 * 相对时间窗：白名单枚举，没有算术、没有相对天数参数（由 AppSec 的「SLA 到期趋势」逼出来）。
 * `overdue` 含义固定为「该 `datetime` 字段早于计算时刻」，不可配置。
 */
export const businessViewWindows=['last-24h','last-7d','last-30d','next-7d','next-30d','overdue'] as const
export type BusinessViewKind=typeof businessViewKinds[number]
export type BusinessAggregation=typeof businessAggregations[number]
export type BusinessTimeBucket=typeof businessTimeBuckets[number]
export type BusinessChartType=typeof businessChartTypes[number]
export type BusinessFilterOperator=typeof businessFilterOperators[number]
/** 筛选只比较字段与字面量取值；`in` 才允许多值，其余恰好一个值。 */
export type BusinessViewFilter={field:string;op:BusinessFilterOperator;values:string[]}
export type BusinessViewWindow={field:string;relative:typeof businessViewWindows[number]}
/**
 * `aggregation==='count'` 时 `field` 必须缺省；其余四个必须绑定字段。
 * `where` 是本度量独占的一条筛选（由 SOC 的「告警趋势按严重度分线」逼出来），
 * 上限因此仍然封闭：度量 ≤4、每个度量最多 1 条筛选，不引入 join。
 */
export type BusinessViewMeasureLocalizedMetadata={label?:LocalizedMetadata}
export type BusinessViewMeasure={id:string;label:string;localized?:BusinessViewMeasureLocalizedMetadata;aggregation:BusinessAggregation;field?:string;where?:BusinessViewFilter}
/** `by==='measure'` 必须带 `measureId` 且指向本视图的度量；`by==='dimension'` 必须缺省。 */
export type BusinessViewSort={by:'dimension'|'measure';measureId?:string;direction:'asc'|'desc'}
/** `bucket` 只在维度对应 `trend` 视图时允许且必填；`distribution` 必须缺省。`limit` 是维度取值上限。 */
export type BusinessViewDimension={field:string;bucket?:BusinessTimeBucket;limit:number}
export type BusinessViewLocalizedMetadata={title?:LocalizedMetadata}
export type BusinessViewDefinition={format:'teloa.business-view/v1';id:string;version:string;domain:string;title:string;localized?:BusinessViewLocalizedMetadata;kind:BusinessViewKind;chart:BusinessChartType;objectType:string;dimension?:BusinessViewDimension;measures:BusinessViewMeasure[];filters:BusinessViewFilter[];sort?:BusinessViewSort;window?:BusinessViewWindow;limit:number}

/** 一个动作输入只有三种来源，全部是逐字取值，没有拼接、没有表达式。 */
export type BusinessActionInput={from:'field';field:string}|{from:'object';part:'title'|'id'|'summary'}|{from:'literal';value:string}
/**
 * `execution-tool` 的 `targetFrom` 由 SOC 的 `security.endpoint.isolate` 样例逼出来：安全动作的
 * `targetSet:string[]` 是独立入参，填不进工作模板的 `requirements`。只允许来自对象（不允许字面量，
 * 否则声明里就能写死一台机器）；`params` 恒为空对象，参数由 playbook 固定，声明不可提供。
 */
export type BusinessActionTarget={kind:'work-template';localId:string}|{kind:'execution-tool';localId:string;tool:string;workTemplate:string;targetFrom:Extract<BusinessActionInput,{from:'field'}|{from:'object'}>}
export type BusinessActionLocalizedMetadata={title?:LocalizedMetadata}
export type BusinessActionDefinition={format:'teloa.business-action/v1';id:string;version:string;domain:string;title:string;localized?:BusinessActionLocalizedMetadata;objectType:string;target:BusinessActionTarget;inputs:BusinessActionInput[]}

/** `kind × chart` 允许组合，写死不留自由搭配。 */
export const businessViewCharts:Readonly<Record<BusinessViewKind,readonly BusinessChartType[]>>={
 list:['table'],
 distribution:['bar','pie','table'],
 trend:['line','bar'],
 'board-card':['number'],
}
/** 字段类型 × 维度 / 度量 / 聚合 / 算子交叉约束表（规格 §2.5），契约与服务端共用同一份，不得再抄一份。 */
export const businessFieldCapabilities:Readonly<Record<BusinessFieldType,{dimension:boolean;measure:boolean;aggregations:readonly BusinessAggregation[];operators:readonly BusinessFilterOperator[]}>>={
 text:{dimension:true,measure:false,aggregations:[],operators:['eq','ne','in']},
 number:{dimension:false,measure:true,aggregations:['sum','avg','min','max'],operators:['eq','ne','gte','lte']},
 enum:{dimension:true,measure:false,aggregations:[],operators:['eq','ne','in']},
 datetime:{dimension:true,measure:true,aggregations:['min','max'],operators:['gte','lte']},
 reference:{dimension:true,measure:false,aggregations:[],operators:['eq','in']},
 duration:{dimension:false,measure:true,aggregations:['sum','avg','min','max'],operators:['eq','ne','gte','lte']},
 boolean:{dimension:true,measure:false,aggregations:[],operators:['eq','ne']},
}
/** 资源上限，全是字面量常量，不做设置项。 */
export const businessLedgerLimits={scanRows:5000,objectTypes:16,viewsPerType:8,measures:4,filters:8,dimensionValues:50,listRows:100} as const

/**
 * 声明的固定身份：与 `IndustryDataSourceSourceSnapshot` 同形，`definitionHash` 由读取层算，不写在文件里。
 * `origin` 逐字由服务端带出来（第二期）：界面要标「已本地定制」，而本地声明与模板声明在这一层形状完全相同，
 * 从 `loadId` 的写法或版本号去反推来源，与第一期禁止「从行的形状反推视图形态」是同一类错（复审 MEDIUM-3 的同一条理由）。
 */
export type BusinessDefinitionSource={loadId:string;scope:string;localId:string;version:string;contentHash:string;fileHash:string;definitionHash:string;origin:BusinessDefinitionOrigin}
export type BusinessObjectTypeRecord={source:BusinessDefinitionSource;definition:BusinessObjectTypeDefinition}
export type BusinessViewRecord={source:BusinessDefinitionSource;definition:BusinessViewDefinition}
export type BusinessActionRecord={source:BusinessDefinitionSource;definition:BusinessActionDefinition}

/** 统计覆盖面：只覆盖已固定进快照表的对象，界面必须把这三项如实写出来。 */
export type BusinessViewCoverage={objects:number;latestReceivedAt:string|null;truncated:boolean}
/**
 * 一行。`dimension` 是原始取值（`list` 视图是对象标识，时间桶是桶起点的 ISO 时刻），作为稳定键与回传筛选用；
 * `label` 是界面文案，服务端一次算好。解析不出来的度量是 `null`，不是 0。
 */
export type BusinessViewRow={dimension:string;label:string;values:Array<number|null>}
export type BusinessViewResult={
 schema:'teloa.business-view-result/v1'
 viewId:string;viewVersion:string;definitionHash:string
 /**
  * 这一份结果算的是模板声明还是本地定制声明，由服务端逐字带出来（第二期）：缓存键与「声明已更新」
  * 判据都只看 `definitionHash`，同一个 `localId` 从本地改回模板时哈希也会变，但界面还要在块上标出
  * 「已本地定制」——那句话不能从声明形状或 `loadId` 反推，与 `kind`/`chart` 逐字带出是同一条理由。
  */
 origin:BusinessDefinitionOrigin
 /**
  * 这一份结果该怎么画与叫什么，由服务端逐字带出来，界面不从行的形状反推——
  * 反推会把只有一个取值的分布误判成大盘卡、把 text 维度的取值误判成时间桶（复审 MEDIUM-3）。
  */
 kind:BusinessViewKind;chart:BusinessChartType;title:string;localized?:BusinessViewLocalizedMetadata;dimensionField?:string
 scope:string;objectType:string;computedAt:string
 /**
  * `fieldType` 是这项度量绑定字段的声明类型（`count` 不绑字段，因此缺省）：
  * `datetime` 的 min/max 回的是毫秒时刻，界面据此还原成时间。没有这一位时界面只能拿
  * 度量标识去撞同名字段声明，`count` 度量一旦与某个 datetime 字段同名就会被画成 1970 年（复审 MEDIUM-2）。
  */
 measures:Array<{id:string;label:string;localized?:BusinessViewMeasureLocalizedMetadata;fieldType?:BusinessFieldType}>
 rows:BusinessViewRow[]
 /** 截断前的维度取值组数（`board-card` 恒 1，`list` 是筛选后的对象条数）：界面据此如实说"共几项、显示前几项"。 */
 dimensionValues:number
 coverage:BusinessViewCoverage
 /** 声明引用了、但已固定快照里一次都没出现过的字段名；界面据此给降级提示。 */
 missingFields:string[]
 objects?:BusinessLedgerObject[]
}
/** `kind==='list'` 专用：平台四列里的三列与对象详情都来自固定快照本身。 */
export type BusinessLedgerObject={id:string;title:string;source:string;observedAt:string;receivedAt:string;quality:'complete'|'missing';version:number;snapshotHash:string;summary:string;fields:Array<{label:string;value:string}>}
export type BusinessLedgerBlock={
 objectType:BusinessObjectTypeRecord
 objects:number
 /** 来源称呼由模板声明；未声明时界面用通用名词，回包保留它供展示与分享。 */
 source:{sourceId:string;connected:boolean;sourceNoun?:string}
 defaultAction?:{actionId:string;title:string;targetKind:'work-template'|'execution-tool';available:boolean}
 /**
  * 块级覆盖面与缺失披露：一张视图都没声明的块也必须把"统计基于已同步的 N 条"与截断如实写出来，
  * 否则用户看到的数字没有任何分母交代（复审 HIGH-2）。视图级那两份仍保留——同一个块里每张视图
  * 引用的字段各不相同，`BusinessViewResult.missingFields` 只覆盖该视图引用到的那几个。
  */
 coverage:BusinessViewCoverage
 /** 只有对象类型声明了 `progress` 才出现；服务端按固定快照重新计算，不由界面或行业名称推断。 */
 progress?:{unfinished:number;waitingForYou:number;latestChangedAt:string|null}
 /** 该对象类型全部声明字段里，至少有一个已同步对象读不出取值的那些字段名（块级全量，不按视图收窄）。 */
 missingFields:string[]
 views:BusinessViewResult[]
}
export type BusinessLedger={schema:'teloa.business-ledger/v1';scope:string;computedAt:string;blocks:BusinessLedgerBlock[];actions:BusinessActionRecord[]}

const bad=(message:string)=>new WorkError('teloa/invalid-input',message)
/** 缺键/多键都指出具体字段名（不带路径的泛化文案让模型无从下手排查，见页内新建业务定义的可用性缺陷复盘）。 */
const maxNamedFields=8
const exact=(value:unknown,keys:readonly string[],message:string):Record<string,unknown>=>{
 if(!isRecord(value))throw bad(message)
 const missing=keys.filter(key=>!(key in value)),extra=Object.keys(value).filter(key=>!keys.includes(key))
 if(!missing.length&&!extra.length)return value
 const parts:string[]=[]
 if(missing.length)parts.push('缺少字段 '+missing.slice(0,maxNamedFields).join('、'))
 if(extra.length)parts.push('不认识的字段 '+extra.slice(0,maxNamedFields).join('、'))
 throw bad(message.replace(/。$/,'')+'：'+parts.join('；')+'。')
}
/** 枚举/字面量取值不合法时把实际取值与允许列表一并报出，避免模型靠猜。 */
const invalidEnum=(message:string,value:unknown,allowed:readonly string[]):WorkError=>bad(message.replace(/。$/,'')+'，当前为「'+String(value)+'」，允许：'+allowed.join(' / ')+'。')
/** 嵌套读取器在抛错时补上位置前缀（`fields[2]`、`measures[0]`、`dimension` 等），错误码不变。 */
function atPath<T>(path:string,run:()=>T):T{
 try{return run()}
 catch(error){if(error instanceof WorkError)throw new WorkError(error.code,path+'：'+error.message);throw error}
}
/** 字段 / 度量 / 维度标识：视图与动作只引用它，界面改标签不影响引用。至多 63 字符：看板 SQL 里它就是列名，PG 标识符超过 63 字节会被静默截断。 */
const fieldName=/^[a-z0-9][a-z0-9_-]{0,62}$/
/** 对象类型 / 视图 / 动作 / 目标本地标识：与清单资源标识同规矩，不接受下划线。 */
const localId=/^[a-zA-Z0-9][a-zA-Z0-9-]{0,119}$/
const sourceIdPattern=/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/
const toolName=/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/
const exactSemver=/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
/**
 * 声明文本会同时进两个地方：界面（文本节点）与模型上下文（台账摘要、动作说明）。
 * 基础判据抄 `business-data.ts` 的 `text()`（禁 C0 控制符与 DEL，但放行 `\t`/`\n`/`\r`），
 * 在此之上再显式禁 `\r` 与 `\n`——声明文本全部是单行标签，允许换行等于允许在模型上下文里
 * 另起一段，那是注入面（规格 §8 第 1 条）；`\t` 不构成注入面，顺带放行不禁。
 */
const label=(value:unknown,max:number):value is string=>typeof value==='string'&&!!value.trim()&&value===value.trim()&&value.length<=max&&!/[\x00-\x08\x0a-\x1f\x7f]/.test(value)
const domainText=(value:unknown):value is string=>isBusinessScopeKey(value)&&value!=='general'
const semver=(value:unknown):value is string=>typeof value==='string'&&value.length<=80&&exactSemver.test(value)
const dedupList=(values:unknown,min:number,max:number,item:(value:unknown)=>boolean):values is string[]=>Array.isArray(values)&&values.length>=min&&values.length<=max&&new Set(values).size===values.length&&values.every(item)

function localizedShape(value:unknown,keys:readonly string[],message:string):Record<string,unknown>{
 if(!isRecord(value)||!Object.keys(value).length||Object.keys(value).some(key=>!keys.includes(key)))throw bad(message)
 return value
}
function localizedText(value:unknown,original:string,max:number,message:string):LocalizedMetadata{
 let metadata:LocalizedMetadata
 try{metadata=localizedMetadata(value)}catch{throw bad(message)}
 if(metadata.original!==original||Object.values(metadata.locales).some(item=>typeof item==='string'&&!label(item,max)))throw bad(message)
 return metadata
}

function fieldDefinition(value:unknown):BusinessObjectFieldDefinition{
 if(!isRecord(value))throw bad('业务对象字段定义格式不正确。')
 const hasValues=value.values!==undefined,hasReference=value.referenceType!==undefined,hasLocalized=value.localized!==undefined
 const keys=['name','label',...(hasLocalized?['localized']:[]),'type','required','from',...(hasValues?['values']:[]),...(hasReference?['referenceType']:[])]
 const row=exact(value,keys,'业务对象字段定义格式不正确。')
 if(typeof row.name!=='string'||!fieldName.test(row.name))throw bad('业务对象字段标识不合法。')
 if(!label(row.label,80))throw bad('业务对象字段标签不合法。')
 if(!(businessFieldTypes as readonly string[]).includes(row.type as string))throw invalidEnum('业务对象字段类型不合法。',row.type,businessFieldTypes)
 const type=row.type as BusinessFieldType
 if(typeof row.required!=='boolean')throw bad('业务对象字段是否必填不合法。')
 // `from` 上限 120 抄 `readBusinessObjectSnapshot`（packages/backend/src/work/business-data.ts）：声明比快照宽一格没有意义。
 if(!label(row.from,120))throw bad('业务对象字段来源不合法。')
 if(type==='enum'){
  if(!dedupList(row.values,2,32,item=>label(item,80)))throw bad('枚举取值必须是 2–32 个去重且不超 80 字的取值。')
 }else if(hasValues)throw bad('该字段类型不得带取值列表。')
 if(type==='reference'){
  if(typeof row.referenceType!=='string'||!localId.test(row.referenceType))throw bad('引用目标类型标识不合法。')
 }else if(hasReference)throw bad('该字段类型不得带引用目标类型。')
 let localized:BusinessObjectFieldLocalizedMetadata|undefined
 if(hasLocalized){
  const metadata=localizedShape(row.localized,['label','values'],'业务对象字段本地化元数据不合法。'),result:BusinessObjectFieldLocalizedMetadata={}
  if(metadata.label!==undefined)result.label=localizedText(metadata.label,row.label as string,80,'业务对象字段标签本地化元数据不合法。')
  if(metadata.values!==undefined){
   if(type!=='enum'||!Array.isArray(metadata.values)||metadata.values.length!==(row.values as string[]).length)throw bad('业务对象枚举取值本地化元数据不合法。')
   result.values=metadata.values.map((item,index)=>localizedText(item,(row.values as string[])[index]!,80,'业务对象枚举取值本地化元数据不合法。'))
  }
  localized=result
 }
 return {name:row.name,label:row.label,...(localized?{localized}:{}),type,required:row.required,from:row.from,...(hasValues?{values:[...row.values as string[]]}:{}),...(hasReference?{referenceType:row.referenceType as string}:{})}
}

function progressDefinition(value:unknown,fields:readonly BusinessObjectFieldDefinition[]):BusinessObjectProgressDefinition{
 if(!isRecord(value))throw bad('业务对象进度摘要定义格式不正确。')
 const hasChangedAtField=value.changedAtField!==undefined
 const row=exact(value,['stageField','unfinished','waitingForYou',...(hasChangedAtField?['changedAtField']:[])],'业务对象进度摘要定义格式不正确。')
 if(typeof row.stageField!=='string'||!fieldName.test(row.stageField))throw bad('业务对象进度阶段字段不合法。')
 const stage=fields.find(field=>field.name===row.stageField)
 if(!stage||stage.type!=='enum'||!stage.values)throw bad('业务对象进度阶段必须引用枚举字段。')
 const declared=(values:unknown,min:number):values is string[]=>dedupList(values,min,stage.values!.length,item=>typeof item==='string'&&stage.values!.includes(item))
 if(!declared(row.unfinished,1)||!declared(row.waitingForYou,0))throw bad('业务对象进度取值必须是阶段枚举的去重子集。')
 if((row.waitingForYou as string[]).some(value=>!(row.unfinished as string[]).includes(value)))throw bad('业务对象等待确认取值必须属于未完成取值。')
 if(hasChangedAtField){
  if(typeof row.changedAtField!=='string'||!fieldName.test(row.changedAtField)||fields.find(field=>field.name===row.changedAtField)?.type!=='datetime')throw bad('业务对象最近变化字段必须引用日期时间字段。')
 }
 return {stageField:row.stageField,unfinished:[...row.unfinished as string[]],waitingForYou:[...row.waitingForYou as string[]],...(hasChangedAtField?{changedAtField:row.changedAtField as string}:{})}
}

export function readBusinessObjectTypeDefinition(value:unknown):BusinessObjectTypeDefinition{
 if(!isRecord(value))throw bad('业务对象类型定义格式不正确。')
 const hasDefaultAction=value.defaultAction!==undefined,hasProgress=value.progress!==undefined,hasLocalized=value.localized!==undefined
 const keys=['format','id','version','domain','title',...(hasLocalized?['localized']:[]),'unit','lead','sourceId','fields',...(hasProgress?['progress']:[]),...(hasDefaultAction?['defaultAction']:[])]
 const row=exact(value,keys,'业务对象类型定义格式不正确。')
 if(row.format!=='teloa.business-object-type/v1')throw invalidEnum('业务对象类型定义格式不正确。',row.format,['teloa.business-object-type/v1'])
 if(typeof row.id!=='string'||!localId.test(row.id))throw bad('业务对象类型标识不合法。')
 if(!semver(row.version))throw bad('业务对象类型版本必须是精确三段号。')
 if(!domainText(row.domain))throw bad('业务对象类型所属业务范围不合法：'+businessScopeKeyRule+'，general 一律拒绝。')
 // title 上限对齐清单 requiredText(value.title,'资源名称',120)
 if(!label(row.title,120))throw bad('业务对象类型标题不合法。')
 if(!label(row.unit,8))throw bad('业务对象类型计数单位不合法。')
 if(!label(row.lead,500))throw bad('业务对象类型处境说明不合法。')
 if(typeof row.sourceId!=='string'||!sourceIdPattern.test(row.sourceId))throw bad('业务对象类型绑定的数据源标识不合法。')
 // fields 上限 50 抄 `readBusinessObjectSnapshot`：快照读不进来的字段声明也用不上。
 if(!Array.isArray(row.fields)||row.fields.length<1||row.fields.length>50)throw bad('业务对象类型字段必须是 1–50 项。')
 const fields=row.fields.map((item,index)=>atPath(`fields[${index}]`,()=>fieldDefinition(item)))
 if(new Set(fields.map(field=>field.name)).size!==fields.length||new Set(fields.map(field=>field.from)).size!==fields.length)throw bad('业务对象类型字段标识或来源不得重复。')
 const progress=hasProgress?atPath('progress',()=>progressDefinition(row.progress,fields)):undefined
 if(hasDefaultAction&&(typeof row.defaultAction!=='string'||!localId.test(row.defaultAction)))throw bad('业务对象类型默认动作标识不合法。')
 let localized:BusinessObjectTypeLocalizedMetadata|undefined
 if(hasLocalized){
  const metadata=localizedShape(row.localized,['title','unit','lead'],'业务对象类型本地化元数据不合法。'),result:BusinessObjectTypeLocalizedMetadata={}
  if(metadata.title!==undefined)result.title=localizedText(metadata.title,row.title as string,120,'业务对象类型标题本地化元数据不合法。')
  if(metadata.unit!==undefined)result.unit=localizedText(metadata.unit,row.unit as string,8,'业务对象类型计数单位本地化元数据不合法。')
  if(metadata.lead!==undefined)result.lead=localizedText(metadata.lead,row.lead as string,500,'业务对象类型处境说明本地化元数据不合法。')
  localized=result
 }
 return {format:'teloa.business-object-type/v1',id:row.id,version:row.version,domain:row.domain,title:row.title,...(localized?{localized}:{}),unit:row.unit,lead:row.lead,sourceId:row.sourceId,fields,...(progress?{progress}:{}),...(hasDefaultAction?{defaultAction:row.defaultAction as string}:{})}
}

/**
 * `filters` 与度量的 `where` 共用同一条读取路径，算子一律按 `businessFilterOperators`
 * 全量校验（规格 §2.5「`where` 受与 `filters` 完全相同的算子约束」）——契约层不知道
 * `field` 在对应对象类型里的真实类型，算子×字段类型的交叉约束（§2.5 表）留给读取层
 * 核对（§3.3，同「动作 inputs 数量对齐工作模板」一样是跨声明检查）。
 * `values` 上限 32 与 `fieldDefinition` 的枚举取值上限对齐：筛选值本质是枚举成员的子集。
 */
function filterClause(value:unknown,message:string):BusinessViewFilter{
 const row=exact(value,['field','op','values'],message)
 if(typeof row.field!=='string'||!fieldName.test(row.field))throw bad(message)
 if(!(businessFilterOperators as readonly string[]).includes(row.op as string))throw invalidEnum(message,row.op,businessFilterOperators)
 const op=row.op as BusinessFilterOperator
 if(!dedupList(row.values,1,32,item=>label(item,80)))throw bad(message)
 if(op!=='in'&&row.values.length!==1)throw bad(message)
 return {field:row.field,op,values:[...row.values as string[]]}
}

function measureDefinition(value:unknown):BusinessViewMeasure{
 if(!isRecord(value))throw bad('业务视图度量定义格式不正确。')
 const hasField=value.field!==undefined,hasWhere=value.where!==undefined,hasLocalized=value.localized!==undefined
 const keys=['id','label',...(hasLocalized?['localized']:[]),'aggregation',...(hasField?['field']:[]),...(hasWhere?['where']:[])]
 const row=exact(value,keys,'业务视图度量定义格式不正确。')
 if(typeof row.id!=='string'||!fieldName.test(row.id))throw bad('业务视图度量标识不合法。')
 if(!label(row.label,80))throw bad('业务视图度量标签不合法。')
 if(!(businessAggregations as readonly string[]).includes(row.aggregation as string))throw invalidEnum('业务视图度量聚合方式不合法。',row.aggregation,businessAggregations)
 const aggregation=row.aggregation as BusinessAggregation
 if(aggregation==='count'){
  if(hasField)throw bad('count 聚合不得绑定字段。')
 }else if(typeof row.field!=='string'||!fieldName.test(row.field))throw bad('非 count 聚合必须绑定字段。')
 const where=hasWhere?atPath('where',()=>filterClause(row.where,'业务视图度量筛选不合法。')):undefined
 let localized:BusinessViewMeasureLocalizedMetadata|undefined
 if(hasLocalized){
  const metadata=localizedShape(row.localized,['label'],'业务视图度量本地化元数据不合法。'),result:BusinessViewMeasureLocalizedMetadata={}
  if(metadata.label!==undefined)result.label=localizedText(metadata.label,row.label as string,80,'业务视图度量标签本地化元数据不合法。')
  localized=result
 }
 return {id:row.id,label:row.label,...(localized?{localized}:{}),aggregation,...(hasField?{field:row.field as string}:{}),...(where?{where}:{})}
}

function dimensionDefinition(value:unknown,kind:BusinessViewKind):BusinessViewDimension{
 if(!isRecord(value))throw bad('业务视图维度定义格式不正确。')
 const hasBucket=value.bucket!==undefined
 const keys=['field','limit',...(hasBucket?['bucket']:[])]
 const row=exact(value,keys,'业务视图维度定义格式不正确。')
 if(typeof row.field!=='string'||!fieldName.test(row.field))throw bad('业务视图维度字段不合法。')
 if(!Number.isSafeInteger(row.limit)||Number(row.limit)<1||Number(row.limit)>businessLedgerLimits.dimensionValues)throw bad('业务视图维度取值上限不合法。')
 if(kind==='trend'){
  if(!hasBucket)throw bad('趋势视图的维度必须带分桶。')
  if(!(businessTimeBuckets as readonly string[]).includes(row.bucket as string))throw invalidEnum('趋势视图的维度分桶不合法。',row.bucket,businessTimeBuckets)
 }else if(hasBucket)throw bad('分布视图的维度不得带分桶。')
 return {field:row.field,limit:row.limit as number,...(hasBucket?{bucket:row.bucket as BusinessTimeBucket}:{})}
}

function sortDefinition(value:unknown,measureIds:readonly string[]):BusinessViewSort{
 if(!isRecord(value))throw bad('业务视图排序定义格式不正确。')
 const hasMeasureId=value.measureId!==undefined
 const keys=['by','direction',...(hasMeasureId?['measureId']:[])]
 const row=exact(value,keys,'业务视图排序定义格式不正确。')
 if(row.by!=='dimension'&&row.by!=='measure')throw invalidEnum('业务视图排序依据不合法。',row.by,['dimension','measure'])
 if(row.direction!=='asc'&&row.direction!=='desc')throw invalidEnum('业务视图排序方向不合法。',row.direction,['asc','desc'])
 if(row.by==='measure'){
  if(typeof row.measureId!=='string'||!measureIds.includes(row.measureId))throw bad('业务视图排序依据的度量必须是本视图已声明的度量。')
 }else if(hasMeasureId)throw bad('按维度排序不得带度量标识。')
 return {by:row.by,direction:row.direction,...(hasMeasureId?{measureId:row.measureId as string}:{})}
}

function windowDefinition(value:unknown):BusinessViewWindow{
 const row=exact(value,['field','relative'],'业务视图时间窗定义格式不正确。')
 if(typeof row.field!=='string'||!fieldName.test(row.field))throw bad('业务视图时间窗字段不合法。')
 if(!(businessViewWindows as readonly string[]).includes(row.relative as string))throw invalidEnum('业务视图时间窗相对区间不在白名单内。',row.relative,businessViewWindows)
 return {field:row.field,relative:row.relative as typeof businessViewWindows[number]}
}

export function readBusinessViewDefinition(value:unknown):BusinessViewDefinition{
 if(!isRecord(value))throw bad('业务视图定义格式不正确。')
 if(!(businessViewKinds as readonly string[]).includes(value.kind as string))throw invalidEnum('业务视图种类不合法。',value.kind,businessViewKinds)
 const kind=value.kind as BusinessViewKind
 // `distribution`/`trend` 必填维度；`list`/`distribution`/`trend` 必填排序；`board-card` 两者都必须缺省。
 const hasDimension=kind==='distribution'||kind==='trend',hasSort=kind!=='board-card',hasWindow=value.window!==undefined,hasLocalized=value.localized!==undefined
 const keys=['format','id','version','domain','title',...(hasLocalized?['localized']:[]),'kind','chart','objectType',...(hasDimension?['dimension']:[]),'measures','filters',...(hasSort?['sort']:[]),...(hasWindow?['window']:[]),'limit']
 const row=exact(value,keys,'业务视图定义格式不正确。')
 if(row.format!=='teloa.business-view/v1')throw invalidEnum('业务视图定义格式不正确。',row.format,['teloa.business-view/v1'])
 if(typeof row.id!=='string'||!localId.test(row.id))throw bad('业务视图标识不合法。')
 if(!semver(row.version))throw bad('业务视图版本必须是精确三段号。')
 if(!domainText(row.domain))throw bad('业务视图所属业务范围不合法：'+businessScopeKeyRule+'，general 一律拒绝。')
 if(!label(row.title,120))throw bad('业务视图标题不合法。')
 if(!(businessChartTypes as readonly string[]).includes(row.chart as string))throw invalidEnum('业务视图图表类型不合法。',row.chart,businessChartTypes)
 if(!businessViewCharts[kind].includes(row.chart as BusinessChartType))throw invalidEnum('该视图种类不支持所选图表类型。',row.chart,businessViewCharts[kind])
 const chart=row.chart as BusinessChartType
 if(typeof row.objectType!=='string'||!localId.test(row.objectType))throw bad('业务视图统计的对象类型标识不合法。')
 const dimension=hasDimension?atPath('dimension',()=>dimensionDefinition(row.dimension,kind)):undefined
 // `list`/`board-card` 恰好一项度量（大盘卡与清单行都只有一个数字/一行）；饼图同理（一个饼只能画一项度量的占比）；其余 1–4 项。
 if(!Array.isArray(row.measures)||!row.measures.length||row.measures.length>businessLedgerLimits.measures)throw bad('业务视图度量数量不合法。')
 if((kind==='list'||kind==='board-card'||chart==='pie')&&row.measures.length!==1)throw bad('清单、大盘卡与饼图视图必须恰好一项度量。')
 const measures=row.measures.map((item,index)=>atPath(`measures[${index}]`,()=>measureDefinition(item)))
 if(new Set(measures.map(measure=>measure.id)).size!==measures.length)throw bad('业务视图度量标识不得重复。')
 if(!Array.isArray(row.filters)||row.filters.length>businessLedgerLimits.filters)throw bad('业务视图筛选数量不合法。')
 const filters=row.filters.map((filter,index)=>atPath(`filters[${index}]`,()=>filterClause(filter,'业务视图筛选不合法。')))
 const sort=hasSort?atPath('sort',()=>sortDefinition(row.sort,measures.map(measure=>measure.id))):undefined
 const window=hasWindow?atPath('window',()=>windowDefinition(row.window)):undefined
 // 行数上限：list 与 `readBusinessDataQuery` 的 1–100 对齐，board-card 固定 1，其余（distribution/trend）1–50。
 if(kind==='board-card'){if(row.limit!==1)throw bad('大盘卡视图行数固定为 1。')}
 else if(kind==='list'){if(!Number.isSafeInteger(row.limit)||Number(row.limit)<1||Number(row.limit)>businessLedgerLimits.listRows)throw bad('清单视图行数必须在 1 到 100 之间。')}
 else if(!Number.isSafeInteger(row.limit)||Number(row.limit)<1||Number(row.limit)>businessLedgerLimits.dimensionValues)throw bad('视图行数不合法。')
 let localized:BusinessViewLocalizedMetadata|undefined
 if(hasLocalized){
  const metadata=localizedShape(row.localized,['title'],'业务视图本地化元数据不合法。'),result:BusinessViewLocalizedMetadata={}
  if(metadata.title!==undefined)result.title=localizedText(metadata.title,row.title as string,120,'业务视图标题本地化元数据不合法。')
  localized=result
 }
 return {format:'teloa.business-view/v1',id:row.id,version:row.version,domain:row.domain,title:row.title,...(localized?{localized}:{}),kind,chart,objectType:row.objectType,...(dimension?{dimension}:{}),measures,filters,...(sort?{sort}:{}),...(window?{window}:{}),limit:row.limit as number}
}

/** `from:'field'|'object'|'literal'` 逐字取值；`allowLiteral=false` 用于 `execution-tool` 的 `targetFrom`（目标必须来自对象）。 */
function actionInput(value:unknown,allowLiteral:boolean):BusinessActionInput{
 if(!isRecord(value))throw bad('业务动作输入定义格式不正确。')
 if(value.from==='field'){
  const row=exact(value,['from','field'],'业务动作输入定义格式不正确。')
  if(typeof row.field!=='string'||!fieldName.test(row.field))throw bad('业务动作输入字段不合法。')
  return {from:'field',field:row.field}
 }
 if(value.from==='object'){
  const row=exact(value,['from','part'],'业务动作输入定义格式不正确。')
  if(row.part!=='title'&&row.part!=='id'&&row.part!=='summary')throw invalidEnum('业务动作输入的对象部位不合法。',row.part,['title','id','summary'])
  return {from:'object',part:row.part}
 }
 if(value.from==='literal'&&allowLiteral){
  const row=exact(value,['from','value'],'业务动作输入定义格式不正确。')
  // 字面量上限与任务输入一致（`inputs[i].length<=4000`，packages/backend/src/work/industry-tasks.ts）。
  if(!label(row.value,4000))throw bad('业务动作字面量输入不合法。')
  return {from:'literal',value:row.value}
 }
 throw invalidEnum('业务动作输入来源不合法。',value.from,allowLiteral?['field','object','literal']:['field','object'])
}

function actionTarget(value:unknown):BusinessActionTarget{
 if(!isRecord(value))throw bad('业务动作目标定义格式不正确。')
 if(value.kind==='work-template'){
  const row=exact(value,['kind','localId'],'业务动作目标定义格式不正确。')
  if(typeof row.localId!=='string'||!localId.test(row.localId))throw bad('业务动作工作模板标识不合法。')
  return {kind:'work-template',localId:row.localId}
 }
 if(value.kind==='execution-tool'){
  const row=exact(value,['kind','localId','tool','workTemplate','targetFrom'],'业务动作目标定义格式不正确。')
  if(typeof row.localId!=='string'||!localId.test(row.localId))throw bad('业务动作执行工具本地标识不合法。')
  // tool 上限 128 与安全动作提议的 `text(row.tool,128)` 对齐（packages/contract/src/security-actions.ts:186）。
  if(typeof row.tool!=='string'||row.tool.length>128||!toolName.test(row.tool))throw bad('业务动作执行工具剧本标识不合法。')
  if(typeof row.workTemplate!=='string'||!localId.test(row.workTemplate))throw bad('业务动作执行工具关联的工作模板标识不合法。')
  const targetFrom=atPath('targetFrom',()=>actionInput(row.targetFrom,false))
  return {kind:'execution-tool',localId:row.localId,tool:row.tool,workTemplate:row.workTemplate,targetFrom:targetFrom as Extract<BusinessActionInput,{from:'field'}|{from:'object'}>}
 }
 throw invalidEnum('业务动作目标种类不在白名单内。',value.kind,['work-template','execution-tool'])
}

export function readBusinessActionDefinition(value:unknown):BusinessActionDefinition{
 const hasLocalized=isRecord(value)&&value.localized!==undefined
 const row=exact(value,['format','id','version','domain','title',...(hasLocalized?['localized']:[]),'objectType','target','inputs'],'业务动作定义格式不正确。')
 if(row.format!=='teloa.business-action/v1')throw invalidEnum('业务动作定义格式不正确。',row.format,['teloa.business-action/v1'])
 if(typeof row.id!=='string'||!localId.test(row.id))throw bad('业务动作标识不合法。')
 if(!semver(row.version))throw bad('业务动作版本必须是精确三段号。')
 if(!domainText(row.domain))throw bad('业务动作所属业务范围不合法：'+businessScopeKeyRule+'，general 一律拒绝。')
 if(!label(row.title,120))throw bad('业务动作标题不合法。')
 if(typeof row.objectType!=='string'||!localId.test(row.objectType))throw bad('业务动作作用的对象类型标识不合法。')
 const target=atPath('target',()=>actionTarget(row.target))
 // inputs 上限对齐工作模板 `requirements` 上限 100（packages/backend/src/work/industry-work-source.ts）。
 if(!Array.isArray(row.inputs)||!row.inputs.length||row.inputs.length>100)throw bad('业务动作输入必须是 1–100 项。')
 const inputs=row.inputs.map((item,index)=>atPath(`inputs[${index}]`,()=>actionInput(item,true)))
 let localized:BusinessActionLocalizedMetadata|undefined
 if(hasLocalized){
  const metadata=localizedShape(row.localized,['title'],'业务动作本地化元数据不合法。'),result:BusinessActionLocalizedMetadata={}
  if(metadata.title!==undefined)result.title=localizedText(metadata.title,row.title as string,120,'业务动作标题本地化元数据不合法。')
  localized=result
 }
 return {format:'teloa.business-action/v1',id:row.id,version:row.version,domain:row.domain,title:row.title,...(localized?{localized}:{}),objectType:row.objectType,target,inputs}
}

export const businessDefinitionKinds=['object-type','view','action','source-mapping','widget','dashboard'] as const
export type BusinessDefinitionKind=typeof businessDefinitionKinds[number]

/** 声明来源：模板加载来的，还是会话里定制出来的本地声明（规格 §6.4）。客户端据此标「已本地定制」，不按形状反推。 */
export type BusinessDefinitionOrigin='template'|'local'

/** 会话草案。沿用 ResourceDraft 的 draft|applied 两态；模型侧没有任何路径能写出 applied。 */
export type BusinessDefinitionDraft={
 id:string;ownerId:string;requestId:string;scope:string;kind:BusinessDefinitionKind
 localId:string;semver:string;definitionHash:string
 /** 声明正文的规范化 JSON（industryUpdateCanonical 的输出，≤128 KiB）。 */
 body:string
 status:'draft'|'applied'
 createdAt:string;updatedAt:string
 /** status==='applied' 才有：落地成的本地声明版本号（单调递增整数）。 */
 appliedVersion?:number
}

/** 本地声明的一个版本。`version` 是单调递增整数，`semver` 是正文里那个三段号，两者各管一件事（D1）。 */
export type BusinessLocalDefinitionVersion={version:number;semver:string;definitionHash:string;bodyHash:string;createdAt:string;draftId:string}
/** 一条本地声明的版本链：`current` 缺省即当前生效的是模板那一份（或整条不出现）。 */
export type BusinessCustomizationEntry={
 scope:string;kind:BusinessDefinitionKind;localId:string
 current?:BusinessLocalDefinitionVersion
 /** 1–50 条，按 version 升序。 */
 versions:BusinessLocalDefinitionVersion[]
 /** 同 localId 的模板声明在不在、是哪一版——「回到模板版本」能不能点由它说。 */
 template:{available:boolean;version?:string}
}
export type BusinessCustomizationDirectory={
 schema:'teloa.business-customization/v1';scope:string;readAt:string
 drafts:BusinessDefinitionDraft[];entries:BusinessCustomizationEntry[]
}

/** 差异一行。`path` 是规范化正文里的路径（`fields[2].label`、`measures[0].where.values[1]`），缺省侧为 null。 */
export type BusinessDefinitionDiffRow={path:string;before:string|null;after:string|null}
export type BusinessDefinitionPreview={
 schema:'teloa.business-definition-preview/v1'
 draft:BusinessDefinitionDraft
 /** 当前进程只读预览签发的不可伪造回执；确认请求必须原样带回。 */
 receipt:string
 /** 比对基准：当前生效的那一份是模板的、本地的，还是根本没有（新增声明）。 */
 base:{origin:BusinessDefinitionOrigin|'none';semver?:string;definitionHash?:string}
 diff:BusinessDefinitionDiffRow[]
 /** 差异过多时只列前 businessCustomizationLimits.diffRows 行，并把这一位置真——不静默截断（规格 §8 第 7 条）。 */
 diffTruncated:boolean
 /** 影响范围：全是标识，不含取值样例。 */
 impact:{scope:string;objectType:string;views:string[];actions:string[];fields:string[];widgets:string[];dashboards:string[]}
 /** 试算：按草案算出来的那一个块，形状与台账逐字相同（D4）。数据源未连接或零对象时缺省。 */
 trial?:BusinessLedgerBlock
 /**
  * `pull-required`：只用于来源为受管 MCP 工具的映射草案——打开预览不调外部工具，用户显式点「试拉」（预览请求带 `pull:true`）才调一次。
  * `pull-failed`：只用于 source-mapping 草案——来源已接上、试拉调用却失败（超时、回包不符等）；界面保留「试拉」可重试，失败原文不上屏。
  * `config-unreadable`：只用于 source-mapping 草案——数据源配置文件存在却读不了（JSON 损坏、格式不正确、权限不对）；界面请用户检查配置文件。
  */
 trialUnavailable?:'source-disconnected'|'no-objects'|'pull-required'|'pull-failed'|'config-unreadable'
 /** widget 草案：按草案真跑一次 SQL（同一执行边界、≤ 50 行）；SQL 不合规时 `status:'failed'` 带 reason，预览本身不抛。 */
 widgetTrial?:BusinessWidgetResult
 /** dashboard 草案：引用的组件全部存在时给出布局。 */
 dashboardTrial?:{layout:BusinessDashboardLayoutItem[]}
 /** source-mapping 草案：对源试拉 1 页、按映射转换，不落库；`objects` 为映射后的前几条对象字段。 */
 mappingTrial?:{fetched:number;objects:Array<{objectId:string;fields:Array<{field:string;value:string}>}>}
 computedAt:string
}

/** 定制层资源上限，与 `businessLedgerLimits` 同规矩：全是字面量常量，不做设置项。 */
export const businessCustomizationLimits={bodyBytes:131072,draftsPerScope:32,versionsPerDefinition:50,diffRows:400} as const

/** 按 kind 分派到六个 read*：草案、本地声明、试算三条路径共用唯一一处分派，不各写一遍。 */
export function readBusinessDefinitionBody(kind:BusinessDefinitionKind,value:unknown):BusinessObjectTypeDefinition|BusinessViewDefinition|BusinessActionDefinition|BusinessSourceMappingDefinition|BusinessWidgetDefinition|BusinessDashboardDefinition{
 if(kind==='object-type')return readBusinessObjectTypeDefinition(value)
 if(kind==='view')return readBusinessViewDefinition(value)
 if(kind==='source-mapping')return readBusinessSourceMappingDefinition(value)
 if(kind==='widget')return readBusinessWidgetDefinition(value)
 if(kind==='dashboard')return readBusinessDashboardDefinition(value)
 return readBusinessActionDefinition(value)
}
/**
 * 规范化正文：industryUpdateCanonical 的输出，同一份声明必得同一个字节串（差异基准与 bodyHash 都取它）。
 * 入参是对应 `read*` 的返回值——那六个函数的返回里没有取值为 `undefined` 的键，因此输出一定是合法 JSON。
 */
export function businessDefinitionCanonicalBody(definition:unknown):string{
 const body=industryUpdateCanonical(definition)
 if(new TextEncoder().encode(body).byteLength>businessCustomizationLimits.bodyBytes)throw bad('业务声明正文超过 128 KiB。')
 return body
}
/** 规范化正文 → 路径 → 叶子值文本，差异与影响范围共用。叶子一律 JSON.stringify，数组保序。 */
export function businessDefinitionPaths(definition:unknown):Map<string,string>{
 const paths=new Map<string,string>()
 // 缺省的可选键不进路径表：否则「本来没有这一位」与「这一位是 null」在差异里长得一样。
 const walk=(value:unknown,path:string):void=>{
  if(value===undefined)return
  if(Array.isArray(value)){value.forEach((item,index)=>walk(item,path+'['+index+']'));return}
  if(isRecord(value)){for(const [key,item] of Object.entries(value))walk(item,path?path+'.'+key:key);return}
  paths.set(path,JSON.stringify(value))
 }
 walk(definition,'')
 return paths
}

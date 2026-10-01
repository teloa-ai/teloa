import {createHash} from 'node:crypto'

/** 与 `businessObjectSnapshotHash`（packages/backend/src/work/business-data.ts:59）同一条键序摘要。 */
export const snapshotDigest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const seedHash=(seed:string)=>createHash('sha256').update(seed).digest('hex')
export const computedAt='2026-09-15T02:00:00.000Z'

export const definitionSource=(scope:string,localId:string,version='1.0.0')=>({
 loadId:'load-1',scope,localId,version,
 contentHash:seedHash(localId+':content'),fileHash:seedHash(localId+':file'),definitionHash:seedHash(localId+':'+version),
 origin:'template' as const,
})

export function objectTypeDefinition(over:Record<string,unknown>={}){
 const row:Record<string,unknown>={
  format:'teloa.business-object-type/v1',id:'alert-ticket',version:'1.0.0',domain:'SOC',
  title:'告警工单',unit:'条',lead:'来自告警平台和终端记录，进来之后先归并再判断。',sourceId:'security-alert-http',
  fields:[
   // localized.label 补英文，供「缺失字段按当前语言的列表习惯排版」在 en 下核对：没有它就落回中文原文，不是组件的锅。
   {name:'severity',label:'严重度',type:'enum',required:true,from:'严重度',values:['高','中','低'],localized:{label:{original:'严重度',defaultLocale:'zh-CN',locales:{'zh-CN':'严重度',en:'Severity'}}}},
   {name:'first-seen-at',label:'首次出现',type:'datetime',required:true,from:'首次出现',localized:{label:{original:'首次出现',defaultLocale:'zh-CN',locales:{'zh-CN':'首次出现',en:'First seen'}}}},
  ],
  defaultAction:'assign-alert-review',
  ...over,
 }
 // 传 defaultAction:null 表示这一类在台账块上不出按钮（覆盖「缺省」那条分支）；
 // 契约的白名单键判据不接受「键在但值是 undefined」，所以这里整键删掉。
 if(row.defaultAction===null)delete row.defaultAction
 return row
}

export function actionDefinition(over:Record<string,unknown>={}){
 return {
  format:'teloa.business-action/v1',id:'assign-alert-review',version:'1.0.0',domain:'SOC',
  title:'交给同事核对',objectType:'alert-ticket',
  target:{kind:'work-template',localId:'alert-triage-review'},
  inputs:[{from:'object',part:'title'},{from:'object',part:'summary'}],
  ...over,
 }
}

export function ledgerObject(scope:string,type:string,id:string,over:{quality?:'complete'|'missing';fields?:Array<{label:string;value:string}>}={}){
 const quality=over.quality??'complete'
 const fields=over.fields??[{label:'严重度',value:'高'},{label:'首次出现',value:'2026-09-14T22:00:00.000Z'}]
 const snapshot={
  scope,type,id,version:1,title:'工单 '+id,source:'EDR',
  observedAt:'2026-09-15T01:00:00.000Z',receivedAt:'2026-09-15T01:05:00.000Z',quality,summary:'这条还没有人看过。',fields,
 }
 return {
  id,title:snapshot.title,source:snapshot.source,observedAt:snapshot.observedAt,receivedAt:snapshot.receivedAt,
  quality,version:1,snapshotHash:snapshotDigest(snapshot),summary:snapshot.summary,fields,
 }
}

/**
 * 一份视图结果。`kind`/`chart`/`title`/`dimensionValues` 由服务端逐字给出（契约 `BusinessViewResult`），
 * 缺省造一张 `distribution`/`bar`，`dimensionValues` 跟行数一致（即"没有被截断"）。
 */
/** 显式声明返回形状：`...over` 来自宽松的 `Record<string,unknown>`，靠推断拿不到 `objects` 这类只在个别调用点才有的键。 */
type ViewResult={
 schema:string;viewId:string;viewVersion:string;definitionHash:string;origin:string
 kind:string;chart:string;title:string
 scope:string;objectType:string;computedAt:string
 measures:Array<{id:string;label:string;fieldType?:string}>
 rows:Array<{dimension:string;label:string;values:Array<number|null>}>
 dimensionValues:number
 coverage:{objects:number;latestReceivedAt:string|null;truncated:boolean}
 missingFields:string[]
 objects?:ReturnType<typeof ledgerObject>[]
}

export function viewResult(scope:string,objectType:string,viewId:string,rows:Array<{dimension:string;label:string;values:Array<number|null>}>,over:Record<string,unknown>={}):ViewResult{
 return {
  schema:'teloa.business-view-result/v1',viewId,viewVersion:'1.0.0',definitionHash:seedHash(viewId+':1.0.0'),origin:'template',
  kind:'distribution',chart:'bar',title:'风险分布',
  scope,objectType,computedAt,
  measures:[{id:'total',label:'条数'}],rows,
  dimensionValues:rows.length,
  coverage:{objects:12,latestReceivedAt:'2026-09-15T01:05:00.000Z',truncated:false},
  missingFields:[],
  ...over,
 }
}

export function listView(scope:string,objectType:string,objects:ReturnType<typeof ledgerObject>[]){
 return viewResult(scope,objectType,'object-list',objects.map(object=>({dimension:object.id,label:object.title,values:[1]})),{kind:'list',chart:'table',title:'对象清单',objects})
}

export function block<V=ReturnType<typeof viewResult>>(over:{definition?:Record<string,unknown>;objects?:number;connected?:boolean;views?:V[];defaultAction?:unknown;progress?:unknown;scope?:string;coverage?:unknown;missingFields?:string[]}={}){
 const definition=objectTypeDefinition(over.definition??{})
 const scope=over.scope??String(definition.domain)
 const defaultAction=over.defaultAction===undefined?{actionId:'assign-alert-review',title:'交给同事核对',targetKind:'work-template',available:true}:over.defaultAction
 const views=(over.views??[viewResult(scope,String(definition.id),'risk-distribution',[{dimension:'高',label:'高',values:[7]},{dimension:'中',label:'中',values:[5]}])]) as V[]
 /**
  * 覆盖面是块级数据（同一批行算出来的）：块与每张视图那份必须逐项一致，块的 `objects` 也等于
  * 覆盖面里的对象数。要造"截断"或"还没同步过"那两档就在块上传 `coverage`，视图那份跟着改写。
  */
 const coverage=(over.coverage??{objects:over.objects??12,latestReceivedAt:'2026-09-15T01:05:00.000Z',truncated:false}) as {objects:number;latestReceivedAt:string;truncated:boolean}
 return {
  objectType:{source:definitionSource(scope,String(definition.id)),definition},
  objects:coverage.objects,
  source:{sourceId:String(definition.sourceId),connected:over.connected??true},
  ...(defaultAction===null?{}:{defaultAction}),
  coverage,missingFields:over.missingFields??[],
  ...(over.progress===undefined?{}:{progress:over.progress}),
  views:views.map(view=>({...view,coverage})),
 }
}

export function ledger<B=ReturnType<typeof block<ReturnType<typeof viewResult>>>>(over:{scope?:string;blocks?:B[];actions?:unknown[]}={}){
 const scope=over.scope??'SOC'
 return {
  schema:'teloa.business-ledger/v1',scope,computedAt,
  blocks:(over.blocks??[block()]) as B[],
  actions:over.actions??[{source:definitionSource(scope,'assign-alert-review'),definition:actionDefinition()}],
 }
}

/** 第二份声明：`domain` 不同、标题不同、字段不同，用来证明同一套组件换范围零改动。 */
export function otherLedger(){
 const definition={
  id:'vulnerability',domain:'AppSec',title:'漏洞',unit:'个',lead:'扫描器报上来的，先确认再排期。',
  sourceId:'appsec-finding-http',
  fields:[{name:'state',label:'处理状态',type:'enum',required:true,from:'处理状态',values:['待确认','修复中','已修复']}],
  defaultAction:null,
 }
 return ledger({
  scope:'AppSec',
  blocks:[block({scope:'AppSec',definition,defaultAction:null,views:[viewResult('AppSec','vulnerability','finding-board',[{dimension:'',label:'漏洞',values:[9]}],{kind:'board-card',chart:'number',title:'待确认漏洞',dimensionValues:1})]})],
  actions:[],
 })
}

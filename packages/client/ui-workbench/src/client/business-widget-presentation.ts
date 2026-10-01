import {isBusinessMatchValue,type BusinessConfigurationViewRef,type BusinessLedger,type BusinessObjectTypeDefinition,type BusinessViewResult,type BusinessWidgetCell,type BusinessWidgetDefinition,type BusinessWidgetResult,type BusinessWidgetThreshold,type WorkErrorCode} from '@teloa/contract'
import {businessDashboardErrorKey,type BusinessDashboardErrorKey} from './business-dashboard-errors.ts'
import type {BusinessTarget} from './business-preview.ts'

/**
 * 看板原生组件的纯函数：色调、分列、阶段归一、单元格读法、失败原因词条与视图引用投影。
 * 组件（`BusinessWidgets.tsx`）只负责把这些结果摆出来，不在 JSX 里再判一遍。
 */

export type WidgetTone=BusinessWidgetThreshold['tone']

/** 阈值按声明顺序取第一条命中的色调；取值为空或都不命中即无色调（不猜「正常」）。 */
export function metricTone(value:number|null,thresholds:readonly Pick<BusinessWidgetThreshold,'op'|'value'|'tone'>[]):WidgetTone|undefined{
 if(value===null)return undefined
 return thresholds.find(item=>item.op==='gte'?value>=item.value:value<=item.value)?.tone
}

/** 按声明的状态分列，声明外的状态归「其他」列（`status:null`），「其他」列没有卡片就不出。 */
export function boardColumns<T extends {status:string}>(cards:readonly T[],statuses:readonly string[]):Array<{status:string|null;cards:T[]}>{
 const columns=statuses.map(status=>({status:status as string|null,cards:cards.filter(card=>card.status===status)}))
 const other=cards.filter(card=>!statuses.includes(card.status))
 return other.length?[...columns,{status:null,cards:other}]:columns
}

/** 按声明阶段归一：缺的阶段数量补 0、时长为空；声明外的阶段不画（阶段条的顺序只认声明）。 */
export function pipelineStages(rows:ReadonlyArray<{stage:string;count:number;duration:number|null}>,stages:readonly string[]):Array<{stage:string;count:number;duration:number|null}>{
 return stages.map(stage=>{const row=rows.find(item=>item.stage===stage);return {stage,count:row?.count??0,duration:row?.duration??null}})
}

/** 按列名取一列的下标；声明引用的列不在结果里时返回 -1，调用方按缺值处理。 */
export const columnIndex=(result:BusinessWidgetResult,name:string)=>result.columns.findIndex(column=>column.name===name)
export const numberCell=(value:unknown):number|null=>typeof value==='number'&&Number.isFinite(value)?value:null

type CellFormat={yes:string;no:string;number:(value:number)=>string;dateTime:(value:Date)=>string}
/** 结果单元格的界面读法：布尔写人话、时刻本地化、空值写破折号；取值只作文本，不当标记解释。 */
export function widgetCells(result:BusinessWidgetResult,format:CellFormat,columns?:readonly string[]):string[][]{
 const indexes=columns?columns.map(name=>columnIndex(result,name)):result.columns.map((_,index)=>index)
 return result.rows.map(row=>indexes.map(index=>{
  const value=index<0?null:row[index]??null,type=index<0?'null':result.columns[index]!.type
  if(value===null)return '—'
  if(typeof value==='boolean')return value?format.yes:format.no
  if(typeof value==='number')return format.number(value)
  if(type==='datetime'&&Number.isFinite(Date.parse(value)))return format.dateTime(new Date(value))
  return value
 }))
}

export type WidgetFailureKey=BusinessDashboardErrorKey

/** 任意失败（组件结果里的 error，或调用抛出的 WorkError）→ 固定词条；映射本身见 `business-dashboard-errors.ts`。 */
export function widgetFailure(error:unknown):ReturnType<typeof businessDashboardErrorKey>{
 const code=error!==null&&typeof error==='object'&&'code' in error?String((error as {code:unknown}).code):''
 const reason=error!==null&&typeof error==='object'?String((error as {reason?:unknown;message?:unknown}).reason??(error as {message?:unknown}).message??''):''
 return businessDashboardErrorKey({code:code as WorkErrorCode,reason})
}

type ViewShape=Pick<BusinessViewResult,'kind'|'chart'|'measures'>&{dimensionField?:string|undefined}
/**
 * 视图引用组件：服务端把视图投影成 `[dimension,label,<度量 id>…]` 存进结果快照，这里还原成台账那五个画法认的形状。
 * 画法、度量标签与维度字段取台账里同一视图的那份（界面不从行的形状反推）；台账里没有这份视图时一律画表格。
 */
export function viewRefProjection(result:BusinessWidgetResult,title:string,shape?:ViewShape):BusinessViewResult{
 const measureIds=result.columns.slice(2).map(column=>column.name)
 const measures=measureIds.map(id=>{const found=shape?.measures.find(measure=>measure.id===id);return found?{...found}:{id,label:id}})
 const rows=result.rows.map(row=>({dimension:String(row[0]??''),label:String(row[1]??''),values:row.slice(2).map(numberCell)}))
 return {
  schema:'teloa.business-view-result/v1',viewId:result.widgetId,viewVersion:'0.0.0',definitionHash:result.definitionHash,origin:'template',
  kind:shape?.kind??'distribution',chart:shape?.chart??'table',title,...(shape?.dimensionField!==undefined?{dimensionField:shape.dimensionField}:{}),
  scope:'',objectType:'',computedAt:result.computedAt,measures,rows,dimensionValues:rows.length,
  coverage:{objects:rows.length,latestReceivedAt:null,truncated:false},missingFields:[],
 }
}

/** 配置页面以显式元数据为准；只有旧台账调用才保留原来的无元数据表格兼容。 */
export function viewRefPresentation(widget:BusinessWidgetDefinition,result:BusinessWidgetResult,title:string,{viewRefs,ledger}:{viewRefs?:readonly BusinessConfigurationViewRef[]|undefined;ledger?:BusinessLedger|undefined}):{view:BusinessViewResult;objectType?:BusinessObjectTypeDefinition}|undefined{
 if(viewRefs!==undefined){
  const ref=viewRefs.find(({view,objectType})=>view.id===widget.viewRef&&view.domain===widget.domain&&objectType.domain===widget.domain&&view.objectType===objectType.id)
  if(!ref)return undefined
  const {view,objectType}=ref
  const measureIds=result.columns.slice(2).map(column=>column.name)
  if(measureIds.length!==view.measures.length||measureIds.some(id=>!view.measures.some(measure=>measure.id===id)))return undefined
  const measures=view.measures.map(measure=>{
   const fieldType=objectType.fields.find(field=>field.name===measure.field)?.type
   return {...measure,...(fieldType===undefined?{}:{fieldType})}
  })
  const projected=viewRefProjection(result,title,{kind:view.kind,chart:view.chart,measures,dimensionField:view.dimension?.field})
  return {view:{...projected,viewId:view.id,viewVersion:view.version,scope:view.domain,objectType:objectType.id},objectType}
 }
 const block=ledger?.blocks.find(item=>item.views.some(view=>view.viewId===widget.viewRef))
 const shape=block?.views.find(view=>view.viewId===widget.viewRef)
 return {view:viewRefProjection(result,title,shape),...(block?{objectType:block.objectType.definition}:{})}
}

/**
 * 点击下钻的导航目标（二期规格 §4.3）：`idColumn` → 单个对象（清单同时按 `_id` 收窄，保证目标对象一定在清单里）；
 * `match` → 按字段取值过滤的对象清单；只写 `objectType` 或没有行（标题行按钮）→ 未过滤清单。
 * 行来自结果快照或图表点击，后者由外部库给出、不可信：只收有限的文本 / 数字 / 布尔，取值 1–200 字无控制字符，否则不可点。
 */
export function drilldownTarget(scope:string,widget:BusinessWidgetDefinition,row:Readonly<Record<string,BusinessWidgetCell>>|undefined):BusinessTarget|undefined{
 const drilldown=widget.drilldown
 if(!drilldown)return undefined
 const base:BusinessTarget={scope,section:'data',objectType:drilldown.objectType}
 const column=drilldown.idColumn??drilldown.match?.column
 if(column===undefined||row===undefined)return base
 const cell:unknown=Object.hasOwn(row,column)?row[column]:undefined
 if(typeof cell!=='string'&&typeof cell!=='boolean'&&!(typeof cell==='number'&&Number.isFinite(cell)))return undefined
 const value=String(cell)
 if(!isBusinessMatchValue(value))return undefined
 return drilldown.idColumn!==undefined?{...base,id:value,match:{field:'_id',value}}:{...base,match:{field:drilldown.match!.field,value}}
}

/** 结果快照的一行按列名展开，交给 `drilldownTarget`。 */
export const widgetRow=(result:BusinessWidgetResult,row:readonly BusinessWidgetCell[]):Record<string,BusinessWidgetCell>=>Object.fromEntries(result.columns.map((column,index)=>[column.name,row[index]??null]))

import {businessObjectReference,readBusinessViewWidgetResultV2,type BusinessObjectReference,type BusinessConfigurationViewRefVersioned,type BusinessViewResultV2,type BusinessViewWidgetResultV2,type BusinessWidgetDefinition} from '@teloa/contract'
import {durationText,localizedBusinessFieldLabel,localizedBusinessFieldValue,localizedBusinessMeasureLabel,localizedBusinessObjectType,localizedBusinessViewTitle} from './business-definition-localization.js'
import {useI18n,type I18nValue} from './i18n/provider.js'
import css from './BusinessTypedViewWidget.module.css'
import dashboardCss from './BusinessDashboardPage.module.css'

type Measure=BusinessViewResultV2['measures'][number]
type Value=BusinessViewResultV2['rows'][number]['values'][number]
type Coverage=BusinessViewResultV2['coverage']
/** 页面级存档口径：按对象类型取多数组件共用的覆盖范围，页面只说一次。 */
export type TypedViewSharedCoverage=ReadonlyMap<string,{objectType:BusinessConfigurationViewRefVersioned['objectType'];coverage:Coverage}>
const coverageKey=(coverage:Coverage)=>coverage.objects+'\0'+(coverage.latestReceivedAt??'')
function coverageText(coverage:Coverage,format:I18nValue):string{
 return coverage.latestReceivedAt===null?format.t('business.ledger.coverage.snapshotNever',{count:coverage.objects}):format.t('business.ledger.coverage.snapshot',{count:coverage.objects,at:format.dateTime(new Date(coverage.latestReceivedAt))})
}

/** 小数正文只分拆字符串，整数分组交给 Intl 的 BigInt 路径，负的小于一金额保留符号。 */
function moneyText(decimal:string,currency:string,locale:string):string{
 const negative=decimal.startsWith('-'),[integer,fraction]=decimal.replace(/^-/,'').split('.')
 const formatter=new Intl.NumberFormat(locale)
 const separator=formatter.formatToParts(1.1).find(part=>part.type==='decimal')?.value??'.'
 return currency+' '+(negative?'-':'')+formatter.format(BigInt(integer!))+(fraction===undefined?'':separator+fraction)
}
function valueText(value:Value,measure:Measure,format:I18nValue):string{
 if(value===null)return '—'
 if(typeof value==='object')return moneyText(value.decimal,value.currency,format.locale)
 if(measure.fieldType==='duration')return durationText(value,format.number)
 return measure.fieldType==='datetime'?format.dateTime(new Date(value)):format.number(value,{maximumFractionDigits:20})
}

/** 日期桶是 UTC 身份；按稳定维度重新本地化，不能沿用宿主计算的中文标签。 */
function dimensionText(row:BusinessViewResultV2['rows'][number],ref:BusinessConfigurationViewRefVersioned,format:I18nValue):string{
 const field=ref.objectType.fields.find(field=>field.name===ref.view.dimension?.field)
 if(field?.type==='datetime'){
  const bucket=ref.view.dimension?.bucket
  return format.dateTime(row.dimension,bucket===undefined?{dateStyle:'medium',timeStyle:'short',timeZone:'UTC'}:{
   year:'numeric',month:bucket==='hour'?'short':'long',timeZone:'UTC',
   ...(bucket==='month'?{}:{day:'numeric'}),...(bucket==='hour'?{hour:'2-digit',hourCycle:'h23'}:{}),
  })
 }
 if(field?.type==='boolean'&&(row.dimension==='true'||row.dimension==='false'))return format.t(row.dimension==='true'?'business.dashboards.boolean.true':'business.dashboards.boolean.false')
 return field?localizedBusinessFieldValue(field,row.label||row.dimension,format.locale):row.label
}

/** 仅为绘图把精确金额按本度量最大绝对值缩到 [-1,1]；精确读数永远走 valueText。 */
function plotValues(values:readonly Value[]):Array<number|null>{
 const money=values.some(value=>value!==null&&typeof value==='object')
 if(money){
  const units=values.map(value=>value===null?null:typeof value==='object'?BigInt(value.decimal.replace('.','')+'0'.repeat(4-(value.decimal.split('.')[1]?.length??0))):null)
  const maximum=units.reduce<bigint>((max,value)=>{const absolute=value===null?0n:value<0n?-value:value;return absolute>max?absolute:max},0n)
  return units.map(value=>value===null?null:maximum===0n?0:Number(value*1_000_000n/maximum)/1_000_000)
 }
 const numbers=values.map(value=>typeof value==='number'?value:null),maximum=Math.max(0,...numbers.map(value=>Math.abs(value??0)))
 return numbers.map(value=>value===null?null:maximum===0?0:value/maximum)
}

function checkedView(widget:BusinessWidgetDefinition,result:unknown,refs:readonly BusinessConfigurationViewRefVersioned[]|undefined):{view:BusinessViewResultV2;ref:BusinessConfigurationViewRefVersioned}|undefined{
 try{
  const parsed=readBusinessViewWidgetResultV2(result),view=parsed.view
  const ref=refs?.find(candidate=>candidate.view.id===widget.viewRef)
  if(widget.kind!=='view-ref'||parsed.widgetId!==widget.id||!ref)return undefined
  const definition=ref.view
  if(view.viewId!==definition.id||view.viewVersion!==definition.version||view.scope!==widget.domain||definition.domain!==widget.domain||view.objectType!==definition.objectType||ref.objectType.id!==view.objectType||ref.objectType.domain!==view.scope||view.kind!==definition.kind||view.chart!==definition.chart||view.dimensionField!==definition.dimension?.field||view.measures.length!==definition.measures.length)return undefined
  const dimension=ref.objectType.fields.find(field=>field.name===definition.dimension?.field)
  if(view.dimensionMode!==(dimension?.type==='multi-enum'?'membership':'records'))return undefined
  if(dimension?.type==='datetime'&&view.rows.some(row=>{const date=new Date(row.dimension);return !Number.isFinite(date.getTime())||date.toISOString()!==row.dimension}))return undefined
  for(const [index,declared] of definition.measures.entries()){
   const measure=view.measures[index]!,field=ref.objectType.fields.find(candidate=>candidate.name===declared.field)
   const currency='currency'in declared?declared.currency:undefined
   if(measure.id!==declared.id||measure.aggregation!==declared.aggregation||measure.fieldType!==field?.type||measure.currency!==currency)return undefined
  }
  return {view,ref}
 }catch{return undefined}
}

/** 卡片标题已显示组件名：表格名称只给辅助技术；首列表头是行的真实含义（清单为对象类型，分组为维度字段）。 */
function ExactTable({view,firstColumn,format,openRecord}:{view:BusinessViewResultV2;firstColumn:string;format:I18nValue;openRecord?:((reference:BusinessObjectReference)=>void)|undefined}){
 return <div className={css.tableWrap}><table className={css.table} aria-label={view.title}>
  <thead><tr><th scope="col">{firstColumn}</th>{view.measures.map(measure=><th scope="col" key={measure.id}>{measure.label}{measure.currency&&<> ({measure.currency})</>}</th>)}</tr></thead>
  <tbody>{view.rows.map((row,position)=>{
   const object=view.kind==='list'?view.objects?.[position]:undefined,title=object?.title||row.label||row.dimension
   let reference:BusinessObjectReference|undefined
   try{if(object)reference=businessObjectReference({scope:view.scope,type:view.objectType,id:object.id,version:object.version,snapshotHash:object.snapshotHash})}catch{/* 无合法固定来源的行只读展示，不推断 latest。 */}
   return <tr key={row.dimension}><th scope="row">{view.chart==='pie'&&<span className={css.swatch} data-series={position%4} aria-hidden="true"/>}{reference&&openRecord?<button type="button" className={dashboardCss.drill} onClick={()=>openRecord(reference)}>{title}</button>:title}</th>{view.measures.map((measure,index)=><td key={measure.id}>{valueText(row.values[index]??null,measure,format)}</td>)}</tr>
  })}</tbody>
 </table></div>
}

function Plot({view,measure,index}:{view:BusinessViewResultV2;measure:Measure;index:number}){
 const format=useI18n(),{t}=format,source=view.rows.map(row=>row.values[index]??null)
 // 饼图的比例只在正值之间计算，负金额不能收紧正值的绘图精度。
 const values=plotValues(view.chart==='pie'?source.map(value=>value!==null&&(typeof value==='number'?value>0:!value.decimal.startsWith('-')&&value.decimal!=='0')?value:null):source)
 const high=Math.max(0,...values.map(value=>value??0)),low=Math.min(0,...values.map(value=>value??0)),span=high-low||1
 const at=(value:number)=>(value-low)/span*100,zero=at(0)
 const segments:string[][]=[];let current:string[]=[]
 values.forEach((value,position)=>{if(value===null){if(current.length)segments.push(current);current=[]}else current.push(`${view.rows.length>1?position/(view.rows.length-1)*100:50},${39-at(value)*.38}`)})
 if(current.length)segments.push(current)
 const slices=values.map(value=>Math.max(0,value??0)),total=slices.reduce((sum,value)=>sum+value,0);let start=0
 return <section className={css.plot} data-typed-series={measure.id}>
  <h4>{measure.label}{measure.currency&&<> ({measure.currency})</>}</h4>
  {/* 柱状图按行画：类别名、柱条、精确读数同行，各行共用一套列宽使柱长可比；对照表仍在下方供辅助技术读取。 */}
  {view.chart==='bar'?<ol className={css.barRows} aria-hidden="true" data-typed-bars>{values.map((value,position)=>{
   const row=view.rows[position]!
   return <li key={row.dimension}><span>{row.label}</span><span className={css.barTrack}>{value!==null&&<i style={{marginLeft:Math.min(zero,at(value))+'%',width:Math.abs(at(value)-zero)+'%'}}/>}</span><span>{valueText(source[position]??null,measure,format)}</span></li>
  })}</ol>:view.chart==='line'?<svg viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true" className={css.lines}>
   {segments.map((points,part)=>points.length===1?<circle key={part} cx={points[0]!.split(',')[0]} cy={points[0]!.split(',')[1]} r="1"/>:<polyline key={part} fill="none" points={points.join(' ')}/>)}
  </svg>:<>{total>0&&<svg viewBox="0 0 36 36" aria-hidden="true" className={css.pie}>{slices.map((value,position)=>{
   const share=value/total*100,offset=start;start+=share
   return <circle key={view.rows[position]!.dimension} data-series={position%4} cx="18" cy="18" r="15.9155" fill="none" strokeWidth="4" strokeDasharray={`${share} ${100-share}`} strokeDashoffset={25-offset}/>
  })}</svg>}<p className={dashboardCss.note}>{t('business.typed.pie')}</p></>}
 </section>
}

/** 类型化结果只在正式清单具备固定记录身份时打开原记录；统计维度与候选预览不冒充记录。 */
/** 统计页把「— 与 0」口径和多数组件共用的存档覆盖说一次；无法核验的结果不计入。 */
export function typedViewSharedCoverage(widgets:readonly BusinessWidgetDefinition[],results:readonly unknown[],viewRefs:readonly BusinessConfigurationViewRefVersioned[]|undefined):TypedViewSharedCoverage{
 const groups=new Map<string,Map<string,{objectType:BusinessConfigurationViewRefVersioned['objectType'];coverage:Coverage;count:number}>>()
 for(const result of results){
  if(!result||typeof result!=='object'||!('format'in result))continue
  const widget=widgets.find(entry=>entry.id===(result as {widgetId?:unknown}).widgetId),selected=widget&&checkedView(widget,result,viewRefs)
  if(!selected)continue
  const type=selected.view.objectType,key=coverageKey(selected.view.coverage),group=groups.get(type)??new Map(),entry=group.get(key)
  if(entry)entry.count++;else group.set(key,{objectType:selected.ref.objectType,coverage:selected.view.coverage,count:1})
  groups.set(type,group)
 }
 return new Map([...groups].map(([type,group])=>{
  const {objectType,coverage}=[...group.values()].reduce((best,item)=>item.count>best.count?item:best)
  return [type,{objectType,coverage}]
 }))
}

export function BusinessTypedViewNotes({shared}:{shared:TypedViewSharedCoverage}){
 const format=useI18n(),{t,locale}=format
 if(!shared.size)return null
 return <p className={dashboardCss.meta} data-typed-page-notes><span data-typed-null>{t('business.typed.null')}</span>{[...shared.values()].map(({objectType,coverage})=><span key={objectType.id} data-typed-coverage>{shared.size>1?t('business.typed.coverageFor',{type:localizedBusinessObjectType(objectType,locale).title,coverage:coverageText(coverage,format)}):coverageText(coverage,format)}</span>)}</p>
}

/** sharedCoverage 由统计页提供：通用口径不再逐卡重复，只有与页面口径不同的覆盖范围才在卡内说明。 */
export function BusinessTypedViewWidget({widget,result,viewRefs,openRecord,sharedCoverage}:{widget:BusinessWidgetDefinition;result:BusinessViewWidgetResultV2|undefined;viewRefs:readonly BusinessConfigurationViewRefVersioned[]|undefined;openRecord?:((reference:BusinessObjectReference)=>void)|undefined;sharedCoverage?:TypedViewSharedCoverage|undefined}){
 const format=useI18n(),{t,locale,list}=format,title=localizedBusinessViewTitle(widget,locale)
 const selected=checkedView(widget,result,viewRefs)
 if(!selected)return <><h3>{title}</h3><p className={dashboardCss.failed} role="alert" data-widget-failed={widget.id}>{t('business.dashboards.error.corrupt')}</p></>
 const {ref}=selected
 const view={...selected.view,title:localizedBusinessViewTitle(selected.view,locale),measures:selected.view.measures.map(measure=>({...measure,label:localizedBusinessMeasureLabel(measure,locale)})),rows:selected.view.rows.map(row=>({...row,label:dimensionText(row,ref,format)}))}
 const missing=view.missingFields.map(name=>{const field=ref.objectType.fields.find(candidate=>candidate.name===name);return field?localizedBusinessFieldLabel(field,locale):name})
 const currencies=[...new Set(view.measures.flatMap(measure=>measure.currency?[measure.currency]:[]))]
 const dimension=ref.objectType.fields.find(field=>field.name===ref.view.dimension?.field)
 const firstColumn=view.kind!=='list'&&dimension?localizedBusinessFieldLabel(dimension,locale):localizedBusinessObjectType(ref.objectType,locale).title
 const shared=sharedCoverage?.get(view.objectType),ownCoverage=!shared||coverageKey(shared.coverage)!==coverageKey(view.coverage)
 return <><h3>{title}</h3><div className={css.body} data-typed-view={view.chart}>
  {view.dimensionMode==='membership'&&<p className={dashboardCss.note} data-typed-membership>{t('business.typed.membership')}</p>}
  {currencies.length>1&&<p className={dashboardCss.note} data-typed-currencies>{t('business.typed.currencies',{currencies:list(currencies)})}</p>}
  {view.chart==='number'?<div className={css.metric}><strong>{valueText(view.rows[0]?.values[0]??null,view.measures[0]!,format)}</strong><span>{view.measures[0]!.label}</span></div>:<>
   {view.chart!=='table'&&view.measures.map((measure,index)=><Plot key={measure.id} view={view} measure={measure} index={index}/>)}
   <ExactTable view={view} firstColumn={firstColumn} format={format} openRecord={openRecord}/>
  </>}
  {!view.rows.length&&<p className={dashboardCss.note}>{t('business.ledger.empty.objects')}</p>}
  {!sharedCoverage&&<p className={dashboardCss.note} data-typed-null>{t('business.typed.null')}</p>}
  {view.measures.some(measure=>measure.rounding)&&<p className={dashboardCss.note} data-typed-rounding>{t('business.typed.rounding',{measures:list(view.measures.filter(measure=>measure.rounding).map(measure=>measure.label))})}</p>}
  {ownCoverage&&<p className={dashboardCss.note} data-typed-coverage>{coverageText(view.coverage,format)}</p>}
  {missing.length>0&&<p className={dashboardCss.note} data-view-missing>{t('business.typed.missing',{fields:list(missing)})}</p>}
  {view.coverage.truncated&&<p className={dashboardCss.note} data-view-truncated>{t('business.ledger.truncated')}</p>}
  {view.dimensionValues>view.rows.length&&<p className={dashboardCss.note} data-rows-truncated>{t('business.ledger.rowsShown',{total:view.dimensionValues,count:view.rows.length})}</p>}
 </div></>
}

import {useEffect,useRef,useState,type ReactNode} from 'react'
import {ArrowDown,ArrowUp,Minus} from 'lucide-react'
import {validateWidgetResultShape,type BusinessConfigurationViewRef,type BusinessLedger,type BusinessWidgetCell,type BusinessWidgetDefinition,type BusinessWidgetResult} from '@teloa/contract'
import {ViewBars,ViewBoardCard,ViewPie,ViewTable,ViewTrend} from './BusinessLedger.js'
import {durationText,localizedBusinessView,localizedBusinessViewTitle} from './business-definition-localization.js'
import {boardColumns,columnIndex,drilldownTarget,metricTone,numberCell,pipelineStages,viewRefPresentation,widgetCells,widgetFailure,widgetRow} from './business-widget-presentation.js'
import type {BusinessTarget} from './business-preview.js'
import {businessChartTheme,renderChart} from './business-chart-renderer.js'
import {useI18n} from './i18n/provider.js'
import css from './BusinessDashboardPage.module.css'

/**
 * 看板的六种原生组件与一种声明式图表。组件只摆 `business-widget-presentation.ts` 算好的结果；
 * 结果里的每个取值都只作为 React 文本子节点渲染，不当标记解释。
 */

type WidgetProps={widget:BusinessWidgetDefinition;result:BusinessWidgetResult}
/** 按行下钻：给一行（列名 → 取值）返回点击处理；这一行不可点（空单元格、取值不合规）时返回 undefined。 */
type RowDrill=(row:Readonly<Record<string,BusinessWidgetCell>>)=>(()=>void)|undefined
type DrillProps={drill?:RowDrill|undefined}

/** 可点的一格：有处理就是按钮（朗读「查看 X」），没有就原样是文本。 */
function DrillCell({open,value,children}:{open:(()=>void)|undefined;value:string;children:ReactNode}){
 const {t}=useI18n()
 return open?<button type="button" className={css.drill} data-drilldown-row aria-label={t('business.dashboards.drilldown.row',{value})} onClick={open}>{children}</button>:<>{children}</>
}

function useCellFormat(){
 const {t,number,dateTime}=useI18n()
 return {yes:t('business.dashboards.boolean.true'),no:t('business.dashboards.boolean.false'),number:(value:number)=>number(value),dateTime:(value:Date)=>dateTime(value,{dateStyle:'medium',timeStyle:'short'})}
}

export function MetricWidget({widget,result}:WidgetProps){
 const {t,number}=useI18n()
 const metric=widget.metric!,row=result.rows[0]
 const value=row?numberCell(row[columnIndex(result,metric.valueColumn)]):null
 const previous=row&&metric.previousColumn!==undefined?numberCell(row[columnIndex(result,metric.previousColumn)]):null
 const tone=metricTone(value,(widget.thresholds??[]).filter(item=>item.field===metric.valueColumn))
 const Trend=value===null||previous===null?undefined:value>previous?ArrowUp:value<previous?ArrowDown:Minus
 return <div className={css.metric} data-tone={tone}>
  <strong>{value===null?'—':number(value)}{metric.unit&&<small>{metric.unit}</small>}</strong>
  {previous!==null&&<span className={css.trend}>{Trend&&<Trend size={13} aria-hidden/>}{t('business.dashboards.metric.previous',{value:number(previous)})}</span>}
 </div>
}

/** 表格：有按行下钻时首列是按钮。 */
export function TableWidget({widget,result,drill}:WidgetProps&DrillProps){
 const {t}=useI18n(),format=useCellFormat()
 const columns=widget.table?.columns??result.columns.map(column=>column.name)
 if(!result.rows.length)return <p className={css.note}>{t('business.ledger.empty.objects')}</p>
 return <table className={css.table}>
  <thead><tr>{columns.map(name=><th scope="col" key={name}>{name}</th>)}</tr></thead>
  <tbody>{widgetCells(result,format,columns).map((row,index)=>{
   const open=drill?.(widgetRow(result,result.rows[index]!))
   return <tr key={index}>{row.map((cell,position)=><td key={columns[position]}>{position===0?<DrillCell open={open} value={cell}>{cell}</DrillCell>:cell}</td>)}</tr>
  })}</tbody>
 </table>
}

/** 清单：第一列作标题（有按行下钻时是按钮），其余列作一行小字；没有声明列时按结果列顺序。 */
export function ListWidget({widget,result,drill}:WidgetProps&DrillProps){
 const {t}=useI18n(),format=useCellFormat()
 const columns=widget.table?.columns??result.columns.map(column=>column.name)
 if(!result.rows.length)return <p className={css.note}>{t('business.ledger.empty.objects')}</p>
 return <ul className={css.list}>{widgetCells(result,format,columns).map((row,index)=><li key={index}><span><DrillCell open={drill?.(widgetRow(result,result.rows[index]!))} value={row[0]!}>{row[0]}</DrillCell></span>{row.length>1&&<small>{row.slice(1).join(' · ')}</small>}</li>)}</ul>
}

export function BoardWidget({widget,result,drill}:WidgetProps&DrillProps){
 const {t}=useI18n()
 const board=widget.board!,at=(name:string)=>columnIndex(result,name)
 const cards=result.rows.map(row=>({id:String(row[at(board.idColumn)]??''),title:String(row[at(board.titleColumn)]??''),status:String(row[at(board.statusColumn)]??''),row}))
 return <div className={css.board}>{boardColumns(cards,board.statuses).map(column=><section key={column.status===null?'other':'status:'+column.status} aria-label={column.status??t('business.dashboards.board.other')}>
  <h4><span>{column.status??t('business.dashboards.board.other')}</span><span>{column.cards.length}</span></h4>
  {column.cards.map((card,index)=><article key={card.id+':'+index}><DrillCell open={drill?.(widgetRow(result,card.row))} value={card.title||card.id}>{card.title||card.id}</DrillCell></article>)}
 </section>)}</div>
}

/** 流水线：按行下钻时阶段名是按钮，点的是阶段本身（契约要求 match.column 即 stageColumn），数量为 0 的阶段同样可点。 */
export function PipelineWidget({widget,result,drill}:WidgetProps&DrillProps){
 const {t,number}=useI18n()
 const pipeline=widget.pipeline!,at=(name:string)=>columnIndex(result,name)
 const rows=result.rows.map(row=>({stage:String(row[at(pipeline.stageColumn)]??''),count:numberCell(row[at(pipeline.countColumn)])??0,duration:pipeline.durationColumn===undefined?null:numberCell(row[at(pipeline.durationColumn)])}))
 const stages=pipelineStages(rows,pipeline.stages),max=Math.max(1,...stages.map(stage=>stage.count))
 return <ol className={css.pipeline}>{stages.map(stage=><li key={stage.stage}>
  <span><DrillCell open={drill?.({[pipeline.stageColumn]:stage.stage})} value={stage.stage}>{stage.stage}</DrillCell></span>
  <span className={css.bar} aria-hidden><i style={{width:Math.max(0,stage.count/max*100)+'%'}}/></span>
  <span>{number(stage.count)}{stage.duration!==null&&<> <small>{t('business.dashboards.pipeline.duration',{value:durationText(stage.duration,number)})}</small></>}</span>
 </li>)}</ol>
}

/** 视图引用：画法与标签优先取配置页面元数据，旧台账调用继续取同一视图；布尔维度写成是/否。 */
export function ViewRefWidget({widget,result,ledger,viewRefs}:WidgetProps&{ledger?:BusinessLedger|undefined;viewRefs?:readonly BusinessConfigurationViewRef[]|undefined}){
 const {t,locale}=useI18n()
 const title=localizedBusinessViewTitle(widget,locale)
 const selected=viewRefPresentation(widget,result,title,{ledger,viewRefs})
 if(!selected)return <p className={css.note} role="alert">{t('business.dashboards.error.corrupt')}</p>
 // 视图算出零行时照台账口径说一句，不画一张空图。
 if(!result.rows.length)return <p className={css.note}>{t('business.ledger.empty.objects')}</p>
 const view=selected.objectType?localizedBusinessView(selected.view,selected.objectType,locale,{yes:t('business.dashboards.boolean.true'),no:t('business.dashboards.boolean.false')}):selected.view
 const shown={...view,title}
 return view.chart==='number'?<ViewBoardCard view={shown}/>:view.chart==='pie'?<ViewPie view={shown}/>:view.chart==='line'?<ViewTrend view={shown}/>:view.chart==='bar'?<ViewBars view={shown}/>:<ViewTable view={shown}/>
}

/**
 * 声明式图表：渲染器先过契约白名单，图表库按需从同包分块取回（首屏不带）；
 * 主题令牌在每次画之前从容器读，`colorScheme` 或界面语言一变就整张重画（时间轴格式随语言）。
 * 点击下钻的处理放在引用里：上层每次重渲染都会换一个处理函数，不能因此整张重画，只在「能不能点」变化时重画。
 */
export function ChartWidget({widget,result,colorScheme,onDatum}:WidgetProps&{colorScheme:'light'|'dark';onDatum?:((datum:Record<string,unknown>)=>void)|undefined}){
 const {t,locale}=useI18n()
 const host=useRef<HTMLDivElement>(null),[failed,setFailed]=useState(false)
 const latest=useRef(onDatum)
 latest.current=onDatum
 const clickable=onDatum!==undefined
 const label=t('business.dashboards.chart.aria',{title:localizedBusinessViewTitle(widget,locale)})
 useEffect(()=>{
  const el=host.current
  if(!el)return
  let dispose:(()=>void)|undefined,cancelled=false
  setFailed(false)
  void renderChart(el,widget.chart,result.columns,result.rows,businessChartTheme(el),label,{locale,...(clickable?{onDatum:(datum:Record<string,unknown>)=>latest.current?.(datum)}:{})}).then(
   release=>{if(cancelled)release();else dispose=release},
   ()=>{if(!cancelled)setFailed(true)},
  )
  return ()=>{cancelled=true;dispose?.();el.replaceChildren()}
 },[widget.chart,result,colorScheme,label,locale,clickable])
 return <>{failed&&<p className={css.failed} role="status">{t('business.dashboards.widget.failed')}</p>}<div ref={host} className={css.chart} data-widget-chart={widget.id}/></>
}

/**
 * 一张组件卡：标题、失败原因（固定词条）、声明已更新的提示，以及按种类选中的画法；看板有时间范围而本组件没接入时，标题下注明不随范围变化。
 * 给了 `go`（看板页）且组件声明了下钻：标题行出「查看对象」（未过滤清单，也是图表的键盘入口）；声明了 `idColumn`/`match` 时行、卡片、阶段、图形可点。
 * 预览里不给 `go`，一个按钮都不出。
 */
export function BusinessWidget({widget,result,ledger,viewRefs,colorScheme,ranged=false,go}:{widget:BusinessWidgetDefinition;result:BusinessWidgetResult|undefined;ledger?:BusinessLedger|undefined;viewRefs?:readonly BusinessConfigurationViewRef[]|undefined;colorScheme:'light'|'dark';ranged?:boolean;go?:((target:BusinessTarget)=>void)|undefined}){
 const {t,locale}=useI18n()
 // 成功的结果渲染前再核一次形状（与服务端落库前同一判据），不合格按失败显示，不拿缺列的结果去画。
 const shape=result?.status==='ok'?validateWidgetResultShape(widget,result):null
 const failure=result?.status==='failed'?widgetFailure(result.error):shape!==null?widgetFailure({code:'teloa/invalid-input',reason:shape}):result?undefined:{key:'business.dashboards.error.notComputed' as const}
 const props=result&&!failure?{widget,result}:undefined
 const drilldown=go?widget.drilldown:undefined
 // 组件的 domain 就是它所在的业务范围（看板页回包读取器已核对）。
 const drill:RowDrill|undefined=drilldown&&(drilldown.idColumn!==undefined||drilldown.match)?row=>{const target=drilldownTarget(widget.domain,widget,row);return target?()=>go!(target):undefined}:undefined
 const onDatum=drill?(datum:Record<string,unknown>)=>drill(datum as Record<string,BusinessWidgetCell>)?.():undefined
 const title=<h3>{localizedBusinessViewTitle(widget,locale)}</h3>
 return <>
  {drilldown?<div className={css.widgetTitle}>{title}<button type="button" data-drilldown-open onClick={()=>go!(drilldownTarget(widget.domain,widget,undefined)!)}>{t('business.dashboards.drilldown.open')}</button></div>:title}
  {ranged&&widget.timeFilter===undefined&&<p className={css.note} data-range-unbound={widget.id}>{t('business.dashboards.range.unbound')}</p>}
  <div className={css.widgetBody}>
   {failure&&<p className={css.failed} role="status" data-widget-failed={widget.id}>{t(failure.key,failure.params)}</p>}
   {props&&(widget.kind==='metric'?<MetricWidget {...props}/>
    :widget.kind==='table'?<TableWidget {...props} drill={drill}/>
    :widget.kind==='list'?<ListWidget {...props} drill={drill}/>
    :widget.kind==='board'?<BoardWidget {...props} drill={drill}/>
    :widget.kind==='pipeline'?<PipelineWidget {...props} drill={drill}/>
    :widget.kind==='view-ref'?<ViewRefWidget {...props} ledger={ledger} viewRefs={viewRefs}/>
    :<ChartWidget {...props} colorScheme={colorScheme} onDatum={onDatum}/>)}
  </div>
  {result?.stale&&<p className={css.note}>{t('business.dashboards.stale')}</p>}
 </>
}

import {useEffect,useState,type ReactNode} from 'react'
import {ArrowUpRight} from 'lucide-react'
import type {BusinessActionRecord,BusinessLedger,BusinessLedgerBlock,BusinessLedgerObject,BusinessObjectTypeDefinition,BusinessViewCoverage,BusinessViewResult} from '@teloa/contract'
import {businessLedgerBlockUpdated,businessLedgerCacheKeys,businessLedgerFailureKey,ledgerListTruncation,type BusinessLedgerApi} from './business-ledger-api.js'
import {durationText,localizedBusinessActionTitle,localizedBusinessFieldLabel,localizedBusinessFieldValue,localizedBusinessObjectType,localizedBusinessView} from './business-definition-localization.js'
import {blockLocalCustomized} from './business-customization-presentation.js'
import type {BusinessTarget} from './business-preview.js'
import {useI18n} from './i18n/provider.js'
import base from './TaskPage.module.css'
import css from './BusinessLedger.module.css'

/**
 * 业务定制层的五个固定组件（规格 §5.1）。声明里的每一段文字都只作为 React 文本子节点渲染，
 * 组件里没有一处行业名、没有一个声明标识写死——换一个 `domain` 的声明，这套组件零改动。
 * 该画哪一种图由回包里的 `kind`/`chart` 决定（契约 `BusinessViewResult`），界面不从行的形状反推。
 */

type Measure=BusinessViewResult['measures'][number]
type Format={number:(value:number,options?:Intl.NumberFormatOptions)=>string;dateTime:(value:Date)=>string}

/** 度量取值怎么读：`datetime` 度量的 min/max 回的是毫秒时刻，按回包给的绑定字段类型还原成时间；`duration` 度量是秒数，写成时长。 */
function measureText(value:number|null,measure:Measure,format:Format):string{
 if(value===null)return '—'
 if(measure.fieldType==='duration')return durationText(value,format.number)
 return measure.fieldType==='datetime'?format.dateTime(new Date(value)):format.number(value)
}

/** 缺失只给字段名，界面换成该字段的声明标签；声明里没有的名字原样写出来，不吞掉。 */
function MissingFields({fields,definition}:{fields:readonly string[];definition:BusinessObjectTypeDefinition}){
 const {t,locale,list}=useI18n()
 const labels=fields.map(name=>{const field=definition.fields.find(candidate=>candidate.name===name);return field?localizedBusinessFieldLabel(field,locale):name})
 if(!labels.length)return null
 return <p className={css.note} data-view-missing>{t('business.ledger.missingFields',{fields:list(labels)})}</p>
}

/** 只有真被截断了才说：`dimensionValues` 是截断前的组数，等于画出来的行数时一个字都不该多说（复审 MEDIUM-1）。 */
function RowsShown({view}:{view:BusinessViewResult}){
 const {t}=useI18n()
 if(view.dimensionValues<=view.rows.length)return null
 return <p className={css.note} data-rows-truncated>{t('business.ledger.rowsShown',{total:view.dimensionValues,count:view.rows.length})}</p>
}

function Legend({items}:{items:ReadonlyArray<{key:string;label:string}>}){
 if(items.length<2)return null
 return <ul className={css.legend}>{items.map((item,index)=><li key={item.key}><span className={css.swatch} data-series={index%4}/>{item.label}</li>)}</ul>
}

/** 维度取值与各项度量的对照表：条形、饼、折线三种画法共用它当读数区，表格视图则只有它。 */
function ValueRows({view}:{view:BusinessViewResult}){
 const {number,dateTime,date}=useI18n()
 return <dl className={css.chartRows}>{view.rows.map(row=><div key={row.dimension} className={css.chartRow}>
  <dt>{row.label||(row.dimension?date(new Date(row.dimension)):'')}</dt>
  <dd>{view.measures.map((measure,index)=><span key={measure.id}>{measureText(row.values[index]??null,measure,{number,dateTime})}</span>)}</dd>
 </div>)}</dl>
}

export function ViewBoardCard({view}:{view:BusinessViewResult}){
 const {number,dateTime}=useI18n()
 const measure=view.measures[0]!,row=view.rows[0]
 return <div className={css.boardCard} data-view-board-card={view.viewId}>
  <strong>{row?measureText(row.values[0]??null,measure,{number,dateTime}):'—'}</strong>
  <span>{view.title}</span>
  <small>{measure.label}</small>
 </div>
}

/**
 * 条形：纯 SVG，引一个图表库就是引一条新的外部依赖与一条新的注入面。
 * 基线取零而不是最小值——有负数时条从零往左长，正负两侧各自按同一把尺子；
 * 全是非负数时基线仍在左边缘，与原来的画法逐像素一致。
 */
export function ViewBars({view}:{view:BusinessViewResult}){
 const rows=view.rows,measures=view.measures
 const band=measures.length*11+14,height=Math.max(rows.length*band,band)
 const numbers=rows.flatMap(row=>row.values.map(value=>value??0))
 const high=Math.max(...numbers,0),low=Math.min(...numbers,0),span=high-low||1
 const at=(value:number)=>(value-low)/span*100
 const zero=at(0)
 return <div className={css.chart} data-view-distribution={view.viewId}>
  <Legend items={measures.map(measure=>({key:measure.id,label:measure.label}))}/>
  <svg viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" role="presentation" className={css.bars} style={{height:height+'px'}}>
   {rows.map((row,rowIndex)=>measures.map((measure,index)=>{
    const end=at(row.values[index]??0)
    return <rect key={row.dimension+measure.id} data-series={index%4} x={Math.min(zero,end)} y={rowIndex*band+index*11+3} width={Math.max(Math.abs(end-zero),0.4)} height="9"/>
   }))}
  </svg>
  <ValueRows view={view}/>
  <RowsShown view={view}/>
 </div>
}

/**
 * 饼：用圆环的 dasharray 切片，不做弧线数学。半径取 15.9155 让周长恰好是 100，
 * 一个切片的长度就是它的百分比。负数与空值不参与切分——一块负的扇形没有意义，
 * 它仍在下面的读数区里如实写出来。
 */
export function ViewPie({view}:{view:BusinessViewResult}){
 const measure=view.measures[0]!
 const slices=view.rows.map(row=>Math.max(row.values[0]??0,0))
 const total=slices.reduce((sum,value)=>sum+value,0)
 let start=0
 return <div className={css.chart} data-view-pie={view.viewId}>
  <Legend items={view.rows.map(row=>({key:row.dimension,label:row.label||row.dimension}))}/>
  {total>0&&<svg viewBox="0 0 36 36" role="presentation" className={css.pie}>
   {slices.map((value,index)=>{
    const share=value/total*100,offset=start;start+=share
    return <circle key={view.rows[index]!.dimension} data-series={index%4} cx="18" cy="18" r="15.9155" fill="none" strokeWidth="4" strokeDasharray={`${share.toFixed(2)} ${(100-share).toFixed(2)}`} strokeDashoffset={(25-offset).toFixed(2)}/>
   })}
  </svg>}
  {/* 饼只切第一项度量：图例给的是维度取值，这一行把切的是哪项度量写清楚。 */}
  <p className={css.note}>{measure.label}</p>
  <ValueRows view={view}/>
  <RowsShown view={view}/>
 </div>
}

/**
 * 折线：读不出取值的点**断线**而不是把两端连起来——连起来等于凭空补了一段没有发生过的走势。
 * 每项度量因此可能画出多条折线，一段连续的非空点一条。
 */
export function ViewTrend({view}:{view:BusinessViewResult}){
 const rows=view.rows,measures=view.measures
 const numbers=rows.flatMap(row=>row.values.filter((value):value is number=>value!==null))
 const high=Math.max(...numbers,0),low=Math.min(...numbers,0),span=high-low||1
 const step=rows.length>1?100/(rows.length-1):0
 const segments=(index:number):string[]=>{
  const lines:string[][]=[];let current:string[]=[]
  rows.forEach((row,position)=>{
   const value=row.values[index]
   if(value===null||value===undefined){if(current.length)lines.push(current);current=[];return}
   current.push(`${(position*step).toFixed(2)},${(39-((value-low)/span)*38).toFixed(2)}`)
  })
  if(current.length)lines.push(current)
  // 单点段也画出来：一个孤立的取值不能因为画不成线就从图上消失。
  return lines.map(points=>points.length===1?points[0]+' '+points[0]:points.join(' '))
 }
 return <div className={css.chart} data-view-trend={view.viewId}>
  <Legend items={measures.map(measure=>({key:measure.id,label:measure.label}))}/>
  <svg viewBox="0 0 100 40" preserveAspectRatio="none" role="presentation" className={css.lines}>
   {measures.map((measure,index)=>segments(index).map((points,part)=><polyline key={measure.id+':'+part} data-series={index%4} fill="none" points={points}/>))}
  </svg>
  <ValueRows view={view}/>
  <RowsShown view={view}/>
 </div>
}

/** 表格：维度一列、每项度量各一列，复用清单那张表的样式，不另造一套。 */
export function ViewTable({view}:{view:BusinessViewResult}){
 const {t,number,dateTime,date}=useI18n()
 return <div className={css.listView} data-view-table={view.viewId}>
  <div className={css.tableWrap}><table className={css.table}>
   <thead><tr>
    <th scope="col">{view.title}</th>
    {view.measures.map(measure=><th scope="col" key={measure.id}>{measure.label}</th>)}
   </tr></thead>
   <tbody>{view.rows.map(row=><tr key={row.dimension}>
    <td>{row.label||(row.dimension?date(new Date(row.dimension)):'')}</td>
    {view.measures.map((measure,index)=><td key={measure.id}>{measureText(row.values[index]??null,measure,{number,dateTime})}</td>)}
   </tr>)}</tbody>
  </table></div>
  {!view.rows.length&&<p className={css.note}>{t('business.ledger.empty.objects')}</p>}
  <RowsShown view={view}/>
 </div>
}

export function ViewList({view,definition,sourceLabel,select,selected}:{view:BusinessViewResult;definition:BusinessObjectTypeDefinition;sourceLabel:string;select:(object:BusinessLedgerObject)=>void;selected?:string|undefined}){
 const {t,number,dateTime,locale}=useI18n()
 const localizedView=localizedBusinessView(view,definition,locale),objects=localizedView.objects??[],measure=localizedView.measures[0]!
 const stageField=definition.progress?definition.fields.find(field=>field.name===definition.progress!.stageField&&field.type==='enum'):undefined
 const stageValue=(object:BusinessLedgerObject)=>{const value=stageField?object.fields.find(field=>field.label===stageField.from)?.value:undefined;return value===undefined?'—':localizedBusinessFieldValue(stageField!,value,locale)}
 return <div className={css.listView} data-view-list={localizedView.viewId}>
  <div className={css.tableWrap}><table className={css.table}>
   <thead><tr><th scope="col">{t('business.ledger.column.object')}</th>{stageField&&<th scope="col">{localizedBusinessFieldLabel(stageField,locale)}</th>}<th scope="col">{t('business.ledger.column.sourceAndTime')}</th><th scope="col">{t('business.ledger.column.completeness')}</th><th scope="col">{measure.label}</th></tr></thead>
   <tbody>{objects.map((object,index)=><tr key={object.id}>
    <td><button type="button" aria-pressed={selected===object.id} onClick={()=>select(object)}>{object.title}</button><small>{object.id}</small></td>
    {stageField&&<td>{stageValue(object)}</td>}
    <td><span title={object.source}>{sourceLabel}</span><small>{dateTime(new Date(object.observedAt))}</small></td>
    <td>{object.quality==='complete'?t('business.data.quality.complete'):t('business.data.quality.incomplete')}</td>
    <td>{measureText(localizedView.rows[index]?.values[0]??null,measure,{number,dateTime})}</td>
   </tr>)}</tbody>
  </table></div>
  <RowsShown view={view}/>
 </div>
}

/** 一张图该用哪个组件画：判据只有回包里的 `chart` 一位，与契约那张 kind×chart 允许组合表一一对应。 */
function ViewChart({view,definition}:{view:BusinessViewResult;definition:BusinessObjectTypeDefinition}){
 const {t,locale}=useI18n()
 const localizedView=localizedBusinessView(view,definition,locale,{yes:t('business.dashboards.boolean.true'),no:t('business.dashboards.boolean.false')})
 return <>
  {localizedView.chart==='number'?<ViewBoardCard view={localizedView}/>
   :localizedView.chart==='pie'?<ViewPie view={localizedView}/>
   :localizedView.chart==='line'?<ViewTrend view={localizedView}/>
   :localizedView.chart==='bar'?<ViewBars view={localizedView}/>
   :<ViewTable view={localizedView}/>}
  <MissingFields fields={view.missingFields} definition={definition}/>
 </>
}

function Coverage({coverage,connected}:{coverage:BusinessViewCoverage;connected:boolean}){
 const {t,dateTime}=useI18n()
 const {objects,latestReceivedAt,truncated}=coverage
 return <>
  <p className={css.coverage}>{connected
   ? latestReceivedAt===null?t('business.ledger.coverage.never',{count:objects}):t('business.ledger.coverage',{count:objects,at:dateTime(new Date(latestReceivedAt))})
   : latestReceivedAt===null?t('business.ledger.coverage.snapshotNever',{count:objects}):t('business.ledger.coverage.snapshot',{count:objects,at:dateTime(new Date(latestReceivedAt))})}</p>
  {truncated&&<p className={css.note} data-view-truncated>{t('business.ledger.truncated')}</p>}
 </>
}

/** 默认动作：入口条件由服务端给出；执行工具仍只会创建进入人工审批链的任务。 */
function DefaultAction({block,actions,open}:{block:BusinessLedgerBlock;actions:readonly BusinessActionRecord[];open:()=>void}){
 const {t,locale}=useI18n()
 const action=block.defaultAction
 if(!action||!action.available)return null
 const declaration=actions.find(row=>row.definition.id===action.actionId)
 if(!declaration)return null
 const template=declaration.definition.target.kind==='work-template'?declaration.definition.target.localId:declaration.definition.target.workTemplate
 return <button type="button" className={css.defaultAction} data-default-action={action.actionId} title={t('business.ledger.action.explain',{template,count:declaration.definition.inputs.length})} onClick={open}>
  {localizedBusinessActionTitle(declaration.definition,locale)}
 </button>
}

export function ObjectTypeBlock({block,actions,open,connect,updated=false,localCustomized=false}:{block:BusinessLedgerBlock;actions:readonly BusinessActionRecord[];open:(objectType:string)=>void;connect:(sourceId:string)=>void;updated?:boolean;localCustomized?:boolean}){
 const {t,number,dateTime,locale}=useI18n()
 const definition=block.objectType.definition
 const copy=localizedBusinessObjectType(definition,locale)
 const sourceName=block.source.sourceNoun??t('business.source.noun')
 const progress=block.progress
 const coverageSummary=!block.source.connected
  ? block.coverage.latestReceivedAt===null?t('business.ledger.coverage.snapshotNever',{count:number(block.coverage.objects)}):t('business.ledger.coverage.snapshot',{count:number(block.coverage.objects),at:dateTime(new Date(block.coverage.latestReceivedAt))})
  : block.coverage.latestReceivedAt===null?t('business.ledger.coverage.never',{count:number(block.coverage.objects)}):t('business.ledger.coverage',{count:number(block.coverage.objects),at:dateTime(new Date(block.coverage.latestReceivedAt))})
 const progressText=progress===undefined?undefined:progress.waitingForYou>0
  ?t('business.ledger.progress.waiting',{unfinished:number(progress.unfinished),waiting:number(progress.waitingForYou)})
  :t('business.ledger.progress.unfinished',{unfinished:number(progress.unfinished)})
 return <article className={css.block} data-object-type-block={definition.id} aria-label={copy.title}>
  <button type="button" className={css.blockOpen} onClick={()=>open(definition.id)}>
   <span className={css.lead}>{copy.lead}</span>
   <span className={css.blockTitle}><strong>{copy.title}</strong><ArrowUpRight size={15}/></span>
   <span className={css.count}>{number(block.objects)}<i>{copy.unit}</i></span>
   {!block.source.connected&&!block.objects
    ? <span className={css.blockSummary} data-block-summary>{t('business.ledger.source.notConnected')}<small title={block.source.sourceId}>{sourceName}</small></span>
    : progress===undefined
      ? <span className={css.blockSummary} data-block-summary>{coverageSummary}{!block.source.connected&&<small title={block.source.sourceId}>{t('business.ledger.source.notConnected')} · {sourceName}</small>}</span>
      : <span className={css.blockSummary} data-block-summary><span data-block-progress>{progressText}</span>{progress.latestChangedAt!==null&&<small data-block-change>{t('business.ledger.change',{at:dateTime(new Date(progress.latestChangedAt))})}</small>}{!block.source.connected&&<small title={block.source.sourceId}>{t('business.ledger.source.notConnected')} · {sourceName}</small>}</span>}
  </button>
  {updated&&<p className={css.note} data-definition-updated>{t('business.ledger.definitionUpdated')}</p>}
  {localCustomized&&<p className={css.note} data-local-customized>{t('business.custom.local.badge')}</p>}
  {/* B3 范围总览只保留对象类型卡；图表和字段缺失说明进对象目录，避免把操作台账做成仪表盘。 */}
  <footer>
   {!block.source.connected&&<button type="button" onClick={()=>connect(block.source.sourceId)}>{t('business.ledger.source.connect')}</button>}
   <DefaultAction block={block} actions={actions} open={()=>open(definition.id)}/>
   <button type="button" onClick={()=>open(definition.id)}>{t('business.ledger.openDirectory')}</button>
  </footer>
 </article>
}

function ObjectSheet({object,definition,sourceLabel}:{object:BusinessLedgerObject;definition:BusinessObjectTypeDefinition;sourceLabel:string}){
 const {t,dateTime,locale}=useI18n()
 const copy=localizedBusinessObjectType(definition,locale)
 // 字段按声明的标签与顺序排，声明里没有的快照字段排在后面一组，原样显示、不丢。
 const declared=definition.fields.map(field=>{const value=object.fields.find(row=>row.label===field.from)?.value??'';return {key:field.name,label:localizedBusinessFieldLabel(field,locale),value:value?localizedBusinessFieldValue(field,value,locale):''}})
 const extra=object.fields.filter(row=>!definition.fields.some(field=>field.from===row.label))
 return <article className={css.sheet} aria-label={t('business.ledger.objectDetail')}>
  <header><span>{copy.title}</span><h3>{object.title}</h3></header>
  <p>{object.summary||t('business.real.noSummary')}</p>
  <dl>
   <dt>{t('business.real.objectIdentity')}</dt><dd>{object.id}</dd>
   <dt>{t('business.connection.source')}</dt><dd title={object.source}>{sourceLabel}</dd>
   <dt>{t('business.real.observedAt')}</dt><dd>{dateTime(new Date(object.observedAt))}</dd>
   <dt>{t('business.real.receivedAt')}</dt><dd>{dateTime(new Date(object.receivedAt))}</dd>
   <dt>{t('business.ledger.column.completeness')}</dt><dd>{object.quality==='complete'?t('business.data.quality.complete'):t('business.real.missingData')}</dd>
   {declared.map(field=><div className={css.fact} key={field.key}><dt>{field.label}</dt><dd>{field.value||t('business.real.notProvided')}</dd></div>)}
   {extra.map(field=><div className={css.fact} key={field.label}><dt>{field.label}</dt><dd>{field.value||t('business.real.notProvided')}</dd></div>)}
  </dl>
  <details><summary>{t('business.real.verifyPinnedDigest')}</summary><code>{object.snapshotHash}</code></details>
 </article>
}

type SurfaceState={status:'loading'}|{status:'failed';reason:ReturnType<typeof businessLedgerFailureKey>}|{status:'ready';ledger:BusinessLedger;updated:ReadonlySet<string>}

/**
 * 缓存挂在组件 useRef 上时，离开业务页再回来必然重挂、清零，于是「声明已更新」在真实流程里等于不存在。
 * 因此按 scope 分桶提到模块级；它只是一次会话内的比对基准，不做持久化。
 */
const ledgerKeys=new Map<string,Map<string,string>>()

type ViewProps={
 ledger:BusinessLedger;objectType?:string|undefined;objectId?:string|undefined;updated?:ReadonlySet<string>|undefined
 /** 组件下钻带来的对象清单筛选：清单已由服务端按它收窄，这里只负责说出来并给「看全部」。 */
 match?:BusinessTarget['match']
 go:(target:BusinessTarget)=>void;connect:(sourceId:string)=>void
 /** 第三个入参给出所属块：能不能对这一类对象发起动作由服务端算好的 `defaultAction.available` 说。 */
 objectActions?:((object:BusinessLedgerObject,objectType:string,block:BusinessLedgerBlock)=>ReactNode)|undefined
 /** 一条声明都没有时的空态：调用方给就用它（业务页给的是「还差一步」接入引导），不给就用台账自己那一句。 */
 empty?:ReactNode|undefined
}

/** 已经读到台账之后的那一层：五档空态与五个组件全在这里，读取与缓存留在外面一层。 */
export function BusinessLedgerView({ledger,objectType,objectId,updated,match,go,connect,objectActions,empty}:ViewProps){
 const {t,locale}=useI18n()
 const scope=ledger.scope as BusinessTarget['scope']
 // 详情只是同一目录的另一层；返回时保留筛选，不把上一个对象类型的筛选带进新类型。
 const [filters,setFilters]=useState<Record<string,{quality:'all'|'complete'|'missing';stage:string|null}>>({})
 const filterKey=JSON.stringify([scope,objectType])
 const {quality,stage}=filters[filterKey]??{quality:'all' as const,stage:null}
 const filter=(patch:Partial<{quality:'all'|'complete'|'missing';stage:string|null}>)=>setFilters(current=>({...current,[filterKey]:{quality,stage,...patch}}))
 if(!ledger.blocks.length)return <>{empty??<div className={base.empty} aria-label={t('business.ledger.title')}><h2>{t('business.ledger.empty.types')}</h2><p>{t('business.ledger.empty.typesHint')}</p></div>}</>
 const block=objectType?ledger.blocks.find(row=>row.objectType.definition.id===objectType):undefined
 if(objectType&&!block)return <div className={base.empty} aria-label={t('business.ledger.title')}><h2>{t('business.ledger.empty.types')}</h2><p>{t('business.ledger.empty.typesHint')}</p></div>
 if(block){
  const definition=block.objectType.definition
  const copy=localizedBusinessObjectType(definition,locale)
  const sourceName=block.source.sourceNoun??t('business.source.noun')
  const list=block.views.find(view=>view.kind==='list')
  const analysisViews=block.views.filter(view=>view.kind!=='list')
  const stageField=definition.progress?definition.fields.find(field=>field.name===definition.progress!.stageField&&field.type==='enum'):undefined
  // 筛选字段按声明取本地化标题与取值；`_id` 是对象编号，没有对应声明字段。
  const matchField=match?definition.fields.find(field=>field.name===match.field):undefined
  // 只认声明中的枚举，声明变更后失效的旧筛选回到全部，不猜字段、不伪造状态。
  const selectedStage=stage!==null&&stageField?.values?.includes(stage)?stage:null
  const rows=(list?.objects??[]).map((object,index)=>({object,row:list!.rows[index]!})).filter(entry=>(quality==='all'||entry.object.quality===quality)&&(selectedStage===null||entry.object.fields.find(field=>field.label===stageField!.from)?.value===selectedStage))
  /**
   * 完整性和状态筛选是界面这一侧的事，与服务端的行数截断是两回事（复审 N-2）。
   * 传给 `ViewList` 的 `dimensionValues` 永远压成当前行数——它内置的那句提示只会拿
   * `view.rows.length` 当分母，筛选一开就配不上服务端的截断分母，因此由下面两句接管：
   * 服务端截断看 `ledgerListTruncation` 算出的 `serverTruncated`（不受筛选影响）；
   * 筛选造成的差额是 `filtered`，只在真被筛掉了东西时才出现，两句各说各的、互不冒充。
   */
  const truncation=list?ledgerListTruncation(list,rows.length):undefined
  const view=list?{...list,rows:rows.map(entry=>entry.row),objects:rows.map(entry=>entry.object),dimensionValues:rows.length}:undefined
  // 直达链接按未过滤的对象集合解析，不能被此前保存的目录筛选遮住。
  const current=list?.objects?.find(object=>object.id===objectId)
  // 已经固定进台账的对象不因实时来源暂时未连接而消失；连接状态只影响继续同步与执行动作。
  if(objectId&&(block.source.connected||block.objects>0))return <section className={css.surface} aria-label={t('business.ledger.objectDetail')}>
   <header className={css.directoryHeader}>
    <button type="button" onClick={()=>go({scope,section:'data',objectType:definition.id})}>{t('business.ledger.backDirectory',{type:copy.title})}</button>
    <button type="button" onClick={()=>go({scope,section:'data'})}>{t('business.ledger.back')}</button>
   </header>
   {current?<><ObjectSheet object={current} definition={definition} sourceLabel={sourceName}/>{objectActions?.(current,definition.id,block)}</>:<p role="status" className={base.empty}>{t('error.notFound')}</p>}
  </section>
  return <section className={css.surface} aria-label={copy.title}>
   <header className={css.directoryHeader}>
    <div><span className={css.lead}>{copy.lead}</span><h2>{copy.title}</h2></div>
    <button type="button" onClick={()=>go({scope,section:'data'})}>{t('business.ledger.back')}</button>
   </header>
   {match&&<div className={css.sourceNotice} role="note" data-ledger-match><span>{t('business.ledger.match',{field:matchField?localizedBusinessFieldLabel(matchField,locale):match.field==='_id'?t('business.object.id'):match.field,value:matchField?localizedBusinessFieldValue(matchField,match.value,locale):match.value})}</span><button type="button" onClick={()=>go({scope,section:'data',objectType:definition.id})}>{t('business.ledger.matchClear')}</button></div>}
   {!block.source.connected&&!block.objects
    ? <div className={base.empty} data-source-disconnected><h3>{t('business.ledger.source.notConnected')}</h3><p title={block.source.sourceId}>{sourceName}</p><div className={base.buttons}><button type="button" onClick={()=>connect(block.source.sourceId)}>{t('business.ledger.source.connect')}</button></div></div>
     : !block.objects
     ? <div className={base.empty} data-objects-empty><h3>{t('business.ledger.empty.objects')}</h3></div>
     : <>
       {!block.source.connected&&<div className={css.sourceNotice} data-source-disconnected><span title={block.source.sourceId}>{t('business.ledger.source.notConnected')} · {sourceName}</span><button type="button" onClick={()=>connect(block.source.sourceId)}>{t('business.ledger.source.connect')}</button></div>}
       <Coverage coverage={block.coverage} connected={block.source.connected}/>
       {view
        ? <>{stageField?.values&&<div className={css.stageFilters} role="group" aria-label={t('business.directory.stage.aria')}>
          <button type="button" aria-pressed={selectedStage===null} onClick={()=>filter({stage:null})}>{t('business.directory.stage.all')}</button>
          {stageField.values.map(value=><button key={value} type="button" aria-pressed={selectedStage===value} onClick={()=>filter({stage:value})}>{localizedBusinessFieldValue(stageField,value,locale)}</button>)}
         </div>}<div className={css.filters}><label>{t('business.data.quality.label')}<select aria-label={t('business.data.quality.label')} value={quality} onChange={event=>filter({quality:event.target.value as 'all'|'complete'|'missing'})}>
          <option value="all">{t('business.data.quality.all')}</option>
          <option value="complete">{t('business.data.quality.complete')}</option>
          <option value="missing">{t('business.data.quality.missing')}</option>
         </select></label></div>
         <ViewList view={view} definition={definition} sourceLabel={sourceName} select={object=>go({scope,section:'data',objectType:definition.id,id:object.id})}/>
         {truncation?.serverTruncated&&<p className={css.note} data-rows-truncated>{t('business.ledger.rowsShown',{total:list!.dimensionValues,count:list!.rows.length})}</p>}
         {truncation?.filtered&&<p className={css.note} data-rows-filtered>{t('business.ledger.filteredShown',{total:list!.rows.length,count:rows.length})}</p>}
         <MissingFields fields={view.missingFields} definition={definition}/>
        </>
        : <MissingFields fields={block.missingFields} definition={definition}/>}
       {analysisViews.length>0&&<details className={css.analysisViews}>
        <summary>{t('business.section.analysis')}</summary>
        <div>{analysisViews.map(view=><section key={view.viewId} className={css.view}><ViewChart view={view} definition={definition}/></section>)}</div>
       </details>}
      </>}
  </section>
 }
 const snapshotOnly=ledger.blocks.some(row=>!row.source.connected&&row.objects>0)
 return <section className={css.surface} aria-label={t('business.ledger.title')}>
  <p className={css.note}>{t('business.ledger.note')}</p>
  {snapshotOnly&&<div className={css.sourceNotice} role="note" data-fixed-snapshot><span>{t('business.ledger.snapshotOnly')}</span></div>}
  <div className={css.blocks}>{ledger.blocks.map(row=><ObjectTypeBlock key={row.objectType.definition.id} block={row} actions={ledger.actions} updated={updated?.has(row.objectType.definition.id)??false} localCustomized={blockLocalCustomized(row)} connect={connect} open={id=>go({scope,section:'data',objectType:id})}/>)}</div>
 </section>
}

/**
 * 读取、重试与缓存失效这一层。缓存以 `(scope,viewId,definitionHash)` 为键：
 * 声明版本一变旧结果整条作废，不做增量合并，块上标「声明已更新」（规格 §4.3、§8 第 5 条）。
 * 读不出来就停在这里并写明原因，不以空台账替代（规格 §8 第 7 条）。
 */
export function BusinessLedgerSurface({scope,objectType,objectId,match,api,go,connect,objectActions,empty,refreshKey=0}:{
 scope:BusinessTarget['scope'];objectType?:string|undefined;objectId?:string|undefined;match?:BusinessTarget['match'];api:BusinessLedgerApi
 go:(target:BusinessTarget)=>void;connect:(sourceId:string)=>void
 /** 第三个入参给出所属块：能不能对这一类对象发起动作由服务端算好的 `defaultAction.available` 说。 */
 objectActions?:((object:BusinessLedgerObject,objectType:string,block:BusinessLedgerBlock)=>ReactNode)|undefined
 empty?:ReactNode|undefined
 refreshKey?:number
}){
 const {t}=useI18n()
 const [state,setState]=useState<SurfaceState>({status:'loading'})
 const [attempt,setAttempt]=useState(0)
 // 依赖取筛选的两个取值而不是对象本身：上层每次重渲染都会给一个新对象，不能因此重读。
 const matchField=match?.field,matchValue=match?.value
 useEffect(()=>{
  const controller=new AbortController()
  setState({status:'loading'})
  void api.read({scope,...(objectType?{objectType}:{}),...(objectType&&matchField!==undefined&&matchValue!==undefined?{match:{field:matchField,value:matchValue}}:{})},controller.signal).then(ledger=>{
   if(controller.signal.aborted)return
   const previous=ledgerKeys.get(scope)
   const updated=new Set(ledger.blocks.filter(block=>businessLedgerBlockUpdated(previous,scope,block)).map(block=>block.objectType.definition.id))
   ledgerKeys.set(scope,businessLedgerCacheKeys(ledger))
   setState({status:'ready',ledger,updated})
  },error=>{if(!controller.signal.aborted)setState({status:'failed',reason:businessLedgerFailureKey(error)})})
  return ()=>controller.abort()
 },[api,scope,objectType,matchField,matchValue,attempt,refreshKey])
 if(state.status==='loading')return <div className={base.empty} aria-label={t('business.ledger.title')}><h3>{t('business.ledger.loading')}</h3></div>
 // 按宿主回的错误码选一条固定文案；`details` 不碰，原始 message 与内部错误码都不上屏。
 if(state.status==='failed')return <div className={base.error} role="alert"><span>{t(state.reason)}</span><button type="button" onClick={()=>setAttempt(value=>value+1)}>{t('business.ledger.retry')}</button></div>
 return <BusinessLedgerView ledger={state.ledger} updated={state.updated} go={go} connect={connect} {...(objectType?{objectType}:{})} {...(objectId?{objectId}:{})} {...(match?{match}:{})} {...(objectActions?{objectActions}:{})} {...(empty?{empty}:{})}/>
}

import clsx from 'clsx'
import type {ReactNode} from 'react'
import {ArrowUpRight,ChevronRight} from 'lucide-react'
import {ItemArt,StateMark,stateMarkLabel} from './SolutionCards.js'
import type {SolutionMark} from './market-solution-presentation.js'
import type {IndustryResourceKind} from './industry-manifest.js'
import type {MarketCategory} from './market-home-presentation.js'
import {staffAvatarSeed} from './staff-avatar-seed.js'
import {useI18n} from './i18n/provider.js'
import {UNCLASSIFIED,filterTaxonomyRows,getIndustrySubKeys,getTaxonomyLabel,isMarketIndustryRoot,marketFunctionKeys,marketIndustryKeys,type MarketFunctionKey,type MarketIndustryKey,type TaxonomyFilter,type TaxonomyTags} from './market-taxonomy-filter.js'
import css from './MarketUnifiedList.module.css'
import pageCss from './MarketPage.module.css'
import staffCss from './StaffAvatar.module.css'

/**
 * 市场统一列表（原型 `市场方案.jsx`）：一个页签只有一个列表、一套筛选。
 * 官方目录条目、本机条目（含内置示例）和本机资源行都先换成 `MarketListRow`，再由这里按同一套卡片与两排筛选渲染。
 */
export type MarketListRow={
 key:string
 title:string
 summary:string
 /** 第三行小字：「状态 · 来源」或方案的「包含：…」 */
 facts:string
 /** 行内小标签：内置示例 / 本机；官方条目不带 */
 tag?:string
 mark:SolutionMark|null
 art:{kind:IndustryResourceKind|MarketCategory;seed:string}
 taxonomy:TaxonomyTags
 open:()=>void
 /** 官方条目写 data-teloa-catalog-entry / data-catalog-row（详情返回时按它找回焦点），本机条目写 data-teloa-entry */
 catalogId?:string
 current?:boolean
 /** 本机条目对应的内容编号：同一内容已作为官方条目「已添加」时，列表只留官方那一行（带已添加记号） */
 contentId?:string
 /** 卡片下方附加内容（推荐改用链接） */
 after?:ReactNode
}

const ROOT_INDUSTRY_KEYS=(marketIndustryKeys as readonly MarketIndustryKey[]).filter(key=>!key.includes('/'))
const FN_KEYS=marketFunctionKeys as readonly MarketFunctionKey[]

/** 筛选行：左侧一列写明这一排筛什么（行业 / 功能 / 排序），右侧按钮换行时对齐在按钮列里，不钻到标签下面。 */
export function FilterRow({label,aria,sub=false,children}:{label:string;aria:string;sub?:boolean;children:ReactNode}){
 return <div className={clsx(css.filterRow,sub&&css.filterRowSub)} role="group" aria-label={aria}>
  <span className={css.filterLabel} aria-hidden="true">{label}</span>
  <div className={css.chips}>{children}</div>
 </div>
}

/**
 * 两排筛选（行业 / 功能）：行业计数在功能筛选之后统计，功能计数在行业筛选之后统计；计数为 0 的键不出现（已选中的除外）。
 * 选中含二级行业的根键时展开二级行。`children` 放在筛选区末尾（排序、更多筛选）。
 */
export function MarketFilterBar<T>({rows,tags,filter,onChange,children}:{rows:readonly T[];tags:(row:T)=>TaxonomyTags;filter:TaxonomyFilter;onChange:(filter:TaxonomyFilter)=>void;children?:ReactNode}){
 const {t,locale,number}=useI18n()
 const {industry,fn}=filter
 const industryBase=filterTaxonomyRows(rows,tags,{industry:null,fn})
 const fnBase=filterTaxonomyRows(rows,tags,{industry,fn:null})
 const countIndustry=(key:MarketIndustryKey)=>filterTaxonomyRows(industryBase,tags,{industry:key,fn:null}).length
 const countFn=(key:MarketFunctionKey)=>filterTaxonomyRows(fnBase,tags,{industry:null,fn:key}).length
 const industryKeys=ROOT_INDUSTRY_KEYS.filter(key=>countIndustry(key)>0||industry===key||(industry!==null&&industry.startsWith(key+'/')))
 const fnKeys=FN_KEYS.filter(key=>countFn(key)>0||fn===key)
 // 「未分类」只在确有没分类的条目（或正选着它）时出现；选具体功能时这些条目不在结果里，选「全部」或「未分类」时在
 const unclassified=filterTaxonomyRows(fnBase,tags,{industry:null,fn:UNCLASSIFIED}).length
 const showUnclassified=unclassified>0||fn===UNCLASSIFIED
 const subRoot=industry&&isMarketIndustryRoot(industry)&&getIndustrySubKeys(industry).length>0?industry:null
 const label=(axis:'industry'|'function',key:string)=>getTaxonomyLabel(axis,key,locale)??key
 const setIndustry=(value:MarketIndustryKey|null)=>onChange({industry:value,fn})
 return <div className={css.filterBar}>
  {/* 词表为空（没有可选键）时不渲染只剩「全部」的一行；「全部」不带数字，总数只在结果行写一次 */}
  {industryKeys.length>0&&<FilterRow label={t('market.catalog.official.taxonomyIndustryLabel')} aria={t('market.catalog.official.taxonomyIndustryAria')}>
   <button type="button" aria-pressed={industry===null} onClick={()=>setIndustry(null)}>{t('market.catalog.official.taxonomyAll')}</button>
   {industryKeys.map(key=><button key={key} type="button" aria-pressed={industry===key||(industry!==null&&industry.startsWith(key+'/'))} onClick={()=>setIndustry(key)}>{label('industry',key)}<span>{number(countIndustry(key))}</span></button>)}
  </FilterRow>}
  {subRoot&&<FilterRow label={label('industry',subRoot)} aria={label('industry',subRoot)} sub>
   <button type="button" aria-pressed={industry===subRoot} onClick={()=>setIndustry(subRoot)}>{t('market.catalog.official.taxonomyAll')}</button>
   {getIndustrySubKeys(subRoot).filter(key=>countIndustry(key)>0||industry===key).map(key=><button key={key} type="button" aria-pressed={industry===key} onClick={()=>setIndustry(key)}>{label('industry',key)}<span>{number(countIndustry(key))}</span></button>)}
  </FilterRow>}
  {(fnKeys.length>0||showUnclassified)&&<FilterRow label={t('market.catalog.official.taxonomyFunctionLabel')} aria={t('market.catalog.official.taxonomyFunctionAria')}>
   <button type="button" aria-pressed={fn===null} onClick={()=>onChange({industry,fn:null})}>{t('market.catalog.official.taxonomyAll')}</button>
   {fnKeys.map(key=><button key={key} type="button" aria-pressed={fn===key} onClick={()=>onChange({industry,fn:key})}>{label('function',key)}<span>{number(countFn(key))}</span></button>)}
   {showUnclassified&&<button type="button" aria-pressed={fn===UNCLASSIFIED} onClick={()=>onChange({industry,fn:UNCLASSIFIED})}>{t('market.catalog.official.taxonomyUnclassified')}<span>{number(unclassified)}</span></button>}
  </FilterRow>}
  {children}
 </div>
}

/** 「更多筛选」折叠：放在两排筛选下方、按钮列里，收来源、可见范围这类少用的维度。 */
export function MoreFilters({label,children}:{label:string;children:ReactNode}){
 return <details className={css.moreFilters}><summary>{label}</summary>{children}</details>
}
export const moreFilterCss={chips:css.chips,fields:css.moreFields}

/** 白话结果行：「共 N 项」，可带后缀（目录版本）。 */
export function MarketResultLine({count,suffix}:{count:number;suffix?:string}){
 const {t,number}=useI18n()
 return <p className={css.resultLine} aria-live="polite">{t('market.catalog.official.count',{count:number(count)})}{suffix?' · '+suffix:''}</p>
}

/**
 * 列表空态，两种：本来就没有内容（「这里还没有内容」，不给按钮）与筛选后为 0（「没有匹配资源」+「重置筛选」）。
 * 官方目录、本机资源、任务模板三处共用，样式一致。
 */
export function MarketEmpty({filtered,onReset}:{filtered:boolean;onReset:()=>void}){
 const {t}=useI18n()
 return <div className={css.empty} role="status">{filtered?<><span>{t('market.catalog.empty')}</span><button type="button" onClick={onReset}>{t('market.filter.reset')}</button></>:<span>{t('market.catalog.nothingYet')}</span>}</div>
}

/** 条目卡列表：方案用双列方案卡，其余用单列条目卡；一击进入详情。 */
export function MarketListRows({rows,layout='list'}:{rows:readonly MarketListRow[];layout?:'list'|'grid'}){
 const {t}=useI18n()
 const dataAttrs=(row:MarketListRow)=>row.catalogId?{'data-catalog-row':row.catalogId}:{'data-teloa-entry':row.key}
 const tag=(row:MarketListRow)=>row.tag?<span className={css.tag}>{row.tag}</span>:null
 if(layout==='grid')return <ul className={css.grid}>{rows.map(row=><li key={row.key} {...(row.catalogId?{'data-teloa-catalog-entry':row.catalogId}:{})}>
  {/* 方案卡内容多（一句话 + 包含），可访问名只取标题、标签与状态 */}
  <button type="button" className={css.gridCard} {...dataAttrs(row)} aria-label={[row.title,row.tag,row.mark&&stateMarkLabel(row.mark,t)].filter(Boolean).join(', ')} aria-current={row.current?'page':undefined} onClick={row.open}>
   <span className={clsx(pageCss.bundleArt,staffCss['tone'+staffAvatarSeed(row.art.seed).tone])} aria-hidden="true"><span/><span/><span/></span>
   <span className={css.rowMain}>
    <span className={css.rowTop}><strong className={css.gridTitle}>{row.title}</strong>{tag(row)}{row.mark&&<StateMark mark={row.mark} t={t}/>}</span>
    <span className={css.gridPitch}>{row.summary}</span>
    <span className={css.rowFacts}>{row.facts}</span>
   </span>
   <ArrowUpRight size={16} aria-hidden="true"/>
  </button>
 </li>)}</ul>
 return <ul className={css.rows}>{rows.map(row=><li key={row.key} className={css.row} {...(row.catalogId?{'data-teloa-catalog-entry':row.catalogId}:{})}>
  {/* 单列条目卡不设 aria-label：按钮内容（标题、摘要、状态记号的读屏文字）即可访问名 */}
  <button type="button" className={css.rowButton} {...dataAttrs(row)} aria-current={row.current?'page':undefined} onClick={row.open}>
   <ItemArt kind={row.art.kind} title={row.title} seed={row.art.seed}/>
   <span className={css.rowMain}>
    <span className={css.rowTop}><strong className={css.rowTitle}>{row.title}</strong>{tag(row)}</span>
    {row.summary&&<span className={css.rowSummary}>{row.summary}</span>}
    <span className={css.rowFacts}>{row.facts}</span>
   </span>
   {row.mark&&<StateMark mark={row.mark} t={t}/>}
   <ChevronRight size={16} aria-hidden="true"/>
  </button>
  {row.after&&<div className={css.rowAfter}>{row.after}</div>}
 </li>)}</ul>
}

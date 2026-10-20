import clsx from 'clsx'
import type {RoleAvatarKey} from '@teloa/contract'
import {useId,useState,type ReactNode} from 'react'
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
 /** 仅使用真实声明的作者或来源，不从审查人推定作者。 */
 credit?:string
 group?:string
 /** 行内小标签：内置示例 / 本机；官方条目不带 */
 tag?:string
 mark:SolutionMark|null
 /** 只有引用或内容冲突的行只可查看，不能暗示可独立添加。 */
 addable?:boolean
 art:{kind:IndustryResourceKind|MarketCategory;seed:string;avatarKey?:RoleAvatarKey}
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
export function MarketFilterBar<T>({rows,tags,filter,onChange,children,compact:compactRow=false,sidebar=false,simple=false}:{rows:readonly T[];tags:(row:T)=>TaxonomyTags;filter:TaxonomyFilter;onChange:(filter:TaxonomyFilter)=>void;children?:ReactNode;compact?:boolean;/** 只显示工作领域，不显示行业与技术筛选。 */simple?:boolean;/** 方案 B 主目录：用途分类竖排在左栏，其余筛选折叠在分类下方 */sidebar?:boolean}){
 const {t,locale,number}=useI18n()
 const compact=compactRow||sidebar
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
 return <div className={clsx(css.filterBar,compact&&css.purposeBar,sidebar&&css.purposeNav)}>
  {/* 词表为空（没有可选键）时不渲染只剩「全部」的一行；「全部」不带数字，总数只在结果行写一次 */}
  {!compact&&industryKeys.length>0&&<FilterRow label={t('market.catalog.official.taxonomyIndustryLabel')} aria={t('market.catalog.official.taxonomyIndustryAria')}>
   <button type="button" aria-pressed={industry===null} onClick={()=>setIndustry(null)}>{t('market.catalog.official.taxonomyAll')}</button>
   {industryKeys.map(key=><button key={key} type="button" aria-pressed={industry===key||(industry!==null&&industry.startsWith(key+'/'))} onClick={()=>setIndustry(key)}>{label('industry',key)}<span>{number(countIndustry(key))}</span></button>)}
  </FilterRow>}
  {!compact&&subRoot&&<FilterRow label={label('industry',subRoot)} aria={label('industry',subRoot)} sub>
   <button type="button" aria-pressed={industry===subRoot} onClick={()=>setIndustry(subRoot)}>{t('market.catalog.official.taxonomyAll')}</button>
   {getIndustrySubKeys(subRoot).filter(key=>countIndustry(key)>0||industry===key).map(key=><button key={key} type="button" aria-pressed={industry===key} onClick={()=>setIndustry(key)}>{label('industry',key)}<span>{number(countIndustry(key))}</span></button>)}
  </FilterRow>}
  {(fnKeys.length>0||showUnclassified)&&<FilterRow label={t(compact?'market.primary.purpose':'market.catalog.official.taxonomyFunctionLabel')} aria={t(compact?'market.primary.purposeAria':'market.catalog.official.taxonomyFunctionAria')}>
   <button type="button" aria-pressed={fn===null} onClick={()=>onChange({industry,fn:null})}>{t('market.catalog.official.taxonomyAll')}</button>
   {fnKeys.map(key=><button key={key} type="button" aria-pressed={fn===key} onClick={()=>onChange({industry,fn:key})}>{label('function',key)}<span>{number(countFn(key))}</span></button>)}
   {showUnclassified&&<button type="button" aria-pressed={fn===UNCLASSIFIED} onClick={()=>onChange({industry,fn:UNCLASSIFIED})}>{t('market.catalog.official.taxonomyUnclassified')}<span>{number(unclassified)}</span></button>}
  </FilterRow>}
  {compact&&!simple?<MoreFilters label={t('market.catalog.official.moreFilters')}><div className={css.filterPanel}>
   {industryKeys.length>0&&<div><p>{t('market.catalog.official.taxonomyIndustryLabel')}</p><div className={css.chips} role="group" aria-label={t('market.catalog.official.taxonomyIndustryAria')}><button type="button" aria-pressed={industry===null} onClick={()=>setIndustry(null)}>{t('market.catalog.official.taxonomyAll')}</button>{industryKeys.map(key=><button key={key} type="button" aria-pressed={industry===key||(industry!==null&&industry.startsWith(key+'/'))} onClick={()=>setIndustry(key)}>{label('industry',key)}</button>)}</div></div>}
   {subRoot&&<div><p>{label('industry',subRoot)}</p><div className={css.chips}><button type="button" aria-pressed={industry===subRoot} onClick={()=>setIndustry(subRoot)}>{t('market.catalog.official.taxonomyAll')}</button>{getIndustrySubKeys(subRoot).filter(key=>countIndustry(key)>0||industry===key).map(key=><button key={key} type="button" aria-pressed={industry===key} onClick={()=>setIndustry(key)}>{label('industry',key)}</button>)}</div></div>}
   {children}
  </div></MoreFilters>:children}
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
export function MarketListRows({rows,layout='list',showGroups=false}:{rows:readonly MarketListRow[];layout?:'list'|'grid'|'cards';showGroups?:boolean}){
 const {t}=useI18n()
 const dataAttrs=(row:MarketListRow)=>row.catalogId?{'data-catalog-row':row.catalogId}:{'data-teloa-entry':row.key}
 const tag=(row:MarketListRow)=>row.tag?<span className={css.tag}>{row.tag}</span>:null
 // 紧凑卡里的团队方案形象缩到与员工形象同一 40px
 const art=(row:MarketListRow,compact=false)=>row.art.kind==='industry'?<span className={clsx(pageCss.bundleArt,compact&&css.cardBundle,staffCss['tone'+staffAvatarSeed(row.art.seed).tone])} aria-hidden="true"><span/><span/><span/></span>:<ItemArt kind={row.art.kind} title={row.title} seed={row.art.seed} avatarKey={row.art.avatarKey}/>
 const ariaLabel=(row:MarketListRow)=>[row.title,row.tag,row.mark&&stateMarkLabel(row.mark,t)].filter(Boolean).join(', ')
 // 1.0 紧凑卡（设计稿 10）：形象 + 名称 + 提供方小字，一句话，底部右侧「添加 / 已添加」胶囊；已添加不再另画记号，需重启与冲突仍留记号
 if(layout==='cards')return <ul className={clsx(css.grid,css.cards)}>{rows.map(row=><li key={row.key} {...(row.catalogId?{'data-teloa-catalog-entry':row.catalogId}:{})}>
  <button type="button" className={css.gridCard} {...dataAttrs(row)} aria-label={ariaLabel(row)} aria-current={row.current?'page':undefined} onClick={row.open}>
   <span className={css.cardHead}>{art(row,true)}<span className={css.cardIdentity}><span className={css.rowTop}><strong className={css.gridTitle}>{row.title}</strong>{showGroups&&row.group&&<span className={css.resultGroup}>{row.group}</span>}{tag(row)}{(row.mark==='restart'||row.mark==='conflict')&&<StateMark mark={row.mark} t={t}/>}</span>{row.credit&&<span className={css.cardCredit}>{row.credit}</span>}</span></span>
   <span className={css.gridPitch}>{row.summary}</span>
   <span className={css.cardFoot}><span className={clsx(css.cardAction,row.mark==='added'&&css.cardAdded)}>{row.mark==='added'?stateMarkLabel('added',t):t(row.mark==='available'&&row.addable!==false?'market.primary.add':'market.catalog.official.view')}</span></span>
  </button>
 </li>)}</ul>
 if(layout==='grid')return <ul className={css.grid}>{rows.map(row=><li key={row.key} {...(row.catalogId?{'data-teloa-catalog-entry':row.catalogId}:{})}>
  {/* 方案卡内容多（一句话 + 包含），可访问名只取标题、标签与状态 */}
  <button type="button" className={css.gridCard} {...dataAttrs(row)} aria-label={ariaLabel(row)} aria-current={row.current?'page':undefined} onClick={row.open}>
   {art(row)}
   <span className={css.rowMain}>
    <span className={css.rowTop}><strong className={css.gridTitle}>{row.title}</strong>{showGroups&&row.group&&<span className={css.resultGroup}>{row.group}</span>}{tag(row)}{row.mark&&<StateMark mark={row.mark} t={t}/>}</span>
    <span className={css.gridPitch}>{row.summary}</span>
    <span className={css.rowFacts}>{row.facts}</span>
   </span>
   <ArrowUpRight size={16} aria-hidden="true"/>
  </button>
 </li>)}</ul>
 return <ul className={css.rows}>{rows.map(row=><li key={row.key} className={css.row} {...(row.catalogId?{'data-teloa-catalog-entry':row.catalogId}:{})}>
  {/* 单列条目卡不设 aria-label：按钮内容（标题、摘要、状态记号的读屏文字）即可访问名 */}
  <button type="button" className={css.rowButton} {...dataAttrs(row)} aria-current={row.current?'page':undefined} onClick={row.open}>
   <ItemArt kind={row.art.kind} title={row.title} seed={row.art.seed} avatarKey={row.art.avatarKey}/>
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

/** 首页按真实用途分区，不制造精选或安装统计；查看全部继续使用同一筛选。 */
export function MarketCardSections({rows,grouped,onSelect,showGroups=false}:{rows:readonly MarketListRow[];grouped:boolean;onSelect:(fn:TaxonomyFilter['fn'])=>void;showGroups?:boolean}){
 const {t,locale,number}=useI18n()
 if(!grouped)return <MarketListRows rows={rows} layout="cards" showGroups={showGroups}/>
 const keys=[...FN_KEYS,UNCLASSIFIED] as const
 return <div className={css.cardSections}>{keys.map(fn=>{
  const items=rows.filter(row=>(row.taxonomy.functions[0]??UNCLASSIFIED)===fn)
  if(!items.length)return null
  const label=fn===UNCLASSIFIED?t('market.catalog.official.taxonomyUnclassified'):getTaxonomyLabel('function',fn,locale)??fn
  return <section key={fn}><header><h2>{label}</h2><button type="button" aria-label={t('market.primary.viewAll')} onClick={()=>onSelect(fn)}>{t('market.primary.viewAll')}<span>{number(items.length)}</span></button></header><MarketListRows rows={items.slice(0,4)} layout="cards"/></section>
 })}</div>
}

/** 读取骨架（B8）：直接套真实卡片 / 行的类名与尺寸（44px 形象、两行一句话、底部胶囊），读到后原位换成真实条目不跳动。 */
export function MarketCatalogSkeleton({layout,grouped=false}:{layout:'list'|'grid'|'cards';grouped?:boolean}){
 const line=(width:string)=><span className={css.skeletonLine} style={{width}}/>
 if(layout==='list')return <ul className={css.rows}>{[0,1,2,3].map(index=><li key={index} className={css.row}><div className={clsx(css.rowButton,css.skeletonRow)}><span className={css.skeletonArt}/><span className={css.rowMain}>{line('38%')}{line('86%')}{line('24%')}</span></div></li>)}</ul>
 const cards=<ul className={clsx(css.grid,layout==='cards'&&css.cards)}>{[0,1,2,3].map(index=><li key={index}><div className={clsx(css.gridCard,css.skeletonCard)}>{layout==='cards'?<>
  <span className={css.cardHead}><span className={css.skeletonArt}/><span className={css.cardIdentity}>{line('62%')}{line('34%')}</span></span>
  <span className={css.skeletonPitch}>{line('94%')}{line('72%')}</span>
  <span className={css.cardFoot}><span className={css.skeletonPill}/></span>
 </>:<><span className={css.skeletonArt}/><span className={css.rowMain}>{line('42%')}{line('92%')}{line('68%')}{line('30%')}</span></>}</div></li>)}</ul>
 return grouped?<div className={css.cardSections}><section><header>{line('96px')}</header>{cards}</section></div>:cards
}

/** 方案 B 主目录版面：左栏用途分类（`MarketFilterBar sidebar`），右栏搜索与紧凑卡片；窄窗口下分类回到卡片上方横排。 */
export function MarketDirectoryLayout({nav,children}:{nav:ReactNode;children:ReactNode}){
 return <div className={css.directory}><div className={css.directoryNav}>{nav}</div><div className={css.directoryBody}>{children}</div></div>
}

/** 仅展示模板已有声明；切换分类不会创建、安装或启用内容。 */
export function MarketTemplateDetails({sections}:{sections:readonly {id:string;title:string;content:ReactNode}[]}){
 const id=useId(),[active,setActive]=useState(sections[0]?.id)
 return <section className={css.templateDetails}><nav role="tablist" className={css.detailTabs}>{sections.map(section=><button key={section.id} type="button" role="tab" id={id+'-'+section.id} aria-selected={active===section.id} aria-controls={id+'-panel-'+section.id} tabIndex={active===section.id?0:-1} onClick={()=>setActive(section.id)} onKeyDown={event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const index=sections.findIndex(value=>value.id===section.id),next=event.key==='Home'?0:event.key==='End'?sections.length-1:(index+(event.key==='ArrowRight'?1:-1)+sections.length)%sections.length;setActive(sections[next]!.id);document.getElementById(id+'-'+sections[next]!.id)?.focus()}}>{section.title}</button>)}</nav>{sections.map(section=><div key={section.id} id={id+'-panel-'+section.id} role="tabpanel" aria-labelledby={id+'-'+section.id} hidden={active!==section.id} className={css.detailPanel}>{section.content}</div>)}</section>
}

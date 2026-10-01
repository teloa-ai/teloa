import {useState,type ReactNode} from 'react'
import {Boxes,ChevronRight} from 'lucide-react'
import {type IndustryResourceKind} from './industry-manifest.js'
import css from './IndustryResourceBrowser.module.css'
import {useI18n} from './i18n/provider.js'

type Resource={id:string;title:string;kind:IndustryResourceKind;version:string}
/**
 * 目录分组必须覆盖 `industryResourceKinds` 全集：漏掉的类型在左侧一格都点不出来，
 * 资源明明在包里却像不存在。导出出去只为让测试能钉住这条穷尽性，界面之外没有别的调用方。
 */
export const industryBrowserGroups=[
 {title:'market.industry.browser.group.members',kinds:['role','skill','knowledge']},
 {title:'market.industry.browser.group.tools',kinds:['mcp','plugin','execution-tool']},
 {title:'market.industry.browser.group.work',kinds:['data-source','work-template','plan']},
 {title:'market.industry.browser.group.business',kinds:['object-type','business-view','business-action','business-configuration']},
] as const

/** 模板声明与空间实例复用浏览结构，各自提供真实状态和可用操作。 */
/** kindLabel 让已加入的方案页按市场标签称呼类型（同事、扩展、连接…）；initialSelectedId 从别处带着某一项进来时先选中它，列表仍是全部。 */
export function IndustryResourceBrowser<T extends Resource>({resources,render,status,showCategories=true,title,kindLabel:customKindLabel,initialSelectedId}:{resources:readonly T[];render:(resource:T)=>ReactNode;status:(resource:T)=>string;showCategories?:boolean;title?:string|undefined;kindLabel?:((kind:IndustryResourceKind)=>string)|undefined;initialSelectedId?:string|undefined}){
 const {t}=useI18n()
 const kindLabel=customKindLabel??((value:IndustryResourceKind)=>t(`market.industry.resource.${value}` as Parameters<typeof t>[0]))
 const [kind,setKind]=useState<IndustryResourceKind|'all'>('all')
 const [query,setQuery]=useState('')
 const [selectedId,setSelectedId]=useState(resources.some(row=>row.id===initialSelectedId)?initialSelectedId:resources[0]?.id)
 const rows=resources.filter(row=>(kind==='all'||row.kind===kind)&&row.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
 const selected=rows.find(row=>row.id===selectedId)??rows[0]
 const count=(kind:IndustryResourceKind)=>resources.filter(row=>row.kind===kind).length
 return <div className={showCategories?css.browser:css.browserWithoutTree}>
  {showCategories&&<div className={css.tree} role="group" aria-label={t('market.industry.browser.categories')}>
   <button type="button" aria-label={t('market.industry.browser.allCount',{count:resources.length})} aria-pressed={kind==='all'} onClick={()=>setKind('all')}><Boxes size={15}/>{t('common.all')} · {resources.length}</button>
   {industryBrowserGroups.map(group=><details key={group.title} open><summary>{t(group.title)}</summary>{group.kinds.map(value=>{const label=kindLabel(value)+' · '+count(value);return <button type="button" key={value} aria-label={label} aria-pressed={kind===value} onClick={()=>setKind(value)}>{label}</button>})}</details>)}
  </div>}
  <div className={css.main}>
   <div className={css.toolbar}><strong>{title??(kind==='all'?t('market.industry.browser.allResources'):kindLabel(kind))} · {rows.length}</strong><input aria-label={t('market.industry.browser.searchAria')} placeholder={t('market.industry.browser.search')} value={query} onChange={event=>setQuery(event.target.value)}/></div>
   <div className={css.workbench}>
    <div className={css.list} role="listbox" aria-label={t('market.industry.browser.list')}>
     {rows.map(resource=><button type="button" role="option" aria-selected={selected?.id===resource.id} className={css.resource} key={resource.id} onClick={()=>setSelectedId(resource.id)}><span><strong>{resource.title}</strong><small>{kindLabel(resource.kind)} · v{resource.version}</small></span><em>{status(resource)}</em><ChevronRight size={15}/></button>)}
     {!rows.length&&<p className={css.empty}>{query?t('market.industry.browser.noMatch'):t('market.industry.browser.emptyKind',{kind:kind==='all'?t('market.industry.browser.resources'):kindLabel(kind)})}</p>}
    </div>
    <section className={css.preview} aria-label={t('market.industry.browser.preview')}>
     {selected?<><header><span>{kindLabel(selected.kind)}</span><strong>{selected.title}</strong><small>v{selected.version} · {status(selected)}</small></header><div className={css.body}>{render(selected)}</div></>:<div className={css.previewEmpty}><strong>{t('market.industry.browser.select')}</strong><p>{t('market.industry.browser.selectHelp')}</p></div>}
    </section>
   </div>
  </div>
 </div>
}

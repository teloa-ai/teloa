import {BookOpen,BriefcaseBusiness,ChevronRight,Clock3,LockKeyhole,ShieldCheck,Users,Wrench,type LucideIcon} from 'lucide-react'
import {useEffect,useRef,useState,type ReactNode} from 'react'
import type {RoleWorkDelegation,WorkResource} from '@teloa/contract'
import type {PreviewRole} from './role-preview.js'
import type {RoleDelegationMessageKey} from './i18n/locales/role-delegation.js'
import {ContextDrawer} from './ContextDrawer.js'
import {roleToolLabel} from './RoleToolGrants.js'
import {useI18n} from './i18n/provider.js'
import css from './RoleDelegationOverview.module.css'

/** 总览只展示当前服务事实；所有变更仍由原委托表单明确提交。 */
export function RoleDelegationOverview({role,current,status,toolNames,knowledge,groups,ready,error,pending,hasHistory,closed,children}:{
 role:PreviewRole;current:RoleWorkDelegation|undefined;status:RoleDelegationMessageKey;toolNames:readonly string[];knowledge:readonly WorkResource[];groups:readonly {id:string;name:string}[];ready:boolean;error:string|undefined;pending:boolean;hasHistory:boolean;closed:()=>void;children:ReactNode
}){
 const {t}=useI18n(),[open,setOpen]=useState(false),[history,setHistory]=useState(false)
 const manager=useRef<HTMLDivElement>(null)
 useEffect(()=>{if(!open||!history)return;const records=manager.current?.querySelector<HTMLDetailsElement>('details[data-teloa-delegation-history]');if(records){records.open=true;records.querySelector('summary')?.focus();records.scrollIntoView({block:'nearest'})}},[open,history])
 const show=(records=false)=>{setHistory(records);setOpen(true)}
 const close=()=>{setOpen(false);closed()}
 const missing=(count:number)=>t('roleDelegation.overview.unavailable',{count})
 const materialIds=current?.knowledgeIds??role.knowledge,groupIds=current?.groupIds??groups.map(group=>group.id)
 const materials=materialIds.map(id=>knowledge.find(row=>row.id===id)?.title).filter((name):name is string=>!!name)
 const collaborators=groupIds.map(id=>groups.find(row=>row.id===id)?.name).filter((name):name is string=>!!name)
 const tools=(current?.allowedTools??toolNames).map(name=>roleToolLabel(name,t))
 const tags=(values:readonly string[],unknown=0)=><>{!ready?<span className={css.muted}>{t('roleDelegation.loading')}</span>:values.length?<div className={css.tags}>{values.slice(0,3).map((value,index)=><span key={`${index}:${value}`}>{value}</span>)}{values.length>3&&<span>{t('roleDelegation.overview.more',{count:values.length-3})}</span>}</div>:!unknown?<span className={css.muted}>{t('roleDelegation.overview.empty')}</span>:null}{ready&&unknown>0&&<small>{missing(unknown)}</small>}</>
 const row=(Icon:LucideIcon,title:RoleDelegationMessageKey,value:ReactNode)=><div className={css.row}><Icon size={18}/><div className={css.rowBody}><h4>{t(title)}</h4>{value}</div><button type="button" className={css.rowAction} aria-label={t('roleDelegation.overview.editRow',{name:t(title)})} onClick={()=>show()}><ChevronRight size={16}/></button></div>
 return <div className={css.overview}>
  <header className={css.heading}><div><h2>{t('team.twin.tab.boundary')}</h2><p>{t('roleDelegation.overview.lead')}</p></div></header>
  <div className={css.status} role="status"><ShieldCheck size={21}/><div><strong>{t(status)}</strong><p>{t(current?'roleDelegation.overview.currentHint':'roleDelegation.overview.draftHint')}</p></div><button type="button" className={css.primary} onClick={()=>show()}>{t('roleDelegation.overview.manage')}<ChevronRight size={15}/></button></div>
  {error&&<p role="alert" className={css.error}>{error}</p>}
  {pending&&<p className={css.notice}>{t('roleDelegation.pending')} <button type="button" onClick={()=>show()}>{t('roleDelegation.recover')}</button></p>}
  <div className={css.columns}><div><div className={css.sectionTitle}><h3>{t('roleDelegation.overview.work')}</h3><span>{t(current?'roleDelegation.overview.saved':'roleDelegation.overview.configured')}</span></div>
   <div className={css.card}>
    {row(BriefcaseBusiness,'roleDelegation.overview.duty',<p className={css.duty}>{role.duty||t('roleDelegation.overview.empty')}</p>)}
    {row(BookOpen,'roleDelegation.overview.material',tags(materials,materialIds.length-materials.length))}
    {row(Wrench,'roleDelegation.overview.tools',tags(tools))}
    {row(Users,'roleDelegation.overview.groups',tags(collaborators,groupIds.length-collaborators.length))}
    <footer className={css.cardFooter}><span><LockKeyhole size={13}/>{t('roleDelegation.overview.identity')}</span>{hasHistory&&<button type="button" onClick={()=>show(true)}><Clock3 size={14}/>{t('roleDelegation.history')}<ChevronRight size={13}/></button>}</footer>
   </div></div><aside className={css.aside}><h3>{t('roleDelegation.overview.principles')}</h3><ul>{(['inScope','ask','identity'] as const).map(key=><li key={key}><ShieldCheck size={14}/><span>{t(`roleDelegation.overview.${key}`)}</span></li>)}</ul><p>{t('roleDelegation.privateMemory')}</p><p>{t('roleDelegation.configureHint')}</p></aside></div>
  <ContextDrawer open={open} title={t('roleDelegation.overview.manage')} close={close} className={css.drawer??''}>
   <div ref={manager} className={css.manager}>{children}</div>
  </ContextDrawer>
 </div>
}

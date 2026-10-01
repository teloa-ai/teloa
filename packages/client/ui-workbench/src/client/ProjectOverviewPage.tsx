import {useEffect,useState} from 'react'
import clsx from 'clsx'
import {CalendarDays,FolderKanban,RefreshCw} from 'lucide-react'
import {projectStates,type ProjectDefinition,type WorkProject} from '@teloa/contract'
import type {ProjectApi} from './project-api.js'
import type {BusinessScopeLabel} from './business-directory.js'
import type {WorkbenchDirectoryNavigation,WorkbenchDirectoryPatch} from './workbench-navigation-state.js'
import {projectStateKeys} from './project-presentation.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import page from './TaskPage.module.css'
import css from './ProjectWorkspace.module.css'

const pageSize=50
type StateFilter='current'|ProjectDefinition['state']
const stateFilters:readonly StateFilter[]=['current',...projectStates]
type Props={api:ProjectApi;scopeLabels:readonly BusinessScopeLabel[];labelsReady:boolean;scopeName:(scope:string)=>string;navigation:{state:WorkbenchDirectoryNavigation;change:(patch:WorkbenchDirectoryPatch)=>void};open:(project:WorkProject)=>void;visible:boolean}
/** 平台级项目总览：只是跨业务的视角，归属不变；筛选状态存在导航目录里（category=业务，query=状态）。 */
export function ProjectOverviewPage({api,scopeLabels,labelsReady,scopeName,navigation,open,visible}:Props){
 const {t,locale}=useI18n()
 const scope=navigation.state.category&&scopeLabels.some(label=>label.scope===navigation.state.category)?navigation.state.category:null
 const stateFilter:StateFilter=stateFilters.includes(navigation.state.query as StateFilter)?navigation.state.query as StateFilter:'current'
 const [rows,setRows]=useState<WorkProject[]>([]),[nextCursor,setNextCursor]=useState<string|null>(null),[loading,setLoading]=useState(true),[more,setMore]=useState(false),[error,setError]=useState(''),[revision,refresh]=useState(0)
 // 业务目录未就绪时不发首屏请求：等标签到齐再按恢复的业务筛选查一次，避免 null→scope 的双请求。
 useEffect(()=>{if(!visible||!labelsReady)return;let active=true;setLoading(true);setError('');void api.overview({scope,state:stateFilter,cursor:null,limit:pageSize}).then(value=>{if(active){setRows(value.rows);setNextCursor(value.nextCursor);setLoading(false)}},e=>{if(active){setError(localizeWorkError(locale,e));setLoading(false)}});return()=>{active=false}},[api,scope,stateFilter,revision,visible,labelsReady,locale])
 useEffect(()=>{if(!visible)return;const update=()=>{if(document.visibilityState==='visible')refresh(n=>n+1)};window.addEventListener('focus',update);const timer=setInterval(update,30000);return()=>{window.removeEventListener('focus',update);clearInterval(timer)}},[visible])
 const loadMore=async()=>{if(!nextCursor||more)return;setMore(true);setError('');try{const value=await api.overview({scope,state:stateFilter,cursor:nextCursor,limit:pageSize});setRows(current=>[...current,...value.rows.filter(row=>!current.some(item=>item.id===row.id))]);setNextCursor(value.nextCursor)}catch(e){setError(localizeWorkError(locale,e))}finally{setMore(false)}}
 return <section className={clsx(page.page,css.workspace)} aria-label={t('project.overview.title')}>
  <header className={page.pageHeader}><div><h1>{t('project.overview.title')}</h1><p>{t('project.overview.hint')}</p></div><button type="button" onClick={()=>refresh(n=>n+1)} aria-label={t('project.refresh')} disabled={loading}><RefreshCw size={16}/></button></header>
  <div className={css.overviewBody} data-teloa-pane="directory" tabIndex={-1}>
   <div className={css.toolbar}>
    {scopeLabels.length>1&&<select aria-label={t('project.overview.businessFilter')} value={scope??''} onChange={e=>navigation.change({category:e.target.value||undefined})}><option value="">{t('project.overview.allBusinesses')}</option>{scopeLabels.map(label=><option key={label.scope} value={label.scope}>{scopeName(label.scope)}</option>)}</select>}
    <select aria-label={t('project.overview.stateFilter')} value={stateFilter} onChange={e=>navigation.change({query:e.target.value==='current'?undefined:e.target.value})}>{stateFilters.map(value=><option key={value} value={value}>{t(value==='current'?'project.current':projectStateKeys[value])}</option>)}</select>
   </div>
   {error&&<div className={css.error} role="alert">{error}<button type="button" disabled={loading||more} onClick={()=>refresh(n=>n+1)}>{t('project.refresh')}</button></div>}
   {loading?<p role="status">{t('project.loading')}</p>:!rows.length?(error?null:<div className={css.directoryEmpty}><FolderKanban size={27}/><h3>{t('project.overview.empty')}</h3></div>):<div className={css.projectList}>{rows.map(project=><button type="button" className={css.projectCard} key={project.id} data-project-card={project.id} onClick={()=>open(project)}><span className={css.cardTitle}><FolderKanban size={19}/><strong>{project.title}</strong><small>{t(projectStateKeys[project.state])}</small></span><span className={css.cardScope}>{scopeName(project.scope)}</span><span className={css.cardGoal}>{project.goal}</span>{project.dueDate&&<span className={css.due}><CalendarDays size={13}/>{project.dueDate}</span>}</button>)}</div>}
   {nextCursor&&!loading&&<div className={css.loadMore}><button type="button" data-project-load-more="" disabled={more} onClick={()=>void loadMore()}>{t('project.overview.loadMore')}</button></div>}
  </div>
 </section>
}

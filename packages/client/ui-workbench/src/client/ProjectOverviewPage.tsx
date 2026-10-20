import {useEffect,useRef,useState} from 'react'
import clsx from 'clsx'
import {FolderKanban,Plus,RefreshCw} from 'lucide-react'
import {ToolbarIconButton} from './ToolbarIconButton.js'
import {projectDefinition,projectStates,type ProjectDefinition,type WorkProject} from '@teloa/contract'
import type {ProjectApi} from './project-api.js'
import type {BusinessScopeLabel} from './business-directory.js'
import type {WorkbenchDirectoryNavigation,WorkbenchDirectoryPatch} from './workbench-navigation-state.js'
import {projectStateKeys,projectCopy} from './project-presentation.js'
import {ProjectCard} from './ProjectWorkspace.js'
import {ProjectForm,type ProjectFormDraft} from './ProjectForm.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import page from './TaskPage.module.css'
import css from './ProjectWorkspace.module.css'

const pageSize=50
type StateFilter='current'|ProjectDefinition['state']
const stateFilters:readonly StateFilter[]=['current',...projectStates]
type Props={api:ProjectApi;scopeLabels:readonly BusinessScopeLabel[];labelsReady:boolean;scopeName:(scope:string)=>string;navigation:{state:WorkbenchDirectoryNavigation;change:(patch:WorkbenchDirectoryPatch)=>void};open:(project:WorkProject)=>void;visible:boolean}
const creationDrafts=new WeakMap<ProjectApi,Map<string,ProjectFormDraft>>()
type Creation={api:ProjectApi;origin:string;draft:ProjectFormDraft}
/** 平台级项目总览：只是跨业务的视角，归属不变；筛选状态存在导航目录里（category=业务，query=状态）。 */
export function ProjectOverviewPage({api,scopeLabels,labelsReady,scopeName,navigation,open,visible}:Props){
 const {t,locale}=useI18n()
 const scope=navigation.state.category&&scopeLabels.some(label=>label.scope===navigation.state.category)?navigation.state.category:null
 const stateFilter:StateFilter=stateFilters.includes(navigation.state.query as StateFilter)?navigation.state.query as StateFilter:'current'
 const [rows,setRows]=useState<WorkProject[]>([]),[nextCursor,setNextCursor]=useState<string|null>(null),[loading,setLoading]=useState(true),[more,setMore]=useState(false),[error,setError]=useState(''),[revision,refresh]=useState(0)
 const [creation,setCreation]=useState<Creation|null>(null),[recovering,setRecovering]=useState(false),current=useRef({api,visible,creation}),mounted=useRef(true),generation=useRef(0)
 current.current={api,visible,creation}
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false}},[])
 useEffect(()=>{generation.current++;setCreation(null);setRecovering(false)},[api,visible])
 const create=()=>{
  if(!labelsReady||!scopeLabels.length||api.pendingFields()||api.recoveryError())return
  const origin=scope??'',initialScope=scope??scopeLabels.find(label=>label.scope==='general')?.scope??scopeLabels[0]!.scope
  let book=creationDrafts.get(api);if(!book){book=new Map();creationDrafts.set(api,book)}
  let draft=book.get(origin)
  if(!draft){draft={fields:{scope:initialScope,title:'',goal:'',dueDate:null,state:'planning',links:[],references:[]},ack:false};book.set(origin,draft)}
  else if(!scopeLabels.some(label=>label.scope===draft!.fields.scope)){draft={...draft,fields:{...draft.fields,scope:initialScope}};book.set(origin,draft)}
  setCreation({api,origin,draft})
 }
 // 业务目录未就绪时不发首屏请求：等标签到齐再按恢复的业务筛选查一次，避免 null→scope 的双请求。
 useEffect(()=>{if(!visible||!labelsReady)return;let active=true;setLoading(true);setError('');void api.overview({scope,state:stateFilter,cursor:null,limit:pageSize}).then(value=>{if(active){setRows(value.rows);setNextCursor(value.nextCursor);setLoading(false)}},e=>{if(active){setError(localizeWorkError(locale,e));setLoading(false)}});return()=>{active=false}},[api,scope,stateFilter,revision,visible,labelsReady,locale])
 useEffect(()=>{if(!visible)return;const update=()=>{if(document.visibilityState==='visible')refresh(n=>n+1)};window.addEventListener('focus',update);const timer=setInterval(update,30000);return()=>{window.removeEventListener('focus',update);clearInterval(timer)}},[visible])
 const loadMore=async()=>{if(!nextCursor||more)return;setMore(true);setError('');try{const value=await api.overview({scope,state:stateFilter,cursor:nextCursor,limit:pageSize});setRows(current=>[...current,...value.rows.filter(row=>!current.some(item=>item.id===row.id))]);setNextCursor(value.nextCursor)}catch(e){setError(localizeWorkError(locale,e))}finally{setMore(false)}}
 const pending=api.pendingFields(),recoveryError=api.recoveryError(),blocked=!!pending||!!recoveryError
 const recover=async()=>{if(recovering)return;setRecovering(true);setError('');const started=generation.current,isCurrent=()=>mounted.current&&current.current.api===api&&current.current.visible&&generation.current===started;try{const row=await api.recover();if(pending)for(const [origin,draft] of creationDrafts.get(api)??[])if(JSON.stringify(projectDefinition(draft.fields))===JSON.stringify(projectDefinition(pending)))creationDrafts.get(api)!.delete(origin);if(isCurrent()){refresh(n=>n+1);open(row)}}catch(e){if(isCurrent())setError(localizeWorkError(locale,e))}finally{if(isCurrent())setRecovering(false)}}
 return <section className={clsx(page.page,css.workspace)} aria-label={t('project.overview.title')}>
  <header className={css.overviewHeader}><div><h1>{t('project.overview.title')}</h1><p>{projectCopy(locale,'overviewLead')}</p></div><div className={css.overviewActions}><ToolbarIconButton label={t('project.refresh')} icon={RefreshCw} disabled={loading} onClick={()=>refresh(n=>n+1)}/><button type="button" className={css.primary} disabled={!labelsReady||!scopeLabels.length||blocked} onClick={create}><Plus size={15}/>{t('project.create')}</button></div></header>
  {blocked&&<div className={css.notice}><p>{t('project.pending')}</p><p>{t('recovery.nextStep')}</p>{pending&&<button type="button" disabled={recovering} onClick={()=>void recover()}>{t('project.recover')}</button>}<button type="button" disabled={recovering} onClick={()=>{api.discard();refresh(n=>n+1)}}>{t('recovery.discard')}</button></div>}
  <div className={css.overviewBody} data-teloa-pane="directory" tabIndex={-1}>
   <div className={css.toolbar}>
    {scopeLabels.length>1&&<select aria-label={t('project.overview.businessFilter')} value={scope??''} onChange={e=>navigation.change({category:e.target.value||undefined})}><option value="">{t('project.overview.allBusinesses')}</option>{scopeLabels.map(label=><option key={label.scope} value={label.scope}>{scopeName(label.scope)}</option>)}</select>}
    <select aria-label={t('project.overview.stateFilter')} value={stateFilter} onChange={e=>navigation.change({query:e.target.value==='current'?undefined:e.target.value})}>{stateFilters.map(value=><option key={value} value={value}>{t(value==='current'?'project.current':projectStateKeys[value])}</option>)}</select>
   </div>
   {error&&<div className={css.error} role="alert">{error}<button type="button" disabled={loading||more} onClick={()=>refresh(n=>n+1)}>{t('project.refresh')}</button></div>}
   {loading?<p role="status">{t('project.loading')}</p>:!rows.length?(error?null:<div className={css.directoryEmpty}><FolderKanban size={27}/><h3>{t(scope||stateFilter!=='current'?'project.overview.noMatch':'project.overview.empty')}</h3><div className={page.buttons}>{(scope||stateFilter!=='current')&&<button type="button" onClick={()=>navigation.change({category:undefined,query:undefined})}>{t('task.filter.reset')}</button>}<button type="button" disabled={!labelsReady||!scopeLabels.length||blocked} onClick={create}><Plus size={16}/>{t('project.create')}</button></div></div>):<div className={css.projectList}>{rows.map(project=><ProjectCard key={project.id} project={project} scopeName={scopeName(project.scope)} open={()=>open(project)}/>)}</div>}
   {nextCursor&&!loading&&<div className={css.loadMore}><button type="button" data-project-load-more="" disabled={more} onClick={()=>void loadMore()}>{t('project.overview.loadMore')}</button></div>}
  </div>
  {creation&&creation.api===api&&visible&&<ProjectForm initial={creation.draft.fields} draft={creation.draft} changeDraft={draft=>{creation.draft=draft;creationDrafts.get(api)!.set(creation.origin,draft)}} scopeName={scopeName(creation.draft.fields.scope)} scopes={scopeLabels.map(label=>({scope:label.scope,label:scopeName(label.scope)}))} close={()=>setCreation(null)} save={async fields=>{const created=await api.create(fields);if(creationDrafts.get(api)?.get(creation.origin)===creation.draft)creationDrafts.get(api)!.delete(creation.origin);if(mounted.current&&current.current.api===api&&current.current.visible&&current.current.creation===creation){setCreation(null);refresh(n=>n+1);open(created)}}}/>}
 </section>
}

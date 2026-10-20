import {useEffect,useRef,useState,type ReactNode} from 'react'
import {ArrowLeft,FolderKanban,Plus,RefreshCw,CalendarDays,Pencil,Archive,X,BookOpen} from 'lucide-react'
import clsx from 'clsx'
import {ToolbarIconButton} from './ToolbarIconButton.js'
import {projectLinkKinds,type ProjectDefinition,type ProjectDetail,type ProjectItem,type ProjectReferenceItem,type WorkProject} from '@teloa/contract'
import type {BusinessScopeLabel} from './business-directory.js'
import {useBusinessScopes} from './business-scope-context.js'
import type {ProjectApi} from './project-api.js'
import {ProjectForm,ProjectArchiveDialog,type ProjectFormDraft} from './ProjectForm.js'
import {ProjectRelations,type ProjectRelationsDraft} from './ProjectRelations.js'
import {ProjectReferences,type ProjectReferencesDraft} from './ProjectReferences.js'
import {ProjectContextPanel} from './ProjectContextPanel.js'
import {ProjectConversations,type ProjectConversationActions} from './ProjectRuntimePanel.js'
import {projectContextCopy} from './project-context-copy.js'
import {projectGoalText,projectCopy,filterProjects,projectFields,projectProgress,removeProjectLink,removeProjectReference,referenceScopeName,projectStateKeys,projectKindKeys,projectItemStateKeys} from './project-presentation.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import css from './ProjectWorkspace.module.css'
import light from './light-actions.module.css'

type Props={api:ProjectApi;conversationActions?:ProjectConversationActions|undefined;scope:string;selectedId?:string;typeName:string;scopeLabels?:readonly BusinessScopeLabel[];select:(id:string,scope?:string)=>void;back:()=>void;openItem:(item:ProjectItem|ProjectReferenceItem)=>void|Promise<void>}
type Draft<T>={value:T;pending?:Promise<void>}
type FormDraft=Draft<ProjectFormDraft>&{initial:ProjectDefinition;project?:WorkProject}
type RelationDraft<T>=Draft<T>&{project:WorkProject}
type ProjectDrafts={forms:Map<string,FormDraft>;relations:Map<string,RelationDraft<ProjectRelationsDraft>>;references:Map<string,RelationDraft<ProjectReferencesDraft>>}
// 同一本人连接内按项目和入口保留草稿；连接释放后不保留跨身份的全局副本。
const projectDrafts=new WeakMap<ProjectApi,ProjectDrafts>()
const draftsFor=(api:ProjectApi)=>{let drafts=projectDrafts.get(api);if(!drafts){drafts={forms:new Map(),relations:new Map(),references:new Map()};projectDrafts.set(api,drafts)}return drafts}
function submitDraft<T extends Draft<unknown>>(drafts:Map<string,T>,key:string,draft:T,run:()=>Promise<void>){
 if(draft.pending)return draft.pending
 const pending=Promise.resolve().then(run).then(()=>{if(drafts.get(key)===draft)drafts.delete(key)})
 draft.pending=pending
 void pending.then(()=>{delete draft.pending},()=>{delete draft.pending})
 return pending
}
type OpenDraft<T>={book:ProjectDrafts;key:string;draft:T}
export function ProjectWorkspace({api,conversationActions,scope,selectedId,typeName,scopeLabels=[],select,back,openItem}:Props){
 const {t,locale}=useI18n(),collaborationScopes=useBusinessScopes(),scopeName=(value:string)=>referenceScopeName({scope:value},scopeLabels,item=>collaborationScopes[item]||item),[rows,setRows]=useState<WorkProject[]>([]),[detail,setDetail]=useState<ProjectDetail>(),[loadedKey,setLoadedKey]=useState(''),[loading,setLoading]=useState(true),[error,setError]=useState(''),[revision,refresh]=useState(0)
 const [query,setQuery]=useState(''),[archived,setArchived]=useState(false),[busy,setBusy]=useState(false),[discarded,setDiscarded]=useState(false)
 const [form,setForm]=useState<OpenDraft<FormDraft>|null>(null),[relations,setRelations]=useState<OpenDraft<RelationDraft<ProjectRelationsDraft>>|null>(null),[references,setReferences]=useState<OpenDraft<RelationDraft<ProjectReferencesDraft>>|null>(null),[archive,setArchive]=useState<WorkProject|null>(null)
 const [contextProject,setContextProject]=useState<string>()
 const key=scope+':'+(selectedId??''),current=loadedKey===key?detail:undefined
 const book=draftsFor(api),origin=JSON.stringify([scope,selectedId??null]),location=useRef({api,key}),mounted=useRef(true)
 location.current={api,key}
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false}},[])
 useEffect(()=>{setForm(null);setRelations(null);setReferences(null)},[api,key])
 useEffect(()=>{
  const opened=form??relations??references,pending=opened?.draft.pending
  if(!opened||opened.book!==book||opened.key!==origin||!pending)return
  let active=true
  void pending.then(()=>{if(active){refresh(n=>n+1);setForm(current=>current===form?null:current);setRelations(current=>current===relations?null:current);setReferences(current=>current===references?null:current)}},()=>{})
  return()=>{active=false}
 },[form,relations,references,book,origin])
 const sameLocation=()=>mounted.current&&location.current.api===api&&location.current.key===key
 const openForm=(initial:ProjectDefinition,project?:WorkProject)=>{let draft=book.forms.get(origin);if(!draft){draft={initial,value:{fields:initial,ack:false},...(project?{project}:{})};book.forms.set(origin,draft)}setForm({book,key:origin,draft})}
 const openRelations=(project:WorkProject)=>{let draft=book.relations.get(origin);if(!draft){draft={project,value:{kind:'task',query:'',selected:[]}};book.relations.set(origin,draft)}setRelations({book,key:origin,draft})}
 const openReferences=(project:WorkProject)=>{let draft=book.references.get(origin);if(!draft){draft={project,value:{scope:scopeLabels.find(label=>label.scope!==scope)?.scope??'',kind:'task',query:'',selected:[]}};book.references.set(origin,draft)}setReferences({book,key:origin,draft})}
 useEffect(()=>{
  let active=true;setLoading(true);setError('')
  const load=async()=>{if(selectedId){const value=await api.get(selectedId);if(value.project.scope!==scope)throw Error('项目不属于当前业务。');if(active){setDetail(value);setRows([])}}else{const value=await api.list(scope);if(active){setRows(value);setDetail(undefined)}}}
  void load().then(()=>{if(active){setLoadedKey(key);setLoading(false)}},e=>{if(active){setError(localizeWorkError(locale,e));setLoading(false)}})
  return()=>{active=false}
 },[api,scope,selectedId,revision,locale,key])
 useEffect(()=>{if(form||relations||references||archive||busy)return;const update=()=>{if(document.visibilityState==='visible')refresh(n=>n+1)};window.addEventListener('focus',update);const timer=setInterval(update,30000);return()=>{window.removeEventListener('focus',update);clearInterval(timer)}},[form,relations,references,archive,busy])
 const save=async(project:WorkProject,fields:ProjectDefinition)=>{await api.edit(project.id,project.version,fields);refresh(n=>n+1)}
 const action=async(run:()=>Promise<unknown>)=>{if(busy)return;setBusy(true);setError('');try{await run()}catch(e){setError(localizeWorkError(locale,e))}finally{setBusy(false)}}
 const pending=api.pendingFields(),shown=filterProjects(rows,query,archived)
 return <section className={css.workspace} aria-label={t('project.workspace.aria')}>
  {error&&<div className={css.error} role="alert">{error}<button type="button" disabled={busy} onClick={()=>refresh(n=>n+1)}>{t('project.refresh')}</button></div>}
  {selectedId&&!current&&!loading&&<button type="button" className={light.back} onClick={back}><ArrowLeft size={14} aria-hidden/>{t('project.back',{type:typeName})}</button>}
  {loading&&!current?<p role="status">{t('project.loading')}</p>:error&&loadedKey!==key?null:selectedId?current&&<ProjectDetailView conversations={api.runtime&&conversationActions?<ProjectConversations key={current.project.id} project={current.project} api={api} actions={conversationActions}/>:undefined} context={()=>setContextProject(current.project.id)} detail={current} busy={busy||loading} back={back} refresh={()=>refresh(n=>n+1)} edit={()=>openForm(projectFields(current.project),current.project)} add={()=>openRelations(current.project)} addReference={()=>openReferences(current.project)} changeState={state=>{if(state==='archived')setArchive(current.project);else void action(()=>save(current.project,projectFields(current.project,{state})))}} remove={item=>{void action(()=>save(current.project,removeProjectLink(current.project,item)))}} removeReference={ref=>{void action(()=>save(current.project,removeProjectReference(current.project,ref)))}} open={item=>{void action(async()=>{await openItem(item)})}} scopeName={scopeName}/>:
   <div className={css.directory}>
    <header><div><h2>{typeName}<span className={css.headCount}>{projectCopy(locale,'count').replace('{count}',String(shown.length))}</span></h2></div><button className={css.primary} type="button" disabled={busy||!!pending||!!api.recoveryError()} onClick={()=>openForm({scope,title:'',goal:'',dueDate:null,state:'planning',links:[],references:[]})}><Plus size={16}/>{t('project.create')}</button></header>
    {(pending||api.recoveryError())&&<div className={css.notice}><p>{t('project.pending')}</p><p>{t('recovery.nextStep')}</p>{pending&&<button type="button" disabled={busy} onClick={()=>void action(async()=>{const row=await api.recover();select(row.id,row.scope)})}>{t('project.recover')}</button>}<button type="button" disabled={busy} onClick={()=>{api.discard();setDiscarded(true);refresh(n=>n+1)}}>{t('recovery.discard')}</button></div>}
    {discarded&&<p role="status">{t('recovery.discarded')}</p>}
    <div className={css.toolbar}><input aria-label={t('project.search')} placeholder={t('project.search')} value={query} onChange={e=>setQuery(e.target.value)}/><select aria-label={t('project.filter')} value={archived?'archived':'current'} onChange={e=>setArchived(e.target.value==='archived')}><option value="current">{t('project.current')}</option><option value="archived">{t('project.state.archived')}</option></select><ToolbarIconButton label={t('project.refresh')} icon={RefreshCw} onClick={()=>refresh(n=>n+1)}/></div>
    {!shown.length?<div className={css.directoryEmpty}><FolderKanban size={27}/><h3>{t(query||archived?'project.noMatch':'project.empty.title')}</h3></div>:<div className={css.projectList}>{shown.map(project=><ProjectCard key={project.id} project={project} open={()=>select(project.id)}/>)}</div>}
   </div>}
  {current&&<ProjectContextPanel key={current.project.id} project={current.project} api={api} open={contextProject===current.project.id} close={()=>setContextProject(undefined)}/>}
  {form&&form.book===book&&form.key===origin&&<ProjectForm initial={form.draft.initial} draft={form.draft.value} changeDraft={value=>{form.draft.value=value}} pending={form.draft.pending} editing={!!form.draft.project} scopeName={scopeName(form.draft.initial.scope)} openTasks={current?projectProgress(current.summary).total-current.summary.completedTasks:0} close={()=>setForm(null)} save={async fields=>{await submitDraft(book.forms,form.key,form.draft,async()=>{if(form.draft.project)await api.edit(form.draft.project.id,form.draft.project.version,fields);else{const created=await api.create(fields);if(sameLocation())select(created.id,created.scope)}});if(sameLocation()){refresh(n=>n+1);setForm(current=>current===form?null:current)}}}/>}
  {relations&&relations.book===book&&relations.key===origin&&<ProjectRelations project={relations.draft.project} api={api} draft={relations.draft.value} changeDraft={value=>{relations.draft.value=value}} pending={relations.draft.pending} close={()=>setRelations(null)} save={async links=>{await submitDraft(book.relations,relations.key,relations.draft,async()=>{const project=relations.draft.project;await api.edit(project.id,project.version,projectFields(project,{links:[...project.links,...links]}))});if(sameLocation()){refresh(n=>n+1);setRelations(current=>current===relations?null:current)}}}/>}
  {references&&references.book===book&&references.key===origin&&<ProjectReferences project={references.draft.project} api={api} draft={references.draft.value} changeDraft={value=>{references.draft.value=value}} pending={references.draft.pending} scopeLabels={scopeLabels} scopeName={scopeName} close={()=>setReferences(null)} save={async added=>{await submitDraft(book.references,references.key,references.draft,async()=>{const project=references.draft.project;await api.edit(project.id,project.version,projectFields(project,{references:[...project.references,...added]}))});if(sameLocation()){refresh(n=>n+1);setReferences(current=>current===references?null:current)}}}/>}
  {archive&&<ProjectArchiveDialog close={()=>setArchive(null)} save={async()=>{await save(archive,projectFields(archive,{state:'archived'}));setArchive(null)}}/>}
 </section>
}

/** 1.0 项目卡（设计 23）：名称与状态同行，其下业务、目标摘要，底部截止日期与更新时间；业务内页签不显示业务名。 */
export function ProjectCard({project,scopeName,open}:{project:WorkProject;scopeName?:string|undefined;open:()=>void}){
 const {t,dateTime}=useI18n(),goal=projectGoalText(project)
 return <button type="button" className={css.projectCard} data-project-card={project.id} onClick={open}><span className={css.cardTitle}><strong>{project.title}</strong><small className={clsx(css.statePill,css['state_'+project.state])}>{t(projectStateKeys[project.state])}</small></span>{scopeName&&<span className={css.cardScope}>{scopeName}</span>}{goal&&<span className={css.cardGoal}>{goal}</span>}<span className={css.cardFoot}>{project.dueDate?<span className={css.due}><CalendarDays size={13}/>{project.dueDate}</span>:<span/>}<time dateTime={project.updatedAt}>{dateTime(project.updatedAt,{month:'numeric',day:'numeric'})}</time></span></button>
}

type DetailProps={conversations?:ReactNode;context?:()=>void;detail:ProjectDetail;busy:boolean;back:()=>void;refresh:()=>void;edit:()=>void;add:()=>void;addReference:()=>void;changeState:(state:ProjectDefinition['state'])=>void;remove:(item:ProjectItem)=>void;removeReference:(ref:ProjectReferenceItem)=>void;open:(item:ProjectItem|ProjectReferenceItem)=>void;scopeName:(scope:string)=>string}
export function ProjectDetailView({conversations,context,detail,busy,back,refresh,edit,add,addReference,changeState,remove,removeReference,open,scopeName}:DetailProps){
 const {t,locale,dateTime}=useI18n(),{project,items,summary,references}=detail,progress=projectProgress(summary),archived=project.state==='archived',attention=items.filter(item=>item.attention!==null)
 const linkedGroups=(detail.linkedGroups??[]).filter(group=>!items.some(item=>item.kind==='group'&&item.id===group.id))
 const fromGroup=t('project.group.originalLink')
 const linkedGroupRow=(item:ProjectReferenceItem)=><li key={'group-link:'+item.id}><div>{item.available?<button type="button" className={css.itemOpen} disabled={busy} onClick={()=>open(item)}>{item.title}</button>:<span>{t('project.item.unavailable')}</span>}<small>{scopeName(item.scope)} · {fromGroup}</small></div></li>
 const row=(item:ProjectItem)=><li key={item.kind+item.id}><div>{item.available?<button type="button" className={css.itemOpen} data-project-item={item.id} disabled={busy} onClick={()=>open(item)}>{item.title}</button>:<span>{t('project.item.unavailable')}</span>}<small>{item.state?t(projectItemStateKeys[item.state as keyof typeof projectItemStateKeys]):t('project.unavailableHint')}{item.origin!=='direct'&&<> · {t(item.origin==='automation'?'project.fromAutomation':'project.fromTask')}</>}{item.kind==='artifact'&&item.version!==null&&<> · v{item.version}</>}</small></div>{!archived&&item.origin==='direct'&&<ToolbarIconButton label={t('project.removeNamed',{name:item.title??t('project.item.unavailable')})} icon={X} data-project-remove={item.id} disabled={busy} onClick={()=>remove(item)}/>}</li>
 /** 关联分组：任务留在主栏，其余（协作群、员工、自动化、资料、成果）进右侧「关联」栏。 */
 const relationSection=(kind:typeof projectLinkKinds[number])=><section key={kind} className={css.relationSection} aria-label={t(projectKindKeys[kind])}><header><h3>{t(projectKindKeys[kind])}</h3><span>{items.filter(item=>item.kind===kind).length+(kind==='group'?linkedGroups.length:0)}</span></header>{items.some(item=>item.kind===kind)||kind==='group'&&linkedGroups.length?<ul>{items.filter(item=>item.kind===kind).map(row)}{kind==='group'&&linkedGroups.map(linkedGroupRow)}</ul>:<p className={css.muted}>{t('project.noneLinked')}</p>}</section>
 return <article className={css.detail}>
  <div className={css.detailToolbar}><button type="button" className={css.back} onClick={back}><ArrowLeft size={15}/>{t('project.directory')}</button><ToolbarIconButton label={t('project.refresh')} icon={RefreshCw} onClick={refresh} disabled={busy}/></div>
  <header className={css.detailHeader}><div><div className={css.titleRow}><h2>{project.title}</h2><span className={css.status}>{t(projectStateKeys[project.state])}</span></div>{projectGoalText(project)&&<p>{projectGoalText(project)}</p>}<span className={css.meta}><span>{scopeName(project.scope)}</span><span>{projectCopy(locale,'created').replace('{date}',dateTime(project.createdAt,{month:'numeric',day:'numeric'}))}</span>{project.dueDate&&<span><CalendarDays size={13}/>{t('project.dueDate')}: {project.dueDate}</span>}</span></div><div className={css.actions}>{context&&<ToolbarIconButton label={projectContextCopy(locale).title} icon={BookOpen} onClick={context}/>}{archived?<button type="button" disabled={busy} onClick={()=>changeState('running')}>{t('project.restore')}</button>:<><ToolbarIconButton label={t('project.edit')} icon={Pencil} data-project-edit disabled={busy} onClick={edit}/><ToolbarIconButton label={t('project.archive')} icon={Archive} disabled={busy} onClick={()=>changeState('archived')}/><button type="button" className={css.primary} disabled={busy} onClick={add}><Plus size={15}/>{t('project.add')}</button></>}</div></header>
  <div className={css.detailBody}><div className={css.detailMain}>
  {conversations}
  <dl className={css.metrics}><div><dt>{t('project.progress')}</dt><dd>{progress.percent===null?'—':progress.percent+'%'}<small>{t('project.progressCount',{done:progress.completed,total:progress.total})}</small></dd>{progress.total>0&&<progress max={progress.total} value={progress.completed} aria-label={t('project.progress')}/>}</div><div><dt>{t('task.table.attention')}</dt><dd>{summary.attentionTasks}</dd></div><div><dt>{t('project.artifacts')}</dt><dd>{items.filter(item=>item.kind==='artifact'&&item.available).length}</dd></div></dl>
  {attention.length>0&&<section className={css.attention}><h3>{t('task.table.attention')}</h3><ul>{attention.map(row)}</ul></section>}
  {relationSection('task')}
  </div><aside className={css.relationRail} aria-label={projectCopy(locale,'related')}><h3 className={css.railTitle}>{projectCopy(locale,'related')}</h3>{projectLinkKinds.filter(kind=>kind!=='task').map(relationSection)}
   <section className={css.relationSection+' '+css.references} aria-label={t('project.references')} data-project-references="">
    <header><h3>{t('project.references')}</h3><span>{references.length}</span>{!archived&&<button type="button" data-project-reference-add="" disabled={busy} onClick={addReference}><Plus size={15}/>{t('project.reference.add')}</button>}</header>
    <p className={css.muted}>{t('project.reference.hint')}</p>
    {references.length?<ul>{references.map(ref=><li key={ref.scope+ref.kind+ref.id}><div>{ref.available?<button type="button" className={css.itemOpen} data-project-reference={ref.id} disabled={busy} onClick={()=>open(ref)}>{ref.title}</button>:<span>{t('project.item.unavailable')}</span>}<small><span className={css.referenceBadge}>{scopeName(ref.scope)}</span> · {t(projectKindKeys[ref.kind])} · <span className={css.referenceBadge}>{t('project.reference.readonly')}</span>{ref.available?ref.state&&<> · {t(projectItemStateKeys[ref.state as keyof typeof projectItemStateKeys])}</>:<> · {t('project.reference.unavailableHint')}</>}</small></div>{!archived&&<button type="button" data-project-reference-remove={ref.id} className={css.remove} disabled={busy} aria-label={t('project.removeNamed',{name:ref.title??t('project.item.unavailable')})} onClick={()=>removeReference(ref)}>{t('project.reference.remove')}</button>}</li>)}</ul>:<p className={css.muted}>{t('project.reference.empty')}</p>}
   </section>
  </aside></div>
 </article>
}

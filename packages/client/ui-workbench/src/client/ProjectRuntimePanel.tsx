import {useEffect,useRef,useState,type ReactNode} from 'react'
import {ChevronDown,FileText,Link2,MessageCirclePlus,RefreshCw,Search,Unlink} from 'lucide-react'
import {ToolbarIconButton} from './ToolbarIconButton.js'
import type {ProjectContextEntry,ProjectContextShare,ProjectItem,WorkProject} from '@teloa/contract'
import type {ProjectApi} from './project-api.js'
import type {ProjectConversationBinding,ProjectConversationCandidate,ProjectMemoryMode,ProjectRuntimeCandidate,ProjectRuntimeFailure,ProjectRuntimeSettings,ProjectRuntimeUse} from './project-runtime-api.js'
import {projectExtractionFailureText,projectRuntimeCopy} from './project-runtime-copy.js'
import {ContextDrawer} from './ContextDrawer.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import css from './ProjectRuntimePanel.module.css'
import {ProjectPersonalPreferences} from './ProjectPersonalPreferences.js'

const contextTabs=['settings','candidates','uses','history'] as const

export type ProjectConversationActions={create:(project:WorkProject,memoryMode:ProjectMemoryMode,title:string,description?:string)=>Promise<void|boolean>;open:(sessionId:string)=>Promise<void>}

export function ProjectRuntimePanel({project,api,open,sessionId,contextVersion,contextChanged,children}:{project:WorkProject;api:ProjectApi;open:boolean;sessionId?:string|undefined;contextVersion?:number|undefined;contextChanged?:()=>void;children?:ReactNode}){
 const {locale,t}=useI18n(),copy=projectRuntimeCopy(locale),runtime=api.runtime
 const [settings,setSettings]=useState<ProjectRuntimeSettings>(),[draft,setDraft]=useState(()=>runtime?.draft(project.id)),[resources,setResources]=useState<ProjectItem[]>([]),[candidates,setCandidates]=useState<ProjectRuntimeCandidate[]>([]),[uses,setUses]=useState<ProjectRuntimeUse[]>([]),[failures,setFailures]=useState<ProjectRuntimeFailure[]>([])
 const [tab,setTab]=useState<typeof contextTabs[number]>('settings'),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[errors,setErrors]=useState<Partial<Record<'settings'|'resources'|'candidates'|'uses'|'failures'|'action',string>>>({}),[notice,setNotice]=useState(''),[revision,refresh]=useState(0)
 const [history,setHistory]=useState<{entries:ProjectContextEntry[];shares:ProjectContextShare[];nextCursor:string|null}>(),[historyBusy,setHistoryBusy]=useState(false),[historyError,setHistoryError]=useState('')
 const [query,setQuery]=useState(''),[configurationOpen,setConfigurationOpen]=useState(false),[searching,setSearching]=useState(false),[resourceRevision,refreshResources]=useState(0)
 const [metadata,setMetadata]=useState<Record<string,{sourceTitle?:string;updatedAt:string}>>({})
 useEffect(()=>{
  if(!runtime||!open)return
  let active=true;setLoading(true)
  const jobs=[runtime.settings(project.id),api.candidates(project.scope,'resource',''),runtime.candidates(project.id),runtime.uses(project.id,sessionId),runtime.failures(project.id)] as const
  void Promise.allSettled(jobs).then(results=>{
   if(!active)return
   const [s,r,c,u,f]=results,next:typeof errors={}
   if(s.status==='fulfilled')setSettings(s.value);else{setSettings(undefined);next.settings=localizeWorkError(locale,s.reason)}
   if(r.status==='fulfilled'){setResources(r.value);refreshResources(n=>n+1)}else{setResources([]);next.resources=copy.readError}
   if(c.status==='fulfilled')setCandidates(c.value);else{setCandidates([]);next.candidates=localizeWorkError(locale,c.reason)}
   if(u.status==='fulfilled')setUses(u.value);else{setUses([]);next.uses=localizeWorkError(locale,u.reason)}
   if(f.status==='fulfilled')setFailures(f.value);else{setFailures([]);next.failures=localizeWorkError(locale,f.reason)}
   setErrors(next);setLoading(false)
  })
  return()=>{active=false}
 },[runtime,api,project.id,project.scope,open,revision,locale,sessionId])
 useEffect(()=>{
  if(!open||!api.materialMetadata)return
  let active=true;setMetadata({})
  void api.materialMetadata(project.scope).then(value=>{if(active)setMetadata(value)},()=>{})
  return()=>{active=false}
 },[api,open,project.id,project.scope,revision])
 useEffect(()=>{
  if(!open||!query.trim()){setSearching(false);return}
  let active=true;setSearching(true)
  const timer=setTimeout(()=>{void api.candidates(project.scope,'resource',query.trim()).then(rows=>{
   if(!active)return
   setSearching(false)
   setResources(old=>[...new Map([...old,...rows].map(row=>[row.id,row])).values()])
   setErrors(old=>{const {resources:_,...rest}=old;return rest})
  },()=>{if(active){setSearching(false);setErrors(old=>({...old,resources:copy.readError}))}})},250)
  return()=>{active=false;clearTimeout(timer)}
 },[api,open,project.id,project.scope,query,copy.readError,resourceRevision])
 if(!runtime)return null
 const loadHistory=async(cursor:string|null=null)=>{if(historyBusy)return;setHistoryBusy(true);setHistoryError('');try{const result=await runtime.history({projectId:project.id,cursor,limit:50});setHistory(old=>cursor&&old?{entries:[...old.entries,...result.entries.filter(row=>!old.entries.some(value=>value.id===row.id))],shares:[...old.shares,...result.shares.filter(row=>!old.shares.some(value=>value.id===row.id))],nextCursor:result.nextCursor}:result)}catch(error){setHistoryError(localizeWorkError(locale,error))}finally{setHistoryBusy(false)}}
 const selectTab=(next:typeof contextTabs[number])=>{setTab(next);if(next==='history'&&!history)void loadHistory()}
 const pending=runtime.pending(project.id),blocked=busy||loading||!!pending||!!runtime.recoveryError(),value=draft??settings,archived=project.state==='archived'
 const update=(next:ProjectRuntimeSettings|undefined)=>{try{runtime.setDraft(project.id,next);setDraft(next);setErrors(old=>{const {action:_,...rest}=old;return rest});setNotice('')}catch(error){setErrors(old=>({...old,action:localizeWorkError(locale,error)}))}}
 const act=async(run:()=>Promise<unknown>,saved=false,changed=false,retrying=false)=>{if(busy)return;setBusy(true);setNotice('');try{await run();setDraft(runtime.draft(project.id));setErrors({});if(saved)setNotice(copy.saved);else if(retrying)setNotice(copy.retryQueued);if(changed)contextChanged?.();refresh(n=>n+1)}catch(error){const changedRetry=retrying&&error&&typeof error==='object'&&'rejected'in error&&error.rejected===true&&'code'in error&&error.code==='teloa/conflict';setErrors(old=>({...old,action:changedRetry?copy.retryChanged:localizeWorkError(locale,error)}))}finally{setBusy(false)}}
 const discard=()=>{if(busy)return;setNotice('');try{const had=runtime.discard(project.id);setDraft(runtime.draft(project.id));setErrors({});if(had)setNotice(t('recovery.discarded'));refresh(n=>n+1)}catch(error){setErrors(old=>({...old,action:localizeWorkError(locale,error)}))}}
 const selected=new Map(value?.resources.map(row=>[row.resourceId,row])??[]),available=new Map(resources.map(row=>[row.id,row])),materialIds=[...new Set([...available.keys(),...selected.keys()])]
 const needle=query.trim().toLocaleLowerCase(locale),visibleMaterials=materialIds.filter(id=>!needle||[available.get(id)?.title,metadata[id]?.sourceTitle].some(text=>text?.toLocaleLowerCase(locale).includes(needle)))
 const sourceNames={project:copy.sourceProject,brief:copy.sourceBrief,rule:copy.sourceRule,memory:copy.sourceMemory,share:copy.sourceShare,resource:copy.sourceResource,personal:copy.sourcePersonal,role:copy.sourceRole}
 const evidenceNames={decision:copy.evidenceDecision,rule:copy.evidenceRule,verified:copy.evidenceVerified,untrusted:copy.evidenceUntrusted,assistant:copy.evidenceAssistant}
 return <section className={css.panel} aria-label={copy.settings}>
  <nav className={css.tabs} aria-label={copy.title}>{contextTabs.map(key=><button key={key} type="button" aria-pressed={tab===key} onKeyDown={event=>{const keys=contextTabs,index=keys.indexOf(key);let next:number|undefined;if(event.key==='ArrowRight')next=(index+1)%keys.length;else if(event.key==='ArrowLeft')next=(index+keys.length-1)%keys.length;else if(event.key==='Home')next=0;else if(event.key==='End')next=keys.length-1;if(next!==undefined){event.preventDefault();selectTab(keys[next]!);(event.currentTarget.parentElement?.children[next] as HTMLElement|undefined)?.focus()}}} onClick={()=>selectTab(key)}>{copy[key]}{key==='candidates'&&candidates.length>0&&<small aria-hidden="true">{candidates.length}</small>}</button>)}<button className={css.refresh} type="button" aria-label={copy.refresh} title={copy.refresh} disabled={busy||historyBusy} onClick={()=>{refresh(n=>n+1);contextChanged?.();if(tab==='history')void loadHistory()}}><RefreshCw size={15}/></button></nav>
  {errors.action&&<p role="alert">{errors.action}</p>}{notice&&<p role="status">{notice}</p>}
  {!!runtime.recoveryError()&&<p role="alert">{copy.readError} {t('recovery.nextStep')}</p>}
  {pending&&<div className={css.notice}><p>{copy.pending}</p><button type="button" disabled={busy||!!runtime.recoveryError()} onClick={()=>void act(()=>runtime.recover(project.id),pending.endpoint==='configure',false,pending.endpoint==='retry')}>{copy.recover}</button></div>}
  {(pending||!!runtime.recoveryError())&&<button type="button" disabled={busy} onClick={discard}>{t('recovery.discard')}</button>}
  {loading&&<p role="status">{copy.loading}</p>}
  {tab==='settings'&&<>
   {children}
   {errors.settings&&<p role="alert">{errors.settings}<button type="button" disabled={busy} onClick={()=>refresh(n=>n+1)}>{copy.retry}</button></p>}
   {value&&<form className={css.form} onSubmit={event=>{event.preventDefault();void act(()=>runtime.configure(value),true)}}>
    <details className={css.configuration} open={configurationOpen} onToggle={event=>setConfigurationOpen(event.currentTarget.open)}><summary><span>{copy.configuration}</span><small>{copy[value.automatic]}</small><ChevronDown size={15}/></summary><div className={css.configurationBody}>
    <div className={css.settingRow}><label htmlFor={'project-learning-'+project.id}>{copy.automatic}</label><select id={'project-learning-'+project.id} aria-label={copy.automatic} value={value.automatic} disabled={blocked||archived} onChange={event=>update({...value,automatic:event.target.value as ProjectRuntimeSettings['automatic']})}><option value="decisions">{copy.decisions}</option><option value="verified">{copy.verified}</option><option value="paused">{copy.paused}</option></select></div>
    <p className={css.hint}>{copy.automaticHint}</p>
    <div className={css.settingRow}><label className={css.check}><input type="checkbox" checked={value.readPersonal} disabled={blocked||archived} onChange={event=>update({...value,readPersonal:event.target.checked})}/><span>{copy.readPersonal}</span></label><ProjectPersonalPreferences api={runtime} changed={()=>refresh(n=>n+1)}/></div><p className={css.hint}>{copy.personalHint}</p>
    </div></details>
    <section className={css.materials} aria-label={copy.materials}><header><h3>{copy.materials}</h3><small>{copy.selectedCount.replace('{count}',String(selected.size))}</small></header>
    <label className={css.search}><Search size={16} aria-hidden="true"/><input type="search" aria-label={copy.searchMaterials} placeholder={copy.searchMaterials} maxLength={120} value={query} onChange={event=>setQuery(event.target.value)}/></label>
    {errors.resources&&<p role="alert">{errors.resources}</p>}{!materialIds.length&&!searching&&<p className={css.hint}>{copy.noMaterials}</p>}{searching&&!visibleMaterials.length?<p className={css.hint} role="status">{copy.loading}</p>:materialIds.length>0&&!visibleMaterials.length&&<p className={css.hint}>{copy.noMatches}</p>}<div className={css.materialList} aria-busy={searching}>{visibleMaterials.map(id=>{
     const item=available.get(id),chosen=selected.get(id)
     const detail=metadata[id],caption=[detail?.sourceTitle,item?.version?'v'+item.version:null,detail?.updatedAt?new Intl.DateTimeFormat(locale,{dateStyle:'medium',timeStyle:'short'}).format(new Date(detail.updatedAt)):null].filter(Boolean).join(' · ')
     return <div key={id} className={css.material}><label className={css.check}><input type="checkbox" aria-label={item?.title??copy.unavailable} aria-describedby={'project-material-'+project.id+'-'+id} checked={!!chosen} disabled={blocked||archived||(!item?.available&&!chosen)} onChange={event=>update({...value,resources:event.target.checked?[...value.resources,{resourceId:id,required:false}]:value.resources.filter(row=>row.resourceId!==id)})}/><FileText size={17} aria-hidden="true"/><span className={css.materialName}><span>{item?.title??copy.unavailable}</span><small id={'project-material-'+project.id+'-'+id} title={caption}>{caption}</small></span></label>{chosen&&<label className={css.required}><input type="checkbox" checked={chosen.required} disabled={blocked||archived} onChange={event=>update({...value,resources:value.resources.map(row=>row.resourceId===id?{...row,required:event.target.checked}:row)})}/>{copy.required}</label>}</div>
    })}</div></section>
    {draft&&settings&&draft.version!==settings.version&&<div className={css.notice}><p>{copy.stale}</p><button type="button" disabled={blocked} onClick={()=>update({...draft,version:settings.version})}>{copy.rebase}</button></div>}
    {draft&&<footer><button type="button" disabled={busy||!!pending} onClick={()=>update(undefined)}>{copy.cancel}</button><button type="submit" disabled={blocked||archived||!settings||draft.version!==settings.version}>{copy.save}</button></footer>}
   </form>}
  </>}
  {tab==='candidates'&&<>{errors.candidates?<p role="alert">{errors.candidates}</p>:<>{!loading&&!candidates.length&&<p className={css.hint}>{copy.noCandidates}</p>}{candidates.map(candidate=><article key={candidate.id} className={css.entry}><header><strong>{candidate.topic}</strong><small>{copy[candidate.status==='conflict'?'conflict':'candidate']}</small></header><p>{candidate.markdown}</p><p className={css.hint}>{copy.candidateHint}</p>{!!candidate.evidence?.length&&<details className={css.evidence}><summary>{copy.originalEvidence}</summary>{candidate.source&&<p className={css.hint}>{copy.evidenceSource}</p>}{candidate.evidence.map((evidence,index)=><section key={index}><small>{evidenceNames[evidence.kind]}</small><p>{evidence.text}</p></section>)}</details>}<div className={css.actions}><button type="button" disabled={blocked||archived||contextVersion===undefined} onClick={()=>void act(()=>runtime.resolve(project.id,candidate.id,contextVersion!,'accept'),false,true)}>{copy.accept}</button><button type="button" disabled={blocked||contextVersion===undefined} onClick={()=>void act(()=>runtime.resolve(project.id,candidate.id,contextVersion!,'reject'),false,true)}>{copy.reject}</button></div></article>)}</>}
   {errors.failures&&<p role="alert">{errors.failures}</p>}{failures.length>0&&<section aria-label={copy.failures}><h3>{copy.failures}</h3>{failures.map(failure=><article key={failure.eventId} className={css.entry}><strong>{copy.failureTitle}</strong><p>{projectExtractionFailureText(locale,failure.errorCode)}</p>{(settings?.automatic==='paused'||!failure.canRetry)&&<p className={css.hint}>{settings?.automatic==='paused'?copy.retryPaused:copy.retryUnavailable}</p>}<button type="button" disabled={blocked||archived||!settings||settings.automatic==='paused'||!failure.canRetry} onClick={()=>void act(()=>runtime.retry(project.id,failure.eventId),false,false,true)}>{copy.retryExtraction}</button></article>)}</section>}
  </>}
  {tab==='uses'&&<>{errors.uses?<p role="alert">{errors.uses}</p>:<>{!loading&&!uses.length&&<p className={css.hint}>{copy.noUses}</p>}{uses.map(use=><article key={use.id} className={css.entry}><header><strong>{new Intl.DateTimeFormat(locale,{dateStyle:'medium',timeStyle:'short'}).format(new Date(use.createdAt))}</strong><small>{use.memoryMode==='off'?copy.off:copy.enabled}</small></header><p className={css.hint}>{copy.usedSources}</p><ul>{use.sources.map((source,index)=><li key={source.kind+source.id+index}><span className={css.source}><span>{source.title}</span><small>v{source.version}</small></span><small>{sourceNames[source.kind]}</small></li>)}</ul>{use.omitted.length>0&&<p className={css.hint}>{copy.omitted}</p>}</article>)}</>}</>}
  {tab==='history'&&<>{historyError&&<p role="alert">{historyError}</p>}{historyBusy&&<p role="status">{copy.loading}</p>}{history&&!history.entries.length&&!history.shares.length&&<p className={css.hint}>{copy.noHistory}</p>}{history?.entries.map(entry=><article className={css.entry} key={'entry:'+entry.id}><header><strong>{entry.topic}</strong><small>v{entry.version} · {entry.state==='withdrawn'?copy.withdrawn:entry.kind==='rule'?copy.sourceRule:copy.sourceMemory}</small></header>{entry.markdown!==null&&<p>{entry.markdown}</p>}</article>)}{history?.shares.map(share=><article className={css.entry} key={'share:'+share.id}><header><strong>{share.topic??copy.shared}</strong><small>v{share.entryVersion} · {share.status==='revoked'?copy.revoked:share.status==='withdrawn'?copy.withdrawn:share.status==='unavailable'?copy.unavailable:copy.shared}</small></header>{share.markdown!==null&&<p>{share.markdown}</p>}</article>)}{history?.nextCursor&&<button type="button" disabled={historyBusy} onClick={()=>void loadHistory(history.nextCursor)}>{copy.moreHistory}</button>}</>}
 </section>
}

type ConversationDraft={title:string;description:string;memoryMode:ProjectMemoryMode;titleEdited:boolean}
// 未提交内容只属于原API与项目；关闭抽屉保留，换连接不迁移。
const conversationDrafts=new WeakMap<ProjectApi,Map<string,ConversationDraft>>()
function conversationTitle(value:string){
 const line=value.split(/\r?\n/).map(row=>row.trim()).find(row=>row&&!/^[#*\-_=\s]+$/.test(row))??''
 return line.replace(/^#{1,6}\s+/,'').replace(/^(?:[-*+]\s+|\d+[.)]\s+)/,'').slice(0,120).replace(/[\uD800-\uDBFF]$/,'')
}
export function ProjectConversations(props:{project:WorkProject;api:ProjectApi;actions:ProjectConversationActions}){
 const {project,api}=props,origin=useRef({api,runtime:api.runtime,id:project.id,scope:project.scope,version:project.version,key:0})
 const old=origin.current
 if(old.api!==api||old.runtime!==api.runtime||old.id!==project.id||old.scope!==project.scope||old.version!==project.version)origin.current={api,runtime:api.runtime,id:project.id,scope:project.scope,version:project.version,key:old.key+1}
 return <ProjectConversationScope key={origin.current.key} {...props}/>
}
function ProjectConversationScope({project,api,actions}:{project:WorkProject;api:ProjectApi;actions:ProjectConversationActions}){
 const {locale,t}=useI18n(),copy=projectRuntimeCopy(locale),runtime=api.runtime,active=useRef(true)
 useEffect(()=>{active.current=true;return()=>{active.current=false}},[])
 const key=project.id+':'+project.scope
 const drafts=conversationDrafts.get(api)??new Map<string,ConversationDraft>()
 if(!conversationDrafts.has(api))conversationDrafts.set(api,drafts)
 const creation=runtime?.creation(project.id)
 const [draft,setDraft]=useState<ConversationDraft>(()=>creation?{title:creation.title,description:creation.preparation?.text??'',memoryMode:creation.memoryMode,titleEdited:true}:drafts.get(key)??{title:'',description:'',memoryMode:'enabled',titleEdited:false})
 const changeDraft=(next:ConversationDraft)=>{drafts.set(key,next);setDraft(next)}
 const [rows,setRows]=useState<ProjectConversationBinding[]>([]),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[revision,refresh]=useState(0),[editor,setEditor]=useState<'create'|'join'>(),[removing,setRemoving]=useState<ProjectConversationBinding>()
 const [memoryMode,setMemoryMode]=useState<ProjectMemoryMode>('enabled'),[eligible,setEligible]=useState<ProjectConversationCandidate[]>([]),[selection,setSelection]=useState('')
 useEffect(()=>{if(!runtime)return;let current=true;setLoading(true);void runtime.members(project.id).then(value=>{if(current){setRows(value);setError('');setLoading(false)}},cause=>{if(current){setRows([]);setError(localizeWorkError(locale,cause));setLoading(false)}});return()=>{current=false}},[runtime,project.id,revision,locale])
 if(!runtime)return null
 const pending=runtime.pending(project.id),archived=project.state==='archived',blocked=busy||loading||!!pending||!!runtime.recoveryError()
 const act=async(run:()=>Promise<unknown>,creating=false)=>{if(busy||!active.current)return;setBusy(true);setError('');try{
  const accepted=await run()
  if(accepted===false)return
  if(creating)drafts.delete(key)
  if(active.current){if(creating)setDraft({title:'',description:'',memoryMode:'enabled',titleEdited:false});setEditor(undefined);setRemoving(undefined);refresh(n=>n+1)}
 }catch(cause){if(active.current)setError(localizeWorkError(locale,cause))}finally{if(active.current)setBusy(false)}}
 const create=()=>actions.create(project,creation?.memoryMode??draft.memoryMode,creation?.title??draft.title,creation?creation.preparation?.text:draft.description)
 const discard=()=>{if(busy)return;setNotice('');try{if(runtime.discard(project.id)){setError('');setNotice(t('recovery.discarded'));refresh(n=>n+1)}}catch(cause){setError(localizeWorkError(locale,cause))}}
 // 旧预约与最新项目冲突时由本人取回原稿：只结束本次读到的预约，不动已建会话与绑定，也不代为再次提交。
 const reprepare=()=>{
  const captured=creation
  if(blocked||!active.current||!captured?.preparation)return
  const current=runtime.creation(project.id)
  if(current?.requestId!==captured.requestId||!current.preparation){refresh(n=>n+1);return}
  const next:ConversationDraft={title:current.title,description:current.preparation.text,memoryMode:current.memoryMode,titleEdited:true}
  try{runtime.completeCreation(project.id,current.requestId);if(runtime.creation(project.id)?.requestId===current.requestId)throw Error(copy.stale)}catch(cause){setError(localizeWorkError(locale,cause));return}
  changeDraft(next);setError('');setEditor('create')
 }
 const join=async()=>{setBusy(true);setError('');try{const rows=await runtime.conversations(project.id);if(active.current){setEligible(rows);setSelection('');setMemoryMode('enabled');setEditor('join')}}catch(cause){if(active.current)setError(localizeWorkError(locale,cause))}finally{if(active.current)setBusy(false)}}
 const chooseExisting=async(sessionId:string)=>{setSelection(sessionId);if(!sessionId)return;setBusy(true);setError('');try{const binding=await runtime.binding(sessionId),candidate=eligible.find(row=>row.sessionId===sessionId);if(!active.current)return;if(!candidate||(binding?.version??0)!==candidate.bindingVersion)throw Error(copy.stale);setMemoryMode(binding?.memoryMode??'enabled')}catch(cause){if(active.current){setSelection('');setError(localizeWorkError(locale,cause))}}finally{if(active.current)setBusy(false)}}
 const legacy=!!creation&&!creation.preparation,chosenMemory=editor==='create'?draft.memoryMode:memoryMode
 return <section className={css.conversations} aria-label={copy.conversations}>
  <header><h3>{copy.conversations}</h3><div className={css.actions}>{!archived&&<><ToolbarIconButton label={copy.newConversation} icon={MessageCirclePlus} disabled={blocked} onClick={()=>{if(creation)setDraft({title:creation.title,description:creation.preparation?.text??'',memoryMode:creation.memoryMode,titleEdited:true});setEditor('create')}}/><ToolbarIconButton label={copy.join} icon={Link2} disabled={blocked||!!creation} onClick={()=>void join()}/></>}<ToolbarIconButton label={copy.refresh} icon={RefreshCw} disabled={busy} onClick={()=>refresh(n=>n+1)}/></div></header>
  {error&&<p role="alert">{error}</p>}{loading&&<p role="status">{copy.loading}</p>}
  {notice&&<p role="status">{notice}</p>}{!!runtime.recoveryError()&&<p role="alert">{copy.readError} {t('recovery.nextStep')}</p>}
  {pending&&<div className={css.notice}><p>{copy.pending}</p><button type="button" disabled={busy||!!runtime.recoveryError()} onClick={()=>void act(()=>runtime.recover(project.id))}>{copy.recover}</button></div>}
  {(pending||!!runtime.recoveryError())&&<button type="button" disabled={busy} onClick={discard}>{t('recovery.discard')}</button>}
  {creation&&!editor&&<div className={css.notice}><p>{copy.creationPending}</p><button type="button" disabled={busy} onClick={()=>void act(create,true)}>{copy.recover}</button>{creation.preparation&&<button type="button" disabled={blocked} onClick={reprepare}>{copy.reprepare}</button>}</div>}
  {!loading&&!error&&!rows.length&&<p className={css.hint}>{archived?copy.archived:copy.emptyConversations}</p>}
  {rows.map(row=><div key={row.sessionId} className={css.conversationRow}><div><button type="button" title={copy.open} disabled={busy} onClick={()=>void act(()=>actions.open(row.sessionId))}>{row.title}</button><small>{row.memoryMode==='off'?copy.off:copy.enabled}</small></div>{!archived&&<ToolbarIconButton label={copy.remove} icon={Unlink} disabled={blocked} onClick={()=>setRemoving(row)}/>}</div>)}
  {editor&&<ContextDrawer title={editor==='create'?copy.newConversation:copy.join} close={()=>setEditor(undefined)} canClose={!busy}><div className={css.dialogBody}><form className={css.form} onSubmit={event=>{event.preventDefault();if(editor==='create')void act(create,true);else{const row=eligible.find(value=>value.sessionId===selection);if(row)void act(()=>runtime.bind({sessionId:row.sessionId,projectId:project.id,expectedVersion:row.bindingVersion,memoryMode}))}}}>
   {error&&<p role="alert">{error}</p>}
   {editor==='create'?<>
    <p className={css.workContext}>{project.title}</p>
    {!legacy&&<><label>{copy.workDescription}<textarea className={css.workDescription} aria-label={copy.workDescription} required maxLength={8000} rows={8} placeholder={copy.workExample} value={draft.description} disabled={busy||!!creation} onChange={event=>changeDraft({...draft,description:event.target.value,...(!draft.titleEdited?{title:conversationTitle(event.target.value)}:{})})}/></label><p className={css.hint}>{copy.workHint}</p></>}
    {(draft.description.trim()||legacy)&&<label className={css.proposedTopic}>{copy.conversationTitle}<input aria-label={copy.conversationTitle} required maxLength={200} value={draft.title} disabled={busy||!!creation} onChange={event=>changeDraft({...draft,title:event.target.value,titleEdited:true})}/></label>}
   </>:<label>{copy.chooseConversation}<select aria-label={copy.chooseConversation} required value={selection} disabled={busy} onChange={event=>void chooseExisting(event.target.value)}><option value="">{copy.chooseConversation}</option>{eligible.map(row=><option key={row.sessionId} value={row.sessionId}>{row.title}</option>)}</select>{!eligible.length&&<p className={css.hint}>{copy.noEligible}</p>}</label>}
   <label>{copy.memoryMode}<select aria-label={copy.memoryMode} value={chosenMemory} disabled={busy||!!creation||editor==='join'} onChange={event=>changeDraft({...draft,memoryMode:event.target.value as ProjectMemoryMode})}><option value="enabled">{copy.enabled}</option><option value="off">{copy.off}</option></select></label>{chosenMemory==='off'&&<p className={css.hint}>{copy.offHint}</p>}
   <footer><button type="button" disabled={busy} onClick={()=>setEditor(undefined)}>{copy.dismiss}</button><button type="submit" disabled={busy||(editor==='create'?!draft.title.trim()||!legacy&&!draft.description.trim():!selection)}>{editor==='create'?copy.create:copy.join}</button></footer>
  </form></div></ContextDrawer>}
  {removing&&<ContextDrawer title={copy.remove} close={()=>setRemoving(undefined)} canClose={!busy}><div className={css.dialogBody+' '+css.panel}><strong>{removing.title}</strong><p>{copy.removeHint}</p>{error&&<p role="alert">{error}</p>}<div className={css.actions}><button type="button" disabled={busy} onClick={()=>setRemoving(undefined)}>{copy.cancel}</button><button type="button" disabled={busy} onClick={()=>void act(()=>runtime.bind({sessionId:removing.sessionId,projectId:null,expectedVersion:removing.version,memoryMode:removing.memoryMode},project.id))}>{copy.remove}</button></div></div></ContextDrawer>}
 </section>
}

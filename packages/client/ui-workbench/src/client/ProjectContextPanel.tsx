import {useEffect,useRef,useState} from 'react'
import {ArrowLeft,BookmarkPlus,ChevronDown} from 'lucide-react'
import type {ProjectContextChange,ProjectContextDetail,ProjectContextEntry,ProjectContextShare,WorkProject} from '@teloa/contract'
import type {ProjectApi} from './project-api.js'
import type {ProjectContextDraft} from './project-context-api.js'
import {ContextDrawer} from './ContextDrawer.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import {projectContextCopy} from './project-context-copy.js'
import css from './ProjectContextPanel.module.css'
import {ProjectRuntimePanel} from './ProjectRuntimePanel.js'
import {projectRuntimeCopy} from './project-runtime-copy.js'
import {ToolbarIconButton} from './ToolbarIconButton.js'

type Props={project:WorkProject;api:ProjectApi;open:boolean;close:()=>void;sessionId?:string|undefined}
export function ProjectContextPanel(props:Props){
 const {api,project}=props,origin=useRef({api,context:api.context,runtime:api.runtime,id:project.id,scope:project.scope,key:0})
 const old=origin.current
 if(old.api!==api||old.context!==api.context||old.runtime!==api.runtime||old.id!==project.id||old.scope!==project.scope)origin.current={api,context:api.context,runtime:api.runtime,id:project.id,scope:project.scope,key:old.key+1}
 return <ProjectContextScope key={origin.current.key} {...props}/>
}
function ProjectContextScope({project,api,open,close,sessionId}:Props){
 const {locale,t}=useI18n(),copy=projectContextCopy(locale),context=api.context
 const personal=api.runtime?.personal,mounted=useRef(true),adopting=useRef<object>()
 const origin=useRef({api,personal,projectId:project.id,version:project.version,open,token:{}})
 if(origin.current.api!==api||origin.current.personal!==personal||origin.current.projectId!==project.id||origin.current.version!==project.version||origin.current.open!==open)origin.current={api,personal,projectId:project.id,version:project.version,open,token:{}}
 const token=origin.current.token
 const [adoption,setAdoption]=useState<{origin:object;busy:boolean;error?:string;notice?:string}>()
 const currentAdoption=adoption?.origin===token?adoption:undefined,adoptionBusy=!!currentAdoption?.busy,personalBlocked=!!personal?.pending()||!!personal?.recoveryError()
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false}},[])
 const [data,setData]=useState<ProjectContextDetail>(),[draft,setDraft]=useState<ProjectContextDraft|undefined>(()=>context.draft(project.id)),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[loading,setLoading]=useState(true),[revision,refresh]=useState(0)
 const [sharing,setSharing]=useState<ProjectContextEntry>(),[targets,setTargets]=useState<WorkProject[]>([]),[target,setTarget]=useState(''),[withdrawing,setWithdrawing]=useState<ProjectContextEntry>()
 const [upgrading,setUpgrading]=useState<{share:ProjectContextShare;current:ProjectContextEntry}>()
 const comparisonPanel=useRef<HTMLElement>(null),comparisonOrigin=useRef<HTMLButtonElement|null>(null),savedContext=useRef<HTMLDivElement>(null)
 const restoreAfterLoad=useRef<{context:ProjectApi['context'];projectId:string}|null>(null)
 useEffect(()=>{if(upgrading)comparisonPanel.current?.focus()},[upgrading])
 const closeComparison=()=>{setUpgrading(undefined);requestAnimationFrame(()=>{if(comparisonOrigin.current?.isConnected)comparisonOrigin.current.focus();else savedContext.current?.focus()})}
 const archived=project.state==='archived',pending=context.pending(project.id),blocked=busy||loading||pending||!!context.recoveryError()
 useEffect(()=>{
  if(!open)return
  let active=true;setLoading(true);setError('')
  void context.get(project.id).then(result=>{if(active){setData(result);setLoading(false)}},e=>{if(active){setData(undefined);setLoading(false);setError(localizeWorkError(locale,e))}})
  return()=>{active=false}
 },[context,project.id,open,revision,locale])
 useEffect(()=>{
  const restore=restoreAfterLoad.current
  if(!restore)return
  if(!open||restore.context!==context||restore.projectId!==project.id){restoreAfterLoad.current=null;return}
  if(loading||!data||!savedContext.current)return
  savedContext.current.focus();restoreAfterLoad.current=null
 },[open,context,project.id,loading,data])
 useEffect(()=>{
  if(!open||busy)return
  let active=true
  // 背景核对只更新已保存快照，编辑期间也处理撤回；不卸载表单或移动焦点。
  const update=()=>{if(document.visibilityState==='visible')void context.get(project.id).then(value=>{if(active)setData(old=>!old||value.version>=old.version?value:old)},e=>{if(active){setData(undefined);setError(localizeWorkError(locale,e))}})}
  window.addEventListener('focus',update);window.addEventListener('storage',update);const timer=setInterval(update,15000)
  return()=>{active=false;window.removeEventListener('focus',update);window.removeEventListener('storage',update);clearInterval(timer)}
 },[open,busy,context,project.id,locale])
 const updateDraft=(value:ProjectContextDraft|undefined)=>{setDraft(value);try{context.setDraft(project.id,value);setError('')}catch(e){setError(e&&typeof e==='object'&&'code'in e&&e.code==='teloa/invalid-input'?localizeWorkError(locale,e):copy.draftError)}}
 const act=async(run:()=>Promise<unknown>,clearDraft=false)=>{
  if(busy)return;setBusy(true);setError('');setNotice('')
  try{await run();if(clearDraft)setDraft(context.draft(project.id));if(upgrading){restoreAfterLoad.current={context,projectId:project.id};setLoading(true)}setSharing(undefined);setWithdrawing(undefined);setUpgrading(undefined);setNotice(copy.saved);refresh(n=>n+1)}catch(e){setError(localizeWorkError(locale,e))}finally{setBusy(false)}
 }
 const mutate=(change:ProjectContextChange,expectedVersion=data!.version,clearDraft=false)=>act(()=>context.mutate(project.id,expectedVersion,change),clearDraft)
 // 只采用本人点下时的固定条目版本；先读本人CAS版本，正文与来源由服务端取得。迟答只属于原入口。
 const adopt=async(entry:ProjectContextEntry)=>{
  if(!personal||!open||archived||blocked||draft||personalBlocked||adopting.current===token||data?.projectId!==project.id||entry.state!=='active')return
  adopting.current=token;setAdoption({origin:token,busy:true})
  const current=()=>mounted.current&&origin.current.token===token
  try{
   const value=await personal.get()
   if(!current())return
   const result=await personal.publish({projectId:project.id,entryId:entry.id,entryVersion:entry.version,expectedPersonalVersion:value.version})
   if(current()){
    const matched=result.entries.some(value=>value.source?.projectId===project.id&&value.source.entryId===entry.id&&value.source.entryVersion===entry.version&&value.source.basisHash===entry.hash)
    setAdoption({origin:token,busy:false,notice:matched?copy.adoptedPersonal:copy.personalChecked})
   }
  }catch(error){if(current())setAdoption({origin:token,busy:false,error:localizeWorkError(locale,error)})}
  finally{if(adopting.current===token)adopting.current=undefined}
 }
 const edit=(entry?:ProjectContextEntry,kind:'rule'|'memory'='memory')=>{setNotice('');updateDraft({expectedVersion:data!.version,change:{kind:'save-entry',entryId:entry?.id??null,entryKind:entry?.kind??kind,topic:entry?.topic??'',markdown:entry?.markdown??''}})}
 const chooseShare=async(entry:ProjectContextEntry)=>{
  setBusy(true);setError('')
  try{const rows:WorkProject[]=[];let cursor:string|null=null;do{const page=await api.overview({scope:null,state:'current',cursor,limit:100});rows.push(...page.rows);cursor=page.nextCursor}while(cursor&&rows.length<1000)
   setTargets(rows.filter(p=>p.id!==project.id));setTarget('');setSharing(entry)
  }catch(e){setError(localizeWorkError(locale,e))}finally{setBusy(false)}
 }
 const chooseUpgrade=async(share:ProjectContextShare,origin:HTMLButtonElement)=>{
  comparisonOrigin.current=origin
  setBusy(true);setError('')
  try{const source=await context.get(share.sourceProjectId),current=source.entries.find(entry=>entry.id===share.entryId&&entry.state==='active')
   if(!current||current.version!==share.currentVersion)throw Error(projectRuntimeCopy(locale).stale)
   setUpgrading({share,current})
  }catch(error){setError(localizeWorkError(locale,error))}finally{setBusy(false)}
 }
 const entryRow=(entry:ProjectContextEntry)=><details key={entry.id} className={css.entry}>
  <summary><strong>{entry.topic}</strong><small>v{entry.version} · {copy[entry.state==='active'?'active':'withdrawn']}</small><ChevronDown size={15}/></summary>
  {entry.markdown!==null&&<p className={css.body}>{entry.markdown}</p>}
  {entry.state==='active'&&<div className={css.actions}>
   {!archived&&<button disabled={blocked||!!draft} onClick={()=>edit(entry)}>{copy.edit}</button>}
   {!archived&&entry.kind==='memory'&&<button disabled={blocked||!!draft} onClick={()=>void chooseShare(entry)}>{copy.share}</button>}
   {personal&&!archived&&<ToolbarIconButton label={copy.adoptPersonal} icon={BookmarkPlus} disabled={blocked||!!draft||personalBlocked||adoptionBusy} onClick={()=>void adopt(entry)}/>}
   <button disabled={blocked||!!draft} onClick={()=>setWithdrawing(entry)}>{copy.withdraw}</button>
  </div>}
 </details>
 const contextBody=<>
   {archived&&<p>{copy.archived}</p>}
   {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
   {currentAdoption?.error&&<p role="alert">{currentAdoption.error}</p>}{currentAdoption?.notice&&<p role="status">{currentAdoption.notice}</p>}
   {personalBlocked&&<p className={css.hint}>{copy.personalRecovery}</p>}
   {!!context.recoveryError()&&<div role="alert"><p>{copy.broken}</p><p>{t('recovery.nextStep')}</p><p>{copy.resetRecovery}</p><button disabled={busy} onClick={()=>{try{context.resetRecovery();setDraft(undefined);setError('');setNotice(t('recovery.discarded'));refresh(n=>n+1)}catch{setError(copy.draftError)}}}>{t('recovery.discard')}</button></div>}
   {pending&&<div className={css.notice}><p>{copy.pending}</p><button disabled={busy} onClick={()=>void act(()=>context.recover(project.id),true)}>{copy.retry}</button><button disabled={busy} onClick={()=>{context.discard(project.id);refresh(n=>n+1)}}>{copy.discardPending}</button></div>}
   {!api.runtime&&<button disabled={busy} onClick={()=>refresh(n=>n+1)}>{copy.refresh}</button>}
   {loading?<p role="status">{copy.loading}</p>:data&&<>
    {draft&&<form className={css.form} onSubmit={e=>{e.preventDefault();void mutate(draft.change,draft.expectedVersion,true)}}>
     <h3>{copy.draft}</h3>
     {draft.change.kind==='save-brief'?<label>{copy.brief}<textarea aria-label={copy.brief} maxLength={16000} value={draft.change.brief} disabled={busy} onChange={e=>updateDraft({...draft,change:{kind:'save-brief',brief:e.target.value}})}/></label>:<>
      <label>{copy.topic}<input aria-label={copy.topic} maxLength={120} required disabled={busy||draft.change.entryId!==null} value={draft.change.topic} onChange={e=>{if(draft.change.kind==='save-entry')updateDraft({...draft,change:{...draft.change,topic:e.target.value}})}}/></label>
      <label>{copy.body}<textarea aria-label={copy.body} maxLength={16000} required disabled={busy} value={draft.change.markdown} onChange={e=>{if(draft.change.kind==='save-entry')updateDraft({...draft,change:{...draft.change,markdown:e.target.value}})}}/></label>
     </>}
     {draft.expectedVersion!==data.version&&<div className={css.notice}><p>{copy.stale}</p><button type="button" disabled={blocked} onClick={()=>updateDraft({...draft,expectedVersion:data.version})}>{copy.rebase}</button></div>}
     <footer><button type="button" disabled={busy||pending} onClick={()=>updateDraft(undefined)}>{copy.cancel}</button><button disabled={blocked||archived||draft.expectedVersion!==data.version} type="submit">{copy.save}</button></footer>
    </form>}
    {sharing&&<form className={css.form} onSubmit={e=>{e.preventDefault();void mutate({kind:'share',entryId:sharing.id,entryVersion:sharing.version,targetProjectId:target})}}>
     <h3>{copy.share} · {sharing.topic} · v{sharing.version}</h3><p>{copy.fixed}</p>
     <label>{copy.target}<select aria-label={copy.target} required disabled={blocked} value={target} onChange={e=>setTarget(e.target.value)}><option value="">{copy.select}</option>{targets.map(p=><option key={p.id} value={p.id}>{p.title}</option>)}</select></label>
     <footer><button type="button" disabled={busy} onClick={()=>setSharing(undefined)}>{copy.back}</button><button disabled={blocked||!target} type="submit">{copy.share}</button></footer>
    </form>}
    {withdrawing&&<div className={css.notice}><strong>{withdrawing.topic}</strong><p>{copy.confirmWithdraw}</p><button disabled={busy} onClick={()=>setWithdrawing(undefined)}>{copy.back}</button><button disabled={blocked} onClick={()=>void mutate({kind:'withdraw-entry',entryId:withdrawing.id})}>{copy.confirm}</button></div>}
    {upgrading&&<section ref={comparisonPanel} className={css.comparison} role="region" aria-label={projectRuntimeCopy(locale).compare+' · '+upgrading.share.topic} tabIndex={-1}>
     <header><button type="button" disabled={busy} aria-label={copy.back} title={copy.back} onClick={closeComparison}><ArrowLeft size={18}/></button><h3>{upgrading.share.topic}</h3></header>
     <div className={css.comparisonReader}><div className={css.comparisonColumns}>
      <section><h3>{projectRuntimeCopy(locale).fixedVersion} · v{upgrading.share.entryVersion}</h3><p className={css.body}>{upgrading.share.markdown}</p></section>
      <section><h3>{projectRuntimeCopy(locale).latestVersion} · v{upgrading.current.version}</h3><p className={css.body}>{upgrading.current.markdown}</p></section>
     </div></div>
     <footer><button type="button" disabled={blocked||archived} onClick={()=>void mutate({kind:'update-share',shareId:upgrading.share.id,entryVersion:upgrading.current.version})}>{projectRuntimeCopy(locale).adoptVersion}</button></footer>
    </section>}
    <div ref={savedContext} className={css.savedContext} hidden={!!upgrading} tabIndex={-1}>
    <section className={css.contextSection}><header><h3>{copy.brief}</h3>{!archived&&<button disabled={blocked||!!draft} onClick={()=>updateDraft({expectedVersion:data.version,change:{kind:'save-brief',brief:data.brief}})}>{copy.edit}</button>}</header><p className={css.body}>{data.brief||copy.empty}</p></section>
    {(['rule','memory'] as const).map(kind=><section className={css.contextSection} key={kind} aria-label={kind==='rule'?copy.rules:copy.memories}><header><h3>{kind==='rule'?copy.rules:copy.memories}</h3>{!archived&&<button disabled={blocked||!!draft} onClick={()=>edit(undefined,kind)}>{kind==='rule'?copy.addRule:copy.addMemory}</button>}</header>{data.entries.filter(e=>e.kind===kind).length?data.entries.filter(e=>e.kind===kind).map(entryRow):<p className={css.hint}>{copy.empty}</p>}</section>)}
    {data.shares.length>0&&<section className={css.contextSection} aria-label={copy.shares}><h3>{copy.shares}</h3>{data.shares.map(s=><details key={s.id} className={css.entry}>
     <summary><strong>{s.topic??copy[s.status]}</strong><small>v{s.entryVersion} · {s.status==='active'&&s.currentVersion!==undefined&&s.currentVersion>s.entryVersion?projectRuntimeCopy(locale).newVersion:copy[s.status]}</small><ChevronDown size={15}/></summary>
     <p>{s.sourceProjectId===project.id?copy.outgoing+': '+(s.targetTitle??copy.unavailable):copy.incoming+': '+(s.sourceTitle??copy.unavailable)}</p>
     {s.markdown!==null&&<p className={css.body}>{s.markdown}</p>}
     {s.status==='active'&&s.currentVersion!==undefined&&s.currentVersion>s.entryVersion&&<p className={css.hint}>{projectRuntimeCopy(locale).newVersion} · v{s.currentVersion}{s.targetProjectId===project.id&&!archived&&<button type="button" disabled={blocked||!!draft} onClick={event=>void chooseUpgrade(s,event.currentTarget)}>{projectRuntimeCopy(locale).compare}</button>}</p>}
     {s.status==='active'&&<button disabled={blocked||!!draft} onClick={()=>void mutate({kind:'revoke-share',shareId:s.id})}>{copy.revoke}</button>}
    </details>)}</section>}
    </div>
   </>}
 </>
 return <ContextDrawer open={open} title={copy.title} close={close} canClose={!busy&&!adoptionBusy} className={css.drawer!}>
  <div className={css.panel}>
   {api.runtime?<ProjectRuntimePanel project={project} api={api} open={open} sessionId={sessionId} contextVersion={data?.version} contextChanged={()=>refresh(n=>n+1)}>{contextBody}</ProjectRuntimePanel>:<><p className={css.hint}>{copy.hint}</p>{contextBody}</>}
  </div>
 </ContextDrawer>
}

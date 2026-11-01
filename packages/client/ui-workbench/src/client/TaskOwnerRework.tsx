import {useEffect,useRef,useState} from 'react'
import type {PreviewTask} from './task-preview.js'
import type {TaskTransitionApi} from './task-transition-api.js'
import {GroupWorkResumeDrawer,type GroupWorkResumeControls} from './GroupWorkResume.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import css from './TaskPage.module.css'

export type TaskOwnerReworkPort={candidate:TaskTransitionApi['reworkCandidate'];pending:TaskTransitionApi['pending'];recoveryMessage:TaskTransitionApi['recoveryMessage'];submit:(task:PreviewTask)=>Promise<void>;recover:()=>Promise<void>;controls:GroupWorkResumeControls}
type View={kind:'loading'|'none'|'eligible'|'active'|'blocked'}|{kind:'paused';controlId:string}

/** 原任务、版本和连接共同隔离迟到读取；本人确认只转回待准备。 */
export function TaskOwnerRework(props:{task:PreviewTask;api:TaskOwnerReworkPort;blocked:(value:boolean)=>void}){
 const origin=useRef({api:props.api,epoch:0})
 if(origin.current.api!==props.api)origin.current={api:props.api,epoch:origin.current.epoch+1}
 return <Panel key={JSON.stringify([props.task.id,props.task.version,props.task.state,origin.current.epoch])} {...props}/>
}
function Panel({task,api,blocked}:{task:PreviewTask;api:TaskOwnerReworkPort;blocked:(value:boolean)=>void}){
 const {locale,t}=useI18n(),[view,setView]=useState<View>({kind:'loading'}),[revision,setRevision]=useState(0),[busy,setBusy]=useState(false),[error,setError]=useState<string>(),[resuming,setResuming]=useState(false),live=useRef(true),lock=useRef(false),notify=useRef(blocked)
 notify.current=blocked
 const relevant=task.storage==='persistent'&&task.assigneeId!=='self'&&['waiting','ready'].includes(task.state)
 useEffect(()=>{live.current=true;return()=>{live.current=false}},[])
 useEffect(()=>{
  let current=true;setView({kind:'loading'});setError(undefined)
  if(!relevant){setView({kind:'none'});return()=>{current=false}}
  void (async():Promise<View>=>{
   const candidate=await api.candidate(task.id,task.version)
   if(task.state==='waiting')return {kind:candidate.available?'eligible':'none'}
   if(!candidate.controlId)return {kind:'none'}
   const control=await api.controls.get(candidate.controlId)
   if(control.id!==candidate.controlId||control.scope!=='round'||control.pendingRunIds.length||control.unknownOperationIds.length)return {kind:'blocked'}
   return control.state==='active'?{kind:'active'}:control.state==='paused'?{kind:'paused',controlId:control.id}:{kind:'blocked'}
  })().then(value=>{if(current)setView(value)},cause=>{if(current){setView({kind:'blocked'});setError(localizeWorkError(locale,cause))}})
  return()=>{current=false}
 },[task.id,task.version,task.state,api,relevant,revision,locale])
 useEffect(()=>{notify.current(relevant&&task.state==='ready'&&!['none','active'].includes(view.kind))},[relevant,task.state,view])
 const pending=api.pending(),ownPending=pending?.action==='rework'&&pending.taskId===task.id&&pending.expectedVersion===task.version
 const act=async(recover:boolean)=>{
  if(lock.current||!relevant||(recover?!ownPending:view.kind!=='eligible'||!!pending||!!api.recoveryMessage()))return
  lock.current=true;setBusy(true);setError(undefined)
  try{if(recover)await api.recover();else await api.submit(task)}catch(cause){if(live.current)setError(localizeWorkError(locale,cause))}finally{lock.current=false;if(live.current)setBusy(false)}
 }
 if(!relevant||view.kind==='none'||view.kind==='active')return null
 return <section className={css.block} aria-label={t('taskCompletion.rework.title')}>
  {view.kind==='eligible'&&<><p>{t('taskCompletion.rework.boundary')}</p><button type="button" disabled={busy||!!pending||!!api.recoveryMessage()} onClick={()=>void act(false)}>{t('taskCompletion.rework.action')}</button></>}
  {ownPending&&<button type="button" disabled={busy||!!api.recoveryMessage()} onClick={()=>void act(true)}>{t('taskCompletion.rework.check')}</button>}
  {view.kind==='loading'&&<p role="status">{t('taskCompletion.rework.loading')}</p>}
  {view.kind==='paused'&&<><p>{t('taskCompletion.rework.resumeBody')}</p><button type="button" disabled={busy} onClick={()=>setResuming(true)}>{t('taskCompletion.rework.resume')}</button></>}
  {view.kind==='blocked'&&<p>{t('taskCompletion.rework.controlBlocked')}</p>}
  {error&&<p role="alert">{error}</p>}
  {(error||view.kind==='blocked')&&<button type="button" disabled={busy} onClick={()=>setRevision(value=>value+1)}>{t('taskCompletion.rework.retry')}</button>}
  {resuming&&view.kind==='paused'&&<GroupWorkResumeDrawer controlId={view.controlId} controls={api.controls} emptyOnly copy={{title:t('taskCompletion.rework.resume'),body:t('taskCompletion.rework.resumeBody'),confirm:t('taskCompletion.rework.resumeConfirm'),stuck:t('taskCompletion.rework.controlBlocked')}} close={()=>setResuming(false)} resumed={()=>setRevision(value=>value+1)}/>}
 </section>
}

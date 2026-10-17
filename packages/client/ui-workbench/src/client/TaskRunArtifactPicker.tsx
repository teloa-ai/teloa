import {useEffect,useMemo,useRef,useState} from 'react'
import {NativeArtifactPicker} from './NativeArtifactPicker.js'
import {copyArtifactMessages,type ArtifactMessage,type NativeArtifactApi} from './artifact-native.js'
import type {TaskArtifactPort} from './TaskArtifactPicker.js'
import type {TaskRunApi,RunView} from './task-run-api.js'
import {taskRunReasonKeys} from './task-run-presentation.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import css from './TaskPage.module.css'

type Props={preservePreview:boolean;taskId:string;api:Pick<TaskRunApi,'list'|'chatPresentation'>;port:TaskArtifactPort;native:NativeArtifactApi;selected:ArtifactMessage[];select:(message:ArtifactMessage|undefined)=>void}
const sameRun=(a:RunView,b:RunView)=>a.id===b.id&&a.taskId===b.taskId&&a.sessionId===b.sessionId&&a.nativeRequestId===b.nativeRequestId&&a.taskVersion===b.taskVersion&&a.roleVersion===b.roleVersion&&a.state===b.state&&a.reason===b.reason
/** 仅预览本人已确认关联的具体执行；不同轮次和不同消息不自动合稿。 */
export function TaskRunArtifactPicker(props:Props){
 const origin=useRef({taskId:props.taskId,api:props.api,port:props.port,native:props.native,epoch:0})
 if(origin.current.taskId!==props.taskId||origin.current.api!==props.api||origin.current.port!==props.port||origin.current.native!==props.native)origin.current={taskId:props.taskId,api:props.api,port:props.port,native:props.native,epoch:origin.current.epoch+1}
 const captured=origin.current
 return <TaskRunArtifactPickerPanel key={captured.epoch} {...props} isCurrent={()=>origin.current===captured}/>
}
function TaskRunArtifactPickerPanel({preservePreview,taskId,api,port,native,selected,select,isCurrent}:Props&{isCurrent:()=>boolean}){
 const {locale,t,dateTime}=useI18n(),[rows,setRows]=useState<RunView[]>([]),[opened,setOpened]=useState<RunView>(),[direct,setDirect]=useState(false),[busy,setBusy]=useState(true),[error,setError]=useState(''),generation=useRef(0),abort=useRef<AbortController>(),openedToken=useRef(0)
 const valid=(token:number)=>isCurrent()&&token===generation.current
 useEffect(()=>{
  const token=++generation.current;setRows([]);setOpened(undefined);setBusy(true);setError('')
  void Promise.all([api.list(taskId),port.list(taskId)]).then(([runs,linked])=>{if(!valid(token))return;const candidates=runs.filter(run=>run.taskId===taskId&&run.state==='ended'&&linked.some(row=>row.id===run.sessionId));setRows(candidates);if(candidates.length===1&&!preservePreview)void open(candidates[0]!)},cause=>{if(valid(token))setError(localizeWorkError(locale,cause))}).finally(()=>{if(valid(token))setBusy(false)})
  return()=>{generation.current++;abort.current?.abort()}
 },[taskId,api,port,locale])
 const open=async(run:RunView)=>{
  const token=++generation.current;abort.current?.abort();const controller=new AbortController();abort.current=controller;setBusy(true);setError('');setOpened(undefined);setDirect(false);openedToken.current=0;select(undefined)
  try{
   const [runs,linked]=await Promise.all([api.list(taskId),port.list(taskId)])
   if(!valid(token))return
   const fresh=runs.find(row=>sameRun(row,run))
   if(!fresh||!linked.some(row=>row.id===run.sessionId))throw Error(t('artifact.panel.text.002'))
   const reservation=await api.chatPresentation(fresh.sessionId)
   if(!valid(token))return
   if(!reservation||reservation.sessionId!==fresh.sessionId||reservation.runId!==fresh.id||reservation.taskId!==taskId||reservation.taskVersion!==fresh.taskVersion||reservation.roleVersion!==fresh.roleVersion||reservation.nativeRequestId!==fresh.nativeRequestId)throw Error(t('artifact.panel.text.002'))
   await port.open(fresh.sessionId,controller.signal,()=>valid(token))
   if(!valid(token)||controller.signal.aborted)return
   const page=await native.read(fresh.sessionId)
   if(!valid(token)||controller.signal.aborted)return
   if(page.sessionId!==fresh.sessionId||page.items.some(message=>message.sessionId!==fresh.sessionId))throw Error(t('nativeArtifact.wrongSession'))
   const replies=page.items.filter(message=>message.role==='assistant'&&!!message.text.trim())
   openedToken.current=token;setOpened(fresh)
   if(page.nextBeforeSeq===null&&replies.length===1&&replies[0]!.text.length<=16000){setDirect(true);select(copyArtifactMessages(replies,{kind:'task',id:taskId})[0])}
  }catch(cause){if(valid(token))setError(localizeWorkError(locale,cause))}
  finally{if(valid(token))setBusy(false)}
 }
 const messages=useMemo<NativeArtifactApi>(()=>({
  ...native,
  async read(sessionId,beforeSeq){
   const token=openedToken.current
   if(!valid(token)||!opened||sessionId!==opened.sessionId)throw Error(t('nativeArtifact.wrongSession'))
   const page=await native.read(sessionId,beforeSeq)
   if(!valid(token))throw Error(t('artifact.panel.text.002'))
   if(page.sessionId!==sessionId||page.items.some(message=>message.sessionId!==sessionId))throw Error(t('nativeArtifact.wrongSession'))
   return {...page,items:page.items.filter(message=>message.role==='assistant'&&!!message.text.trim())}
  },
 }),[native,opened,taskId,t])
 return <section className={css.block} aria-label={t('artifact.task.aria')}>
  {busy&&<p role="status">{t('nativeArtifact.loading')}</p>}{error&&<p role="alert">{error}</p>}
  <div className={css.buttons}>{rows.map(run=><button type="button" key={run.id} disabled={busy} aria-pressed={opened?.id===run.id} onClick={()=>void open(run)}>{run.roleName} · {dateTime(run.createdAt)} · {t(taskRunReasonKeys[run.reason??'']??'taskExecution.phase.ended')}</button>)}</div>
  {!busy&&!error&&!rows.length&&<p>{t('nativeArtifact.empty')}</p>}
  {opened&&!direct&&<NativeArtifactPicker key={opened.id} sessionId={opened.sessionId} api={messages} selected={selected} assistantName={opened.roleName} select={message=>{if(valid(openedToken.current)&&message.sessionId===opened.sessionId)select(copyArtifactMessages([message],{kind:'task',id:taskId})[0])}}/>}
 </section>
}

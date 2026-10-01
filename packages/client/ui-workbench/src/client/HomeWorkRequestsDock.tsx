import {useEffect,useRef,useState,useSyncExternalStore} from 'react'
import type {PropsRuntime} from '@deepseek-ai/dsh-client-ui-slots'
import type {BindingClient} from './binding-client.js'
import {HomeWorkStatusCard} from './HomeWorkRequestCard.js'
import {readHomeWorkStatus,type HomeWorkStatus,type HomeWorkStatusCall} from './home-work-status.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import css from './HomeWorkRequestCard.module.css'

type Props=PropsRuntime<'conversation.input.dock'>&{work:BindingClient;call:HomeWorkStatusCall;isAssistantContext:(id:string,signal?:AbortSignal)=>Promise<boolean>;openTask:(id:string)=>void;subscribeActivity:(listener:()=>void)=>()=>void}
/** 公开 dock 常驻展示请求；工具步骤折叠不影响进度和任务入口。 */
export function HomeWorkRequestsDock({sessionId,work,call,isAssistantContext,openTask,subscribeActivity}:Props){
 const {locale}=useI18n(),zh=locale.startsWith('zh'),binding=useSyncExternalStore(work.subscribe,work.getSnapshot)
 const ready=binding.sessionId===sessionId&&binding.status==='ready'
 const [snapshot,setSnapshot]=useState<{sessionId:string;rows:HomeWorkStatus[];error?:string}>({sessionId,rows:[]}),[retry,setRetry]=useState(0)
 const generation=useRef(0),latest=useRef({sessionId,ready});latest.current={sessionId,ready}
 useEffect(()=>{
  if(!ready)return
  const controller=new AbortController(),current=++generation.current;let loading=false,again=false,eligible:boolean|undefined,timer:ReturnType<typeof setTimeout>|undefined
  const active=()=>!controller.signal.aborted&&current===generation.current
  const refresh=async()=>{
   if(!active())return
   if(loading){again=true;return}
   loading=true;clearTimeout(timer)
   try{
    eligible??=await isAssistantContext(sessionId,controller.signal)
    if(!active())return
    if(!eligible){setSnapshot({sessionId,rows:[]});return}
    const value=await call('work-requests/list',{sessionId},controller.signal)
    if(!active())return
    if(!Array.isArray(value))throw Error('工作进度列表格式不正确。')
    const rows=value.map(row=>readHomeWorkStatus(row,sessionId))
    setSnapshot({sessionId,rows})
    if(rows.some(row=>row.members.some(member=>member.status==='waiting')))timer=setTimeout(()=>void refresh(),10000)
   }catch(cause){if(active())setSnapshot(previous=>({sessionId,rows:previous.sessionId===sessionId?previous.rows:[],error:localizeWorkError(locale,cause)}))}
   finally{loading=false;if(again&&active()){again=false;clearTimeout(timer);timer=setTimeout(()=>void refresh(),200)}}
  }
  const off=subscribeActivity(()=>{clearTimeout(timer);timer=setTimeout(()=>void refresh(),200)})
  void refresh()
  return()=>{controller.abort();clearTimeout(timer);off()}
 },[sessionId,ready,call,isAssistantContext,subscribeActivity,retry,locale])
 const changed=(value:HomeWorkStatus)=>{
  if(latest.current.sessionId!==sessionId||!latest.current.ready)return
  const row=readHomeWorkStatus(value,sessionId)
  generation.current++
  setSnapshot(previous=>previous.sessionId===sessionId?{sessionId,rows:previous.rows.map(item=>item.requestId===row.requestId?row:item)}:previous)
  setRetry(value=>value+1)
 }
 if(!ready||snapshot.sessionId!==sessionId||!snapshot.rows.length&&!snapshot.error)return null
 return <div className={css.dock} role="region" aria-label={zh?'本会话交办':'Work in this conversation'}>
  {snapshot.rows.map(row=><HomeWorkStatusCard key={row.sessionId+':'+row.requestId} initial={row} call={call} openTask={openTask} managed onChange={changed}/>)}
  {snapshot.error&&<p role="alert">{snapshot.error} <button type="button" onClick={()=>setRetry(value=>value+1)}>{zh?'重试读取进度':'Retry progress'}</button></p>}
 </div>
}

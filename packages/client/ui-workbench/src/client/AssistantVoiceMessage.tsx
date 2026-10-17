import {useEffect,useRef,useState} from 'react'
import {Mic,Square,X} from 'lucide-react'
import type {EmployeeVoiceApi} from './employee-voice-api.js'
import {openVoiceMicrophone,encodeVoiceWav} from './voice-microphone.js'
import {useI18n} from './i18n/provider.js'
import css from './AssistantVoiceMessage.module.css'
export class AssistantVoiceBusyError extends Error{}
export type AssistantVoiceDestination={sessionId:string;contextVersion:number;isCurrent:()=>boolean;subscribe:(listener:()=>void)=>()=>void}
export type AssistantVoiceDraft={sessionId:string;contextVersion:number;text:string;signal:AbortSignal}
const labels={busy:['请先挂断当前通话，再录制留言。','請先掛斷目前通話，再錄製留言。','End the current call before recording a voice message.'],start:['开始录音','開始錄音','Start recording'],stop:['完成录音','完成錄音','Finish recording'],cancel:['取消','取消','Cancel'],idle:['留言将添加到原会话草稿，由你核对后发送。','留言將加入原對話草稿，由你核對後傳送。','Voice messages go into your original draft for you to review and send.'],preparing:['正在打开原助手会话…','正在開啟原助手對話…','Opening your assistant conversation…'],recording:['正在录音，最多 15 秒','正在錄音，最多 15 秒','Recording, up to 15 seconds'],transcribing:['正在转写…','正在轉寫…','Transcribing…'],saved:['已添加到原会话草稿，请核对后发送。','已加入原對話草稿，請核對後傳送。','Added to your original draft. Review and send when ready.'],cancelled:['已取消录音，原草稿保留。','已取消錄音，原草稿保留。','Recording cancelled. Your original draft is preserved.'],empty:['未识别到语音，请重新录音。','未辨識到語音，請重新錄音。','No speech detected. Try recording again.'],missing:['请在设置的语音服务中配置语音识别。','請在設定的語音服務中設定語音識別。','Configure speech recognition in Settings > Voice service.'],failed:['留言暂不可用，原草稿保留。请重试或继续输入文字。','留言暫不可用，原草稿保留。請重試或繼續輸入文字。','Voice message unavailable. Your draft is preserved. Retry or type your message.'],denied:['未取得麦克风权限，请允许后重试。','未取得麥克風權限，請允許後重試。','Microphone permission denied. Allow access and try again.']} as const
type RecordingOperation={abort:AbortController;microphone?:Awaited<ReturnType<typeof openVoiceMicrophone>>;off?:(()=>void)|undefined;timer?:ReturnType<typeof setTimeout>|undefined;finish?:(()=>Promise<void>)|undefined}
type State='idle'|'preparing'|'recording'|'transcribing'|'saved'|'cancelled'|'empty'
/** 留言和持续通话共用采集协议；转写只回到经核验的原生草稿。 */
export function AssistantVoiceMessage({api,prepare,insert}:{api:EmployeeVoiceApi;prepare:(signal:AbortSignal)=>Promise<AssistantVoiceDestination>;insert:(draft:AssistantVoiceDraft)=>Promise<void>}){
 const {locale}=useI18n(),copy=(key:keyof typeof labels)=>labels[key][locale==='zh-CN'?0:locale.startsWith('zh-')?1:2]
 const [state,setState]=useState<State>('idle'),[error,setError]=useState<string>()
 const mounted=useRef(true),operation=useRef<RecordingOperation>()
 const cancel=()=>{const current=operation.current;if(!current)return;operation.current=undefined;current.abort.abort();current.off?.();clearTimeout(current.timer);void current.microphone?.close();if(mounted.current){setError(undefined);setState('cancelled')}}
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;cancel()}},[])
 const start=async()=>{
  if(operation.current)return
  const current={abort:new AbortController()} as RecordingOperation;operation.current=current
  const live=()=>mounted.current&&operation.current===current&&!current.abort.signal.aborted
  let parts:Float32Array[]=[],rate=0,samples=0
  setError(undefined);setState('preparing')
  try{
   const readiness=await (api.recognitionReadiness?.()??api.readiness());if(!live())return
   if(readiness.status!=='ready')throw Error(copy('missing'))
   const target=await prepare(current.abort.signal);if(!live())return
   if(!target.isCurrent()){cancel();return}
   current.off=target.subscribe(()=>{if(!target.isCurrent())cancel()})
   const finish=async()=>{
    if(!live()||state==='transcribing')return
    // 清除入口后不再接收样本；先关闭麦克风，再发送封口的 WAV。
    const captured=parts;parts=[];clearTimeout(current.timer);current.finish=undefined
    await current.microphone?.close();if(!live())return
    if(!samples||!rate){setState('empty');operation.current=undefined;current.off?.();return}
    setState('transcribing')
    const bytes=encodeVoiceWav(captured,rate);let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte)
    const result=await api.transcribe({requestId:crypto.randomUUID(),sessionId:target.sessionId,expectedContextVersion:target.contextVersion,audio:btoa(binary)},current.abort.signal)
    if(!live()||!target.isCurrent()){if(live())cancel();return}
    if(result.text){await insert({sessionId:target.sessionId,contextVersion:target.contextVersion,text:result.text,signal:current.abort.signal});if(live())setState('saved')}else setState('empty')
    if(live()){current.off?.();operation.current=undefined}
   }
   current.microphone=await openVoiceMicrophone((chunk,sampleRate)=>{if(!live()||!current.finish)return;rate=sampleRate;const bounded=chunk.subarray(0,Math.max(0,Math.floor(rate*15)-samples));if(bounded.length){parts.push(bounded);samples+=bounded.length}if(samples>=rate*15)void complete()})
   if(!live()){await current.microphone.close();return}
   current.finish=finish;setState('recording');current.timer=setTimeout(()=>{void complete()},15000)
  }catch(cause){if(live()){cancel();setError(cause instanceof AssistantVoiceBusyError?copy('busy'):cause instanceof DOMException&&cause.name==='NotAllowedError'?copy('denied'):cause instanceof Error&&cause.message===copy('missing')?cause.message:copy('failed'))}}
 }
 const complete=async()=>{const current=operation.current,finish=current?.finish;if(!finish)return;current.finish=undefined;try{await finish()}catch{if(operation.current===current){cancel();setError(copy('failed'))}}}
 const busy=state==='preparing'||state==='recording'||state==='transcribing'
 return <div className={css.message}><p role="status">{copy(state)}</p>{error&&<p role="alert">{error}</p>}<div>{state==='recording'?<button type="button" onClick={()=>void complete()}><Square size={14}/>{copy('stop')}</button>:<button type="button" disabled={busy} onClick={()=>void start()}><Mic size={14}/>{copy('start')}</button>}{busy&&<button type="button" onClick={cancel}><X size={14}/>{copy('cancel')}</button>}</div></div>
}

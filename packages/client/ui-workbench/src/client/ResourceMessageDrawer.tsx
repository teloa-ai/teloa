import {useEffect,useRef,useState} from 'react'
import {encodeResourceReference} from '@teloa/contract'
import type {NativeResourceMessageApi,ResourceMessageTarget,ResourceOriginalMessage} from './native-resource-message.js'
import {ContextDrawer} from './ContextDrawer.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import css from './ResourceMessageDrawer.module.css'

/** 精确原消息的只读视图；打开原会话是另一项明确动作，不宣称原生 Chat 已滚到该消息。 */
export function ResourceMessageDrawer({target,api,isCurrent,close,openConversation}:{target:ResourceMessageTarget;api:NativeResourceMessageApi;isCurrent:()=>boolean;close:()=>void;openConversation:(current:()=>boolean)=>Promise<void>}){
 const {locale,t}=useI18n(),copy=(cn:string,hant:string,en:string)=>locale==='zh-CN'?cn:locale.startsWith('zh')?hant:en
 const [state,setState]=useState<{identity:string;value?:ResourceOriginalMessage;error?:string}>(),[retry,setRetry]=useState(0),[opening,setOpening]=useState(false)
 const current=useRef(isCurrent);current.current=isCurrent
 const identity=JSON.stringify([target.id,target.messageId]),generation=useRef(0)
 // 来源资料子组件先提交新的身份，提交后再核对；不能只在父级 render 读取上一帧的来源 ref。
 useEffect(()=>{if(!current.current())close()})
 useEffect(()=>{
  const controller=new AbortController(),token=++generation.current;setState(undefined);setOpening(false)
  if(current.current())void api.read(target,controller.signal).then(value=>{
   if(controller.signal.aborted||generation.current!==token||!current.current())return
   if(value.sessionId!==target.id||value.messageId!==target.messageId)throw Error('原消息身份不一致。')
   setState({identity,value})
  }).catch(cause=>{if(!controller.signal.aborted&&generation.current===token&&current.current())setState({identity,error:localizeWorkError(locale,cause)})})
  return()=>{generation.current++;controller.abort()}
 },[api,identity,retry,locale])
 const valid=current.current()&&state?.identity===identity,value=valid?state.value:undefined,error=valid?state.error:undefined
 const references=new Map(value?.references.map(ref=>[encodeResourceReference(ref),ref]))
 const open=async()=>{
  if(opening||!value||!current.current())return
  const token=generation.current;setOpening(true)
  try{await openConversation(()=>generation.current===token&&current.current())}catch(cause){if(generation.current===token&&current.current())setState({identity,value,error:localizeWorkError(locale,cause)})}finally{if(generation.current===token&&current.current())setOpening(false)}
 }
 return <ContextDrawer title={copy('原消息','原訊息','Original message')} close={close} padded>
  <div className={css.root}>{error&&<p role="alert">{error} <button type="button" onClick={()=>setRetry(value=>value+1)}>{t('common.retry')}</button></p>}
   {value?<><time dateTime={value.at}>{new Date(value.at).toLocaleString(locale)}</time><pre className={css.message}>{value.text.split(/(\[\[teloa-resource:[^\]]*\]\])/g).map((part,index)=>{const ref=references.get(part);return ref?<span key={index} className={css.reference}>{ref.metadata?.title??copy('引用资料','引用資料','Referenced material')} · v{ref.version}</span>:part})}</pre>
    <button type="button" disabled={opening} onClick={()=>void open()}>{copy('打开原会话','開啟原對話','Open original conversation')}</button>
   </>:!error&&<p role="status">{t('knowledge.ui.085')}</p>}
  </div>
 </ContextDrawer>
}

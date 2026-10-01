import { useEffect,useRef,useState,useSyncExternalStore } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ResourceFailure,RecoverableRequest } from '@teloa/contract'
import type { ResourceApi } from './resource-api.js'
import type { BindingClient } from './binding-client.js'
import { restoreRecoveredText } from './resource-recovery.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import css from './ResourceRecovery.module.css'

export function ResourceRecovery({sessionId,session,input,inputActions,api,work}:PropsRuntime<'conversation.input.dock'> & {api:ResourceApi;work:BindingClient}){
  const {locale,t,dateTime}=useI18n()
  const binding=useSyncExternalStore(work.subscribe,work.getSnapshot),ready=binding.sessionId===sessionId&&binding.status==='ready'
  const [result,setResult]=useState<{sessionId:string;failures:ResourceFailure[];nextBeforeSeq:number|null}>(),[loading,setLoading]=useState(false),[error,setError]=useState<string>(),[notice,setNotice]=useState<string>()
  const request=useRef<AbortController>(),generation=useRef(0)
  const read=async(beforeSeq?:number)=>{
    request.current?.abort();const controller=new AbortController();request.current=controller
    const current=++generation.current;setLoading(true);setError(undefined)
    try{
      const page=await api.recovery(sessionId,beforeSeq,controller.signal)
      if(controller.signal.aborted||generation.current!==current)return
      setResult(previous=>beforeSeq===undefined||previous?.sessionId!==sessionId?page:{...page,failures:[...previous.failures,...page.failures.filter(item=>!previous.failures.some(old=>old.endSeq===item.endSeq))]})
    }catch(cause){if(!controller.signal.aborted&&generation.current===current)setError(localizeWorkError(locale,cause))}
    finally{if(!controller.signal.aborted&&generation.current===current)setLoading(false)}
  }
  useEffect(()=>{
    setNotice(undefined)
    if(ready)void read()
    return ()=>{generation.current++;request.current?.abort()}
  },[sessionId,ready,session.running,session.lastAgentError,api])
  if(!ready)return null
  const active=result?.sessionId===sessionId?result:undefined
  if(!error&&!active?.failures.length)return null
  const restore=(message:RecoverableRequest)=>{
    setNotice(undefined)
    if(!inputActions){setError(t('resourceRecovery.inputUnavailable'));return}
    try{restoreRecoveredText(message,input,session.running,inputActions);setNotice(t(message.otherContentCount>0?'resourceRecovery.restoredWithOther':'resourceRecovery.restored'))}
    catch(cause){setError(localizeWorkError(locale,cause))}
  }
  const copy=async(message:RecoverableRequest)=>{try{await navigator.clipboard.writeText(message.text);setNotice(t('resourceRecovery.copied'))}catch(cause){setError(localizeWorkError(locale,cause))}}
  const blocked=session.running||input.phase!=='plain'||input.draft.length>0||input.attachmentIds.length>0
  return <details className={css.panel}>
    <summary>{t('resourceRecovery.title',{count:active?.failures.length??0})}</summary>
    <div className={css.body}>
      <p className={css.muted}>{t('resourceRecovery.description')}</p>
      {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
      <button type="button" className={css.button} disabled={loading} onClick={()=>void read()}>{t('resourceRecovery.refresh')}</button>
      {blocked&&<p className={css.muted}>{t('resourceRecovery.blocked')}</p>}
      {active?.failures.map(failure=><section key={failure.endSeq} className={css.failure} aria-label={t('resourceRecovery.failureAria',{turn:failure.turn})}>
        <strong>{failure.reason}</strong><small className={css.muted}>{t('resourceRecovery.failureMeta',{at:dateTime(failure.at),turn:failure.turn})}</small>
        {failure.messages.map(message=><div key={message.id} className={css.message}>
          <pre>{message.text||t('resourceRecovery.noText')}</pre>
          {message.otherContentCount>0&&<p className={css.muted}>{t('resourceRecovery.otherContent',{count:message.otherContentCount})}</p>}
          <div className={css.actions}><button type="button" className={css.button} disabled={blocked||!message.text.trim()} onClick={()=>restore(message)}>{t('resourceRecovery.restore')}</button><button type="button" className={css.button} disabled={!message.text} onClick={()=>void copy(message)}>{t('resourceRecovery.copy')}</button></div>
        </div>)}
      </section>)}
      {active?.nextBeforeSeq!==null&&active?.nextBeforeSeq!==undefined&&<button type="button" className={css.button} disabled={loading} onClick={()=>void read(active.nextBeforeSeq!)}>{t('resourceRecovery.older')}</button>}
    </div>
  </details>
}

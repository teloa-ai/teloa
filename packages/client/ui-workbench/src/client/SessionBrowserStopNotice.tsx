import {useEffect,useSyncExternalStore} from 'react'
import type {PropsRuntime} from '@deepseek-ai/dsh-client-ui-slots'
import type {TeloaI18n} from './i18n/index.js'
import type {SessionBrowserStopReader} from './session-browser-stop.js'
import css from './SessionBrowserStopNotice.module.css'

export function SessionBrowserStopNotice({sessionId,reader,i18n}:PropsRuntime<'conversation.input.dock'>&{reader:SessionBrowserStopReader;i18n:TeloaI18n}){
 useSyncExternalStore(i18n.subscribe,i18n.getSnapshot,i18n.getSnapshot)
 const state=useSyncExternalStore(reader.subscribe,reader.getSnapshot,reader.getSnapshot)
 useEffect(()=>reader.attach(),[sessionId,reader])
 if(state.status==='ready'||state.status==='loading')return null
 const key=state.status==='failed'?'sessionBrowserStop.failed':state.status==='isolated'?'sessionBrowserStop.isolated':'sessionBrowserStop.unconfirmed'
 return <section className={css.notice} role="alert" aria-busy={state.checking}>
  <p>{i18n.t(key)}</p>
  <button type="button" disabled={state.checking} onClick={()=>void reader.check()}>{i18n.t('sessionBrowserStop.check')}</button>
 </section>
}

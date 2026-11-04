import {useSyncExternalStore} from 'react'
import {Play,LoaderCircle} from 'lucide-react'
import {useI18n} from './i18n/provider.js'
import type {createSessionContinuation} from './session-continuation.js'
import css from './SessionContinuationButton.module.css'

const copy={
 continue:['继续未完成的工作','繼續未完成的工作','Continue unfinished work'],
 help:['沿原会话继续，保留已有结果与当前草稿','沿原對話繼續，保留已有結果與目前草稿','Continue in this conversation, preserving existing results and your draft'],
 failed:['恢复尚未确认，请核对原会话后重试','尚未確認恢復，請核對原對話後再試','Continuation is unconfirmed. Check this conversation and retry'],
} as const
export function SessionContinuationButton({port}:{port:ReturnType<typeof createSessionContinuation>}){
 const state=useSyncExternalStore(port.subscribe,port.getSnapshot,port.getSnapshot),{locale}=useI18n(),index=locale==='zh-CN'?0:locale.startsWith('zh')?1:2
 if(!state.available)return null
 const Icon=state.busy?LoaderCircle:Play
 return <span className={css.wrap}>
  <button type="button" className={css.button} disabled={state.busy} aria-label={copy.continue[index]} title={copy.help[index]} onClick={()=>{void port.continue().catch(()=>{})}}><Icon size={16} aria-hidden="true"/></button>
  {state.error&&<span className={css.error} role="alert">{copy.failed[index]}</span>}
 </span>
}

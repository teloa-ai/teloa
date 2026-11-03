import {createElement,useState,useSyncExternalStore,type ComponentType} from 'react'
import type {PropsRuntime,StoredEntry} from '@deepseek-ai/dsh-client-ui-slots'
import {StateDot} from '@deepseek-ai/dsh-client-ui-primitives'
import {readWorkBudgetExhaustedCode} from '@teloa/contract'
import {localizeWorkError} from './i18n/errors.js'
import {useI18n} from './i18n/provider.js'
import css from './BudgetTurnErrorView.module.css'
import type {FailedTurnContinuation} from './failed-turn-continuation.js'
import {draftContinuityCopy} from './draft-continuity-copy.js'

type TurnErrorProps=PropsRuntime<'conversation.chat.node','turn-error'>
type Renderer={subscribe:(listener:()=>void)=>()=>void;getSnapshot:()=>readonly StoredEntry[];isLive:(entry:StoredEntry)=>boolean}

/** 借用原生 turn-error keyed renderer（priority 0 的官方占位）；不复制其他失败的展示。 */
function nativeTurnErrorRenderer(entries:readonly StoredEntry[],isLive:(entry:StoredEntry)=>boolean):{component:ComponentType<TurnErrorProps>;live:()=>boolean}|null{
 const entry=entries.find(row=>row.options.key==='turn-error'&&(row.options.priority??0)===0)
 if(!entry||entry.inject||entry.children||entry.store||!entry.component)return null
 return {component:entry.component as ComponentType<TurnErrorProps>,live:()=>isLive(entry)}
}

/**
 * 会话里的本轮失败行：额度拒绝按稳定 code 说明原因、范围与下一步，不显示服务端原文或内部 code；
 * 其余失败沿用原生 renderer；其不可用时按真实 turn-error 的稳定 code 保留说明与安全动作。
 */
export function BudgetTurnErrorView({renderer,continuation,...props}:TurnErrorProps&{renderer:Renderer;continuation?:FailedTurnContinuation}){
 const entries=useSyncExternalStore(renderer.subscribe,renderer.getSnapshot,renderer.getSnapshot)
 const {t,locale}=useI18n(),code=(props.node.data as {code?:unknown}).code
 // 额度拒绝保留具体恢复说明；未确认额度恢复时，不用 Retry 再发同一个必拒请求。
 if(readWorkBudgetExhaustedCode(code))return <div className={css.row} role="status">
  <StateDot state="error" className={css.dot}/>
  <div className={css.copy}><span className={css.title}>{t('planWork.budget.turnError')}</span><span className={css.message}>{localizeWorkError(locale,{code})}</span></div>
 </div>
 const native=nativeTurnErrorRenderer(entries,renderer.isLive)
 // 原生 renderer 热卸载时，durable turn-error 仍存在；不能连安全重试入口一起吞掉。
 const error=native?.live()?createElement(native.component,props):<div className={css.row} role="status">
  <StateDot state="error" className={css.dot}/>
  <div className={css.copy}><span className={css.title}>{draftContinuityCopy(locale,'answerIncomplete')}</span><span className={css.message}>{localizeWorkError(locale,{code})}</span></div>
 </div>
 return continuation?<>{error}<ContinueAnswer port={continuation} seq={props.node.data.seq}/></>:error
}

function ContinueAnswer({port,seq}:{port:FailedTurnContinuation;seq:number}){
 useSyncExternalStore(port.subscribe,port.getSnapshot,port.getSnapshot)
 const {locale}=useI18n(),[error,setError]=useState(false)
 if(!port.available(seq))return null
 return <div className={css.continue}>
  <button type="button" title={draftContinuityCopy(locale,'help')} onClick={()=>{setError(false);void port.continue(seq).catch(()=>setError(true))}}>{draftContinuityCopy(locale,'continue')}</button>
  {error&&<span role="alert">{draftContinuityCopy(locale,'failed')}</span>}
 </div>
}

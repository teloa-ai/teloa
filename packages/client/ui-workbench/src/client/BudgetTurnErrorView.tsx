import {createElement,useSyncExternalStore,type ComponentType} from 'react'
import type {PropsRuntime,StoredEntry} from '@deepseek-ai/dsh-client-ui-slots'
import {StateDot} from '@deepseek-ai/dsh-client-ui-primitives'
import {readWorkBudgetExhaustedCode} from '@teloa/contract'
import {localizeWorkError} from './i18n/errors.js'
import {useI18n} from './i18n/provider.js'
import css from './BudgetTurnErrorView.module.css'

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
 * 其余失败仍交给原生 renderer。
 */
export function BudgetTurnErrorView({renderer,...props}:TurnErrorProps&{renderer:Renderer}){
 const entries=useSyncExternalStore(renderer.subscribe,renderer.getSnapshot,renderer.getSnapshot)
 const {t,locale}=useI18n(),code=(props.node.data as {code?:unknown}).code
 if(readWorkBudgetExhaustedCode(code))return <div className={css.row} role="status">
  <StateDot state="error" className={css.dot}/>
  <div className={css.copy}><span className={css.title}>{t('planWork.budget.turnError')}</span><span className={css.message}>{localizeWorkError(locale,{code})}</span></div>
 </div>
 const native=nativeTurnErrorRenderer(entries,renderer.isLive)
 return native&&native.live()?createElement(native.component,props):null
}

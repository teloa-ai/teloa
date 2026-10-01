import {cloneElement,useEffect,useRef,useState,type ReactElement} from 'react'
import {createPortal} from 'react-dom'
import clsx from 'clsx'
import {editionGateProps,useEdition} from './edition.js'
import {useI18n} from './i18n/provider.js'
import css from './EditionGate.module.css'

/** 提示停留时长：够读完一行文案，不需要用户手动关闭。 */
const NOTICE_DURATION_MS=4000
/** 淡出动画时长，需要和 CSS 里 `.leaving` 的 transition 时长一致。 */
const EXIT_MS=180

/**
 * 企业版入口的统一门控：个人版下被包裹控件照常渲染但标记 `aria-disabled`，
 * 点击或键盘激活弹出一条自动消失的小提示，不会调用被包裹控件的处理函数。
 *
 * 提示是非模态的 `role="status"`（`aria-live="polite"`），挂到 `document.body`：
 * 被包裹控件常常位于 `role="menu"`、`role="listbox"` 这类只允许特定子角色的容器里，
 * 就地渲染会污染漫游 tabindex；提示本身也不抢焦点、没有遮罩、没有关闭按钮。
 * `NOTICE_DURATION_MS` 后自动淡出消失；点击提示本身立即触发淡出；再次触发只重置
 * 倒计时（先清掉上一个 `setTimeout` 再重新计时），不会叠加出多条。
 * `onIntercept` 给调用方一个先收起菜单 / 下拉的机会。
 * 版本只从 `useEdition()` 读：门控没有属性可以旁路，测试要走非个人版分支就用 `configureEdition` 注入。
 */
export function EditionGate({feature,label,onIntercept,children}:{feature:string;label:string;onIntercept?:()=>void;children:ReactElement}){
 const edition=useEdition()
 const {t}=useI18n()
 const [phase,setPhase]=useState<'closed'|'open'|'leaving'>('closed')
 const timer=useRef<ReturnType<typeof setTimeout>>()
 const clearTimer=()=>{if(timer.current!==undefined)clearTimeout(timer.current)}
 useEffect(()=>clearTimer,[])
 if(edition!=='personal')return children
 const leave=()=>{clearTimer();setPhase('leaving');timer.current=setTimeout(()=>setPhase('closed'),EXIT_MS)}
 const show=()=>{clearTimer();setPhase('open');timer.current=setTimeout(leave,NOTICE_DURATION_MS)}
 const gated=cloneElement(children as ReactElement<Record<string,unknown>>,editionGateProps(feature,()=>{onIntercept?.();show()}))
 const notice=phase!=='closed'?<div role="status" aria-live="polite" className={clsx(css.notice,phase==='leaving'&&css.leaving)} onClick={leave}>
  <p>{t('edition.gate.body',{action:label})}</p>
 </div>:null
 return <>{gated}{notice&&(typeof document==='undefined'?notice:createPortal(notice,document.body))}</>
}

import {useEffect,useRef,useState,type ReactNode} from 'react'
import {CloudOff,LoaderCircle,RotateCw} from 'lucide-react'
import {useI18n} from './i18n/provider.js'
import css from './ReadState.module.css'

/**
 * 读取三态（B8，对标报告第 3 节）：列表 / 页面读取的统一过程表达。
 * 0–1 秒不显示加载态（只留读屏状态）；1 秒后显示与真实卡片 / 行同尺寸的骨架；10 秒进入「读取较慢」并给「取消」；
 * 30 秒仍未返回即转为超时失败，由调用方停止等待。主动取消与失败分开表达；成功到达后调用方直接换成内容。
 * 阈值：1 秒〔Primer、NN/g〕、10 秒〔Primer、NN/g〕、30 秒〔参照 Claude 连接器超时〕；「取消」入口为推断。
 */
export const readTiming={skeleton:1000,slow:10000,timeout:30000}
export type ReadStatus='pending'|'failed'|'timeout'|'cancelled'

export function ReadState({status,subject,loadingLabel,reason,skeleton,cancel,retry,back,onTimeout,timing=readTiming}:{
 status:ReadStatus
 /** 嵌进「没能读取…」「已取消读取…」的对象名，如「官方目录」。 */
 subject:string
 /** 读屏播报的具体读取文案，如「正在读取官方目录…」。 */
 loadingLabel:string
 /** 失败原因一句话（已本地化，不含原始异常）；超时由组件写明等待时长。 */
 reason?:string|undefined
 /** 与该入口真实卡片 / 行同尺寸的骨架，不用通用灰条。 */
 skeleton:ReactNode
 cancel:()=>void
 retry:()=>void
 back?:(()=>void)|undefined
 onTimeout:()=>void
 timing?:typeof readTiming
}){
 const {t}=useI18n()
 const [elapsed,setElapsed]=useState(0)
 const timeoutRef=useRef(onTimeout);timeoutRef.current=onTimeout
 useEffect(()=>{
  setElapsed(0)
  if(status!=='pending')return
  const start=Date.now(),update=()=>setElapsed(Date.now()-start)
  let tick:ReturnType<typeof setInterval>|undefined
  const timers=[
   setTimeout(update,timing.skeleton),
   setTimeout(()=>{update();tick=setInterval(update,1000)},timing.slow),
   setTimeout(()=>timeoutRef.current(),timing.timeout),
  ]
  return ()=>{timers.forEach(clearTimeout);clearInterval(tick)}
 },[status,timing.skeleton,timing.slow,timing.timeout])
 if(status==='failed'||status==='timeout')return <div className={css.failed} role="alert">
  <p className={css.title}><CloudOff size={15} aria-hidden="true"/>{t('readState.failedTitle',{subject})}</p>
  <p className={css.reason}>{status==='timeout'?t('readState.timeout',{seconds:Math.round(timing.timeout/1000)}):reason}</p>
  <div className={css.actions}><button type="button" className={css.primary} onClick={retry}><RotateCw size={13} aria-hidden="true"/>{t('readState.retry')}</button>{back&&<button type="button" onClick={back}>{t('readState.back')}</button>}</div>
 </div>
 if(status==='cancelled')return <div className={css.cancelled} role="status">
  <span>{t('readState.cancelled',{subject})}</span><button type="button" onClick={retry}>{t('readState.reload')}</button>
 </div>
 const slow=elapsed>=timing.slow
 return <div className={css.pending} aria-busy="true" data-read-phase={slow?'slow':elapsed>=timing.skeleton?'skeleton':'waiting'}>
  {slow?<div className={css.slow}><LoaderCircle size={15} className={css.spinner} aria-hidden="true"/><span role="status">{t('readState.slow')}</span><span className={css.elapsed}>{t('readState.elapsed',{seconds:Math.floor(elapsed/1000)})}</span><button type="button" onClick={cancel}>{t('readState.cancel')}</button></div>
   :<p className={css.srOnly} role="status">{loadingLabel}</p>}
  {elapsed>=timing.skeleton&&<div className={css.skeleton} aria-hidden="true">{skeleton}</div>}
 </div>
}

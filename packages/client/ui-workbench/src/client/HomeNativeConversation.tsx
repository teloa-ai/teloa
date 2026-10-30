import {useEffect,useLayoutEffect,useRef,useSyncExternalStore,type ReactNode} from 'react'
import type {PropsRuntime} from '@deepseek-ai/dsh-client-ui-slots'
import css from './HomeNativeConversation.module.css'

type Owner={home:boolean;ready:boolean;overview:ReactNode;content:ReactNode;notice?:ReactNode;engaged?:(sessionId:string)=>void;openTaskForm?:(goal:string,scope:string)=>void}
declare module '@deepseek-ai/dsh-client-ui-slots'{interface SlotMap{'teloa.conversation':{kind:'single';scope:'session-maybe';owner:Owner}}}
type Props=PropsRuntime<'teloa.conversation'>&{taskCreation?:(openForm:(goal:string,scope:string)=>void)=>ReactNode;isHomeDraft:()=>boolean;accept:()=>void;acceptance:{getSnapshot:()=>boolean;subscribe:(listener:()=>void)=>()=>void}}

/** 整体复用官方 main（内部装配 content factory）；首页切到正文只改外壳布局，不迁移或重建富草稿。 */
export function HomeNativeConversation({home,ready,overview,content,notice,engaged,sessionId,useSession,acceptance,accept,isHomeDraft,taskCreation,openTaskForm}:Props){
 const session=useSession(value=>value),accepted=useSyncExternalStore(acceptance.subscribe,acceptance.getSnapshot)
 // Frame 的旧 ready 会跨切页保留到 effect；首帧即核对草稿归属，避免旧回执抢先转场。
 const homeReady=ready&&(!home||isHomeDraft())
 const hero=session===undefined||session.blank&&!session.promptAttempted&&session.pendingSubmissions.length===0
 const showOverview=home&&hero
 const root=useRef<HTMLElement>(null)
 useLayoutEffect(()=>{
  const node=root.current
  if(!showOverview||!homeReady||!node)return
  // 原生命令菜单按视口顶边限高；首页还有工作台头部与页签，要把真实滚动边界交给它。
  const style=document.documentElement.style,key='--dsh-frame-top-clearance'
  const previous=style.getPropertyValue(key),priority=style.getPropertyPriority(key)
  const inherited=Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(key))||0
  let applied=''
  const measure=()=>{
   const value=`${Math.max(inherited,node.getBoundingClientRect().top)}px`
   if(value===applied)return
   style.setProperty(key,value);applied=value
   // 原生菜单监听滚动重算限高；也覆盖页头换行等只改变容器尺寸的情况。
   node.dispatchEvent(new Event('scroll'))
  }
  measure()
  const observer=new ResizeObserver(measure);observer.observe(node)
  window.addEventListener('resize',measure,true)
  return()=>{
   observer.disconnect();window.removeEventListener('resize',measure,true)
   if(style.getPropertyValue(key)===applied){if(previous)style.setProperty(key,previous,priority);else style.removeProperty(key)}
  }
 },[showOverview,homeReady])
 useEffect(()=>{if(sessionId&&accepted&&isHomeDraft()){accept();if(home&&homeReady)engaged?.(sessionId)}},[home,homeReady,sessionId,accepted,engaged,accept,isHomeDraft])
 return <section ref={root} className={showOverview?css.home:css.conversation} data-teloa-home={home||undefined} aria-busy={home&&!homeReady}>
  <>{notice}{openTaskForm&&taskCreation?.(openTaskForm)}</>
  <div className={showOverview?css.homeConversation:css.body} hidden={home&&!homeReady}>
   {content}
  </div>
  {showOverview&&homeReady&&overview}
 </section>
}

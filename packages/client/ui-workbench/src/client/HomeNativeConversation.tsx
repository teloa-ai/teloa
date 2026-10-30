import {useEffect,useRef,useSyncExternalStore,type ReactNode} from 'react'
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
 const shell=useRef<HTMLElement>(null)
 // 原生候选菜单按窗口顶边计算高度；首页还有工作台页签，边界应取自己的可见工作区。
 useEffect(()=>{
  const element=shell.current
  if(!showOverview||!element)return
  let frame=0,observedCard:HTMLElement|undefined,observedSeat:HTMLElement|undefined
  const update=()=>{
   const card=element.querySelector<HTMLElement>('[data-composer-card]')
   if(!card)return
   if(card!==observedCard){
    if(observedCard)resize.unobserve(observedCard)
    if(observedSeat)resize.unobserve(observedSeat)
    observedCard=card;observedSeat=card.closest<HTMLElement>('[data-composer-seat]')??undefined
    resize.observe(card);if(observedSeat)resize.observe(observedSeat)
   }
   const bounds=element.getBoundingClientRect()
   let box=card.getBoundingClientRect()
   if(element.querySelector('[role=listbox]')&&(box.top<bounds.top||box.bottom>Math.min(innerHeight,bounds.bottom))){
    card.scrollIntoView({block:'nearest'})
    box=card.getBoundingClientRect()
   }
   const above=box.top-Math.max(0,bounds.top)-8,below=Math.min(innerHeight,bounds.bottom)-box.bottom-8
   const side=above>=160||above>=below?'above':'below'
   element.dataset.teloaHomeMenuSide=side
   element.style.setProperty('--teloa-home-menu-height',Math.max(40,Math.min(400,side==='above'?above:below))+'px')
   element.style.setProperty('--teloa-home-card-height',box.height+8+'px')
  }
  const schedule=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(update)}
  const resize=new ResizeObserver(schedule),mutation=new MutationObserver(schedule)
  resize.observe(element);mutation.observe(element,{subtree:true,childList:true})
  element.addEventListener('scroll',schedule,true);window.addEventListener('resize',schedule);schedule()
  return()=>{cancelAnimationFrame(frame);resize.disconnect();mutation.disconnect();element.removeEventListener('scroll',schedule,true);window.removeEventListener('resize',schedule)}
 },[showOverview,homeReady])
 useEffect(()=>{if(sessionId&&accepted&&isHomeDraft()){accept();if(home&&homeReady)engaged?.(sessionId)}},[home,homeReady,sessionId,accepted,engaged,accept,isHomeDraft])
 return <section ref={shell} className={showOverview?css.home:css.conversation} data-teloa-home={home||undefined} aria-busy={home&&!homeReady}>
  <>{notice}{openTaskForm&&taskCreation?.(openTaskForm)}</>
  <div className={showOverview?css.homeConversation:css.body} data-teloa-home-input={showOverview||undefined} hidden={home&&!homeReady}>
   {content}
  </div>
  {showOverview&&homeReady&&overview}
 </section>
}

import {useEffect,useLayoutEffect,useRef,useSyncExternalStore,type ReactNode} from 'react'
import type {PropsRuntime} from '@deepseek-ai/dsh-client-ui-slots'
import css from './HomeNativeConversation.module.css'

type Owner={home:boolean;ready:boolean;retainingInput?:boolean;overview:ReactNode;content:ReactNode;notice?:ReactNode;engaged?:(sessionId:string)=>void;openTaskForm?:(goal:string,scope:string)=>void}
declare module '@deepseek-ai/dsh-client-ui-slots'{interface SlotMap{'teloa.conversation':{kind:'single';scope:'session-maybe';owner:Owner}}}
type Props=PropsRuntime<'teloa.conversation'>&{taskCreation?:(openForm:(goal:string,scope:string)=>void)=>ReactNode;isHomeDraft:()=>boolean;accept:()=>void;acceptance:{getSnapshot:()=>boolean;subscribe:(listener:()=>void)=>()=>void}}

/** 整体复用官方 main（内部装配 content factory）；首页切到正文只改外壳布局，不迁移或重建富草稿。 */
export function HomeNativeConversation({home,ready,retainingInput,overview,content,notice,engaged,sessionId,useSession,acceptance,accept,isHomeDraft,taskCreation,openTaskForm}:Props){
 const session=useSession(value=>value),accepted=useSyncExternalStore(acceptance.subscribe,acceptance.getSnapshot)
 // Frame 的旧 ready 会跨切页保留到 effect；首帧即核对草稿归属，避免旧回执抢先转场。
 const owned=!home||isHomeDraft(),homeReady=ready&&owned
 const retained=home&&!homeReady&&retainingInput&&owned,showInput=homeReady||retained
 const hero=session===undefined||session.blank&&!session.promptAttempted&&session.pendingSubmissions.length===0
 const showOverview=home&&hero
 const root=useRef<HTMLElement>(null)
 useLayoutEffect(()=>{
  const node=root.current
  if(!showOverview||!showInput||!node)return
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
 },[showOverview,showInput])
 // 原生候选菜单按窗口顶边计算高度；首页还有工作台页签，边界应取自己的可见工作区。
 useEffect(()=>{
  const element=root.current
  if(!showOverview||!showInput||!element)return
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
   // 原生 hero 留有尾部空白；只收回输入之后的空白，避免固定负边距盖住大字输入。
   const conversation=element.querySelector<HTMLElement>('[data-teloa-home-input]')
   const trim=conversation?Math.max(0,conversation.getBoundingClientRect().bottom-box.bottom-40):0
   element.style.setProperty('--teloa-home-hero-trim',trim+'px')
   const above=box.top-Math.max(0,bounds.top)-8,below=Math.min(innerHeight,bounds.bottom)-box.bottom-8
   const side=above>=96||above>=below?'above':'below'
   element.dataset.teloaHomeMenuSide=side
   element.style.setProperty('--teloa-home-menu-height',Math.max(40,Math.min(400,side==='above'?above:below))+'px')
   element.style.setProperty('--teloa-home-card-height',box.height+8+'px')
  }
  const schedule=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(update)}
  const resize=new ResizeObserver(schedule),mutation=new MutationObserver(schedule)
  resize.observe(element);mutation.observe(element,{subtree:true,childList:true})
  element.addEventListener('scroll',schedule,true);window.addEventListener('resize',schedule);schedule()
  return()=>{cancelAnimationFrame(frame);resize.disconnect();mutation.disconnect();element.removeEventListener('scroll',schedule,true);window.removeEventListener('resize',schedule)}
 },[showOverview,showInput])
 useEffect(()=>{if(sessionId&&accepted&&isHomeDraft()){accept();if(home&&homeReady)engaged?.(sessionId)}},[home,homeReady,sessionId,accepted,engaged,accept,isHomeDraft])
 return <section ref={root} className={showOverview?css.home:css.conversation} data-teloa-home={home||undefined} aria-busy={home&&!homeReady}>
  <>{!retained&&notice}{openTaskForm&&taskCreation?.(openTaskForm)}</>
  <div className={showOverview?css.homeConversation:css.body} data-teloa-home-input={showOverview||undefined} hidden={home&&!showInput} {...(retained?{inert:''}:{})}>
   {content}
  </div>
  {showOverview&&showInput&&overview}
 </section>
}

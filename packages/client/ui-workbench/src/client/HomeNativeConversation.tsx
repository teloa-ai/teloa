import {useEffect,useSyncExternalStore,type ReactNode} from 'react'
import type {PropsRuntime} from '@deepseek-ai/dsh-client-ui-slots'
import css from './HomeNativeConversation.module.css'

type Owner={home:boolean;ready:boolean;overview:ReactNode;content:ReactNode;notice?:ReactNode;engaged?:(sessionId:string)=>void}
declare module '@deepseek-ai/dsh-client-ui-slots'{interface SlotMap{'teloa.conversation':{kind:'single';scope:'session-maybe';owner:Owner}}}
type Props=PropsRuntime<'teloa.conversation'>&{isHomeDraft:()=>boolean;accept:()=>void;acceptance:{getSnapshot:()=>boolean;subscribe:(listener:()=>void)=>()=>void}}

/** 整体复用官方 main（内部装配 content factory）；首页切到正文只改外壳布局，不迁移或重建富草稿。 */
export function HomeNativeConversation({home,ready,overview,content,notice,engaged,sessionId,useSession,acceptance,accept,isHomeDraft}:Props){
 const session=useSession(value=>value),accepted=useSyncExternalStore(acceptance.subscribe,acceptance.getSnapshot)
 // Frame 的旧 ready 会跨切页保留到 effect；首帧即核对草稿归属，避免旧回执抢先转场。
 const homeReady=ready&&(!home||isHomeDraft())
 const hero=session===undefined||session.blank&&!session.promptAttempted&&session.pendingSubmissions.length===0
 const showOverview=home&&hero
 useEffect(()=>{if(sessionId&&accepted&&isHomeDraft()){accept();if(home&&homeReady)engaged?.(sessionId)}},[home,homeReady,sessionId,accepted,engaged,accept,isHomeDraft])
 return <section className={showOverview?css.home:css.conversation} aria-busy={home&&!homeReady}>
  {notice}
  <div className={showOverview?css.homeConversation:css.body} hidden={home&&!homeReady}>
   {content}
  </div>
  {showOverview&&homeReady&&overview}
 </section>
}

import type {UiSession} from '@deepseek-ai/dsh-client-ui-session/client'
import type {SessionId} from '@deepseek-ai/dsh-session'
import {brandString} from '@deepseek-ai/dsh-brand'
import type {ISessions} from '@deepseek-ai/dsh-api-session-controller/client'
import type {BindingClient} from './binding-client.js'

export type MainSessionSource={subscribe:(listener:()=>void)=>()=>void;getSnapshot:()=>SessionId|undefined}

/** 主视图身份由原生 Session adapter 持有；这里只投影身份，不维护另一份选中状态。 */
export function mainSessionSource(uiSession:Pick<UiSession,'adapter'>):MainSessionSource{
  const source=uiSession.adapter.current
  return {
    subscribe:listener=>source.subscribe(listener),
    getSnapshot:()=>{const key=source.getSnapshot().key;return key===undefined?undefined:brandString<SessionId>(key)},
  }
}

type NativeSessionCatalog=Pick<ISessions,'list'|'subagentAddress'>

/** 来源只用于排除普通业务绑定，不作为子会话可继续执行的授权。 */
export function isNativeChildSession(sessions:NativeSessionCatalog,sessionId:SessionId):boolean{
  return sessions.subagentAddress(sessionId)!==undefined||sessions.list.getSnapshot().byId[sessionId]?.origin==='subagent'
}

/** 主视图不变时也接收原生目录补齐的子会话身份，避免恢复历史误走普通绑定。 */
export function observeMainSessionBinding(main:MainSessionSource,sessions:NativeSessionCatalog,work:Pick<BindingClient,'select'>):()=>void{
  let current:SessionId|undefined,nativeChild=false
  const sync=()=>{
    const next=main.getSnapshot(),nextChild=next!==undefined&&isNativeChildSession(sessions,next)
    if(next===current&&nextChild===nativeChild)return
    current=next;nativeChild=nextChild
    void work.select(next)
  }
  const offMain=main.subscribe(sync),offCatalog=sessions.list.subscribe(sync)
  sync()
  return ()=>{offMain();offCatalog();void work.select(undefined)}
}

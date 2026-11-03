import {useSyncExternalStore} from 'react'
import type {SessionEventSource,SessionEventLikeEntry} from '@deepseek-ai/dsh-api-session-controller/client'
import {bindEmployeeMentionEventSource,employeeMentionIdentity} from './employee-mention-presentation.js'
import css from './EmployeeMentionReplyLabel.module.css'

const empty={entries:[]},emptyRead=()=>empty,emptySubscribe=()=>()=>{}
/** 只署名已持久化的这个答复；流式暂未有final seq时不借用上一个员工身份。 */
export function EmployeeMentionReplyLabel({events,assistantSeq}:{events:Pick<SessionEventSource,'subscribe'|'getSnapshot'>|undefined;assistantSeq:number|undefined}){
 const source=bindEmployeeMentionEventSource(events)
 const snapshot=useSyncExternalStore<{entries:readonly SessionEventLikeEntry[]}>(source?.subscribe??emptySubscribe,source?.getSnapshot??emptyRead,source?.getSnapshot??emptyRead)
 const identity=assistantSeq===undefined?null:employeeMentionIdentity(snapshot.entries.flatMap(row=>row.type==='event'?[row.event]:[]),assistantSeq)
 return identity?<span className={css.label}>{identity.name}</span>:null
}

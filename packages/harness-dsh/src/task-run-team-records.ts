import type {SessionEvent,UserMessage} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-experimental-agent-team'
import type {} from '@deepseek-ai/dsh-subagent'
import type {TaskRunRuntimeLink} from '@teloa/backend'
type TaskRunTeamLink=Extract<TaskRunRuntimeLink,{kind:'team'}>

/** 升级前旧 mailbox 的待核对身份；不携带正文，也不授予重发许可。 */
export function pendingLegacyTeamMessages(events:readonly SessionEvent[]):readonly {teamId:string;messageId:string;senderId:string;senderName:string;targetId:string}[]{
 const delivered=new Set(events.flatMap(event=>event.type==='team/message/delivered'?[event.data.messageId]:[]))
 return events.flatMap(event=>{
  if(event.type!=='team/message/queued'||delivered.has(event.data.message.id))return []
  const {teamId,message}=event.data
  return [{teamId,messageId:message.id,senderId:message.senderId,senderName:message.senderName,targetId:message.targetId}]
 })
}

/** 消息正文不参与授权；身份全来自官方 producer 的结构化 source。 */
/** 群追加原生请求身份在续接集合中的键。 */
export const groupRunAppendKey=(rpcId:string)=>JSON.stringify(['group-append',rpcId])
export function taskRunTeamMessageKey(event:SessionEvent):string|undefined{
 if(event.type!=='user/message'||event.surfaceOp!=='append')return undefined
 return teamInputKey(event.data)
}
function teamInputKey(message:UserMessage):string|undefined{
 if(message.source.kind==='subagent-settled')return JSON.stringify(['subagent-settled',message.source.senderSessionId])
 if(message.source.kind==='agent-message'&&message.source.form==='relay')return JSON.stringify(['agent-message',message.source.senderSessionId,message.id])
 // 本人在原群对活动 Run 的追加：只有宿主持久登记过同一 rpcId 的回执，才会出现在续接集合里（见 group-run-append.ts）。
 if(message.source.kind==='user'&&'rpcId' in message.source&&typeof message.source.rpcId==='string')return groupRunAppendKey(message.source.rpcId)
 if(message.source.kind!=='team-message')return undefined
 const source=message.source
 return JSON.stringify([source.teamId,source.messageId,source.senderId,source.senderName])
}
/** 只认递送前该成员的最后一份 roster 状态，旧 active 不能覆盖退役事实。 */
export function taskRunTeamRelayGrant(events:readonly SessionEvent[],grants:readonly TaskRunTeamLink[],senderId:string,acceptedSeq:number):TaskRunTeamLink|undefined{
 const matches=grants.filter(grant=>{
  const latest=events.filter(row=>row.seq<acceptedSeq&&row.type==='team/member'&&String(row.data.teamId)===grant.sessionId&&row.data.member.id===senderId).sort((a,b)=>a.seq-b.seq).at(-1)
  return latest?.type==='team/member'&&latest.data.member.name===grant.payload.name&&latest.data.member.phase==='active'
 })
 return matches.length===1?matches[0]:undefined
}
/** 接纳新直接 Inbox 及旧持久 mailbox；两者都必须匹配此前获准的 active roster。 */
export function taskRunTeamContinuations(events:readonly SessionEvent[],grants:readonly TaskRunTeamLink[]):ReadonlySet<string>{
 const result=new Set<string>()
 for(const event of events){
  const messages=event.type==='user/message'&&event.surfaceOp==='append'?[event.data]:event.type==='agent/inbox/spliced'?event.data.inserted:[]
  for(const message of messages){
   if((message.source.kind==='agent-message'&&message.source.form==='relay'||message.source.kind==='subagent-settled')&&taskRunTeamRelayGrant(events,grants,message.source.senderSessionId,event.seq))result.add(teamInputKey(message)!)
  }
  if(event.type!=='team/message/queued')continue
  const {teamId,message}=event.data
  const grant=grants.find(grant=>grant.sessionId===teamId&&String(message.targetId)===String(teamId)&&events.some(row=>row.seq<event.seq&&row.type==='team/member'&&row.data.teamId===teamId&&row.data.member.id===message.senderId&&row.data.member.name===grant.payload.name&&row.data.member.phase==='active'))
  if(grant)result.add(JSON.stringify([teamId,message.id,message.senderId,message.senderName]))
 }
 return result
}

import type {SessionEvent} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-experimental-agent-team'
import type {} from '@deepseek-ai/dsh-subagent'
import type {TaskRunRuntimeLink} from '@teloa/backend'
type TaskRunTeamLink=Extract<TaskRunRuntimeLink,{kind:'team'}>

/** 消息正文不参与授权；身份全来自官方 producer 的结构化 source。 */
export function taskRunTeamMessageKey(event:SessionEvent):string|undefined{
 if(event.type!=='user/message'||event.surfaceOp!=='append')return undefined
 if(event.data.source.kind==='subagent-settled')return JSON.stringify(['subagent-settled',event.data.source.senderSessionId])
 if(event.data.source.kind!=='team-message')return undefined
 const source=event.data.source
 return JSON.stringify([source.teamId,source.messageId,source.senderId,source.senderName])
}
/** 只接纳确切获准成员发送、且已进入原生持久 mailbox 的 Lead 通知。 */
export function taskRunTeamContinuations(events:readonly SessionEvent[],grants:readonly TaskRunTeamLink[]):ReadonlySet<string>{
 const result=new Set<string>()
 for(const event of events){
  if(event.type==='user/message'&&event.surfaceOp==='append'&&event.data.source.kind==='subagent-settled'){
   const senderId=event.data.source.senderSessionId
   if(grants.some(grant=>events.some(row=>row.seq<event.seq&&row.type==='team/member'&&String(row.data.teamId)===grant.sessionId&&row.data.member.id===senderId&&row.data.member.name===grant.payload.name&&row.data.member.phase==='active')))result.add(taskRunTeamMessageKey(event)!)
  }
  if(event.type!=='team/message/queued')continue
  const {teamId,message}=event.data
  const grant=grants.find(grant=>grant.sessionId===teamId&&String(message.targetId)===String(teamId)&&events.some(row=>row.seq<event.seq&&row.type==='team/member'&&row.data.teamId===teamId&&row.data.member.id===message.senderId&&row.data.member.name===grant.payload.name&&row.data.member.phase==='active'))
  if(grant)result.add(JSON.stringify([teamId,message.id,message.senderId,message.senderName]))
 }
 return result
}

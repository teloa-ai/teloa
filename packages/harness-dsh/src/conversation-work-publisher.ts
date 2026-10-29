import {createHash} from 'node:crypto'
import type {Context} from '@deepseek-ai/cordis'
import {createUserMessage,type UserMessage} from '@deepseek-ai/dsh-llm'
import {brandString} from '@deepseek-ai/dsh-brand'
import type {SessionId,SessionStore} from '@deepseek-ai/dsh-session'
import {WorkError,readBusinessReassignmentReceipt,businessObjectReference} from '@teloa/contract'
import {readSessionEvents} from './session-events.ts'
import {conversationWorkSource} from './conversation-work-tools.ts'
import type {ConversationWorkStatus} from './conversation-work-dispatch.ts'

/** true 表示通知已进入持久会话；false 表示本人会话仍活动，原交办继续待回流。 */
export async function publishConversationWorkStatus(ctx:Context,status:ConversationWorkStatus,authorize:()=>Promise<void>,lockSignal?:AbortSignal):Promise<boolean>{
 lockSignal?.throwIfAborted()
 const reassignment=status.reassignment?readBusinessReassignmentReceipt(status.reassignment):undefined
 const sourceReference=status.sourceReference?businessObjectReference(status.sourceReference):undefined
 if(reassignment&&(reassignment.newRequestId!==status.requestId||reassignment.newSessionId!==status.sessionId||reassignment.scope!==status.scope)||sourceReference&&(!reassignment||sourceReference.scope!==status.scope))throw new WorkError('teloa/invalid-host-response','后继结果的原交办或固定来源不可核对。')
 const association=reassignment?{reassignment,...(sourceReference?{sourceReference}:{})}:{}
 const relation=reassignment?['原交办与后继关联（原材料保持固定，不表示业务已验收）：'+JSON.stringify(association)]:[]
 await authorize()
 lockSignal?.throwIfAborted()
 const resolved=await ctx.sessionController.resolveAgent(brandString<SessionId>(status.sessionId))
 lockSignal?.throwIfAborted()
 if('error' in resolved)throw new WorkError('teloa/session-unavailable','发起会话暂不可用，工作结果保留待回流。')
 // resolveAgent 可能等待恢复；追加任何正文前重新读取当前业务访问权。
 await authorize()
 lockSignal?.throwIfAborted()
 const agent=resolved.agent,session=agent.session,store=Reflect.get(ctx,'sessions') as unknown as SessionStore
 const idle=()=>{
  lockSignal?.throwIfAborted()
  if(ctx.agents.get(agent.id)!==agent||agent.session!==session||store.get(agent.id)!==session)throw new WorkError('teloa/session-unavailable','原本人会话已变化，工作结果保留待回流。')
  return agent.status==='idle'
 }
 // 保留后端 pending 通知，不借新输入队列绕过 native final admission，也不唤醒本人。
 if(!idle())return false
 const {observedAt:_,...stable}=status
 const c=status.counts,summary=`${status.title}：收到 ${c.received}，等待 ${c.waiting}，不可用 ${c.unavailable}，失败 ${c.failed}，已停止 ${c.stopped}`
 let text=[summary,...relation,'以下为本次真实执行结果；收到回复不等于业务已验收。',...status.members.map(member=>`### ${member.name}\n${member.reason??({received:'已收到',waiting:'等待回复',unavailable:'不可用',failed:'失败',stopped:'已停止'}[member.status])}${member.result?'\n\n'+member.result:''}`)].join('\n\n')
 const expanded=Buffer.byteLength(text,'utf8')<=131072
 if(!expanded){
  text=[summary,...relation,'结果较长，未在会话中展开；完整结果保留在原任务执行记录，仍待本人核对。请从本会话交办卡片打开以下任务：',...status.members.map(member=>{if(member.result&&!member.task)throw new WorkError('teloa/invalid-host-response','结果超过会话容量且缺少可核对的任务入口，保留待回流。');return member.task?`任务“${member.task.title}”（${member.task.id}）：${member.name}；${member.status}`:`${member.name}：${member.status}`})].join('\n\n')
  if(Buffer.byteLength(text,'utf8')>131072)throw new WorkError('teloa/invalid-host-response','交办结果入口超过会话容量，完整结果保留待回流。')
 }
 // 任务验收、版本等可变投影不构成新的执行结果。回执只固定通知及其真实来源；
 // 超长结果虽只展示入口，仍参与摘要，不能把两次不同正文当成同一通知。
 const delivery={...association,requestId:status.requestId,sessionId:status.sessionId,kind:status.kind,scope:status.scope,text,members:status.members.map(member=>({roleId:member.roleId,scope:member.scope,taskId:member.task?.id,runId:member.run?.id,runSessionId:member.run?.sessionId,result:member.result}))}
 const receipt='v2:'+createHash('sha256').update(JSON.stringify(delivery)).digest('hex'),legacyReceipt=createHash('sha256').update(JSON.stringify(stable)).digest('hex')
 const matches=(message:UserMessage)=>{
  if(message.source.kind!==conversationWorkSource||message.source.form!=='notice'||message.source.requestId!==status.requestId)return false
  const prior=message.source.receipt
  if(prior===receipt||prior===legacyReceipt)return true
  // 兼容已落盘的旧回执：只有完整相同正文才能证明同一结果；截短入口不作此推断。
  return expanded&&typeof prior==='string'&&/^[a-f0-9]{64}$/.test(prior)&&message.content.length===1&&message.content[0]?.type==='text'&&message.content[0].text===text
 }
 const events=readSessionEvents(session),existing=events.some(event=>event.type==='user/message'&&event.surfaceOp==='append'&&matches(event.data))
 if(!existing){
  // 检查与追加之间无 await；工具等待、流式请求和 pre-step 都只能等真实闲置后回流。
  if(!idle())return false
  const pendingCalls=new Set<string>()
  const eventBySeq=new Map(events.map(event=>[event.seq,event]))
  for(const seq of session.surface.nodes){
   const event=eventBySeq.get(seq)
   if(event?.type==='assistant/message'){for(const block of event.data.message.content)if(block.type==='tool-call')pendingCalls.add(block.id)}
   else if(event?.type==='tool/result')pendingCalls.delete(event.data.message.toolCallId)
  }
  // 冷恢复仍有未配对的旧调用时，不替 SDK 伪造结果或把 notice 插入原调用链。
  if(pendingCalls.size)return false
  const message=createUserMessage({source:{kind:conversationWorkSource,form:'notice',summary:summary.slice(0,120),requestId:status.requestId,receipt,...association},content:[{type:'text',text}]})
  session.append('user/message',message,{surfaceOp:'append'})
 }
 lockSignal?.throwIfAborted()
 const flushed=await store.flush(session),stillIdle=idle()
 if(!flushed)throw new WorkError('teloa/session-unavailable','原会话结果尚未持久化，请先核对原交办。')
 return stillIdle
}

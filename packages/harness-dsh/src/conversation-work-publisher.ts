import {createHash} from 'node:crypto'
import type {Context} from '@deepseek-ai/cordis'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import {brandString} from '@deepseek-ai/dsh-brand'
import type {SessionId,SessionStore} from '@deepseek-ai/dsh-session'
import {WorkError,readBusinessReassignmentReceipt,businessObjectReference} from '@teloa/contract'
import {readSessionEvents} from './session-events.ts'
import {conversationWorkSource} from './conversation-work-tools.ts'
import type {ConversationWorkStatus} from './conversation-work-dispatch.ts'

/** 使用官方 producer notice 和 Session 追加/持久化；不假造助手消息，不唤醒额外模型轮次。 */
export async function publishConversationWorkStatus(ctx:Context,status:ConversationWorkStatus,authorize:()=>Promise<void>,lockSignal?:AbortSignal):Promise<void>{
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
 const session=resolved.agent.session,{observedAt:_,...stable}=status
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
 const existing=readSessionEvents(session).some(event=>{
  if(event.type!=='user/message'||event.surfaceOp!=='append'||event.data.source.kind!==conversationWorkSource||event.data.source.form!=='notice'||event.data.source.requestId!==status.requestId)return false
  const prior=event.data.source.receipt
  if(prior===receipt||prior===legacyReceipt)return true
  // 兼容已落盘的旧回执：只有完整相同正文才能证明同一结果；截短入口不作此推断。
  return expanded&&typeof prior==='string'&&/^[a-f0-9]{64}$/.test(prior)&&event.data.content.length===1&&event.data.content[0]?.type==='text'&&event.data.content[0].text===text
 })
 if(!existing){
  lockSignal?.throwIfAborted()
  session.append('user/message',createUserMessage({source:{kind:conversationWorkSource,form:'notice',summary:summary.slice(0,120),requestId:status.requestId,receipt,...association},content:[{type:'text',text}]}),{surfaceOp:'append'})
 }
 const store=Reflect.get(ctx,'sessions') as unknown as SessionStore
 lockSignal?.throwIfAborted()
 if(!await store.flush(session))throw new WorkError('teloa/session-unavailable','原会话结果尚未持久化，请先核对原交办。')
 lockSignal?.throwIfAborted()
}

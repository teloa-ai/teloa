import {createHash} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import {boundContextSummary} from '@deepseek-ai/dsh-llm'
import type {SessionEvent} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-subagent'
import type {TaskRun,TaskRunRuntimeLink} from '@teloa/backend'
import {WorkError} from '@teloa/contract'
import {observeTaskRunTimeline} from './task-run-observation.ts'
import {taskRunTeamMessageKey} from './task-run-team-records.ts'

type Binding=Pick<TaskRun,'id'|'sessionId'|'nativeRequestId'|'allowedTools'>
function invalid():never{throw new WorkError('teloa/storage-corrupt','外部完成通知与原执行关系不一致，请核对原执行记录。')}
function pending():never{throw new WorkError('teloa/execution-pending','外部完成通知尚未进入本次执行快照，请稍后读取原执行记录。')}
const sha=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')

/**
 * 只投影已获本次原生审批、登记于本 Run、由父会话目录确认的外部完成通知。
 * 这不是执行授权：不恢复 Agent、不投递输入；复制 source.kind 或 child ID 不能成为续轮。
 */
export function taskRunExternalContinuations(run:Binding,events:readonly SessionEvent[],rows:readonly TaskRunRuntimeLink[],base:ReadonlySet<string>=new Set()):ReadonlySet<string>{
 const external=rows.filter(row=>row.kind==='external')
 if(!external.length)return new Set()
 if(events.some((event,index)=>event.seq!==index))invalid()
 const roots=events.filter(event=>event.type==='user/message'&&event.surfaceOp==='append'&&event.data.source.kind==='user'&&Reflect.get(event.data.source,'rpcId')===run.nativeRequestId)
 if(!roots.length){if(events.some(event=>event.type==='user/message'&&event.data.source.kind==='user'))invalid();pending()}
 if(roots.length!==1)invalid()
 const keys=new Set(base),result=new Set<string>(),children=new Set<string>(),reservations=new Set<string>()
 const ordered=external.map(row=>{
  const provider=row.payload.provider,name=provider==='codex'?'subagent_codex':'subagent_claude_code'
  if(row.runId!==run.id||row.sessionId!==run.sessionId||row.payload.requestId!==run.nativeRequestId||row.nativeId!==row.payload.reservationId||reservations.has(row.nativeId)||!run.allowedTools.includes(name))invalid()
  reservations.add(row.nativeId)
  const calls=events.filter((event):event is Extract<SessionEvent,{type:'tool/call'}>=>event.type==='tool/call'&&event.data.name===name&&row.nativeId==='external:'+sha([row.payload.runtimeId,run.sessionId,event.data.callId,provider]))
  if(!calls.length){
   if(events.some(event=>event.type==='tool/call'&&row.nativeId==='external:'+sha([row.payload.runtimeId,run.sessionId,event.data.callId,provider])))invalid()
   pending()
  }
  const call=calls[0];if(calls.length!==1||call?.type!=='tool/call')invalid()
  return {row,call}
 }).sort((a,b)=>a.call.seq-b.call.seq)
 for(const {row,call}of ordered){
  let owned=false
  observeTaskRunTimeline(events.slice(0,call.seq+1),run.nativeRequestId,keys,event=>{if(event===call)owned=true})
  if(!owned)invalid()
  if(['reserved','running','stopping'].includes(row.payload.status))continue
  if(row.payload.status==='unknown')invalid()
  const replies=events.filter(event=>event.type==='tool/result'&&event.data.message.toolCallId===call.data.callId),reply=replies[0]
  if(!replies.length){
   if(events.some(event=>event.seq>call.seq&&(event.type==='step/end'&&event.data.turn===call.data.turn&&event.data.step===call.data.step||event.type==='turn/end'&&event.data.turn===call.data.turn)))invalid()
   pending()
  }
  const assistants=events.filter(event=>event.type==='assistant/message'&&event.data.turn===call.data.turn&&event.data.step===call.data.step&&event.data.message.content.some(block=>block.type==='tool-call'&&block.id===call.data.callId)),assistant=assistants[0]
  const block=assistant?.type==='assistant/message'?assistant.data.message.content.find(block=>block.type==='tool-call'&&block.id===call.data.callId):undefined
  if(replies.length!==1||reply?.type!=='tool/result'||reply.data.turn!==call.data.turn||reply.data.step!==call.data.step||!isDeepStrictEqual(reply.sourceEventSeqs,[call.seq])||assistants.length!==1||!assistant||assistant.seq>=call.seq||block?.type!=='tool-call'||block.name!==call.data.name||!isDeepStrictEqual(block.arguments,call.data.arguments))invalid()
  const asks=events.filter(event=>event.type==='approval/asked'&&event.data.callId===call.data.callId&&event.data.toolName===call.data.name),ask=asks[0]
  if(asks.length!==1||ask?.type!=='approval/asked'||!(call.seq<ask.seq&&ask.seq<reply.seq))invalid()
  const decisions=events.filter(event=>event.type==='approval/decided'&&event.data.id===ask.data.id),decision=decisions[0]
  if(decisions.length!==1||decision?.type!=='approval/decided'||decision.data.outcome!=='allowed-once'||!(ask.seq<decision.seq&&decision.seq<reply.seq))invalid()
  if(!row.payload.activationId){
   // reserve 后启动失败尚未产生 child；只能保留同 call 的真实错误，不能捏造完成通知。
   if(row.payload.status!=='failed'||reply.data.message.isError!==true||events.some(event=>event.type==='subagent/catalog'&&call.seq<event.seq&&event.seq<reply.seq&&!external.some(other=>other.payload.activationId===event.data.childId)))invalid()
   continue
  }
  const child=row.payload.activationId;if(children.has(child))invalid();children.add(child)
  const catalog=events.filter(event=>event.type==='subagent/catalog'&&event.data.childId===child),discovered=catalog[0]
  if(catalog.length!==1||discovered?.type!=='subagent/catalog'||discovered.data.version!==2||discovered.data.mode!=='external'||reply.data.message.isError!==false||!(decision.seq<discovered.seq&&discovered.seq<reply.seq))invalid()
  const notices=events.flatMap(event=>event.type==='agent/inbox/spliced'?event.data.inserted.filter(message=>message.source.kind==='subagent-settled'&&message.source.senderSessionId===child).map(message=>({event,message})):[])
  // DB 终态读取可晚于已捕获的日志前缀；尚未看见通知只保留 pending，不能冻结第一轮占位。
  if(!notices.length){
   if(events.some(event=>event.type==='user/message'&&event.data.source.kind==='subagent-settled'&&event.data.source.senderSessionId===child))invalid()
   pending()
  }
  const notice=notices[0];if(notices.length!==1||!notice||notice.event.type!=='agent/inbox/spliced'||notice.event.data.inserted.length!==1||!['next-turn','next-step'].includes(notice.event.data.target)||notice.event.seq<=discovered.seq)invalid()
  const {message}=notice,source=message.source
  if(source.kind!=='subagent-settled'||source.form!=='notice'||Object.keys(source).some(key=>!['kind','form','summary','senderSessionId'].includes(key))||message.content.some(part=>part.type!=='text'))invalid()
  const subject=`Background subagent ${child}`,summaries=row.payload.status==='completed'?[`${subject} finished. It cannot receive follow-up messages.`]:row.payload.status==='aborted'?[`${subject} was stopped before it finished.`]:[`${subject} failed before it finished.`,`${subject} ran out of room before it finished.`,`${subject} declined the task.`]
  const first=message.content[0]
  if(first?.type!=='text'||!summaries.includes(first.text)||source.summary!==boundContextSummary(first.text))invalid()
  const consumed=events.filter(event=>event.type==='user/message'&&event.data.source.kind==='subagent-settled'&&event.data.source.senderSessionId===child)
  if(consumed.length>1||consumed.some(event=>event.type!=='user/message'||event.seq<=notice.event.seq||event.surfaceOp!=='append'||!isDeepStrictEqual(event.data,message)))invalid()
  const key=taskRunTeamMessageKey({type:'user/message',surfaceOp:'append',data:message} as SessionEvent);if(!key)invalid()
  result.add(key);keys.add(key)
 }
 return result
}

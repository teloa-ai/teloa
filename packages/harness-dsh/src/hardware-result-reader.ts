import type {HardwareOperation,HardwareReceipt} from '@teloa/contract'
import {observeNativeRequest,type VoiceConversationSession} from './voice-conversation-driver.ts'
import type {ConversationWorkStatus} from './conversation-work-dispatch.ts'

export const hardwareSpokenText=(text:string):string=>Array.from(text).length>1200?Array.from(text).slice(0,1170).join('')+'。请到 Teloa 查看完整结果。':text
/** 交办回执不是成果；只投影该原输入关联的正式工作和原审批。 */
export function hardwareWorkReceipt(base:HardwareReceipt,works:readonly ConversationWorkStatus[],awaitingApproval:boolean):HardwareReceipt{
 if(awaitingApproval)return {...base,state:'needs_approval',speakableText:'这项工作需要本人确认，请到 Teloa 原审批处理。'}
 if(!works.length)return base
 const members=works.flatMap(work=>work.members)
 if(members.length&&members.every(member=>member.status==='received'&&!!member.result))return {...base,state:'completed',speakableText:hardwareSpokenText(members.map(member=>member.name+'：'+member.result).join('\n'))}
 if(members.some(member=>['failed','stopped','unavailable'].includes(member.status)))return {...base,state:'unknown',speakableText:hardwareSpokenText('原工作尚未完整完成。'+members.filter(member=>member.status!=='received').map(member=>member.name+'：'+(member.reason??member.status)).join('；')+'。请到 Teloa 查看原任务。')}
 return {...base,state:'pending',speakableText:'工作还在进行，尚未收到完整成果，可以稍后问我结果。'}
}
/** 复用正式 Inbox/消息/轮次投影；连接和媒体结束不改变原结果。 */
export function readHardwareResult(operation:HardwareOperation,snapshot:VoiceConversationSession):HardwareReceipt{
 const result=observeNativeRequest({id:operation.nativeRequestId,text:operation.text},snapshot)
 const base={operationId:operation.id,resultRef:null}
 if(result.reply)return {...base,state:'completed',speakableText:hardwareSpokenText(result.reply.text),resultRef:{nativeRequestId:operation.nativeRequestId,messageId:result.reply.messageId,endSeq:result.reply.endSeq}}
 if(result.state==='active'||result.state==='queued')return {...base,state:'pending',speakableText:'还在处理这条请求，可以稍后问我结果。'}
 if(result.state==='ended')return {...base,state:'unknown',speakableText:'原轮次已结束，暂时没有可核对的完整回复，请到 Teloa 查看。'}
 return {...base,state:'unknown',speakableText:'原请求的受理状态待核对，请查询原操作，不要重新提交。'}
}

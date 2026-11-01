import type {SessionEvent} from '@deepseek-ai/dsh-session/types'

/** 完整官方日志的反证：既不能有目标输入，也不能把上一轮结束后的新活动当作空闲。 */
export function taskRunHasPublicationEvidence(events:readonly SessionEvent[],requestId:string):boolean{
 if(events.some(event=>event.type==='user/message'&&event.data.source.kind==='user'&&Reflect.get(event.data.source,'rpcId')===requestId||event.type==='agent/inbox/spliced'&&event.data.inserted.some(message=>Reflect.get(message.source,'rpcId')===requestId)))return true
 const lastEnd=events.map(event=>event.type).lastIndexOf('turn/end')
 return events.slice(lastEnd+1).some(event=>event.type==='user/message'||event.type==='turn/start'||event.type==='agent/inbox/spliced'&&event.data.inserted.length>0||/^(?:request|step|tool|assistant)\//.test(event.type))
}

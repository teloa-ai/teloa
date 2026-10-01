import type {SessionEvent} from '@deepseek-ai/dsh-session/types'
import {observeTaskRunTimeline} from './task-run-observation.ts'

/**
 * 只从本次已结束原生轮次的最终助手消息取回传正文。
 * 不读取工具事件、流式片段或下一轮内容，避免宿主把未经确认的内容写入群。
 */
export function readTaskRunGroupResult(events:readonly SessionEvent[],requestId:string,teamMessages?:ReadonlySet<string>):string|undefined{
 const {observation:observed,turn}=observeTaskRunTimeline(events,requestId,teamMessages)
 if(observed.state!=='ended')return undefined
 let result:string|undefined
 for(const event of events){
  if(event.seq<=observed.messageSeq||event.seq>=observed.endSeq||event.type!=='assistant/message'||event.surfaceOp!=='append'||event.data.turn!==turn||event.data.interrupted===true)continue
  const text=event.data.message.content.filter(block=>block.type==='text').map(block=>block.text).join('\n').trim()
  if(text)result=text
 }
 return result
}

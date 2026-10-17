import type {SessionEvent} from '@deepseek-ai/dsh-session/types'
import {observeTaskRunTimeline} from './task-run-observation.ts'
import {deliveryReviewResult,deliveryReviewSource} from './task-delivery-review.ts'
import type {GoalObservationContext} from '@teloa/contract'

/** 明确的非 stop 收尾（如 max-tokens）不是完整结果；没有流或 finish 记录的旧历史仍按完整处理。 */
function truncated(event:Extract<SessionEvent,{type:'assistant/message'}>):boolean{
 let finish:string|undefined
 for(const record of event.data.stream??[])if(record.type==='chunk'&&record.chunk.type==='finish')finish=record.chunk.reason.kind
 return finish!==undefined&&finish!=='stop'
}

/**
 * 只从本次已完成（reason=completed）原生轮次的最后一条助手消息取回传正文：错误或取消的轮次没有交付；
 * 末条被中断、明确截断或正文为空时同样没有交付，不回退该轮更早的草稿。
 * 不读取工具事件、流式片段或下一轮内容，避免宿主把未经确认的内容写入群。
 */
export function readTaskRunGroupResult(events:readonly SessionEvent[],requestId:string,teamMessages?:ReadonlySet<string>,goal?:GoalObservationContext,options?:{requireReview:true;runId:string}):string|undefined{
 const {observation:observed,turn}=observeTaskRunTimeline(events,requestId,teamMessages,undefined,goal)
 if(observed.state!=='ended'||observed.reason!=='completed')return undefined
 const window=events.filter(event=>event.seq>observed.messageSeq&&event.seq<observed.endSeq)
 // 经交付复核的轮次：草稿与编辑计划是中间稿，只取宿主应用后的复核交付（旧整篇改写会话取完整改写，见 task-delivery-review.ts）。
 // 工具证据冷读还须看见本请求的真实受理根；仅补同一原始轮起点，不纳入相邻请求。
 const reviewStart=window.some(event=>event.type==='user/message'&&event.data.source.kind===deliveryReviewSource&&Reflect.get(event.data.source,'toolEvidence')!==undefined)
  ?[...events].reverse().find(event=>event.type==='turn/start'&&event.seq<observed.messageSeq)?.seq:undefined
 const reviewed=deliveryReviewResult(reviewStart===undefined?window:events.filter(event=>event.seq>=reviewStart&&event.seq<observed.endSeq),turn)
 if(options?.requireReview){
  // 新 owner 成果只认本 Run 的正式两轮通过回执；旧正文与无协议历史仍可读，但不能隐式新定版。
  const inputs=window.filter((event):event is Extract<SessionEvent,{type:'user/message'}>=>event.type==='user/message'&&event.surfaceOp==='append'&&event.data.source.kind===deliveryReviewSource)
  const source=inputs.at(-1)?.data.source
  if(!options.runId||!inputs.length||inputs.some(event=>Reflect.get(event.data.source,'runId')!==options.runId)||!source||Reflect.get(source,'summary')!=='复核后交付'||Reflect.get(source,'protocol')===undefined||Reflect.get(source,'phase')!=='verify'||Reflect.get(source,'verdict')!=='accepted')return undefined
  return reviewed?.text
 }
 if(reviewed)return reviewed.text
 let last:Extract<SessionEvent,{type:'assistant/message'}>|undefined
 for(const event of window)if(event.type==='assistant/message'&&event.surfaceOp==='append'&&event.data.turn===turn)last=event
 if(!last||last.data.interrupted===true||truncated(last))return undefined
 const text=last.data.message.content.filter(block=>block.type==='text').map(block=>block.text).join('\n').trim()
 return text||undefined
}

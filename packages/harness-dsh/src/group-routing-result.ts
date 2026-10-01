import type {Context} from '@deepseek-ai/cordis'
import {brandString} from '@deepseek-ai/dsh-brand'
import type {SessionId} from '@deepseek-ai/dsh-session'
import type {SessionEvent} from '@deepseek-ai/dsh-session/types'
import {observeTaskRun} from './task-run-observation.ts'
import {readSessionEvents} from './session-events.ts'

/**
 * 本轮里是否混进了别的请求。判据照搬 `task-tool-guard.ts:52-55`：从 `from` 往前找到本轮的
 * `turn/start`，在 (那一条, `to`) 区间里只要出现一条 `rpcId` 不是本次请求的用户消息即为真。
 *
 * 路由会话按 (owner,groupId,day) 复用，同群同日的两条触发消息有可能挤进同一轮；一旦混入，
 * 谁的结论都不算数——模型看到的输入已经不是任何一方发出的那一份了。
 *
 * **前提**：`events` 必须是已经过 `observeTaskRun` 核验的那一份（它逐条要求 `event.seq===index`），
 * 本函数因此直接按下标取事件、按下标切区间，不再自己核对 `seq`。
 */
export function routingTurnMixed(events:readonly SessionEvent[],from:number,to:number,nativeRequestId:string):boolean{
 let start=Math.min(from,events.length-1)
 while(start>=0&&events[start]!.type!=='turn/start')start--
 return events.slice(start+1,to).some(event=>event.type==='user/message'&&event.surfaceOp==='append'&&event.data.source.kind==='user'&&(!('rpcId' in event.data.source)||event.data.source.rpcId!==nativeRequestId))
}

/**
 * 只从本次已结束原生轮次的最终助手消息取回正文。
 * 不读取工具事件、流式片段或下一轮内容，避免宿主把未经确认的内容当成路由结论。
 *
 * 五条判据与 `task-run-group-result.ts:8-17` 逐字同套，但签名不绑 `TaskRun`：路由会话没有 Run，
 * 复用那个函数会把 Run 概念带进没有 Run 的地方。`turn` 由调用方在等到终轮时读出并传进来，
 * 与日志里观察到的轮次对不上即整条作废（不去猜是哪一轮说的话）。
 * 本轮混入别的请求时同样交出 `undefined`：调用方不该把串轮的回答当成本次的结论。
 */
export function readGroupRoutingResult(events:readonly SessionEvent[],nativeRequestId:string,turn:number):string|undefined{
 const observed=observeTaskRun(events,nativeRequestId)
 if(observed.state!=='ended'||observed.turn!==turn)return undefined
 if(routingTurnMixed(events,observed.messageSeq,observed.endSeq,nativeRequestId))return undefined
 let result:string|undefined
 for(const event of events){
  if(event.seq<=observed.messageSeq||event.seq>=observed.endSeq||event.type!=='assistant/message'||event.surfaceOp!=='append'||event.data.turn!==turn||event.data.interrupted===true)continue
  const text=event.data.message.content.filter(block=>block.type==='text').map(block=>block.text).join('\n').trim()
  if(text)result=text
 }
 return result
}

/**
 * 路由会话的原生日志读口。会话取不到就交出空日志：调用方按「这一轮没说话」退化，不上抛。
 * 走 `readSessionEvents` 这唯一读口（规格 §八 G5），不新增对上游同步读的直接调用。
 */
export async function readRoutingEvents(ctx:Context,sessionId:string):Promise<readonly SessionEvent[]>{
 const resolved=await ctx.sessionController.resolveAgent(brandString<SessionId>(sessionId))
 if('error' in resolved)return []
 return readSessionEvents(resolved.agent.session)
}

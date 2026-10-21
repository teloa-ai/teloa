import type {GroupMessage,GroupRoutingDecisionView,GroupRoutingStatusView} from '@teloa/contract'

/** 员工真实回帖后的空候选只说明没有下一位接手人，不代表原本人问题失败。 */
export function groupRoutingFollowupIsIdle(message:GroupMessage|undefined,decision:GroupRoutingDecisionView|undefined,status:GroupRoutingStatusView):boolean{
 return !!message&&message.authorId!=='self'&&'runId' in message&&message.id===status.messageId&&decision?.messageId===message.id&&decision.kind==='no-candidate'&&decision.hops>0&&decision.respond.length===0&&status.phase==='unavailable'&&status.hintCode==='target-unavailable'&&status.recipients.length===0
}

/**
 * 话题面板「同事正在回复…」折叠行的纯派生（规格 §3.4）。
 * 不读运行状态——群运行今天读不回客户端；判据只有一条：路由决策选中的同事，
 * 只要还没在本话题的消息目录里出现过 authorId，就算还在回复。
 * 代价是运行失败且永不回帖时这一行会一直挂着，所以用触发消息的时间兜底：
 * 超过 30 分钟一律不再显示（纯客户端判断，不落库）。
 */
export const groupRoutingPendingWindowMs=30*60*1000

export function groupRoutingPending(decision:GroupRoutingDecisionView,messages:readonly GroupMessage[],now:number):string[]{
 if(decision.respond.length===0)return []
 const trigger=messages.find(message=>message.id===decision.messageId)
 if(!trigger)return []
 const at=Date.parse(trigger.createdAt)
 if(!Number.isFinite(at)||now-at>groupRoutingPendingWindowMs)return []
 const spoken=new Set(messages.map(message=>message.authorId))
 return decision.respond.filter(roleId=>!spoken.has(roleId))
}

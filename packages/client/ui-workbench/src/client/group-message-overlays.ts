import type {GroupMessage,GroupRoutingStatusView} from '@teloa/contract'

export const groupMainMessages=(messages:readonly GroupMessage[])=>messages.filter(message=>message.rootId===null||'runId' in message&&message.contextMode==='main')

/** 两个并列消息流各保留名额；当前话题先取，空余名额由另一流补足。 */
export function groupMessageOverlayIds(main:readonly GroupMessage[],topic:readonly GroupMessage[],cap:number,visible:{main?:readonly string[];topic?:readonly string[]}={}):string[]{
 const mainRows=groupMainMessages(main)
 const mainLimit=Math.min(mainRows.length,Math.floor(cap/2)),topicLimit=Math.min(topic.length,cap-mainLimit)
 const windowIds=(rows:readonly GroupMessage[],limit:number,shown:readonly string[]=[],root?:string)=>{
  const allowed=new Set(rows.map(message=>message.id)),latest=rows.at(-1)?.id
  // 最新消息与话题根不被滚动中的旧消息挤掉；其余优先覆盖当前实际可见窗口，再从尾部补足。
  return [...new Set([...(latest?[latest]:[]),...(root?[root]:[]),...shown.filter(id=>allowed.has(id)),...rows.map(message=>message.id).reverse()])].slice(0,limit)
 }
 const topicWindow=windowIds(topic,cap,visible.topic,topic[0]?.rootId===null?topic[0].id:undefined),mainWindow=windowIds(mainRows,cap,visible.main)
 return [...new Set([...topicWindow.slice(0,topicLimit),...mainWindow.slice(0,cap-topicLimit),...topicWindow,...mainWindow])].slice(0,cap)
}

// received 没有路由唤醒，不代表旧消息仍在执行；只有窗口内或关联活动工作的 received 需要读取。
const settled=new Set(['received','completed','recorded','routing-failed','unavailable','blocked','stopped'])
const changing=(status:GroupRoutingStatusView)=>!settled.has(status.phase)||status.recipients.some(person=>!settled.has(person.phase))

/** 状态只读取本人消息；已知在途工作独立于表情窗口持续刷新，直到收到真实终态。 */
export function groupMessageStatusIds(main:readonly GroupMessage[],topic:readonly GroupMessage[],cap:number,previous:readonly GroupRoutingStatusView[],workMessageIds:readonly string[]=[],visible:{main?:readonly string[];topic?:readonly string[]}={}):string[]{
 const own=(rows:readonly GroupMessage[])=>rows.filter(message=>!('runId' in message))
 const allowed=new Set(own([...main,...topic]).map(message=>message.id))
 return [...new Set([...groupMessageOverlayIds(own(main),own(topic),cap,visible),...previous.filter(changing).map(status=>status.messageId),...workMessageIds])].filter(id=>allowed.has(id))
}

/** 本轮窗口与在途工作保留缓存，成功批次替换原状态，失败批次保留；窗口外终态随下一轮退役。 */
export function mergeGroupMessageStatuses(previous:readonly GroupRoutingStatusView[],trackedIds:readonly string[],requested:readonly string[],rows:readonly GroupRoutingStatusView[]):GroupRoutingStatusView[]{
 const allowed=new Set(trackedIds),replaced=new Set(requested)
 return [...previous.filter(status=>allowed.has(status.messageId)&&!replaced.has(status.messageId)),...rows.filter(status=>allowed.has(status.messageId))]
}

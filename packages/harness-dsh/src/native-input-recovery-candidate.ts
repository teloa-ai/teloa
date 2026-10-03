import type {InboxState} from '@deepseek-ai/dsh-agent'
import type {SessionEvent,UserMessage} from '@deepseek-ai/dsh-session'
import {nativeInputIdentity} from './native-input-access.ts'
import type {NativeCheckpointSnapshot,NativeInputRoot} from './native-input-checkpoint.ts'

export type NativeInputRecoveryCandidateInput=Readonly<{
 snapshot:NativeCheckpointSnapshot
 /** 与完整快照同一观测点的官方完整 Inbox 投影；不能使用缓存或人为挑选的消息子集。 */
 inbox:InboxState|undefined
}>
/** 只描述数据候选；没有许可断言、消费票据或执行能力。 */
export type NativeInputRecoveryCandidate=Readonly<{
 sessionId:string
 messages:readonly UserMessage[]
 roots:readonly NativeInputRoot[]
 acceptedEvents:readonly SessionEvent[]
}>

function canonical(value:unknown):string{
 if(value===null||typeof value!=='object'){
  const text=JSON.stringify(value);if(text===undefined)throw Error('invalid recovery candidate')
  return text
 }
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']'
 return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(Reflect.get(value,key))).join(',')+'}'
}

/**
 * 复用官方完整 Inbox 投影，只筛选可以进一步核验持久受理记录的全部原始根。
 * 不读取账号、许可或账本，不打开 Agent，不重放 Inbox，也不因候选数据授予恢复权限。
 * 返回集合独立冻结，不修改或冻结调用方的官方快照与投影对象。
 */
export function nativeInputRecoveryCandidate({snapshot,inbox}:NativeInputRecoveryCandidateInput):NativeInputRecoveryCandidate|undefined{
 try{
  const {header,events,inheritedEventCount}=snapshot
  if(typeof header.id!=='string'||!header.id||!Array.isArray(events)||!Number.isSafeInteger(inheritedEventCount)||inheritedEventCount<0||inheritedEventCount>events.length||events.some((event,index)=>event.seq!==index))return
  if(!inbox||!Array.isArray(inbox['next-turn'])||!Array.isArray(inbox['next-step'])||!inbox['next-turn'].length||inbox['next-step'].length)return
  const messages=[...inbox['next-turn']],acceptedEvents:SessionEvent[]=[],roots:NativeInputRoot[]=[]
  if(new Set(messages.map(message=>message.id)).size!==messages.length)return
  // 未结束的已领取轮次可能有未知外部成果，不能因仍有其他 pending 根而重放。
  let activeTurn=false,claimed=false
  for(const event of events){
   if(event.type==='turn/start'){activeTurn=true;claimed=false}
   else if(event.type==='turn/end'){activeTurn=false;claimed=false}
   else if(activeTurn&&event.type==='agent/inbox/spliced'&&(event.data.removedCount??0)>0)claimed=true
  }
  if(activeTurn&&claimed)return
  for(const message of messages){
   const matches=events.filter(event=>event.type==='agent/inbox/spliced'&&event.data.inserted.some((inserted:UserMessage)=>inserted.id===message.id))
   const event=matches[0]
   if(matches.length!==1||!event||event.type!=='agent/inbox/spliced'||event.seq<inheritedEventCount||event.data.target!=='next-turn'||event.data.inserted.length!==1||message.source.kind==='tool'||canonical(event.data.inserted[0])!==canonical(message))return
   const rpcId=Reflect.get(message.source,'rpcId')
   if(rpcId!==undefined&&(typeof rpcId!=='string'||!rpcId))return
   const identity=nativeInputIdentity(message,typeof rpcId==='string'?rpcId:undefined)
   acceptedEvents.push(event)
   roots.push(Object.freeze({sessionId:header.id,messageId:identity.messageId,nativeRequestId:identity.nativeRequestId??null,payloadSha256:identity.payloadSha256}))
  }
  return Object.freeze({sessionId:header.id,messages:Object.freeze(messages),roots:Object.freeze(roots),acceptedEvents:Object.freeze(acceptedEvents)})
 }catch{return undefined}
}

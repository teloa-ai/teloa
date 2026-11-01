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

export type NativePendingInputOccurrence=Readonly<{
 message:UserMessage
 event:SessionEvent & {type:'agent/inbox/spliced'}
 target:'next-turn'|'next-step'
}>

/**
 * 重放真实队列位置，只认可尚未领取项的同位一换一编辑。
 * 历史已移出 id、跨队列重复或改写来源不能成为新的受理根；不产生许可。
 */
export function nativePendingInputOccurrence(events:readonly SessionEvent[],messageId:string):NativePendingInputOccurrence|undefined{
 try{
  const queues:{'next-turn':NativePendingInputOccurrence[];'next-step':NativePendingInputOccurrence[]}={'next-turn':[],'next-step':[]}
  const seen=new Set<string>(),invalid=new Set<string>()
  for(const event of events){
   if(event.type!=='agent/inbox/spliced')continue
   const {target,start,inserted}=event.data,removedCount=event.data.removedCount??0
   if((target!=='next-turn'&&target!=='next-step')||!Number.isSafeInteger(start)||start<0||start>queues[target].length||!Number.isSafeInteger(removedCount)||removedCount<0||removedCount>queues[target].length-start)return
   const queue=queues[target],removed=queue.slice(start,start+removedCount)
   for(const message of inserted){
    if(seen.has(message.id)){
     const previous=removed[0]
     if(event.data.outcome!=='canceled'||removedCount!==1||inserted.length!==1||!previous||previous.message.id!==message.id||message.source.kind!=='user'||canonical(previous.message.source)!==canonical(message.source))invalid.add(message.id)
    }
    seen.add(message.id)
   }
   queue.splice(start,removedCount,...inserted.map(message=>({message,event,target})))
  }
  if(invalid.has(messageId))return
  const matches=[...queues['next-turn'],...queues['next-step']].filter(row=>row.message.id===messageId)
  return matches.length===1?matches[0]:undefined
 }catch{return undefined}
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
   else if(activeTurn&&event.type==='agent/inbox/spliced'&&event.data.outcome!=='canceled'&&(event.data.removedCount??0)>0)claimed=true
  }
  if(activeTurn&&claimed)return
  for(const message of messages){
   const occurrence=nativePendingInputOccurrence(events,message.id),event=occurrence?.event
   if(!occurrence||!event||event.seq<inheritedEventCount||occurrence.target!=='next-turn'||event.data.inserted.length!==1||message.source.kind==='tool'||canonical(occurrence.message)!==canonical(message))return
   const rpcId=Reflect.get(message.source,'rpcId')
   if(rpcId!==undefined&&(typeof rpcId!=='string'||!rpcId))return
   const identity=nativeInputIdentity(message,typeof rpcId==='string'?rpcId:undefined)
   acceptedEvents.push(event)
   roots.push(Object.freeze({sessionId:header.id,messageId:identity.messageId,nativeRequestId:identity.nativeRequestId??null,payloadSha256:identity.payloadSha256}))
  }
  return Object.freeze({sessionId:header.id,messages:Object.freeze(messages),roots:Object.freeze(roots),acceptedEvents:Object.freeze(acceptedEvents)})
 }catch{return undefined}
}

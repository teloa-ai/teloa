import type {ISessions} from '@deepseek-ai/dsh-api-session-controller/client'
import type {SessionSeq} from '@deepseek-ai/dsh-session'
import {isResourceHistoryPage,parseResourceReferences,type ResourceHistoryItem} from '@teloa/contract'
import type {ResourceApi} from './resource-api.js'
import {readNativeSessionForOpening} from './native-session-opening.ts'

declare module '@deepseek-ai/dsh-api-session-controller/client'{interface SessionReferenceSourceMap{teloaResourceCitation:unknown}}
export type ResourceMessageTarget={id:string;messageId:string}
export type ResourceOriginalMessage={sessionId:string;messageId:string;seq:number;at:string;text:string;references:ResourceHistoryItem['references']}
export type NativeResourceMessageApi={read:(target:ResourceMessageTarget,signal:AbortSignal)=>Promise<ResourceOriginalMessage>}
const unavailable=()=>Object.assign(Error('原消息历史暂时无法核对，请重试。'),{code:'teloa/source-unavailable'})

/** 先由本人资料历史核对自有消息指针，再读官方 SessionReference；继承消息、同名和当前版本均不能替代原消息。 */
export function createNativeResourceMessageApi(sessions:()=>ISessions,history:ResourceApi['history']):NativeResourceMessageApi{
 return {async read(target,signal){
  const owner=sessions(),current=()=>{signal.throwIfAborted();if(sessions()!==owner)throw unavailable()}
  current()
  const id=await readNativeSessionForOpening(owner,target.id)
  current()
  let before:number|undefined,pointer:ResourceHistoryItem|undefined
  while(!pointer){
   const page=await history(target.id,before,signal);current()
   if(!isResourceHistoryPage(page)||page.sessionId!==target.id)throw unavailable()
   pointer=page.items.find(item=>item.messageId===target.messageId)
   if(pointer)break
   if(page.nextBeforeSeq===null)throw unavailable()
   if(before!==undefined&&page.nextBeforeSeq>=before)throw unavailable()
   before=page.nextBeforeSeq
  }
  if(pointer.issue)throw unavailable()
  const original=pointer
  return owner.using(id,{source:'teloaResourceCitation',signal},async reference=>{
   const binding=await reference.ready;current()
   if(reference.sessionId!==id||binding.sessionId!==id||binding.session.sessionId!==id||owner.binding(id)!==binding)throw unavailable()
   await binding.session.loadThrough(original.seq as SessionSeq);current()
   if(owner.binding(id)!==binding)throw unavailable()
   const entries=binding.eventSource.getSnapshot().entries
   const matches=entries.filter(entry=>entry.type==='event'&&entry.event.type==='user/message'&&entry.event.seq===original.seq&&entry.event.data.id===target.messageId)
   if(matches.length!==1)throw unavailable()
   const event=matches[0]!.event
   if(event.type!=='user/message'||event.data.source.kind!=='user'||new Date(event.time).toISOString()!==original.at)throw unavailable()
   const text=event.data.content.filter(block=>block.type==='text').map(block=>block.text).join('\n')
   const references=parseResourceReferences(text)
   if(JSON.stringify(references.map(({id,version})=>({id,version})))!==JSON.stringify(original.references.map(({id,version})=>({id,version}))))throw unavailable()
   current()
   return {sessionId:target.id,messageId:target.messageId,seq:original.seq,at:original.at,text,references:original.references}
  })
 }}
}

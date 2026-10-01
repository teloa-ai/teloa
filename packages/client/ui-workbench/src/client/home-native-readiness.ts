import type {ISessions,SessionBinding} from '@deepseek-ai/dsh-api-session-controller/client'
import type {SessionId} from '@deepseek-ai/dsh-session'

/** 目录 blank 只是提示；恢复草稿须打开官方历史并核对真实受理，读取失败不推断为空。 */
export async function readHomeNativeBlank(sessions:ISessions,sessionId:SessionId,queued:(binding:SessionBinding)=>boolean):Promise<boolean|undefined>{
 if(!sessions.list.getSnapshot().byId[sessionId])return undefined
 return sessions.using(sessionId,{source:'controllerOperation'},async reference=>{
  await reference.ready
  const {session,eventSource}=reference.binding
  for(;;){
   const snapshot=session.getSnapshot(),events=eventSource.getSnapshot()
   if(snapshot.openState!=='open'||snapshot.removed)throw Error('待用会话历史尚未核对，请重试。')
   if(snapshot.awaitingFirstTurn||queued(reference.binding)||events.entries.some(entry=>entry.event.type==='user/message'&&entry.event.surfaceOp==='append'&&entry.event.data.source.kind==='user'))return false
   if(!snapshot.hasMore)return snapshot.pendingSubmissions.length?undefined:true
   const revision=events.revision
   await session.loadOlder()
   if(eventSource.getSnapshot().revision===revision)throw Error('待用会话历史尚未核对，请重试。')
  }
 })
}

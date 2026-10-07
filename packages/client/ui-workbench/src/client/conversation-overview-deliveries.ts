import type {SessionEventLikeEntry} from '@deepseek-ai/dsh-api-session-controller/client'
import type {ConversationOverviewArtifact} from './conversation-overview-model.js'
import {producedFilePath} from './produced-files.ts'

const record=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)
/** 只列显式交付；读取、编辑和命令输出本身不等于给用户的成果。 */
export function conversationOverviewDeliveries(sessionId:string,entries:readonly SessionEventLikeEntry[],cwd:string|undefined):readonly ConversationOverviewArtifact[]{
 const events=entries.flatMap(entry=>entry.type==='event'?[entry.event]:[]).sort((a,b)=>a.seq-b.seq)
 let inherited=-1
 for(const event of events)if(event.type==='session/end-seed'&&event.data.inherited===true)inherited=event.seq
 const latest=new Map<string,ConversationOverviewArtifact>()
 for(const event of events){
  if(event.seq<=inherited||String(event.type)!=='deliverables/presented')continue
  const data:unknown=event.data
  if(!record(data))continue
  if(!Number.isSafeInteger(data.turn)||(data.turn as number)<1||typeof data.callId!=='string'||!data.callId||!Array.isArray(data.files))continue
  for(const file of data.files){
   if(!record(file)||typeof file.path!=='string'||(file.description!==undefined&&typeof file.description!=='string'))continue
   const path=producedFilePath(file.path,cwd)
   if(!path)continue
   const name=path.split('/').at(-1)!,extension=name.includes('.')?name.split('.').at(-1)!.toLowerCase():''
   latest.set(path,{id:JSON.stringify(['delivery',sessionId,event.seq,path]),sessionId,path,label:name,kind:['md','markdown','mdown'].includes(extension)?'Markdown':extension.toUpperCase()||'File',status:'unknown',seq:event.seq})
  }
 }
 return [...latest.values()].reverse()
}

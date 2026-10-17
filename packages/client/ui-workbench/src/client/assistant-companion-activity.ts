import {brandString} from '@deepseek-ai/dsh-brand'
import type {SessionId} from '@deepseek-ai/dsh-session/types'
import type {SessionEventLikeEntry,SessionSnapshot} from '@deepseek-ai/dsh-api-session-controller/client'
import {projectConversationOverviewSnapshot} from './conversation-overview-model.ts'

declare module '@deepseek-ai/dsh-api-session-controller/client' {interface SessionReferenceSourceMap {assistantCompanion:unknown}}
type Source<T>={getSnapshot:()=>T;subscribe:(listener:()=>void)=>()=>void}
type AssistantSessionState=Pick<SessionSnapshot,'sessionId'|'running'|'removed'|'openState'|'lastAgentError'|'promptError'|'awaitingFirstTurn'|'subagent'>
type AssistantBinding={sessionId:SessionId;session:Source<AssistantSessionState>;eventSource:Source<{entries:readonly SessionEventLikeEntry[]}>}
type AssistantReference={binding:AssistantBinding;ready:Promise<AssistantBinding>;release:()=>void}
export type AssistantCompanionActivityServices={
 sessions:{list:Source<{phase:string;ids:readonly string[]}>;binding:(id:SessionId)=>AssistantBinding|undefined;retain:(id:SessionId,options:{source:'assistantCompanion'})=>AssistantReference}
 connection:Source<string>
}
export type AssistantCompanionActivitySnapshot={status:'idle'|'processing'|'completed'|'waiting'|'stopped'|'failed'|'unknown';pose:'standing'|'reading'|'celebrating';sessionId?:string}
const idle:AssistantCompanionActivitySnapshot={status:'idle',pose:'standing'}
const lastSequence=(entries:readonly SessionEventLikeEntry[])=>entries.reduce((seq,entry)=>entry.type==='event'?Math.max(seq,entry.event.seq):seq,-1)

/** 只持有已核验助手原会话的读取引用；不会选中会话、发送输入、启动或停止工作。 */
export function createAssistantCompanionActivity(){
 const listeners=new Set<()=>void>()
 let checked=false,selected:string|undefined,services:AssistantCompanionActivityServices|undefined,reference:AssistantReference|undefined,ready=false,baseline=-1,epoch=0,syncing=false,offBinding:(()=>void)[]=[],snapshot:AssistantCompanionActivitySnapshot=idle
 const publish=(next:AssistantCompanionActivitySnapshot)=>{if(next.status===snapshot.status&&next.pose===snapshot.pose&&next.sessionId===snapshot.sessionId)return;snapshot=next;for(const listener of [...listeners])listener()}
 const clearBinding=()=>{epoch++;for(const off of offBinding)off();offBinding=[];reference?.release();reference=undefined;ready=false;baseline=-1}
 const read=()=>{
  if(!selected){publish(checked?idle:{status:'unknown',pose:'standing'});return}
  const unknown:AssistantCompanionActivitySnapshot={sessionId:selected,status:'unknown',pose:'standing'}
  if(!services||services.connection.getSnapshot()!=='connected'||!reference||!ready||services.sessions.binding(brandString<SessionId>(selected))!==reference.binding){publish(unknown);return}
  const binding=reference.binding,state=binding.session.getSnapshot()
  if(binding.sessionId!==selected||state.sessionId!==selected||state.removed||state.subagent!==null||state.openState!=='open'){publish(unknown);return}
  const view=projectConversationOverviewSnapshot({sessionId:selected,session:state,entries:binding.eventSource.getSnapshot().entries,connected:true})
  let status:AssistantCompanionActivitySnapshot['status']=view.status==='running'||state.awaitingFirstTurn&&!state.lastAgentError&&!state.promptError?'processing':view.status==='stopping'?'processing':view.status
  // 首次读取和每次重连只建立基线；恢复历史 completed 不是新完成事件，不能重新庆祝。
  if(status==='completed'&&(view.currentRound?.endSeq===undefined||view.currentRound.endSeq<=baseline))status='idle'
  publish({sessionId:selected,status,pose:status==='completed'?'celebrating':status==='processing'?'reading':'standing'})
 }
 const sync=()=>{
  if(syncing)return
  syncing=true
  try{
   if(!selected||!services||services.connection.getSnapshot()!=='connected'||services.sessions.list.getSnapshot().phase!=='ready'||!services.sessions.list.getSnapshot().ids.includes(selected)){clearBinding();read();return}
   const id=brandString<SessionId>(selected)
   if(reference&&services.sessions.binding(id)===reference.binding){read();return}
   clearBinding()
   const token=epoch,current=services.sessions.retain(id,{source:'assistantCompanion'})
   reference=current;offBinding=[current.binding.session.subscribe(sync),current.binding.eventSource.subscribe(sync)];read()
   void current.ready.then(binding=>{
    if(token!==epoch||reference!==current||!services||services.sessions.binding(id)!==binding||binding!==current.binding)return
    baseline=lastSequence(binding.eventSource.getSnapshot().entries);ready=true;read()
   },()=>{if(token===epoch&&reference===current){clearBinding();read()}})
  }catch{clearBinding();read()}finally{syncing=false}
 }
 return {
  subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener)}},getSnapshot:()=>snapshot,
  /** 调用方必须先按本人目录、general/null上下文及归档状态核对原助手身份。 */
  setSession:(sessionId:string|undefined)=>{if(checked&&selected===sessionId)return;clearBinding();checked=true;selected=sessionId;sync()},
  invalidate:()=>{clearBinding();checked=false;selected=undefined;read()},
  attach:(next:AssistantCompanionActivityServices)=>{clearBinding();services=next;const off=[next.sessions.list.subscribe(sync),next.connection.subscribe(sync)];sync();return()=>{for(const dispose of off)dispose();if(services===next){clearBinding();services=undefined;read()}}},
 }
}
export type AssistantCompanionActivity=ReturnType<typeof createAssistantCompanionActivity>

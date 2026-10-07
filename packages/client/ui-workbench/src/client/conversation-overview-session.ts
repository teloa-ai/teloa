import type {ISessions,SessionBinding,SessionReference} from '@deepseek-ai/dsh-api-session-controller/client'
import type {IJobs} from '@deepseek-ai/dsh-api-job-controller/client'
import type {ObservableSnapshot} from '@deepseek-ai/dsh-client-store'
import type {SubagentAddress,SubagentCatalogEntry} from '@deepseek-ai/dsh-subagent/client'
import type {ToolResourceUseSnapshot} from '@teloa/contract'
import {conversationOverviewRoundScopes,createConversationOverviewModel,type ConversationOverviewArtifact,type ConversationOverviewChild,type ConversationOverviewRoundScope,type ConversationOverviewSnapshot,type ConversationOverviewWork} from './conversation-overview-model.ts'
import {collectConversationOverviewResources,type ConversationOverviewRelatedResourceSession} from './conversation-overview-resources.ts'

declare module '@deepseek-ai/dsh-api-session-controller/client' {
 interface SessionReferenceSourceMap {workOverview:unknown}
}

export type ConversationOverviewSessionOptions={
 readonly binding:SessionBinding
 readonly sessions:ISessions
 readonly jobs:IJobs
 readonly connection:ObservableSnapshot<string>
 readonly pendingInteraction?:ObservableSnapshot<boolean>
 readonly artifacts?:ObservableSnapshot<readonly ConversationOverviewArtifact[]>
 readonly resourceUseSnapshots?:ObservableSnapshot<readonly ToolResourceUseSnapshot[]>
 readonly executorName?:()=>string|undefined
}
type Child={catalog:SubagentCatalogEntry;address:SubagentAddress;reference:SessionReference;binding:SessionBinding;off:(()=>void)[];failed:boolean}
type Stop={status:'stopping'|'unknown';epoch:number;throughSeq:number}
const record=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)
function catalogRows(value:unknown):SubagentCatalogEntry[]{
 if(!Array.isArray(value))return []
 return value.filter((row:unknown)=>record(row)&&typeof row.id==='string'&&typeof row.createdAt==='number'&&['one-shot','continuable','unknown'].includes(String(row.mode))) as SubagentCatalogEntry[]
}
function sameAddress(left:SubagentAddress|undefined,right:SubagentAddress):boolean{
 return left?.parentSessionId===right.parentSessionId&&left.childSessionId===right.childSessionId&&(left.mode===right.mode||right.mode==='unknown')
}
function admitted(result:unknown):void{
 if(!record(result)||result.ok!==true){
  const failure=record(result)&&record(result.error)?result.error:undefined
  throw Object.assign(Error(typeof failure?.message==='string'?failure.message:'停止请求未获宿主确认。'),{rpcError:failure})
 }
}

/** 持有现有会话的读取引用与名册，不取得Agent执行所有权，也不启动新工作。 */
export function createConversationOverviewSession(options:ConversationOverviewSessionOptions){
 const {binding,sessions,jobs,connection}=options
 const catalog=binding.session.projections.faceOf('subagentCatalog')
 const children=new Map<string,Child>(),stops=new Map<string,Stop>(),listeners=new Set<()=>void>(),activityListeners=new Set<()=>void>()
 let references=0,disposed=false,epoch=0,revision=0,syncing=false,syncAgain=false,off:(()=>void)[]=[],detachModel:(()=>void)|undefined
 const current=()=>!disposed&&sessions.binding(binding.sessionId)===binding&&!binding.session.getSnapshot().removed
 const connected=()=>current()&&connection.getSnapshot()==='connected'
 const changed=()=>{revision++;for(const listener of [...activityListeners])listener()}
 const activity={getSnapshot:()=>revision,subscribe:(listener:()=>void)=>{activityListeners.add(listener);return()=>{activityListeners.delete(listener)}}}
 const childCurrent=(child:Child)=>!child.failed&&sessions.binding(child.catalog.id)===child.binding&&!child.binding.session.getSnapshot().removed&&sameAddress(child.binding.session.getSnapshot().subagent?.address,child.address)
 const readChildren=():ConversationOverviewChild[]=>catalogRows(catalog.getSnapshot()).map(row=>{
  const child=children.get(row.id)
  if(!child||!childCurrent(child)||!connected())return row
  const state=child.binding.session.getSnapshot(),timing=child.binding.session.projections.faceOf('subagentTiming').getSnapshot()
  return {...row,mode:state.subagent!.address.mode,parentAvailable:state.subagent?.parentAvailable!==false&&state.openState==='open',...(state.openState==='open'?{running:state.running,entries:child.binding.eventSource.getSnapshot().entries}:{}),...(record(timing)&&typeof timing.lastTurnCompleted==='boolean'?{lastTurnCompleted:timing.lastTurnCompleted}:{})}
 })
 const relatedResources=({round,entries}:ConversationOverviewRoundScope):ConversationOverviewRelatedResourceSession[]=>{
  const related:ConversationOverviewRelatedResourceSession[]=[]
  // 同turn追加人类输入切界时，turn/start可能在范围之前；round.turn已由真实事件确定。
  let parentTurn:number|undefined=round.turn
  for(const entry of entries){
   const event=entry.event
   if(event.type==='turn/start')parentTurn=event.data.turn
   if(event.type==='turn/end')parentTurn=undefined
   // client入口只导出浏览器词汇，catalog的宿主扩充不在该入口；依公开payload显式窄化。
   const fact:unknown=event
   if(!record(fact)||fact.type!=='subagent/catalog'||!record(fact.data)||typeof fact.data.childId!=='string'||parentTurn===undefined||!round.turns.includes(parentTurn))continue
   const child=children.get(fact.data.childId)
   if(!child||!childCurrent(child))continue
   const childEntries=child.binding.eventSource.getSnapshot().entries
   // SDK将带inherited标记的seq校验为精确继承长度；标记未载入时不补猜0。
   const markers=childEntries.filter(item=>item.type==='event'&&item.event.type==='session/end-seed'&&item.event.data.inherited===true)
   const marker=markers.at(-1)
   if(!marker||!Number.isSafeInteger(marker.event.seq)||marker.event.seq<0)continue
   related.push({sessionId:child.catalog.id,executorId:child.catalog.id,...(child.catalog.label===undefined?{}:{executorName:child.catalog.label}),parentSessionId:binding.sessionId,parentTurn,parentStartSeq:round.startSeq,inheritedEventCount:marker.event.seq,entries:childEntries,resourceUseSnapshots:options.resourceUseSnapshots?.getSnapshot().filter(row=>row.sessionId===child.catalog.id)??[]})
  }
  return related
 }
 const model=createConversationOverviewModel(binding,{jobs:jobs.state,activity,children:readChildren,context:()=>{
  const entries=binding.eventSource.getSnapshot().entries,executorName=options.executorName?.()
  const scopes=conversationOverviewRoundScopes(binding.sessionId,entries),resourceUseSnapshots=options.resourceUseSnapshots?.getSnapshot().filter(row=>row.sessionId===binding.sessionId)??[]
  const resources=(scope:ConversationOverviewRoundScope|undefined)=>scope?collectConversationOverviewResources({round:scope.round,entries:scope.entries,executorId:binding.sessionId,...(executorName===undefined?{}:{executorName}),relatedSessions:relatedResources(scope),resourceUseSnapshots}):[]
  // 最后人类工作的待进入Goal/宿主turn仍属于当前工作，不提前搬成已结束历史。
  const usageHistory=scopes.rounds.slice(0,-1).map(scope=>({round:scope.round,usageGroups:resources(scope)}))
  return {connected:connected(),pendingInteraction:options.pendingInteraction?.getSnapshot()??false,artifacts:options.artifacts?.getSnapshot()??[],usageGroups:resources(scopes.currentRound),usageHistory}
 }})
 const applyWork=(work:ConversationOverviewWork):ConversationOverviewWork=>{
  const stop=stops.get(work.id)
  if(['completed','failed','stopped'].includes(work.status)){stops.delete(work.id);return work}
  if(!connected())return {...work,status:'unknown',canStop:false}
  if(work.childSessionId){
   const child=children.get(work.childSessionId)
   if(!child||!childCurrent(child))return {...work,status:'unknown',canStop:false}
   if(child.binding.session.getSnapshot().lastAgentError)return {...work,status:'failed',canStop:false,detail:child.binding.session.getSnapshot().lastAgentError!}
   if(stop&&child.binding.eventSource.getSnapshot().entries.some(entry=>entry.type==='event'&&entry.event.seq>stop.throughSeq&&(entry.event.type==='turn/end'||entry.event.type==='turn/start'))){stops.delete(work.id);return work}
  }
  return stop?{...work,status:stop.status,canStop:false}:work
 }
 const read=():ConversationOverviewSnapshot=>{
  const raw=model.getSnapshot(),all=[...raw.running,...raw.ended].map(applyWork),ids=new Set(all.map(work=>work.id))
  for(const id of stops.keys())if(!ids.has(id))stops.delete(id)
  const terminal=(work:ConversationOverviewWork)=>['completed','failed','stopped'].includes(work.status)
  return {...raw,running:all.filter(work=>!terminal(work)),ended:all.filter(terminal)}
 }
 let snapshot=read()
 const publish=()=>{snapshot=read();for(const listener of [...listeners])listener()}
 const releaseChild=(child:Child)=>{for(const unsubscribe of child.off)unsubscribe();child.off=[];child.reference.release()}
 const releaseChildren=()=>{for(const child of children.values())releaseChild(child);children.clear()}
 const syncChildren=()=>{
  if(disposed||references===0)return
  if(syncing){syncAgain=true;return}
  syncing=true
  try{do{
  syncAgain=false
  const rows=current()?catalogRows(catalog.getSnapshot()):[],ids=new Set<string>(rows.map(row=>row.id))
  for(const [id,child] of children)if(!ids.has(id)){children.delete(id);releaseChild(child)}
  for(const row of rows){
   const previous=children.get(row.id)
   if(previous){previous.catalog=row;continue}
   const address:SubagentAddress={parentSessionId:binding.sessionId,childSessionId:row.id,mode:row.mode},generation=epoch
   let reference:SessionReference|undefined
   try{
    reference=sessions.retain(address,{source:'workOverview'})
    void reference.ready.catch(()=>{})
    if(disposed||generation!==epoch||references===0){reference.release();continue}
    const child:Child={catalog:row,address,reference,binding:reference.binding,off:[],failed:false}
    children.set(row.id,child)
    const sourceChanged=()=>{if(children.get(row.id)===child&&generation===epoch&&references>0)changed()}
    child.off=[child.binding.session.subscribe(sourceChanged),child.binding.eventSource.subscribe(sourceChanged),child.binding.session.projections.faceOf('subagent').subscribe(sourceChanged),child.binding.session.projections.faceOf('subagentTiming').subscribe(sourceChanged)]
    void reference.ready.then(ready=>{
     if(disposed||generation!==epoch||children.get(row.id)!==child||!current())return
     if(ready!==child.binding){child.failed=true;changed();return}
     sourceChanged()
    },()=>{if(!disposed&&generation===epoch&&children.get(row.id)===child){child.failed=true;changed()}})
   }catch{reference?.release()}
  }
  }while(syncAgain&&!disposed&&references>0)}finally{syncing=false}
  if(disposed||references===0)return
  changed()
 }
 const assertCurrent=()=>{
  if(disposed)throw Error('Conversation overview disposed')
  if(!current())throw Error('会话代际已变化（generation）。')
  if(connection.getSnapshot()!=='connected')throw Error('会话连接尚未恢复（connected）。')
  if(references===0)throw Error('会话工作概览尚未挂载。')
 }
 const workCurrent=(work:ConversationOverviewWork)=>{
  assertCurrent()
  const latest=[...snapshot.running,...snapshot.ended].find(row=>row.id===work.id)
  if(!latest||latest.jobId!==work.jobId||latest.childSessionId!==work.childSessionId||latest.sessionId!==work.sessionId||latest.parentSessionId!==work.parentSessionId)throw Error('工作不属于当前会话或已变化（current）。')
  return latest
 }
 const stopWork=async(work:ConversationOverviewWork):Promise<void>=>{
  const latest=workCurrent(work)
  if(stops.get(work.id)?.status==='stopping'||latest.status==='stopping')throw Error('工作正在停止（stopping）。')
  if(!latest.canStop)throw Error('当前工作不可停止。')
  const generation=epoch
  const child=latest.childSessionId?children.get(latest.childSessionId):undefined
  const throughSeq=child?Math.max(-1,...child.binding.eventSource.getSnapshot().entries.filter(entry=>entry.type==='event').map(entry=>entry.event.seq)):-1
  // 只呈现请求中；accepted不是已停止，名册/turn终态才负责收敛。
  stops.set(work.id,{status:'stopping',epoch:generation,throughSeq});changed()
  try{
   if(latest.jobId){
    const row=jobs.state.getSnapshot().rows[binding.sessionId]?.find(job=>job.id===latest.jobId)
    if(!row||row.owner!==binding.sessionId||row.status!=='running')throw Error('工作owner或运行状态已变化。')
    const result=await jobs.kill(binding.sessionId,row.id);assertCurrent();if(generation!==epoch)throw Error('会话代际已变化（generation）。');admitted(result)
   }else{
    const address=child?.binding.session.getSnapshot().subagent?.address
    if(!child||!childCurrent(child)||!address||address.mode==='unknown')throw Error('子工作父子地址不可用。')
    const result=await sessions.using(address,{source:'controllerOperation'},async reference=>{
     const target=await reference.ready;assertCurrent()
     if(generation!==epoch||children.get(child.catalog.id)!==child||target!==child.binding||target.sessionId!==child.catalog.id||!sameAddress(target.session.getSnapshot().subagent?.address,address)||target.session.getSnapshot().subagent?.parentAvailable===false||!target.session.getSnapshot().running)throw Error('子工作父子身份或当前运行状态已变化。')
     return await target.session.cancel()
    })
    assertCurrent();if(generation!==epoch||children.get(child.catalog.id)!==child||!childCurrent(child))throw Error('子会话代际已变化（generation）。');admitted(result)
   }
  }catch(error){
   if(!disposed&&generation===epoch&&current()&&(!child||children.get(child.catalog.id)===child)){stops.set(work.id,{status:'unknown',epoch:generation,throughSeq});changed()}
   throw error
  }
 }
 const reconcileWork=async(work:ConversationOverviewWork):Promise<void>=>{
  const latest=workCurrent(work),generation=epoch,child=latest.childSessionId?children.get(latest.childSessionId):undefined
  await sessions.refresh();assertCurrent();if(generation!==epoch)throw Error('会话代际已变化（generation）。')
  await sessions.refreshProjections(binding.sessionId);assertCurrent();if(generation!==epoch)throw Error('会话代际已变化（generation）。')
  if(child&&children.get(child.catalog.id)===child&&childCurrent(child)){await sessions.refreshProjections(child.catalog.id);assertCurrent();if(generation!==epoch)throw Error('会话代际已变化（generation）。')}
  stops.delete(work.id);syncChildren()
 }
 const stopReading=()=>{
  epoch++;for(const unsubscribe of off)unsubscribe();off=[];detachModel?.();detachModel=undefined;releaseChildren();stops.clear()
 }
 const attach=()=>{
  if(disposed)throw Error('Conversation overview disposed')
  if(references++===0){
   epoch++
   off=[model.subscribe(publish),jobs.watchRows(binding.sessionId),connection.subscribe(syncChildren),sessions.list.subscribe(syncChildren),sessions.retainInfo(binding.sessionId).subscribe(syncChildren),catalog.subscribe(syncChildren)]
   if(options.pendingInteraction)off.push(options.pendingInteraction.subscribe(changed))
   if(options.artifacts)off.push(options.artifacts.subscribe(changed))
   if(options.resourceUseSnapshots)off.push(options.resourceUseSnapshots.subscribe(changed))
   detachModel=model.attach();syncChildren()
  }
  let released=false
  return()=>{if(released)return;released=true;if(disposed)return;if(--references===0)stopReading()}
 }
 const dispose=()=>{if(disposed)return;disposed=true;references=0;stopReading();listeners.clear()}
 return {model,getSnapshot:()=>snapshot,subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener)}},attach,dispose,stopWork,reconcileWork}
}
export type ConversationOverviewSession=ReturnType<typeof createConversationOverviewSession>

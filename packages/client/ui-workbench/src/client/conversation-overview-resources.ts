import type {SessionEventLikeEntry} from '@deepseek-ai/dsh-api-session-controller/client'
import type {RecordedToolResourceUse,ToolResourceUseSnapshot} from '@teloa/contract'
import {conversationOverviewRoundEntries,type ConversationOverviewEventEntry,type ConversationOverviewRound} from './conversation-overview-model.ts'

export type ConversationOverviewResourceKind='skill'|'mcp'|'plugin'|'search'
export type ConversationOverviewSearchSource={readonly url:string;readonly title?:string;readonly snippet?:string;readonly publishedAt?:string}
export type ConversationOverviewResourceEvidence={
 readonly id:string
 readonly sessionId:string
 readonly executorId:string
 readonly executorName?:string
 readonly seq:number
 readonly resultSeq?:number
 readonly callId?:string
 readonly timestamp:number
 readonly status:'read'|'injected'|'completed'|'failed'|'pending'
 readonly toolName?:string
 readonly rawToolName?:string
 readonly queries?:readonly string[]
 readonly sources?:readonly ConversationOverviewSearchSource[]
 readonly truncated?:boolean
 readonly answer?:string
}
export type ConversationOverviewResourceGroup={readonly id:string;readonly kind:ConversationOverviewResourceKind;readonly name:string;readonly provider?:string;readonly evidence:readonly ConversationOverviewResourceEvidence[]}
/** 宿主在真实执行结果中写入；客户端不由工具名或当前安装目录反推来源。 */
export type ConversationOverviewRecordedResourceUse=RecordedToolResourceUse
export type ConversationOverviewResourceUseSnapshot=ToolResourceUseSnapshot
export type ConversationOverviewRelatedResourceSession={
 readonly sessionId:string
 readonly executorId:string
 readonly executorName?:string
 readonly parentSessionId:string
 readonly parentTurn:number
 readonly parentStartSeq:number
 readonly inheritedEventCount:number
 readonly entries:readonly SessionEventLikeEntry[]
 readonly resourceUseSnapshots?:readonly ConversationOverviewResourceUseSnapshot[]
}
export type ConversationOverviewResourcesInput={
 readonly round:ConversationOverviewRound|undefined
 readonly entries:readonly SessionEventLikeEntry[]
 readonly executorId?:string
 readonly executorName?:string
 readonly relatedSessions?:readonly ConversationOverviewRelatedResourceSession[]
 readonly resourceUseSnapshots?:readonly ConversationOverviewResourceUseSnapshot[]
}
type Event=ConversationOverviewEventEntry['event']
type Call=Extract<Event,{type:'tool/call'}>
type Executor={sessionId:string;executorId:string;executorName?:string}
type MutableGroup={id:string;kind:ConversationOverviewResourceKind;name:string;provider?:string;evidence:ConversationOverviewResourceEvidence[]}
type PtcFact={seq:number;time:number;rootCallId:string;parentCallId:string;callId:string;toolName:string;isError:boolean}
const record=(value:unknown):value is Record<string,unknown>=>typeof value==='object'&&value!==null&&!Array.isArray(value)
const nonempty=(value:unknown):value is string=>typeof value==='string'&&value.trim().length>0
const identity=(parts:readonly unknown[])=>JSON.stringify(parts)

function argumentsOf(call:Call):Record<string,unknown>|undefined{
 try{const value:unknown=JSON.parse(call.data.arguments);return record(value)?value:undefined}catch{return undefined}
}
function recordedUse(meta:unknown,toolName:string):ConversationOverviewRecordedResourceUse|undefined{
 if(!record(meta)||!record(meta.teloaResourceUse))return undefined
 const value=meta.teloaResourceUse
 if(value.schema!=='teloa.resource-use/v1'||!nonempty(value.providerId)||!nonempty(value.name)||value.toolName!==toolName||(value.rawToolName!==undefined&&!nonempty(value.rawToolName)))return undefined
 if(value.kind==='skill'){
  if(value.state!=='read'&&value.state!=='injected')return undefined
 }else if(typeof value.kind!=='string'||!['mcp','plugin','web'].includes(value.kind)||value.state!=='used')return undefined
 return value as ConversationOverviewRecordedResourceUse
}
function searchResult(meta:unknown):Pick<ConversationOverviewResourceEvidence,'sources'|'truncated'|'answer'>|undefined{
 if(!record(meta)||!Array.isArray(meta.sources)||typeof meta.truncated!=='boolean'||(meta.answer!==undefined&&typeof meta.answer!=='string'))return undefined
 const sources:ConversationOverviewSearchSource[]=[]
 for(const item of meta.sources){
  if(!record(item)||!nonempty(item.url)||['title','snippet','publishedAt'].some(key=>item[key]!==undefined&&typeof item[key]!=='string'))return undefined
  sources.push({url:item.url,...(typeof item.title==='string'?{title:item.title}:{}),...(typeof item.snippet==='string'?{snippet:item.snippet}:{}),...(typeof item.publishedAt==='string'?{publishedAt:item.publishedAt}:{})})
 }
 return {sources,truncated:meta.truncated,...(typeof meta.answer==='string'?{answer:meta.answer}:{})}
}
function searchQueries(args:Record<string,unknown>|undefined):readonly string[]|undefined{
 if(!args||!Array.isArray(args.queries)||!args.queries.length||!args.queries.every(nonempty))return undefined
 return [...new Set(args.queries)]
}
function ptcFact(value:unknown,type:'tool/ptc-dispatch-start'|'tool/ptc-dispatch'):PtcFact|undefined{
 if(!record(value)||value.type!==type||typeof value.seq!=='number'||typeof value.time!=='number'||!record(value.data))return undefined
 const data=value.data
 if(!nonempty(data.rootCallId)||!nonempty(data.parentCallId)||!nonempty(data.subCallId)||!nonempty(data.name)||(type==='tool/ptc-dispatch'&&typeof data.isError!=='boolean'))return undefined
 return {seq:value.seq,time:value.time,rootCallId:data.rootCallId,parentCallId:data.parentCallId,callId:data.subCallId,toolName:data.name,isError:data.isError===true}
}

/** 一份真实用户轮次的事实投影；当前与历史复用序号边界，不把请求或模型正文当作使用证明。 */
export function collectConversationOverviewResources(input:ConversationOverviewResourcesInput):readonly ConversationOverviewResourceGroup[]{
 const round=input.round
 if(!round)return []
 const groups=new Map<string,MutableGroup>(),evidenceIds=new Set<string>()
 const add=(kind:ConversationOverviewResourceKind,name:string,provider:string|undefined,evidence:ConversationOverviewResourceEvidence)=>{
  const evidenceId=identity([kind,evidence.id])
  if(evidenceIds.has(evidenceId))return
  evidenceIds.add(evidenceId)
  const id=identity([kind,provider??null,name]),existing=groups.get(id)
  if(existing)existing.evidence.push(evidence)
  else groups.set(id,{id,kind,name,...(provider!==undefined?{provider}:{}),evidence:[evidence]})
 }
 const project=(entries:readonly ConversationOverviewEventEntry[],executor:Executor,snapshots:readonly ConversationOverviewResourceUseSnapshot[]=[])=>{
  const calls=new Map<string,Call>(),seenSeqs=new Set<number>()
  const settlements=entries.flatMap(({event})=>{const fact=ptcFact(event,'tool/ptc-dispatch');return fact?[fact]:[]})
  const starts=entries.flatMap(({event})=>{const fact=ptcFact(event,'tool/ptc-dispatch-start');return fact?[fact]:[]})
  const addNested=(row:Record<string,unknown>,settlement:PtcFact,start:PtcFact|undefined)=>{
   const use=recordedUse({teloaResourceUse:row},settlement.toolName)
   if(!use)return
   const evidence:ConversationOverviewResourceEvidence={id:identity([executor.sessionId,start?.seq??settlement.seq,settlement.seq,settlement.callId]),...executor,seq:start?.seq??settlement.seq,resultSeq:settlement.seq,callId:settlement.callId,timestamp:settlement.time,status:use.state==='used'?'completed':use.state,toolName:settlement.toolName,...(use.rawToolName?{rawToolName:use.rawToolName}:{})}
   if(use.kind==='web'){
    const queries=searchQueries(row),detail=searchResult(row)
    if(queries&&detail)add('search',use.name,use.providerId,{...evidence,queries,...detail})
   }else add(use.kind,use.name,use.providerId,evidence)
  }
  for(const {event} of entries){
   if(seenSeqs.has(event.seq))continue
   seenSeqs.add(event.seq)
   if(event.type==='tool/call'){
    calls.set(identity([event.data.turn,event.data.step,event.data.callId]),event)
    continue
   }
   if(event.type==='user/message'){
    const source:unknown=event.data.source
    if(record(source)&&source.kind==='skill-invocation'&&source.form==='instructions'&&nonempty(source.name)&&event.data.content.some(block=>block.type==='text'&&nonempty(block.text))){
     add('skill',source.name,undefined,{id:identity([executor.sessionId,event.seq,'injected']),...executor,seq:event.seq,timestamp:event.time,status:'injected'})
    }
    continue
   }
   if(event.type!=='tool/result'||event.data.message.isError)continue
   const result=event.data,call=calls.get(identity([result.turn,result.step,result.message.toolCallId]))
   if(!call||call.seq>=event.seq||(event.sourceEventSeqs!==undefined&&!event.sourceEventSeqs.includes(call.seq)))continue
   const toolName=call.data.name,args=argumentsOf(call),source=recordedUse(result.meta,toolName)
   if(record(result.meta)&&Object.hasOwn(result.meta,'teloaResourceUse')&&!source)continue
   const evidence:ConversationOverviewResourceEvidence={id:identity([executor.sessionId,call.seq,event.seq,call.data.callId]),...executor,seq:call.seq,resultSeq:event.seq,callId:call.data.callId,timestamp:event.time,status:'completed',toolName,...(source?.rawToolName?{rawToolName:source.rawToolName}:{})}
   if(toolName==='run_code'&&record(result.meta)&&Array.isArray(result.meta.teloaResourceUses)){
    for(const row of result.meta.teloaResourceUses){
     if(!record(row)||!nonempty(row.callId)||row.rootCallId!==call.data.callId||!nonempty(row.toolName))continue
     const settlement=settlements.find(item=>!item.isError&&item.seq>call.seq&&item.seq<event.seq&&item.parentCallId===call.data.callId&&item.rootCallId===row.rootCallId&&item.callId===row.callId&&item.toolName===row.toolName)
     if(!settlement)continue
     const start=starts.find(item=>item.seq>call.seq&&item.seq<settlement.seq&&item.parentCallId===settlement.parentCallId&&item.rootCallId===settlement.rootCallId&&item.callId===settlement.callId&&item.toolName===settlement.toolName)
     addNested(row,settlement,start)
    }
   }
   if(source){
    const kind=source.kind==='web'?'search':source.kind
    if(kind==='search'){
     const queries=searchQueries(args),detail=searchResult(result.meta)
     if(queries&&detail)add(kind,source.name,source.providerId,{...evidence,queries,...detail})
    }else add(kind,source.name,source.providerId,{...evidence,status:source.state==='used'?'completed':source.state})
   }else if(toolName==='web_search'){
    const queries=searchQueries(args),detail=searchResult(result.meta)
    if(queries&&detail)add('search',toolName,undefined,{...evidence,queries,...detail})
   }
  }
  for(const snapshot of snapshots){
   if(snapshot.schema!=='teloa.resource-use-snapshot/v1'||snapshot.sessionId!==executor.sessionId||!record(snapshot.use)||!nonempty(snapshot.use.callId)||!nonempty(snapshot.use.rootCallId))continue
   const call=[...calls.values()].find(item=>item.seq===snapshot.parentCallSeq&&item.data.name==='run_code'&&item.data.callId===snapshot.parentCallId&&item.data.callId===snapshot.use.rootCallId)
   const start=starts.find(item=>item.seq===snapshot.startSeq&&item.seq>snapshot.parentCallSeq&&item.parentCallId===snapshot.parentCallId&&item.rootCallId===snapshot.use.rootCallId&&item.callId===snapshot.use.callId&&item.toolName===snapshot.use.toolName)
   const settlement=settlements.find(item=>!item.isError&&item.seq>snapshot.startSeq&&item.parentCallId===snapshot.parentCallId&&item.rootCallId===snapshot.use.rootCallId&&item.callId===snapshot.use.callId&&item.toolName===snapshot.use.toolName)
   if(call&&start&&settlement)addNested(snapshot.use,settlement,start)
  }
 }
 project(conversationOverviewRoundEntries(input.entries,round),{sessionId:round.sessionId,executorId:input.executorId??round.sessionId,...(input.executorName!==undefined?{executorName:input.executorName}:{})},input.resourceUseSnapshots)
 for(const child of input.relatedSessions??[]){
  if(child.sessionId===round.sessionId||child.parentSessionId!==round.sessionId||!round.turns.includes(child.parentTurn)||child.parentStartSeq!==round.startSeq||!Number.isSafeInteger(child.inheritedEventCount)||child.inheritedEventCount<0)continue
  // 父轮次关系来自宿主；子会话只取自己的日志，排除 fork 继承前缀。
  const entries=child.entries.filter((entry):entry is ConversationOverviewEventEntry=>entry.type==='event'&&entry.event.seq>=child.inheritedEventCount).sort((left,right)=>left.event.seq-right.event.seq)
  project(entries,{sessionId:child.sessionId,executorId:child.executorId,...(child.executorName!==undefined?{executorName:child.executorName}:{})},child.resourceUseSnapshots)
 }
 return [...groups.values()]
}

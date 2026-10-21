import type {SessionEvent,SessionHeader} from '@deepseek-ai/dsh-session'
import {foldConsumedWork} from '@deepseek-ai/dsh-agent'
import {foldSubagentDescriptor} from '@deepseek-ai/dsh-subagent'
import type {TaskRunSubagent} from '@teloa/backend'
import {subagentReservationId} from './subagent-delegation.ts'

type Catalog=Extract<SessionEvent,{type:'subagent/catalog'}>
type Binding=Readonly<{runId:string;sessionId:string;requestId:string}>
type Inspection={meta:SessionHeader;inheritedEventCount:number;events:readonly SessionEvent[]}
type Header=Pick<SessionHeader,'id'|'createdAt'|'parentSession'|'isSeeded'|'origin'|'delegationDepth'>
/** 只冻结一次 fresh 原生子调用的归属、输入、正文与结束边界；不复制系统上下文、推理或旧历史。 */
export type NativeReviewChild=Readonly<{
 registration:TaskRunSubagent;header:Header
 descriptor:{seq:number;time:number;version:3;mode:'continuable';provider:'spawn';label:string}
 input:{seq:number;time:number;id:string;text:string}
 answer:{seq:number;time:number;id:string;text:string;turn:number}
 start:{seq:number;time:number;turn:number};end:{seq:number;time:number;turn:number;reason:'completed'}
}>
type Invocation=Readonly<{callId:string;name:string;arguments:string;callSeq:number;callTime:number;resultSeq:number;resultTime:number;isError:boolean;text:string}>
const maxBytes=128*1024,cap=32
const fail=()=>Error('原生子调用的归属或完成证据尚未核实。')
const local=(event:Catalog)=>event.data.version===0&&event.data.mode==='continuable'
const text=(value:readonly {type:string;text?:string}[])=>value.flatMap(part=>part.type==='text'&&typeof part.text==='string'?[part.text]:[]).join('')
const keys=(value:object,names:string[])=>Object.keys(value).sort().join(',')===names.sort().join(',')
const contexts=new Set(['user','agent-instructions','runtime-context','time-context'])

/** 官方 inspect 只读；同一 Run 已登记的精确 child 才可读取，不恢复 Agent 或接受新输入。 */
export async function readNativeReviewChildren(ports:{inspect:(id:string,signal:AbortSignal)=>Promise<Inspection>;live:(id:string)=>{status:string;inbox:{nextTurn:readonly unknown[];nextStep:readonly unknown[]}}|undefined},events:readonly SessionEvent[],binding:Binding,registrations:readonly TaskRunSubagent[],signal:AbortSignal):Promise<readonly NativeReviewChild[]|undefined>{
 const roots=events.filter(event=>event.type==='user/message'&&event.surfaceOp==='append'&&event.data.source.kind==='user'&&Reflect.get(event.data.source,'rpcId')===binding.requestId)
 if(roots.length!==1)throw fail()
 const catalogs=events.filter((event):event is Catalog=>event.seq>=roots[0]!.seq&&event.type==='subagent/catalog'&&local(event))
 if(!catalogs.length)return undefined
 if(catalogs.length>cap||new Set(catalogs.map(event=>event.data.childId)).size!==catalogs.length)throw fail()
 const rows:NativeReviewChild[]=[]
 for(const catalog of catalogs){
  signal.throwIfAborted()
  const matches=registrations.filter(row=>row.runId===binding.runId&&row.childSessionId===catalog.data.childId),registration=matches[0]
  if(matches.length!==1||!registration||registration.state!=='ended'||registration.stopReason!=='completed')throw fail()
  const live=ports.live(catalog.data.childId)
  if(live&&(live.status!=='idle'||live.inbox.nextTurn.length||live.inbox.nextStep.length))throw fail()
  const snapshot=await ports.inspect(catalog.data.childId,signal);signal.throwIfAborted()
  const {meta,events:child}=snapshot
  if(snapshot.inheritedEventCount!==0||meta.isSeeded||meta.id!==catalog.data.childId||meta.parentSession!==binding.sessionId||meta.origin!=='subagent'||meta.delegationDepth!==1||meta.createdAt!==catalog.data.childCreatedAt||child.length>512||child.some((event,index)=>event.seq!==index))throw fail()
  const descriptor=foldSubagentDescriptor(child),descriptors=child.filter(event=>event.type==='subagent/descriptor')
  if(descriptors.length!==1||!descriptor||descriptor.version!==3||descriptor.mode!=='continuable'||descriptor.provider!=='spawn'||descriptor.label!==catalog.data.label)throw fail()
  if(child.some(event=>event.type.startsWith('subagent/')&&event.type!=='subagent/descriptor'||event.type.startsWith('team/')||event.type.startsWith('job/')))throw fail()
  if(child.some(event=>event.type==='user/message'&&!contexts.has(event.data.source.kind)))throw fail()
  const inputs=child.filter(event=>event.type==='user/message'&&event.data.source.kind==='user'),input=inputs[0]
  const accounting=foldConsumedWork(child),end=accounting.end,starts=child.filter(event=>event.type==='turn/start'),start=starts[0]
  const answer=[...child].reverse().find(event=>event.type==='assistant/message'&&event.data.message.content.length>0),identity=descriptors[0]
  if(inputs.length!==1||input?.type!=='user/message'||input.surfaceOp!=='append'||input.data.content.some(part=>part.type!=='text')||starts.length!==1||start?.type!=='turn/start'||!end||end.data.reason.kind!=='completed'||accounting.droppedUnrun||end.seq!==child.at(-1)?.seq||answer?.type!=='assistant/message'||answer.data.interrupted===true||identity?.type!=='subagent/descriptor')throw fail()
  const after=ports.live(catalog.data.childId)
  if(after!==live||after&&(after.status!=='idle'||after.inbox.nextTurn.length||after.inbox.nextStep.length))throw fail()
  const proof:NativeReviewChild={registration:structuredClone(registration),header:{id:meta.id,createdAt:meta.createdAt,parentSession:meta.parentSession,isSeeded:meta.isSeeded,origin:meta.origin,delegationDepth:meta.delegationDepth},descriptor:{seq:identity.seq,time:identity.time,version:3,mode:'continuable',provider:'spawn',label:descriptor.label},input:{seq:input.seq,time:input.time,id:input.data.id,text:text(input.data.content)},answer:{seq:answer.seq,time:answer.time,id:answer.data.message.id,text:text(answer.data.message.content),turn:answer.data.turn},start:{seq:start.seq,time:start.time,turn:start.data.turn},end:{seq:end.seq,time:end.time,turn:end.data.turn,reason:'completed'}}
  if(Buffer.byteLength(JSON.stringify(proof))>maxBytes)throw fail()
  rows.push(proof)
 }
 return rows
}

/** 目录、既有预留映射、官方子会话与父成功回执须共同吻合；正文仍是待复核资料。 */
export function proveNativeReviewChildren(catalogs:readonly Catalog[],invocations:readonly Invocation[],binding:Binding,children:readonly NativeReviewChild[]|undefined):boolean{
 try{
  const rows=children??[]
  if(catalogs.length!==rows.length||rows.length>cap||new Set(rows.map(row=>row.header.id)).size!==rows.length)return false
  const used=new Set<string>()
  for(const catalog of catalogs){
   if(!local(catalog))return false
   const proof=rows.find(row=>row.header.id===catalog.data.childId)
   if(!proof||Buffer.byteLength(JSON.stringify(proof))>maxBytes)return false
   const {registration:r,header:h,descriptor:d,input,answer,start,end}=proof
   if(!keys(proof,['registration','header','descriptor','input','answer','start','end'])||!keys(h,['id','createdAt','parentSession','isSeeded','origin','delegationDepth'])||!keys(d,['seq','time','version','mode','provider','label'])||!keys(input,['seq','time','id','text'])||!keys(answer,['seq','time','id','text','turn'])||!keys(start,['seq','time','turn'])||!keys(end,['seq','time','turn','reason']))return false
   if(Object.keys(r).some(key=>!['runId','reservationId','state','createdAt','childSessionId','depth','startedAt','endedAt','stopReason','tokenEstimate'].includes(key))||[d.seq,input.seq,answer.seq,start.seq,end.seq,d.time,input.time,answer.time,start.time,end.time].some(value=>!Number.isSafeInteger(value)||value<0)||!input.id||!answer.id)return false
   const calls=invocations.filter(call=>call.name==='subagent_task'&&!call.isError&&r.reservationId===subagentReservationId(binding.sessionId,call.callId)),call=calls[0]
   if(calls.length!==1||!call||used.has(call.callId))return false
   const args:unknown=JSON.parse(call.arguments)
   if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).sort().join(',')!=='description,prompt'||!('description'in args)||!('prompt'in args)||typeof args.description!=='string'||typeof args.prompt!=='string'||!args.description.trim()||!args.prompt.trim())return false
   if(r.runId!==binding.runId||r.childSessionId!==h.id||r.state!=='ended'||r.stopReason!=='completed'||r.depth!==1||r.depth!==h.delegationDepth||h.parentSession!==binding.sessionId||h.isSeeded!==false||h.origin!=='subagent'||h.createdAt!==catalog.data.childCreatedAt)return false
   if(d.version!==3||d.mode!=='continuable'||d.provider!=='spawn'||d.label!==catalog.data.label||d.label!==args.description||input.text!==args.prompt||answer.text!==call.text||!answer.text.trim()||answer.turn!==start.turn||end.turn!==start.turn||end.reason!=='completed')return false
   if(!(call.callSeq<catalog.seq&&catalog.seq<call.resultSeq&&d.seq<start.seq&&start.seq<input.seq&&input.seq<answer.seq&&answer.seq<end.seq))return false
   if(!(call.callTime<=Date.parse(r.createdAt)&&call.callTime<=h.createdAt&&h.createdAt<=catalog.time&&catalog.time<=call.resultTime&&h.createdAt<=d.time&&d.time<=start.time&&start.time<=input.time&&input.time<=answer.time&&answer.time<=end.time&&end.time<=Date.parse(r.endedAt??'')&&Date.parse(r.endedAt??'')<=call.resultTime&&Date.parse(r.startedAt??'')>=h.createdAt&&Date.parse(r.startedAt??'')<=Date.parse(r.endedAt??'')))return false
   used.add(call.callId)
  }
  if(invocations.some(call=>call.name==='subagent_task'&&!call.isError&&!used.has(call.callId)))return false
  return true
 }catch{return false}
}

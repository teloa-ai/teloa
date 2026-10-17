import {createHash,randomUUID} from 'node:crypto'
import type {Context} from '@deepseek-ai/cordis'
import {scopeTarget} from '@deepseek-ai/dsh-scope'
import type {ApprovalRequestEvent,ApprovalOutcome} from '@deepseek-ai/dsh-user-approval/types'
import type {DirectDeviceBinding} from '@teloa/backend'
import type {DeviceAuthorization} from '@teloa/device-gateway'
import {readSessionEvents} from './session-events.ts'

type Entry={request:ApprovalRequestEvent;finished:boolean;resolve:(outcome:ApprovalOutcome)=>void}
const hash=(value:string)=>createHash('sha256').update(value).digest('hex')
function snapshot(request:ApprovalRequestEvent){
 const events=readSessionEvents(request.agent.session)
 const asked=[...events].reverse().find(event=>event.type==='approval/asked'&&event.data.toolName===request.toolName&&event.data.callId===request.callId)
 if(asked?.type!=='approval/asked'||events.some(event=>event.type==='approval/decided'&&event.data.id===asked.data.id))return null
 const call=[...events].reverse().flatMap(event=>event.type==='assistant/message'?event.data.message.content:[]).find(part=>part.type==='tool-call'&&part.id===request.callId&&part.name===request.toolName)
 if(call?.type!=='tool-call')return null
 const full=`${request.toolName}\n${request.reason??''}\n${call.arguments}`
 const canDecide=!/[\u0000-\u0009\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(full)&&Array.from(full).length<=4000&&Buffer.byteLength(JSON.stringify(full))<=12000
 return {digest:hash(JSON.stringify([asked.data.id,request.toolName,request.callId,call.arguments,request.reason??''])),text:canDecide?full:'这项申请需要在 Teloa 网页查看并处理。',canDecide}
}
/** 同一个原审批的第二个答复界面；Web/设备只允许一个一次性决定先完成。 */
export function createDeviceApprovals(ctx:Context,belongs:(binding:DirectDeviceBinding,request:ApprovalRequestEvent)=>Promise<boolean>,enabled:(request:ApprovalRequestEvent)=>boolean|Promise<boolean>=()=>false){
 const pending=new Set<Entry>(),forwarded=new WeakSet<object>(),tickets=new Map<string,{entry:Entry;authorization:DeviceAuthorization;digest:string;expiresAt:number}>(),life=new AbortController()
 const off=ctx.on('approval/request',async(request,next):Promise<ApprovalOutcome>=>{
  if(forwarded.has(request))return next()
  let permitted=false;try{permitted=await enabled(request)}catch{/* 保留原 Web 答复链。 */}
  if(!permitted||!snapshot(request))return next()
  const media=new AbortController(),signal=AbortSignal.any([life.signal,media.signal,...request.signal?[request.signal]:[]])
  const delegated={...request,signal};forwarded.add(delegated)
  let resolve!:(value:ApprovalOutcome)=>void
  const choice=new Promise<ApprovalOutcome>(done=>{resolve=done}),entry:Entry={request,finished:false,resolve:value=>{if(entry.finished)return;entry.finished=true;resolve(value)}}
  pending.add(entry)
  const cancelled=()=>entry.resolve('cancelled');signal.addEventListener('abort',cancelled,{once:true})
  void ctx.waterfall(scopeTarget(request.agent,request.agent),'approval/request',delegated,()=>Promise.resolve('unavailable' as const)).then(outcome=>{if(outcome!=='unavailable'||!snapshot(request)?.canDecide)entry.resolve(outcome)},()=>{})
  try{if(signal.aborted)cancelled();return await choice}
  finally{pending.delete(entry);entry.finished=true;media.abort();signal.removeEventListener('abort',cancelled);for(const [id,ticket] of tickets)if(ticket.entry===entry)tickets.delete(id)}
 },{prepend:true})
 const check=(authorization:DeviceAuthorization,binding:DirectDeviceBinding)=>{authorization.assertCurrent();authorization.signal.throwIfAborted();if(life.signal.aborted||binding.allowApprovals!==true)throw new Error('设备尚未授予审批权限。')}
 return Object.freeze({
  async open(authorization:DeviceAuthorization,binding:DirectDeviceBinding,index:number){
   check(authorization,binding)
   const entries:Entry[]=[]
   for(const entry of pending){if(!entry.finished&&!entry.request.signal?.aborted&&await belongs(binding,entry.request)&&!entry.finished&&!entry.request.signal?.aborted)entries.push(entry)}
   check(authorization,binding)
   for(const [id,ticket] of tickets)if(ticket.expiresAt<=Date.now()||ticket.authorization===authorization)tickets.delete(id)
   const entry=entries[index],current=entry&&snapshot(entry.request),id=randomUUID()
   if(!entry||!current)return {type:'approval.card' as const,ticket:id,digest:hash(id),text:'当前没有可在此设备处理的申请。',canDecide:false,index:0,total:entries.length}
   tickets.set(id,{entry,authorization,digest:current.digest,expiresAt:Date.now()+60000})
   return {type:'approval.card' as const,ticket:id,...current,index,total:Math.min(entries.length,20)}
  },
  async decide(authorization:DeviceAuthorization,binding:DirectDeviceBinding,input:{ticket:string;digest:string;decision:'approve'|'reject'}){
   check(authorization,binding);const ticket=tickets.get(input.ticket)
   if(!ticket||ticket.authorization!==authorization||ticket.expiresAt<=Date.now()||ticket.entry.finished)return {type:'approval.ack' as const,ticket:input.ticket,state:'stale' as const}
   const current=snapshot(ticket.entry.request)
   if(!current?.canDecide||input.digest!==ticket.digest||current.digest!==ticket.digest||!await belongs(binding,ticket.entry.request))return {type:'approval.ack' as const,ticket:input.ticket,state:'stale' as const}
   check(authorization,binding)
   if(ticket.entry.finished||ticket.entry.request.signal?.aborted)return {type:'approval.ack' as const,ticket:input.ticket,state:'stale' as const}
   tickets.delete(input.ticket);ticket.entry.resolve(input.decision==='approve'?'allowed-once':'rejected')
   return {type:'approval.ack' as const,ticket:input.ticket,state:'submitted' as const}
  },
  async close(){life.abort();await off();tickets.clear()},
 })
}

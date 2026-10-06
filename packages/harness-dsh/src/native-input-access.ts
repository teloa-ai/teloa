import {AsyncLocalStorage} from 'node:async_hooks'
import {createHash} from 'node:crypto'
import type {Context} from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import {SessionSeq,snapshotSessionEvent,type Session,type SessionStore,type SessionEvent,type UserMessage} from '@deepseek-ai/dsh-session'
import type {WorkAccessLease} from '@teloa/backend'
import {WorkError} from '@teloa/contract'

export type NativeInputIdentity=Readonly<{messageId:string;nativeRequestId?:string;payloadSha256:string}>
export type NativeInputGuard={
 withLease:<T>(session:Session,identity:NativeInputIdentity,lease:WorkAccessLease,action:()=>T|Promise<T>)=>Promise<T>
 withSyncLease:<T>(session:Session,identity:NativeInputIdentity,lease:WorkAccessLease,action:()=>T)=>T
 close:()=>void
}
export type NativeInputAcceptance=Readonly<{session:Session;event:Readonly<SessionEvent>;assertContinuationCurrent:()=>void}>
export type NativeInputGuardOptions=Readonly<{final?:boolean;onAccepted?:(acceptance:NativeInputAcceptance)=>void}>
type AppendAdmissionStore={
 requireAppendAdmission:()=>void
 installAppendAdmission:(policy:(session:Session,event:Readonly<SessionEvent>)=>void)=>void
}
type Ticket={session:Session;identity:NativeInputIdentity;assertCurrent:()=>void;assertContinuationCurrent:()=>void;releaseUnaccepted?:()=>void;active:boolean;consumed:boolean;published:boolean;pendingEvent?:Readonly<SessionEvent>}
const installed=new WeakSet<Context>(),acceptances=new WeakMap<NativeInputAcceptance,()=>void>()
const denied=()=>new WorkError('teloa/forbidden','当前暂不能提交新输入，请核对运行许可后重试。')

/** 只核对本模块真实发布的回执；不读取结构相同对象上的公共字段。 */
export function assertNativeInputAcceptanceCurrent(acceptance:NativeInputAcceptance):void{
 try{
  const assertion=acceptances.get(acceptance)
  if(typeof assertion!=='function')throw denied()
  const returned:unknown=Reflect.apply(assertion,undefined,[])
  if(returned!==undefined){void Promise.resolve(returned).catch(()=>{});throw denied()}
 }catch{throw denied()}
}

/** 只处理已经通过官方 lossless-JSON 快照校验的值；键顺序不影响载荷身份。 */
function canonical(value:unknown):string{
 if(value===null||typeof value!=='object'){
  const result=JSON.stringify(value)
  if(result===undefined)throw denied()
  return result
 }
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']'
 return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(Reflect.get(value,key))).join(',')+'}'
}

function requestId(message:UserMessage):unknown{return Reflect.get(message.source,'rpcId')}

/** 由可信生产者在取得逐请求许可后构造；不接受页面提供的摘要作为授权依据。 */
export function nativeInputIdentity(message:UserMessage,nativeRequestId?:string):NativeInputIdentity{
 try{
  const snapshot=snapshotSessionEvent({type:'user/message',seq:SessionSeq(0),time:0,data:message,surfaceOp:'append'}).data
  if(snapshot.role!=='user'||typeof snapshot.id!=='string'||!snapshot.id)throw denied()
  if(nativeRequestId!==undefined&&(typeof nativeRequestId!=='string'||!nativeRequestId||requestId(snapshot)!==nativeRequestId))throw denied()
  return Object.freeze({messageId:snapshot.id,...nativeRequestId===undefined?{}:{nativeRequestId},payloadSha256:createHash('sha256').update(canonical(snapshot)).digest('hex')})
 }catch{throw denied()}
}

function fixedIdentity(identity:NativeInputIdentity):NativeInputIdentity{
 try{
  const {messageId,nativeRequestId,payloadSha256}=identity
  if(typeof messageId!=='string'||!messageId||typeof payloadSha256!=='string'||!/^[a-f0-9]{64}$/.test(payloadSha256)
   ||nativeRequestId!==undefined&&(typeof nativeRequestId!=='string'||!nativeRequestId))throw denied()
  return Object.freeze({messageId,...nativeRequestId===undefined?{}:{nativeRequestId},payloadSha256})
 }catch{throw denied()}
}

function fixedAssertions(lease:WorkAccessLease,withContinuation:boolean):Pick<Ticket,'assertCurrent'|'assertContinuationCurrent'>{
 try{
  const assertion=lease.assertCurrent,continuation=withContinuation?lease.assertContinuationCurrent:undefined
  if(typeof assertion!=='function'||continuation!==undefined&&typeof continuation!=='function')throw denied()
  const wrap=(check:()=>void)=>()=>{
   try{
    const returned:unknown=Reflect.apply(check,lease,[])
    if(returned!==undefined){
     // 官方 dispatch 是同步边界；拒绝 thenable，并接住其潜在拒绝。
     void Promise.resolve(returned).catch(()=>{})
     throw denied()
    }
   }catch{throw denied()}
  }
  const strict=wrap(assertion)
  return {assertCurrent:strict,assertContinuationCurrent:continuation===undefined?strict:wrap(continuation)}
 }catch{throw denied()}
}

/**
 * 受管宿主显式安装的逐输入底座；Free 不安装时沿用官方行为。
 * rc.2 Session 在 log.push 前解析 session/event 监听器，公开 internal/dispatch
 * 的同步抛错会否决候选；普通 session/event 是提交后通知，不能用来否决。
 * 缺省只保证本监听器执行时的 proof；后续 dispatch 监听器仍可使 lease 失效。
 * final:true 要求显式 rc.2 补口，并复用同一校验闭包在全部 dispatch/filter/bind
 * 完成后、log.push 前同步再核对；没有补口时拒绝安装，不回退到公开事件。
 * final 模式只在最终 Store validator 成功后消费票据，一次 scope 最多一次插入；
 * 前置 listener 不消费，否决后仍可重试。缺省模式没有一次提交保证。
 * 可选回执只关联最终 validator 的精确候选与官方提交后 feed 的同一对象；
 * 不读历史、不按 seq 或 source 合成受理事实。通知失败不能撤销已提交事件。
 * 不改历史回执，也不覆盖尚未发布的 seed/prepare 生产者。
 */
export function createNativeInputGuard(ctx:Context,options:NativeInputGuardOptions={}):NativeInputGuard{
 if(installed.has(ctx))throw denied()
 let final:boolean,onAccepted:NativeInputGuardOptions['onAccepted']
 try{
  if(!options||typeof options!=='object')throw denied()
  const value=options.final;onAccepted=options.onAccepted
  if(value!==undefined&&typeof value!=='boolean'||onAccepted!==undefined&&typeof onAccepted!=='function')throw denied()
  final=value??false
  if(onAccepted&&!final)throw denied()
 }catch{throw denied()}
 const scope=new AsyncLocalStorage<Ticket>(),pending=new WeakMap<Readonly<SessionEvent>,Ticket>()
 let closed=false
 const assertSession=(ticket:Ticket):void=>{
  if(closed||(Reflect.get(ctx,'sessions') as unknown as SessionStore).get(ticket.session.id)!==ticket.session)throw denied()
 }
 const current=(ticket:Ticket):void=>{
  try{
   assertSession(ticket)
   if(!ticket.active||ticket.consumed)throw denied()
   ticket.assertCurrent()
   assertSession(ticket)
   if(!ticket.active||ticket.consumed)throw denied()
  }catch{throw denied()}
 }
 const finish=(ticket:Ticket):void=>{
  const unused=final&&ticket.active&&!ticket.consumed
  ticket.active=false
  if(ticket.pendingEvent)pending.delete(ticket.pendingEvent)
  delete ticket.pendingEvent
  if(unused)ticket.releaseUnaccepted?.()
 }
 const begin=(session:Session,identity:NativeInputIdentity,lease:WorkAccessLease,action:unknown):Ticket=>{
  const release=lease.releaseUnaccepted
  if(release!==undefined&&typeof release!=='function')throw denied()
  const ticket:Ticket={session,identity:fixedIdentity(identity),...fixedAssertions(lease,onAccepted!==undefined),...(release?{releaseUnaccepted(){const value:unknown=Reflect.apply(release,lease,[]);if(value!==undefined){void Promise.resolve(value).catch(()=>{});throw denied()}}}:{}),active:true,consumed:false,published:false}
  try{
   current(ticket)
   if(typeof action!=='function')throw denied()
   return ticket
  }catch(error){finish(ticket);throw error}
 }
 const checkInput=(session:Session,event:Readonly<SessionEvent>):Ticket|undefined=>{
  if(event.type!=='agent/inbox/spliced'||event.data.inserted.length===0)return
  try{
   const ticket=scope.getStore()
   if(!ticket||session!==ticket.session||event.data.inserted.length!==1)throw denied()
   current(ticket)
   const actual=nativeInputIdentity(event.data.inserted[0]!,ticket.identity.nativeRequestId)
   if(actual.messageId!==ticket.identity.messageId||actual.payloadSha256!==ticket.identity.payloadSha256)throw denied()
   // 摘要计算也可能跨越到期；pre-append 与 final 共用完全相同的 proof 校验。
   current(ticket)
   return ticket
  }catch{throw denied()}
 }
 const assertFinalInput=(session:Session,event:Readonly<SessionEvent>):void=>{
  const ticket=checkInput(session,event)
  // 所有 dispatch/filter/bind 与 proof 校验已完成；此后紧接官方 log.push。
  if(ticket){
   ticket.consumed=true
   if(onAccepted){ticket.pendingEvent=event;pending.set(event,ticket)}
  }
 }
 if(final){
  try{
   const store=ctx.sessions as unknown as AppendAdmissionStore
   const requireAdmission=store.requireAppendAdmission,installAdmission=store.installAppendAdmission
   if(typeof requireAdmission!=='function'||typeof installAdmission!=='function')throw denied()
   if(Reflect.apply(requireAdmission,store,[])!==undefined||Reflect.apply(installAdmission,store,[assertFinalInput])!==undefined)throw denied()
  }catch{throw denied()}
 }
 if(onAccepted)ctx.on('session/event',(session,event)=>{
  const ticket=pending.get(event)
  // 官方 append 在 final 校验之后 log.push，再直调预收集的 contained observers。
  // 公开 emit 会重走上面的 dispatch 检查，consumed 票据不能伪造这个通知。
  if(!ticket||scope.getStore()!==ticket||!ticket.active||!ticket.consumed||ticket.published||ticket.session!==session||ticket.pendingEvent!==event)return
  assertSession(ticket)
  pending.delete(event);delete ticket.pendingEvent;ticket.published=true
  let acceptance:NativeInputAcceptance
  const assertion=()=>{
   try{
    if(!ticket.published||!ticket.consumed)throw denied()
    assertSession(ticket);ticket.assertContinuationCurrent();assertSession(ticket)
   }catch{throw denied()}
  }
  acceptance=Object.freeze({session,event,assertContinuationCurrent:()=>assertNativeInputAcceptanceCurrent(acceptance)})
  acceptances.set(acceptance,assertion)
  try{
   const returned:unknown=Reflect.apply(onAccepted,options,[acceptance])
   // 通知发生于提交后；消费者错误不改写真实受理事实。
   if(returned!==undefined)void Promise.resolve(returned).catch(()=>{})
  }catch{throw denied()}
 },{global:true,prepend:true})
 ctx.on('internal/dispatch',(mode,name,args)=>{
  if(mode!=='emit'||name!=='session/event')return
  const [session,event]=args as [Session,SessionEvent]
  checkInput(session,event)
 },{global:true,prepend:true})
 installed.add(ctx)
 return Object.freeze({
  async withLease<T>(session:Session,identity:NativeInputIdentity,lease:WorkAccessLease,action:()=>T|Promise<T>):Promise<T>{
   const ticket=begin(session,identity,lease,action)
   try{return await scope.run(ticket,action)}finally{finish(ticket)}
  },
  withSyncLease<T>(session:Session,identity:NativeInputIdentity,lease:WorkAccessLease,action:()=>T):T{
   const ticket=begin(session,identity,lease,action)
   let result:T
   // 同步发布者返回即关闭，不把票据保留到 await 的下一轮 microtask。
   try{result=scope.run(ticket,action)}finally{finish(ticket)}
   try{
    if(result!==null&&(typeof result==='object'||typeof result==='function')&&typeof Reflect.get(result,'then')==='function'){
     void Promise.resolve(result).catch(()=>{})
     // 只能拒绝异步发布与后续写入；callback 已同步提交的写入不能撤销。
     throw denied()
    }
   }catch{throw denied()}
   return result
  },
  // 不卸载 listener：已关闭的宿主必须继续拒绝新输入，删除/清空仍可收尾。
  close():void{closed=true},
 })
}

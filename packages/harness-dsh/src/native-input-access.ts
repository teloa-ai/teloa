import {AsyncLocalStorage} from 'node:async_hooks'
import {createHash} from 'node:crypto'
import type {Context} from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import {SessionSeq,snapshotSessionEvent,type Session,type SessionEvent,type UserMessage} from '@deepseek-ai/dsh-session'
import type {WorkAccessLease} from '@teloa/backend'
import {WorkError} from '@teloa/contract'

export type NativeInputIdentity=Readonly<{messageId:string;nativeRequestId?:string;payloadSha256:string}>
export type NativeInputGuard={
 withLease:<T>(session:Session,identity:NativeInputIdentity,lease:WorkAccessLease,action:()=>T|Promise<T>)=>Promise<T>
 close:()=>void
}
type Ticket={session:Session;identity:NativeInputIdentity;assertCurrent:()=>void;active:boolean}
const installed=new WeakSet<Context>()
const denied=()=>new WorkError('teloa/forbidden','当前暂不能提交新输入，请核对运行许可后重试。')

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

function fixedAssertion(lease:WorkAccessLease):()=>void{
 try{
  const assertion=lease.assertCurrent
  if(typeof assertion!=='function')throw denied()
  return ()=>{
   try{
    const returned:unknown=Reflect.apply(assertion,lease,[])
    if(returned!==undefined){
     // 官方 dispatch 是同步边界；拒绝 thenable，并接住其潜在拒绝。
     void Promise.resolve(returned).catch(()=>{})
     throw denied()
    }
   }catch{throw denied()}
  }
 }catch{throw denied()}
}

/**
 * 受管宿主显式安装的逐输入底座；Free 不安装时沿用官方行为。
 * rc.2 Session 在 log.push 前解析 session/event 监听器，公开 internal/dispatch
 * 的同步抛错会否决候选；普通 session/event 是提交后通知，不能用来否决。
 * 断言仅保证本监听器执行时的 proof；后续 dispatch 监听器仍可同步使 lease 失效。
 * 官方没有 dispatch 全部完成后的提交校验口，此底座不是一般最终 commit 屏障；
 * 正式宿主还须核对受控扩展与 IPC epoch 的同步顺序。
 * 此处不消费 proof，不改历史回执，也不覆盖尚未发布的 seed/prepare 生产者。
 */
export function createNativeInputGuard(ctx:Context):NativeInputGuard{
 if(installed.has(ctx))throw denied()
 const scope=new AsyncLocalStorage<Ticket>()
 let closed=false
 const current=(ticket:Ticket):void=>{
  try{
   if(closed||!ticket.active||ctx.sessions.get(ticket.session.id)!==ticket.session)throw denied()
   ticket.assertCurrent()
  }catch{throw denied()}
 }
 ctx.on('internal/dispatch',(mode,name,args)=>{
  if(mode!=='emit'||name!=='session/event')return
  const [session,event]=args as [Session,SessionEvent]
  if(event.type!=='agent/inbox/spliced'||event.data.inserted.length===0)return
  try{
   const ticket=scope.getStore()
   if(!ticket||session!==ticket.session||event.data.inserted.length!==1)throw denied()
   current(ticket)
   const actual=nativeInputIdentity(event.data.inserted[0]!,ticket.identity.nativeRequestId)
   if(actual.messageId!==ticket.identity.messageId||actual.payloadSha256!==ticket.identity.payloadSha256)throw denied()
   // 再核对摘要计算期间的到期；后续 dispatch 监听器的变化不在此检查点内。
   current(ticket)
  }catch{throw denied()}
 },{global:true,prepend:true})
 installed.add(ctx)
 return Object.freeze({
  async withLease<T>(session:Session,identity:NativeInputIdentity,lease:WorkAccessLease,action:()=>T|Promise<T>):Promise<T>{
   const ticket:Ticket={session,identity:fixedIdentity(identity),assertCurrent:fixedAssertion(lease),active:true}
   current(ticket)
   if(typeof action!=='function')throw denied()
   try{return await scope.run(ticket,action)}finally{ticket.active=false}
  },
  // 不卸载 listener：已关闭的宿主必须继续拒绝新输入，删除/清空仍可收尾。
  close():void{closed=true},
 })
}

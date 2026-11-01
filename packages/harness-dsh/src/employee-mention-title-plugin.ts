import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import type {Context} from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {Session} from '@deepseek-ai/dsh-session'
import {readSessionEvents} from './session-events.ts'
import {employeeMentionReadableTitle,employeeMentionTitleInput} from './employee-mention-title.ts'

type Provider=Parameters<Context['sessionTitle']['register']>[0]
type TitleRecoveryService=Pick<Context['sessionTitle'],'get'|'refresh'>
type NativePlugin={Config:unknown;apply:(ctx:Context,config:Record<string,unknown>)=>void}
// 沿已随附 app-boot → base 的正式依赖边解析，不新建模型客户端或修改上游包。
const require=createRequire(import.meta.url)
const baseRequire=createRequire(createRequire(require.resolve('@deepseek-ai/dsh-app-boot')).resolve('@deepseek-ai/dsh-base/package.json'))
const official=await import(pathToFileURL(baseRequire.resolve('@deepseek-ai/dsh-session-title-first-prompt-llm')).href) as NativePlugin
const {normalizeSessionTitle}=await import(pathToFileURL(baseRequire.resolve('@deepseek-ai/dsh-session-title')).href) as {normalizeSessionTitle:(text:string,maxBytes:number)=>string}
export const Config=official.Config
export const name='teloa-employee-session-title'
export const inject=['sessionTitle','sessions','llm']

/** 注册仍由官方唯一标题服务负责；普通输入完整委托官方生成器。 */
export function employeeAwareTitleProvider(provider:Provider):Provider{
 return {...provider,async generate(request){
  request.signal.throwIfAborted()
  const first=request.messages[0]
  const parent=request.session.header.parentSession!==undefined||request.session.header.origin==='subagent'
  const title=!parent&&first?employeeMentionTitleInput(readSessionEvents(request.session),first.seq):undefined
  if(title!==undefined)return {title,messageSeqs:[first!.seq]}
  return provider.generate(request)
 }}
}

/** 原生 refresh 正常重算旧自动标题；派生预检不成立时绝不发起它。 */
export function installEmployeeMentionTitleRecovery(ctx:Context,titles:TitleRecoveryService=ctx.sessionTitle):()=>void{
 const queued=new Set<Session>()
 const pending=new WeakSet<Session>(),attempted=new WeakSet<Session>()
 let disposed=false
 const schedule=(session:Session)=>{
  if(disposed||queued.has(session)||pending.has(session)||attempted.has(session))return
  queued.add(session)
  queueMicrotask(()=>{
   queued.delete(session)
   if(disposed||pending.has(session)||attempted.has(session))return
   try{
   if(disposed||ctx.sessions.get(session.id)!==session||session.header.parentSession!==undefined||session.header.origin==='subagent')return
   const title=titles.get(session)
   const events=readSessionEvents(session)
   const first=events.find(event=>event.type==='user/message'&&event.data.source.kind==='user'&&normalizeSessionTitle(event.data.content.filter(block=>block.type==='text').map(block=>block.text).join('\n'),Number.MAX_SAFE_INTEGER).length>0)
   // 默认 first-prompt 的实际输入就是首条本人消息；预检与 generate 必须完全同源。
   if(!title||!first||!title.messageSeqs.includes(first.seq)||employeeMentionReadableTitle(events,title)===undefined||employeeMentionTitleInput(events,first.seq)===undefined)return
   // 从微任务进入，避开 Session publication/reentrant 边界；同步预检后才调用公开 refresh。
   // 一次恢复持有到原生异步生成结束；失败也不因自身标题事件无限自动重试。
   attempted.add(session);pending.add(session)
   void Promise.resolve(titles.refresh(session)).catch(()=>{ctx.logger.warn('员工会话自动标题暂未恢复，原始会话记录仍保留。')}).finally(()=>pending.delete(session))
   }catch{attempted.add(session);pending.delete(session);ctx.logger.warn('员工会话自动标题暂未恢复，原始会话记录仍保留。')}
  })
 }
 const offCreated=ctx.on('session/created',schedule)
 const offEvent=ctx.on('session/event',(session,event)=>{
  if(event.type==='session/title'||event.type==='user/message'&&event.data.source.kind==='runtime-context')schedule(session)
 })
 for(const session of ctx.sessions.list())schedule(session)
 return ()=>{disposed=true;queued.clear();offCreated();offEvent()}
}

/** 仅替换默认 first-prompt 插件；实验 all-prompts 原来禁用此行的互斥装配保持不变。 */
export function apply(ctx:Context,config:Record<string,unknown>):void{
 const native=ctx.sessionTitle
 // Cordis 的隔离注册会影响后续上下文解析；在隔离前捕获真实公开方法及其 receiver。
 const titles:TitleRecoveryService={get:native.get.bind(native),refresh:native.refresh.bind(native)}
 const scoped=ctx.isolate('sessionTitle')
 scoped.provide('sessionTitle',{register:(provider:Provider)=>native.register(employeeAwareTitleProvider(provider))})
 // 官方 apply 仅用 sessionTitle.register；模型、超时、辅助请求审计和配置校验仍走原实现。
 official.apply(scoped,config)
 ctx.effect(()=>installEmployeeMentionTitleRecovery(ctx,titles),'teloa: 员工自动标题恢复')
}

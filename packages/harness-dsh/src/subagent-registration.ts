import type {Context} from '@deepseek-ai/cordis'
import {SessionId} from '@deepseek-ai/dsh-session'

export type SubagentRegistrationPorts={
 bind:(input:{childSessionId:string;depth:number;parentSessionId:string})=>Promise<void>
 settle:(input:{childSessionId:string;stopReason:string})=>Promise<void>
 /** 生命周期通知已晚于子级创建，登记写入失败后必须留下保守终态，不能静默丢失。 */
 abandon:(input:{childSessionId:string;depth:number;parentSessionId:string;reason:string})=>Promise<void>
}

type RegisteredChild={childSessionId:string;depth:number;parentSessionId:string;bound:Promise<boolean>}
/** 上游公开生命周期负载只在此处作结构读取，避免把可选宿主插件变成 Teloa 的运行期依赖。 */
type SubagentStartInfo={readonly id:unknown}
type SubagentEndInfo={readonly id:unknown;readonly stopReason:unknown}
type LifecycleContext={
 agents:{get:(id:SessionId)=>{session:{header:{parentSession?:unknown;delegationDepth?:unknown}}}|undefined}
 logger:{warn:(message:string)=>void}
 on:{
  (name:'subagent/start',listener:(info:SubagentStartInfo)=>void,options:{global:true}):()=>void
  (name:'subagent/end',listener:(info:SubagentEndInfo)=>void,options:{global:true}):()=>void
 }
}

const session=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(value)
const depth=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0&&value<=32
const reason=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=256

/**
 * 生命周期函数不再能撤回已经创建的子级；所以登记失败时把同一预留收成 abandoned，
 * 让累计上限继续保守计数，而不是让未登记的执行绕开父 Run。
 */
export function registerSubagentRegistration(ctx:Context,ports:SubagentRegistrationPorts):()=>void{
 const lifecycle=ctx as unknown as LifecycleContext
 const children=new Map<string,RegisteredChild>()
 const report=(phase:string)=>lifecycle.logger.warn('Teloa 子 Agent '+phase+'登记未完成，已保守保留该次委派。')
 const abandon=async(child:Omit<RegisteredChild,'bound'>,failure:string)=>{
  try{await ports.abandon({...child,reason:failure})}catch{report('失败')}
 }
 const start=(info:SubagentStartInfo)=>{
  const childSessionId=String(info.id),child=lifecycle.agents.get(SessionId(childSessionId)),header=child?.session.header
  if(!session(childSessionId)||!session(header?.parentSession)||!depth(header.delegationDepth)){report('启动');return}
  const record:Omit<RegisteredChild,'bound'>={childSessionId,parentSessionId:header.parentSession,depth:header.delegationDepth}
  const bound=ports.bind(record).then(()=>true,async()=>{await abandon(record,'registration-failed');return false})
  children.set(childSessionId,{...record,bound})
 }
 const end=(info:SubagentEndInfo)=>{
  const childSessionId=String(info.id),record=children.get(childSessionId)
  if(record===undefined){report('结束');return}
  void record.bound.then(async bound=>{
  try{
    if(bound){
     if(!reason(info.stopReason))throw Error('invalid stop reason')
     await ports.settle({childSessionId,stopReason:info.stopReason})
    }
   }catch{
    const {bound:_,...identity}=record
    await abandon(identity,'settlement-failed')
   }
   finally{children.delete(childSessionId)}
  })
 }
 // DSH 按父 Agent 的会话作用域分派生命周期事件；宿主登记必须跨作用域观察，
 // 否则预留能写入而子会话永远不会绑定到 Task Run。
 const removeStart=lifecycle.on('subagent/start',start,{global:true})
 const removeEnd=lifecycle.on('subagent/end',end,{global:true})
 return ()=>{removeStart();removeEnd();children.clear()}
}

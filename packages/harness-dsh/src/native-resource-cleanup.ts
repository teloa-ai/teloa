import {AsyncLocalStorage} from 'node:async_hooks'
import {types} from 'node:util'
import type {Context} from '@deepseek-ai/cordis'
import type {Agent} from '@deepseek-ai/dsh-agent'
import type {ToolCallId} from '@deepseek-ai/dsh-llm'
import type {Session,SessionStore} from '@deepseek-ai/dsh-session'
import type {ToolExecution,ToolExecutionInput,ToolExecutionResult,ToolRunContext} from '@deepseek-ai/dsh-tools'
import {WorkError} from '@teloa/contract'

type Admission=
 |Readonly<{kind:'create';input:ToolExecutionInput;exec:ToolRunContext}>
 |Readonly<{kind:'body'|'body-end';exec:ToolRunContext}>
type Ticket={
 ctx:Context;root:Context;agent:Agent;agentContext:Context;session:Session;id:Agent['id']
 header:Session['header'];sessionPrototype:object;sessionIdGetter:()=>unknown
 input:ToolExecutionInput;checkOwner:()=>boolean;active:boolean;entered:boolean
 phase:'issued'|'created'|'body'|'ended';exec?:ToolRunContext;fields?:Readonly<Record<string,unknown>>
}
const closeTool='mcp__playwright-mcp__browser_close'
const scope=new AsyncLocalStorage<Ticket>()
const inputs=new WeakMap<ToolExecutionInput,Ticket>(),executions=new WeakMap<ToolExecution,Ticket>()
const denied=()=>new WorkError('teloa/forbidden','资源回收归属或实际关闭调用已失效。')
const empty=(value:unknown)=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value))&&Reflect.ownKeys(value).length===0
function data(object:object,key:string):unknown{
 if(types.isProxy(object))throw denied()
 const descriptor=Object.getOwnPropertyDescriptor(object,key)
 if(descriptor&&!('value' in descriptor))throw denied()
 return descriptor?.value
}
function identity(ticket:Ticket,ctx:Context):void{
 const {agent,session,id,input}=ticket
 if(!ticket.active||scope.getStore()!==ticket||ctx.root!==ticket.root||ticket.ctx.root!==ticket.root
  ||agent.ctx!==ticket.agentContext||agent.ctx.root!==ticket.root||agent.id!==id||agent.session!==session||session.id!==id
  ||ticket.ctx.agents.get(id)!==agent||ctx.agents.get(id)!==agent||agent.ctx.agents.get(id)!==agent
  ||(ticket.ctx.get('sessions') as SessionStore|undefined)?.get(id)!==session
  ||(ctx.get('sessions') as SessionStore|undefined)?.get(id)!==session
  ||(agent.ctx.get('sessions') as SessionStore|undefined)?.get(id)!==session)throw denied()
 input.signal.throwIfAborted()
 if(ticket.exec&&ticket.fields){
  for(const [key,value] of Object.entries(ticket.fields))if(data(ticket.exec,key)!==value)throw denied()
 }
}
/** 官方 Agent 是普通对象的 own data 字段；Session.id 则是 header.id 的原型 getter。 */
function identityData(ticket:Ticket):void{
 const {agent,session,id,header,sessionPrototype,sessionIdGetter}=ticket
 if(!ticket.active||data(agent,'ctx')!==ticket.agentContext||data(agent,'id')!==id||data(agent,'session')!==session
  ||data(session,'header')!==header||data(header,'id')!==id
  ||Object.getOwnPropertyDescriptor(session,'id')!==undefined||Object.getPrototypeOf(session)!==sessionPrototype)throw denied()
 const descriptor=Object.getOwnPropertyDescriptor(sessionPrototype,'id')
 if(!descriptor||descriptor.get!==sessionIdGetter||descriptor.set!==undefined||'value' in descriptor)throw denied()
 if(ticket.exec&&ticket.fields){
  for(const [key,value] of Object.entries(ticket.fields))if(data(ticket.exec,key)!==value)throw denied()
 }
}
function current(ticket:Ticket,ctx:Context):void{
 // 所有 getter、注册表查询与 signal 方法在唯一最终 owner 回调之前执行。
 identity(ticket,ctx)
 if(ticket.checkOwner()!==true)throw denied()
 // SDK 普通对象只读 descriptor；不再调用 identity/getter 或重复 owner 回调。
 identityData(ticket)
}

/**
 * 由已经持有资源事实的宿主 owner 私有保存。当前唯一回收操作是空参 browser_close。
 * 调用者不能提供工具名、parent、initiator 或自制 input；业务审批和持久 dirty 仍由原 owner 核对。
 */
export function createNativeResourceCleanupOwner(ctx:Context,owns:(agent:Agent)=>boolean){
 let closed=false
 return Object.freeze({
  async execute(agent:Agent,callId:ToolCallId,signal:AbortSignal):Promise<ToolExecutionResult>{
   if(closed||scope.getStore())throw denied()
   const input:ToolExecutionInput=Object.freeze({agent,callId,signal,name:closeTool,arguments:Object.freeze({})})
   const session=agent.session,header=session.header
   if(types.isProxy(agent)||types.isProxy(session)||types.isProxy(header))throw denied()
   const sessionPrototype=Object.getPrototypeOf(session) as object
   if(types.isProxy(sessionPrototype))throw denied()
   const sessionIdGetter=Object.getOwnPropertyDescriptor(sessionPrototype,'id')?.get
   if(typeof sessionIdGetter!=='function'||!Object.isFrozen(header))throw denied()
   const ticket:Ticket={ctx,root:ctx.root,agent,agentContext:agent.ctx,session,id:agent.id,header,sessionPrototype,sessionIdGetter,input,checkOwner:()=>!closed&&owns(agent),active:true,entered:false,phase:'issued'}
   inputs.set(input,ticket)
   try{return await scope.run(ticket,async()=>{
    current(ticket,ctx)
    const result=await ctx.tools.execute(input)
    identity(ticket,ctx)
    // 回收结果不成为工作输入或工具续作来源，deferContext 和 post wrapper 均不能借此发布上下文。
    if(result.additionalContexts?.length)throw denied()
    return result
   })}finally{ticket.active=false;inputs.delete(input)}
  },
  close():void{closed=true},
 })
}

/** 官方唯一 Tools policy 在无 agent 提前返回之前调用；普通无票据、无回收scope的调用不受影响。 */
export function admitNativeResourceCleanup(ctx:Context,request:Admission):boolean{
 const ticket=request.kind==='create'?inputs.get(request.input):executions.get(request.exec)
 if(!ticket){if(scope.getStore())throw denied();return false}
 if(request.kind==='body-end'){ticket.phase='ended';return true}
 current(ticket,ctx)
 const {exec}=request
 if(request.kind==='create'){
  if(ticket.phase!=='issued'||executions.has(exec)||request.input!==ticket.input
   ||data(exec,'agent')!==ticket.agent||data(exec,'callId')!==ticket.input.callId||data(exec,'rootCallId')!==ticket.input.callId
   ||data(exec,'name')!==closeTool||data(exec,'signal')!==ticket.input.signal||data(exec,'parent')!==undefined
   ||data(exec,'schema')!==undefined||!empty(data(exec,'arguments'))||!data(exec,'token'))throw denied()
  ticket.fields=Object.freeze(Object.fromEntries(['agent','callId','rootCallId','name','signal','parent','schema','arguments','token'].map(key=>[key,data(exec,key)])))
  ticket.exec=exec;executions.set(exec,ticket);ticket.phase='created'
  current(ticket,ctx);return true
 }
 if(ticket.exec!==exec||ticket.phase!=='created'||!ticket.entered)throw denied()
 current(ticket,ctx);ticket.phase='body';return true
}

/** 回收 wrapper 不创建普通 ToolCause，不能供嵌套工具、附加上下文或子任务继承。 */
export function enterNativeResourceCleanup(ctx:Context,exec:ToolExecution):boolean{
 const ticket=executions.get(exec)
 if(!ticket){if(scope.getStore())throw denied();return false}
 current(ticket,ctx)
 if(ticket.phase!=='created'||ticket.entered)throw denied()
 ticket.entered=true;return true
}

/** 包含已结束但仍被异步任务继承的 scope，避免迟到回收降级成新工作。 */
export function isNativeResourceCleanupScope():boolean{return scope.getStore()!==undefined}

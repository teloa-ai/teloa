import type {Context} from '@deepseek-ai/cordis'
import type {ToolExecution} from '@deepseek-ai/dsh-tools'
import {workAccess,type WorkAccess,type WorkAccessLease} from '@teloa/backend'
import {conversationDelegationTools,subagentTaskToolName} from './role-tool-grants.ts'

// 只锁会新增或推进另一个执行主体的实际效果；查询、等待、停止和审批拒绝不在此列。
const parallelTools=new Set<string>([...conversationDelegationTools.filter(name=>name==='subagent'||name==='subagent_fork'||name==='send_message'),subagentTaskToolName,'spawn_teammate','team_task_create','team_task_update','workflow','ralph'])
const reason='当前暂不能使用多 Agent 协作，请核对账号权益后重试。'

export function registerNativeCapabilityTools(ctx:Context,owner:string,access:WorkAccess=workAccess):()=>void{
 const checked=new WeakMap<ToolExecution,WorkAccessLease>()
 const before=ctx.on('tools/pre-execute',async(exec,next)=>{
  if(!exec.agent||!parallelTools.has(exec.name))return next()
  try{
   exec.signal.throwIfAborted()
   const lease=await access.authorize({kind:'capability',capability:'parallel-agents',ownerId:owner,sessionId:exec.agent.id,objectId:exec.agent.id,operation:'run'})
   exec.signal.throwIfAborted();lease.assertCurrent();checked.set(exec,lease)
  }catch{return {kind:'deny' as const,reason}}
  return next()
 },{global:true,prepend:true})
 // 真实系统审批后、工具体前再次核对同一租约；等待确认不冻结高级权益。
 const final=ctx.tools.guard(exec=>{
  if(!exec.agent||!parallelTools.has(exec.name))return
  const lease=checked.get(exec)
  if(!lease)return reason
  try{exec.signal.throwIfAborted();lease.assertCurrent()}catch{return reason}
 })
 return ()=>{before();final()}
}

import type {Context} from '@deepseek-ai/cordis'
import type {PreToolDecision,ToolExecution} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import {SessionId} from '@deepseek-ai/dsh-session'
import {resolveSessionLineage} from './subagent-lineage.ts'
import type {TaskToolPolicyReader} from './task-tool-guard.ts'

// 执行对象由原生运行器唯一创建；弱引用只保存本次审核的同步复核，不跨调用复用授权。
const permissionCheckpoints=new WeakMap<ToolExecution,()=>void>()

/** 在异步业务授权读口之后调用；不能沿用等待期间已变化的原生权限与审核结果。 */
export function recheckNativeAutoReviewPermissions(exec:ToolExecution):void{
 permissionCheckpoints.get(exec)?.()
}

/**
 * DSH 0.2 Auto 使用全权限沙箱与原生模型审核；仅存活审核器登记的 Auto 可用于受管任务。
 * 卸载后上游会转为 Full access，仍由本守卫阻止；任务身份与工具范围由独立守卫核对。
 */
export function registerNativeAutoReviewGuard(ctx:Context,readPolicy:TaskToolPolicyReader){
 const checkedAuto=new WeakMap<ToolExecution,ReadonlySet<string>>()
 let active=true
 const check=async(exec:ToolExecution):Promise<PreToolDecision|undefined>=>{
  if(!exec.agent)return
  if(exec.signal.aborted)return {kind:'deny',reason:'本次工具调用已取消。'}
  try{
   const session=exec.agent.session,lineage=resolveSessionLineage(ctx,session)
   const policy=await readPolicy(lineage.root.id,exec.signal)
   if(exec.signal.aborted)return {kind:'deny',reason:'本次工具调用已取消。'}
   if(policy===null)return
   if(policy===undefined)throw Error('missing managed policy')
   // 不仅看 preset 名称：自定义别名、直接改 sandbox/mode、卸载迁移都可能保留全权限。
   const sessions=[session,...lineage.ancestors.map(id=>{
    const ancestor=ctx.agents.get(SessionId(id))
    if(!ancestor)throw Error('subagent parent unavailable')
    return ancestor.session
   })]
   const expected=checkedAuto.get(exec),autoSessions=new Set<string>()
   for(const target of sessions){
    const preset=ctx.permissionPresets.current(target),mode=ctx.sandboxPolicy.resolve({session:target}).mode
    if(expected?.has(target.id)&&preset!=='auto')return {kind:'deny',reason:'审核期间权限模式已变化，请按当前模式重新执行。'}
    // current 只有在原生 Auto 注册存活且会话状态匹配时才返回 auto，不能靠会话事件伪造审核器。
    if(preset==='auto'&&mode==='danger-full-access'){autoSessions.add(target.id);continue}
    if(mode==='danger-full-access')return {kind:'deny',reason:'受管任务不能使用完全访问，请选择 Auto review 或受限权限后重试。'}
    if(mode!=='read-only'&&mode!=='workspace-write')throw Error('unrecognized sandbox policy')
   }
   if(autoSessions.size&&!expected)checkedAuto.set(exec,autoSessions)
   recheckNativeAutoReviewPermissions(exec)
   if(!permissionCheckpoints.has(exec)){
    const snapshot=sessions.map(target=>({target,preset:ctx.permissionPresets.current(target),mode:ctx.sandboxPolicy.resolve({session:target}).mode}))
    permissionCheckpoints.set(exec,()=>{
     exec.signal.throwIfAborted()
     if(!active)throw Error('任务权限守卫已停用，请重新执行。')
     for(const {target,preset,mode} of snapshot){
      if(ctx.agents.get(target.id)?.session!==target)throw Error('任务会话归属已变化，请重新执行。')
      if(ctx.permissionPresets.current(target)!==preset||ctx.sandboxPolicy.resolve({session:target}).mode!==mode)throw Error('审核期间权限模式已变化，请按当前模式重新执行。')
     }
    })
   }
  }catch{
   return {kind:'deny',reason:'无法核对任务执行权限，请先恢复授权服务。'}
  }
 }
 const removeExecute=ctx.on('tools/execute',async(exec,next)=>{
  if(checkedAuto.has(exec)){
   const decision=await check(exec)
   if(decision?.kind==='deny')throw Error(decision.reason)
  }
  return next()
 })
 const removePreExecute=ctx.on('tools/pre-execute',async(exec,next):Promise<PreToolDecision>=>{
  const decision=await check(exec)
  return decision??next()
 },{prepend:true})
 return ()=>{active=false;removePreExecute();removeExecute()}
}

import type {Context} from '@deepseek-ai/cordis'
import type {PreToolDecision} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import {SessionId} from '@deepseek-ai/dsh-session'
import {resolveSessionLineage} from './subagent-lineage.ts'
import type {TaskToolPolicyReader} from './task-tool-guard.ts'

/**
 * 官方 Auto 是 Full access + never；卸载 Auto 插件还会把存活会话迁移到 Full access。
 * 受管 Run 继续使用 Teloa 的身份与审批边界，只通过公开读口拒绝扩权，不改写原生预设。
 */
export function registerNativeAutoReviewGuard(ctx:Context,readPolicy:TaskToolPolicyReader){
 return ctx.on('tools/pre-execute',async(exec,next):Promise<PreToolDecision>=>{
  if(!exec.agent)return next()
  if(exec.signal.aborted)return {kind:'deny',reason:'本次工具调用已取消。'}
  try{
   const session=exec.agent.session,lineage=resolveSessionLineage(ctx,session)
   const policy=await readPolicy(lineage.root.id,exec.signal)
   if(exec.signal.aborted)return {kind:'deny',reason:'本次工具调用已取消。'}
   if(policy===null)return next()
   if(policy===undefined)throw Error('missing managed policy')
   // 不仅看 preset 名称：自定义别名、直接改 sandbox/mode、卸载迁移都可能保留全权限。
   const sessions=[session,...lineage.ancestors.map(id=>{
    const ancestor=ctx.agents.get(SessionId(id))
    if(!ancestor)throw Error('subagent parent unavailable')
    return ancestor.session
   })]
   for(const target of sessions){
    const preset=ctx.permissionPresets.current(target),mode=ctx.sandboxPolicy.resolve({session:target}).mode
    if(preset==='auto'||mode==='danger-full-access')return {kind:'deny',reason:'受管任务不能使用 Auto review 或 Full access，请恢复受限权限后重试。'}
    if(mode!=='read-only'&&mode!=='workspace-write')throw Error('unrecognized sandbox policy')
   }
  }catch{
   return {kind:'deny',reason:'无法核对任务执行权限，请先恢复授权服务。'}
  }
  return next()
 },{prepend:true})
}

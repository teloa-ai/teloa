import type {Context} from '@deepseek-ai/cordis'
import type {Agent} from '@deepseek-ai/dsh-agent'
import {resolveSessionLineage} from './subagent-lineage.ts'

/** DSH 目录和 /name 在 next 返回后读取；绑定必须先于 next，且失败不能降级为普通会话。 */
export function registerManagedRunSkillPreStep<Binding>(
 ctx:Context,
 reader:(sessionId:string,signal:AbortSignal)=>Promise<Binding|undefined>,
 ensure:(agent:Agent,binding:Binding,signal:AbortSignal)=>Promise<void>,
){
 return ctx.on('agent/pre-step',async({agent,signal},next)=>{
  signal.throwIfAborted()
  // 子 Agent 会话没有自己的 Run，绑定按谱系根会话读；谱系断链时这里直接抛，
  // 与本文件的既有语义一致——失败不能降级为普通会话（那等于让子级绕过 Run Skill 作用域）。
  const root=resolveSessionLineage(ctx,agent.session).root
  const binding=await reader(root.id,signal)
  signal.throwIfAborted()
  if(binding!==undefined){
   await ensure(agent,binding,signal)
   signal.throwIfAborted()
  }
  return next()
 })
}

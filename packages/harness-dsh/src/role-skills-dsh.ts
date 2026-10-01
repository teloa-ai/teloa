import type {Context} from '@deepseek-ai/cordis'
import {brandString} from '@deepseek-ai/dsh-brand'
import type {SessionId} from '@deepseek-ai/dsh-session'
import {WorkError} from '@teloa/contract'
import {resolveRoleSkills} from './role-skills.ts'
import type {TaskRunSkillDatabase} from '@teloa/backend'
import {resolveManagedRunSkillsByInstallation,type ManagedRunSkillPorts,type ManagedRunSkillResolver} from './managed-run-skills.ts'
import type {RunSkill} from '@teloa/backend'

export type ReadManagedSkillAvailability=(name:string,database?:TaskRunSkillDatabase)=>Promise<'enabled'|'disabled'|undefined>

/** 按执行会话的预设及 cwd 解析，不使用首页或全局技能目录冒充会话能力。 */
export async function resolveDshRoleSkills(ctx:Context,owner:string,sessionId:string,names:readonly string[],inspect:(id:string)=>Promise<{ownerId:string;sessionId:string;status:string}>,signal:AbortSignal,resolveManaged?:ManagedRunSkillResolver,database?:TaskRunSkillDatabase,readManagedAvailability?:ReadManagedSkillAvailability){
 signal.throwIfAborted()
 const binding=await inspect(sessionId)
 if(binding.ownerId!==owner||binding.sessionId!==sessionId||binding.status!=='ready')throw new WorkError('teloa/forbidden','员工能力目标会话身份不匹配。')
 const resolved=await ctx.sessionController.resolveAgent(brandString<SessionId>(sessionId))
 signal.throwIfAborted()
 if('error' in resolved)throw new WorkError('teloa/session-unavailable','员工能力目标会话不可用。')
 const agent=resolved.agent,skills=ctx.agentPresets.serviceFor(agent,'skills')??ctx.skills
 return resolveRoleSkills(names,async(name,currentSignal)=>{
  currentSignal.throwIfAborted()
  if(await readManagedAvailability?.(name,database)==='disabled')return undefined
  currentSignal.throwIfAborted()
  return skills.get(name,{cwd:agent.session.header.cwd,scope:agent,signal:currentSignal})
 },signal,resolveManaged?(skill,currentSignal)=>resolveManaged(skill,currentSignal,database):undefined)
}

export async function resolveDshManagedRoleSkills(ctx:Context,owner:string,sessionId:string,installationIds:readonly string[],inspect:(id:string)=>Promise<{ownerId:string;sessionId:string;status:string}>,signal:AbortSignal,ports:ManagedRunSkillPorts,database?:TaskRunSkillDatabase):Promise<RunSkill[]>{
 signal.throwIfAborted()
 const binding=await inspect(sessionId)
 if(binding.ownerId!==owner||binding.sessionId!==sessionId||binding.status!=='ready')throw new WorkError('teloa/forbidden','员工能力目标会话身份不匹配。')
 const resolved=await ctx.sessionController.resolveAgent(brandString<SessionId>(sessionId))
 signal.throwIfAborted()
 if('error' in resolved)throw new WorkError('teloa/session-unavailable','员工能力目标会话不可用。')
 return resolveManagedRunSkillsByInstallation(owner,resolved.agent,installationIds,signal,ports,database)
}

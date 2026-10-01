import {WorkError,type CapabilitySnapshot} from '@teloa/contract'
import type {SkillSummary} from '@deepseek-ai/dsh-skill'
/** 首页仅列出固定工作区的元数据；不接收客户端路径，不创建会话。 */
export async function readHomeSkills(payload:unknown,list:()=>Promise<SkillSummary[]>):Promise<CapabilitySnapshot['skills']>{
 if(!payload||typeof payload!=='object'||Array.isArray(payload)||Object.keys(payload).length)throw new WorkError('teloa/invalid-input','首页技能目录不接受路径或会话参数。')
 return (await list()).map(skill=>({name:skill.name,description:skill.description,source:skill.source,provider:skill.provider,modelInvocable:skill.invocation.modelInvocable,userInvocable:skill.invocation.userInvocable}))
}

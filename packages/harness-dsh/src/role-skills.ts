import {createHash} from 'node:crypto'
import {WorkError,promptFullTextMaxBytes} from '@teloa/contract'
import type {ManagedRunSkill,RunSkill} from '@teloa/backend'
import type {SkillDefinition,SkillResourceBase} from '@deepseek-ai/dsh-skill'

export type RoleSkillSnapshot=RunSkill
const kib=(bytes:number)=>Math.ceil(bytes/1024)
export type ReadRoleSkill=(name:string,signal:AbortSignal)=>Promise<SkillDefinition|undefined>
export type ResolveManagedRoleSkill=(skill:SkillDefinition,signal:AbortSignal)=>Promise<ManagedRunSkill|undefined>
/** 读取原生获胜提供方；只提供工作方法，技能正文不授予工具或数据权限。 */
export async function resolveRoleSkills(names:readonly string[],read:ReadRoleSkill,signal:AbortSignal,resolveManaged?:ResolveManagedRoleSkill):Promise<RoleSkillSnapshot[]>{
 if(names.length>30||new Set(names).size!==names.length||names.some(name=>typeof name!=='string'||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)))throw new WorkError('teloa/invalid-input','员工技能需要使用已安装技能的唯一名称。')
 const skills:SkillDefinition[]=[]
 let bytes=0,largest={name:'',bytes:0}
 for(const name of names){
  signal.throwIfAborted()
  let skill:SkillDefinition|undefined
  try{skill=await read(name,signal)}catch{
   signal.throwIfAborted()
   throw new WorkError('teloa/skill-unavailable','员工技能读取失败：'+name)
  }
  signal.throwIfAborted()
  if(!skill||skill.name!==name)throw new WorkError('teloa/skill-unavailable','员工技能未安装或身份不匹配：'+name)
  if(!skill.invocation.modelInvocable)throw new WorkError('teloa/forbidden','该技能不允许员工调用：'+name)
  // Teloa 内置技能（如技能创建器）只登记在本人普通会话，不能被写进岗位技能、冻结进员工运行。
  if(skill.provider==='teloa-builtin')throw new WorkError('teloa/forbidden','Teloa 内置技能只用于本人会话，不能分配给员工：'+name)
  if(typeof skill.content!=='string'||!skill.content.trim()||typeof skill.provider!=='string'||!skill.provider||typeof skill.source!=='string'||!skill.source||typeof skill.description!=='string')throw new WorkError('teloa/skill-unavailable','员工技能内容不完整：'+name)
  const size=Buffer.byteLength(skill.content,'utf8')
  bytes+=size
  if(size>largest.bytes)largest={name,bytes:size}
  skills.push(skill)
 }
 // 技能正文整段写进任务提示词，256 KiB 合计是提示词预算；读完全部技能再报，让用户看到合计与最大的一条。
 if(bytes>promptFullTextMaxBytes)throw new WorkError('teloa/invalid-input','员工技能正文合计 '+kib(bytes)+' KiB，超过 '+kib(promptFullTextMaxBytes)+' KiB 上限（最大：'+largest.name+' '+kib(largest.bytes)+' KiB）。请减少本员工绑定的技能。')
 const result:RoleSkillSnapshot[]=[]
 for(const skill of skills){
  const name=skill.name
  const managed=await resolveManaged?.(skill,signal)
  signal.throwIfAborted()
  if((skill.provider==='teloa-market')!==(managed!==undefined))throw new WorkError('teloa/storage-corrupt','受管技能缺少固定安装身份。')
  result.push({name,provider:skill.provider,source:skill.source,description:skill.description,content:skill.content,sha256:createHash('sha256').update(skill.content).digest('hex'),...(skill.resourceBase?{resourceBase:{...skill.resourceBase} as SkillResourceBase}:{}),...(managed?{managed}:{})})
 }
 return result
}

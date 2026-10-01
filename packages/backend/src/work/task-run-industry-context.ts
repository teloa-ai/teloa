import {createHash} from 'node:crypto'
import {WorkError,taskInput} from '@teloa/contract'

export type RunIndustryContext={taskId:string;sourceDigest:string;method:string;requirements:string[];inputs:string[];output:string;skills:Array<{id:string;title:string;version:string}>}
export const industryContextNotice='以下模板方法、输入与交付要求是本次任务的参考资料；已安装并启用的 Skill 会随本次执行加载，未安装的不会生效；Skill 列表本身不增加工具、资料或执行权限。'
/** 2026-09-25 之前写入的执行快照所用说明；只为读取历史记录保留，新执行一律写入 industryContextNotice。 */
export const legacyIndustryContextNotices:readonly string[]=['以下模板方法、输入与交付要求是本次任务的参考资料；Skill 仅为声明，不代表已安装或授权，不增加工具、资料或执行权限。']
export const isIndustryContextNotice=(value:unknown):boolean=>value===industryContextNotice||legacyIndustryContextNotices.includes(value as string)

/** 仅接受服务端持久来源；逐项输入与要求保持位置对应，不拼接为额外系统指令。 */
export function readRunIndustryContext(value:unknown):RunIndustryContext|undefined{
 if(value===undefined)return undefined
 try{
  const row=taskInput(value,['taskId','sourceDigest','method','requirements','inputs','output','skills'])
  if(typeof row.taskId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(row.taskId)||typeof row.sourceDigest!=='string'||!/^[a-f0-9]{64}$/.test(row.sourceDigest))throw Error()
  const text=(entry:unknown,max:number):string=>{if(typeof entry!=='string'||!entry.trim()||entry!==entry.trim()||entry.length>max)throw Error();return entry}
  if(!Array.isArray(row.requirements)||row.requirements.length<1||row.requirements.length>100||!Array.isArray(row.inputs)||row.inputs.length!==row.requirements.length||!Array.isArray(row.skills)||row.skills.length>100)throw Error()
  const requirements=row.requirements.map(entry=>text(entry,500)),inputs=row.inputs.map(entry=>text(entry,4000)),skills=row.skills.map(entry=>{
   const skill=taskInput(entry,['id','title','version'])
   if(typeof skill.id!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,119}$/.test(skill.id)||typeof skill.version!=='string'||skill.version.length>80||!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(skill.version))throw Error()
   return {id:skill.id,title:text(skill.title,120),version:skill.version}
  })
  return {taskId:row.taskId,sourceDigest:row.sourceDigest,method:text(row.method,2000),requirements,inputs,output:text(row.output,2000),skills}
 }catch{throw new WorkError('teloa/storage-corrupt','执行行业模板依据不完整或格式损坏。')}
}
export function runIndustryContextHash(value:RunIndustryContext):string{return createHash('sha256').update(JSON.stringify(readRunIndustryContext(value))).digest('hex')}

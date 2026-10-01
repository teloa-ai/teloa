import {createHash} from 'node:crypto'
import {WorkError,taskInput} from '@teloa/contract'

export type RunPlanWorkContext={sourceDigest:string;method:string;requirements:string[];output:string;skills:Array<{id:string;title:string;version:string}>}
export type RunPlanContext={occurrenceId:string;goal:string;dataScope:string;delivery:string;work?:RunPlanWorkContext}
export const planWorkContextNotice='以下模板要求是本轮待获取或核实的资料，不表示已经提供输入；方法与交付要求仅供任务参考，Skill 声明不代表已安装或授权，不增加执行权限。'
export const planContextNotice='资料范围是工作说明，不授予读取或执行权限；实际权限以岗位授权为准。'

/** 与一次性行业任务不同，计划只有本轮待获取要求，没有预先提供的 inputs。 */
export function readRunPlanWorkContext(value:unknown):RunPlanWorkContext{
 try{
  const row=taskInput(value,['sourceDigest','method','requirements','output','skills'])
  const text=(entry:unknown,max:number):string=>{if(typeof entry!=='string'||!entry.trim()||entry.trim()!==entry||entry.length>max)throw Error();return entry}
  if(typeof row.sourceDigest!=='string'||!/^[a-f0-9]{64}$/.test(row.sourceDigest)||!Array.isArray(row.requirements)||row.requirements.length<1||row.requirements.length>100||!Array.isArray(row.skills)||row.skills.length>100)throw Error()
  const requirements=row.requirements.map(entry=>text(entry,500)),skills=row.skills.map(entry=>{
   const skill=taskInput(entry,['id','title','version'])
   if(typeof skill.id!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,119}$/.test(skill.id)||typeof skill.version!=='string'||skill.version.length>80||!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(skill.version))throw Error()
   return {id:skill.id,title:text(skill.title,120),version:skill.version}
  })
  return {sourceDigest:row.sourceDigest,method:text(row.method,2000),requirements,output:text(row.output,2000),skills}
 }catch{throw new WorkError('teloa/storage-corrupt','执行计划的固定工作依据损坏。')}
}

/** 只接受服务端读取的固定计划依据；不接受客户端传入的权限或任意提示词字段。 */
export function readRunPlanContext(value:unknown):RunPlanContext|undefined{
 if(value===undefined)return undefined
 try{
  const row=taskInput(value,['occurrenceId','goal','dataScope','delivery','work'])
  if(typeof row.occurrenceId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(row.occurrenceId))throw Error()
  for(const key of ['goal','dataScope','delivery'])if(typeof row[key]!=='string'||!row[key].trim()||row[key].length>8000||row[key].trim()!==row[key])throw Error()
  return {occurrenceId:row.occurrenceId,goal:row.goal as string,dataScope:row.dataScope as string,delivery:row.delivery as string,...(row.work===undefined?{}:{work:readRunPlanWorkContext(row.work)})}
 }catch{throw new WorkError('teloa/storage-corrupt','执行计划依据不完整或格式损坏。')}
}

export function runPlanContextHash(value:RunPlanContext):string{return createHash('sha256').update(JSON.stringify(readRunPlanContext(value))).digest('hex')}

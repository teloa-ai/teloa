import {WorkError} from './work-error.ts'

/** 原生引用 codec 的正文投影；显示名称不是身份，也不携带授权。 */
export type EmployeeMentionReference={roleId:string;roleVersion:number}
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const invalid=()=>new WorkError('teloa/invalid-input','员工引用已损坏，请移除后重新选择员工。')
export function encodeEmployeeMention(reference:EmployeeMentionReference):string{
 if(!uuid.test(reference.roleId)||!Number.isSafeInteger(reference.roleVersion)||reference.roleVersion<1||reference.roleVersion>2147483647)throw invalid()
 return `[teloa-employee:${reference.roleId.toLowerCase()}:${reference.roleVersion}]`
}
export function parseEmployeeMentions(text:string):EmployeeMentionReference[]{
 const result:EmployeeMentionReference[]=[],pattern=/\[teloa-employee:([^\]\r\n]+)\]/g
 const rest=text.replace(pattern,(_token,payload:string)=>{
  const fields=payload.split(':');if(fields.length!==2||!uuid.test(fields[0]!)||!/^[1-9]\d*$/.test(fields[1]!))throw invalid()
  const reference={roleId:fields[0]!.toLowerCase(),roleVersion:Number(fields[1])};encodeEmployeeMention(reference);result.push(reference);return ''
 })
 if(rest.includes('[teloa-employee:'))throw invalid()
 return result
}
/** 重复同一引用可读；不同岗位或版本不取第一个、不静默改派。 */
export function singleEmployeeMention(text:string):EmployeeMentionReference|undefined{
 const references=parseEmployeeMentions(text),unique=new Map(references.map(reference=>[encodeEmployeeMention(reference),reference]))
 if(unique.size>1)throw new WorkError('teloa/conflict','本轮请指定一位员工；已保留原文，请移除其他员工后再发送。')
 return unique.values().next().value
}

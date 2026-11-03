import type {SessionEvent} from '@deepseek-ai/dsh-session'
import type {UserTextRule} from '@deepseek-ai/dsh-client-ui-conversation/client'
import {encodeEmployeeMention,type DigitalRole,type EmployeeMentionReference} from '@teloa/contract'
import {readEmployeeMentionIdentity} from './employee-mention-presentation.ts'

declare module '@deepseek-ai/dsh-client-ui-conversation/client'{interface UserTextDataMap{'teloa-employee':EmployeeMentionReference}}
/** 只产生显示节点；原消息和员工身份编码不改写，不把名字当授权。 */
export const employeeMentionTextRule:UserTextRule<'teloa-employee'>={id:'teloa-employee',order:5,match(text,from){
 const pattern=/\[teloa-employee:([a-f0-9-]{36}):([1-9][0-9]*)\]/g;pattern.lastIndex=from
 for(let match=pattern.exec(text);match;match=pattern.exec(text)){
  const reference={roleId:match[1]!,roleVersion:Number(match[2])}
  try{if(encodeEmployeeMention(reference)!==match[0])continue}catch{continue}
  return {id:'teloa-employee',start:match.index,end:match.index+match[0].length,data:reference}
 }
 return undefined
}}
/** 用户inline引用显示当前本人目录的同版本名字；目录不可用时才回退受信原生名字。 */
export function employeeMentionDisplayName(reference:EmployeeMentionReference,events:readonly SessionEvent[],roles:readonly DigitalRole[]=[]):string|undefined{
 const role=roles.find(row=>row.kind==='employee'&&row.id===reference.roleId&&row.version===reference.roleVersion)
 if(role?.name.trim())return role.name.trim()
 for(const event of events){
  const data=event.data as unknown as {source?:{kind?:unknown;form?:unknown;sections?:unknown}}
  if(event.type!=='user/message'||data.source?.kind!=='runtime-context'||data.source.form!=='snapshot'||!Array.isArray(data.source.sections))continue
  for(const section of data.source.sections as {name?:unknown;text?:unknown}[]){
   if(section.name!=='teloa/employee-mention'||typeof section.text!=='string')continue
   const identity=readEmployeeMentionIdentity(section.text)
   if(identity?.roleId===reference.roleId&&identity.roleVersion===reference.roleVersion)return identity.name
  }
 }
 return undefined
}

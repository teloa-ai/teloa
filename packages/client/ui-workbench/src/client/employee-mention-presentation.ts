import type {SessionEvent} from '@deepseek-ai/dsh-session'
import type {SessionEventSource} from '@deepseek-ai/dsh-api-session-controller/client'
import {encodeEmployeeMention} from '@teloa/contract'
type EmployeeMentionEventSource=Pick<SessionEventSource,'subscribe'|'getSnapshot'>
const boundEventSources=new WeakMap<EmployeeMentionEventSource,EmployeeMentionEventSource>()
/** SDK事件源的方法依赖this；给React稳定的闭包，保留原源与订阅清理语义。 */
export function bindEmployeeMentionEventSource(source:EmployeeMentionEventSource|undefined):EmployeeMentionEventSource|undefined{
 if(!source)return undefined
 let bound=boundEventSources.get(source)
 if(!bound){bound={subscribe:listener=>source.subscribe(listener),getSnapshot:()=>source.getSnapshot()};boundEventSources.set(source,bound)}
 return bound
}

export type EmployeeMentionIdentity={roleId:string;roleVersion:number;name:string;scopeId:string;state:'active'|'paused'}
/** 只解析宿主 section 文本；调用方仍须先验证实际 runtime-context 来源。 */
export function readEmployeeMentionIdentity(text:string):EmployeeMentionIdentity|null{
 try{
  const row=JSON.parse(text) as Record<string,unknown>
  if(row.schema!=='teloa.employee-mention/v1'||row.boundTo!=='current-owner-message'||typeof row.name!=='string'||!row.name.trim()||row.name.length>120||typeof row.scopeId!=='string'||!row.scopeId||!['active','paused'].includes(String(row.state)))return null
  const reference={roleId:row.roleId as string,roleVersion:row.roleVersion as number};encodeEmployeeMention(reference)
  return {...reference,name:row.name,scopeId:row.scopeId,state:row.state as 'active'|'paused'}
 }catch{return null}
}
/** 仅展示本轮宿主原生上下文，不能从用户@文字或最新角色名倒填历史答复身份。 */
export function employeeMentionIdentity(events:readonly SessionEvent[],assistantSeq:number):EmployeeMentionIdentity|null{
 if(!events.some(event=>event.seq===assistantSeq&&event.type==='assistant/message'))return null
 let selected:EmployeeMentionIdentity|null=null
 for(const event of events){
  if(event.seq>assistantSeq)break
  if(event.type==='turn/start')selected=null
  const data=event.data as unknown as {source?:{kind?:unknown;form?:unknown;sections?:unknown}}
  if(event.type!=='user/message'||data.source?.kind!=='runtime-context'||data.source.form!=='snapshot'||!Array.isArray(data.source.sections))continue
  const section=(data.source.sections as {name?:unknown;text?:unknown}[]).find(row=>row.name==='teloa/employee-mention');if(typeof section?.text!=='string')continue
  selected=readEmployeeMentionIdentity(section.text)
 }
 return selected
}

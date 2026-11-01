import type {InputTriggerSource} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import {encodeEmployeeMention,singleEmployeeMention,roleSupportsScope,type EmployeeMentionReference,type DigitalRole} from '@teloa/contract'
import {employeeMentionCopy} from './employee-mention-copy.ts'

export type EmployeeMentionCandidate=EmployeeMentionReference&{name:string;state:'active'|'paused'|'retired';scopeTitle:string;duty?:string}
export type EmployeeMentionSourcePorts={
 locale:()=>string
 /** 必须使用当前本人目录及当前会话业务过滤；包括暂停状态以便准确说明。 */
 candidates:(sessionId:string,signal:AbortSignal)=>Promise<readonly EmployeeMentionCandidate[]>
 /** 正常只读宿主校验；还须核对该 session 仍为正在提交的输入，抛错保留原生草稿。 */
 verify:(sessionId:string,reference:EmployeeMentionReference,signal:AbortSignal)=>Promise<void>
}
const source='teloa-employees'
export function employeeMentionCandidates(roles:readonly DigitalRole[],scopeId:string,scopeTitle:string):EmployeeMentionCandidate[]{
 return roles.filter(role=>role.kind==='employee'&&(scopeId==='general'||roleSupportsScope(role.scopes,scopeId))).map(role=>({roleId:role.id,roleVersion:role.version,name:role.name,state:role.state,scopeTitle,duty:role.duty.replace(/\s+/g,' ').slice(0,160)}))
}
function decode(value:string):{sessionId:string;reference:EmployeeMentionReference}{
 let row:unknown;try{row=JSON.parse(value)}catch{throw Error('员工引用无法核对，请重新选择。')}
 if(!row||typeof row!=='object'||Array.isArray(row))throw Error('员工引用无法核对，请重新选择。')
 const data=row as Record<string,unknown>
 if(Object.keys(data).sort().join(',')!=='reference,sessionId'||typeof data.sessionId!=='string'||!data.sessionId)throw Error('员工引用无法核对，请重新选择。')
 const ref=data.reference as EmployeeMentionReference
 if(!ref||Object.keys(ref).sort().join(',')!=='roleId,roleVersion')throw Error('员工引用无法核对，请重新选择。')
 encodeEmployeeMention(ref);return {sessionId:data.sessionId,reference:ref}
}
/** 原生 picker、IME、Enter、Escape 与草稿持久化继续由官方 input-trigger 拥有。 */
export function employeeMentionSource(ports:EmployeeMentionSourcePorts):InputTriggerSource{
 return {trigger:'@',name:source,order:5,showGroupTitle:false,
  async candidates(session,{query,signal,quoted,drilled}){
   if(quoted||drilled)return []
   const rows=await ports.candidates(session.sessionId,signal);signal.throwIfAborted()
   return rows.filter(row=>row.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(row=>({name:row.name,section:employeeMentionCopy(ports.locale(),'section'),description:[row.scopeTitle,employeeMentionCopy(ports.locale(),row.state==='active'?'active':row.state),row.duty].filter(Boolean).join(' · '),icon:'session' as const,value:JSON.stringify({sessionId:session.sessionId,reference:{roleId:row.roleId,roleVersion:row.roleVersion}})}))
  },
  onPick({candidate,session}){
   if(!candidate.value)return undefined
   const row=decode(candidate.value);if(row.sessionId!==session.sessionId)throw Error(employeeMentionCopy(ports.locale(),'missing'))
   return {insert:{source,ref:candidate.value,label:'@'+candidate.name,appearance:'session',clipboardText:encodeEmployeeMention(row.reference)}}
  },
  codec:{clipboardText:value=>encodeEmployeeMention(decode(value).reference),serialize:async(value,signal)=>{
   const row=decode(value);signal.throwIfAborted();await ports.verify(row.sessionId,row.reference,signal);signal.throwIfAborted();return encodeEmployeeMention(row.reference)
  }},
 }
}
/** Root 的正常 submit preparation 调用；也覆盖手输/粘贴正文及不同员工多 chip。 */
export async function prepareEmployeeMentionInput(sessionId:string,text:string,ports:Pick<EmployeeMentionSourcePorts,'verify'>,signal:AbortSignal){
 const reference=singleEmployeeMention(text);if(reference){signal.throwIfAborted();await ports.verify(sessionId,reference,signal);signal.throwIfAborted()}
 return reference
}

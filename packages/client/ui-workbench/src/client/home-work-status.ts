export type HomeWorkMember={roleId:string;name:string;scope:string;status:'received'|'waiting'|'unavailable'|'failed'|'stopped';reason?:string;task?:{id:string;title:string};run?:{id:string;state:string};result?:string}
export type HomeWorkStatus={requestId:string;sessionId:string;title:string;scope:string;stoppedAt:string|null;members:HomeWorkMember[]}
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)
/** 只认工具所属会话的真实回包；不从模型正文猜任务或补造链接。 */
export function readHomeWorkStatus(value:unknown,sessionId:string,requestId?:string):HomeWorkStatus{
 if(!record(value)||value.sessionId!==sessionId||typeof value.requestId!=='string'||!value.requestId||requestId!==undefined&&value.requestId!==requestId||typeof value.title!=='string'||typeof value.scope!=='string'||value.stoppedAt!==null&&typeof value.stoppedAt!=='string'||!Array.isArray(value.members))throw Error('工作进度身份或格式不正确。')
 const members=value.members.map(member=>{
  if(!record(member)||typeof member.roleId!=='string'||typeof member.name!=='string'||typeof member.scope!=='string'||!['received','waiting','unavailable','failed','stopped'].includes(String(member.status))||member.reason!==undefined&&typeof member.reason!=='string'||member.result!==undefined&&typeof member.result!=='string')throw Error('接手员工的进度格式不正确。')
  if(member.task!==undefined&&(!record(member.task)||typeof member.task.id!=='string'||!member.task.id||typeof member.task.title!=='string'))throw Error('任务入口格式不正确。')
  if(member.run!==undefined&&(!record(member.run)||typeof member.run.id!=='string'||!member.run.id||typeof member.run.state!=='string'||!member.run.state))throw Error('任务执行状态格式不正确。')
  return {roleId:member.roleId,name:member.name,scope:member.scope,status:member.status,...(member.reason===undefined?{}:{reason:member.reason}),...(member.task===undefined?{}:{task:{id:(member.task as Record<string,string>).id,title:(member.task as Record<string,string>).title}}),...(member.run===undefined?{}:{run:{id:(member.run as Record<string,string>).id,state:(member.run as Record<string,string>).state}}),...(member.result===undefined?{}:{result:member.result})} as HomeWorkMember
 })
 return {requestId:value.requestId,sessionId,title:value.title,scope:value.scope,stoppedAt:value.stoppedAt,members}
}
export type HomeWorkStatusCall=(endpoint:string,payload:unknown,signal?:AbortSignal)=>Promise<unknown>
export async function changeHomeWorkStatus(call:HomeWorkStatusCall,row:HomeWorkStatus,action:'status'|'stop'|'resume',signal?:AbortSignal){
 return readHomeWorkStatus(await call('work-requests/'+action,{sessionId:row.sessionId,requestId:row.requestId},signal),row.sessionId,row.requestId)
}

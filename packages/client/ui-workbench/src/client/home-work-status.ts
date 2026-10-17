import {readWorkExecutor,workTaskStates,type WorkTask,type WorkExecutor} from '@teloa/contract'
export type HomeWorkMember={roleId:string|null;executor?:WorkExecutor;name:string;scope:string;status:'received'|'waiting'|'unavailable'|'failed'|'stopped';reason?:string;task?:{id:string;title:string;state?:WorkTask['state']|'unknown';version?:number};run?:{id:string;state:string;artifactRevision?:{artifactId:string;baseVersion:number;title:string}};result?:string}
export type HomeWorkStatus={requestId:string;sessionId:string;title:string;scope:string;stoppedAt:string|null;members:HomeWorkMember[]}
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)
function readTask(value:unknown):NonNullable<HomeWorkMember['task']>{
 if(!record(value)||typeof value.id!=='string'||!value.id||typeof value.title!=='string'||value.state!==undefined&&(typeof value.state!=='string'||!value.state)||value.version!==undefined&&(!Number.isSafeInteger(value.version)||(value.version as number)<1))throw Error('任务入口格式不正确。')
 return {id:value.id,title:value.title,...(value.state===undefined?{}:{state:workTaskStates.find(state=>state===value.state)??'unknown'}),...(value.version===undefined?{}:{version:value.version as number})}
}
function readRun(value:unknown):NonNullable<HomeWorkMember['run']>{
 if(!record(value)||typeof value.id!=='string'||!value.id||typeof value.state!=='string'||!value.state)throw Error('任务执行状态格式不正确。')
 if(value.artifactRevision===undefined)return {id:value.id,state:value.state}
 const source=value.artifactRevision
 if(!record(source)||typeof source.artifactId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(source.artifactId)||!Number.isSafeInteger(source.baseVersion)||(source.baseVersion as number)<1||!Number.isSafeInteger((source.baseVersion as number)+1)||typeof source.title!=='string')throw Error('成果修改来源格式不正确。')
 return {id:value.id,state:value.state,artifactRevision:{artifactId:source.artifactId,baseVersion:source.baseVersion as number,title:source.title}}
}
/** 只认工具所属会话的真实回包；不从模型正文猜任务或补造链接。 */
export function readHomeWorkStatus(value:unknown,sessionId:string,requestId?:string):HomeWorkStatus{
 if(!record(value)||value.sessionId!==sessionId||typeof value.requestId!=='string'||!value.requestId||requestId!==undefined&&value.requestId!==requestId||typeof value.title!=='string'||typeof value.scope!=='string'||value.stoppedAt!==null&&typeof value.stoppedAt!=='string'||!Array.isArray(value.members))throw Error('工作进度身份或格式不正确。')
 const memberCount=value.members.length,members=value.members.map(member=>{
  if(!record(member))throw Error('工作执行身份不正确。')
  const executor=member.executor===undefined?undefined:readWorkExecutor(member.executor)
  if(executor?.kind==='owner'?(member.roleId!==null||member.scope!=='general'||value.scope!=='general'||executor.grantId!==value.requestId||memberCount!==1):typeof member.roleId!=='string')throw Error('工作执行身份与原交办不一致。')
  if(typeof member.name!=='string'||typeof member.scope!=='string'||!['received','waiting','unavailable','failed','stopped'].includes(String(member.status))||member.reason!==undefined&&typeof member.reason!=='string'||member.result!==undefined&&typeof member.result!=='string')throw Error('接手员工的进度格式不正确。')
  return {roleId:member.roleId,...(executor?{executor}:{}),name:member.name,scope:member.scope,status:member.status,...(member.reason===undefined?{}:{reason:member.reason}),...(member.task===undefined?{}:{task:readTask(member.task)}),...(member.run===undefined?{}:{run:readRun(member.run)}),...(member.result===undefined?{}:{result:member.result})} as HomeWorkMember
 })
 return {requestId:value.requestId,sessionId,title:value.title,scope:value.scope,stoppedAt:value.stoppedAt,members}
}
export type HomeWorkStatusCall=(endpoint:string,payload:unknown,signal?:AbortSignal)=>Promise<unknown>
export async function changeHomeWorkStatus(call:HomeWorkStatusCall,row:HomeWorkStatus,action:'status'|'stop'|'resume',signal?:AbortSignal){
 return readHomeWorkStatus(await call('work-requests/'+action,{sessionId:row.sessionId,requestId:row.requestId},signal),row.sessionId,row.requestId)
}

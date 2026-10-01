import {WorkError,taskInput} from '@teloa/contract'
export type TaskRunEvidence={state:'accepted'}|{state:'active';turn:number;messageSeq:number}|{state:'ended';turn:number;messageSeq:number;endSeq:number;reason:string}
const natural=(v:unknown)=>Number.isSafeInteger(v)&&(v as number)>=0
/** 仅接收宿主从原生日志/发送回执得到的事实，不接收浏览器自报运行状态。 */
export function runEvidence(input:unknown):TaskRunEvidence{
 const row=taskInput(input,['state','turn','messageSeq','endSeq','reason'])
 if(row.state==='accepted'){
  taskInput(row,['state']);return {state:'accepted'}
 }
 if(typeof row.state!=='string'||!['active','ended'].includes(row.state)||!natural(row.turn)||!natural(row.messageSeq))throw new WorkError('teloa/invalid-input','执行证据轮次或序号无效。')
 if(row.state==='active'){
  taskInput(row,['state','turn','messageSeq']);return {state:'active',turn:row.turn as number,messageSeq:row.messageSeq as number}
 }
 if(!natural(row.endSeq)||(row.endSeq as number)<=(row.messageSeq as number)||typeof row.reason!=='string'||!row.reason.trim()||row.reason.length>128)throw new WorkError('teloa/invalid-input','执行终止证据无效。')
 return {state:'ended',turn:row.turn as number,messageSeq:row.messageSeq as number,endSeq:row.endSeq as number,reason:row.reason}
}
export function mergeRunEvidence(previous:TaskRunEvidence|null,next:TaskRunEvidence):TaskRunEvidence{
 if(!previous||previous.state==='accepted')return next
 if(next.state==='accepted')return previous
 if(previous.turn!==next.turn||previous.messageSeq!==next.messageSeq)throw new WorkError('teloa/conflict','执行证据指向不同原生轮次。')
 if(previous.state==='ended'){
  if(next.state==='ended'&&(previous.endSeq!==next.endSeq||previous.reason!==next.reason))throw new WorkError('teloa/conflict','执行终止证据不一致。')
  return previous
 }
 return next
}

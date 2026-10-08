import {WorkError} from './work-error.ts'

/** 话题归属不是执行父关系；这些字段只从持久可信来源推导。 */
export type WorkLineage={schema:'teloa.work-lineage/v1';ownerId:string;rootTaskId:string;definition:{planId:string;definitionVersion:number;occurrenceId:string}|null;parentRunId:string|null;definitionControlId:string|null;roundControlId:string;controlGeneration:number;budgetAccountId:string}
export type WorkSource={kind:'owner-task';taskId:string}|{kind:'plan-occurrence';claimId:string}|{kind:'group-run-message';messageId:string;runId:string}|{kind:'team-child';parentRunId:string;memberId:string}

const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
const positive=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>0
const reservation=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9._:-]{1,256}$/.test(value)
const occurrence=(value:unknown):value is string=>typeof value==='string'&&!!value.trim()&&value.trim()===value&&value.length<=100&&!/[\x00-\x1f]/.test(value)
const invalid=()=>new WorkError('teloa/invalid-input','工作谱系请求格式不正确或包含未知字段。')
const corrupt=()=>new WorkError('teloa/storage-corrupt','工作谱系或其持久来源损坏，已停止读取。')
const exact=(value:unknown,keys:readonly string[]):Record<string,unknown>=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))throw invalid();return value as Record<string,unknown>}

/** 只解析来源声明；真实本人、Task 与 Run 关系仍由可信服务端核对。 */
export function readWorkSource(value:unknown):WorkSource{
 const row=exact(value,['kind','taskId','claimId','messageId','runId','parentRunId','memberId'])
 if(row.kind==='owner-task'&&Object.keys(row).length===2&&uuid(row.taskId))return {kind:'owner-task',taskId:row.taskId.toLowerCase()}
 if(row.kind==='plan-occurrence'&&Object.keys(row).length===2&&uuid(row.claimId))return {kind:'plan-occurrence',claimId:row.claimId.toLowerCase()}
 if(row.kind==='group-run-message'&&Object.keys(row).length===3&&uuid(row.messageId)&&uuid(row.runId))return {kind:'group-run-message',messageId:row.messageId.toLowerCase(),runId:row.runId.toLowerCase()}
 if(row.kind==='team-child'&&Object.keys(row).length===3&&uuid(row.parentRunId)&&reservation(row.memberId))return {kind:'team-child',parentRunId:row.parentRunId.toLowerCase(),memberId:row.memberId}
 throw invalid()
}

/** 前后端共用固定 Run 输入读取器；许可和持久关系仍由服务端核对。 */
export function readWorkLineage(value:unknown):WorkLineage{
 try{
  const row=exact(value,['schema','ownerId','rootTaskId','definition','parentRunId','definitionControlId','roundControlId','controlGeneration','budgetAccountId'])
  if(Object.keys(row).length!==9||row.schema!=='teloa.work-lineage/v1'||typeof row.ownerId!=='string'||!row.ownerId.trim()||row.ownerId.length>128||!uuid(row.rootTaskId)||row.parentRunId!==null&&!uuid(row.parentRunId)||!uuid(row.roundControlId)||!positive(row.controlGeneration)||!uuid(row.budgetAccountId))throw Error()
  let definition:WorkLineage['definition']=null
  if(row.definition!==null){const fixed=exact(row.definition,['planId','definitionVersion','occurrenceId']);if(Object.keys(fixed).length!==3||!uuid(fixed.planId)||!positive(fixed.definitionVersion)||!occurrence(fixed.occurrenceId)||!uuid(row.definitionControlId))throw Error();definition={planId:fixed.planId,definitionVersion:fixed.definitionVersion,occurrenceId:fixed.occurrenceId}}
  else if(row.definitionControlId!==null)throw Error()
  return {schema:'teloa.work-lineage/v1',ownerId:row.ownerId,rootTaskId:row.rootTaskId,definition,parentRunId:row.parentRunId as string|null,definitionControlId:row.definitionControlId as string|null,roundControlId:row.roundControlId,controlGeneration:row.controlGeneration,budgetAccountId:row.budgetAccountId}
 }catch{throw corrupt()}
}

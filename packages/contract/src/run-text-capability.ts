import {WorkError} from './work-error.ts'
import {taskInput} from './tasks.ts'
import {groupReferenceMaxFiles} from './group-attachments.ts'

/** 本人对同一工作明确选择的只读文本能力。资料范围由宿主冻结，不接受模型声明。 */
export type RunTextCapability={schema:'teloa.run-text-capability/v1';kind:'text';approvalId:string;ownerId:string;taskId:string;taskVersion:number;roleId:string;roleVersion:number;groupId:string;groupVersion:number;sourceMessageId:string;sourceDigest:string;materials:{id:string;version:number;sha256:string}[];confirmedAt:string}
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
const version=(value:unknown):value is number=>Number.isSafeInteger(value)&&(value as number)>0
export function readRunTextCapability(value:unknown):RunTextCapability{
 try{
  const row=taskInput(value,['schema','kind','approvalId','ownerId','taskId','taskVersion','roleId','roleVersion','groupId','groupVersion','sourceMessageId','sourceDigest','materials','confirmedAt'])
  if(row.schema!=='teloa.run-text-capability/v1'||row.kind!=='text'||!uuid(row.approvalId)||!uuid(row.taskId)||!uuid(row.roleId)||!uuid(row.groupId)||!uuid(row.sourceMessageId)||typeof row.ownerId!=='string'||!row.ownerId.trim()||row.ownerId.length>128||!version(row.taskVersion)||!version(row.roleVersion)||!version(row.groupVersion)||typeof row.sourceDigest!=='string'||!/^[a-f0-9]{64}$/.test(row.sourceDigest)||typeof row.confirmedAt!=='string'||new Date(row.confirmedAt).toISOString()!==row.confirmedAt||!Array.isArray(row.materials)||row.materials.length>groupReferenceMaxFiles)throw Error()
  const materials=row.materials.map(value=>{const item=taskInput(value,['id','version','sha256']);if(!uuid(item.id)||!version(item.version)||typeof item.sha256!=='string'||!/^[a-f0-9]{64}$/.test(item.sha256))throw Error();return {id:item.id,version:item.version,sha256:item.sha256}})
  if(new Set(materials.map(item=>item.id)).size!==materials.length)throw Error()
  return {schema:row.schema,kind:row.kind,approvalId:row.approvalId,ownerId:row.ownerId,taskId:row.taskId,taskVersion:row.taskVersion,roleId:row.roleId,roleVersion:row.roleVersion,groupId:row.groupId,groupVersion:row.groupVersion,sourceMessageId:row.sourceMessageId,sourceDigest:row.sourceDigest,materials,confirmedAt:row.confirmedAt}
 }catch{throw new WorkError('teloa/invalid-input','受限文本工作能力的身份、版本或固定资料不完整。')}
}

import {WorkError} from './work-error.ts'
import {readWorkLineage,type WorkLineage} from './work-lineage.ts'

/** 冻结作者只来自 Run 输入；不公开其私有知识或本人执行回执。 */
export type GroupRunSource={schema:'teloa.group-run-source/v2';ownerId:string;taskId:string;runId:string;roleId:string;roleVersion:number;roleKind:'employee'|'twin';roleName:string;lineage:WorkLineage}
export type GroupDispatchItem={id:string;ownerId:string;groupId:string;messageId:string;decisionVersion:number;roleId:string;roleVersion:number;requestId:string;state:'pending'|'leased'|'submitted'|'unknown'|'settled'|'blocked';taskId:string|null;runId:string|null;lineage:WorkLineage|null;attempts:number;nextAttemptAt:string|null;leaseGeneration:number}
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v)
const integer=(v:unknown,min:number):v is number=>Number.isSafeInteger(v)&&Number(v)>=min
const owner=(v:unknown):v is string=>typeof v==='string'&&!!v.trim()&&v.length<=128
const row=(v:unknown,keys:string[]):Record<string,unknown>=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length!==keys.length||Object.keys(v).some(k=>!keys.includes(k)))throw Error();return v as Record<string,unknown>}
const corrupt=()=>new WorkError('teloa/storage-corrupt','群派工或运行来源记录损坏，已停止读取。')
export function readGroupRunSource(v:unknown):GroupRunSource{
 try{const r=row(v,['schema','ownerId','taskId','runId','roleId','roleVersion','roleKind','roleName','lineage']);if(r.schema!=='teloa.group-run-source/v2'||!owner(r.ownerId)||!uuid(r.taskId)||!uuid(r.runId)||!uuid(r.roleId)||!integer(r.roleVersion,1)||!['employee','twin'].includes(String(r.roleKind))||typeof r.roleName!=='string'||!r.roleName.trim()||r.roleName.length>80)throw Error();const lineage=readWorkLineage(r.lineage);if(lineage.ownerId!==r.ownerId)throw Error();return {schema:'teloa.group-run-source/v2',ownerId:r.ownerId,taskId:r.taskId,runId:r.runId,roleId:r.roleId,roleVersion:r.roleVersion,roleKind:r.roleKind as 'employee'|'twin',roleName:r.roleName,lineage}}catch{throw corrupt()}
}
export function readGroupDispatchItem(v:unknown):GroupDispatchItem{
 try{const r=row(v,['id','ownerId','groupId','messageId','decisionVersion','roleId','roleVersion','requestId','state','taskId','runId','lineage','attempts','nextAttemptAt','leaseGeneration']);if(![r.id,r.groupId,r.messageId,r.roleId,r.requestId].every(uuid)||!owner(r.ownerId)||!integer(r.decisionVersion,1)||!integer(r.roleVersion,1)||!integer(r.attempts,0)||!integer(r.leaseGeneration,0)||!['pending','leased','submitted','unknown','settled','blocked'].includes(String(r.state))||r.taskId!==null&&!uuid(r.taskId)||r.runId!==null&&!uuid(r.runId)||r.runId!==null&&r.taskId===null||r.nextAttemptAt!==null&&(typeof r.nextAttemptAt!=='string'||!Number.isFinite(Date.parse(r.nextAttemptAt))))throw Error();const lineage=r.lineage===null?null:readWorkLineage(r.lineage);if(lineage&&lineage.ownerId!==r.ownerId)throw Error();return {...r,lineage} as GroupDispatchItem}catch{throw corrupt()}
}

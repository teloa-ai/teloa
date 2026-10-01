import {WorkError} from './work-error.ts'
import {taskInput} from './tasks.ts'
import {isBusinessScopeKey} from './business-scopes.ts'
import {businessObjectReference,type BusinessObjectReference} from './business-data.ts'

export type BusinessReassignmentSelection={
 oldRequestId:string;newRoleId:string;expectedNewRoleVersion:number
}
export type BusinessReassignmentInstruction={
 requestId:string;sessionId:string;messageId:string;
 messageSeq:number;sourceText:string;
 selection:BusinessReassignmentSelection
}
export type BusinessReassignmentSnapshot={
 instruction:BusinessReassignmentInstruction;
 oldSessionId:string;scope:string;
 oldContext:{version:number;roleId:string|null};
 newContext:{version:number;roleId:string|null};
 oldTarget:{roleId:string;roleVersion:number;name:string};
 oldRoleCurrent:{version:number;state:'active'|'paused'|'retired'}|null;
 newTarget:{roleId:string;roleVersion:number;name:string};
 /** null 表示无负责人管理配置；已管理但未设负责人保留 version=0、roleId=null。 */
 responsibility:{version:number;roleId:string|null}|null;
 title:string;goal:string;sourceText?:string;
 reference?:BusinessObjectReference;
 snapshotHash:string
}
export type BusinessReassignmentReceipt={
 oldRequestId:string;newRequestId:string;
 oldSessionId:string;newSessionId:string;
 scope:string;snapshotHash:string;createdAt:string
}

const invalid=():never=>{throw new WorkError('teloa/invalid-input','业务改派的身份、版本或快照格式不正确。')}
const version=(value:unknown,min=1):value is number=>Number.isSafeInteger(value)&&Number(value)>=min&&Number(value)<=2147483647
function uuid(value:unknown):string{
 if(typeof value!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value))return invalid()
 return value.toLowerCase()
}
function session(value:unknown):string{
 if(typeof value!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(value))return invalid()
 return value
}
function text(value:unknown,max:number):string{
 if(typeof value!=='string'||!value.trim()||value.length>max)return invalid()
 return value
}
function scope(value:unknown):string{
 if(!isBusinessScopeKey(value)||value==='general')return invalid()
 return value
}
function hash(value:unknown):string{
 if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))return invalid()
 return value
}
function context(value:unknown):BusinessReassignmentSnapshot['oldContext']{
 const row=taskInput(value,['version','roleId'])
 if(!version(row.version))return invalid()
 return {version:row.version,roleId:row.roleId===null?null:uuid(row.roleId)}
}
function target(value:unknown):BusinessReassignmentSnapshot['oldTarget']{
 const row=taskInput(value,['roleId','roleVersion','name'])
 if(!version(row.roleVersion))return invalid()
 return {roleId:uuid(row.roleId),roleVersion:row.roleVersion,name:text(row.name,120).trim()}
}
function currentRole(value:unknown):BusinessReassignmentSnapshot['oldRoleCurrent']{
 if(value===null)return null
 const row=taskInput(value,['version','state'])
 if(!version(row.version)||(row.state!=='active'&&row.state!=='paused'&&row.state!=='retired'))return invalid()
 return {version:row.version,state:row.state}
}
function responsibility(value:unknown):BusinessReassignmentSnapshot['responsibility']{
 if(value===null)return null
 const row=taskInput(value,['version','roleId'])
 if(!version(row.version,0)||row.version===0&&row.roleId!==null)return invalid()
 return {version:row.version,roleId:row.roleId===null?null:uuid(row.roleId)}
}

export function readBusinessReassignmentSelection(input:unknown):BusinessReassignmentSelection{
 const row=taskInput(input,['oldRequestId','newRoleId','expectedNewRoleVersion'])
 if(!version(row.expectedNewRoleVersion))return invalid()
 return {oldRequestId:uuid(row.oldRequestId),newRoleId:uuid(row.newRoleId),expectedNewRoleVersion:row.expectedNewRoleVersion}
}
export function readBusinessReassignmentInstruction(input:unknown):BusinessReassignmentInstruction{
 const row=taskInput(input,['requestId','sessionId','messageId','messageSeq','sourceText','selection'])
 const requestId=uuid(row.requestId),selection=readBusinessReassignmentSelection(row.selection)
 if(requestId===selection.oldRequestId||!Number.isSafeInteger(row.messageSeq)||Number(row.messageSeq)<0)return invalid()
 return {requestId,sessionId:session(row.sessionId),messageId:text(row.messageId,200),messageSeq:Number(row.messageSeq),sourceText:text(row.sourceText,7400),selection}
}

const snapshotKeys=['instruction','oldSessionId','scope','oldContext','newContext','oldTarget','oldRoleCurrent','newTarget','responsibility','title','goal','sourceText','reference'] as const
/** 审批身份与原请求材料分别保留；这里仅校验协议，当前授权和角色可用性由服务端核对。 */
function snapshotBody(input:unknown):Omit<BusinessReassignmentSnapshot,'snapshotHash'>{
 const row=taskInput(input,snapshotKeys)
 const instruction=readBusinessReassignmentInstruction(row.instruction),businessScope=scope(row.scope)
 const oldTarget=target(row.oldTarget),newTarget=target(row.newTarget)
 if(newTarget.roleId!==instruction.selection.newRoleId||newTarget.roleVersion!==instruction.selection.expectedNewRoleVersion)return invalid()
 const title=text(row.title,120).trim(),goal=text(row.goal,8000).trim()
 const sourceText=row.sourceText===undefined?undefined:text(row.sourceText,7400)
 if(sourceText!==undefined&&sourceText.length+goal.length>7400)return invalid()
 const reference=row.reference===undefined?undefined:businessObjectReference(row.reference)
 if(reference!==undefined&&reference.scope!==businessScope)return invalid()
 return {
  instruction,oldSessionId:session(row.oldSessionId),scope:businessScope,
  oldContext:context(row.oldContext),newContext:context(row.newContext),
  oldTarget,oldRoleCurrent:currentRole(row.oldRoleCurrent),newTarget,
  responsibility:responsibility(row.responsibility),title,goal,
  ...(sourceText===undefined?{}:{sourceText}),...(reference===undefined?{}:{reference}),
 }
}
export function readBusinessReassignmentSnapshot(input:unknown):BusinessReassignmentSnapshot{
 const row=taskInput(input,[...snapshotKeys,'snapshotHash'])
 const {snapshotHash,...body}=row
 return {...snapshotBody(body),snapshotHash:hash(snapshotHash)}
}
export function readBusinessReassignmentReceipt(input:unknown):BusinessReassignmentReceipt{
 const row=taskInput(input,['oldRequestId','newRequestId','oldSessionId','newSessionId','scope','snapshotHash','createdAt'])
 const oldRequestId=uuid(row.oldRequestId),newRequestId=uuid(row.newRequestId),createdAt=row.createdAt
 if(oldRequestId===newRequestId||typeof createdAt!=='string'||!Number.isFinite(Date.parse(createdAt))||new Date(createdAt).toISOString()!==createdAt)return invalid()
 return {oldRequestId,newRequestId,oldSessionId:session(row.oldSessionId),newSessionId:session(row.newSessionId),scope:scope(row.scope),snapshotHash:hash(row.snapshotHash),createdAt}
}
/** 按声明顺序重建每层对象；后端单处计算 SHA256，浏览器仅消费摘要。 */
export function canonicalBusinessReassignmentSnapshot(input:Omit<BusinessReassignmentSnapshot,'snapshotHash'>):string{
 return JSON.stringify(snapshotBody(input))
}

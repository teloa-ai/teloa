import {isRoleMemory,roleMemorySource,roleMemoryVisibility,type RoleMemory,type RoleMemorySource,type RoleMemoryVisibility} from '@teloa/contract'
import {recoveryStorageError} from './recovery-error.ts'

type Call=(endpoint:string,payload:unknown)=>Promise<unknown>
type Journal={read:()=>string|null;write:(value:string)=>void;clear:()=>void}
type CreateInput={roleId:string;expectedRoleVersion:number;title:string;markdown:string;source:RoleMemorySource;visibility:RoleMemoryVisibility}
type Pending={endpoint:'role-memory/create';payload:{requestId:string}&CreateInput}|{endpoint:'role-memory/confirm'|'role-memory/withdraw';payload:{requestId:string;memoryId:string;expectedStateVersion:number}}
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
const positive=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>0
const maxMarkdownBytes=128*1024,maxJournalCharacters=1024*1024
const object=(value:unknown,keys:readonly string[])=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))throw Error('员工记忆请求格式不正确。');return value as Record<string,unknown>}
const deterministic=(error:unknown)=>!!error&&typeof error==='object'&&'rejected' in error&&error.rejected===true&&'code' in error&&['teloa/invalid-input','teloa/forbidden','teloa/conflict','teloa/version-conflict'].includes(String(error.code))
function readMemory(value:unknown){if(!isRoleMemory(value))throw Error('员工记忆服务响应格式不正确。');return value}
function readPending(value:unknown):Pending{
 const row=object(value,['endpoint','payload']),endpoint=row.endpoint
 if(!['role-memory/create','role-memory/confirm','role-memory/withdraw'].includes(String(endpoint)))throw Error()
 const payload=endpoint==='role-memory/create'?object(row.payload,['requestId','roleId','expectedRoleVersion','title','markdown','source','visibility']):object(row.payload,['requestId','memoryId','expectedStateVersion'])
 if(!uuid(payload.requestId))throw Error()
 if(endpoint==='role-memory/create'){
  if(!uuid(payload.roleId)||!positive(payload.expectedRoleVersion)||typeof payload.title!=='string'||!payload.title.trim()||payload.title.length>120||typeof payload.markdown!=='string')throw Error()
  const markdown=payload.markdown.replace(/^\ufeff/,'').replace(/\r\n?/g,'\n')
  if(!markdown.trim()||new TextEncoder().encode(markdown).byteLength>maxMarkdownBytes)throw Error()
  return {endpoint,payload:{requestId:payload.requestId,roleId:payload.roleId,expectedRoleVersion:payload.expectedRoleVersion,title:payload.title.trim(),markdown,source:roleMemorySource(payload.source),visibility:roleMemoryVisibility(payload.visibility)}}
 }
 if(!uuid(payload.memoryId)||!positive(payload.expectedStateVersion))throw Error()
 return {endpoint:endpoint as 'role-memory/confirm'|'role-memory/withdraw',payload:{requestId:payload.requestId,memoryId:payload.memoryId,expectedStateVersion:payload.expectedStateVersion}}
}

export type RoleMemoryApi=ReturnType<typeof createRoleMemoryApi>
export function createRoleMemoryApi(call:Call,journal?:Journal,newId=()=>crypto.randomUUID()){
 let pending:Pending|undefined,recoveryError:ReturnType<typeof recoveryStorageError>|undefined,busy=false
 try{const raw=journal?.read();if(raw){if(raw.length>maxJournalCharacters)throw Error();const row=object(JSON.parse(raw),['schema','operation']);if(row.schema!=='teloa.role-memory-command/v1')throw Error();pending=readPending(row.operation)}}catch{recoveryError=recoveryStorageError()}
 const send=async()=>{
  if(recoveryError)throw recoveryError;if(busy)throw Error('员工记忆请求正在核对。');if(!pending)throw Error('没有待核对的员工记忆请求。')
  busy=true
  try{
   journal?.write(JSON.stringify({schema:'teloa.role-memory-command/v1',operation:pending}))
   const result=readMemory(await call(pending.endpoint,pending.payload)),request=pending
   if(request.endpoint==='role-memory/create'){
    const input=request.payload
    if(result.roleId!==input.roleId||result.roleVersion!==input.expectedRoleVersion||result.state!=='candidate'||result.stateVersion!==1||result.title!==input.title||result.content.version!==1||result.content.markdown!==input.markdown||JSON.stringify(result.source)!==JSON.stringify(input.source)||JSON.stringify(result.visibility)!==JSON.stringify(input.visibility))throw Error('员工记忆创建响应与原请求不一致，请刷新核对。')
   }else{
    const state=request.endpoint==='role-memory/confirm'?'confirmed':'withdrawn'
    if(result.id!==request.payload.memoryId||result.state!==state||result.stateVersion!==request.payload.expectedStateVersion+1)throw Error('员工记忆状态响应与原请求不一致，请刷新核对。')
   }
   journal?.clear();pending=undefined;return result
  }catch(error){if(deterministic(error)){journal?.clear();pending=undefined}throw error}finally{busy=false}
 }
 const begin=async(operation:Pending)=>{if(recoveryError)throw recoveryError;if(pending&&JSON.stringify(pending)!==JSON.stringify(operation))throw Error('请先核对原员工记忆请求，再执行其他操作。');pending??=operation;return send()}
 return {
  pending:()=>pending?structuredClone(pending):undefined,recoveryMessage:()=>recoveryError,
  /** 丢弃只清本地恢复记录，不通知服务端（规格 §二 D4）。 */
  discard(){const had=pending!==undefined||recoveryError!==undefined;try{journal?.clear()}catch{/* 清不掉不该变成第二道墙 */}pending=undefined;recoveryError=undefined;return had},
  recover:send,
  async list(roleId:string){if(!uuid(roleId))throw Error('员工身份不正确。');const value=await call('role-memory/list',{roleId});if(!Array.isArray(value))throw Error('员工记忆目录格式不正确。');const rows=value.map(readMemory),owners=new Set(rows.map(row=>row.ownerId));if(rows.some(row=>row.roleId!==roleId)||owners.size>1||new Set(rows.map(row=>row.id)).size!==rows.length)throw Error('员工记忆目录的员工、本人或身份不一致。');return rows},
  create(input:CreateInput){const normalized=readPending({endpoint:'role-memory/create',payload:{requestId:newId(),...input}});return begin(normalized)},
  confirm(memoryId:string,expectedStateVersion:number){return begin(readPending({endpoint:'role-memory/confirm',payload:{requestId:newId(),memoryId,expectedStateVersion}}))},
  withdraw(memoryId:string,expectedStateVersion:number){return begin(readPending({endpoint:'role-memory/withdraw',payload:{requestId:newId(),memoryId,expectedStateVersion}}))},
 }
}

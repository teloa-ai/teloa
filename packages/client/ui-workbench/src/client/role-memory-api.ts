import {isRoleMemory,roleMemorySource,roleMemoryVisibility,type RoleMemory,type RoleMemorySource,type RoleMemoryVisibility} from '@teloa/contract'
import {recoveryStorageError} from './recovery-error.ts'

type Call=(endpoint:string,payload:unknown)=>Promise<unknown>
type Journal={read:()=>string|null;write:(value:string)=>void;clear:()=>void}
type CreateInput={roleId:string;expectedRoleVersion:number;title:string;markdown:string;source:RoleMemorySource;visibility:RoleMemoryVisibility}
type EditFields={title:string;markdown:string}
export type RoleMemoryEditDraft={target:RoleMemory;value:EditFields}
type EditPayload={requestId:string;roleId:string;memoryId:string;expectedContentVersion:number;expectedContentHash:string;expectedStateVersion:number}&EditFields
type Pending={endpoint:'role-memory/create';payload:{requestId:string}&CreateInput}|{endpoint:'role-memory/confirm'|'role-memory/withdraw';payload:{requestId:string;memoryId:string;expectedStateVersion:number}}|{endpoint:'role-memory/edit';payload:EditPayload;target:RoleMemory}
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
const positive=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>0
const maxMarkdownBytes=128*1024,maxJournalCharacters=3*1024*1024
const object=(value:unknown,keys:readonly string[])=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))throw Error('员工记忆请求格式不正确。');return value as Record<string,unknown>}
const deterministic=(error:unknown)=>!!error&&typeof error==='object'&&'rejected' in error&&error.rejected===true&&'code' in error&&['teloa/invalid-input','teloa/forbidden','teloa/conflict','teloa/version-conflict'].includes(String(error.code))
const canonical=(value:unknown):string=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item)
function readMemory(value:unknown){if(!isRoleMemory(value))throw Error('员工记忆服务响应格式不正确。');return value}
function readPending(value:unknown):Pending{
 const row=object(value,['endpoint','payload','target']),endpoint=row.endpoint
 if(endpoint==='role-memory/edit'){
  const payload=object(row.payload,['requestId','roleId','memoryId','expectedContentVersion','expectedContentHash','expectedStateVersion','title','markdown']),target=readMemory(row.target)
  if(!uuid(payload.requestId)||payload.roleId!==target.roleId||payload.memoryId!==target.id||payload.expectedContentVersion!==target.content.version||payload.expectedContentHash!==target.content.contentHash||payload.expectedStateVersion!==target.stateVersion||target.state==='withdrawn')throw Error('员工记忆编辑目标不一致。')
  const fields=editFields(payload)
  return {endpoint,payload:{requestId:payload.requestId,roleId:target.roleId,memoryId:target.id,expectedContentVersion:target.content.version,expectedContentHash:target.content.contentHash,expectedStateVersion:target.stateVersion,...fields},target}
 }
 if(!['role-memory/create','role-memory/confirm','role-memory/withdraw'].includes(String(endpoint))||Object.hasOwn(row,'target'))throw Error()
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
function editFields(value:Record<string,unknown>):EditFields{
 if(typeof value.title!=='string'||!value.title.trim()||value.title.trim().length>120||typeof value.markdown!=='string')throw Error('员工记忆正文格式不正确。')
 const markdown=value.markdown.replace(/^\ufeff/,'').replace(/\r\n?/g,'\n')
 if(!markdown.trim()||new TextEncoder().encode(markdown).byteLength>maxMarkdownBytes)throw Error('员工记忆正文格式不正确。')
 return {title:value.title.trim(),markdown}
}
function matchesEdit(result:RoleMemory,request:Extract<Pending,{endpoint:'role-memory/edit'}>){
 const target=request.target
 return result.id===target.id&&result.ownerId===target.ownerId&&result.roleId===target.roleId&&result.roleVersion===target.roleVersion&&result.state===target.state&&result.stateVersion===target.stateVersion+1&&result.title===request.payload.title&&result.content.version===target.content.version+1&&result.content.editedBy==='self'&&result.content.markdown===request.payload.markdown&&result.candidateAt===target.candidateAt&&result.confirmedAt===target.confirmedAt&&result.withdrawnAt===target.withdrawnAt&&canonical(result.source)===canonical(target.source)&&result.sourceTitle===target.sourceTitle&&canonical(result.visibility)===canonical(target.visibility)&&canonical(result.proposedBy)===canonical(target.proposedBy)
}

export type RoleMemoryApi=ReturnType<typeof createRoleMemoryApi>
export function createRoleMemoryApi(call:Call,journal?:Journal,newId=()=>crypto.randomUUID(),draftJournal?:Journal){
 let pending:Pending|undefined,recoveryError:ReturnType<typeof recoveryStorageError>|undefined,busy=false
 let flight:Promise<RoleMemory>|undefined
 const drafts=new Map<string,RoleMemoryEditDraft>()
 let draftError:unknown,draftCorrupt=false
 try{const raw=draftJournal?.read();if(raw){if(raw.length>16*1024*1024)throw Error();const row=object(JSON.parse(raw),['schema','drafts']);if(row.schema!=='teloa.role-memory-edit-drafts/v1'||!Array.isArray(row.drafts)||row.drafts.length>100)throw Error();for(const value of row.drafts){const item=object(value,['target','value']),target=readMemory(item.target),fields=object(item.value,['title','markdown']);if(typeof fields.title!=='string'||fields.title.length>120||typeof fields.markdown!=='string'||new TextEncoder().encode(fields.markdown).byteLength>maxMarkdownBytes||drafts.has(target.id))throw Error();drafts.set(target.id,{target,value:fields as EditFields})}}}catch{draftError=recoveryStorageError();draftCorrupt=true}
 const persistDrafts=()=>{try{if(draftCorrupt)throw draftError;draftJournal?.write(JSON.stringify({schema:'teloa.role-memory-edit-drafts/v1',drafts:[...drafts.values()]}));draftError=undefined}catch(error){draftError=error;throw error}}
 try{const raw=journal?.read();if(raw){if(raw.length>maxJournalCharacters)throw Error();const row=object(JSON.parse(raw),['schema','operation']);if(row.schema!=='teloa.role-memory-command/v1')throw Error();pending=readPending(row.operation)}}catch{recoveryError=recoveryStorageError()}
 const send=async()=>{
  if(recoveryError)throw recoveryError;if(busy)throw Error('员工记忆请求正在核对。');if(!pending)throw Error('没有待核对的员工记忆请求。')
  const request=pending
  busy=true
  try{
   journal?.write(JSON.stringify({schema:'teloa.role-memory-command/v1',operation:request}))
   const result=readMemory(await call(request.endpoint,request.payload))
   if(request.endpoint==='role-memory/create'){
    const input=request.payload
    if(result.roleId!==input.roleId||result.roleVersion!==input.expectedRoleVersion||result.state!=='candidate'||result.stateVersion!==1||result.title!==input.title||result.content.version!==1||result.content.markdown!==input.markdown||JSON.stringify(result.source)!==JSON.stringify(input.source)||JSON.stringify(result.visibility)!==JSON.stringify(input.visibility))throw Error('员工记忆创建响应与原请求不一致，请刷新核对。')
   }else if(request.endpoint==='role-memory/edit'){
    if(!matchesEdit(result,request))throw Error('员工记忆编辑响应与原请求或来源身份不一致，请核对原请求。')
   }else{
    const state=request.endpoint==='role-memory/confirm'?'confirmed':'withdrawn'
    if(result.id!==request.payload.memoryId||result.state!==state||result.stateVersion!==request.payload.expectedStateVersion+1)throw Error('员工记忆状态响应与原请求不一致，请刷新核对。')
   }
   journal?.clear();pending=undefined
   if(request.endpoint==='role-memory/edit'){
    const draft=drafts.get(request.target.id)
    if(draft&&draft.target.content.version===request.target.content.version&&draft.value.title.trim()===request.payload.title&&draft.value.markdown.replace(/^\ufeff/,'').replace(/\r\n?/g,'\n')===request.payload.markdown){drafts.delete(request.target.id);try{persistDrafts()}catch{/* 回执已核对；存储失败不把成功变成未知写入。 */}}
   }
   return result
  }catch(error){if(deterministic(error)){journal?.clear();pending=undefined}throw error}finally{busy=false}
 }
 const dispatch=()=>{if(flight)return flight;const promise=send();flight=promise;void promise.then(()=>{if(flight===promise)flight=undefined},()=>{if(flight===promise)flight=undefined});return promise}
 const begin=async(operation:Pending)=>{if(recoveryError)throw recoveryError;if(pending&&JSON.stringify(pending)!==JSON.stringify(operation))throw Error('请先核对原员工记忆请求，再执行其他操作。');pending??=operation;return dispatch()}
 return {
  pending:()=>pending?structuredClone(pending):undefined,recoveryMessage:()=>recoveryError,
  /** 编辑可能已经追加不可逆版本，必须先核对原请求；旧候选命令仍保留既有清日志语义。 */
  discard(){if(busy||pending?.endpoint==='role-memory/edit')throw Error('请先核对原请求，编辑结果尚未确认。');const had=pending!==undefined||recoveryError!==undefined;try{journal?.clear()}catch{/* 清不掉不该变成第二道墙 */}pending=undefined;recoveryError=undefined;return had},
  recover:dispatch,
  inFlight:()=>flight,
  busy:()=>busy,
  draftError:()=>draftError,
  editDraft(memory:RoleMemory){const target=readMemory(memory),saved=drafts.get(target.id);if(saved){if(saved.target.ownerId!==target.ownerId||saved.target.roleId!==target.roleId)throw Error('员工记忆草稿归属不一致。');return structuredClone(saved)}if(draftError)throw draftError;const draft={target:structuredClone(target),value:{title:target.title,markdown:target.content.markdown}};drafts.set(target.id,draft);persistDrafts();return structuredClone(draft)},
  updateEditDraft(memoryId:string,value:EditFields){const saved=drafts.get(memoryId);if(!saved||typeof value.title!=='string'||value.title.length>120||typeof value.markdown!=='string'||new TextEncoder().encode(value.markdown).byteLength>maxMarkdownBytes)throw Error('员工记忆编辑草稿不正确。');saved.value={...value};persistDrafts()},
  discardEditDraft(memoryId:string){if(pending)throw Error('请先核对原员工记忆请求。');drafts.delete(memoryId);persistDrafts()},
  async readVersion(target:RoleMemory,version:number){if(!positive(version))throw Error('员工记忆版本不正确。');const result=readMemory(await call('role-memory/read-version',{roleId:target.roleId,memoryId:target.id,version}));if(result.id!==target.id||result.ownerId!==target.ownerId||result.roleId!==target.roleId||result.content.version!==version||canonical(result.source)!==canonical(target.source)||canonical(result.proposedBy)!==canonical(target.proposedBy)||canonical(result.visibility)!==canonical(target.visibility))throw Error('员工记忆历史响应与原来源身份不一致。');return result},
  async list(roleId:string){if(!uuid(roleId))throw Error('员工身份不正确。');const value=await call('role-memory/list',{roleId});if(!Array.isArray(value))throw Error('员工记忆目录格式不正确。');const rows=value.map(readMemory),owners=new Set(rows.map(row=>row.ownerId));if(rows.some(row=>row.roleId!==roleId)||owners.size>1||new Set(rows.map(row=>row.id)).size!==rows.length)throw Error('员工记忆目录的员工、本人或身份不一致。');return rows},
  create(input:CreateInput){const normalized=readPending({endpoint:'role-memory/create',payload:{requestId:newId(),...input}});return begin(normalized)},
  edit(target:RoleMemory,value:EditFields){return begin(readPending({endpoint:'role-memory/edit',target,payload:{requestId:newId(),roleId:target.roleId,memoryId:target.id,expectedContentVersion:target.content.version,expectedContentHash:target.content.contentHash,expectedStateVersion:target.stateVersion,...value}}))},
  confirm(memoryId:string,expectedStateVersion:number){return begin(readPending({endpoint:'role-memory/confirm',payload:{requestId:newId(),memoryId,expectedStateVersion}}))},
  withdraw(memoryId:string,expectedStateVersion:number){return begin(readPending({endpoint:'role-memory/withdraw',payload:{requestId:newId(),memoryId,expectedStateVersion}}))},
 }
}

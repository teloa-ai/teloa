import {isRecord,isResourceAdoptionInput,isResourceDraft,isWorkResource,resourceId,WorkError,type ResourceAdoptionInput,type ResourceDraft,type WorkResource} from '@teloa/contract'
import type {WorkbenchNavigationStorage} from './workbench-navigation-state.js'
import {recoveryStorageError} from './recovery-error.ts'
import {isAdoptedMaterialSourceId} from './local-material-registration.ts'

type Identity={ownerId:string;spaceId:string}
type Ports={prepareAdoption:(input:ResourceAdoptionInput)=>Promise<ResourceDraft[]>;apply:(draft:ResourceDraft)=>Promise<WorkResource>;directory:()=>Promise<{resources:WorkResource[]}>}
export type ResourceAdoptionCommand={schema:'teloa.resource-adoption/v1';ownerId:string;spaceId:string;input:ResourceAdoptionInput;resources:WorkResource[];drafts?:ResourceDraft[];applied:WorkResource[]}
const bad=()=>new WorkError('teloa/invalid-host-response','资料采用恢复记录或回执与原请求不一致。')
const conflict=()=>new WorkError('teloa/conflict','请先恢复原资料采用请求，核对后再发起另一组采用。')
const sameScope=(scopes:readonly string[],scope:string)=>scopes.length===1&&scopes[0]===scope
const sameResource=(resource:WorkResource,draft:ResourceDraft)=>resource.ownerId===draft.ownerId&&resource.title===draft.title&&resource.sourceId===draft.sourceId&&resource.sourceVersion===draft.sourceVersion&&JSON.stringify(resource.scopeIds)===JSON.stringify(draft.scopeIds)
const exact=(value:Record<string,unknown>,keys:string[])=>Object.keys(value).every(key=>keys.includes(key))
const resourceKeys=['id','ownerId','title','sourceId','sourceVersion','scopeIds','version','status','createdAt','updatedAt']
export function resourceAdoptionJournalKey(identity:Identity):string{
 if(!identity.ownerId||identity.ownerId.length>128||!/^[a-zA-Z0-9_-]{1,128}$/.test(identity.spaceId))throw bad()
 return 'teloa.resource-adoption/v1/'+encodeURIComponent(identity.ownerId)+'/'+encodeURIComponent(identity.spaceId)
}
/** 原固定版本快照独立留底；存储按浏览器同源、本人、个人空间（原生另有安装命名空间）隔离。 */
export function createResourceAdoptionRecovery(ports:Ports,identity:Identity,storage?:WorkbenchNavigationStorage,newId:()=>string=()=>crypto.randomUUID()){
 const key=resourceAdoptionJournalKey(identity)
 let pending:ResourceAdoptionCommand|undefined,error:ReturnType<typeof recoveryStorageError>|undefined,busy=false
 const parse=(raw:string):ResourceAdoptionCommand=>{
  if(raw.length>256*1024)throw bad()
  const row:unknown=JSON.parse(raw)
  if(!isRecord(row)||!exact(row,['schema','ownerId','spaceId','input','resources','drafts','applied'])||row.schema!=='teloa.resource-adoption/v1'||row.ownerId!==identity.ownerId||row.spaceId!==identity.spaceId||!isResourceAdoptionInput(row.input)||!Array.isArray(row.resources)||row.resources.length!==row.input.resources.length||!row.resources.every(resource=>isRecord(resource)&&isWorkResource(resource)&&exact(resource,resourceKeys)&&resource.ownerId===identity.ownerId&&resource.status==='active')||!Array.isArray(row.applied))throw bad()
  const resources=row.resources as WorkResource[],input=row.input
  if(new Set(resources.map(resource=>resource.id.toLowerCase())).size!==resources.length||input.resources.some(ref=>!resources.some(resource=>resource.id.toLowerCase()===ref.id.toLowerCase()&&resource.version===ref.version&&resource.sourceVersion===ref.sourceVersion)))throw bad()
  if(row.drafts!==undefined&&(!Array.isArray(row.drafts)||row.drafts.length!==resources.length||!row.drafts.every(draft=>isRecord(draft)&&isResourceDraft(draft)&&exact(draft,[...resourceKeys,'requestId','resourceId'])&&draft.ownerId===identity.ownerId&&isAdoptedMaterialSourceId(draft.sourceId)&&sameScope(draft.scopeIds,input.targetScope))||new Set(row.drafts.map(draft=>draft.id)).size!==resources.length||new Set(row.drafts.map(draft=>draft.sourceId)).size!==resources.length))throw bad()
  const drafts=row.drafts as ResourceDraft[]|undefined,applied=row.applied
  if(drafts&&JSON.stringify(drafts.map(draft=>draft.sourceVersion).sort())!==JSON.stringify(input.resources.map(ref=>ref.sourceVersion).sort()))throw bad()
  if(applied.length>(drafts?.length??0)||!applied.every(resource=>isRecord(resource)&&isWorkResource(resource)&&exact(resource,resourceKeys)&&drafts?.some(draft=>sameResource(resource,draft)))||new Set(applied.map(resource=>resource.id)).size!==applied.length||new Set(applied.map(resource=>resource.sourceId)).size!==applied.length)throw bad()
  return row as ResourceAdoptionCommand
 }
 const load=()=>{if(!storage)return;try{const raw=storage.getItem(key);pending=raw===null?undefined:parse(raw);error=undefined}catch{pending=undefined;error=recoveryStorageError()}}
 const persist=(next:ResourceAdoptionCommand)=>{const raw=JSON.stringify(next);parse(raw);try{storage?.setItem(key,raw)}catch{throw new WorkError('teloa/storage-unavailable','资料采用恢复记录未能保存；本次尚未继续发送。')};pending=next;error=undefined}
 const assertCurrent=(command:ResourceAdoptionCommand)=>{
  if(storage){let current:ResourceAdoptionCommand;try{const raw=storage.getItem(key);if(raw===null)throw conflict();current=parse(raw)}catch(cause){if(cause instanceof WorkError)throw cause;throw recoveryStorageError()};if(current.input.requestId!==command.input.requestId||JSON.stringify(current.input)!==JSON.stringify(command.input))throw conflict();return current}
  if(pending?.input.requestId!==command.input.requestId)throw conflict()
  return pending
 }
 const clear=(command:ResourceAdoptionCommand)=>{assertCurrent(command);storage?.removeItem(key);pending=undefined;error=undefined}
 const checkedDrafts=(command:ResourceAdoptionCommand,drafts:ResourceDraft[])=>parse(JSON.stringify({...command,drafts,applied:[]}))
 const send=async()=>{
  load();if(error)throw error;if(!pending||busy)throw conflict();busy=true
  const command=pending
  try{
   if(command.drafts)return structuredClone(command)
   // 每次恢复仍先确保持久化可写，再向宿主发送同一请求身份。
   assertCurrent(command);persist(command)
   const drafts=await ports.prepareAdoption(structuredClone(command.input)),next=checkedDrafts(command,drafts)
   const current=assertCurrent(command)
   // 原窗口的迟到prepare不能把其他窗口已保存的采用进度倒退为空。
   if(current.drafts){pending=current;return structuredClone(current)}
   persist(next);return structuredClone(next)
  }catch(cause){
   if(isRecord(cause)&&cause.rejected===true&&['teloa/invalid-input','teloa/forbidden','teloa/conflict','teloa/version-conflict','teloa/source-unavailable'].includes(String(cause.code))){try{const current=assertCurrent(command);if(!current.drafts&&!current.applied.length)clear(current)}catch{/* 新请求、已确认草稿或存储故障不得被旧失败清理。 */}}
   throw cause
  }finally{busy=false}
 }
 load()
 return {
  pending(){load();return pending?structuredClone(pending):undefined},
  recoveryMessage(){load();return error},
  async begin(resources:WorkResource[],targetScope:string){
   load();if(error)throw error;if(pending||busy)throw conflict()
   const input:ResourceAdoptionInput={requestId:newId(),targetScope,resources:resources.map(({id,version,sourceVersion})=>({id,version,sourceVersion}))}
   const command=parse(JSON.stringify({schema:'teloa.resource-adoption/v1',...identity,input,resources,applied:[]}));persist(command);return send()
  },
  recover:send,
  async apply(onProgress?:(command:ResourceAdoptionCommand)=>void){
   load();if(error)throw error;if(!pending?.drafts||busy)throw conflict();busy=true
   let command=pending
   try{
    assertCurrent(command);persist(command)
    for(const draft of command.drafts!){
     command=assertCurrent(command)
     if(command.applied.some(resource=>resource.sourceId===draft.sourceId))continue
     assertCurrent(command)
     // 另一个窗口可能已单独采用该草稿；只读恢复其真实回执，不用新版草稿号重发旧apply。
     const resource=draft.status==='applied'?(await ports.directory()).resources.find(row=>row.id===draft.resourceId):await ports.apply(draft)
     if(!isWorkResource(resource)||!sameResource(resource,draft)||draft.status==='applied'&&!resourceId(draft.resourceId))throw bad()
     const current=assertCurrent(command);command={...current,applied:current.applied.some(row=>row.sourceId===resource.sourceId)?current.applied:[...current.applied,resource]};persist(command);onProgress?.(structuredClone(command))
    }
    clear(command);return structuredClone(command.applied)
   }finally{busy=false}
  },
  /** 损坏记录不可重放；只有本人明确清理此类记录。有效未知命令不能通过关闭表单丢弃。 */
  clearCorrupt(){load();if(!error||pending||busy)return false;storage?.removeItem(key);error=undefined;return true},
 }
}
export type ResourceAdoptionRecovery=ReturnType<typeof createResourceAdoptionRecovery>

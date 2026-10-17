import {WorkError,projectInput,projectUuid} from '@teloa/contract'
export type PersonalPreferenceSource={projectId:string;entryId:string;entryVersion:number;basisHash:string}
export type PersonalPreferenceEntry={id:string;version:number;topic:string;markdown:string;source?:PersonalPreferenceSource}
export type PersonalPreferences={version:number;entries:PersonalPreferenceEntry[]}
export type PersonalPreferenceDraft={expectedVersion:number;entryId:string|null;topic:string;markdown:string}
export type PersonalPreferenceAdoption={projectId:string;entryId:string;entryVersion:number;expectedPersonalVersion:number}
type Journal={read:()=>string|null;write:(value:string)=>void;clear:()=>void;discard?:(value:string|null)=>void}
type EditPending={endpoint:'save-personal'|'withdraw-personal';input:{requestId:string;expectedVersion:number;entryId:string|null;topic?:string;markdown?:string}}
type PublishPending={endpoint:'publish-personal';input:PersonalPreferenceAdoption&{requestId:string}}
type Pending=EditPending|PublishPending
const invalid=()=>new WorkError('teloa/invalid-host-response','个人偏好回执无法核对。')
const version=(value:unknown,min=0):value is number=>Number.isSafeInteger(value)&&Number(value)>=min
const content=(value:unknown,max:number,empty=false):value is string=>typeof value==='string'&&value.length<=max&&(empty||value.trim().length>0)&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)
const readDraft=(value:unknown):PersonalPreferenceDraft=>{const row=projectInput(value,['expectedVersion','entryId','topic','markdown']);if(!version(row.expectedVersion)||row.entryId!==null&&!projectUuid(row.entryId)||!content(row.topic,120,true)||!content(row.markdown,12000,true))throw invalid();return row as PersonalPreferenceDraft}
const readPending=(value:unknown):Pending=>{
 const row=projectInput(value,['endpoint','input'])
 if(row.endpoint==='publish-personal'){
  const input=projectInput(row.input,['requestId','projectId','entryId','entryVersion','expectedPersonalVersion'])
  if(!projectUuid(input.requestId)||!projectUuid(input.projectId)||!projectUuid(input.entryId)||!version(input.entryVersion,1)||!version(input.expectedPersonalVersion))throw invalid()
  return {endpoint:row.endpoint,input:input as PublishPending['input']}
 }
 if(row.endpoint!=='save-personal'&&row.endpoint!=='withdraw-personal')throw invalid()
 const input=projectInput(row.input,row.endpoint==='save-personal'?['requestId','expectedVersion','entryId','topic','markdown']:['requestId','expectedVersion','entryId'])
 if(!projectUuid(input.requestId)||!version(input.expectedVersion)||input.entryId!==null&&!projectUuid(input.entryId)||row.endpoint==='withdraw-personal'&&input.entryId===null||row.endpoint==='save-personal'&&(!content(input.topic,120)||!content(input.markdown,12000)))throw invalid()
 return {endpoint:row.endpoint,input:input as EditPending['input']}
}
const readPersonal=(value:unknown):PersonalPreferences=>{const row=projectInput(value,['version','entries']);if(!version(row.version)||!Array.isArray(row.entries)||row.entries.length>100)throw invalid();const entries=row.entries.map(value=>{
 const entry=projectInput(value,['id','version','topic','markdown','source'])
 if(!projectUuid(entry.id)||!version(entry.version,1)||!content(entry.topic,120)||!content(entry.markdown,12000))throw invalid()
 if(entry.source!==undefined){const source=projectInput(entry.source,['projectId','entryId','entryVersion','basisHash']);if(!projectUuid(source.projectId)||!projectUuid(source.entryId)||!version(source.entryVersion,1)||typeof source.basisHash!=='string'||!/^[a-f0-9]{64}$/.test(source.basisHash))throw invalid()}
 return entry as PersonalPreferenceEntry
});if(new Set(entries.map(entry=>entry.id)).size!==entries.length)throw invalid();return {version:row.version,entries}}
export function createPersonalPreferenceApi(call:(endpoint:string,input:unknown)=>Promise<unknown>,journal?:Journal){
 let pending:Pending|undefined,draft:PersonalPreferenceDraft|undefined,recoveryError:unknown,busy=false
 const sync=()=>{if(!journal)return;try{const raw=journal.read(),row=projectInput(raw?JSON.parse(raw):{pending:null,draft:null},['pending','draft']);pending=row.pending===null?undefined:readPending(row.pending);draft=row.draft===null?undefined:readDraft(row.draft);recoveryError=undefined}catch(error){recoveryError=error}}
 const update=(change:()=>void)=>{sync();if(recoveryError)throw new WorkError('teloa/storage-corrupt','个人偏好草稿恢复记录不可读。');change();if(!pending&&!draft)journal?.clear();else journal?.write(JSON.stringify({pending:pending??null,draft:draft??null}))}
 const run=async(request:Pending)=>{
  if(busy)throw new WorkError('teloa/conflict','个人偏好仍在保存。');busy=true
  try{const expectedVersion=request.endpoint==='publish-personal'?request.input.expectedPersonalVersion:request.input.expectedVersion,result=readPersonal(await call('project-runtime/'+request.endpoint,request.input));if(result.version<expectedVersion+1)throw invalid()
   update(()=>{if(pending?.input.requestId===request.input.requestId)pending=undefined;if(request.endpoint==='save-personal'&&draft&&draft.expectedVersion===request.input.expectedVersion&&draft.entryId===request.input.entryId&&draft.topic.trim()===request.input.topic&&draft.markdown.trim()===request.input.markdown)draft=undefined});return result
  }catch(error){if(request.endpoint!=='publish-personal'&&error&&typeof error==='object'&&'rejected'in error&&error.rejected===true&&'code'in error&&['teloa/invalid-input','teloa/forbidden','teloa/not-found','teloa/conflict','teloa/version-conflict'].includes(String(error.code)))update(()=>{if(pending?.input.requestId===request.input.requestId)pending=undefined});throw error}finally{busy=false}
 }
 const mutate=(endpoint:Pending['endpoint'],input:Omit<EditPending['input'],'requestId'>|PersonalPreferenceAdoption)=>{sync();if(recoveryError)throw new WorkError('teloa/storage-corrupt','个人偏好恢复记录不可读。');const request=readPending({endpoint,input:{...input,requestId:pending?.input.requestId??crypto.randomUUID()}});if(pending&&JSON.stringify(pending)!==JSON.stringify(request))throw new WorkError('teloa/conflict','请先核对上次个人偏好操作。');update(()=>{pending=request});return run(request)}
 sync()
 return {recoveryError:()=>{sync();return recoveryError},pending:()=>{sync();return pending},draft:()=>{sync();return draft?structuredClone(draft):undefined},
  discard(){
   if(busy)throw new WorkError('teloa/conflict','个人偏好仍在保存，请稍后再试。')
   sync();const had=!!recoveryError||!!pending;if(!had)return false
   let kept=draft
   try{const raw=journal?.read();if(raw){const row=projectInput(JSON.parse(raw),['pending','draft']);kept=row.draft===null?undefined:readDraft(row.draft)}}catch{/* 损坏记录不能覆盖已在编辑的可读草稿。 */}
   const next=kept?JSON.stringify({pending:null,draft:kept}):null
   if(journal?.discard)journal.discard(next);else if(next===null)journal?.clear();else journal?.write(next)
   if(journal&&journal.read()!==next)throw new WorkError('teloa/storage-unavailable','本地记录未能清理，请稍后重试。')
   pending=undefined;draft=kept;recoveryError=undefined;return true
  },
  setDraft(value:PersonalPreferenceDraft|undefined){if(value)value=readDraft(value);update(()=>{draft=value?structuredClone(value):undefined})},
  async get(){return readPersonal(await call('project-runtime/personal',{}))},
  async save(value:PersonalPreferenceDraft){const row=readDraft(value);return mutate('save-personal',{...row,topic:row.topic.trim(),markdown:row.markdown.trim()})},
  async withdraw(value:{expectedVersion:number;entryId:string}){return mutate('withdraw-personal',value)},
  async publish(value:PersonalPreferenceAdoption){return mutate('publish-personal',value)},
  recover(){sync();if(recoveryError)throw new WorkError('teloa/storage-corrupt','个人偏好恢复记录不可读。');if(!pending)throw new WorkError('teloa/not-found','没有待核对的个人偏好操作。');return run(pending)},
 }
}
export type PersonalPreferenceApi=ReturnType<typeof createPersonalPreferenceApi>

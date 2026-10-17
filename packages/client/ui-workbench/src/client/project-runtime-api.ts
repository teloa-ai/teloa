import {WorkError,projectUuid,projectInput,projectRuntimeSettingsInput,projectMembershipInput,readProjectRuntimeSettings,readProjectMembership,readContextUseManifest,readProjectContext,type ProjectRuntimeSettings,type ProjectConversationMembership,type ProjectContextUseManifest,type ProjectMemoryMode} from '@teloa/contract'
import {createPersonalPreferenceApi} from './project-personal-preferences-api.ts'

export type {ProjectMemoryMode,ProjectRuntimeSettings}
export type ProjectConversationBinding=ProjectConversationMembership
export type ProjectRuntimeEvidence={kind:'decision'|'rule'|'verified'|'untrusted'|'assistant';text:string}
export type ProjectRuntimeCandidate={id:string;projectId:string;topic:string;markdown:string;kind:'rule'|'memory';status:'candidate'|'conflict';reason:string;version:number;source?:{sessionId:string;messageId:string};evidence?:ProjectRuntimeEvidence[]}
export type ProjectRuntimeFailure={eventId:string;projectId:string;attempts:number;errorCode:string;canRetry:boolean}
export type ProjectRuntimeUse=ProjectContextUseManifest
export type ProjectConversationCandidate={sessionId:string;title:string;bindingVersion:number}
export type ProjectConversationPreparation={text:string;projectVersion:number;scope:string}
export type ProjectConversationCreation={projectId:string;requestId:string;title:string;memoryMode:ProjectMemoryMode;workspaceId?:string;workspaceResolved?:boolean;preparation?:ProjectConversationPreparation}
type BindInput={sessionId:string;projectId:string|null;expectedVersion:number;memoryMode:ProjectMemoryMode}
type Journal={read:()=>string|null;write:(value:string)=>void;clear:()=>void}
type Pending={projectId:string;endpoint:'configure'|'bind'|'resolve'|'retry';input:Record<string,unknown>}
const invalid=()=>new WorkError('teloa/invalid-host-response','项目上下文回执无法核对。')
const record=(value:unknown):Record<string,unknown>=>{if(!value||typeof value!=='object'||Array.isArray(value))throw invalid();return value as Record<string,unknown>}
const text=(value:unknown,max=2000):value is string=>typeof value==='string'&&value.length>0&&value.length<=max&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)
const version=(value:unknown,min=0):value is number=>Number.isSafeInteger(value)&&Number(value)>=min
const mode=(value:unknown):value is ProjectMemoryMode=>value==='enabled'||value==='off'
const hostResponse=<T>(read:(value:unknown)=>T)=>(value:unknown):T=>{try{return read(value)}catch{throw invalid()}}
const readSettings=hostResponse(readProjectRuntimeSettings)
const readBinding=hostResponse(readProjectMembership)
const readCandidate=(value:unknown):ProjectRuntimeCandidate=>{
 const raw=record(value),r=raw.proposal?{...raw,...record(raw.proposal)}:raw
 if(!projectUuid(r.id)||!projectUuid(r.projectId)||!text(r.topic,120)||!text(r.markdown,16000)||!['rule','memory'].includes(String(r.kind))||!['candidate','conflict'].includes(String(r.status))||!text(r.reason,2000)||!version(r.version,1))throw invalid()
 let source:ProjectRuntimeCandidate['source'],evidence:ProjectRuntimeEvidence[]|undefined
 if(raw.source!==undefined){const value=projectInput(raw.source,['sessionId','messageId']);if(!text(value.sessionId,256)||!text(value.messageId,256)||value.sessionId!==value.sessionId.trim()||value.messageId!==value.messageId.trim())throw invalid();source={sessionId:value.sessionId,messageId:value.messageId}}
 if(raw.evidence!==undefined){if(!Array.isArray(raw.evidence)||raw.evidence.length>32)throw invalid();evidence=raw.evidence.map(item=>{const value=projectInput(item,['kind','text']);if(!['decision','rule','verified','untrusted','assistant'].includes(String(value.kind))||!text(value.text,16000))throw invalid();return {kind:value.kind as ProjectRuntimeEvidence['kind'],text:value.text}})}
 return {id:r.id,projectId:r.projectId,topic:r.topic,markdown:r.markdown,kind:r.kind as ProjectRuntimeCandidate['kind'],status:r.status as ProjectRuntimeCandidate['status'],reason:r.reason,version:r.version,...(source?{source}:{}),...(evidence?{evidence}:{})}
}
const readUse=hostResponse(readContextUseManifest)
const readFailure=(value:unknown):ProjectRuntimeFailure=>{
 const r=record(value)
 if(!projectUuid(r.eventId)||!projectUuid(r.projectId)||!version(r.attempts,1)||r.attempts>5||typeof r.errorCode!=='string'||!/^teloa\/[a-z][a-z0-9-]{0,60}$/.test(r.errorCode)||typeof r.canRetry!=='boolean'||r.status!==undefined&&r.status!=='failed')throw invalid()
 return {eventId:r.eventId,projectId:r.projectId,attempts:r.attempts,errorCode:r.errorCode,canRetry:r.canRetry}
}
const readRows=<T>(value:unknown,read:(item:unknown)=>T,key:(item:T)=>string,max=1000)=>{
 const r=record(value);if(!Array.isArray(r.rows)||r.rows.length>max)throw invalid()
 const rows=r.rows.map(read);if(new Set(rows.map(key)).size!==rows.length)throw invalid();return rows
}
const readCreation=(value:unknown):ProjectConversationCreation=>{
 const r=record(value)
 if(!projectUuid(r.projectId)||!projectUuid(r.requestId)||!text(r.title,200)||!mode(r.memoryMode)||r.workspaceId!==undefined&&!text(r.workspaceId)||r.workspaceResolved!==undefined&&typeof r.workspaceResolved!=='boolean')throw invalid()
 if(r.preparation!==undefined){const p=record(r.preparation);if(!text(p.text,8000)||!p.text.trim()||!version(p.projectVersion,1)||!text(p.scope,200))throw invalid()}
 return r as ProjectConversationCreation
}
const readPending=(value:unknown):Pending=>{
 const row=record(value)
 if(!projectUuid(row.projectId)||!['configure','bind','resolve','retry'].includes(String(row.endpoint)))throw invalid()
 let input:Record<string,unknown>
 if(row.endpoint==='configure')input={...projectRuntimeSettingsInput(row.input)}
 else if(row.endpoint==='bind')input={...projectMembershipInput(row.input)}
 else if(row.endpoint==='retry'){input=projectInput(row.input,['projectId','eventId','requestId']);if(!projectUuid(input.projectId)||!projectUuid(input.eventId)||!projectUuid(input.requestId))throw invalid()}
 else{input=projectInput(row.input,['projectId','candidateId','requestId','expectedVersion','decision']);if(!projectUuid(input.projectId)||!projectUuid(input.candidateId)||!projectUuid(input.requestId)||!version(input.expectedVersion)||!['accept','reject'].includes(String(input.decision)))throw invalid()}
 if(input.projectId!==null&&input.projectId!==row.projectId)throw invalid()
 return {projectId:row.projectId,endpoint:row.endpoint as Pending['endpoint'],input}
}

export function createProjectRuntimeApi(call:(endpoint:string,input:unknown)=>Promise<unknown>,journal?:Journal){
 let pending=new Map<string,Pending>(),drafts=new Map<string,ProjectRuntimeSettings>(),creations=new Map<string,ProjectConversationCreation>(),personalSnapshot:unknown,recoveryError:unknown
 const busy=new Set<string>()
 const sync=()=>{
  if(!journal)return
  try{
   const saved=journal.read(),r=record(saved?JSON.parse(saved):{pending:[],drafts:[],creations:[]})
   if(!Array.isArray(r.pending)||!Array.isArray(r.drafts)||!Array.isArray(r.creations)||r.pending.length>100||r.drafts.length>100||r.creations.length>100)throw invalid()
   const p=new Map<string,Pending>(),d=new Map<string,ProjectRuntimeSettings>(),c=new Map<string,ProjectConversationCreation>()
   for(const value of r.pending){const item=readPending(value);if(p.has(item.projectId))throw invalid();p.set(item.projectId,item)}
   for(const value of r.drafts){const item=readSettings(value);if(d.has(item.projectId))throw invalid();d.set(item.projectId,item)}
   for(const value of r.creations){const item=readCreation(value);if(c.has(item.projectId))throw invalid();c.set(item.projectId,item)}
   pending=p;drafts=d;creations=c;personalSnapshot=r.personal;recoveryError=undefined
  }catch(error){recoveryError=error}
 }
 const persist=()=>{if(!pending.size&&!drafts.size&&!creations.size&&personalSnapshot===undefined)journal?.clear();else journal?.write(JSON.stringify({pending:[...pending.values()],drafts:[...drafts.values()],creations:[...creations.values()],...(personalSnapshot===undefined?{}:{personal:personalSnapshot})}))}
 // 只清指定分区的恢复请求；可读的其他项目、草稿、会话预约与个人偏好继续保留。
 const discardLocal=(projectId:string|undefined,personal:unknown=undefined,replacePersonal=false)=>{
  if(busy.size)throw new WorkError('teloa/conflict','项目操作仍在处理，请稍后再试。')
  sync();const had=replacePersonal?true:!!recoveryError||!!projectId&&pending.has(projectId)
  if(!had)return false
  let saved:Record<string,unknown>|undefined
  try{const raw=journal?.read();if(raw)saved=record(JSON.parse(raw))}catch{/* 不可解析时保留本进程最后一次可读的分区。 */}
  const p=new Map(pending),d=new Map(drafts),c=new Map(creations)
  if(saved){
   if(!Array.isArray(saved.pending)||!Array.isArray(saved.drafts)||!Array.isArray(saved.creations)||saved.pending.length>100||saved.drafts.length>100||saved.creations.length>100)throw invalid()
   p.clear();d.clear();c.clear()
   for(const value of saved.pending){if(projectId&&value&&typeof value==='object'&&'projectId'in value&&value.projectId===projectId)continue;const row=readPending(value);if(p.has(row.projectId))throw invalid();p.set(row.projectId,row)}
   for(const value of saved.drafts){const row=readSettings(value);if(d.has(row.projectId))throw invalid();d.set(row.projectId,row)}
   for(const value of saved.creations){const row=readCreation(value);if(c.has(row.projectId))throw invalid();c.set(row.projectId,row)}
  }
  if(projectId)p.delete(projectId)
  const pref=replacePersonal?personal:saved?saved.personal:personalSnapshot
  const next=!p.size&&!d.size&&!c.size&&pref===undefined?null:JSON.stringify({pending:[...p.values()],drafts:[...d.values()],creations:[...c.values()],...(pref===undefined?{}:{personal:pref})})
  if(next===null)journal?.clear();else journal?.write(next)
  if(journal&&journal.read()!==next)throw new WorkError('teloa/storage-unavailable','本地记录未能清理，请稍后重试。')
  pending=p;drafts=d;creations=c;personalSnapshot=pref;recoveryError=undefined
  return true
 }
 const update=(change:()=>void)=>{sync();if(recoveryError)throw new WorkError('teloa/storage-corrupt','项目运行设置恢复记录不可读。');change();persist()}
 const run=async(request:Pending)=>{
  if(busy.has(request.projectId))throw new WorkError('teloa/conflict','项目上下文操作仍在处理。')
  busy.add(request.projectId)
  try{
   const result=await call('project-runtime/'+request.endpoint,request.input)
   let receipt:ProjectRuntimeSettings|ProjectConversationBinding|{ok:true}
   if(request.endpoint==='configure'){
    receipt=readSettings(result)
    if(receipt.projectId!==request.projectId||receipt.version!==Number(request.input.expectedVersion)+1||receipt.automatic!==request.input.automatic||receipt.readPersonal!==request.input.readPersonal||JSON.stringify(receipt.resources)!==JSON.stringify(request.input.resources))throw invalid()
   }else if(request.endpoint==='bind'){
    receipt=readBinding(result)
    if(receipt.sessionId!==request.input.sessionId||receipt.projectId!==request.input.projectId||receipt.version!==Number(request.input.expectedVersion)+1||receipt.memoryMode!==request.input.memoryMode)throw invalid()
   }else{if(record(result).ok!==true)throw invalid();receipt={ok:true}}
   update(()=>{
    if(pending.get(request.projectId)?.input.requestId===request.input.requestId)pending.delete(request.projectId)
    const draft=drafts.get(request.projectId)
    if(request.endpoint==='configure'&&draft&&draft.version===request.input.expectedVersion&&draft.automatic===request.input.automatic&&draft.readPersonal===request.input.readPersonal&&JSON.stringify(draft.resources)===JSON.stringify(request.input.resources))drafts.delete(request.projectId)
   })
   return receipt
  }catch(error){
   if(error&&typeof error==='object'&&'rejected'in error&&error.rejected===true&&'code'in error&&['teloa/invalid-input','teloa/forbidden','teloa/not-found','teloa/conflict','teloa/version-conflict'].includes(String(error.code)))update(()=>{if(pending.get(request.projectId)?.input.requestId===request.input.requestId)pending.delete(request.projectId)})
   throw error
  }finally{busy.delete(request.projectId)}
 }
 const mutate=(projectId:string,endpoint:Pending['endpoint'],input:Record<string,unknown>)=>{
  if(!projectUuid(projectId)||endpoint!=='retry'&&!version(input.expectedVersion))throw new WorkError('teloa/invalid-input','项目或版本不正确。')
  sync();if(recoveryError)throw new WorkError('teloa/storage-corrupt','项目运行设置恢复记录不可读。')
  const saved=pending.get(projectId),request=readPending({projectId,endpoint,input:{...input,requestId:saved?.input.requestId??crypto.randomUUID()}})
  if(saved&&JSON.stringify(saved)!==JSON.stringify(request))throw new WorkError('teloa/conflict','请先核对此项目上次操作的结果。')
  if(endpoint==='bind'&&[...pending.values()].some(item=>item.projectId!==projectId&&item.endpoint==='bind'&&item.input.sessionId===input.sessionId))throw new WorkError('teloa/conflict','此会话的项目归属仍待核对。')
  update(()=>pending.set(projectId,request));return run(request)
 }
 sync()
 const personalJournal=journal?{read:()=>{sync();if(recoveryError)throw recoveryError;return personalSnapshot===undefined?null:JSON.stringify(personalSnapshot)},write:(value:string)=>update(()=>{personalSnapshot=JSON.parse(value)}),clear:()=>update(()=>{personalSnapshot=undefined}),discard:(value:string|null)=>{discardLocal(undefined,value===null?undefined:JSON.parse(value),true)}}:undefined
 return {
  personal:createPersonalPreferenceApi(call,personalJournal),
  recoveryError:()=>{sync();return recoveryError},pending:(projectId:string)=>{sync();return pending.get(projectId)},
  discard(projectId:string){if(!projectUuid(projectId))throw invalid();return discardLocal(projectId)},
  draft:(projectId:string)=>{sync();const value=drafts.get(projectId);return value?structuredClone(value):undefined},
  setDraft(projectId:string,value:ProjectRuntimeSettings|undefined){if(value){value=readSettings(value);if(value.projectId!==projectId)throw invalid()}update(()=>{if(value)drafts.set(projectId,structuredClone(value));else drafts.delete(projectId)})},
  async settings(projectId:string){const result=readSettings(await call('project-runtime/settings',{projectId}));if(result.projectId!==projectId)throw invalid();return result},
  async configure(settings:ProjectRuntimeSettings){const value=readSettings(settings);return await mutate(value.projectId,'configure',{projectId:value.projectId,expectedVersion:value.version,automatic:value.automatic,readPersonal:value.readPersonal,resources:value.resources}) as ProjectRuntimeSettings},
  async members(projectId:string){const rows=readRows(await call('project-runtime/members',{projectId}),readBinding,item=>item.sessionId);if(rows.some(row=>row.projectId!==projectId))throw invalid();return rows},
  async binding(sessionId:string){const value=await call('project-runtime/binding',{sessionId});if(value===null)return null;const result=readBinding(value);if(result.sessionId!==sessionId)throw invalid();return result},
  async conversations(projectId:string){return readRows(await call('project-runtime/conversations',{projectId}),value=>{const r=record(value);if(!text(r.sessionId)||!text(r.title,200)||!version(r.bindingVersion))throw invalid();return {sessionId:r.sessionId,title:r.title,bindingVersion:r.bindingVersion}},item=>item.sessionId)},
  async bind(input:BindInput,fromProjectId?:string){if(!text(input.sessionId)||input.projectId!==null&&!projectUuid(input.projectId)||!mode(input.memoryMode))throw new WorkError('teloa/invalid-input','会话项目设置不正确。');return await mutate(input.projectId??fromProjectId!,'bind',{...input}) as ProjectConversationBinding},
  async uses(projectId:string,sessionId?:string){const rows=readRows(await call('project-runtime/uses',{projectId,...(sessionId?{sessionId}:{})}),readUse,item=>item.id);if(rows.some(row=>row.projectId!==projectId||sessionId&&row.sessionId!==sessionId))throw invalid();return rows},
  async candidates(projectId:string){const rows=readRows(await call('project-runtime/candidates',{projectId}),readCandidate,item=>item.id);if(rows.some(row=>row.projectId!==projectId))throw invalid();return rows},
  async failures(projectId:string){const rows=readRows(await call('project-runtime/failures',{projectId}),readFailure,item=>item.eventId,100);if(rows.some(row=>row.projectId!==projectId))throw invalid();return rows},
  async retry(projectId:string,eventId:string){if(!projectUuid(eventId))throw new WorkError('teloa/invalid-input','提炼事件不正确。');return await mutate(projectId,'retry',{projectId,eventId}) as {ok:true}},
  async history(input:{projectId:string;cursor:string|null;limit:number}){const value=record(await call('project-runtime/history',input));if(value.nextCursor!==null&&!text(value.nextCursor,2000))throw invalid();const detail=hostResponse(readProjectContext)({projectId:input.projectId,version:0,brief:'',entries:value.entries,shares:value.shares});return {entries:detail.entries,shares:detail.shares,nextCursor:value.nextCursor as string|null}},
  async resolve(projectId:string,candidateId:string,expectedVersion:number,decision:'accept'|'reject'){if(!projectUuid(candidateId)||!['accept','reject'].includes(decision))throw new WorkError('teloa/invalid-input','候选选择不正确。');return await mutate(projectId,'resolve',{projectId,candidateId,expectedVersion,decision}) as {ok:true}},
  recover(projectId:string){sync();if(recoveryError)throw new WorkError('teloa/storage-corrupt','项目运行设置恢复记录不可读。');const request=pending.get(projectId);if(!request)throw new WorkError('teloa/not-found','没有待核对的操作。');return run(request)},
  creation(projectId:string){sync();const value=creations.get(projectId);return value?structuredClone(value):undefined},
  reserveCreation(projectId:string,title:string,memoryMode:ProjectMemoryMode,preparation?:ProjectConversationPreparation){const value=readCreation({projectId,requestId:crypto.randomUUID(),title:title.trim(),memoryMode,...(preparation?{preparation}:{})});let result=value;update(()=>{const old=creations.get(projectId);if(old){if(old.title!==value.title||old.memoryMode!==value.memoryMode||old.preparation?.text!==value.preparation?.text||old.preparation?.projectVersion!==value.preparation?.projectVersion||old.preparation?.scope!==value.preparation?.scope)throw new WorkError('teloa/conflict','请先恢复原项目会话预约。');result=old}else creations.set(projectId,value)});return structuredClone(result)},
  creationWorkspace(projectId:string,workspaceId:string|undefined){update(()=>{const row=creations.get(projectId);if(!row)throw invalid();if((row.workspaceResolved||row.workspaceId!==undefined)&&row.workspaceId!==workspaceId)throw new WorkError('teloa/conflict','会话预约必须在原工作区恢复。');creations.set(projectId,{...row,workspaceResolved:true,...(workspaceId===undefined?{}:{workspaceId})})})},
  completeCreation(projectId:string,requestId:string){update(()=>{if(creations.get(projectId)?.requestId===requestId)creations.delete(projectId)})},
 }
}
export type ProjectRuntimeApi=ReturnType<typeof createProjectRuntimeApi>

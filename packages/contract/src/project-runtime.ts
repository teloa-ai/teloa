import {WorkError} from './work-error.ts'
import {projectInput,projectUuid} from './projects.ts'
import {isRecord} from './resources.ts'

export type ProjectMemoryMode='enabled'|'off'
export type ProjectAutomaticMemory='decisions'|'verified'|'paused'
export type ProjectRuntimeResource={resourceId:string;required:boolean}
export type ProjectRuntimeSettings={projectId:string;version:number;automatic:ProjectAutomaticMemory;readPersonal:boolean;resources:ProjectRuntimeResource[]}
export type ProjectConversationMembership={sessionId:string;projectId:string|null;version:number;memoryMode:ProjectMemoryMode;generation:number;title:string}
export type ProjectContextUseSource={kind:'project'|'brief'|'rule'|'memory'|'share'|'resource'|'personal'|'role';id:string;version:number;hash:string;title:string}
export type ProjectContextUseManifest={id:string;sessionId:string;messageId:string;projectId:string;bindingVersion:number;generation:number;memoryMode:ProjectMemoryMode;createdAt:string;sources:ProjectContextUseSource[];omitted:Array<{reason:string}>}
export type ProjectCitationKind='memory'|'rule'|'brief'|'project'
export type ProjectCitationSelector={kind:ProjectCitationKind;id:string}|{kind:ProjectCitationKind;title:string}|{hash:string}
export type ProjectContextCitationRequest={sessionId:string;turn:number}&({kind:ProjectCitationKind;id:string}|{reference:string})
export type ProjectContextCitation={sessionId:string;turn:number;kind:ProjectCitationKind;id:string;version:number;currentVersion:number;hash:string;title:string;markdown:string}
const citationKind=(value:unknown):value is ProjectCitationKind=>value==='memory'||value==='rule'||value==='brief'||value==='project'
/** 仅兼容已出现的明确引用形式；选择信息本身不构成正文读取许可。 */
export function projectCitationSelector(value:unknown):ProjectCitationSelector|undefined{
 if(typeof value!=='string'||value.length>260||/[\x00-\x1f\x7f]/.test(value))return
 const qualified=/^(memory|rule|brief|project)[/:]([a-f0-9-]{36})$/i.exec(value)
 if(qualified&&projectUuid(qualified[2]))return {kind:qualified[1]!.toLowerCase() as ProjectCitationKind,id:qualified[2]!.toLowerCase()}
 const titled=/^(记忆|规则|简报|项目):(.{1,240})$/.exec(value),kinds={记忆:'memory',规则:'rule',简报:'brief',项目:'project'} as const
 if(titled)return {kind:kinds[titled[1] as keyof typeof kinds],title:titled[2]!}
 if(/^[a-f0-9]{64}$/.test(value))return {hash:value}
 return
}
export function projectCitationMatches(source:ProjectContextUseSource,selector:ProjectCitationSelector):boolean{
 return 'hash'in selector?source.hash===selector.hash:source.kind===selector.kind&&('id'in selector?source.id===selector.id:source.title===selector.title)
}
export function projectContextCitationInput(value:unknown):ProjectContextCitationRequest{
 const r=projectInput(value,['sessionId','turn','kind','id','reference']),base={sessionId:projectRuntimeSession(r.sessionId),turn:projectRuntimeVersion(r.turn,1)}
 if(r.reference!==undefined){projectInput(value,['sessionId','turn','reference']);if(typeof r.reference!=='string'||!projectCitationSelector(r.reference))throw invalid();return {...base,reference:r.reference}}
 if(!citationKind(r.kind))throw invalid()
 return {...base,kind:r.kind,id:projectRuntimeUuid(r.id)}
}
export function readProjectContextCitation(value:unknown):ProjectContextCitation{
 const r=projectInput(value,['sessionId','turn','kind','id','version','currentVersion','hash','title','markdown'])
 if(!citationKind(r.kind)||typeof r.hash!=='string'||!/^[a-f0-9]{64}$/.test(r.hash))throw invalid()
 const version=projectRuntimeVersion(r.version,1),currentVersion=projectRuntimeVersion(r.currentVersion,version)
 return {sessionId:projectRuntimeSession(r.sessionId),turn:projectRuntimeVersion(r.turn,1),kind:r.kind,id:projectRuntimeUuid(r.id),version,currentVersion,hash:r.hash,title:projectRuntimeText(r.title,240),markdown:projectRuntimeText(r.markdown,16000)}
}
export type ProjectCitationEvent={type:string;seq:number;surfaceOp?:unknown;data:unknown}
export type ProjectCitationSnapshotSource={projectId:string;generation:number;source:ProjectContextUseSource&{kind:ProjectCitationKind};markdown:string}
/** 从官方事件定位原轮次候选。客户端只用它决定导航；宿主仍须复核正文hash、派发清单和当前权限。 */
export function projectCitationTurnSources(events:readonly ProjectCitationEvent[],sessionId:string,requestedTurn:number,inheritedEventCount=0):{messageIds:string[];rows:ProjectCitationSnapshotSource[]}{
 const snapshot=(data:Record<string,unknown>):ProjectCitationSnapshotSource[]|null=>{
  const source=data.source;if(!isRecord(source)||source.kind!=='runtime-context'||source.form!=='snapshot'||!Array.isArray(source.sections))return null
  const sections=source.sections.filter(isRecord),contexts=sections.filter(s=>s.name==='teloa/project-context'),markers=sections.filter(s=>s.name==='teloa/project-context-generation')
  if(contexts.length!==1||markers.length!==1||typeof contexts[0]!.text!=='string'||typeof markers[0]!.text!=='string'||contexts[0]!.text.length>1024*1024)return null
  try{
   const [sid,projectId,generation]=JSON.parse(markers[0]!.text)
   if(sid!==sessionId||!projectUuid(projectId)||!Number.isSafeInteger(generation)||generation<1)return null
   const text=contexts[0]!.text,rows:unknown=JSON.parse(text.slice(text.lastIndexOf('\n')+1));if(!Array.isArray(rows)||rows.length>500)return null
   const result:ProjectCitationSnapshotSource[]=[]
   for(const row of rows){
    if(!isRecord(row)||!isRecord(row.source))return null
    const s=row.source;if(!citationKind(s.kind))continue
    if(!projectUuid(s.id)||((s.kind==='project'||s.kind==='brief')&&s.id!==projectId)||!Number.isSafeInteger(s.version)||Number(s.version)<1||typeof s.hash!=='string'||!/^[a-f0-9]{64}$/.test(s.hash)||typeof s.title!=='string'||s.title.length>240||typeof row.markdown!=='string'||row.markdown.length>16000)return null
    result.push({projectId,generation,source:{kind:s.kind,id:s.id,version:Number(s.version),hash:s.hash,title:s.title},markdown:row.markdown})
   }
   return result
  }catch{return null}
 }
 let turn:number|undefined,active:ProjectCitationSnapshotSource[]|null=null
 const messageIds:string[]=[],found=new Map<string,ProjectCitationSnapshotSource>()
 for(const event of events){
  if(!isRecord(event.data))continue
  const data=event.data
  if(event.type==='turn/start')turn=event.seq>=inheritedEventCount&&data.turn===requestedTurn?requestedTurn:undefined
  if(event.type==='user/message'&&isRecord(data.source)&&data.source.kind==='runtime-context'){
   const next=snapshot(data)
   if(next?.length&&active?.length&&active[0]!.projectId===next[0]!.projectId&&active[0]!.generation===next[0]!.generation){const rows:Map<string,ProjectCitationSnapshotSource>=new Map(active.map(row=>[JSON.stringify(row.source),row]));for(const row of next)rows.set(JSON.stringify(row.source),row);active=[...rows.values()]}else active=next
  }
  if(turn!==requestedTurn)continue
  if(event.type==='user/message'&&event.surfaceOp==='append'&&isRecord(data.source)&&data.source.kind==='user'&&typeof data.id==='string')messageIds.push(data.id)
  if(event.type==='assistant/message'&&event.surfaceOp==='append'&&data.turn===requestedTurn&&active)for(const row of active)found.set(JSON.stringify([row.projectId,row.generation,row.source]),row)
  if(event.type==='turn/end')turn=undefined
 }
 return {messageIds,rows:[...found.values()]}
}
export type ProjectRuntimeSettingsMutation=Omit<ProjectRuntimeSettings,'version'>&{requestId:string;expectedVersion:number}
export type ProjectMembershipMutation={requestId:string;sessionId:string;projectId:string|null;expectedVersion:number;memoryMode:ProjectMemoryMode}
const invalid=()=>new WorkError('teloa/invalid-input','项目运行设置或会话归属格式不正确。')
export function projectRuntimeUuid(value:unknown){if(!projectUuid(value))throw invalid();return value.toLowerCase()}
export function projectRuntimeVersion(value:unknown,min=0){if(!Number.isSafeInteger(value)||Number(value)<min)throw invalid();return Number(value)}
export function projectRuntimeSession(value:unknown){if(typeof value!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(value))throw invalid();return value}
export function projectRuntimeText(value:unknown,max=16000){if(typeof value!=='string'||value.length>max||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value))throw invalid();return value}
function mode(value:unknown):ProjectMemoryMode{if(value!=='enabled'&&value!=='off')throw invalid();return value}
function automatic(value:unknown):ProjectAutomaticMemory{if(value!=='decisions'&&value!=='verified'&&value!=='paused')throw invalid();return value}
function boolean(value:unknown){if(typeof value!=='boolean')throw invalid();return value}
function resources(value:unknown):ProjectRuntimeResource[]{
 if(!Array.isArray(value)||value.length>100)throw invalid()
 const rows=value.map(v=>{const row=projectInput(v,['resourceId','required']);return {resourceId:projectRuntimeUuid(row.resourceId),required:boolean(row.required)}})
 if(new Set(rows.map(r=>r.resourceId)).size!==rows.length)throw invalid()
 return rows
}
export function projectRuntimeSettingsInput(value:unknown):ProjectRuntimeSettingsMutation{
 const r=projectInput(value,['projectId','requestId','expectedVersion','automatic','readPersonal','resources'])
 return {projectId:projectRuntimeUuid(r.projectId),requestId:projectRuntimeUuid(r.requestId),expectedVersion:projectRuntimeVersion(r.expectedVersion),automatic:automatic(r.automatic),readPersonal:boolean(r.readPersonal),resources:resources(r.resources)}
}
export function readProjectRuntimeSettings(value:unknown):ProjectRuntimeSettings{
 const r=projectInput(value,['projectId','version','automatic','readPersonal','resources'])
 return {projectId:projectRuntimeUuid(r.projectId),version:projectRuntimeVersion(r.version),automatic:automatic(r.automatic),readPersonal:boolean(r.readPersonal),resources:resources(r.resources)}
}
export function projectMembershipInput(value:unknown):ProjectMembershipMutation{
 const r=projectInput(value,['requestId','sessionId','projectId','expectedVersion','memoryMode'])
 return {requestId:projectRuntimeUuid(r.requestId),sessionId:projectRuntimeSession(r.sessionId),projectId:r.projectId===null?null:projectRuntimeUuid(r.projectId),expectedVersion:projectRuntimeVersion(r.expectedVersion),memoryMode:mode(r.memoryMode)}
}
export function readProjectMembership(value:unknown):ProjectConversationMembership{
 const r=projectInput(value,['sessionId','projectId','version','memoryMode','generation','title'])
 return {sessionId:projectRuntimeSession(r.sessionId),projectId:r.projectId===null?null:projectRuntimeUuid(r.projectId),version:projectRuntimeVersion(r.version),memoryMode:mode(r.memoryMode),generation:projectRuntimeVersion(r.generation,1),title:projectRuntimeText(r.title,240)}
}
export function readContextUseManifest(value:unknown):ProjectContextUseManifest{
 const r=projectInput(value,['id','sessionId','messageId','projectId','bindingVersion','generation','memoryMode','createdAt','sources','omitted'])
 if(!Array.isArray(r.sources)||r.sources.length>500||!Array.isArray(r.omitted)||r.omitted.length>500||typeof r.createdAt!=='string'||!Number.isFinite(Date.parse(r.createdAt)))throw invalid()
 const sources=r.sources.map(v=>{const s=projectInput(v,['kind','id','version','hash','title']);if(!['project','brief','rule','memory','share','resource','personal','role'].includes(String(s.kind))||typeof s.hash!=='string'||!/^[a-f0-9]{64}$/.test(s.hash))throw invalid();return {kind:s.kind as ProjectContextUseSource['kind'],id:projectRuntimeText(s.id,128),version:projectRuntimeVersion(s.version),hash:s.hash,title:projectRuntimeText(s.title,240)}})
 return {id:projectRuntimeUuid(r.id),sessionId:projectRuntimeSession(r.sessionId),messageId:projectRuntimeText(r.messageId,128),projectId:projectRuntimeUuid(r.projectId),bindingVersion:projectRuntimeVersion(r.bindingVersion),generation:projectRuntimeVersion(r.generation,1),memoryMode:mode(r.memoryMode),createdAt:r.createdAt,sources,omitted:r.omitted.map(v=>{const o=projectInput(v,['reason']);return {reason:projectRuntimeText(o.reason,240)}})}
}

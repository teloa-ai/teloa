import {isRecord,WorkError} from './index.ts'

export const projectStates=['planning','running','review','completed','archived'] as const
export const projectLinkKinds=['task','group','role','plan','resource','artifact'] as const
export type ProjectLinkKind=typeof projectLinkKinds[number]
export type ProjectLink={kind:ProjectLinkKind;id:string}
/** 跨业务只读引用：指向其他业务的条目，只做展示，不参与派生汇入、进度与 AI 上下文。 */
export type ProjectReference=ProjectLink&{scope:string}
export type ProjectReferenceItem=ProjectReference&{title:string|null;state:string|null;version:number|null;available:boolean}
export type ProjectDefinition={scope:string;title:string;goal:string;dueDate:string|null;state:typeof projectStates[number];links:ProjectLink[];references:ProjectReference[]}
export type WorkProject=ProjectDefinition&{id:string;ownerId:string;version:number;createdAt:string;updatedAt:string}
export type ProjectItem=ProjectLink&{title:string|null;state:string|null;version:number|null;available:boolean;origin:'direct'|'automation'|'task-output';attention:'error'|'review'|null}
export type ProjectSummary={totalTasks:number;completedTasks:number;cancelledTasks:number;attentionTasks:number}
export type ProjectDetail={project:WorkProject;items:ProjectItem[];summary:ProjectSummary;references:ProjectReferenceItem[]}
/** 总览入参：`state` 为 `null` 表示全部状态，`'current'` 表示非归档（其余取值为单一生命周期）。 */
export type ProjectOverviewInput={scope:string|null;state:ProjectDefinition['state']|'current'|null;cursor:string|null;limit:number}
export type ProjectOverviewPage={rows:WorkProject[];nextCursor:string|null}
const invalid=()=>new WorkError('teloa/invalid-input','项目内容或字段格式不正确。')
export const projectUuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v)
export function projectInput(value:unknown,keys:readonly string[]):Record<string,unknown>{if(!isRecord(value)||Object.keys(value).some(key=>!keys.includes(key)))throw invalid();return value}
function text(value:unknown,max:number){if(typeof value!=='string'||!value.trim()||value.length>max||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value))throw invalid();return value.trim()}
export function readProjectLink(value:unknown):ProjectLink{
 const row=projectInput(value,['kind','id']);if(!projectLinkKinds.includes(row.kind as ProjectLinkKind)||!projectUuid(row.id))throw invalid()
 return {kind:row.kind as ProjectLinkKind,id:row.id.toLowerCase()}
}
function scopeText(value:unknown){const scope=text(value,64);if(!/^[a-zA-Z0-9_-]+$/.test(scope))throw invalid();return scope}
export function readProjectReference(value:unknown):ProjectReference{
 const row=projectInput(value,['kind','id','scope']);return {...readProjectLink({kind:row.kind,id:row.id}),scope:scopeText(row.scope)}
}
const referenceKey=(ref:ProjectReference)=>ref.scope+':'+ref.kind+':'+ref.id
const definitionKeys=['scope','title','goal','dueDate','state','links','references'] as const
export function projectDefinition(value:unknown):ProjectDefinition{
 const row=projectInput(value,definitionKeys),scope=scopeText(row.scope)
 if(!projectStates.includes(row.state as ProjectDefinition['state']))throw invalid()
 if(row.dueDate!==null&&(typeof row.dueDate!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(row.dueDate)||!Number.isFinite(Date.parse(row.dueDate))||new Date(row.dueDate).toISOString().slice(0,10)!==row.dueDate))throw invalid()
 if(!Array.isArray(row.links)||row.links.length>300)throw invalid()
 const links=row.links.map(readProjectLink).sort((a,b)=>a.kind.localeCompare(b.kind)||a.id.localeCompare(b.id))
 if(new Set(links.map(link=>link.kind+':'+link.id)).size!==links.length)throw invalid()
 // 存量定义没有 references，缺失按空处理；同业务条目请走 links。
 const rawReferences=row.references===undefined?[]:row.references
 if(!Array.isArray(rawReferences)||rawReferences.length>100)throw invalid()
 const references=rawReferences.map(readProjectReference).sort((a,b)=>a.scope.localeCompare(b.scope)||a.kind.localeCompare(b.kind)||a.id.localeCompare(b.id))
 if(new Set(references.map(referenceKey)).size!==references.length||references.some(ref=>ref.scope===scope))throw invalid()
 return {scope,title:text(row.title,120),goal:text(row.goal,8000),dueDate:row.dueDate as string|null,state:row.state as ProjectDefinition['state'],links,references}
}
export function readProject(value:unknown):WorkProject{
 const row=projectInput(value,[...definitionKeys,'id','ownerId','version','createdAt','updatedAt']),{id,ownerId,version,createdAt,updatedAt,...fields}=row
 if(!projectUuid(id)||!Number.isSafeInteger(version)||Number(version)<1||![createdAt,updatedAt].every(v=>typeof v==='string'&&Number.isFinite(Date.parse(v))))throw invalid()
 return {...projectDefinition(fields),id:id.toLowerCase(),ownerId:text(ownerId,128),version:Number(version),createdAt:createdAt as string,updatedAt:updatedAt as string}
}
const itemStates:Record<ProjectLinkKind,readonly string[]>={task:['ready','running','paused','waiting','blocked','completed','cancelled'],group:['active','archived'],role:['active','paused','retired'],plan:['active','paused','archived'],resource:['active','withdrawn'],artifact:['saved']}
export function readProjectItem(value:unknown):ProjectItem{
 const row=projectInput(value,['kind','id','title','state','version','available','origin','attention']),link=readProjectLink({kind:row.kind,id:row.id})
 if(typeof row.available!=='boolean'||!['direct','automation','task-output'].includes(String(row.origin))||![null,'error','review'].includes(row.attention as string|null))throw invalid()
 if((row.origin==='automation'&&link.kind!=='task')||(row.origin==='task-output'&&link.kind!=='artifact')||(row.attention!==null&&link.kind!=='task'))throw invalid()
 if(row.available){if(!Number.isSafeInteger(row.version)||Number(row.version)<1||!itemStates[link.kind].includes(String(row.state)))throw invalid();text(row.title,200)}
 else if(row.title!==null||row.state!==null||row.version!==null||row.attention!==null)throw invalid()
 return {...link,title:row.title as string|null,state:row.state as string|null,version:row.version as number|null,available:row.available,origin:row.origin as ProjectItem['origin'],attention:row.attention as ProjectItem['attention']}
}
export function readProjectReferenceItem(value:unknown):ProjectReferenceItem{
 const row=projectInput(value,['kind','id','scope','title','state','version','available']),ref=readProjectReference({kind:row.kind,id:row.id,scope:row.scope})
 if(typeof row.available!=='boolean')throw invalid()
 if(row.available){if(!Number.isSafeInteger(row.version)||Number(row.version)<1||!itemStates[ref.kind].includes(String(row.state)))throw invalid();text(row.title,200)}
 else if(row.title!==null||row.state!==null||row.version!==null)throw invalid()
 return {...ref,title:row.title as string|null,state:row.state as string|null,version:row.version as number|null,available:row.available}
}
export function projectSummary(items:readonly ProjectItem[]):ProjectSummary{
 const tasks=items.filter(item=>item.kind==='task'&&item.available)
 return {totalTasks:tasks.length,completedTasks:tasks.filter(item=>item.state==='completed').length,cancelledTasks:tasks.filter(item=>item.state==='cancelled').length,attentionTasks:tasks.filter(item=>item.attention!==null).length}
}
export function readProjectDetail(value:unknown):ProjectDetail{
 const row=projectInput(value,['project','items','summary','references']);if(!Array.isArray(row.items)||!Array.isArray(row.references))throw invalid()
 const project=readProject(row.project),items=row.items.map(readProjectItem),summary=projectSummary(items),given=projectInput(row.summary,Object.keys(summary)),references=row.references.map(readProjectReferenceItem)
 if(new Set(items.map(item=>item.kind+':'+item.id)).size!==items.length||Object.entries(summary).some(([key,n])=>given[key]!==n))throw invalid()
 if(new Set(references.map(referenceKey)).size!==references.length)throw invalid()
 return {project,items,summary,references}
}
/** 总览分页游标：`${updatedAt ISO}|${id}`，与后端 `order by updated_at desc,id`（同 list）的 keyset 一一对应。 */
const projectCursor=(v:unknown):v is string=>{
 if(typeof v!=='string')return false
 const [at,id,...rest]=v.split('|');return !rest.length&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(at??'')&&Number.isFinite(Date.parse(at??''))&&projectUuid(id)
}
export function projectOverviewInput(value:unknown):ProjectOverviewInput{
 const row=projectInput(value,['scope','state','cursor','limit'])
 if(!['scope','state','cursor','limit'].every(key=>key in row))throw invalid()
 if(row.state!==null&&row.state!=='current'&&!projectStates.includes(row.state as ProjectDefinition['state']))throw invalid()
 if(row.cursor!==null&&!projectCursor(row.cursor))throw invalid()
 if(!Number.isSafeInteger(row.limit)||Number(row.limit)<1||Number(row.limit)>100)throw invalid()
 return {scope:row.scope===null?null:scopeText(row.scope),state:row.state as ProjectOverviewInput['state'],cursor:row.cursor as string|null,limit:Number(row.limit)}
}
export function readProjectOverviewPage(value:unknown):ProjectOverviewPage{
 const row=projectInput(value,['rows','nextCursor']);if(!Array.isArray(row.rows)||(row.nextCursor!==null&&!projectCursor(row.nextCursor)))throw invalid()
 const rows=row.rows.map(readProject);if(new Set(rows.map(item=>item.id)).size!==rows.length)throw invalid()
 return {rows,nextCursor:row.nextCursor as string|null}
}

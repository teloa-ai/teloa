import {businessObjectReference,type Group,type WorkTask,type BusinessObjectSnapshot} from '@teloa/contract'
import type {BusinessTarget} from './business-preview.js'
import type {GroupApi} from './group-api.ts'
import type {TaskApi} from './task-api.ts'
import type {ArtifactApi} from './artifact-api.ts'
import type {ArtifactVersion} from './artifact-preview.ts'
import type {BusinessTaskApi} from './business-task-api.ts'
import type {BusinessRecordApi} from './business-record-api.ts'

/** 版本化群资料只描述已保存工作的关系，不授予执行权限、不改写任务状态。 */
export const teamBriefTitle='AI 团队协作交付'
type FixedArtifact={id:string;version:number}
type Output={taskId:string;artifact:FixedArtifact;label:string}
type Step={id:string;roleId:string;taskId:string;label:string;artifact?:FixedArtifact}
export type TeamBrief={schema:'teloa.team-collaboration/v1';scope:string;groupId:string;summary:string;notes:string[];steps:Step[];handoffs:{from:string;to:string;label:string}[];deliveries:Output[];reviews:(Output&{roleId:string;reviewed:FixedArtifact[]})[];decisions:{type:string;id:string;pending:{field:string;value:string};label:string;reviewType?:string}[]}
export type TeamCollaborationServices={businessTasks?:Pick<BusinessTaskApi,'create'>|undefined;groups:Pick<GroupApi,'get'|'resources'|'resource'>;tasks:Pick<TaskApi,'list'>;artifacts:Pick<ArtifactApi,'get'|'feedback'>;records?:Pick<BusinessRecordApi,'get'|'list'|'create'>|undefined}
type VerifiedOutput=Output&{version:ArtifactVersion;task:WorkTask}
export type TeamCollaboration={group:Group;phase:'ready'|'unconfigured'|'failed';activeTasks:WorkTask[];brief?:TeamBrief;steps:(Step&{task:WorkTask})[];deliveries:VerifiedOutput[];reviews:VerifiedOutput[];decisions:{label:string;record:BusinessObjectSnapshot;reviewType?:string}[];ownerReviews:BusinessObjectSnapshot[]}
const fail=()=>Error('协作来源与当前业务、员工或固定成果不一致。')
const obj=(v:unknown):Record<string,unknown>=>{if(!v||typeof v!=='object'||Array.isArray(v))throw fail();return v as Record<string,unknown>}
const text=(v:unknown,max=2000):string=>{if(typeof v!=='string'||!v.trim()||v.length>max)throw fail();return v}
const uuid=(v:unknown)=>{const s=text(v,36);if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(s))throw fail();return s}
const arr=(v:unknown,max=24)=>{if(!Array.isArray(v)||v.length>max)throw fail();return v}
const ref=(v:unknown):FixedArtifact=>{const r=obj(v);if(!Number.isSafeInteger(r.version)||Number(r.version)<1)throw fail();return {id:uuid(r.id),version:Number(r.version)}}
const output=(v:unknown):Output=>{const r=obj(v);return {taskId:uuid(r.taskId),artifact:ref(r.artifact),label:text(r.label,200)}}
export function readTeamBrief(markdown:string,scope:string,groupId:string):TeamBrief{
 if(markdown.length>64000)throw fail()
 const r=obj(JSON.parse(markdown));if(r.schema!=='teloa.team-collaboration/v1'||r.scope!==scope||r.groupId!==groupId)throw fail()
 const steps=arr(r.steps).map(v=>{const s=obj(v);return {id:text(s.id,80),roleId:uuid(s.roleId),taskId:uuid(s.taskId),label:text(s.label,200),...(s.artifact?{artifact:ref(s.artifact)}:{})}})
 if(new Set(steps.map(s=>s.id)).size!==steps.length)throw fail()
 const handoffs=arr(r.handoffs).map(v=>{const h=obj(v),from=text(h.from,80),to=text(h.to,80);if(from===to||!steps.some(s=>s.id===from)||!steps.some(s=>s.id===to))throw fail();return {from,to,label:text(h.label,500)}})
 // 只接受无环关系；列表顺序、时间戳和共享样本都不能自行生成交接。
 const done=new Set<string>(),visiting=new Set<string>();const visit=(id:string)=>{if(visiting.has(id))throw fail();if(done.has(id))return;visiting.add(id);for(const h of handoffs.filter(h=>h.from===id))visit(h.to);visiting.delete(id);done.add(id)};for(const s of steps)visit(s.id)
 return {schema:r.schema,scope,groupId,summary:text(r.summary),notes:arr(r.notes,12).map(v=>text(v)),steps,handoffs,deliveries:arr(r.deliveries,12).map(output),reviews:arr(r.reviews,12).map(v=>{const s=obj(v);return {...output(v),roleId:uuid(s.roleId),reviewed:arr(s.reviewed).map(ref)}}),decisions:arr(r.decisions,12).map(v=>{const d=obj(v),p=obj(d.pending);return {type:text(d.type,80),id:text(d.id,200),label:text(d.label,200),...(d.reviewType?{reviewType:text(d.reviewType,80)}:{}),pending:{field:text(p.field,120),value:text(p.value,500)}}})}
}
/** 所有读取沿本人原生API；失效来源只令对应团队失败，不能回落成静态“通过”。 */
export async function loadBusinessTeamCollaboration(scope:string,groups:readonly Group[],api:TeamCollaborationServices,signal?:AbortSignal):Promise<TeamCollaboration[]>{
 const check=()=>signal?.throwIfAborted();check()
 const tasks=await api.tasks.list();check()
 const artifacts=new Map<string,ReturnType<ArtifactApi['get']>>()
 const artifact=(id:string)=>{let p=artifacts.get(id);if(!p){p=api.artifacts.get(id);artifacts.set(id,p)}return p}
 return Promise.all(groups.filter(g=>g.scope===scope&&!g.archived).map(async group=>{
  const activeTasks=tasks.filter(t=>t.scope===scope&&t.ownerId===group.ownerId&&t.groupId===group.id&&['ready','running','paused','blocked'].includes(t.state)).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)||a.id.localeCompare(b.id))
  const base={group,activeTasks,steps:[],deliveries:[],reviews:[],decisions:[],ownerReviews:[]}
  try{
   check();const [snapshot,directory]=await Promise.all([api.groups.get(group.id),api.groups.resources(group.id)]);check()
   if(snapshot.group.scope!==scope||snapshot.group.ownerId!==group.ownerId||snapshot.group.archived)throw fail()
   const sources=directory.items.filter(r=>r.title===teamBriefTitle&&!r.withdrawnAt)
   if(!sources.length)return {...base,phase:'unconfigured' as const}
   if(sources.length!==1)throw fail()
   const source=sources[0]!,saved=await api.groups.resource(group.id,source.id,source.version);check()
   const brief=readTeamBrief(saved.markdown,scope,group.id)
   const task=(id:string)=>{const t=tasks.find(t=>t.id===id&&t.scope===scope&&t.ownerId===group.ownerId);if(!t)throw fail();return t}
   const member=(id:string)=>{if(!snapshot.members.some(m=>m.roleId===id))throw fail()}
   const fixed=async(o:Output):Promise<VerifiedOutput>=>{const t=task(o.taskId),a=await artifact(o.artifact.id);check();const v=a.versions.find(v=>v.number===o.artifact.version)
    if(a.storage!=='persistent'||!v||v.source.scope!==scope||a.source.kind!=='task'||a.source.id!==t.id)throw fail();return {...o,task:t,version:v}}
   const steps=await Promise.all(brief.steps.map(async s=>{member(s.roleId);const t=task(s.taskId);if(t.assigneeRoleId!==s.roleId)throw fail();if(s.artifact)await fixed({...s,artifact:s.artifact});return {...s,task:t}}))
   const deliveries=await Promise.all(brief.deliveries.map(fixed))
   const reviews=await Promise.all(brief.reviews.map(async r=>{const row=await fixed(r);if(row.task.assigneeRoleId!==r.roleId||!r.reviewed.length)throw fail()
    for(const reviewed of r.reviewed){const a=deliveries.find(d=>d.artifact.id===reviewed.id&&d.artifact.version===reviewed.version);if(!a||a.task.assigneeRoleId===r.roleId)throw fail()}
    return row}))
   const ownerReviews:BusinessObjectSnapshot[]=[]
   const reviewPages=new Map<string,Promise<BusinessObjectSnapshot[]>>()
   const readReviews=(type:string)=>{let result=reviewPages.get(type);if(!result){result=(async()=>{const rows:BusinessObjectSnapshot[]=[];let cursor:string|undefined;do{const page=await api.records!.list({scope,type,limit:100,...(cursor?{cursor}:{})},signal);check();rows.push(...page.items);cursor=page.nextCursor;if(rows.length>=1000&&cursor)throw fail()}while(cursor);return rows})();reviewPages.set(type,result)}return result}
   const decisions=await Promise.all(brief.decisions.map(async d=>{if(!api.records)throw fail();const record=await api.records.get({scope,type:d.type,id:d.id});check();const field=record.fields.find(f=>f.label===d.pending.field);if(record.scope!==scope||record.type!==d.type||record.id!==d.id||!field)throw fail();const reviews=d.reviewType?(await readReviews(d.reviewType)).filter(r=>r.fields.some(f=>f.label==='subject'&&f.value===teamDecisionSubject(record))):[];ownerReviews.push(...reviews);return !record.deletedAt&&field.value===d.pending.value&&!reviews.length?{label:d.label,record,...(d.reviewType?{reviewType:d.reviewType}:{})}:null}))
   check();return {group:snapshot.group,activeTasks,phase:'ready' as const,brief,steps,deliveries,reviews,ownerReviews,decisions:decisions.filter((d):d is NonNullable<typeof d>=>d!==null)}
  }catch(error){check();return {...base,phase:'failed' as const}}
 }))
}

/** 本人的决定另存原生版本化业务记录，不修改AI候选、质检意见或历史Run。 */
export const teamDecisionSubject=(record:Pick<BusinessObjectSnapshot,'type'|'id'|'version'|'snapshotHash'>)=>JSON.stringify([record.type,record.id,record.version,record.snapshotHash])
export async function submitTeamDecision(api:Pick<BusinessRecordApi,'get'|'create'>,record:BusinessObjectSnapshot,policy:{reviewType:string},decision:'accepted'|'changes',note:string,requestId:string){
 if(decision!=='accepted'&&decision!=='changes'||note.length>1800||decision==='changes'&&!note.trim())throw Error('退回必须说明需要补充的内容。')
 const current=await api.get({scope:record.scope,type:record.type,id:record.id})
 if(current.deletedAt||current.version!==record.version||current.snapshotHash!==record.snapshotHash)throw Error('对象版本已变化，请刷新后重新审阅。')
 return api.create({requestId,scope:record.scope,type:policy.reviewType,title:record.title,summary:decision==='accepted'?'本人采用此版本研判；不授权额外执行。':'本人退回此版本补充；未授权额外执行。',fields:[{name:'subject',value:teamDecisionSubject(record)},{name:'target',value:record.id},{name:'decision',value:decision},{name:'note',value:note.trim()}]})
}

/** 正式记录页使用固定引用选页，不能误入旧行业台账。 */
export const teamRecordTarget=(record:BusinessObjectSnapshot):BusinessTarget=>({scope:record.scope,section:'data',objectType:record.type,id:record.id,recordReference:businessObjectReference({scope:record.scope,type:record.type,id:record.id,version:record.version,snapshotHash:record.snapshotHash})})

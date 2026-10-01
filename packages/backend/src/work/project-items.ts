import type {Pool,PoolClient} from 'pg'
import {WorkError,readProjectItem,readProjectReferenceItem,type ProjectItem,type ProjectLink,type ProjectLinkKind,type ProjectReference,type ProjectReferenceItem} from '@teloa/contract'

type Db=Pool|PoolClient
// 与群编辑（群→岗位）、计划变更（岗位→计划）和岗位退役（岗位→任务）保持一致。
const projectLockOrder:readonly ProjectLinkKind[]=['group','role','plan','task','resource','artifact']
// SQL 只由固定类型表决定；本人、范围、关键词和身份始终使用绑定参数。
const sources:Record<ProjectLinkKind,{select:string;from:string;where:string;id:string;title:string}>= {
 task:{select:"id,definition->>'title' as title,state,version",from:'teloa_tasks',where:"owner_id=$1 and definition->>'scope'=$2",id:'id',title:"definition->>'title'"},
 group:{select:"id,definition->>'name' as title,'active' as state,version",from:'teloa_groups',where:"owner_id=$1 and definition->>'scope'=$2 and not archived",id:'id',title:"definition->>'name'"},
 role:{select:"id,definition->>'name' as title,state,version",from:'teloa_roles',where:"owner_id=$1 and ($2='general' or definition->'scopes' ? $2) and state <> 'retired'",id:'id',title:"definition->>'name'"},
 plan:{select:"id,definition->>'title' as title,state,version",from:'teloa_plans',where:"owner_id=$1 and scope=$2 and state <> 'archived' and source->>'kind' <> 'system-digest'",id:'id',title:"definition->>'title'"},
 resource:{select:"id,spec->>'title' as title,status as state,revision as version",from:'teloa_resources',where:"owner_id=$1 and spec->'scopeIds' ? $2 and status='active'",id:'id',title:"spec->>'title'"},
 artifact:{select:"a.id,v.content->>'title' as title,'saved' as state,a.current_version as version",from:'teloa_artifacts a join teloa_artifact_versions v on v.owner_id=a.owner_id and v.artifact_id=a.id and v.number=a.current_version',where:"a.owner_id=$1 and v.source->>'scope'=$2",id:'a.id',title:"v.content->>'title'"},
}
function item(kind:ProjectLinkKind,row:Record<string,unknown>):ProjectItem{
 try{return readProjectItem({kind,id:row.id,title:row.title,state:row.state,version:row.version,available:true,origin:'direct',attention:null})}
 catch{throw new WorkError('teloa/storage-corrupt','项目关联对象记录损坏，请检查原对象。')}
}
export const unavailableProjectItem=(link:ProjectLink):ProjectItem=>({...link,title:null,state:null,version:null,available:false,origin:'direct',attention:null})
async function targets(db:Db,owner:string,kind:ProjectLinkKind,scope:string,ids:readonly string[],lock:boolean):Promise<Record<string,unknown>[]>{
 const q=sources[kind];return (await db.query(`select ${q.select} from ${q.from} where ${q.where} and ${q.id}=any($3::uuid[]) order by ${q.id}${lock?' for share':''}`,[owner,scope,ids])).rows
}
export const unavailableProjectReference=(ref:ProjectReference):ProjectReferenceItem=>({...ref,title:null,state:null,version:null,available:false})
const referenceKey=(ref:ProjectReference)=>ref.scope+':'+ref.kind+':'+ref.id
function referenceItem(ref:ProjectReference,row:Record<string,unknown>):ProjectReferenceItem{
 try{return readProjectReferenceItem({kind:ref.kind,id:row.id,scope:ref.scope,title:row.title,state:row.state,version:row.version,available:true})}
 catch{throw new WorkError('teloa/storage-corrupt','项目引用对象记录损坏，请检查原对象。')}
}
/**
 * 一趟读取（可加锁）本业务关联与跨业务引用的目标行：按 projectLockOrder 逐类进行，同一类里先本业务 links、再按 scope 升序的 references，
 * 保证 links+references 混合写入时只走一遍全局锁序。跨业务引用只做只读投影，不进入 items/summary，也不参与派生。
 */
export async function readProjectRelations(db:Db,owner:string,scope:string,links:readonly ProjectLink[],references:readonly ProjectReference[],lock=false):Promise<{items:ProjectItem[];references:ProjectReferenceItem[]}>{
 const foundItems=new Map<string,ProjectItem>(),foundRefs=new Map<string,ProjectReferenceItem>(),scopes=[...new Set(references.map(ref=>ref.scope))].sort()
 // UI 展示顺序不作为跨对象事务的加锁顺序。
 for(const kind of projectLockOrder){
  const ids=links.filter(link=>link.kind===kind).map(link=>link.id)
  if(ids.length)for(const row of await targets(db,owner,kind,scope,ids,lock)){const value=item(kind,row);foundItems.set(kind+':'+value.id,value)}
  for(const refScope of scopes){
   const group=references.filter(ref=>ref.kind===kind&&ref.scope===refScope);if(!group.length)continue
   for(const row of await targets(db,owner,kind,refScope,group.map(ref=>ref.id),lock)){const value=referenceItem(group[0]!,row);foundRefs.set(referenceKey(value),value)}
  }
 }
 return {items:links.map(link=>foundItems.get(link.kind+':'+link.id)??unavailableProjectItem(link)),references:references.map(ref=>foundRefs.get(referenceKey(ref))??unavailableProjectReference(ref))}
}
export async function readProjectItems(db:Db,owner:string,scope:string,links:readonly ProjectLink[],lock=false):Promise<ProjectItem[]>{return (await readProjectRelations(db,owner,scope,links,[],lock)).items}
export async function readProjectReferenceItems(db:Db,owner:string,references:readonly ProjectReference[],lock=false):Promise<ProjectReferenceItem[]>{return (await readProjectRelations(db,owner,'',[],references,lock)).references}
export async function projectCandidates(db:Db,owner:string,scope:string,kind:ProjectLinkKind,query:string):Promise<ProjectItem[]>{
 const q=sources[kind],rows=(await db.query(`select ${q.select} from ${q.from} where ${q.where} and strpos(lower(${q.title}),lower($3))>0 order by ${q.title},${q.id} limit 100`,[owner,scope,query])).rows
 return rows.map(row=>item(kind,row))
}
/** 只沿已存项目关系扩展：自动化任务和任务成果不靠同业务猜归属；`references`（跨业务引用）不参与派生。 */
export async function projectDerivedItems(db:PoolClient,owner:string,scope:string,direct:readonly ProjectItem[]):Promise<ProjectItem[]>{
 const merged=new Map(direct.map(value=>[value.kind+':'+value.id,value]))
 // 已归档自动化的历史依然属于这个项目；范围或本人已经不匹配则不扩展。
 const planIds=direct.filter(value=>value.kind==='plan').map(value=>value.id)
 if(planIds.length){
  const rows=(await db.query(`select distinct t.id from teloa_plan_task_links l
   join teloa_plan_occurrences o on o.id=l.claim_id and o.owner_id=l.owner_id
   join teloa_plans p on p.id=o.plan_id and p.owner_id=o.owner_id
   join teloa_tasks t on t.id=l.task_id and t.owner_id=l.owner_id
   where l.owner_id=$1 and p.scope=$2 and t.definition->>'scope'=$2 and p.id=any($3::uuid[]) order by t.id limit 10001`,[owner,scope,planIds])).rows
  if(rows.length>10000)throw new WorkError('teloa/conflict','项目关联的执行任务超过读取上限，请减少关联的自动化后重试。')
  const tasks=await readProjectItems(db,owner,scope,rows.map(row=>({kind:'task',id:row.id})))
  for(const task of tasks)if(!merged.has('task:'+task.id))merged.set('task:'+task.id,{...task,origin:'automation'})
 }
 const taskIds=[...merged.values()].filter(value=>value.kind==='task'&&value.available).map(value=>value.id)
 if(taskIds.length){
  const rows=(await db.query(`select a.id from teloa_artifacts a join teloa_artifact_versions v on v.owner_id=a.owner_id and v.artifact_id=a.id and v.number=a.current_version
   where a.owner_id=$1 and v.source->>'scope'=$2 and v.source->>'kind'='task' and v.source->>'id'=any($3::text[]) order by a.id limit 10001`,[owner,scope,taskIds])).rows
  if(rows.length>10000)throw new WorkError('teloa/conflict','项目成果超过读取上限，请减少关联任务后重试。')
  const artifacts=await readProjectItems(db,owner,scope,rows.map(row=>({kind:'artifact',id:row.id})))
  for(const artifact of artifacts)if(!merged.has('artifact:'+artifact.id))merged.set('artifact:'+artifact.id,{...artifact,origin:'task-output'})
 }
 return [...merged.values()]
}

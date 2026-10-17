import type {Pool,PoolClient} from 'pg'
import {WorkError,projectDefinition,groupWorkLinksChangeInput,groupWorkLinksGetInput,groupWorkLinksCandidatesInput,groupWorkLinkKey,readGroupWorkLink,readGroupWorkLinkItem,readGroupWorkLinks,type GroupWorkLink,type GroupWorkLinkItem,type GroupWorkLinks} from '@teloa/contract'
import {BusinessScopeService} from './business-scopes.ts'
import {businessObjectSnapshotHash,readBusinessObjectSnapshot} from './business-data.ts'
import {workAccess} from './work-access.ts'

const unavailable=(link:GroupWorkLink):GroupWorkLinkItem=>({...link,available:false,title:null,state:null,objectVersion:null})
const corrupt=()=>new WorkError('teloa/storage-corrupt','群关联工作记录损坏，已停止读取。')
const actor=(owner:string)=>{if(typeof owner!=='string'||!owner.trim()||owner.length>128)throw new WorkError('teloa/forbidden','需要有效的本人身份。')}
/** 这里只压缩关联行的显示摘要；原对象正文、状态与固定摘要保持原样。 */
const displayLabel=(value:string,limit:number,fallback='available')=>{
 const label=value.replace(/[\x00-\x1f\x7f\s]+/g,' ').trim()
 return label.length>limit?label.slice(0,limit-1)+'…':label||fallback
}
/** 新表只记录关联身份和不可变操作回执；原群、原对象与会话表保持不变。 */
export async function initializeGroupWorkLinks(pool:Pool):Promise<void>{await pool.query(`
 create table if not exists teloa_group_work_links(
  group_id uuid primary key references teloa_groups(id),owner_id text not null,version integer not null check(version>0),
  links jsonb not null check(jsonb_typeof(links)='array'),updated_at timestamptz not null);
 create table if not exists teloa_group_work_link_requests(
  owner_id text not null,request_id uuid not null,group_id uuid not null references teloa_groups(id),
  request_spec jsonb not null,result jsonb not null,created_at timestamptz not null,primary key(owner_id,request_id));
 `)}

/** 群关联正向与反向读取共用同一存储校验，不把损坏的关系投影为可信事实。 */
export function readStoredGroupWorkLinks(row:Record<string,unknown>|undefined):{version:number;links:GroupWorkLink[]}{
 if(!row)return {version:0,links:[]}
 try{if(!Number.isSafeInteger(row.version)||Number(row.version)<1||!Array.isArray(row.links)||row.links.length>100)throw Error();const links=row.links.map(readGroupWorkLink);if(new Set(links.map(groupWorkLinkKey)).size!==links.length)throw Error();return {version:Number(row.version),links}}catch{throw corrupt()}
}

/** 关系本身不等同于 Agent 的读取授权；执行侧仍须显式固定原对象的版本与范围。 */
export class GroupWorkLinkService{
 private readonly pool:Pool
 private readonly identity:{now:()=>string}
 constructor(pool:Pool,identity:{now:()=>string}){this.pool=pool;this.identity=identity}
 private async transaction<T>(operation:(db:PoolClient)=>Promise<T>,readOnly=false):Promise<T>{
  const db=await this.pool.connect()
  try{await db.query(readOnly?'begin isolation level repeatable read read only':'begin');const result=await operation(db);await db.query('commit');return result}
  catch(error){await db.query('rollback').catch(()=>{});throw error}finally{db.release()}
 }
 private async group(db:PoolClient,owner:string,id:string,lock=false){
  const row=(await db.query("select version,archived,definition->>'scope' scope from teloa_groups where owner_id=$1 and id=$2"+(lock?' for update':''),[owner,id])).rows[0]
  if(!row)throw new WorkError('teloa/not-found','群不存在或不可访问。')
  if(!Number.isSafeInteger(row.version)||row.version<1||typeof row.archived!=='boolean'||typeof row.scope!=='string')throw corrupt()
  return row as {version:number;archived:boolean;scope:string}
 }
 private async resolve(db:PoolClient,owner:string,link:GroupWorkLink):Promise<GroupWorkLinkItem>{
  if(!await BusinessScopeService.registered(db,owner,link.scope))return unavailable(link)
  if(link.kind==='business'){
   const row=(await db.query('select object_version,snapshot_hash,snapshot from teloa_business_object_snapshots where owner_id=$1 and scope_id=$2 and object_type=$3 and object_id=$4 order by object_version desc limit 1',[owner,link.scope,link.type,link.id])).rows[0]
   if(!row)return unavailable(link)
   let snapshot:ReturnType<typeof readBusinessObjectSnapshot>
   try{snapshot=readBusinessObjectSnapshot(row.snapshot,link.scope)}catch{throw corrupt()}
   if(snapshot.id!==link.id||snapshot.type!==link.type||snapshot.version!==row.object_version||businessObjectSnapshotHash(snapshot)!==row.snapshot_hash)throw corrupt()
   if(snapshot.deletedAt)return unavailable(link)
   const state=snapshot.fields.find(field=>['status','state','状态','狀態'].includes(field.label))?.value??'available'
   return readGroupWorkLinkItem({...link,available:true,title:displayLabel(snapshot.title,240),state:displayLabel(state,120),objectVersion:snapshot.version})
  }
  const table=link.kind==='task'?'teloa_tasks':'teloa_projects',state=link.kind==='task'?'state':"definition->>'state'"
  const row=(await db.query(`select version,definition->>'title' title,${state} state from ${table} where owner_id=$1 and id=$2 and definition->>'scope'=$3`,[owner,link.id,link.scope])).rows[0]
  if(!row||['archived','cancelled'].includes(row.state))return unavailable(link)
  try{return readGroupWorkLinkItem({...link,available:true,title:row.title,state:row.state,objectVersion:row.version})}catch{throw corrupt()}
 }
 /** 沿项目中同业务 links 或跨业务 references 反向读取；不写第二份关系或授权。 */
 private async projectLinks(db:PoolClient,owner:string,groupId:string,scope:string):Promise<GroupWorkLinkItem[]>{
  const rows=(await db.query(`select id,definition,version from teloa_projects where owner_id=$1 and
   ((definition->>'scope'=$2 and definition->'links' @> $3::jsonb) or definition->'references' @> $4::jsonb)
   order by id limit 10001`,[owner,scope,JSON.stringify([{kind:'group',id:groupId}]),JSON.stringify([{kind:'group',scope,id:groupId}])])).rows
  if(rows.length>10000)throw new WorkError('teloa/conflict','群关联项目超过读取上限，请减少原项目关联后重试。')
  const result:GroupWorkLinkItem[]=[]
  for(const row of rows){
   if(!row.definition||typeof row.definition.scope!=='string')throw corrupt()
   if(!await BusinessScopeService.registered(db,owner,row.definition.scope))continue
   let definition:ReturnType<typeof projectDefinition>
   try{definition=projectDefinition(row.definition)}catch{throw corrupt()}
   const matches=definition.scope===scope?definition.links.some(link=>link.kind==='group'&&link.id===groupId):definition.references.some(link=>link.kind==='group'&&link.scope===scope&&link.id===groupId)
   if(!matches)throw corrupt()
   result.push(await this.resolve(db,owner,{kind:'project',scope:definition.scope,id:row.id}))
  }
  return result
 }
 async get(owner:string,input:unknown):Promise<GroupWorkLinks>{
  actor(owner);const {groupId}=groupWorkLinksGetInput(input)
  return this.transaction(async db=>{
   const group=await this.group(db,owner,groupId),stored=readStoredGroupWorkLinks((await db.query('select version,links from teloa_group_work_links where owner_id=$1 and group_id=$2',[owner,groupId])).rows[0])
   const items:GroupWorkLinkItem[]=[];for(const link of stored.links)items.push(await this.resolve(db,owner,link))
   return readGroupWorkLinks({groupId,groupVersion:group.version,version:stored.version,items,projectLinks:await this.projectLinks(db,owner,groupId,group.scope)})
  },true)
 }
 async change(owner:string,input:unknown,signal?:AbortSignal,revalidate?:()=>Promise<void>):Promise<GroupWorkLinks>{
  actor(owner);const request=groupWorkLinksChangeInput(input),spec=JSON.stringify(request)
  return this.transaction(async db=>{
   signal?.throwIfAborted();await revalidate?.()
   await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['teloa/group-work-link',owner,request.requestId])])
   const group=await this.group(db,owner,request.groupId,true)
   const prior=(await db.query('select request_spec,result from teloa_group_work_link_requests where owner_id=$1 and request_id=$2',[owner,request.requestId])).rows[0]
   if(prior){if(JSON.stringify(prior.request_spec)!==spec){const normalized=groupWorkLinksChangeInput(prior.request_spec);if(JSON.stringify(normalized)!==spec)throw new WorkError('teloa/conflict','同一请求不能保存不同的群关联。')}try{return readGroupWorkLinks(prior.result)}catch{throw corrupt()}}
   if(group.archived)throw new WorkError('teloa/conflict','请先恢复群，再修改关联工作。')
   if(group.version!==request.expectedGroupVersion)throw new WorkError('teloa/version-conflict','群已更新，请刷新后再保存关联。')
   const current=readStoredGroupWorkLinks((await db.query('select version,links from teloa_group_work_links where owner_id=$1 and group_id=$2',[owner,request.groupId])).rows[0])
   if(current.version!==request.expectedVersion)throw new WorkError('teloa/version-conflict','关联工作已更新，请刷新后再保存。')
   const previous=new Set(current.links.map(groupWorkLinkKey)),items:GroupWorkLinkItem[]=[]
   for(const link of request.links){const item=await this.resolve(db,owner,link);if(!item.available&&!previous.has(groupWorkLinkKey(link)))throw new WorkError('teloa/forbidden','关联对象不存在、不可用或不属于当前本人。');items.push(item)}
   const admission=await workAccess.authorize({kind:'capability',capability:'groups',ownerId:owner,sessionId:null,objectId:request.groupId,operation:'edit'})
   signal?.throwIfAborted();await revalidate?.();signal?.throwIfAborted();admission.assertCurrent()
   const result=readGroupWorkLinks({groupId:request.groupId,groupVersion:group.version,version:current.version+1,items}),now=this.identity.now()
   await db.query('insert into teloa_group_work_links values($1,$2,$3,$4,$5) on conflict(group_id) do update set version=excluded.version,links=excluded.links,updated_at=excluded.updated_at',[request.groupId,owner,result.version,JSON.stringify(request.links),now])
   await db.query('insert into teloa_group_work_link_requests values($1,$2,$3,$4,$5,$6)',[owner,request.requestId,request.groupId,spec,JSON.stringify(result),now])
   signal?.throwIfAborted();await revalidate?.();signal?.throwIfAborted();admission.assertCurrent()
   return result
  })
 }
 async candidates(owner:string,input:unknown):Promise<GroupWorkLinkItem[]>{
  actor(owner);const query=groupWorkLinksCandidatesInput(input)
  return this.transaction(async db=>{
   await this.group(db,owner,query.groupId)
   if(!await BusinessScopeService.registered(db,owner,query.scope))throw new WorkError('teloa/forbidden','该业务不可访问。')
   let links:GroupWorkLink[]
   const needle='%'+query.query.replace(/[\\%_]/g,value=>'\\'+value)+'%'
   if(query.kind==='business'){
    const rows=(await db.query(`select * from (select distinct on (object_type,object_id) object_type,object_id,snapshot from teloa_business_object_snapshots where owner_id=$1 and scope_id=$2 order by object_type,object_id,object_version desc) latest where snapshot->>'deletedAt' is null and (snapshot->>'title' ilike $3 or object_id ilike $3) order by object_id limit 100`,[owner,query.scope,needle])).rows
    links=rows.map(row=>({kind:'business',scope:query.scope,type:row.object_type,id:row.object_id}))
   }else{
    const table=query.kind==='task'?'teloa_tasks':'teloa_projects',state=query.kind==='task'?'state':"definition->>'state'"
    const rows=(await db.query(`select id from ${table} where owner_id=$1 and definition->>'scope'=$2 and ${state} not in ('archived','cancelled') and definition->>'title' ilike $3 order by updated_at desc,id limit 100`,[owner,query.scope,needle])).rows
    links=rows.map(row=>({kind:query.kind as 'task'|'project',scope:query.scope,id:row.id}))
   }
   const items:GroupWorkLinkItem[]=[];for(const link of links){const item=await this.resolve(db,owner,link);if(item.available)items.push(item)}return items
  },true)
 }
}

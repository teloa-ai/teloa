import {createHash} from 'node:crypto'
import type {Pool,PoolClient} from 'pg'
import {WorkError,projectContextRead,projectContextMutation,readProjectContext,type ProjectContextDetail,type ProjectContextReceipt} from '@teloa/contract'
import {BusinessScopeService} from './business-scopes.ts'
const listeners=new WeakMap<Pool,Set<(owner:string,projectIds:readonly string[])=>void>>()
type MemoryAvailability=(db:PoolClient,owner:string,input:{entryId:string;entryVersion:number})=>Promise<boolean>
const availability=new WeakMap<Pool,Map<string,MemoryAvailability>>()
export function registerProjectMemoryAvailability(pool:Pool,owner:string,read:MemoryAvailability){if(!availability.has(pool))availability.set(pool,new Map());availability.get(pool)!.set(owner,read);return()=>{if(availability.get(pool)?.get(owner)===read)availability.get(pool)?.delete(owner)}}
export function subscribeProjectContextChanges(pool:Pool,listener:(owner:string,projectIds:readonly string[])=>void){if(!listeners.has(pool))listeners.set(pool,new Set());listeners.get(pool)!.add(listener);return()=>{listeners.get(pool)?.delete(listener)}}
const invalidate=(pool:Pool,owner:string,ids:readonly string[])=>{for(const listener of listeners.get(pool)??[])listener(owner,ids)}

/** 项目正文不注册到业务资料目录；修订不可变，分享只保存版本指针。 */
export async function initializeProjectContext(pool:Pool){
 await pool.query(`
  create table if not exists teloa_project_contexts(
   project_id uuid primary key references teloa_projects(id),version integer not null default 0 check(version>=0),brief text not null default ''
  );
  create table if not exists teloa_project_context_entries(
   id uuid primary key,project_id uuid not null references teloa_projects(id),kind text not null check(kind in ('rule','memory')),
   topic text not null,topic_key text not null,version integer not null check(version>0),state text not null check(state in ('active','withdrawn'))
  );
  create unique index if not exists teloa_project_context_entry_active_topic on teloa_project_context_entries(project_id,kind,topic_key) where state='active';
  alter table teloa_project_context_entries drop constraint if exists teloa_project_context_entries_project_id_kind_topic_key_key;
  create table if not exists teloa_project_context_revisions(
   entry_id uuid not null references teloa_project_context_entries(id),version integer not null check(version>0),markdown text not null,
   hash text not null,request_id uuid not null,created_at timestamptz not null,primary key(entry_id,version)
  );
  create table if not exists teloa_project_context_shares(
   id uuid primary key,source_project_id uuid not null references teloa_projects(id),target_project_id uuid not null references teloa_projects(id),
   entry_id uuid not null,entry_version integer not null,revoked boolean not null default false,request_id uuid not null,created_at timestamptz not null,
   foreign key(entry_id,entry_version) references teloa_project_context_revisions(entry_id,version),check(source_project_id<>target_project_id)
  );
  create unique index if not exists teloa_project_context_share_active on teloa_project_context_shares(entry_id,entry_version,target_project_id) where not revoked;
  create index if not exists teloa_project_context_share_target on teloa_project_context_shares(target_project_id);
  create table if not exists teloa_project_context_requests(
   owner_id text not null,request_id uuid not null,spec jsonb not null,receipt jsonb not null,primary key(owner_id,request_id)
  );
 `)
}
const missing=()=>new WorkError('teloa/not-found','项目上下文不存在或不可访问。')
const conflict=(message='项目上下文已改变，请刷新后核对。')=>new WorkError('teloa/conflict',message)
type ProjectRow={id:string;definition:{scope:string;title:string;state:string}}
export class ProjectContextService{
 readonly pool:Pool;readonly identity:{id:()=>string;now:()=>string}
 constructor(pool:Pool,identity:{id:()=>string;now:()=>string}){this.pool=pool;this.identity=identity}
 private owner(owner:string){if(typeof owner!=='string'||!owner.trim()||owner.length>128)throw new WorkError('teloa/forbidden','需要有效的本人身份。')}
 private async project(db:PoolClient,owner:string,id:string,lock=false):Promise<ProjectRow>{
  const row=(await db.query(`select id,definition from teloa_projects where owner_id=$1 and id=$2${lock?' for update':''}`,[owner,id])).rows[0] as ProjectRow|undefined
  if(!row||!await BusinessScopeService.registered(db,owner,row.definition.scope))throw missing()
  return row
 }
 private async read(db:PoolClient,owner:string,projectId:string,memory=true,checkAvailability=false):Promise<ProjectContextDetail>{
  await this.project(db,owner,projectId)
  const context=(await db.query('select version,brief from teloa_project_contexts where project_id=$1',[projectId])).rows[0]??{version:0,brief:''}
  const entries=(await db.query(`select e.id,e.kind,e.topic,e.version,e.state,case when e.state='active' then r.markdown else null end markdown,case when e.state='active' then r.hash else null end hash from teloa_project_context_entries e join teloa_project_context_revisions r on r.entry_id=e.id and r.version=e.version where e.project_id=$1 and ($2::boolean or e.kind='rule') order by case when e.state='active' then 0 else 1 end,e.kind,e.topic_key,e.id limit 200`,[projectId,memory])).rows
  const sourceAvailable=checkAvailability?availability.get(this.pool)?.get(owner):undefined
  if(sourceAvailable)for(const entry of entries)if(entry.state==='active'&&!await sourceAvailable(db,owner,{entryId:entry.id,entryVersion:entry.version})){entry.state='withdrawn';entry.topic='已失效来源';entry.markdown=null;entry.hash=null}
  const rows=memory?(await db.query(`select s.*,e.state,e.topic,e.version current_version,r.markdown,r.hash from teloa_project_context_shares s join teloa_project_context_entries e on e.id=s.entry_id join teloa_project_context_revisions r on r.entry_id=s.entry_id and r.version=s.entry_version where s.source_project_id=$1 or s.target_project_id=$1 order by case when not s.revoked and e.state='active' then 0 else 1 end,s.created_at,s.id limit 1000`,[projectId])).rows:[]
  const projects=new Map<string,ProjectRow|null>()
  for(const id of new Set<string>(rows.flatMap(r=>[r.source_project_id,r.target_project_id]))){try{projects.set(id,await this.project(db,owner,id))}catch(error){if(error instanceof WorkError&&error.code==='teloa/not-found')projects.set(id,null);else throw error}}
  const shares=[]
  for(const r of rows){
   const source=projects.get(r.source_project_id),target=projects.get(r.target_project_id),status=!source||!target?'unavailable':r.revoked?'revoked':r.state==='withdrawn'?'withdrawn':sourceAvailable&&!await sourceAvailable(db,owner,{entryId:r.entry_id,entryVersion:r.entry_version})?'unavailable':'active'
   shares.push({id:r.id,sourceProjectId:r.source_project_id,targetProjectId:r.target_project_id,sourceTitle:source?.definition.title??null,targetTitle:target?.definition.title??null,entryId:r.entry_id,entryVersion:r.entry_version,...(status==='active'?{currentVersion:r.current_version}:{}),topic:status==='active'?r.topic:null,markdown:status==='active'?r.markdown:null,hash:status==='active'?r.hash:null,status})
  }
  return readProjectContext({projectId,...context,entries,shares})
 }
 async get(owner:string,input:unknown):Promise<ProjectContextDetail>{
  this.owner(owner);const {projectId}=projectContextRead(input),db=await this.pool.connect()
  // 读取派生记忆还需正式资料服务的共享行锁；保持同一快照，不限制为 PG READ ONLY。
  try{await db.query('begin isolation level repeatable read');const value=await this.read(db,owner,projectId,true,true);await db.query('commit');return value}catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
 async readInTransaction(db:PoolClient,owner:string,projectId:string,memory=true){this.owner(owner);return this.read(db,owner,projectId,memory)}
 /** 采用用途的固定来源读取：本人项目未归档、条目当前 active 且版本精确、已注册的来源依据仍有效；任一不满足即拒绝，不返回部分正文。 */
 async readAdoptableEntryInTransaction(db:PoolClient,owner:string,input:{projectId:string;entryId:string;entryVersion:number}):Promise<{kind:'rule'|'memory';topic:string;markdown:string;hash:string}>{
  this.owner(owner)
  const project=await this.project(db,owner,input.projectId)
  if(project.definition.state==='archived')throw conflict('归档项目的经验不能采用为个人偏好，请先恢复项目。')
  const row=(await db.query('select e.kind,e.topic,e.version,e.state,r.markdown,r.hash from teloa_project_context_entries e join teloa_project_context_revisions r on r.entry_id=e.id and r.version=e.version where e.id=$1 and e.project_id=$2',[input.entryId,input.projectId])).rows[0]
  if(!row)throw missing()
  if(row.state!=='active'||row.version!==input.entryVersion)throw conflict('来源已撤回或版本已变化，请刷新后重新采用。')
  const sourceAvailable=availability.get(this.pool)?.get(owner)
  if(sourceAvailable&&!await sourceAvailable(db,owner,{entryId:input.entryId,entryVersion:input.entryVersion}))throw conflict('来源的原始依据已失效，不能采用。')
  return {kind:row.kind,topic:row.topic,markdown:row.markdown,hash:row.hash}
 }
 async mutate(owner:string,input:unknown,signal?:AbortSignal):Promise<ProjectContextReceipt>{
  const db=await this.pool.connect();try{await db.query('begin');const receipt=await this.mutateInTransaction(db,owner,input,signal);await db.query('commit');return receipt}catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
 async mutateInTransaction(db:PoolClient,owner:string,input:unknown,signal?:AbortSignal):Promise<ProjectContextReceipt>{
  this.owner(owner);const request=projectContextMutation(input),{projectId,requestId,expectedVersion,change}=request;signal?.throwIfAborted()
   // 本人事务按单一锁序串行，避免双向项目分享及级联撤回互锁。
   await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['teloa/project-context',owner])])
   const project=await this.project(db,owner,projectId,true)
   const replay=(await db.query('select spec,receipt from teloa_project_context_requests where owner_id=$1 and request_id=$2',[owner,requestId])).rows[0]
   if(replay){if(JSON.stringify(projectContextMutation(replay.spec))!==JSON.stringify(request))throw conflict('同一请求不能执行不同的上下文操作。');signal?.throwIfAborted();return replay.receipt}
   await db.query('insert into teloa_project_contexts(project_id) values($1) on conflict do nothing',[projectId])
   const version=(await db.query('select version from teloa_project_contexts where project_id=$1',[projectId])).rows[0].version
   if(version!==expectedVersion)throw new WorkError('teloa/version-conflict','项目上下文已改变，请刷新后核对。')
   if(project.definition.state==='archived'&&change.kind!=='withdraw-entry'&&change.kind!=='revoke-share')throw conflict('归档项目只能查看或撤回上下文。')
   const affected=new Set([projectId])
   if(change.kind==='save-brief')await db.query('update teloa_project_contexts set brief=$2 where project_id=$1',[projectId,change.brief])
   else if(change.kind==='save-entry'){
    let id=change.entryId,entryVersion=1
    const topicKey=change.topic.normalize('NFKC').toLocaleLowerCase('en-US')
    if(id){
     const old=(await db.query('select * from teloa_project_context_entries where id=$1 and project_id=$2',[id,projectId])).rows[0]
     if(!old)throw missing()
     if(old.state!=='active'||old.kind!==change.entryKind||old.topic!==change.topic)throw conflict('已保存条目的类型与主题不可改；撤回后请显式新建记录。')
     entryVersion=old.version+1
     await db.query('update teloa_project_context_entries set version=$2 where id=$1',[id,entryVersion])
    }else{
     if((await db.query("select 1 from teloa_project_context_entries where project_id=$1 and kind=$2 and topic_key=$3 and state='active'",[projectId,change.entryKind,topicKey])).rowCount)throw conflict('相同主题已有有效记录，请编辑现有内容。')
     if((await db.query("select count(*)::int n from teloa_project_context_entries where project_id=$1 and state='active'",[projectId])).rows[0].n>=200)throw conflict('项目上下文条目已达上限。')
     id=this.identity.id()
     await db.query("insert into teloa_project_context_entries(id,project_id,kind,topic,topic_key,version,state) values($1,$2,$3,$4,$5,1,'active')",[id,projectId,change.entryKind,change.topic,topicKey])
    }
    await db.query('insert into teloa_project_context_revisions(entry_id,version,markdown,hash,request_id,created_at) values($1,$2,$3,$4,$5,$6)',[id,entryVersion,change.markdown,createHash('sha256').update(change.markdown).digest('hex'),requestId,this.identity.now()])
   }else if(change.kind==='withdraw-entry'){
    const row=(await db.query("update teloa_project_context_entries set state='withdrawn' where id=$1 and project_id=$2 and state='active' returning id",[change.entryId,projectId])).rows[0]
    if(!row)throw missing()
    const targets=(await db.query('select distinct target_project_id from teloa_project_context_shares where entry_id=$1 and not revoked',[row.id])).rows
    for(const target of targets)affected.add(target.target_project_id)
   }else if(change.kind==='share'){
    const target=await this.project(db,owner,change.targetProjectId,true)
    if(target.definition.state==='archived')throw conflict('不能向归档项目新增分享。')
    const entry=(await db.query('select * from teloa_project_context_entries where id=$1 and project_id=$2',[change.entryId,projectId])).rows[0]
    if(!entry)throw missing()
    if(entry.state!=='active'||entry.kind!=='memory'||entry.version!==change.entryVersion)throw conflict('只能分享当前有效的记忆修订。')
    if((await db.query('select 1 from teloa_project_context_shares where entry_id=$1 and entry_version=$2 and target_project_id=$3 and not revoked',[change.entryId,change.entryVersion,change.targetProjectId])).rowCount)throw conflict('此版本已分享至目标项目。')
    for(const id of [projectId,change.targetProjectId])if((await db.query("select count(*)::int n from teloa_project_context_shares s join teloa_project_context_entries e on e.id=s.entry_id where (s.source_project_id=$1 or s.target_project_id=$1) and not s.revoked and e.state='active'",[id])).rows[0].n>=1000)throw conflict('项目分享记录已达上限。')
    await db.query('insert into teloa_project_context_shares(id,source_project_id,target_project_id,entry_id,entry_version,request_id,created_at) values($1,$2,$3,$4,$5,$6,$7)',[this.identity.id(),projectId,change.targetProjectId,change.entryId,change.entryVersion,requestId,this.identity.now()]);affected.add(change.targetProjectId)
   }else if(change.kind==='update-share'){
    const previous=(await db.query('select * from teloa_project_context_shares where id=$1 and target_project_id=$2 and not revoked',[change.shareId,projectId])).rows[0]
    if(!previous)throw missing()
    const source=await this.project(db,owner,previous.source_project_id,true)
    const current=(await db.query("select * from teloa_project_context_entries where id=$1 and project_id=$2 and state='active' and kind='memory'",[previous.entry_id,source.id])).rows[0]
    if(!current||current.version!==change.entryVersion||current.version<=previous.entry_version||source.definition.state==='archived')throw conflict('来源版本已变化，或没有可采用的新版本。')
    await db.query('update teloa_project_context_shares set revoked=true where id=$1',[previous.id])
    await db.query('insert into teloa_project_context_shares(id,source_project_id,target_project_id,entry_id,entry_version,request_id,created_at) values($1,$2,$3,$4,$5,$6,$7)',[this.identity.id(),source.id,projectId,current.id,current.version,requestId,this.identity.now()])
    affected.add(source.id)
   }else{
    const row=(await db.query('update teloa_project_context_shares set revoked=true where id=$1 and (source_project_id=$2 or target_project_id=$2) and not revoked returning source_project_id,target_project_id',[change.shareId,projectId])).rows[0]
    if(!row)throw missing();affected.add(row.source_project_id);affected.add(row.target_project_id)
   }
   for(const id of affected)await db.query('insert into teloa_project_contexts(project_id,version) values($1,1) on conflict(project_id) do update set version=teloa_project_contexts.version+1',[id])
   const receipt={projectId,requestId,version:expectedVersion+1}
   await db.query('insert into teloa_project_context_requests(owner_id,request_id,spec,receipt) values($1,$2,$3,$4)',[owner,requestId,JSON.stringify(request),JSON.stringify(receipt)])
   signal?.throwIfAborted();invalidate(this.pool,owner,[...affected]);return receipt
 }
}

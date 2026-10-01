import type {Pool,PoolClient} from 'pg'
import {WorkError,projectDefinition,projectInput,projectOverviewInput,projectUuid,projectLinkKinds,readProject,projectSummary,type WorkProject,type ProjectDefinition,type ProjectDetail,type ProjectLinkKind,type ProjectOverviewPage,type ProjectReference} from '@teloa/contract'
import {BusinessScopeService,assertBusinessScopeRegistered} from './business-scopes.ts'
import {readProjectItems,readProjectReferenceItems,readProjectRelations,unavailableProjectReference,projectCandidates,projectDerivedItems} from './project-items.ts'
import {TaskAttentionService} from './task-attention.ts'

/** references 回填是一次性迁移：迁移标记首次落下时才补齐存量缺键行，之后启动只剩一次主键插入尝试。 */
export async function initializeProjects(pool:Pool){
 const db=await pool.connect()
 try{
  await db.query('begin')
  await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',['teloa/project-migrations'])
  await db.query(`
   create table if not exists teloa_projects(
    id uuid primary key,owner_id text not null,request_id uuid not null,request_spec jsonb not null,
    definition jsonb not null,version integer not null check(version>0),created_at timestamptz not null,updated_at timestamptz not null,
    unique(owner_id,request_id),check(jsonb_typeof(definition)='object'),check(jsonb_typeof(request_spec)='object')
   );
   create index if not exists teloa_projects_owner_scope on teloa_projects(owner_id,(definition->>'scope'));
   create table if not exists teloa_project_edits(
    project_id uuid not null references teloa_projects(id),base_version integer not null check(base_version>0),
    request_spec jsonb not null,result jsonb not null,primary key(project_id,base_version)
   );
   create table if not exists teloa_project_migrations(name text primary key,applied_at timestamptz not null);
  `)
  const first=await db.query("insert into teloa_project_migrations(name,applied_at) values('references-backfill-v1',clock_timestamp()) on conflict(name) do nothing returning name")
  if(first.rowCount===1)await db.query(`
   update teloa_projects set definition=definition||'{"references":[]}' where not (definition ? 'references');
   update teloa_projects set request_spec=request_spec||'{"references":[]}' where not (request_spec ? 'references');
   update teloa_project_edits set request_spec=request_spec||'{"references":[]}' where not (request_spec ? 'references');
   update teloa_project_edits set result=result||'{"references":[]}' where not (result ? 'references');
  `)
  await db.query('commit')
 }catch(error){await db.query('rollback').catch(()=>{});throw error}finally{db.release()}
}
/**
 * 跨业务引用权限的写侧断言；与读侧占位（get）共享同一判据 referenceScopeAccessible。个人版：该业务范围已为本人登记即可访问。
 * 企业版按成员授权判定时，除替换 referenceScopeAccessible 外还需：放宽 project-items.ts 六张源表 SQL（sources）的 owner_id 条件、
 * 给 candidates 加同一判据、读侧 get 保持同一判据——三处缺一即会出现「能引用却读不到」或「能搜到却不能引用」。
 */
export async function assertReferenceScopeAccessible(db:Pool|PoolClient,owner:string,scope:string):Promise<void>{
 if(!await referenceScopeAccessible(db,owner,scope))throw referenceForbidden()
}
/** 写侧断言与读侧占位共用同一判据：读侧对失去可访问性的范围整组置为不可用占位，不报错也不泄露对方标题。 */
const referenceScopeAccessible=(db:Pool|PoolClient,owner:string,scope:string)=>BusinessScopeService.registered(db,owner,scope)
const referenceForbidden=()=>new WorkError('teloa/forbidden','引用对象不存在、不可用或不属于可访问的业务。')
const referenceKey=(ref:ProjectReference)=>ref.scope+':'+ref.kind+':'+ref.id
const invalid=()=>new WorkError('teloa/invalid-input','项目请求格式不正确。')
function ownerIdentity(value:string){if(typeof value!=='string'||!value.trim()||value.length>128)throw new WorkError('teloa/forbidden','需要有效的本人身份。')}
function scopeInput(value:unknown){if(typeof value!=='string'||!/^[a-zA-Z0-9_-]{1,64}$/.test(value))throw invalid();return value}
function read(row:Record<string,unknown>):WorkProject{
 try{
  if(!(row.created_at instanceof Date)||!(row.updated_at instanceof Date))throw Error()
  return readProject({...projectDefinition(row.definition),id:row.id,ownerId:row.owner_id,version:row.version,createdAt:row.created_at.toISOString(),updatedAt:row.updated_at.toISOString()})
 }catch{throw new WorkError('teloa/storage-corrupt','项目记录损坏，请检查原记录。')}
}
const same=(a:ProjectDefinition,b:ProjectDefinition)=>JSON.stringify(a)===JSON.stringify(b)
export class ProjectService{
 readonly pool:Pool;readonly identity:{id:()=>string;now:()=>string}
 constructor(pool:Pool,identity:{id:()=>string;now:()=>string}){this.pool=pool;this.identity=identity}
 private async transaction<T>(run:(db:PoolClient)=>Promise<T>,readOnly=false):Promise<T>{
  const db=await this.pool.connect()
  try{await db.query(readOnly?'begin isolation level repeatable read read only':'begin');const value=await run(db);await db.query('commit');return value}
  catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
 async list(owner:string,input:unknown):Promise<WorkProject[]>{
  ownerIdentity(owner);const row=projectInput(input,['scope']),scope=scopeInput(row.scope)
  return (await this.pool.query("select * from teloa_projects where owner_id=$1 and definition->>'scope'=$2 order by updated_at desc,id",[owner,scope])).rows.map(read)
 }
 async overview(owner:string,input:unknown):Promise<ProjectOverviewPage>{
  ownerIdentity(owner);const page=projectOverviewInput(input),args:unknown[]=[owner],where=['owner_id=$1']
  if(page.scope!==null){args.push(page.scope);where.push(`definition->>'scope'=$${args.length}`)}
  if(page.state==='current')where.push(`definition->>'state'<>'archived'`)
  else if(page.state!==null){args.push(page.state);where.push(`definition->>'state'=$${args.length}`)}
  // 次序与 list 一致（updated_at desc,id 升序），游标谓词按同一次序续读。
  if(page.cursor!==null){args.push(...page.cursor.split('|'));where.push(`(updated_at<$${args.length-1}::timestamptz or (updated_at=$${args.length-1}::timestamptz and id>$${args.length}::uuid))`)}
  args.push(page.limit+1)
  const rows=(await this.pool.query(`select * from teloa_projects where ${where.join(' and ')} order by updated_at desc,id limit $${args.length}`,args)).rows.map(read)
  const last=rows.length>page.limit?rows[page.limit-1]:undefined
  return {rows:rows.slice(0,page.limit),nextCursor:last?last.updatedAt+'|'+last.id:null}
 }
 async get(owner:string,input:unknown):Promise<ProjectDetail>{
  ownerIdentity(owner);const row=projectInput(input,['projectId']);if(!projectUuid(row.projectId))throw invalid()
  return this.transaction(async db=>{
   const raw=(await db.query('select * from teloa_projects where owner_id=$1 and id=$2',[owner,row.projectId])).rows[0]
   if(!raw)throw new WorkError('teloa/not-found','项目不存在或不可访问。')
   const project=read(raw),direct=await readProjectItems(db,owner,project.scope,project.links),items=await projectDerivedItems(db,owner,project.scope,direct)
   const attention=await new TaskAttentionService(this.pool).readInTransaction(db,owner,items.filter(item=>item.kind==='task'&&item.available).map(item=>item.id)),byId=new Map(attention.items.map(item=>[item.task.id,item.attention]))
   for(const item of items)if(item.kind==='task'&&item.available)item.attention=byId.get(item.id)?.kind??null
   const accessible=new Set<string>();for(const scope of new Set(project.references.map(ref=>ref.scope)))if(await referenceScopeAccessible(db,owner,scope))accessible.add(scope)
   const readable=new Map((await readProjectReferenceItems(db,owner,project.references.filter(ref=>accessible.has(ref.scope)))).map(item=>[referenceKey(item),item]))
   return {project,items,summary:projectSummary(items),references:project.references.map(ref=>readable.get(referenceKey(ref))??unavailableProjectReference(ref))}
  },true)
 }
 async candidates(owner:string,input:unknown){
  ownerIdentity(owner);const row=projectInput(input,['scope','kind','query']),scope=scopeInput(row.scope)
  if(!projectLinkKinds.includes(row.kind as ProjectLinkKind)||typeof row.query!=='string'||row.query.length>120)throw invalid()
  return projectCandidates(this.pool,owner,scope,row.kind as ProjectLinkKind,row.query.trim())
 }
 /** 新增的 links 与 references 一趟按全局锁序加锁校验；已存关系不重复加锁。 */
 private async validateRelations(db:PoolClient,owner:string,fields:ProjectDefinition,previous?:ProjectDefinition){
  const oldLinks=new Set(previous?.links.map(link=>link.kind+':'+link.id)),addedLinks=fields.links.filter(link=>!oldLinks.has(link.kind+':'+link.id))
  const oldRefs=new Set(previous?.references.map(referenceKey)),addedRefs=fields.references.filter(ref=>!oldRefs.has(referenceKey(ref)))
  for(const scope of new Set(addedRefs.map(ref=>ref.scope)))await assertReferenceScopeAccessible(db,owner,scope)
  const {items,references}=await readProjectRelations(db,owner,fields.scope,addedLinks,addedRefs,true)
  if(items.some(item=>!item.available))throw new WorkError('teloa/forbidden','关联对象不存在、不可用或不属于当前业务。')
  if(references.some(item=>!item.available))throw referenceForbidden()
 }
 async create(owner:string,input:unknown):Promise<WorkProject>{
  ownerIdentity(owner);const row=projectInput(input,['requestId','fields']),fields=projectDefinition(row.fields)
  if(!projectUuid(row.requestId)||fields.state!=='planning')throw invalid()
  return this.transaction(async db=>{
   await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['project-create',owner,row.requestId])])
   const existing=(await db.query('select * from teloa_projects where owner_id=$1 and request_id=$2 for update',[owner,row.requestId])).rows[0]
   if(existing){if(!same(projectDefinition(existing.request_spec),fields))throw new WorkError('teloa/conflict','同一请求不能创建不同的项目。');return read({...existing,definition:existing.request_spec,version:1,updated_at:existing.created_at})}
   await assertBusinessScopeRegistered(db,owner,fields.scope);await this.validateRelations(db,owner,fields)
   const now=this.identity.now(),result=await db.query('insert into teloa_projects(id,owner_id,request_id,request_spec,definition,version,created_at,updated_at) values($1,$2,$3,$4,$4,1,$5,$5) returning *',[this.identity.id(),owner,row.requestId,JSON.stringify(fields),now])
   return read(result.rows[0])
  })
 }
 async edit(owner:string,input:unknown):Promise<WorkProject>{
  ownerIdentity(owner);const row=projectInput(input,['projectId','expectedVersion','fields']),fields=projectDefinition(row.fields)
  if(!projectUuid(row.projectId)||!Number.isSafeInteger(row.expectedVersion)||Number(row.expectedVersion)<1)throw invalid()
  return this.transaction(async db=>{
   const raw=(await db.query('select * from teloa_projects where owner_id=$1 and id=$2 for update',[owner,row.projectId])).rows[0]
   if(!raw)throw new WorkError('teloa/not-found','项目不存在或不可访问。')
   const previous=read(raw),receipt=(await db.query('select * from teloa_project_edits where project_id=$1 and base_version=$2',[row.projectId,row.expectedVersion])).rows[0]
   if(receipt){if(!same(projectDefinition(receipt.request_spec),fields))throw new WorkError('teloa/version-conflict','项目已更新，请刷新后再编辑。');return readProject(receipt.result)}
   if(previous.version!==row.expectedVersion)throw new WorkError('teloa/version-conflict','项目已更新，请刷新后再编辑。')
   if(previous.scope!==fields.scope)throw new WorkError('teloa/invalid-input','项目创建后不能更改所属业务。')
   const previousFields=projectDefinition(raw.definition)
   if(previous.state==='archived'&&(fields.state==='archived'||!same({...previousFields,state:fields.state},fields)))throw new WorkError('teloa/conflict','请先恢复项目，再编辑内容或关联。')
   await this.validateRelations(db,owner,fields,previousFields)
   const updated=read((await db.query('update teloa_projects set definition=$3,version=version+1,updated_at=$4 where owner_id=$1 and id=$2 returning *',[owner,row.projectId,JSON.stringify(fields),this.identity.now()])).rows[0])
   await db.query('insert into teloa_project_edits(project_id,base_version,request_spec,result) values($1,$2,$3,$4)',[row.projectId,row.expectedVersion,JSON.stringify(fields),JSON.stringify(updated)])
   return updated
  })
 }
}

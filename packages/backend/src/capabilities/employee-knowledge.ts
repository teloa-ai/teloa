import {createHash} from 'node:crypto'
import type {Pool,PoolClient} from 'pg'
import {WorkError,isRecord,isWorkResource,isEmployeeKnowledgeContent,isEmployeeKnowledgeRevision,resourceId,resourceVersion,roleDefinition,type EmployeeKnowledgeContent,type EmployeeKnowledgeDocument,type EmployeeKnowledgeRevision,type EmployeeKnowledgeVersion,type EmployeeKnowledgeImportResetPreview,type PasteKnowledge,type WorkResource} from '@teloa/contract'
import {MarkdownKnowledgeService,normalizePasteMarkdown} from './markdown-knowledge.ts'
import {markdownKnowledgeReferenceId} from './markdown-knowledge-catalog.ts'
import {authorizeResourceActor,ResourceService,type ResourceActor} from './resources.ts'
import {retrievalChunker} from './retrieval-chunker.ts'

const bad=()=>new WorkError('teloa/invalid-input','员工知识请求格式不正确或包含未知字段。')
const corrupt=()=>new WorkError('teloa/storage-corrupt','员工知识绑定或版本记录损坏。')
const conflict=()=>new WorkError('teloa/version-conflict','员工知识已变化，请重新读取后编辑。')
const exact=(value:unknown,keys:string[]):Record<string,unknown>=>{if(!isRecord(value)||Object.keys(value).some(key=>!keys.includes(key)))throw bad();return value}
const hash=(value:string)=>createHash('sha256').update(value).digest('hex')
const digest=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)
const target=(input:unknown,extra:string[]=[]):Record<string,unknown>&{roleId:string;resourceId:string}=>{const row=exact(input,['roleId','resourceId',...extra]);if(!resourceId(row.roleId)||!resourceId(row.resourceId))throw bad();return {...row,roleId:row.roleId.toLowerCase(),resourceId:row.resourceId.toLowerCase()}}
const present=async(db:Pick<PoolClient,'query'>)=>(await db.query("select to_regclass('teloa_employee_knowledge_bindings') as present")).rows[0]?.present!=null
type Binding={owner_id:string;role_id:string;origin_resource_id:string;origin_document_id:string;knowledge_id:string;head_resource_id:string;origin:{resourceId:string;sourceId:string;sourceVersion:string}}

export async function initializeEmployeeKnowledge(pool:Pool):Promise<void>{await pool.query(`
 create table if not exists teloa_employee_knowledge_bindings(
  owner_id text not null,role_id uuid not null,origin_resource_id uuid not null references teloa_resources(id),origin_document_id text not null,
  knowledge_id uuid not null,head_resource_id uuid not null references teloa_resources(id),origin jsonb not null check(jsonb_typeof(origin)='object'),
  created_at timestamptz not null,updated_at timestamptz not null,
  primary key(owner_id,role_id,origin_document_id),unique(owner_id,role_id,origin_resource_id),unique(owner_id,knowledge_id),
  foreign key(owner_id,knowledge_id) references teloa_knowledge_items(owner_id,id)
 );
 create table if not exists teloa_employee_knowledge_versions(
  owner_id text not null,role_id uuid not null,origin_document_id text not null,body_version integer not null check(body_version>0),
  resource_id uuid not null references teloa_resources(id),content_hash text not null check(content_hash ~ '^[a-f0-9]{64}$'),bytes integer not null check(bytes>0 and bytes<=2097152),created_at timestamptz not null,
  primary key(owner_id,role_id,origin_document_id,body_version),unique(owner_id,role_id,resource_id),
  foreign key(owner_id,role_id,origin_document_id) references teloa_employee_knowledge_bindings(owner_id,role_id,origin_document_id)
 );
 create table if not exists teloa_employee_knowledge_operations(
  owner_id text not null,request_id uuid not null,role_id uuid not null,origin_resource_id uuid not null,
  request_spec jsonb not null check(jsonb_typeof(request_spec)='object'),result jsonb not null check(jsonb_typeof(result)='object'),created_at timestamptz not null,
  primary key(owner_id,request_id)
 );
 create table if not exists teloa_employee_knowledge_archives(
  owner_id text not null,knowledge_id uuid not null,role_id uuid not null,origin_resource_id uuid not null,origin_document_id text not null,
  reset_id uuid not null,reset_digest text not null check(reset_digest ~ '^[a-f0-9]{64}$'),binding jsonb not null,versions jsonb not null,created_at timestamptz not null,
  primary key(owner_id,knowledge_id),check(jsonb_typeof(binding)='object'),check(jsonb_typeof(versions)='array')
 );
 create table if not exists teloa_employee_knowledge_baselines(
  owner_id text not null,role_id uuid not null,origin_resource_id uuid not null references teloa_resources(id),current_resource_id uuid not null references teloa_resources(id),
  origin_document_id text not null,updated_at timestamptz not null,primary key(owner_id,role_id,origin_resource_id)
 );
 create table if not exists teloa_employee_knowledge_baseline_refs(
  owner_id text not null,role_id uuid not null,origin_resource_id uuid not null,resource_id uuid not null references teloa_resources(id),
  primary key(owner_id,role_id,resource_id)
 );
 create table if not exists teloa_employee_knowledge_import_transitions(
  owner_id text not null,role_id uuid not null,origin_resource_id uuid not null,previous_resource_id uuid not null,
  load_id uuid not null,state text not null check(state in ('pending','completed','cancelled')),created_at timestamptz not null,updated_at timestamptz not null,
  primary key(owner_id,role_id,origin_resource_id)
 );
 create table if not exists teloa_employee_knowledge_retirements(
  owner_id text not null,role_id uuid not null,origin_resource_id uuid not null,removed_resource_id uuid not null,
  local_id text not null,load_id uuid not null,created_at timestamptz not null,updated_at timestamptz not null,
  primary key(owner_id,role_id,origin_resource_id)
 );
 create table if not exists teloa_employee_knowledge_source_retirements(
  owner_id text not null,source_id text not null,source_version text not null,resource_id uuid not null,
  load_id uuid not null,created_at timestamptz not null,primary key(owner_id,source_id,source_version)
 );
 create or replace function teloa_reject_employee_knowledge_history_mutation() returns trigger language plpgsql as $$ begin
  if TG_TABLE_NAME='teloa_employee_knowledge_versions' then
   if TG_OP='DELETE' then
    if exists(select 1 from teloa_employee_knowledge_archives a where a.owner_id=OLD.owner_id and a.role_id=OLD.role_id and a.origin_document_id=OLD.origin_document_id
     and exists(select 1 from jsonb_array_elements(a.versions) v where v->>'resource_id'=OLD.resource_id::text and (v->>'body_version')::integer=OLD.body_version)) then return OLD; end if;
   end if;
  end if;
  raise exception 'employee knowledge history is immutable'; end $$;
 drop trigger if exists teloa_employee_knowledge_versions_immutable on teloa_employee_knowledge_versions;
 create trigger teloa_employee_knowledge_versions_immutable before update or delete on teloa_employee_knowledge_versions for each row execute function teloa_reject_employee_knowledge_history_mutation();
 drop trigger if exists teloa_employee_knowledge_operations_immutable on teloa_employee_knowledge_operations;
 create trigger teloa_employee_knowledge_operations_immutable before update or delete on teloa_employee_knowledge_operations for each row execute function teloa_reject_employee_knowledge_history_mutation();
 drop trigger if exists teloa_employee_knowledge_archives_immutable on teloa_employee_knowledge_archives;
 create trigger teloa_employee_knowledge_archives_immutable before update or delete on teloa_employee_knowledge_archives for each row execute function teloa_reject_employee_knowledge_history_mutation();
 drop trigger if exists teloa_employee_knowledge_source_retirements_immutable on teloa_employee_knowledge_source_retirements;
 create trigger teloa_employee_knowledge_source_retirements_immutable before update or delete on teloa_employee_knowledge_source_retirements for each row execute function teloa_reject_employee_knowledge_history_mutation();
`)}

type ImportResetScope={roleIds?:string[];originResourceIds:string[]}
const pendingImport=()=>new WorkError('teloa/conflict','新版包知识正在接入；可查看旧正文，请先完成新版资料接入后再保存或准备新工作。',{reason:'employee-knowledge-import-pending'})
async function assertImportReady(db:Pick<PoolClient,'query'>,owner:string,roleId:string,resourceIds:readonly string[]):Promise<void>{
 if(!resourceIds.length)return
 if((await db.query('select 1 from teloa_employee_knowledge_import_transitions where owner_id=$1 and role_id=$2 and state=\'pending\' and (origin_resource_id=any($3::uuid[]) or previous_resource_id=any($3::uuid[])) limit 1',[owner,roleId,resourceIds])).rowCount)throw pendingImport()
}
/** 与升级加载同事务固定待接入状态；在途固定读不消费此门槛。 */
export async function stageEmployeeKnowledgeImportBaselinesInTransaction(db:PoolClient,owner:string,input:{previousResourceIds:string[];loadId:string;now:string}):Promise<void>{
 if(!resourceId(input.loadId)||!Number.isFinite(Date.parse(input.now))||!Array.isArray(input.previousResourceIds)||input.previousResourceIds.some(id=>!resourceId(id)))throw bad()
 if(!input.previousResourceIds.length||!await present(db))return
 const roles=(await db.query(`select id,definition from teloa_roles r where r.owner_id=$1 and (r.definition->'knowledge' ?| $2::text[] or exists(select 1 from teloa_employee_knowledge_baselines b where b.owner_id=r.owner_id and b.role_id=r.id and b.current_resource_id=any($2::uuid[]))) order by r.id for update`,[owner,input.previousResourceIds])).rows
 for(const role of roles){
  const aliases=(await db.query('select origin_resource_id,current_resource_id from teloa_employee_knowledge_baselines where owner_id=$1 and role_id=$2 and current_resource_id=any($3::uuid[])',[owner,role.id,input.previousResourceIds])).rows
  const fields=roleDefinition(role.definition),origins=[...aliases.map(row=>({origin:row.origin_resource_id,previous:row.current_resource_id})),...fields.knowledge.filter(id=>input.previousResourceIds.includes(id)&&!aliases.some(row=>row.origin_resource_id===id)).map(id=>({origin:id,previous:id}))]
  for(const origin of origins)await db.query(`insert into teloa_employee_knowledge_import_transitions values($1,$2,$3,$4,$5,'pending',$6,$6)
   on conflict(owner_id,role_id,origin_resource_id) do update set previous_resource_id=excluded.previous_resource_id,load_id=excluded.load_id,state='pending',created_at=excluded.created_at,updated_at=excluded.updated_at`,[owner,role.id,origin.origin,origin.previous,input.loadId,input.now])
 }
}
export async function cancelEmployeeKnowledgeImportBaselinesInTransaction(db:PoolClient,owner:string,loadId:string,now:string):Promise<void>{
 if(!resourceId(loadId)||!Number.isFinite(Date.parse(now)))throw bad()
 if(await present(db))await db.query("update teloa_employee_knowledge_import_transitions set state='cancelled',updated_at=$3 where owner_id=$1 and load_id=$2 and state='pending'",[owner,loadId,now])
}
/** 包移除项仅影响未来使用；既有执行的固定正文和反向授权身份保留。 */
export async function retireEmployeeKnowledgeImportDocumentsInTransaction(db:PoolClient,owner:string,input:{previousLoadId:string;loadId:string;resources:{resourceId:string;localId:string}[];now:string}):Promise<void>{
 if(!resourceId(input.previousLoadId)||!resourceId(input.loadId)||!Number.isFinite(Date.parse(input.now))||!Array.isArray(input.resources)||input.resources.some(row=>!resourceId(row.resourceId)||typeof row.localId!=='string'||!row.localId))throw bad()
 if(!await present(db))return
 await db.query('update teloa_employee_knowledge_retirements set load_id=$3,updated_at=$4 where owner_id=$1 and load_id=$2',[owner,input.previousLoadId,input.loadId,input.now])
 for(const removed of input.resources){
  await db.query(`insert into teloa_employee_knowledge_source_retirements select owner_id,spec->>'sourceId',spec->>'sourceVersion',id,$3,$4 from teloa_resources where owner_id=$1 and id=$2 on conflict do nothing`,[owner,removed.resourceId,input.loadId,input.now])
  const roles=(await db.query(`select id,definition from teloa_roles r where r.owner_id=$1 and (r.definition->'knowledge' ? $2 or exists(select 1 from teloa_employee_knowledge_baselines b where b.owner_id=r.owner_id and b.role_id=r.id and b.current_resource_id=$2::uuid)) order by r.id for update`,[owner,removed.resourceId])).rows
  for(const role of roles){
   const aliases=(await db.query('select origin_resource_id from teloa_employee_knowledge_baselines where owner_id=$1 and role_id=$2 and current_resource_id=$3',[owner,role.id,removed.resourceId])).rows
   const origins=aliases.length?aliases.map(row=>String(row.origin_resource_id)):[removed.resourceId]
   for(const origin of origins){
    await db.query(`insert into teloa_employee_knowledge_retirements values($1,$2,$3,$4,$5,$6,$7,$7) on conflict(owner_id,role_id,origin_resource_id) do update set removed_resource_id=excluded.removed_resource_id,local_id=excluded.local_id,load_id=excluded.load_id,updated_at=excluded.updated_at`,[owner,role.id,origin,removed.resourceId,removed.localId,input.loadId,input.now])
    await db.query("update teloa_employee_knowledge_import_transitions set state='cancelled',updated_at=$4 where owner_id=$1 and role_id=$2 and origin_resource_id=$3 and state='pending'",[owner,role.id,origin,input.now])
   }
  }
 }
}
export async function removedEmployeeKnowledgeReferences(db:Pick<PoolClient,'query'>,owner:string,roleId:string,ids:readonly string[]):Promise<string[]>{
 const references=ids.filter(resourceId).map(id=>id.toLowerCase())
 if(!references.length||!await present(db))return []
 const removed=(await db.query('select origin_resource_id,removed_resource_id from teloa_employee_knowledge_retirements where owner_id=$1 and role_id=$2 and (origin_resource_id=any($3::uuid[]) or removed_resource_id=any($3::uuid[]))',[owner,roleId,references])).rows
 return ids.filter(id=>removed.some(row=>row.origin_resource_id===id.toLowerCase()||row.removed_resource_id===id.toLowerCase()))
}
function resetScope(input:ImportResetScope):ImportResetScope{
 if(!Array.isArray(input.originResourceIds)||input.originResourceIds.some(id=>!resourceId(id))||input.roleIds!==undefined&&(!Array.isArray(input.roleIds)||input.roleIds.some(id=>!resourceId(id))))throw bad()
 return {originResourceIds:[...new Set(input.originResourceIds.map(id=>id.toLowerCase()))].sort(),...(input.roleIds===undefined?{}:{roleIds:[...new Set(input.roleIds.map(id=>id.toLowerCase()))].sort()})}
}
/** 导入服务从该包已登记实例取得 scope；不可直接转发浏览器提供的任意资源列表。 */
export async function previewEmployeeKnowledgeImportResetInTransaction(db:Pick<PoolClient,'query'>,owner:string,input:ImportResetScope):Promise<EmployeeKnowledgeImportResetPreview>{
 const scope=resetScope(input)
 if(!owner)throw new WorkError('teloa/forbidden','需要有效本人身份。')
 const rows=scope.originResourceIds.length&&await present(db)?(await db.query(`select b.role_id,b.origin_resource_id,b.knowledge_id,i.current_version,v.content_hash,i.title
  from teloa_employee_knowledge_bindings b join teloa_knowledge_items i on i.owner_id=b.owner_id and i.id=b.knowledge_id
  join teloa_knowledge_versions v on v.owner_id=i.owner_id and v.knowledge_id=i.id and v.number=i.current_version
  where b.owner_id=$1 and (b.origin_resource_id=any($2::uuid[]) or exists(select 1 from teloa_employee_knowledge_baselines e where e.owner_id=b.owner_id and e.role_id=b.role_id and e.origin_resource_id=b.origin_resource_id and e.current_resource_id=any($2::uuid[]))) and ($3::uuid[] is null or b.role_id=any($3::uuid[])) order by b.role_id,b.origin_resource_id`,[owner,scope.originResourceIds,scope.roleIds??null])).rows:[]
 const documents=rows.map(row=>({roleId:row.role_id,resourceId:row.origin_resource_id,knowledgeId:row.knowledge_id,bodyVersion:row.current_version,contentHash:row.content_hash,title:row.title}))
 const baselines=scope.originResourceIds.length&&await present(db)?(await db.query(`select b.role_id,b.origin_resource_id,b.current_resource_id,r.revision,r.status,r.spec from teloa_employee_knowledge_baselines b join teloa_resources r on r.owner_id=b.owner_id and r.id=b.current_resource_id where b.owner_id=$1 and (b.origin_resource_id=any($2::uuid[]) or b.current_resource_id=any($2::uuid[])) and ($3::uuid[] is null or b.role_id=any($3::uuid[])) order by b.role_id,b.origin_resource_id`,[owner,scope.originResourceIds,scope.roleIds??null])).rows:[]
 return {digest:hash(JSON.stringify({owner,scope,documents,baselines})),documents}
}
export async function confirmEmployeeKnowledgeImportResetInTransaction(db:PoolClient,owner:string,input:ImportResetScope&{expectedDigest:string;resetId:string;now:string}):Promise<EmployeeKnowledgeImportResetPreview>{
 const scope=resetScope(input)
 if(!digest(input.expectedDigest)||!resourceId(input.resetId)||!Number.isFinite(Date.parse(input.now)))throw bad()
 if(await present(db)){
  // 与编辑同取员工锁，然后取知识锁；锁定后重算摘要，拒绝确认窗口中的本地修改。
  const preliminary=await previewEmployeeKnowledgeImportResetInTransaction(db,owner,scope),roles=scope.roleIds??[...new Set(preliminary.documents.map(row=>row.roleId))]
  if(roles.length)await db.query('select id from teloa_roles where owner_id=$1 and id=any($2::uuid[]) order by id for update',[owner,roles])
  if(preliminary.documents.length)await db.query('select id from teloa_knowledge_items where owner_id=$1 and id=any($2::uuid[]) order by id for update',[owner,preliminary.documents.map(row=>row.knowledgeId)])
 }
 const preview=await previewEmployeeKnowledgeImportResetInTransaction(db,owner,scope)
 if(preview.digest!==input.expectedDigest)throw new WorkError('teloa/version-conflict','确认后包关联知识又有修改，请重新核对将被覆盖的版本。',{reason:'employee-knowledge-import-reset',preview})
 for(const document of preview.documents){
  const binding=(await db.query('select * from teloa_employee_knowledge_bindings where owner_id=$1 and knowledge_id=$2 for update',[owner,document.knowledgeId])).rows[0]
  const versions=(await db.query('select * from teloa_employee_knowledge_versions where owner_id=$1 and role_id=$2 and origin_document_id=$3 order by body_version',[owner,document.roleId,binding.origin_document_id])).rows
  await db.query('insert into teloa_employee_knowledge_archives values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[owner,document.knowledgeId,document.roleId,document.resourceId,binding.origin_document_id,input.resetId,input.expectedDigest,JSON.stringify(binding),JSON.stringify(versions),input.now])
  await db.query('delete from teloa_employee_knowledge_versions where owner_id=$1 and role_id=$2 and origin_document_id=$3',[owner,document.roleId,binding.origin_document_id])
  await db.query('delete from teloa_employee_knowledge_bindings where owner_id=$1 and knowledge_id=$2',[owner,document.knowledgeId])
  const taskRuns=(await db.query("select to_regclass('teloa_task_runs') as present")).rows[0]?.present!=null
  const fixed=taskRuns&&(await db.query("select 1 from teloa_task_runs r where r.owner_id=$1 and exists(select 1 from jsonb_array_elements(r.role_knowledge) k where k->>'sourceId'=$2) limit 1",[owner,markdownKnowledgeReferenceId(document.knowledgeId)])).rowCount
  if(!fixed)await db.query('delete from teloa_retrieval_enrollments where owner_id=$1 and source_id=$2',[owner,markdownKnowledgeReferenceId(document.knowledgeId)])
  await db.query('update teloa_knowledge_nodes set archived=true where owner_id=$1 and knowledge_id=$2',[owner,document.knowledgeId])
 }
 if(preview.documents.length){
  await db.query(`with ranked as(select owner_id,id,row_number() over(partition by owner_id,space_id,parent_id order by sibling_order,id)-1 as position from teloa_knowledge_nodes where owner_id=$1 and not archived and node_type<>'space') update teloa_knowledge_nodes n set sibling_order=r.position from ranked r where n.owner_id=r.owner_id and n.id=r.id`,[owner])
  await db.query('update teloa_knowledge_spaces set directory_revision=directory_revision+1,updated_at=$2 where owner_id=$1',[owner,input.now])
 }
 return preview
}

/** 新包知识实例正式提交后，按旧包资源身份推进基线；员工定义和授权版本保持不变。 */
export async function replaceEmployeeKnowledgeImportBaselineInTransaction(db:PoolClient,owner:string,input:{previousResourceId:string;resourceId:string;now:string}):Promise<void>{
 if(!resourceId(input.previousResourceId)||!resourceId(input.resourceId)||!Number.isFinite(Date.parse(input.now)))throw bad()
 if(!await present(db))return
 const resources=(await db.query('select * from teloa_resources where owner_id=$1 and id=any($2::uuid[]) order by id for share',[owner,[input.previousResourceId,input.resourceId]])).rows
 const previous=resources.find(row=>row.id===input.previousResourceId),next=resources.find(row=>row.id===input.resourceId)
 if(!previous||!next||next.status!=='active'||!isRecord(previous.spec)||!isRecord(next.spec))throw new WorkError('teloa/forbidden','包知识基线资源不可用。')
 await db.query('insert into teloa_retrieval_enrollments(owner_id,source_id,created_at) select $1,$2,$3 where exists(select 1 from teloa_retrieval_enrollments where owner_id=$1 and source_id=$4) on conflict do nothing',[owner,next.spec.sourceId,input.now,previous.spec.sourceId])
 const roles=(await db.query(`select id,definition from teloa_roles r where r.owner_id=$1 and (r.definition->'knowledge' ? $2 or exists(select 1 from teloa_employee_knowledge_baselines b where b.owner_id=r.owner_id and b.role_id=r.id and b.current_resource_id=$2::uuid)) order by r.id for update`,[owner,input.previousResourceId])).rows
 for(const role of roles){
  const aliases=(await db.query('select * from teloa_employee_knowledge_baselines where owner_id=$1 and role_id=$2 and current_resource_id=$3',[owner,role.id,input.previousResourceId])).rows
  const origins=aliases.length?aliases.map(row=>({id:row.origin_resource_id,documentId:row.origin_document_id})):[{id:input.previousResourceId,documentId:previous.spec.sourceId}]
  for(const origin of origins){
   const existing=(await db.query('select current_resource_id from teloa_employee_knowledge_baselines where owner_id=$1 and role_id=$2 and origin_resource_id=$3',[owner,role.id,origin.id])).rows[0]
   if(existing?.current_resource_id===input.resourceId)continue
   if((await db.query('select 1 from teloa_employee_knowledge_bindings where owner_id=$1 and role_id=$2 and origin_resource_id=$3',[owner,role.id,origin.id])).rowCount)throw new WorkError('teloa/conflict','本地知识在导入期间又被修改，请重新确认覆盖。')
   await db.query('insert into teloa_employee_knowledge_baselines values($1,$2,$3,$4,$5,$6) on conflict(owner_id,role_id,origin_resource_id) do update set current_resource_id=excluded.current_resource_id,updated_at=excluded.updated_at',[owner,role.id,origin.id,input.resourceId,origin.documentId,input.now])
   await db.query('insert into teloa_employee_knowledge_baseline_refs(owner_id,role_id,origin_resource_id,resource_id) select $1,$2,$3,unnest($4::uuid[]) on conflict do nothing',[owner,role.id,origin.id,[input.previousResourceId,input.resourceId]])
   await db.query('delete from teloa_employee_knowledge_retirements where owner_id=$1 and role_id=$2 and origin_resource_id=$3',[owner,role.id,origin.id])
   await db.query("update teloa_employee_knowledge_import_transitions set state='completed',updated_at=$5 where owner_id=$1 and role_id=$2 and origin_resource_id=$3 and previous_resource_id=$4 and state='pending'",[owner,role.id,origin.id,input.previousResourceId,input.now])
  }
 }
}

async function mapping(db:Pick<PoolClient,'query'>,owner:string,roleId:string,ids:readonly string[],reverse:boolean,allowPending=false):Promise<string[]>{
 if(!ids.length||!await present(db))return [...ids]
 const originalReferences=ids.filter(resourceId).map(id=>id.toLowerCase())
 if(!reverse&&!allowPending)await assertImportReady(db,owner,roleId,originalReferences)
 const removed=reverse?[]:await removedEmployeeKnowledgeReferences(db,owner,roleId,ids),effective=ids.filter(id=>!removed.includes(id)),references=effective.filter(resourceId).map(id=>id.toLowerCase())
 if(!references.length)return [...effective]
 const rows=(await db.query(`select b.*,o.status as origin_status,h.status as head_status,v.resource_id as historical_resource_id,br.status as baseline_status
  from teloa_employee_knowledge_bindings b join teloa_resources o on o.id=b.origin_resource_id and o.owner_id=b.owner_id
  join teloa_resources h on h.id=b.head_resource_id and h.owner_id=b.owner_id
  left join teloa_employee_knowledge_versions v on v.owner_id=b.owner_id and v.role_id=b.role_id and v.origin_document_id=b.origin_document_id
  left join teloa_employee_knowledge_baselines baseline on baseline.owner_id=b.owner_id and baseline.role_id=b.role_id and baseline.origin_resource_id=b.origin_resource_id
  left join teloa_resources br on br.owner_id=baseline.owner_id and br.id=baseline.current_resource_id
  where b.owner_id=$1 and b.role_id=$2 and (b.origin_resource_id=any($3::uuid[]) or v.resource_id=any($3::uuid[]))`,[owner,roleId,references])).rows
 const baselines=(await db.query(`select b.*,o.status as origin_status,h.status as head_status,ref.resource_id as historical_resource_id from teloa_employee_knowledge_baselines b
  join teloa_resources o on o.id=b.origin_resource_id and o.owner_id=b.owner_id join teloa_resources h on h.id=b.current_resource_id and h.owner_id=b.owner_id
  left join teloa_employee_knowledge_baseline_refs ref on ref.owner_id=b.owner_id and ref.role_id=b.role_id and ref.origin_resource_id=b.origin_resource_id
  where b.owner_id=$1 and b.role_id=$2 and (b.origin_resource_id=any($3::uuid[]) or b.current_resource_id=any($3::uuid[]) or ref.resource_id=any($3::uuid[]))`,[owner,roleId,references])).rows
 const archives=reverse?(await db.query(`select a.origin_resource_id,a.origin_document_id,v->>'resource_id' as historical_resource_id,o.status as origin_status,h.status as head_status
  from teloa_employee_knowledge_archives a cross join lateral jsonb_array_elements(a.versions) v
  join teloa_resources o on o.owner_id=a.owner_id and o.id=a.origin_resource_id
  left join teloa_employee_knowledge_baselines baseline on baseline.owner_id=a.owner_id and baseline.role_id=a.role_id and baseline.origin_resource_id=a.origin_resource_id
  left join teloa_employee_knowledge_bindings current on current.owner_id=a.owner_id and current.role_id=a.role_id and current.origin_resource_id=a.origin_resource_id
  join teloa_resources h on h.owner_id=a.owner_id and h.id=coalesce(current.head_resource_id,baseline.current_resource_id,a.origin_resource_id)
  where a.owner_id=$1 and a.role_id=$2 and v->>'resource_id'=any($3::text[])`,[owner,roleId,references])).rows:[]
 return effective.map(id=>{
  const matches=rows.filter(row=>row.origin_resource_id===id.toLowerCase()||row.historical_resource_id===id.toLowerCase())
  if(!matches.length){
   const baseline=baselines.find(row=>row.origin_resource_id===id.toLowerCase()||row.current_resource_id===id.toLowerCase()||row.historical_resource_id===id.toLowerCase())
   if(baseline){if(baseline.origin_status!=='active'||baseline.head_status!=='active')throw new WorkError('teloa/resource-withdrawn','员工知识来源或当前基线已撤回。');return String(reverse?baseline.origin_resource_id:baseline.current_resource_id)}
   const archive=archives.find(row=>row.historical_resource_id===id.toLowerCase());if(archive){if(archive.origin_status!=='active'||archive.head_status!=='active')throw new WorkError('teloa/resource-withdrawn','员工知识来源或当前基线已撤回。');return String(archive.origin_resource_id)}return id
  }
  const row=matches[0]!
  if(matches.some(other=>other.origin_document_id!==row.origin_document_id))throw corrupt()
  if(row.origin_status!=='active'||row.head_status!=='active'||row.baseline_status!==null&&row.baseline_status!=='active')throw new WorkError('teloa/resource-withdrawn','员工知识来源或当前副本已撤回。')
  return String(reverse?row.origin_resource_id:row.head_resource_id)
 })
}
/** 未来工作采用员工副本当前版本；旧装配缺表时保持原行为。 */
export const resolveEmployeeKnowledgeReferences=(db:Pick<PoolClient,'query'>,owner:string,roleId:string,ids:readonly string[])=>mapping(db,owner,roleId,ids,false)
/** 在途固定版本反查原授权身份，内容修订不撤销既有执行许可。 */
export const employeeKnowledgeReferenceOrigins=(db:Pick<PoolClient,'query'>,owner:string,roleId:string,ids:readonly string[])=>mapping(db,owner,roleId,ids,true)

export class EmployeeKnowledgeService{
 private profile:()=>string|null=()=>null
 private readonly pool:Pool
 private readonly knowledge:MarkdownKnowledgeService
 private readonly resources:ResourceService
 private readonly identity:{id:()=>string;now:()=>string}
 constructor(pool:Pool,knowledge:MarkdownKnowledgeService,resources:ResourceService,identity:{id:()=>string;now:()=>string}){this.pool=pool;this.knowledge=knowledge;this.resources=resources;this.identity=identity}
 setRetrievalProfileReader(reader:()=>string|null){this.profile=reader}
 private async assertReceiptCurrent(client:PoolClient,value:unknown,expected:{ownerId:string;requestId:string;roleId:string;resourceId:string;scopeIds:string[]}):Promise<EmployeeKnowledgeRevision>{
  if(!isEmployeeKnowledgeRevision(value))throw corrupt()
  const document=value.document
  if(value.requestId!==expected.requestId||document.roleId!==expected.roleId||document.resourceId!==expected.resourceId||document.resource.ownerId!==expected.ownerId||document.resource.scopeIds.some(scope=>!expected.scopeIds.includes(scope))||hash(document.markdown)!==document.contentHash)throw corrupt()
  if((await client.query('select 1 from teloa_employee_knowledge_archives where owner_id=$1 and knowledge_id=$2',[value.document.resource.ownerId,value.document.knowledgeId])).rowCount)throw new WorkError('teloa/not-found','该知识历史已在重新导入包时清空。')
  const fixed=(await client.query(`select r.status from teloa_employee_knowledge_versions v join teloa_employee_knowledge_bindings b on b.owner_id=v.owner_id and b.role_id=v.role_id and b.origin_document_id=v.origin_document_id join teloa_resources r on r.owner_id=v.owner_id and r.id=v.resource_id where v.owner_id=$1 and v.role_id=$2 and b.origin_resource_id=$3 and b.knowledge_id=$4 and v.body_version=$5 and v.resource_id=$6 and v.content_hash=$7 and v.bytes=$8`,[expected.ownerId,expected.roleId,expected.resourceId,document.knowledgeId,document.bodyVersion,document.resource.id,document.contentHash,document.bytes])).rows[0]
  if(!fixed)throw corrupt()
  if(fixed.status!=='active')throw new WorkError('teloa/resource-withdrawn','该知识固定版本已撤回。')
  return value
 }
 private async tx<T>(operation:(client:PoolClient)=>Promise<T>):Promise<T>{const client=await this.pool.connect();try{await client.query('begin');const result=await operation(client);await client.query('commit');return result}catch(error){await client.query('rollback').catch(()=>{});if(error instanceof WorkError)throw error;throw new WorkError('teloa/storage-unavailable','员工知识操作暂未完成。')}finally{client.release()}}
 private async role(client:PoolClient,actor:ResourceActor,roleId:string,resourceId?:string,lock=false){
  authorizeResourceActor(actor)
  const row=(await client.query('select * from teloa_roles where owner_id=$1 and id=$2 for '+(lock?'update':'share'),[actor.ownerId,roleId])).rows[0]
  if(!row)throw new WorkError('teloa/forbidden','员工不存在或不属于当前本人。')
  let fields:ReturnType<typeof roleDefinition>;try{fields=roleDefinition(row.definition)}catch{throw corrupt()}
  if(row.state==='retired'||fields.scopes.some(scope=>!actor.scopeIds.includes(scope)))throw new WorkError('teloa/forbidden','当前主体无权维护该员工的知识。')
  if(resourceId&&!fields.knowledge.map(id=>id.toLowerCase()).includes(resourceId))throw new WorkError('teloa/forbidden','该知识未绑定到当前员工。')
  return fields
 }
 private async binding(client:PoolClient,owner:string,roleId:string,resourceId:string):Promise<Binding|undefined>{return (await client.query('select * from teloa_employee_knowledge_bindings where owner_id=$1 and role_id=$2 and origin_resource_id=$3',[owner,roleId,resourceId])).rows[0]}
 private async indexState(client:PoolClient,actor:ResourceActor,resource:WorkResource):Promise<EmployeeKnowledgeDocument['indexState']>{
  const enrolled=(await client.query('select 1 from teloa_retrieval_enrollments where owner_id=$1 and source_id=$2',[actor.ownerId,resource.sourceId])).rowCount
  if(!enrolled)return 'not-enrolled'
  const profile=this.profile();if(!profile)return 'pending'
  const rows=(await client.query('select state from teloa_retrieval_indexes where owner_id=$1 and resource_id=$2 and resource_version=$3 and source_version=$4 and profile_hash=$5 and chunker=$6 order by created_at desc',[actor.ownerId,resource.id,resource.version,resource.sourceVersion,profile,retrievalChunker])).rows
  return rows.some(row=>row.state==='ready')?'ready':rows[0]?.state==='failed'?'failed':'pending'
 }
 private async current(client:PoolClient,actor:ResourceActor,roleId:string,resourceId:string):Promise<EmployeeKnowledgeContent>{
  await this.role(client,actor,roleId,resourceId)
  if((await removedEmployeeKnowledgeReferences(client,actor.ownerId,roleId,[resourceId])).length)throw new WorkError('teloa/not-found','该知识已从当前包中移除；原执行快照仍保留。')
  const origin=(await client.query('select * from teloa_resources where owner_id=$1 and id=$2 for share',[actor.ownerId,resourceId])).rows[0]
  if(!origin||!isRecord(origin.spec))throw new WorkError('teloa/forbidden','员工知识来源不存在。')
  const binding=await this.binding(client,actor.ownerId,roleId,resourceId)
  const baseline=(await client.query('select * from teloa_employee_knowledge_baselines where owner_id=$1 and role_id=$2 and origin_resource_id=$3',[actor.ownerId,roleId,resourceId])).rows[0]
  if(binding){
   await mapping(client,actor.ownerId,roleId,[resourceId],false,true)
   const fixed=await this.resources.readFixedInTransaction(client,actor,binding.head_resource_id),head=(await client.query(`select i.current_version,v.content_hash,v.bytes,e.resource_id from teloa_knowledge_items i
    join teloa_knowledge_versions v on v.owner_id=i.owner_id and v.knowledge_id=i.id and v.number=i.current_version
    join teloa_employee_knowledge_versions e on e.owner_id=i.owner_id and e.role_id=$3 and e.origin_document_id=$4 and e.body_version=i.current_version
    where i.owner_id=$1 and i.id=$2`,[actor.ownerId,binding.knowledge_id,roleId,binding.origin_document_id])).rows[0]
   if(!head||head.content_hash!==fixed.resource.sourceVersion||head.resource_id!==fixed.resource.id||head.bytes!==Buffer.byteLength(fixed.text)||fixed.resource.sourceId!==markdownKnowledgeReferenceId(binding.knowledge_id))throw corrupt()
   const value:EmployeeKnowledgeContent={roleId,resourceId,documentId:binding.origin_document_id,knowledgeId:binding.knowledge_id,title:fixed.resource.title,bodyVersion:head.current_version,contentHash:fixed.resource.sourceVersion,bytes:Buffer.byteLength(fixed.text),resource:fixed.resource,origin:binding.origin,editing:'employee-copy',indexState:await this.indexState(client,actor,fixed.resource),markdown:fixed.text}
   if(!isEmployeeKnowledgeContent(value))throw corrupt();return value
  }
  if(baseline)await mapping(client,actor.ownerId,roleId,[resourceId],false,true)
  const fixed=await this.resources.readFixedInTransaction(client,actor,baseline?.current_resource_id??resourceId)
  const other=(await client.query('select 1 from teloa_employee_knowledge_bindings where owner_id=$1 and role_id=$2 and origin_document_id=$3',[actor.ownerId,roleId,fixed.resource.sourceId])).rowCount
  if(other)throw new WorkError('teloa/conflict','该员工存在同一知识的多个资料投影，请先选择并整理原绑定。')
  const value:EmployeeKnowledgeContent={roleId,resourceId,documentId:baseline?.origin_document_id??fixed.resource.sourceId,knowledgeId:null,title:fixed.resource.title,bodyVersion:1,contentHash:fixed.resource.sourceVersion,bytes:Buffer.byteLength(fixed.text),resource:fixed.resource,origin:{resourceId,sourceId:fixed.resource.sourceId,sourceVersion:fixed.resource.sourceVersion},editing:'fork-on-write',indexState:await this.indexState(client,actor,fixed.resource),markdown:fixed.text}
  if(!isEmployeeKnowledgeContent(value))throw corrupt();return value
 }
 async list(actor:ResourceActor,input:unknown):Promise<EmployeeKnowledgeDocument[]>{
  const row=exact(input,['roleId','requireReady']);if(!resourceId(row.roleId)||row.requireReady!==undefined&&row.requireReady!==true)throw bad()
  return this.tx(async client=>{const fields=await this.role(client,actor,row.roleId as string),values:EmployeeKnowledgeDocument[]=[],removed=await removedEmployeeKnowledgeReferences(client,actor.ownerId,(row.roleId as string).toLowerCase(),fields.knowledge);if(row.requireReady===true)await resolveEmployeeKnowledgeReferences(client,actor.ownerId,(row.roleId as string).toLowerCase(),fields.knowledge);for(const resourceId of fields.knowledge.filter(id=>!removed.includes(id))){const {markdown:_,...document}=await this.current(client,actor,(row.roleId as string).toLowerCase(),resourceId.toLowerCase());values.push(document)}return values})
 }
 async read(actor:ResourceActor,input:unknown):Promise<EmployeeKnowledgeContent>{
  const row=target(input,['version']);if(row.version!==undefined&&!resourceVersion(row.version))throw bad()
  const current=await this.tx(client=>this.current(client,actor,row.roleId,row.resourceId))
  if(row.version===undefined||row.version===current.bodyVersion)return current
  if(!current.knowledgeId||row.version>current.bodyVersion)throw new WorkError('teloa/not-found','员工知识固定版本不存在。')
  const version=await this.knowledge.readVersion(actor,{knowledgeId:current.knowledgeId,version:row.version})
  const fixed=await this.tx(async client=>{const found=(await client.query('select resource_id from teloa_employee_knowledge_versions where owner_id=$1 and role_id=$2 and origin_document_id=$3 and body_version=$4',[actor.ownerId,row.roleId,current.documentId,row.version])).rows[0];if(!found)throw corrupt();const resource=(await this.resources.readFixedInTransaction(client,actor,found.resource_id)).resource;return {resource,indexState:await this.indexState(client,actor,resource)}})
  return {...current,bodyVersion:version.version,contentHash:version.contentHash,bytes:version.bytes,markdown:version.markdown,...fixed}
 }
 async versions(actor:ResourceActor,input:unknown):Promise<EmployeeKnowledgeVersion[]>{
  const row=target(input)
  return this.tx(async client=>{const current=await this.current(client,actor,row.roleId,row.resourceId);if(!current.knowledgeId)return [{version:1,contentHash:current.contentHash,bytes:current.bytes,createdAt:current.resource.createdAt,resourceId:current.resource.id}]
   const rows=(await client.query('select * from teloa_employee_knowledge_versions where owner_id=$1 and role_id=$2 and origin_document_id=$3 order by body_version',[actor.ownerId,row.roleId,current.documentId])).rows
   if(rows.length!==current.bodyVersion)throw corrupt()
   return rows.map(row=>({version:row.body_version,contentHash:row.content_hash,bytes:row.bytes,createdAt:row.created_at.toISOString(),resourceId:row.resource_id}))
  })
 }
 async status(actor:ResourceActor,input:unknown):Promise<EmployeeKnowledgeRevision|null>{
  authorizeResourceActor(actor);const row=exact(input,['requestId']);if(!resourceId(row.requestId))throw bad()
  return this.tx(async client=>{const prior=(await client.query('select * from teloa_employee_knowledge_operations where owner_id=$1 and request_id=$2',[actor.ownerId,row.requestId])).rows[0];if(!prior)return null
   await this.current(client,actor,prior.role_id,prior.origin_resource_id)
   return this.assertReceiptCurrent(client,prior.result,{...actor,requestId:(row.requestId as string).toLowerCase(),roleId:prior.role_id,resourceId:prior.origin_resource_id})
  })
 }
 private async mutate(actor:ResourceActor,input:unknown,operation:'revise'|'restore'):Promise<EmployeeKnowledgeRevision>{
  authorizeResourceActor(actor,actor.ownerId,[],true)
  const row=target(input,['requestId','expectedBodyVersion','expectedContentHash',operation==='revise'?'markdown':'restoreVersion'])
  if(!resourceId(row.requestId)||!resourceVersion(row.expectedBodyVersion)||!digest(row.expectedContentHash)||(operation==='restore'&&!resourceVersion(row.restoreVersion)))throw bad()
  const markdown=operation==='revise'?normalizePasteMarkdown(row.markdown):undefined
  const requestId=row.requestId.toLowerCase(),spec={operation,roleId:row.roleId,resourceId:row.resourceId,expectedBodyVersion:row.expectedBodyVersion,expectedContentHash:row.expectedContentHash,...(operation==='revise'?{contentHash:hash(markdown!)}:{restoreVersion:row.restoreVersion})}
  const replay=()=>this.tx(async client=>{const prior=(await client.query('select result,request_spec=$3::jsonb as same_request from teloa_employee_knowledge_operations where owner_id=$1 and request_id=$2',[actor.ownerId,requestId,JSON.stringify(spec)])).rows[0];if(!prior)return null;if(!prior.same_request)throw new WorkError('teloa/conflict','同一请求 ID 不能保存另一份员工知识修改。');await this.current(client,actor,row.roleId,row.resourceId);return this.assertReceiptCurrent(client,prior.result,{...actor,requestId,roleId:row.roleId,resourceId:row.resourceId})})
  const prior=await replay()
  if(prior)return prior
  const current=await this.read(actor,{roleId:row.roleId,resourceId:row.resourceId})
  if(current.bodyVersion!==row.expectedBodyVersion||current.contentHash!==row.expectedContentHash){const concurrent=await replay();if(concurrent)return concurrent;throw conflict()}
  const nextMarkdown=operation==='revise'?markdown!:(await this.read(actor,{roleId:row.roleId,resourceId:row.resourceId,version:row.restoreVersion})).markdown
  const publish=async(client:PoolClient,saved:PasteKnowledge):Promise<EmployeeKnowledgeRevision>=>{
   await this.role(client,actor,row.roleId,row.resourceId,true)
   await assertImportReady(client,actor.ownerId,row.roleId,[row.resourceId])
   await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['employee-knowledge',actor.ownerId,row.roleId,current.documentId])])
   const prior=(await client.query('select result,request_spec=$3::jsonb as same_request from teloa_employee_knowledge_operations where owner_id=$1 and request_id=$2',[actor.ownerId,requestId,JSON.stringify(spec)])).rows[0]
   if(prior){if(!prior.same_request)throw new WorkError('teloa/conflict','同一请求 ID 不能保存另一份员工知识修改。');return this.assertReceiptCurrent(client,prior.result,{...actor,requestId,roleId:row.roleId,resourceId:row.resourceId})}
   const binding=await this.binding(client,actor.ownerId,row.roleId,row.resourceId)
   if(current.knowledgeId?(binding?.knowledge_id!==current.knowledgeId):binding!==undefined)throw conflict()
   // 行锁之后再核对原资料可读；发布不能越过并发权限撤回。
   const baseline=(await client.query('select current_resource_id from teloa_employee_knowledge_baselines where owner_id=$1 and role_id=$2 and origin_resource_id=$3',[actor.ownerId,row.roleId,row.resourceId])).rows[0]
   const origin=await this.resources.readFixedInTransaction(client,actor,baseline?.current_resource_id??row.resourceId)
   if(origin.resource.sourceId!==current.origin.sourceId||origin.resource.sourceVersion!==current.origin.sourceVersion)throw conflict()
   if(binding)await resolveEmployeeKnowledgeReferences(client,actor.ownerId,row.roleId,[row.resourceId])
   const resource=await this.resources.publishEmployeeKnowledgeInTransaction(client,actor,{title:saved.item.title,sourceId:markdownKnowledgeReferenceId(saved.item.id),sourceVersion:saved.version.contentHash,scopeIds:saved.item.scopeIds}),now=this.identity.now()
   if(!binding){
    await client.query('insert into teloa_employee_knowledge_bindings(owner_id,role_id,origin_resource_id,origin_document_id,knowledge_id,head_resource_id,origin,created_at,updated_at) values($1,$2,$3,$4,$5,$6,$7,$8,$8)',[actor.ownerId,row.roleId,row.resourceId,current.documentId,saved.item.id,resource.id,JSON.stringify(current.origin),now])
    const initial=(await client.query('select content_hash,bytes,created_at from teloa_knowledge_versions where owner_id=$1 and knowledge_id=$2 and number=1',[actor.ownerId,saved.item.id])).rows[0]
    if(!initial)throw corrupt()
    // 导入原件可能使用 BOM/CRLF；受管 Markdown 规范化后的首版本也必须有匹配摘要的固定资源。
    const baseline=initial.content_hash===current.contentHash&&initial.bytes===current.bytes?current.resource:await this.resources.publishEmployeeKnowledgeInTransaction(client,actor,{title:saved.item.title,sourceId:markdownKnowledgeReferenceId(saved.item.id),sourceVersion:initial.content_hash,scopeIds:saved.item.scopeIds})
    await client.query('insert into teloa_employee_knowledge_versions values($1,$2,$3,1,$4,$5,$6,$7)',[actor.ownerId,row.roleId,current.documentId,baseline.id,initial.content_hash,initial.bytes,initial.created_at])
   }
   else await client.query('update teloa_employee_knowledge_bindings set head_resource_id=$4,updated_at=$5 where owner_id=$1 and role_id=$2 and origin_document_id=$3',[actor.ownerId,row.roleId,current.documentId,resource.id,now])
   await client.query('insert into teloa_employee_knowledge_versions values($1,$2,$3,$4,$5,$6,$7,$8)',[actor.ownerId,row.roleId,current.documentId,saved.version.version,resource.id,saved.version.contentHash,saved.version.bytes,saved.version.createdAt])
   // 登记持久化检索意图；重启后仍由原索引协调器发现 pending 并继续建立。
   await client.query('insert into teloa_retrieval_enrollments(owner_id,source_id,created_at) select $1,$2,$3 where exists(select 1 from teloa_retrieval_enrollments where owner_id=$1 and source_id=$4) on conflict do nothing',[actor.ownerId,resource.sourceId,now,current.origin.sourceId])
   const document:EmployeeKnowledgeContent={...current,knowledgeId:saved.item.id,bodyVersion:saved.version.version,contentHash:saved.version.contentHash,bytes:saved.version.bytes,resource,editing:'employee-copy',indexState:await this.indexState(client,actor,resource),markdown:saved.version.markdown}
   const result:EmployeeKnowledgeRevision={requestId,operation,forked:!binding,document}
   if(!isEmployeeKnowledgeRevision(result))throw corrupt()
   await client.query('insert into teloa_employee_knowledge_operations values($1,$2,$3,$4,$5,$6,$7)',[actor.ownerId,requestId,row.roleId,row.resourceId,JSON.stringify(spec),JSON.stringify(result),now]);return result
  }
  if(!current.knowledgeId)return (await this.knowledge.forkWithTransaction(actor,{requestId,title:current.title,category:'reference',topics:[],scopeIds:current.resource.scopeIds,initialMarkdown:current.markdown,markdown:nextMarkdown},publish)).value
  return (await this.knowledge.reviseWithTransaction(actor,{requestId,knowledgeId:current.knowledgeId,expectedVersion:current.bodyVersion,markdown:nextMarkdown},publish,async client=>{await this.role(client,actor,row.roleId,row.resourceId,true)})).value
 }
 async revise(actor:ResourceActor,input:unknown){return this.mutate(actor,input,'revise')}
 async restore(actor:ResourceActor,input:unknown){return this.mutate(actor,input,'restore')}
}

import {randomUUID} from 'node:crypto'
import type {Pool,PoolClient} from 'pg'
import {WorkError,roleDefinition,type ResourceSpec} from '@teloa/contract'
import {BusinessScopeService,isBusinessScopeDomain} from './business-scopes.ts'
import {industryPredicates} from './industry-instance-kit.ts'
import {industryKnowledgeDigests} from './industry-knowledge.ts'
import {industryRoleDigests} from './industry-roles.ts'
import {retireIndustryLoadInTransaction,type IndustryLoadPlanPort} from './industry-load-retire.ts'

type Db=Pool|PoolClient
type Row=Record<string,unknown>
/** 一次迁移写了多少行；回执条数与这四项之和一致，便于调用方与测试直接核对。 */
export type BusinessSpaceMigrationSummary={moved:number;unloaded:number;scopes:number;resources:number}
/** 回执种类：加载搬移、重复内容卸载、冻结范围改写、资料范围改写。 */
export type BusinessSpaceMigrationKind='load-moved'|'load-unloaded-duplicate'|'scope-rewritten'|'resource-scope-rewritten'

/**
 * 迁移的可选端口。重复加载要走卸载协议退役，其中"暂停该加载创建的持续计划"必须经由持续计划服务自己的协议；
 * 没接入而又确有在效计划时显式失败，不静默留下一个挂在已卸载模板上的计划。
 */
export type BusinessSpaceMigrationOptions={plans?:IndustryLoadPlanPort|undefined}

const empty=():BusinessSpaceMigrationSummary=>({moved:0,unloaded:0,scopes:0,resources:0})
const owner=(value:string)=>{if(typeof value!=='string'||!value.trim()||value.length>128)throw new WorkError('teloa/forbidden','需要有效的本人身份。')}
const corrupt=()=>new WorkError('teloa/storage-corrupt','业务空间迁移回执损坏，已停止回滚。')
/** 六张冻结了业务范围的行业实例表；迁移按 `load_id` 关联到加载，改写其中的 `scope='space-<空间身份>'`。 */
const roleInstances='teloa_industry_role_instances',knowledgeInstances='teloa_industry_knowledge_instances'
const kitInstances=['teloa_industry_data_source_instances','teloa_industry_execution_tool_instances','teloa_industry_mcp_instances','teloa_industry_plugin_instances'] as const
/**
 * 迁移唯一允许改写的表及其定位列（白名单）：回滚只按这张表拼 SQL，回执里出现别的表名一律判为回执损坏。
 * `teloa_skill_install_usages` 是整行删除，回滚按 `(owner_id,load_id,item_instance_id)` 原样插回，定位列只用于回执可读性。
 */
const targetKeys:Record<string,string>={
 teloa_industry_loads:'id',
 teloa_industry_role_instances:'id',teloa_industry_role_requests:'request_id',teloa_roles:'id',
 teloa_industry_knowledge_instances:'id',teloa_industry_knowledge_requests:'request_id',
 teloa_industry_data_source_instances:'id',teloa_industry_execution_tool_instances:'id',
 teloa_industry_mcp_instances:'id',teloa_industry_plugin_instances:'id',
 teloa_resources:'id',teloa_resource_drafts:'id',teloa_skill_install_usages:'item_instance_id',
}
const present=async(db:Db,names:readonly string[]):Promise<Set<string>>=>
 new Set((await db.query('select name from unnest($1::text[]) as name where to_regclass(name) is not null',[[...names]])).rows.map(row=>row.name as string))
const client=(db:Db):db is PoolClient=>typeof (db as PoolClient).release==='function'
const text=(value:unknown):string=>{if(typeof value!=='string')throw corrupt();return value}

/**
 * 迁移回执表：每改一行就留一条，`previous` 存这一行被改动的**全部列**的原值，
 * 因此回滚只是把 `previous` 的键值原样写回，不需要知道当初是怎么算出来的。
 *
 * 与任务简报的 `from_space_id/load_id/action` 形状的偏差：范围改写涉及六张实例表、两张回执表、
 * 岗位表与资料表，用 `target_table+target_id` 泛化后同一张回执表就能覆盖所有写；
 * 加载搬移把原 `space_id` 放进 `previous`，信息不丢。
 */
export async function initializeBusinessSpaceMigrations(pool:Pool):Promise<void>{await pool.query(`
 create table if not exists teloa_business_space_migrations(seq bigserial primary key,id uuid not null unique,owner_id text not null,kind text not null check(kind in ('load-moved','load-unloaded-duplicate','scope-rewritten','resource-scope-rewritten')),target_table text not null,target_id text not null,previous jsonb not null check(jsonb_typeof(previous)='object'),created_at timestamptz not null);
 alter table teloa_business_space_migrations add column if not exists seq bigserial;
 create index if not exists teloa_business_space_migrations_owner on teloa_business_space_migrations(owner_id,seq desc);
 `)}

/**
 * 把本人名下其它业务空间的行业加载并入本人空间，并把存量冻结列上的 `space-<空间身份>` 改写为加载的 `scope`。
 *
 * 一个事务、一把 `['business-space-migration',owner]` 咨询锁；`db` 是连接时沿用调用方的事务，是连接池时自开事务。
 * 本人空间尚未引导（或空间表还不存在）时整体无操作——引导是 `BusinessSpaceService.ensurePersonal` 的职责，
 * 迁移不凭空造空间。全程幂等：第二次运行既不改行也不写回执。
 */
export async function migrateToPersonalSpace(db:Db,ownerId:string,options:BusinessSpaceMigrationOptions={}):Promise<BusinessSpaceMigrationSummary>{
 owner(ownerId)
 if(client(db))return migrate(db,ownerId,options)
 const connection=await db.connect()
 try{await connection.query('begin');const result=await migrate(connection,ownerId,options);await connection.query('commit');return result}
 catch(error){await connection.query('rollback').catch(()=>{});throw error}
 finally{connection.release()}
}

async function migrate(db:PoolClient,ownerId:string,options:BusinessSpaceMigrationOptions):Promise<BusinessSpaceMigrationSummary>{
 await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['business-space-migration',ownerId])])
 const summary=empty()
 const tables=await present(db,['teloa_business_spaces','teloa_industry_loads',roleInstances,knowledgeInstances,...kitInstances,'teloa_industry_role_requests','teloa_industry_knowledge_requests','teloa_roles','teloa_resources','teloa_resource_drafts','teloa_tasks','teloa_plans','teloa_groups'])
 if(!tables.has('teloa_business_spaces'))return summary
 const personal=(await db.query("select id,version from teloa_business_spaces where owner_id=$1 and kind='personal'",[ownerId])).rows[0]
 if(!personal)return summary
 const personalId=text(personal.id)
 // 内置范围与存量 `Design` 历史标签统一由 功能验证 的 `ensureBuiltin` 负责，这里只是调用它，不重复判据。
 await BusinessScopeService.ensureBuiltin(db,ownerId,personalId)
 // 存量冻结取值恒为 `'space-'+本人某个空间的身份`；先把全集算出来，搬移前后判据一致。
 const spaceNames=new Map((await db.query('select id,name from teloa_business_spaces where owner_id=$1',[ownerId])).rows.map(row=>[text(row.id),text(row.name)]))
 const frozen=new Set([...spaceNames.keys()].map(id=>'space-'+id))
 const loads=tables.has('teloa_industry_loads')?(await db.query('select id,space_id,space_version,content_hash,status,created_at,scope,template_title from teloa_industry_loads where owner_id=$1 order by created_at,id',[ownerId])).rows:[]
 // 每一条**合规** `scope` 都登记成本人空间下的业务范围标签——单空间旧库一条都不用搬，
 // 但它的模板同样要出现在业务范围目录里，否则该范围下建任务会被判成"未登记"。登记幂等，不覆盖已有行。
 // 不合规的 `scope`（中文、超长等，加载判据 §`isBusinessScopeDomain` 之前入库的存量行）既不登记标签
 // 也不参与改写：把它写进 `scope` 列会让岗位定义当场抛错、知识与资料被写成永久读不出的行。
 const scopes=new Map<string,string>()
 for(const row of loads){
  const title=text(row.template_title),scope=text(row.scope)
  if(!isBusinessScopeDomain(scope))continue
  scopes.set(text(row.id),scope)
  await BusinessScopeService.ensure(db,ownerId,{scope,title:title.length<=80?title:scope,kind:'domain',spaceId:personalId})
 }
 // 历史范围的登记排在加载范围之后：同一个取值若既是某加载的 scope 又出现在任务上，先到的加载标签说了算。
 await registerLegacyScopes(db,ownerId,personalId,tables,spaceNames,await skippedLoadScopes(db,ownerId,tables,loads,scopes))
 if(!loads.length)return summary
 await moveLoads(db,ownerId,personalId,Number(personal.version),loads,summary,options)
 await rewriteRoles(db,ownerId,tables,frozen,scopes,summary)
 await rewriteKnowledge(db,ownerId,tables,frozen,scopes,summary)
 for(const table of kitInstances)if(tables.has(table))await rewriteKit(db,ownerId,table,frozen,scopes,summary)
 return summary
}

/**
 * 不合规 `scope` 的那些加载，其实例上冻结的业务范围取值：这些行一律不改写，因此要把它们**现有**的取值
 * 登记成历史标签，至少让同范围下的任务与群继续可写。取值形状恒为 `space-<空间身份>`，与任务那边同一套登记。
 */
async function skippedLoadScopes(db:PoolClient,ownerId:string,tables:ReadonlySet<string>,loads:readonly Row[],scopes:ReadonlyMap<string,string>):Promise<string[]>{
 const skipped=loads.filter(row=>!scopes.has(text(row.id))).map(row=>text(row.id))
 if(!skipped.length)return []
 const found=new Set<string>()
 for(const table of [roleInstances,knowledgeInstances,...kitInstances]){
  if(!tables.has(table))continue
  for(const row of (await db.query(`select distinct scope from ${table} where owner_id=$1 and load_id=any($2::uuid[]) and scope is not null`,[ownerId,skipped])).rows)found.add(text(row.scope))
 }
 return [...found]
}

/**
 * 任务、计划与群上冻结的业务范围**不改写行**（它们的定义进了任务版本与各自的回执指纹），
 * 改为把这些取值按 `Design` 的先例登记成 `legacy` 标签，让存量对象在写入校验下继续可读可写。
 * 登记的是**全部**未登记取值，不只 `space-<空间身份>` 那一类：第二阶段之前任何自定义取值都没有目录条目，
 * 漏掉一个就意味着那些任务永久不能编辑。
 * 标题取对应空间名加"（历史）"，空间行已不在（或名称过长）时退回取值本身；
 * 登记幂等且不覆盖已有行（内置与加载标签先到先得），与内置标签同理不进回执、不回滚。
 * 标签表存不下的取值（空白、超 80 字、含控制字符）跳过：它本来就不可能成为合法标签，写不进去也改不了行。
 */
async function registerLegacyScopes(db:PoolClient,ownerId:string,personalId:string,tables:ReadonlySet<string>,spaceNames:ReadonlyMap<string,string>,extra:readonly string[]):Promise<void>{
 const sources:readonly {table:string;sql:string}[]=[
  {table:'teloa_tasks',sql:"select distinct definition->>'scope' as scope from teloa_tasks where owner_id=$1 and definition->>'scope' is not null"},
  {table:'teloa_plans',sql:'select distinct scope from teloa_plans where owner_id=$1 and scope is not null'},
  {table:'teloa_groups',sql:"select distinct definition->>'scope' as scope from teloa_groups where owner_id=$1 and definition->>'scope' is not null"},
 ]
 const found=new Set<string>(extra)
 for(const source of sources){
  if(!tables.has(source.table))continue
  for(const row of (await db.query(source.sql,[ownerId])).rows)found.add(text(row.scope))
 }
 for(const scope of [...found].sort()){
  if(!registrable(scope))continue
  const name=scope.startsWith('space-')?spaceNames.get(scope.slice('space-'.length)):undefined
  const title=name?name+'（历史）':scope
  await BusinessScopeService.ensure(db,ownerId,{scope,title:registrable(title)?title:scope,kind:'legacy',spaceId:personalId})
 }
}
/** 标签表的取值判据，与 `BusinessScopeService.ensure` 的同一条：非空、不超 80 字、不含控制字符。 */
const registrable=(value:string):boolean=>!!value.trim()&&value.length<=80&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)

const receipt=async(db:PoolClient,ownerId:string,kind:BusinessSpaceMigrationKind,table:string,id:string,previous:Row):Promise<void>=>{
 await db.query('insert into teloa_business_space_migrations(id,owner_id,kind,target_table,target_id,previous,created_at) values(gen_random_uuid(),$1,$2,$3,$4,$5::jsonb,now())',[ownerId,kind,table,id,JSON.stringify(previous)])
}

/**
 * 加载归并：按 `content_hash` 分组，每组只有一条能落在本人空间（表上 `unique(owner_id,space_id,content_hash)`）。
 * 本人空间里已有同摘要的那条是既定占位者（搬不走别人也搬不进来），因此它就是保留者；
 * 否则在非本人空间的候选里取「仍活跃且最新」的一条搬进来。其余候选留在原空间并置为已卸载——
 * 其它空间行按规格保留不删，只是它们的重复加载不再提供可执行血缘。
 *
 * 搬移同时把 `space_version` 压到本人空间的当前版本：加载读取要求 `空间当前版本>=加载登记时的版本`，
 * 旧空间版本更高时不压会让搬过来的加载整条读成记录损坏。已经不高于的保持原值（`least`），因此重跑无变化。
 */
async function moveLoads(db:PoolClient,ownerId:string,personalId:string,personalVersion:number,loads:readonly Row[],summary:BusinessSpaceMigrationSummary,options:BusinessSpaceMigrationOptions):Promise<void>{
 const groups=new Map<string,Row[]>()
 for(const row of loads)groups.set(text(row.content_hash),[...(groups.get(text(row.content_hash))??[]),row])
 for(const group of groups.values()){
  const occupant=group.find(row=>text(row.space_id)===personalId)
  const ranked=[...group].sort((a,b)=>(a.status==='active'?0:1)-(b.status==='active'?0:1)||order(b.created_at,a.created_at)||order(text(b.id),text(a.id)))
  const keeper=occupant??ranked[0]!
  for(const row of group){
   const id=text(row.id)
   if(row===keeper){
    if(text(row.space_id)===personalId)continue
    const moved=(await db.query('update teloa_industry_loads set space_id=$3,space_version=least(space_version,$4::integer) where id=$1 and owner_id=$2 returning space_id',[id,ownerId,personalId,personalVersion])).rowCount
    if(!moved)throw corrupt()
    await receipt(db,ownerId,'load-moved','teloa_industry_loads',id,{space_id:row.space_id,space_version:row.space_version})
    summary.moved+=1
    continue
   }
   // 已卸载的不必再动；已被升级替代的一律跳过——`superseded` 是升级血缘，改成 `unloaded` 会把它抹掉。
   if(row.status!=='active')continue
   // 重复加载不能只把状态一改了事：解除四类实例、删 Skill 使用关系、暂停它创建的计划都要按卸载协议走一遍，
   // 逐行原值进迁移回执，否则合并之后会留下一批仍可写的实例与仍在跑的计划。
   const now=stamp(await db.query('select now() as value'))
   await retireIndustryLoadInTransaction(db,ownerId,id,now,{
    plans:options.plans,identity:{id:randomUUID},
    note:'重复加载已在合并到本人工作空间时卸载',
    dependency:'持续计划服务尚未接入，不能合并仍在生效的重复行业加载。',
    receipt:(table,target,previous)=>receipt(db,ownerId,'load-unloaded-duplicate',table,target,previous),
   })
   await db.query("update teloa_industry_loads set status='unloaded',unloaded_at=$3 where id=$1 and owner_id=$2",[id,ownerId,now])
   await receipt(db,ownerId,'load-unloaded-duplicate','teloa_industry_loads',id,{status:row.status,unloaded_at:row.unloaded_at??null,space_id:row.space_id})
   summary.unloaded+=1
  }
 }
}
const stamp=(result:{rows:Row[]}):string=>{const value=result.rows[0]?.value;if(!(value instanceof Date))throw corrupt();return value.toISOString()}
const order=(left:unknown,right:unknown):number=>{const a=String(left instanceof Date?left.toISOString():left),b=String(right instanceof Date?right.toISOString():right);return a<b?-1:a>b?1:0}

/** 冻结取值改写为该加载的 `scope`；取值不在冻结全集里、或改写后与原值相同时都不写，保证重跑无操作。 */
const next=(value:unknown,frozen:ReadonlySet<string>,targetScope:string):string|null=>{
 const current=text(value)
 return frozen.has(current)&&current!==targetScope?targetScope:null
}
/** 资料范围是数组：逐元素替换冻结取值，去重后排序（`ResourceSpec` 的读取器本身也按排序后比较）。 */
const nextScopes=(value:unknown,frozen:ReadonlySet<string>,targetScope:string):string[]|null=>{
 if(!Array.isArray(value))throw corrupt()
 const mapped=[...new Set(value.map(item=>frozen.has(text(item))?targetScope:text(item)))].sort()
 return JSON.stringify(mapped)===JSON.stringify(value)?null:mapped
}
const spec=(value:unknown):ResourceSpec=>{
 const row=value as Record<string,unknown>|null
 if(!row||typeof row!=='object'||Array.isArray(row))throw corrupt()
 return {title:text(row.title),sourceId:text(row.sourceId),sourceVersion:text(row.sourceVersion),scopeIds:row.scopeIds as string[]}
}

/**
 * 岗位实例：除 `scope` 列外，冻结的 `definition.scopes` 与由它派生的 `definition_hash`、`mapping_digest`
 * 都要一起改；实例化回执里存着同两个指纹，不改会让重放实例化请求读成记录损坏。
 * 真实数字岗位的 `definition.scopes` 也含同一个取值，不改不会报错但岗位在任何业务范围下都不可见，一并改写。
 */
async function rewriteRoles(db:PoolClient,ownerId:string,tables:ReadonlySet<string>,frozen:ReadonlySet<string>,scopes:ReadonlyMap<string,string>,summary:BusinessSpaceMigrationSummary):Promise<void>{
 if(!tables.has(roleInstances))return
 for(const row of (await db.query(`select * from ${roleInstances} where owner_id=$1 order by created_at,id`,[ownerId])).rows){
  const targetScope=scopes.get(text(row.load_id));if(targetScope===undefined)continue
  const scope=next(row.scope,frozen,targetScope);if(scope===null)continue
  const definition=roleDefinition(row.definition)
  const rewritten=roleDefinition({...definition,scopes:definition.scopes.map(value=>frozen.has(value)?targetScope:value)})
  const definitionHash=industryRoleDigests.definition(rewritten)
  const mappingDigest=industryRoleDigests.mapping({id:text(row.id),ownerId,loadId:text(row.load_id),itemInstanceId:text(row.item_instance_id),downstreamRequestId:text(row.downstream_request_id),definitionHash,knowledge:row.knowledge as never,omittedKnowledge:row.omitted_knowledge as never,declarations:row.declarations as never})
  await db.query(`update ${roleInstances} set scope=$3,definition=$4::jsonb,definition_hash=$5,mapping_digest=$6 where id=$1 and owner_id=$2`,[row.id,ownerId,scope,JSON.stringify(rewritten),definitionHash,mappingDigest])
  await receipt(db,ownerId,'scope-rewritten',roleInstances,text(row.id),{scope:row.scope,definition:row.definition,definition_hash:row.definition_hash,mapping_digest:row.mapping_digest})
  summary.scopes+=1
  if(tables.has('teloa_industry_role_requests'))
   for(const request of (await db.query('select * from teloa_industry_role_requests where owner_id=$1 and instance_id=$2',[ownerId,row.id])).rows){
    const saved={...(request.request_spec as Row),definitionHash,mappingDigest}
    await db.query('update teloa_industry_role_requests set request_spec=$3::jsonb where owner_id=$1 and request_id=$2',[ownerId,request.request_id,JSON.stringify(saved)])
    await receipt(db,ownerId,'scope-rewritten','teloa_industry_role_requests',text(request.request_id),{request_spec:request.request_spec})
    summary.scopes+=1
   }
  if(row.role_id!==null&&tables.has('teloa_roles'))await rewriteRole(db,ownerId,text(row.role_id),frozen,targetScope,summary)
 }
}
async function rewriteRole(db:PoolClient,ownerId:string,roleId:string,frozen:ReadonlySet<string>,targetScope:string,summary:BusinessSpaceMigrationSummary):Promise<void>{
 const role=(await db.query('select id,definition,request_spec from teloa_roles where id=$1 and owner_id=$2',[roleId,ownerId])).rows[0]
 if(!role)return
 // 两列各自从自己的原值改写：`definition` 随每次编辑更新，`request_spec` 停在创建那一刻，
 // 被编辑过（含升级按模板重放定义）的岗位上两者本就不同。把改写后的定义同时写进两列，会让
 // `findByRequest` 的「创建请求与固定定义相等」判据由真变假，岗位实例随即整体读成记录损坏。
 const rewrite=(value:unknown):string|null=>{
  const definition=roleDefinition(value)
  if(!definition.scopes.some(scope=>frozen.has(scope)&&scope!==targetScope))return null
  return JSON.stringify(roleDefinition({...definition,scopes:definition.scopes.map(scope=>frozen.has(scope)?targetScope:scope)}))
 }
 const definition=rewrite(role.definition),requested=rewrite(role.request_spec)
 if(definition===null&&requested===null)return
 await db.query('update teloa_roles set definition=coalesce($3::jsonb,definition),request_spec=coalesce($4::jsonb,request_spec) where id=$1 and owner_id=$2',[roleId,ownerId,definition,requested])
 await receipt(db,ownerId,'scope-rewritten','teloa_roles',roleId,{definition:role.definition,request_spec:role.request_spec})
 summary.scopes+=1
}

/**
 * 知识实例：`scope` 列之外，冻结的 `spec.scopeIds` 与由它派生的 `digest`、再由 `digest` 派生的 `mapping_digest`
 * 都是存储列，读取时会重算比对，必须一并改写；实例化回执里存着同一份 `spec/digest/mappingDigest`。
 * 下游的资源草案与工作资料上也冻结着同一个范围取值，读取路径按 `[scope]` 严格比对，因此一并按元素改写。
 */
async function rewriteKnowledge(db:PoolClient,ownerId:string,tables:ReadonlySet<string>,frozen:ReadonlySet<string>,scopes:ReadonlyMap<string,string>,summary:BusinessSpaceMigrationSummary):Promise<void>{
 if(!tables.has(knowledgeInstances))return
 for(const row of (await db.query(`select * from ${knowledgeInstances} where owner_id=$1 order by created_at,id`,[ownerId])).rows){
  const targetScope=scopes.get(text(row.load_id));if(targetScope===undefined)continue
  const scope=next(row.scope,frozen,targetScope);if(scope===null)continue
  const current=spec(row.spec),scopeIds=nextScopes(current.scopeIds,frozen,targetScope)??current.scopeIds
  const rewritten:ResourceSpec={title:current.title,sourceId:current.sourceId,sourceVersion:current.sourceVersion,scopeIds}
  const digest=industryKnowledgeDigests.spec(rewritten)
  const mappingDigest=industryKnowledgeDigests.mapping({id:text(row.id),ownerId,loadId:text(row.load_id),itemInstanceId:text(row.item_instance_id),downstreamRequestId:text(row.downstream_request_id),digest})
  await db.query(`update ${knowledgeInstances} set scope=$3,spec=$4::jsonb,digest=$5,mapping_digest=$6 where id=$1 and owner_id=$2`,[row.id,ownerId,scope,JSON.stringify(rewritten),digest,mappingDigest])
  await receipt(db,ownerId,'scope-rewritten',knowledgeInstances,text(row.id),{scope:row.scope,spec:row.spec,digest:row.digest,mapping_digest:row.mapping_digest})
  summary.scopes+=1
  if(tables.has('teloa_industry_knowledge_requests'))
   for(const request of (await db.query('select * from teloa_industry_knowledge_requests where owner_id=$1 and instance_id=$2',[ownerId,row.id])).rows){
    const saved={...(request.request_spec as Row),spec:rewritten,digest,mappingDigest}
    await db.query('update teloa_industry_knowledge_requests set request_spec=$3::jsonb where owner_id=$1 and request_id=$2',[ownerId,request.request_id,JSON.stringify(saved)])
    await receipt(db,ownerId,'scope-rewritten','teloa_industry_knowledge_requests',text(request.request_id),{request_spec:request.request_spec})
    summary.scopes+=1
   }
  const resourceIds=new Set<string>(row.resource_id===null?[]:[text(row.resource_id)])
  if(tables.has('teloa_resource_drafts'))
   for(const draft of (await db.query('select * from teloa_resource_drafts where owner_id=$1 and request_id=$2',[ownerId,row.downstream_request_id])).rows){
    if(draft.resource_id!==null)resourceIds.add(text(draft.resource_id))
    const saved=nextScopes(spec(draft.spec).scopeIds,frozen,targetScope),requested=nextScopes(spec(draft.request_spec).scopeIds,frozen,targetScope)
    if(saved===null&&requested===null)continue
    await db.query('update teloa_resource_drafts set spec=jsonb_set(spec,\'{scopeIds}\',$3::jsonb),request_spec=jsonb_set(request_spec,\'{scopeIds}\',$4::jsonb) where id=$1 and owner_id=$2',[draft.id,ownerId,JSON.stringify(saved??spec(draft.spec).scopeIds),JSON.stringify(requested??spec(draft.request_spec).scopeIds)])
    await receipt(db,ownerId,'resource-scope-rewritten','teloa_resource_drafts',text(draft.id),{spec:draft.spec,request_spec:draft.request_spec})
    summary.resources+=1
   }
  if(!tables.has('teloa_resources'))continue
  for(const resourceId of resourceIds){
   const resource=(await db.query('select id,spec from teloa_resources where id=$1 and owner_id=$2',[resourceId,ownerId])).rows[0]
   if(!resource)continue
   const scopeIds=nextScopes(spec(resource.spec).scopeIds,frozen,targetScope)
   if(scopeIds===null)continue
   await db.query('update teloa_resources set spec=jsonb_set(spec,\'{scopeIds}\',$3::jsonb) where id=$1 and owner_id=$2',[resourceId,ownerId,JSON.stringify(scopeIds)])
   await receipt(db,ownerId,'resource-scope-rewritten','teloa_resources',resourceId,{spec:resource.spec})
   summary.resources+=1
  }
 }
}

/** 四张 kit 实例表形状一致：`scope` 列进入映射指纹，因此两列同改；它们的回执里没有范围取值，不受影响。 */
async function rewriteKit(db:PoolClient,ownerId:string,table:string,frozen:ReadonlySet<string>,scopes:ReadonlyMap<string,string>,summary:BusinessSpaceMigrationSummary):Promise<void>{
 for(const row of (await db.query(`select * from ${table} where owner_id=$1 order by created_at,id`,[ownerId])).rows){
  const targetScope=scopes.get(text(row.load_id));if(targetScope===undefined)continue
  const scope=next(row.scope,frozen,targetScope);if(scope===null)continue
  const mappingDigest=industryPredicates.mapping({id:text(row.id),ownerId,loadId:text(row.load_id),itemInstanceId:text(row.item_instance_id),itemLocalId:text(row.item_local_id),contentId:text(row.content_id),contentHash:text(row.content_hash),itemVersion:text(row.item_version),scope})
  await db.query(`update ${table} set scope=$3,mapping_digest=$4 where id=$1 and owner_id=$2`,[row.id,ownerId,scope,mappingDigest])
  await receipt(db,ownerId,'scope-rewritten',table,text(row.id),{scope:row.scope,mapping_digest:row.mapping_digest})
  summary.scopes+=1
 }
}

/**
 * 回滚：按登记的倒序把 `previous` 的每个键原样写回，然后删掉全部回执。
 * 每条回执只描述一行上一次被改动的那些列，因此逐条写回就是迁移的逐步逆运算；没有回执时整体无操作。
 * 迁移登记的业务范围标签不在回滚范围内：标签是只增不减的目录条目，撤掉会让仍指向它的任务与群无法读写。
 */
export async function rollbackPersonalSpaceMigration(pool:Pool,ownerId:string):Promise<number>{
 owner(ownerId)
 const db=await pool.connect()
 try{
  await db.query('begin')
  await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['business-space-migration',ownerId])])
  if(!(await present(db,['teloa_business_space_migrations'])).has('teloa_business_space_migrations')){await db.query('commit');return 0}
  const rows=(await db.query('select * from teloa_business_space_migrations where owner_id=$1 order by seq desc',[ownerId])).rows
  for(const row of rows)await restore(db,ownerId,row)
  await db.query('delete from teloa_business_space_migrations where owner_id=$1',[ownerId])
  await db.query('commit')
  return rows.length
 }catch(error){await db.query('rollback').catch(()=>{});throw error}finally{db.release()}
}
/**
 * 单条回执的逆运算：`__deleted` 把整行原样插回，其余把 `previous` 的每个键写回。
 * 表名只认白名单，恰好命中一行才算成功——回执指向的行已不在，说明迁移之后另有写动过它，
 * 蛮力写回只会制造更深的不一致，此时整笔回滚失败且一条回执都不删。
 */
async function restore(db:PoolClient,ownerId:string,row:Row):Promise<void>{
 const table=text(row.target_table),previous=row.previous as Row
 const key=Object.prototype.hasOwnProperty.call(targetKeys,table)?targetKeys[table]!:undefined
 if(!key||!previous||typeof previous!=='object'||Array.isArray(previous)||!Object.keys(previous).length)throw corrupt()
 if('__deleted' in previous){
  const deleted=previous.__deleted as Row
  if(!deleted||typeof deleted!=='object'||Array.isArray(deleted)||!Object.keys(deleted).length||deleted.owner_id!==ownerId)throw corrupt()
  const columns=Object.keys(deleted)
  if(columns.some(column=>!/^[a-z_]+$/.test(column)))throw corrupt()
  const inserted=await db.query(`insert into ${table}(${columns.join(',')}) values(${columns.map((_,index)=>'$'+(index+1)).join(',')})`,columns.map(column=>deleted[column]))
  if(inserted.rowCount!==1)throw corrupt()
  return
 }
 const values:unknown[]=[text(row.target_id),ownerId]
 const sets=Object.entries(previous).map(([column,value])=>{
  if(!/^[a-z_]+$/.test(column))throw corrupt()
  if(value===null)return `${column}=null`
  values.push(typeof value==='object'?JSON.stringify(value):value)
  return `${column}=$${values.length}`+(typeof value==='object'?'::jsonb':'')
 })
 const updated=await db.query(`update ${table} set ${sets.join(',')} where ${key}=$1 and owner_id=$2`,values)
 if(updated.rowCount!==1)throw corrupt()
}

import type {Pool,PoolClient} from 'pg'
import {WorkError,isBusinessScopeKey,builtinBusinessScopes,businessScopeKinds,isBuiltinBusinessScope,legacyBusinessScope,type BusinessScopeKind,type BusinessScopeLabel} from '@teloa/contract'

type Db=Pool|PoolClient
/** 登记一条标签所需的全部事实。`spaceId` 是表上的非空外键，调用方在写事务里手上恒有空间行，就近传入比再查一次可靠。 */
export type BusinessScopeInput={scope:string;title:string;kind:BusinessScopeKind;spaceId:string}

const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
const label=(value:unknown):value is string=>typeof value==='string'&&!!value.trim()&&value.length<=80&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)
const invalid=()=>new WorkError('teloa/invalid-input','业务范围标签请求格式不正确。')
const corrupt=()=>new WorkError('teloa/storage-corrupt','业务范围标签记录损坏，已停止读取。')
const owner=(value:string)=>{if(typeof value!=='string'||!value.trim()||value.length>128)throw new WorkError('teloa/forbidden','需要有效的本人身份。')}
/** 未登记的范围一律在写之前拒绝；文案与规格 §3.2 一致。 */
const unregistered=()=>new WorkError('teloa/invalid-input','业务范围未登记。')
/**
 * 业务范围标签当作业务身份用时的命名判据（唯一出处）：任务、群、计划与资料的范围列各有自己的正则
 * （`taskDefinition` 限 `[-a-zA-Z0-9_]+`、`resourceScopes` 限 `[a-zA-Z0-9_-]{1,64}`），取其交集。
 * 行业模板加载在写事务之前用它拒绝不合规的 `domain`；存量迁移用它判断哪些 `domain` 不能拿来改写冻结列。
 */
export const isBusinessScopeDomain=isBusinessScopeKey
/** 存量 `Design` 取值可能落在这四处；表缺失就说明该类还没接入，这条判据无从成立。 */
const legacySources:readonly {table:string;sql:string}[]=[
 {table:'teloa_tasks',sql:"select 1 from teloa_tasks where owner_id=$1 and definition->>'scope'=$2 limit 1"},
 {table:'teloa_plans',sql:'select 1 from teloa_plans where owner_id=$1 and scope=$2 limit 1'},
 {table:'teloa_groups',sql:"select 1 from teloa_groups where owner_id=$1 and definition->>'scope'=$2 limit 1"},
 {table:'teloa_industry_role_instances',sql:'select 1 from teloa_industry_role_instances where owner_id=$1 and scope=$2 limit 1'},
]
const present=async(db:Db,names:readonly string[]):Promise<Set<string>>=>
 new Set((await db.query('select name from unnest($1::text[]) as name where to_regclass(name) is not null',[[...names]])).rows.map(row=>row.name as string))
const sourceNoun=(value:unknown):value is string=>typeof value==='string'&&!!value.trim()&&value===value.trim()&&value.length<=12&&!/[\x00-\x1f\x7f]/.test(value)

/**
 * 行业模板固定快照里只取数据源的展示称呼。它是只读投影，不能信任数据库 JSON：
 * - 老快照没有 `sourceNoun` 仍有效；
 * - 显式但不合规的值说明快照损坏，不能在首页默默显示成另一种说法。
 */
function sourceNouns(snapshot:unknown):{sources:number;nouns:string[]}{
 if(!snapshot||typeof snapshot!=='object'||Array.isArray(snapshot)||!Array.isArray((snapshot as {resources?:unknown}).resources))throw corrupt()
 const found:{sources:number;nouns:string[]}={sources:0,nouns:[]}
 for(const resource of (snapshot as {resources:unknown[]}).resources){
  if(!resource||typeof resource!=='object'||Array.isArray(resource))throw corrupt()
  const row=resource as Record<string,unknown>
  if(row.kind!=='data-source')continue
  found.sources++
  if(Object.hasOwn(row,'sourceNoun')){
   if(!sourceNoun(row.sourceNoun))throw corrupt()
   found.nouns.push(row.sourceNoun)
  }
 }
 return found
}

/**
 * 同一业务可能来自多份行业模板。只有候选加载都声明同一个来源名词时才对首页给出；
 * 有未命名或互异来源时宁可让界面回落「数据源」，不能挑其中一条冒充整门业务。
 * 当前生效加载优先；都已卸载时再按历史加载作只读回顾。
 */
function scopeSourceNouns(rows:readonly Record<string,unknown>[]):Map<string,string>{
 const active=new Set(rows.filter(row=>row.status==='active').map(row=>row.scope).filter((scope):scope is string=>typeof scope==='string'))
 const grouped=new Map<string,{sources:number;nouns:string[]}>()
 for(const row of rows){
  if(typeof row.scope!=='string'||typeof row.status!=='string'||(row.status!=='active'&&row.status!=='unloaded'&&row.status!=='superseded'))throw corrupt()
  if(active.has(row.scope)&&row.status!=='active')continue
  const current=sourceNouns(row.source_snapshot)
  const entry=grouped.get(row.scope)??{sources:0,nouns:[]}
  entry.sources+=current.sources;entry.nouns.push(...current.nouns);grouped.set(row.scope,entry)
 }
 const result=new Map<string,string>()
 for(const [scope,value] of grouped){
  const unique=[...new Set(value.nouns)]
  if(value.sources>0&&value.sources===value.nouns.length&&unique.length===1)result.set(scope,unique[0]!)
 }
 return result
}

/**
 * 业务范围标签表：`scope` 是空间内的标签，主键按 (本人,标签) ——个人版一人一空间，标签在本人名下唯一。
 * 由 `initializeBusinessSpaces` 在建好空间表之后调用（外键依赖顺序），语句幂等可重跑。
 */
export async function initializeBusinessScopes(pool:Pool):Promise<void>{await pool.query(`
 create table if not exists teloa_business_scopes(owner_id text not null,space_id uuid not null,scope text not null,title text not null,kind text not null check(kind in ('builtin','domain','legacy')),created_at timestamptz not null,primary key(owner_id,scope),foreign key(space_id,owner_id) references teloa_business_spaces(id,owner_id));
 alter table teloa_business_scopes add column if not exists configuration_managed boolean not null default false;
 alter table teloa_business_scopes add column if not exists runtime_managed boolean not null default false;
 `)}

/**
 * 业务范围标签的登记与只读汇总。
 *
 * 校验取舍（规格 §3.2 + 2026-09-15 控制者裁定）：
 * 1. 三个内置取值 `general`/`SOC`/`AppSec` **恒有效**，哪怕标签表里一行都没有——大量既有装配直接 new 服务、
 *    从不引导本人空间，这些取值在那里一直是合法的业务身份，写路径不能因为"没引导过"就把它们判成未登记。
 * 2. 标签表不存在即视为标签登记尚未接入（与仓库既有的 `to_regclass` 缺表判据一致），校验整体放行；
 *    真实宿主装配里表恒存在，校验因此在真实路径上始终生效。
 * 3. 其余取值必须在表里有行才允许写入。
 */
export class BusinessScopeService{
 readonly pool:Db
 constructor(pool:Db){this.pool=pool}
 /** 幂等登记：已存在的行不改 `kind` 与 `title`——先到的来源（内置/加载/迁移）说了算，重复登记只是无操作。 */
 static async ensure(db:Db,ownerId:string,input:BusinessScopeInput):Promise<{created:boolean}>{
  owner(ownerId)
  if(!label(input.scope)||!label(input.title)||!businessScopeKinds.some(kind=>kind===input.kind)||!uuid(input.spaceId))throw invalid()
  const result=await db.query('insert into teloa_business_scopes(owner_id,space_id,scope,title,kind,created_at) values($1,$2,$3,$4,$5,now()) on conflict (owner_id,scope) do nothing returning scope',[ownerId,input.spaceId.toLowerCase(),input.scope,input.title,input.kind])
  return {created:result.rowCount===1}
 }
 /**
  * 登记三个内置范围；库里确有 `scope='Design'` 的存量行时一并登记为 `legacy` 标签，
  * 让既有任务、计划、群与岗位实例的该取值继续可读可写。迁移任务会重复做这件事，两边都幂等。
  */
 static async ensureBuiltin(db:Db,ownerId:string,spaceId:string):Promise<void>{
  for(const item of builtinBusinessScopes)await BusinessScopeService.ensure(db,ownerId,{scope:item.scope,title:item.title,kind:'builtin',spaceId})
  const tables=await present(db,legacySources.map(source=>source.table))
  for(const source of legacySources){
   if(!tables.has(source.table))continue
   if(!(await db.query(source.sql,[ownerId,legacyBusinessScope.scope])).rowCount)continue
   await BusinessScopeService.ensure(db,ownerId,{scope:legacyBusinessScope.scope,title:legacyBusinessScope.title,kind:'legacy',spaceId})
   return
  }
 }
 /** 写路径的判据：内置取值恒真，缺表视为未接入亦为真，其余取值按表里有没有行。 */
 static async registered(db:Db,ownerId:string,scope:string):Promise<boolean>{
  owner(ownerId)
  if(!label(scope))return false
  if(isBuiltinBusinessScope(scope))return true
  if(!(await present(db,['teloa_business_scopes'])).has('teloa_business_scopes'))return true
  return !!(await db.query('select 1 from teloa_business_scopes where owner_id=$1 and scope=$2',[ownerId,scope])).rowCount
 }
 /** 标签目录：按登记先后列出，并汇总各标签下的加载、任务与群数量。缺表的那一类计 0。 */
 async list(ownerId:string):Promise<BusinessScopeLabel[]>{
  owner(ownerId)
  if(!(await present(this.pool,['teloa_business_scopes'])).has('teloa_business_scopes'))return []
  // 排序与上限都与 harness 的严格回包对齐：内置范围按声明次序排在最前，其余按登记先后；一次最多 500 条。
  const builtinOrder=new Map(builtinBusinessScopes.map((item,index)=>[item.scope,index]))
  const rows=(await this.pool.query('select scope,title,kind from teloa_business_scopes where owner_id=$1 order by created_at,scope limit 500',[ownerId])).rows
   .sort((a,b)=>{
    const left=builtinOrder.has(a.scope)?builtinOrder.get(a.scope)!:Number.MAX_SAFE_INTEGER,right=builtinOrder.has(b.scope)?builtinOrder.get(b.scope)!:Number.MAX_SAFE_INTEGER
    return left-right
   })
  const tables=await present(this.pool,['teloa_industry_loads','teloa_tasks','teloa_groups'])
  const tally=async(table:string,sql:string):Promise<Map<string,{total:number;active:number}>>=>{
   const found=new Map<string,{total:number;active:number}>()
   if(!tables.has(table))return found
   for(const row of (await this.pool.query(sql,[ownerId])).rows){
    if(typeof row.scope!=='string'||!Number.isSafeInteger(Number(row.total))||!Number.isSafeInteger(Number(row.active)))throw corrupt()
    found.set(row.scope,{total:Number(row.total),active:Number(row.active)})
   }
   return found
  }
  const loads=await tally('teloa_industry_loads',"select scope,count(*)::int total,count(*) filter (where status='active')::int active from teloa_industry_loads where owner_id=$1 group by scope")
  const nouns=tables.has('teloa_industry_loads')?scopeSourceNouns((await this.pool.query("select scope,status,source_snapshot from teloa_industry_loads where owner_id=$1 order by created_at,id",[ownerId])).rows as Record<string,unknown>[]):new Map<string,string>()
  const tasks=await tally('teloa_tasks',"select definition->>'scope' as scope,count(*)::int total,0 as active from teloa_tasks where owner_id=$1 and definition->>'scope' is not null group by definition->>'scope'")
  const groups=await tally('teloa_groups',"select definition->>'scope' as scope,count(*)::int total,0 as active from teloa_groups where owner_id=$1 and definition->>'scope' is not null group by definition->>'scope'")
  return rows.map(row=>{
   if(!label(row.scope)||!label(row.title)||!businessScopeKinds.some(kind=>kind===row.kind))throw corrupt()
   const load=loads.get(row.scope)
   const sourceNoun=nouns.get(row.scope as string)
   return {scope:row.scope as string,title:row.title as string,kind:row.kind as BusinessScopeKind,loads:load?.total??0,activeLoads:load?.active??0,tasks:tasks.get(row.scope)?.total??0,groups:groups.get(row.scope)?.total??0,...(sourceNoun===undefined?{}:{sourceNoun})}
  })
 }
}

/** 任务、计划与群的写入校验：未登记的业务范围在任何写之前被拒，调用方的事务因此不会留下痕迹。 */
export async function assertBusinessScopeRegistered(db:Db,ownerId:string,scope:string):Promise<void>{
 if(!await BusinessScopeService.registered(db,ownerId,scope))throw unregistered()
}

import type {PoolClient} from 'pg'
import {WorkError} from '@teloa/contract'
import {detachIndustryInstanceByItem,detachIndustryInstances,industryDetachedState} from './industry-instance-kit.ts'
import {deleteIndustryUsages} from '../market/skill-installations.ts'

/**
 * 卸载协议的写入副作用，单独成模块。
 *
 * `industry-loads.ts` 要建加载表，因此依赖 `business-spaces.ts`；而业务空间引导之后要跑存量迁移，
 * 迁移退役重复加载时又需要这一段卸载协议。三者直接互相引用会形成循环导入，
 * 于是把不依赖加载服务自身的这几步抽到这里：加载服务与迁移各自引用本模块，本模块谁也不引用。
 */

const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
const invalid=()=>new WorkError('teloa/invalid-input','行业模板加载请求格式不正确。')
const corrupt=()=>new WorkError('teloa/storage-corrupt','行业模板加载记录损坏，已停止读取。')

/** 卸载时在同一事务内暂停该加载计划所需的最小端口，由 `PlanService.changeInTransaction` 满足。 */
export type IndustryLoadPlanPort={changeInTransaction:(db:PoolClient,ownerId:string,input:unknown)=>Promise<unknown>}

/**
 * 由 industry-instance-kit 管理状态与修订的四类实例表，按资源类型定位到唯一一张表。
 * 键集是 `IndustryLoadResourceKind` 的子集，该联合类型仍归 `industry-loads.ts` 所有，
 * 由那边用 `satisfies` 复核，本模块因此不必反向引用它。
 */
export const detachTableByKind={'data-source':'teloa_industry_data_source_instances','execution-tool':'teloa_industry_execution_tool_instances',mcp:'teloa_industry_mcp_instances',plugin:'teloa_industry_plugin_instances'} as const satisfies Record<'data-source'|'execution-tool'|'mcp'|'plugin',string>
/** 卸载时统一解除的四类实例表。 */
export const detachTables:readonly string[]=Object.values(detachTableByKind)

/** 缺表即视为该类下游尚未接入：解除不因未初始化的表而失败，也不会遗漏已存在表上的写。 */
export async function presentTables(db:PoolClient,names:readonly string[]):Promise<Set<string>>{
 return new Set((await db.query('select name from unnest($1::text[]) as name where to_regclass(name) is not null',[[...names]])).rows.map(row=>row.name as string))
}
/**
 * 本加载沿用来的持有实例：继任加载上的沿用项自己没有实例行，实例仍挂在被替代（或更早）的加载上，
 * 因此按 `load_id` 一行都找不到。解除继任加载要连它们一起解除，否则升级过的模板卸载后仍留着一批可写实例。
 * 只取四类 kit 实例：知识与岗位的沿用项同样不改下游对象状态，与卸载"本地对象一律保留"的取舍一致。
 */
export async function carriedInstanceHolders(db:PoolClient,loadId:string):Promise<{table:string;itemInstanceId:string}[]>{
 const rows=(await db.query('select kind,carried_from from teloa_industry_load_items where load_id=$1 and carried_from is not null order by local_id',[loadId])).rows
 return rows.flatMap(row=>{
  const table=row.kind in detachTableByKind?detachTableByKind[row.kind as keyof typeof detachTableByKind]:undefined
  if(!table)return []
  if(!uuid(row.carried_from))throw corrupt()
  return [{table,itemInstanceId:row.carried_from as string}]
 })
}
/**
 * 暂停该加载创建且仍在生效的计划：原因记在计划变更台账，计划与其历史仍完整属于本人。
 * 缺表门槛只列本查询联接的两张表——它与卸载的阻塞检查是两笔独立判据，互不依赖对方的表是否存在。
 * 有在效计划却没接入持续计划服务时显式失败，不静默跳过。
 */
export async function pauseLoadPlans(db:PoolClient,ownerId:string,loadId:string,present:Set<string>,options:{note:string;dependency:string;plans:IndustryLoadPlanPort|undefined;identity:{id:()=>string}}):Promise<void>{
 if(!['teloa_plans','teloa_industry_plan_sources'].every(name=>present.has(name)))return
 const rows=(await db.query(`select p.id,p.version from teloa_plans p join teloa_industry_plan_sources s on s.plan_id=p.id and s.owner_id=p.owner_id where p.owner_id=$1 and s.source_snapshot->>'loadId'=$2 and p.state='active' order by p.id`,[ownerId,loadId])).rows
 if(!rows.length)return
 if(!options.plans)throw new WorkError('teloa/dependency-unavailable',options.dependency)
 for(const row of rows){
  const requestId=options.identity.id();if(!uuid(requestId))throw invalid()
  await options.plans.changeInTransaction(db,ownerId,{planId:row.id,requestId,expectedVersion:Number(row.version),action:'pause',note:options.note})
 }
}
/** 退役一条加载时逐行回调，用于调用方留下可回滚的原值；`__deleted` 表示整行被删除。 */
export type IndustryLoadRetireReceipt=(table:string,id:string,previous:Record<string,unknown>)=>Promise<void>
/**
 * 卸载协议的写入副作用：解除四类 kit 实例（含被沿用的来源实例）、删除该加载的 Skill 使用关系、暂停它创建的持续计划。
 * `unload` 与业务空间迁移共用同一段，迁移里把重复加载退役时不能绕过这三步，否则会留下仍可写的实例与仍在跑的计划。
 * 岗位、知识与任务一律不改状态：模板只失去活跃血缘，本地对象保留。
 */
export async function retireIndustryLoadInTransaction(db:PoolClient,ownerId:string,loadId:string,now:string,options:{present?:Set<string>;plans:IndustryLoadPlanPort|undefined;identity:{id:()=>string};note:string;dependency:string;receipt?:IndustryLoadRetireReceipt}):Promise<void>{
 const present=options.present??await presentTables(db,[...detachTables,'teloa_skill_install_usages','teloa_plans','teloa_industry_plan_sources'])
 const targets:{table:string;column:string;value:string}[]=[
  ...detachTables.filter(table=>present.has(table)).map(table=>({table,column:'load_id',value:loadId})),
  ...(await carriedInstanceHolders(db,loadId)).filter(target=>present.has(target.table)).map(target=>({table:target.table,column:'item_instance_id',value:target.itemInstanceId})),
 ]
 for(const target of targets){
  if(options.receipt)
   for(const row of (await db.query(`select id,state,revision,updated_at from ${target.table} where owner_id=$1 and ${target.column}=$2 and state<>$3`,[ownerId,target.value,industryDetachedState])).rows)
    await options.receipt(target.table,row.id as string,{state:row.state,revision:row.revision,updated_at:row.updated_at})
  if(target.column==='load_id')await detachIndustryInstances(db,target.table,ownerId,target.value,now)
  else await detachIndustryInstanceByItem(db,target.table,ownerId,target.value,now)
 }
 // Skill 使用关系按 (加载,加载项) 绑定且从不沿用，因此按 `load_id` 删除对继任加载同样完整。
 if(present.has('teloa_skill_install_usages')){
  if(options.receipt)
   for(const row of (await db.query('select * from teloa_skill_install_usages where owner_id=$1 and load_id=$2',[ownerId,loadId])).rows)
    await options.receipt('teloa_skill_install_usages',String(row.item_instance_id),{__deleted:row})
  await deleteIndustryUsages(db,ownerId,loadId)
 }
 // 计划暂停走持续计划服务自己的协议（版本 +1 与变更台账），因此不进迁移回执：用蛮力写回会把台账改坏。
 await pauseLoadPlans(db,ownerId,loadId,present,{note:options.note,dependency:options.dependency,plans:options.plans,identity:options.identity})
}

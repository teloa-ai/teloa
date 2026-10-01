import type {PoolClient} from 'pg'
import {WorkError,isRecord,industryResourceModelDependencies,assertIndustryModelsReady,type IndustryModelProbe} from '@teloa/contract'
import {readEnabledIndustrySkillUsage} from '../market/skill-installations.ts'

export type IndustryRunSkillBindings={installationIds:string[]}

const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
const stableId=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9-]{0,119}$/.test(value)
const semver=(value:unknown):value is string=>typeof value==='string'&&value.length<=80&&/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value)
const corrupt=()=>new WorkError('teloa/storage-corrupt','行业任务技能绑定记录损坏，已停止准备执行。')

type DeclaredSkill={id:string;title:string;version:string}
type Origin={loadId:string;workItemInstanceId:string;skills:DeclaredSkill[]}
type Relation={kind:string;from:string;to:string}

function skills(value:unknown):DeclaredSkill[]{
 if(!Array.isArray(value)||value.length>100)throw corrupt()
 const seen=new Set<string>()
 return value.map(item=>{
  if(!isRecord(item)||Object.keys(item).length!==3||Object.keys(item).some(key=>!['id','title','version'].includes(key))||!stableId(item.id)||typeof item.title!=='string'||!item.title.trim()||item.title.length>120||!semver(item.version)||seen.has(item.id))throw corrupt()
  seen.add(item.id);return {id:item.id,title:item.title.trim(),version:item.version}
 })
}
function origin(value:unknown,kind:'task'|'plan'):Origin{
 if(!isRecord(value)||!uuid(value.loadId)||!uuid(value.itemInstanceId))throw corrupt()
 if(kind==='task')return {loadId:value.loadId,workItemInstanceId:value.itemInstanceId,skills:skills(value.skills)}
 if(!isRecord(value.work))throw corrupt()
 return {loadId:value.loadId,workItemInstanceId:value.itemInstanceId,skills:skills(value.work.skills)}
}
function relation(value:unknown):Relation{
 if(!isRecord(value)||Object.keys(value).length!==3||typeof value.kind!=='string'||!value.kind||!uuid(value.from)||!uuid(value.to))throw corrupt()
 return {kind:value.kind,from:value.from,to:value.to}
}

/**
 * 从已经固定的行业任务或行业计划来源，解析本轮真正需要的 Skill 安装。
 * 工作模板声明决定本轮用哪些 Skill，岗位关系决定是否允许，usage 决定精确版本。
 */
export async function resolveIndustryRunSkillBindings(db:PoolClient,ownerId:string,taskId:string,roleId:string,models?:IndustryModelProbe):Promise<IndustryRunSkillBindings|undefined>{
 if(typeof ownerId!=='string'||!ownerId||!uuid(taskId)||!uuid(roleId))throw corrupt()
 const direct=(await db.query('select source_snapshot from teloa_industry_task_sources where owner_id=$1 and task_id=$2 for share',[ownerId,taskId])).rows[0]
 const planned=(await db.query(`select s.source_snapshot from teloa_tasks t join teloa_plan_occurrences o on o.owner_id=t.owner_id and o.task_request_id=t.request_id join teloa_industry_plan_sources s on s.owner_id=o.owner_id and s.plan_id=o.plan_id where t.owner_id=$1 and t.id=$2 for share of s`,[ownerId,taskId])).rows[0]
 if(direct&&planned)throw corrupt()
 if(!direct&&!planned)return undefined
 const fixed=direct?origin(direct.source_snapshot,'task'):origin(planned.source_snapshot,'plan')
 const loadRow=(await db.query('select relations,status,source_snapshot from teloa_industry_loads where owner_id=$1 and id=$2 for share',[ownerId,fixed.loadId])).rows[0]
 if(!loadRow||!Array.isArray(loadRow.relations))throw corrupt()
 // 已卸载或已被升级替代的加载不再提供可执行血缘：固定来源仍在，但本轮不能再据它准备执行。
 if(loadRow.status!=='active')throw new WorkError('teloa/conflict','行业模板已卸载或已被升级替代，不能继续准备执行。')
 const relations:Relation[]=(loadRow.relations as unknown[]).map(relation)
 const roleRows=(await db.query('select item_instance_id,phase from teloa_industry_role_instances where owner_id=$1 and load_id=$2 and role_id=$3 for share',[ownerId,fixed.loadId,roleId])).rows
 if(roleRows.length!==1||!uuid(roleRows[0].item_instance_id)||!['prepared','needs-recovery'].includes(String(roleRows[0].phase)))throw new WorkError('teloa/conflict','行业任务负责人未绑定到该行业加载中的真实员工。')
 const roleItemId=roleRows[0].item_instance_id as string
 if(!relations.some(link=>link.kind==='role-work'&&link.from===roleItemId&&link.to===fixed.workItemInstanceId))throw new WorkError('teloa/conflict','行业任务与当前员工没有可执行关联。')
 const itemRows=(await db.query('select local_id,instance_id,kind,title,version,status from teloa_industry_load_items where load_id=$1 order by local_id for share',[fixed.loadId])).rows
 const items=new Map<string,{instanceId:string;kind:string;title:string;version:string;status:string}>()
 for(const row of itemRows){if(!stableId(row.local_id)||!uuid(row.instance_id)||typeof row.kind!=='string'||typeof row.title!=='string'||!row.title||!semver(row.version)||!['pending-adapter','skipped'].includes(String(row.status))||items.has(row.local_id))throw corrupt();items.set(row.local_id,{instanceId:row.instance_id,kind:row.kind,title:row.title,version:row.version,status:row.status})}
 const installationIds:string[]=[],nativeNames=new Set<string>()
 for(const declared of fixed.skills){
  const item=items.get(declared.id)
  if(!item||item.kind!=='skill'||item.status!=='pending-adapter'||item.title!==declared.title||item.version!==declared.version)throw new WorkError('teloa/dependency-unavailable','行业工作声明的技能与加载目录不一致。')
  if(!relations.some(link=>link.kind==='role-skill'&&link.from===roleItemId&&link.to===item.instanceId))throw new WorkError('teloa/conflict','当前员工没有使用该行业技能的职责关系。')
  // 模型声明来自固定加载快照，不从 Skill 正文或模型输出推断；停用后再次执行也需重验。
  const snapshot=loadRow.source_snapshot
  if(!isRecord(snapshot)||!Array.isArray(snapshot.resources))throw corrupt()
  const resource=snapshot.resources.find(row=>isRecord(row)&&row.localId===declared.id)
  if(!isRecord(resource)||resource.kind!=='skill')throw corrupt()
  await assertIndustryModelsReady(industryResourceModelDependencies(resource.kind,resource.modelDependencies).modelDependencies,models)
  const installation=await readEnabledIndustrySkillUsage(db,ownerId,fixed.loadId,item.instanceId)
  if(!installation)throw new WorkError('teloa/dependency-unavailable','请先安装行业工作所需的技能。')
  if(nativeNames.has(installation.native.name)||installationIds.includes(installation.id))throw corrupt()
  nativeNames.add(installation.native.name);installationIds.push(installation.id)
 }
 return {installationIds}
}

/**
 * 岗位的行业职责技能名（技能代发授权页候选，规格 2026-09-27 §5.1 审查修复 R1 M-1）：
 * 只看仍在用（active）的行业加载里，本岗位实例经 `role-skill` 关系指向、且已有启用 usage 的技能安装；按名去重、保持出现顺序。
 * 只用于授权页列出候选，不参与运行准备；运行时仍按 `resolveIndustryRunSkillBindings` 固定精确安装。
 */
export async function readRoleIndustrySkillNames(db:PoolClient,ownerId:string,roleId:string):Promise<string[]>{
 if(typeof ownerId!=='string'||!ownerId||!uuid(roleId))throw corrupt()
 const rows=(await db.query(`select r.load_id,r.item_instance_id,l.relations from teloa_industry_role_instances r join teloa_industry_loads l on l.owner_id=r.owner_id and l.id=r.load_id where r.owner_id=$1 and r.role_id=$2 and l.status='active' and r.phase in ('prepared','needs-recovery') order by r.load_id`,[ownerId,roleId])).rows
 const names:string[]=[]
 for(const row of rows){
  if(!uuid(row.load_id)||!uuid(row.item_instance_id)||!Array.isArray(row.relations))throw corrupt()
  const targets=(row.relations as unknown[]).map(relation).filter(link=>link.kind==='role-skill'&&link.from===row.item_instance_id).map(link=>link.to)
  for(const target of targets){
   // 已停用的安装（readEnabledSkillInstallation 回 conflict）不列入候选；其余错误原样上抛。
   const installation=await readEnabledIndustrySkillUsage(db,ownerId,row.load_id,target).catch((error:unknown)=>{if(error instanceof WorkError&&error.code==='teloa/conflict')return null;throw error})
   if(installation&&!names.includes(installation.native.name))names.push(installation.native.name)
  }
 }
 return names
}

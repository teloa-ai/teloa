import {createHash} from 'node:crypto'
import type {Pool,PoolClient} from 'pg'
import {WorkError,isRecord} from '@teloa/contract'
import {readStoredSkillInstallation,type SkillInstallation} from './skill-installations.ts'
import {readSkillSelection} from './skill-selections.ts'
import type {RunSkill} from '../work/task-run-skills.ts'
import {readStoredRole} from '../work/roles.ts'
import {readStoredPlan} from '../work/plans.ts'
import {readStoredTask} from '../work/tasks.ts'
import {readStoredTaskRun} from '../work/task-runs.ts'
import {verifyTaskRunSkillRefs} from '../work/task-run-skill-refs.ts'

export type SkillAvailabilityValue='enabled'|'disabled'
export type SkillAvailability={installationId:string;ownerId:string;availability:SkillAvailabilityValue;version:number;updatedAt:string}
export type SkillAvailabilityImpact={
 installation:{id:string;version:number;bundleHash:string;nativeName:string}
 availability:{value:SkillAvailabilityValue;version:number}
 industryUsages:{loadId:string;itemInstanceId:string}[]
 roles:{roleId:string;version:number;state:'active'|'paused'|'retired';name:string}[]
 plans:{planId:string;version:number;state:'paused'|'active'|'archived';roleId:string}[]
 tasks:{taskId:string;version:number;state:string;assigneeRoleId:string|null}[]
 runs:{runId:string;taskId:string;roleId:string;state:string}[]
 ordinarySessions:{status:'unknown'}
}
export type SkillAvailabilityPreview={installation:SkillInstallation;availability:SkillAvailability;impact:SkillAvailabilityImpact;impactDigest:string;blockers:Array<'installation-not-installed'>}
export type SkillAvailabilityChangeInput={requestId:string;installationId:string;expectedVersion:number;expectedBundleHash:string;expectedImpactDigest:string;action:'disable'|'enable';reason?:string}
export type SkillAvailabilityReceipt={requestId:string;installationId:string;action:'disable'|'enable';reason:string;impact:SkillAvailabilityImpact;impactDigest:string;result:SkillAvailability;createdAt:string}
export type SkillAvailabilityChange={receipt:SkillAvailabilityReceipt;current:SkillAvailability}
export type SkillAvailabilityRestorePort={verify:(db:PoolClient,ownerId:string,installation:SkillInstallation)=>Promise<void>}

const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
const hex=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)
const positive=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>0&&Number(value)<=2147483647
const stamp=(value:unknown)=>{if(!(value instanceof Date)||!Number.isFinite(value.getTime()))throw corrupt();return value.toISOString()}
const jsonStamp=(value:unknown)=>{if(typeof value!=='string'||!Number.isFinite(Date.parse(value))||new Date(value).toISOString()!==value)throw corrupt();return value}
const stable=(value:unknown):string=>JSON.stringify(value,(_,item)=>isRecord(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a<b?-1:a>b?1:0)):item)
const sha=(value:string)=>createHash('sha256').update(value).digest('hex')
const invalid=()=>new WorkError('teloa/invalid-input','技能可用状态请求格式不正确。')
const corrupt=()=>new WorkError('teloa/storage-corrupt','技能可用状态或维护回执损坏，已停止读取。')
const exact=(value:unknown,keys:readonly string[],stored=false):Record<string,unknown>=>{if(!isRecord(value)||Object.keys(value).some(key=>!keys.includes(key)))throw stored?corrupt():invalid();return value}
const owner=(value:string)=>{if(typeof value!=='string'||!value.trim()||value.length>128)throw new WorkError('teloa/forbidden','需要有效的本人身份。')}
const limit=<T>(values:T[]):T[]=>{if(values.length>1000)throw new WorkError('teloa/conflict','技能影响范围超过单次维护上限。');return values}

export async function initializeSkillAvailabilities(pool:Pool){
 const db=await pool.connect()
 try{
  await db.query('begin')
  await db.query(`
   create unique index if not exists teloa_skill_installations_identity_owner on teloa_skill_installations(id,owner_id);
   create table if not exists teloa_skill_install_availability(
    installation_id uuid primary key,owner_id text not null,availability text not null check(availability in ('enabled','disabled')),
    version integer not null check(version>0),updated_at timestamptz not null,unique(installation_id,owner_id),
    foreign key(installation_id,owner_id) references teloa_skill_installations(id,owner_id)
   );
   create table if not exists teloa_skill_install_maintenance_requests(
    owner_id text not null,request_id uuid not null,installation_id uuid not null,request_spec jsonb not null check(jsonb_typeof(request_spec)='object'),
    impact_snapshot jsonb not null check(jsonb_typeof(impact_snapshot)='object'),impact_digest text not null check(impact_digest ~ '^[a-f0-9]{64}$'),
    result jsonb not null check(jsonb_typeof(result)='object'),receipt_digest text not null check(receipt_digest ~ '^[a-f0-9]{64}$'),created_at timestamptz not null,
    primary key(owner_id,request_id),foreign key(installation_id,owner_id) references teloa_skill_installations(id,owner_id)
   );
   create table if not exists teloa_skill_install_availability_migrations(name text primary key,applied_at timestamptz not null)
  `)
  await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',['teloa/skill-install-availability-migrations'])
  const first=await db.query("insert into teloa_skill_install_availability_migrations(name,applied_at) values('initial-backfill-v1',clock_timestamp()) on conflict(name) do nothing returning name")
  if(first.rowCount)await db.query("insert into teloa_skill_install_availability(installation_id,owner_id,availability,version,updated_at) select id,owner_id,'enabled',1,updated_at from teloa_skill_installations on conflict(installation_id) do nothing")
  await db.query('commit')
 }catch(error){await db.query('rollback').catch(()=>{});throw error}finally{db.release()}
}

export function readStoredSkillAvailability(row:Record<string,unknown>,ownerId:string):SkillAvailability{
 if(row.owner_id!==ownerId||!uuid(row.installation_id)||!['enabled','disabled'].includes(String(row.availability))||!positive(row.version))throw corrupt()
 return {installationId:row.installation_id,ownerId,availability:row.availability as SkillAvailabilityValue,version:row.version,updatedAt:stamp(row.updated_at)}
}
export async function readSkillAvailability(db:PoolClient,ownerId:string,installationId:string):Promise<SkillAvailability>{
 const installed=(await db.query('select owner_id from teloa_skill_installations where id=$1',[installationId])).rows[0]
 if(!installed||installed.owner_id!==ownerId)throw new WorkError('teloa/forbidden','技能安装不存在或不属于当前本人。')
 const row=(await db.query('select * from teloa_skill_install_availability where installation_id=$1',[installationId])).rows[0]
 if(!row)throw corrupt()
 return readStoredSkillAvailability(row,ownerId)
}
export async function readSkillAvailabilityByName(db:PoolClient,ownerId:string,name:string):Promise<SkillAvailability|undefined>{
 const rows=await db.query('select i.*,a.installation_id availability_installation_id,a.owner_id availability_owner_id,a.availability,a.version availability_version,a.updated_at availability_updated_at from teloa_skill_selections s join teloa_skill_installations i on i.id=s.installation_id and i.owner_id=s.owner_id and i.native_name=s.native_name left join teloa_skill_install_availability a on a.installation_id=i.id and a.owner_id=i.owner_id where s.owner_id=$1 and s.native_name=$2',[ownerId,name])
 if(!rows.rows[0])return undefined
 const installation=readStoredSkillInstallation(rows.rows[0],ownerId),row=rows.rows[0]
 if(row.availability_installation_id===null)throw corrupt()
 return readStoredSkillAvailability({installation_id:row.availability_installation_id,owner_id:row.availability_owner_id,availability:row.availability,version:row.availability_version,updated_at:row.availability_updated_at},installation.ownerId)
}
/** 技能名的安装绑定三态：未安装；已安装且绑定到官方目录条目（entryId）；已安装但来源不是目录条目（GitHub/上传/行业方案）或回执缺失（entryId 缺省）。 */
export type InstalledSkillBinding={installed:false}|{installed:true;entryId?:string}
/**
 * 当前安装（选定）绑定：选定 → 安装 → 内容（industry-public 取 sourceContentId，即公共来源技能内容）→ 导入回执 source.kind==='catalog' 的 entryId。
 * 供技能密钥声明按条目 id 取用：调用方对「已安装但非目录来源」与「未安装」都不注入任何目录密钥（fail-closed）。
 */
export async function readInstalledSkillBinding(db:PoolClient,ownerId:string,name:string):Promise<InstalledSkillBinding>{
 const rows=await db.query('select i.source from teloa_skill_selections s join teloa_skill_installations i on i.id=s.installation_id and i.owner_id=s.owner_id and i.native_name=s.native_name where s.owner_id=$1 and s.native_name=$2',[ownerId,name])
 const source=rows.rows[0]?.source
 if(!isRecord(source))return {installed:false}
 const contentId=source.kind==='industry-public'?source.sourceContentId:source.contentId
 if(typeof contentId!=='string')return {installed:true}
 const imports=await db.query('select source from teloa_market_imports where owner_id=$1 and content_id=$2 order by created_at desc limit 1',[ownerId,contentId])
 const origin=imports.rows[0]?.source
 return isRecord(origin)&&origin.kind==='catalog'&&typeof origin.entryId==='string'?{installed:true,entryId:origin.entryId}:{installed:true}
}
export async function assertRunSkillsEnabled(db:PoolClient,ownerId:string,skills:readonly Pick<RunSkill,'name'|'managed'>[]):Promise<void>{
 const keys=new Set<string>()
 for(const skill of skills){
  const key=skill.managed?.installationId??'name:'+skill.name
  if(keys.has(key))continue
  keys.add(key)
  const row=skill.managed
   ?(await db.query('select * from teloa_skill_installations where id=$1 and owner_id=$2 for share',[skill.managed.installationId,ownerId])).rows[0]
   :(await db.query('select i.* from teloa_skill_selections s join teloa_skill_installations i on i.id=s.installation_id and i.owner_id=s.owner_id and i.native_name=s.native_name where s.owner_id=$1 and s.native_name=$2 for share of i',[ownerId,skill.name])).rows[0]
  if(!row)continue
  const fixed=readStoredSkillInstallation(row,ownerId),availabilityRow=(await db.query('select * from teloa_skill_install_availability where installation_id=$1 and owner_id=$2 for share',[fixed.id,ownerId])).rows[0]
  if(fixed.native.name!==skill.name)throw corrupt()
  if(!availabilityRow)throw corrupt()
  if(readStoredSkillAvailability(availabilityRow,ownerId).availability==='disabled')throw new WorkError('teloa/conflict','员工声明包含已停用技能，请先恢复后再准备或领取执行。')
 }
}
export async function createSkillAvailability(db:PoolClient,ownerId:string,installationId:string,updatedAt:string){
 await db.query("insert into teloa_skill_install_availability(installation_id,owner_id,availability,version,updated_at) values($1,$2,'enabled',1,$3)",[installationId,ownerId,updatedAt])
}

function availabilityFromJson(value:unknown,ownerId:string):SkillAvailability{
 const row=exact(value,['installationId','ownerId','availability','version','updatedAt'],true)
 if(!uuid(row.installationId)||row.ownerId!==ownerId||!['enabled','disabled'].includes(String(row.availability))||!positive(row.version))throw corrupt()
 return {installationId:row.installationId,ownerId,availability:row.availability as SkillAvailabilityValue,version:row.version,updatedAt:jsonStamp(row.updatedAt)}
}
function readUsage(row:Record<string,unknown>,ownerId:string,installationId:string){
 if(row.owner_id!==ownerId||row.installation_id!==installationId||!uuid(row.load_id)||!uuid(row.item_instance_id)||!hex(row.usage_hash)||row.usage_hash!==sha(stable([ownerId,row.load_id,row.item_instance_id,installationId])))throw corrupt()
 return {loadId:row.load_id,itemInstanceId:row.item_instance_id}
}
const sorted=(values:unknown[],key:(value:any)=>string)=>values.every((value,index)=>index===0||key(values[index-1])<key(value))
function readImpact(value:unknown):SkillAvailabilityImpact{
 const row=exact(value,['installation','availability','industryUsages','roles','plans','tasks','runs','ordinarySessions'],true),installation=exact(row.installation,['id','version','bundleHash','nativeName'],true),availability=exact(row.availability,['value','version'],true),ordinary=exact(row.ordinarySessions,['status'],true)
 if(!uuid(installation.id)||!positive(installation.version)||!hex(installation.bundleHash)||typeof installation.nativeName!=='string'||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(installation.nativeName)||!['enabled','disabled'].includes(String(availability.value))||!positive(availability.version)||ordinary.status!=='unknown')throw corrupt()
 const industryUsages:Array<{loadId:string;itemInstanceId:string}>=[],roles:SkillAvailabilityImpact['roles']=[],plans:SkillAvailabilityImpact['plans']=[],tasks:SkillAvailabilityImpact['tasks']=[],runs:SkillAvailabilityImpact['runs']=[]
 if(!Array.isArray(row.industryUsages)||!Array.isArray(row.roles)||!Array.isArray(row.plans)||!Array.isArray(row.tasks)||!Array.isArray(row.runs))throw corrupt()
 for(const raw of limit(row.industryUsages)){const item=exact(raw,['loadId','itemInstanceId'],true);if(!uuid(item.loadId)||!uuid(item.itemInstanceId))throw corrupt();industryUsages.push({loadId:item.loadId,itemInstanceId:item.itemInstanceId})}
 for(const raw of limit(row.roles)){const item=exact(raw,['roleId','version','state','name'],true);if(!uuid(item.roleId)||!positive(item.version)||!['active','paused','retired'].includes(String(item.state))||typeof item.name!=='string'||!item.name.trim())throw corrupt();roles.push(item as SkillAvailabilityImpact['roles'][number])}
 for(const raw of limit(row.plans)){const item=exact(raw,['planId','version','state','roleId'],true);if(!uuid(item.planId)||!positive(item.version)||!['active','paused','archived'].includes(String(item.state))||!uuid(item.roleId))throw corrupt();plans.push(item as SkillAvailabilityImpact['plans'][number])}
 for(const raw of limit(row.tasks)){const item=exact(raw,['taskId','version','state','assigneeRoleId'],true);if(!uuid(item.taskId)||!positive(item.version)||typeof item.state!=='string'||!item.state||item.assigneeRoleId!==null&&!uuid(item.assigneeRoleId))throw corrupt();tasks.push(item as SkillAvailabilityImpact['tasks'][number])}
 for(const raw of limit(row.runs)){const item=exact(raw,['runId','taskId','roleId','state'],true);if(!uuid(item.runId)||!uuid(item.taskId)||!uuid(item.roleId)||typeof item.state!=='string'||!item.state)throw corrupt();runs.push(item as SkillAvailabilityImpact['runs'][number])}
 if(!sorted(industryUsages,value=>value.loadId+':'+value.itemInstanceId)||!sorted(roles,value=>value.roleId)||!sorted(plans,value=>value.planId)||!sorted(tasks,value=>value.taskId)||!sorted(runs,value=>value.runId))throw corrupt()
 return {installation:{id:installation.id,version:installation.version,bundleHash:installation.bundleHash,nativeName:installation.nativeName},availability:{value:availability.value as SkillAvailabilityValue,version:availability.version},industryUsages,roles,plans,tasks,runs,ordinarySessions:{status:'unknown'}}
}
async function impact(db:PoolClient,ownerId:string,installation:SkillInstallation,availability:SkillAvailability):Promise<SkillAvailabilityImpact>{
 const usageRows=(await db.query('select * from teloa_skill_install_usages where owner_id=$1 and installation_id=$2 order by load_id,item_instance_id limit 1001',[ownerId,installation.id])).rows
 const industryUsages=limit(usageRows.map(row=>readUsage(row,ownerId,installation.id)))
 const allRoles=(await db.query('select * from teloa_roles where owner_id=$1 order by id',[ownerId])).rows.map(readStoredRole),affectedRoles=limit(allRoles.filter(role=>role.skills.includes(installation.native.name))),roleIds=new Set(affectedRoles.map(role=>role.id))
 const allPlans=(await db.query('select * from teloa_plans where owner_id=$1 order by id',[ownerId])).rows.map(readStoredPlan),affectedPlans=limit(allPlans.filter(plan=>roleIds.has(plan.roleId)))
 const refRows=(await db.query('select r.* from teloa_task_runs r join teloa_task_run_skill_refs s on s.run_id=r.id and s.owner_id=r.owner_id where r.owner_id=$1 and s.installation_id=$2 order by r.id limit 1001',[ownerId,installation.id])).rows,runs=[]
 for(const row of limit(refRows)){const run=readStoredTaskRun(row);await verifyTaskRunSkillRefs(db,ownerId,run.id,run.skills);runs.push({runId:run.id,taskId:run.taskId,roleId:run.roleId,state:run.state})}
 const runTaskIds=new Set(runs.map(run=>run.taskId)),allTasks=(await db.query('select * from teloa_tasks where owner_id=$1 order by id',[ownerId])).rows.map(readStoredTask),affectedTasks=limit(allTasks.filter(task=>task.assigneeRoleId!==null&&roleIds.has(task.assigneeRoleId)||runTaskIds.has(task.id)))
 return {installation:{id:installation.id,version:installation.version,bundleHash:installation.bundleHash,nativeName:installation.native.name},availability:{value:availability.availability,version:availability.version},industryUsages,roles:affectedRoles.map(role=>({roleId:role.id,version:role.version,state:role.state,name:role.name})),plans:affectedPlans.map(plan=>({planId:plan.id,version:plan.version,state:plan.state,roleId:plan.roleId})),tasks:affectedTasks.map(task=>({taskId:task.id,version:task.version,state:task.state,assigneeRoleId:task.assigneeRoleId})),runs,ordinarySessions:{status:'unknown'}}
}
function getInput(value:unknown){const row=exact(value,['installationId']);if(!uuid(row.installationId))throw invalid();return row.installationId.toLowerCase()}
function changeInput(value:unknown){
 const row=exact(value,['requestId','installationId','expectedVersion','expectedBundleHash','expectedImpactDigest','action','reason'])
 if(!uuid(row.requestId)||!uuid(row.installationId)||!positive(row.expectedVersion)||!hex(row.expectedBundleHash)||!hex(row.expectedImpactDigest)||!['disable','enable'].includes(String(row.action))||row.reason!==undefined&&typeof row.reason!=='string')throw invalid()
 const reason=typeof row.reason==='string'?row.reason.trim():'';if(reason.length>4000)throw invalid()
 return {requestId:row.requestId.toLowerCase(),installationId:row.installationId.toLowerCase(),expectedVersion:row.expectedVersion,expectedBundleHash:row.expectedBundleHash,expectedImpactDigest:row.expectedImpactDigest,action:row.action as 'disable'|'enable',reason}
}
async function installation(db:PoolClient,ownerId:string,id:string,lock=''){
 const row=(await db.query(`select * from teloa_skill_installations where id=$1 ${lock}`,[id])).rows[0]
 if(!row||row.owner_id!==ownerId)throw new WorkError('teloa/forbidden','技能安装不存在或不属于当前本人。')
 return readStoredSkillInstallation(row,ownerId)
}
function receipt(row:Record<string,unknown>,ownerId:string,spec:ReturnType<typeof changeInput>):SkillAvailabilityReceipt{
 let stored:ReturnType<typeof changeInput>;try{stored=changeInput(row.request_spec)}catch{throw corrupt()}
 const fixedImpact=readImpact(row.impact_snapshot),result=availabilityFromJson(row.result,ownerId),createdAt=stamp(row.created_at)
 if(stable(stored)!==stable(spec))throw new WorkError('teloa/conflict','同一技能启停请求不能更换动作、版本或影响范围。')
 const before=spec.action==='disable'?'enabled':'disabled'
 if(row.owner_id!==ownerId||row.request_id!==spec.requestId||row.installation_id!==spec.installationId||!hex(row.impact_digest)||row.impact_digest!==skillAvailabilityImpactDigest(fixedImpact)||row.impact_digest!==spec.expectedImpactDigest||fixedImpact.installation.id!==spec.installationId||fixedImpact.installation.bundleHash!==spec.expectedBundleHash||fixedImpact.availability.version!==spec.expectedVersion||fixedImpact.availability.value!==before||result.installationId!==spec.installationId||result.version!==spec.expectedVersion+1||result.availability!==(spec.action==='disable'?'disabled':'enabled')||!hex(row.receipt_digest))throw corrupt()
 const value={requestId:spec.requestId,installationId:spec.installationId,action:spec.action,reason:spec.reason,impact:fixedImpact,impactDigest:row.impact_digest,result,createdAt}
 if(row.receipt_digest!==sha(stable([ownerId,value])))throw corrupt()
 return value
}

export class SkillAvailabilityService{
 readonly pool:Pool;readonly identity:{now:()=>string};readonly restore:SkillAvailabilityRestorePort|undefined
 constructor(pool:Pool,identity:{now:()=>string},restore?:SkillAvailabilityRestorePort){this.pool=pool;this.identity=identity;this.restore=restore}
 private async tx<T>(readOnly:boolean,fn:(db:PoolClient)=>Promise<T>):Promise<T>{const db=await this.pool.connect();try{await db.query(readOnly?'begin isolation level repeatable read read only':'begin');const value=await fn(db);await db.query('commit');return value}catch(error){await db.query('rollback').catch(()=>{});if(error instanceof WorkError)throw error;throw new WorkError('teloa/storage-unavailable','技能可用状态存储操作未完成。')}finally{db.release()}}
 async get(ownerId:string,value:unknown):Promise<SkillAvailability>{owner(ownerId);const id=getInput(value);return this.tx(true,db=>readSkillAvailability(db,ownerId,id))}
 async directory(ownerId:string):Promise<{installation:SkillInstallation;availability:SkillAvailability}[]>{owner(ownerId);return this.tx(true,async db=>{const rows=(await db.query('select * from teloa_skill_installations where owner_id=$1 order by created_at,id',[ownerId])).rows,result=[];for(const row of rows){const fixed=readStoredSkillInstallation(row,ownerId);result.push({installation:fixed,availability:await readSkillAvailability(db,ownerId,fixed.id)})}return result})}
 async selectedDirectory(ownerId:string):Promise<{installation:SkillInstallation;availability:SkillAvailability;selectionVersion:number}[]>{owner(ownerId);return this.tx(true,async db=>{
  const rows=(await db.query('select i.* from teloa_skill_selections s join teloa_skill_installations i on i.id=s.installation_id and i.owner_id=s.owner_id and i.native_name=s.native_name where s.owner_id=$1 order by s.native_name',[ownerId])).rows,result=[]
  for(const row of rows){const fixed=readStoredSkillInstallation(row,ownerId),selection=await readSkillSelection(db,ownerId,fixed.native.name);if(!selection||selection.installationId!==fixed.id)throw corrupt();result.push({installation:fixed,availability:await readSkillAvailability(db,ownerId,fixed.id),selectionVersion:selection.version})}
  return result
 })}
 async preview(ownerId:string,value:unknown):Promise<SkillAvailabilityPreview>{owner(ownerId);const id=getInput(value);return this.tx(true,async db=>{const fixedInstallation=await installation(db,ownerId,id),current=await readSkillAvailability(db,ownerId,id),fixedImpact=await impact(db,ownerId,fixedInstallation,current);return {installation:fixedInstallation,availability:current,impact:fixedImpact,impactDigest:skillAvailabilityImpactDigest(fixedImpact),blockers:fixedInstallation.state==='installed'?[]:['installation-not-installed']}})}
 async change(ownerId:string,value:SkillAvailabilityChangeInput):Promise<SkillAvailabilityChange>{
  owner(ownerId);const spec=changeInput(value),now=this.identity.now();if(!Number.isFinite(Date.parse(now))||new Date(now).toISOString()!==now)throw invalid()
  return this.tx(false,async db=>{
   await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[stable(['skill-availability-request',ownerId,spec.requestId])])
   const prior=(await db.query('select * from teloa_skill_install_maintenance_requests where owner_id=$1 and request_id=$2',[ownerId,spec.requestId])).rows[0]
   if(prior){const historical=receipt(prior,ownerId,spec),current=await readSkillAvailability(db,ownerId,historical.installationId);if(current.version<historical.result.version||current.version===historical.result.version&&stable(current)!==stable(historical.result))throw corrupt();return {receipt:historical,current}}
   const fixedInstallation=await installation(db,ownerId,spec.installationId,'for update')
   if(fixedInstallation.state!=='installed')throw new WorkError('teloa/conflict','技能安装尚未完成，不能维护可用状态。')
   if(fixedInstallation.bundleHash!==spec.expectedBundleHash)throw new WorkError('teloa/version-conflict','技能安装包摘要已变化，请重新预览。')
   const availabilityRow=(await db.query('select * from teloa_skill_install_availability where installation_id=$1 and owner_id=$2 for update',[fixedInstallation.id,ownerId])).rows[0]
   if(!availabilityRow)throw corrupt()
   const current=readStoredSkillAvailability(availabilityRow,ownerId)
   if(current.version!==spec.expectedVersion)throw new WorkError('teloa/version-conflict','技能可用状态版本已变化，请重新预览。')
   const target=spec.action==='disable'?'disabled':'enabled';if(current.availability===target)throw new WorkError('teloa/conflict','技能已处于请求的可用状态。')
   // 个人版用短维护事务固定完整影响集。锁序恒为安装行→可用状态行→影响表；代价是维护期间串行化四张表的写入，后续多租户拆分时再改为本人范围锁。
   await db.query('lock table teloa_roles,teloa_plans,teloa_tasks,teloa_task_runs in share mode')
   const fixedImpact=await impact(db,ownerId,fixedInstallation,current),impactDigest=skillAvailabilityImpactDigest(fixedImpact)
   if(impactDigest!==spec.expectedImpactDigest)throw new WorkError('teloa/version-conflict','技能影响范围已变化，请重新预览。')
   if(spec.action==='enable'){if(!this.restore)throw new WorkError('teloa/source-unavailable','技能固定来源核验尚未接入。');await this.restore.verify(db,ownerId,fixedInstallation)}
   const updated=(await db.query('update teloa_skill_install_availability set availability=$3,version=version+1,updated_at=$4 where installation_id=$1 and owner_id=$2 returning *',[fixedInstallation.id,ownerId,target,now])).rows[0],result=readStoredSkillAvailability(updated,ownerId)
   const historical:SkillAvailabilityReceipt={requestId:spec.requestId,installationId:spec.installationId,action:spec.action,reason:spec.reason,impact:fixedImpact,impactDigest,result,createdAt:now},receiptDigest=sha(stable([ownerId,historical]))
   await db.query('insert into teloa_skill_install_maintenance_requests(owner_id,request_id,installation_id,request_spec,impact_snapshot,impact_digest,result,receipt_digest,created_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9)',[ownerId,spec.requestId,spec.installationId,JSON.stringify(spec),JSON.stringify(fixedImpact),impactDigest,JSON.stringify(result),receiptDigest,now])
   return {receipt:historical,current:result}
  })
 }
}

export const skillAvailabilityImpactDigest=(impact:SkillAvailabilityImpact)=>sha(stable(impact))

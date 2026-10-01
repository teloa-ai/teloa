import type {Pool} from 'pg'
import {WorkError,roleInput,type DigitalRole} from '@teloa/contract'
import {readStoredRole} from './roles.ts'
import {ensureAutoDreamPlan,pauseAutoDreamPlan,type AutoDreamPorts} from './auto-dream-plans.ts'
import {renewRoleGrants} from './collaboration.ts'
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v)
export type RoleLifecycleResult={role:DigitalRole;appliedVersion:number;handoffTaskIds:string[]}
export async function initializeRoleLifecycle(pool:Pool):Promise<void>{
 await pool.query(`create unique index if not exists teloa_tasks_identity_owner on teloa_tasks(id,owner_id);
 create table if not exists teloa_role_transitions (
  role_id uuid not null references teloa_roles(id),base_version integer not null check(base_version>0),
  request_spec jsonb not null check(jsonb_typeof(request_spec)='object'),
  handoff_task_ids jsonb not null check(jsonb_typeof(handoff_task_ids)='array'),created_at timestamptz not null,
  primary key(role_id,base_version)
 );
 create table if not exists teloa_task_handoffs (
  id uuid primary key,task_id uuid not null,from_role_id uuid not null,owner_id text not null,
  role_version integer not null check(role_version>0),task_version integer not null check(task_version>0),
  reason text not null,created_at timestamptz not null,status text not null check(status in ('pending','resolved')),
  foreign key(task_id,owner_id) references teloa_tasks(id,owner_id),
  foreign key(from_role_id,owner_id) references teloa_roles(id,owner_id),unique(task_id,from_role_id)
 )`)
}
export class RoleLifecycleService{
 readonly pool:Pool
 readonly identity:{id:()=>string;now:()=>string}
 /** Auto Dream 的系统计划端口：装配期接上才随岗位同步计划状态，未接线的装配照旧只改岗位。 */
 readonly autoDream:AutoDreamPorts|undefined
 constructor(pool:Pool,identity:{id:()=>string;now:()=>string},autoDream?:AutoDreamPorts){this.pool=pool;this.identity=identity;this.autoDream=autoDream}
 async change(owner:string,input:unknown):Promise<RoleLifecycleResult>{
  if(typeof owner!=='string'||!owner.trim()||owner.length>128)throw new WorkError('teloa/forbidden','需要有效的本人身份。')
  const row=roleInput(input,['roleId','expectedVersion','action','reason'])
  if(!uuid(row.roleId)||!Number.isSafeInteger(row.expectedVersion)||(row.expectedVersion as number)<1||typeof row.action!=='string'||!['pause','resume','retire'].includes(row.action)||typeof row.reason!=='string'||!row.reason.trim()||row.reason.length>4000)throw new WorkError('teloa/invalid-input','员工操作、版本或原因不合法。')
  const reason=row.reason.trim(),spec=JSON.stringify({action:row.action,reason}),client=await this.pool.connect()
  try{
   await client.query('begin')
   const found=await client.query('select * from teloa_roles where id=$1 and owner_id=$2 for update',[row.roleId,owner])
   if(!found.rows[0])throw new WorkError('teloa/forbidden','员工不存在或不属于当前本人。')
   const role=readStoredRole(found.rows[0])
   const prior=await client.query('select *,request_spec=$3::jsonb as same_request from teloa_role_transitions where role_id=$1 and base_version=$2',[role.id,row.expectedVersion,spec])
   if(prior.rows[0]){
    if(!prior.rows[0].same_request)throw new WorkError('teloa/version-conflict','原员工版本已执行不同操作，请复核当前状态。')
    const ids:unknown=prior.rows[0].handoff_task_ids,appliedVersion=(row.expectedVersion as number)+1
    if(appliedVersion>role.version||!Array.isArray(ids)||!ids.every(uuid)||new Set(ids).size!==ids.length)throw new WorkError('teloa/storage-corrupt','员工状态回执损坏，请核对原记录。')
    await client.query('commit');return {role,appliedVersion,handoffTaskIds:ids}
   }
   if(role.version!==row.expectedVersion)throw new WorkError('teloa/version-conflict','员工已变化，请读取新版本后复核。')
   if(role.kind==='twin')throw new WorkError('teloa/conflict','分身是个人空间的默认代拟身份，不能暂停或退役。')
   if(role.state==='retired'||row.action==='pause'&&role.state!=='active'||row.action==='resume'&&role.state!=='paused')throw new WorkError('teloa/conflict','当前员工状态不能执行此操作。')
   const now=this.identity.now(),handoffTaskIds:string[]=[]
   // 与新交办共用岗位行锁；以后任务接任/结束也须按岗位→任务的次序加锁。
   if(row.action==='retire'){
    const tasks=await client.query("select id,version from teloa_tasks where owner_id=$1 and assignee_role_id=$2 and state not in ('completed','cancelled') order by id for update",[owner,role.id])
    for(const task of tasks.rows){
     if(!uuid(task.id)||!Number.isSafeInteger(task.version)||task.version<1)throw new WorkError('teloa/storage-corrupt','待交接任务身份或版本损坏。')
     await client.query("insert into teloa_task_handoffs(id,task_id,from_role_id,owner_id,role_version,task_version,reason,created_at,status) values($1,$2,$3,$4,$5,$6,$7,$8,'pending')",[this.identity.id(),task.id,role.id,owner,role.version+1,task.version,reason,now])
     handoffTaskIds.push(task.id)
    }
   }
   const state=row.action==='pause'?'paused':row.action==='resume'?'active':'retired'
   const updated=await client.query('update teloa_roles set state=$3,version=version+1,updated_at=$4 where id=$1 and owner_id=$2 returning *',[role.id,owner,state,now])
   const current=readStoredRole(updated.rows[0])
   // 恢复在岗同样把岗位版本 +1，群授权因此整体判 `invalidated`：改使命的完整动线是「暂停→改→恢复」，
   // 只在改定义那一笔续签救不回来，恢复这一笔必须照新版本再续一次（`collaboration.ts` 的 `renewRoleGrants`）。
   if(row.action==='resume')await renewRoleGrants(client,owner,current,now)
   // 岗位新状态已经落库，系统计划在同一笔事务里跟上；接线失败一律回滚整笔岗位操作。
   if(this.autoDream){
    if(row.action==='resume')await ensureAutoDreamPlan(client,this.autoDream,owner,current)
    else await pauseAutoDreamPlan(client,this.autoDream,owner,current.id)
   }
   await client.query('insert into teloa_role_transitions(role_id,base_version,request_spec,handoff_task_ids,created_at) values($1,$2,$3,$4,$5)',[role.id,role.version,spec,JSON.stringify(handoffTaskIds),now])
   await client.query('commit');return {role:current,appliedVersion:current.version,handoffTaskIds}
  }catch(error){await client.query('rollback');throw error}finally{client.release()}
 }
}

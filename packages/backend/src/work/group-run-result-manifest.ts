import type {Pool,PoolClient} from 'pg'
import {WorkError,groupReferenceMaxFiles,groupRunResultManifest,type GroupRunFileClaim,type GroupRunResultManifest} from '@teloa/contract'
import {readStoredRunPlanReport} from './task-run-plan-context.ts'
import {PlanOccurrenceService} from './plan-occurrences.ts'
import {RoleWorkEligibilityService} from './role-work-eligibility.ts'
import {readRoleWorkAuthorization} from '@teloa/contract'
import {readStoredTaskRun} from './task-runs.ts'
import {readStoredRole} from './roles.ts'
import {readStoredTask} from './tasks.ts'
import {readRunGroupContext,type RunGroupFilePorts} from './task-run-group-context.ts'

type Identity={sessionId:string;nativeRequestId:string}
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
function identity(owner:string,input:Identity,keys:readonly string[]=['sessionId','nativeRequestId']):Identity{
 if(typeof owner!=='string'||!owner.trim()||owner.length>128)throw new WorkError('teloa/forbidden','需要当前本人身份。')
 if(!input||Object.keys(input).length!==keys.length||Object.keys(input).some(key=>!keys.includes(key))||typeof input.sessionId!=='string'||!/^[\w-]{1,128}$/.test(input.sessionId)||!uuid(input.nativeRequestId))throw new WorkError('teloa/invalid-input','原运行的交付声明身份不正确。')
 return {sessionId:input.sessionId,nativeRequestId:input.nativeRequestId.toLowerCase()}
}
function manifest(value:unknown):GroupRunResultManifest{
 try{return groupRunResultManifest(value)}catch{throw new WorkError('teloa/storage-corrupt','原运行的交付声明损坏，已停止发布。')}
}

/** 宿主专用，不提供浏览器或模型任意写入口；声明在工具成功返回前落库，发布时仍现读文件并重核授权。 */
export class GroupRunResultManifestService{
 readonly pool:Pool
 readonly files:RunGroupFilePorts|undefined
 constructor(pool:Pool,files?:RunGroupFilePorts){this.pool=pool;this.files=files}
 async read(owner:string,input:Identity):Promise<GroupRunResultManifest>{
  const value=identity(owner,input),row=(await this.pool.query('select * from teloa_task_runs where owner_id=$1 and session_id=$2 and native_request_id=$3',[owner,value.sessionId,value.nativeRequestId])).rows[0]
  if(!row||(!readStoredTaskRun(row).groupContext&&!readStoredRunPlanReport(row)))throw new WorkError('teloa/forbidden','原运行不是本人的群工作。')
  return manifest(row.group_result_manifest)
 }
 private async update<T>(owner:string,value:Identity,claim:boolean,signal:AbortSignal|undefined,change:(current:GroupRunResultManifest)=>{manifest:GroupRunResultManifest;result:T}):Promise<T>{
  signal?.throwIfAborted()
  const db=await this.pool.connect()
  try{
   await db.query('begin')
   const hint=(await db.query('select role_id from teloa_task_runs where owner_id=$1 and session_id=$2 and native_request_id=$3',[owner,value.sessionId,value.nativeRequestId])).rows[0]
   if(!hint)throw new WorkError('teloa/forbidden','原运行不属于当前本人。')
   // 与执行准入保持 岗位→Run→Task 的锁序；并发子级声明在同一原 Run 上串行追加。
   const role=(await db.query('select * from teloa_roles where owner_id=$1 and id=$2 for share',[owner,hint.role_id])).rows[0]
   const row=(await db.query('select * from teloa_task_runs where owner_id=$1 and session_id=$2 and native_request_id=$3 for update',[owner,value.sessionId,value.nativeRequestId])).rows[0]
   if(!row||row.role_id!==hint.role_id)throw new WorkError('teloa/forbidden','原运行身份已变化。')
   const run=readStoredTaskRun(row)
   if((!run.groupContext&&!readStoredRunPlanReport(row))||run.stopRequestedAt!==null||!(claim?['accepted','active']:['prepared','submitting','accepted','active']).includes(run.state))throw new WorkError('teloa/conflict','原运行已结束或停止，不能再增加交付声明。')
   if(claim)await this.authorizeClaim(db,owner,row,role)
   const saved=change(manifest(row.group_result_manifest));signal?.throwIfAborted()
   await db.query('update teloa_task_runs set group_result_manifest=$4 where owner_id=$1 and session_id=$2 and native_request_id=$3',[owner,value.sessionId,value.nativeRequestId,JSON.stringify(saved.manifest)])
   signal?.throwIfAborted();await db.query('commit');return saved.result
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
 private async authorizeClaim(db:PoolClient,owner:string,row:Record<string,unknown>,role:Record<string,unknown>|undefined):Promise<void>{
  const run=readStoredTaskRun(row),task=(await db.query('select * from teloa_tasks where owner_id=$1 and id=$2 for share',[owner,run.taskId])).rows[0]
  if(!task||!role||run.roleId===null||run.roleVersion===null)throw new WorkError('teloa/forbidden','原岗位或任务不可用。')
  const plan=readStoredRunPlanReport(row)
  if(plan){
   const occurrence=await new PlanOccurrenceService(this.pool,{id:()=>{throw new WorkError('teloa/storage-corrupt','不能为交付声明新建发生实例。')}}).executionContext(db,owner,run.taskId)
   if(!occurrence?.reportGroup||occurrence.occurrenceId!==plan.occurrenceId||JSON.stringify(occurrence.reportGroup)!==JSON.stringify(plan.reportGroup))throw new WorkError('teloa/version-conflict','原计划汇报范围已变化，不能增加声明。')
   const authorization=readRoleWorkAuthorization(JSON.parse(run.inputText).role?.authorization),storedTask=readStoredTask(task)
   const admission=await new RoleWorkEligibilityService(this.pool).authorize(owner,{roleId:run.roleId,expectedRoleVersion:run.roleVersion,scope:storedTask.scope,inputSchema:'teloa.task-run-input/v2',authorization,groupId:plan.reportGroup.groupId},db)
   admission.assertCurrent();return
  }
  const current=await readRunGroupContext(db,owner,readStoredTask(task),readStoredRole(role),this.files,this.pool)
  if(!current||JSON.stringify(current)!==JSON.stringify(run.groupContext))throw new WorkError('teloa/version-conflict','原群工作范围或资料已变化，不能增加声明。')
  const grant=(await db.query('select grant_version,state,can_post from teloa_group_agent_grants where owner_id=$1 and group_id=$2 and role_id=$3 order by grant_version desc limit 1 for share',[owner,current.groupId,run.roleId])).rows[0]
  if(!grant||grant.state!=='active'||grant.grant_version!==current.grantVersion||grant.can_post!==true)throw new WorkError('teloa/forbidden','本员工没有当前群内发言授权。')
 }
 async declare(owner:string,input:Identity&{claim:GroupRunFileClaim},signal?:AbortSignal):Promise<GroupRunResultManifest&{duplicate:boolean}>{
  const value=identity(owner,input,['sessionId','nativeRequestId','claim']),checked=groupRunResultManifest({files:[input.claim],noVision:false}).files[0]!
  return this.update(owner,value,true,signal,current=>{
   const duplicate=current.files.some(file=>file.path===checked.path&&file.sha256===checked.sha256)
   if(!duplicate&&current.files.length>=groupReferenceMaxFiles)throw new WorkError('teloa/conflict','本次运行最多声明 8 个要贴回群的文件。')
   const saved={...current,files:duplicate?current.files:[...current.files,checked]}
   return {manifest:saved,result:{...saved,duplicate}}
  })
 }
 async markNoVision(owner:string,input:Identity,signal?:AbortSignal):Promise<GroupRunResultManifest>{
  const value=identity(owner,input)
  return this.update(owner,value,false,signal,current=>{const saved={...current,noVision:true};return {manifest:saved,result:saved}})
 }
 async mentionSelf(owner:string,input:Identity,signal?:AbortSignal):Promise<GroupRunResultManifest>{
  const value=identity(owner,input)
  return this.update(owner,value,true,signal,current=>{const saved={...current,mentionSelf:true as const};return {manifest:saved,result:saved}})
 }
}

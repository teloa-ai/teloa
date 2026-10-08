import {isDeepStrictEqual} from 'node:util'
import type {Pool,PoolClient} from 'pg'
import {WorkError,readWorkControl,readWorkControlChange,type WorkLineage,type WorkControl,type WorkControlChange} from '@teloa/contract'
import {WorkLineageService} from './work-lineage.ts'
import {roleWorkOwner,roleWorkTransaction} from './twin-execution-consents.ts'
import {combineWorkAccessLeases,workAccess,type WorkAccessLease} from './work-access.ts'

export type WorkControlOwnerAuthority={authorize:(owner:string,request:Readonly<WorkControlChange>)=>Promise<WorkAccessLease>}
export type WorkRunSettlement={settled:boolean;unknownOperationIds:string[]}
export type WorkControlPorts={ownerAuthority?:WorkControlOwnerAuthority;hostGeneration?:()=>number;inspectRun?:(owner:string,input:{runId:string;action:'pause'|'stop';generation:number})=>Promise<WorkRunSettlement>}
export type WorkControlEvent={control:WorkControl;runIds:string[];action:'pause'|'stop'|'resume'}
const epochs=new Map<string,number>()
const key=(owner:string,id:string)=>JSON.stringify([owner,id])
const epoch=(owner:string,id:string)=>epochs.get(key(owner,id))??0
const invalidate=(owner:string,id:string)=>epochs.set(key(owner,id),epoch(owner,id)+1)
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v)
const positive=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0
const invalid=()=>new WorkError('teloa/invalid-input','工作控制请求不正确或包含未知字段。')
const forbidden=()=>new WorkError('teloa/forbidden','工作已暂停、停止，或本人执行许可已失效。')
const corrupt=()=>new WorkError('teloa/storage-corrupt','工作控制持久记录不完整。')
const version=()=>new WorkError('teloa/version-conflict','工作控制世代或版本已变化，请重新读取。')
function input(value:unknown,keys:readonly string[]):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k)))throw invalid();return value as Record<string,unknown>}

/** 在 WorkLineage 建表后初始化；沿用 ending/ended 存储状态，不改写既有谱系。 */
export async function initializeWorkControl(pool:Pool):Promise<void>{await pool.query(`
 alter table teloa_work_controls add column if not exists version integer not null default 1 check(version>0);
 create table if not exists teloa_work_control_requests(
  owner_id text not null,request_id uuid not null,control_id uuid not null,spec jsonb not null,result jsonb not null,created_at timestamptz not null,
  primary key(owner_id,request_id),foreign key(owner_id,control_id) references teloa_work_controls(owner_id,id)
 );
 create table if not exists teloa_work_control_progress(
  owner_id text not null,control_id uuid not null,generation integer not null check(generation>0),pending_run_ids uuid[] not null default '{}',unknown_operation_ids text[] not null default '{}',
  primary key(owner_id,control_id),foreign key(owner_id,control_id) references teloa_work_controls(owner_id,id)
 );
 create table if not exists teloa_work_control_hosts(owner_id text primary key,generation integer not null check(generation>0));
`)}

export class WorkControlService{
 readonly pool:Pool;readonly identity:{id:()=>string;now:()=>string};readonly ports:WorkControlPorts
 private readonly listeners=new Set<(event:WorkControlEvent)=>Promise<void>|void>()
 constructor(pool:Pool,identity:{id:()=>string;now:()=>string},ports:WorkControlPorts={}){this.pool=pool;this.identity=identity;this.ports=ports}
 subscribe(listener:(event:WorkControlEvent)=>Promise<void>|void):()=>void{this.listeners.add(listener);return ()=>this.listeners.delete(listener)}
 private async read(db:Pick<Pool,'query'>,owner:string,id:string,lock=false):Promise<WorkControl>{
  const row=(await db.query('select * from teloa_work_controls where owner_id=$1 and id=$2'+(lock?' for update':''),[owner,id])).rows[0]
  if(!row)throw forbidden()
  if(!uuid(row.budget_account_id)||!(row.created_at instanceof Date)||!(row.updated_at instanceof Date))throw corrupt()
  const progress=(await db.query('select * from teloa_work_control_progress where owner_id=$1 and control_id=$2',[owner,id])).rows[0]
  if(progress&&progress.generation!==row.generation)throw corrupt()
  try{return readWorkControl({id:row.id,ownerId:row.owner_id,generation:row.generation,version:row.version,state:row.state==='ending'?'stopping':row.state==='ended'?'stopped':row.state,scope:row.kind,pendingRunIds:progress?.pending_run_ids??[],unknownOperationIds:progress?.unknown_operation_ids??[]})}catch{throw corrupt()}
 }
 async get(owner:string,value:{controlId:string}):Promise<WorkControl>{roleWorkOwner(owner);const a=input(value,['controlId']);if(!uuid(a.controlId))throw invalid();return this.read(this.pool,owner,a.controlId)}
 async getInTransaction(db:PoolClient,owner:string,value:{controlId:string}):Promise<WorkControl>{roleWorkOwner(owner);const a=input(value,['controlId']);if(!uuid(a.controlId))throw invalid();return this.read(db,owner,a.controlId)}
 async stateForRun(owner:string,value:{runId:string}):Promise<WorkControl['state']>{
  roleWorkOwner(owner);const a=input(value,['runId']);if(!uuid(a.runId))throw invalid()
  const run=(await this.pool.query('select task_id from teloa_task_runs where owner_id=$1 and id=$2',[owner,a.runId])).rows[0];if(!run)throw forbidden()
  const db=await this.pool.connect()
  try{
   const lineage=await new WorkLineageService(this.pool,this.identity).readInTransaction(db,owner,{taskId:run.task_id})
   if(!lineage)throw new WorkError('teloa/conflict','历史执行没有可信整项控制来源。')
   const round=await this.read(db,owner,lineage.roundControlId),definition=lineage.definitionControlId?await this.read(db,owner,lineage.definitionControlId):null
   const states=[round.state,definition?.state];for(const state of ['stopped','stopping','paused','pausing'] as const)if(states.includes(state))return state
   return 'active'
  }finally{db.release()}
 }
 /** 仅供已完成本人 seal、全部候选复核的恢复事务调用；不注册客户端/模型端口。 */
 async resumeInTransaction(db:PoolClient,owner:string,value:{controlId:string;expectedVersion:number},seal:WorkAccessLease):Promise<WorkControl>{
  roleWorkOwner(owner);const a=input(value,['controlId','expectedVersion']);if(!uuid(a.controlId)||!positive(a.expectedVersion)||typeof seal?.assertCurrent!=='function')throw forbidden()
  const current=await this.read(db,owner,a.controlId,true);if(current.version!==a.expectedVersion)throw version()
  if(current.state!=='paused'||current.pendingRunIds.length||current.unknownOperationIds.length)throw new WorkError('teloa/conflict','工作尚未安全暂停，不能恢复。')
  combineWorkAccessLeases([seal]).assertCurrent();invalidate(owner,current.id)
  await db.query("update teloa_work_controls set state='active',generation=generation+1,version=version+1,updated_at=$3 where owner_id=$1 and id=$2",[owner,current.id,this.identity.now()])
  await db.query("update teloa_work_control_progress set generation=generation+1,pending_run_ids='{}',unknown_operation_ids='{}' where owner_id=$1 and control_id=$2",[owner,current.id])
  return this.read(db,owner,current.id)
 }
 async publishResume(owner:string,control:WorkControl):Promise<void>{const current=await this.get(owner,{controlId:control.id});if(current.generation!==control.generation||current.state!=='active')throw version();const runIds=await this.runIds(owner,control.id);await Promise.allSettled([...this.listeners].map(listener=>listener({control:current,runIds,action:'resume'})))}
 /** 固定宿主启动口，必须先于调度/派工/Goal 驱动启动；不注册本人 RPC 或模型工具。 */
 async disarmForRestart(owner:string,value:{hostGeneration:number}):Promise<WorkControl[]>{
  roleWorkOwner(owner);const a=input(value,['hostGeneration']);if(!positive(a.hostGeneration)||!this.ports.hostGeneration||this.ports.hostGeneration()!==a.hostGeneration)throw forbidden()
  const changes=await roleWorkTransaction(this.pool,async db=>{
   await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['teloa/work-control-host',owner])])
   const prior=(await db.query('select generation from teloa_work_control_hosts where owner_id=$1',[owner])).rows[0]
   if(prior&&prior.generation>a.hostGeneration!)throw version()
   if(prior?.generation===a.hostGeneration)return []
   await db.query('insert into teloa_work_control_hosts(owner_id,generation) values($1,$2) on conflict(owner_id) do update set generation=excluded.generation',[owner,a.hostGeneration])
   // 长期定义已有统一栅栏，其 round 不另加一次暂停；保留本人先前对单轮的暂停选择。
   const ids=(await db.query("select c.id from teloa_work_controls c where c.owner_id=$1 and c.state='active' and (c.kind='definition' or not exists(select 1 from teloa_task_work_lineage l where l.owner_id=c.owner_id and l.round_control_id=c.id and l.definition_control_id is not null)) order by c.id for update",[owner])).rows
   const result:WorkControl[]=[]
   for(const {id} of ids){
    const current=await this.read(db,owner,id),runs=(await db.query(`select r.id from teloa_task_runs r join teloa_task_work_lineage l on l.owner_id=r.owner_id and l.task_id=r.task_id where r.owner_id=$1 and ${current.scope==='definition'?'l.definition_control_id':'l.round_control_id'}=$2 order by r.id`,[owner,id])).rows.map(r=>r.id)
    if(this.ports.hostGeneration!()!==a.hostGeneration)throw forbidden();invalidate(owner,id)
    await db.query("update teloa_work_controls set state='pausing',generation=generation+1,version=version+1,updated_at=$3 where owner_id=$1 and id=$2",[owner,id,this.identity.now()])
    await db.query(`insert into teloa_work_control_progress(owner_id,control_id,generation,pending_run_ids,unknown_operation_ids) values($1,$2,$3,$4,$5) on conflict(owner_id,control_id) do update set generation=excluded.generation,pending_run_ids=excluded.pending_run_ids,unknown_operation_ids=excluded.unknown_operation_ids`,[owner,id,current.generation+1,runs,current.unknownOperationIds])
    result.push(await this.read(db,owner,id))
   }
   return result
  })
  for(const control of changes)await Promise.allSettled([...this.listeners].map(listener=>listener({control,runIds:control.pendingRunIds,action:'pause'})))
  return changes
 }
 private async runIds(owner:string,controlId:string):Promise<string[]>{return (await new WorkLineageService(this.pool,this.identity).descendants(owner,{controlId})).runIds}
 async change(owner:string,value:WorkControlChange):Promise<WorkControl>{
  roleWorkOwner(owner);const request=readWorkControlChange(value)
  // 本人 RPC seal 是第一步；模型/后台入口不能通过 capability 或请求字段自行取得此权力。
  if(typeof this.ports.ownerAuthority?.authorize!=='function')throw forbidden()
  const seal=await this.ports.ownerAuthority.authorize(owner,Object.freeze({...request}))
  if(typeof seal?.assertCurrent!=='function')throw forbidden()
  const lease=combineWorkAccessLeases([seal,await workAccess.authorize({kind:'capability',capability:'automation',ownerId:owner,sessionId:null,objectId:request.controlId,operation:'edit'})]);lease.assertCurrent()
  if(request.action==='resume')throw new WorkError('teloa/forbidden','请通过整项恢复入口核对当前角色、预算和原受理回执后恢复。')
  let effectiveId=request.controlId
  if(request.roundControlId!==null){
   if(request.scope!=='round'||(await this.get(owner,{controlId:request.controlId})).scope!=='definition')throw invalid()
   const linked=(await this.pool.query('select task_id from teloa_task_work_lineage where owner_id=$1 and definition_control_id=$2 and round_control_id=$3 limit 1',[owner,request.controlId,request.roundControlId])).rows[0]
   if(!linked)throw forbidden();effectiveId=request.roundControlId
  }
  const runIds=await this.runIds(owner,effectiveId)
  const result=await roleWorkTransaction(this.pool,async db=>{
   await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['teloa/work-control-request',owner,request.requestId])])
   const prior=(await db.query('select spec,result from teloa_work_control_requests where owner_id=$1 and request_id=$2',[owner,request.requestId])).rows[0]
   if(prior){if(!isDeepStrictEqual(prior.spec,request))throw new WorkError('teloa/conflict','该工作控制请求已用于不同操作。');try{return {control:readWorkControl(prior.result),changed:false}}catch{throw corrupt()}}
   const current=await this.read(db,owner,effectiveId,true)
   if(current.version!==request.expectedVersion)throw version()
   if(current.scope!==request.scope)throw invalid()
   if(request.action==='pause'&&current.state!=='active'||request.action==='stop'&&['stopping','stopped'].includes(current.state))throw new WorkError('teloa/conflict','当前工作状态不接受此控制操作。')
   lease.assertCurrent()
   // 同一个本机宿主内，同步最终发布 guard 从这里起失效；数据库提交前失效只会保守拒绝旧请求。
   invalidate(owner,current.id)
   const state=request.action==='pause'?'pausing':'stopping',generation=current.generation+1
   await db.query('update teloa_work_controls set state=$3,generation=$4,version=version+1,updated_at=$5 where owner_id=$1 and id=$2',[owner,current.id,state==='stopping'?'ending':state,generation,this.identity.now()])
   await db.query(`insert into teloa_work_control_progress(owner_id,control_id,generation,pending_run_ids,unknown_operation_ids) values($1,$2,$3,$4,'{}') on conflict(owner_id,control_id) do update set generation=excluded.generation,pending_run_ids=excluded.pending_run_ids,unknown_operation_ids='{}'`,[owner,current.id,generation,runIds])
   const control=await this.read(db,owner,current.id)
   await db.query('insert into teloa_work_control_requests(owner_id,request_id,control_id,spec,result,created_at) values($1,$2,$3,$4,$5,$6)',[owner,request.requestId,current.id,JSON.stringify(request),JSON.stringify(control),this.identity.now()])
   return {control,changed:true}
  })
  if(result.changed)await Promise.allSettled([...this.listeners].map(listener=>listener({control:result.control,runIds,action:request.action})))
  return result.control
 }
 async acquireForRun(owner:string,value:{runId:string;expectedGeneration?:number;mode:'new-input'|'continuation'},client?:PoolClient):Promise<{control:WorkControl;lease:WorkAccessLease}>{
  roleWorkOwner(owner);const a=input(value,['runId','expectedGeneration','mode']);if(!uuid(a.runId)||a.expectedGeneration!==undefined&&!positive(a.expectedGeneration)||!['new-input','continuation'].includes(a.mode as string))throw invalid()
  const acquire=async(db:PoolClient)=>{
   const run=(await db.query('select task_id,state,stop_requested_at from teloa_task_runs where owner_id=$1 and id=$2',[owner,a.runId])).rows[0]
   if(!run||!['prepared','submitting','accepted','active'].includes(run.state)||run.stop_requested_at!==null)throw forbidden()
   const lineage=await new WorkLineageService(this.pool,this.identity).readInTransaction(db,owner,{taskId:run.task_id})
   if(!lineage)throw new WorkError('teloa/conflict','历史执行没有可信工作谱系，需要本人建立新的受控执行。')
   return this.acquireLineage(db,owner,lineage,a.expectedGeneration as number|undefined)
  }
  return client?acquire(client):roleWorkTransaction(this.pool,acquire)
 }
 /** 仅固定持久来源使用；已结束的回帖 Run 不因后继路由重新成为可执行 Run。 */
 async acquireForLineage(owner:string,value:{taskId:string;expectedGeneration?:number;mode?:'new-input'|'continuation'},client?:PoolClient):Promise<{control:WorkControl;lease:WorkAccessLease}>{
  roleWorkOwner(owner);const a=input(value,['taskId','expectedGeneration','mode'])
  if(!uuid(a.taskId)||a.expectedGeneration!==undefined&&!positive(a.expectedGeneration)||a.mode!==undefined&&!['new-input','continuation'].includes(a.mode as string))throw invalid()
  const acquire=async(db:PoolClient)=>{
   const task=(await db.query('select id from teloa_tasks where owner_id=$1 and id=$2 for share',[owner,a.taskId])).rows[0]
   const stored=task&&await new WorkLineageService(this.pool,this.identity).readInTransaction(db,owner,{taskId:task.id})
   if(!stored)throw forbidden()
   return this.acquireLineage(db,owner,stored,a.expectedGeneration as number|undefined)
  }
  return client?acquire(client):roleWorkTransaction(this.pool,acquire)
 }
 private async acquireLineage(db:PoolClient,owner:string,lineage:WorkLineage,expectedGeneration?:number):Promise<{control:WorkControl;lease:WorkAccessLease}>{
   const ids=[lineage.definitionControlId,lineage.roundControlId].filter((v):v is string=>v!==null).sort(),controls:WorkControl[]=[]
   for(const id of ids){await db.query('select id from teloa_work_controls where owner_id=$1 and id=$2 for share',[owner,id]);const c=await this.read(db,owner,id);if(c.state!=='active')throw forbidden();controls.push(c)}
   const control=controls.find(c=>c.id===lineage.roundControlId)!
   if(expectedGeneration!==undefined&&control.generation!==expectedGeneration)throw version()
   const captured=controls.map(c=>({id:c.id,epoch:epoch(owner,c.id)})),host=this.ports.hostGeneration?.()
   const assertCurrent=()=>{if(captured.some(c=>epoch(owner,c.id)!==c.epoch)||host!==undefined&&this.ports.hostGeneration?.()!==host)throw forbidden()}
   assertCurrent();return {control,lease:{assertCurrent,assertContinuationCurrent:assertCurrent}}
 }
 /** 只消费服务端装配的真实子工作/宿主回执；未知或缺少检查器不能落终态。 */
 async reconcile(owner:string,value:{controlId:string;generation:number}):Promise<WorkControl>{
  roleWorkOwner(owner);const a=input(value,['controlId','generation']);if(!uuid(a.controlId)||!positive(a.generation))throw invalid()
  const current=await this.get(owner,{controlId:a.controlId});if(current.generation!==a.generation)throw version()
  if(!['pausing','stopping'].includes(current.state))return current
  const runIds=[...new Set([...current.pendingRunIds,...await this.runIds(owner,current.id)])].sort(),pending:string[]=[],unknown:string[]=[]
  for(const runId of runIds){
   let proof:WorkRunSettlement|undefined
   try{proof=await this.ports.inspectRun?.(owner,{runId,action:current.state==='pausing'?'pause':'stop',generation:current.generation})}catch{}
   if(!proof||typeof proof.settled!=='boolean'||!Array.isArray(proof.unknownOperationIds)||proof.unknownOperationIds.some(id=>typeof id!=='string'||!id.trim()||id.length>512||/[\x00-\x1f]/.test(id)))pending.push(runId)
   else{if(!proof.settled||proof.unknownOperationIds.length)pending.push(runId);unknown.push(...proof.unknownOperationIds)}
  }
  return roleWorkTransaction(this.pool,async db=>{
   const latest=await this.read(db,owner,current.id,true);if(latest.generation!==current.generation)throw version()
   if(latest.state!==current.state)return latest
   await db.query('update teloa_work_control_progress set pending_run_ids=$4,unknown_operation_ids=$5 where owner_id=$1 and control_id=$2 and generation=$3',[owner,current.id,current.generation,pending,[...new Set(unknown)].sort()])
   if(!pending.length&&!unknown.length)await db.query('update teloa_work_controls set state=$3,version=version+1,updated_at=$4 where owner_id=$1 and id=$2',[owner,current.id,current.state==='pausing'?'paused':'ended',this.identity.now()])
   return this.read(db,owner,current.id)
  })
 }
}

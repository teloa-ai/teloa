import {isDeepStrictEqual} from 'node:util'
import {randomUUID} from 'node:crypto'
import type {Pool} from 'pg'
import {WorkError} from '@teloa/contract'
import {readWorkProgress,readWorkProgressFields,type WorkProgress} from '@teloa/contract'
import {workObject,workUuid} from '@teloa/contract'
import {WorkLineageService} from './work-lineage.ts'
import {readStoredTaskRunFlow} from './task-run-flows.ts'
import {readStoredTaskRun} from './task-runs.ts'
export async function initializeWorkProgress(pool:Pool):Promise<void>{await pool.query(`
 create table if not exists teloa_work_progress(owner_id text not null,root_task_id uuid not null,version integer not null check(version>0),progress jsonb not null,primary key(owner_id,root_task_id),foreign key(root_task_id,owner_id) references teloa_tasks(id,owner_id));
 create table if not exists teloa_work_progress_receipts(owner_id text not null,request_id uuid not null,request jsonb not null,result jsonb not null,primary key(owner_id,request_id));
`)}
export class WorkProgressService{
 readonly pool:Pool;readonly clock:{id:()=>string;now:()=>string}
 constructor(pool:Pool,clock:{id:()=>string;now:()=>string}){this.pool=pool;this.clock=clock}
 /** 宿主在真实 Run/Flow 回执之后投影；没有新事实时不增加进展版本。 */
 async recordRunProgress(owner:string,runId:string):Promise<WorkProgress|null>{
  const row=(await this.pool.query('select * from teloa_task_runs where owner_id=$1 and id=$2',[owner,runId])).rows[0];if(!row)throw new WorkError('teloa/forbidden','执行不属于本人。');const run=readStoredTaskRun(row),lineage=await new WorkLineageService(this.pool,this.clock).read(owner,{taskId:run.taskId});if(!lineage)return null
  const rootTaskId=lineage.rootTaskId,taskIds=(await this.pool.query('select task_id from teloa_task_work_lineage where owner_id=$1 and root_task_id=$2',[owner,rootTaskId])).rows.map(r=>r.task_id),flowRow=(await this.pool.query('select * from teloa_task_run_flows where owner_id=$1 and run_id=$2',[owner,run.id])).rows[0],flow=flowRow?readStoredTaskRunFlow(flowRow):null
  const completedStepIds=flow?.steps.filter(s=>s.state==='succeeded'||s.state==='compensated').map(s=>s.id)??[],next=flow?.steps.find(s=>s.state==='ready'||s.state==='waiting'),artifactIds=(await this.pool.query("select distinct artifact_id from teloa_artifact_versions where owner_id=$1 and source->>'kind'='task' and source->>'id'=any($2::text[])",[owner,taskIds])).rows.map(r=>r.artifact_id).sort()
  const securityPresent=(await this.pool.query("select to_regclass('teloa_security_actions') is not null as present")).rows[0].present,pendingActionIds=securityPresent?(await this.pool.query("select id from teloa_security_actions where owner_id=$1 and task_id=any($2::uuid[]) and state in ('proposed','pending_approval','approved','executing','effect_unknown') order by id",[owner,taskIds])).rows.map(r=>r.id):[]
  const task=(await this.pool.query('select state from teloa_tasks where owner_id=$1 and id=$2',[owner,rootTaskId])).rows[0],stage=task.state==='completed'?'本轮已验收':task.state==='cancelled'?'本轮已结束':pendingActionIds.length?'等待动作处理':flow?.state==='waiting'?'等待步骤回执':run.state==='ended'?'等待本轮交付验收':run.state==='active'||run.state==='accepted'?'正在执行':run.state==='submitting'?'执行结果待核对':'等待执行'
  const fields={stage,completedStepIds,nextStep:next?.title??null,wait:pendingActionIds.length?{kind:'owner' as const,reason:'实际动作尚待处理',nextAt:null}:next?.state==='waiting'?{kind:next.kind==='human_checkpoint'?'owner' as const:'external' as const,reason:next.waitReason??next.inputSummary,nextAt:null}:run.state==='ended'&&task.state==='waiting'?{kind:'owner' as const,reason:'本轮交付尚未验收',nextAt:null}:null,artifactIds,pendingActionIds}
  const previous=await this.get(owner,{rootTaskId});if(previous){const {rootTaskId:_id,version:_version,updatedAt:_updated,...old}=previous;if(isDeepStrictEqual(old,fields))return previous}
  return this.change(owner,{requestId:randomUUID(),rootTaskId,expectedVersion:previous?.version??0,progress:fields})
 }
 async get(owner:string,input:{rootTaskId:string}):Promise<WorkProgress|null>{const v=workObject(input,['rootTaskId']);if(!workUuid(v.rootTaskId))throw new WorkError('teloa/invalid-input','工作身份不正确。');const lineage=await new WorkLineageService(this.pool,this.clock).read(owner,{taskId:v.rootTaskId});if(!lineage||lineage.rootTaskId!==v.rootTaskId)throw new WorkError('teloa/forbidden','只能读取根工作的进展。');const row=(await this.pool.query('select * from teloa_work_progress where owner_id=$1 and root_task_id=$2',[owner,v.rootTaskId])).rows[0];if(!row)return null;const result=readWorkProgress(row.progress);if(result.rootTaskId!==v.rootTaskId||result.version!==row.version)throw new WorkError('teloa/storage-corrupt','工作进展记录损坏。');return result}
 async change(owner:string,input:unknown):Promise<WorkProgress>{
  const v=workObject(input,['requestId','rootTaskId','expectedVersion','progress']),fields=readWorkProgressFields(v.progress)
  if(!workUuid(v.requestId)||!workUuid(v.rootTaskId)||!Number.isSafeInteger(v.expectedVersion)||Number(v.expectedVersion)<0)throw new WorkError('teloa/invalid-input','工作进展请求格式不正确。')
  const db=await this.pool.connect();try{await db.query('begin');await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',['teloa/work-progress/'+owner+'/'+v.rootTaskId])
   const prior=(await db.query('select * from teloa_work_progress_receipts where owner_id=$1 and request_id=$2',[owner,v.requestId])).rows[0]
   if(prior){if(!isDeepStrictEqual(prior.request,v))throw new WorkError('teloa/conflict','原进展请求已经保存其他内容。');const result=readWorkProgress(prior.result);if(result.rootTaskId!==v.rootTaskId||result.version!==Number(v.expectedVersion)+1)throw new WorkError('teloa/storage-corrupt','工作进展回执不匹配。');await db.query('commit');return result}
   const lineage=await new WorkLineageService(this.pool,this.clock).readInTransaction(db,owner,{taskId:v.rootTaskId});if(!lineage||lineage.rootTaskId!==v.rootTaskId)throw new WorkError('teloa/forbidden','只能修改根工作的进展。')
   const row=(await db.query('select * from teloa_work_progress where owner_id=$1 and root_task_id=$2 for update',[owner,v.rootTaskId])).rows[0];if((row?.version??0)!==v.expectedVersion)throw new WorkError('teloa/version-conflict','工作进展已变化。')
   const taskIds=(await db.query('select task_id from teloa_task_work_lineage where owner_id=$1 and root_task_id=$2',[owner,v.rootTaskId])).rows.map(r=>r.task_id)
   if(fields.completedStepIds.length){const rows=(await db.query('select f.* from teloa_task_run_flows f join teloa_task_runs r on r.id=f.run_id and r.owner_id=f.owner_id where f.owner_id=$1 and r.task_id=any($2::uuid[])',[owner,taskIds])).rows.map(readStoredTaskRunFlow),completed=new Set(rows.flatMap(f=>f.steps.filter(s=>s.state==='succeeded'||s.state==='compensated').map(s=>s.id)));if(fields.completedStepIds.some(id=>!completed.has(id)))throw new WorkError('teloa/forbidden','步骤尚无所属 Run 的真实完成回执。')}
   if(fields.artifactIds.length){const ids=(await db.query("select distinct artifact_id as id from teloa_artifact_versions where owner_id=$1 and artifact_id=any($2::uuid[]) and source->>'kind'='task' and source->>'id'=any($3::text[])",[owner,fields.artifactIds,taskIds])).rows.map(r=>r.id);if(fields.artifactIds.some(id=>!ids.includes(id)))throw new WorkError('teloa/forbidden','成果不属于本次工作。')}
   if(fields.pendingActionIds.length){const ids=(await db.query("select id from teloa_security_actions where owner_id=$1 and id=any($2::uuid[]) and task_id=any($3::uuid[]) and state in ('proposed','pending_approval','approved','executing','effect_unknown')",[owner,fields.pendingActionIds,taskIds])).rows.map(r=>r.id);if(fields.pendingActionIds.some(id=>!ids.includes(id)))throw new WorkError('teloa/forbidden','待处理动作不属于本次工作或已经结束。')}
   const result=readWorkProgress({rootTaskId:v.rootTaskId,version:Number(v.expectedVersion)+1,...fields,updatedAt:this.clock.now()})
   await db.query('insert into teloa_work_progress(owner_id,root_task_id,version,progress) values($1,$2,$3,$4) on conflict(owner_id,root_task_id) do update set version=excluded.version,progress=excluded.progress',[owner,v.rootTaskId,result.version,JSON.stringify(result)])
   await db.query('insert into teloa_work_progress_receipts(owner_id,request_id,request,result) values($1,$2,$3,$4)',[owner,v.requestId,JSON.stringify(v),JSON.stringify(result)])
   await db.query('commit');return result
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
}

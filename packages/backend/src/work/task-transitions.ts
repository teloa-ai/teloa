import {runEvidence} from './task-run-evidence.ts'
import {ArtifactService} from './artifacts.ts'
import type {Pool,PoolClient} from 'pg'
import {WorkError,taskInput,type WorkTask} from '@teloa/contract'
import {readStoredTask} from './tasks.ts'
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v)
const targets={start:'running',pause:'paused',resume:'running',cancel:'cancelled',complete:'completed'} as const
export async function initializeTaskTransitions(pool:Pool){await pool.query(`create table if not exists teloa_task_transitions(
 owner_id text not null,request_id uuid not null,task_id uuid not null references teloa_tasks(id),request_spec jsonb not null,result jsonb not null,created_at timestamptz not null,primary key(owner_id,request_id)
)`)}
export async function initializeTaskCompletions(pool:Pool){await pool.query(`
 create unique index if not exists teloa_task_owner_identity on teloa_tasks(owner_id,id);
 create table if not exists teloa_task_completions(owner_id text not null,task_id uuid not null,task_version integer not null,artifact_id uuid not null,artifact_version integer not null,note text not null,completed_at timestamptz not null,
 primary key(owner_id,task_id),foreign key(owner_id,task_id) references teloa_tasks(owner_id,id),foreign key(owner_id,artifact_id,artifact_version) references teloa_artifact_versions(owner_id,artifact_id,number))
`)}
/** 本人负责的任务台账。AI 员工的执行状态须由 Harness 接线驱动。 */
export class TaskTransitions{
 readonly pool:Pool;readonly identity:{id:()=>string;now:()=>string}
 constructor(pool:Pool,identity:{id:()=>string;now:()=>string}){this.pool=pool;this.identity=identity}
 async change(owner:string,input:unknown):Promise<WorkTask>{
  const db=await this.pool.connect()
  try{await db.query('begin');const result=await this.changeInTransaction(db,owner,input);await db.query('commit');return result}
  catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
 /** 可信结项复用本人结项的锁、固定成果及唯一回执；调用方负责事务。proof不接受客户端输入。 */
 async changeInTransaction(client:PoolClient,owner:string,input:unknown,proof?:{candidate:unknown;policy:unknown;receiptIds:string[]}):Promise<WorkTask>{
  if(typeof owner!=='string'||!owner.trim()||owner.length>128)throw new WorkError('teloa/forbidden','需要本人身份。')
  const row=taskInput(input,['taskId','requestId','expectedVersion','action','artifact','note'])
  if(!uuid(row.taskId)||!uuid(row.requestId)||!Number.isSafeInteger(row.expectedVersion)||(row.expectedVersion as number)<1||typeof row.action!=='string'||!Object.hasOwn(targets,row.action))throw new WorkError('teloa/invalid-input','任务状态请求格式不正确。')
  if(row.action!=='complete'&&(row.artifact!==undefined||row.note!==undefined))throw new WorkError('teloa/invalid-input','只有结项请求可以包含成果与说明。')
  const artifact=row.action==='complete'?taskInput(row.artifact,['id','version']):undefined
  if(artifact&&(!uuid(artifact.id)||!Number.isSafeInteger(artifact.version)||(artifact.version as number)<1||typeof row.note!=='string'||!row.note.trim()||row.note.length>4000))throw new WorkError('teloa/invalid-input','请选择固定成果版本并填写结项说明。')
  const action=row.action as keyof typeof targets,spec=JSON.stringify({...row,...(proof?{verifiedCompletion:proof}:{})})
   await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['task-transition',owner,row.requestId])])
   const rows=await client.query('select * from teloa_tasks where owner_id=$1 and id=$2 for update',[owner,row.taskId])
   if(!rows.rows[0])throw new WorkError('teloa/forbidden','任务不存在或不属于本人。')
   const task=readStoredTask(rows.rows[0]),receipts=await client.query('select *,request_spec=$3::jsonb as same_request from teloa_task_transitions where owner_id=$1 and request_id=$2',[owner,row.requestId,spec])
   if(receipts.rows[0]){
    const receipt=receipts.rows[0];if(!receipt.same_request)throw new WorkError('teloa/conflict','原请求已记录其他状态操作。')
    let saved:WorkTask
    try{const raw=receipt.result;saved=readStoredTask({...raw,created_at:new Date(raw.created_at),updated_at:new Date(raw.updated_at)});if(receipt.task_id!==task.id||saved.id!==task.id||saved.ownerId!==owner||saved.version!==(row.expectedVersion as number)+1||saved.state!==targets[action])throw Error()}catch{throw new WorkError('teloa/storage-corrupt','任务状态回执损坏，请核对记录。')}
    if(action==='complete'){const completion=await this.readCompletion(client,owner,task.id);if(!completion||completion.taskVersion!==saved.version||completion.artifactId!==artifact!.id||completion.artifactVersion!==artifact!.version||completion.note!==(row.note as string).trim())throw new WorkError('teloa/storage-corrupt','结项记录与状态回执不一致。')}
    return saved
   }
   if(task.version!==row.expectedVersion)throw new WorkError('teloa/version-conflict','任务版本已变化，请刷新后核对。')
   if(task.assigneeRoleId){
    if(action!=='complete'||task.state!=='waiting')throw new WorkError('teloa/conflict','员工任务须通过执行服务推进；本轮成功后才能验收结项。')
    // 任务行锁与领取/终态投影共用，防止验收与新执行同时推进。
    const active=await client.query("select id from teloa_task_runs where owner_id=$1 and task_id=$2 and state not in ('ended','withdrawn','configuration_failed')",[owner,task.id])
    if(active.rows.length)throw new WorkError('teloa/conflict','仍有未结束的执行，不能结项。')
    const finished=await client.query("select evidence from teloa_task_runs where owner_id=$1 and task_id=$2 and role_id=$3 and state='ended' and task_state_version=$4",[owner,task.id,task.assigneeRoleId,task.version-1])
    if(finished.rows.length!==1)throw new WorkError('teloa/conflict','当前任务没有可验收的执行结果。')
    let evidence
    try{evidence=runEvidence(finished.rows[0].evidence)}catch{throw new WorkError('teloa/storage-corrupt','执行结束证据损坏，不能结项。')}
    if(evidence.state!=='ended'||evidence.reason!=='completed')throw new WorkError('teloa/conflict','本轮未正常完成，请先处理执行结果。')
   }
   const allowed=action==='start'?task.state==='ready':action==='pause'?task.state==='running':action==='resume'?task.state==='paused':action==='complete'?(task.assigneeRoleId?task.state==='waiting':task.state==='running'):!['completed','cancelled'].includes(task.state)
   if(!allowed)throw new WorkError('teloa/conflict','当前任务状态不能执行此操作。')
   if(artifact){
    const artifacts=new ArtifactService(this.pool,this.identity,async()=>{throw Error('结项不创建成果')})
    const version=await artifacts.readVersion(client,owner,artifact.id as string,artifact.version as number)
    if(version.source.kind!=='task'||version.source.id!==task.id||version.source.scope!==task.scope||version.source.version!==`${task.version} · ${task.updatedAt}`)throw new WorkError('teloa/version-conflict','交付成果不属于当前任务版本，请先核对任务并修订成果。')
    await client.query('insert into teloa_task_completions values($1,$2,$3,$4,$5,$6,$7)',[owner,task.id,task.version+1,artifact.id,artifact.version,(row.note as string).trim(),this.identity.now()])
   }
   const updated=await client.query('update teloa_tasks set state=$3,version=version+1,updated_at=$4 where owner_id=$1 and id=$2 returning *',[owner,task.id,targets[action],this.identity.now()]),saved=readStoredTask(updated.rows[0])
   await client.query('insert into teloa_task_transitions values($1,$2,$3,$4,$5,$6)',[owner,row.requestId,task.id,spec,JSON.stringify(updated.rows[0]),this.identity.now()])
   return saved
 }
 private async readCompletion(db:Pick<Pool,'query'>,owner:string,id:string){
  const rows=await db.query('select * from teloa_task_completions where owner_id=$1 and task_id=$2',[owner,id]);if(!rows.rows[0])return null
  const row=rows.rows[0]
  if(!uuid(row.artifact_id)||!Number.isSafeInteger(row.artifact_version)||row.artifact_version<1||!Number.isSafeInteger(row.task_version)||row.task_version<2||typeof row.note!=='string'||!row.note.trim()||row.note.length>4000||!(row.completed_at instanceof Date))throw new WorkError('teloa/storage-corrupt','结项记录格式损坏。')
  const version=await new ArtifactService(this.pool,this.identity,async()=>{throw Error('只读结项')}).readVersion(db,owner,row.artifact_id,row.artifact_version)
  if(version.source.kind!=='task'||version.source.id!==id)throw new WorkError('teloa/storage-corrupt','结项成果来源损坏。')
  return {taskId:id,taskVersion:row.task_version as number,artifactId:row.artifact_id as string,artifactVersion:row.artifact_version as number,note:row.note as string,completedAt:row.completed_at.toISOString()}
 }
 async completion(owner:string,input:unknown){
  if(typeof owner!=='string'||!owner.trim()||owner.length>128)throw new WorkError('teloa/forbidden','需要本人身份。')
  const row=taskInput(input,['taskId']);if(!uuid(row.taskId))throw new WorkError('teloa/invalid-input','任务身份不正确。')
  const client=await this.pool.connect()
  try{await client.query('begin isolation level repeatable read read only');const rows=await client.query('select * from teloa_tasks where owner_id=$1 and id=$2',[owner,row.taskId]);if(!rows.rows[0])throw new WorkError('teloa/forbidden','任务不属于本人。');const task=readStoredTask(rows.rows[0]),result=await this.readCompletion(client,owner,task.id)
   if(task.state==='completed'?(!result||result.taskVersion!==task.version):!!result)throw new WorkError('teloa/storage-corrupt','任务状态与结项记录不一致。')
   await client.query('commit');return result
  }catch(error){await client.query('rollback');throw error}finally{client.release()}
 }

}

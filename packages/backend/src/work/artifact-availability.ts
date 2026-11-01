import type {Pool,PoolClient} from 'pg'
import {artifactInput,readArtifactWithdrawalInput,readArtifactWithdrawal,savedArtifactSource,WorkError,type ArtifactAvailability,type ArtifactWithdrawal} from '@teloa/contract'
import {isDeepStrictEqual} from 'node:util'
import {readArtifactRunSources} from './artifact-run-sources.ts'

type Db=Pick<PoolClient,'query'>
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
function ownerInput(owner:string){if(typeof owner!=='string'||!owner.trim()||owner!==owner.trim()||owner.length>128)throw new WorkError('teloa/forbidden','需要有效的本人身份。')}
function receipt(row:Record<string,unknown>):ArtifactWithdrawal{
 try{
  if(!(row.withdrawn_at instanceof Date))throw Error()
  const result=readArtifactWithdrawal({requestId:row.request_id,artifactId:row.artifact_id,expectedVersion:row.expected_version,source:row.source,withdrawnAt:row.withdrawn_at.toISOString()})
  const {withdrawnAt:_,...fixed}=result
  if(!isDeepStrictEqual(fixed,readArtifactWithdrawalInput(row.request_spec)))throw Error()
  return result
 }catch{throw new WorkError('teloa/storage-corrupt','成果撤回回执损坏，请核对原请求。')}
}
export async function initializeArtifactAvailability(pool:Pool):Promise<void>{
 await pool.query(`create table if not exists teloa_artifact_withdrawals(
  owner_id text not null,artifact_id uuid not null,request_id uuid not null,request_spec jsonb not null,
  expected_version integer not null check(expected_version>0),source jsonb not null,withdrawn_at timestamptz not null,
  primary key(owner_id,artifact_id),unique(owner_id,request_id),
  foreign key(owner_id,artifact_id) references teloa_artifacts(owner_id,id)
 );
 create table if not exists teloa_artifact_input_sources(
  owner_id text not null,session_id text not null,artifact_id uuid not null,
  created_at timestamptz not null,primary key(owner_id,session_id,artifact_id),
  foreign key(owner_id,artifact_id) references teloa_artifacts(owner_id,id)
 )`)
}
/** 新消费必须在调用方事务内持有头行共享锁；本人历史原件/回执读取不走此准入。 */
export async function assertArtifactAvailable(db:Db,owner:string,artifactId:string,version?:number):Promise<void>{
 ownerInput(owner)
 if(!uuid(artifactId)||version!==undefined&&(!Number.isSafeInteger(version)||version<1))throw new WorkError('teloa/invalid-input','成果引用身份或版本不正确。')
 const head=(await db.query('select current_version from teloa_artifacts where owner_id=$1 and id=$2 for share',[owner,artifactId])).rows[0]
 if(!head)throw new WorkError('teloa/forbidden','成果不存在或不属于本人。')
 if(version!==undefined&&!(await db.query('select 1 from teloa_artifact_versions where owner_id=$1 and artifact_id=$2 and number=$3',[owner,artifactId,version])).rowCount)throw new WorkError('teloa/source-unavailable','指定成果版本不可用。')
 if((await db.query('select 1 from teloa_artifact_withdrawals where owner_id=$1 and artifact_id=$2',[owner,artifactId])).rowCount)throw new WorkError('teloa/source-unavailable','此成果已撤回，不能用于新的工作。请新建不含此成果的工作会话；原件与历史仍可由本人查看和导出。',{reason:'artifact-withdrawn',artifactId})
}
export class ArtifactAvailabilityService{
 readonly pool:Pool;readonly now:()=>string
 constructor(pool:Pool,now:()=>string){this.pool=pool;this.now=now}
 /** 最终发送持有此准入直到 provider 已开始返回或迭代结束；失败/取消也必须 release。
  * 来源绑定保守保留：未知外发不能因没有响应而被误当从未进入该会话。
  */
 async bindInputInTransaction(db:PoolClient,owner:string,input:{sessionId?:string;references:readonly {artifactId:string;version:number}[];artifactIds?:readonly string[];groupMessageIds?:readonly string[];revisionRequestIds?:readonly string[]}):Promise<void>{
  ownerInput(owner);const row=artifactInput(input,['sessionId','references','artifactIds','groupMessageIds','revisionRequestIds']),sessionId=row.sessionId
  if(sessionId!==undefined&&(typeof sessionId!=='string'||!/^[-\w]{1,128}$/.test(sessionId))||!Array.isArray(row.references)||row.references.length>1024)throw new WorkError('teloa/invalid-input','成果输入的会话或固定来源不正确。')
  const ids=(value:unknown):string[]=>{if(value===undefined)return [];if(!Array.isArray(value)||value.length>1024||value.some(id=>!uuid(id)))throw new WorkError('teloa/invalid-input','成果输入的间接来源不正确。');return [...new Set(value.map(id=>(id as string).toLowerCase()))]}
  const groupMessageIds=ids(row.groupMessageIds),revisionRequestIds=ids(row.revisionRequestIds),artifactIds=ids(row.artifactIds)
  const references:{artifactId:string;version?:number}[]=(row.references as unknown[]).map(value=>{
   const r=artifactInput(value,['artifactId','version'])
   if(!uuid(r.artifactId)||!Number.isSafeInteger(r.version)||Number(r.version)<1)throw new WorkError('teloa/invalid-input','成果输入引用不正确。')
   return {artifactId:r.artifactId.toLowerCase(),version:Number(r.version)}
  });references.push(...artifactIds.map(artifactId=>({artifactId})))
   const sourceRunIds=new Set<string>()
   if(typeof sessionId==='string'){
    const previous=(await db.query('select artifact_id from teloa_artifact_input_sources where owner_id=$1 and session_id=$2',[owner,sessionId])).rows
    references.push(...previous.map(r=>({artifactId:r.artifact_id as string})))
    // 原生历史可能在成果保存前已形成；即使从未出现结构化引用，也不能在原来源会话里重放。
    const origins=(await db.query("select a.id,v.number from teloa_artifacts a join teloa_artifact_versions v on v.owner_id=a.owner_id and v.artifact_id=a.id and v.number=a.current_version where a.owner_id=$1 and v.source->>'kind'='session' and v.source->>'id'=$2",[owner,sessionId])).rows
    references.push(...origins.map(r=>({artifactId:r.id as string,version:r.number as number})))
    if((await db.query("select to_regclass('teloa_task_runs') as relation")).rows[0]?.relation)for(const run of (await db.query('select id from teloa_task_runs where owner_id=$1 and session_id=$2',[owner,sessionId])).rows)sourceRunIds.add(run.id)
   }
   if(groupMessageIds.length&&(await db.query("select to_regclass('teloa_group_messages') as relation")).rows[0]?.relation){
    // 投影给 router/日结的消息会裁掉原 references，但 messageId 仍固定；只沿该本人原行回溯。
    const messages=(await db.query('select reference_snapshot,run_id from teloa_group_messages where owner_id=$1 and id=any($2::uuid[])',[owner,groupMessageIds])).rows
    for(const message of messages){
     if(!Array.isArray(message.reference_snapshot))throw new WorkError('teloa/storage-corrupt','群消息的固定成果来源损坏。')
     for(const reference of message.reference_snapshot)if(reference?.kind==='artifact'){
      if(!uuid(reference.id)||!Number.isSafeInteger(reference.version)||reference.version<1)throw new WorkError('teloa/storage-corrupt','群消息的固定成果来源损坏。')
      references.push({artifactId:reference.id,version:reference.version})
     }
     if(message.run_id)sourceRunIds.add(message.run_id)
    }
   }
   if(revisionRequestIds.length){
    const revisions=(await db.query('select id,artifact_id,base_version from teloa_artifact_revision_requests where owner_id=$1 and id=any($2::uuid[])',[owner,revisionRequestIds])).rows
    if(revisions.length!==revisionRequestIds.length)throw new WorkError('teloa/source-unavailable','原成果续改请求不可用，请核对原工作。')
    references.push(...revisions.map(r=>({artifactId:r.artifact_id as string,version:r.base_version as number})))
   }
   if(sourceRunIds.size){
    references.push(...await readArtifactRunSources(db,owner,[...sourceRunIds]))
   }
   const unique=[...new Map(references.map(r=>{const value={...r,artifactId:r.artifactId.toLowerCase()};return [value.artifactId+':'+(value.version??''),value] as const})).values()].sort((a,b)=>a.artifactId.localeCompare(b.artifactId)||(a.version??0)-(b.version??0))
   for(const reference of unique){
    await assertArtifactAvailable(db,owner,reference.artifactId,reference.version)
    if(typeof sessionId==='string')await db.query('insert into teloa_artifact_input_sources(owner_id,session_id,artifact_id,created_at) values($1,$2,$3,$4) on conflict do nothing',[owner,sessionId,reference.artifactId,this.now()])
   }
 }
 async admitInput(owner:string,input:{sessionId?:string;references:readonly {artifactId:string;version:number}[];artifactIds?:readonly string[];groupMessageIds?:readonly string[];revisionRequestIds?:readonly string[]}):Promise<{release:()=>Promise<void>}>{
  ownerInput(owner);const db=await this.pool.connect()
  try{
   await db.query('begin')
   await this.bindInputInTransaction(db,owner,input)
   let released:Promise<void>|undefined
   return {release:()=>released??=(async()=>{try{await db.query('commit')}finally{db.release()}})()}
  }catch(error){await db.query('rollback');db.release();throw error}
 }
 async availability(owner:string,input:unknown):Promise<ArtifactAvailability>{
  ownerInput(owner);const r=artifactInput(input,['artifactId']);if(!uuid(r.artifactId))throw new WorkError('teloa/invalid-input','成果身份不正确。')
  // 单条语句读取 owner/head 与撤回状态，避免两次无事务读取跨越撤回提交。
  const row=(await this.pool.query('select a.id,w.* from teloa_artifacts a left join teloa_artifact_withdrawals w on w.owner_id=a.owner_id and w.artifact_id=a.id where a.owner_id=$1 and a.id=$2',[owner,r.artifactId])).rows[0]
  if(!row)throw new WorkError('teloa/forbidden','成果不存在或不属于本人。')
  return row.artifact_id?{artifactId:r.artifactId,state:'withdrawn',withdrawal:receipt(row)}:{artifactId:r.artifactId,state:'available',withdrawal:null}
 }
 async withdraw(owner:string,input:unknown):Promise<ArtifactWithdrawal>{
  ownerInput(owner);const r=readArtifactWithdrawalInput(input),db=await this.pool.connect()
  try{
   await db.query('begin')
   await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['artifact-withdrawal',owner,r.requestId])])
   const previous=(await db.query('select *,request_spec=$3::jsonb as same_request from teloa_artifact_withdrawals where owner_id=$1 and request_id=$2',[owner,r.requestId,JSON.stringify(r)])).rows[0]
   if(previous){if(!previous.same_request)throw new WorkError('teloa/conflict','原撤回请求不能更换成果、版本或来源。');const result=receipt(previous);await db.query('commit');return result}
   const head=(await db.query('select current_version from teloa_artifacts where owner_id=$1 and id=$2 for update',[owner,r.artifactId])).rows[0]
   if(!head)throw new WorkError('teloa/forbidden','成果不存在或不属于本人。')
   if((await db.query('select 1 from teloa_artifact_withdrawals where owner_id=$1 and artifact_id=$2',[owner,r.artifactId])).rowCount)throw new WorkError('teloa/conflict','此成果已经撤回，请核对原撤回回执。')
   const version=(await db.query('select source from teloa_artifact_versions where owner_id=$1 and artifact_id=$2 and number=$3',[owner,r.artifactId,r.expectedVersion])).rows[0]
   if(head.current_version!==r.expectedVersion||!version||!isDeepStrictEqual(savedArtifactSource(version.source),r.source))throw new WorkError('teloa/version-conflict','成果当前版本或固定来源已变化，请重新核对后撤回。')
   const result=readArtifactWithdrawal({...r,withdrawnAt:this.now()})
   await db.query('insert into teloa_artifact_withdrawals(owner_id,artifact_id,request_id,request_spec,expected_version,source,withdrawn_at) values($1,$2,$3,$4,$5,$6,$7)',[owner,r.artifactId,r.requestId,JSON.stringify(r),r.expectedVersion,JSON.stringify(r.source),result.withdrawnAt])
   // 不改变头字段值；推进该锁行的 MVCC 身份，使撤回前建立的 repeatable-read
   // 快照在稍后 FOR SHARE 时产生序列化拒绝，不能凭旧快照漏读新撤回记录。
   await db.query('update teloa_artifacts set current_version=current_version where owner_id=$1 and id=$2',[owner,r.artifactId])
   await db.query('commit');return result
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
}

import {createHash} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import type {Pool,PoolClient} from 'pg'
import {WorkError} from '@teloa/contract'
import type {WorkAccessLease} from './work-access.ts'

export type NativeSessionModel={provider:string;model:string;reasoningEffort?:string;permissionMode?:string}
export type NativeSessionCheckpoint={ownerId:string;sessionId:string;runtimeId:string;hostGeneration:number;runId:string|null;scopeRunId:string|null;requestId:string;phase:'claimed'|'model'|'tools'|'step-end'|'turn-end';logCut:number;logSha256:string;roots:readonly {sessionId:string;messageId:string;nativeRequestId:string|null;payloadSha256:string}[];model:NativeSessionModel|null;review:{schema:'teloa.delivery-review-checkpoint/v1';json:string;sha256:string}|null;background?:{runtimeId:string;unsettledJobIds:readonly string[]}}
export type NativeContinuationMessage={id:string;role:'user';source:{kind:'user';rpcId:string}|{kind:'plugin:teloa.session-continuation';continuationId:string;form:'notice';summary:string};content:readonly {type:'text';text:string}[]}
export type NativeContinuationAdmission={runtimeId:string;controls:readonly {id:string;generation:number}[];modelRequestIds:readonly string[];priorEvidence?:unknown;retirement?:{endedAt:string;seq:number;eventSha256:string;boundary:'turn/end'|'checkpoint'}}
export type NativeSessionContinuation={id:string;checkpoint:NativeSessionCheckpoint;prefix:{logCut:number;logSha256:string};hostGeneration:number;mode:'automatic'|'manual';input:'continuation'|'pending';message:NativeContinuationMessage|null;state:'prepared'|'accepted';acceptedSeq:number|null;acceptedEventSha256:string|null;acceptedAt?:string;automaticAdmission?:NativeContinuationAdmission;previousAdmissions?:readonly {hostGeneration:number;admission:NativeContinuationAdmission|null}[]}
type Identity={id:()=>string;now:()=>string}
const sha=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
const canonical=(value:unknown):string=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value!==null&&typeof value==='object'?'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(Reflect.get(value,key))).join(',')+'}':JSON.stringify(value)??''
const digest=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value)
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
const exact=(value:object,keys:readonly string[])=>Object.keys(value).every(key=>keys.includes(key))
const denied=()=>new WorkError('teloa/conflict','原续作检查点或受理回执已变化，请保留原工作并核对。')
async function currentHost(db:PoolClient,ownerId:string,generation:number):Promise<void>{
 const host=(await db.query('select generation from teloa_work_control_hosts where owner_id=$1 for share',[ownerId])).rows[0]
 if(!Number.isSafeInteger(generation)||host?.generation!==generation)throw denied()
}
function checkpoint(value:unknown):NativeSessionCheckpoint{
 if(!value||typeof value!=='object')throw denied()
 const c=value as NativeSessionCheckpoint
 if(!exact(c,['ownerId','sessionId','runtimeId','hostGeneration','runId','scopeRunId','requestId','phase','logCut','logSha256','roots','model','review','background'])||!uuid(c.runtimeId))throw denied()
 if(c.background!==undefined&&(!c.background||!exact(c.background,['runtimeId','unsettledJobIds'])||c.background.runtimeId!==c.runtimeId||!Array.isArray(c.background.unsettledJobIds)||c.background.unsettledJobIds.some(id=>typeof id!=='string'||!id)||new Set(c.background.unsettledJobIds).size!==c.background.unsettledJobIds.length))throw denied()
 if(typeof c.ownerId!=='string'||!c.ownerId.trim()||c.ownerId.length>128||typeof c.sessionId!=='string'||!/^[-a-zA-Z0-9_]{1,128}$/.test(c.sessionId)||!Number.isSafeInteger(c.hostGeneration)||c.hostGeneration<1||!Number.isSafeInteger(c.logCut)||c.logCut<0||!digest(c.logSha256)||!['claimed','model','tools','step-end','turn-end'].includes(c.phase)||typeof c.requestId!=='string'||!c.requestId||c.requestId.length>256||c.runId!==null&&!uuid(c.runId)||c.scopeRunId!==null&&!uuid(c.scopeRunId)||!Array.isArray(c.roots)||!c.roots.length||c.roots.some(root=>!root||typeof root!=='object'||root.sessionId!==c.sessionId||typeof root.messageId!=='string'||!root.messageId||root.nativeRequestId!==null&&typeof root.nativeRequestId!=='string'||!digest(root.payloadSha256)))throw denied()
 if(c.roots.some(root=>!exact(root,['sessionId','messageId','nativeRequestId','payloadSha256']))||c.model!==null&&(!c.model||typeof c.model!=='object'||!exact(c.model,['provider','model','reasoningEffort','permissionMode'])||typeof c.model.provider!=='string'||!c.model.provider||c.model.provider.length>256||typeof c.model.model!=='string'||!c.model.model||c.model.model.length>512||c.model.permissionMode!==undefined&&!['read-only','workspace-write','danger-full-access'].includes(c.model.permissionMode)))throw denied()
 if(c.model?.reasoningEffort!==undefined&&(typeof c.model.reasoningEffort!=='string'||!c.model.reasoningEffort||c.model.reasoningEffort.length>128))throw denied()
 if(c.runId!==null&&c.scopeRunId!==c.runId||!c.roots.some(root=>root.nativeRequestId===c.requestId)||new Set(c.roots.map(root=>root.messageId)).size!==c.roots.length)throw denied()
 if(c.review!==null){
  const review=c.review
  if(!review||typeof review!=='object'||!exact(review,['schema','json','sha256'])||review.schema!=='teloa.delivery-review-checkpoint/v1'||typeof review.json!=='string'||!digest(review.sha256)||createHash('sha256').update(review.json).digest('hex')!==review.sha256)throw denied()
  let state:unknown;try{state=JSON.parse(review.json)}catch{throw denied()}
  if(!state||typeof state!=='object'||Reflect.get(state,'runId')!==c.runId||Reflect.get(state,'requestId')!==c.requestId||Reflect.get(state,'phase')!=='rewrite')throw denied()
 }
 return structuredClone(c)
}

export async function initializeNativeSessionContinuations(pool:Pool):Promise<void>{await pool.query(`
 create table if not exists teloa_native_session_checkpoints(
  owner_id text not null,session_id text not null,host_generation integer not null,checkpoint jsonb not null,updated_at timestamptz not null,
  primary key(owner_id,session_id,host_generation)
 );
 create table if not exists teloa_native_session_continuations(
  id uuid primary key,owner_id text not null,session_id text not null,run_id uuid,scope_run_id uuid,
  prefix_sha256 text not null,record jsonb not null,created_at timestamptz not null,updated_at timestamptz not null,
  unique(owner_id,session_id,prefix_sha256)
 );
 create index if not exists teloa_native_continuation_run on teloa_native_session_continuations(owner_id,run_id);
`)}

/** 持久续作账本只由原生检查点及恢复协调器使用；不提供客户端自报恢复标记的写入口。 */
export class NativeSessionContinuationJournal{
 readonly pool:Pool;readonly identity:Identity
 constructor(pool:Pool,identity:Identity){this.pool=pool;this.identity=identity}
 async save(value:NativeSessionCheckpoint,assertCurrent:()=>void):Promise<void>{
  const c=checkpoint(value),db=await this.pool.connect()
  try{
   assertCurrent();await db.query('begin');await currentHost(db,c.ownerId,c.hostGeneration);await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['teloa/native-checkpoint',c.ownerId,c.sessionId])])
   const old=(await db.query('select checkpoint from teloa_native_session_checkpoints where owner_id=$1 and session_id=$2 and host_generation=$3 for update',[c.ownerId,c.sessionId,c.hostGeneration])).rows[0]
   if(old){const previous=checkpoint(old.checkpoint);if(previous.logCut>c.logCut){assertCurrent();await db.query('commit');return}if(previous.logCut===c.logCut&&!isDeepStrictEqual({...previous,phase:c.phase},c))throw denied()}
   assertCurrent()
   await db.query('insert into teloa_native_session_checkpoints(owner_id,session_id,host_generation,checkpoint,updated_at) values($1,$2,$3,$4,$5) on conflict(owner_id,session_id,host_generation) do update set checkpoint=excluded.checkpoint,updated_at=excluded.updated_at',[c.ownerId,c.sessionId,c.hostGeneration,JSON.stringify(c),this.identity.now()])
   assertCurrent();await db.query('commit')
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
 async latest(ownerId:string,sessionId:string):Promise<NativeSessionCheckpoint|null>{
  const row=(await this.pool.query('select checkpoint from teloa_native_session_checkpoints where owner_id=$1 and session_id=$2 order by host_generation desc limit 1',[ownerId,sessionId])).rows[0]
  const c=row?checkpoint(row.checkpoint):null
  if(c&&(c.ownerId!==ownerId||c.sessionId!==sessionId))throw denied()
  return c
 }
 async forPrefix(ownerId:string,sessionId:string,prefixSha256:string):Promise<NativeSessionContinuation|null>{
  if(!digest(prefixSha256))throw denied()
  const row=(await this.pool.query('select record from teloa_native_session_continuations where owner_id=$1 and session_id=$2 and prefix_sha256=$3',[ownerId,sessionId,prefixSha256])).rows[0]
  const r=row?this.read(row.record):null
  if(r&&(r.checkpoint.ownerId!==ownerId||r.checkpoint.sessionId!==sessionId||r.prefix.logSha256!==prefixSha256))throw denied()
  return r
 }
 async automaticCandidates(ownerId:string,hostGeneration:number):Promise<NativeSessionCheckpoint[]>{
  const rows=(await this.pool.query(`with latest as(
   select distinct on(session_id) owner_id,session_id,host_generation,checkpoint from teloa_native_session_checkpoints where owner_id=$1 order by session_id,host_generation desc
  ) select l.checkpoint from latest l join teloa_task_runs r on r.owner_id=l.owner_id and r.session_id=l.session_id and r.id::text=l.checkpoint->>'runId'
   join teloa_tasks t on t.owner_id=r.owner_id and t.id=r.task_id where l.host_generation<$2 and
   (r.state in ('submitting','accepted','active') or (r.state='ended' and r.evidence->>'reason'='completed' and r.stop_requested_at is null and t.state='waiting'))`,[ownerId,hostGeneration])).rows
  return rows.map(row=>checkpoint(row.checkpoint)).filter(c=>c.ownerId===ownerId&&c.hostGeneration<hostGeneration&&c.runId!==null)
 }
 /** 调用方在同事务中核对归属、当前授权、控制与累计额度；票据落定先于任何原生发布。 */
 async prepare(captured:NativeSessionCheckpoint,hostGeneration:number,mode:'automatic'|'manual',authorize:(db:PoolClient,c:NativeSessionCheckpoint,record:NativeSessionContinuation)=>Promise<WorkAccessLease>,inputKind:'continuation'|'pending'='continuation',observed:{logCut:number;logSha256:string}={logCut:captured.logCut,logSha256:captured.logSha256}):Promise<{record:NativeSessionContinuation;lease:WorkAccessLease}>{
  const c=checkpoint(captured)
  const prefix=structuredClone(observed)
  if(!Number.isSafeInteger(hostGeneration)||hostGeneration<c.hostGeneration||mode==='automatic'&&(hostGeneration===c.hostGeneration||c.runId===null)||!exact(prefix,['logCut','logSha256'])||!Number.isSafeInteger(prefix.logCut)||prefix.logCut<c.logCut||!digest(prefix.logSha256)||!['continuation','pending'].includes(inputKind)||inputKind==='pending'&&c.roots.length!==1)throw denied()
  const db=await this.pool.connect()
  try{
   await db.query('begin');await currentHost(db,c.ownerId,hostGeneration);await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['teloa/native-checkpoint',c.ownerId,c.sessionId])])
   const saved=(await db.query('select checkpoint from teloa_native_session_checkpoints where owner_id=$1 and session_id=$2 order by host_generation desc limit 1 for share',[c.ownerId,c.sessionId])).rows[0]
   if(!saved||!isDeepStrictEqual(checkpoint(saved.checkpoint),c))throw denied()
   const existing=(await db.query('select record from teloa_native_session_continuations where owner_id=$1 and session_id=$2 and prefix_sha256=$3 for update',[c.ownerId,c.sessionId,prefix.logSha256])).rows[0]
   if(existing){
    const record=this.read(existing.record)
    if(record.mode!==mode||record.input!==inputKind||!isDeepStrictEqual(record.checkpoint,c)||!isDeepStrictEqual(record.prefix,prefix)||record.hostGeneration>hostGeneration)throw denied()
    if(mode==='automatic'&&record.hostGeneration<hostGeneration){record.previousAdmissions=[...record.previousAdmissions??[],{hostGeneration:record.hostGeneration,admission:record.automaticAdmission??null}];record.hostGeneration=hostGeneration;delete record.automaticAdmission;await db.query('update teloa_native_session_continuations set record=$3 where owner_id=$1 and id=$2',[c.ownerId,record.id,JSON.stringify(record)])}
    const lease=await authorize(db,c,record);this.read(record);await db.query('update teloa_native_session_continuations set record=$3 where owner_id=$1 and id=$2',[c.ownerId,record.id,JSON.stringify(record)])
    lease.assertCurrent();await db.query('commit');return {record,lease}
   }
   const id=this.identity.id();if(!uuid(id))throw denied()
   const text='继续原工作。完整原会话与已完成工具回执仍是本轮依据。先从尚未完成的工作继续，不重复已完成步骤；任何外部结果未知、停止、取消或撤权均保持待核对。已有正式报告时只补交付与收口。'
   const message:NativeContinuationMessage|null=inputKind==='pending'?null:{id:this.identity.id(),role:'user',source:mode==='manual'?{kind:'user',rpcId:id}:{kind:'plugin:teloa.session-continuation',continuationId:id,form:'notice',summary:'继续原执行'},content:[{type:'text',text}]}
   if(message&&!uuid(message.id))throw denied()
   const record:NativeSessionContinuation={id,checkpoint:c,prefix,hostGeneration,mode,input:inputKind,message,state:'prepared',acceptedSeq:null,acceptedEventSha256:null},now=this.identity.now()
   await db.query('insert into teloa_native_session_continuations(id,owner_id,session_id,run_id,scope_run_id,prefix_sha256,record,created_at,updated_at) values($1,$2,$3,$4,$5,$6,$7,$8,$8)',[id,c.ownerId,c.sessionId,c.runId,c.scopeRunId,prefix.logSha256,JSON.stringify(record),now])
   const lease=await authorize(db,c,record)
   this.read(record);await db.query('update teloa_native_session_continuations set record=$3 where owner_id=$1 and id=$2',[c.ownerId,id,JSON.stringify(record)])
   lease.assertCurrent();await db.query('commit');return {record,lease}
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
 read(value:unknown):NativeSessionContinuation{
  if(!value||typeof value!=='object')throw denied()
  const r=value as NativeSessionContinuation,c=checkpoint(r.checkpoint)
  if(!exact(r,['id','checkpoint','prefix','hostGeneration','mode','input','message','state','acceptedSeq','acceptedEventSha256','acceptedAt','automaticAdmission','previousAdmissions']))throw denied()
  if(r.acceptedAt!==undefined&&(r.state!=='accepted'||!Number.isFinite(Date.parse(r.acceptedAt))||new Date(r.acceptedAt).toISOString()!==r.acceptedAt))throw denied()
  if(r.previousAdmissions!==undefined&&(!Array.isArray(r.previousAdmissions)||r.mode!=='automatic'||r.previousAdmissions.some((v,i,a)=>!v||!exact(v,['hostGeneration','admission'])||!Number.isSafeInteger(v.hostGeneration)||v.hostGeneration<=c.hostGeneration||v.hostGeneration>=r.hostGeneration||i>0&&v.hostGeneration<=a[i-1]!.hostGeneration)))throw denied()
  if(r.automaticAdmission!==undefined){const a=r.automaticAdmission;if(r.mode!=='automatic'||!a||!uuid(a.runtimeId)||!exact(a,['runtimeId','controls','modelRequestIds','priorEvidence','retirement'])||!Array.isArray(a.controls)||!a.controls.length||a.controls.some(c=>!c||!exact(c,['id','generation'])||!uuid(c.id)||!Number.isSafeInteger(c.generation)||c.generation<1)||new Set(a.controls.map(c=>c.id)).size!==a.controls.length||!Array.isArray(a.modelRequestIds)||a.modelRequestIds.some(id=>typeof id!=='string'||!id)||new Set(a.modelRequestIds).size!==a.modelRequestIds.length)throw denied();if(a.retirement){const t=a.retirement;if(!exact(t,['endedAt','seq','eventSha256','boundary'])||!Number.isSafeInteger(t.seq)||t.seq<0||t.seq>r.prefix.logCut||!digest(t.eventSha256)||!['turn/end','checkpoint'].includes(t.boundary)||!Number.isFinite(Date.parse(t.endedAt))||new Date(t.endedAt).toISOString()!==t.endedAt)throw denied()}}
  if(!uuid(r.id)||!Number.isSafeInteger(r.hostGeneration)||r.hostGeneration<c.hostGeneration||!['automatic','manual'].includes(r.mode)||r.mode==='automatic'&&(r.hostGeneration===c.hostGeneration||c.runId===null)||!r.prefix||!exact(r.prefix,['logCut','logSha256'])||!Number.isSafeInteger(r.prefix.logCut)||r.prefix.logCut<c.logCut||!digest(r.prefix.logSha256)||!['prepared','accepted'].includes(r.state)||!['continuation','pending'].includes(r.input))throw denied()
  if(r.input==='pending'){
   if(r.message!==null||c.roots.length!==1||c.roots[0]!.nativeRequestId!==c.requestId)throw denied()
  }else{
   if(!r.message||!uuid(r.message.id)||!Array.isArray(r.message.content)||r.message.content.length!==1||r.message.content[0]?.type!=='text'||typeof r.message.content[0].text!=='string'||!r.message.content[0].text)throw denied()
   const source=r.message.source
   if(!source||r.message.role!=='user'||!exact(r.message,['id','role','source','content'])||!exact(r.message.content[0],['type','text'])||!exact(source,r.mode==='manual'?['kind','rpcId']:['kind','continuationId','form','summary']))throw denied()
   if(r.mode==='manual'?(source.kind!=='user'||source.rpcId!==r.id):(source.kind!=='plugin:teloa.session-continuation'||source.continuationId!==r.id||source.form!=='notice'||source.summary!=='继续原执行'))throw denied()
  }
  if(r.state==='prepared'?(r.acceptedSeq!==null||r.acceptedEventSha256!==null):(!Number.isSafeInteger(r.acceptedSeq)||(r.acceptedSeq??-1)<0||(r.input==='continuation'?(r.acceptedSeq??-1)<=r.prefix.logCut:(r.acceptedSeq??Infinity)>r.prefix.logCut)||!digest(r.acceptedEventSha256)))throw denied()
  return structuredClone({...r,checkpoint:c})
 }
 async records(ownerId:string,sessionId:string):Promise<NativeSessionContinuation[]>{
  const rows=(await this.pool.query('select record from teloa_native_session_continuations where owner_id=$1 and session_id=$2 order by created_at,id',[ownerId,sessionId])).rows
  const records=rows.map(row=>this.read(row.record));if(records.some(r=>r.checkpoint.ownerId!==ownerId||r.checkpoint.sessionId!==sessionId))throw denied();return records
 }
 /** acceptedEvent必须来自已flush/read的完整官方日志；这里只原子固定该真实受理位置，不宣称模型或业务成功。 */
 async accept(ownerId:string,id:string,acceptedSeq:number,event:unknown,assertCurrent:()=>void,hostGeneration:number):Promise<NativeSessionContinuation>{
  const db=await this.pool.connect()
  try{
   assertCurrent();await db.query('begin');await currentHost(db,ownerId,hostGeneration);const row=(await db.query('select record from teloa_native_session_continuations where owner_id=$1 and id=$2 for update',[ownerId,id])).rows[0]
   if(!row)throw denied()
   const r=this.read(row.record),e=event as {type?:unknown;seq?:unknown;data?:{target?:unknown;inserted?:unknown[]}}
   if(r.hostGeneration>hostGeneration)throw denied()
   if(e?.type!=='agent/inbox/spliced'||e.seq!==acceptedSeq||!Number.isSafeInteger(acceptedSeq)||acceptedSeq<0||e.data?.target!=='next-turn'||!Array.isArray(e.data.inserted)||e.data.inserted.length!==1)throw denied()
   if(r.input==='continuation'){
    if(acceptedSeq<=r.prefix.logCut||!isDeepStrictEqual(e.data.inserted[0],r.message))throw denied()
   }else{
    const message=e.data.inserted[0] as {id?:unknown;role?:unknown;source?:{kind?:unknown;rpcId?:unknown}},root=r.checkpoint.roots[0]!
    if(acceptedSeq>r.prefix.logCut||message?.id!==root.messageId||message.role!=='user'||message.source?.kind!=='user'||message.source.rpcId!==root.nativeRequestId||createHash('sha256').update(canonical(message)).digest('hex')!==root.payloadSha256)throw denied()
   }
   const next:NativeSessionContinuation={...r,state:'accepted',acceptedSeq,acceptedEventSha256:sha(event),acceptedAt:r.acceptedAt??this.identity.now()}
   if(r.state==='accepted'&&!isDeepStrictEqual(r,next))throw denied()
   assertCurrent();await db.query('update teloa_native_session_continuations set record=$3,updated_at=$4 where owner_id=$1 and id=$2',[ownerId,id,JSON.stringify(next),this.identity.now()]);assertCurrent();await db.query('commit');return next
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
}

import {createHash} from 'node:crypto'
import type {Pool,PoolClient} from 'pg'
import {WorkError,projectInput,projectRuntimeUuid,projectRuntimeVersion,projectRuntimeText} from '@teloa/contract'
import {ProjectContextService} from './project-context.ts'

/** 显式采用时固定的来源引用；手工改写正文后清除，不冒称正文仍等于原来源。 */
export type ProjectPersonalMemorySource={projectId:string;entryId:string;entryVersion:number;basisHash:string}
export type ProjectPersonalMemoryEntry={id:string;version:number;topic:string;markdown:string;source?:ProjectPersonalMemorySource}
export type ProjectPersonalMemory={version:number;entries:ProjectPersonalMemoryEntry[]}
const listeners=new WeakMap<Pool,Set<(owner:string)=>void>>()
export function subscribePersonalMemoryChanges(pool:Pool,listener:(owner:string)=>void){if(!listeners.has(pool))listeners.set(pool,new Set());listeners.get(pool)!.add(listener);return ()=>{listeners.get(pool)?.delete(listener)}}
const denied=()=>new WorkError('teloa/not-found','个人偏好不存在或不可访问。')
const conflict=()=>new WorkError('teloa/version-conflict','个人偏好已更新，请重新读取。')
const capacity=()=>new WorkError('teloa/conflict','个人偏好已达到有效条目上限，请先整理。')
const ownerKey=(owner:string)=>{if(typeof owner!=='string'||!owner.trim()||owner.length>128)throw denied()}
const MARKDOWN_MAX=12000
export async function initializeProjectPersonalMemory(pool:Pool){await pool.query(`
 create table if not exists teloa_personal_memory_stores(owner_id text primary key,version integer not null check(version>0));
 create table if not exists teloa_personal_memory_entries(id uuid primary key,owner_id text not null,version integer not null check(version>0),topic text not null,markdown text,state text not null check(state in('active','withdrawn')));
 alter table teloa_personal_memory_entries add column if not exists source jsonb;
 create index if not exists teloa_personal_memory_owner on teloa_personal_memory_entries(owner_id,state);
 create table if not exists teloa_personal_memory_requests(owner_id text not null,request_id uuid not null,spec_hash text not null,primary key(owner_id,request_id));
`)}
/** 仅本人显式编辑或显式采用；自动提炼和项目分享不具有个人写入端口。 */
export class ProjectPersonalMemoryService{
 readonly pool:Pool;readonly identity:{id:()=>string;now:()=>string}
 constructor(pool:Pool,identity:{id:()=>string;now:()=>string}){this.pool=pool;this.identity=identity}
 async readInTransaction(db:PoolClient,owner:string):Promise<ProjectPersonalMemory>{
  ownerKey(owner);const version=(await db.query('select version from teloa_personal_memory_stores where owner_id=$1',[owner])).rows[0]?.version??0
  const rows=(await db.query("select id,version,topic,markdown,source from teloa_personal_memory_entries where owner_id=$1 and state='active' order by id",[owner])).rows
  return {version,entries:rows.map(row=>({id:row.id,version:row.version,topic:row.topic,markdown:row.markdown,...(row.source?{source:row.source as ProjectPersonalMemorySource}:{})}))}
 }
 async get(owner:string){ownerKey(owner);const db=await this.pool.connect();try{await db.query('begin isolation level repeatable read read only');const value=await this.readInTransaction(db,owner);await db.query('commit');return value}catch(error){await db.query('rollback');throw error}finally{db.release()}}
 save(owner:string,input:unknown,signal?:AbortSignal){return this.mutate(owner,input,'save',signal)}
 withdraw(owner:string,input:unknown,signal?:AbortSignal){return this.mutate(owner,input,'withdraw',signal)}
 /** 显式把本人当前项目的有效 rule/memory 采用为独立个人副本：正文与主题取服务端固定版本，不接受客户端正文；之后原项目撤回不影响副本。 */
 async publishProjectExperience(owner:string,input:unknown,signal?:AbortSignal):Promise<ProjectPersonalMemory>{
  ownerKey(owner);const r=projectInput(input,['requestId','projectId','entryId','entryVersion','expectedPersonalVersion'])
  const requestId=projectRuntimeUuid(r.requestId),projectId=projectRuntimeUuid(r.projectId),entryId=projectRuntimeUuid(r.entryId),entryVersion=projectRuntimeVersion(r.entryVersion,1),expectedVersion=projectRuntimeVersion(r.expectedPersonalVersion)
  const digest=createHash('sha256').update(JSON.stringify({action:'publish',expectedVersion,projectId,entryId,entryVersion})).digest('hex')
  return this.transact(owner,requestId,digest,expectedVersion,signal,async(db,current)=>{
   if(current.entries.length>=100)throw capacity()
   const source=await new ProjectContextService(this.pool,this.identity).readAdoptableEntryInTransaction(db,owner,{projectId,entryId,entryVersion})
   if(current.entries.some(e=>e.source?.entryId===entryId&&e.source.entryVersion===entryVersion))throw new WorkError('teloa/conflict','该版本已采用为个人偏好。')
   if(source.markdown.length>MARKDOWN_MAX)throw new WorkError('teloa/conflict','来源正文超过个人偏好长度上限，不能直接采用。')
   const sourceRef:ProjectPersonalMemorySource={projectId,entryId,entryVersion,basisHash:source.hash}
   await db.query("insert into teloa_personal_memory_entries(id,owner_id,version,topic,markdown,state,source) values($1,$2,1,$3,$4,'active',$5)",[this.identity.id(),owner,source.topic,source.markdown,JSON.stringify(sourceRef)])
  })
 }
 private async mutate(owner:string,input:unknown,action:'save'|'withdraw',signal?:AbortSignal){
  ownerKey(owner);const r=projectInput(input,action==='save'?['requestId','expectedVersion','entryId','topic','markdown']:['requestId','expectedVersion','entryId'])
  const requestId=projectRuntimeUuid(r.requestId),expectedVersion=projectRuntimeVersion(r.expectedVersion),entryId=r.entryId===null&&action==='save'?null:projectRuntimeUuid(r.entryId)
  const topic=action==='save'?projectRuntimeText(r.topic,120).trim():'',markdown=action==='save'?projectRuntimeText(r.markdown,MARKDOWN_MAX).trim():''
  if(action==='save'&&(!topic||!markdown))throw new WorkError('teloa/invalid-input','请填写个人偏好的主题和内容。')
  const digest=createHash('sha256').update(JSON.stringify({action,expectedVersion,entryId,topic,markdown})).digest('hex')
  return this.transact(owner,requestId,digest,expectedVersion,signal,async(db,current)=>{
   if(entryId&&!current.entries.some(e=>e.id===entryId))throw denied()
   if(action==='save'){
    if(!entryId&&current.entries.length>=100)throw capacity()
    // 手工改写即与原来源脱钩：清除 source，避免冒称正文仍等于项目固定版本。
    if(entryId)await db.query('update teloa_personal_memory_entries set version=version+1,topic=$3,markdown=$4,source=null where owner_id=$1 and id=$2',[owner,entryId,topic,markdown])
    else await db.query("insert into teloa_personal_memory_entries(id,owner_id,version,topic,markdown,state) values($1,$2,1,$3,$4,'active')",[this.identity.id(),owner,topic,markdown])
   }else await db.query("update teloa_personal_memory_entries set version=version+1,state='withdrawn',markdown=null where owner_id=$1 and id=$2",[owner,entryId])
  })
 }
 /** 本人锁 + 相同请求回放 + 真源 CAS；具体变更在 apply 内完成，之后统一推进版本并登记请求摘要。 */
 private async transact(owner:string,requestId:string,digest:string,expectedVersion:number,signal:AbortSignal|undefined,apply:(db:PoolClient,current:ProjectPersonalMemory)=>Promise<void>){
  const db=await this.pool.connect()
  try{
   signal?.throwIfAborted();await db.query('begin');await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['teloa/project-context',owner])])
   const replay=(await db.query('select spec_hash from teloa_personal_memory_requests where owner_id=$1 and request_id=$2',[owner,requestId])).rows[0]
   if(replay){if(replay.spec_hash!==digest)throw conflict();const value=await this.readInTransaction(db,owner);await db.query('commit');return value}
   const current=await this.readInTransaction(db,owner);if(current.version!==expectedVersion)throw conflict()
   await apply(db,current)
   await db.query('insert into teloa_personal_memory_stores values($1,$2) on conflict(owner_id) do update set version=excluded.version',[owner,current.version+1])
   await db.query('insert into teloa_personal_memory_requests values($1,$2,$3)',[owner,requestId,digest]);signal?.throwIfAborted()
   for(const listener of listeners.get(this.pool)??[])listener(owner)
   const value=await this.readInTransaction(db,owner);await db.query('commit');return value
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
}

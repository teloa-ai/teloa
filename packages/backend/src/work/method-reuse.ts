import {createHash} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import type {Pool,PoolClient} from 'pg'
import {WorkError,isRecord,readMethodReuseSource,readMethodReuseAcceptedSource,readMethodReuseIntent,readMethodReuseReference,methodReuseBasisHash,readPageCreatePlanDraft,taskInput,type MethodReuseSource,type MethodReuseAcceptedSource,type MethodReuseTarget,type MethodReuseIntent,type SavedArtifactVersion,type PageCreateDraft} from '@teloa/contract'
import type {ArtifactService} from './artifacts.ts'
import type {PageCreateDraftService} from './page-create-drafts.ts'
import {readStoredTask} from './tasks.ts'
import {isArtifactRevisionProducer} from './artifact-revision-requests.ts'

export type MethodReuseAcceptedMessage=MethodReuseAcceptedSource&{ownerId:string;source:{kind:'user';rpcId:string};text:string}
export type PrepareMethodReuseInput={requestId:string;source:MethodReuseSource;acceptedSource?:MethodReuseAcceptedSource;target:MethodReuseTarget}
export type MethodReuseDraftAuthority={source:MethodReuseSource;target:MethodReuseTarget;intent:MethodReuseIntent;acceptedSource?:MethodReuseAcceptedSource}
export type MethodReusePorts={
 artifacts:Pick<ArtifactService,'readVersion'>
 drafts:Pick<PageCreateDraftService,'createInTransaction'|'draftInTransaction'>
 /** 只接受宿主回读的原生本人消息；模型工具参数不得提供这份回执。 */
 readAcceptedMessage:(owner:string,source:MethodReuseAcceptedSource)=>Promise<MethodReuseAcceptedMessage>
 /** 复用原成果来源服务；传入同一事务，来源可变行应持共享锁至草稿提交。 */
 assertSourceCurrent:(db:PoolClient,owner:string,artifact:SavedArtifactVersion)=>Promise<void>
 /** 同一次原创建工具已经生成的正文；本服务不发模型、不执行方法或安装技能。 */
 prepareBody:(input:{ownerId:string;source:MethodReuseSource;artifact:SavedArtifactVersion;target:MethodReuseTarget;intent:MethodReuseIntent;acceptedSource?:MethodReuseAcceptedSource},signal?:AbortSignal)=>Promise<unknown>
}
const invalid=()=>new WorkError('teloa/invalid-input','可信成果复用请求格式不正确。')
const denied=()=>new WorkError('teloa/forbidden','需要本人认可的固定成果，或原本人消息明确要求保存方法。')
const stale=()=>new WorkError('teloa/version-conflict','原成果、认可消息或方法草稿已变化，请重新核对。')
const corrupt=()=>new WorkError('teloa/storage-corrupt','方法来源与草稿回执不一致。')
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
const ownerValue=(owner:string)=>{if(typeof owner!=='string'||!owner.trim()||owner!==owner.trim()||owner.length>128||/[\x00-\x1f\x7f]/.test(owner))throw denied()}
const hash=(value:string)=>createHash('sha256').update(value).digest('hex')
type Acceptance={kind:'message';source:MethodReuseAcceptedSource;textHash:string}|{kind:'manual-completion';taskId:string;taskVersion:number;requestId:string}

/** 仅保存来源和唯一草稿回执；成果正文、技能与计划仍在各自原存储中。 */
export async function initializeMethodReuse(pool:Pool):Promise<void>{
 await pool.query(`create table if not exists teloa_method_reuse_requests(
  owner_id text not null,request_id uuid not null,request_spec jsonb not null,
  artifact_id uuid not null,artifact_version integer not null check(artifact_version>0),
  acceptance jsonb not null,draft_id uuid not null,body_hash text not null check(body_hash~'^[a-f0-9]{64}$'),created_at timestamptz not null,
  primary key(owner_id,request_id),unique(owner_id,draft_id),
  foreign key(owner_id,artifact_id,artifact_version) references teloa_artifact_versions(owner_id,artifact_id,number),
  foreign key(owner_id,draft_id) references teloa_page_create_drafts(owner_id,id)
 )`)
}

export class MethodReuseService{
 readonly pool:Pool;readonly identity:{id:()=>string;now:()=>string};readonly ports:MethodReusePorts
 constructor(pool:Pool,identity:{id:()=>string;now:()=>string},ports:MethodReusePorts){this.pool=pool;this.identity=identity;this.ports=ports}
 private input(input:unknown):PrepareMethodReuseInput{
  const row=taskInput(input,['requestId','source','acceptedSource','target'])
  if(!uuid(row.requestId)||row.target!=='skill'&&row.target!=='plan')throw invalid()
  return {requestId:row.requestId.toLowerCase(),source:readMethodReuseSource(row.source),target:row.target,...row.acceptedSource===undefined?{}:{acceptedSource:readMethodReuseAcceptedSource(row.acceptedSource)}}
 }
 /** 只读本人指定成果；尚未认可也可先了解内容，不因此取得保存或启用许可。 */
 async readSource(owner:string,input:unknown,signal?:AbortSignal):Promise<{source:MethodReuseSource;artifact:SavedArtifactVersion}>{
  ownerValue(owner);const row=taskInput(input,['artifactId','version'])
  if(!uuid(row.artifactId)||row.version!==undefined&&(!Number.isSafeInteger(row.version)||Number(row.version)<1))throw invalid()
  const db=await this.pool.connect()
  try{
   await db.query('begin isolation level repeatable read');signal?.throwIfAborted()
   const head=(await db.query('select current_version from teloa_artifacts where owner_id=$1 and id=$2',[owner,row.artifactId])).rows[0]
   if(!head)throw denied()
   const version=row.version??head.current_version
   if(version!==head.current_version)throw stale()
   const artifact=await this.ports.artifacts.readVersion(db,owner,row.artifactId,version as number)
   const producer=await this.producer(db,owner,artifact,false)
   const taskId=producer??(artifact.source.kind==='task'?artifact.source.id:undefined)
   const source:MethodReuseSource={artifactId:artifact.artifactId,version:artifact.number,basisHash:await methodReuseBasisHash(artifact),...taskId?{taskId}:{}}
   await this.currentArtifact(db,owner,source,false);signal?.throwIfAborted();await db.query('commit')
   return {source,artifact}
  }catch(error){await db.query('rollback').catch(()=>{});throw error}finally{db.release()}
 }
 /** 已结项会合法推进Task版本；原固定completion代替“来源必须仍等于结项前版本”的错误判断。 */
 private async producer(db:PoolClient,owner:string,artifact:SavedArtifactVersion,lock:boolean):Promise<string|undefined>{
  const present=(await db.query("select to_regclass('teloa_artifact_revision_producers') as relation")).rows[0]?.relation
  if(!present)return
  const rows=(await db.query('select task_id from teloa_artifact_revision_producers where owner_id=$1 and artifact_id=$2 and number=$3'+(lock?' for share':''),[owner,artifact.artifactId,artifact.number])).rows
  if(!rows.length)return
  if(rows.length!==1||!uuid(rows[0].task_id)||!await isArtifactRevisionProducer(db,owner,rows[0].task_id,artifact))throw corrupt()
  return rows[0].task_id
 }
 private async completion(db:PoolClient,owner:string,artifact:SavedArtifactVersion,source:MethodReuseSource,lock:boolean,producer?:string):Promise<{valid:boolean;manual:Acceptance|null}>{
  const taskId=source.taskId??(artifact.source.kind==='task'?artifact.source.id:undefined)
  if(!taskId)return {valid:false,manual:null}
  if(!producer&&(artifact.source.kind!=='task'||artifact.source.id!==taskId))throw denied()
  const taskRow=(await db.query('select * from teloa_tasks where owner_id=$1 and id=$2'+(lock?' for share':''),[owner,taskId])).rows[0]
  if(!taskRow)throw denied();const task=readStoredTask(taskRow)
  if(task.state==='cancelled')throw stale()
  if(producer&&!await isArtifactRevisionProducer(db,owner,task.id,artifact,task.state==='completed'?task.version-1:task.version))throw stale()
  const present=(await db.query("select to_regclass('teloa_task_completions') as relation")).rows[0]?.relation
  if(!present)return {valid:false,manual:null}
  if(task.state!=='completed')return {valid:false,manual:null}
  const saved=(await db.query('select * from teloa_task_completions where owner_id=$1 and task_id=$2'+(lock?' for share':''),[owner,taskId])).rows[0]
  if(!saved||saved.artifact_id!==artifact.artifactId||saved.artifact_version!==artifact.number||saved.task_version!==task.version)throw stale()
  const rows=(await db.query('select request_id,request_spec,result from teloa_task_transitions where owner_id=$1 and task_id=$2'+(lock?' for share':''),[owner,taskId])).rows
  const matches=rows.filter(row=>isRecord(row.request_spec)&&row.request_spec.action==='complete'&&row.request_spec.expectedVersion===task.version-1&&isRecord(row.request_spec.artifact)&&row.request_spec.artifact.id===artifact.artifactId&&row.request_spec.artifact.version===artifact.number&&isRecord(row.result)&&row.result.version===task.version&&row.result.state==='completed')
  const receipt=matches[0]
  if(matches.length!==1||!receipt||!uuid(receipt.request_id))throw corrupt()
  return {valid:true,manual:Object.hasOwn(receipt.request_spec,'verifiedCompletion')?null:{kind:'manual-completion',taskId,taskVersion:task.version,requestId:receipt.request_id}}
 }
 private async currentArtifact(db:PoolClient,owner:string,source:MethodReuseSource,lock=true){
  const head=(await db.query('select current_version from teloa_artifacts where owner_id=$1 and id=$2'+(lock?' for share':''),[owner,source.artifactId])).rows[0]
  if(!head)throw denied();if(head.current_version!==source.version)throw stale()
  const artifact=await this.ports.artifacts.readVersion(db,owner,source.artifactId,source.version)
  if(artifact.ownerId!==owner||artifact.artifactId!==source.artifactId||artifact.number!==source.version||await methodReuseBasisHash(artifact)!==source.basisHash)throw stale()
  const producer=await this.producer(db,owner,artifact,lock)
  const taskId=producer??(artifact.source.kind==='task'?artifact.source.id:undefined)
  if(source.taskId!==undefined&&source.taskId!==taskId)throw denied()
  const completion=await this.completion(db,owner,artifact,{...source,...taskId?{taskId}:{}},lock,producer)
  if(!completion.valid&&!producer)await this.ports.assertSourceCurrent(db,owner,artifact)
  return {artifact,manual:completion.manual}
 }
 private async verify(db:PoolClient,owner:string,input:Pick<PrepareMethodReuseInput,'source'|'acceptedSource'|'target'>,signal?:AbortSignal){
  signal?.throwIfAborted()
  const {artifact,manual}=await this.currentArtifact(db,owner,input.source)
  let acceptance:Acceptance|null=manual,intent:MethodReuseIntent='save-paused'
  if(input.acceptedSource){
   const original=input.acceptedSource,message=await this.ports.readAcceptedMessage(owner,original)
   if(message.ownerId!==owner||message.sessionId!==original.sessionId||message.messageId!==original.messageId||message.messageSeq!==original.messageSeq||message.requestId!==original.requestId||message.source?.kind!=='user'||message.source.rpcId!==original.requestId||typeof message.text!=='string')throw denied()
   const explicit=readMethodReuseIntent(message.text,input.target)
   const reference=readMethodReuseReference(message.text)
   if(reference&&(reference.artifactId!==input.source.artifactId||reference.version!==input.source.version))throw denied()
   if(explicit&&reference){intent=explicit;acceptance={kind:'message',source:original,textHash:hash(message.text)}}
  }
  if(!acceptance)throw denied()
  signal?.throwIfAborted()
  return {artifact,acceptance,intent}
 }
 /** 后续计划复用调用方事务；仅核来源，不捕获本人授权、不启用计划，也不写方法账本。 */
 async assertPlanSourceInTransaction(db:PoolClient,owner:string,input:{source:MethodReuseSource;acceptedSource?:MethodReuseAcceptedSource},signal?:AbortSignal):Promise<{intent:MethodReuseIntent}>{
  ownerValue(owner)
  const row=taskInput(input,['source','acceptedSource']),source=readMethodReuseSource(row.source),acceptedSource=row.acceptedSource===undefined?undefined:readMethodReuseAcceptedSource(row.acceptedSource)
  if(!acceptedSource&&!source.taskId)throw denied()
  const fixed={source,...acceptedSource?{acceptedSource}:{},target:'plan' as const}
  const checked=await this.verify(db,owner,fixed,signal)
  if(acceptedSource&&checked.acceptance.kind!=='message')throw denied()
  return {intent:checked.intent}
 }
 async prepareMethodReuse(owner:string,input:PrepareMethodReuseInput,signal?:AbortSignal):Promise<PageCreateDraft>{
  ownerValue(owner);const fixed=this.input(input),db=await this.pool.connect()
  try{
   await db.query('begin');await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['method-reuse',owner,fixed.requestId])])
   const checked=await this.verify(db,owner,fixed,signal)
   const prior=(await db.query('select * from teloa_method_reuse_requests where owner_id=$1 and request_id=$2',[owner,fixed.requestId])).rows[0]
   if(prior){
    if(!isDeepStrictEqual(prior.request_spec,fixed))throw new WorkError('teloa/conflict','同一方法复用请求已绑定另一份来源或目标。')
    const draft=await this.ports.drafts.draftInTransaction(db,owner,prior.draft_id)
    if(draft.bodyHash!==prior.body_hash||draft.requestId!==fixed.requestId||draft.entity!==fixed.target||!isDeepStrictEqual(prior.acceptance,checked.acceptance))throw stale()
    signal?.throwIfAborted();await db.query('commit');return draft
   }
   const body=await this.ports.prepareBody({ownerId:owner,source:fixed.source,artifact:checked.artifact,target:fixed.target,intent:checked.intent,...fixed.acceptedSource?{acceptedSource:fixed.acceptedSource}:{}},signal)
   if(fixed.target==='plan'){
    const plan=readPageCreatePlanDraft(body)
    if('kind'in plan||!isDeepStrictEqual(plan.source,fixed.source)||plan.intent==='create-and-enable'&&checked.intent!=='create-and-enable')throw denied()
   }
   const current=await this.verify(db,owner,fixed,signal)
   if(!isDeepStrictEqual(current.acceptance,checked.acceptance)||current.intent!==checked.intent)throw stale()
   // PageCreate已有request可被同指令修改；可信方法请求首次绑定时不得接管另一份原稿。
   await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['page-create-request',owner,fixed.requestId])])
   if((await db.query('select id from teloa_page_create_drafts where owner_id=$1 and request_id=$2',[owner,fixed.requestId])).rows.length)throw new WorkError('teloa/conflict','此请求已有其它创建草稿，请核对原稿。')
   const draft=await this.ports.drafts.createInTransaction(db,{ownerId:owner,scopeIds:[]},{entity:fixed.target,body,requestId:fixed.requestId,...fixed.acceptedSource?{origin:fixed.acceptedSource}:{}},signal)
   await db.query('insert into teloa_method_reuse_requests(owner_id,request_id,request_spec,artifact_id,artifact_version,acceptance,draft_id,body_hash,created_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9)',[owner,fixed.requestId,JSON.stringify(fixed),fixed.source.artifactId,fixed.source.version,JSON.stringify(current.acceptance),draft.id,draft.bodyHash,this.identity.now()])
   signal?.throwIfAborted();await db.query('commit');return draft
  }catch(error){await db.query('rollback').catch(()=>{});throw error}finally{db.release()}
 }
 /** 草稿续改复用同一事务与原认可来源；只提升草稿正文摘要，不改成果/来源/认可记录。 */
 async reviseDraftInTransaction(db:PoolClient,owner:string,draft:PageCreateDraft,body:unknown,bodyHash:string,signal?:AbortSignal,restoring=false):Promise<void>{
  ownerValue(owner)
  const row=(await db.query('select * from teloa_method_reuse_requests where owner_id=$1 and draft_id=$2 for update',[owner,draft.id])).rows[0]
  if(!row)return
  const fixed=this.input(row.request_spec),checked=await this.verify(db,owner,fixed,signal)
  if(row.body_hash!==draft.bodyHash||draft.requestId!==fixed.requestId||draft.entity!==fixed.target||!isDeepStrictEqual(row.acceptance,checked.acceptance))throw stale()
  if(fixed.target==='plan'){const plan=readPageCreatePlanDraft(body);if('kind'in plan||!isDeepStrictEqual(plan.source,fixed.source)||plan.intent!=='save-paused')throw denied()}
  signal?.throwIfAborted()
  if(restoring){if(row.body_hash!==bodyHash)throw stale();return}
  await db.query('update teloa_method_reuse_requests set body_hash=$3 where owner_id=$1 and draft_id=$2',[owner,draft.id,bodyHash])
 }
 /** 采用前复核；非方法来源草稿回null，不把普通配置草稿冒称认可成果。 */
 async assertDraftCurrent(owner:string,input:{draftId:string;bodyHash:string},signal?:AbortSignal):Promise<MethodReuseDraftAuthority|null>{
  ownerValue(owner);if(!uuid(input.draftId)||!/^[a-f0-9]{64}$/.test(input.bodyHash))throw invalid()
  const db=await this.pool.connect()
  try{
   await db.query('begin');const row=(await db.query('select * from teloa_method_reuse_requests where owner_id=$1 and draft_id=$2',[owner,input.draftId])).rows[0]
   if(!row){await db.query('commit');return null}
   const fixed=this.input(row.request_spec),checked=await this.verify(db,owner,fixed,signal),draft=await this.ports.drafts.draftInTransaction(db,owner,input.draftId)
   if(row.body_hash!==input.bodyHash||draft.bodyHash!==input.bodyHash||draft.requestId!==fixed.requestId||draft.entity!==fixed.target||!isDeepStrictEqual(row.acceptance,checked.acceptance))throw stale()
   const intent=fixed.target==='plan'?readPageCreatePlanDraft(JSON.parse(draft.body)).intent:'save-paused'
   if(intent==='create-and-enable'&&checked.intent!=='create-and-enable')throw stale()
   const authority:MethodReuseDraftAuthority={source:fixed.source,target:fixed.target,intent,...checked.acceptance.kind==='message'?{acceptedSource:checked.acceptance.source}:{}}
   signal?.throwIfAborted();await db.query('commit');return authority
  }catch(error){await db.query('rollback').catch(()=>{});throw error}finally{db.release()}
 }
}

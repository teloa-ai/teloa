import {initializeArtifactRevisionRequests,isArtifactRevisionProducer} from './artifact-revision-requests.ts'
import {readStoredTaskRun,type TaskRun} from './task-runs.ts'
import {workRequestChildId} from './conversation-work-task-protection.ts'
import {createHash} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import type {WorkAccessLease} from './work-access.ts'
import type {Pool,PoolClient} from 'pg'
import {artifactInput,artifactContent,savedArtifactSource,artifactFileTotalBytes,WorkError,type SavedArtifactSource,type SavedArtifactVersion,type ArtifactContent,type RoleArtifactSummary} from '@teloa/contract'
import {BusinessScopeService} from './business-scopes.ts'
import {ArtifactMessageStore,initializeArtifactMessages} from './artifact-messages.ts'
import {ArtifactSnapshotStore} from './artifact-snapshots.ts'
import {taskArtifactSource} from './artifact-task-source.ts'
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
const sourceKey=(source:SavedArtifactSource)=>JSON.stringify([source.kind,source.id,source.scope,source.objectType??''])
const ownerInput=(owner:string)=>{if(typeof owner!=='string'||!owner.trim()||owner.length>128)throw new WorkError('teloa/forbidden','需要有效的本人身份。')}
export async function initializeArtifacts(pool:Pool){await initializeArtifactMessages(pool);await pool.query(`
 create table if not exists teloa_artifacts (id uuid primary key,owner_id text not null,request_id uuid not null,request_spec jsonb not null,source_key text not null,current_version integer not null check(current_version>=0),unique(owner_id,request_id),unique(owner_id,id));
 create table if not exists teloa_artifact_versions (owner_id text not null,artifact_id uuid not null,number integer not null check(number>0),source jsonb not null,content jsonb not null,created_at timestamptz not null,primary key(owner_id,artifact_id,number),foreign key(owner_id,artifact_id) references teloa_artifacts(owner_id,id));
 create table if not exists teloa_artifact_files (owner_id text not null,artifact_id uuid not null,number integer not null,snapshot_id text not null,primary key(owner_id,artifact_id,number,snapshot_id),foreign key(owner_id,artifact_id,number) references teloa_artifact_versions(owner_id,artifact_id,number),foreign key(owner_id,snapshot_id) references teloa_artifact_snapshots(owner_id,snapshot_id));
 create table if not exists teloa_artifact_messages (owner_id text not null,artifact_id uuid not null,number integer not null,snapshot_id text not null,primary key(owner_id,artifact_id,number,snapshot_id),foreign key(owner_id,artifact_id,number) references teloa_artifact_versions(owner_id,artifact_id,number),foreign key(owner_id,snapshot_id) references teloa_artifact_message_snapshots(owner_id,snapshot_id));
`);await initializeArtifactRevisionRequests(pool) }
type SourceResolver=(owner:string,expected:SavedArtifactSource,client:PoolClient)=>Promise<{source:SavedArtifactSource;sessionIds:readonly string[]}>
function read(row:Record<string,unknown>):SavedArtifactVersion{
 try{
  if(!uuid(row.artifact_id)||typeof row.owner_id!=='string'||!row.owner_id||!Number.isSafeInteger(row.number)||(row.number as number)<1||!(row.created_at instanceof Date)||!Number.isFinite(row.created_at.getTime()))throw Error()
  return {artifactId:row.artifact_id,ownerId:row.owner_id,number:row.number as number,source:savedArtifactSource(row.source),content:artifactContent(row.content),createdAt:row.created_at.toISOString()}
 }catch{throw new WorkError('teloa/storage-corrupt','成果版本记录损坏，已停止读取。')}
}
export class ArtifactService{
 readonly pool:Pool;readonly identity:{id:()=>string;now:()=>string};readonly resolve:SourceResolver
 constructor(pool:Pool,identity:{id:()=>string;now:()=>string},resolve:SourceResolver){this.pool=pool;this.identity=identity;this.resolve=resolve}
 /** 冷恢复只读原运行已落定的精确回执，不把存在任意成果当作本次已发布。 */
 async ownerRunReceipt(owner:string,expected:TaskRun):Promise<boolean>{
  ownerInput(owner);if(!uuid(expected.id))throw new WorkError('teloa/invalid-input','执行身份不正确。')
  const db=await this.pool.connect()
  try{await db.query('begin isolation level repeatable read read only')
   const stored=(await db.query('select * from teloa_task_runs where owner_id=$1 and id=$2',[owner,expected.id])).rows[0]
   if(!stored)throw new WorkError('teloa/forbidden','原执行不属于本人。')
   const run=readStoredTaskRun(stored)
   const identity=(value:TaskRun)=>[value.id,value.taskId,value.sessionId,value.nativeRequestId,value.inputText,value.executor,value.state,value.evidence,value.stopRequestedAt]
   if(!isDeepStrictEqual(identity(run),identity(expected)))throw new WorkError('teloa/forbidden','成果回执与原执行不一致。')
   if(run.executor?.kind!=='owner'||run.state!=='ended'||run.evidence?.state!=='ended'||run.evidence.reason!=='completed'||run.stopRequestedAt!==null){await db.query('commit');return false}
   const revision=JSON.parse(run.inputText).artifactRevision
   if(revision){
    const row=(await db.query('select * from teloa_artifact_revision_requests where owner_id=$1 and id=$2',[owner,revision.requestId])).rows[0]
    if(!row||row.state!=='completed'){await db.query('commit');return false}
    if(row.task_id!==run.taskId||row.run_id!==run.id||row.artifact_id!==revision.artifactId||row.base_version!==revision.baseVersion||row.section_id!==revision.sectionId||row.produced_version!==revision.baseVersion+1)throw new WorkError('teloa/storage-corrupt','原修订与成果回执不一致。')
    const saved=await this.readVersion(db,owner,row.artifact_id,row.produced_version),base=await this.readVersion(db,owner,row.artifact_id,row.base_version)
    if(!await isArtifactRevisionProducer(db,owner,run.taskId,saved)||!isDeepStrictEqual(saved.source,base.source)||saved.content.sections.find(section=>section.id===revision.sectionId)?.text!==row.candidate_text)throw new WorkError('teloa/storage-corrupt','原修订成果与生产回执不一致。')
   }else{
    const row=(await db.query('select * from teloa_artifacts where owner_id=$1 and request_id=$2',[owner,workRequestChildId(run.id,'owner-artifact')])).rows[0]
    if(!row){await db.query('commit');return false}
    const saved=await this.readVersion(db,owner,row.id,1)
    if(row.current_version<1||row.source_key!==sourceKey(saved.source)||saved.source.kind!=='task'||saved.source.id!==run.taskId||!isDeepStrictEqual(row.request_spec,{source:saved.source,content:saved.content}))throw new WorkError('teloa/storage-corrupt','原成果与创建回执不一致。')
   }
   await db.query('commit');return true
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
 private async validate(client:PoolClient,owner:string,expected:SavedArtifactSource,content:ArtifactContent){
  const resolved=await this.resolve(owner,expected,client),source=savedArtifactSource(resolved.source)
  if(JSON.stringify(source)!==JSON.stringify(expected))throw new WorkError('teloa/version-conflict','成果来源已变化，请核对当前来源后保存。')
  let textLength=0;const messages=new Set<string>()
  for(const id of content.messageSnapshotIds??[]){const message=await new ArtifactMessageStore(client).read(owner,id);if(!resolved.sessionIds.includes(message.sessionId))throw new WorkError('teloa/forbidden','原消息不属于成果来源会话。');const key=JSON.stringify([message.sessionId,message.messageId,message.seq]);if(messages.has(key))throw new WorkError('teloa/invalid-input','同一原消息不能重复引用。');messages.add(key);textLength+=message.text.length}
  if(textLength>64000)throw new WorkError('teloa/invalid-input','原消息正文总量超过限制。')
  let bytes=0;const files=new Set<string>()
  for(const id of content.snapshotIds){const file=await new ArtifactSnapshotStore(client).read(owner,id);if(!resolved.sessionIds.includes(file.sessionId))throw new WorkError('teloa/forbidden','文件不属于该成果允许的来源会话。');const key=JSON.stringify([file.sessionId,file.id]);if(files.has(key))throw new WorkError('teloa/invalid-input','同一成果版本不能重复引用同一文件。');files.add(key);bytes+=file.bytes}
  if(bytes>artifactFileTotalBytes)throw new WorkError('teloa/invalid-input','成果文件总量超过32 MiB。')
 }
 private async append(client:PoolClient,owner:string,id:string,number:number,source:SavedArtifactSource,content:ArtifactContent){
  const result=await client.query('insert into teloa_artifact_versions(owner_id,artifact_id,number,source,content,created_at) values($1,$2,$3,$4,$5,$6) returning *',[owner,id,number,JSON.stringify(source),JSON.stringify(content),this.identity.now()])
  for(const snapshot of content.snapshotIds)await client.query('insert into teloa_artifact_files values($1,$2,$3,$4)',[owner,id,number,snapshot])
  for(const snapshot of content.messageSnapshotIds??[])await client.query('insert into teloa_artifact_messages values($1,$2,$3,$4)',[owner,id,number,snapshot])
  await client.query('update teloa_artifacts set current_version=$3 where owner_id=$1 and id=$2',[owner,id,number])
  return read(result.rows[0])
 }
 private createInput(owner:string,input:unknown){
  ownerInput(owner);const row=artifactInput(input,['requestId','source','content']),source=savedArtifactSource(row.source),content=artifactContent(row.content)
  if(!uuid(row.requestId))throw new WorkError('teloa/invalid-input','成果创建请求身份不正确。')
  if(content.feedbackId)throw new WorkError('teloa/invalid-input','成果初版不能引用其他版本的反馈。')
  return {requestId:row.requestId as string,source,content,spec:JSON.stringify({source,content})}
 }
 /**
  * 在调用方已经打开的事务里定版：不 begin、不 commit、不 rollback，成败随调用方的事务一起去留。
  * 群内运行结束时宿主代本人定版走这条路，让成果与员工消息写在同一个事务里，被拒时不留孤儿版本。
  */
 async createInTransaction(client:PoolClient,owner:string,input:unknown):Promise<SavedArtifactVersion>{
  const row=this.createInput(owner,input),{source,content,spec}=row
  await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['artifact',owner,row.requestId])])
  const existing=await client.query('select *,request_spec=$3::jsonb as same_request from teloa_artifacts where owner_id=$1 and request_id=$2',[owner,row.requestId,spec])
  if(existing.rows[0]){if(!existing.rows[0].same_request)throw new WorkError('teloa/conflict','原请求已保存另一份成果。');const first=await this.readVersion(client,owner,existing.rows[0].id,1);if(JSON.stringify({source:first.source,content:first.content})!==spec)throw new WorkError('teloa/storage-corrupt','成果初版与创建回执不一致。');return first}
  await this.validate(client,owner,source,content);const id=this.identity.id()
  await client.query('insert into teloa_artifacts values($1,$2,$3,$4,$5,0)',[id,owner,row.requestId,spec,sourceKey(source)])
  return this.append(client,owner,id,1,source,content)
 }
 async create(owner:string,input:unknown):Promise<SavedArtifactVersion>{
  // 入参不对不占连接：校验留在取连接之前，与本次变更之前逐字同序。
  this.createInput(owner,input)
  const client=await this.pool.connect()
  try{await client.query('begin');const result=await this.createInTransaction(client,owner,input);await client.query('commit');return result}
  catch(error){await client.query('rollback');throw error}finally{client.release()}
 }
 async revise(owner:string,input:unknown):Promise<SavedArtifactVersion>{
  ownerInput(owner);const row=artifactInput(input,['artifactId','expectedVersion','source','content']),source=savedArtifactSource(row.source),content=artifactContent(row.content)
  if(!uuid(row.artifactId)||!Number.isSafeInteger(row.expectedVersion)||(row.expectedVersion as number)<1)throw new WorkError('teloa/invalid-input','成果身份或修改版本不正确。')
  const base=row.expectedVersion as number,client=await this.pool.connect()
  try{await client.query('begin');const heads=await client.query('select * from teloa_artifacts where owner_id=$1 and id=$2 for update',[owner,row.artifactId]),head=heads.rows[0]
   if(!head)throw new WorkError('teloa/forbidden','成果不存在或不属于本人。')
   if(head.current_version>base){const saved=await this.readVersion(client,owner,row.artifactId,base+1);if(JSON.stringify(saved.source)!==JSON.stringify(source)||JSON.stringify(saved.content)!==JSON.stringify(content))throw new WorkError('teloa/version-conflict','该版本已保存不同修改，请核对新版本。');await client.query('commit');return saved}
   if(head.current_version!==base||head.source_key!==sourceKey(source))throw new WorkError('teloa/version-conflict','成果版本或来源身份不一致。')
   const previous=await this.readVersion(client,owner,row.artifactId,base)
   if(content.feedbackId){const feedback=await client.query('select * from teloa_artifact_feedback where owner_id=$1 and id=$2',[owner,content.feedbackId]),ref=feedback.rows[0];if(!ref||ref.artifact_id!==row.artifactId||ref.version!==base||!content.sections.some(section=>section.id===ref.section_id&&section.text!==previous.content.sections.find(old=>old.id===ref.section_id)?.text))throw new WorkError('teloa/invalid-input','反馈必须属于正在修订的原版本和已修改段落。')}
   if(JSON.stringify(previous.content)===JSON.stringify(content))throw new WorkError('teloa/conflict','成果内容未变化。')
   await this.validate(client,owner,source,content)
   const result=await this.append(client,owner,row.artifactId,base+1,source,content);await client.query('commit');return result
  }catch(error){await client.query('rollback');throw error}finally{client.release()}
 }
 /** 宿主专用：本人明确的后续工作可以修订终态来源，普通 revise 的来源写禁令保持。 */
 async reviseFromRequest(owner:string,input:{revisionId:string;runId:string;text:string},authorize:(db:PoolClient,runId:string)=>Promise<WorkAccessLease>):Promise<{applied:boolean;artifactId:string;version:number;candidateText?:string}>{
  ownerInput(owner);artifactInput(input,['revisionId','runId','text'])
  if(!uuid(input.revisionId)||!uuid(input.runId)||typeof input.text!=='string'||!input.text.trim()||input.text.length>16000)throw new WorkError('teloa/invalid-input','成果续改的候选正文或身份不正确。')
  const db=await this.pool.connect()
  try{await db.query('begin')
   const request=(await db.query('select * from teloa_artifact_revision_requests where owner_id=$1 and id=$2 for update',[owner,input.revisionId])).rows[0]
   if(!request||!request.task_id)throw new WorkError('teloa/forbidden','修订尚未绑定本人的后续工作。')
   if(request.state==='completed'||request.state==='conflict'){
    if(request.run_id!==input.runId||request.candidate_text!==input.text)throw new WorkError('teloa/conflict','原修订已经记录其他候选。')
    if(request.state==='completed'){
     const saved=await this.readVersion(db,owner,request.artifact_id,request.produced_version)
     if(!await isArtifactRevisionProducer(db,owner,request.task_id,saved)||saved.content.sections.find(section=>section.id===request.section_id)?.text!==input.text)throw new WorkError('teloa/storage-corrupt','原修订成果与生产回执不一致。')
    }
    await db.query('commit');return {applied:request.state==='completed',artifactId:request.artifact_id,version:request.produced_version??request.base_version,...(request.state==='conflict'?{candidateText:request.candidate_text}:{})}
   }
   const stored=(await db.query('select * from teloa_task_runs where owner_id=$1 and id=$2 for share',[owner,input.runId])).rows[0]
   if(!stored)throw new WorkError('teloa/forbidden','修订的原生运行不存在。')
   const run=readStoredTaskRun(stored),fixed=JSON.parse(run.inputText).artifactRevision
   if(run.taskId!==request.task_id||run.executor?.kind!=='owner'||run.executor.grantId!==request.source_request_id||run.state!=='ended'||run.evidence?.state!=='ended'||run.evidence.reason!=='completed'||run.stopRequestedAt!==null||fixed?.requestId!==request.id||fixed.artifactId!==request.artifact_id||fixed.baseVersion!==request.base_version||fixed.sectionId!==request.section_id)throw new WorkError('teloa/forbidden','候选不是这次固定反馈工作的成功结果。')
   const admission=await authorize(db,run.id)
   const head=(await db.query('select * from teloa_artifacts where owner_id=$1 and id=$2 for update',[owner,request.artifact_id])).rows[0]
   const base=await this.readVersion(db,owner,request.artifact_id,request.base_version)
   const feedback=(await db.query('select * from teloa_artifact_feedback where owner_id=$1 and id=$2',[owner,request.feedback_id])).rows[0]
   if(!head||!feedback||feedback.artifact_id!==base.artifactId||feedback.version!==base.number||feedback.section_id!==request.section_id||feedback.body!==fixed.feedback||base.content.sections.find(section=>section.id===request.section_id)?.text!==fixed.originalText||head.source_key!==sourceKey(base.source))throw new WorkError('teloa/storage-corrupt','原成果、反馈与固定修订输入不一致。')
   admission.assertCurrent()
   if(head.current_version!==request.base_version||base.content.sections.find(section=>section.id===request.section_id)?.text===input.text){
    await db.query("update teloa_artifact_revision_requests set state='conflict',run_id=$3,candidate_text=$4 where owner_id=$1 and id=$2",[owner,request.id,run.id,input.text]);await db.query('commit')
    return {applied:false,artifactId:base.artifactId,version:base.number,candidateText:input.text}
   }
   const content=artifactContent({...base.content,sections:base.content.sections.map(section=>section.id===request.section_id?{...section,text:input.text}:section),feedbackId:request.feedback_id,note:'根据本人反馈由 AI 修订指定段落'})
   const saved=await this.append(db,owner,base.artifactId,base.number+1,base.source,content)
   await db.query('insert into teloa_artifact_revision_producers values($1,$2,$3,$4,$5,$6,$7)',[owner,base.artifactId,saved.number,request.id,run.taskId,run.id,stored.task_state_version+1])
   await db.query("update teloa_artifact_revision_requests set state='completed',run_id=$3,produced_version=$4,candidate_text=$5 where owner_id=$1 and id=$2",[owner,request.id,run.id,saved.number,input.text])
   admission.assertCurrent();await db.query('commit');return {applied:true,artifactId:base.artifactId,version:saved.number}
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
 async readVersion(db:Pick<Pool,'query'>,owner:string,id:string,number:number){
  const rows=await db.query('select * from teloa_artifact_versions where owner_id=$1 and artifact_id=$2 and number=$3',[owner,id,number])
  if(!rows.rows[0])throw new WorkError('teloa/storage-corrupt','成果版本缺失。')
  const version=read(rows.rows[0]),links=await db.query('select snapshot_id from teloa_artifact_files where owner_id=$1 and artifact_id=$2 and number=$3 order by snapshot_id',[owner,id,number])
  if(JSON.stringify(links.rows.map(row=>row.snapshot_id))!==JSON.stringify([...version.content.snapshotIds].sort()))throw new WorkError('teloa/storage-corrupt','成果文件引用与版本记录不一致。')
  for(const snapshot of version.content.snapshotIds)await new ArtifactSnapshotStore(db).read(owner,snapshot)
  const messageLinks=await db.query('select snapshot_id from teloa_artifact_messages where owner_id=$1 and artifact_id=$2 and number=$3 order by snapshot_id',[owner,id,number])
  if(JSON.stringify(messageLinks.rows.map(row=>row.snapshot_id))!==JSON.stringify([...(version.content.messageSnapshotIds??[])].sort()))throw new WorkError('teloa/storage-corrupt','成果消息引用与版本记录不一致。')
  for(const snapshot of version.content.messageSnapshotIds??[])await new ArtifactMessageStore(db).read(owner,snapshot)
  if(version.content.feedbackId){const feedback=await db.query('select artifact_id,version,section_id from teloa_artifact_feedback where owner_id=$1 and id=$2',[owner,version.content.feedbackId]),ref=feedback.rows[0];if(!ref||ref.artifact_id!==id||ref.version!==number-1||!version.content.sections.some(section=>section.id===ref.section_id))throw new WorkError('teloa/storage-corrupt','成果修订的反馈关联损坏。')}
  return version
 }
 async list(owner:string,input:unknown):Promise<SavedArtifactVersion[]>{
  ownerInput(owner);const row=artifactInput(input,['artifactId']);if(!uuid(row.artifactId))throw new WorkError('teloa/invalid-input','成果身份不正确。')
  const client=await this.pool.connect()
  try{
  await client.query('begin isolation level repeatable read read only')
  const head=await client.query('select current_version,source_key from teloa_artifacts where owner_id=$1 and id=$2',[owner,row.artifactId]);if(!head.rows[0])throw new WorkError('teloa/forbidden','成果不存在或不属于本人。')
  const count=head.rows[0].current_version;if(!Number.isSafeInteger(count)||count<1)throw new WorkError('teloa/storage-corrupt','成果版本总数损坏。')
  const result:SavedArtifactVersion[]=[]
  const total=await client.query('select count(*)::integer as count from teloa_artifact_versions where owner_id=$1 and artifact_id=$2',[owner,row.artifactId]);if(total.rows[0].count!==count)throw new WorkError('teloa/storage-corrupt','成果版本数量与目录不一致。')
  for(let number=1;number<=count;number++){const version=await this.readVersion(client,owner,row.artifactId,number);if(sourceKey(version.source)!==head.rows[0].source_key)throw new WorkError('teloa/storage-corrupt','成果历史来源不一致。');result.push(version)}
  await client.query('commit')
  return result
  }catch(error){await client.query('rollback');throw error}finally{client.release()}
 }
 /**
  * GRP-02：把「以文本完成」的角色运行结果保存为当前任务版本的正式成果版本。
  * 只在结项面读取任务成果时按需生成（`listTask` 入口），不需要新增宿主装配：
  * 只认真实结束且 reason=completed 的角色运行；失败/取消/空文本/非角色运行一律不生成；
  * 成果来源取任务来源（含任务版本与更新时间），因此结项下拉的「当前任务版本」过滤可直接命中；
  * 正文摘要 sha256、来源会话、运行、任务版本写进版本说明，供本人核对；
  * requestId 由运行身份确定性派生，重复读取/并发读取不产生重复版本。
  */
 async materializeTextRunResult(owner:string,taskId:string,runId?:string):Promise<SavedArtifactVersion|null>{
  ownerInput(owner)
  if(!uuid(taskId)||runId!==undefined&&!uuid(runId))throw new WorkError('teloa/invalid-input','任务或运行身份不正确。')
  const client=await this.pool.connect()
  try{
   await client.query('begin')
   const taskRow=(await client.query('select * from teloa_tasks where owner_id=$1 and id=$2 for share',[owner,taskId])).rows[0]
   if(!taskRow)throw new WorkError('teloa/forbidden','任务不存在或不属于本人。')
   if(taskRow.state!=='waiting'){await client.query('commit');return null}
   const params:unknown[]=runId===undefined?[owner,taskId]:[owner,taskId,runId]
   const run=(await client.query("select id,task_id,role_id,session_id,state,evidence,stop_requested_at from teloa_task_runs where owner_id=$1 and task_id=$2 and role_id is not null and state='ended' and evidence->>'state'='ended' and evidence->>'reason'='completed' and stop_requested_at is null"+(runId===undefined?'':' and id=$3')+' order by created_at desc limit 1',params)).rows[0]
   if(!run)throw new WorkError('teloa/conflict','本轮没有可保存为成果的已完成角色运行。')
   if(taskRow.assignee_role_id!==run.role_id){await client.query('commit');return null}
   const message=(await client.query('select text,id from teloa_group_messages where owner_id=$1 and run_id=$2 and author_id<>\'self\' order by created_at desc,id desc limit 1',[owner,run.id])).rows[0]
   const text=typeof message?.text==='string'?message.text.trim():''
   if(!text){await client.query('commit');return null}
   const source=await taskArtifactSource(client,owner,taskId,true)
   const digest=createHash('sha256').update(text).digest('hex')
   const definition=taskRow.definition&&typeof taskRow.definition==='object'?taskRow.definition as Record<string,unknown>:{}
   const title=typeof definition.title==='string'?definition.title:'本轮结果'
   const content=artifactContent({title,sections:[{id:'run-result',title:'本轮结果正文',text:text.slice(0,16000)}],snapshotIds:[],note:`本轮运行最终文本 · 来源运行 ${run.id} · 会话 ${run.session_id} · 任务 v${taskRow.version} · 正文摘要 sha256 ${digest}`})
   const saved=await this.createInTransaction(client,owner,{requestId:workRequestChildId(run.id,'run-result-artifact'),source,content})
   await client.query('commit')
   return saved
  }catch(error){await client.query('rollback');throw error}finally{client.release()}
 }
 async listSource(owner:string,source:SavedArtifactSource):Promise<SavedArtifactVersion[]>{
  ownerInput(owner);const key=sourceKey(savedArtifactSource(source))
  const rows=await this.pool.query('select v.*,h.source_key from teloa_artifacts h left join teloa_artifact_versions v on v.owner_id=h.owner_id and v.artifact_id=h.id and v.number=h.current_version where h.owner_id=$1 and h.source_key=$2 order by v.created_at desc,h.id',[owner,key])
  return rows.rows.map(row=>{const version=read(row);if(sourceKey(version.source)!==key)throw new WorkError('teloa/storage-corrupt','成果目录与来源不一致。');return version})
 }
 /** 原归属保持；后续任务只通过持久生产回执取得指定版本。 */
 async listTask(owner:string,source:SavedArtifactSource):Promise<(SavedArtifactVersion&{producer?:{taskId:string;taskVersion:number;runId:string}})[]>{
  if(source.kind!=='task')throw new WorkError('teloa/invalid-input','需要任务来源。')
  // GRP-02：结项面读取任务成果时，把已完成角色运行的最终文本按需定版；失败不阻断目录读取（本人仍能看到已有成果）。
  {try{await this.materializeTextRunResult(owner,source.id)}catch{/* 生成失败不阻断只读目录；结项面仍给出可操作说明。 */}}
  const own=await this.listSource(owner,source)
  const produced=await this.pool.query('select * from teloa_artifact_revision_producers where owner_id=$1 and task_id=$2 order by artifact_id,number',[owner,source.id])
  const rows:(SavedArtifactVersion&{producer?:{taskId:string;taskVersion:number;runId:string}})[]=[...own]
  for(const receipt of produced.rows){
   const version=await this.readVersion(this.pool,owner,receipt.artifact_id,receipt.number)
   if(!await isArtifactRevisionProducer(this.pool,owner,source.id,version,receipt.task_version))throw new WorkError('teloa/storage-corrupt','后续工作成果缺少可信生产回执。')
   if(rows.some(row=>row.artifactId===version.artifactId))throw new WorkError('teloa/storage-corrupt','后续工作成果目录重复。')
   rows.push({...version,producer:{taskId:source.id,taskVersion:receipt.task_version,runId:receipt.run_id}})
  }
  return rows
 }
 /**
  * 员工工作成果目录（只读引用）：每条成果只列当前版本元数据，按更新时间倒序，最多 50 条。
  * 归属按真实记录依次判定，先命中的规则即为结论，多员工参与或无法确定的不归入任何员工：
  * run：任一版本的生产回执所属 Run 由员工执行（本人 Run 不计），且恰好只有一位员工；
  * task：任务来源，该任务全部 Run 的执行者（本人也算一方）恰好只有该员工；没有任何 Run 时取任务指派；
  * session：会话来源，该会话恰好一条有效的员工对象会话链接。
  * 结果再按本人当前可查看的业务范围过滤，失去权限的业务成果不出现在目录里。
  */
 async listByRole(owner:string,roleId:string):Promise<RoleArtifactSummary[]>{
  ownerInput(owner);if(!uuid(roleId))throw new WorkError('teloa/invalid-input','员工身份不正确。')
  if(!(await this.pool.query('select 1 from teloa_roles where owner_id=$1 and id=$2',[owner,roleId])).rows[0])throw new WorkError('teloa/forbidden','员工不存在或不属于本人。')
  const rows=(await this.pool.query(`select * from (
   select h.id as artifact_id,h.current_version as number,cv.source,cv.content->>'title' as title,fv.created_at,cv.created_at as updated_at,
    case
     when produced.roles is not null then case when produced.roles=array[$2::uuid] then 'run' end
     when cv.source->>'kind'='task' then case when runs.total>0 then case when runs.executors=array[$2::text] then 'task' end when t.assignee_role_id=$2::uuid then 'task' end
     when cv.source->>'kind'='session' then case when links.roles=array[$2::uuid] then 'session' end
    end as attribution
   from teloa_artifacts h
   join teloa_artifact_versions cv on cv.owner_id=h.owner_id and cv.artifact_id=h.id and cv.number=h.current_version
   join teloa_artifact_versions fv on fv.owner_id=h.owner_id and fv.artifact_id=h.id and fv.number=1
   left join lateral (select array_agg(distinct r.role_id) as roles from teloa_artifact_revision_producers p join teloa_task_runs r on r.owner_id=p.owner_id and r.id=p.run_id where p.owner_id=h.owner_id and p.artifact_id=h.id and r.role_id is not null) produced on true
   left join lateral (select count(*)::integer as total,array_agg(distinct coalesce(r.role_id::text,'owner')) as executors from teloa_task_runs r where cv.source->>'kind'='task' and r.owner_id=h.owner_id and r.task_id::text=cv.source->>'id') runs on true
   left join teloa_tasks t on cv.source->>'kind'='task' and t.owner_id=h.owner_id and t.id::text=cv.source->>'id'
   left join lateral (select array_agg(c.object_id) as roles from teloa_object_conversations c where cv.source->>'kind'='session' and c.owner_id=h.owner_id and c.session_id=cv.source->>'id' and c.kind='role' and c.active=true) links on true
   where h.owner_id=$1
  ) attributed where attribution is not null order by updated_at desc,artifact_id limit 50`,[owner,roleId])).rows
  const items=rows.map(row=>{
   if(!uuid(row.artifact_id)||!Number.isSafeInteger(row.number)||row.number<1||typeof row.title!=='string'||!(row.created_at instanceof Date)||!(row.updated_at instanceof Date))throw new WorkError('teloa/storage-corrupt','员工成果目录记录损坏。')
   let source:SavedArtifactSource;try{source=savedArtifactSource(row.source)}catch{throw new WorkError('teloa/storage-corrupt','员工成果来源记录损坏。')}
   return {artifactId:row.artifact_id as string,number:row.number as number,title:row.title,source,createdAt:row.created_at.toISOString(),updatedAt:row.updated_at.toISOString(),attribution:row.attribution as RoleArtifactSummary['attribution']}
  })
  // 与会话成果目录同一业务范围校验：本人当前无权读取的业务成果直接不列，不让整份目录失败。
  const scopes=new BusinessScopeService(this.pool),allowed=new Set<string>()
  for(const scope of new Set(items.map(item=>item.source.scope)))if((await scopes.attentionScopes(owner,{scope})).scopeIds.includes(scope))allowed.add(scope)
  return items.filter(item=>allowed.has(item.source.scope))
 }
}

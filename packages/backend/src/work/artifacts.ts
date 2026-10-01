import type {Pool,PoolClient} from 'pg'
import {artifactInput,artifactContent,savedArtifactSource,artifactFileTotalBytes,WorkError,type SavedArtifactSource,type SavedArtifactVersion,type ArtifactContent} from '@teloa/contract'
import {ArtifactMessageStore,initializeArtifactMessages} from './artifact-messages.ts'
import {ArtifactSnapshotStore} from './artifact-snapshots.ts'
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
const sourceKey=(source:SavedArtifactSource)=>JSON.stringify([source.kind,source.id,source.scope,source.objectType??''])
const ownerInput=(owner:string)=>{if(typeof owner!=='string'||!owner.trim()||owner.length>128)throw new WorkError('teloa/forbidden','需要有效的本人身份。')}
export async function initializeArtifacts(pool:Pool){await initializeArtifactMessages(pool);await pool.query(`
 create table if not exists teloa_artifacts (id uuid primary key,owner_id text not null,request_id uuid not null,request_spec jsonb not null,source_key text not null,current_version integer not null check(current_version>=0),unique(owner_id,request_id),unique(owner_id,id));
 create table if not exists teloa_artifact_versions (owner_id text not null,artifact_id uuid not null,number integer not null check(number>0),source jsonb not null,content jsonb not null,created_at timestamptz not null,primary key(owner_id,artifact_id,number),foreign key(owner_id,artifact_id) references teloa_artifacts(owner_id,id));
 create table if not exists teloa_artifact_files (owner_id text not null,artifact_id uuid not null,number integer not null,snapshot_id text not null,primary key(owner_id,artifact_id,number,snapshot_id),foreign key(owner_id,artifact_id,number) references teloa_artifact_versions(owner_id,artifact_id,number),foreign key(owner_id,snapshot_id) references teloa_artifact_snapshots(owner_id,snapshot_id));
 create table if not exists teloa_artifact_messages (owner_id text not null,artifact_id uuid not null,number integer not null,snapshot_id text not null,primary key(owner_id,artifact_id,number,snapshot_id),foreign key(owner_id,artifact_id,number) references teloa_artifact_versions(owner_id,artifact_id,number),foreign key(owner_id,snapshot_id) references teloa_artifact_message_snapshots(owner_id,snapshot_id));
`) }
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
 async listSource(owner:string,source:SavedArtifactSource):Promise<SavedArtifactVersion[]>{
  ownerInput(owner);const key=sourceKey(savedArtifactSource(source))
  const rows=await this.pool.query('select v.*,h.source_key from teloa_artifacts h left join teloa_artifact_versions v on v.owner_id=h.owner_id and v.artifact_id=h.id and v.number=h.current_version where h.owner_id=$1 and h.source_key=$2 order by v.created_at desc,h.id',[owner,key])
  return rows.rows.map(row=>{const version=read(row);if(sourceKey(version.source)!==key)throw new WorkError('teloa/storage-corrupt','成果目录与来源不一致。');return version})
 }
}

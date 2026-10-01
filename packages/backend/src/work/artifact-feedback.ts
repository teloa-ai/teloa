import type {Pool} from 'pg'
import {artifactInput,artifactContent,savedArtifactSource,savedArtifactFeedback,WorkError,type SavedArtifactFeedback} from '@teloa/contract'
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
const ownerInput=(owner:string)=>{if(typeof owner!=='string'||!owner.trim()||owner.length>128)throw new WorkError('teloa/forbidden','需要有效本人身份。')}
export async function initializeArtifactFeedback(pool:Pool){await pool.query(`create table if not exists teloa_artifact_feedback (
 id uuid primary key,owner_id text not null,artifact_id uuid not null,version integer not null,section_id text not null,body text not null,
 request_id uuid not null,request_spec jsonb not null,created_at timestamptz not null,
 unique(owner_id,request_id),foreign key(owner_id,artifact_id,version) references teloa_artifact_versions(owner_id,artifact_id,number)
)`)}
function read(row:Record<string,unknown>):SavedArtifactFeedback{
 try{if(!(row.created_at instanceof Date))throw Error();const result=savedArtifactFeedback({id:row.id,ownerId:row.owner_id,artifactId:row.artifact_id,version:row.version,sectionId:row.section_id,text:row.body,createdAt:row.created_at.toISOString()});if(!artifactContent(row.content).sections.some(section=>section.id===result.sectionId))throw Error();return result}
 catch{throw new WorkError('teloa/storage-corrupt','成果反馈或其段落关联损坏。')}
}
const joined='select f.*,v.content from teloa_artifact_feedback f left join teloa_artifact_versions v on v.owner_id=f.owner_id and v.artifact_id=f.artifact_id and v.number=f.version'
export class ArtifactFeedbackService{
 readonly pool:Pool;readonly identity:{id:()=>string;now:()=>string}
 constructor(pool:Pool,identity:{id:()=>string;now:()=>string}){this.pool=pool;this.identity=identity}
 async add(owner:string,input:unknown):Promise<SavedArtifactFeedback>{
  ownerInput(owner);const row=artifactInput(input,['requestId','artifactId','version','sectionId','text','source']),source=savedArtifactSource(row.source)
  if(!uuid(row.requestId)||!uuid(row.artifactId)||!Number.isSafeInteger(row.version)||(row.version as number)<1||typeof row.sectionId!=='string'||!row.sectionId.trim()||row.sectionId.length>240||typeof row.text!=='string'||!row.text.trim()||row.text.length>4000)throw new WorkError('teloa/invalid-input','成果反馈参数不正确。')
  const spec=JSON.stringify({...row,source,text:row.text.trim()}),client=await this.pool.connect()
  try{await client.query('begin');await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['artifact-feedback',owner,row.requestId])])
   const old=await client.query(joined+' where f.owner_id=$1 and f.request_id=$2',[owner,row.requestId])
   if(old.rows[0]){const same=await client.query('select request_spec=$3::jsonb as same from teloa_artifact_feedback where owner_id=$1 and request_id=$2',[owner,row.requestId,spec]);if(!same.rows[0].same)throw new WorkError('teloa/conflict','该请求已保存不同反馈。');const result=read(old.rows[0]);await client.query('commit');return result}
   const version=await client.query('select * from teloa_artifact_versions where owner_id=$1 and artifact_id=$2 and number=$3',[owner,row.artifactId,row.version])
   if(!version.rows[0])throw new WorkError('teloa/forbidden','反馈目标不存在或不属于本人。')
   if(JSON.stringify(savedArtifactSource(version.rows[0].source))!==JSON.stringify(source))throw new WorkError('teloa/invalid-input','反馈来源与指定成果版本不一致。')
   const content=artifactContent(version.rows[0].content);if(!content.sections.some(section=>section.id===row.sectionId))throw new WorkError('teloa/invalid-input','指定版本没有此段落。')
   const created=await client.query('insert into teloa_artifact_feedback(id,owner_id,artifact_id,version,section_id,body,request_id,request_spec,created_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *',[this.identity.id(),owner,row.artifactId,row.version,row.sectionId,row.text.trim(),row.requestId,spec,this.identity.now()])
   const result=read({...created.rows[0],content});await client.query('commit');return result
  }catch(error){await client.query('rollback');throw error}finally{client.release()}
 }
 async list(owner:string,input:unknown):Promise<SavedArtifactFeedback[]>{
  ownerInput(owner);const row=artifactInput(input,['artifactId']);if(!uuid(row.artifactId))throw new WorkError('teloa/invalid-input','成果身份不正确。')
  const head=await this.pool.query('select id from teloa_artifacts where owner_id=$1 and id=$2',[owner,row.artifactId]);if(!head.rows[0])throw new WorkError('teloa/forbidden','成果不属于当前本人。')
  const rows=await this.pool.query(joined+' where f.owner_id=$1 and f.artifact_id=$2 order by f.created_at,f.id',[owner,row.artifactId]);return rows.rows.map(read)
 }
}

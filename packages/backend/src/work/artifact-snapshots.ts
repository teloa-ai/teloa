import {createHash} from 'node:crypto'
import type {Pool} from 'pg'
import {isArtifactFile,WorkError,type ArtifactFile} from '@teloa/contract'
const digest=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex')
const keys=['schema','sessionId','id','path','sha256','bytes','capturedAt','contentBase64']
function checked(value:unknown):ArtifactFile{
 if(!isArtifactFile(value)||Object.keys(value).some(key=>!keys.includes(key)))throw Error('快照格式无效')
 const bytes=Buffer.from(value.contentBase64,'base64')
 if(bytes.length!==value.bytes||bytes.toString('base64')!==value.contentBase64||digest(bytes)!==value.sha256)throw Error('快照字节校验失败')
 return {schema:value.schema,sessionId:value.sessionId,id:value.id,path:value.path,sha256:value.sha256,bytes:value.bytes,capturedAt:value.capturedAt,contentBase64:value.contentBase64}
}
const identity=(file:ArtifactFile)=>digest(JSON.stringify(file))
function ownerInput(owner:string){if(typeof owner!=='string'||!owner.trim()||owner.length>128)throw new WorkError('teloa/forbidden','缺少有效的本人身份。')}
export async function initializeArtifactSnapshots(pool:Pool){await pool.query(`create table if not exists teloa_artifact_snapshots (
 owner_id text not null,snapshot_id text not null check(snapshot_id ~ '^[a-f0-9]{64}$'),
 content jsonb not null check(jsonb_typeof(content)='object'),primary key(owner_id,snapshot_id)
)`)}
/** 内部快照存储，不提供任意客户端上传入口；来源由宿主读取或成果服务核验。 */
export class ArtifactSnapshotStore{
 readonly pool:Pick<Pool,'query'>
 constructor(pool:Pick<Pool,'query'>){this.pool=pool}
 async save(owner:string,input:unknown):Promise<string>{
  ownerInput(owner)
  let file:ArtifactFile
  try{file=checked(input)}catch{throw new WorkError('teloa/invalid-input','文件快照格式或内容摘要不正确，未保存。')}
  const id=identity(file)
  await this.pool.query('insert into teloa_artifact_snapshots(owner_id,snapshot_id,content) values($1,$2,$3) on conflict(owner_id,snapshot_id) do nothing',[owner,id,JSON.stringify(file)])
  // 冲突不能视作已成功：仍须校验存量记录，避免损坏行掩盖失败。
  await this.read(owner,id)
  return id
 }
 async read(owner:string,id:string):Promise<ArtifactFile>{
  ownerInput(owner)
  if(typeof id!=='string'||!/^[a-f0-9]{64}$/.test(id))throw new WorkError('teloa/invalid-input','快照身份无效。')
  const result=await this.pool.query('select content from teloa_artifact_snapshots where owner_id=$1 and snapshot_id=$2',[owner,id])
  if(!result.rows[0])throw new WorkError('teloa/forbidden','快照不存在或不属于当前本人。')
  try{const file=checked(result.rows[0].content);if(identity(file)!==id)throw Error();return file}
  catch{throw new WorkError('teloa/storage-corrupt','文件快照已损坏，停止预览和下载，请核对记录。')}
 }
}

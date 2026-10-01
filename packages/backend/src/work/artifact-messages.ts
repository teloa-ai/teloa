import {createHash} from 'node:crypto'
import type {Pool} from 'pg'
import {savedArtifactMessage,WorkError,type SavedArtifactMessage} from '@teloa/contract'
const identity=(message:SavedArtifactMessage)=>createHash('sha256').update(JSON.stringify(message)).digest('hex')
function ownerInput(owner:string){if(typeof owner!=='string'||!owner.trim()||owner.length>128)throw new WorkError('teloa/forbidden','缺少有效的本人身份。')}
export async function initializeArtifactMessages(pool:Pool){await pool.query(`create table if not exists teloa_artifact_message_snapshots (
 owner_id text not null,snapshot_id text not null check(snapshot_id ~ '^[a-f0-9]{64}$'),content jsonb not null check(jsonb_typeof(content)='object'),primary key(owner_id,snapshot_id)
)`)}
/** 内部存储：调用方必须先从可信会话历史核对消息，不能直接保存客户端声明。 */
export class ArtifactMessageStore{
 readonly pool:Pick<Pool,'query'>
 constructor(pool:Pick<Pool,'query'>){this.pool=pool}
 async save(owner:string,value:unknown):Promise<string>{
  ownerInput(owner);const message=savedArtifactMessage(value),id=identity(message)
  await this.pool.query('insert into teloa_artifact_message_snapshots(owner_id,snapshot_id,content) values($1,$2,$3) on conflict(owner_id,snapshot_id) do nothing',[owner,id,JSON.stringify(message)])
  await this.read(owner,id);return id
 }
 async read(owner:string,id:string):Promise<SavedArtifactMessage>{
  ownerInput(owner);if(typeof id!=='string'||!/^[a-f0-9]{64}$/.test(id))throw new WorkError('teloa/invalid-input','消息快照身份无效。')
  const result=await this.pool.query('select content from teloa_artifact_message_snapshots where owner_id=$1 and snapshot_id=$2',[owner,id])
  if(!result.rows[0])throw new WorkError('teloa/forbidden','消息快照不存在或不属于当前本人。')
  try{const message=savedArtifactMessage(result.rows[0].content);if(identity(message)!==id)throw Error();return message}
  catch{throw new WorkError('teloa/storage-corrupt','原消息快照损坏，请核对记录。')}
 }
}

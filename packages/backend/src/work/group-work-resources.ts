import type {PoolClient} from 'pg'
import {WorkError,groupDefinition,isWorkResource,type MessageReference,type WorkResource} from '@teloa/contract'

/** 群消息只固定原知识身份，不复制正文、不授予员工执行许可。与群及资料撤回写口共用行锁。 */
export async function readActiveGroupWorkResource(db:PoolClient,owner:string,groupId:string,reference:MessageReference):Promise<WorkResource>{
 const invisible=()=>new WorkError('teloa/forbidden','引用的原件不存在、已撤回或不属于当前本人。')
 const row=(await db.query(`select r.*,g.definition group_definition from teloa_resources r join teloa_groups g on g.owner_id=r.owner_id and g.id=$3
  where r.owner_id=$1 and r.id=$2 for share of r,g`,[owner,reference.id,groupId])).rows[0]
 if(!row)throw invisible()
 let scope:string,value:WorkResource
 try{
  scope=groupDefinition(row.group_definition).scope
  value={...row.spec,id:row.id,ownerId:row.owner_id,version:row.revision,status:row.status,createdAt:row.created_at.toISOString(),updatedAt:row.updated_at.toISOString()}
  if(!isWorkResource(value))throw Error()
 }catch{throw new WorkError('teloa/storage-corrupt','群引用的工作资料固定身份损坏。')}
 if(value.ownerId!==owner||value.status!=='active'||value.version!==reference.version||!value.scopeIds.every(allowed=>allowed===scope))throw invisible()
 return value
}

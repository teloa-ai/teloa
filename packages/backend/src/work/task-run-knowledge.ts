import {createHash} from 'node:crypto'
import {WorkError,taskInput,isResourceSpec,promptFullTextMaxBytes,resourceId,resourceVersion,type ResourceContext} from '@teloa/contract'
export type RunKnowledge=ResourceContext['contents'][number]
export function readRunKnowledge(value:unknown):RunKnowledge[]{
 try{
  if(!Array.isArray(value)||value.length>8)throw Error()
  let bytes=0
  const rows=value.map(item=>{
   const r=taskInput(item,['id','version','title','sourceId','sourceVersion','scopeIds','text'])
   const spec={title:r.title,sourceId:r.sourceId,sourceVersion:r.sourceVersion,scopeIds:r.scopeIds}
   if(!isResourceSpec(spec)||!resourceId(r.id)||!resourceVersion(r.version)||typeof r.text!=='string'||createHash('sha256').update(r.text).digest('hex')!==r.sourceVersion)throw Error()
   bytes+=Buffer.byteLength(r.text);if(bytes>promptFullTextMaxBytes)throw Error()
   return {title:spec.title,sourceId:spec.sourceId,sourceVersion:spec.sourceVersion,scopeIds:[...spec.scopeIds].sort(),id:r.id,version:r.version,text:r.text}
  })
  if(new Set(rows.map(row=>row.id)).size!==rows.length)throw Error()
  return rows
 }catch{throw new WorkError('teloa/storage-corrupt','执行知识资料快照损坏或来源摘要不一致。')}
}

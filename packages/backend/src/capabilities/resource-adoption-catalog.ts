import {createHash} from 'node:crypto'
import type {Pool} from 'pg'
import {isWorkResource,resourceId,resourceScopes,WorkError,type SourceReference,type WorkResource} from '@teloa/contract'
import {authorizeResourceActor,type ResourceSourceCatalog,type ResourceSourceContext} from './resources.ts'

const corrupt=()=>new WorkError('teloa/storage-corrupt','业务资料采用来源记录损坏。')
export const isAdoptedResourceSourceId=(value:string)=>value.startsWith('adopted_')&&resourceId(value.slice(8))
/** 本人显式采用时固定的独立正文；以后只按目标业务授权，不再借用原行业加载的范围。 */
export class ResourceAdoptionCatalog implements ResourceSourceCatalog{
 private readonly pool:Pool
 constructor(pool:Pool){this.pool=pool}
 private info(row:Record<string,unknown>,context:ResourceSourceContext):SourceReference{
  if(typeof row.source_id!=='string'||!isAdoptedResourceSourceId(row.source_id)||typeof row.owner_id!=='string'||typeof row.target_scope!=='string'||row.target_scope==='general'||!resourceScopes([row.target_scope])||!isWorkResource(row.origin)||row.origin.ownerId!==row.owner_id||typeof row.origin_source!=='string'||row.source_version!==row.origin.sourceVersion||!Number.isSafeInteger(row.bytes)||Number(row.bytes)<1||Number(row.bytes)>2*1024*1024)throw corrupt()
  authorizeResourceActor(context.actor,row.owner_id,[row.target_scope])
  if(!context.scopeIds?.includes(row.target_scope))throw new WorkError('teloa/forbidden','当前工作范围无权读取此业务资料。')
  const origin=row.origin as WorkResource
  return {id:row.source_id,title:origin.title,source:`resource:${origin.id}@${origin.version} 来源：${row.origin_source}`,version:origin.sourceVersion,bytes:Number(row.bytes)}
 }
 async list(context?:ResourceSourceContext){
  if(!context)throw new WorkError('teloa/forbidden','业务资料采用来源需要有效主体。')
  authorizeResourceActor(context.actor)
  const scopes=context.actor.scopeIds.filter(scope=>!context.scopeIds||context.scopeIds.includes(scope))
  const rows=(await (context.client??this.pool).query('select source_id,owner_id,target_scope,origin,origin_source,source_version,bytes from teloa_resource_adoptions where owner_id=$1 and target_scope=any($2::text[]) order by created_at,source_id',[context.actor.ownerId,scopes])).rows
  return {schema:'teloa.reference-list/v1' as const,references:rows.map(row=>this.info(row,{...context,scopeIds:context.scopeIds??context.actor.scopeIds}))}
 }
 async read(id:string,version:string,context?:ResourceSourceContext){
  if(!context||!isAdoptedResourceSourceId(id))throw new WorkError('teloa/forbidden','业务资料采用来源需要有效主体。')
  authorizeResourceActor(context.actor)
  const row=(await (context.client??this.pool).query('select * from teloa_resource_adoptions where source_id=$1 and owner_id=$2',[id,context.actor.ownerId])).rows[0] as Record<string,unknown>|undefined
  if(!row)throw new WorkError('teloa/source-unavailable','业务资料采用来源不存在或不可访问。')
  const info=this.info(row,context)
  if(info.version!==version)throw new WorkError('teloa/version-conflict','采用资料的固定来源版本不一致。')
  if(typeof row.content!=='string'||Buffer.byteLength(row.content)!==info.bytes||createHash('sha256').update(row.content).digest('hex')!==info.version)throw corrupt()
  return {schema:'teloa.reference/v1' as const,...info,text:row.content}
 }
 async sizes(refs:readonly {id:string;version:string}[],context:ResourceSourceContext){
  const wanted=new Map(refs.map(ref=>[ref.id,ref.version])),result=new Map<string,number>()
  for(const ref of (await this.list(context)).references)if(wanted.get(ref.id)===ref.version)result.set(ref.id+'@'+ref.version,ref.bytes)
  return result
 }
}

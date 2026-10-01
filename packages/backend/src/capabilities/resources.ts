import type { Pool,PoolClient } from 'pg'
import { ReferenceError,type ReferenceCatalog } from '@teloa/mcp-reference/catalog'
import { WorkError,isRecord,promptFullTextMaxBytes,isResourceSpec,isResourceDraft,isWorkResource,resourceId,resourceScopes,resourceVersion,retrievalLimits,type ResourceSpec,type ResourceDraft,type WorkResource,type ResourceReference,type ResourceDirectory,type MessageResourceSnapshot,type ResourceContext,type SourceReference } from '@teloa/contract'
import { normalizeRetrievalText } from './retrieval-chunker.ts'
export type ResourceActor={ownerId:string;kind:'human'|'agent';scopeIds:string[]}
/** 来源适配器只接收服务端主体；事务内读取复用连接，避免嵌套借用耗尽连接池。 */
export type ResourceSourceContext={actor:ResourceActor;client?:PoolClient;scopeIds?:string[]}
export interface ResourceSourceCatalog {
  list(context?:ResourceSourceContext):Promise<{schema:'teloa.reference-list/v1';references:SourceReference[]}>
  read(id:string,version:string,context?:ResourceSourceContext):ReturnType<ReferenceCatalog['read']>
  /** 可选：不读正文，按来源登记给出字节数，键为 `id@version`；主体无权或版本不符的不给。 */
  sizes?(refs:readonly {id:string;version:string}[],context:ResourceSourceContext):Promise<Map<string,number>>
}
const specKeys=['title','sourceId','sourceVersion','scopeIds']
const badInput=()=>new WorkError('teloa/invalid-input','资源请求格式不正确或包含未知字段。')
const corrupt=()=>new WorkError('teloa/storage-corrupt','资源存储内容不符合合同，已停止读取。')
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b)
const stableId=(v:unknown):v is string=>typeof v==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(v)
/** 整段进模型的资料正文：单份与岗位/任务合计 256 KiB；单条消息引用合计 1 MiB（原 8 份 × 128 KiB 的实际上界）。更大的资料只走本地检索摘录。 */
const fullTextMaxBytes=promptFullTextMaxBytes,messageReferenceMaxBytes=1024*1024
const fullTextTotal={role:'员工资料正文总量过大，请缩小本次资料范围。',task:'任务知识正文总量过大，请缩小本次资料范围。'} as const
const retrievalOnly=(resource:WorkResource,bytes:number,limit:string)=>new WorkError('teloa/invalid-input','资料「'+resource.title+'」有 '+Math.ceil(bytes/1024)+' KiB，超过'+limit+' 256 KiB，只能加入本地检索使用。')
function object(input:unknown,keys:string[]):Record<string,unknown>{if(!isRecord(input)||Object.keys(input).some(key=>!keys.includes(key)))throw badInput();return input}
function spec(input:Record<string,unknown>):ResourceSpec {
  if(!isResourceSpec(input))throw badInput()
  return {title:input.title.trim(),sourceId:input.sourceId,sourceVersion:input.sourceVersion,scopeIds:[...input.scopeIds].sort()}
}
export function authorizeResourceActor(actor:ResourceActor,ownerId=actor.ownerId,scopes:string[]=[],human=false):void {
  if(!actor.ownerId||actor.ownerId!==ownerId||!['human','agent'].includes(actor.kind)||!resourceScopes(actor.scopeIds)||scopes.some(scope=>!actor.scopeIds.includes(scope))||(human&&actor.kind!=='human'))throw new WorkError('teloa/forbidden','当前主体或目标范围无权执行此资源操作。')
}
function validateRoleKnowledge(actor:ResourceActor,targetScopes:string[],ids:readonly string[]):void {
  authorizeResourceActor(actor)
  if(!resourceScopes(targetScopes)||!Array.isArray(ids)||ids.length>8||ids.some(id=>!resourceId(id))||new Set(ids).size!==ids.length)throw badInput()
}
function expected(input:Record<string,unknown>,key:string):{id:string;version:number}{
  if(!resourceId(input[key])||!resourceVersion(input.expectedVersion))throw badInput()
  return {id:input[key],version:input.expectedVersion}
}
/** 检索命中回读的定位：资料身份、版本、正文版本与规范化正文中的半开字符区间。 */
export type RetrievalExcerptHit={resourceId:string;resourceVersion:number;sourceVersion:string;chars:[number,number]}
function excerptHit(input:unknown):RetrievalExcerptHit{
  const row=object(input,['resourceId','resourceVersion','sourceVersion','chars']),chars=row.chars
  if(!resourceId(row.resourceId)||!resourceVersion(row.resourceVersion)||typeof row.sourceVersion!=='string'||!/^[a-f0-9]{64}$/.test(row.sourceVersion)||!Array.isArray(chars)||chars.length!==2||!chars.every(value=>Number.isSafeInteger(value)&&value>=0)||chars[0]>=chars[1])throw badInput()
  return {resourceId:row.resourceId,resourceVersion:row.resourceVersion,sourceVersion:row.sourceVersion,chars:[chars[0],chars[1]]}
}
/** 按 UTF-8 字节截断，不切开码点。 */
function clipBytes(text:string,limit:number):string{
  if(Buffer.byteLength(text,'utf8')<=limit)return text
  let used=0,value=''
  for(const point of text){const size=Buffer.byteLength(point,'utf8');if(used+size>limit)break;used+=size;value+=point}
  return value
}
function stamp(value:unknown):string {if(!(value instanceof Date)||!Number.isFinite(value.getTime()))throw corrupt();return value.toISOString()}
function readSpec(row:Record<string,unknown>):ResourceSpec {if(!isResourceSpec(row.spec))throw corrupt();return spec(row.spec)}
function draftRow(row:Record<string,unknown>):ResourceDraft {
  const value={...readSpec(row),id:row.id,ownerId:row.owner_id,requestId:row.request_id,version:row.revision,status:row.status,createdAt:stamp(row.created_at),updatedAt:stamp(row.updated_at),...(row.resource_id===null?{}:{resourceId:row.resource_id})}
  if(!isResourceDraft(value))throw corrupt();return value
}
function resourceRow(row:Record<string,unknown>):WorkResource {
  const value={...readSpec(row),id:row.id,ownerId:row.owner_id,version:row.revision,status:row.status,createdAt:stamp(row.created_at),updatedAt:stamp(row.updated_at)}
  if(!isWorkResource(value))throw corrupt();return value
}
function snapshotRow(row:Record<string,unknown>):MessageResourceSnapshot {
  if(!resourceId(row.id)||typeof row.owner_id!=='string'||!stableId(row.session_id)||!stableId(row.message_id)||(row.request_id!==null&&!stableId(row.request_id))||!resourceScopes(row.scope_ids)||!Array.isArray(row.refs)||row.refs.length<1||row.refs.length>8||!row.refs.every(ref=>isRecord(ref)&&resourceId(ref.id)&&resourceVersion(ref.version)&&Object.keys(ref).every(k=>['id','version'].includes(k))))throw corrupt()
  return {id:row.id,ownerId:row.owner_id,sessionId:row.session_id,messageId:row.message_id,...(row.request_id===null?{}:{requestId:row.request_id as string}),scopeIds:row.scope_ids,references:row.refs as ResourceReference[],createdAt:stamp(row.created_at)}
}

export class ResourceService {
  private readonly pool:Pool
  private readonly sources:ResourceSourceCatalog
  private readonly identity:{id:()=>string;now:()=>string}
  constructor(pool:Pool,sources:ResourceSourceCatalog,identity:{id:()=>string;now:()=>string}){this.pool=pool;this.sources=sources;this.identity=identity}
  private async tx<T>(operation:(client:PoolClient)=>Promise<T>):Promise<T>{
    const client=await this.pool.connect().catch(()=>{throw new WorkError('teloa/storage-unavailable','资源数据库暂不可用。')})
    try{await client.query('begin');const value=await operation(client);await client.query('commit');return value}
    catch(error){await client.query('rollback').catch(()=>{});if(error instanceof WorkError)throw error;throw new WorkError('teloa/storage-unavailable','资源事务未完成，请检查数据库连接与结构。')}
    finally{client.release()}
  }
  private async source(value:ResourceSpec,actor:ResourceActor,client:PoolClient):Promise<string>{
    try{return (await this.sources.read(value.sourceId,value.sourceVersion,{actor,client,scopeIds:value.scopeIds})).text}
    catch(error){if(error instanceof WorkError)throw error;if(error instanceof ReferenceError&&error.code==='reference/version-conflict')throw new WorkError('teloa/version-conflict','来源内容已变化，请核对新版本后重新提交资料。');throw new WorkError('teloa/source-unavailable','资料来源当前不可读取。')}
  }
  async sourceDirectory(actor:ResourceActor){authorizeResourceActor(actor);try{return (await this.sources.list({actor})).references}catch(error){if(error instanceof WorkError)throw error;throw new WorkError('teloa/source-unavailable','受控资料来源当前不可读取。')}}
  async create(actor:ResourceActor,input:unknown):Promise<ResourceDraft>{
    const data=object(input,['requestId',...specKeys]),value=spec(data)
    if(!resourceId(data.requestId))throw badInput()
    authorizeResourceActor(actor,actor.ownerId,value.scopeIds)
    return this.tx(async client=>{
      await client.query(`insert into teloa_resource_drafts(id,owner_id,request_id,request_spec,spec,revision,status,created_at,updated_at) values($1,$2,$3,$4,$4,1,'draft',$5,$5) on conflict(owner_id,request_id) do nothing`,[this.identity.id(),actor.ownerId,data.requestId,JSON.stringify(value),this.identity.now()])
      const row=(await client.query('select * from teloa_resource_drafts where owner_id=$1 and request_id=$2 for update',[actor.ownerId,data.requestId])).rows[0] as Record<string,unknown>
      if(!isResourceSpec(row.request_spec))throw corrupt()
      if(!same(spec(row.request_spec),value))throw new WorkError('teloa/conflict','同一请求 ID 不能创建另一份资源草案。')
      return draftRow(row)
    })
  }
  private async draft(client:PoolClient,actor:ResourceActor,id:string):Promise<{draft:ResourceDraft;appliedVersion:unknown}>{
    const row=(await client.query('select * from teloa_resource_drafts where id=$1 for update',[id])).rows[0] as Record<string,unknown>|undefined
    if(!row)throw new WorkError('teloa/not-found','资源草案不存在。')
    const draft=draftRow(row);authorizeResourceActor(actor,draft.ownerId,draft.scopeIds)
    return {draft,appliedVersion:row.applied_version}
  }
  private async resource(client:PoolClient,actor:ResourceActor,id:string,lock:'share'|'update'='share'):Promise<WorkResource>{
    const row=(await client.query('select * from teloa_resources where id=$1 for '+lock,[id])).rows[0] as Record<string,unknown>|undefined
    if(!row)throw new WorkError('teloa/not-found','工作资料不存在。')
    const resource=resourceRow(row);authorizeResourceActor(actor,resource.ownerId,resource.scopeIds);return resource
  }
  async update(actor:ResourceActor,input:unknown):Promise<ResourceDraft>{
    const data=object(input,['draftId','expectedVersion',...specKeys]),{id,version}=expected(data,'draftId'),value=spec(data)
    authorizeResourceActor(actor,actor.ownerId,value.scopeIds)
    return this.tx(async client=>{
      const {draft}=await this.draft(client,actor,id)
      if(draft.version!==version||draft.status!=='draft')throw new WorkError('teloa/version-conflict','草案已变化或已提交，请重新读取。')
      const row=(await client.query('update teloa_resource_drafts set spec=$2,revision=revision+1,updated_at=$3 where id=$1 returning *',[id,JSON.stringify(value),this.identity.now()])).rows[0]
      return draftRow(row)
    })
  }
  async apply(actor:ResourceActor,input:unknown):Promise<WorkResource>{
    const data=object(input,['draftId','expectedVersion']),{id,version}=expected(data,'draftId');authorizeResourceActor(actor,actor.ownerId,[],true)
    return this.tx(async client=>{
      const {draft,appliedVersion}=await this.draft(client,actor,id)
      if(draft.status==='applied'){
        if(appliedVersion!==version)throw new WorkError('teloa/version-conflict','提交版本与已应用的草案不一致。')
        return this.resource(client,actor,draft.resourceId!)
      }
      if(draft.version!==version)throw new WorkError('teloa/version-conflict','草案已变化，请核对后提交。')
      await this.source(draft,actor,client)
      const value=spec(draft),resourceId=this.identity.id(),now=this.identity.now()
      const row=(await client.query(`insert into teloa_resources(id,owner_id,revision,status,spec,created_at,updated_at) values($1,$2,1,'active',$3,$4,$4) returning *`,[resourceId,actor.ownerId,JSON.stringify(value),now])).rows[0]
      await client.query(`update teloa_resource_drafts set status='applied',resource_id=$2,applied_version=revision,revision=revision+1,updated_at=$3 where id=$1`,[id,resourceId,now])
      return resourceRow(row)
    })
  }
  async withdraw(actor:ResourceActor,input:unknown):Promise<WorkResource>{
    const data=object(input,['resourceId','expectedVersion']),{id,version}=expected(data,'resourceId');authorizeResourceActor(actor,actor.ownerId,[],true)
    return this.tx(async client=>{
      const resource=await this.resource(client,actor,id,'update')
      if(resource.status==='withdrawn'&&resource.version===version+1)return resource
      if(resource.version!==version||resource.status!=='active')throw new WorkError('teloa/version-conflict','资料状态已变化，请重新读取。')
      return resourceRow((await client.query(`update teloa_resources set status='withdrawn',revision=revision+1,updated_at=$2 where id=$1 returning *`,[id,this.identity.now()])).rows[0])
    })
  }
  /** 知识版本与可引用投影共用外层事务；调用者必须先固定知识版本。 */
  async replaceKnowledgeProjectionInTransaction(client:PoolClient,actor:ResourceActor,input:{resourceId:string;expectedVersion:number;expectedSourceId:string;expectedSourceVersion:string;nextSourceVersion:string;title:string;scopeIds:string[]}):Promise<WorkResource>{
    authorizeResourceActor(actor,actor.ownerId,[],true)
    if(!resourceId(input.resourceId)||!resourceVersion(input.expectedVersion)||!stableId(input.expectedSourceId)||!isResourceSpec({title:input.title,sourceId:input.expectedSourceId,sourceVersion:input.nextSourceVersion,scopeIds:input.scopeIds})||!isResourceSpec({title:input.title,sourceId:input.expectedSourceId,sourceVersion:input.expectedSourceVersion,scopeIds:input.scopeIds}))throw badInput()
    const current=await this.resource(client,actor,input.resourceId,'update')
    if(current.status!=='active'||current.version!==input.expectedVersion)throw new WorkError('teloa/version-conflict','可引用知识版本已变化，请重新读取后编辑。')
    if(current.sourceId!==input.expectedSourceId||current.sourceVersion!==input.expectedSourceVersion||current.title!==input.title||!same(current.scopeIds,[...input.scopeIds].sort()))throw new WorkError('teloa/version-conflict','可引用知识与当前正文版本不一致，请重新读取后编辑。')
    const nextSpec=spec({title:input.title,sourceId:input.expectedSourceId,sourceVersion:input.nextSourceVersion,scopeIds:input.scopeIds}),nextId=this.identity.id(),now=this.identity.now()
    if(!resourceId(nextId)||!Number.isFinite(Date.parse(now)))throw corrupt()
    const next=resourceRow((await client.query(`insert into teloa_resources(id,owner_id,revision,status,spec,created_at,updated_at) values($1,$2,1,'active',$3,$4,$4) returning *`,[nextId,actor.ownerId,JSON.stringify(nextSpec),now])).rows[0])
    await client.query(`update teloa_resources set status='withdrawn',revision=revision+1,updated_at=$2 where id=$1`,[current.id,now])
    return next
  }
  /** 幂等重试返回当时的 active 快照；后续修订可已将它撤回。 */
  async recoverKnowledgeProjectionInTransaction(client:PoolClient,actor:ResourceActor,snapshot:WorkResource):Promise<WorkResource>{
    if(!isWorkResource(snapshot)||snapshot.status!=='active')throw corrupt()
    const current=await this.resource(client,actor,snapshot.id)
    const sameIdentity=current.ownerId===snapshot.ownerId&&current.title===snapshot.title&&current.sourceId===snapshot.sourceId&&current.sourceVersion===snapshot.sourceVersion&&same(current.scopeIds,snapshot.scopeIds)&&current.createdAt===snapshot.createdAt
    const validState=(current.status==='active'&&current.version===snapshot.version)||(current.status==='withdrawn'&&current.version===snapshot.version+1)
    if(!sameIdentity||!validState)throw corrupt()
    return snapshot
  }
  async list(actor:ResourceActor):Promise<ResourceDirectory>{
    authorizeResourceActor(actor)
    return this.tx(async client=>({
      drafts:(await client.query('select * from teloa_resource_drafts where owner_id=$1 order by created_at desc,id',[actor.ownerId])).rows.map(draftRow).filter(row=>row.scopeIds.every(scope=>actor.scopeIds.includes(scope))),
      resources:(await client.query('select * from teloa_resources where owner_id=$1 order by created_at desc,id',[actor.ownerId])).rows.map(resourceRow).filter(row=>row.scopeIds.every(scope=>actor.scopeIds.includes(scope))),
    }))
  }
  async findDraft(actor:ResourceActor,input:unknown):Promise<ResourceDraft|null>{
    authorizeResourceActor(actor);const data=object(input,['requestId']);if(!resourceId(data.requestId))throw badInput()
    const row=(await this.pool.query('select * from teloa_resource_drafts where owner_id=$1 and request_id=$2',[actor.ownerId,data.requestId])).rows[0] as Record<string,unknown>|undefined
    if(!row)return null
    const draft=draftRow(row);authorizeResourceActor(actor,draft.ownerId,draft.scopeIds);return draft
  }
  async getResource(actor:ResourceActor,input:unknown):Promise<WorkResource>{
    authorizeResourceActor(actor);const data=object(input,['resourceId']);if(!resourceId(data.resourceId))throw badInput()
    return this.tx(client=>this.resource(client,actor,data.resourceId as string))
  }
  /** 按来源登记的字节数给出资料体积（资源 ID → 字节），不读正文；来源不登记字节数的资料不在结果里。 */
  async fullTextBytes(actor:ResourceActor,resources:readonly WorkResource[]):Promise<Map<string,number>>{
    authorizeResourceActor(actor)
    const result=new Map<string,number>()
    if(!this.sources.sizes||!resources.length)return result
    const sizes=await this.sources.sizes(resources.map(resource=>({id:resource.sourceId,version:resource.sourceVersion})),{actor,scopeIds:actor.scopeIds})
    for(const resource of resources){const size=sizes.get(resource.sourceId+'@'+resource.sourceVersion);if(size!==undefined)result.set(resource.id,size)}
    return result
  }
  /**
   * 保存岗位资料或任务知识前的体积预检：单份与合计都不能超过整段进提示词的上限，文案与执行准备一致。
   * 只看来源登记的字节数、不读正文；格式不对、不属于本人或不存在的资料不在这里判断（岗位定义本就允许先存），执行准备时仍按原规则拒绝。
   */
  async checkFullTextBudget(actor:ResourceActor,ids:readonly string[],kind:'role'|'task'):Promise<void>{
    authorizeResourceActor(actor)
    if(!Array.isArray(ids)||ids.some(id=>typeof id!=='string'))throw badInput()
    const unique=[...new Set(ids.filter(id=>resourceId(id)).map(id=>id.toLowerCase()))]
    if(!unique.length||!this.sources.sizes)return
    const rows=await this.tx(async client=>(await client.query('select * from teloa_resources where owner_id=$1 and id=any($2::uuid[])',[actor.ownerId,unique])).rows.map(resourceRow))
    const resources=unique.flatMap(id=>rows.filter(row=>row.id===id)),sizes=await this.fullTextBytes(actor,resources)
    let bytes=0
    for(const resource of resources){
      const size=sizes.get(resource.id)
      if(size===undefined)continue
      if(size>fullTextMaxBytes)throw retrievalOnly(resource,size,'员工/任务全文上限')
      bytes+=size
    }
    if(bytes>fullTextMaxBytes)throw new WorkError('teloa/invalid-input',fullTextTotal[kind])
  }
  /** 工具授权只需岗位资料的来源与版本：与执行准备同样核对本人、范围与启用状态，但不读正文，超大资料不连累授权页。 */
  async executionKnowledgeReferences(actor:ResourceActor,targetScopes:string[],ids:readonly string[]):Promise<WorkResource[]>{
    validateRoleKnowledge(actor,targetScopes,ids)
    return this.tx(client=>this.executionKnowledgeRoleReferencesInTransaction(client,actor,targetScopes,ids))
  }
  async executionKnowledgeRoleReferencesInTransaction(client:PoolClient,actor:ResourceActor,targetScopes:string[],ids:readonly string[]):Promise<WorkResource[]>{
    validateRoleKnowledge(actor,targetScopes,ids)
      const resources=new Map<string,WorkResource>()
      for(const id of [...ids].sort()){
        const resource=await this.resource(client,actor,id)
        if(!resource.scopeIds.every(scope=>targetScopes.includes(scope)))throw new WorkError('teloa/forbidden','目标执行范围无权使用此员工资料。')
        if(resource.status!=='active')throw new WorkError('teloa/resource-withdrawn','员工资料已撤回，请重新选择。')
        resources.set(id,resource)
      }
      return ids.map(id=>resources.get(id)!)
  }
  /** 岗位执行准备读取：只接受资源身份，不创建虚构消息或复用消息审计快照。 */
  async executionKnowledge(actor:ResourceActor,targetScopes:string[],ids:readonly string[],signal?:AbortSignal):Promise<ResourceContext['contents']>{
    validateRoleKnowledge(actor,targetScopes,ids)
    signal?.throwIfAborted()
    return this.tx(client=>this.executionKnowledgeInTransaction(client,actor,targetScopes,ids,signal))
  }
  /** Run 准备已持有事务连接时，岗位资料必须在同一连接内读取。 */
  async executionKnowledgeInTransaction(client:PoolClient,actor:ResourceActor,targetScopes:string[],ids:readonly string[],signal?:AbortSignal):Promise<ResourceContext['contents']>{
    validateRoleKnowledge(actor,targetScopes,ids)
    signal?.throwIfAborted()
      const contents:ResourceContext['contents']=[]
      let bytes=0
      // 固定锁顺序，多个岗位以不同顺序引用相同资料时也不形成反向锁链。
      const resources=new Map<string,WorkResource>()
      for(const id of [...ids].sort()){
        signal?.throwIfAborted()
        const resource=await this.resource(client,actor,id)
        if(!resource.scopeIds.every(scope=>targetScopes.includes(scope)))throw new WorkError('teloa/forbidden','目标执行范围无权使用此员工资料。')
        if(resource.status!=='active')throw new WorkError('teloa/resource-withdrawn','员工资料已撤回，请重新选择。')
        resources.set(id,resource)
      }
      for(const id of ids){
        signal?.throwIfAborted()
        const resource=resources.get(id)!,text=await this.source(resource,actor,client)
        const size=Buffer.byteLength(text,'utf8')
        if(size>fullTextMaxBytes)throw retrievalOnly(resource,size,'员工/任务全文上限')
        bytes+=size
        if(bytes>fullTextMaxBytes)throw new WorkError('teloa/invalid-input',fullTextTotal.role)
        contents.push({...spec(resource),id:resource.id,version:resource.version,text})
      }
      signal?.throwIfAborted()
      return contents
  }
  /** 任务执行准备复用外层事务，并在读取正文的同一事务中核对固定资源版本。 */
  async executionKnowledgeReferencesInTransaction(client:PoolClient,actor:ResourceActor,targetScopes:string[],references:readonly ResourceReference[],signal?:AbortSignal):Promise<ResourceContext['contents']>{
    authorizeResourceActor(actor)
    if(!resourceScopes(targetScopes)||!Array.isArray(references)||references.length>8||references.some(ref=>!isRecord(ref)||Object.keys(ref).some(key=>!['id','version'].includes(key))||Object.keys(ref).length!==2||!resourceId(ref.id)||!resourceVersion(ref.version))||new Set(references.map(ref=>ref.id)).size!==references.length)throw badInput()
    signal?.throwIfAborted()
    const resources=new Map<string,WorkResource>()
    for(const ref of [...references].sort((left,right)=>left.id.localeCompare(right.id))){
      signal?.throwIfAborted()
      const current=await this.resource(client,actor,ref.id)
      if(!current.scopeIds.every(scope=>targetScopes.includes(scope)))throw new WorkError('teloa/forbidden','目标执行范围无权使用此任务知识。')
      if(current.status!=='active')throw new WorkError('teloa/resource-withdrawn','任务知识已撤回，请重新选择。')
      if(current.version!==ref.version)throw new WorkError('teloa/version-conflict','任务知识固定版本已变化，请重新选择。')
      resources.set(ref.id,current)
    }
    const contents:ResourceContext['contents']=[]
    let bytes=0
    for(const ref of references){
      signal?.throwIfAborted()
      const current=resources.get(ref.id)!,text=await this.source(current,actor,client)
      const size=Buffer.byteLength(text,'utf8')
      if(size>fullTextMaxBytes)throw retrievalOnly(current,size,'员工/任务全文上限')
      bytes+=size
      if(bytes>fullTextMaxBytes)throw new WorkError('teloa/invalid-input',fullTextTotal.task)
      contents.push({...spec(current),id:current.id,version:current.version,text})
    }
    signal?.throwIfAborted()
    return contents
  }
  /** 本地检索建索引：只接受本人主体，读取当前启用版本的正文，单份不超过 2 MiB。 */
  async readForIndexInTransaction(client:PoolClient,actor:ResourceActor,id:string):Promise<{resource:WorkResource;text:string}>{
    authorizeResourceActor(actor,actor.ownerId,[],true)
    if(!resourceId(id))throw badInput()
    const resource=await this.resource(client,actor,id)
    if(resource.status!=='active')throw new WorkError('teloa/resource-withdrawn','资料已撤回，不能加入本地检索。')
    const text=await this.source(resource,actor,client)
    if(Buffer.byteLength(text,'utf8')>retrievalLimits.maxSourceBytes)throw new WorkError('teloa/invalid-input','单份资料正文超过 2 MiB，不能加入本地检索。')
    return {resource,text}
  }
  /**
   * 本地检索命中回读：逐条核对本人、目标范围、启用状态、资料版本与正文版本，按规范化正文区间切片。
   * 只返回有界摘录（单条 2 KiB、合计 16 KiB），不注入整篇资料。
   */
  async readExcerptsInTransaction(client:PoolClient,actor:ResourceActor,targetScopes:string[],hits:readonly unknown[]):Promise<{resource:WorkResource;excerpt:string}[]>{
    authorizeResourceActor(actor)
    if(!resourceScopes(targetScopes)||!Array.isArray(hits)||hits.length>retrievalLimits.maxResults)throw badInput()
    const rows=hits.map(excerptHit),resources=new Map<string,{resource:WorkResource;text:string|null}>()
    for(const id of [...new Set(rows.map(row=>row.resourceId))].sort()){
      const resource=await this.resource(client,actor,id)
      if(!resource.scopeIds.every(scope=>targetScopes.includes(scope)))throw new WorkError('teloa/forbidden','目标范围无权读取此资料。')
      if(resource.status!=='active')throw new WorkError('teloa/resource-withdrawn','资料已撤回，检索结果已失效。')
      resources.set(id,{resource,text:null})
    }
    for(const row of rows){
      const entry=resources.get(row.resourceId)!
      if(entry.resource.version!==row.resourceVersion||entry.resource.sourceVersion!==row.sourceVersion)throw new WorkError('teloa/version-conflict','资料版本已变化，检索结果已失效。')
    }
    const excerpts:{resource:WorkResource;excerpt:string}[]=[]
    let total=0
    for(const row of rows){
      const entry=resources.get(row.resourceId)!
      entry.text??=normalizeRetrievalText(await this.source(entry.resource,actor,client))
      if(row.chars[1]>entry.text.length)throw new WorkError('teloa/storage-corrupt','检索索引区间与资料正文不一致，已停止读取。')
      const excerpt=clipBytes(entry.text.slice(row.chars[0],row.chars[1]),Math.min(retrievalLimits.maxExcerptBytes,retrievalLimits.maxTotalExcerptBytes-total))
      if(!excerpt.trim())break
      total+=Buffer.byteLength(excerpt,'utf8')
      excerpts.push({resource:entry.resource,excerpt})
    }
    return excerpts
  }
  async resolve(actor:ResourceActor,target:{sessionId:string;scopeIds:string[]},input:{messageId:string;requestId?:string;references:ResourceReference[]},signal?:AbortSignal):Promise<ResourceContext>{
    authorizeResourceActor(actor)
    if(!stableId(target.sessionId)||!resourceScopes(target.scopeIds)||!stableId(input.messageId)||(input.requestId!==undefined&&!stableId(input.requestId))||!Array.isArray(input.references)||input.references.length<1||input.references.length>8||!input.references.every(ref=>isRecord(ref)&&resourceId(ref.id)&&resourceVersion(ref.version)&&Object.keys(ref).every(k=>['id','version'].includes(k))))throw badInput()
    const scopes=[...target.scopeIds].sort(),references=input.references.map(ref=>({...ref}))
    authorizeResourceActor(actor,actor.ownerId,scopes)
    const outcome=await this.tx(async client=>{
      await client.query(`insert into teloa_message_snapshots(id,owner_id,session_id,message_id,request_id,scope_ids,refs,created_at) values($1,$2,$3,$4,$5,$6,$7,$8) on conflict(session_id,message_id) do nothing`,[this.identity.id(),actor.ownerId,target.sessionId,input.messageId,input.requestId??null,JSON.stringify(scopes),JSON.stringify(references),this.identity.now()])
      const snapshot=snapshotRow((await client.query('select * from teloa_message_snapshots where session_id=$1 and message_id=$2 for update',[target.sessionId,input.messageId])).rows[0])
      authorizeResourceActor(actor,snapshot.ownerId)
      if(!same(snapshot.references,references)||snapshot.requestId!==input.requestId||!same(snapshot.scopeIds,scopes))throw new WorkError('teloa/snapshot-conflict','同一消息的资料引用身份已变化，不能覆盖历史快照。')
      const contents:ResourceContext['contents']=[]
      let error:WorkError|undefined,bytes=0
      try{
        for(const ref of references){
          signal?.throwIfAborted()
          const resource=await this.resource(client,actor,ref.id)
          if(!resource.scopeIds.every(scope=>scopes.includes(scope)))throw new WorkError('teloa/forbidden','目标会话无权引用此资料范围。')
          if(resource.status==='withdrawn')throw new WorkError('teloa/resource-withdrawn','资料已撤回，请移除该引用或选择其他资料。')
          if(resource.version!==ref.version)throw new WorkError('teloa/version-conflict','引用的资料版本已变化，请重新选择。')
          const text=await this.source(resource,actor,client),size=Buffer.byteLength(text,'utf8')
          if(size>fullTextMaxBytes)throw retrievalOnly(resource,size,'单条消息引用全文上限')
          bytes+=size
          if(bytes>messageReferenceMaxBytes)throw new WorkError('teloa/invalid-input','引用资料正文合计超过 1 MiB，请减少本条消息引用的资料。')
          contents.push({...spec(resource),id:resource.id,version:resource.version,text})
        }
        signal?.throwIfAborted()
      }catch(cause){error=cause instanceof WorkError?cause:new WorkError('teloa/cancelled','资料读取已中止。')}
      await client.query('insert into teloa_resource_reads(id,snapshot_id,outcome,result,created_at) values($1,$2,$3,$4,$5)',[this.identity.id(),snapshot.id,error?'failed':'provided',JSON.stringify(error?{code:error.code,message:error.message}:{contents}),this.identity.now()])
      return error?{error}:{value:{snapshot,contents}}
    })
    if(outcome.error)throw outcome.error
    return outcome.value!
  }
}

import {createHash} from 'node:crypto'
import type {Pool,PoolClient} from 'pg'
import {WorkError} from '@teloa/contract'
import type {ReferenceInfo} from '@teloa/mcp-reference/catalog'
import {validateManifest,type MarketContentStore} from '../market/content-store.ts'
import type {IndustryLoadService} from '../work/industry-loads.ts'
import type {ResourceActor,ResourceSourceCatalog,ResourceSourceContext} from './resources.ts'

const sourcePattern=/^industry_([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})_([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i
const unavailable=(message='行业资料来源当前不可读取。')=>new WorkError('teloa/source-unavailable',message)
const forbidden=()=>new WorkError('teloa/forbidden','当前主体或业务范围无权读取此行业资料。')

export const industryReferenceId=(loadId:string,mappingId:string)=>`industry_${loadId.toLowerCase()}_${mappingId.toLowerCase()}`

export class IndustryReferenceCatalog{
 private readonly pool:Pool
 private readonly market:Pick<MarketContentStore,'getInTransaction'>
 private readonly loads:Pick<IndustryLoadService,'getInTransaction'|'storedItemStatus'>
 constructor(pool:Pool,market:Pick<MarketContentStore,'getInTransaction'>,loads:Pick<IndustryLoadService,'getInTransaction'|'storedItemStatus'>){this.pool=pool;this.market=market;this.loads=loads}
 private actor(context:ResourceSourceContext|undefined):ResourceActor{
  const actor=context?.actor
  if(!actor||!actor.ownerId||!['human','agent'].includes(actor.kind)||!Array.isArray(actor.scopeIds)||!actor.scopeIds.length||actor.scopeIds.some(scope=>typeof scope!=='string'))throw forbidden()
  return actor
 }
 private async client<T>(context:ResourceSourceContext,operation:(client:PoolClient)=>Promise<T>):Promise<T>{
  if(context.client)return operation(context.client)
  const client=await this.pool.connect().catch(()=>{throw new WorkError('teloa/storage-unavailable','行业资料目录数据库暂不可用。')})
  try{await client.query('begin isolation level repeatable read');const result=await operation(client);await client.query('commit');return result}catch(error){await client.query('rollback').catch(()=>{});throw error}finally{client.release()}
 }
 private async resolve(sourceId:string,context:ResourceSourceContext):Promise<ReferenceInfo&{text:string}>{
  const match=sourcePattern.exec(sourceId);if(!match)throw unavailable('行业资料来源身份不存在。')
  const actor=this.actor(context),load=await this.loads.getInTransaction(context.client!,actor.ownerId,{loadId:match[1]})
  if(!actor.scopeIds.includes(load.space.scope)||!context.scopeIds?.includes(load.space.scope))throw forbidden()
  const item=load.items.find(row=>row.instanceId.toLowerCase()===match[2]!.toLowerCase())
  if(!item||item.kind!=='knowledge'||await this.loads.storedItemStatus(context.client!,actor.ownerId,item.instanceId)!=='pending-adapter')throw unavailable('行业资料未加载、种类不符或本次已跳过。')
  const content=await this.market.getInTransaction(context.client!,{ownerId:actor.ownerId,kind:actor.kind},{contentId:load.contentId})
  if(content.kind!=='industry-template'||content.hash!==load.contentHash)throw unavailable('行业资料固定内容与加载记录不一致。')
  const manifest=validateManifest(content.metadata),definition=manifest.resources.find(row=>row.id===item.localId)
  if(!definition||definition.kind!=='knowledge'||definition.version!==item.version||definition.source.kind!=='local')throw unavailable('行业资料定义与加载记录不一致。')
  const root=content.manifestPath.includes('/')?content.manifestPath.slice(0,content.manifestPath.lastIndexOf('/')+1):'',path=root+definition.source.path
  const provided=content.provides.find(row=>row.resourceId===item.localId)
  const file=content.files.find(row=>row.path===path)
  if(!provided||provided.kind!=='knowledge'||provided.version!==item.version||provided.path!==path||!file)throw unavailable('行业资料固定文件不存在或身份不一致。')
  if(file.bytes.byteLength>128*1024)throw unavailable('行业资料正文超过 128 KiB。')
  let text:string;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(file.bytes)}catch{throw unavailable('行业资料正文不是有效 UTF-8。')}
  const version=createHash('sha256').update(file.bytes).digest('hex')
  if(version!==file.hash)throw new WorkError('teloa/storage-corrupt','行业资料固定文件摘要不一致。')
  return {id:sourceId,title:item.title,source:`market:${load.contentId}/${item.localId}`,version,bytes:file.bytes.byteLength,text}
 }
 async read(id:string,version:string,context?:ResourceSourceContext){
  const actor=this.actor(context)
  return this.client({...context!,actor},async client=>{const result=await this.resolve(id,{...context!,actor,client});if(result.version!==version)throw new WorkError('teloa/version-conflict','行业资料来源版本已变化。');return {schema:'teloa.reference/v1' as const,...result}})
 }
 async list(context?:ResourceSourceContext){
  const actor=this.actor(context)
  // 加载按业务范围标签（模板 `scope`）归属，不再按市场行业归类 `domain` 或空间身份拼出的 `space-<id>`：主体带的范围就是可见范围。
  // 范围取值自此与普通业务范围同形，无法再从取值形状判断有没有行业来源，因此改按"行业表在不在"决定是否访问。
  return this.client({...context!,actor},async client=>{
   const names=['teloa_industry_loads','teloa_industry_load_items']
   if((await client.query('select name from unnest($1::text[]) as name where to_regclass(name) is not null',[names])).rows.length!==names.length)return {schema:'teloa.reference-list/v1' as const,references:[]}
   const rows=(await client.query(`select distinct l.id,i.instance_id from teloa_industry_loads l join teloa_industry_load_items i on i.load_id=l.id where l.owner_id=$1 and l.scope=any($2::text[]) and i.kind='knowledge' and i.status='pending-adapter' order by l.id,i.instance_id`,[actor.ownerId,actor.scopeIds])).rows
   const references:ReferenceInfo[]=[]
   for(const row of rows){const sourceId=industryReferenceId(row.id,row.instance_id);try{const result=await this.resolve(sourceId,{actor,client,scopeIds:actor.scopeIds});const {text:_,...info}=result;references.push(info)}catch(error){if(error instanceof WorkError&&error.code==='teloa/forbidden')continue;throw error}}
   return {schema:'teloa.reference-list/v1' as const,references}
  })
 }
}

export function combineReferenceCatalogs(publicCatalog:ResourceSourceCatalog,industryCatalog:ResourceSourceCatalog,markdownCatalog?:ResourceSourceCatalog,localMaterials?:ResourceSourceCatalog):ResourceSourceCatalog{
 return {
  list:async context=>{const rows=await Promise.all([publicCatalog.list(),industryCatalog.list(context),...(markdownCatalog?[markdownCatalog.list(context)]:[]),...(localMaterials?[localMaterials.list(context)]:[])]),references=rows.flatMap(row=>row.references),ids=new Set<string>();for(const row of references){if(ids.has(row.id))throw new WorkError('teloa/storage-corrupt','工作资料来源目录存在重复身份。');ids.add(row.id)}return {schema:'teloa.reference-list/v1',references}},
  read:(id,version,context)=>id.startsWith('local_material_')&&localMaterials?localMaterials.read(id,version,context):id.startsWith('industry_')?industryCatalog.read(id,version,context):id.startsWith('knowledge_')&&markdownCatalog?markdownCatalog.read(id,version,context):publicCatalog.read(id,version,context),
  current:async(id,context)=>{
   if(id.startsWith('local_material_')){if(!localMaterials?.current)throw new WorkError('teloa/unavailable','本机原件的指定来源读取尚未就绪。');return localMaterials.current(id,context)}
   const catalog=id.startsWith('industry_')?industryCatalog:id.startsWith('knowledge_')&&markdownCatalog?markdownCatalog:publicCatalog
   if(catalog.current)return catalog.current(id,context)
   const source=(await catalog.list(context)).references.find(row=>row.id===id)
   if(!source)throw new WorkError('teloa/source-unavailable','资料来源当前不可读取。')
   return source
  },
  // 只有粘贴知识可能超过整段进提示词的上限；公共参考资料与行业资料各自不超过 128 KiB，不登记字节数。
  sizes:async(refs,context)=>{const wanted=refs.filter(ref=>ref.id.startsWith('knowledge_'));return wanted.length&&markdownCatalog?.sizes?await markdownCatalog.sizes(wanted,context):new Map<string,number>()},
 }
}

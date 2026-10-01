import {createHash} from 'node:crypto'
import type {PoolClient} from 'pg'
import {WorkError,readIndustryPluginDefinition,type IndustryPluginDefinition} from '@teloa/contract'
import {validateManifest,type MarketContentStore} from '../market/content-store.ts'
import type {IndustryLoadService} from './industry-loads.ts'

export type IndustryPluginSourceSnapshot={
 loadId:string
 itemInstanceId:string
 itemLocalId:string
 contentId:string
 contentHash:string
 itemVersion:string
 fileHash:string
 definition:IndustryPluginDefinition
}

const unavailable=(message:string)=>new WorkError('teloa/source-unavailable',message)
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)

/**
 * 从已固定的市场内容读取插件声明。调用方不能提供 registry、包名或文件路径，
 * 因而安装只能针对加载时已经审阅并持久化的字节。
 */
export class IndustryPluginSource{
 private readonly market:Pick<MarketContentStore,'getInTransaction'>
 private readonly loads:Pick<IndustryLoadService,'getInTransaction'|'storedItemStatus'>
 constructor(market:Pick<MarketContentStore,'getInTransaction'>,loads:Pick<IndustryLoadService,'getInTransaction'|'storedItemStatus'>){this.market=market;this.loads=loads}

 async read(db:PoolClient,owner:string,input:{loadId:string;itemInstanceId:string}):Promise<IndustryPluginSourceSnapshot>{
  if(!owner||owner.length>128||!uuid(input.loadId)||!uuid(input.itemInstanceId))throw unavailable('行业扩展来源身份不正确。')
  const load=await this.loads.getInTransaction(db,owner,{loadId:input.loadId}),item=load.items.find(candidate=>candidate.instanceId.toLowerCase()===input.itemInstanceId.toLowerCase())
  if(!item||item.kind!=='plugin'||await this.loads.storedItemStatus(db,owner,item.instanceId)!=='pending-adapter')throw unavailable('目标不是可安装的行业扩展。')
  const content=await this.market.getInTransaction(db,{ownerId:owner,kind:'human'},{contentId:load.contentId})
  if(content.ownerId!==owner||content.id.toLowerCase()!==load.contentId.toLowerCase()||content.kind!=='industry-template'||content.hash!==load.contentHash)throw unavailable('扩展固定内容与加载记录不一致。')
  const manifest=validateManifest(content.metadata)
  if(manifest.id!==load.templateId||manifest.version!==load.templateVersion)throw unavailable('扩展所属模板身份或版本不一致。')
  const resource=manifest.resources.find(candidate=>candidate.id===item.localId)
  if(!resource||resource.kind!=='plugin'||resource.version!==item.version)throw unavailable('扩展声明与加载记录不一致。')
  if(resource.source.kind!=='local')throw unavailable('扩展只支持行业模板内的固定本地定义。')
  const root=content.manifestPath.includes('/')?content.manifestPath.slice(0,content.manifestPath.lastIndexOf('/')+1):'',path=root+resource.source.path
  const provided=content.provides.find(candidate=>candidate.resourceId===item.localId),file=content.files.find(candidate=>candidate.path===path)
  if(!provided||provided.kind!=='plugin'||provided.version!==item.version||provided.path!==path||!file||file.bytes.byteLength>128*1024)throw unavailable('扩展文件不存在、过大或身份不一致。')
  const fileHash=createHash('sha256').update(file.bytes).digest('hex')
  if(file.hash!==fileHash)throw unavailable('扩展文件摘要不一致。')
  let raw:string
  try{raw=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(file.bytes)}catch{throw unavailable('扩展定义不是有效 UTF-8。')}
  let parsed:unknown
  try{parsed=JSON.parse(raw)}catch{throw unavailable('扩展定义不是有效 JSON。')}
  let definition:IndustryPluginDefinition
  try{definition=readIndustryPluginDefinition(parsed)}catch{throw unavailable('扩展定义格式、registry 或版本不正确。')}
  return {loadId:load.id,itemInstanceId:item.instanceId,itemLocalId:item.localId,contentId:load.contentId,contentHash:load.contentHash,itemVersion:item.version,fileHash,definition}
 }
}

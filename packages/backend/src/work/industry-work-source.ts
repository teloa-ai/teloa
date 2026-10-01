import {createHash} from 'node:crypto'
import type {PoolClient} from 'pg'
import {WorkError,isRecord,assertIndustryModelsReady,type IndustryModelProbe,localizedMetadata} from '@teloa/contract'
import {validateManifest,type MarketContentStore} from '../market/content-store.ts'
import type {IndustryLoadService} from './industry-loads.ts'

export type IndustryWorkSkill={id:string;title:string;version:string}
export type IndustryWorkSnapshot={loadId:string;itemInstanceId:string;itemLocalId:string;contentId:string;contentHash:string;templateId:string;templateVersion:string;fileHash:string;title:string;method:string;requirements:string[];output:string;skills:IndustryWorkSkill[];scope:string}
const unavailable=(message:string)=>new WorkError('teloa/source-unavailable',message)
const text=(value:unknown,max:number)=>{if(typeof value!=='string'||!value.trim()||value.length>max)throw unavailable('工作模板字段不合法。');return value.trim()}
const semver=(value:unknown):value is string=>typeof value==='string'&&value.length<=80&&/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value)
function validateLocalized(value:unknown,originals:{title:string;description:string;requirements:string[];output:string}):void{
 if(value===undefined)return
 if(!isRecord(value)||Object.keys(value).some(key=>!['title','description','requirements','output'].includes(key)))throw unavailable('工作模板本地化元数据不合法。')
 try{
  for(const field of ['title','description','output'] as const)if(value[field]!==undefined&&localizedMetadata(value[field]).original!==originals[field])throw Error()
  if(value.requirements!==undefined){
   if(!Array.isArray(value.requirements)||value.requirements.length!==originals.requirements.length)throw Error()
   value.requirements.forEach((item,index)=>{if(localizedMetadata(item).original!==originals.requirements[index])throw Error()})
  }
 }catch{throw unavailable('工作模板本地化元数据不合法。')}
}
export class IndustryWorkSource{
 private readonly market:Pick<MarketContentStore,'get'|'getInTransaction'>;private readonly loads:Pick<IndustryLoadService,'get'|'getInTransaction'>
 private readonly models:IndustryModelProbe|undefined
 constructor(market:Pick<MarketContentStore,'get'|'getInTransaction'>,loads:Pick<IndustryLoadService,'get'|'getInTransaction'>,models?:IndustryModelProbe){this.market=market;this.loads=loads;this.models=models}
 /** 运行已有任务只重验其固定版本的模型声明；不把模型检查变成重建任务或追随最新方案。 */
 async assertModelsReady(owner:string,snapshot:IndustryWorkSnapshot,client?:PoolClient):Promise<void>{
  const content=client?await this.market.getInTransaction(client,{ownerId:owner,kind:'human'},{contentId:snapshot.contentId}):await this.market.get({ownerId:owner,kind:'human'},{contentId:snapshot.contentId})
  if(content.kind!=='industry-template'||content.hash!==snapshot.contentHash)throw unavailable('工作模板固定内容与任务来源不一致。')
  const resource=validateManifest(content.metadata).resources.find(row=>row.id===snapshot.itemLocalId)
  if(!resource||resource.kind!=='work-template'||resource.version!==snapshot.templateVersion)throw unavailable('工作模板固定声明与任务来源不一致。')
  await assertIndustryModelsReady(resource.modelDependencies,this.models)
 }
 async read(owner:string,loadId:string,itemInstanceId:string,client?:PoolClient):Promise<IndustryWorkSnapshot>{
  const load=client?await this.loads.getInTransaction(client,owner,{loadId}):await this.loads.get(owner,{loadId}),item=load.items.find(row=>row.instanceId===itemInstanceId)
  if(!item||item.kind!=='work-template'||item.status!=='pending-adapter')throw unavailable('目标不是可使用的行业工作模板。')
  const content=client?await this.market.getInTransaction(client,{ownerId:owner,kind:'human'},{contentId:load.contentId}):await this.market.get({ownerId:owner,kind:'human'},{contentId:load.contentId})
  if(content.kind!=='industry-template'||content.hash!==load.contentHash)throw unavailable('工作模板固定内容与加载记录不一致。')
  const manifest=validateManifest(content.metadata),resource=manifest.resources.find(row=>row.id===item.localId)
  if(!resource||resource.kind!=='work-template'||resource.version!==item.version||resource.source.kind!=='local')throw unavailable('工作模板声明与加载记录不一致。')
  await assertIndustryModelsReady(resource.modelDependencies,this.models)
  const root=content.manifestPath.includes('/')?content.manifestPath.slice(0,content.manifestPath.lastIndexOf('/')+1):'',path=root+resource.source.path,provided=content.provides.find(row=>row.resourceId===item.localId),file=content.files.find(row=>row.path===path)
  if(!provided||provided.kind!=='work-template'||provided.version!==item.version||provided.path!==path||!file||file.bytes.byteLength>128*1024)throw unavailable('工作模板文件不存在、过大或身份不一致。')
  let raw:string;try{raw=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(file.bytes)}catch{throw unavailable('工作模板不是有效 UTF-8。')}
  let parsed:unknown;try{parsed=JSON.parse(raw)}catch{throw unavailable('工作模板不是有效 JSON。')}
  const keys=['format','id','title','version','domain','description','localized','requirements','output','skills']
  if(!isRecord(parsed)||Object.keys(parsed).some(key=>!keys.includes(key))||parsed.format!=='teloa.work-template/v1'||typeof parsed.id!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,119}$/.test(parsed.id)||parsed.id!==item.localId||!semver(parsed.version)||parsed.version!==item.version||parsed.domain!=='general'&&parsed.domain!==load.scope||!Array.isArray(parsed.requirements)||parsed.requirements.length<1||parsed.requirements.length>100||!Array.isArray(parsed.skills)||parsed.skills.length>100)throw unavailable('工作模板格式、版本或业务范围不正确。')
  const title=text(parsed.title,120),method=text(parsed.description,2000),requirements=parsed.requirements.map(value=>text(value,500)),output=text(parsed.output,2000)
  validateLocalized(parsed.localized,{title,description:method,requirements,output})
  const skills=parsed.skills.map(value=>{if(!isRecord(value)||Object.keys(value).some(key=>!['id','title','version'].includes(key))||typeof value.id!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,119}$/.test(value.id)||!semver(value.version))throw unavailable('工作模板技能声明不合法。');return {id:value.id,title:text(value.title,120),version:value.version}})
  return {loadId:load.id,itemInstanceId:item.instanceId,itemLocalId:item.localId,contentId:load.contentId,contentHash:load.contentHash,templateId:parsed.id,templateVersion:parsed.version,fileHash:createHash('sha256').update(file.bytes).digest('hex'),title,method,requirements,output,skills,scope:load.space.scope}
 }
}

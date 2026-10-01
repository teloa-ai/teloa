import {createHash} from 'node:crypto'
import {WorkError,isRecord,assertIndustryModelsReady,type IndustryModelProbe} from '@teloa/contract'
import {validateManifest,marketTrustHash,type MarketContent,type MarketContentStore,type MarketSourceTrust} from './content-store.ts'
import type {IndustryLoadService} from '../work/industry-loads.ts'

export type SkillInstallSourceInput=
 |{kind:'atomic';contentId:string}
 |{kind:'industry';loadId:string;itemInstanceId:string}

type FixedSkill={resourceId:string;resourceVersion:string}
export type SkillInstallSourceIdentity=
 |({kind:'atomic';contentId:string;contentHash:string}&FixedSkill)
 |({kind:'industry-local';loadId:string;itemInstanceId:string;contentId:string;contentHash:string}&FixedSkill)
 |({kind:'industry-public';loadId:string;itemInstanceId:string;contentId:string;contentHash:string;sourceContentId:string;sourceContentHash:string;sourceResourceId:string;sourceResourceVersion:string}&FixedSkill)
export type SkillInstallSourceBundle={ownerId:string;source:SkillInstallSourceIdentity;entryPath:'SKILL.md';files:{path:string;hash:string;bytes:Uint8Array}[];bundleHash:string;trust?:MarketSourceTrust;trustHash?:string}

const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
const exact=(value:unknown,keys:readonly string[])=>{if(!isRecord(value)||Object.keys(value).some(key=>!keys.includes(key)))throw new WorkError('teloa/invalid-input','技能安装来源请求格式不正确。');return value}
const corrupt=()=>new WorkError('teloa/storage-corrupt','技能安装固定来源损坏，已停止读取。')
const digest=(files:readonly {path:string;hash:string}[])=>createHash('sha256').update(JSON.stringify(files.map(file=>[file.path,file.hash]))).digest('hex')
const order=(a:string,b:string)=>a<b?-1:a>b?1:0

function bundle(ownerId:string,content:MarketContent,entry:string,source:SkillInstallSourceIdentity):SkillInstallSourceBundle{
 const slash=entry.lastIndexOf('/'),root=slash<0?'':entry.slice(0,slash+1)
 const files=content.files.filter(file=>file.path.startsWith(root)).map(file=>({path:file.path.slice(root.length),hash:file.hash,bytes:Uint8Array.from(file.bytes)})).sort((a,b)=>order(a.path,b.path))
 if(!files.length||files.filter(file=>file.path==='SKILL.md').length!==1)throw corrupt()
 if(marketTrustHash(content.trust)!==content.trustHash)throw corrupt()
 return {ownerId,source,entryPath:'SKILL.md',files,bundleHash:digest(files),trust:structuredClone(content.trust),trustHash:content.trustHash}
}

function atomic(ownerId:string,content:MarketContent,identity?:Extract<SkillInstallSourceIdentity,{kind:'industry-public'}>):SkillInstallSourceBundle{
 if(content.ownerId!==ownerId||content.kind!=='atomic-skill')throw new WorkError('teloa/source-unavailable','固定技能来源种类或本人身份不一致。')
 const provided=content.provides.filter(item=>item.kind==='skill')
 if(provided.length!==1||provided[0]!.resourceId!==content.logicalId||provided[0]!.version!==content.version||provided[0]!.path!==content.manifestPath)throw corrupt()
 const item=provided[0]!
 return bundle(ownerId,content,item.path,identity??{kind:'atomic',contentId:content.id,contentHash:content.hash,resourceId:item.resourceId,resourceVersion:item.version})
}

export class SkillInstallSource{
 private readonly market:Pick<MarketContentStore,'get'>
 private readonly loads:Pick<IndustryLoadService,'get'>
 private readonly models:IndustryModelProbe|undefined
 constructor(market:Pick<MarketContentStore,'get'>,loads:Pick<IndustryLoadService,'get'>,models?:IndustryModelProbe){this.market=market;this.loads=loads;this.models=models}
 /**
  * 包内 Skill 的普通调用按固定清单检查模型；公共引用只共享原子正文，不能把首个安装方案的入口条件加给其他使用方。
  * 公共引用所在方案的执行条件由当前加载的 resolveIndustryRunSkillBindings 核对。
  */
 async assertModelsReady(ownerId:string,source:SkillInstallSourceIdentity):Promise<void>{
  if(source.kind!=='industry-local')return
  const content=await this.market.get({ownerId,kind:'human'},{contentId:source.contentId})
  if(content.kind!=='industry-template'||content.hash!==source.contentHash)throw corrupt()
  const resource=validateManifest(content.metadata).resources.find(row=>row.id===source.resourceId)
  if(!resource||resource.kind!=='skill'||resource.version!==source.resourceVersion)throw corrupt()
  await assertIndustryModelsReady(resource.modelDependencies,this.models)
 }
 async read(ownerId:string,input:unknown):Promise<SkillInstallSourceBundle>{
  const row=exact(input,['kind','contentId','loadId','itemInstanceId'])
  if(row.kind==='atomic'){
   exact(row,['kind','contentId']);if(!uuid(row.contentId))throw new WorkError('teloa/invalid-input','技能安装来源请求格式不正确。')
   return atomic(ownerId,await this.market.get({ownerId,kind:'human'},{contentId:row.contentId.toLowerCase()}))
  }
  exact(row,['kind','loadId','itemInstanceId']);if(row.kind!=='industry'||!uuid(row.loadId)||!uuid(row.itemInstanceId))throw new WorkError('teloa/invalid-input','技能安装来源请求格式不正确。')
  const loadId=row.loadId.toLowerCase(),itemInstanceId=row.itemInstanceId.toLowerCase(),load=await this.loads.get(ownerId,{loadId})
  const item=load.items.find(candidate=>candidate.instanceId.toLowerCase()===itemInstanceId)
  if(!item)throw new WorkError('teloa/forbidden','行业技能映射不存在或不属于当前本人。')
  if(item.kind!=='skill'||item.status!=='pending-adapter')throw new WorkError('teloa/source-unavailable','行业资源不是可安装的固定技能。')
  const content=await this.market.get({ownerId,kind:'human'},{contentId:load.contentId})
  if(content.id.toLowerCase()!==load.contentId.toLowerCase()||content.hash!==load.contentHash||content.kind!=='industry-template')throw new WorkError('teloa/source-unavailable','行业技能固定包来源不一致。')
  const manifest=validateManifest(content.metadata),resource=manifest.resources.find(candidate=>candidate.id===item.localId)
  if(!resource||resource.kind!=='skill'||resource.title!==item.title||resource.version!==item.version)throw corrupt()
  if(resource.source.kind==='local'){
   const provided=content.provides.filter(candidate=>candidate.resourceId===resource.id)
   const root=content.manifestPath.includes('/')?content.manifestPath.slice(0,content.manifestPath.lastIndexOf('/')+1):'',entry=root+resource.source.path
   if(provided.length!==1||provided[0]!.kind!=='skill'||provided[0]!.version!==resource.version||provided[0]!.path!==entry)throw corrupt()
   const slash=entry.lastIndexOf('/'),skillRoot=slash<0?'':entry.slice(0,slash+1)
   if(entry.slice(slash+1)!=='SKILL.md'||content.files.filter(file=>file.path.startsWith(skillRoot)&&file.path.split('/').at(-1)==='SKILL.md').length!==1)throw new WorkError('teloa/source-unavailable','行业技能必须精确指向仅含一个入口的 SKILL.md 目录。')
   return bundle(ownerId,content,entry,{kind:'industry-local',loadId,itemInstanceId,contentId:content.id,contentHash:content.hash,resourceId:resource.id,resourceVersion:resource.version})
  }
  const references=content.references.filter(candidate=>candidate.resourceId===resource.id)
  if(references.length!==1)throw new WorkError('teloa/source-unavailable','行业公共技能固定引用缺失。')
  const reference=references[0]!,source=await this.market.get({ownerId,kind:'human'},{contentId:reference.sourceContentId})
  if(source.kind!=='atomic-skill'||source.hash!==reference.sourceHash||reference.sourceItemId!=='atomic-'+source.hash||reference.sourceResourceId!==resource.source.id||source.logicalId!==resource.source.id||source.version!==resource.source.version)throw new WorkError('teloa/source-unavailable','行业公共技能固定引用身份、版本或摘要不一致。')
  return atomic(ownerId,source,{kind:'industry-public',loadId,itemInstanceId,contentId:content.id,contentHash:content.hash,sourceContentId:source.id,sourceContentHash:source.hash,sourceResourceId:source.logicalId,sourceResourceVersion:source.version,resourceId:resource.id,resourceVersion:resource.version})
 }
}

import {createHash} from 'node:crypto'
import type {Pool,PoolClient} from 'pg'
import {WorkError,isRecord,isGithubRepositoryName,localizedMetadata,isIndustryPackageFormat,industryResourceModelDependencies,assertIndustryConfigurationResourceFormat,readBusinessDashboardResource,type BusinessDashboardResourceDefinition,type IndustryPackageFormat,type IndustryModelDependency,type LocalizedMetadata} from '@teloa/contract'

export type MarketActor={ownerId:string;kind:'human'|'agent'}
export type MarketFileInput={path:string;bytes:Uint8Array}
export type MarketResourceKind='role'|'knowledge'|'skill'|'mcp'|'plugin'|'data-source'|'execution-tool'|'work-template'|'plan'|'object-type'|'business-view'|'business-action'|'business-configuration'
export type MarketProvidedResource={resourceId:string;kind:MarketResourceKind;version:string;path:string}
export type MarketSourceTrust={publisher:string;repository:{host:'github.com';owner:string;repo:string}|null;license:{status:'declared';value:string}|{status:'missing'};signature:{status:'verified'|'unverified'|'invalid';signer:string|null};compatibility:{teloa:string;dsh:string};plugins:{id:string;version:string;required:boolean}[];externalCapabilities:{id:string;kind:'mcp'|'connection';required:boolean}[];permissions:{id:string;description:string;required:boolean}[];review:{conclusion:'approved'|'needs-review'|'rejected';summary:string}}
export type MarketContentReference={resourceId:string;sourceContentId:string;sourceItemId:string;sourceResourceId:string;sourceHash:string}
export type MarketContent={
 id:string;ownerId:string;kind:'atomic-skill'|'industry-template';logicalId:string;version:string
 hash:string;baseHash:string;manifestPath:string;metadata:Record<string,unknown>;trust:MarketSourceTrust;trustHash:string
 files:{path:string;hash:string;bytes:Uint8Array}[];provides:MarketProvidedResource[]
 references:MarketContentReference[];createdAt:string
}
export type MarketImportSource={kind:'upload';name:string}|{kind:'github';owner:string;repo:string;requestedRef:string;resolvedCommit:string;archiveHash:string;path?:string}|{kind:'catalog';catalog:'teloa-official';catalogVersion:string;entryId:string;entryVersion:string;treeHash:string}
export type MarketImportReceipt={requestId:string;contentId:string;source:MarketImportSource;createdAt:string}
export type MarketCatalogContentIdentity={entryId:string;entryVersion:string;treeHash:string;logicalId:string;trustHash:string}

type LocalizedFields={title?:LocalizedMetadata;description?:LocalizedMetadata}
export const marketPublicationRequiredLocales=['zh-CN','en'] as const
export type MarketPublicationMetadata={
 requiredLocales:typeof marketPublicationRequiredLocales
 localized:{title:LocalizedMetadata;description?:LocalizedMetadata}
 resources:{id:string;title:LocalizedMetadata}[]
}
type AtomicInput={kind:'atomic-skill';requestId:string;source:MarketImportSource;metadata:{id:string;title:string;version:string;categories:string[];localized?:Pick<LocalizedFields,'title'>};trust?:MarketSourceTrust;files:MarketFileInput[]}
type IndustryInput={kind:'industry-template';requestId:string;source:MarketImportSource;manifestPath:string;trust?:MarketSourceTrust;files:MarketFileInput[];references:MarketContentReference[]}
type ImportInput=AtomicInput|IndustryInput
type Normalized={kind:MarketContent['kind'];logicalId:string;version:string;hash:string;baseHash:string;manifestPath:string;metadata:Record<string,unknown>;trust:MarketSourceTrust;trustHash:string;files:MarketContent['files'];provides:MarketProvidedResource[];references:MarketContentReference[];requestSpec:Record<string,unknown>;source:MarketImportReceipt['source'];requestId:string}

const kinds=['role','knowledge','skill','mcp','plugin','data-source','execution-tool','work-template','plan','object-type','business-view','business-action','business-configuration'] as const
// 四条关联的 from 全是 role，不给声明开第五条：动作 → 工作模板的关联由动作声明里的
// target.localId 表达，不走 relations，否则同一件事有两个真源。
const relationTargets:Record<string,readonly MarketResourceKind[]>={
 'role-knowledge':['knowledge'],'role-skill':['skill'],'role-connection':['mcp','data-source','execution-tool'],'role-work':['work-template','plan'],
}
const MAX_FILE=2*1024*1024,MAX_TOTAL=20*1024*1024
const bad=(message='市场内容请求格式不正确或包含未知字段。')=>new WorkError('teloa/invalid-input',message)
const corrupt=()=>new WorkError('teloa/storage-corrupt','市场内容存储与固定摘要不一致，已停止读取。')
const stableId=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9-]{0,119}$/.test(value)
/** GitHub 仓库名（如 next.js、.github）与 github-source 的请求校验共用契约定义；owner 仍只有字母、数字和连字符。 */
const githubRepo=isGithubRepositoryName
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
const semver=(value:unknown):value is string=>typeof value==='string'&&value.length<=80&&/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value)
const hex=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value)
const sha=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex')
const exact=(value:unknown,keys:readonly string[]):Record<string,unknown>=>{
 if(!isRecord(value)||Object.keys(value).some(key=>!keys.includes(key)))throw bad()
 return value
}
const requiredText=(value:unknown,label:string,max:number):string=>{
 if(typeof value!=='string'||!value.trim()||value.length>max)throw bad(label+'必须填写且不超过 '+max+' 字。')
 return value.trim()
}
const safePath=(value:unknown):string=>{
 const path=requiredText(value,'内容路径',500)
 if(path.startsWith('/')||path.split('/').some(part=>!part||part==='.'||part==='..')||/[\\:?%#\u0000-\u001f\u007f]/.test(path))throw bad('内容路径必须是安全的包内相对路径。')
 return path
}
const stable=(value:unknown):string=>JSON.stringify(value,(_,item)=>isRecord(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item)
const same=(a:unknown,b:unknown)=>stable(a)===stable(b)
/** 旧回执未带 trustHash 时，只接受迁移后的默认信任，不能将旧回执提升为新信任。 */
function sameImportRequest(actual:unknown,expected:Record<string,unknown>&{trustHash:unknown}):boolean{
 const {trustHash,...legacy}=expected
 return same(actual,expected)||(trustHash===marketTrustHash(normalizeMarketSourceTrust(undefined))&&same(actual,legacy))
}
const stamp=(value:unknown):string=>{if(!(value instanceof Date)||!Number.isFinite(value.getTime()))throw corrupt();return value.toISOString()}

function source(input:unknown):MarketImportSource{
 // GitHub 固定来源保留 owner/repo/ref 与解析后的 commit、归档摘要，便于后续比对同仓库的新提交。
 if(isRecord(input)&&input.kind==='github'){
  const value=exact(input,['kind','owner','repo','requestedRef','resolvedCommit','archiveHash','path'])
  if(value.path!==undefined&&(typeof value.path!=='string'||value.path.length>300||safePath(value.path)!==value.path))throw bad('GitHub 来源子目录必须是安全的相对路径。')
  if(!stableId(value.owner)||!githubRepo(value.repo))throw bad('GitHub 来源仓库身份格式不正确。')
  if(typeof value.resolvedCommit!=='string'||!/^[0-9a-f]{40}$/.test(value.resolvedCommit)||!hex(value.archiveHash))throw bad('GitHub 来源必须固定到 40 位 commit 与归档摘要。')
  return {kind:'github',owner:value.owner,repo:value.repo,requestedRef:requiredText(value.requestedRef,'GitHub ref',200),resolvedCommit:value.resolvedCommit,archiveHash:value.archiveHash,...(value.path===undefined?{}:{path:value.path as string})}
 }
 // 官方目录来源：字节来自随发行固定的目录快照，这里只固定条目身份与工件树摘要。
 if(isRecord(input)&&input.kind==='catalog'){
  const value=exact(input,['kind','catalog','catalogVersion','entryId','entryVersion','treeHash'])
  if(value.catalog!=='teloa-official'||typeof value.catalogVersion!=='string'||!/^[0-9A-Za-z][0-9A-Za-z.-]{0,39}$/.test(value.catalogVersion))throw bad('官方目录来源身份格式不正确。')
  if(typeof value.entryId!=='string'||!/^(?=.{1,120}$)[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*){1,2}$/.test(value.entryId)||!semver(value.entryVersion)||!hex(value.treeHash))throw bad('官方目录来源必须固定到资源标识、版本与工件树摘要。')
  return {kind:'catalog',catalog:'teloa-official',catalogVersion:value.catalogVersion,entryId:value.entryId,entryVersion:value.entryVersion,treeHash:value.treeHash}
 }
 const value=exact(input,['kind','name'])
 if(value.kind!=='upload')throw bad('首批市场内容持久化只接受已经读取字节的本地上传来源。')
 return {kind:'upload',name:requiredText(value.name,'来源名称',300)}
}
/** 来源缺少信任声明时的回退发布者标识。 */
const sourceLabel=(value:MarketImportSource):string=>value.kind==='upload'?value.name:value.kind==='catalog'?'Teloa 官方目录 '+value.entryId:value.owner+'/'+value.repo
function unique<T extends {id:string}>(values:T[],label:string):T[]{if(new Set(values.map(value=>value.id)).size!==values.length)throw bad(label+'不能重复。');return values}
function localizedFields(input:unknown,originals:{title:string;description?:string}):LocalizedFields{
 const row=exact(input,['title','description']),result:LocalizedFields={}
 for(const field of ['title','description'] as const)if(row[field]!==undefined){
  if(originals[field]===undefined)throw bad('此市场内容不支持该本地化字段。')
  const value=localizedMetadata(row[field])
  if(value.original!==originals[field])throw bad('本地化元数据的稳定原文必须与市场内容字段一致。')
  result[field]=value
 }
 return result
}
function publicationField(input:unknown,original:string,label:string):LocalizedMetadata{
 if(input===undefined)throw bad(label+'公开发布必须提供简体中文和英文。')
 const value=localizedMetadata(input)
 if(value.original!==original)throw bad(label+'本地化元数据的稳定原文与内容不一致。')
 if(value.defaultLocale!=='en')throw bad(label+'公开发布必须使用英文作为其他语言的默认回退。')
 if(typeof value.locales['zh-CN']!=='string'||typeof value.locales.en!=='string')throw bad(label+'公开发布必须分别提供简体中文和英文实际文本，不能使用 fallback 代替。')
 return value
}
/**
 * 公开市场发布前的用户可见元数据闸门。固定到本人目录的私有内容不经过此闸，
 * 以免把尚在整理的草案误当作公开资源；将来的发布服务必须在创建公开版本前调用。
 */
export function marketPublicationMetadata(input:Pick<MarketContent,'kind'|'metadata'>):MarketPublicationMetadata{
 if(input.kind==='atomic-skill'){
  const metadata=exact(input.metadata,['id','title','version','categories','localized']),title=requiredText(metadata.title,'技能名称',120)
  const localized=metadata.localized===undefined?undefined:exact(metadata.localized,['title'])
  return {requiredLocales:marketPublicationRequiredLocales,localized:{title:publicationField(localized?.title,title,'技能名称')},resources:[]}
 }
 const manifest=validateManifest(input.metadata)
 return {requiredLocales:marketPublicationRequiredLocales,localized:{
  title:publicationField(manifest.localized?.title,manifest.title,'行业模板名称'),
  description:publicationField(manifest.localized?.description,manifest.description,'行业模板说明'),
 },resources:manifest.resources.map(resource=>({id:resource.id,title:publicationField(resource.localized?.title,resource.title,'资源「'+resource.title+'」名称')}))}
}
export function normalizeMarketSourceTrust(input:unknown,fallbackPublisher='未知发布者'):MarketSourceTrust{
 if(input===undefined)return {publisher:fallbackPublisher,repository:null,license:{status:'missing'},signature:{status:'unverified',signer:null},compatibility:{teloa:'未声明',dsh:'未声明'},plugins:[],externalCapabilities:[],permissions:[],review:{conclusion:'needs-review',summary:'来源未提供信任声明'}}
 const row=exact(input,['publisher','repository','license','signature','compatibility','plugins','externalCapabilities','permissions','review'])
 let repository:MarketSourceTrust['repository']=null
 if(row.repository!==null){const value=exact(row.repository,['host','owner','repo']);if(value.host!=='github.com'||!stableId(value.owner)||!githubRepo(value.repo))throw bad('仓库身份格式不正确。');repository={host:'github.com',owner:value.owner,repo:value.repo}}
 const licenseRow=exact(row.license,['status','value']);let license:MarketSourceTrust['license']
 if(licenseRow.status==='missing'){exact(licenseRow,['status']);license={status:'missing'}}else if(licenseRow.status==='declared')license={status:'declared',value:requiredText(licenseRow.value,'许可证',200)};else throw bad('许可证声明格式不正确。')
 const signatureRow=exact(row.signature,['status','signer']);if(!['verified','unverified','invalid'].includes(String(signatureRow.status))||signatureRow.signer!==null&&typeof signatureRow.signer!=='string')throw bad('签名状态格式不正确。')
 const compatibilityRow=exact(row.compatibility,['teloa','dsh']),compatibility={teloa:requiredText(compatibilityRow.teloa,'Teloa 兼容范围',120),dsh:requiredText(compatibilityRow.dsh,'DSH 兼容范围',120)}
 if(!Array.isArray(row.plugins)||!Array.isArray(row.externalCapabilities)||!Array.isArray(row.permissions)||row.plugins.length>100||row.externalCapabilities.length>100||row.permissions.length>100)throw bad('来源能力或权限声明过多。')
 const plugins=unique(row.plugins.map(input=>{const value=exact(input,['id','version','required']);if(typeof value.required!=='boolean'||!semver(value.version))throw bad('扩展声明格式不正确。');return {id:id(value.id,'扩展标识'),version:value.version,required:value.required}}),'扩展声明')
 const externalCapabilities=unique(row.externalCapabilities.map(input=>{const value=exact(input,['id','kind','required']);if(!['mcp','connection'].includes(String(value.kind))||typeof value.required!=='boolean')throw bad('外部能力声明格式不正确。');return {id:id(value.id,'外部能力标识'),kind:value.kind as 'mcp'|'connection',required:value.required}}),'外部能力声明')
 const permissions=unique(row.permissions.map(input=>{const value=exact(input,['id','description','required']);if(typeof value.id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value.id)||typeof value.required!=='boolean')throw bad('权限声明格式不正确。');return {id:value.id,description:requiredText(value.description,'权限说明',500),required:value.required}}),'权限声明')
 const reviewRow=exact(row.review,['conclusion','summary']);if(!['approved','needs-review','rejected'].includes(String(reviewRow.conclusion)))throw bad('审查结论格式不正确。')
 return {publisher:requiredText(row.publisher,'发布者',200),repository,license,signature:{status:signatureRow.status as MarketSourceTrust['signature']['status'],signer:signatureRow.signer===null?null:requiredText(signatureRow.signer,'签名主体',200)},compatibility,plugins,externalCapabilities,permissions,review:{conclusion:reviewRow.conclusion as MarketSourceTrust['review']['conclusion'],summary:requiredText(reviewRow.summary,'审查说明',1000)}}
}
export const marketTrustHash=(value:MarketSourceTrust)=>sha(stable(value))
function files(input:unknown):MarketContent['files']{
 if(!Array.isArray(input)||input.length<1||input.length>500)throw bad('市场内容需包含 1～500 个文件。')
 const paths=new Set<string>(),result:MarketContent['files']=[]
 let total=0
 for(const row of input){
  const value=exact(row,['path','bytes']),path=safePath(value.path),bytes=value.bytes
  if(paths.has(path))throw bad('内容路径重复：'+path)
  if(!(bytes instanceof Uint8Array)||bytes.byteLength>MAX_FILE)throw bad('单个市场内容文件不能超过 2 MiB。')
  paths.add(path);total+=bytes.byteLength
  if(total>MAX_TOTAL)throw bad('市场内容总大小不能超过 20 MiB。')
  const copy=Uint8Array.from(bytes)
  result.push({path,hash:sha(copy),bytes:copy})
 }
 return result.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0)
}
function utf8(file:MarketContent['files'][number],label:string):string{
 try{return new TextDecoder('utf-8',{fatal:true}).decode(file.bytes)}catch{throw bad(label+'必须是 UTF-8 文本。')}
}
function normalizeAtomic(input:AtomicInput):Omit<Normalized,'requestSpec'|'source'|'requestId'> {
 const metadataRow=exact(input.metadata,['id','title','version','categories','localized'])
 if(!stableId(metadataRow.id))throw bad('技能标识仅允许字母、数字和连字符。')
 if(!semver(metadataRow.version))throw bad('技能版本必须是固定的三段版本号。')
 if(!Array.isArray(metadataRow.categories)||metadataRow.categories.length>20)throw bad('技能分类最多 20 项。')
 const categories=metadataRow.categories.map(value=>requiredText(value,'技能分类',80))
 if(new Set(categories).size!==categories.length)throw bad('技能分类不能重复。')
 const title=requiredText(metadataRow.title,'技能名称',120)
 const metadata={id:metadataRow.id,title,version:metadataRow.version,categories,...(metadataRow.localized===undefined?{}:{localized:localizedFields(metadataRow.localized,{title})})}
 const contentFiles=files(input.files),entries=contentFiles.filter(file=>file.path.split('/').at(-1)==='SKILL.md')
 if(entries.length!==1)throw bad('独立技能必须只包含一个顶层 SKILL.md。')
 const manifestPath=entries[0]!.path,root=manifestPath.slice(0,manifestPath.lastIndexOf('/')+1)
 if(contentFiles.some(file=>!file.path.startsWith(root)))throw bad('技能目录包含入口目录外的文件。')
 if(!utf8(entries[0]!,'SKILL.md').trim())throw bad('SKILL.md 不能为空。')
 const baseHash=sha(JSON.stringify({metadata,files:contentFiles.map(file=>[file.path,file.hash])}))
 const trust=normalizeMarketSourceTrust(input.trust,sourceLabel(input.source))
 return {kind:'atomic-skill',logicalId:metadata.id,version:metadata.version,hash:baseHash,baseHash,manifestPath,metadata,trust,trustHash:marketTrustHash(trust),files:contentFiles,provides:[{resourceId:metadata.id,kind:'skill',version:metadata.version,path:manifestPath}],references:[]}
}

/**
 * 原子 Skill 导入后的内容身份（与 `import` 同一归一化与摘要公式）。
 * 官方目录据此判断本人是否已添加某条目，不另写一份摘要算法。
 */
export function atomicContentIdentity(input:{metadata:AtomicInput['metadata'];trust?:MarketSourceTrust;files:MarketFileInput[];sourceLabel:string}):{logicalId:string;version:string;contentHash:string;trustHash:string}{
 const value=normalizeAtomic({kind:'atomic-skill',requestId:'00000000-0000-4000-8000-000000000000',source:{kind:'upload',name:input.sourceLabel},metadata:input.metadata,...(input.trust?{trust:input.trust}:{}),files:input.files})
 return {logicalId:value.logicalId,version:value.version,contentHash:value.hash,trustHash:value.trustHash}
}
/** 行业模板导入后的内容身份，与 `import` 共用本地字节与固定引用摘要公式。 */
export function industryContentIdentity(input:{manifestPath:string;trust?:MarketSourceTrust;files:MarketFileInput[];sourceLabel:string;references?:MarketContentReference[]}):{logicalId:string;version:string;contentHash:string;trustHash:string}{
 const value=normalizeIndustry({kind:'industry-template',requestId:'00000000-0000-4000-8000-000000000000',source:{kind:'upload',name:input.sourceLabel},manifestPath:input.manifestPath,...(input.trust?{trust:input.trust}:{}),files:input.files,references:input.references??[]})
 return {logicalId:value.logicalId,version:value.version,contentHash:value.hash,trustHash:value.trustHash}
}

type ManifestResource={modelDependencies?:IndustryModelDependency[];id:string;kind:MarketResourceKind;title:string;localized?:Pick<LocalizedFields,'title'>;version:string;required:boolean;source:{kind:'local';path:string}|{kind:'public';id:string;version:string}}
type IndustryManifest={format:IndustryPackageFormat;id:string;title:string;version:string;domain:string;scope:string;description:string;localized?:LocalizedFields;resources:ManifestResource[];relations:{kind:string;from:string;to:string}[];entrypoints:string[]}
function id(value:unknown,label='资源标识'):string{if(!stableId(value))throw bad(label+'仅允许字母、数字和连字符。');return value}
export function validateManifest(input:unknown):IndustryManifest{
 const hasScope=isRecord(input)&&Object.hasOwn(input,'scope')
 const row=exact(input,['format','id','title','version','domain','scope','description','localized','resources','relations','entrypoints'])
 if(!isIndustryPackageFormat(row.format))throw bad('只支持 teloa.business-package/v2、v3 或 v4 行业模板。')
 if(!semver(row.version))throw bad('行业模板版本必须是固定的三段版本号。')
 if(!Array.isArray(row.resources)||!row.resources.length||row.resources.length>500)throw bad('行业资源需包含 1～500 项。')
 const resources:ManifestResource[]=row.resources.map(input=>{
  const value=exact(input,['id','kind','title','localized','version','required','source',...(row.format!=='teloa.business-package/v2'?['modelDependencies']:[])]),resourceId=id(value.id),title=requiredText(value.title,'资源名称',120)
  if(!kinds.includes(value.kind as MarketResourceKind)||!semver(value.version)||typeof value.required!=='boolean')throw bad('行业资源类型、版本或 required 无效。')
  assertIndustryConfigurationResourceFormat(row.format,value.kind)
  const sourceValue=exact(value.source,['kind','path','id','version'])
  let normalizedSource:ManifestResource['source']
  if(sourceValue.kind==='local'){
   exact(sourceValue,['kind','path']);normalizedSource={kind:'local',path:safePath(sourceValue.path)}
  }else if(sourceValue.kind==='public'){
   exact(sourceValue,['kind','id','version'])
   if(!stableId(sourceValue.id)||!semver(sourceValue.version)||sourceValue.version!==value.version)throw bad('公共资源必须固定身份和与声明一致的版本。')
   normalizedSource={kind:'public',id:sourceValue.id,version:sourceValue.version}
  }else throw bad('行业资源来源必须是包内路径或固定公共引用。')
  return {id:resourceId,kind:value.kind as MarketResourceKind,title,...(value.localized===undefined?{}:{localized:localizedFields(exact(value.localized,['title']),{title})}),version:value.version,required:value.required,source:normalizedSource,...industryResourceModelDependencies(value.kind,value.modelDependencies)}
 })
 const byId=new Map(resources.map(value=>[value.id,value]));if(byId.size!==resources.length)throw bad('行业资源标识重复。')
 if(!Array.isArray(row.relations)||row.relations.length>2000)throw bad('行业资源关联不能超过 2000 项。')
 const seen=new Set<string>(),relations=row.relations.map(input=>{
  const value=exact(input,['kind','from','to']),kind=requiredText(value.kind,'关联类型',80),from=id(value.from),to=id(value.to)
  const fromResource=byId.get(from),toResource=byId.get(to),allowed=relationTargets[kind]
  if(!fromResource||!toResource)throw bad('行业资源关联指向不存在的资源。')
  if(!allowed||fromResource.kind!=='role'||!allowed.includes(toResource.kind))throw bad('行业资源关联类型不匹配。')
  const key=kind+':'+from+':'+to;if(seen.has(key))throw bad('行业资源关联重复。');seen.add(key)
  return {kind,from,to}
 })
 if(!Array.isArray(row.entrypoints)||row.entrypoints.length>500)throw bad('行业入口不能超过 500 项。')
 const entrypoints=row.entrypoints.map(value=>id(value,'业务入口'))
 if(new Set(entrypoints).size!==entrypoints.length)throw bad('业务入口重复。')
 for(const entry of entrypoints)if(!['skill','work-template'].includes(byId.get(entry)?.kind??''))throw bad('业务入口必须引用存在的技能或工作模板。')
 const title=requiredText(row.title,'行业名称',120),description=requiredText(row.description,'行业定位',2000),domain=requiredText(row.domain,'行业分类',80),scope=hasScope?requiredText(row.scope,'业务范围',80):domain
 if(!/^[a-zA-Z0-9_-]{1,64}$/.test(scope))throw bad('业务范围只能是 1–64 位字母、数字、下划线或连字符。')
 return {format:row.format,id:id(row.id,'行业标识'),title,version:row.version,domain,scope,description,...(row.localized===undefined?{}:{localized:localizedFields(row.localized,{title,description})}),resources,relations,entrypoints}
}
function configurationBody(file:MarketContent['files'][number],resource:ManifestResource,scope:string):BusinessDashboardResourceDefinition{
 const value=readBusinessDashboardResource(JSON.parse(utf8(file,'业务配置资源')))
 if(value.id!==resource.id||value.version!==resource.version||value.configuration.scope!==scope)throw bad('业务配置资源身份、版本或业务范围与清单不一致。')
 return value
}
/** 只读固定的本地配置正文；不写业务配置头、记录或授权。 */
export function readMarketBusinessConfigurationResource(content:MarketContent,resourceId:string):BusinessDashboardResourceDefinition{
 try{
  if(content.kind!=='industry-template')throw bad()
  const manifest=validateManifest(content.metadata),resource=manifest.resources.find(row=>row.id===resourceId)
  if(!resource||resource.kind!=='business-configuration'||resource.source.kind!=='local')throw bad()
  const root=content.manifestPath.includes('/')?content.manifestPath.slice(0,content.manifestPath.lastIndexOf('/')+1):'',path=root+resource.source.path
  const provided=content.provides.find(row=>row.resourceId===resourceId),file=content.files.find(row=>row.path===path)
  if(!provided||provided.kind!==resource.kind||provided.version!==resource.version||provided.path!==path||!file||sha(file.bytes)!==file.hash)throw bad()
  return configurationBody(file,resource,manifest.scope)
 }catch{throw new WorkError('teloa/source-unavailable','固定业务配置资源身份、正文或文件摘要不一致。')}
}
/** 公共引用与同主体固定来源逐项匹配；配置源只允许无嵌套引用的本地包。 */
export function assertMarketContentReference(ownerId:string,scope:string,resource:ManifestResource,reference:MarketContentReference,sourceContent:MarketContent):void{
 const unavailable=()=>new WorkError('teloa/source-unavailable','公共资源来源主体、身份、版本、种类或内容摘要不匹配。')
 if(resource.source.kind!=='public'||reference.resourceId!==resource.id||sourceContent.ownerId!==ownerId||sourceContent.id.toLowerCase()!==reference.sourceContentId.toLowerCase()||sourceContent.hash!==reference.sourceHash)throw unavailable()
 const provided=sourceContent.provides.find(row=>row.resourceId===reference.sourceResourceId)
 if(!provided||provided.kind!==resource.kind||provided.resourceId!==resource.source.id||provided.version!==resource.version)throw unavailable()
 if(resource.kind==='skill'){
  if(sourceContent.kind!=='atomic-skill'||reference.sourceItemId!=='atomic-'+sourceContent.hash)throw unavailable()
 }else if(resource.kind==='business-configuration'){
  if(sourceContent.kind!=='industry-template'||sourceContent.references.length||reference.sourceItemId!=='directory-'+sourceContent.hash)throw unavailable()
  const sourceScope=readMarketBusinessConfigurationResource(sourceContent,reference.sourceResourceId).configuration.scope
  if(sourceScope!=='template'&&sourceScope!==scope)throw unavailable()
 }else throw unavailable()
}
function normalizeReference(input:unknown):MarketContentReference{
 const value=exact(input,['resourceId','sourceContentId','sourceItemId','sourceResourceId','sourceHash'])
 if(!stableId(value.resourceId)||!uuid(value.sourceContentId)||!stableId(value.sourceResourceId)||typeof value.sourceItemId!=='string'||value.sourceItemId.length>200||!hex(value.sourceHash))throw bad('公共资源引用身份或摘要格式不正确。')
 return {resourceId:value.resourceId,sourceContentId:value.sourceContentId,sourceItemId:value.sourceItemId,sourceResourceId:value.sourceResourceId,sourceHash:value.sourceHash}
}
function normalizeIndustry(input:IndustryInput):Omit<Normalized,'requestSpec'|'source'|'requestId'> {
 const manifestPath=safePath(input.manifestPath),contentFiles=files(input.files),root=manifestPath.includes('/')?manifestPath.slice(0,manifestPath.lastIndexOf('/')+1):''
 if(contentFiles.some(file=>!file.path.startsWith(root)))throw bad('行业模板内容包含清单目录外的文件。')
 const manifestFile=contentFiles.find(file=>file.path===manifestPath);if(!manifestFile)throw bad('行业清单文件不存在。')
 let raw:unknown;try{raw=JSON.parse(utf8(manifestFile,'行业清单'))}catch(error){if(error instanceof WorkError)throw error;throw bad('行业清单不是有效 JSON。')}
 const manifest=validateManifest(raw),paths=new Set(contentFiles.map(file=>file.path)),provides:MarketProvidedResource[]=[]
 for(const resource of manifest.resources){
  if(resource.source.kind!=='local')continue
  const path=root+resource.source.path
  if(!paths.has(path)){if(resource.required)throw bad('缺少必需资源文件：'+resource.source.path);continue}
  if(resource.kind==='business-configuration'){
   try{configurationBody(contentFiles.find(file=>file.path===path)!,resource,manifest.scope)}catch(error){if(error instanceof WorkError)throw error;throw bad('业务配置资源不是有效的固定正文。')}
  }
  provides.push({resourceId:resource.id,kind:resource.kind,version:resource.version,path})
 }
 const references=(Array.isArray(input.references)?input.references:[]).map(normalizeReference).sort((a,b)=>a.resourceId<b.resourceId?-1:a.resourceId>b.resourceId?1:0)
 if(new Set(references.map(value=>value.resourceId)).size!==references.length)throw bad('公共资源引用重复。')
 const publicResources=manifest.resources.filter(resource=>resource.source.kind==='public')
 if(references.some(reference=>!publicResources.some(resource=>resource.id===reference.resourceId)))throw bad('公共资源引用不属于此行业模板。')
 const baseHash=sha(JSON.stringify({manifestPath,files:contentFiles.map(file=>[file.path,file.hash])}))
 const hash=references.length?sha(JSON.stringify([baseHash,references.map(({resourceId,sourceItemId,sourceResourceId,sourceHash})=>[resourceId,sourceItemId,sourceResourceId,sourceHash])])):baseHash
 const trust=normalizeMarketSourceTrust(input.trust,sourceLabel(input.source))
 return {kind:'industry-template',logicalId:manifest.id,version:manifest.version,hash,baseHash,manifestPath,metadata:manifest as unknown as Record<string,unknown>,trust,trustHash:marketTrustHash(trust),files:contentFiles,provides,references}
}
function normalize(input:unknown):Normalized{
 const row=exact(input,['kind','requestId','source','metadata','manifestPath','trust','files','references'])
 if(!uuid(row.requestId))throw bad('市场导入请求 ID 必须是 UUID。')
 const normalizedSource=source(row.source)
 let content:Omit<Normalized,'requestSpec'|'source'|'requestId'>
 if(row.kind==='atomic-skill'){
  exact(row,['kind','requestId','source','metadata','trust','files'])
  content=normalizeAtomic(row as unknown as AtomicInput)
 }else if(row.kind==='industry-template'){
  exact(row,['kind','requestId','source','manifestPath','trust','files','references'])
  content=normalizeIndustry(row as unknown as IndustryInput)
 }else throw bad('不支持的市场内容类型。')
 const requestSpec={kind:content.kind,source:normalizedSource,logicalId:content.logicalId,version:content.version,hash:content.hash,baseHash:content.baseHash,manifestPath:content.manifestPath,metadata:content.metadata,trustHash:content.trustHash,references:content.references}
 return {...content,requestId:row.requestId,source:normalizedSource,requestSpec}
}

export async function initializeMarketContents(pool:Pool):Promise<void>{
 await pool.query(`
  create table if not exists teloa_market_contents(
   id uuid primary key,owner_id text not null,kind text not null check(kind in ('atomic-skill','industry-template')),
   logical_id text not null,version text not null,content_hash text not null check(content_hash ~ '^[0-9a-f]{64}$'),
   base_hash text not null check(base_hash ~ '^[0-9a-f]{64}$'),manifest_path text not null,
   metadata jsonb not null check(jsonb_typeof(metadata)='object'),trust jsonb,trust_hash text,
   provides jsonb not null check(jsonb_typeof(provides)='array'),
   refs jsonb not null check(jsonb_typeof(refs)='array'),created_at timestamptz not null,
   unique(owner_id,kind,logical_id,version,content_hash)
  );
  create table if not exists teloa_market_files(
   content_id uuid not null references teloa_market_contents(id),path text not null,file_hash text not null check(file_hash ~ '^[0-9a-f]{64}$'),bytes bytea not null,
   primary key(content_id,path)
  );
  create table if not exists teloa_market_imports(
   owner_id text not null,request_id uuid not null,request_spec jsonb not null check(jsonb_typeof(request_spec)='object'),
   content_id uuid not null references teloa_market_contents(id),source jsonb not null check(jsonb_typeof(source)='object'),created_at timestamptz not null,
   primary key(owner_id,request_id)
  );
 `)
 const legacy=normalizeMarketSourceTrust(undefined),legacyHash=marketTrustHash(legacy)
 await pool.query('alter table teloa_market_contents add column if not exists trust jsonb; alter table teloa_market_contents add column if not exists trust_hash text')
 await pool.query('update teloa_market_contents set trust=$1,trust_hash=$2 where trust is null or trust_hash is null',[JSON.stringify(legacy),legacyHash])
 await pool.query("alter table teloa_market_contents alter column trust set not null; alter table teloa_market_contents alter column trust_hash set not null; alter table teloa_market_contents drop constraint if exists teloa_market_contents_trust_shape; alter table teloa_market_contents add constraint teloa_market_contents_trust_shape check(jsonb_typeof(trust)='object' and trust_hash ~ '^[0-9a-f]{64}$')")
 await pool.query(`do $$ declare item record; begin for item in select conname from pg_constraint where conrelid='teloa_market_contents'::regclass and contype='u' and pg_get_constraintdef(oid)='UNIQUE (owner_id, kind, logical_id, version, content_hash)' loop execute format('alter table teloa_market_contents drop constraint %I',item.conname); end loop; end $$; create unique index if not exists teloa_market_contents_fixed_source on teloa_market_contents(owner_id,kind,logical_id,version,content_hash,trust_hash)`)
}

export class MarketContentStore{
 private readonly pool:Pool
 private readonly identity:{id:()=>string;now:()=>string}
 constructor(pool:Pool,identity:{id:()=>string;now:()=>string}){this.pool=pool;this.identity=identity}
 private authorize(actor:MarketActor,human=false):void{
  if(!actor.ownerId||!['human','agent'].includes(actor.kind)||(human&&actor.kind!=='human'))throw new WorkError('teloa/forbidden','当前主体无权执行市场内容操作。')
 }
 private async tx<T>(operation:(client:PoolClient)=>Promise<T>):Promise<T>{
  const client=await this.pool.connect().catch(()=>{throw new WorkError('teloa/storage-unavailable','市场内容数据库暂不可用。')})
  try{await client.query('begin');const value=await operation(client);await client.query('commit');return value}
  catch(error){await client.query('rollback').catch(()=>{});if(error instanceof WorkError)throw error;throw new WorkError('teloa/storage-unavailable','市场内容事务未完成，请检查数据库连接与结构。')}
  finally{client.release()}
 }
 /**
  * `lock` 缺省为真，保持既有写路径逐字不变（导入回执、实例化、授权都在写事务里取 `for share`，
  * 防止同一批字节在事务中途被换掉）。只读调用方可以显式关掉：`for share` 与 `read only` 事务
  * 在 Postgres 里不能共存（25006），台账那条纯读路径要的是真正的只读事务，而不是为了迁就取锁
  * 把只读声明去掉（复审 MEDIUM-6）。写法照 `role-memory.ts` 的 `role(db,...,lock=false)`。
  */
 private async content(client:PoolClient,actor:MarketActor,contentId:string,lock=true):Promise<MarketContent>{
  const row=(await client.query('select * from teloa_market_contents where id=$1'+(lock?' for share':''),[contentId])).rows[0] as Record<string,unknown>|undefined
  if(!row)throw new WorkError('teloa/not-found','市场内容不存在。')
  if(row.owner_id!==actor.ownerId)throw new WorkError('teloa/forbidden','当前主体无权读取此市场内容。')
  if(!uuid(row.id)||!['atomic-skill','industry-template'].includes(row.kind as string)||!stableId(row.logical_id)||!semver(row.version)||!hex(row.content_hash)||!hex(row.base_hash)||typeof row.manifest_path!=='string'||!isRecord(row.metadata)||!isRecord(row.trust)||!hex(row.trust_hash)||!Array.isArray(row.provides)||!Array.isArray(row.refs))throw corrupt()
  let fixedTrust:MarketSourceTrust;try{fixedTrust=normalizeMarketSourceTrust(row.trust)}catch{throw corrupt()}if(marketTrustHash(fixedTrust)!==row.trust_hash)throw corrupt()
  const fileRows=(await client.query('select path,file_hash,bytes from teloa_market_files where content_id=$1 order by path',[contentId])).rows as Record<string,unknown>[]
  let contentFiles:MarketContent['files']
  try{contentFiles=files(fileRows.map(value=>({path:value.path,bytes:value.bytes})))}catch{throw corrupt()}
  const storedHashes=new Map(fileRows.map(value=>[value.path,value.file_hash]))
  if(contentFiles.some(file=>storedHashes.get(file.path)!==file.hash))throw corrupt()
  let rebuilt:Omit<Normalized,'requestSpec'|'source'|'requestId'>
  try{
   const rawFiles=contentFiles.map(({path,bytes})=>({path,bytes}))
   if(row.kind==='atomic-skill')rebuilt=normalizeAtomic({kind:'atomic-skill',requestId:'00000000-0000-4000-8000-000000000000',source:{kind:'upload',name:'stored'},metadata:row.metadata as unknown as AtomicInput['metadata'],trust:fixedTrust,files:rawFiles})
   else rebuilt=normalizeIndustry({kind:'industry-template',requestId:'00000000-0000-4000-8000-000000000000',source:{kind:'upload',name:'stored'},manifestPath:row.manifest_path as string,trust:fixedTrust,files:rawFiles,references:row.refs as MarketContentReference[]})
  }catch{throw corrupt()}
  if(rebuilt.logicalId!==row.logical_id||rebuilt.version!==row.version||rebuilt.hash!==row.content_hash||rebuilt.baseHash!==row.base_hash||rebuilt.manifestPath!==row.manifest_path||!same(rebuilt.metadata,row.metadata)||!same(rebuilt.provides,row.provides)||!same(rebuilt.references,row.refs))throw corrupt()
  await this.verifyReferences(client,actor,rebuilt,lock)
  return {id:row.id,ownerId:actor.ownerId,kind:row.kind as MarketContent['kind'],logicalId:row.logical_id,version:row.version,hash:row.content_hash,baseHash:row.base_hash,manifestPath:row.manifest_path,metadata:row.metadata as Record<string,unknown>,trust:fixedTrust,trustHash:row.trust_hash,files:contentFiles,provides:row.provides as MarketProvidedResource[],references:row.refs as MarketContentReference[],createdAt:stamp(row.created_at)}
 }
 private async verifyReferences(client:PoolClient,actor:MarketActor,value:Pick<Normalized,'kind'|'metadata'|'references'>,lock=true):Promise<void>{
  if(value.kind!=='industry-template')return
  const manifest=value.metadata as unknown as IndustryManifest
  for(const resource of manifest.resources){
   if(resource.source.kind!=='public')continue
   if(resource.kind!=='skill'&&resource.kind!=='business-configuration')throw new WorkError('teloa/source-unavailable','固定公共引用只支持原子技能或完整业务配置。')
   const reference=value.references.find(row=>row.resourceId===resource.id)
   if(!reference)throw new WorkError('teloa/source-unavailable','公共资源尚未固定到已持久化的来源内容。')
   const sourceIdentity=(await client.query('select owner_id,kind,refs from teloa_market_contents where id=$1'+(lock?' for share':''),[reference.sourceContentId])).rows[0] as {owner_id?:unknown;kind?:unknown;refs?:unknown}|undefined
   const expectedKind=resource.kind==='skill'?'atomic-skill':'industry-template'
   // 读取完整来源之前拒绝嵌套配置包，不沿不可信引用递归，环也不能触发无限查询。
   if(!sourceIdentity||sourceIdentity.owner_id!==actor.ownerId||sourceIdentity.kind!==expectedKind||resource.kind==='business-configuration'&&(!Array.isArray(sourceIdentity.refs)||sourceIdentity.refs.length))throw new WorkError('teloa/source-unavailable','公共来源不存在、种类不符、包含嵌套引用或当前主体不可读取。')
   let sourceContent:MarketContent
   try{sourceContent=await this.content(client,actor,reference.sourceContentId,lock)}catch(error){if(error instanceof WorkError&&['teloa/not-found','teloa/forbidden'].includes(error.code))throw new WorkError('teloa/source-unavailable','公共来源不存在或当前主体不可读取。');throw error}
   assertMarketContentReference(actor.ownerId,manifest.scope,resource,reference,sourceContent)
  }
 }
 async import(actor:MarketActor,input:unknown):Promise<{receipt:MarketImportReceipt;content:MarketContent}>{
  this.authorize(actor,true);const value=normalize(input)
  // 「Teloa 官方目录」只能由官方目录来源产生；上传或 GitHub 导入自报这个发布者一律拒绝，避免冒充官方收录。
  if(value.source.kind!=='catalog'&&value.trust.publisher==='Teloa 官方目录')throw bad('只有 Teloa 官方目录来源可以使用这个发布者名称。')
  return this.tx(async client=>{
   await this.verifyReferences(client,actor,value)
   const now=this.identity.now()
   const inserted=(await client.query(`insert into teloa_market_contents(id,owner_id,kind,logical_id,version,content_hash,base_hash,manifest_path,metadata,trust,trust_hash,provides,refs,created_at)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) on conflict(owner_id,kind,logical_id,version,content_hash,trust_hash) do nothing returning id`,
    [this.identity.id(),actor.ownerId,value.kind,value.logicalId,value.version,value.hash,value.baseHash,value.manifestPath,JSON.stringify(value.metadata),JSON.stringify(value.trust),value.trustHash,JSON.stringify(value.provides),JSON.stringify(value.references),now])).rows[0] as {id:string}|undefined
   const contentId=inserted?.id??((await client.query('select id from teloa_market_contents where owner_id=$1 and kind=$2 and logical_id=$3 and version=$4 and content_hash=$5 and trust_hash=$6 for share',[actor.ownerId,value.kind,value.logicalId,value.version,value.hash,value.trustHash])).rows[0] as {id:string}).id
   if(inserted)for(const file of value.files)await client.query('insert into teloa_market_files(content_id,path,file_hash,bytes) values($1,$2,$3,$4)',[contentId,file.path,file.hash,Buffer.from(file.bytes)])
   await client.query(`insert into teloa_market_imports(owner_id,request_id,request_spec,content_id,source,created_at) values($1,$2,$3,$4,$5,$6) on conflict(owner_id,request_id) do nothing`,[actor.ownerId,value.requestId,JSON.stringify(value.requestSpec),contentId,JSON.stringify(value.source),now])
   const receiptRow=(await client.query('select * from teloa_market_imports where owner_id=$1 and request_id=$2 for update',[actor.ownerId,value.requestId])).rows[0] as Record<string,unknown>
   if(!same(receiptRow.request_spec,value.requestSpec)||receiptRow.content_id!==contentId||!same(receiptRow.source,value.source))throw new WorkError('teloa/conflict','同一市场导入请求不能更换来源或内容。')
   const content=await this.content(client,actor,contentId)
   return {receipt:{requestId:value.requestId,contentId,source:value.source,createdAt:stamp(receiptRow.created_at)},content}
  })
 }
 /** 按内容身份查本人已固定的原子 Skill；只读、不加锁，未命中返回 null。 */
 async findByIdentity(actor:MarketActor,input:{logicalId:string;version:string;contentHash:string;trustHash:string}):Promise<string|null>{
  this.authorize(actor)
  if(!stableId(input.logicalId)||!semver(input.version)||!hex(input.contentHash)||!hex(input.trustHash))throw bad('市场内容身份格式不正确。')
  const client=await this.pool.connect().catch(()=>{throw new WorkError('teloa/dependency-unavailable','市场内容数据库暂不可用。')})
  try{
   // 不按 kind 过滤：原子技能与行业模板的内容摘要由不同的规范化路径计算，这五个字段不会跨类型撞上。
   const row=(await client.query("select id from teloa_market_contents where owner_id=$1 and logical_id=$2 and version=$3 and content_hash=$4 and trust_hash=$5",[actor.ownerId,input.logicalId,input.version,input.contentHash,input.trustHash])).rows[0] as {id:unknown}|undefined
   if(row&&!uuid(row.id))throw corrupt()
   return row?row.id as string:null
  }catch(error){if(error instanceof WorkError)throw error;throw new WorkError('teloa/dependency-unavailable','市场内容查询未完成。')}
  finally{client.release()}
 }
 /** 按当前页固定目录来源回显本人已添加内容；只读回执与元数据，不重新下载或读取文件。 */
 async findByCatalogSources(actor:MarketActor,inputs:readonly MarketCatalogContentIdentity[]):Promise<ReadonlyMap<string,string>>{
  this.authorize(actor)
  if(!Array.isArray(inputs)||inputs.length>50||new Set(inputs.map(item=>item.entryId)).size!==inputs.length)throw bad('目录来源查询必须是当前页的不重复资源。')
  const sources=inputs.map(item=>{
   if(!stableId(item.logicalId)||!hex(item.trustHash))throw bad('市场内容身份格式不正确。')
   // catalogVersion 标识发行快照；无关条目升级不应使已有的固定来源失效。
   const {catalogVersion:_,...fixed}=source({kind:'catalog',catalog:'teloa-official',catalogVersion:'lookup',entryId:item.entryId,entryVersion:item.entryVersion,treeHash:item.treeHash}) as Extract<MarketImportSource,{kind:'catalog'}>
   return fixed
  })
  const ids=new Map<string,string>()
  if(!sources.length)return ids
  const requested=new Map(inputs.map(item=>[item.entryId,item]))
  const client=await this.pool.connect().catch(()=>{throw new WorkError('teloa/dependency-unavailable','市场内容数据库暂不可用。')})
  try{
   // 同一内容可有多个来源回执；匹配全部固定绑定，不能只看 content 最近一次导入来源。
   const rows=(await client.query(`select c.*,i.owner_id as import_owner_id,i.source,i.request_spec
    from teloa_market_imports i join teloa_market_contents c on c.id=i.content_id
    where i.owner_id=$1 and exists(select 1 from jsonb_array_elements($2::jsonb) wanted(source) where i.source @> wanted.source)
    order by i.created_at desc,i.request_id desc`,[actor.ownerId,JSON.stringify(sources)])).rows as Record<string,unknown>[]
   for(const row of rows){
    if(row.owner_id!==actor.ownerId||row.import_owner_id!==actor.ownerId||!uuid(row.id)||row.kind!=='atomic-skill'||!stableId(row.logical_id)||!semver(row.version)||!hex(row.content_hash)||!hex(row.base_hash)||typeof row.manifest_path!=='string'||!isRecord(row.metadata)||!isRecord(row.trust)||!hex(row.trust_hash)||!Array.isArray(row.refs)||!isRecord(row.request_spec))throw corrupt()
    let fixedSource:MarketImportSource,trust:MarketSourceTrust
    try{fixedSource=source(row.source);trust=normalizeMarketSourceTrust(row.trust)}catch{throw corrupt()}
    if(fixedSource.kind!=='catalog'||marketTrustHash(trust)!==row.trust_hash)throw corrupt()
    const wanted=requested.get(fixedSource.entryId)
    if(!wanted||fixedSource.entryVersion!==wanted.entryVersion||fixedSource.treeHash!==wanted.treeHash)throw corrupt()
    const expected={kind:row.kind,source:fixedSource,logicalId:row.logical_id,version:row.version,hash:row.content_hash,baseHash:row.base_hash,manifestPath:row.manifest_path,metadata:row.metadata,trustHash:row.trust_hash,references:row.refs}
    if(!sameImportRequest(row.request_spec,expected))throw corrupt()
    if(row.logical_id===wanted.logicalId&&row.version===wanted.entryVersion&&row.trust_hash===wanted.trustHash&&!ids.has(wanted.entryId))ids.set(wanted.entryId,row.id)
   }
   return ids
  }catch(error){if(error instanceof WorkError)throw error;throw new WorkError('teloa/dependency-unavailable','市场目录来源查询未完成。')}
  finally{client.release()}
 }
 async get(actor:MarketActor,input:unknown):Promise<MarketContent>{
  this.authorize(actor);const value=exact(input,['contentId']);if(!uuid(value.contentId))throw bad()
  return this.tx(client=>this.getInTransaction(client,actor,{contentId:value.contentId as string}))
 }
 /** `lock` 缺省为真：既有调用方全在写事务里，行为逐字不变；只读事务里的调用方显式传 `false`。 */
 async getInTransaction(client:PoolClient,actor:MarketActor,input:unknown,lock=true):Promise<MarketContent>{
  this.authorize(actor);const value=exact(input,['contentId']);if(!uuid(value.contentId))throw bad()
  return this.content(client,actor,value.contentId as string,lock)
 }
 /** 目录摘要不读取文件；使用内容前仍须通过 get 验证原始字节与来源。 */
 async list(actor:MarketActor,input:unknown):Promise<{items:Omit<MarketContent,'files'>[];nextCursor:string|null}>{
  this.authorize(actor);const value=exact(input,['cursor','limit']),limit=value.limit===undefined?50:value.limit
  if(!Number.isInteger(limit)||Number(limit)<1||Number(limit)>100||(value.cursor!==undefined&&!uuid(value.cursor)))throw bad()
  return this.tx(async client=>{
   let after:Date|null=null
   if(value.cursor!==undefined){
    const cursor=(await client.query('select created_at from teloa_market_contents where id=$1 and owner_id=$2',[value.cursor,actor.ownerId])).rows[0] as {created_at:unknown}|undefined
    if(!cursor)throw new WorkError('teloa/not-found','市场目录游标不存在。')
    stamp(cursor.created_at);after=cursor.created_at as Date
   }
   const rows=(await client.query(`select id,kind,logical_id,version,content_hash,base_hash,manifest_path,metadata,trust,trust_hash,provides,refs,created_at
    from teloa_market_contents where owner_id=$1 and ($2::timestamptz is null or (created_at,id)<($2::timestamptz,$3::uuid))
    order by created_at desc,id desc limit $4`,[actor.ownerId,after,value.cursor??null,Number(limit)+1])).rows as Record<string,unknown>[]
   const items=rows.slice(0,Number(limit)).map(row=>{
    if(!uuid(row.id)||!['atomic-skill','industry-template'].includes(row.kind as string)||!stableId(row.logical_id)||!semver(row.version)||!hex(row.content_hash)||!hex(row.base_hash)||typeof row.manifest_path!=='string'||!isRecord(row.metadata)||!isRecord(row.trust)||!hex(row.trust_hash)||!Array.isArray(row.provides)||!Array.isArray(row.refs))throw corrupt()
    let trust:MarketSourceTrust;try{trust=normalizeMarketSourceTrust(row.trust)}catch{throw corrupt()}if(marketTrustHash(trust)!==row.trust_hash)throw corrupt()
    return {id:row.id,ownerId:actor.ownerId,kind:row.kind as MarketContent['kind'],logicalId:row.logical_id,version:row.version,hash:row.content_hash,baseHash:row.base_hash,manifestPath:row.manifest_path,metadata:row.metadata,trust,trustHash:row.trust_hash,provides:row.provides as MarketProvidedResource[],references:row.refs as MarketContentReference[],createdAt:stamp(row.created_at)}
   })
   return {items,nextCursor:rows.length>Number(limit)?items[items.length-1]!.id:null}
  })
 }
 async getImport(actor:MarketActor,input:unknown):Promise<{receipt:MarketImportReceipt;content:MarketContent}>{
  this.authorize(actor);const value=exact(input,['requestId']);if(!uuid(value.requestId))throw bad()
  return this.tx(async client=>{
   const row=(await client.query('select * from teloa_market_imports where owner_id=$1 and request_id=$2 for share',[actor.ownerId,value.requestId])).rows[0] as Record<string,unknown>|undefined
   if(!row)throw new WorkError('teloa/not-found','市场导入记录不存在。')
   if(!uuid(row.content_id)||!isRecord(row.request_spec))throw corrupt()
   let fixedSource:MarketImportReceipt['source'];try{fixedSource=source(row.source)}catch{throw corrupt()}
   const content=await this.content(client,actor,row.content_id)
   const expected={kind:content.kind,source:fixedSource,logicalId:content.logicalId,version:content.version,hash:content.hash,baseHash:content.baseHash,manifestPath:content.manifestPath,metadata:content.metadata,trustHash:content.trustHash,references:content.references}
   if(!sameImportRequest(row.request_spec,expected))throw corrupt()
   return {receipt:{requestId:value.requestId as string,contentId:content.id,source:fixedSource,createdAt:stamp(row.created_at)},content}
  })
 }
}

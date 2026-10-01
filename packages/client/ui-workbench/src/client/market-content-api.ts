import {inspectIndustryContent} from './industry-content.ts'
import {isIndustryManifest} from './industry-manifest.ts'
import { readAtomicSkill, validateAtomicSkillMetadata, type AtomicSkillContent, type AtomicSkillMetadata } from './atomic-skill.ts'
import { atomicSkillCopy, atomicSkillItem } from './atomic-market.ts'
import type { IndustryContent } from './industry-directory.ts'
import { validateIndustryManifest, type IndustryResourceKind } from './industry-manifest.ts'
import { itemFromManifest, type MarketItem, type MarketTrust } from './market-preview.ts'
import type { IndustryInspection } from './industry-content.ts'
import {recoveryStorageError} from './recovery-error.ts'

type Call=(endpoint:string,payload:unknown)=>Promise<unknown>
export type MarketContentJournal={read:()=>string|null;write:(value:string)=>void;clear:()=>void}
type StoredFile={path:string;hash:string;bytes:Uint8Array}
type StoredReference={resourceId:string;sourceContentId:string;sourceItemId:string;sourceResourceId:string;sourceHash:string}
type StoredResource={resourceId:string;kind:IndustryResourceKind;version:string;path:string}
type StoredSummary={id:string;ownerId:string;kind:'atomic-skill'|'industry-template';logicalId:string;version:string;hash:string;baseHash:string;manifestPath:string;metadata:Record<string,unknown>;trust?:MarketTrust;trustHash?:string;provides:StoredResource[];references:StoredReference[];createdAt:string}
type StoredContent=StoredSummary&{files:StoredFile[]}
type Pending={requestId:string;kind:StoredSummary['kind'];logicalId:string;version:string;hash:string}
type PendingGithub={requestId:string;githubRequestId:string;manifestPath:string}

const resourceKinds=['role','knowledge','skill','mcp','plugin','data-source','execution-tool','work-template','plan','object-type','business-view','business-action','business-configuration'] as const
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
const hex=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value)
const date=(value:unknown):value is string=>typeof value==='string'&&Number.isFinite(Date.parse(value))
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)
const exact=(value:unknown,keys:readonly string[])=>{if(!record(value)||Object.keys(value).some(key=>!keys.includes(key)))throw Error('市场固定内容响应格式不正确。');return value}
const safePath=(value:unknown):value is string=>typeof value==='string'&&!!value&&value.length<=500&&!value.startsWith('/')&&!value.split('/').some(part=>!part||part==='.'||part==='..')&&!/[\\:?%#\u0000-\u001f\u007f]/.test(value)
const digest=async(bytes:Uint8Array)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',Uint8Array.from(bytes))),byte=>byte.toString(16).padStart(2,'0')).join('')
const stable=(value:unknown):string=>JSON.stringify(value,(_,item)=>record(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item)
const encode=(bytes:Uint8Array)=>{let out='';for(let offset=0;offset<bytes.length;offset+=0x8000)out+=String.fromCharCode(...bytes.subarray(offset,offset+0x8000));return btoa(out)}
const decode=(value:unknown)=>{
 if(typeof value!=='string'||value.length%4!==0||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))throw Error('市场固定内容文件字节格式不正确。')
 let raw:string;try{raw=atob(value)}catch{throw Error('市场固定内容文件字节格式不正确。')}
 const bytes=Uint8Array.from(raw,char=>char.charCodeAt(0));if(encode(bytes)!==value)throw Error('市场固定内容文件字节格式不正确。');return bytes
}
function atomicMetadata(value:unknown):AtomicSkillMetadata{
 const row=exact(value,['id','title','version','categories','localized'])
 if(typeof row.id!=='string'||typeof row.title!=='string'||typeof row.version!=='string'||!Array.isArray(row.categories)||row.categories.some(value=>typeof value!=='string'))throw Error('市场技能元数据格式不正确。')
 return validateAtomicSkillMetadata({id:row.id,title:row.title,version:row.version,categories:row.categories as string[],...(row.localized===undefined?{}:{localized:row.localized as NonNullable<AtomicSkillMetadata['localized']>})})
}
function references(value:unknown):StoredReference[]{
 if(!Array.isArray(value))throw Error('市场固定内容引用格式不正确。')
 return value.map(input=>{const row=exact(input,['resourceId','sourceContentId','sourceItemId','sourceResourceId','sourceHash']);if(typeof row.resourceId!=='string'||!uuid(row.sourceContentId)||typeof row.sourceItemId!=='string'||typeof row.sourceResourceId!=='string'||!hex(row.sourceHash))throw Error('市场固定内容引用格式不正确。');return row as unknown as StoredReference})
}
function provided(value:unknown):StoredResource[]{
 if(!Array.isArray(value))throw Error('市场固定内容资源格式不正确。')
 return value.map(input=>{const row=exact(input,['resourceId','kind','version','path']);if(typeof row.resourceId!=='string'||!resourceKinds.includes(row.kind as IndustryResourceKind)||typeof row.version!=='string'||!safePath(row.path))throw Error('市场固定内容资源格式不正确。');return row as unknown as StoredResource})
}
function trust(value:unknown):MarketTrust{const row=exact(value,['publisher','repository','license','signature','compatibility','plugins','externalCapabilities','permissions','review']);const repository=row.repository===null?null:exact(row.repository,['host','owner','repo']),license=exact(row.license,['status','value']),signature=exact(row.signature,['status','signer']),compatibility=exact(row.compatibility,['teloa','dsh']),review=exact(row.review,['conclusion','summary']);if(typeof row.publisher!=='string'||!row.publisher||repository&&repository.host!=='github.com'||repository&&[repository.owner,repository.repo].some(value=>typeof value!=='string'||!value)||license.status!=='missing'&&license.status!=='declared'||license.status==='declared'&&typeof license.value!=='string'||!['verified','unverified','invalid'].includes(String(signature.status))||signature.signer!==null&&typeof signature.signer!=='string'||typeof compatibility.teloa!=='string'||typeof compatibility.dsh!=='string'||!['approved','needs-review','rejected'].includes(String(review.conclusion))||typeof review.summary!=='string'||!Array.isArray(row.plugins)||!Array.isArray(row.externalCapabilities)||!Array.isArray(row.permissions))throw Error('市场来源信任声明格式不正确。');const plugins=row.plugins.map(value=>{const item=exact(value,['id','version','required']);if(typeof item.id!=='string'||typeof item.version!=='string'||typeof item.required!=='boolean')throw Error();return item}),externalCapabilities=row.externalCapabilities.map(value=>{const item=exact(value,['id','kind','required']);if(typeof item.id!=='string'||!['mcp','connection'].includes(String(item.kind))||typeof item.required!=='boolean')throw Error();return item}),permissions=row.permissions.map(value=>{const item=exact(value,['id','description','required']);if(typeof item.id!=='string'||typeof item.description!=='string'||typeof item.required!=='boolean')throw Error();return item});return {publisher:row.publisher,repository:repository as MarketTrust['repository'],license:license as MarketTrust['license'],signature:signature as MarketTrust['signature'],compatibility:compatibility as MarketTrust['compatibility'],plugins:plugins as MarketTrust['plugins'],externalCapabilities:externalCapabilities as MarketTrust['externalCapabilities'],permissions:permissions as MarketTrust['permissions'],review:review as MarketTrust['review']}}
function summary(value:unknown):StoredSummary{
 const row=exact(value,['id','ownerId','kind','logicalId','version','hash','baseHash','manifestPath','metadata','trust','trustHash','provides','references','createdAt'])
 if(!uuid(row.id)||typeof row.ownerId!=='string'||!row.ownerId||row.kind!=='atomic-skill'&&row.kind!=='industry-template'||typeof row.logicalId!=='string'||typeof row.version!=='string'||!hex(row.hash)||!hex(row.baseHash)||!safePath(row.manifestPath)||!record(row.metadata)||!date(row.createdAt))throw Error('市场固定内容响应身份不正确。')
 if((row.trust===undefined)!==(row.trustHash===undefined)||row.trustHash!==undefined&&!hex(row.trustHash))throw Error('市场来源信任声明摘要格式不正确。')
 return {id:row.id,ownerId:row.ownerId,kind:row.kind,logicalId:row.logicalId,version:row.version,hash:row.hash,baseHash:row.baseHash,manifestPath:row.manifestPath,metadata:row.metadata,...(row.trust!==undefined?{trust:trust(row.trust),trustHash:row.trustHash as string}:{}),provides:provided(row.provides),references:references(row.references),createdAt:row.createdAt}
}
async function content(value:unknown):Promise<StoredContent>{
 const row=exact(value,['id','ownerId','kind','logicalId','version','hash','baseHash','manifestPath','metadata','trust','trustHash','files','provides','references','createdAt']),head=summary(Object.fromEntries(Object.entries(row).filter(([key])=>key!=='files')))
 if(!Array.isArray(row.files)||!row.files.length)throw Error('市场固定内容文件格式不正确。')
 const paths=new Set<string>(),files:StoredFile[]=[]
 if(head.trust&&await digest(new TextEncoder().encode(stable(head.trust)))!==head.trustHash)throw Error('市场来源信任声明摘要不一致。')
 for(const input of row.files){const file=exact(input,['path','hash','base64']);if(!safePath(file.path)||!hex(file.hash)||paths.has(file.path))throw Error('市场固定内容文件格式不正确或路径重复。');const bytes=decode(file.base64);if(await digest(bytes)!==file.hash)throw Error('市场固定内容文件摘要与字节不一致。');paths.add(file.path);files.push({path:file.path,hash:file.hash,bytes})}
 files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0)
 if(head.kind==='atomic-skill'){
  const rebuilt=await readAtomicSkill(files.map(file=>({path:file.path,size:file.bytes.length,read:async()=>file.bytes})),atomicMetadata(head.metadata))
  if(rebuilt.hash!==head.hash||head.baseHash!==head.hash||rebuilt.entryPath!==head.manifestPath||rebuilt.id!==head.logicalId)throw Error('市场技能固定摘要或身份不一致。')
 }else{
  const manifest=validateIndustryManifest(head.metadata),baseHash=await digest(new TextEncoder().encode(JSON.stringify({manifestPath:head.manifestPath,files:files.map(file=>[file.path,file.hash])})))
  const fixed=head.references.length?await digest(new TextEncoder().encode(JSON.stringify([baseHash,head.references.map(({resourceId,sourceItemId,sourceResourceId,sourceHash})=>[resourceId,sourceItemId,sourceResourceId,sourceHash])]))):baseHash
  if(manifest.id!==head.logicalId||manifest.version!==head.version||baseHash!==head.baseHash||fixed!==head.hash||!files.some(file=>file.path===head.manifestPath))throw Error('市场行业模板固定摘要或身份不一致。')
 }
 return {...head,files}
}
/** 固定来源回执既可能来自本地上传，也可能来自 GitHub 归档；两种出处都按各自字段严格核对。 */
function receiptSource(value:unknown,expected:'upload'|'github'|'catalog'):void{
 if(expected==='catalog'){
  try{
   const row=exact(value,['kind','catalog','catalogVersion','entryId','entryVersion','treeHash'])
   if(row.kind!=='catalog'||row.catalog!=='teloa-official'||typeof row.catalogVersion!=='string'||!row.catalogVersion||typeof row.entryId!=='string'||!row.entryId||typeof row.entryVersion!=='string'||!row.entryVersion||!hex(row.treeHash))throw Error()
  }catch{throw Error('市场导入回执的官方目录来源不完整。')}
  return
 }
 if(expected==='github'){
  try{
   const row=exact(value,['kind','owner','repo','requestedRef','resolvedCommit','archiveHash','path'])
   if(row.path!==undefined&&!safePath(row.path))throw Error()
   if(row.kind!=='github'||typeof row.owner!=='string'||!row.owner||typeof row.repo!=='string'||!row.repo||typeof row.requestedRef!=='string'||!row.requestedRef||typeof row.resolvedCommit!=='string'||!/^[0-9a-f]{40}$/.test(row.resolvedCommit)||!hex(row.archiveHash))throw Error()
  }catch{throw Error('市场导入回执的 GitHub 来源出处不完整。')}
  return
 }
 const row=exact(value,['kind','name'])
 if(row.kind!=='upload'||typeof row.name!=='string'||!row.name)throw Error('市场导入回执的上传来源不完整。')
}
function pendingGithub(value:unknown):PendingGithub{
 const row=exact(value,['requestId','githubRequestId','manifestPath'])
 if(!uuid(row.requestId)||!uuid(row.githubRequestId)||!safePath(row.manifestPath))throw Error()
 return row as unknown as PendingGithub
}
function pending(value:unknown):Pending{
 const row=exact(value,['requestId','kind','logicalId','version','hash'])
 if(!uuid(row.requestId)||row.kind!=='atomic-skill'&&row.kind!=='industry-template'||typeof row.logicalId!=='string'||typeof row.version!=='string'||!hex(row.hash))throw Error()
 return row as unknown as Pending
}
const samePending=(a:Pending,b:Omit<Pending,'requestId'>)=>a.kind===b.kind&&a.logicalId===b.logicalId&&a.version===b.version&&a.hash===b.hash
const requestFiles=(files:readonly {path:string;bytes:Uint8Array}[])=>files.map(file=>({path:file.path,base64:encode(file.bytes)}))
const uploadTrust=(publisher:string):MarketTrust=>({publisher,repository:null,license:{status:'missing'},signature:{status:'unverified',signer:null},compatibility:{teloa:'未声明',dsh:'未声明'},plugins:[],externalCapabilities:[],permissions:[],review:{conclusion:'needs-review',summary:'本地上传来源尚未完成签名与兼容审查'}})
function summaryItem(value:StoredSummary):MarketItem{
 const storage={contentId:value.id,createdAt:value.createdAt,loaded:false},source={kind:'stored' as const,contentId:value.id}
 if(value.kind==='atomic-skill'){
  const metadata=atomicMetadata(value.metadata)
  const {status,...text}=atomicSkillCopy('stored',{title:metadata.title,localizedTitle:metadata.localized?.title}),stored={status,text}
  return {id:'atomic-'+value.hash,kind:'skill',resourceKind:'skill',title:metadata.title,version:metadata.version,scope:'general',visibility:'personal',...stored.text,author:value.trust?.publisher??'本人导入',license:value.trust?.license.status==='declared'?value.trust.license.value:'来源许可未声明',source,owner:'DSH',components:[{name:metadata.title,required:true,status:stored.status}],hash:value.hash,capabilityCategories:[...metadata.categories],...(value.trust?{trust:value.trust}:{}),contentStorage:storage}
 }
 const manifest=validateIndustryManifest(value.metadata),raw=JSON.stringify(manifest,null,2),item=itemFromManifest({manifest,raw,hash:value.hash},source)
 return {...item,id:'directory-'+value.hash,hash:value.hash,...(value.trust?{trust:value.trust}:{}),author:value.trust?.publisher??item.author,license:value.trust?.license.status==='declared'?value.trust.license.value:'来源许可未声明',contentStorage:storage,compatibility:'行业模板已固定保存；详情字节尚未读取，未加载到工作空间。'}
}
async function contentItem(value:StoredContent,sourceContents:readonly StoredContent[]=[]):Promise<MarketItem>{
 const storage={contentId:value.id,createdAt:value.createdAt,loaded:true},source={kind:'stored' as const,contentId:value.id}
 if(value.kind==='atomic-skill'){
  const metadata=atomicMetadata(value.metadata),entry=value.files.find(file=>file.path===value.manifestPath)!
  let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(entry.bytes)}catch{throw Error('市场技能正文不是 UTF-8 文本。')}
  return {...atomicSkillItem({...metadata,hash:value.hash,entryPath:value.manifestPath,files:structuredClone(value.files),text}),source,...(value.trust?{trust:value.trust}:{}),author:value.trust?.publisher??'本人导入',license:value.trust?.license.status==='declared'?value.trust.license.value:'来源许可未声明',contentStorage:storage}
 }
 const manifest=validateIndustryManifest(value.metadata),manifestFile=value.files.find(file=>file.path===value.manifestPath)!
 let raw:string;try{raw=new TextDecoder('utf-8',{fatal:true}).decode(manifestFile.bytes)}catch{throw Error('市场行业清单不是 UTF-8 文本。')}
 const root=value.manifestPath.includes('/')?value.manifestPath.slice(0,value.manifestPath.lastIndexOf('/')+1):'',paths=new Set(value.files.map(file=>file.path))
 const resolved:NonNullable<IndustryContent['resolved']>=[]
 for(const reference of value.references){
  const target=manifest.resources.find(resource=>resource.id===reference.resourceId),sourceContent=sourceContents.find(content=>content.id===reference.sourceContentId)
  if(target?.kind==='business-configuration'){
   if(target.source.kind!=='public'||!sourceContent||sourceContent.kind!=='industry-template'||sourceContent.references.length||sourceContent.hash!==reference.sourceHash||reference.sourceItemId!=='directory-'+sourceContent.baseHash)throw Error('市场业务看板固定来源不一致。')
   const sourceManifest=validateIndustryManifest(sourceContent.metadata),resource=sourceManifest.resources.find(row=>row.id===reference.sourceResourceId)
   if(!resource||resource.kind!==target.kind||resource.version!==target.version||resource.source.kind!=='local')throw Error('市场业务看板固定来源不一致。')
   const sourcePath=(sourceContent.manifestPath.includes('/')?sourceContent.manifestPath.slice(0,sourceContent.manifestPath.lastIndexOf('/')+1):'')+resource.source.path
   const inspection=inspectIndustryContent(sourceManifest,{manifestPath:sourceContent.manifestPath,hash:sourceContent.hash,files:sourceContent.files,resources:[]}).find(row=>row.id===resource.id)
   if(inspection?.state!=='parsed'||inspection.definition?.kind!=='business-configuration'||inspection.definition.definition.configuration.scope!=='template'&&inspection.definition.definition.configuration.scope!==manifest.scope)throw Error('市场业务看板内容未通过核验。')
   resolved.push({resourceId:target.id,sourceContentId:sourceContent.id,sourceItemId:reference.sourceItemId,sourceResourceId:resource.id,sourceHash:sourceContent.hash,kind:target.kind,version:target.version,inspection,sourcePath,sourceFiles:structuredClone(sourceContent.files.filter(file=>file.path===sourcePath))});continue
  }
  if(!target||target.kind!=='skill'||target.source.kind!=='public'||!sourceContent||sourceContent.kind!=='atomic-skill'||sourceContent.hash!==reference.sourceHash)throw Error('市场公共技能固定来源不一致。')
  const metadata=atomicMetadata(sourceContent.metadata),entry=sourceContent.files.find(file=>file.path===sourceContent.manifestPath);if(!entry||metadata.id!==reference.sourceResourceId)throw Error('市场公共技能固定来源不一致。')
  let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(entry.bytes)}catch{throw Error('市场公共技能正文不是 UTF-8 文本。')}
  const folder=sourceContent.manifestPath.includes('/')?sourceContent.manifestPath.slice(0,sourceContent.manifestPath.lastIndexOf('/')+1):''
  const inspection:IndustryInspection={id:target.id,state:'pending',message:'技能内容已保存，格式和运行条件待检查。',definition:{kind:'skill',text,files:sourceContent.files.map(file=>({path:file.path.slice(folder.length),hash:file.hash,size:file.bytes.length}))}}
  resolved.push({resourceId:target.id,sourceContentId:sourceContent.id,sourceItemId:reference.sourceItemId,sourceResourceId:reference.sourceResourceId,sourceHash:reference.sourceHash,sourceKind:'atomic-skill',kind:'skill',version:target.version,inspection,sourcePath:sourceContent.manifestPath,sourceFiles:structuredClone(sourceContent.files)})
 }
 const packageContent:IndustryContent={manifestPath:value.manifestPath,hash:value.hash,baseHash:value.baseHash,files:structuredClone(value.files),resolved,resources:manifest.resources.map(resource=>({id:resource.id,state:resource.source.kind==='public'?(resolved.some(row=>row.resourceId===resource.id)?'available':'unresolved'):(paths.has(root+resource.source.path)?'available':'missing')}))}
 const item=itemFromManifest({manifest,raw,hash:manifestFile.hash},source)
 return {...item,id:'directory-'+value.hash,hash:manifestFile.hash,...(value.trust?{trust:value.trust}:{}),author:value.trust?.publisher??item.author,license:value.trust?.license.status==='declared'?value.trust.license.value:'来源许可未声明',packageContent,contentStorage:storage,compatibility:'原始文件字节已固定保存；组件语义与宿主兼容性待核对，未加载到工作空间。'}
}

export type MarketContentApi=ReturnType<typeof createMarketContentApi>
export function createMarketContentApi(call:Call,journal?:MarketContentJournal,newId=()=>crypto.randomUUID(),githubJournal?:MarketContentJournal){
 let awaiting:Pending|undefined,recoveryError:ReturnType<typeof recoveryStorageError>|undefined,busy=false
 let awaitingGithub:PendingGithub|undefined,githubRecoveryError:ReturnType<typeof recoveryStorageError>|undefined
 try{const raw=journal?.read();if(raw){if(raw.length>2000)throw Error();const row=exact(JSON.parse(raw),['schema','request']);if(row.schema!=='teloa.market-content-import/v1')throw Error();awaiting=pending(row.request)}}catch{recoveryError=recoveryStorageError()}
 try{const raw=githubJournal?.read();if(raw){if(raw.length>2000)throw Error();const row=exact(JSON.parse(raw),['schema','request']);if(row.schema!=='teloa.market-import-github/v1')throw Error();awaitingGithub=pendingGithub(row.request)}}catch{githubRecoveryError=recoveryStorageError()}
 const write=()=>{if(awaiting)journal?.write(JSON.stringify({schema:'teloa.market-content-import/v1',request:awaiting}))}
 const clearedCodes=['teloa/invalid-input','teloa/forbidden','teloa/conflict','teloa/source-unavailable']
 const rejected=(error:unknown)=>!!error&&typeof error==='object'&&'rejected' in error&&error.rejected===true&&'code' in error&&clearedCodes.includes(String(error.code))
 const clear=()=>{journal?.clear();awaiting=undefined}
 const awaitingSkill=new Map<string,string>()
 const checkedResult=async(value:unknown,expected:Pending)=>{
  const row=exact(value,['receipt','content']),receipt=exact(row.receipt,['requestId','contentId','source','createdAt']);receiptSource(receipt.source,record(receipt.source)&&receipt.source.kind==='catalog'?'catalog':'upload');const stored=await content(row.content)
  if(receipt.requestId!==expected.requestId||receipt.contentId!==stored.id||!date(receipt.createdAt)||!samePending(expected,stored))throw Error('市场导入回执与原请求不一致。')
  return contentItem(stored,await Promise.all(stored.references.map(reference=>getContent(reference.sourceContentId))))
 }
 const checkedGithubResult=async(value:unknown,request:PendingGithub)=>{
  const row=exact(value,['receipt','content']),receipt=exact(row.receipt,['requestId','contentId','source','createdAt'])
  receiptSource(receipt.source,'github')
  const stored=await content(row.content)
  if(receipt.requestId!==request.requestId||receipt.contentId!==stored.id||!date(receipt.createdAt)||stored.kind!=='industry-template'||stored.manifestPath!==request.manifestPath)throw Error('GitHub 导入回执与原请求不一致。')
  return contentItem(stored,await Promise.all(stored.references.map(reference=>getContent(reference.sourceContentId))))
 }
 const getContent=async(contentId:string)=>{if(!uuid(contentId))throw Error('市场内容身份不正确。');const stored=await content(await call('market-content/get',{contentId}));if(stored.id!==contentId)throw Error('市场内容响应与目标身份不一致。');return stored}
 const send=async(payload:Record<string,unknown>,identity:Omit<Pending,'requestId'>)=>{
  if(recoveryError)throw recoveryError;if(busy)throw Error('市场导入正在核对。')
  if(awaiting&&!samePending(awaiting,identity))throw Error('请先恢复同一市场导入请求，再导入其他内容。')
  awaiting??={requestId:newId(),...identity};busy=true
  try{write();const result=await checkedResult(await call('market-content/import',{...payload,requestId:awaiting.requestId}),awaiting);clear();return result}
  catch(error){if(rejected(error))clear();throw error}finally{busy=false}
 }
 return {
  pending:()=>awaiting?structuredClone(awaiting):undefined,
  recoveryMessage:()=>recoveryError,
  /** 丢弃只清本地恢复记录，不通知服务端（规格 §二 D4）。 */
  discard(){const had=awaiting!==undefined||recoveryError!==undefined;try{journal?.clear()}catch{/* 清不掉不该变成第二道墙 */}awaiting=undefined;recoveryError=undefined;return had},
  async recover(){
   if(recoveryError)throw recoveryError;if(!awaiting)throw Error('没有待核对的市场导入请求。');if(busy)throw Error('市场导入正在核对。');busy=true
   try{const item=await checkedResult(await call('market-content/receipt',{requestId:awaiting.requestId}),awaiting);clear();return item}
   catch(error){if(error&&typeof error==='object'&&'rejected' in error&&error.rejected===true&&'code' in error&&error.code==='teloa/not-found')throw Error('服务尚未找到该请求；请重新选择原文件，以同一请求继续核对，不能新建请求。');throw error}finally{busy=false}
  },
  async importAtomic(value:AtomicSkillContent,name:string){
   if(!name.trim())throw Error('上传来源名称不能为空。')
   const identity={kind:'atomic-skill' as const,logicalId:value.id,version:value.version,hash:value.hash}
   return send({kind:'atomic-skill',source:{kind:'upload',name:name.trim()},metadata:{id:value.id,title:value.title,version:value.version,categories:[...value.categories],...(value.localized?{localized:value.localized}:{})},trust:uploadTrust(name.trim()),files:requestFiles(value.files)},identity)
  },
  async importIndustry(item:MarketItem){
   if(item.source.kind!=='upload')throw Error('首批行业模板持久化只接受上传来源。')
   if(!isIndustryManifest(item.manifest)||!item.packageContent)throw Error('请先读取完整行业模板原始文件。')
   const publicResources=item.manifest.resources.filter(resource=>resource.source.kind==='public')
   if(publicResources.some(resource=>resource.kind!=='skill'&&resource.kind!=='business-configuration'))throw Error('固定引用只支持技能或完整业务看板配置。')
   const resolved=item.packageContent.resolved??[]
   const fixed=publicResources.map(resource=>{const value=resolved.find(row=>row.resourceId===resource.id);if(!value?.sourceContentId||!uuid(value.sourceContentId))throw Error('公共技能必须选择带真实 contentId 的已持久化来源。');return {resourceId:value.resourceId,sourceContentId:value.sourceContentId,sourceItemId:value.sourceItemId,sourceResourceId:value.sourceResourceId,sourceHash:value.sourceHash}})
   const identity={kind:'industry-template' as const,logicalId:item.manifest.id,version:item.manifest.version,hash:item.packageContent.hash}
   return send({kind:'industry-template',source:{kind:'upload',name:item.source.name},manifestPath:item.packageContent.manifestPath,trust:item.trust??uploadTrust(item.source.name),files:requestFiles(item.packageContent.files),references:fixed},identity)
  },
  pendingGithubImport:()=>awaitingGithub?structuredClone(awaitingGithub):undefined,
  githubRecoveryMessage:()=>githubRecoveryError,
  /** 丢弃 GitHub 导入的本地恢复记录，不通知服务端（规格 §二 D4）。 */
  discardGithubImport(){const had=awaitingGithub!==undefined||githubRecoveryError!==undefined;try{githubJournal?.clear()}catch{/* 清不掉不该变成第二道墙 */}awaitingGithub=undefined;githubRecoveryError=undefined;return had},
  /** GitHub 固定来源子目录导入为原子 Skill；同一来源与路径在失败后沿用原请求 ID 重试，宿主按请求身份重放原回执。 */
  async importGithubSkill({githubRequestId,skillPath}:{githubRequestId:string;skillPath:string}){
   if(busy)throw Error('市场导入正在核对。')
   if(!uuid(githubRequestId)||!safePath(skillPath)||(skillPath!=='SKILL.md'&&!skillPath.endsWith('/SKILL.md')))throw Error('GitHub 固定来源身份或技能路径不正确。')
   const key=githubRequestId+'\u0000'+skillPath,requestId=awaitingSkill.get(key)??newId();awaitingSkill.set(key,requestId);busy=true
   try{
    const value=await call('market-content/import-github-skill',{requestId,githubRequestId,skillPath})
    const row=exact(value,['receipt','content']),receipt=exact(row.receipt,['requestId','contentId','source','createdAt'])
    receiptSource(receipt.source,'github')
    const stored=await content(row.content)
    if(receipt.requestId!==requestId||receipt.contentId!==stored.id||!date(receipt.createdAt)||stored.kind!=='atomic-skill'||stored.manifestPath!==skillPath)throw Error('GitHub 导入回执与原请求不一致。')
    awaitingSkill.delete(key)
    return contentItem(stored)
   }catch(error){if(rejected(error))awaitingSkill.delete(key);throw error}finally{busy=false}
  },
  /** GitHub 固定来源导入为行业模板；同一来源与清单沿用原 requestId 重试，宿主按请求身份重放原回执。 */
  async importGithub({githubRequestId,manifestPath}:{githubRequestId:string;manifestPath:string}){
   if(githubRecoveryError)throw githubRecoveryError
   if(busy)throw Error('市场导入正在核对。')
   if(!uuid(githubRequestId)||!safePath(manifestPath))throw Error('GitHub 固定来源身份或清单路径不正确。')
   if(awaitingGithub&&(awaitingGithub.githubRequestId!==githubRequestId||awaitingGithub.manifestPath!==manifestPath))throw Error('请先恢复同一 GitHub 导入请求，再导入其他固定来源。')
   awaitingGithub??={requestId:newId(),githubRequestId,manifestPath};busy=true
   const request=awaitingGithub
   try{
    githubJournal?.write(JSON.stringify({schema:'teloa.market-import-github/v1',request}))
    const item=await checkedGithubResult(await call('market-content/import-github',{...request}),request)
    githubJournal?.clear();awaitingGithub=undefined
    return item
   }catch(error){if(rejected(error)){githubJournal?.clear();awaitingGithub=undefined}throw error}finally{busy=false}
  },
  /**
   * 回包丢失后按原 requestId 找回 GitHub 导入回执。
   * 宿主确认没有这笔请求时释放日志：导入与回执在同一事务里落盘，找不到即从未写入，
   * 重新获取固定来源会得到新的 githubRequestId，保留旧日志只会挡住后续导入。
   */
  async recoverGithubImport(){
   if(githubRecoveryError)throw githubRecoveryError
   if(!awaitingGithub)throw Error('没有待核对的 GitHub 导入请求。')
   if(busy)throw Error('市场导入正在核对。')
   busy=true;const request=awaitingGithub
   try{
    const item=await checkedGithubResult(await call('market-content/receipt',{requestId:request.requestId}),request)
    githubJournal?.clear();awaitingGithub=undefined
    return item
   }catch(error){
    if(error&&typeof error==='object'&&'rejected' in error&&error.rejected===true&&'code' in error&&error.code==='teloa/not-found'){
     githubJournal?.clear();awaitingGithub=undefined
     throw Error('服务没有这笔 GitHub 导入请求，之前的提交没有生效；请重新获取同一固定来源后再次导入。')
    }
    throw error
   }finally{busy=false}
  },
  async list(){
   const seen=new Set<string>(),cursors=new Set<string>(),items:MarketItem[]=[];let cursor:string|undefined
   do{
    if(cursor){if(cursors.has(cursor))throw Error('市场固定内容目录游标重复。');cursors.add(cursor)}
    const value=exact(await call('market-content/list',{...(cursor?{cursor}:{}),limit:100}),['items','nextCursor'])
    if(!Array.isArray(value.items)||value.nextCursor!==null&&!uuid(value.nextCursor))throw Error('市场固定内容目录格式不正确。')
    for(const input of value.items){const row=summary(input);if(seen.has(row.id))throw Error('市场固定内容目录含重复身份。');seen.add(row.id);items.push(summaryItem(row))}
    cursor=value.nextCursor??undefined
   }while(cursor)
   return items
  },
  async hydrate(item:MarketItem){
   const contentId=item.contentStorage?.contentId;if(!contentId)throw Error('市场目录项没有真实 contentId。')
   const stored=await getContent(contentId),sources=await Promise.all(stored.references.map(reference=>getContent(reference.sourceContentId)))
   const expectedKind=item.kind==='skill'?'atomic-skill':item.kind==='bundle'?'industry-template':undefined
   if(item.contentStorage?.loaded===false&&(stored.kind!==expectedKind||item.id!==(stored.kind==='atomic-skill'?'atomic-':'directory-')+stored.hash||item.version!==stored.version||item.hash!==stored.hash))throw Error('市场内容与目录摘要不一致。')
   return contentItem(stored,sources)
  }
 }
}

import {readPageCreateAtomicSkillDraft,skillFrontmatterName,readIndustryModelDependencies,type IndustryModelDependency} from '@teloa/contract'
import {readAtomicSkill,type AtomicSkillContent} from './atomic-skill.ts'
import type {AtomicSkillDerivationBinding,AtomicSkillRequirements,MarketContentApi} from './market-content-api.js'
import type {MarketItem,MarketTrust} from './market-preview.js'
import type {SkillInstallApi,SkillInstallationRecord,SkillInstallSourceIdentity} from './skill-install-api.js'
import {installationSourceInput} from './real-skill-installation-state.ts'

type File={path:string;hash:string;bytes:Uint8Array}
export type SkillDerivativeOrigin={source:SkillInstallSourceIdentity;bundleHash:string;nativeName:string;publisher:string;license:string;declaredLicense?:string;modelDependencies?:IndustryModelDependency[];requirements?:AtomicSkillRequirements;sourcePackageDeclarations?:AtomicSkillRequirements&Pick<MarketTrust,'license'|'publisher'>}
export type SkillDerivativeFile=File&{text?:string;locked:boolean}
export type SkillDerivativeDraft={origin:SkillDerivativeOrigin;title:string;version:string;categories:string[];files:SkillDerivativeFile[]}
const sha=async(bytes:Uint8Array)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',Uint8Array.from(bytes))),byte=>byte.toString(16).padStart(2,'0')).join('')
const canonical=(value:unknown):string=>JSON.stringify(value,(_,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a<b?-1:a>b?1:0)):item)
const ordered=(files:readonly File[])=>[...files].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0)
const licenseFile=(path:string)=>/(?:^|\/)(?:licen[cs]e|copying|notice)(?:\.[^/]*)?$/i.test(path)
const inputs=(files:readonly {path:string;bytes:Uint8Array}[])=>files.map(file=>({path:file.path,size:file.bytes.length,read:async()=>Uint8Array.from(file.bytes)}))
const base64=(bytes:Uint8Array)=>{let value='';for(let offset=0;offset<bytes.length;offset+=0x8000)value+=String.fromCharCode(...bytes.subarray(offset,offset+0x8000));return btoa(value)}
const textOf=(bytes:Uint8Array)=>{try{const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);return /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)?undefined:text}catch{return undefined}}
const requirements=(trust:MarketTrust):AtomicSkillRequirements=>structuredClone({compatibility:trust.compatibility,plugins:trust.plugins,externalCapabilities:trust.externalCapabilities,permissions:trust.permissions})
function renameEntry(text:string,name:string){
 const match=/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
 if(!match||match[1]!.split(/\r?\n/).filter(line=>/^name:\s*/.test(line)).length!==1)throw Error('技能入口名称不明确，不能创建派生版本。')
 return text.replace(/^(---\r?\n[\s\S]*?)^name:[^\r\n]*/m,(_,prefix:string)=>prefix+'name: '+name)
}

/** 只读原安装固定来源，并以实际安装预览的逐文件摘要核对完整目录；不执行或安装。 */
export async function loadSkillDerivative(api:Pick<SkillInstallApi,'get'|'preview'>,contentApi:Pick<MarketContentApi,'list'|'hydrate'>,record:SkillInstallationRecord,token:string=crypto.randomUUID()):Promise<SkillDerivativeDraft>{
 const current=await api.get(record.id)
 if(current.id!==record.id||current.ownerId!==record.ownerId||current.state!=='installed'||canonical(skillDerivativeBinding(current))!==canonical(skillDerivativeBinding(record)))throw Error('原技能不属于当前本人或固定来源已变化。')
 const preview=await api.preview(installationSourceInput(record.source))
 if(preview.bundleHash!==record.bundleHash||canonical(preview.source)!==canonical(record.source))throw Error('原技能来源或版本已变化，请重新打开详情后再创建副本。')
 const source=record.source,contentId=source.kind==='industry-public'?source.sourceContentId:source.contentId,contentHash=source.kind==='industry-public'?source.sourceContentHash:source.contentHash
 const summaries=await contentApi.list(),summary=summaries.find(item=>item.contentStorage?.contentId===contentId)
 if(!summary||summary.hash!==contentHash)throw Error('找不到原技能的完整固定内容，未创建副本。')
 const item=await contentApi.hydrate(summary)
 if(item.contentStorage?.contentId!==contentId||!item.contentStorage.loaded)throw Error('原技能固定内容身份不一致。')
 let entry:string,files:readonly File[],title=item.title,categories=item.capabilityCategories??[],modelDependencies:IndustryModelDependency[]|undefined,sourcePackageDeclarations:SkillDerivativeOrigin['sourcePackageDeclarations']=source.kind==='industry-local'&&item.trust?{...requirements(item.trust),license:structuredClone(item.trust.license),publisher:item.trust.publisher}:undefined
 if(item.atomicSkill){entry=item.atomicSkill.entryPath;files=item.atomicSkill.files;modelDependencies=item.atomicSkill.modelDependencies;if(item.atomicSkill.hash!==contentHash)throw Error('原技能内容摘要不一致。')}
 else{
  const content=item.packageContent,manifest=item.manifest
  if(!content||!manifest||!('resources'in manifest)||content.hash!==contentHash)throw Error('原方案缺少完整技能文件。')
  const resource=manifest.resources.find(row=>row.id===source.resourceId)
  if(!resource||resource.kind!=='skill'||resource.version!==source.resourceVersion||resource.source.kind!=='local')throw Error('原技能资源映射不一致。')
  entry=(content.manifestPath.includes('/')?content.manifestPath.slice(0,content.manifestPath.lastIndexOf('/')+1):'')+resource.source.path;files=content.files;title=resource.title;categories=[];modelDependencies=resource.modelDependencies
 }
 if(source.kind==='industry-public'){
  const parentSummary=summaries.find(row=>row.contentStorage?.contentId===source.contentId)
  if(!parentSummary||parentSummary.hash!==source.contentHash)throw Error('原方案固定来源缺失，不能丢弃技能的配套声明。')
  const parent=await contentApi.hydrate(parentSummary),resource=parent.manifest&&'resources'in parent.manifest?parent.manifest.resources.find(row=>row.id===source.resourceId):undefined
  if(!parent.packageContent||parent.packageContent.hash!==source.contentHash||!resource||resource.kind!=='skill'||resource.version!==source.resourceVersion||resource.source.kind!=='public'||resource.source.id!==source.sourceResourceId||resource.source.version!==source.sourceResourceVersion)throw Error('原方案技能配套声明来源不一致。')
  if(parent.trust)sourcePackageDeclarations={...requirements(parent.trust),license:structuredClone(parent.trust.license),publisher:parent.trust.publisher}
  const combined=[...modelDependencies??[],...resource.modelDependencies??[]],unique=new Map<string,IndustryModelDependency>()
  for(const dependency of combined){const key=dependency.catalogId+'\0'+dependency.usage,previous=unique.get(key);if(previous&&previous.version!==dependency.version)throw Error('原技能与方案的模型版本要求冲突，不能派生为缺失条件的副本。');unique.set(key,{...dependency,required:dependency.required||previous?.required===true})}
  modelDependencies=unique.size?readIndustryModelDependencies([...unique.values()]):undefined
 }
 if(modelDependencies!==undefined)modelDependencies=readIndustryModelDependencies(modelDependencies)
 const root=entry.includes('/')?entry.slice(0,entry.lastIndexOf('/')+1):'',bundle=ordered(files.filter(file=>file.path.startsWith(root)).map(file=>({...file,path:file.path.slice(root.length),bytes:Uint8Array.from(file.bytes)})))
 if(bundle.filter(file=>file.path==='SKILL.md').length!==1||bundle.some(file=>file.path!=='SKILL.md'&&file.path.endsWith('/SKILL.md')))throw Error('原技能入口不明确。')
 for(const file of bundle)if(await sha(file.bytes)!==file.hash)throw Error('原技能文件摘要不一致：'+file.path)
 const actual=await sha(new TextEncoder().encode(JSON.stringify(bundle.map(file=>[file.path,file.hash]))))
 if(actual!==record.bundleHash||canonical(bundle.map(file=>({path:file.path,hash:file.hash,size:file.bytes.length})))!==canonical(preview.files))throw Error('原技能配套文件与安装记录不一致。')
 const name=('my-'+record.native.name.slice(0,85).replace(/-+$/,'')+'-'+token.replace(/-/g,'').slice(0,8)).toLowerCase()
 const result=bundle.map(file=>{const text=textOf(file.bytes);return {...file,...(text===undefined?{}:{text:file.path==='SKILL.md'?renameEntry(text,name):text}),locked:licenseFile(file.path)||text===undefined}})
 return {origin:{source:structuredClone(source),bundleHash:record.bundleHash,nativeName:record.native.name,publisher:item.author,license:item.license,...(item.trust?.license.status==='declared'?{declaredLicense:item.trust.license.value}:{}),...(modelDependencies?{modelDependencies}:{}),...(item.atomicSkill&&item.trust?{requirements:requirements(item.trust)}:{}),...(sourcePackageDeclarations?{sourcePackageDeclarations}:{})},title,version:'1.0.0',categories:[...categories],files:result}
}

/** 原许可与二进制原字节保留；派生来源随 SKILL.md 保存，确认保存不等于安装或采用。 */
export async function buildSkillDerivative(draft:SkillDerivativeDraft,installedNames:readonly string[]=[]):Promise<AtomicSkillContent>{
 const entry=draft.files.find(file=>file.path==='SKILL.md'),name=entry?.text&&skillFrontmatterName(entry.text)
 if(!name||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)||name.length>120||name.startsWith('teloa-'))throw Error('请在 SKILL.md 中填写有效的独立技能名称。')
 if(name===draft.origin.nativeName||installedNames.includes(name))throw Error('请为派生版本使用独立技能名称，避免覆盖已有技能。')
 for(const file of draft.files)if(await sha(file.bytes)!==file.hash)throw Error('原技能文件摘要不一致：'+file.path)
 const origin=JSON.stringify({format:'teloa.skill-derivation/v1',...draft.origin}).replace(/</g,'\\u003c').replace(/>/g,'\\u003e')
 const files=draft.files.map(file=>{
  if(file.locked||licenseFile(file.path)||textOf(file.bytes)===undefined)return {path:file.path,bytes:Uint8Array.from(file.bytes)}
  const text=file.path==='SKILL.md'?file.text+'\n\n<!-- '+origin+' -->\n':file.text!
  return {path:file.path,bytes:new TextEncoder().encode(text)}
 })
 const metadata={id:name,title:draft.title,version:draft.version,categories:draft.categories,...(draft.origin.modelDependencies?{modelDependencies:draft.origin.modelDependencies}:{})}
 readPageCreateAtomicSkillDraft({...metadata,files:files.map(file=>({path:file.path,base64:base64(file.bytes)}))})
 return readAtomicSkill(inputs(files),metadata)
}

export function derivativeSourceName(draft:SkillDerivativeDraft){return 'Local copy: '+draft.title}
export function derivativeSavedItem(item:MarketItem){if(item.kind!=='skill'||!item.contentStorage?.loaded||!item.atomicSkill)throw Error('技能保存回执缺少完整内容。');return item}
export function skillDerivativeBinding(record:SkillInstallationRecord):AtomicSkillDerivationBinding{return {ownerId:record.ownerId,installationId:record.id,bundleHash:record.bundleHash,sourceIdentity:canonical(record.source)}}
export function verifySkillDerivativeOrigin(item:MarketItem,origin:SkillDerivativeOrigin){
 const content=derivativeSavedItem(item).atomicSkill!,match=/<!-- (\{[^\n]*"format":"teloa\.skill-derivation\/v1"[^\n]*\}) -->\s*$/.exec(content.text)
 let actual:unknown;try{actual=match&&JSON.parse(match[1]!)}catch{}
 if(canonical(actual)!==canonical({format:'teloa.skill-derivation/v1',...origin}))throw Error('保存版本的派生来源与当前原技能不一致。')
 return item
}

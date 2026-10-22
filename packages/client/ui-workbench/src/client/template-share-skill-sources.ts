import type {IndustryLoadApi} from './industry-load-api.ts'
import {readIndustryFiles} from './industry-directory.ts'
import {isIndustryManifest} from './industry-manifest.ts'
import type {MarketContentApi} from './market-content-api.ts'
import type {MarketItem} from './market-preview.ts'
import type {ShareSkillSource} from './share-package-plan.ts'
import type {SkillInstallApi,SkillInstallationRecord,SkillInstallPreview} from './skill-install-api.ts'

type Ports={skills:Pick<SkillInstallApi,'list'|'preview'>;contents:Pick<MarketContentApi,'hydrate'>;loads:Pick<IndustryLoadApi,'get'>}
export type ShareSkillSelection={installationId:string}
const unavailable=()=>Object.assign(Error('The installed skill’s fixed sharing source is unavailable.'),{code:'teloa/source-unavailable'})
const stable=(value:unknown):string=>JSON.stringify(value&&typeof value==='object'?Array.isArray(value)?value.map(item=>JSON.parse(stable(item))):Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,item])=>[key,JSON.parse(stable(item))])):value)
const digest=async(value:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),byte=>byte.toString(16).padStart(2,'0')).join('')
/** SKILL.md 可自行声明单行许可；仅读取首个 frontmatter，不从正文、重复键或复杂 YAML 猜测许可。 */
function frontmatterLicense(text:string):string|undefined{
 const header=/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1]
 const lines=header?.split(/\r?\n/).filter(line=>/^license:/.test(line))??[]
 if(lines.length!==1)return
 const match=/^license:[ \t]*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([A-Za-z0-9][A-Za-z0-9 .+()-]*))[ \t]*$/.exec(lines[0]!)
 const value=(match?.[1]??match?.[2]??match?.[3])?.trim()
 return value&&value.length<=200?value:undefined
}
async function staticSource(record:SkillInstallationRecord,item:MarketItem,entry:string,original:NonNullable<MarketItem['packageContent']>['files'],preview:SkillInstallPreview):Promise<Pick<ShareSkillSource,'text'|'files'|'license'|'publisher'>>{
 const folder=entry.includes('/')?entry.slice(0,entry.lastIndexOf('/')+1):''
 if(entry.slice(folder.length)!=='SKILL.md'||!original.length||original.filter(file=>file.path.split('/').at(-1)==='SKILL.md').length!==1||original.some(file=>!file.path.startsWith(folder)))throw unavailable()
 const files=await readIndustryFiles(original.map(file=>({path:file.path.slice(folder.length),size:file.bytes.length,read:async()=>file.bytes})))
 if(files.some(file=>file.hash!==original.find(old=>old.path===folder+file.path)?.hash))throw unavailable()
 const bundleHash=await digest(JSON.stringify(files.map(file=>[file.path,file.hash])))
 if(stable(preview.source)!==stable(record.source)||bundleHash!==record.bundleHash||preview.bundleHash!==record.bundleHash||stable(preview.native)!==stable(record.native)||preview.trustHash!==record.trustHash||stable(preview.files)!==stable(files.map(file=>({path:file.path,hash:file.hash,size:file.bytes.length}))))throw unavailable()
 // ignoreBOM 保留原文件里的 BOM；致命 UTF-8 校验防止替换字符改变原始字节。
 let texts:{path:string;text:string}[]
 try{texts=files.map(file=>({path:file.path,text:new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(file.bytes)}))}catch{throw unavailable()}
 const text=texts.find(file=>file.path==='SKILL.md')!.text
 const license=item.trust?.license.status==='declared'?item.trust.license.value.trim():frontmatterLicense(text)
 if(!license)return {}
 return {text,files:texts,license,...(item.trust?.publisher?{publisher:item.trust.publisher}:{})}
}
async function localSource(record:SkillInstallationRecord,ports:Ports):Promise<Pick<ShareSkillSource,'text'|'files'|'license'|'publisher'>>{
 const source=record.source
 if(source.kind!=='industry-local')throw unavailable()
 const load=await ports.loads.get(source.loadId),mapped=load.items.find(item=>item.instanceId===source.itemInstanceId)
 if(load.id!==source.loadId||load.ownerId!==record.ownerId||load.contentId!==source.contentId||load.contentHash!==source.contentHash||mapped?.kind!=='skill'||mapped.localId!==source.resourceId||mapped.version!==source.resourceVersion)throw unavailable()
 const item=await ports.contents.hydrate({kind:'bundle',contentStorage:{contentId:source.contentId,createdAt:record.createdAt,loaded:true}} as MarketItem)
 const content=item.packageContent,manifest=item.manifest
 if(item.contentStorage?.contentId!==source.contentId||!content||content.hash!==source.contentHash||!isIndustryManifest(manifest)||manifest.id!==load.templateId||manifest.version!==load.templateVersion)throw unavailable()
 const resource=manifest.resources.find(row=>row.id===source.resourceId)
 if(resource?.kind!=='skill'||resource.version!==source.resourceVersion||resource.source.kind!=='local')throw unavailable()
 const root=content.manifestPath.includes('/')?content.manifestPath.slice(0,content.manifestPath.lastIndexOf('/')+1):'',entry=root+resource.source.path,folder=entry.includes('/')?entry.slice(0,entry.lastIndexOf('/')+1):''
 const original=content.files.filter(file=>file.path.startsWith(folder))
 const preview=await ports.skills.preview({kind:'industry',loadId:source.loadId,itemInstanceId:source.itemInstanceId})
 return staticSource(record,item,entry,original,preview)
}
/** 分享按员工绑定的原生名读取本人安装来源；只返回许可允许的静态内容。 */
export async function resolveTemplateShareSkills(names:readonly string[],ports:Ports,selection?:ShareSkillSelection):Promise<ShareSkillSource[]>{
 if(selection&&names.length!==1)throw unavailable()
 const listed=await ports.skills.list()
 return Promise.all(names.map(async(name):Promise<ShareSkillSource>=>{
  const record=selection?listed.items.find(row=>row.id===selection.installationId):listed.items.find(row=>row.native.name===name&&row.state==='installed')
  if(selection&&(!record||record.native.name!==name||record.state!=='installed'))throw unavailable()
  if(!record)return {name}
  const base:ShareSkillSource={name,title:record.native.name,resourceId:record.source.resourceId,version:record.source.resourceVersion}
  if(record.source.kind==='industry-public')return {...base,publicId:record.source.sourceResourceId,version:record.source.sourceResourceVersion}
  if(record.source.kind==='industry-local')return {...base,...await localSource(record,ports)}
  if(record.source.kind!=='atomic')throw unavailable()
  const item=await ports.contents.hydrate({kind:'skill',contentStorage:{contentId:record.source.contentId,createdAt:record.createdAt,loaded:true}} as MarketItem),content=item.atomicSkill
  if(item.contentStorage?.contentId!==record.source.contentId||!content||content.hash!==record.source.contentHash||content.id!==record.source.resourceId||content.version!==record.source.resourceVersion)throw unavailable()
  const preview=await ports.skills.preview({kind:'atomic',contentId:record.source.contentId})
  return {...base,...await staticSource(record,item,content.entryPath,content.files,preview)}
 }))
}

import {isIndustryManifest} from './industry-manifest.ts'
import type { IndustryContent } from './industry-directory.ts'
import { inspectIndustryContent, type IndustryInspection } from './industry-content.ts'
import type { IndustryResourceKind } from './industry-manifest.ts'
import type { MarketItem } from './market-preview.ts'
export type IndustryReferenceChoice={resourceId:string;sourceContentId?:string;sourceItemId:string;sourceResourceId:string;sourceHash:string}
export type ResolvedIndustryReference=IndustryReferenceChoice&{sourceKind?:'atomic-skill';kind:IndustryResourceKind;version:string;inspection:IndustryInspection;sourcePath:string;sourceFiles:IndustryContent['files']}

export async function prepareIndustryReferenceCandidates(item:MarketItem,items:readonly MarketItem[],hydrate:(item:MarketItem)=>Promise<MarketItem>):Promise<MarketItem[]>{
 const manifest=item.manifest
 if(!isIndustryManifest(manifest))throw Error('请先读取完整 v2/v3 行业模板。')
 const references=manifest.resources.filter(resource=>resource.source.kind==='public')
 if(references.some(resource=>resource.kind!=='skill'&&resource.kind!=='business-configuration'))throw Error('首批持久化只支持公共技能引用。')
 if(!references.length)return [...items]
 const hydrated=await Promise.all(items.map(candidate=>(candidate.kind==='skill'||references.some(row=>row.kind==='business-configuration')&&candidate.kind==='bundle')&&candidate.contentStorage&&!candidate.contentStorage.loaded?hydrate(candidate):Promise.resolve(candidate)))
 const merged:MarketItem[]=[]
 for(const candidate of hydrated){const index=merged.findIndex(row=>row.contentStorage?.contentId===candidate.contentStorage?.contentId||row.id===candidate.id);if(index<0)merged.push(candidate);else if(candidate.contentStorage||!merged[index]?.contentStorage)merged[index]=candidate}
 return merged
}

export function referenceCandidates(item:MarketItem,items:readonly MarketItem[],resourceId:string):IndustryReferenceChoice[]{
 const manifest=isIndustryManifest(item.manifest)?item.manifest:undefined
 const target=manifest?.resources.find(row=>row.id===resourceId)
 if(!manifest||target?.source.kind!=='public'||['plan','plugin'].includes(target.kind))return []
 const reference=target.source
 return items.flatMap(source=>{
  if(source.atomicSkill){
   const skill=source.atomicSkill
   return target.kind==='skill'&&source.contentStorage?.contentId&&skill.id===reference.id&&skill.version===reference.version?[{resourceId,sourceContentId:source.contentStorage.contentId,sourceItemId:source.id,sourceResourceId:skill.id,sourceHash:skill.hash}]:[]
  }
  if(source.id===item.id||!isIndustryManifest(source.manifest)||!source.packageContent)return []
  const resource=source.manifest.resources.find(row=>row.id===reference.id&&row.kind===target.kind&&row.version===reference.version&&row.source.kind==='local')
  if(!resource)return []
  const inspection=inspectIndustryContent(source.manifest,source.packageContent).find(row=>row.id===resource.id)
  if(!inspection||!['parsed','pending'].includes(inspection.state))return []
  if(inspection.definition?.kind==='work-template'&&inspection.definition.manifest.domain!=='general'&&inspection.definition.manifest.domain!==manifest.scope)return []
  if(inspection.definition?.kind==='business-configuration'&&inspection.definition.definition.configuration.scope!=='template'&&inspection.definition.definition.configuration.scope!==manifest.scope)return []
  if(target.kind==='business-configuration'&&(!source.contentStorage?.contentId||source.packageContent.resolved?.length))return []
  return [{resourceId,...(target.kind==='business-configuration'&&source.contentStorage?.contentId?{sourceContentId:source.contentStorage.contentId}:{}),sourceItemId:target.kind==='business-configuration'?'directory-'+(source.packageContent.baseHash??source.packageContent.hash):source.id,sourceResourceId:resource.id,sourceHash:source.packageContent.hash}]
 })
}

/** 用户明确选择已取得的内容；不会扩大来源可见范围或共享原凭据。 */
export async function resolveIndustryReferences(item:MarketItem,items:readonly MarketItem[],choices:readonly IndustryReferenceChoice[]):Promise<MarketItem>{
 const manifest=item.manifest,content=item.packageContent
 if(!isIndustryManifest(manifest)||!content)throw Error('请先读取行业目录。')
 if(new Set(choices.map(row=>row.resourceId)).size!==choices.length)throw Error('公共引用选择重复。')
 const resolved:ResolvedIndustryReference[]=choices.map((choice):ResolvedIndustryReference=>{
  const match=referenceCandidates(item,items,choice.resourceId).find(row=>row.sourceContentId===choice.sourceContentId&&row.sourceItemId===choice.sourceItemId&&row.sourceResourceId===choice.sourceResourceId&&row.sourceHash===choice.sourceHash)
  if(!match)throw Error('引用来源不存在、版本不匹配或内容已变化，请重新选择。')
  const source=items.find(row=>row.contentStorage?.contentId===match.sourceContentId&&match.sourceContentId!==undefined||row.id===match.sourceItemId)!
  if(source.atomicSkill){
   const skill=source.atomicSkill,root=skill.entryPath.slice(0,skill.entryPath.lastIndexOf('/')+1)
   const inspection:IndustryInspection={id:skill.id,state:'pending',message:'技能内容已读取，格式和运行条件待检查。',definition:{kind:'skill',text:skill.text,files:skill.files.map(file=>({path:file.path.slice(root.length),hash:file.hash,size:file.bytes.length}))}}
   return {...match,sourceKind:'atomic-skill',kind:'skill',version:skill.version,inspection,sourcePath:skill.entryPath,sourceFiles:structuredClone(skill.files)}
  }
  if(!isIndustryManifest(source.manifest)||!source.packageContent)throw Error('引用来源尚未读取。')
  const target=manifest.resources.find(row=>row.id===choice.resourceId)!
  const inspection=inspectIndustryContent(source.manifest,source.packageContent).find(row=>row.id===match.sourceResourceId)!
  const sourceResource=source.manifest.resources.find(row=>row.id===match.sourceResourceId)!
  if(sourceResource.source.kind!=='local')throw Error('引用必须有实际本地内容。')
  const root=source.packageContent.manifestPath.includes('/')?source.packageContent.manifestPath.slice(0,source.packageContent.manifestPath.lastIndexOf('/')+1):''
  const sourcePath=root+sourceResource.source.path
  const folder=sourcePath.includes('/')?sourcePath.slice(0,sourcePath.lastIndexOf('/')+1):''
  const sourceFiles=source.packageContent.files.filter(file=>file.path===sourcePath||(target.kind==='skill'&&file.path.startsWith(folder)))
  return {...match,kind:target.kind,version:target.version,inspection:structuredClone(inspection),sourcePath,sourceFiles:structuredClone(sourceFiles)}
 }).sort((a,b)=>a.resourceId<b.resourceId?-1:a.resourceId>b.resourceId?1:0)
 const baseHash=content.baseHash||content.hash
 const identity=JSON.stringify([baseHash,resolved.map(({resourceId,sourceItemId,sourceResourceId,sourceHash})=>[resourceId,sourceItemId,sourceResourceId,sourceHash])])
 const hash=resolved.length?Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(identity))),byte=>byte.toString(16).padStart(2,'0')).join(''):baseHash
 return {...item,id:resolved.length?'resolved-'+hash:'directory-'+baseHash,packageContent:{...content,baseHash,hash,resolved,resources:content.resources.map(row=>{
  const resource=manifest.resources.find(resource=>resource.id===row.id)!
  return resource.source.kind==='public'?{...row,state:resolved.some(ref=>ref.resourceId===row.id)?'available':'unresolved'}:row
 })},compatibility:'引用选择与内容版本已固定；未安装或获得运行权限。'}
}

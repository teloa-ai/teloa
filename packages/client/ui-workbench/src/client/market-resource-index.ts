import {isIndustryManifest} from './industry-manifest.ts'
import type {MarketItem} from './market-preview.ts'
import type {IndustryResourceKind} from './industry-manifest.ts'
import type {LocalizedMetadata} from '@teloa/contract'

export type MarketResourceUse={templateId:string;templateTitle:string;localizedTitle?:LocalizedMetadata;industry:string;resourceId:string}
export const resourceVisibilityLabels={public:'公共',personal:'本人',team:'团队（演示）',unknown:'来源待核对'} as const
export type MarketResourceVisibility=keyof typeof resourceVisibilityLabels
export type MarketResourceOwner='Teloa'|'DSH'|'unknown'
export type MarketResourceEntry={visibility:MarketResourceVisibility;owner:MarketResourceOwner;key:string;id:string;version:string;kind:IndustryResourceKind;title:string;localizedTitle?:LocalizedMetadata;itemId?:string;capabilities:string[];uses:MarketResourceUse[];status:'reference'|'catalogued'|'conflict'}
const itemKind=(item:MarketItem):IndustryResourceKind|undefined=>item.resourceKind??(item.kind==='skill'?'skill':item.kind==='role'?'role':item.kind==='template'?'work-template':item.protocol==='MCP'?'mcp':undefined)
const keyOf=(namespace:string,id:string,version:string)=>JSON.stringify([namespace,id,version])

/** 只投影传入的可见目录，不扩大可见范围，也不将目录存在当作已安装。 */
export function marketResourceIndex(items:readonly MarketItem[]):MarketResourceEntry[]{
 const entries=new Map<string,MarketResourceEntry>()
 const digests=new Map<string,string>()
 for(const item of items){
  const kind=itemKind(item);if(!kind)continue
  const key=keyOf('catalog',item.id,item.version),existing=entries.get(key)
  const digest=item.packageContent?.hash||item.hash
  if(existing){if(existing.kind!==kind||(digest&&digests.has(key)&&digests.get(key)!==digest))existing.status='conflict';if(digest&&!digests.has(key))digests.set(key,digest);continue}
  if(digest)digests.set(key,digest)
  entries.set(key,{visibility:item.visibility,owner:item.owner,key,id:item.atomicSkill?.id||item.id,version:item.version,kind,title:item.title,...(item.localized?.title?{localizedTitle:item.localized.title}:{}),itemId:item.id,capabilities:[...new Set(item.capabilityCategories||[])],uses:[],status:'catalogued'})
 }
 for(const item of items){
  const manifest=item.manifest;if(!isIndustryManifest(manifest))continue
  for(const resource of manifest.resources){
   // 包内编号仅在来源条目内有效；未发布的同名文件不自动合并为公共资源。
   const id=resource.source.kind==='public'?resource.source.id:resource.id
   const resolved=item.packageContent?.resolved?.find(row=>row.resourceId===resource.id)
   const key=resolved?.sourceKind==='atomic-skill'?keyOf('catalog',resolved.sourceItemId,resource.version):keyOf(resource.source.kind==='public'?'catalog':'package:'+item.id,id,resource.version)
   let entry=entries.get(key)
   if(!entry){entry={visibility:resource.source.kind==='local'?item.visibility:'unknown',owner:'unknown',key,id,version:resource.version,kind:resource.kind,title:resource.title,...(resource.localized?.title?{localizedTitle:resource.localized.title}:{}),capabilities:[],uses:[],status:'reference'};entries.set(key,entry)}
   if(entry.kind!==resource.kind)entry.status='conflict'
   if(!entry.uses.some(use=>use.templateId===item.id&&use.resourceId===resource.id))entry.uses.push({templateId:item.id,templateTitle:item.title,...(item.localized?.title?{localizedTitle:item.localized.title}:{}),industry:manifest.domain,resourceId:resource.id})
  }
 }
 return [...entries.values()]
}

export function filterMarketResources(rows:readonly MarketResourceEntry[],filter:{kind:IndustryResourceKind|'all';query:string;referencedIndustry:string;capability:string;visibility?:MarketResourceVisibility|'all';owner?:MarketResourceOwner|'all';searchValues?:(row:MarketResourceEntry)=>readonly string[]}):MarketResourceEntry[]{
 const query=filter.query.trim().toLocaleLowerCase()
 return rows.filter(row=>(!filter.owner||filter.owner==='all'||row.owner===filter.owner)&&(!filter.visibility||filter.visibility==='all'||row.visibility===filter.visibility)&&(filter.kind==='all'||row.kind===filter.kind)&&(filter.capability==='all'||row.capabilities.includes(filter.capability))&&(filter.referencedIndustry==='all'||row.uses.some(use=>use.industry===filter.referencedIndustry))&&[...(filter.searchValues?.(row)??[]),row.id,row.title,...row.capabilities,...row.uses.map(use=>use.templateTitle)].some(value=>value.toLocaleLowerCase().includes(query)))
}

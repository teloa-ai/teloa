import type {MarketContentApi} from './market-content-api.js'
import type {MarketItem} from './market-preview.js'
import type {SkillInstallApi,SkillInstallSourceIdentity} from './skill-install-api.js'
import {isIndustryManifest} from './industry-manifest.js'

export type InstalledSkillSource={installationId:string;source:SkillInstallSourceIdentity}
const unavailable=()=>Object.assign(Error('The installed skill fixed source is unavailable or has changed.'),{code:'teloa/source-unavailable'})
const same=(left:SkillInstallSourceIdentity,right:SkillInstallSourceIdentity)=>JSON.stringify(Object.entries(left).sort())===JSON.stringify(Object.entries(right).sort())

/** 只读本人这次安装的完整固定来源；不按名称、目录最新版本或另一份安装回落。 */
export async function readInstalledSkillSource(api:Pick<SkillInstallApi,'get'>,contentApi:Pick<MarketContentApi,'list'|'hydrate'>,request:InstalledSkillSource):Promise<MarketItem>{
 const installed=await api.get(request.installationId)
 if(installed.id!==request.installationId||installed.state!=='installed'||!same(installed.source,request.source))throw unavailable()
 const summaries=await contentApi.list(),source=request.source
 const read=async(id:string,hash:string)=>{
  const summary=summaries.find(row=>row.contentStorage?.contentId===id)
  if(!summary||summary.hash!==hash)throw unavailable()
  const item=await contentApi.hydrate(summary)
  if(item.contentStorage?.contentId!==id||!item.contentStorage.loaded||(item.atomicSkill?.hash??item.packageContent?.hash)!==hash)throw unavailable()
  return item
 }
 const item=await read(source.kind==='industry-public'?source.sourceContentId:source.contentId,source.kind==='industry-public'?source.sourceContentHash:source.contentHash)
 if(source.kind==='industry-local'){
  const resource=isIndustryManifest(item.manifest)?item.manifest.resources.find(row=>row.id===source.resourceId):undefined
  if(!item.packageContent||!resource||resource.kind!=='skill'||resource.version!==source.resourceVersion||resource.source.kind!=='local')throw unavailable()
  const content=item.packageContent,root=content.manifestPath.includes('/')?content.manifestPath.slice(0,content.manifestPath.lastIndexOf('/')+1):'',path=root+resource.source.path
  if(!content.files.some(file=>file.path===path))throw unavailable()
 }else{
  if(!item.atomicSkill||item.version!==(source.kind==='industry-public'?source.sourceResourceVersion:source.resourceVersion)||item.atomicSkill.id!==(source.kind==='industry-public'?source.sourceResourceId:source.resourceId)||item.atomicSkill.version!==(source.kind==='industry-public'?source.sourceResourceVersion:source.resourceVersion))throw unavailable()
  if(source.kind==='industry-public'){
   const parent=await read(source.contentId,source.contentHash),resource=isIndustryManifest(parent.manifest)?parent.manifest.resources.find(row=>row.id===source.resourceId):undefined
   if(!resource||resource.kind!=='skill'||resource.version!==source.resourceVersion||resource.source.kind!=='public'||resource.source.id!==source.sourceResourceId||resource.source.version!==source.sourceResourceVersion)throw unavailable()
  }
 }
 if(!(item.atomicSkill?.files.length??item.packageContent?.files.length))throw unavailable()
 return item
}

const zh={open:'查看固定来源',title:'技能固定来源',loading:'正在读取这次安装的固定来源…',notice:'以下为这次安装的固定来源与配套文件。',unavailable:'无法读取这次安装的固定来源。来源不存在、权限或摘要变化时，不会改用其他版本。',files:'配套文件',binary:'此文件不能作为文本预览，可下载原始字节。',download:'下载原文件'}
const hant={open:'查看固定來源',title:'技能固定來源',loading:'正在讀取這次安裝的固定來源…',notice:'以下為這次安裝的固定來源與配套檔案。',unavailable:'無法讀取這次安裝的固定來源。來源不存在、權限或摘要變更時，不會改用其他版本。',files:'配套檔案',binary:'此檔案無法作文字預覽，可下載原始位元組。',download:'下載原檔案'}
const en={open:'View fixed source',title:'Skill fixed source',loading:'Reading the fixed source for this installation…',notice:'The fixed source and supporting files for this installation.',unavailable:'The fixed source for this installation could not be read. Missing sources or changed permissions or hashes will not be replaced with another version.',files:'Supporting files',binary:'This file cannot be previewed as text. You can download its original bytes.',download:'Download original file'}
export const installedSkillSourceCopy=(locale:string)=>locale==='zh-CN'?zh:locale==='zh-Hant'?hant:en

import {planBusinessSharePackage,type BusinessShareExclusion,type BusinessShareInput} from './business-share-package.ts'
import {readIndustryDirectory} from './industry-directory.ts'
import {exportIndustryArchive} from './industry-export.ts'
import type {MarketItem} from './market-preview.ts'
import type {MarketContentApi} from './market-content-api.ts'
import type {BusinessShareSource} from './business-share-source.ts'
import {assertBusinessShareInspection,inspectBusinessShareContent,type BusinessShareInspection} from '@teloa/contract'

export type BusinessShareApi={
 source:BusinessShareSource
 plan:(input:BusinessShareInput)=>Promise<{item:MarketItem;excluded:BusinessShareExclusion[];inspection:BusinessShareInspection}>
 inspect:(item:MarketItem,purpose:string)=>Promise<BusinessShareInspection>
 download:(item:MarketItem,expectedDigest:string,purpose:string)=>Promise<{bytes:Uint8Array;name:string}>
 fix:(item:MarketItem,expectedDigest:string,purpose:string)=>Promise<MarketItem>
}

/** 分享页所有「能否继续」判断都在纯函数中，组件只呈现状态。 */
export function businessShareReady(input:Pick<BusinessShareInput,'packageId'|'packageVersion'|'title'|'description'|'objectTypes'>):boolean{
 return !!input.packageId.trim()&&!!input.packageVersion.trim()&&!!input.title.trim()&&!!input.description.trim()&&input.objectTypes.length>0
}
export function businessSharePublicationNotice(english:BusinessShareInput['english']):'local-only'|undefined{return english?undefined:'local-only'}
/** 资源标题来自原声明；英文门面只翻译包名与说明，不能假装翻译了别人的资源标题。 */
export function businessShareEnglishResourceNotice(english:BusinessShareInput['english']):'source-title-fallback'|undefined{return english?'source-title-fallback':undefined}
export function businessShareExclusionText(item:BusinessShareExclusion):string{return item.localId+'：'+item.reason}

export function createBusinessShareApi(source:BusinessShareSource,market:MarketContentApi):BusinessShareApi{
 return {
  source,
  async plan(input){
   const packaged=planBusinessSharePackage(input)
   // 出处是用户可见的信息而不是内容哈希输入；日期只标识这次本机生成，不影响同一声明包的确定性字节。
   const date=new Date().toISOString().slice(0,10)
   const item=await readIndustryDirectory(packaged.files.map(file=>({path:file.path,size:file.bytes.byteLength,read:async()=>file.bytes})),packaged.manifestPath,'本机业务声明 · '+input.scope+' · '+date)
   return {item,excluded:packaged.excluded,inspection:await inspectBusinessShareContent({files:packaged.files,purpose:input.description})}
  },
  inspect:(item,purpose)=>{if(!item.packageContent)throw Error('请先读取分享内容。');return inspectBusinessShareContent({files:item.packageContent.files,purpose})},
  async download(item,expectedDigest,purpose){
   const fixed=structuredClone(item)
   if(!fixed.packageContent)throw Error('请先读取分享内容。')
   await assertBusinessShareInspection({files:fixed.packageContent.files,purpose},expectedDigest)
   return exportIndustryArchive(fixed)
  },
  async fix(item,expectedDigest,purpose){
   const fixed=structuredClone(item)
   if(!fixed.packageContent)throw Error('请先读取分享内容。')
   await assertBusinessShareInspection({files:fixed.packageContent.files,purpose},expectedDigest)
   // 与下载同样重读清单和文件摘要，不能只相信 MarketItem 门面。
   const checked=await readIndustryDirectory(fixed.packageContent.files.map(file=>({path:file.path,size:file.bytes.byteLength,read:async()=>file.bytes})),fixed.packageContent.manifestPath,fixed.title)
   if(checked.packageContent!.hash!==(fixed.packageContent.baseHash||fixed.packageContent.hash))throw Error('分享内容已变化，请重新预览。')
   return market.importIndustry(fixed)
  },
 }
}

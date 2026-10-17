import {marketCatalogUpstreamTreeInput,type MarketCatalogUpstreamSkillEntry} from '@teloa/contract'
import type {MarketCatalogApi} from './market-catalog-api.ts'
import type {SkillInstallApi,SkillInstallationRecord,SkillInstallPreview} from './skill-install-api.ts'
import {skillInstallationMatchesPreview} from './skill-install-state.ts'

/**
 * 应用包一次安装：对每个所选来源沿原链路逐个执行「目录按固定版本与树指纹添加 → 原生预览 → 按预览的 bundleHash / trustHash 安装」。
 * 不另起安装引擎、不跳内容页、不连接账号、不授权员工；成员仍是各自独立的固定来源与安装记录。
 * - 原生安装接口同一时刻只保留一个待核对请求：中途断线留下原请求时停止推进，下次先按原请求身份核对；
 * - 被明确拒绝的来源记为未完成并继续其余来源；
 * - 已有同名技能（来源不同）不安装、不覆盖，交给原选择流程，结果里明确列出；
 * - 每次异步返回后核对调用方代次（本人 / 宿主端口），过期即停止，不再提交后续请求。
 */
export type AppPackMember={entryId:string;entry:MarketCatalogUpstreamSkillEntry;contentId:string|null}
export type AppPackPorts={catalog:Pick<MarketCatalogApi,'add'>;skills:Pick<SkillInstallApi,'list'|'preview'|'install'|'pending'|'recover'>;requestId?:()=>string}
export type AppPackOutcomeState='installed'|'already-installed'|'name-conflict'|'failed'|'pending'|'not-started'
export type AppPackOutcome={entryId:string;state:AppPackOutcomeState;contentId?:string;installationId?:string;nameInUse?:string;error?:unknown}
export type AppPackResult={outcomes:AppPackOutcome[];stopped:'pending'|'stale'|null}
export type AppPackOptions={isCurrent:()=>boolean;onProgress?:(outcome:AppPackOutcome,done:number,total:number)=>void}

const hex=(bytes:ArrayBuffer)=>Array.from(new Uint8Array(bytes),byte=>byte.toString(16).padStart(2,'0')).join('')
/** 浏览器异步摘要算出与宿主同一的上游树指纹（规范输入由契约给出）。 */
export async function appPackTreeHash(entry:MarketCatalogUpstreamSkillEntry):Promise<string>{
 return hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(marketCatalogUpstreamTreeInput(entry.upstream))))
}
const sameSource=(record:SkillInstallationRecord,preview:SkillInstallPreview)=>record.source.kind==='atomic'&&preview.source.kind==='atomic'&&record.source.contentId===preview.source.contentId

export async function installAppPack(members:readonly AppPackMember[],ports:AppPackPorts,options:AppPackOptions):Promise<AppPackResult>{
 const outcomes:AppPackOutcome[]=members.map(member=>({entryId:member.entryId,state:'not-started',...(member.contentId?{contentId:member.contentId}:{})}))
 const settle=(index:number,outcome:AppPackOutcome)=>{outcomes[index]=outcome;options.onProgress?.(outcome,outcomes.filter(item=>item.state!=='not-started').length,members.length)}
 const stale=():AppPackResult=>({outcomes,stopped:'stale'})
 // 已有待核对请求：属于本包某个来源时先按原请求身份核对，其它来源的请求不替用户处理
 const pending=ports.skills.pending()
 if(pending){
  const index=pending.source.kind==='atomic'?members.findIndex(member=>member.contentId===(pending.source as {contentId:string}).contentId):-1
  if(index<0)throw Error('另有技能安装结果待核对，请先在技能安装中核对后再安装此应用。')
  try{
   const record=await ports.skills.recover()
   if(!options.isCurrent())return stale()
   settle(index,{entryId:members[index]!.entryId,state:'installed',contentId:members[index]!.contentId!,installationId:record.id})
  }catch(error){
   if(!options.isCurrent())return stale()
   if(ports.skills.pending()){settle(index,{entryId:members[index]!.entryId,state:'pending',contentId:members[index]!.contentId!,error});return {outcomes,stopped:'pending'}}
   settle(index,{entryId:members[index]!.entryId,state:'failed',contentId:members[index]!.contentId!,error})
  }
 }
 const installed=(await ports.skills.list()).items.filter(record=>record.state==='installed')
 if(!options.isCurrent())return stale()
 for(const [index,member] of members.entries()){
  if(outcomes[index]!.state!=='not-started')continue
  let contentId=member.contentId
  try{
   if(!contentId){
    const treeHash=await appPackTreeHash(member.entry)
    contentId=(await ports.catalog.add(member.entryId,{version:member.entry.version,treeHash})).contentId
    if(!options.isCurrent())return stale()
   }
   const preview=await ports.skills.preview({kind:'atomic',contentId})
   if(!options.isCurrent())return stale()
   if(preview.source.kind!=='atomic'||preview.source.contentId!==contentId||preview.source.resourceVersion!==member.entry.version)throw Error('技能来源的版本与所选版本不一致，请重新打开应用后再安装。')
   const existing=installed.find(record=>skillInstallationMatchesPreview(record,preview))
   if(existing){settle(index,{entryId:member.entryId,state:'already-installed',contentId,installationId:existing.id});continue}
   const sameName=installed.find(record=>record.native.name===preview.native.name&&!sameSource(record,preview))
   if(sameName){settle(index,{entryId:member.entryId,state:'name-conflict',contentId,nameInUse:sameName.native.name});continue}
   const record=await ports.skills.install({requestId:ports.requestId?.()??crypto.randomUUID(),source:{kind:'atomic',contentId},expectedBundleHash:preview.bundleHash,...(preview.trustHash?{expectedTrustHash:preview.trustHash}:{})})
   if(!options.isCurrent())return stale()
   installed.push(record)
   settle(index,{entryId:member.entryId,state:'installed',contentId,installationId:record.id})
  }catch(error){
   if(!options.isCurrent())return stale()
   if(ports.skills.pending()){settle(index,{entryId:member.entryId,state:'pending',...(contentId?{contentId}:{}),error});return {outcomes,stopped:'pending'}}
   settle(index,{entryId:member.entryId,state:'failed',...(contentId?{contentId}:{}),error})
  }
 }
 return {outcomes,stopped:null}
}

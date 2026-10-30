import type {IndustryPrepareReceipt,IndustryReadiness} from './industry-load-api.js'
import type {SkillInstallApi,SkillInstallPreview,SkillInstallRequest} from './skill-install-api.js'

export type IndustrySkillBatchItem={itemInstanceId:string;title:string;preview:SkillInstallPreview;request:SkillInstallRequest}
export type IndustrySkillBatch={loadId:string;digest:string;items:IndustrySkillBatchItem[]}
export const industryBatchSkillRows=(readiness:IndustryReadiness,pending?:SkillInstallRequest)=>readiness.rows.filter(row=>row.kind==='skill'&&(row.state==='needs-user'&&(row.entry==='skill-confirm'||row.entry==='skill-link')||pending?.source.kind==='industry'&&pending.source.loadId===readiness.loadId&&pending.source.itemInstanceId===row.itemInstanceId))
const changed=()=>Error('方案或技能已变化，请重新核对安装清单。')

/** 只读固定预览；批量确认前不写安装、使用关系或员工。 */
export async function previewIndustrySkills(api:SkillInstallApi,readiness:IndustryReadiness):Promise<IndustrySkillBatch>{
 const items=await Promise.all(industryBatchSkillRows(readiness,api.pending()).map(async row=>{
  const source={kind:'industry' as const,loadId:readiness.loadId,itemInstanceId:row.itemInstanceId},preview=await api.preview(source)
  return {itemInstanceId:row.itemInstanceId,title:row.title,preview,request:{requestId:crypto.randomUUID(),source,expectedBundleHash:preview.bundleHash,...(preview.trustHash?{expectedTrustHash:preview.trustHash}:{})}}
 }))
 if(new Set(items.map(item=>item.preview.native.name)).size!==items.length)throw Error('方案内有同名技能，请先核对技能来源。')
 return {loadId:readiness.loadId,digest:readiness.digest,items}
}

/** 逐项复用原安装与恢复接口；任何一项未真正可用时保留原请求，停止后续员工准备。 */
export async function prepareIndustrySkills(api:SkillInstallApi,batch:IndustrySkillBatch,confirmed:IndustryReadiness,port:{read:(id:string)=>Promise<IndustryReadiness>;prepare:(id:string,digest:string)=>Promise<IndustryPrepareReceipt>}):Promise<IndustryPrepareReceipt>{
 if(batch.loadId!==confirmed.loadId||batch.digest!==confirmed.digest)throw changed()
 const current=await port.read(batch.loadId)
 if(current.digest!==batch.digest||current.status!=='active')throw changed()
 const pending=api.pending()
 if(pending&&!batch.items.some(item=>sameRequest(item.request,pending)))throw Error('请先核对另一项尚未完成的技能安装。')
 const results:IndustryPrepareReceipt['results']=[]
 for(const item of batch.items){
  const outstanding=api.pending()
  const record=outstanding&&sameRequest(item.request,outstanding)?await api.recover():await api.install(item.request)
  if(record.state!=='installed'||record.bundleHash!==item.preview.bundleHash)throw Error('技能「'+item.title+'」仍在准备，请稍后继续。')
  const observation=await api.observe(record.id),expected=item.preview.native,actual=observation.current
  if(observation.state!=='available'||!actual||(['name','description','bodyHash','modelInvocable','userInvocable'] as const).some(key=>actual[key]!==expected[key]))throw Error('技能「'+item.title+'」尚未在当前工作区生效，请检查后继续。')
  results.push({itemInstanceId:item.itemInstanceId,title:item.title,step:'skill',outcome:'done',code:null,message:null})
 }
 const after=await port.read(batch.loadId)
 const unchanged=(value:IndustryReadiness)=>JSON.stringify(value.rows.filter(row=>!batch.items.some(item=>item.itemInstanceId===row.itemInstanceId)))
 if(after.status!=='active'||unchanged(after)!==unchanged(confirmed))throw changed()
 if(batch.items.some(item=>!after.rows.some(row=>row.itemInstanceId===item.itemInstanceId&&row.state==='ready')))throw Error('技能安装结果仍待核对，请重新准备。')
 if(!after.counts.auto)return {loadId:batch.loadId,digest:batch.digest,results,readiness:after}
 const receipt=await port.prepare(batch.loadId,after.digest)
 return {...receipt,results:[...results,...receipt.results]}
}

function sameRequest(left:SkillInstallRequest,right:SkillInstallRequest):boolean{
 return left.source.kind==='industry'&&right.source.kind==='industry'&&left.source.loadId===right.source.loadId&&left.source.itemInstanceId===right.source.itemInstanceId&&left.expectedBundleHash===right.expectedBundleHash&&left.expectedTrustHash===right.expectedTrustHash
}

import {WorkError,isRecord,pageCreateLimits,type PageCreateDraftDirectory,type PageCreateEntity} from '@teloa/contract'

/** 宿主服务已校验草案正文；模型只取得可定位原稿的摘要，再按需预览。 */
export function savedDraftSummaries(page:PageCreateDraftDirectory,input:{entity:PageCreateEntity;scope?:string},owner:string){
 if(!isRecord(page)||page.schema!=='teloa.page-create-drafts/v1'||page.entity!==input.entity||page.scope!==input.scope||typeof page.readAt!=='string'||!Number.isFinite(Date.parse(page.readAt))||!Array.isArray(page.drafts)||page.drafts.length>pageCreateLimits.draftsPerEntity)throw new WorkError('teloa/invalid-host-response','草案目录返回格式不正确。')
 const seen=new Set<string>()
 const drafts=page.drafts.map(draft=>{
  if(!isRecord(draft)||draft.ownerId!==owner||draft.entity!==input.entity||draft.scope!==input.scope||typeof draft.id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(draft.id)||seen.has(draft.id)||typeof draft.title!=='string'||!draft.title.trim()||typeof draft.bodyHash!=='string'||!/^[a-f0-9]{64}$/.test(draft.bodyHash)||!['draft','applied','discarded'].includes(draft.status)||!Number.isFinite(Date.parse(draft.createdAt))||!Number.isFinite(Date.parse(draft.updatedAt))||(draft.status==='applied')!==(typeof draft.appliedRef==='string'&&!!draft.appliedRef.trim())||draft.status!=='applied'&&draft.appliedRef!==undefined)throw new WorkError('teloa/invalid-host-response','草案目录的归属、身份或状态不正确。')
  seen.add(draft.id)
  return {id:draft.id,entity:draft.entity,...(draft.scope===undefined?{}:{scope:draft.scope}),title:draft.title,status:draft.status,bodyHash:draft.bodyHash,createdAt:draft.createdAt,updatedAt:draft.updatedAt,...(draft.appliedRef===undefined?{}:{appliedRef:draft.appliedRef})}
 })
 return {schema:'teloa.page-create-draft-summaries/v1',entity:page.entity,...(page.scope===undefined?{}:{scope:page.scope}),readAt:page.readAt,limit:pageCreateLimits.draftsPerEntity,coverage:'recent-saved-drafts',drafts}
}

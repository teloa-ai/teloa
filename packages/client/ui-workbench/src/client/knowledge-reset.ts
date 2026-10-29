export type KnowledgeResetPreview={digest:string;documents:Array<{roleId:string;resourceId:string;knowledgeId:string;bodyVersion:number;contentHash:string;title:string}>}
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
const hash=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value)
export function readKnowledgeResetPreview(value:unknown):KnowledgeResetPreview{
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('知识覆盖清单格式不正确。')
 const row=value as Record<string,unknown>
 if(Object.keys(row).some(key=>!['digest','documents'].includes(key))||!hash(row.digest)||!Array.isArray(row.documents)||row.documents.length>5000)throw Error('知识覆盖清单格式不正确。')
 const documents=row.documents.map(value=>{
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('知识覆盖清单格式不正确。')
  const item=value as Record<string,unknown>
  if(Object.keys(item).some(key=>!['roleId','resourceId','knowledgeId','bodyVersion','contentHash','title'].includes(key))||!uuid(item.roleId)||!uuid(item.resourceId)||!uuid(item.knowledgeId)||!Number.isSafeInteger(item.bodyVersion)||Number(item.bodyVersion)<1||!hash(item.contentHash)||typeof item.title!=='string'||!item.title.trim()||item.title.length>200)throw Error('知识覆盖清单格式不正确。')
  return {roleId:item.roleId,resourceId:item.resourceId,knowledgeId:item.knowledgeId,bodyVersion:Number(item.bodyVersion),contentHash:item.contentHash,title:item.title}
 })
 if(new Set(documents.map(row=>row.roleId+':'+row.resourceId)).size!==documents.length)throw Error('知识覆盖清单格式不正确。')
 return {digest:row.digest,documents}
}
export function knowledgeResetFromError(error:unknown):KnowledgeResetPreview|undefined{
 if(!error||typeof error!=='object'||!('rejected'in error)||error.rejected!==true||!('details'in error)||!error.details||typeof error.details!=='object'||!('reason'in error.details)||error.details.reason!=='employee-knowledge-reset-required'||!('knowledgeReset'in error.details))return undefined
 return readKnowledgeResetPreview(error.details.knowledgeReset)
}

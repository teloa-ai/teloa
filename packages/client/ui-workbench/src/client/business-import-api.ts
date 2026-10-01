import {
 readBusinessImportStageInput,readBusinessImportStageReceiptInput,readBusinessImportGetInput,readBusinessImportInspectInput,
 readBusinessImportPreviewInput,readBusinessImportApplyInput,readBusinessImportRevisionInput,readBusinessImportReceiptInput,
 readBusinessImportDraft,readBusinessImportInspection,readBusinessImportReceipt,readBusinessImportStageReceiptResponse,readBusinessImportReceiptResponse,
 readBusinessImportAnyDraft,readBusinessImportAnyInspection,readBusinessImportAnyReceipt,readBusinessImportAnyStageInput,readBusinessImportAnyInspectInput,readBusinessImportAnyPreviewInput,
 readBusinessImportAnyStageReceiptResponse,readBusinessImportAnyReceiptResponse,readBusinessImportWorkbookInputV2,readBusinessImportWorkbookV2,
 industryUpdateCanonical,
 type BusinessImportDraft,type BusinessImportStageInput,type BusinessImportStageReceiptInput,type BusinessImportGetInput,
 type BusinessImportInspectInput,type BusinessImportPreviewInput,type BusinessImportApplyInput,type BusinessImportRevisionInput,type BusinessImportReceiptInput,
 type BusinessImportAnyDraft,type BusinessImportAnyReceipt,type BusinessImportAnyStageInput,type BusinessImportAnyInspectInput,type BusinessImportAnyPreviewInput,type BusinessImportWorkbookInputV2,
} from '@teloa/contract'
type Call=(method:string,input:unknown,signal?:AbortSignal)=>Promise<unknown>
type AcceptDraft=(draft:BusinessImportAnyDraft)=>void
const applyRejectionCodes=['teloa/invalid-input','teloa/forbidden','teloa/version-conflict','teloa/conflict','teloa/not-found']
/** 仅真实 RPC 拒绝身份及已知事务拒绝码能证明此请求没有受理；传输/解码失败仍未知。 */
export function businessImportApplyRejectedCode(error:unknown):string|undefined{return error&&typeof error==='object'&&'rejected'in error&&error.rejected===true&&'code'in error&&typeof error.code==='string'&&applyRejectionCodes.includes(error.code)?error.code:undefined}
const invalid=()=>Object.assign(Error('导入回包与原请求不一致。'),{code:'teloa/invalid-host-response'})
const same=(a:unknown,b:unknown)=>industryUpdateCanonical(a)===industryUpdateCanonical(b)
/** 回包只沿公共 strict reader 读取；已读取草案的不可变身份用于后续回包核对。 */
export function createBusinessImportApi(call:Call){
 const drafts=new Map<string,BusinessImportAnyDraft>()
 function remember(value:unknown,id?:string,validate?:(draft:BusinessImportAnyDraft)=>void){
  const draft=readBusinessImportAnyDraft(value),previous=drafts.get(draft.id)
  if(id!==undefined&&draft.id!==id||previous&&(draft.format!==previous.format||draft.ownerId!==previous.ownerId||draft.scope!==previous.scope||draft.type!==previous.type||draft.stageRequestId!==previous.stageRequestId||draft.sourceIdentity!==previous.sourceIdentity||!same(draft.file,previous.file)||draft.format==='teloa.business-record-import/v2'&&previous.format==='teloa.business-record-import/v2'&&(!same(draft.source,previous.source)||!same(draft.policy,previous.policy))))throw invalid()
  validate?.(draft);drafts.set(draft.id,draft);return draft
 }
 function stageTarget(draft:BusinessImportAnyDraft,input:BusinessImportStageReceiptInput){
  if(draft.stageRequestId!==input.requestId||draft.scope!==input.scope||draft.type!==input.type)throw invalid()
  return draft
 }
 function applyTarget(value:unknown,input:BusinessImportApplyInput){
  const receipt=readBusinessImportAnyReceipt(value),draft=drafts.get(input.draftId)
  if(receipt.requestId!==input.requestId||receipt.draftId!==input.draftId||receipt.previewDigest!==input.previewDigest||draft&&(receipt.scope!==draft.scope||receipt.type!==draft.type||receipt.fileHash!==draft.file.sha256||receipt.sourceIdentity!==draft.sourceIdentity||draft.preview&&(receipt.sourcePolicyDigest!==draft.preview.sourcePolicyDigest||receipt.contentKey!==draft.preview.contentKey||receipt.created!==draft.preview.rows.length)))throw invalid()
  if(draft&&((draft.format==='teloa.business-record-import/v2')!==('format'in receipt)))throw invalid()
  if(draft?.format==='teloa.business-record-import/v2'&&'format'in receipt&&(!same(draft.source,receipt.source)||!same(draft.policy,receipt.policy)||!same(draft.preview?.rawCellsDigest,receipt.rawCellsDigest)))throw invalid()
  return receipt
 }
 return {
  async workbook(input:BusinessImportWorkbookInputV2,signal?:AbortSignal){
   const data=readBusinessImportWorkbookInputV2(input),bytes=Uint8Array.from(atob(data.dataBase64),c=>c.charCodeAt(0))
   if(bytes.byteLength!==data.bytes)throw invalid()
   const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(byte=>byte.toString(16).padStart(2,'0')).join('')
   const result=readBusinessImportWorkbookV2(await call('business-imports/workbook',data,signal))
   if(result.bytes!==data.bytes||result.fileHash!==hash)throw invalid();return result
  },
  async stage(input:BusinessImportAnyStageInput,signal?:AbortSignal,accept?:AcceptDraft){
   const data=readBusinessImportAnyStageInput(input)
   return remember(await call('business-imports/stage',data,signal),undefined,draft=>{stageTarget(draft,data);if(draft.file.name!==data.name||draft.file.bytes!==data.bytes||(draft.format==='teloa.business-record-import/v2')!==('format'in data)||draft.format==='teloa.business-record-import/v2'&&'format'in data&&!same(draft.source,data.source))throw invalid();accept?.(draft)})
  },
  async stageReceipt(input:BusinessImportStageReceiptInput,signal?:AbortSignal,accept?:AcceptDraft){
   const data=readBusinessImportStageReceiptInput(input),draft=readBusinessImportAnyStageReceiptResponse(await call('business-imports/stage-receipt',data,signal))
   return draft===null?null:remember(draft,undefined,value=>{stageTarget(value,data);accept?.(value)})
  },
  async get(input:BusinessImportGetInput,signal?:AbortSignal,accept?:AcceptDraft){const data=readBusinessImportGetInput(input);return remember(await call('business-imports/get',data,signal),data.draftId,accept)},
  async inspect(input:BusinessImportAnyInspectInput,signal?:AbortSignal){
   const data=readBusinessImportAnyInspectInput(input),result=readBusinessImportAnyInspection(await call('business-imports/inspect',data,signal)),draft=drafts.get(data.draftId)
   if(result.draftId!==data.draftId||result.revision!==data.expectedRevision||(result.format==='teloa.business-import-inspection/v2')!==('format'in data)||result.format==='teloa.business-import-inspection/v1'&&'delimiter'in data&&result.delimiter!==data.delimiter||draft&&(result.scope!==draft.scope||result.type!==draft.type||result.fileHash!==draft.file.sha256||(draft.format==='teloa.business-record-import/v2')!==(result.format==='teloa.business-import-inspection/v2')))throw invalid()
   if(draft?.format==='teloa.business-record-import/v2'&&result.format==='teloa.business-import-inspection/v2'&&(!same(draft.source,result.source)||!same(draft.policy,result.policy)))throw invalid()
   return result
  },
  async preview(input:BusinessImportAnyPreviewInput,signal?:AbortSignal){
   const data=readBusinessImportAnyPreviewInput(input)
   return remember(await call('business-imports/preview',data,signal),data.draftId,draft=>{if(draft.status!=='previewed'||draft.revision!==data.expectedRevision+1||!draft.preview||!same(draft.mapping,data.mapping)||(draft.format==='teloa.business-record-import/v2')!==('format'in data))throw invalid()})
  },
  async apply(input:BusinessImportApplyInput,signal?:AbortSignal){const data=readBusinessImportApplyInput(input);return applyTarget(await call('business-imports/apply',data,signal),data)},
  async cancel(input:BusinessImportRevisionInput,signal?:AbortSignal){
   const data=readBusinessImportRevisionInput(input)
   return remember(await call('business-imports/cancel',data,signal),data.draftId,draft=>{if(draft.status!=='applied'&&(draft.revision<data.expectedRevision||draft.revision===data.expectedRevision&&draft.status!=='cancelled'))throw invalid()})
  },
  async resume(input:BusinessImportRevisionInput,signal?:AbortSignal){
   const data=readBusinessImportRevisionInput(input)
   return remember(await call('business-imports/resume',data,signal),data.draftId,draft=>{if(draft.status!=='applied'&&(draft.revision<data.expectedRevision||draft.revision===data.expectedRevision&&draft.status!=='ready'))throw invalid()})
  },
  async receipt(input:BusinessImportReceiptInput,signal?:AbortSignal){
   const data=readBusinessImportReceiptInput(input),receipt=readBusinessImportAnyReceiptResponse(await call('business-imports/receipt',data,signal))
   if(receipt!==null&&(receipt.requestId!==data.requestId||receipt.scope!==data.scope))throw invalid();return receipt
  },
 }
}
export type BusinessImportApi=ReturnType<typeof createBusinessImportApi>

import {createHash} from 'node:crypto'
import {
 WorkError,industryUpdateCanonical,readBusinessImportAnyStageInput,readBusinessImportStageReceiptInput,readBusinessImportGetInput,readBusinessImportAnyInspectInput,
 readBusinessImportAnyPreviewInput,readBusinessImportApplyInput,readBusinessImportRevisionInput,readBusinessImportReceiptInput,
 readBusinessImportAnyDraft,readBusinessImportAnyInspection,readBusinessImportAnyReceipt,readBusinessImportWorkbookInputV2,readBusinessImportWorkbookV2,
 type BusinessImportActor,type BusinessImportAnyStageInput,type BusinessImportStageReceiptInput,type BusinessImportGetInput,type BusinessImportAnyInspectInput,
 type BusinessImportAnyPreviewInput,type BusinessImportApplyInput,type BusinessImportRevisionInput,type BusinessImportReceiptInput,
 type BusinessImportAnyDraft,type BusinessImportAnyInspection,type BusinessImportAnyReceipt,type BusinessImportWorkbookV2,
} from '@teloa/contract'

export const businessImportEndpoints=['business-imports/workbook','business-imports/stage','business-imports/stage-receipt','business-imports/get','business-imports/inspect','business-imports/preview','business-imports/apply','business-imports/cancel','business-imports/resume','business-imports/receipt'] as const
export type BusinessImportServices={imports:{
 inspectWorkbook(actor:BusinessImportActor,input:unknown,signal?:AbortSignal):Promise<BusinessImportWorkbookV2>
 stage(actor:BusinessImportActor,input:BusinessImportAnyStageInput,signal?:AbortSignal):Promise<BusinessImportAnyDraft>
 stageReceipt(actor:BusinessImportActor,input:BusinessImportStageReceiptInput):Promise<BusinessImportAnyDraft|undefined>
 get(actor:BusinessImportActor,input:BusinessImportGetInput):Promise<BusinessImportAnyDraft>
 inspect(actor:BusinessImportActor,input:BusinessImportAnyInspectInput,signal?:AbortSignal):Promise<BusinessImportAnyInspection>
 preview(actor:BusinessImportActor,input:BusinessImportAnyPreviewInput,signal?:AbortSignal):Promise<BusinessImportAnyDraft>
 apply(actor:BusinessImportActor,input:BusinessImportApplyInput,signal?:AbortSignal):Promise<BusinessImportAnyReceipt>
 cancel(actor:BusinessImportActor,input:BusinessImportRevisionInput):Promise<BusinessImportAnyDraft>
 resume(actor:BusinessImportActor,input:BusinessImportRevisionInput):Promise<BusinessImportAnyDraft>
 receipt(actor:BusinessImportActor,input:BusinessImportReceiptInput):Promise<BusinessImportAnyReceipt|undefined>
}}
const invalid=()=>new WorkError('teloa/invalid-host-response','导入结果与当前用户、业务或原请求不一致，请重新核对。')
const readers={workbook:readBusinessImportWorkbookInputV2,stage:readBusinessImportAnyStageInput,'stage-receipt':readBusinessImportStageReceiptInput,get:readBusinessImportGetInput,inspect:readBusinessImportAnyInspectInput,preview:readBusinessImportAnyPreviewInput,apply:readBusinessImportApplyInput,cancel:readBusinessImportRevisionInput,resume:readBusinessImportRevisionInput,receipt:readBusinessImportReceiptInput}
const same=(a:unknown,b:unknown)=>industryUpdateCanonical(a)===industryUpdateCanonical(b)
function sourceMatches(draft:BusinessImportAnyDraft,result:BusinessImportAnyDraft|BusinessImportAnyInspection|BusinessImportAnyReceipt){
 if(draft.format==='teloa.business-record-import/v2')return 'source' in result&&same(result.source,draft.source)&&same(result.policy,draft.policy)
 return !('source' in result)
}

/** 身份由宿主提供，回执缺失只表示尚未查明，不能触发新批次。 */
export function createBusinessImportHandler(owner:string,scopeIds:()=>Promise<readonly string[]>,get:()=>Promise<BusinessImportServices>){
 return async(endpoint:string,payload:unknown,signal?:AbortSignal):Promise<unknown>=>{
  if(!(businessImportEndpoints as readonly string[]).includes(endpoint))throw new WorkError('teloa/not-found','未提供此导入接口。')
  const method=endpoint.slice('business-imports/'.length) as keyof typeof readers,input=readers[method](payload)
  signal?.throwIfAborted()
  const actor={ownerId:owner,scopeIds:[...await scopeIds()].filter(scope=>scope!=='general')}
  if('scope' in input&&!actor.scopeIds.includes(input.scope))throw new WorkError('teloa/forbidden','当前用户无权导入或读取此业务。')
  const {imports}=await get()
  signal?.throwIfAborted()
  const checkDraft=(value:unknown,id?:string)=>{
   const result=readBusinessImportAnyDraft(value)
   if(result.ownerId!==owner||!actor.scopeIds.includes(result.scope)||id!==undefined&&result.id!==id)throw invalid()
   return result
  }
  // v2 检查/预览没有 source 入参；共用 apply 没有版本入参。一次读取固定草案后核来源。
  let prior:BusinessImportAnyDraft|undefined
  if(method==='apply'||(method==='inspect'||method==='preview')&&'format' in input){
   if(!('draftId' in input))throw invalid()
   prior=checkDraft(await imports.get(actor,{draftId:input.draftId}),input.draftId)
   signal?.throwIfAborted()
   if(method!=='apply'&&prior.format!=='teloa.business-record-import/v2')throw invalid()
  }
  let value:unknown
  switch(method){
   case 'workbook':value=await imports.inspectWorkbook(actor,readBusinessImportWorkbookInputV2(input),signal);break
   case 'stage':value=await imports.stage(actor,readBusinessImportAnyStageInput(input),signal);break
   case 'stage-receipt':value=await imports.stageReceipt(actor,readBusinessImportStageReceiptInput(input));break
   case 'get':value=await imports.get(actor,readBusinessImportGetInput(input));break
   case 'inspect':value=await imports.inspect(actor,readBusinessImportAnyInspectInput(input),signal);break
   case 'preview':value=await imports.preview(actor,readBusinessImportAnyPreviewInput(input),signal);break
   case 'apply':value=await imports.apply(actor,readBusinessImportApplyInput(input),signal);break
   case 'cancel':value=await imports.cancel(actor,readBusinessImportRevisionInput(input));break
   case 'resume':value=await imports.resume(actor,readBusinessImportRevisionInput(input));break
   case 'receipt':value=await imports.receipt(actor,readBusinessImportReceiptInput(input));break
  }
  signal?.throwIfAborted()
  if(value===undefined&&(method==='stage-receipt'||method==='receipt'))return null
  if(method==='workbook'){
   const request=readBusinessImportWorkbookInputV2(input),result=readBusinessImportWorkbookV2(value),bytes=Buffer.from(request.dataBase64,'base64')
   if(result.bytes!==request.bytes||result.fileHash!==createHash('sha256').update(bytes).digest('hex'))throw invalid()
   return result
  }
  if(method==='apply'||method==='receipt'){
   const result=readBusinessImportAnyReceipt(value)
   if(!actor.scopeIds.includes(result.scope)||!('requestId' in input)||result.requestId!==input.requestId||'scope' in input&&result.scope!==input.scope||'draftId' in input&&result.draftId!==input.draftId||'previewDigest' in input&&result.previewDigest!==input.previewDigest)throw invalid()
   if(prior&&(result.scope!==prior.scope||result.type!==prior.type||result.fileHash!==prior.file.sha256||result.sourceIdentity!==prior.sourceIdentity||!sourceMatches(prior,result)))throw invalid()
   if(prior?.format==='teloa.business-record-import/v2'&&(!('rawCellsDigest' in result)||!prior.preview||result.rawCellsDigest!==prior.preview.rawCellsDigest||result.sourcePolicyDigest!==prior.preview.sourcePolicyDigest||result.contentKey!==prior.preview.contentKey))throw invalid()
   return result
  }
  if(method==='inspect'){
   const request=readBusinessImportAnyInspectInput(input),result=readBusinessImportAnyInspection(value)
   if(!actor.scopeIds.includes(result.scope)||result.draftId!==request.draftId||result.revision!==request.expectedRevision)throw invalid()
   if('format' in request){
    if(result.format!=='teloa.business-import-inspection/v2'||!prior||result.scope!==prior.scope||result.type!==prior.type||result.fileHash!==prior.file.sha256||!sourceMatches(prior,result))throw invalid()
   }else if(result.format!=='teloa.business-import-inspection/v1'||result.delimiter!==request.delimiter)throw invalid()
   return result
  }
  const result=checkDraft(value)
  if('scope' in input&&result.scope!==input.scope||'type' in input&&result.type!==input.type||'draftId' in input&&result.id!==input.draftId||(method==='stage'||method==='stage-receipt')&&'requestId' in input&&result.stageRequestId!==input.requestId)throw invalid()
  if(method==='stage'){
   const request=readBusinessImportAnyStageInput(input),bytes=Buffer.from(request.dataBase64,'base64')
   if(result.file.name!==request.name||result.file.bytes!==request.bytes||result.file.sha256!==createHash('sha256').update(bytes).digest('hex'))throw invalid()
   if('format' in request){if(result.format!=='teloa.business-record-import/v2'||!same(result.source,request.source))throw invalid()}
   else if(result.format!=='teloa.business-record-import/v1')throw invalid()
  }
  if(method==='preview'){
   const request=readBusinessImportAnyPreviewInput(input)
   if('format' in request){
    if(!prior||result.format!==prior.format||result.scope!==prior.scope||result.type!==prior.type||!same(result.file,prior.file)||result.sourceIdentity!==prior.sourceIdentity||!sourceMatches(prior,result)||!same(result.mapping,request.mapping))throw invalid()
   }else if(result.format!=='teloa.business-record-import/v1')throw invalid()
  }
  return result
 }
}

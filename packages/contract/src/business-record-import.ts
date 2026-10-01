import {WorkError} from './work-error.ts'
import {isRecord} from './resources.ts'
import {isBusinessScopeKey} from './business-scopes.ts'
import {businessObjectReference,type BusinessObjectReference} from './business-data.ts'
import {readBusinessRecordCreate,type BusinessRecordBatchOperation} from './business-records.ts'
import {industryUpdateCanonical} from './industry-update-compare.ts'

export type BusinessImportActor={ownerId:string;scopeIds:string[]}
export type BusinessImportFileRef={attachmentId:string;name:string;bytes:number;sha256:string}
export type BusinessImportRow={rowNumber:number;cells:string[]}
export type BusinessImportTable={format:'teloa.business-import-table/v1';parserVersion:'csv-v1';columns:number;rows:BusinessImportRow[]}
export type BusinessImportSourceColumn={column:number;trim:boolean}
export type BusinessImportFieldMapping={field:string;value:BusinessImportSourceColumn;currency?:{fixed:string}|BusinessImportSourceColumn}
export type BusinessImportMapping={delimiter:','|';'|'\t';headerRow:number;primaryKey:BusinessImportSourceColumn[];title:BusinessImportSourceColumn;summary?:BusinessImportSourceColumn;fields:BusinessImportFieldMapping[]}
export type BusinessImportStageInput={requestId:string;scope:string;type:string;name:string;bytes:number;dataBase64:string}
export type BusinessImportStageReceiptInput={requestId:string;scope:string;type:string}
export type BusinessImportGetInput={draftId:string}
export type BusinessImportInspectInput={draftId:string;expectedRevision:number;delimiter:BusinessImportMapping['delimiter']}
export type BusinessImportPreviewInput={draftId:string;expectedRevision:number;mapping:BusinessImportMapping}
export type BusinessImportApplyInput={requestId:string;draftId:string;previewRevision:number;previewDigest:string}
export type BusinessImportRevisionInput={requestId:string;draftId:string;expectedRevision:number}
export type BusinessImportReceiptInput={requestId:string;scope:string}
export type BusinessImportIssue={rowNumber?:number;column?:number;field?:string;code:string;message:string}
export type BusinessImportInspection={format:'teloa.business-import-inspection/v1';draftId:string;scope:string;type:string;fileHash:string;revision:number;delimiter:BusinessImportMapping['delimiter'];parserVersion:'csv-v1';headerRow:1;columns:Array<{column:number;header:string}>;sampleRows:BusinessImportRow[];sampleRowsOmitted?:number;dataRows?:number;issues:BusinessImportIssue[];complete:boolean;canMap:boolean}
export type BusinessImportPreview={revision:number;digest:string;schemaFingerprint:string;writeSchemaFingerprint:string;configurationVersion:number;sourceIdentity:string;sourcePolicyDigest:string;contentKey:string;mapping:BusinessImportMapping;rows:Array<{rowNumber:number;primaryKey:string[];operation:Extract<BusinessRecordBatchOperation,{operation:'create'}>}>;issues:BusinessImportIssue[];canApply:boolean}
export type BusinessImportReceipt={requestId:string;canonicalRequestId:string;draftId:string;scope:string;type:string;fileHash:string;previewDigest:string;sourceIdentity:string;sourcePolicyDigest:string;contentKey:string;created:number;references:BusinessObjectReference[];appliedAt:string}
export type BusinessImportDraft={format:'teloa.business-record-import/v1';id:string;stageRequestId:string;ownerId:string;scope:string;type:string;sourceIdentity:string;revision:number;status:'ready'|'previewed'|'cancelled'|'applied';file:BusinessImportFileRef;mapping?:BusinessImportMapping;preview?:BusinessImportPreview;receipt?:BusinessImportReceipt;createdAt:string;updatedAt:string}
export type BusinessImportFilePort={
 save(input:{dataBase64:string;name:string;bytes:number},signal?:AbortSignal):Promise<BusinessImportFileRef>
 read(file:BusinessImportFileRef,signal?:AbortSignal):Promise<Uint8Array>
}
export type BusinessImportTablePort={parse(bytes:Uint8Array,mapping:Pick<BusinessImportMapping,'delimiter'>,signal?:AbortSignal):Promise<BusinessImportTable>}
/** 宿主内部事务守卫；新导入不得收养另一个用途已提交的批次。默认保留普通批次的回执回放。 */
export type BusinessRecordBatchDefinitionGuard={scope:string;type:string;schemaFingerprint:string;receiptPolicy?:'new-only'}

const invalid=()=>new WorkError('teloa/invalid-input','业务表格导入参数不正确。')
const bad=()=>new WorkError('teloa/invalid-host-response','业务表格导入回包格式或身份不一致。')
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v)
const hash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)
const integer=(v:unknown,min:number,max=2147483647):v is number=>Number.isSafeInteger(v)&&Number(v)>=min&&Number(v)<=max
const text=(v:unknown,max:number):v is string=>typeof v==='string'&&v.length>0&&v===v.trim()&&v.length<=max&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v)
const raw=(v:unknown,max:number):v is string=>typeof v==='string'&&v.length<=max
const scope=(v:unknown):v is string=>isBusinessScopeKey(v)&&v!=='general'
const field=(v:unknown):v is string=>typeof v==='string'&&/^[a-z0-9][a-z0-9_-]{0,62}$/.test(v)
const delimiter=(v:unknown):v is BusinessImportMapping['delimiter']=>v===','||v===';'||v==='\t'
const name=(v:unknown):v is string=>text(v,240)&&v!=='.'&&v!=='..'&&!/[\/\\\r\n]/.test(v)
const stamp=(v:unknown):v is string=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v
const unique=(values:string[])=>new Set(values).size===values.length
const byteSize=(v:unknown)=>new TextEncoder().encode(industryUpdateCanonical(v)).byteLength
function exact(v:unknown,required:string[],optional:string[]=[]):Record<string,unknown>{
 if(!isRecord(v)||required.some(key=>!Object.hasOwn(v,key))||Object.keys(v).some(key=>!required.includes(key)&&!optional.includes(key))||optional.some(key=>Object.hasOwn(v,key)&&v[key]===undefined))throw invalid()
 return v
}
function response<T>(read:()=>T):T{try{return read()}catch{throw bad()}}
function target(r:Record<string,unknown>):{scope:string;type:string}{if(!scope(r.scope)||!text(r.type,80))throw invalid();return {scope:r.scope,type:r.type}}
function draftId(r:Record<string,unknown>):string{if(!uuid(r.draftId))throw invalid();return r.draftId}
function requestId(r:Record<string,unknown>):string{if(!uuid(r.requestId))throw invalid();return r.requestId}
function revision(v:unknown):number{if(!integer(v,1))throw invalid();return v}
function sourceColumn(v:unknown,columns:number):BusinessImportSourceColumn{
 const r=exact(v,['column','trim'])
 if(!integer(r.column,0,columns-1)||typeof r.trim!=='boolean')throw invalid()
 return {column:r.column,trim:r.trim}
}
/** 列序号与 trim 独立保留，字段按稳定 name 归一；列存在性可由完整解析结果收紧。 */
export function readBusinessImportMapping(value:unknown,columns=64):BusinessImportMapping{
 const r=exact(value,['delimiter','headerRow','primaryKey','title','fields'],['summary'])
 if(!integer(columns,1,64)||!delimiter(r.delimiter)||r.headerRow!==1||!Array.isArray(r.primaryKey)||r.primaryKey.length<1||r.primaryKey.length>3||!Array.isArray(r.fields)||r.fields.length>50)throw invalid()
 const primaryKey=r.primaryKey.map(v=>sourceColumn(v,columns))
 if(new Set(primaryKey.map(v=>v.column)).size!==primaryKey.length)throw invalid()
 const fields=r.fields.map(value=>{
  const f=exact(value,['field','value'],['currency'])
  if(!field(f.field))throw invalid()
  let currency:BusinessImportFieldMapping['currency']
  if(f.currency!==undefined){
   if(isRecord(f.currency)&&Object.hasOwn(f.currency,'fixed')){
    const c=exact(f.currency,['fixed'])
    if(typeof c.fixed!=='string'||! /^[A-Z]{3}$/.test(c.fixed))throw invalid()
    currency={fixed:c.fixed}
   }else currency=sourceColumn(f.currency,columns)
  }
  return {field:f.field,value:sourceColumn(f.value,columns),...(currency===undefined?{}:{currency})}
 })
 if(!unique(fields.map(f=>f.field)))throw invalid()
 return {delimiter:r.delimiter,headerRow:1,primaryKey,title:sourceColumn(r.title,columns),...(r.summary===undefined?{}:{summary:sourceColumn(r.summary,columns)}),fields:fields.sort((a,b)=>a.field<b.field?-1:a.field>b.field?1:0)}
}
/** 不使用宽松解码器：编码长度、声明字节和末尾补位必须共同满足规范 base64。 */
function base64(value:unknown,bytes:number):value is string{
 if(typeof value!=='string'||value.length!==4*Math.ceil(bytes/3)||value.length>4*Math.ceil(2_097_152/3)||! /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))return false
 const padding=value.endsWith('==')?2:value.endsWith('=')?1:0
 if(value.length/4*3-padding!==bytes)return false
 const chars='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
 return padding===0||chars.indexOf(value[value.length-padding-1]!)%(padding===2?16:4)===0
}
export function readBusinessImportStageInput(value:unknown):BusinessImportStageInput{
 const r=exact(value,['requestId','scope','type','name','bytes','dataBase64'])
 if(!name(r.name)||!integer(r.bytes,0,2_097_152)||!base64(r.dataBase64,r.bytes))throw invalid()
 return {requestId:requestId(r),...target(r),name:r.name,bytes:r.bytes,dataBase64:r.dataBase64}
}
export function readBusinessImportStageReceiptInput(value:unknown):BusinessImportStageReceiptInput{const r=exact(value,['requestId','scope','type']);return {requestId:requestId(r),...target(r)}}
export function readBusinessImportGetInput(value:unknown):BusinessImportGetInput{const r=exact(value,['draftId']);return {draftId:draftId(r)}}
export function readBusinessImportInspectInput(value:unknown):BusinessImportInspectInput{
 const r=exact(value,['draftId','expectedRevision','delimiter']);if(!delimiter(r.delimiter))throw invalid()
 return {draftId:draftId(r),expectedRevision:revision(r.expectedRevision),delimiter:r.delimiter}
}
export function readBusinessImportPreviewInput(value:unknown):BusinessImportPreviewInput{
 const r=exact(value,['draftId','expectedRevision','mapping'])
 return {draftId:draftId(r),expectedRevision:revision(r.expectedRevision),mapping:readBusinessImportMapping(r.mapping)}
}
export function readBusinessImportApplyInput(value:unknown):BusinessImportApplyInput{
 const r=exact(value,['requestId','draftId','previewRevision','previewDigest']);if(!hash(r.previewDigest))throw invalid()
 return {requestId:requestId(r),draftId:draftId(r),previewRevision:revision(r.previewRevision),previewDigest:r.previewDigest}
}
export function readBusinessImportRevisionInput(value:unknown):BusinessImportRevisionInput{
 const r=exact(value,['requestId','draftId','expectedRevision']);return {requestId:requestId(r),draftId:draftId(r),expectedRevision:revision(r.expectedRevision)}
}
export function readBusinessImportReceiptInput(value:unknown):BusinessImportReceiptInput{
 const r=exact(value,['requestId','scope']);if(!scope(r.scope))throw invalid();return {requestId:requestId(r),scope:r.scope}
}
export function readBusinessImportFileRef(value:unknown):BusinessImportFileRef{return response(()=>{
 const r=exact(value,['attachmentId','name','bytes','sha256'])
 if(!text(r.attachmentId,200)||!name(r.name)||!integer(r.bytes,0,2_097_152)||!hash(r.sha256))throw invalid()
 return {attachmentId:r.attachmentId,name:r.name,bytes:r.bytes,sha256:r.sha256}
})}
export function readBusinessImportRow(value:unknown):BusinessImportRow{
 const r=exact(value,['rowNumber','cells'])
 if(!integer(r.rowNumber,1,51)||!Array.isArray(r.cells)||r.cells.length<1||r.cells.length>64||!r.cells.every(v=>raw(v,4000)))throw invalid()
 return {rowNumber:r.rowNumber,cells:[...r.cells] as string[]}
}
export function readBusinessImportTable(value:unknown):BusinessImportTable{
 const r=exact(value,['format','parserVersion','columns','rows'])
 if(r.format!=='teloa.business-import-table/v1'||r.parserVersion!=='csv-v1'||!integer(r.columns,1,64)||!Array.isArray(r.rows)||r.rows.length<2||r.rows.length>51)throw invalid()
 const rows=r.rows.map(readBusinessImportRow)
 if(rows.some((row,index)=>row.rowNumber!==index+1||row.cells.length!==r.columns))throw invalid()
 return {format:r.format,parserVersion:r.parserVersion,columns:r.columns,rows}
}
/** 限额错误仍需表达第 52 行/第 65 列，issue 的实际位置不受成功表格限额约束。 */
export function readBusinessImportIssue(value:unknown):BusinessImportIssue{
 const r=exact(value,['code','message'],['rowNumber','column','field'])
 if(!text(r.code,64)||!text(r.message,240)||r.rowNumber!==undefined&&!integer(r.rowNumber,1)||r.column!==undefined&&!integer(r.column,0)||r.field!==undefined&&!field(r.field))throw invalid()
 return {code:r.code,message:r.message,...(r.rowNumber===undefined?{}:{rowNumber:r.rowNumber as number}),...(r.column===undefined?{}:{column:r.column as number}),...(r.field===undefined?{}:{field:r.field as string})}
}
export function readBusinessImportIssues(value:unknown):BusinessImportIssue[]{if(!Array.isArray(value)||value.length>100)throw invalid();return value.map(readBusinessImportIssue)}
export function readBusinessImportInspection(value:unknown):BusinessImportInspection{return response(()=>{
 const r=exact(value,['format','draftId','scope','type','fileHash','revision','delimiter','parserVersion','headerRow','columns','sampleRows','issues','complete','canMap'],['sampleRowsOmitted','dataRows'])
 const t=target(r)
 if(r.format!=='teloa.business-import-inspection/v1'||!hash(r.fileHash)||!delimiter(r.delimiter)||r.parserVersion!=='csv-v1'||r.headerRow!==1||!Array.isArray(r.columns)||r.columns.length>64||!Array.isArray(r.sampleRows)||r.sampleRows.length>5||typeof r.complete!=='boolean'||typeof r.canMap!=='boolean')throw invalid()
 const columns=r.columns.map((value,index)=>{const c=exact(value,['column','header']);if(c.column!==index||!raw(c.header,4000))throw invalid();return {column:index,header:c.header}})
 const sampleRows=r.sampleRows.map(readBusinessImportRow),issues=readBusinessImportIssues(r.issues)
 if(sampleRows.some((row,index)=>row.rowNumber!==index+2||row.cells.length!==columns.length)||byteSize(sampleRows)>65_536)throw invalid()
 if(r.complete){
  if(!integer(r.dataRows,1,50)||!integer(r.sampleRowsOmitted,0,50)||r.dataRows!==sampleRows.length+r.sampleRowsOmitted||columns.length<1||issues.length||!r.canMap)throw invalid()
 }else if(columns.length||sampleRows.length||r.dataRows!==undefined||r.sampleRowsOmitted!==undefined||!issues.length||r.canMap)throw invalid()
 const result={format:r.format,draftId:draftId(r),...t,fileHash:r.fileHash,revision:revision(r.revision),delimiter:r.delimiter,parserVersion:r.parserVersion,headerRow:1,columns,sampleRows,...(r.dataRows===undefined?{}:{dataRows:r.dataRows as number,sampleRowsOmitted:r.sampleRowsOmitted as number}),issues,complete:r.complete,canMap:r.canMap} as BusinessImportInspection
 if(byteSize(result)>524_288)throw invalid()
 return result
})}
export function readBusinessImportPreview(value:unknown):BusinessImportPreview{return response(()=>{
 const r=exact(value,['revision','digest','schemaFingerprint','writeSchemaFingerprint','configurationVersion','sourceIdentity','sourcePolicyDigest','contentKey','mapping','rows','issues','canApply'])
 if(!['digest','schemaFingerprint','writeSchemaFingerprint','sourceIdentity','sourcePolicyDigest','contentKey'].every(key=>hash(r[key]))||!integer(r.configurationVersion,1)||!Array.isArray(r.rows)||r.rows.length>50||typeof r.canApply!=='boolean')throw invalid()
 const mapping=readBusinessImportMapping(r.mapping),issues=readBusinessImportIssues(r.issues)
 const rows=r.rows.map(value=>{
  const row=exact(value,['rowNumber','primaryKey','operation'])
  if(!integer(row.rowNumber,2,51)||!Array.isArray(row.primaryKey)||row.primaryKey.length!==mapping.primaryKey.length||!row.primaryKey.every((v,index)=>raw(v,4000)&&v.length>0&&(!mapping.primaryKey[index]!.trim||v===v.trim())))throw invalid()
  const op=exact(row.operation,['operation','type','title','summary','fields'])
  if(op.operation!=='create')throw invalid()
  const {operation:_,...body}=op
  const {scope:__,requestId:___,...create}=readBusinessRecordCreate({...body,scope:'import-validation',requestId:'00000000-0000-4000-8000-000000000000'})
  return {rowNumber:row.rowNumber,primaryKey:[...row.primaryKey] as string[],operation:{operation:'create' as const,...create}}
 })
 if(rows.some((row,index)=>index>0&&row.rowNumber<=rows[index-1]!.rowNumber)||r.canApply&&(issues.length||rows.length<1||rows.some((row,index)=>row.rowNumber!==index+2)||!unique(rows.map(row=>industryUpdateCanonical(row.primaryKey)))))throw invalid()
 return {revision:revision(r.revision),digest:r.digest as string,schemaFingerprint:r.schemaFingerprint as string,writeSchemaFingerprint:r.writeSchemaFingerprint as string,configurationVersion:r.configurationVersion,sourceIdentity:r.sourceIdentity as string,sourcePolicyDigest:r.sourcePolicyDigest as string,contentKey:r.contentKey as string,mapping,rows,issues,canApply:r.canApply}
})}
export function readBusinessImportReceipt(value:unknown):BusinessImportReceipt{return response(()=>{
 const r=exact(value,['requestId','canonicalRequestId','draftId','scope','type','fileHash','previewDigest','sourceIdentity','sourcePolicyDigest','contentKey','created','references','appliedAt']),t=target(r)
 if(!uuid(r.canonicalRequestId)||!['fileHash','previewDigest','sourceIdentity','sourcePolicyDigest','contentKey'].every(key=>hash(r[key]))||!integer(r.created,1,50)||!Array.isArray(r.references)||r.references.length!==r.created||!stamp(r.appliedAt))throw invalid()
 const references=r.references.map(businessObjectReference)
 if(references.some(ref=>ref.scope!==t.scope||ref.type!==t.type||!uuid(ref.id))||!unique(references.map(ref=>ref.id)))throw invalid()
 return {requestId:requestId(r),canonicalRequestId:r.canonicalRequestId,draftId:draftId(r),...t,fileHash:r.fileHash as string,previewDigest:r.previewDigest as string,sourceIdentity:r.sourceIdentity as string,sourcePolicyDigest:r.sourcePolicyDigest as string,contentKey:r.contentKey as string,created:r.created,references,appliedAt:r.appliedAt}
})}
export function readBusinessImportDraft(value:unknown):BusinessImportDraft{return response(()=>{
 const r=exact(value,['format','id','stageRequestId','ownerId','scope','type','sourceIdentity','revision','status','file','createdAt','updatedAt'],['mapping','preview','receipt']),t=target(r)
 if(r.format!=='teloa.business-record-import/v1'||!uuid(r.id)||!uuid(r.stageRequestId)||!text(r.ownerId,128)||!hash(r.sourceIdentity)||!integer(r.revision,1)||typeof r.status!=='string'||!['ready','previewed','cancelled','applied'].includes(r.status)||!stamp(r.createdAt)||!stamp(r.updatedAt)||r.updatedAt<r.createdAt)throw invalid()
 const file=readBusinessImportFileRef(r.file),mapping=r.mapping===undefined?undefined:readBusinessImportMapping(r.mapping),preview=r.preview===undefined?undefined:readBusinessImportPreview(r.preview),receipt=r.receipt===undefined?undefined:readBusinessImportReceipt(r.receipt)
 if(r.status==='ready'&&(preview||receipt)||r.status==='previewed'&&(!mapping||!preview||receipt||preview.revision!==r.revision)||r.status==='cancelled'&&receipt||r.status==='applied'&&!receipt)throw invalid()
 if(r.status==='applied'&&preview&&(!preview.canApply||receipt!.created!==preview.rows.length))throw invalid()
 if(preview&&(preview.revision>r.revision||preview.sourceIdentity!==r.sourceIdentity||!mapping||industryUpdateCanonical(mapping)!==industryUpdateCanonical(preview.mapping)||preview.rows.some(row=>row.operation.type!==t.type)))throw invalid()
 // 同来源成功别名沿原 appliedAt；它可早于此次重传草案的 createdAt。
 if(receipt&&(receipt.draftId!==r.id||receipt.scope!==t.scope||receipt.type!==t.type||receipt.fileHash!==file.sha256||receipt.sourceIdentity!==r.sourceIdentity||receipt.appliedAt>r.updatedAt||preview&&(receipt.previewDigest!==preview.digest||receipt.sourcePolicyDigest!==preview.sourcePolicyDigest||receipt.contentKey!==preview.contentKey)))throw invalid()
 const result={format:r.format,id:r.id,stageRequestId:r.stageRequestId,ownerId:r.ownerId,...t,sourceIdentity:r.sourceIdentity,revision:r.revision,status:r.status,file,...(mapping===undefined?{}:{mapping}),...(preview===undefined?{}:{preview}),...(receipt===undefined?{}:{receipt}),createdAt:r.createdAt,updatedAt:r.updatedAt} as BusinessImportDraft
 if(byteSize(result)>1_048_576)throw invalid()
 return result
})}
/** null 仅表示未读到回执，调用方必须保留传输未知状态。 */
export function readBusinessImportStageReceiptResponse(value:unknown):BusinessImportDraft|null{return value===null?null:readBusinessImportDraft(value)}
export function readBusinessImportReceiptResponse(value:unknown):BusinessImportReceipt|null{return value===null?null:readBusinessImportReceipt(value)}

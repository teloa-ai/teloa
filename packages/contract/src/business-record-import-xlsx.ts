import {WorkError} from './work-error.ts'
import {isRecord} from './resources.ts'
import {industryUpdateCanonical} from './industry-update-compare.ts'
import {readBusinessImportMapping,readBusinessImportStageInput,readBusinessImportInspectInput,readBusinessImportPreviewInput,readBusinessImportInspection,readBusinessImportPreview,readBusinessImportReceipt,readBusinessImportDraft,type BusinessImportMapping,type BusinessImportStageInput,type BusinessImportInspectInput,type BusinessImportPreviewInput,type BusinessImportInspection,type BusinessImportPreview,type BusinessImportReceipt,type BusinessImportDraft} from './business-record-import.ts'

export type BusinessImportSheetV2={sheetId:string;name:string;part:string}
export type BusinessImportSourceV2={kind:'xlsx';sheet:BusinessImportSheetV2}
export type BusinessImportPolicyV2={parserVersion:'xlsx-scalar-v1';scalarPolicy:'closed-scalar-v1';datePolicy:'reject-date-v1';formulaPolicy:'reject-formula-v1'}
export type BusinessImportCellV2={kind:'blank';text:''}|{kind:'string';text:string}|{kind:'number';text:string}|{kind:'boolean';text:'true'|'false'}
export type BusinessImportRowV2={rowNumber:number;cells:BusinessImportCellV2[]}
export type BusinessImportTableV2={format:'teloa.business-import-table/v2';source:BusinessImportSourceV2;policy:BusinessImportPolicyV2;columns:number;rows:BusinessImportRowV2[]}
export type BusinessImportMappingV2=Omit<BusinessImportMapping,'delimiter'>
export type BusinessImportWorkbookInputV2=Omit<BusinessImportStageInput,'requestId'>
export type BusinessImportWorkbookV2={format:'teloa.business-import-workbook/v2';fileHash:string;bytes:number;sheets:BusinessImportSheetV2[];policy:BusinessImportPolicyV2}
export type BusinessImportStageInputV2=BusinessImportStageInput&{format:'teloa.business-import-stage/v2';source:BusinessImportSourceV2}
export type BusinessImportInspectInputV2={draftId:string;expectedRevision:number;format:'teloa.business-import-inspect/v2'}
export type BusinessImportPreviewInputV2={draftId:string;expectedRevision:number;format:'teloa.business-import-preview-input/v2';mapping:BusinessImportMappingV2}
export type BusinessImportInspectionV2=Omit<BusinessImportInspection,'format'|'delimiter'|'parserVersion'|'sampleRows'>&{format:'teloa.business-import-inspection/v2';source:BusinessImportSourceV2;policy:BusinessImportPolicyV2;rawCellsDigest:string|null;sampleRows:BusinessImportRowV2[]}
export type BusinessImportPreviewV2=Omit<BusinessImportPreview,'mapping'>&{format:'teloa.business-import-preview/v2';source:BusinessImportSourceV2;policy:BusinessImportPolicyV2;rawCellsDigest:string|null;mapping:BusinessImportMappingV2}
export type BusinessImportReceiptV2=BusinessImportReceipt&{format:'teloa.business-import-receipt/v2';source:BusinessImportSourceV2;policy:BusinessImportPolicyV2;rawCellsDigest:string}
export type BusinessImportDraftV2=Omit<BusinessImportDraft,'format'|'mapping'|'preview'|'receipt'>&{format:'teloa.business-record-import/v2';source:BusinessImportSourceV2;policy:BusinessImportPolicyV2;mapping?:BusinessImportMappingV2;preview?:BusinessImportPreviewV2;receipt?:BusinessImportReceiptV2}
export type BusinessImportXlsxPort={inspectWorkbook(bytes:Uint8Array,signal?:AbortSignal):Promise<BusinessImportWorkbookV2>;parseSheet(bytes:Uint8Array,source:BusinessImportSourceV2,signal?:AbortSignal):Promise<BusinessImportTableV2>}

const invalid=()=>new WorkError('teloa/invalid-input','业务 XLSX 导入参数不正确。')
const bad=()=>new WorkError('teloa/invalid-host-response','业务 XLSX 导入回包格式或身份不一致。')
const hash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)
const integer=(v:unknown,min:number,max:number):v is number=>Number.isSafeInteger(v)&&Number(v)>=min&&Number(v)<=max
const size=(v:unknown)=>new TextEncoder().encode(industryUpdateCanonical(v)).byteLength
function exact(v:unknown,required:string[],optional:string[]=[]):Record<string,unknown>{
 if(!isRecord(v)||required.some(k=>!Object.hasOwn(v,k))||Object.keys(v).some(k=>!required.includes(k)&&!optional.includes(k))||[...required,...optional].some(k=>Object.hasOwn(v,k)&&v[k]===undefined))throw invalid()
 return v
}
function response<T>(read:()=>T):T{try{return read()}catch{throw bad()}}
function format(r:Record<string,unknown>,expected:string){if(r.format!==expected)throw invalid()}
/** 仅在 exact 拒绝未知键后按明确清单投影；不允许输入键被默认值覆盖。 */
function pick(r:Record<string,unknown>,keys:string[]):Record<string,unknown>{return Object.fromEntries(keys.filter(k=>Object.hasOwn(r,k)).map(k=>[k,r[k]]))}
const mappingKeys=['headerRow','primaryKey','title','fields','summary']
const stageKeys=['requestId','scope','type','name','bytes','dataBase64']
const inspectionKeys=['draftId','scope','type','fileHash','revision','headerRow','columns','issues','complete','canMap','sampleRowsOmitted','dataRows']
const previewKeys=['revision','digest','schemaFingerprint','writeSchemaFingerprint','configurationVersion','sourceIdentity','sourcePolicyDigest','contentKey','rows','issues','canApply']
const receiptKeys=['requestId','canonicalRequestId','draftId','scope','type','fileHash','previewDigest','sourceIdentity','sourcePolicyDigest','contentKey','created','references','appliedAt']
const draftKeys=['id','stageRequestId','ownerId','scope','type','sourceIdentity','revision','status','file','createdAt','updatedAt']
const v2Keys=['format','source','policy','rawCellsDigest']
/** 旧 reader 的 map/every 会跳过空位；v2 委托前只核数组自有下标，不解释业务字符串。 */
function dense(value:unknown,max:number):unknown[]{
 if(!Array.isArray(value)||value.length>max)throw invalid()
 for(let i=0;i<value.length;i++)if(!Object.hasOwn(value,i))throw invalid()
 return value
}
function same(a:unknown,b:unknown){if(industryUpdateCanonical(a)!==industryUpdateCanonical(b))throw invalid()}
function budget(v:unknown,max:number){if(size(v)>max)throw invalid()}
export function readBusinessImportSheetV2(value:unknown):BusinessImportSheetV2{
 const r=exact(value,['sheetId','name','part'])
 if(typeof r.sheetId!=='string'||! /^[1-9][0-9]{0,9}$/.test(r.sheetId)||Number(r.sheetId)>4294967295||typeof r.name!=='string'||r.name.length<1||r.name.length>31||/[\[\]:*?/\\\x00-\x1f\x7f]/.test(r.name)||typeof r.part!=='string'||r.part.length>300||!r.part.endsWith('.xml')||/[\\\x00-\x1f\x7f:%?#]/.test(r.part)||r.part.split('/').some(s=>s===''||s==='.'||s==='..'))throw invalid()
 return {sheetId:r.sheetId,name:r.name,part:r.part}
}
export function readBusinessImportSourceV2(value:unknown):BusinessImportSourceV2{const r=exact(value,['kind','sheet']);if(r.kind!=='xlsx')throw invalid();return {kind:'xlsx',sheet:readBusinessImportSheetV2(r.sheet)}}
export function readBusinessImportPolicyV2(value:unknown):BusinessImportPolicyV2{
 const r=exact(value,['parserVersion','scalarPolicy','datePolicy','formulaPolicy'])
 if(r.parserVersion!=='xlsx-scalar-v1'||r.scalarPolicy!=='closed-scalar-v1'||r.datePolicy!=='reject-date-v1'||r.formulaPolicy!=='reject-formula-v1')throw invalid()
 return {parserVersion:r.parserVersion,scalarPolicy:r.scalarPolicy,datePolicy:r.datePolicy,formulaPolicy:r.formulaPolicy}
}
export function readBusinessImportCellV2(value:unknown):BusinessImportCellV2{
 const r=exact(value,['kind','text'])
 if(typeof r.text!=='string'||r.text.length>4000||!(r.kind==='string'||r.kind==='blank'&&r.text===''||r.kind==='boolean'&&(r.text==='true'||r.text==='false')||r.kind==='number'&&/^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[Ee][+-]?[0-9]+)?$/.test(r.text)))throw invalid()
 return {kind:r.kind,text:r.text} as BusinessImportCellV2
}
export function readBusinessImportRowV2(value:unknown):BusinessImportRowV2{const r=exact(value,['rowNumber','cells']);if(!integer(r.rowNumber,1,51)||!Array.isArray(r.cells)||r.cells.length<1||r.cells.length>64)throw invalid();return {rowNumber:r.rowNumber,cells:Array.from(r.cells,readBusinessImportCellV2)}}
export function readBusinessImportTableV2(value:unknown):BusinessImportTableV2{
 const r=exact(value,['format','source','policy','columns','rows']);format(r,'teloa.business-import-table/v2')
 if(!integer(r.columns,1,64)||!Array.isArray(r.rows)||r.rows.length<2||r.rows.length>51)throw invalid()
 const rows=Array.from(r.rows,readBusinessImportRowV2)
 if(rows.some((row,i)=>row.rowNumber!==i+1||row.cells.length!==r.columns))throw invalid()
 const result={format:r.format as BusinessImportTableV2['format'],source:readBusinessImportSourceV2(r.source),policy:readBusinessImportPolicyV2(r.policy),columns:r.columns,rows}
 return result
}
export function readBusinessImportMappingV2(value:unknown,columns=64):BusinessImportMappingV2{
 const r=exact(value,['headerRow','primaryKey','title','fields'],['summary'])
 dense(r.primaryKey,3);dense(r.fields,50)
 const {delimiter:_,...mapping}=readBusinessImportMapping({delimiter:',',...pick(r,mappingKeys)},columns);return mapping
}
export function readBusinessImportWorkbookInputV2(value:unknown):BusinessImportWorkbookInputV2{
 const r=exact(value,['scope','type','name','bytes','dataBase64'])
 const {requestId:_,...input}=readBusinessImportStageInput({requestId:'00000000-0000-4000-8000-000000000000',...pick(r,stageKeys)});return input
}
export function readBusinessImportWorkbookV2(value:unknown):BusinessImportWorkbookV2{return response(()=>{
 const r=exact(value,['format','fileHash','bytes','sheets','policy']);format(r,'teloa.business-import-workbook/v2')
 if(!hash(r.fileHash)||!integer(r.bytes,0,2_097_152)||!Array.isArray(r.sheets)||r.sheets.length<1||r.sheets.length>16)throw invalid()
 const sheets=Array.from(r.sheets,readBusinessImportSheetV2)
 for(const values of [sheets.map(s=>s.sheetId),sheets.map(s=>s.part),sheets.map(s=>s.name.normalize('NFC').toLowerCase())])if(new Set(values).size!==values.length)throw invalid()
 return {format:r.format as BusinessImportWorkbookV2['format'],fileHash:r.fileHash,bytes:r.bytes,sheets,policy:readBusinessImportPolicyV2(r.policy)}
})}
export function readBusinessImportStageInputV2(value:unknown):BusinessImportStageInputV2{const r=exact(value,[...stageKeys,'format','source']);format(r,'teloa.business-import-stage/v2');return {...readBusinessImportStageInput(pick(r,stageKeys)),format:r.format as BusinessImportStageInputV2['format'],source:readBusinessImportSourceV2(r.source)}}
export function readBusinessImportInspectInputV2(value:unknown):BusinessImportInspectInputV2{
 const r=exact(value,['draftId','expectedRevision','format']);format(r,'teloa.business-import-inspect/v2')
 const {delimiter:_,...input}=readBusinessImportInspectInput({...pick(r,['draftId','expectedRevision']),delimiter:','});return {...input,format:r.format as BusinessImportInspectInputV2['format']}
}
export function readBusinessImportPreviewInputV2(value:unknown):BusinessImportPreviewInputV2{
 const r=exact(value,['draftId','expectedRevision','format','mapping']);format(r,'teloa.business-import-preview-input/v2');const mapping=readBusinessImportMappingV2(r.mapping)
 const {mapping:_,...input}=readBusinessImportPreviewInput({...pick(r,['draftId','expectedRevision']),mapping:{delimiter:',',...mapping}});return {...input,format:r.format as BusinessImportPreviewInputV2['format'],mapping}
}
export function readBusinessImportInspectionV2(value:unknown):BusinessImportInspectionV2{return response(()=>{
 const r=exact(value,['format','source','policy','rawCellsDigest','sampleRows',...inspectionKeys.filter(k=>k!=='sampleRowsOmitted'&&k!=='dataRows')],['sampleRowsOmitted','dataRows']);format(r,'teloa.business-import-inspection/v2')
 dense(r.columns,64);dense(r.issues,100)
 if(!Array.isArray(r.sampleRows))throw invalid()
 const sampleRows=Array.from(r.sampleRows,readBusinessImportRowV2);budget(sampleRows,65_536)
 const {format:_,delimiter:__,parserVersion:___,sampleRows:____,...base}=readBusinessImportInspection({...pick(r,inspectionKeys),format:'teloa.business-import-inspection/v1',delimiter:',',parserVersion:'csv-v1',sampleRows:sampleRows.map(row=>({rowNumber:row.rowNumber,cells:row.cells.map(cell=>cell.text)}))})
 if(base.complete?!hash(r.rawCellsDigest):r.rawCellsDigest!==null)throw invalid()
 const result={...base,format:r.format as BusinessImportInspectionV2['format'],source:readBusinessImportSourceV2(r.source),policy:readBusinessImportPolicyV2(r.policy),rawCellsDigest:r.rawCellsDigest as string|null,sampleRows};budget(result,524_288);return result
})}
function previewV1(p:BusinessImportPreviewV2):BusinessImportPreview{return {...pick(p as unknown as Record<string,unknown>,previewKeys),mapping:{delimiter:',',...p.mapping}} as BusinessImportPreview}
function receiptV1(p:BusinessImportReceiptV2):BusinessImportReceipt{return pick(p as unknown as Record<string,unknown>,receiptKeys) as BusinessImportReceipt}
export function readBusinessImportPreviewV2(value:unknown):BusinessImportPreviewV2{return response(()=>{
 const r=exact(value,[...v2Keys,...previewKeys,'mapping']);format(r,'teloa.business-import-preview/v2');const mapping=readBusinessImportMappingV2(r.mapping)
 dense(r.issues,100)
 for(const row of dense(r.rows,50)){
  if(!isRecord(row)||!isRecord(row.operation))throw invalid()
  dense(row.primaryKey,3);dense(row.operation.fields,50)
 }
 const {mapping:_,...base}=readBusinessImportPreview({...pick(r,previewKeys),mapping:{delimiter:',',...mapping}})
 if(r.rawCellsDigest!==null&&!hash(r.rawCellsDigest)||r.rawCellsDigest===null&&(base.rows.length!==0||base.issues.length===0||base.canApply))throw invalid()
 const result={...base,format:r.format as BusinessImportPreviewV2['format'],source:readBusinessImportSourceV2(r.source),policy:readBusinessImportPolicyV2(r.policy),rawCellsDigest:r.rawCellsDigest as string|null,mapping};return result
})}
export function readBusinessImportReceiptV2(value:unknown):BusinessImportReceiptV2{return response(()=>{
 const r=exact(value,[...v2Keys,...receiptKeys]);format(r,'teloa.business-import-receipt/v2');if(!hash(r.rawCellsDigest))throw invalid()
 dense(r.references,50)
 const result={...readBusinessImportReceipt(pick(r,receiptKeys)),format:r.format as BusinessImportReceiptV2['format'],source:readBusinessImportSourceV2(r.source),policy:readBusinessImportPolicyV2(r.policy),rawCellsDigest:r.rawCellsDigest};return result
})}
export function readBusinessImportDraftV2(value:unknown):BusinessImportDraftV2{return response(()=>{
 const r=exact(value,['format','source','policy',...draftKeys],['mapping','preview','receipt']);format(r,'teloa.business-record-import/v2')
 const source=readBusinessImportSourceV2(r.source),policy=readBusinessImportPolicyV2(r.policy),mapping=r.mapping===undefined?undefined:readBusinessImportMappingV2(r.mapping),preview=r.preview===undefined?undefined:readBusinessImportPreviewV2(r.preview),receipt=r.receipt===undefined?undefined:readBusinessImportReceiptV2(r.receipt)
 for(const nested of [preview,receipt])if(nested){same(source,nested.source);same(policy,nested.policy)}
 if(preview&&receipt)same(preview.rawCellsDigest,receipt.rawCellsDigest)
 const {format:_,mapping:__,preview:___,receipt:____,...base}=readBusinessImportDraft({...pick(r,draftKeys),format:'teloa.business-record-import/v1',...(mapping?{mapping:{delimiter:',',...mapping}}:{}),...(preview?{preview:previewV1(preview)}:{}),...(receipt?{receipt:receiptV1(receipt)}:{})})
 const result={...base,format:r.format as BusinessImportDraftV2['format'],source,policy,...(mapping?{mapping}:{}),...(preview?{preview}:{}),...(receipt?{receipt}:{})};budget(result,1_048_576);return result
})}
export type BusinessImportAnyDraft=BusinessImportDraft|BusinessImportDraftV2
export type BusinessImportAnyReceipt=BusinessImportReceipt|BusinessImportReceiptV2
export type BusinessImportAnyInspection=BusinessImportInspection|BusinessImportInspectionV2
export type BusinessImportAnyStageInput=BusinessImportStageInput|BusinessImportStageInputV2
export type BusinessImportAnyInspectInput=BusinessImportInspectInput|BusinessImportInspectInputV2
export type BusinessImportAnyPreviewInput=BusinessImportPreviewInput|BusinessImportPreviewInputV2
function dispatch<T,U>(value:unknown,v1:string|null,v2:string,old:(v:unknown)=>T,next:(v:unknown)=>U):T|U{
 if(isRecord(value)&&Object.hasOwn(value,'format')){if(value.format===v2)return next(value);if(v1!==null&&value.format===v1)return old(value);throw invalid()}
 if(v1===null)return old(value);throw invalid()
}
export function readBusinessImportAnyDraft(value:unknown):BusinessImportAnyDraft{return response(()=>dispatch(value,'teloa.business-record-import/v1','teloa.business-record-import/v2',readBusinessImportDraft,readBusinessImportDraftV2))}
export function readBusinessImportAnyReceipt(value:unknown):BusinessImportAnyReceipt{return response(()=>dispatch(value,null,'teloa.business-import-receipt/v2',readBusinessImportReceipt,readBusinessImportReceiptV2))}
export function readBusinessImportAnyInspection(value:unknown):BusinessImportAnyInspection{return response(()=>dispatch(value,'teloa.business-import-inspection/v1','teloa.business-import-inspection/v2',readBusinessImportInspection,readBusinessImportInspectionV2))}
export function readBusinessImportAnyStageInput(value:unknown):BusinessImportAnyStageInput{return dispatch(value,null,'teloa.business-import-stage/v2',readBusinessImportStageInput,readBusinessImportStageInputV2)}
export function readBusinessImportAnyInspectInput(value:unknown):BusinessImportAnyInspectInput{return dispatch(value,null,'teloa.business-import-inspect/v2',readBusinessImportInspectInput,readBusinessImportInspectInputV2)}
export function readBusinessImportAnyPreviewInput(value:unknown):BusinessImportAnyPreviewInput{return dispatch(value,null,'teloa.business-import-preview-input/v2',readBusinessImportPreviewInput,readBusinessImportPreviewInputV2)}
/** null 仅代表未读到回执，保持调用方的传输未知状态。 */
export function readBusinessImportAnyStageReceiptResponse(value:unknown):BusinessImportAnyDraft|null{return value===null?null:readBusinessImportAnyDraft(value)}
export function readBusinessImportAnyReceiptResponse(value:unknown):BusinessImportAnyReceipt|null{return value===null?null:readBusinessImportAnyReceipt(value)}

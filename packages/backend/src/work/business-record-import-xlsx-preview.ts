import {
 WorkError,industryUpdateCanonical,readBusinessImportTableV2,readBusinessImportMappingV2,readBusinessImportSourceV2,readBusinessImportPolicyV2,
 readBusinessImportInspectionV2,readBusinessImportPreviewV2,readBusinessImportIssues,
 type BusinessImportSourceV2,type BusinessImportPolicyV2,type BusinessImportTableV2,type BusinessImportMappingV2,type BusinessImportIssue,type BusinessImportInspectionV2,type BusinessImportPreviewV2,type BusinessObjectReference,
} from '@teloa/contract'
import {businessImportHash,buildBusinessImportPreview} from './business-record-import-preview.ts'

type Metadata={source:BusinessImportSourceV2;policy:BusinessImportPolicyV2;table?:BusinessImportTableV2|undefined;issues?:BusinessImportIssue[]|undefined}
type InspectionInput=Metadata&{draftId:string;scope:string;type:string;fileHash:string;revision:number}
type PreviewInput=Metadata&Omit<Parameters<typeof buildBusinessImportPreview>[0],'mapping'|'table'|'issues'>&{mapping:BusinessImportMappingV2}
const bytes=(value:unknown)=>Buffer.byteLength(industryUpdateCanonical(value),'utf8')
const same=(a:unknown,b:unknown)=>industryUpdateCanonical(a)===industryUpdateCanonical(b)
export const businessImportXlsxSourceIdentity=(owner:string,scope:string,type:string,fileHash:string,source:BusinessImportSourceV2)=>businessImportHash(['teloa.business-import-sheet-source/v2',owner,scope,type,fileHash,readBusinessImportSourceV2(source)])
export const businessImportXlsxRawDigest=(table:BusinessImportTableV2)=>businessImportHash(['teloa.business-import-raw-cells/v2',table.source,table.policy,table.rows])
export const businessImportXlsxPolicyDigest=(fileHash:string,source:BusinessImportSourceV2,policy:BusinessImportPolicyV2,rawCellsDigest:string|null,mapping:BusinessImportMappingV2)=>businessImportHash(['teloa.business-import-source-policy/v2',fileHash,source,policy,rawCellsDigest,mapping.headerRow,mapping.primaryKey])
export const businessImportXlsxContentKey=(sourceIdentity:string,policyDigest:string,mapping:BusinessImportMappingV2,writeSchemaFingerprint:string)=>businessImportHash(['teloa.business-import-content/v2',sourceIdentity,policyDigest,mapping,writeSchemaFingerprint])
export const businessImportXlsxPreviewDigest=(fileHash:string,preview:Omit<BusinessImportPreviewV2,'digest'>,relations:BusinessObjectReference[])=>businessImportHash(['teloa.business-import-preview/v2',fileHash,preview.source,preview.policy,preview.rawCellsDigest,preview.mapping,preview.schemaFingerprint,preview.writeSchemaFingerprint,preview.sourceIdentity,preview.sourcePolicyDigest,preview.contentKey,preview.rows,relations,preview.issues])
function metadata(input:Metadata){
 const source=readBusinessImportSourceV2(input.source),policy=readBusinessImportPolicyV2(input.policy),table=input.table?readBusinessImportTableV2(input.table):undefined
 if(table&&(!same(source,table.source)||!same(policy,table.policy)))throw new WorkError('teloa/invalid-host-response','工作表原值与固定来源或政策不一致。')
 return {source,policy,table,issues:readBusinessImportIssues(input.issues??[])}
}
/** 仅接受现有读取器冻结的拒绝问题；授权、附件和宿主回包错误继续抛出。 */
export function businessImportXlsxParseIssues(error:unknown):BusinessImportIssue[]{
 const codes=['xlsx-package','xlsx-relationship','xlsx-feature','xlsx-limit','xlsx-xml','xlsx-string','xlsx-sheet','xlsx-style','xlsx-coordinate','xlsx-formula','xlsx-date','xlsx-type','xlsx-hidden','xlsx-merged','xlsx-empty']
 if(!(error instanceof WorkError)||error.code!=='teloa/invalid-input')throw error
 let issues:BusinessImportIssue[];try{issues=readBusinessImportIssues(error.details?.businessImportIssues)}catch{throw error}
 if(!issues.length||issues.some(issue=>!codes.includes(issue.code)))throw error
 return issues
}
/** v2预算针对真实typed回包计算，仅保留连续完整行。 */
export function buildBusinessImportXlsxInspection(input:InspectionInput):BusinessImportInspectionV2{
 const {source,policy,table,issues}=metadata(input)
 const base={format:'teloa.business-import-inspection/v2',draftId:input.draftId,scope:input.scope,type:input.type,fileHash:input.fileHash,revision:input.revision,headerRow:1,source,policy}
 const failed=(issues:BusinessImportIssue[])=>readBusinessImportInspectionV2({...base,rawCellsDigest:null,columns:[],sampleRows:[],issues,complete:false,canMap:false})
 if(issues.length)return failed(issues)
 if(!table)return failed([{code:'xlsx-empty',message:'表格没有数据行，请补充表头和至少一条数据后重试。'}])
 const data=table.rows.slice(1),sampleRows:BusinessImportTableV2['rows']=[]
 for(const row of data.slice(0,5)){if(bytes([...sampleRows,row])>65_536)break;sampleRows.push(row)}
 const result={...base,rawCellsDigest:businessImportXlsxRawDigest(table),columns:table.rows[0]!.cells.map((cell,column)=>({column,header:cell.text})),sampleRows,dataRows:data.length,sampleRowsOmitted:data.length-sampleRows.length,issues:[],complete:true,canMap:true}
 if(bytes(result)>524_288)return failed([{code:'inspection-too-large',message:'表头和样例内容过大，请减少列数或表头长度后重试。'}])
 return readBusinessImportInspectionV2(result)
}
/** 只投影原text到已有业务规范器；kind完整绑定raw域，不转换数字或显示值。 */
export async function buildBusinessImportXlsxPreview(input:PreviewInput):Promise<BusinessImportPreviewV2>{
 const {source,policy,table,issues}=metadata(input),mapping=readBusinessImportMappingV2(input.mapping)
 const usable=issues.length?undefined:table,rawCellsDigest=usable?businessImportXlsxRawDigest(usable):null,relations:BusinessObjectReference[]=[]
 const {table:_,source:__,policy:___,issues:____,...business}=input
 const old=await buildBusinessImportPreview({...business,mapping:{delimiter:',',...mapping},...(usable?{table:{format:'teloa.business-import-table/v1',parserVersion:'csv-v1',columns:usable.columns,rows:usable.rows.map(row=>({rowNumber:row.rowNumber,cells:row.cells.map(cell=>cell.text)}))}}:{}),issues,sourceContentKey:undefined,...(input.resolveReference?{resolveReference:async(type:string,id:string)=>{const target=await input.resolveReference!(type,id);const ref={scope:target.scope,type:target.type,id:target.id,version:target.version,snapshotHash:target.snapshotHash};if(!relations.some(row=>same(row,ref)))relations.push(ref);return target}}:{})})
 const sourcePolicyDigest=businessImportXlsxPolicyDigest(input.fileHash,source,policy,rawCellsDigest,mapping)
 const contentKey=businessImportXlsxContentKey(input.sourceIdentity,sourcePolicyDigest,mapping,old.writeSchemaFingerprint)
 const finalIssues=[...old.issues]
 if(input.sourceContentKey!==undefined&&input.sourceContentKey!==contentKey&&finalIssues.length<100)finalIssues.push({code:'source-policy-conflict',message:'此文件已按其他主键或映射导入，请使用原政策；更改政策不会新增另一批记录。'})
 const rows=rawCellsDigest===null?[]:old.rows
 const result={...old,format:'teloa.business-import-preview/v2' as const,source,policy,rawCellsDigest,mapping,rows,issues:finalIssues,sourcePolicyDigest,contentKey,canApply:old.canApply&&(input.sourceContentKey===undefined||input.sourceContentKey===contentKey)}
 return readBusinessImportPreviewV2({...result,digest:businessImportXlsxPreviewDigest(input.fileHash,result,relations)})
}

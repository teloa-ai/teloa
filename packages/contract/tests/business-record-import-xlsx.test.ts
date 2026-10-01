import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readBusinessImportCellV2,readBusinessImportSheetV2,readBusinessImportAnyReceiptResponse} from '../src/business-record-import-xlsx.ts'
test('typed_number_lexemes_and_exact_sheet_identity_survive_read',()=>{
 for(const text of ['001','12345678901234567890.1234','1.25E+20'])assert.deepEqual(readBusinessImportCellV2({kind:'number',text}),{kind:'number',text})
 const sheet={sheetId:'1',name:' Sheet ',part:'xl/worksheets/sheet1.xml'}
 assert.deepEqual(readBusinessImportSheetV2(sheet),sheet)
})
test('legacy_readers_reject_v2_and_dispatcher_preserves_v1',()=>assert.equal(readBusinessImportAnyReceiptResponse(null),null))
import * as xlsx from '../src/business-record-import-xlsx.ts'
import * as csv from '../src/business-record-import.ts'
import {createHash} from 'node:crypto'
import {readFileSync} from 'node:fs'
const inputCode='teloa/invalid-input',responseCode='teloa/invalid-host-response'
const requestId='11111111-1111-4111-8111-111111111111',draftId='22222222-2222-4222-8222-222222222222'
const a='a'.repeat(64),b='b'.repeat(64),c='c'.repeat(64),d='d'.repeat(64),e='e'.repeat(64),f='f'.repeat(64),stamp='2026-09-30T00:00:00.000Z'
const source={kind:'xlsx',sheet:{sheetId:'1',name:' 客户 ',part:'xl/worksheets/sheet1.xml'}}
const policy={parserVersion:'xlsx-scalar-v1',scalarPolicy:'closed-scalar-v1',datePolicy:'reject-date-v1',formulaPolicy:'reject-formula-v1'}
const mapping={headerRow:1,primaryKey:[{column:0,trim:false}],title:{column:1,trim:true},fields:[]}
const operation={operation:'create',type:'customer',title:'客户',summary:'',fields:[]}
const preview={format:'teloa.business-import-preview/v2',source,policy,rawCellsDigest:f,revision:2,digest:a,schemaFingerprint:b,writeSchemaFingerprint:c,configurationVersion:1,sourceIdentity:d,sourcePolicyDigest:e,contentKey:f,mapping,rows:[{rowNumber:2,primaryKey:['001'],operation}],issues:[],canApply:true}
const receipt={format:'teloa.business-import-receipt/v2',source,policy,rawCellsDigest:f,requestId,canonicalRequestId:requestId,draftId,scope:'crm',type:'customer',fileHash:a,previewDigest:a,sourceIdentity:d,sourcePolicyDigest:e,contentKey:f,created:1,references:[{scope:'crm',type:'customer',id:requestId,version:1,snapshotHash:a}],appliedAt:stamp}
const draft={format:'teloa.business-record-import/v2',source,policy,id:draftId,stageRequestId:requestId,ownerId:'owner',scope:'crm',type:'customer',sourceIdentity:d,revision:2,status:'applied',file:{attachmentId:'attachment-1',name:'客户.xlsx',bytes:3,sha256:a},mapping,preview,receipt,createdAt:stamp,updatedAt:stamp}
const table={format:'teloa.business-import-table/v2',source,policy,columns:2,rows:[{rowNumber:1,cells:[{kind:'string',text:'编号'},{kind:'string',text:'客户'}]},{rowNumber:2,cells:[{kind:'number',text:'001'},{kind:'string',text:'客户'}]}]}
const inspection={format:'teloa.business-import-inspection/v2',source,policy,rawCellsDigest:f,draftId,scope:'crm',type:'customer',fileHash:a,revision:2,headerRow:1,columns:[{column:0,header:'编号'},{column:1,header:'客户'}],sampleRows:[table.rows[1]],sampleRowsOmitted:9,dataRows:10,issues:[],complete:true,canMap:true}
const stage={requestId,scope:'crm',type:'customer',name:'客户.xlsx',bytes:3,dataBase64:'YWJj',format:'teloa.business-import-stage/v2',source}
function rejects(read:(v:unknown)=>unknown,values:unknown[],code=inputCode){for(const value of values)assert.throws(()=>read(value),{code})}
function without(value:Record<string,unknown>,...keys:string[]){return Object.fromEntries(Object.entries(value).filter(([k])=>!keys.includes(k)))}
test('complete_v1_literal_and_v2_dispatch_keep_identity_and_distinct_hashes',()=>{
 const v1Mapping={delimiter:',',headerRow:1,primaryKey:[{column:0,trim:false}],title:{column:1,trim:true},fields:[]}
 const v1Preview={revision:2,digest:a,schemaFingerprint:b,writeSchemaFingerprint:c,configurationVersion:1,sourceIdentity:d,sourcePolicyDigest:e,contentKey:f,mapping:v1Mapping,rows:[{rowNumber:2,primaryKey:['001'],operation}],issues:[],canApply:true}
 const v1Receipt={requestId,canonicalRequestId:requestId,draftId,scope:'crm',type:'customer',fileHash:a,previewDigest:a,sourceIdentity:d,sourcePolicyDigest:e,contentKey:f,created:1,references:[{scope:'crm',type:'customer',id:requestId,version:1,snapshotHash:a}],appliedAt:stamp}
 const v1Draft={format:'teloa.business-record-import/v1',id:draftId,stageRequestId:requestId,ownerId:'owner',scope:'crm',type:'customer',sourceIdentity:d,revision:2,status:'applied',file:{attachmentId:'attachment-1',name:'客户.csv',bytes:3,sha256:a},mapping:v1Mapping,preview:v1Preview,receipt:v1Receipt,createdAt:stamp,updatedAt:stamp}
 const v1Inspection={format:'teloa.business-import-inspection/v1',draftId,scope:'crm',type:'customer',fileHash:a,revision:2,headerRow:1,delimiter:',',parserVersion:'csv-v1',columns:[{column:0,header:'编号'},{column:1,header:'客户'}],sampleRows:[{rowNumber:2,cells:['001','客户']}],sampleRowsOmitted:9,dataRows:10,issues:[],complete:true,canMap:true}
 const v1Stage={requestId,scope:'crm',type:'customer',name:'客户.csv',bytes:3,dataBase64:'YWJj'}
 for(const [anyRead,oldRead,value] of [[xlsx.readBusinessImportAnyDraft,csv.readBusinessImportDraft,v1Draft],[xlsx.readBusinessImportAnyReceipt,csv.readBusinessImportReceipt,v1Receipt],[xlsx.readBusinessImportAnyInspection,csv.readBusinessImportInspection,v1Inspection],[xlsx.readBusinessImportAnyStageInput,csv.readBusinessImportStageInput,v1Stage],[xlsx.readBusinessImportAnyInspectInput,csv.readBusinessImportInspectInput,{draftId,expectedRevision:2,delimiter:','}],[xlsx.readBusinessImportAnyPreviewInput,csv.readBusinessImportPreviewInput,{draftId,expectedRevision:2,mapping:v1Mapping}]] as const)assert.deepEqual(anyRead(value),oldRead(value))
 assert.deepEqual(xlsx.readBusinessImportAnyDraft(draft),draft)
 assert.deepEqual(xlsx.readBusinessImportAnyReceipt(receipt),receipt)
 assert.deepEqual(xlsx.readBusinessImportAnyInspection(inspection),inspection)
 assert.deepEqual(xlsx.readBusinessImportAnyStageInput(stage),stage)
 rejects(csv.readBusinessImportDraft,[draft],responseCode);rejects(csv.readBusinessImportReceipt,[receipt],responseCode);rejects(csv.readBusinessImportInspection,[inspection],responseCode);rejects(csv.readBusinessImportStageInput,[stage]);rejects(csv.readBusinessImportTable,[table])
 assert.notEqual(xlsx.readBusinessImportPreviewV2(preview).schemaFingerprint,xlsx.readBusinessImportPreviewV2(preview).writeSchemaFingerprint)
 assert.deepEqual(xlsx.readBusinessImportTableV2(table),table)
})
test('all_v2_readers_reject_unknown_and_explicit_undefined_before_projection',()=>{
 const workbook={format:'teloa.business-import-workbook/v2',fileHash:a,bytes:3,sheets:[source.sheet],policy}
 const cases:[[ (value:unknown)=>unknown,unknown,string],...Array<[(value:unknown)=>unknown,unknown,string]>]=[
 [xlsx.readBusinessImportSheetV2,source.sheet,inputCode],[xlsx.readBusinessImportSourceV2,source,inputCode],[xlsx.readBusinessImportPolicyV2,policy,inputCode],[xlsx.readBusinessImportCellV2,{kind:'blank',text:''},inputCode],[xlsx.readBusinessImportRowV2,table.rows[1],inputCode],[xlsx.readBusinessImportTableV2,table,inputCode],[xlsx.readBusinessImportMappingV2,mapping,inputCode],[xlsx.readBusinessImportWorkbookInputV2,without(stage,'format','source','requestId'),inputCode],[xlsx.readBusinessImportStageInputV2,stage,inputCode],[xlsx.readBusinessImportInspectInputV2,{format:'teloa.business-import-inspect/v2',draftId,expectedRevision:2},inputCode],[xlsx.readBusinessImportPreviewInputV2,{format:'teloa.business-import-preview-input/v2',draftId,expectedRevision:2,mapping},inputCode],[xlsx.readBusinessImportWorkbookV2,workbook,responseCode],[xlsx.readBusinessImportInspectionV2,inspection,responseCode],[xlsx.readBusinessImportPreviewV2,preview,responseCode],[xlsx.readBusinessImportReceiptV2,receipt,responseCode],[xlsx.readBusinessImportDraftV2,draft,responseCode]]
 for(const [read,value,code] of cases){const v=value as Record<string,unknown>;read(v);rejects(read,[{...v,unknown:1},{...v,unknown:undefined},...Object.keys(v).map(k=>({...v,[k]:undefined}))],code)}
 rejects(xlsx.readBusinessImportMappingV2,[{...mapping,delimiter:','},{...mapping,summary:undefined}])
 rejects(xlsx.readBusinessImportDraftV2,[{...without(draft,'mapping','preview','receipt'),mapping:undefined},{...draft,preview:{...preview,mapping:{...mapping,summary:undefined}}}],responseCode)
})
test('exact_sheet_workbook_order_and_normalized_conflicts',()=>{
 rejects(xlsx.readBusinessImportSheetV2,['0','01','4294967296','1.0','+1'].map(sheetId=>({...source.sheet,sheetId})))
 rejects(xlsx.readBusinessImportSheetV2,['','x'.repeat(32),'a/b','a:b','a\u0001','a\u007f'].map(name=>({...source.sheet,name})))
 rejects(xlsx.readBusinessImportSheetV2,['/x.xml','x//y.xml','./x.xml','x/../y.xml','x\\y.xml','x%20.xml','x:1.xml','x.xml?x','x.xml#x','x.txt','x\u0001.xml','x'.repeat(300)+'.xml'].map(part=>({...source.sheet,part})))
 const other={sheetId:'2',name:'另一表',part:'xl/worksheets/sheet2.xml'}
 const workbook={format:'teloa.business-import-workbook/v2',fileHash:a,bytes:3,sheets:[other,source.sheet],policy}
 assert.deepEqual(xlsx.readBusinessImportWorkbookV2(workbook).sheets,[other,source.sheet])
 rejects(xlsx.readBusinessImportWorkbookV2,[{...workbook,sheets:[]},{...workbook,sheets:Array(17).fill(other)},{...workbook,sheets:[source.sheet,{...other,sheetId:'1'}]},{...workbook,sheets:[source.sheet,{...other,part:source.sheet.part}]},{...workbook,sheets:[{...source.sheet,name:'CAFÉ'},{...other,name:'cafe\u0301'}]}],responseCode)
 assert.equal(xlsx.readBusinessImportSheetV2({...source.sheet,sheetId:'4294967295'}).sheetId,'4294967295')
})
test('scalar_lexical_closed_union_and_dense_full_table',()=>{
 for(const text of ['+001','-0','.5','1.','1e-9999'])assert.equal(xlsx.readBusinessImportCellV2({kind:'number',text}).text,text)
 for(const text of ['NaN','Infinity','1_000','0x10','',' 1','1 ','1e','--1'])rejects(xlsx.readBusinessImportCellV2,[{kind:'number',text}])
 rejects(xlsx.readBusinessImportCellV2,[{kind:'blank',text:'0'},{kind:'boolean',text:'1'},{kind:'boolean',text:true},{kind:'date',text:'2026-09-30'},{kind:'formula',text:'1'},{kind:'error',text:'#N/A'},{kind:'number',text:1},{kind:'string',text:'x'.repeat(4001)}])
 assert.deepEqual(xlsx.readBusinessImportCellV2({kind:'string',text:''}),{kind:'string',text:''})
 rejects(xlsx.readBusinessImportTableV2,[{...table,columns:65},{...table,rows:[table.rows[0]]},{...table,rows:[table.rows[0],{...table.rows[1],rowNumber:3}]},{...table,rows:[table.rows[0],{...table.rows[1],cells:[{kind:'blank',text:''}]}]},{...table,rows:Array(52).fill(table.rows[0])}])
})
test('inspection_full_counts_typed_sample_and_failure_no_prefix',()=>{
 const failed={...without(inspection,'dataRows','sampleRowsOmitted'),rawCellsDigest:null,columns:[],sampleRows:[],issues:[{code:'invalid-xlsx',message:'表格解析失败。'}],complete:false,canMap:false}
 assert.deepEqual(xlsx.readBusinessImportInspectionV2(failed),failed)
 rejects(xlsx.readBusinessImportInspectionV2,[{...inspection,rawCellsDigest:null},{...inspection,dataRows:1},{...inspection,sampleRowsOmitted:0},{...inspection,dataRows:51},{...inspection,sampleRows:Array(6).fill(table.rows[1])},{...inspection,sampleRows:[{...table.rows[1],rowNumber:3}]},{...inspection,sampleRows:[{...table.rows[1],cells:[{kind:'blank',text:''}]}]},{...failed,rawCellsDigest:f},{...failed,sampleRows:[table.rows[1]]},{...failed,dataRows:0},{...failed,canMap:true},{...failed,issues:[]}],responseCode)
})
test('null_raw_only_means_whole_parse_failure_and_never_apply',()=>{
 const failed={...preview,rawCellsDigest:null,rows:[],issues:[{code:'invalid-xlsx',message:'表格解析失败。'}],canApply:false}
 assert.deepEqual(xlsx.readBusinessImportPreviewV2(failed),failed)
 assert.equal(xlsx.readBusinessImportPreviewV2({...preview,canApply:false,issues:[{code:'mapping',message:'映射问题。'}]}).rawCellsDigest,f)
 rejects(xlsx.readBusinessImportPreviewV2,[{...preview,rawCellsDigest:null},{...failed,rows:preview.rows},{...failed,issues:[]},{...failed,canApply:true},{...preview,rawCellsDigest:'A'.repeat(64)}],responseCode)
 rejects(xlsx.readBusinessImportReceiptV2,[{...receipt,rawCellsDigest:null}],responseCode)
 for(const read of [xlsx.readBusinessImportAnyReceiptResponse,xlsx.readBusinessImportAnyStageReceiptResponse]){assert.equal(read(null),null);rejects(read,[undefined,{}],responseCode)}
})
test('draft_cross_source_policy_digest_and_legacy_state_guards',()=>{
 const foreign={...source,sheet:{...source.sheet,name:'客户'}}
 rejects(xlsx.readBusinessImportDraftV2,[{...draft,preview:{...preview,source:foreign}},{...draft,receipt:{...receipt,source:foreign}},{...draft,policy:{...policy,parserVersion:'xlsx-scalar-v2'}},{...draft,preview:{...preview,policy:{...policy,datePolicy:'convert-date'}}},{...draft,receipt:{...receipt,rawCellsDigest:a}},{...draft,receipt:{...receipt,sourcePolicyDigest:a}},{...draft,receipt:{...receipt,contentKey:a}},{...draft,preview:{...preview,sourceIdentity:a}},{...draft,mapping:{...mapping,title:{column:0,trim:true}}},{...draft,status:'ready'},{...draft,status:'cancelled'},{...without(draft,'receipt'),status:'applied'},{...draft,preview:{...preview,canApply:false,issues:[{code:'conflict',message:'冲突。'}]}},{...draft,receipt:{...receipt,fileHash:b}},{...draft,receipt:{...receipt,type:'other'}},{...draft,revision:1},{...draft,updatedAt:'2026-09-29T00:00:00.000Z'}],responseCode)
 const alias={...draft,revision:3,receipt:{...receipt,requestId:'44444444-4444-4444-8444-444444444444'},createdAt:'2026-09-30T01:00:00.000Z',updatedAt:'2026-09-30T02:00:00.000Z'}
 assert.equal(xlsx.readBusinessImportDraftV2(alias).receipt!.appliedAt,stamp)
 assert.equal(xlsx.readBusinessImportDraftV2(without(alias,'mapping','preview')).receipt!.canonicalRequestId,requestId)
 assert.equal(xlsx.readBusinessImportDraftV2({...without(draft,'receipt'),status:'cancelled',revision:3}).preview!.revision,2)
 assert.deepEqual(xlsx.readBusinessImportDraftV2({...without(draft,'receipt','preview'),status:'ready',revision:3}).mapping,mapping)
})
test('dispatch_never_downgrades_unknown_or_undefined_format',()=>{
 for(const [read,v,code] of [[xlsx.readBusinessImportAnyDraft,draft,responseCode],[xlsx.readBusinessImportAnyReceipt,receipt,responseCode],[xlsx.readBusinessImportAnyInspection,inspection,responseCode],[xlsx.readBusinessImportAnyStageInput,stage,inputCode],[xlsx.readBusinessImportAnyInspectInput,{draftId,expectedRevision:2},inputCode],[xlsx.readBusinessImportAnyPreviewInput,{draftId,expectedRevision:2,mapping},inputCode]] as const)rejects(read,[{...v,format:undefined},{...v,format:'unknown'},{...v,format:null}],code)
 rejects(xlsx.readBusinessImportStageInputV2,[{...stage,policy},{...stage,bytes:2},{...stage,dataBase64:'YR=='},{...stage,scope:'general'}])
 rejects(xlsx.readBusinessImportInspectInputV2,[{format:'teloa.business-import-inspect/v2',draftId,expectedRevision:2,delimiter:','}])
 rejects(xlsx.readBusinessImportPreviewInputV2,[{format:'teloa.business-import-preview-input/v2',draftId,expectedRevision:2,mapping:{...mapping,delimiter:','}}])
})
test('sample_and_response_budgets_count_utf8_typed_json',()=>{
 const columns=Array.from({length:64},(_,column)=>({column,header:'列'}))
 const samples=Array.from({length:5},(_,i)=>({rowNumber:i+2,cells:Array.from({length:64},()=>({kind:'string',text:'x'.repeat(300)}))}))
 rejects(xlsx.readBusinessImportInspectionV2,[{...inspection,columns,sampleRows:samples,dataRows:5,sampleRowsOmitted:0},{...inspection,columns:columns.map(v=>({...v,header:'中'.repeat(3000)})),sampleRows:[],dataRows:1,sampleRowsOmitted:1}],responseCode)
 const fields=Array.from({length:50},(_,i)=>({name:'field'+i,value:'中'.repeat(1900)}))
 const rows=Array.from({length:50},(_,i)=>({rowNumber:i+2,primaryKey:[String(i)],operation:{...operation,fields}}))
 assert.equal(xlsx.readBusinessImportPreviewV2({...preview,rows}).rows.length,50,'预览沿旧reader结构上限，不新增512KiB总限额')
 rejects(xlsx.readBusinessImportDraftV2,[{...draft,preview:{...preview,rows}}],responseCode)
 assert.equal(xlsx.readBusinessImportTableV2({...table,columns:64,rows:Array.from({length:51},(_,i)=>({rowNumber:i+1,cells:Array.from({length:64},()=>({kind:'string',text:'中'.repeat(4000)}))}))}).rows.length,51,'完整typed表按原行列字数上限，不误用draft预算')
})

test('legacy_csv_reader_source_sha_is_unchanged',()=>assert.equal(createHash('sha256').update(readFileSync(new URL('../src/business-record-import.ts',import.meta.url))).digest('hex'),'375241a7a0d3fdda1301e95ee26c905a8f91a1a2ee2254a27a50cf796ba466eb'))

test('typed_rows_tables_samples_and_workbooks_reject_sparse_arrays',()=>{
 rejects(xlsx.readBusinessImportRowV2,[{rowNumber:2,cells:Array(2)}])
 rejects(xlsx.readBusinessImportTableV2,[{...table,rows:Array(2)}])
 rejects(xlsx.readBusinessImportInspectionV2,[{...inspection,sampleRows:Array(1)}],responseCode)
 rejects(xlsx.readBusinessImportWorkbookV2,[{format:'teloa.business-import-workbook/v2',fileHash:a,bytes:3,sheets:Array(1),policy}],responseCode)
})
test('v2_input_dispatch_retains_explicit_format_and_current_revision',()=>{
 const inspect={format:'teloa.business-import-inspect/v2',draftId,expectedRevision:2}
 const input={format:'teloa.business-import-preview-input/v2',draftId,expectedRevision:2,mapping}
 assert.deepEqual(xlsx.readBusinessImportAnyInspectInput(inspect),inspect)
 assert.deepEqual(xlsx.readBusinessImportAnyPreviewInput(input),input)
 assert.deepEqual(xlsx.readBusinessImportWorkbookInputV2(without(stage,'format','source','requestId')),without(stage,'format','source','requestId'))
 assert.deepEqual(xlsx.readBusinessImportAnyStageReceiptResponse(draft),draft)
 assert.deepEqual(xlsx.readBusinessImportAnyReceiptResponse(receipt),receipt)
 rejects(xlsx.readBusinessImportInspectInputV2,[{...inspect,expectedRevision:0}])
 rejects(xlsx.readBusinessImportPreviewInputV2,[{...input,expectedRevision:0}])
 rejects(xlsx.readBusinessImportDraftV2,[{...draft,receipt:{...receipt,previewDigest:b}},{...draft,receipt:{...receipt,created:2,references:[receipt.references[0],{...receipt.references[0],id:draftId}]}},{...draft,receipt:{...receipt,appliedAt:'2026-09-30T01:00:00.000Z'}}],responseCode)
})

test('sample_budget_includes_cell_kinds_beyond_legacy_text_projection',()=>{
 const columns=Array.from({length:64},(_,column)=>({column,header:'列'}))
 const samples=Array.from({length:5},(_,i)=>({rowNumber:i+2,cells:Array.from({length:64},()=>({kind:'string',text:'x'.repeat(180)}))}))
 const typed={...inspection,columns,sampleRows:samples,dataRows:5,sampleRowsOmitted:0}
 const legacy={...without(typed,'source','policy','rawCellsDigest'),format:'teloa.business-import-inspection/v1',delimiter:',',parserVersion:'csv-v1',sampleRows:samples.map(row=>({rowNumber:row.rowNumber,cells:row.cells.map(cell=>cell.text)}))}
 assert.equal(csv.readBusinessImportInspection(legacy).sampleRows.length,5)
 rejects(xlsx.readBusinessImportInspectionV2,[typed],responseCode)
})
test('fix1_failed_inspection_and_preview_need_real_issue_entries',()=>{
 const failedInspection={...without(inspection,'dataRows','sampleRowsOmitted'),rawCellsDigest:null,columns:[],sampleRows:[],issues:Array(1),complete:false,canMap:false}
 const failedPreview={...preview,rawCellsDigest:null,rows:[],issues:Array(1),canApply:false}
 rejects(xlsx.readBusinessImportInspectionV2,[failedInspection],responseCode)
 rejects(xlsx.readBusinessImportPreviewV2,[failedPreview],responseCode)
})
test('fix1_can_apply_preview_requires_dense_rows_primary_keys_and_fields',()=>{
 rejects(xlsx.readBusinessImportPreviewV2,[{...preview,rows:[{...preview.rows[0],primaryKey:Array(1)}]},{...preview,rows:[{...preview.rows[0],operation:{...operation,fields:Array(1)}}]},{...preview,rows:Array(1),canApply:false}],responseCode)
})
test('fix1_receipt_and_applied_draft_require_real_reference_entries',()=>{
 const sparse={...receipt,references:Array(1)}
 rejects(xlsx.readBusinessImportReceiptV2,[sparse],responseCode)
 rejects(xlsx.readBusinessImportDraftV2,[{...draft,receipt:sparse}],responseCode)
})
test('fix1_mapping_columns_and_nested_delegated_arrays_are_dense',()=>{
 rejects(xlsx.readBusinessImportMappingV2,[{...mapping,fields:Array(1)},{...mapping,primaryKey:Array(1)}])
 rejects(xlsx.readBusinessImportInspectionV2,[{...inspection,columns:Array(2)}],responseCode)
 rejects(xlsx.readBusinessImportDraftV2,[{...draft,mapping:{...mapping,fields:Array(1)}},{...draft,preview:{...preview,rows:[{...preview.rows[0],primaryKey:Array(1)}]}}],responseCode)
 const inherited=Array(1);Object.setPrototypeOf(inherited,{0:{code:'invalid-xlsx',message:'错误。'},__proto__:Array.prototype})
 rejects(xlsx.readBusinessImportPreviewV2,[{...preview,rawCellsDigest:null,rows:[],issues:inherited,canApply:false}],responseCode)
 assert.deepEqual(xlsx.readBusinessImportMappingV2(mapping).fields,[])
 assert.deepEqual(xlsx.readBusinessImportPreviewV2(preview).rows[0]!.operation.fields,[])
 rejects(xlsx.readBusinessImportPreviewV2,[{...preview,rows:[{...preview.rows[0],operation:{...operation,relations:Array(1)}}]}],responseCode)
})
test('fix1_legacy_sparse_accepted_inputs_and_source_sha_remain_unchanged',()=>{
 const legacyPreview={...without(preview,'format','source','policy','rawCellsDigest'),mapping:{delimiter:',',...mapping},rows:[{...preview.rows[0],primaryKey:Array(1)}]}
 assert.equal(csv.readBusinessImportPreview(legacyPreview).canApply,true)
 const legacyReceipt={...without(receipt,'format','source','policy','rawCellsDigest'),references:Array(1)}
 assert.equal(csv.readBusinessImportReceipt(legacyReceipt).created,1)
 assert.equal(csv.readBusinessImportMapping({delimiter:',',...mapping,fields:Array(1)}).fields.length,1)
 const legacyFailed={...without(preview,'format','source','policy','rawCellsDigest'),mapping:{delimiter:',',...mapping},rows:[],issues:Array(1),canApply:false}
 assert.equal(csv.readBusinessImportPreview(legacyFailed).issues.length,1)
})
test('fix1_applied_sparse_reference_alone_is_rejected',()=>rejects(xlsx.readBusinessImportDraftV2,[{...draft,receipt:{...receipt,references:Array(1)}}],responseCode))
test('fix1_parse_failed_preview_sparse_issues_alone_is_rejected',()=>rejects(xlsx.readBusinessImportPreviewV2,[{...preview,rawCellsDigest:null,rows:[],issues:Array(1),canApply:false}],responseCode))

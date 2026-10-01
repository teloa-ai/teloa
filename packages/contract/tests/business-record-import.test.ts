import test from 'node:test'
import assert from 'node:assert/strict'

import * as contract from '../src/business-record-import.ts'
const api:Record<string,(...args:any[])=>any>=contract
const requestId='11111111-1111-4111-8111-111111111111'
const draftId='22222222-2222-4222-8222-222222222222'
const hash='a'.repeat(64),stamp='2026-09-30T00:00:00.000Z'
const column=(column:number,trim=false)=>({column,trim})
const mapping={delimiter:',',headerRow:1,primaryKey:[column(0)],title:column(1),fields:[{field:'z',value:column(2)},{field:'a',value:column(3),currency:{fixed:'CNY'}}]}
const operation={operation:'create',type:'customer',title:'客户',summary:'',fields:[{name:'state',value:'待联系'}]}
const preview={revision:2,digest:hash,schemaFingerprint:hash,writeSchemaFingerprint:hash,configurationVersion:1,sourceIdentity:hash,sourcePolicyDigest:hash,contentKey:hash,mapping,rows:[{rowNumber:2,primaryKey:['001'],operation}],issues:[],canApply:true}
const reference={scope:'crm',type:'customer',id:requestId,version:1,snapshotHash:hash}
const receipt={requestId,canonicalRequestId:requestId,draftId,scope:'crm',type:'customer',fileHash:hash,previewDigest:hash,sourceIdentity:hash,sourcePolicyDigest:hash,contentKey:hash,created:1,references:[reference],appliedAt:stamp}
const draft={format:'teloa.business-record-import/v1',id:draftId,stageRequestId:requestId,ownerId:'owner',scope:'crm',type:'customer',sourceIdentity:hash,revision:2,status:'previewed',file:{attachmentId:'attachment-1',name:'客户.csv',bytes:3,sha256:hash},mapping,preview,createdAt:stamp,updatedAt:stamp}
function reject(read:string,values:unknown[],code='teloa/invalid-input'){
 assert.equal(typeof api[read],'function',read+' 应提供严格读取能力')
 for(const value of values)assert.throws(()=>api[read]!(value),{code})
}
test('rejects_unknown_identity_and_mapping_keys',()=>{
 assert.equal(typeof api.readBusinessImportStageInput,'function')
 const input={requestId,scope:'crm',type:'customer',name:'客户.csv',bytes:3,dataBase64:'YWJj'}
 assert.deepEqual(api.readBusinessImportStageInput!(input),input)
 reject('readBusinessImportStageInput', [{...input,ownerId:'other'},{...input,attachmentId:'fake'},{...input,scope:'general'},{...input,bytes:2},{...input,dataBase64:'YR=='},{...input,dataBase64:'YWJj\n'},{...input,requestId:requestId.replace('1111-4111','AAAA-4111')},{...input,bytes:2_097_153},{...input,name:'../file.csv'}])
 const apply={requestId,draftId,previewRevision:2,previewDigest:hash}
 assert.deepEqual(api.readBusinessImportApplyInput!(apply),apply)
 reject('readBusinessImportApplyInput',[{...apply,ownerId:'other'},{...apply,id:'raw-record'},{...apply,previewDigest:hash.toUpperCase()},{...apply,previewRevision:0}])
 const canonical=api.readBusinessImportMapping!(mapping)
 assert.deepEqual(canonical.fields.map((f:any)=>f.field),['a','z'])
 assert.deepEqual(canonical.primaryKey,[column(0)])
 reject('readBusinessImportMapping',[{...mapping,fields:[{field:'a',value:{...column(0),convert:'number'}}]},{...mapping,fields:[{field:'a',value:column(0)},{field:'a',value:column(1)}]},{...mapping,delimiter:'\\t'},{...mapping,headerRow:2},{...mapping,title:column(64)}])
 assert.throws(()=>api.readBusinessImportMapping!(mapping,3),{code:'teloa/invalid-input'})
})
test('primary_key_requires_unique_columns_and_explicit_trim',()=>{
 reject('readBusinessImportMapping',[{...mapping,primaryKey:[0]},{...mapping,primaryKey:[{column:0}]},{...mapping,primaryKey:[column(0),column(0,true)]},{...mapping,primaryKey:[]},{...mapping,primaryKey:[column(0),column(1),column(2),column(3)]}])
 assert.deepEqual(api.readBusinessImportMapping!({...mapping,primaryKey:[column(2,true),column(0)]}).primaryKey,[column(2,true),column(0)])
})
test('all_request_readers_require_exact_keys_and_original_identity',()=>{
 const inputs={StageReceiptInput:{requestId,scope:'crm',type:'customer'},GetInput:{draftId},InspectInput:{draftId,expectedRevision:2,delimiter:'\t'},PreviewInput:{draftId,expectedRevision:2,mapping},RevisionInput:{requestId,draftId,expectedRevision:2},ReceiptInput:{requestId,scope:'crm'}}
 for(const [name,input] of Object.entries(inputs)){
  const read='readBusinessImport'+name
  assert.equal(typeof api[read],'function')
  api[read]!(input)
  reject(read,[{...input,ownerId:'fake'},{...input,unknown:true},{}])
 }
})
test('table_preserves_raw_cells_and_rejects_partial_or_out_of_bounds_tables',()=>{
 const table={format:'teloa.business-import-table/v1',parserVersion:'csv-v1',columns:2,rows:[{rowNumber:1,cells:[' 名称 ','']},{rowNumber:2,cells:['001',' 引号\n换行 ']}]}
 assert.equal(typeof api.readBusinessImportTable,'function')
 assert.deepEqual(api.readBusinessImportTable!(table),table)
 reject('readBusinessImportTable',[{...table,ownerId:'fake'},{...table,columns:65},{...table,rows:[]},{...table,rows:[table.rows[0],{rowNumber:3,cells:['x','y']}]},{...table,rows:[{rowNumber:1,cells:['x']}]},{...table,rows:[{rowNumber:1,cells:['x'.repeat(4001),'y']}]}])
 reject('readBusinessImportRow',[{rowNumber:0,cells:[]},{rowNumber:52,cells:['x']},{rowNumber:2,cells:['x'],extra:true}])
})
test('inspect_and_stage_receipt_contracts_are_strict_and_bounded',()=>{
 const inspection={format:'teloa.business-import-inspection/v1',draftId,scope:'crm',type:'customer',fileHash:hash,revision:2,delimiter:',',parserVersion:'csv-v1',headerRow:1,columns:[{column:0,header:' 原名 '},{column:1,header:' 原名 '}],sampleRows:[{rowNumber:2,cells:['001','客户']}],sampleRowsOmitted:2,dataRows:3,issues:[],complete:true,canMap:true}
 assert.equal(typeof api.readBusinessImportInspection,'function')
 assert.deepEqual(api.readBusinessImportInspection!(inspection),inspection)
 reject('readBusinessImportInspection',[{...inspection,ownerId:'fake'},{...inspection,columns:[{column:1,header:'错序'}]},{...inspection,sampleRowsOmitted:0},{...inspection,dataRows:undefined},{...inspection,sampleRows:Array(6).fill(inspection.sampleRows[0])},{...inspection,complete:false},{...inspection,issues:[{code:'invalid-csv',message:'格式错误'}]}],'teloa/invalid-host-response')
 const failed={...inspection,columns:[],sampleRows:[],issues:[{rowNumber:2,column:1,code:'ragged-rows',message:'列数不一致。'}],complete:false,canMap:false}
 delete (failed as any).dataRows;delete (failed as any).sampleRowsOmitted
 assert.deepEqual(api.readBusinessImportInspection!(failed),failed)
 reject('readBusinessImportInspection',[{...failed,dataRows:0},{...failed,canMap:true},{...failed,issues:[]}],'teloa/invalid-host-response')
 for(const read of ['readBusinessImportStageReceiptResponse','readBusinessImportReceiptResponse']){
  assert.equal(api[read]!(null),null)
  reject(read,[undefined,{}],'teloa/invalid-host-response')
 }
})
test('issues_are_bounded_and_preserve_logical_rows_and_columns',()=>{
 const issue={rowNumber:51,column:63,field:'state',code:'source-cell-too-long',message:'单元格过长。'}
 assert.equal(typeof api.readBusinessImportIssue,'function')
 assert.deepEqual(api.readBusinessImportIssue!(issue),issue)
 reject('readBusinessImportIssue',[{...issue,rowNumber:0},{...issue,column:2147483648},{...issue,code:'x'.repeat(65)},{...issue,message:'x'.repeat(241)},{...issue,rawCell:'secret'}])
 assert.deepEqual(api.readBusinessImportIssue!({rowNumber:52,column:64,code:'rows-too-many',message:'超过导入限额。'}),{rowNumber:52,column:64,code:'rows-too-many',message:'超过导入限额。'})
 reject('readBusinessImportIssues',[Array(101).fill(issue)])
 assert.equal(api.readBusinessImportIssues!(Array(100).fill(issue)).length,100)
})
test('preview_only_allows_bounded_create_operations_and_explicit_primary_keys',()=>{
 assert.equal(typeof api.readBusinessImportPreview,'function')
 const parsed=api.readBusinessImportPreview!(preview)
 assert.deepEqual(parsed.rows,preview.rows)
 assert.deepEqual(parsed.mapping.fields.map((f:any)=>f.field),['a','z'])
 reject('readBusinessImportPreview',[{...preview,rows:[{rowNumber:2,primaryKey:['001'],operation:{...operation,id:'injected'}}]},{...preview,rows:[{rowNumber:2,primaryKey:['001'],operation:{operation:'archive',type:'customer',id:'old',expectedVersion:1}}]},{...preview,rows:[{rowNumber:1,primaryKey:['001'],operation}]},{...preview,rows:Array(51).fill(preview.rows[0])},{...preview,rows:[{...preview.rows[0],primaryKey:['001','002']}]},{...preview,issues:[{code:'source-policy-conflict',message:'来源冲突。'}]},{...preview,rows:[]}],'teloa/invalid-host-response')
 assert.equal(api.readBusinessImportPreview!({...preview,canApply:false,issues:[{code:'source-policy-conflict',message:'来源冲突。'}]}).canApply,false)
})
test('receipts_and_drafts_reject_cross_scope_and_inconsistent_fixed_evidence',()=>{
 assert.equal(typeof api.readBusinessImportReceipt,'function')
 assert.deepEqual(api.readBusinessImportReceipt!(receipt),receipt)
 reject('readBusinessImportReceipt',[{...receipt,created:2},{...receipt,references:[{...reference,scope:'other'}]},{...receipt,references:[{...reference,type:'other'}]},{...receipt,appliedAt:'today'},{...receipt,references:[{...reference,ownerId:'fake'}]}],'teloa/invalid-host-response')
 assert.equal(api.readBusinessImportDraft!(draft).id,draftId)
 reject('readBusinessImportDraft',[{...draft,revision:1},{...draft,status:'applied'},{...draft,status:'ready'},{...draft,preview:{...preview,sourceIdentity:'b'.repeat(64)}},{...draft,updatedAt:'2026-09-29T00:00:00.000Z'},{...draft,unknown:true}],'teloa/invalid-host-response')
 const applied={...draft,status:'applied',receipt}
 assert.equal(api.readBusinessImportStageReceiptResponse!(applied).receipt.canonicalRequestId,requestId)
 assert.deepEqual(api.readBusinessImportReceiptResponse!(receipt),receipt)
 reject('readBusinessImportDraft',[{...applied,receipt:{...receipt,draftId:requestId}},{...applied,receipt:{...receipt,fileHash:'b'.repeat(64)}}],'teloa/invalid-host-response')
})
test('existing_definition_field_names_remain_readable',()=>{
 const numericName={...mapping,fields:[{field:'1st_field',value:column(2)}]}
 assert.equal(api.readBusinessImportMapping!(numericName).fields[0].field,'1st_field')
 reject('readBusinessImportMapping',[{...mapping,fields:[{field:'a'.repeat(64),value:column(0)}]}])
})
test('canonical_alias_receipt_may_predate_new_draft',()=>{
 const aliasReceipt={...receipt,requestId:'44444444-4444-4444-8444-444444444444'}
 const alias={...draft,status:'applied',revision:3,receipt:aliasReceipt,createdAt:'2026-09-30T01:00:00.000Z',updatedAt:'2026-09-30T02:00:00.000Z'}
 const parsed=api.readBusinessImportDraft!(alias)
 assert.equal(parsed.receipt.appliedAt,'2026-09-30T00:00:00.000Z','别名沿原成功时间，允许早于当前草案')
 assert.equal(parsed.receipt.requestId,'44444444-4444-4444-8444-444444444444')
 assert.equal(parsed.receipt.canonicalRequestId,requestId)
 assert.equal(parsed.preview.revision,2)
 const {preview:_,mapping:__,...receiptOnly}=alias
 assert.deepEqual(api.readBusinessImportDraft!(receiptOnly).receipt,aliasReceipt,'旧成功回执可独立读取，不要求当前定义或保留预览')
})
test('cancel_and_resume_keep_mapping_without_fabricating_current_preview',()=>{
 assert.equal(api.readBusinessImportDraft!({...draft,status:'cancelled',revision:3}).preview.revision,2)
 assert.equal(api.readBusinessImportDraft!({...draft,status:'applied',revision:3,receipt}).preview.revision,2)
 const {preview:_,...resumed}=draft
 assert.deepEqual(api.readBusinessImportDraft!({...resumed,status:'ready',revision:4}).mapping.fields.map((f:any)=>f.field),['a','z'])
})
test('inspection_and_draft_canonical_limits_reject_whole_responses',()=>{
 const headers=Array.from({length:64},(_,column)=>({column,header:'中'.repeat(3000)}))
 const inspection={format:'teloa.business-import-inspection/v1',draftId,scope:'crm',type:'customer',fileHash:hash,revision:2,delimiter:',',parserVersion:'csv-v1',headerRow:1,columns:headers,sampleRows:[],dataRows:1,sampleRowsOmitted:1,issues:[],complete:true,canMap:true}
 reject('readBusinessImportInspection',[inspection],'teloa/invalid-host-response')
 const samples=Array.from({length:5},(_,index)=>({rowNumber:index+2,cells:Array(64).fill('x'.repeat(300))}))
 reject('readBusinessImportInspection',[{...inspection,columns:headers.map(c=>({...c,header:'列'})),sampleRows:samples,dataRows:5,sampleRowsOmitted:0}],'teloa/invalid-host-response')
 const fields=Array.from({length:50},(_,index)=>({name:'field'+index,value:'中'.repeat(1900)}))
 const rows=Array.from({length:50},(_,index)=>({rowNumber:index+2,primaryKey:[String(index)],operation:{...operation,fields}}))
 reject('readBusinessImportDraft',[{...draft,preview:{...preview,rows}}],'teloa/invalid-host-response')
})
test('canonical_base64_accepts_full_two_mebibyte_input_and_checks_padding_bits',()=>{
 const input={requestId,scope:'crm',type:'customer',name:'完整.csv',bytes:2_097_152,dataBase64:Buffer.alloc(2_097_152).toString('base64')}
 assert.equal(api.readBusinessImportStageInput!(input).bytes,2_097_152)
 for(const [dataBase64,bytes] of [['YQ==',1],['YWI=',2],['YWJj',3]] as const)assert.equal(api.readBusinessImportStageInput!({...input,dataBase64,bytes}).dataBase64,dataBase64)
 reject('readBusinessImportStageInput',[{...input,bytes:1,dataBase64:'YR=='},{...input,bytes:2,dataBase64:'YWJ='},{...input,bytes:1,dataBase64:'YQ'},{...input,bytes:1,dataBase64:'YQ__'}])
})
test('empty_file_stage_preserves_bytes_for_inspection_without_claiming_valid_table',()=>{
 const input={requestId,scope:'crm',type:'customer',name:'空.csv',bytes:0,dataBase64:''}
 assert.deepEqual(api.readBusinessImportStageInput!(input),input)
 reject('readBusinessImportStageInput',[{...input,dataBase64:'YQ=='},{...input,bytes:-1}])
})
test('empty_file_reference_is_readable_but_empty_table_is_not',()=>{
 const file={attachmentId:'attachment-1',name:'空.csv',bytes:0,sha256:hash}
 assert.deepEqual(api.readBusinessImportFileRef!(file),file)
 reject('readBusinessImportTable',[{format:'teloa.business-import-table/v1',parserVersion:'csv-v1',columns:1,rows:[]}])
})
test('draft_status_requires_string_enum_before_state_guards',()=>{
 const {preview:_,...withoutPreview}=draft
 reject('readBusinessImportDraft',[{...withoutPreview,status:['previewed']},{...draft,status:['ready']},{...withoutPreview,status:['applied']},{...draft,status:{value:'previewed'}}],'teloa/invalid-host-response')
})
test('preview_primary_keys_must_already_follow_each_columns_trim_policy',()=>{
 const trimmedMapping={...mapping,primaryKey:[column(0,true)]}
 reject('readBusinessImportPreview',[
  {...preview,mapping:trimmedMapping,rows:[{...preview.rows[0],primaryKey:['   ']}]},
  {...preview,mapping:trimmedMapping,rows:[{...preview.rows[0],primaryKey:[' 001 ']}]},
  {...preview,mapping:trimmedMapping,rows:[{rowNumber:2,primaryKey:['001'],operation},{rowNumber:3,primaryKey:[' 001 '],operation}]},
  {...preview,mapping:trimmedMapping,rows:[{rowNumber:2,primaryKey:['001'],operation},{rowNumber:3,primaryKey:['001'],operation}]},
 ],'teloa/invalid-host-response')
 assert.deepEqual(api.readBusinessImportPreview!({...preview,rows:[{...preview.rows[0],primaryKey:[' 001 ']}]}).rows[0].primaryKey,[' 001 '],'trim=false保留首尾空白')
 const mixed={...mapping,primaryKey:[column(0,true),column(1,false)]}
 assert.deepEqual(api.readBusinessImportPreview!({...preview,mapping:mixed,rows:[{rowNumber:2,primaryKey:['001',' 002 '],operation}]}).rows[0].primaryKey,['001',' 002 '],'每列独立trim，前导零保留')
})
test('successful_preview_must_start_at_source_row_two',()=>{
 reject('readBusinessImportPreview',[{...preview,rows:[{...preview.rows[0],rowNumber:3}]}],'teloa/invalid-host-response')
})
test('successful_preview_cannot_omit_middle_source_rows',()=>{
 const rows=[{rowNumber:2,primaryKey:['001'],operation},{rowNumber:4,primaryKey:['002'],operation}]
 reject('readBusinessImportPreview',[{...preview,rows}],'teloa/invalid-host-response')
 const blocked=api.readBusinessImportPreview!({...preview,rows,canApply:false,issues:[{rowNumber:3,code:'required-field',message:'缺少必填字段。'}]})
 assert.equal(blocked.canApply,false,'失败预览可保留问题行之外的合法行，不冒充完整采用')
})
test('applied_receipt_count_must_match_retained_preview_rows',()=>{
 const twoReferences=[reference,{...reference,id:'33333333-3333-4333-8333-333333333333'}]
 const differentCount={...receipt,created:2,references:twoReferences}
 assert.equal(api.readBusinessImportReceipt!(differentCount).created,2,'独立回执结构合法，失败应来自草案与预览不一致')
 reject('readBusinessImportDraft',[{...draft,status:'applied',revision:3,receipt:differentCount}],'teloa/invalid-host-response')
})
test('applied_draft_cannot_retain_blocked_preview',()=>{
 const blocked={...preview,canApply:false,issues:[{code:'source-policy-conflict',message:'来源政策冲突。'}]}
 assert.equal(api.readBusinessImportPreview!(blocked).canApply,false,'失败预览结构本身合法')
 reject('readBusinessImportDraft',[{...draft,status:'applied',revision:3,preview:blocked,receipt}],'teloa/invalid-host-response')
})

import test from 'node:test'
import assert from 'node:assert/strict'
import {industryUpdateCanonical,type BusinessImportTableV2,type BusinessObjectTypeDefinitionV2} from '@teloa/contract'
import {businessImportHash} from '../src/work/business-record-import-preview.ts'
import * as subject from '../src/work/business-record-import-xlsx-preview.ts'
const source={kind:'xlsx' as const,sheet:{sheetId:'1',name:'客户',part:'xl/worksheets/sheet1.xml'}}
const policy={parserVersion:'xlsx-scalar-v1' as const,scalarPolicy:'closed-scalar-v1' as const,datePolicy:'reject-date-v1' as const,formulaPolicy:'reject-formula-v1' as const}
const mapping={headerRow:1 as const,primaryKey:[{column:0,trim:false}],title:{column:1,trim:false},fields:[{field:'amount',value:{column:2,trim:false},currency:{fixed:'USD'}}]}
const definition:BusinessObjectTypeDefinitionV2={format:'teloa.business-object-type/v2',id:'expense',version:'1.0.0',domain:'sales',title:'费用',unit:'条',lead:'费用',sourceId:'local',fields:[{name:'amount',label:'金额',from:'金额',format:'teloa.business-rich-field/v2',type:'money',required:true,currencies:['USD']}]}
const table:BusinessImportTableV2={format:'teloa.business-import-table/v2',source,policy,columns:3,rows:[{rowNumber:1,cells:['编号','标题','金额'].map(text=>({kind:'string',text}))},{rowNumber:2,cells:[{kind:'string',text:'001'},{kind:'string',text:'原标题'},{kind:'number',text:'123456789012345678.1234'}]}]}
const base={draftId:'00000000-0000-4000-8000-000000000001',scope:'sales',type:'expense',fileHash:'a'.repeat(64),revision:2,sourceIdentity:'b'.repeat(64),configurationVersion:1,definition,mapping,source,policy,table}
test('xlsx_projection_preserves_001_and_exact_18_digit_money',async()=>{
 const result=await subject.buildBusinessImportXlsxPreview(base)
 assert.equal(result.canApply,true);assert.deepEqual(result.rows[0]!.primaryKey,['001'])
 assert.equal(result.rows[0]!.operation.fields[0]!.value,'{"currency":"USD","decimal":"123456789012345678.1234"}')
 assert.equal(Object.hasOwn(result.mapping,'delimiter'),false)
})
test('xlsx_scientific_money_is_rejected_without_number_conversion',async()=>{
 const changed=structuredClone(table);changed.rows[1]!.cells[2]={kind:'number',text:'1.23456789012345678E17'}
 const result=await subject.buildBusinessImportXlsxPreview({...base,table:changed})
 assert.equal(result.canApply,false);assert.equal(result.rows.length,0);assert.equal(result.issues[0]!.code,'field-value-invalid')
})
test('xlsx_hash_domains_bind_exact_sheet_policy_and_all_typed_raw',async()=>{
 const s=subject,original=await s.buildBusinessImportXlsxPreview(base),changed=structuredClone(table)
 changed.rows[1]!.cells[2]={kind:'string',text:changed.rows[1]!.cells[2]!.text}
 const next=await s.buildBusinessImportXlsxPreview({...base,table:changed})
 assert.deepEqual(next.rows,original.rows);assert.notEqual(next.rawCellsDigest,original.rawCellsDigest);assert.notEqual(next.sourcePolicyDigest,original.sourcePolicyDigest);assert.notEqual(next.contentKey,original.contentKey);assert.notEqual(next.digest,original.digest)
 assert.equal(original.rawCellsDigest,businessImportHash(['teloa.business-import-raw-cells/v2',source,policy,table.rows]))
 assert.equal(original.sourcePolicyDigest,businessImportHash(['teloa.business-import-source-policy/v2',base.fileHash,source,policy,original.rawCellsDigest,mapping.headerRow,mapping.primaryKey]))
 const identity=s.businessImportXlsxSourceIdentity('owner','sales','expense',base.fileHash,source)
 assert.equal(identity,businessImportHash(['teloa.business-import-sheet-source/v2','owner','sales','expense',base.fileHash,source]))
 for(const sheet of [{...source.sheet,name:'改名'},{...source.sheet,sheetId:'2'},{...source.sheet,part:'xl/worksheets/sheet2.xml'}])assert.notEqual(s.businessImportXlsxSourceIdentity('owner','sales','expense',base.fileHash,{kind:'xlsx',sheet}),identity)
})
test('xlsx_parse_failure_returns_no_rows_and_null_raw_without_partial_prefix',async()=>{
 const result=await subject.buildBusinessImportXlsxPreview({...base,table:undefined,issues:[{code:'xlsx-formula',message:'公式不支持。'}]})
 assert.equal(result.rawCellsDigest,null);assert.equal(result.rows.length,0);assert.equal(result.canApply,false)
 const failed=subject.buildBusinessImportXlsxInspection({...base,table:undefined,issues:result.issues})
 assert.equal(failed.complete,false);assert.equal(failed.rawCellsDigest,null);assert.deepEqual(failed.sampleRows,[])
})
test('xlsx_inspection_budgets_complete_typed_rows_using_actual_payload',()=>{
 const huge=structuredClone(table);huge.columns=16;huge.rows=[{rowNumber:1,cells:Array.from({length:16},()=>({kind:'string',text:''}))},...Array.from({length:4},(_,i)=>({rowNumber:i+2,cells:Array.from({length:16},()=>({kind:'string' as const,text:'x'.repeat(4000)}))}))]
 const result=subject.buildBusinessImportXlsxInspection({...base,table:huge})
 assert.equal(result.complete,true);assert.equal(result.sampleRows.length,1);assert.equal(result.sampleRowsOmitted,3)
 assert.equal(result.sampleRows[0]!.cells[0]!.kind,'string');assert.ok(Buffer.byteLength(industryUpdateCanonical(result.sampleRows))<=65536)
 const overflow=structuredClone(huge);overflow.columns=64;overflow.rows=overflow.rows.slice(0,2).map((r,i)=>({...r,cells:Array.from({length:64},()=>({kind:'string' as const,text:i===0?'界'.repeat(4000):''}))}))
 const failure=subject.buildBusinessImportXlsxInspection({...base,table:overflow});assert.equal(failure.complete,false);assert.equal(failure.rawCellsDigest,null)
})
const service=await import('../src/work/business-record-imports.ts')
const inaccessible=async():Promise<never>=>{throw Error('不得访问外部端口')}
const portPool={connect:inaccessible} as unknown as import('pg').Pool
const dependencies={definitions:{forScopeVersioned:inaccessible},store:{currentInTransaction:inaccessible},records:{get:inaccessible,batchInTransaction:inaccessible},references:{pinInTransaction:inaccessible},files:{save:inaccessible,read:inaccessible},tables:{parse:inaccessible}}
test('xlsx_absent_port_is_explicit_and_never_uses_csv_or_saves',async()=>{
 const imports=new service.BusinessRecordImportService(portPool,{id:()=>base.draftId,now:()=>new Date().toISOString()},dependencies)
 await assert.rejects(imports.stage({ownerId:'owner',scopeIds:['sales']},{format:'teloa.business-import-stage/v2',requestId:base.draftId,scope:'sales',type:'expense',source,name:'data.xlsx',bytes:1,dataBase64:'eA=='}),{code:'teloa/dependency-unavailable'})
})
test('xlsx_workbook_checks_actor_and_signal_before_database_or_ports',async()=>{
 const imports=new service.BusinessRecordImportService(portPool,{id:()=>base.draftId,now:()=>new Date().toISOString()},dependencies)
 assert.equal(typeof imports.inspectWorkbook,'function')
 const input={scope:'sales',type:'expense',name:'data.xlsx',bytes:1,dataBase64:'eA=='}
 await assert.rejects(imports.inspectWorkbook({ownerId:'owner',scopeIds:[]},input),{code:'teloa/forbidden'})
 await assert.rejects(imports.inspectWorkbook({ownerId:'owner',scopeIds:['sales']},input,AbortSignal.abort(new Error('stopped'))),{message:'stopped'})
})
test('xlsx_replayed_preview_rechecks_the_original_file_before_returning',async()=>{
 const s=subject,{createHash}=await import('node:crypto'),{readBusinessImportDraftV2}=await import('@teloa/contract'),file=Buffer.from('original')
 const fileHash=createHash('sha256').update(file).digest('hex'),sourceIdentity=s.businessImportXlsxSourceIdentity('owner',base.scope,base.type,fileHash,source)
 const preview=await s.buildBusinessImportXlsxPreview({...base,fileHash,sourceIdentity}),draft=readBusinessImportDraftV2({format:'teloa.business-record-import/v2',source,policy,id:base.draftId,stageRequestId:base.draftId,ownerId:'owner',scope:base.scope,type:base.type,sourceIdentity,revision:2,status:'previewed',file:{attachmentId:base.draftId,name:'data.xlsx',bytes:file.length,sha256:fileHash},mapping,preview,createdAt:'2026-09-30T00:00:00.000Z',updatedAt:'2026-09-30T00:00:00.000Z'})
 const row={owner_id:'owner',id:draft.id,stage_request_id:draft.stageRequestId,stage_hash:'a'.repeat(64),scope_id:draft.scope,object_type:draft.type,source_identity:sourceIdentity,draft_hash:businessImportHash(draft),draft,relation_references:[]}
 const database={connect:async()=>({query:async(sql:string)=>({rows:sql.startsWith('select * from teloa_business_record_import_drafts')?[row]:[]}),release:()=>{}})} as unknown as import('pg').Pool
 const imports=new service.BusinessRecordImportService(database,{id:()=>base.draftId,now:()=>new Date().toISOString()},{...dependencies,files:{save:inaccessible,read:async()=>Buffer.alloc(file.length,120)}})
 await assert.rejects(imports.preview({ownerId:'owner',scopeIds:[base.scope]},{format:'teloa.business-import-preview-input/v2',draftId:draft.id,expectedRevision:1,mapping}),{code:'teloa/file-changed'})
})

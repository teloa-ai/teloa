import test from 'node:test'
import assert from 'node:assert/strict'
import type {Pool} from 'pg'
import {createHash} from 'node:crypto'
import {WorkError,readBusinessImportMapping,readBusinessImportPreview,readBusinessImportDraft,type BusinessImportTable,type BusinessObjectTypeDefinitionV2,type BusinessObjectSnapshot} from '@teloa/contract'
import * as subject from '../src/work/business-record-import-preview.ts'
import * as service from '../src/work/business-record-imports.ts'
const preview=subject.buildBusinessImportPreview,inspect=subject.buildBusinessImportInspection
const id='00000000-0000-4000-8000-000000000001',sha='a'.repeat(64),sourceIdentity='b'.repeat(64)
const definition:BusinessObjectTypeDefinitionV2={format:'teloa.business-object-type/v2',id:'expense',version:'1.0.0',domain:'sales',title:'费用',unit:'条',lead:'费用记录',sourceId:'local',fields:[
 {name:'amount',label:'金额',from:'金额',format:'teloa.business-rich-field/v2',type:'money',required:true,currencies:['USD','CNY']},
 {name:'tags',label:'标签',from:'标签',format:'teloa.business-rich-field/v2',type:'multi-enum',required:false,values:['甲','乙','丙']},
]}
const mapping=readBusinessImportMapping({delimiter:',',headerRow:1,primaryKey:[{column:0,trim:false}],title:{column:1,trim:true},fields:[{field:'amount',value:{column:2,trim:false},currency:{column:3,trim:false}},{field:'tags',value:{column:4,trim:false}}]})
function table(cells:string[][]):BusinessImportTable{return {format:'teloa.business-import-table/v1',parserVersion:'csv-v1',columns:cells[0]!.length,rows:cells.map((cells,index)=>({rowNumber:index+1,cells}))}}
const source=table([['编号','标题','金额','币种','标签'],[' 001 ','第一条','123456789012345678.1234','USD','["乙","甲"]'],['002','第二条','-0.0000','CNY','']])
const base={draftId:id,scope:'sales',type:'expense',fileHash:sha,revision:2,sourceIdentity,configurationVersion:1,definition,mapping,table:source}

test('money_is_exact_and_multi_values_are_canonical',async()=>{
 const result=await preview(base)
 assert.equal(result.canApply,true)
 assert.deepEqual(result.rows.map(row=>row.operation.fields),[
  [{name:'amount',value:'{"currency":"USD","decimal":"123456789012345678.1234"}'},{name:'tags',value:'["甲","乙"]'}],
  [{name:'amount',value:'{"currency":"CNY","decimal":"0"}'},{name:'tags',value:''}],
 ])
 assert.equal(readBusinessImportPreview(result).rows.length,2)
})
test('preview_is_zero_write_and_preserves_source_rows',async()=>{
 const result=await preview(base)
 assert.deepEqual(result.rows.map(row=>({row:row.rowNumber,key:row.primaryKey,title:row.operation.title})),[{row:2,key:[' 001 '],title:'第一条'},{row:3,key:['002'],title:'第二条'}])
 assert.equal(Object.hasOwn(result.rows[0]!.operation,'id'),false)
 assert.deepEqual(source.rows[1]!.cells,[' 001 ','第一条','123456789012345678.1234','USD','["乙","甲"]'])
})
test('primary_key_trim_is_independent_and_bound_to_every_digest',async()=>{
 const original=await preview(base),trimmed=await preview({...base,mapping:{...mapping,primaryKey:[{column:0,trim:true}]}})
 assert.deepEqual(trimmed.rows[0]!.primaryKey,['001'])
 assert.notEqual(original.sourcePolicyDigest,trimmed.sourcePolicyDigest)
 assert.notEqual(original.contentKey,trimmed.contentKey)
 assert.notEqual(original.digest,trimmed.digest)
 const titleTrim=await preview({...base,mapping:{...mapping,title:{column:1,trim:false}}})
 assert.equal(titleTrim.sourcePolicyDigest,original.sourcePolicyDigest)
 assert.notEqual(titleTrim.contentKey,original.contentKey)
 const ordered=await preview({...base,mapping:{...mapping,primaryKey:[{column:0,trim:true},{column:3,trim:false}]}})
 const reversed=await preview({...base,mapping:{...mapping,primaryKey:[{column:3,trim:false},{column:0,trim:true}]}})
 assert.notEqual(ordered.contentKey,reversed.contentKey)
})
test('missing_keys_duplicate_tuples_and_invalid_rich_values_block_all_rows',async()=>{
 for(const cells of [
  [['','第一条','1','USD','']],
  [['001','第一条','1','USD',''],['001','第二条','2','USD','']],
  [['001','第一条','1','USD','["甲","甲"]']],
  [['001','第一条','1','USD','["未知"]']],
  [['001','第一条','1.00001','USD','']],
  [['001','第一条','1e2','USD','']],
 ]){
  const result=await preview({...base,table:table([source.rows[0]!.cells,...cells])})
  assert.equal(result.canApply,false);assert.ok(result.issues.length)
  assert.ok(result.issues.every(issue=>!issue.message.includes('未知')))
  assert.equal(readBusinessImportPreview(result).canApply,false)
 }
})
test('reference_requires_an_existing_unarchived_local_uuid_and_binds_snapshot_identity',async()=>{
 const relation={...definition,fields:[{name:'client',label:'客户',from:'客户',type:'reference' as const,referenceType:'customer',required:true}]}
 const m={...mapping,fields:[{field:'client',value:{column:2,trim:false}}]}
 const t=table([['编号','标题','客户'],['001','费用',id]])
 const snapshot:BusinessObjectSnapshot={scope:'sales',type:'customer',id,version:1,snapshotHash:sha,title:'原客户',source:'本地记录',quality:'complete',summary:'',fields:[],observedAt:'2026-09-30T00:00:00.000Z',receivedAt:'2026-09-30T00:00:00.000Z'}
 const first=await preview({...base,definition:relation,mapping:m,table:t,resolveReference:async()=>snapshot})
 assert.equal(first.canApply,true)
 const later=await preview({...base,definition:relation,mapping:m,table:t,resolveReference:async()=>({...snapshot,version:2,snapshotHash:'c'.repeat(64)})})
 assert.notEqual(first.digest,later.digest)
 const archived=await preview({...base,definition:relation,mapping:m,table:t,resolveReference:async()=>({...snapshot,deletedAt:'2026-09-30T00:00:00.000Z'})})
 assert.equal(archived.canApply,false)
 const external=await preview({...base,definition:relation,mapping:m,table:table([t.rows[0]!.cells,['001','费用','external-001']]),resolveReference:async()=>snapshot})
 assert.equal(external.canApply,false)
})
test('inspect_returns_original_duplicate_headers_and_bounded_whole_row_samples',()=>{
 const rows=Array.from({length:8},(_,i)=>[String(i), 'x'.repeat(4000),'y'.repeat(4000),'z'.repeat(4000)])
 const result=inspect({...base,delimiter:',',table:table([[' 名称 ','名称','',''],...rows])})
 assert.deepEqual(result.columns,[{column:0,header:' 名称 '},{column:1,header:'名称'},{column:2,header:''},{column:3,header:''}])
 assert.equal(result.complete,true);assert.equal(result.dataRows,8);assert.equal(result.sampleRows.length,5);assert.equal(result.sampleRowsOmitted,3)
 assert.ok(Buffer.byteLength(JSON.stringify(result.sampleRows))<=65536)
 const wider=table([Array(20).fill(''),...Array.from({length:2},()=>Array(20).fill('x'.repeat(4000)))])
 const bounded=inspect({...base,delimiter:',',table:wider})
 assert.equal(bounded.sampleRows.length,0);assert.equal(bounded.sampleRowsOmitted,2)
})
test('inspect_errors_never_claim_a_complete_table',()=>{
 const result=inspect({...base,delimiter:',',issues:[{rowNumber:52,code:'rows-too-many',message:'表格超过50条，请拆分文件后重试。'}]})
 assert.equal(result.complete,false);assert.equal(result.canMap,false)
 assert.deepEqual(result.columns,[]);assert.deepEqual(result.sampleRows,[])
 assert.equal(Object.hasOwn(result,'dataRows'),false);assert.equal(Object.hasOwn(result,'sampleRowsOmitted'),false)
})
test('inspection_response_limit_rejects_the_whole_header_without_truncating',()=>{
 const oversized=table([Array(64).fill('界'.repeat(4000)),Array(64).fill('')])
 const result=inspect({...base,delimiter:',',table:oversized})
 assert.equal(result.complete,false);assert.deepEqual(result.columns,[]);assert.equal(result.issues[0]!.code,'inspection-too-large')
})
test('bounded_issues_never_turn_omitted_bad_rows_into_successful_rows',async()=>{
 const required={...definition,fields:Array.from({length:50},(_,index)=>({name:'f'+index,label:'字段'+index,from:'字段'+index,type:'text' as const,required:true}))}
 const invalid=table([['编号','标题'],...Array.from({length:50},(_,index)=>[String(index),'标题'])])
 const result=await preview({...base,definition:required,mapping:{...mapping,fields:[]},table:invalid})
 assert.equal(result.canApply,false);assert.equal(result.issues.length,100);assert.equal(result.rows.length,0)
})
test('display_rename_changes_preview_guard_but_preserves_content_identity',async()=>{
 const original=await preview(base),renamed=await preview({...base,definition:{...definition,title:'新名称',version:'1.0.1',fields:definition.fields.map(field=>({...field,label:'新'+field.label}))}})
 assert.notEqual(original.schemaFingerprint,renamed.schemaFingerprint)
 assert.notEqual(original.digest,renamed.digest)
 assert.equal(original.writeSchemaFingerprint,renamed.writeSchemaFingerprint)
 assert.equal(original.contentKey,renamed.contentKey)
 const conflict=await preview({...base,sourceContentKey:'c'.repeat(64)})
 assert.equal(conflict.canApply,false);assert.ok(conflict.issues.some(issue=>issue.code==='source-policy-conflict'))
})
test('parser_errors_are_bounded_and_only_frozen_parser_issues_are_folded',()=>{
 assert.equal(typeof subject.businessImportParseIssues,'function')
 assert.deepEqual(subject.businessImportParseIssues(new WorkError('teloa/invalid-input','格式错误',{businessImportIssues:[{code:'empty-table',message:'表格没有数据行，请补充内容。'}]})),[{code:'empty-table',message:'表格没有数据行，请补充内容。'}])
 assert.throws(()=>subject.businessImportParseIssues(new WorkError('teloa/source-unavailable','附件不可读。')),{code:'teloa/source-unavailable'})
 assert.throws(()=>subject.businessImportParseIssues(new WorkError('teloa/invalid-input','错误',{businessImportIssues:[{code:'other',message:'错误。'}]})),{code:'teloa/invalid-input'})
})
const inaccessible=async():Promise<never>=>{throw Error('不得访问外部端口')}
const portDependencies={definitions:{forScopeVersioned:inaccessible},store:{currentInTransaction:inaccessible},records:{get:inaccessible,batchInTransaction:inaccessible},references:{pinInTransaction:inaccessible},files:{save:inaccessible,read:inaccessible},tables:{parse:inaccessible}}
const portPool={connect:inaccessible} as unknown as Pool
test('port_aborted_stage_never_saves_or_opens_a_transaction',async()=>{
 assert.equal(typeof service.BusinessRecordImportService,'function','须提供持久导入服务')
 const signal=AbortSignal.abort(new WorkError('teloa/cancelled','已取消。'))
 const imports=new service.BusinessRecordImportService(portPool,{id:()=>id,now:()=>new Date().toISOString()},portDependencies)
 await assert.rejects(imports.stage({ownerId:'owner',scopeIds:['sales']},{requestId:id,scope:'sales',type:'expense',name:'data.csv',bytes:0,dataBase64:''},signal),{code:'teloa/cancelled'})
})
test('port_foreign_scope_is_denied_before_file_or_database_access',async()=>{
 assert.equal(typeof service.BusinessRecordImportService,'function','须提供持久导入服务')
 const imports=new service.BusinessRecordImportService(portPool,{id:()=>id,now:()=>new Date().toISOString()},portDependencies)
 await assert.rejects(imports.stage({ownerId:'owner',scopeIds:[]},{requestId:id,scope:'sales',type:'expense',name:'data.csv',bytes:0,dataBase64:''}),{code:'teloa/forbidden'})
})
function readableDraft(){
 const bytes=Buffer.from('编号,标题\n001,第一条'),fileHash=createHash('sha256').update(bytes).digest('hex')
 const draft=readBusinessImportDraft({format:'teloa.business-record-import/v1',id,stageRequestId:id,ownerId:'owner',scope:'sales',type:'expense',sourceIdentity:subject.businessImportSourceIdentity('owner','sales','expense',fileHash),revision:1,status:'ready',file:{attachmentId:id,name:'data.csv',bytes:bytes.length,sha256:fileHash},createdAt:'2026-09-30T00:00:00.000Z',updatedAt:'2026-09-30T00:00:00.000Z'})
 return {bytes,draft}
}
test('port_full_read_rejects_length_hash_and_real_cap_before_parse',async()=>{
 const {bytes,draft}=readableDraft()
 for(const actual of [bytes.subarray(0,bytes.length-1),Buffer.alloc(bytes.length,120),Buffer.alloc(2_097_153)]){
  const imports=new service.BusinessRecordImportService(portPool,{id:()=>id,now:()=>new Date().toISOString()},{...portDependencies,files:{save:inaccessible,read:async()=>actual}})
  imports.get=async()=>draft
  await assert.rejects(imports.inspect({ownerId:'owner',scopeIds:['sales']},{draftId:id,expectedRevision:1,delimiter:','}),{code:'teloa/file-changed'})
 }
})
test('port_abort_after_full_read_prevents_parser_and_a_usable_preview',async()=>{
 const {bytes,draft}=readableDraft(),controller=new AbortController()
 const imports=new service.BusinessRecordImportService(portPool,{id:()=>id,now:()=>new Date().toISOString()},{...portDependencies,files:{save:inaccessible,read:async()=>{controller.abort(new WorkError('teloa/cancelled','已停止。'));return bytes}}})
 imports.get=async()=>draft
 await assert.rejects(imports.inspect({ownerId:'owner',scopeIds:['sales']},{draftId:id,expectedRevision:1,delimiter:','},controller.signal),{code:'teloa/cancelled'})
})

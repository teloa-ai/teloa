import test from 'node:test'
import assert from 'node:assert/strict'
import {WorkError,readBusinessImportIssues,readBusinessImportTable,type BusinessImportIssue,type BusinessImportMapping} from '@teloa/contract'
import {parseBusinessImportCsv} from '../src/work/business-import-csv.ts'

const bytes=(text:string)=>new TextEncoder().encode(text)
async function issue(source:Uint8Array,code:string,position?:Pick<BusinessImportIssue,'rowNumber'|'column'>){
 let found:BusinessImportIssue|undefined
 await assert.rejects(parseBusinessImportCsv(source,','),error=>{
  assert.ok(error instanceof WorkError)
  assert.equal(error.code,'teloa/invalid-input')
  const issues=readBusinessImportIssues(error.details?.businessImportIssues)
  assert.ok(issues.length>0&&issues.length<=100)
  found=issues[0]
  assert.equal(found?.code,code)
  if(position)assert.deepEqual({rowNumber:found?.rowNumber,column:found?.column},position)
  assert.ok(error.message.length<=240)
  return true
 })
 return found!
}

test('utf8_bom_quotes_newlines_and_leading_zero_are_preserved',async()=>{
 const table=await parseBusinessImportCsv(bytes('\ufeff 编号 ,重复,重复,,备注\r\n001,"甲,乙","说""好""",,"第一行\r\n第二行"\r\n002, x ,y,,结尾'),',')
 assert.deepEqual(table,{
  format:'teloa.business-import-table/v1',parserVersion:'csv-v1',columns:5,
  rows:[
   {rowNumber:1,cells:[' 编号 ','重复','重复','','备注']},
   {rowNumber:2,cells:['001','甲,乙','说"好"','','第一行\r\n第二行']},
   {rowNumber:3,cells:['002',' x ','y','','结尾']},
  ],
 })
 assert.deepEqual(readBusinessImportTable(table),table)
})

test('delimiter_is_explicit_and_quoted_lf_is_one_logical_row',async()=>{
 assert.deepEqual((await parseBusinessImportCsv(bytes('编号;备注\n001;"甲\n乙,丙"\n'),';')).rows,[
  {rowNumber:1,cells:['编号','备注']},{rowNumber:2,cells:['001','甲\n乙,丙']},
 ])
 assert.deepEqual((await parseBusinessImportCsv(bytes('编号\t备注\n001\t甲;乙'), '\t')).rows,[
  {rowNumber:1,cells:['编号','备注']},{rowNumber:2,cells:['001','甲;乙']},
 ])
 assert.deepEqual((await parseBusinessImportCsv(bytes('编号;备注\n001;甲'),',')).rows,[
  {rowNumber:1,cells:['编号;备注']},{rowNumber:2,cells:['001;甲']},
 ])
 for(const delimiter of ['\\t','|','',undefined]){
  await assert.rejects(parseBusinessImportCsv(bytes('编号\n001'),delimiter as BusinessImportMapping['delimiter']),{code:'teloa/invalid-input'})
 }
})

test('blank_middle_rows_and_trailing_empty_cells_are_not_skipped',async()=>{
 assert.deepEqual((await parseBusinessImportCsv(bytes('编号\n001\n\n002\n'),',')).rows,[
  {rowNumber:1,cells:['编号']},{rowNumber:2,cells:['001']},{rowNumber:3,cells:['']},{rowNumber:4,cells:['002']},
 ])
 assert.deepEqual((await parseBusinessImportCsv(bytes(',\n甲,\n'),',')).rows,[
  {rowNumber:1,cells:['','']},{rowNumber:2,cells:['甲','']},
 ])
 await issue(bytes('编号,备注\n\n001,甲'),'ragged-rows',{rowNumber:2,column:1})
})

test('invalid_utf8_is_rejected_without_replacement_or_encoding_guess',async()=>{
 await issue(Uint8Array.of(0x61,0x0a,0xc3,0x28),'invalid-utf8')
 await issue(Uint8Array.of(0xff,0xfe,0x61,0x00),'invalid-utf8')
 await issue(Uint8Array.of(0x61,0x0a,0xed,0xa0,0x80),'invalid-utf8')
})

test('unclosed_or_illegal_quotes_and_bare_cr_are_rejected_at_logical_position',async()=>{
 for(const source of ['编号,备注\n001,"甲\n乙','编号,备注\n001,甲"乙','编号,备注\n001,"甲"乙','编号,备注\n001, "甲"']){
  await issue(bytes(source),'invalid-csv',{rowNumber:2,column:1})
 }
 await issue(bytes('编号,备注\r001,甲'),'invalid-csv',{rowNumber:1,column:1})
 await issue(bytes('\ufeff\ufeff编号\n001'),'invalid-csv',{rowNumber:1,column:0})
})

test('ragged_rows_identify_first_missing_or_extra_column_without_truncation',async()=>{
 await issue(bytes('编号,备注\n001'),'ragged-rows',{rowNumber:2,column:1})
 await issue(bytes('编号,备注\n001,甲,额外'),'ragged-rows',{rowNumber:2,column:2})
 await issue(bytes('编号,备注\n001,"甲\n乙"\n002'),'ragged-rows',{rowNumber:3,column:1})
})

test('empty_or_header_only_sources_do_not_return_an_importable_table',async()=>{
 for(const source of ['', '\ufeff', '编号', '编号\n', '\n'])await issue(bytes(source),'empty-table')
})

test('all_64_columns_50_data_rows_and_4000_code_units_are_preserved_at_limits',async()=>{
 const headers=Array.from({length:64},(_,column)=>'列'+column)
 const row=Array.from({length:64},(_,column)=>column===63?'甲'.repeat(4000):'001')
 const table=await parseBusinessImportCsv(bytes([headers.join(','),...Array.from({length:50},()=>row.join(','))].join('\n')),',')
 assert.equal(table.columns,64)
 assert.equal(table.rows.length,51)
 assert.deepEqual(table.rows[0],{rowNumber:1,cells:headers})
 assert.deepEqual(table.rows[50],{rowNumber:51,cells:row})
 assert.deepEqual(table.rows.map(row=>row.rowNumber),Array.from({length:51},(_,index)=>index+1))
 assert.deepEqual(readBusinessImportTable(table),table)
 assert.equal((await parseBusinessImportCsv(bytes('备注\n'+ '😀'.repeat(2000)),',')).rows[1]!.cells[0],'😀'.repeat(2000))
})

test('never_returns_first_50_as_complete',async()=>{
 const source=['编号',...Array.from({length:51},(_,index)=>'00'+index)].join('\n')
 await issue(bytes(source),'rows-too-many',{rowNumber:52,column:0})
 await issue(bytes('编号\n'+Array.from({length:50},()=> '001').join('\n')+'\n\n'),'rows-too-many',{rowNumber:52,column:0})
})

test('column_overflow_reports_the_actual_65th_column',async()=>{
 await issue(bytes(Array.from({length:65},()=> '列').join(',')+'\n001'),'columns-too-many',{rowNumber:1,column:64})
 await issue(bytes('编号\n'+Array.from({length:65},()=> '001').join(',')),'columns-too-many',{rowNumber:2,column:64})
})

test('source_cell_limits_refuse_full_values_and_errors_do_not_include_source_text',async()=>{
 await issue(bytes('甲'.repeat(4001)+'\n001'),'source-cell-too-long',{rowNumber:1,column:0})
 await issue(bytes('备注\n'+ '😀'.repeat(2001)),'source-cell-too-long',{rowNumber:2,column:0})
 const headers=Array.from({length:64},()=> '列').join(',')
 const normal=Array.from({length:64},()=> '001').join(',')
 const secret='PRIVATE_SOURCE_VALUE_'+ '甲'.repeat(4001)
 const last=Array.from({length:64},(_,column)=>column===63?'"'+secret+'"':'001').join(',')
 const source=bytes([headers,...Array.from({length:49},()=>normal),last].join('\n'))
 await issue(source,'source-cell-too-long',{rowNumber:51,column:63})
 await assert.rejects(parseBusinessImportCsv(source,','),error=>{
  assert.ok(error instanceof WorkError)
  assert.ok(!JSON.stringify({message:error.message,details:error.details}).includes('PRIVATE_SOURCE_VALUE'))
  return true
 })
})

test('abort_before_or_during_parsing_never_returns_a_table',async()=>{
 await assert.rejects(parseBusinessImportCsv(bytes('编号\n001'),',',AbortSignal.abort()),{name:'AbortError'})
 const reason=new Error('本人取消')
 await assert.rejects(parseBusinessImportCsv(bytes('编号\n001'),',',AbortSignal.abort(reason)),error=>error===reason)
 const controller=new AbortController()
 const headers=Array.from({length:64},()=> '列').join(',')
 const data=Array.from({length:64},()=> '甲'.repeat(4000)).join(',')
 const parsing=parseBusinessImportCsv(bytes(headers+'\n'+data),',',controller.signal)
 setImmediate(()=>controller.abort(reason))
 await assert.rejects(parsing,error=>error===reason)
})

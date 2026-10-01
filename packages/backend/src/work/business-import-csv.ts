import {WorkError,type BusinessImportIssue,type BusinessImportMapping,type BusinessImportRow,type BusinessImportTable} from '@teloa/contract'

const invalid=(issue:BusinessImportIssue)=>new WorkError('teloa/invalid-input','业务表格 CSV 格式或大小不符合导入要求。',{businessImportIssues:[issue]})

export async function parseBusinessImportCsv(bytes:Uint8Array,delimiter:BusinessImportMapping['delimiter'],signal?:AbortSignal):Promise<BusinessImportTable>{
 signal?.throwIfAborted()
 if(delimiter!==','&&delimiter!==';'&&delimiter!=='\t')throw invalid({code:'invalid-csv',message:'请明确选择逗号、分号或制表符作为分隔符。'})
 let source:string
 try{source=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes)}
 catch{throw invalid({code:'invalid-utf8',message:'文件不是有效的 UTF-8 编码，请以 UTF-8 重新保存。'})}
 signal?.throwIfAborted()
 if(source.startsWith('\ufeff'))source=source.slice(1)
 if(source.startsWith('\ufeff'))throw invalid({code:'invalid-csv',message:'文件开头只能包含一个 UTF-8 BOM。',rowNumber:1,column:0})

 const rows:BusinessImportRow[]=[]
 let cells:string[]=[],cell='',state:'start'|'bare'|'quoted'|'closed'='start',columns=0,nextYield=16384
 const fail=(code:string,message:string,column=cells.length):never=>{throw invalid({code,message,rowNumber:rows.length+1,column})}
 const append=(character:string)=>{
  if(cell.length+character.length>4000)fail('source-cell-too-long','单元格超过 4000 字限制，请缩短后重新导入。')
  cell+=character
 }
 const finishCell=()=>{
  if(cells.length>=64)fail('columns-too-many','表格超过 64 列限制，请拆分后重新导入。')
  cells.push(cell);cell='';state='start'
 }
 const finishRow=()=>{
  finishCell()
  if(rows.length>=51)fail('rows-too-many','表格超过 50 条数据限制，请拆分文件后重新导入。',0)
  if(rows.length===0)columns=cells.length
  else if(cells.length!==columns)fail('ragged-rows','此行的列数与表头不一致，请核对分隔符和引号。',Math.min(cells.length,columns))
  rows.push({rowNumber:rows.length+1,cells});cells=[]
 }

 for(let index=0;index<source.length;index++){
  // 有界让出事件循环，使正在解析的本人取消能在返回表格前生效。
  if(signal&&index>=nextYield){await new Promise<void>(resolve=>setImmediate(resolve));signal.throwIfAborted();nextYield=index+16384}
  if(rows.length>=51)fail('rows-too-many','表格超过 50 条数据限制，请拆分文件后重新导入。',0)
  const character=source[index]!
  if(state==='quoted'){
   if(character==='"'){
    if(source[index+1]==='"'){append('"');index++}
    else state='closed'
   }else append(character)
   continue
  }
  if(character===delimiter){
   finishCell()
   if(cells.length>=64)fail('columns-too-many','表格超过 64 列限制，请拆分后重新导入。',64)
   continue
  }
  if(character==='\n'||character==='\r'){
   if(character==='\r'){
    if(source[index+1]!=='\n')fail('invalid-csv','换行必须使用 LF 或 CRLF，请核对 CSV 格式。')
    index++
   }
   finishRow();continue
  }
  if(character==='"'){
   if(state!=='start')fail('invalid-csv','引号只能包围完整单元格，内部引号请写成两个双引号。')
   state='quoted';continue
  }
  if(state==='closed')fail('invalid-csv','闭合引号后只能出现分隔符或换行。')
  append(character);state='bare'
 }
 signal?.throwIfAborted()
 if(state==='quoted')fail('invalid-csv','单元格的引号尚未闭合，请核对 CSV 格式。')
 // 末尾换行是记录终止符；中间空行由 finishRow 保留。
 if(cells.length||cell.length||state!=='start')finishRow()
 if(rows.length<2)throw invalid({code:'empty-table',message:'表格需要包含表头和至少一条数据。'})
 return {format:'teloa.business-import-table/v1',parserVersion:'csv-v1',columns,rows}
}

import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import test from 'node:test'
import {ZipWriter,ZipReader,Uint8ArrayWriter,Uint8ArrayReader} from '@zip.js/zip.js/lib/zip-native.js'
import {WorkError,type BusinessImportSourceV2,type BusinessImportPolicyV2} from '@teloa/contract'
import {createBusinessImportXlsxPort} from '../src/business-import-xlsx.ts'

const S='http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const R='http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const P='http://schemas.openxmlformats.org/package/2006/relationships'
const C='http://schemas.openxmlformats.org/package/2006/content-types'
const mime='application/vnd.openxmlformats-officedocument.spreadsheetml.'
const encoder=new TextEncoder()
const source:BusinessImportSourceV2={kind:'xlsx',sheet:{sheetId:'9',name:' 第二表 ',part:'data/two.xml'}}
const policy:BusinessImportPolicyV2={parserVersion:'xlsx-scalar-v1',scalarPolicy:'closed-scalar-v1',datePolicy:'reject-date-v1',formulaPolicy:'reject-formula-v1'}
const header='<row r="1"><c r="A1" t="inlineStr"><is><t>编号</t></is></c></row>'
const scalarRow='<row r="2"><c r="A2"><v>001</v></c><c r="B2"><v>123456789012345678.1234</v></c><c r="C2"><v>1.25E+20</v></c><c r="D2" t="b"><v>1</v></c><c r="E2" t="str"><v>  文本  </v></c><c r="G2"/></row>'
const sheet=(rows:string)=>`<worksheet xmlns="${S}"><sheetData>${header}${rows}</sheetData></worksheet>`
async function workbook(options:{level?:number;comment?:string;row?:string}={}){
 const rel=(id:string,kind:string,target:string)=>`<Relationship Id="${id}" Type="${R}/${kind}" Target="${target}"/>`
 const relations=(body:string)=>`<Relationships xmlns="${P}">${body}</Relationships>`
 const parts:[string,string][]=[
  ['[Content_Types].xml',`<Types xmlns="${C}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/book/main.xml" ContentType="${mime}sheet.main+xml"/><Override PartName="/data/one.xml" ContentType="${mime}worksheet+xml"/><Override PartName="/data/two.xml" ContentType="${mime}worksheet+xml"/></Types>`],
  ['_rels/.rels',relations(rel('root','officeDocument','book/main.xml'))],
  ['book/main.xml',`<workbook xmlns="${S}" xmlns:r="${R}"><sheets><sheet name="第一表" sheetId="7" r:id="one"/><sheet name=" 第二表 " sheetId="9" r:id="two"/></sheets></workbook>`],
  ['book/_rels/main.xml.rels',relations(rel('one','worksheet','../data/one.xml')+rel('two','worksheet','/data/two.xml'))],
  ['data/one.xml',sheet('<row r="2"><c r="A2" t="str"><v>第一表独有</v></c></row>')],
  ['data/two.xml',sheet(options.row??scalarRow)],
 ]
 const writer=new ZipWriter(new Uint8ArrayWriter(),{useWebWorkers:false,useCompressionStream:true,dataDescriptor:false})
 for(const [path,xml] of parts)await writer.add(path,new Uint8ArrayReader(encoder.encode(xml)),{level:options.level??6})
 return writer.close(encoder.encode(options.comment??''))
}
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex')
const invalid=(error:unknown):error is WorkError=>error instanceof WorkError&&error.code==='teloa/invalid-input'

for(const level of [0,6])test(`真实两表 ZIP ${level} 按完整关系返回目录、policy和原附件哈希`,async()=>{
 const bytes=await workbook({level}),result=await createBusinessImportXlsxPort().inspectWorkbook(bytes)
 assert.deepEqual(result,{format:'teloa.business-import-workbook/v2',fileHash:hash(bytes),bytes:bytes.byteLength,sheets:[{sheetId:'7',name:'第一表',part:'data/one.xml'},source.sheet],policy})
})
test('准确选择第二表并保留四类标量与数字词法，第一表单独可选',async()=>{
 const port=createBusinessImportXlsxPort(),bytes=await workbook(),table=await port.parseSheet(bytes,source)
 assert.deepEqual(table,{format:'teloa.business-import-table/v2',source,policy,columns:7,rows:[{rowNumber:1,cells:[{kind:'string',text:'编号'},...Array.from({length:6},()=>({kind:'blank',text:''}))]},{rowNumber:2,cells:[{kind:'number',text:'001'},{kind:'number',text:'123456789012345678.1234'},{kind:'number',text:'1.25E+20'},{kind:'boolean',text:'true'},{kind:'string',text:'  文本  '},{kind:'blank',text:''},{kind:'blank',text:''}]}]})
 const first=await port.parseSheet(bytes,{kind:'xlsx',sheet:{sheetId:'7',name:'第一表',part:'data/one.xml'}})
 assert.equal(first.rows[1]!.cells[0]!.text,'第一表独有')
})
test('相同解包内容只改ZIP注释仍产生不同原文件hash',async()=>{
 const original=await workbook({comment:'原附件A'}),modified=new Uint8Array(original)
 const comment=encoder.encode('原附件B');modified.set(comment,modified.length-comment.length)
 const port=createBusinessImportXlsxPort(),first=await port.inspectWorkbook(original),second=await port.inspectWorkbook(modified)
 assert.deepEqual(first.sheets,second.sheets);assert.deepEqual(await port.parseSheet(original,source),await port.parseSheet(modified,source))
 assert.equal(first.fileHash,hash(original));assert.equal(second.fileHash,hash(modified));assert.notEqual(first.fileHash,second.fileHash)
})
test('首await前固定Uint8Array和Buffer，异步改写不污染目录哈希或表格',async()=>{
 const original=await workbook(),expectedHash=hash(original),port=createBusinessImportXlsxPort()
 for(const bytes of [new Uint8Array(original),Buffer.from(original)]){
  const inspect=port.inspectWorkbook(bytes),parse=port.parseSheet(bytes,source);bytes.fill(0)
  assert.equal((await inspect).fileHash,expectedHash);assert.equal((await inspect).bytes,original.byteLength)
  assert.deepEqual((await parse).rows[1]!.cells[0],{kind:'number',text:'001'})
 }
})
test('不匹配source任一身份或未知表均拒绝，不回退第一表',async()=>{
 const bytes=await workbook(),port=createBusinessImportXlsxPort()
 for(const selected of [{...source.sheet,name:'第二表'},{...source.sheet,sheetId:'7'},{...source.sheet,part:'data/one.xml'},{sheetId:'99',name:'未知表',part:'data/missing.xml'}]){
  await assert.rejects(port.parseSheet(bytes,{kind:'xlsx',sheet:selected}),error=>invalid(error)&&error.details?.businessImportIssues!==undefined)
 }
 await assert.rejects(port.parseSheet(bytes,{kind:'csv',sheet:source.sheet} as unknown as BusinessImportSourceV2),invalid)
})
test('source在调用方异步改写后仍使用最初的准确表身份',async()=>{
 const bytes=await workbook(),selected:BusinessImportSourceV2={kind:'xlsx',sheet:{...source.sheet}},pending=createBusinessImportXlsxPort().parseSheet(bytes,selected)
 selected.sheet.sheetId='7';selected.sheet.name='第一表';selected.sheet.part='data/one.xml'
 assert.deepEqual((await pending).source,source)
})
test('不支持公式拒绝，不静默读取其缓存值',async()=>{
 const bytes=await workbook({row:'<row r="2"><c r="A2"><f>1+1</f><v>2</v></c></row>'})
 await assert.rejects(createBusinessImportXlsxPort().parseSheet(bytes,source),invalid)
})
test('空、超2MiB及非Uint8Array输入拒绝',async()=>{
 const port=createBusinessImportXlsxPort()
 for(const bytes of [new Uint8Array(),new Uint8Array(2*1024*1024+1),[] as unknown as Uint8Array]){
  await assert.rejects(port.inspectWorkbook(bytes),invalid);await assert.rejects(port.parseSheet(bytes,source),invalid)
 }
})
test('目录和表格预取消、在途取消都保留原reason',async()=>{
 const bytes=await workbook(),port=createBusinessImportXlsxPort(),reason={cancelled:'original'}
 for(const run of [(signal:AbortSignal)=>port.inspectWorkbook(bytes,signal),(signal:AbortSignal)=>port.parseSheet(bytes,source,signal)]){
  const pre=new AbortController();pre.abort(reason);await assert.rejects(run(pre.signal),error=>error===reason)
  const active=new AbortController(),pending=run(active.signal);active.abort(reason);await assert.rejects(pending,error=>error===reason)
 }
})
test('ZIP收口触发取消后端口继续保留原reason',async()=>{
 const bytes=await workbook(),port=createBusinessImportXlsxPort(),reason={cancelled:'during-close'},original=ZipReader.prototype.close
 for(const run of [(signal:AbortSignal)=>port.inspectWorkbook(bytes,signal),(signal:AbortSignal)=>port.parseSheet(bytes,source,signal)]){
  const controller=new AbortController()
  ZipReader.prototype.close=async function(){await original.call(this);controller.abort(reason)}
  try{await assert.rejects(run(controller.signal),error=>error===reason)}finally{ZipReader.prototype.close=original}
 }
})

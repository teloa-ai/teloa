import test from 'node:test'
import assert from 'node:assert/strict'
import {chunkRetrievalText,normalizeRetrievalText,retrievalChunker,retrievalChunkerParameters} from '../src/capabilities/retrieval-chunker.ts'

const sentence=(index:number)=>`第${index}条制度规定员工报销需在三十日内提交完整票据，逾期不予受理。`
const paragraph=(from:number,count:number)=>Array.from({length:count},(_,offset)=>sentence(from+offset)).join('')
const lineSlice=(text:string,[start,end]:[number,number])=>text.split('\n').slice(start,end+1).join('\n')

test('分块器版本串带上全部参数',()=>{
 assert.deepEqual(retrievalChunkerParameters,{target:300,max:450,overlap:60,headingMax:200})
 assert.equal(retrievalChunker,'teloa.chunk.zh/v1;target=300;max=450;overlap=60;heading=200')
})

test('按标题和空行切段，短段在目标长度内合并，标题之间不合并',()=>{
 const text='# 总则\n\n第一段很短。\n\n第二段也很短。\n\n## 报销流程\n\n提交票据。\n'
 const chunks=chunkRetrievalText(text)
 assert.equal(chunks.length,2)
 assert.equal(chunks[0]!.text,'# 总则\n\n第一段很短。\n\n第二段也很短。')
 assert.equal(chunks[0]!.heading,'总则')
 assert.equal(chunks[1]!.text,'## 报销流程\n\n提交票据。')
 assert.equal(chunks[1]!.heading,'总则 > 报销流程')
 assert.deepEqual(chunks.map(chunk=>chunk.ordinal),[0,1])
 // 代码块内的井号行不是标题。
 const fenced=chunkRetrievalText('# 甲\n```\n# 不是标题\n```\n')
 assert.equal(fenced.length,1)
 assert.equal(fenced[0]!.heading,'甲')
 assert.deepEqual(chunkRetrievalText(''),[])
 assert.deepEqual(chunkRetrievalText('\n \n\t\n'),[])
})

test('多段落以 300 字为目标、450 字为上限合并；段内过长时按 60 字重叠切开',()=>{
 const paragraphs=Array.from({length:12},(_,index)=>paragraph(index*3,3))
 const text=paragraphs.join('\n\n')
 const chunks=chunkRetrievalText(text)
 assert.ok(chunks.length>1)
 for(const chunk of chunks){
  assert.ok(chunk.end-chunk.start<=450,'单块不超过上限')
  assert.equal(chunk.text,text.slice(chunk.start,chunk.end))
 }
 for(const chunk of chunks.slice(0,-1))assert.ok(chunk.end-chunk.start>=150,'非末块不应过碎')
 // 段落边界切开的相邻块不重叠。
 for(let index=1;index<chunks.length;index++)assert.ok(chunks[index]!.start>=chunks[index-1]!.end)

 const long=paragraph(0,40)
 const split=chunkRetrievalText(long)
 assert.ok(split.length>2)
 for(let index=1;index<split.length;index++){
  const previous=split[index-1]!,current=split[index]!
  assert.ok(previous.end-previous.start<=450)
  assert.equal(previous.end-current.start,60,'段内切开时相邻块重叠 60 字')
 }
 assert.equal(split.at(-1)!.end,long.length)
 // 优先在句末切开。
 for(const chunk of split.slice(0,-1))assert.ok(chunk.text.endsWith('。'))
})

test('CRLF 规范化后字符区间与行区间都能回切出原文',()=>{
 const text='# 标题\r\n\r\n'+paragraph(0,10)+'\r\n\r\n## 小节\r\n'+paragraph(20,30)+'\r旧式换行\r\n'
 const normalized=normalizeRetrievalText(text)
 assert.equal(normalized.includes('\r'),false)
 const chunks=chunkRetrievalText(text)
 assert.ok(chunks.length>=3)
 for(const chunk of chunks){
  assert.equal(normalized.slice(chunk.start,chunk.end),chunk.text)
  assert.ok(lineSlice(normalized,[chunk.startLine,chunk.endLine]).includes(chunk.text))
  assert.equal(normalized.slice(0,chunk.start).split('\n').length-1,chunk.startLine)
  assert.equal(normalized.slice(0,chunk.end-1).split('\n').length-1,chunk.endLine)
  assert.ok(chunk.text.trim().length>0)
  assert.match(chunk.textSha256,/^[a-f0-9]{64}$/)
 }
})

test('标题路径不超过 200 字，代理对不被切开',()=>{
 const heading='很长的标题'.repeat(30)
 const chunks=chunkRetrievalText(`# ${heading}\n## ${heading}\n正文。`)
 for(const chunk of chunks){
  assert.ok(chunk.heading!==null&&chunk.heading.length<=200&&chunk.heading.trim()===chunk.heading)
 }
 const emoji='😀'.repeat(400)
 for(const chunk of chunkRetrievalText(emoji)){
  assert.equal(/^[\uDC00-\uDFFF]/.test(chunk.text),false)
  assert.equal(/[\uD800-\uDBFF]$/.test(chunk.text),false)
 }
})

test('输入不变时输出确定',()=>{
 const text='# 甲\n'+paragraph(0,25)+'\n\n# 乙\n'+paragraph(40,5)
 assert.deepEqual(chunkRetrievalText(text),chunkRetrievalText(text))
 assert.deepEqual(chunkRetrievalText(text.replaceAll('\n','\r\n')),chunkRetrievalText(text))
})

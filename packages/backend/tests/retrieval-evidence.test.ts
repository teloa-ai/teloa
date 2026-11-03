import test from 'node:test'
import assert from 'node:assert/strict'
import {WorkError,readRetrievalSearchResult,retrievalCitationPath,retrievalLimits,type RetrievalSearchResult} from '@teloa/contract'
import {coalesceRetrievalEvidence} from '../src/capabilities/retrieval-evidence.ts'
import {chunkRetrievalText,normalizeRetrievalText} from '../src/capabilities/retrieval-chunker.ts'

type Hit=RetrievalSearchResult['results'][number]
const resourceId='11111111-1111-4111-8111-111111111111',otherId='22222222-2222-4222-8222-222222222222',version='a'.repeat(64)
function hit(text:string,start:number,end:number,overrides:Partial<Hit>={}):Hit{
 return {resourceId,resourceVersion:1,title:'合成资料',sourceId:'source_a',sourceVersion:version,heading:null,score:0.7,chars:[start,end],lines:[text.slice(0,start).split('\n').length-1,text.slice(0,end-1).split('\n').length-1],excerpt:text.slice(start,end),...overrides}
}
function validate(text:string,hits:Hit[]){
 for(const row of hits){
  assert.equal(row.excerpt,text.slice(...row.chars))
  assert.equal(row.lines[0],text.slice(0,row.chars[0]).split('\n').length-1)
  assert.equal(row.lines[1],text.slice(0,row.chars[1]-1).split('\n').length-1)
  assert.ok(Buffer.byteLength(row.excerpt)<=retrievalLimits.maxExcerptBytes)
  assert.equal(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(row.excerpt),false)
 }
 for(let i=0;i<hits.length;i++)for(const other of hits.slice(i+1))if(hits[i]!.sourceId===other.sourceId&&hits[i]!.sourceVersion===other.sourceVersion)assert.ok(hits[i]!.chars[1]<=other.chars[0]||other.chars[1]<=hits[i]!.chars[0])
 assert.ok(hits.length<=retrievalLimits.maxResults)
 assert.ok(hits.reduce((sum,row)=>sum+Buffer.byteLength(row.excerpt),0)<=retrievalLimits.maxTotalExcerptBytes)
}

test('真实分块的同一重叠原文只占一个证据窗，余量保留另一个独立事实',()=>{
 const fact='指定事实甲=19。',text='A'.repeat(250)+fact+'B'.repeat(800)+'\n\n# 独立条款\n指定事实乙=23。'
 const chunks=chunkRetrievalText(text),raw=chunks.filter(c=>c.text.includes(fact)).map(c=>hit(text,c.start,c.end,{score:0.9}))
 const independent=chunks.find(c=>c.text.includes('指定事实乙=23。'))!;raw.push(hit(text,independent.start,independent.end,{score:0.8}))
 assert.equal(raw.filter(row=>row.excerpt.includes(fact)).length,2)
 const result=coalesceRetrievalEvidence(raw,2)
 assert.equal(result.length,2);assert.equal(result.filter(row=>row.excerpt.includes(fact)).length,1)
 assert.ok(result[1]!.excerpt.includes('指定事实乙=23。'));assert.equal(result[0]!.score,0.9)
 validate(text,result)
})

test('同源不同事实、相邻区间与不同来源或正文版本不合并',()=>{
 const text='甲事实。乙事实。'
 assert.equal(coalesceRetrievalEvidence([hit(text,0,4),hit(text,4,8)],2).length,2)
 assert.equal(coalesceRetrievalEvidence([hit(text,0,4),hit(text,0,4,{sourceId:'source_b'})],2).length,2)
 assert.equal(coalesceRetrievalEvidence([hit(text,0,4),hit(text,0,4,{sourceVersion:'b'.repeat(64)})],2).length,2)
})

test('包含与链式重叠使用最高原余弦，合法代表资源与新引用绑定原source版本',()=>{
 const text='甲乙丙丁戊己庚辛壬癸'
 const result=coalesceRetrievalEvidence([hit(text,2,7,{resourceId:otherId,resourceVersion:3,score:0.95,citationPath:'obsolete'}),hit(text,0,5,{score:0.8}),hit(text,6,10,{score:0.7})],3)
 assert.equal(result.length,1);assert.equal(result[0]!.excerpt,text);assert.equal(result[0]!.resourceId,otherId);assert.equal(result[0]!.resourceVersion,3);assert.equal(result[0]!.score,0.95);assert.equal(result[0]!.citationPath,undefined)
 const citationPath=retrievalCitationPath('fixture-session',result[0]!)
 assert.ok(citationPath.endsWith('/0-10'))
 const checked=readRetrievalSearchResult({coverage:{searched:[{resourceId:otherId,title:'合成资料',version:3}],pending:[],note:'仅本次合成资料。'},results:[{...result[0]!,citationPath}]})
 assert.equal(checked.results[0]!.sourceVersion,version);validate(text,result)
})

test('重叠文字或行号不一致明确拒绝，不吞掉区间或拼造正文',()=>{
 const text='第一行\n第二行\n第三行'
 assert.throws(()=>coalesceRetrievalEvidence([hit(text,0,9),hit(text,5,12,{excerpt:text.slice(5,12).replace('二','错')})],2),error=>error instanceof WorkError&&error.code==='teloa/storage-corrupt')
 assert.throws(()=>coalesceRetrievalEvidence([hit(text,0,9),hit(text,5,12,{lines:[0,1]})],2),error=>error instanceof WorkError&&error.code==='teloa/storage-corrupt')
 assert.throws(()=>coalesceRetrievalEvidence([hit(text,0,9),hit(text,5,12,{score:Number.NaN})],2),error=>error instanceof WorkError&&error.code==='teloa/storage-corrupt')
})

test('UTF8有界窗不切坏emoji，CRLF规范化后的半开字符与末尾换行行号逐字正确',()=>{
 const text=normalizeRetrievalText('第一行\r\n'+'甲🙂乙\r\n'.repeat(400)),chunks=chunkRetrievalText(text)
 const raw=chunks.map(c=>hit(text,c.start,c.end)).slice(0,8),result=coalesceRetrievalEvidence(raw,8)
 assert.ok(result.length>1);validate(text,result)
 const tail='甲\n乙\n';validate(tail,coalesceRetrievalEvidence([hit(tail,0,3),hit(tail,2,4)],2))
})

test('输入和输出保持8条/2KiB/16KiB上限，不修改原命中或扩大limit',()=>{
 const text='甲'.repeat(400),raw=Array.from({length:8},(_,i)=>hit(text,0,text.length,{sourceId:'source_'+i,score:1-i/10})),copy=structuredClone(raw)
 const result=coalesceRetrievalEvidence(raw,3)
 assert.equal(result.length,3);assert.deepEqual(raw,copy)
 assert.throws(()=>coalesceRetrievalEvidence([...raw,raw[0]!],8),error=>error instanceof WorkError&&error.code==='teloa/storage-corrupt')
 assert.throws(()=>coalesceRetrievalEvidence(raw,9),error=>error instanceof WorkError&&error.code==='teloa/storage-corrupt')
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { readIndustryArchive } from '../src/client/industry-archive.ts'
const fixture=(name:string)=>readFile(new URL('../../../../tests/fixtures/行业压缩包/'+name,import.meta.url))
test('ZIP发现多行业模板并保留中文路径和真实知识正文',async()=>{
 const rows=await readIndustryArchive(await fixture('行业模板.zip'),'行业模板.zip')
 assert.equal(rows.length,2)
 const research=rows.find(row=>row.item?.title==='通用研究')?.item
 assert.ok(research?.packageContent)
 const body=research.packageContent.files.find(file=>file.path.endsWith('knowledge/通用研究方法.md'))
 assert.ok(body)
 assert.equal(new TextDecoder().decode(body.bytes),await readFile(new URL('../../../../examples/industry/通用研究/knowledge/通用研究方法.md',import.meta.url),'utf8'))
 assert.ok(research.packageContent.files.every(file=>!file.path.includes('/安全运营/')))
})
test('拒绝越界路径、符号链接、超大解压文件及损坏正文',async()=>{
 await assert.rejects(()=>fixture('越界路径.zip').then(bytes=>readIndustryArchive(bytes,'bad.zip')),/路径/)
 await assert.rejects(()=>fixture('符号链接.zip').then(bytes=>readIndustryArchive(bytes,'bad.zip')),/符号链接/)
 await assert.rejects(()=>fixture('超大文件.zip').then(bytes=>readIndustryArchive(bytes,'bad.zip')),/2 MiB/)
 await assert.rejects(()=>fixture('正文损坏.zip').then(bytes=>readIndustryArchive(bytes,'bad.zip')),/ZIP.*校验失败/)
})
test('截断ZIP和非ZIP不能降级为成功来源记录',async()=>{
 const bytes=await fixture('行业模板.zip')
 await assert.rejects(()=>readIndustryArchive(bytes.slice(0,bytes.length-30),'broken.zip'),/ZIP.*校验失败/)
 await assert.rejects(()=>readIndustryArchive(new TextEncoder().encode('not zip'),'fake.zip'),/ZIP.*校验失败/)
})
test('限制归档文件数和累计解压大小，不接受加密条目',async()=>{
 await assert.rejects(()=>fixture('总大小超限.zip').then(bytes=>readIndustryArchive(bytes,'large.zip')),/20 MiB/)
 await assert.rejects(()=>fixture('文件数量超限.zip').then(bytes=>readIndustryArchive(bytes,'many.zip')),/500 个文件/)
 await assert.rejects(()=>fixture('加密标记.zip').then(bytes=>readIndustryArchive(bytes,'encrypted.zip')),/加密/)
})

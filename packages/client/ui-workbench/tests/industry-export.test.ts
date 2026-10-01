import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { readIndustryArchive } from '../src/client/industry-archive.ts'
import { exportIndustryArchive } from '../src/client/industry-export.ts'
import { readIndustryDirectory } from '../src/client/industry-directory.ts'
const fixture=new URL('../../../../tests/fixtures/行业压缩包/行业模板.zip',import.meta.url)
test('导出完整模板再导入，正文、文件身份与内容摘要保持一致，排除兄弟模板',async()=>{
 const rows=await readIndustryArchive(await readFile(fixture),'样例.zip'),source=rows.find(row=>row.item?.title==='通用研究')!.item!
 const output=await exportIndustryArchive(source)
 assert.match(output.name,/\.zip$/)
 const restored=await readIndustryArchive(output.bytes,output.name)
 assert.equal(restored.length,1)
 assert.equal(restored[0]?.item?.packageContent?.hash,source.packageContent?.hash)
 assert.deepEqual(restored[0]?.item?.packageContent?.files,source.packageContent?.files)
})
test('内容被改动后拒绝冒充已固定版本导出',async()=>{
 const source=(await readIndustryArchive(await readFile(fixture),'样例.zip'))[0]!.item!
 source.packageContent!.files.find(file=>file.path.endsWith('.md'))!.bytes[0]=0
 await assert.rejects(()=>exportIndustryArchive(source),/内容.*变化/)
})
test('仅清单及公共引用声明可导出，但不伪造未取得的公共正文',async()=>{
 const raw=await readFile(new URL('../../../../tests/fixtures/公共引用消费方/teloa.json',import.meta.url)),source=await readIndustryDirectory([{path:'teloa.json',size:raw.length,read:async()=>raw}],'teloa.json','消费方')
 const output=await exportIndustryArchive(source),restored=(await readIndustryArchive(output.bytes,output.name))[0]!.item!
 assert.deepEqual(restored.manifest,source.manifest)
 assert.equal(restored.packageContent!.files.length,1)
 assert.equal(restored.packageContent!.resources[0]?.state,'unresolved')
})

test('v3 目录经 ZIP 导出与重新导入保留模型依赖、原始文件及固定摘要',async()=>{
 const dependency={catalogId:'teloa.model.sensevoice',version:'1.0.0',usage:'speech-to-text',required:true}
 const manifest={format:'teloa.business-package/v3',id:'meeting-notes',title:'会议纪要',version:'1.0.0',domain:'general',scope:'general',description:'在本机转写后整理会议纪要。',resources:[
  {id:'transcribe',kind:'work-template',title:'转写会议录音',version:'1.0.0',required:true,source:{kind:'local',path:'tasks/transcribe.json'},modelDependencies:[dependency]},
  {id:'outline',kind:'knowledge',title:'纪要格式',version:'1.0.0',required:false,source:{kind:'local',path:'knowledge/outline.md'}},
 ],relations:[],entrypoints:['transcribe']}
 const raw=new TextEncoder().encode(JSON.stringify(manifest,null,2)+'\n')
 const files=[{path:'teloa.json',bytes:raw},{path:'tasks/transcribe.json',bytes:new TextEncoder().encode('{"format":"teloa.work-template/v1","id":"transcribe"}\n')},{path:'knowledge/outline.md',bytes:new TextEncoder().encode('# 纪要格式\n\n结论与下一步。\n')}]
 const source=await readIndustryDirectory(files.map(file=>({path:file.path,size:file.bytes.length,read:async()=>file.bytes})),'teloa.json','会议纪要')
 const output=await exportIndustryArchive(source),restored=(await readIndustryArchive(output.bytes,output.name))[0]!.item!
 assert.ok(restored.manifest?.format==='teloa.business-package/v3')
 assert.deepEqual(restored.manifest,source.manifest)
 assert.deepEqual(restored.manifest.resources[0]!.modelDependencies,[dependency])
 assert.deepEqual(restored.packageContent!.files,source.packageContent!.files)
 assert.equal(restored.packageContent!.hash,source.packageContent!.hash)
 assert.deepEqual(restored.packageContent!.files.find(file=>file.path==='teloa.json')!.bytes,raw)
 assert.deepEqual(restored.packageContent!.resources,[{id:'transcribe',state:'available'},{id:'outline',state:'available'}])
 // 导出不能通过修改固定清单中的模型版本来冒充原有内容。
 source.packageContent!.files.find(file=>file.path==='teloa.json')!.bytes=new TextEncoder().encode(JSON.stringify({...manifest,resources:[{...manifest.resources[0],modelDependencies:[{...dependency,version:'2.0.0'}]},manifest.resources[1]]}))
 await assert.rejects(()=>exportIndustryArchive(source),/内容.*变化/)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import type { ArtifactFile } from '@teloa/contract'
import { createArtifact,changeArtifact,artifactMarkdown,type ArtifactSource } from '../src/client/artifact-preview.ts'
import { createArtifactFileApi,fileText,fileBytes,fileImageType } from '../src/client/artifact-files.ts'
import { changeArtifactWork } from '../src/client/artifact-work.ts'
import { emptyTaskPreview } from '../src/client/task-preview.ts'
import { resolveArtifactSource } from '../src/client/artifact-source.ts'
import { sourceStamp } from '../src/client/artifact-preview.ts'
const now='2026-09-11T07:00:00Z',source:ArtifactSource={ref:{kind:'session',id:'s1'},title:'文件工作',scope:'general',version:'binding',author:'本人',private:true,evidence:[]}
const labels=(key:string,params:Readonly<Record<string,string|number>>={})=>({
  'artifactFiles.snapshotMeta':'{bytes} bytes · 读取时间 {at}',
}[key]??key).replace(/\{(\w+)\}/g,(_,name:string)=>String(params[name]??''))
const file=(text='old\r\n'):ArtifactFile=>({schema:'teloa.file-snapshot/v1',sessionId:'s1',id:'a'.repeat(64),path:'out/result.txt',sha256:createHash('sha256').update(text).digest('hex'),bytes:Buffer.byteLength(text),capturedAt:now,contentBase64:Buffer.from(text).toString('base64')})
const make=()=>createArtifact({id:'a1',source,title:'结果',sections:[{id:'p1',title:'摘要',text:'结论'}],now,note:'保留文件',...{files:[file()]}})
test('文件图片预览按内容识别，脚本和SVG不能被当作可执行预览',()=>{
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1N8AAAAASUVORK5CYII=','base64')
 assert.equal(fileImageType(png),'image/png')
 assert.equal(fileImageType(Buffer.from([255,216,255,224,0,16])),'image/jpeg')
 assert.equal(fileImageType(Buffer.from('GIF89a'+String.fromCharCode(1,0,1,0))),'image/gif')
 assert.equal(fileImageType(Buffer.from('RIFFxxxxWEBPVP8 ')),'image/webp')
 for(const bytes of [Buffer.from('<svg onload="alert(1)"></svg>'),Buffer.from('<script>alert(1)</script>'),Buffer.from('print("image.png")'),png.subarray(0,4),Buffer.from('RIFFxxxxWAVE')])assert.equal(fileImageType(bytes),null)
})
test('工作稿固定读取到的文件字节，正文修订保留原文件，导出写明版本而非临时地址',()=>{
  const a=make(),original=file()
  assert.deepEqual(Reflect.get(a.versions[0]!,'files'),[original])
  const next=changeArtifact(a,{type:'revise',expectedVersion:1,sectionId:'p1',text:'新版结论',note:'改正文',now},source)
  assert.deepEqual(Reflect.get(next.versions[1]!,'files'),[original])
  assert.match(artifactMarkdown(next,2,labels),new RegExp(original.sha256));assert.match(artifactMarkdown(next,2,labels),/读取时间/)
  assert.doesNotMatch(artifactMarkdown(next,2,labels),new RegExp(original.contentBase64))
})
test('文件不能混入其他会话，重复身份拒绝，空文件允许固定为真实零字节版本',()=>{
  const input={id:'a1',source,title:'结果',sections:[{id:'p1',title:'摘要',text:'结论'}],now,note:'保留文件'}
  assert.throws(()=>createArtifact({...input,...{files:[{...file(),sessionId:'other'}]}}),/会话|来源/)
  assert.throws(()=>createArtifact({...input,...{files:[file(),file()]}}),/重复/)
  assert.equal(createArtifact({...input,files:[file('')]}).versions[0]?.files?.[0]?.bytes,0)
})
test('更新文件生成独立产物版本，不改正文与旧字节，旧基线及同内容更新被拒绝',()=>{
  const a=make(),newFile=file('new\n'),next=changeArtifact(a,{type:'files',expectedVersion:1,files:[newFile],note:'换新版文件',now},source)
  assert.equal(next.versions[0]!.files![0]!.contentBase64,file().contentBase64)
  assert.equal(next.versions[1]!.files![0]!.sha256,newFile.sha256)
  assert.deepEqual(next.versions[0]!.sections,next.versions[1]!.sections)
  assert.throws(()=>changeArtifact(next,{type:'files',expectedVersion:1,files:[],note:'旧基线',now},source),/版本/)
  assert.throws(()=>changeArtifact(next,{type:'files',expectedVersion:2,files:[{...newFile,capturedAt:'2026-09-12T00:00:00Z'}],note:'没有内容变化',now},source),/未变化/)
})
test('文件 API 核对会话与原始字节摘要，异步切换与篡改响应不得进入草稿',async()=>{
  let active=true,respond:(value:unknown)=>void=()=>{}
  const signal=new AbortController().signal,api=createArtifactFileApi(()=>new Promise(resolve=>{respond=resolve}),()=>{if(!active)throw Error('会话已切换')})
  const pending=api.read('s1','out/result.txt',signal);active=false;respond(file());await assert.rejects(pending,/切换/)
  active=true
  const good=api.read('s1','out/result.txt',signal);respond(file());assert.deepEqual(await good,file())
  const tampered=api.read('s1','out/result.txt',signal);respond({...file(),sha256:'b'.repeat(64)});await assert.rejects(tampered,/校验失败/)
  const wrong=api.read('s1','out/result.txt',signal);respond({...file(),path:'different.txt'});await assert.rejects(wrong,/路径不一致/)
  assert.equal(fileText(fileBytes(file())),'old\r\n');assert.equal(fileText(Uint8Array.from([0,255])),null)
})
test('只有文件也可保存工作稿，保留真实文件快照且不给任务或外部系统写权限',()=>{
  const state=emptyTaskPreview(),conversation={id:'s1',title:'文件工作',scope:'general',bindingId:'binding'},ref={kind:'session' as const,id:'s1'}
  const next=changeArtifactWork(state,{type:'create',id:'a1',source:ref,expectedSource:sourceStamp(resolveArtifactSource(state,ref,conversation)),title:'纯文件产物',body:'',files:[file()],now},conversation)
  assert.deepEqual(next.artifacts[0]!.versions[0]!.files,[file()]);assert.deepEqual(next.tasks,state.tasks)
  assert.match(next.artifacts[0]!.versions[0]!.sections[0]!.text,/out\/result.txt/)
})

import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
import {createArtifactApi} from '../src/client/artifact-api.ts'
import {artifactMarkdown,type Artifact} from '../src/client/artifact-preview.ts'
import type {ArtifactFile} from '../src/client/artifact-files.ts'
import {projectConversationOverviewArtifacts,loadConversationOverviewArtifacts,conversationOverviewArtifactDownload,conversationOverviewFileReference} from '../src/client/conversation-overview-artifacts.ts'
// @ts-expect-error 复用既有无头浏览器加载器。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'

const id='12345678-1234-4234-8234-123456789012',at='2026-10-07T13:00:00Z',t=(key:any,params?:any)=>key+JSON.stringify(params??{})
const file=(content:string|Uint8Array,path='output/report.md'):ArtifactFile=>{const bytes=typeof content==='string'?Buffer.from(content):Buffer.from(content);return {schema:'teloa.file-snapshot/v1',sessionId:'source',id:createHash('sha256').update(path).digest('hex'),path,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,capturedAt:at,contentBase64:bytes.toString('base64')}}
function artifact():Artifact{return {id,source:{kind:'session',id:'source'},storage:'persistent',primary:false,links:[],feedback:[],versions:[1,2].map(number=>({number,title:'交付报告',sections:[{id:'body',title:'正文',text:number===1?'旧版结论':'新版结论'}],source:{ref:{kind:'session',id:'source'},title:'来源会话',scope:'general',version:'binding',author:'本人',private:true,evidence:[]},note:'明确保存',author:'本人',at,files:[file(number===1?'# 旧版文件\n\n| 风险 | 负责人 |\n| --- | --- |\n| 延迟 | 甲 |':'# 新版文件')]}))}}

test('真实注册成果全部版本与文件快照各有稳定身份，旧版预览和下载不被新内容替换',()=>{
 const input=artifact(),projection=projectConversationOverviewArtifacts('source',[input],t)
 assert.equal(projection.rows.length,4)
 assert.equal(projection.rows.filter(row=>row.isHistorical).length,2)
 const oldFile=[...projection.references.values()].find(ref=>ref.kind==='file'&&ref.version===1)!
 assert.equal(oldFile.sessionId,'source');assert.equal(oldFile.row.version,'v1');assert.equal(oldFile.row.isHistorical,true)
 assert.equal(new TextDecoder().decode(conversationOverviewArtifactDownload(oldFile).bytes),'# 旧版文件\n\n| 风险 | 负责人 |\n| --- | --- |\n| 延迟 | 甲 |')
 const oldMarkdown=[...projection.references.values()].find(ref=>ref.kind==='markdown'&&ref.version===1)!
 assert.equal(new TextDecoder().decode(conversationOverviewArtifactDownload(oldMarkdown).bytes),artifactMarkdown(input,1,t))
 input.versions[0]!.files![0]!.contentBase64=Buffer.from('后来覆盖的原文件').toString('base64');input.versions[0]!.sections[0]!.text='后来修改的正文'
 assert.match(new TextDecoder().decode(conversationOverviewArtifactDownload(oldFile).bytes),/^# 旧版文件/)
 assert.match(new TextDecoder().decode(conversationOverviewArtifactDownload(oldMarkdown).bytes),/旧版结论/)
 assert.doesNotMatch(new TextDecoder().decode(conversationOverviewArtifactDownload(oldMarkdown).bytes),/后来修改/)
 const reordered=artifact();reordered.versions.reverse()
 assert.deepEqual(projectConversationOverviewArtifacts('source',[reordered],t).rows.map(row=>row.id).sort(),projection.rows.map(row=>row.id).sort())
})

test('注册成果转换拒绝跨会话来源和文件；未保存的预览草稿不进入概览',()=>{
 const input=artifact();assert.throws(()=>projectConversationOverviewArtifacts('other',[input],t),error=>(error as any).code==='teloa/forbidden')
 input.versions[0]!.files![0]!.sessionId='other';assert.throws(()=>projectConversationOverviewArtifacts('source',[input],t),error=>(error as any).code==='teloa/forbidden')
 const preview=artifact();delete preview.storage
 assert.equal(projectConversationOverviewArtifacts('source',[preview],t).rows.length,0)
})

test('按真实ArtifactApi.list读取注册版本和快照，原文件已移动也不重新读取当前文件',async()=>{
 const input=artifact(),source={kind:'session',id:'source',scope:'general',version:'binding',title:'来源会话'}
 const versions=input.versions.map(version=>({artifactId:id,ownerId:'owner',number:version.number,source,content:{title:version.title,sections:version.sections,note:version.note,snapshotIds:[String(version.number).repeat(64)]},createdAt:at})),calls:string[]=[]
 const api=createArtifactApi(async(method,payload:any)=>{calls.push(method);if(method==='artifacts/list')return [versions.at(-1)];if(method==='artifacts/versions')return versions;if(method==='artifacts/snapshot')return input.versions[Number(payload.snapshotId[0])-1]!.files![0];if(method==='artifacts/feedback/list')return [];throw Error('原文件不可用，不得调用 '+method)})
 const projection=await loadConversationOverviewArtifacts(api,'source',t)
 assert.equal(projection.rows.length,4)
 const old=[...projection.references.values()].find(ref=>ref.kind==='file'&&ref.version===1)!
 assert.match(new TextDecoder().decode(conversationOverviewArtifactDownload(old).bytes),/^# 旧版文件/)
 assert.equal(calls.filter(method=>method==='artifacts/snapshot').length,2)
 assert.equal(calls.some(method=>method.startsWith('artifacts/files/')),false)
})

test('显式交付文件只接受同来源和路径的授权快照，预览下载保留捕获内容且不伪造注册版本',()=>{
 const captured=file('# 已捕获的交付文件'),row={id:'presented:one',sessionId:'source',path:'output/report.md',label:'report.md',kind:'Markdown',status:'unknown' as const}
 const reference=conversationOverviewFileReference(row,captured)
 assert.equal(reference.kind,'file');assert.equal(reference.artifactId,undefined);assert.equal(reference.version,undefined);assert.equal(reference.row.isHistorical,undefined)
 assert.deepEqual(reference.source,{kind:'session',id:'source'})
 captured.contentBase64=Buffer.from('后来的原文件').toString('base64')
 assert.equal(new TextDecoder().decode(conversationOverviewArtifactDownload(reference).bytes),'# 已捕获的交付文件')
 assert.throws(()=>conversationOverviewFileReference({...row,sessionId:'other'},file('x')),error=>(error as any).code==='teloa/forbidden')
 assert.throws(()=>conversationOverviewFileReference({...row,path:'output/other.md'},file('x')),error=>(error as any).code==='teloa/forbidden')
})

test('只读预览排版同版Markdown并禁用远程图片，HTML不执行，下载仍是所选快照',async testContext=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url)),temp=await mkdtemp(join(root,'.runtime-overview-artifact-preview-'))
 testContext.after(()=>rm(temp,{recursive:true,force:true}))
 const entry=`import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';import {ConversationOverviewArtifactPreview} from '${client}ConversationOverviewArtifactPreview.tsx';import {projectConversationOverviewArtifacts,conversationOverviewArtifactDownload} from '${client}conversation-overview-artifacts.ts';import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';const view=createRoot(document.getElementById('root')),snapshot={locale:'zh-CN',dshLocale:'zh-CN',revision:1},runtime={t:(key,params)=>translateMessage('zh-CN',key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};window.previewFixture={calls:[],mount:(artifact,version,kind)=>{const projection=projectConversationOverviewArtifacts('source',[artifact],runtime.t),reference=[...projection.references.values()].find(item=>item.version===version&&item.kind===kind);flushSync(()=>view.render(<I18nProvider runtime={runtime}><ConversationOverviewArtifactPreview reference={reference} onBack={()=>window.previewFixture.calls.push('back')} onDownload={ref=>{const download=conversationOverviewArtifactDownload(ref);window.previewFixture.calls.push({id:ref.row.id,version:ref.version,sessionId:ref.sessionId,text:new TextDecoder().decode(download.bytes),bytes:Array.from(download.bytes)})}}/></I18nProvider>))}};`
 await writeFile(join(temp,'fixture.tsx'),entry)
 const result=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'OverviewArtifactPreviewFixture',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 const script=bundle.output.find(item=>item.type==='chunk')!.code,styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 const browser=await loadPlaywright().chromium.launch(launchOptions());testContext.after(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1024,height:768}}),errors:string[]=[],requests:string[]=[]
 testContext.after(async()=>{await page.close();assert.deepEqual(errors,[]);assert.deepEqual(requests,[])})
 page.on('pageerror',(error:Error)=>errors.push(error.message));await page.route('**/*',(route:any)=>{requests.push(route.request().url());return route.abort()})
 await page.setContent('<!doctype html><html lang="zh-CN"><body><main id="root" style="width:380px;height:600px"></main></body></html>');await page.addStyleTag({content:styles});await page.addScriptTag({content:script})
 const input=artifact();input.versions[0]!.files=[file('# 旧版文件\n\n| 风险 | 负责人 |\n| --- | --- |\n| 延迟 | 甲 |\n\n![禁用的远程图片](https://example.test/beacon.png)')]
 await page.evaluate((input:any)=>(window as any).previewFixture.mount(input,1,'file'),input)
 assert.equal(await page.getByRole('heading',{name:'旧版文件',exact:true}).count(),1)
 assert.deepEqual(await page.locator('table th').allTextContents(),['风险','负责人'])
 assert.equal(await page.locator('img').count(),0)
 await page.getByRole('button',{name:'源文本',exact:true}).click();assert.match(await page.locator('pre').innerText(),/^# 旧版文件/)
 await page.getByRole('button',{name:'下载',exact:true}).click()
 assert.equal((await page.evaluate(()=>(window as any).previewFixture.calls))[0].text,new TextDecoder().decode(Buffer.from(input.versions[0]!.files![0]!.contentBase64,'base64')))
 const html='<html><script>window.executed=true</script><img src="https://example.test/html.png" onerror="window.executed=true"></html>'
 input.versions[0]!.files=[file(html,'output/active.html')]
 await page.evaluate((input:any)=>(window as any).previewFixture.mount(input,1,'file'),input)
 assert.equal(await page.locator('iframe,object,embed,img').count(),0)
 assert.equal(await page.evaluate(()=>(window as any).executed),undefined)
 await page.getByRole('button',{name:'源文本',exact:true}).click();assert.equal(await page.locator('pre').innerText(),html)
 await page.getByRole('button',{name:'下载',exact:true}).click()
 const last=(await page.evaluate(()=>(window as any).previewFixture.calls)).at(-1);assert.equal(last.text,html);assert.equal(last.version,1);assert.equal(last.sessionId,'source')
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhXcAAAAASUVORK5CYII=','base64')
 input.versions[0]!.files=[file(png,'output/pixel.png')]
 await page.evaluate((input:any)=>(window as any).previewFixture.mount(input,1,'file'),input)
 await page.waitForFunction(()=>{const image=document.querySelector('img');return image?.complete&&image.naturalWidth===1})
 assert.match(await page.locator('img').getAttribute('src'),/^blob:/)
 await page.getByRole('button',{name:'下载',exact:true}).click()
 assert.deepEqual((await page.evaluate(()=>(window as any).previewFixture.calls)).at(-1).bytes,Array.from(png))
 await page.getByRole('button',{name:'返回工作概览',exact:true}).click();assert.equal((await page.evaluate(()=>(window as any).previewFixture.calls)).at(-1),'back')
})

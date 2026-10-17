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
import {projectConversationOverviewArtifacts,loadConversationOverviewArtifacts,conversationOverviewArtifactDownload,conversationOverviewFileReference,saveConversationOverviewFile} from '../src/client/conversation-overview-artifacts.ts'
// @ts-expect-error 复用既有无头浏览器加载器。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'

const id='12345678-1234-4234-8234-123456789012',at='2026-10-07T13:00:00Z',t=(key:any,params?:any)=>key+JSON.stringify(params??{})
const file=(content:string|Uint8Array,path='output/report.md'):ArtifactFile=>{const bytes=typeof content==='string'?Buffer.from(content):Buffer.from(content);return {schema:'teloa.file-snapshot/v1',sessionId:'source',id:createHash('sha256').update(path).digest('hex'),path,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,capturedAt:at,contentBase64:bytes.toString('base64')}}
function artifact():Artifact{return {id,source:{kind:'session',id:'source'},storage:'persistent',primary:false,links:[],feedback:[],versions:[1,2].map(number=>({number,title:'交付报告',sections:[{id:'body',title:'正文',text:number===1?'旧版结论':'新版结论'}],source:{ref:{kind:'session',id:'source'},title:'来源会话',scope:'general',version:'binding',author:'本人',private:true,evidence:[]},note:'明确保存',author:'本人',at,files:[file(number===1?'# 旧版文件\n\n| 风险 | 负责人 |\n| --- | --- |\n| 延迟 | 甲 |':'# 新版文件')]}))}}

test('预览收存复用真实成果API未知请求，重载沿原UUID恢复；已有同文件版本不重复创建，切来源不派发保存',async()=>{
 const snapshot=file('# 原快照'),source={ref:{kind:'session' as const,id:'source'},title:'来源会话',scope:'general',version:'binding',author:'本人',evidence:[],private:true},savedSource={kind:'session',id:'source',title:source.title,scope:source.scope,version:source.version}
 let journal='',saved:any,loseResponse=true,current=true
 const calls:{method:string;payload:any}[]=[],wire=async(method:string,payload:any):Promise<unknown>=>{
  calls.push({method,payload:structuredClone(payload)})
  if(method==='artifacts/list')return saved?[saved]:[]
  if(method==='artifacts/source')return savedSource
  if(method==='artifacts/capture')return {snapshotId:'a'.repeat(64),file:snapshot}
  if(method==='artifacts/create'){saved??={artifactId:id,ownerId:'owner',number:1,source:payload.source,content:payload.content,createdAt:at};if(loseResponse){loseResponse=false;throw Error('已发送，回执未知')}return saved}
  if(method==='artifacts/versions')return [saved]
  if(method==='artifacts/snapshot')return snapshot
  if(method==='artifacts/feedback/list')return []
  throw Error('未声明端口 '+method)
 }
 const storage={read:()=>journal,write:(value:string)=>{journal=value},clear:()=>{journal=''}}
 const api=createArtifactApi(wire,storage)
 await assert.rejects(saveConversationOverviewFile(api,source,snapshot,()=>current),/回执未知/)
 const original=JSON.parse(journal).requests[0].requestId
 const resumed=createArtifactApi(wire,storage),result=await saveConversationOverviewFile(resumed,source,snapshot,()=>current)
 assert.deepEqual({id:result.id,version:result.version},{id,version:1})
 assert.deepEqual(calls.filter(row=>row.method==='artifacts/create').map(row=>row.payload.requestId),[original,original])
 assert.equal(calls.filter(row=>row.method==='artifacts/capture').length,1)
 assert.equal(journal,'')
 assert.deepEqual(result.artifact.versions[0]!.files,[snapshot])
 const again=await saveConversationOverviewFile(resumed,source,snapshot,()=>current)
 assert.deepEqual({id:again.id,version:again.version},{id,version:1})
 assert.equal(calls.filter(row=>row.method==='artifacts/create').length,2,'已有相同快照仅打开原版本，不再创建')
 const before=calls.length;current=false
 await assert.rejects(saveConversationOverviewFile(resumed,source,snapshot,()=>current),error=>(error as any).code==='teloa/source-unavailable')
 assert.equal(calls.length,before,'切来源后不读取或保存')
 let finish!:()=>void
 const delayed={...resumed,list:()=>new Promise<Artifact[]>(resolve=>{finish=()=>resolve([])})};current=true
 const pending=saveConversationOverviewFile(delayed,source,snapshot,()=>current);current=false;finish()
 await assert.rejects(pending,error=>(error as any).code==='teloa/source-unavailable')
 assert.equal(calls.length,before,'读取目录期间切来源，不能继续派发保存')
})

test('同会话另有未决反馈时仍先查已有文件版本，不创建副本且不清原反馈journal',async()=>{
 const original=artifact(),snapshot=original.versions.at(-1)!.files![0]!,source=original.versions[0]!.source,savedSource={kind:'session',id:'source',title:source.title,scope:source.scope,version:source.version}
 const versions=original.versions.map(version=>({artifactId:id,ownerId:'owner',number:version.number,source:savedSource,content:{title:version.title,sections:version.sections,note:version.note,snapshotIds:[String(version.number).repeat(64)]},createdAt:at}))
 const calls:{method:string;payload:any}[]=[];let journal='',duplicate:any
 const api=createArtifactApi(async(method,payload:any)=>{
  calls.push({method,payload:structuredClone(payload)})
  if(method==='artifacts/feedback/add')throw Error('反馈回执未知')
  if(method==='artifacts/list')return [versions.at(-1)]
  if(method==='artifacts/versions')return payload.artifactId===id?versions:[duplicate]
  if(method==='artifacts/snapshot')return snapshot
  if(method==='artifacts/feedback/list')return []
  if(method==='artifacts/source')return savedSource
  if(method==='artifacts/capture')return {snapshotId:'c'.repeat(64),file:snapshot}
  if(method==='artifacts/create'){duplicate={artifactId:'22345678-1234-4234-8234-123456789012',ownerId:'owner',number:1,source:payload.source,content:payload.content,createdAt:at};return duplicate}
  throw Error('未声明端口 '+method)
 },{read:()=>journal,write:value=>{journal=value},clear:()=>{journal=''}})
 await assert.rejects(api.feedback(original,1,'body','保留原反馈'),/反馈回执未知/)
 const pending=journal,result=await saveConversationOverviewFile(api,source,snapshot,()=>true)
 assert.deepEqual({id:result.id,version:result.version},{id,version:2},'另一个未决反馈不能让已有同文件版本被重复创建')
 assert.equal(calls.filter(row=>row.method==='artifacts/create').length,0)
 assert.equal(calls.filter(row=>row.method==='artifacts/capture').length,0)
 assert.equal(journal,pending,'原反馈UUID、payload及journal逐字保留')
 assert.deepEqual(api.pendingFor('source').map(row=>row.key),['feedback:'+id+':1:body'])
})

test('成果标题已有Markdown后缀时预览保留名称，不再追加第二个后缀',()=>{
 for(const title of ['交付报告.md','交付报告.MD','交付报告.markdown']){
  const input=artifact();for(const version of input.versions)version.title=title
  const projection=projectConversationOverviewArtifacts('source',[input],t)
  assert.ok(projection.rows.filter(row=>row.path.startsWith('teloa-')).every(row=>row.label===title))
 }
})

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

test('按正式会话成果目录读取注册版本和快照，原文件已移动也不重新读取当前文件',async()=>{
 const input=artifact(),source={kind:'session',id:'source',scope:'general',version:'binding',title:'来源会话'}
 const versions=input.versions.map(version=>({artifactId:id,ownerId:'owner',number:version.number,source,content:{title:version.title,sections:version.sections,note:version.note,snapshotIds:[String(version.number).repeat(64)]},createdAt:at})),calls:string[]=[]
 const api=createArtifactApi(async(method,payload:any)=>{calls.push(method);if(method==='artifacts/conversation/list')return {sessionId:'source',artifacts:[versions.at(-1)]};if(method==='artifacts/versions')return versions;if(method==='artifacts/snapshot')return input.versions[Number(payload.snapshotId[0])-1]!.files![0];if(method==='artifacts/feedback/list')return [];throw Error('原文件不可用，不得调用 '+method)})
 const projection=await loadConversationOverviewArtifacts(api,'source',t)
 assert.equal(projection.rows.length,4)
 const old=[...projection.references.values()].find(ref=>ref.kind==='file'&&ref.version===1)!
 assert.match(new TextDecoder().decode(conversationOverviewArtifactDownload(old).bytes),/^# 旧版文件/)
 assert.equal(calls.filter(method=>method==='artifacts/snapshot').length,2)
 assert.equal(calls.some(method=>method.startsWith('artifacts/files/')),false)
})

test('会话侧栏读取关联任务的最新已关联版本，保留原归属与历史快照，不提升到别处的新版本',async()=>{
 const source={kind:'task',id:'22345678-1234-4234-8234-123456789012',scope:'general',version:'v1',title:'原任务'}
 const versions=[1,2,3,4,5].map(number=>({artifactId:id,ownerId:'owner',number,source,content:{title:'周会行动单',sections:[{id:'body',title:'正文',text:'版本 '+number}],snapshotIds:[],note:'固定版本'},createdAt:at}))
 const calls:{method:string;payload:any}[]=[]
 let visibleVersion=4
 const api=createArtifactApi(async(method,payload:any)=>{
  calls.push({method,payload})
  if(method==='artifacts/conversation/list')return {sessionId:payload.sessionId,artifacts:[versions[visibleVersion-1]]}
  if(method==='artifacts/versions')return versions
  if(method==='artifacts/feedback/list')return []
  if(method==='artifacts/revision/list')return []
  throw Error('不允许额外读取 '+method)
 })
 const projection=await loadConversationOverviewArtifacts(api,'revision-chat',t)
 assert.equal(projection.rows.length,4)
 const latest=projection.rows.find(row=>!row.isHistorical)!
 assert.equal(latest.version,'v4');assert.equal(latest.sessionId,'revision-chat')
 const reference=projection.references.get(latest.id)!
 assert.deepEqual(reference.source,{kind:'task',id:source.id})
 assert.equal(reference.sessionId,'revision-chat')
 assert.match(new TextDecoder().decode(conversationOverviewArtifactDownload(reference).bytes),/版本 4/)
 const old=[...projection.references.values()].find(reference=>reference.version===1)!
 assert.match(new TextDecoder().decode(conversationOverviewArtifactDownload(old).bytes),/版本 1/)
 visibleVersion=2
 const other=await loadConversationOverviewArtifacts(api,'other-chat',t)
 assert.deepEqual(other.rows.map(row=>row.version),['v2','v1'],'目录只关联v2时不能泄漏同成果后续私有v3-v5')
 assert.ok(other.rows.every(row=>row.sessionId==='other-chat'))
 assert.equal(reference.row.version,'v4','切会话不改旧快照')
 assert.ok(calls.every(call=>['artifacts/conversation/list','artifacts/versions','artifacts/feedback/list','artifacts/revision/list'].includes(call.method)))
})

test('会话成果目录拒绝错会话、重复成果及来源不一致，不把读取失败当空目录',async()=>{
 const input=artifact(),version=input.versions[0]!,source={kind:'session',id:'source',scope:'general',version:'binding',title:'原会话'}
 const row={artifactId:id,ownerId:'owner',number:1,source,content:{title:version.title,sections:version.sections,snapshotIds:[],note:version.note},createdAt:at}
 for(const response of [{sessionId:'other',artifacts:[row]},{sessionId:'source',artifacts:[row,row]},{sessionId:'source',artifacts:[{...row,source:{...source,id:'other'}}]}]){
  const api=createArtifactApi(async method=>{assert.equal(method,'artifacts/conversation/list');return response})
  await assert.rejects(loadConversationOverviewArtifacts(api,'source',t),/不一致/)
 }
 const api=createArtifactApi(async()=>{throw Object.assign(Error('关联已失效'),{code:'teloa/forbidden'})})
 await assert.rejects(loadConversationOverviewArtifacts(api,'source',t),/关联已失效/)
})

test('会话目录在装载前截断未来版本，不读取未来文件、消息、反馈或续改',async()=>{
 const source={kind:'task',id:'22345678-1234-4234-8234-123456789012',scope:'general',version:'v1',title:'原任务'}
 const versions=[1,2,3,4,5].map(number=>({artifactId:id,ownerId:'owner',number,source,content:{title:'任务成果',sections:[{id:'body',title:'正文',text:'版本 '+number}],snapshotIds:[String(number).repeat(64)],...(number===5?{messageSnapshotIds:['f'.repeat(64)]}:{}),note:'固定版本'},createdAt:at}))
 const calls:{method:string;payload:any}[]=[]
 const api=createArtifactApi(async(method,payload:any)=>{
  calls.push({method,payload})
  if(method==='artifacts/conversation/list')return {sessionId:'revision-chat',artifacts:[versions[3]]}
  if(method==='artifacts/versions')return versions
  if(method==='artifacts/snapshot'&&payload.snapshotId!=='5'.repeat(64))return {...file('固定文件 '+payload.snapshotId[0]),sessionId:'original-worker-chat'}
  throw Error('不应读取未关联的未来内容或概览无关的目录：'+method)
 })
 const artifacts=await api.conversation('revision-chat')
 assert.deepEqual(artifacts[0]!.versions.map(version=>version.number),[1,2,3,4])
 assert.deepEqual(artifacts[0]!.feedback,[])
 assert.equal(artifacts[0]!.revisions,undefined)
 assert.deepEqual(calls.map(call=>call.method),['artifacts/conversation/list','artifacts/versions',...Array(4).fill('artifacts/snapshot')])
 const projected=await loadConversationOverviewArtifacts(api,'revision-chat',t)
 const reference=[...projected.references.values()].find(ref=>ref.kind==='file'&&ref.version===4)!
 assert.equal(reference.sessionId,'revision-chat')
 assert.deepEqual(reference.source,{kind:'task',id:source.id})
 assert.equal(reference.kind==='file'&&reference.file.sessionId,'original-worker-chat')
 assert.equal(new TextDecoder().decode(conversationOverviewArtifactDownload(reference).bytes),'固定文件 4')
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

test('共享只读版本投影接受原task身份，旧session入口仍严格拒绝task与其他session',async()=>{
 const {projectRegisteredArtifactVersions}=await import('../src/client/conversation-overview-artifacts.ts')
 const artifact:Artifact={id:'task-shared',storage:'persistent',source:{kind:'task',id:'original-task'},primary:false,links:[],feedback:[],versions:[{number:2,title:'任务固定稿',sections:[{id:'body',title:'内容',text:'仅共享v2'}],source:{ref:{kind:'task',id:'original-task'},title:'原任务',scope:'general',version:'v1',author:'本人',evidence:[],private:false},note:'固定快照',author:'本人',at:'2026-10-12T00:00:00Z'}]}
 const projected=projectRegisteredArtifactVersions({kind:'task',id:'original-task'},[artifact],t)
 assert.equal(projected.rows.length,1);assert.equal([...projected.references.values()][0]!.source.kind,'task')
 assert.equal([...projected.references.values()][0]!.version,2)
 assert.throws(()=>projectConversationOverviewArtifacts('original-task',[artifact],t),error=>(error as {code:string}).code==='teloa/forbidden')
 assert.throws(()=>projectRegisteredArtifactVersions({kind:'session',id:'original-task'},[artifact],t),error=>(error as {code:string}).code==='teloa/forbidden')
})

import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 复用现有无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

for(const initialAction of ['prepare',undefined] as const)test(initialAction==='prepare'?'任务最终报告超过40个空行段落仍可从原生消息保存并回读完整成果':'首次零成果默认列表态选择原生报告后，创建底栏可见并完整保存',async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
 const temp=await mkdtemp(join(root,'.runtime-artifact-long-report-'));t.after(()=>rm(temp,{recursive:true,force:true}))
 const report=Array.from({length:67},(_,index)=>`${index%10===0?'## 第'+(Math.floor(index/10)+1)+'部分\n':''}证据段落 ${index+1}：保留原始字段、时间与判定依据。`).join('\n\n')
 await writeFile(join(temp,'fixture.tsx'),`
 import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
 import {ArtifactPanel} from ${JSON.stringify(join(client,'ArtifactPanel.tsx'))};
 import {emptyTaskPreview,changeTaskPreview} from ${JSON.stringify(join(client,'task-preview.ts'))};
 import {changeArtifactWork} from ${JSON.stringify(join(client,'artifact-work.ts'))};
 import {createArtifactApi} from ${JSON.stringify(join(client,'artifact-api.ts'))};
 import {artifactContent} from ${JSON.stringify(join(root,'packages/contract/src/artifacts.ts'))};
 import {savedArtifactMessage} from ${JSON.stringify(join(root,'packages/contract/src/artifact-messages.ts'))};
 import {I18nProvider} from ${JSON.stringify(join(client,'i18n/provider.tsx'))};
 import {translateMessage} from ${JSON.stringify(join(client,'i18n/messages.ts'))};
 const locale='zh-CN',snapshot={locale,dshLocale:'zh',revision:1},runtime={t:(key,params)=>translateMessage(locale,key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};
 const now='2026-10-28T14:30:14.561Z',taskId='10000000-0000-4000-8000-000000000001',sessionId='task-run-original',artifactId='12345678-1234-4234-8234-123456789012',source={kind:'task',id:taskId},calls=[];
 const initial=changeTaskPreview(emptyTaskPreview(),{type:'create',id:taskId,title:'七段完整调查报告',goal:'固定告警只读调查',scope:'general',now});initial.tasks[0].storage='persistent';
 const report=${JSON.stringify(report)},message={sessionId,messageId:'original-final-report',seq:62,role:'assistant',at:now,text:report,images:[],interrupted:false,omittedBlocks:0};
 const run={id:'10000000-0000-4000-8000-000000000002',taskId,sessionId,nativeRequestId:'original-request',state:'ended',reason:'completed',stopRequestedAt:null,taskVersion:1,roleVersion:1,goal:'只读调查',roleName:'T1 安全运营分析工程师',createdAt:now,skills:[],knowledge:[]};
 const native={read:async()=>({sessionId,items:[{...message,messageId:'earlier-progress',seq:60,text:'前期调查进度'},message],nextBeforeSeq:null}),imageUrl:async()=>{throw Error('无图片')}};
 const taskRuns={list:async()=>[run],chatPresentation:async()=>({...run,runId:run.id})},taskSources={list:async()=>[{id:sessionId,title:'本轮原生会话'}],open:async()=>{}};
 const fixedSource={kind:'task',id:taskId,scope:'general',version:'1 · '+now,title:'七段完整调查报告'};let saved;
 const api=createArtifactApi(async(method,payload)=>{calls.push({method,payload});
  if(method==='artifacts/task/source')return fixedSource;
  if(method==='artifacts/task/sessions')return [sessionId];
  if(method==='artifacts/message/capture'){if(JSON.stringify(savedArtifactMessage(payload.message))!==JSON.stringify(savedArtifactMessage(message)))throw Error('原消息不一致');return {snapshotId:'a'.repeat(64),message}}
  if(method==='artifacts/create'){const content=artifactContent(payload.content);if(JSON.stringify(payload.source)!==JSON.stringify(fixedSource))throw Error('来源不一致');saved={artifactId,ownerId:'owner',number:1,source:fixedSource,content,createdAt:now};return saved}
  if(method==='artifacts/versions')return [saved];if(method==='artifacts/message/snapshot')return message;if(method==='artifacts/feedback/list')return [];throw Error(method)
 });
 window.longReportFixture={calls,getSaved:()=>saved};
 function App(){const [state,setState]=useState(initial);return <main><aside style={{width:'min(620px,100%)',height:'100dvh'}}><ArtifactPanel inline open target={{source${initialAction?",initialAction:'prepare'":''}}} state={state} conversation={undefined} taskSources={taskSources} taskRuns={taskRuns} nativeArtifacts={native} artifactFileApi={{}} close={()=>{}} openSource={()=>{}} openTask={()=>{}} change={async command=>{const next=changeArtifactWork(state,command),candidate=next.artifacts.at(-1),stored=await api.save(candidate,true);setState({...next,artifacts:[stored]});return stored.id}}/></aside></main>}
 createRoot(document.getElementById('root')).render(<I18nProvider runtime={runtime}><App/></I18nProvider>);
 `)
 const built=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'ArtifactLongReportTest',formats:['iife']}}})
 const bundle=Array.isArray(built)?built[0]:built;assert.ok(bundle&&'output'in bundle)
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1440,height:1000}});t.after(()=>page.close());page.setDefaultTimeout(5000)
 const errors:string[]=[],requests:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));await page.route('**/*',(route:any)=>{requests.push(route.request().url());return route.abort()})
 await page.setContent('<!doctype html><html lang="zh-CN"><body style="margin:0"><div id="root"></div></body></html>');await page.addStyleTag({content:bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')});await page.addScriptTag({content:bundle.output.find(item=>item.type==='chunk')!.code})
 // about:blank 不提供安全上下文 UUID；只为离线夹具补齐浏览器入口依赖。
 await page.evaluate(()=>{let id=0;if(!crypto.randomUUID)Object.assign(crypto,{randomUUID:()=>`00000000-0000-4000-8000-${String(++id).padStart(12,'0')}`})})
 const panel=page.getByRole('dialog',{name:'工作成果',exact:true})
 await panel.getByRole('button',{name:/引用消息与图片.*T1.*第1部分/}).click()
 const save=panel.getByRole('button',{name:'保存工作成果',exact:true}),download=panel.getByRole('link',{name:'下载',exact:true}),content=panel.locator('article').first()
 for(const [width,height] of [[1280,720],[1920,1080],[2560,1440],[3840,2160],[720,900],[1080,800]]){
  await page.setViewportSize({width:width!,height:height!})
  await page.waitForFunction((modal:boolean)=>document.querySelector('dialog')?.matches(':modal')===modal,width!<=760)
  await content.evaluate((node:HTMLElement)=>{node.scrollTop=0})
  const bounds=await panel.boundingBox(),before=await save.boundingBox(),link=await download.boundingBox()
  assert.ok(bounds&&before&&link)
  assert.ok(before.y>=bounds.y&&before.y+before.height<=Math.min(height!,bounds.y+bounds.height)+1,'长正文未滚动时保存操作可见')
  assert.ok(link.y>=bounds.y&&link.y+link.height<=Math.min(height!,bounds.y+bounds.height)+1,'下载操作可见')
  assert.ok((await save.innerText()).includes('保存工作成果'),'操作有可读文本')
  assert.equal(await panel.evaluate((node:HTMLElement)=>node.matches(':modal')),width!<=760)
  assert.equal(await panel.locator('[data-artifact-expand]').isVisible(),width!>760,'窄屏已全窗，不提供反向缩小的放大控件')
  await content.evaluate((node:HTMLElement)=>{node.scrollTop=node.scrollHeight})
  const after=await save.boundingBox();assert.ok(after);assert.ok(Math.abs(after.y-before.y)<1,'操作占独立轨道，正文滚动不遮挡底栏')
  assert.equal(await panel.evaluate((node:HTMLElement)=>node.scrollWidth<=node.clientWidth+1),true)
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
 }
 assert.equal(decodeURIComponent((await download.getAttribute('href'))!).split(',').slice(1).join(','),report)
 await save.click()
 await panel.getByRole('button',{name:'版本与反馈',exact:true}).waitFor()
 const saved=await page.evaluate(()=>(window as any).longReportFixture.getSaved())
 assert.ok(saved.content.sections.length<=40);assert.equal(saved.content.sections.map((section:{text:string})=>section.text).join('\n\n'),report)
 assert.deepEqual(saved.content.messageSnapshotIds,['a'.repeat(64)])
 const calls=await page.evaluate(()=>(window as any).longReportFixture.calls)
 assert.equal(calls.filter((call:{method:string})=>call.method==='artifacts/create').length,1)
 assert.equal(calls.find((call:{method:string})=>call.method==='artifacts/message/capture').payload.message.messageId,'original-final-report')
 assert.equal(calls.find((call:{method:string})=>call.method==='artifacts/message/capture').payload.message.role,'assistant')
 assert.equal(await panel.getByRole('alert').count(),0)
 assert.deepEqual(errors,[]);assert.deepEqual(requests,[])
})

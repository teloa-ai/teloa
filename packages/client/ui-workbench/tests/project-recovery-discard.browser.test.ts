import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp,rm,writeFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 既有无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

test('项目与个人恢复入口实际丢弃仅清本地请求，关闭和存储失败都保留草稿与其他项目',async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
 const temp=await mkdtemp(join(root,'.runtime-project-recovery-'));t.after(()=>rm(temp,{recursive:true,force:true}))
 await writeFile(join(temp,'fixture.tsx'),`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {ProjectRuntimePanel,ProjectConversations} from ${JSON.stringify(join(client,'ProjectRuntimePanel.tsx'))};import {ProjectPersonalPreferences} from ${JSON.stringify(join(client,'ProjectPersonalPreferences.tsx'))};import {createProjectRuntimeApi} from ${JSON.stringify(join(client,'project-runtime-api.ts'))};import {I18nProvider} from ${JSON.stringify(join(client,'i18n/provider.tsx'))};import {translateMessage} from ${JSON.stringify(join(client,'i18n/messages.ts'))};
 const projectId='10000000-0000-4000-8000-000000000001',otherId='10000000-0000-4000-8000-000000000002',project={id:projectId,scope:'general',title:'原项目',state:'running'};let stored=null,writable=true;const calls=[];
 const settings={projectId,version:0,automatic:'paused',readPersonal:false,resources:[]},otherSettings={...settings,projectId:otherId},personalDraft={expectedVersion:0,entryId:null,topic:'回答方式',markdown:'保留未提交内容'};
 const runtime=createProjectRuntimeApi(async(endpoint,input)=>{calls.push(endpoint);if(endpoint==='project-runtime/configure')throw Error('lost receipt');if(endpoint==='project-runtime/settings')return settings;if(endpoint==='project-runtime/personal')return {version:0,entries:[]};if(['project-runtime/candidates','project-runtime/uses','project-runtime/failures','project-runtime/members'].includes(endpoint))return {rows:[]};throw Error(endpoint)},{read:()=>stored,write:value=>{if(writable)stored=value},clear:()=>{if(writable)stored=null}});
 runtime.setDraft(projectId,settings);runtime.setDraft(otherId,otherSettings);runtime.reserveCreation(otherId,'保留原预约','off');runtime.personal.setDraft(personalDraft);
 const api={runtime,candidates:async()=>[]},locale='zh-CN',snapshot={locale,dshLocale:'zh',revision:1},i18n={t:(key,params)=>translateMessage(locale,key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};
 window.fixture={writable:value=>{writable=value},raw:()=>JSON.parse(stored),corrupt:target=>{const raw=JSON.parse(stored);if(target==='project'){raw.pending=raw.pending.filter(row=>row.projectId!==projectId);raw.pending.push({projectId,endpoint:'broken',input:{}})}else raw.personal.pending={endpoint:'broken',input:{}};stored=JSON.stringify(raw)},snapshot:()=>({projectDraft:runtime.draft(projectId),otherDraft:runtime.draft(otherId),otherPending:runtime.pending(otherId),creation:runtime.creation(otherId),personalDraft:runtime.personal.draft(),projectError:!!runtime.recoveryError(),personalError:!!runtime.personal.recoveryError()}),calls};
 function App(){const [mode,setMode]=useState('');return <><button onClick={()=>setMode('project')}>打开项目设置</button><button onClick={()=>setMode('conversations')}>打开项目会话</button><button onClick={()=>setMode('personal')}>打开个人管理</button>{mode==='project'&&<ProjectRuntimePanel project={project} api={api} open/>}{mode==='conversations'&&<ProjectConversations project={project} api={api} actions={{create:async()=>{},open:async()=>{}}}/ >}{mode==='personal'&&<ProjectPersonalPreferences api={runtime}/>}</>}
 (async()=>{try{await runtime.configure(settings)}catch{}try{await runtime.configure(otherSettings)}catch{}calls.length=0;createRoot(document.getElementById('root')).render(<I18nProvider runtime={i18n}><App/></I18nProvider>)})();`)
 const result=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'ProjectRecoveryTest',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 const script=bundle.output.find(item=>item.type==='chunk')!.code,styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1280,height:900}});t.after(()=>page.close());page.setDefaultTimeout(4000)
 const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));await page.route('**/*',(route:any)=>route.request().url()==='http://127.0.0.1/project-recovery-test'?route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="zh-CN"><body><div id="root"></div></body></html>'}):route.abort())
 await page.goto('http://127.0.0.1/project-recovery-test');await page.addStyleTag({content:styles});await page.addScriptTag({content:script});await page.getByRole('button',{name:'打开项目设置',exact:true}).waitFor()
 const initial=await page.evaluate(()=>(window as any).fixture.snapshot()),discard='丢弃这条恢复记录',next='可丢弃这条恢复记录后重试；若上一次请求已经生效，请到对应目录核对。',done='已丢弃本地恢复记录；如果上一次请求已经生效，请到目录里核对。'
 await page.evaluate(()=>(window as any).fixture.corrupt('project'));await page.getByRole('button',{name:'打开项目设置',exact:true}).click()
 assert.ok((await page.getByRole('alert').allTextContents()).some((text:string)=>text.includes(next)))
 assert.equal(await page.getByRole('button',{name:'核对上次操作',exact:true}).isDisabled(),true)
 const before=await page.evaluate(()=>(window as any).fixture.raw());await page.evaluate(()=>(window as any).fixture.writable(false));await page.getByRole('button',{name:discard,exact:true}).click()
 assert.equal(await page.getByText(done,{exact:true}).count(),0,'本地写入失败不能显示已丢弃')
 assert.deepEqual(await page.evaluate(()=>(window as any).fixture.raw()),before)
 assert.ok((await page.getByRole('alert').allTextContents()).some((text:string)=>text.includes('存储服务暂时不可用')))
 await page.evaluate(()=>(window as any).fixture.writable(true));await page.getByRole('button',{name:discard,exact:true}).click();await page.getByText(done,{exact:true}).waitFor()
 assert.equal(await page.getByRole('button',{name:discard,exact:true}).count(),0)
 const after=await page.evaluate(()=>(window as any).fixture.snapshot());assert.equal(after.projectError,false)
 for(const key of ['projectDraft','otherDraft','otherPending','creation','personalDraft'])assert.deepEqual(after[key],initial[key],key+'不能由丢弃当前项目恢复请求清理')
 assert.equal((await page.evaluate(()=>(window as any).fixture.raw())).pending.length,1)
 await page.evaluate(()=>(window as any).fixture.corrupt('project'));await page.getByRole('button',{name:'打开项目会话',exact:true}).click()
 assert.ok((await page.getByRole('alert').allTextContents()).some((text:string)=>text.includes(next)))
 await page.getByRole('button',{name:discard,exact:true}).click();await page.getByText(done,{exact:true}).waitFor()
 assert.deepEqual((await page.evaluate(()=>(window as any).fixture.snapshot())).otherPending,initial.otherPending,'项目会话入口也只清当前项目请求')
 await page.evaluate(()=>(window as any).fixture.corrupt('personal'));await page.getByRole('button',{name:'打开个人管理',exact:true}).click();await page.getByRole('button',{name:'管理个人偏好',exact:true}).click()
 const dialog=page.getByRole('dialog',{name:'个人偏好',exact:true});await dialog.waitFor()
 assert.ok((await dialog.getByRole('alert').allTextContents()).some((text:string)=>text.includes(next)))
 assert.equal(await page.getByLabel('偏好内容',{exact:true}).inputValue(),initial.personalDraft.markdown)
 const personalBefore=await page.evaluate(()=>(window as any).fixture.raw());await page.keyboard.press('Escape');assert.equal(await dialog.count(),0)
 assert.deepEqual(await page.evaluate(()=>(window as any).fixture.raw()),personalBefore,'关闭抽屉不丢弃、不保存')
 await page.getByRole('button',{name:'管理个人偏好',exact:true}).click();await page.evaluate(()=>(window as any).fixture.writable(false));await dialog.getByRole('button',{name:discard,exact:true}).click()
 assert.equal(await dialog.getByText(done,{exact:true}).count(),0);assert.deepEqual(await page.evaluate(()=>(window as any).fixture.raw()),personalBefore)
 await page.evaluate(()=>(window as any).fixture.writable(true));await dialog.getByRole('button',{name:discard,exact:true}).click();await dialog.getByText(done,{exact:true}).waitFor()
 const personalAfter=await page.evaluate(()=>(window as any).fixture.snapshot());assert.equal(personalAfter.personalError,false)
 for(const key of ['projectDraft','otherDraft','otherPending','creation','personalDraft'])assert.deepEqual(personalAfter[key],initial[key],key+'不能由丢弃个人恢复请求清理')
 assert.deepEqual((await page.evaluate(()=>(window as any).fixture.calls)).filter((endpoint:string)=>!['project-runtime/settings','project-runtime/candidates','project-runtime/uses','project-runtime/failures','project-runtime/members','project-runtime/personal'].includes(endpoint)),[],'丢弃只允许读取复核，不得提交服务端操作')
 assert.deepEqual(errors,[])
})

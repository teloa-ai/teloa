import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 复用既有无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

test('旧整理导航重复打开及宿主晚挂载均保持只读预览，返回不提交',async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
 const temp=await mkdtemp(join(root,'.runtime-artifact-portal-focus-'));t.after(()=>rm(temp,{recursive:true,force:true}))
 await writeFile(join(temp,'fixture.tsx'),`import React,{useState,useEffect} from 'react';import {createRoot} from 'react-dom/client';import {ArtifactPanel} from ${JSON.stringify(join(client,'ArtifactPanel.tsx'))};import {emptyTaskPreview} from ${JSON.stringify(join(client,'task-preview.ts'))};import {I18nProvider} from ${JSON.stringify(join(client,'i18n/provider.tsx'))};import {translateMessage} from ${JSON.stringify(join(client,'i18n/messages.ts'))};
 const locale='zh-CN',snapshot={locale,dshLocale:'zh',revision:1},runtime={t:(key,params)=>translateMessage(locale,key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot},source={kind:'session',id:'original'},target={source,initialAction:'prepare'};
 function App(){const [open,setOpen]=useState(false),[mount,setMount]=useState(null),[host,setHost]=useState(0),[visible,setVisible]=useState(false);useEffect(()=>{if(!open){setVisible(false);return}const frame=requestAnimationFrame(()=>setVisible(true));return()=>cancelAnimationFrame(frame)},[open]);return <main><button onClick={()=>setOpen(true)}>概览整理入口</button><button onClick={()=>setHost(value=>value+1)}>重挂载预览宿主</button><textarea aria-label="原会话草稿" defaultValue="原输入"/><aside style={{width:380,height:700}}><div key={host} ref={setMount} hidden={!visible} style={{height:'100%'}}/></aside><ArtifactPanel inline portal={mount} open={open} target={target} state={emptyTaskPreview()} conversation={{id:source.id,title:'原会话',scope:'general',bindingId:'binding'}} taskSources={{list:async()=>[]}} nativeArtifacts={{}} artifactFileApi={{}} close={()=>setOpen(false)} change={async()=>{throw Error('不应提交')}} openSource={()=>{throw Error('不应导航')}} openTask={()=>{}}/></main>}
 createRoot(document.getElementById('root')).render(<I18nProvider runtime={runtime}><App/></I18nProvider>);`)
 const built=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'ArtifactPortalFocusTest',formats:['iife']}}})
 const bundle=Array.isArray(built)?built[0]:built;assert.ok(bundle&&'output'in bundle)
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1440,height:960}});t.after(()=>page.close());page.setDefaultTimeout(3000)
 const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));await page.route('**/*',(route:any)=>route.abort())
 await page.setContent('<!doctype html><html lang="zh-CN"><body><div id="root"></div></body></html>')
 await page.addStyleTag({content:bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')});await page.addScriptTag({content:bundle.output.find(item=>item.type==='chunk')!.code})
 const entry=page.getByRole('button',{name:'概览整理入口',exact:true}),back=page.getByRole('button',{name:'关闭产物面板',exact:true})
 await entry.click();await back.waitFor();assert.equal(await page.getByRole('dialog').getByRole('textbox').count(),0)
 await back.click();await entry.click();await back.waitFor();await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='关闭产物面板')
 assert.equal(await back.evaluate((node:HTMLElement)=>node===document.activeElement),true,'旧入口重开聚焦返回，不再聚焦手工名称')
 await page.getByRole('button',{name:'重挂载预览宿主',exact:true}).click();await back.waitFor()
 assert.equal(await page.getByRole('dialog').getByRole('textbox').count(),0)
 await back.click()
 assert.equal(await page.getByRole('textbox',{name:'原会话草稿'}).inputValue(),'原输入');assert.deepEqual(errors,[])
})

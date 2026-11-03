import assert from 'node:assert/strict'
import test from 'node:test'
import {fileURLToPath} from 'node:url'
import {build} from 'vite'
// @ts-expect-error 复用已固定的无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

test('F24-SKILL001 接收结果显示方法待处理及原技能入口，恢复后不再报冲突',{timeout:30000},async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url)),virtual=root+'__share_skill_readiness.tsx'
 const entry=`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {TemplateShareReceive} from '${client}TemplateShareReceive.tsx';import {buildSharePlan} from '${client}share-package-plan.ts';import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';
 const installationId='00000000-0000-4000-8000-000000000005';window.readinessCalls=0;window.nativeAvailable=false;window.openedInstallation=null;window.pkg=buildSharePlan({subject:'skill',publisher:'合成作者',roles:[],skills:[{name:'notes',title:'冲突方法',text:'---\\nname: notes\\ndescription: Check synthetic notes.\\n---\\nRead supplied notes.',license:'MIT'}]});const snapshot={locale:'zh-CN',dshLocale:'zh',revision:1},runtime={getSnapshot:()=>snapshot,subscribe:()=>()=>{},t:(key,params)=>translateMessage('zh-CN',key,params)};
 function App(){const[open,setOpen]=useState(true);return <I18nProvider runtime={runtime}><button onClick={()=>setOpen(true)}>继续接收</button><TemplateShareReceive open={open} close={()=>setOpen(false)} intent={null} accept={async()=>{window.readinessCalls++;return {sha256:'a'.repeat(64),complete:window.nativeAvailable,roleIds:[],roles:[],coordinator:'skipped',pendingKinds:window.nativeAvailable?[]:['skill'],skills:[{resourceId:'notes',title:'冲突方法',state:window.nativeAvailable?'done':'needs-user',installationId,nativeName:'notes'}],mcp:[],plugins:[],plans:[]}}} openRole={()=>{}} configure={()=>{}} openSkill={id=>{window.openedInstallation=id}}/></I18nProvider>}createRoot(document.getElementById('root')).render(<App/>);`
 const built=await build({configFile:false,root,logLevel:'error',plugins:[{name:'share-skill-readiness',resolveId:id=>id.endsWith('share-skill-readiness')?virtual:null,load:id=>id===virtual?entry:null}],define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:')},lib:{entry:'share-skill-readiness',name:'ShareSkillReadiness',formats:['iife']}}})
 const bundle=Array.isArray(built)?built[0]:built;assert.ok(bundle&&'output'in bundle)
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:1280,height:1000}});page.setDefaultTimeout(5000)
 const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));const url='http://127.0.0.1/share-skill-readiness'
 await page.route('**/*',(route:any)=>route.request().url()===url?route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="zh-CN"><body><div id="root"></div></body></html>'}):route.abort());await page.goto(url)
 await page.addStyleTag({content:bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')});await page.addScriptTag({content:bundle.output.find(item=>item.type==='chunk')!.code})
 const drawer=page.getByRole('dialog',{name:'导入模板',exact:true}),pkg=await page.evaluate(()=>(window as any).pkg)
 await drawer.locator('input[type=file]:enabled').setInputFiles({name:'notes.teloa-share.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(pkg))});await drawer.getByRole('button',{name:'确认添加',exact:true}).click()
 await drawer.getByText('待你处理',{exact:true}).waitFor();await drawer.getByRole('button',{name:'继续添加',exact:true}).waitFor();const view=drawer.getByRole('button',{name:'查看技能',exact:true});assert.equal(await view.isEnabled(),true)
 if(process.env.TELOA_TEST_CAPTURE_DIR)await drawer.screenshot({path:process.env.TELOA_TEST_CAPTURE_DIR+'/skill-needs-user-with-installation.png'})
 await view.click();assert.equal(await page.evaluate(()=>(window as any).openedInstallation),'00000000-0000-4000-8000-000000000005');await page.getByRole('button',{name:'继续接收',exact:true}).click();await page.evaluate(()=>{(window as any).nativeAvailable=true});await drawer.getByRole('button',{name:'继续添加',exact:true}).click();await drawer.getByText('待你处理',{exact:true}).waitFor({state:'hidden'});assert.equal(await drawer.getByRole('button',{name:'继续添加',exact:true}).count(),0);assert.equal(await page.evaluate(()=>(window as any).readinessCalls),2);assert.deepEqual(errors,[])
})

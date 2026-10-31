import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 复用项目的无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

test('项目弹窗字段纵向占满、错误就地反馈，长表单滚动时标题及操作可达',{timeout:120000},async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=join(root,'packages/client/ui-workbench/src/client'),temp=await mkdtemp(join(root,'.runtime-project-form-layout-'))
 t.after(()=>rm(temp,{recursive:true,force:true}))
 await writeFile(join(temp,'fixture.tsx'),`
 import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {ProjectForm} from '${client}/ProjectForm.tsx';import {I18nProvider} from '${client}/i18n/provider.tsx';import {translateMessage} from '${client}/i18n/messages.ts';import tokens from '${client}/theme-tokens.module.css';import {prototypeThemes} from '${client}/../brand/prototype-theme.ts';
 const config=window.projectFormCase,snapshot={locale:'zh-CN',dshLocale:'zh',revision:1},runtime={getSnapshot:()=>snapshot,subscribe:()=>()=>{},t:(key,params)=>translateMessage('zh-CN',key,params)},saved=[];window.projectFormFixture={saved};
 function App(){const [open,setOpen]=useState(false);return <I18nProvider runtime={runtime}><main className={tokens.tokens} style={{...prototypeThemes[config.theme],'--teloa-design-text-base':config.font/16+'rem',height:'100dvh',fontFamily:'system-ui'}}><button onClick={()=>setOpen(true)}>打开项目窗口</button>{open&&<ProjectForm initial={{scope:'general',title:config.editing?'现有项目':'',goal:config.editing?'原项目目标':'',state:'running',dueDate:null}} editing={config.editing} scopes={[{scope:'general',label:'通用工作'},{scope:'business-long',label:'跨区域客户交付与安全运营协作业务'}]} close={()=>setOpen(false)} save={async fields=>{saved.push(fields);setOpen(false)}}/>}</main></I18nProvider>};createRoot(document.getElementById('root')).render(<App/>);
 `)
 const built=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:')},lib:{entry:join(temp,'fixture.tsx'),name:'ProjectFormLayout',formats:['iife']}}})
 const bundle=Array.isArray(built)?built[0]:built;assert.ok(bundle&&'output'in bundle)
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 for(const editing of [false,true])for(const theme of ['light','dark'])for(const font of [14,28])for(const width of editing?[320,1440]:[320,390,768,1440]){
  const label=JSON.stringify({editing,theme,font,width}),page=await browser.newPage({viewport:{width,height:width<600?568:760}}),errors:string[]=[]
  page.setDefaultTimeout(4000);page.on('pageerror',(error:Error)=>errors.push(error.message))
  try{
   await page.route('**/*',(route:any)=>route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="zh-CN"><body style="margin:0"><div id="root"></div></body></html>'}));await page.goto('http://127.0.0.1:3199/project-form-layout')
   await page.evaluate((config:{editing:boolean;theme:string;font:number})=>{(window as any).projectFormCase=config;document.body.dataset.teloaUiFont=String(config.font)},{editing,theme,font})
   await page.addStyleTag({content:bundle.output.flatMap(row=>row.type==='asset'&&row.fileName.endsWith('.css')?[String(row.source)]:[]).join('\n')});await page.addScriptTag({content:bundle.output.find(row=>row.type==='chunk')!.code})
   const opener=page.getByRole('button',{name:'打开项目窗口',exact:true});await opener.click()
   const dialog=page.getByRole('dialog',{name:editing?'编辑项目':'新建项目',exact:true}),description=dialog.getByRole('textbox',{name:editing?'项目目标':'项目描述',exact:true})
   await description.waitFor();const field=await description.evaluate((node:HTMLElement)=>{const label=node.parentElement!,text=label.querySelector('span')!,a=node.getBoundingClientRect(),b=text.getBoundingClientRect(),c=label.getBoundingClientRect();return {gap:a.top-b.bottom,left:a.left-c.left,width:a.width,labelWidth:c.width}})
   assert.ok(field.gap>=4,label+' 标签应在描述框上方：'+JSON.stringify(field));assert.ok(Math.abs(field.left)<2&&Math.abs(field.width-field.labelWidth)<2,label+' 描述框应占满字段宽度')
   if(!editing){await dialog.locator('button[type=submit]').click();await dialog.getByRole('alert').waitFor();assert.equal(await description.getAttribute('aria-invalid'),'true');assert.equal(await description.evaluate((el:HTMLElement)=>document.activeElement===el),true)}
   const goal='# 客户上线项目\n\n目标：完成产品试用并交付上线说明。\n'+('核对资料、协调员工、确认交付结果。\n'.repeat(40));await description.fill(goal)
   const name=dialog.getByRole('textbox',{name:'项目名称',exact:true});await name.fill('跨区域客户上线项目')
   if(!editing)await dialog.locator('details>summary').click()
   const checkFrame=async()=>{
    const boxes=await dialog.evaluate((node:HTMLElement)=>{const dialog=node.getBoundingClientRect(),header=node.querySelector('form>header')!.getBoundingClientRect(),footer=node.querySelector('form>footer')!.getBoundingClientRect();return {dialog:dialog.toJSON(),header:header.toJSON(),footer:footer.toJSON(),viewport:innerHeight,overflow:node.scrollWidth>node.clientWidth+1}})
    assert.ok(boxes.dialog.top>=0&&boxes.dialog.bottom<=boxes.viewport+1&&!boxes.overflow,label+' 弹窗应完整位于视口内')
    assert.ok(boxes.header.top>=boxes.dialog.top&&boxes.header.bottom<=boxes.dialog.bottom&&boxes.footer.top>=boxes.dialog.top&&boxes.footer.bottom<=boxes.dialog.bottom+1,label+' 标题与操作应保持在弹窗内')
   }
   await checkFrame();await description.evaluate((node:HTMLElement)=>{let parent=node.parentElement;while(parent&&getComputedStyle(parent).overflowY!=='auto')parent=parent.parentElement;if(parent)parent.scrollTop=parent.scrollHeight});await checkFrame()
   assert.equal(await description.inputValue(),goal)
   if(process.env.TELOA_UI_SCREENSHOT_DIR&&!editing&&theme==='light'&&font===14&&[390,1440].includes(width)){await mkdir(process.env.TELOA_UI_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:join(process.env.TELOA_UI_SCREENSHOT_DIR,'project-form-'+width+'.png')})}
   await dialog.locator('button[type=submit]').click();await dialog.waitFor({state:'hidden'});const saved=await page.evaluate(()=>(window as any).projectFormFixture.saved);assert.equal(saved.length,1);assert.equal(saved[0].goal,goal);assert.equal(saved[0].title,'跨区域客户上线项目');assert.deepEqual(errors,[])
  }finally{await page.close()}
 }
})

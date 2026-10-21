import assert from 'node:assert/strict'
import test from 'node:test'
import {writeFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {build} from 'vite'
import {buildSharePlan} from '../src/client/share-package-plan.ts'
// @ts-expect-error 复用本仓无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

test('团队接收组成的员工小头像在预览和已添加结果均保持24px，不占正文伸展空间',{timeout:30000},async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url)),entryId=root+'__share_avatar.tsx'
 const entry=`import React from 'react';import {createRoot} from 'react-dom/client';import {TemplateShareReceive} from '${client}TemplateShareReceive.tsx';import {sharePackageSummary} from '${client}share-package-plan.ts';import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';
 const snapshot={locale:'zh-CN',dshLocale:'zh',revision:1},runtime={getSnapshot:()=>snapshot,subscribe:()=>()=>{},t:(key,params)=>translateMessage('zh-CN',key,params)};window.avatarAccepts=0;
 const accept=async pkg=>{window.avatarAccepts++;const roles=sharePackageSummary(pkg).roles.map((role,index)=>({resourceId:role.resourceId,name:role.name,roleId:'copy-'+index,state:'done'}));return {sha256:'a'.repeat(64),complete:true,groupId:'group-original',roleIds:roles.map(role=>role.roleId),roles,coordinatorRoleId:roles[0].roleId,coordinator:'done',pendingKinds:[],skills:[],mcp:[],plugins:[],plans:[]}};
 createRoot(document.getElementById('root')).render(<I18nProvider runtime={runtime}><TemplateShareReceive open close={()=>{}} intent={null} accept={accept} openRole={()=>{}} openGroup={()=>{}} configure={()=>{}}/></I18nProvider>);`
 const result=await build({configFile:false,root,logLevel:'error',plugins:[{name:'share-avatar',enforce:'pre',resolveId:id=>id.endsWith('share-avatar')?entryId:null,load:id=>id===entryId?entry:null}],define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:'share-avatar',name:'ShareAvatar',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:1280,height:900}});page.setDefaultTimeout(5000)
 const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));const url='http://127.0.0.1/share-avatar'
 await page.route('**/*',(route:any)=>route.request().url()===url?route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="zh-CN"><body><div id="root"></div></body></html>'}):route.abort());await page.goto(url)
 await page.addStyleTag({content:bundle.output.flatMap(row=>row.type==='asset'&&row.fileName.endsWith('.css')?[String(row.source)]:[]).join('\n')});await page.addScriptTag({content:bundle.output.find(row=>row.type==='chunk')!.code})
 const roles=['agent-twin-MiniMax群核验员','agent-review-final3-资料核验员'].map((name,index)=>({id:'role-'+index,name,kind:'employee' as const,duty:'核对本人提供的文字',dataScope:'本轮测试材料',executionScope:'对外操作前确认',skills:[],knowledge:[]})),pkg=buildSharePlan({subject:'team',title:'本轮分享团队',publisher:'Test',license:'MIT',roles,coordinatorRoleId:'role-0',skills:[]})
 const dialog=page.getByRole('dialog',{name:'导入模板',exact:true});await dialog.locator('input[type=file]').setInputFiles({name:'team.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(pkg))});const rows=dialog.locator('li:has(> [data-avatar])');await rows.nth(1).waitFor()
 const check=async(phase:string)=>{
  const dimensions=await rows.evaluateAll((items:Element[])=>items.map(row=>{const avatar=row.querySelector<HTMLElement>(':scope > [data-avatar]')!,svg=avatar.querySelector('svg')!,text=row.querySelector<HTMLElement>(':scope > span:not([data-avatar])')!,a=avatar.getBoundingClientRect(),s=svg.getBoundingClientRect(),r=row.getBoundingClientRect();return {avatar:{width:a.width,height:a.height,display:getComputedStyle(avatar).display,flexGrow:getComputedStyle(avatar).flexGrow},svg:{width:s.width,height:s.height},row:{width:r.width,height:r.height},textFlexGrow:getComputedStyle(text).flexGrow}}))
  console.log(JSON.stringify({phase,dimensions}))
  if(process.env.TELOA_SHARE_EVIDENCE){await page.screenshot({path:process.env.TELOA_SHARE_EVIDENCE+'/avatar-'+phase+'.png',fullPage:true});await writeFile(process.env.TELOA_SHARE_EVIDENCE+'/avatar-'+phase+'.json',JSON.stringify(dimensions,null,2))}
  assert.equal(dimensions.length,2)
  // inline-flex 作为 flex 子项时，浏览器的 computed display 会 blockify 为 flex。
  for(const value of dimensions){assert.equal(value.avatar.width,24,phase+' 员工头像宽度');assert.equal(value.avatar.height,24,phase+' 员工头像高度');assert.equal(value.svg.width,24,phase+' 员工图形宽度');assert.equal(value.svg.height,24,phase+' 员工图形高度');assert.equal(value.avatar.display,'flex');assert.equal(value.avatar.flexGrow,'0');assert.equal(value.textFlexGrow,'1')}
 }
 await check('preview-wide');await page.setViewportSize({width:390,height:844});await check('preview-narrow');assert.equal(await page.evaluate(()=>(window as any).avatarAccepts),0)
 await dialog.getByRole('button',{name:'确认添加',exact:true}).click();await dialog.getByRole('button',{name:'打开 AI 团队',exact:true}).waitFor();assert.equal(await rows.getByRole('button',{name:'查看员工',exact:true}).count(),2);await check('added-narrow');await page.setViewportSize({width:1280,height:900});await check('added-wide');assert.equal(await page.evaluate(()=>(window as any).avatarAccepts),1);assert.deepEqual(errors,[])
})

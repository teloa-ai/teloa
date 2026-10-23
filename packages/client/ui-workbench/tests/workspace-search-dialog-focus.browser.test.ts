import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 复用既有无头浏览器加载器。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'

const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))

test('全局搜索：Tab 不落 BODY，Esc/关闭按钮关闭后焦点回到触发器',{timeout:30000},async t=>{
 const temp=await mkdtemp(join(root,'.runtime-search-focus-'));t.after(()=>rm(temp,{recursive:true,force:true}))
 await writeFile(join(temp,'entry.tsx'),`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {WorkspaceSearch} from '${client}WorkspaceSearch.tsx';import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';import tokens from '${client}theme-tokens.module.css';import {prototypeThemes} from '${client}../brand/prototype-theme.ts';
 Object.entries(prototypeThemes.light).forEach(([key,value])=>document.body.style.setProperty(key,value));document.body.classList.add(tokens.tokens);
 const noop=()=>()=>{},localeState={locale:'zh-CN',dshLocale:'zh-CN',revision:1},runtime={t:(key,params)=>translateMessage('zh-CN',key,params),subscribe:noop,getSnapshot:()=>localeState},source={conversations:[{conversation:{id:'c1',status:'ready'},title:'日常记录',updatedAt:1,status:'idle',snippet:''}],tasks:[{storage:'persistent',id:'t1',title:'核对资料',goal:'核对',state:'ready',scope:'general'}],roles:[],groups:[],spaces:[],knowledge:[],capabilities:[],market:[]};
 function App(){const [visible,setVisible]=useState(false);return <I18nProvider runtime={runtime}><button type="button" onClick={()=>setVisible(true)}>打开搜索</button><WorkspaceSearch visible={visible} source={source} conversationStatus="" knowledgeStatus="" capabilityStatus="" close={()=>setVisible(false)} open={async()=>{}} searchMessages={()=>{}}/></I18nProvider>}
 createRoot(document.getElementById('root')).render(<App/>);`)
 const result=await build({plugins:[{name:'forbid-host-crypto',enforce:'pre',resolveId(id){if(id==='node:crypto')return '\0forbid-host-crypto'},load(id){if(id==='\0forbid-host-crypto')return "function blocked(){throw Error('浏览器验收不允许执行宿主摘要或签名算法')} export {blocked as createHash,blocked as createPublicKey,blocked as verify}"}}],
 configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,lib:{entry:join(temp,'entry.tsx'),name:'SearchFocusTest',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 const script=bundle.output.find(item=>item.type==='chunk')!.code,styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1280,height:900}});t.after(()=>page.close());page.setDefaultTimeout(3000)
 const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));await page.route('**/*',(route:any)=>route.abort())
 await page.setContent('<!doctype html><html lang="zh-CN"><body style="margin:0"><div id="root"></div></body></html>');if(styles)await page.addStyleTag({content:styles});await page.addScriptTag({content:script})
 const trigger=page.getByRole('button',{name:'打开搜索',exact:true}),dialog=page.getByRole('dialog')
 await trigger.click();await dialog.waitFor({state:'visible'})
 const input=dialog.getByRole('combobox')
 await input.fill('核对')
 const seen:Array<{tag:string;BODY:boolean}>=[]
 for(let index=0;index<14;index++){
  await page.keyboard.press('Tab');await page.waitForTimeout(40)
  const state=await page.evaluate(()=>({tag:document.activeElement?.tagName??'',body:document.activeElement===document.body||document.activeElement===document.documentElement,inDialog:!!document.querySelector('dialog')?.contains(document.activeElement)}))
  seen.push({tag:state.tag,BODY:state.body})
  assert.equal(state.body,false,`第 ${index+1} 次 Tab 焦点落到 BODY/HTML：${JSON.stringify(seen)}`)
  assert.equal(state.inDialog,true,`第 ${index+1} 次 Tab 焦点离开搜索弹层：${JSON.stringify(seen)}`)
 }
 await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'})
 assert.equal(await trigger.evaluate((node:HTMLElement)=>document.activeElement===node),true,'Esc 关闭后焦点回到打开搜索的触发器')
 await trigger.click();await dialog.waitFor({state:'visible'})
 await dialog.getByRole('button',{name:'关闭业务搜索',exact:true}).click();await dialog.waitFor({state:'hidden'})
 assert.equal(await trigger.evaluate((node:HTMLElement)=>document.activeElement===node),true,'关闭按钮关闭后焦点回到打开搜索的触发器')
 assert.deepEqual(errors,[])
})

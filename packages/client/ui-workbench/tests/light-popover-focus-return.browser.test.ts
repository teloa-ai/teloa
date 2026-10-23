import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 复用既有无头浏览器加载器。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'

const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))

test('轻浮层：Esc/关闭按钮关闭后焦点回到触发器，外点不抢外部新焦点',{timeout:30000},async t=>{
 const temp=await mkdtemp(join(root,'.runtime-dismissible-focus-'));t.after(()=>rm(temp,{recursive:true,force:true}))
 await writeFile(join(temp,'entry.tsx'),`import React,{useRef,useState} from 'react';import {createRoot} from 'react-dom/client';import {useDismissible} from '${client}use-dismissible.ts';
 function App(){const [open,setOpen]=useState(false),ref=useRef<HTMLDivElement>(null);useDismissible(ref,open,()=>setOpen(false));return <div><button id="trigger" type="button" onClick={()=>setOpen(value=>!value)}>打开浮层</button>{open&&<div ref={ref} role="dialog" aria-label="轻浮层"><input aria-label="浮层输入"/><button id="inside-close" type="button" onClick={()=>setOpen(false)}>完成</button></div>}<button id="outside" type="button">外部按钮</button></div>}
 createRoot(document.getElementById('root')).render(<App/>);`)
 const result=await build({plugins:[{name:'forbid-host-crypto',enforce:'pre',resolveId(id){if(id==='node:crypto')return '\0forbid-host-crypto'},load(id){if(id==='\0forbid-host-crypto')return "function blocked(){throw Error('浏览器验收不允许执行宿主摘要或签名算法')} export {blocked as createHash,blocked as createPublicKey,blocked as verify}"}}],
 configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,lib:{entry:join(temp,'entry.tsx'),name:'DismissibleFocusTest',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 const script=bundle.output.find(item=>item.type==='chunk')!.code,styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const page=await browser.newPage({viewport:{width:900,height:600}});t.after(()=>page.close());page.setDefaultTimeout(3000)
 const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));await page.route('**/*',(route:any)=>route.abort())
 await page.setContent('<!doctype html><html lang="zh-CN"><body style="margin:0"><div id="root"></div></body></html>');if(styles)await page.addStyleTag({content:styles});await page.addScriptTag({content:script})
 const trigger=page.getByRole('button',{name:'打开浮层',exact:true}),dialog=page.getByRole('dialog',{name:'轻浮层',exact:true})
 const focused=()=>page.evaluate(()=>({tag:document.activeElement?.tagName,id:(document.activeElement as HTMLElement| null)?.id,aria:document.activeElement?.getAttribute('aria-label')}))
 await trigger.click();await dialog.waitFor({state:'visible'})
 await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'})
 assert.equal((await focused()).id,'trigger','Esc 关闭后焦点必须回到触发器')
 await trigger.click();await dialog.waitFor({state:'visible'});await dialog.getByRole('button',{name:'完成',exact:true}).click();await dialog.waitFor({state:'hidden'})
 assert.equal((await focused()).id,'trigger','关闭按钮关闭后焦点必须回到触发器')
 await trigger.click();await dialog.waitFor({state:'visible'});await page.getByRole('button',{name:'外部按钮',exact:true}).click();await dialog.waitFor({state:'hidden'})
 assert.equal((await focused()).id,'outside','外点关闭后焦点留在用户点击的外部控件，不能被触发器抢回')
 assert.deepEqual(errors,[])
})

import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 复用既有无头浏览器加载器。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'

test('群附件共享只读预览；SVG不执行，固定身份读取且离开后释放字节',{timeout:30000},async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url)),temp=await mkdtemp(join(root,'.runtime-group-file-preview-'))
 t.after(()=>rm(temp,{recursive:true,force:true}))
 await writeFile(join(temp,'fixture.tsx'),`import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';import {GroupAttachmentPreview} from '${client}GroupAttachmentPreview.tsx';import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';
 const root=createRoot(document.getElementById('root')),snapshot={locale:'zh-CN',dshLocale:'zh-CN',revision:1},runtime={t:(key,params)=>translateMessage('zh-CN',key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};
 const f=window.fileFixture={selected:null,live:true,calls:[],revoked:0,render:()=>render()};
 const api={openReference:async reference=>{f.calls.push(reference);const svg=reference.id==='svg',mime=svg?'image/svg+xml':'text/markdown',name=svg?'主动文件.svg':'采购说明.md',url=URL.createObjectURL(new Blob([svg?'<svg xmlns="http://www.w3.org/2000/svg"><script>window.svgExecuted=true</script></svg>':'# 附件正文'],{type:mime}));return {name,mime,blobUrl:url,revoke:()=>{URL.revokeObjectURL(url);f.revoked++}}}};
 function render(){flushSync(()=>root.render(<I18nProvider runtime={runtime}><textarea aria-label="原讨论草稿" defaultValue="保留资料讨论"/><button onClick={()=>{f.selected='text';render()}}>查看文档</button><button onClick={()=>{f.selected='svg';render()}}>查看SVG</button>{f.selected&&<GroupAttachmentPreview key={f.selected} file={{attachmentId:f.selected,version:1,state:'active',name:f.selected==='svg'?'主动文件.svg':'采购说明.md'}} api={api} isCurrent={()=>f.live} close={()=>{f.selected=null;render()}}/>}</I18nProvider>))}render();`)
 const result=await build({configFile:false,root,logLevel:'error',plugins:[{name:'forbid-host-crypto',enforce:'pre',resolveId:(id:string)=>id==='node:crypto'?'\0forbid-host-crypto':undefined,load:(id:string)=>id==='\0forbid-host-crypto'?"function blocked(){throw Error('浏览器客户端不得执行宿主摘要或验签')} export {blocked as createHash,blocked as createPublicKey,blocked as verify}":undefined}],define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,lib:{entry:join(temp,'fixture.tsx'),name:'GroupFilePreviewTest',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 const script=bundle.output.find(item=>item.type==='chunk')!.code,styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:1440,height:960}});t.after(()=>page.close());page.setDefaultTimeout(3000);await page.route('**/*',(route:any)=>route.abort())
 await page.setContent('<html lang="zh-CN"><body><div id="root"></div></body></html>');await page.addStyleTag({content:styles});await page.addScriptTag({content:script})
 await page.getByRole('button',{name:'查看文档',exact:true}).click();const dialog=page.getByRole('dialog');await dialog.getByRole('heading',{name:'采购说明.md',exact:true}).waitFor();await dialog.getByText('附件正文',{exact:true}).waitFor()
 assert.equal(await dialog.getByRole('textbox').count(),0);await dialog.getByRole('button',{name:'源文本',exact:true}).click();assert.equal(await dialog.locator('pre').innerText(),'# 附件正文')
 assert.deepEqual(await page.evaluate(()=>(window as any).fileFixture.calls),[{kind:'attachment',id:'text',version:1}]);assert.equal(await page.evaluate(()=>(window as any).fileFixture.revoked),1)
 await dialog.getByRole('button',{name:'返回群讨论',exact:true}).click();assert.equal(await page.getByLabel('原讨论草稿').inputValue(),'保留资料讨论')
 await page.getByRole('button',{name:'查看SVG',exact:true}).click();await dialog.getByRole('heading',{name:'主动文件.svg',exact:true}).waitFor()
 assert.equal(await dialog.locator('iframe,object,embed,img').count(),0,'主动文档不得装入可执行浏览器视图');assert.equal(await page.evaluate(()=>Boolean((window as any).svgExecuted)),false)
 assert.equal(await dialog.getByRole('button',{name:'下载',exact:true}).isEnabled(),true);assert.equal(await dialog.getByRole('button',{name:'源文本',exact:true}).count(),0)
 await page.keyboard.press('Escape');assert.equal(await dialog.count(),0);assert.equal(await page.evaluate(()=>(window as any).fileFixture.revoked),2)
})

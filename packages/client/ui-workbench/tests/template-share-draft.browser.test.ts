import assert from 'node:assert/strict'
import test from 'node:test'
import {createServer} from 'node:http'
import {mkdtemp,rm,writeFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 既有无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

test('同一自然语言草案按正文版本恢复：原发布请求可重试，新正文使用新请求且不被旧冻结稿覆盖',async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
 const temp=await mkdtemp(join(root,'.runtime-share-draft-'));t.after(()=>rm(temp,{recursive:true,force:true}))
 await writeFile(join(temp,'fixture.tsx'),`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
 import {ShareDraftDrawer,TemplateShareProvider} from ${JSON.stringify(join(client,'EmployeeTemplateShare.tsx'))};
 import {buildSharePlan,editSharePackage,readSharePackage} from ${JSON.stringify(join(client,'share-package-plan.ts'))};
 import {I18nProvider} from ${JSON.stringify(join(client,'i18n/provider.tsx'))};
 import {translateMessage} from ${JSON.stringify(join(client,'i18n/messages.ts'))};
 const text='---\\nname: draft-method\\ndescription: Check supplied facts\\n---\\n# Method\\nUse the first version of the method.';
 const a=buildSharePlan({subject:'skill',publisher:'Fixture Author',license:'MIT',title:'第一版方法',description:'方法原稿',roles:[],skills:[{name:'draft-method',title:'核查方法',resourceId:'draft-method',version:'1.0.0',text,license:'MIT'}]});
 const b=readSharePackage({...editSharePackage(a,'第二版方法','最新方法原稿'),files:editSharePackage(a,'第二版方法','最新方法原稿').files.map(f=>f.path.endsWith('/SKILL.md')?{...f,text:f.text.replace('first version','second version')}:f)});
 const saved=new Map(),storage={getItem:k=>saved.get(k)??null,setItem:(k,v)=>saved.set(k,v),removeItem:k=>saved.delete(k)};
 const requests=[];window.fixtureRequests=requests;
 const bridge={policy:async()=>({receiveMode:'local-package',canPublish:true}),publish:async input=>{requests.push(structuredClone(input));throw Object.assign(Error('receipt unavailable'),{code:'unavailable'})},read:async()=>{throw Error('unused')},list:async()=>[],revoke:async()=>{throw Error('unused')}};
 const shared={storage,bridge,publisher:'Fixture Author',receive:()=>{},openDraft:()=>{}};
 const locale='zh-CN',snapshot={locale,dshLocale:'zh',revision:1},runtime={t:(k,p)=>translateMessage(locale,k,p),subscribe:()=>()=>{},getSnapshot:()=>snapshot};
 function App(){const [pkg,setPkg]=useState(a),[open,setOpen]=useState(false);return <main id="teloa-main" tabIndex={-1}><button onClick={()=>{setPkg(a);setOpen(true)}}>打开原稿</button><button onClick={()=>{setPkg(b);setOpen(true)}}>打开最新稿</button><ShareDraftDrawer pkg={pkg} open={open} close={()=>setOpen(false)}/></main>}
 createRoot(document.getElementById('root')).render(<I18nProvider runtime={runtime}><TemplateShareProvider value={shared}><App/></TemplateShareProvider></I18nProvider>);`)
 const result=await build({configFile:false,root,resolve:{alias:{'@teloa/contract':join(root,'packages/contract/src/index.ts')}},logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'TemplateShareDraftTest',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 const script=bundle.output.find(item=>item.type==='chunk')!.code,styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 const server=createServer((_req,res)=>{res.setHeader('content-type','text/html');res.end('<!doctype html><html lang="zh-CN"><body><div id="root"></div></body></html>')})
 await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));t.after(()=>new Promise<void>(done=>server.close(()=>done())))
 const address=server.address();assert.ok(address&&typeof address==='object')
 const origin=`http://127.0.0.1:${address.port}`
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1440,height:960}});t.after(()=>page.close());page.setDefaultTimeout(5000)
 const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message))
 await page.route('**/*',(route:any)=>new URL(route.request().url()).origin===origin?route.continue():route.abort())
 await page.goto(origin);await page.addStyleTag({content:styles});await page.addScriptTag({content:script})
 await page.getByRole('button',{name:'打开原稿',exact:true}).click()
 await page.getByRole('heading',{name:'第一版方法',exact:true}).waitFor()
 await page.getByRole('button',{name:'发布分享链接',exact:true}).click()
 await page.getByRole('button',{name:'核对原请求',exact:true}).waitFor()
 await page.getByRole('button',{name:'关闭',exact:true}).click()
 await page.getByRole('button',{name:'打开原稿',exact:true}).click()
 await page.getByRole('button',{name:'核对原请求',exact:true}).click()
 await page.waitForFunction(()=>window.fixtureRequests.length===2)
 await page.getByRole('button',{name:'关闭',exact:true}).click()
 await page.getByRole('button',{name:'打开最新稿',exact:true}).click()
 await page.getByRole('heading',{name:'第二版方法',exact:true}).waitFor()
 assert.equal(await page.getByRole('heading',{name:'第一版方法',exact:true}).count(),0)
 await page.getByRole('button',{name:'发布分享链接',exact:true}).click()
 await page.waitForFunction(()=>window.fixtureRequests.length===3)
 const requests=await page.evaluate(()=>window.fixtureRequests) as {requestId:string;package:{id:string;files:{path:string;text:string}[]}}[]
 assert.deepEqual(requests[0],requests[1],'同一版本重新打开必须核对同一冻结发布请求')
 assert.equal(requests[0]!.package.id,requests[2]!.package.id,'新正文仍属于同一自然语言草案')
 assert.notEqual(requests[0]!.requestId,requests[2]!.requestId,'不同正文不得复用已冻结请求')
 assert.match(requests[2]!.package.files.find(f=>f.path.endsWith('/SKILL.md'))!.text,/second version/)
 assert.deepEqual(errors,[])
})

declare global {interface Window {fixtureRequests:unknown[]}}

import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 复用工作树内的无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

test('真实非安全 HTTP 可挂载首页与资料组件，读取资料仍核对 SHA-256',async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url)),id=join(client,'__http-access-fixture.tsx')
 const text='# 公网 HTTP 资料\n保持正文摘要核对。',hash=createHash('sha256').update(text).digest('hex')
 const entry=`import '${client}browser-crypto-compat.ts';import React from 'react';import {createRoot} from 'react-dom/client';import {WorkHome} from '${client}WorkHome.tsx';import {ResourceManager} from '${client}ResourceManager.tsx';import {createResourceApi} from '${client}resource-api.ts';import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';
 const snapshot={locale:'zh-CN',dshLocale:'zh-CN',revision:1},runtime={subscribe:()=>()=>{},getSnapshot:()=>snapshot,t:(key,params)=>translateMessage('zh-CN',key,params)},directory={status:'ready',rows:[]},management={baseline:true,archived:[],ready:true},work={subscribe:()=>()=>{},getDirectorySnapshot:()=>directory};
 const text=${JSON.stringify(text)},resource={id:'11111111-1111-4111-8111-111111111111',ownerId:'self',title:'HTTP 资料',sourceId:'local_material_22222222-2222-4222-8222-222222222222',sourceVersion:${JSON.stringify(hash)},scopeIds:['general'],version:1,status:'active',createdAt:'2026-10-30T00:00:00.000Z',updatedAt:'2026-10-30T00:00:00.000Z'};let tampered=false;
 const api=createResourceApi(async method=>{if(method!=='resources/read-content')throw Error('夹具不应访问宿主');return {resource,text:tampered?'被篡改的资料':text}});
 window.httpFixture={uuid:()=>crypto.randomUUID(),read:changed=>{tampered=changed;return api.readContent(resource,new AbortController().signal)}};
 createRoot(document.getElementById('root')).render(<I18nProvider runtime={runtime}><WorkHome visible work={work} management={{subscribe:()=>()=>{},getSnapshot:()=>management}} useSessions={select=>select({byId:{}})} workTasks={[]} colleagues={[]} conversationLinks={[]} attentionStatus={{known:true,count:0}} planStatus={{savedPlans:0,examplePlans:0,exampleRuns:0,directory:'ready'}} open={()=>{}} openTask={()=>{}} openTasks={()=>{}} plans={()=>{}} attention={()=>{}}/><ResourceManager visible={false} api={api} selectedDraftId={null} targetResource={null} clearTarget={()=>{}} openConversation={()=>{}}/></I18nProvider>);`
 const built=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},plugins:[{name:'http-access-fixture',enforce:'pre',resolveId:source=>source.endsWith('http-access-fixture')?id:source==='node:crypto'?'\0forbid-host-crypto':null,load:source=>source===id?entry:source==='\0forbid-host-crypto'?"function blocked(){throw Error('浏览器不可使用宿主密码学接口')} export {blocked as createHash,blocked as createPublicKey,blocked as verify}":null}],build:{write:false,minify:false,lib:{entry:'http-access-fixture',name:'HttpAccessFixture',formats:['iife']}}})
 const bundle=Array.isArray(built)?built[0]:built;assert.ok(bundle&&'output'in bundle)
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1280,height:800}});page.setDefaultTimeout(3000)
 const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));await page.route('**/*',(route:any)=>route.abort())
 const origin='http://teloa-http.test:3100/'
 await page.route(origin,(route:any)=>route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="zh-CN"><body><div id="root"></div></body></html>'}));await page.goto(origin)
 assert.deepEqual(await page.evaluate(()=>({secure:isSecureContext,uuid:typeof crypto.randomUUID,subtle:typeof crypto.subtle})),{secure:false,uuid:'undefined',subtle:'undefined'},'不能用 localhost 或浏览器安全例外掩盖公网 HTTP 条件')
 for(const asset of bundle.output)if(asset.type==='asset'&&asset.fileName.endsWith('.css'))await page.addStyleTag({content:String(asset.source)})
 await page.addScriptTag({content:bundle.output.find(row=>row.type==='chunk')!.code})
 await page.getByRole('heading',{name:'继续工作',exact:true}).waitFor()
 const result=await page.evaluate(async()=>{const f=(window as any).httpFixture;let rejected=false;const good=await f.read(false);try{await f.read(true)}catch{rejected=true}return {uuid:f.uuid(),text:good.text,rejected,subtle:typeof crypto.subtle}})
 assert.match(result.uuid,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
 assert.equal(result.text,text);assert.equal(result.rejected,true,'HTTP 下也必须拒绝正文和摘要不一致')
 assert.equal(result.subtle,'undefined','兼容层不能伪造完整的 SubtleCrypto 能力')
 assert.deepEqual(errors,[])
})

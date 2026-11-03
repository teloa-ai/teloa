import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {fileURLToPath} from 'node:url'
import {readFile} from 'node:fs/promises'
import {build} from 'vite'
import {customMcpAuthorizationFixture} from './fixtures/custom-mcp-authorization.ts'
// @ts-expect-error 复用工作树无头浏览器加载器。
import {loadPlaywright,launchOptions} from '../../client/ui-workbench/tests/fixtures/load-playwright.mjs'
const root=fileURLToPath(new URL('../../../',import.meta.url)),client=fileURLToPath(new URL('../../client/ui-workbench/src/client/',import.meta.url))
let browser:Awaited<ReturnType<ReturnType<typeof loadPlaywright>['chromium']['launch']>>,script:string
const entry=`import React,{useState}from'react';import{createRoot}from'react-dom/client';import{CustomMcpConnectionRoute}from'${client}CustomMcpConnectionRoute.tsx';import{createManagedMcpConnectionApi}from'${client}mcp-connections-api.ts';import{I18nProvider}from'${client}i18n/provider.tsx';import{translateMessage}from'${client}i18n/messages.ts';
const api=createManagedMcpConnectionApi((method,payload)=>window.realCustomHandler(method,payload)),snapshot={locale:'zh-CN',dshLocale:'zh',revision:1},runtime={t:(k,p)=>translateMessage('zh-CN',k,p),getSnapshot:()=>snapshot,subscribe:()=>()=>{}};function App(){const [shown,setShown]=useState(true);window.connectionRoute={reopen:()=>setShown(true)};return shown?<CustomMcpConnectionRoute catalogId='custom.reuse_source' api={api} close={()=>setShown(false)}/>:null}createRoot(document.getElementById('root')).render(<I18nProvider runtime={runtime}><App/></I18nProvider>);`
before(async()=>{const virtual=root+'__custom_connection_lifecycle.tsx',result=await build({root,configFile:false,logLevel:'error',plugins:[{name:'custom-connection-lifecycle',resolveId:id=>id.endsWith('custom-connection-lifecycle')?virtual:null,load:id=>id===virtual?entry:null}],define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,lib:{entry:'custom-connection-lifecycle',formats:['iife'],name:'CustomConnectionLifecycle'},rollupOptions:{external:(id:string)=>id.startsWith('node:')}}});const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle);script=bundle.output.find(row=>row.type==='chunk')!.code;browser=await loadPlaywright().chromium.launch(launchOptions())})
after(async()=>{await browser?.close()})
async function mount(handler:(method:string,payload:unknown)=>Promise<unknown>){const page=await browser.newPage(),errors:string[]=[];page.setDefaultTimeout(4000);page.on('pageerror',(e:Error)=>errors.push(e.message));await page.route('**/*',(route:{abort:()=>Promise<void>})=>route.abort());await page.setContent('<!doctype html><html><body><div id="root"></div></body></html>');await page.exposeFunction('realCustomHandler',handler);await page.addScriptTag({content:script});return {page,errors}}

test('正式持久handler断开→关闭重开恢复原只读授权；空控件续用不旋转，明确撤空仍改权',async t=>{
 const f=await customMcpAuthorizationFixture(t),{page,errors}=await mount(async(method,payload)=>f.managed.handler(method,payload))
 try{
  let d=page.getByRole('dialog',{name:'原只读来源',exact:true});await d.getByRole('checkbox',{name:'read_a',exact:true}).waitFor()
  const before=(await f.state())._customAuthorization,binding=(await f.managed.captureSourceAuthority('reuse_source','read_a')).bindingKey
  await d.getByRole('button',{name:'断开连接',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('[role=status]')?.textContent?.includes('已连接'))
  await d.getByRole('button',{name:'关闭',exact:true}).click();await page.evaluate(()=>Reflect.get(window,'connectionRoute').reopen())
  d=page.getByRole('dialog',{name:'原只读来源',exact:true});await d.getByRole('checkbox',{name:'read_a',exact:true}).waitFor()
  assert.equal(await d.getByRole('checkbox',{name:'read_a',exact:true}).isChecked(),true);assert.equal(await d.getByRole('checkbox',{name:'read_b',exact:true}).isChecked(),true)
  const persisted=await f.managed.handler('mcp-connections/get-custom',{id:f.saved.id}) as {connection:{tools?:unknown[]}};assert.equal(persisted.connection.tools,undefined)
  const encrypted=await readFile(f.credentialPath,'utf8'),writes=f.writes()
  await d.getByRole('button',{name:'添加并连接 / 更新连接',exact:true}).click();await d.getByText('已连接，发现 2 个工具',{exact:true}).waitFor()
  assert.deepEqual((await f.state())._customAuthorization,before);assert.equal(await readFile(f.credentialPath,'utf8'),encrypted);assert.equal(f.writes(),writes);assert.equal((await f.managed.captureSourceAuthority('reuse_source','read_a')).bindingKey,binding)
  await d.getByRole('checkbox',{name:'read_a',exact:true}).uncheck();await d.getByRole('checkbox',{name:'read_b',exact:true}).uncheck()
  await d.getByRole('button',{name:'添加并连接 / 更新连接',exact:true}).click();await page.waitForFunction(()=>{const button=document.querySelector('form button[type=submit]');return button instanceof HTMLButtonElement&&!button.disabled})
  assert.notEqual((await f.state())._customAuthorization.generation,before.generation);assert.deepEqual((await f.state())._customAuthorization.readOnlyTools,[]);assert.equal(f.managed.isReadOnlyTool('reuse_source','read_a'),false);assert.notEqual((await f.managed.captureSourceAuthority('reuse_source','read_a')).bindingKey,binding);assert.deepEqual(errors,[])
 }finally{await page.close()}
})

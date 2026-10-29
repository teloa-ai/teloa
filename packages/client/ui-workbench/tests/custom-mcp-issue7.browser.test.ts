import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,writeFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 复用项目浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

test('自定义 MCP 的二选一认证、修订连接、冲突恢复与工具核对在真实 React 中可用',{timeout:60000},async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url)),temp=await mkdtemp(join(root,'.runtime-custom-mcp-issue7-'))
 t.after(()=>rm(temp,{recursive:true,force:true}))
 await writeFile(join(temp,'fixture.tsx'),`import React from 'react';import {createRoot} from 'react-dom/client';import {CustomMcpAppConfirmation} from ${JSON.stringify(join(client,'CustomMcpAppEntry.tsx'))};import {createManagedMcpConnectionApi} from ${JSON.stringify(join(client,'mcp-connections-api.ts'))};import {createRejectedWorkRpcCall} from ${JSON.stringify(join(client,'work-rpc-result.ts'))};import {I18nProvider} from ${JSON.stringify(join(client,'i18n/provider.tsx'))};import {translateMessage} from ${JSON.stringify(join(client,'i18n/messages.ts'))};
const id='11111111-1111-4111-8111-111111111111',calls=[],definition={schema:'teloa.mcp-server/v1',serverName:'audit',title:'审计服务新版',transport:'streamable-http',url:'https://example.test/mcp',auth:{kind:'headers',requirement:'any',headers:[{name:'Authorization',scheme:'Bearer'},{name:'X-API-Key'}]}},connection={id,catalogId:'custom.audit',serverName:'audit',status:'saved',createdAt:'2026-10-28T00:00:00.000Z',updatedAt:'2026-10-28T00:00:00.000Z',tools:[{name:'audit.events.list',fullName:'mcp__audit__audit_events_list_123456789abc',readOnly:false,description:'检索审计事件，query 是查询正文',inputSchema:{type:'object',properties:{query:{type:'string'}}},annotations:{readOnlyHint:true,destructiveHint:false}}]},snapshot={locale:'zh-CN',dshLocale:'zh',revision:1},i18n={t:(key,params)=>translateMessage('zh-CN',key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};let savedHash='a'.repeat(64),configured=false,failPreview=false,failConnect=false;
const preview=()=>({definition,definitionHash:'b'.repeat(64),savedDefinitionHash:savedHash,connection,authorizationConfigured:configured&&savedHash==='b'.repeat(64)}),api={previewCustom:async()=>{calls.push('preview');if(failPreview)throw Error('temporary');return preview()},saveCustom:async()=>{throw Error('must not duplicate')},updateCustom:async input=>{calls.push({operation:'update',input});if(input.expectedDefinitionHash!==savedHash)throw Object.assign(Error('changed'),{code:'teloa/version-conflict'});savedHash='b'.repeat(64);return connection},authorizeCustom:async input=>{calls.push({operation:'authorize',input});configured=true;return connection},connect:async()=>{calls.push('connect');return createManagedMcpConnectionApi(createRejectedWorkRpcCall(async()=>failConnect?{ok:false,error:{code:'teloa/dependency-unavailable',details:{reason:'mcp-auth-rejected'},message:'SECRET_MUST_NOT_RENDER'}}:{ok:true,value:{...connection,status:'connected'}})).connect(id)},disconnect:async()=>connection,delete:async()=>{}};
window.fixture={calls,externalChange:()=>{savedHash='c'.repeat(64);configured=false},failPreview:value=>failPreview=value,failConnect:value=>failConnect=value};const draft={id:'22222222-2222-4222-8222-222222222222',requestId:'33333333-3333-4333-8333-333333333333',body:JSON.stringify({definition}),bodyHash:'d'.repeat(64)};createRoot(document.getElementById('root')).render(<I18nProvider runtime={i18n}><main style={{maxWidth:600,margin:'30px auto',fontFamily:'system-ui'}}><CustomMcpAppConfirmation api={api} preview={{draft}} active apply={async id=>calls.push({operation:'apply',id})}/></main></I18nProvider>);
`)
 const built=await build({configFile:false,root,resolve:{alias:{'@teloa/contract':join(root,'packages/contract/src/index.ts')}},logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'CustomMcpIssue7',formats:['iife']}}})
 const bundle=Array.isArray(built)?built[0]:built;assert.ok(bundle&&'output'in bundle)
 const script=bundle.output.find(item=>item.type==='chunk')!.code,css=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n'),browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const mount=async()=>{const page=await browser.newPage({viewport:{width:1000,height:900}}),errors:string[]=[];page.setDefaultTimeout(4000);page.on('pageerror',(e:Error)=>errors.push(e.message));await page.route('**/*',(route:any)=>route.request().url()==='http://127.0.0.1/custom-mcp-issue7'?route.fulfill({contentType:'text/html',body:'<!doctype html><html><body><div id="root"></div></body></html>'}):route.abort());await page.goto('http://127.0.0.1/custom-mcp-issue7');await page.addStyleTag({content:css});await page.addScriptTag({content:script});await page.getByLabel('X-API-Key',{exact:true}).waitFor();return {page,errors}}
 await t.test('修订草案更新原连接，二选一只发已填请求头，详细工具信息支持确认',async()=>{
  const {page,errors}=await mount();try{
   const connect=page.getByRole('button',{name:'添加并连接 / 更新连接',exact:true});assert.equal(await connect.isDisabled(),true)
   await page.getByText('以下认证任选一项填写；仅发送已填写的请求头。',{exact:true}).waitFor()
   await page.getByLabel('X-API-Key',{exact:true}).fill('test-private-value');assert.equal(await connect.isEnabled(),true)
   await page.getByText('audit.events.list',{exact:true}).waitFor();await page.getByText('mcp__audit__audit_events_list_123456789abc',{exact:true}).waitFor();await page.getByText('检索审计事件，query 是查询正文',{exact:true}).waitFor()
   await page.getByText('查看输入参数与服务声明',{exact:true}).click();assert.match(await page.locator('fieldset pre').first().innerText(),/query/);assert.match(await page.locator('fieldset pre').last().innerText(),/readOnlyHint/)
   assert.equal(await page.getByRole('checkbox').isChecked(),false,'远端只读声明不自动勾选')
   await page.getByRole('checkbox').check();await connect.click();await page.getByText('已连接，发现 1 个工具',{exact:true}).waitFor()
   const calls=await page.evaluate(()=>(window as any).fixture.calls),update=calls.find((row:any)=>row.operation==='update'),authorize=calls.find((row:any)=>row.operation==='authorize')
   assert.equal(update.input.id,'11111111-1111-4111-8111-111111111111');assert.equal(update.input.expectedDefinitionHash,'a'.repeat(64));assert.deepEqual(authorize.input.credentials,{'X-API-Key':'test-private-value'});assert.deepEqual(authorize.input.readOnlyTools,['audit.events.list'])
   assert.equal(await page.getByLabel('X-API-Key',{exact:true}).inputValue(),'');assert.ok(calls.some((row:any)=>row.operation==='apply'))
   if(process.env.TELOA_TEST_SCREENSHOT)await page.screenshot({path:process.env.TELOA_TEST_SCREENSHOT,fullPage:true})
   assert.deepEqual(errors,[])
  }finally{await page.close()}
 })
 await t.test('并行修改先报冲突，重新读取后可核对再连接，认证错误给安全原因',async()=>{
  const {page,errors}=await mount();try{
   await page.evaluate(()=>(window as any).fixture.externalChange());await page.getByLabel('X-API-Key',{exact:true}).fill('test-value')
   await page.getByRole('button',{name:'添加并连接 / 更新连接',exact:true}).click();await page.getByRole('alert').waitFor()
   assert.equal((await page.evaluate(()=>(window as any).fixture.calls)).some((row:any)=>row.operation==='update'),false)
   await page.getByRole('button',{name:'重新读取',exact:true}).click();await page.getByRole('alert').waitFor({state:'hidden'})
   assert.equal(await page.getByLabel('X-API-Key',{exact:true}).inputValue(),'')
   await page.evaluate(()=>(window as any).fixture.failConnect(true));await page.getByLabel('X-API-Key',{exact:true}).fill('test-value')
   await page.getByRole('button',{name:'添加并连接 / 更新连接',exact:true}).click();await page.getByRole('alert').waitFor();assert.match(await page.getByRole('alert').innerText(),/401\/403.*请求头名称.*前缀/);assert.doesNotMatch(await page.locator('main').innerText(),/SECRET_MUST_NOT_RENDER/)
   assert.deepEqual(errors,[])
  }finally{await page.close()}
 })
 await t.test('窄屏表单和参数详情保留可读宽度',async()=>{
  const {page,errors}=await mount();try{
   await page.setViewportSize({width:390,height:844})
   await page.getByText('查看输入参数与服务声明',{exact:true}).click()
   assert.ok(await page.locator('form').evaluate((node:HTMLElement)=>node.scrollWidth<=node.clientWidth+1))
   assert.equal(await page.getByLabel('X-API-Key',{exact:true}).isVisible(),true)
   if(process.env.TELOA_TEST_SCREENSHOT)await page.screenshot({path:process.env.TELOA_TEST_SCREENSHOT.replace(/\.png$/, '-mobile.png'),fullPage:true})
   assert.deepEqual(errors,[])
  }finally{await page.close()}
 })
})

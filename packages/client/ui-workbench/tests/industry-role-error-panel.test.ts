import {test,before,after} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 既有独立无界面浏览器夹具。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'
const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
let browser:any,script:string,temp:string
const entry=`
import React from 'react';import {createRoot} from 'react-dom/client';import {SavedIndustryDirectory} from '${client}SavedIndustryDirectory.tsx';import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';import {localizeWorkError} from '${client}i18n/errors.ts';import {recoveryStorageError} from '${client}recovery-error.ts';
const empty={items:[],error:undefined,partial:false,pending:undefined,recoveryError:undefined,refresh:async()=>{},instantiate:async()=>{throw Error('not used')},recover:async()=>{throw Error('not used')}};
const load={id:'11111111-1111-4111-8111-111111111111',ownerId:'local:teloa-owner',contentId:'22222222-2222-4222-8222-222222222222',contentHash:'a'.repeat(64),templateId:'teloa.example',templateVersion:'1.0.0',templateTitle:'原方案',domain:'general',description:'同事目录错误夹具',targetVersion:1,space:{id:'33333333-3333-4333-8333-333333333333',name:'本人业务',version:1,scope:'general'},items:[],relations:[],entrypoints:[],createdAt:'2026-09-30T00:00:00.000Z',mappingHash:'b'.repeat(64),status:'active'};
const fixture=window.roleErrorFixture={refreshes:0},app=createRoot(document.getElementById('root'));
fixture.render=(locale='zh-CN',recover=false)=>{const snapshot={locale,dshLocale:locale,revision:1},runtime={t:(key,params)=>translateMessage(locale,key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};const props={loads:[load],error:undefined,refresh:async()=>{},openMarket:()=>{},nativeSettings:()=>{},knowledge:{...empty},dataSources:{...empty},executionTools:{...empty},mcpConnections:{...empty},plugins:{...empty},roles:{...empty,error:localizeWorkError(locale,{code:'teloa/forbidden',message:'HOST_SECRET_NOT_FOR_UI'}),recoveryError:recover?recoveryStorageError():undefined,refresh:async()=>{fixture.refreshes++},open:async()=>{}},tasks:{api:{},pending:false,recoveryError:undefined},plans:{api:{},pending:false,recoveryError:undefined},unload:{pending:false,recoveryError:undefined},skillInstallApi:{}};app.render(<I18nProvider runtime={runtime}><SavedIndustryDirectory {...props}/></I18nProvider>)};fixture.render();
`
before(async()=>{temp=await mkdtemp(join(root,'.runtime-industry-role-errors-'));await writeFile(join(temp,'fixture.tsx'),entry);const result=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'IndustryRoleErrors',formats:['iife']}}});const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle);script=bundle.output.find(item=>item.type==='chunk')!.code;browser=await loadPlaywright().chromium.launch(launchOptions())})
after(async()=>{await browser?.close();if(temp)await rm(temp,{recursive:true,force:true})})
async function mount(t:any){const page=await browser.newPage(),errors:string[]=[];page.setDefaultTimeout(6000);page.on('pageerror',(error:Error)=>errors.push(error.message));t.after(async()=>{await page.close();assert.deepEqual(errors,[])});await page.route('**/*',(route:{abort:()=>Promise<void>})=>route.abort());await page.setContent('<!doctype html><html><body><div id="root"></div></body></html>');await page.addScriptTag({content:script});await page.getByRole('alert').waitFor();return page}
test('行业同事目录直接展示调用方已本地化的明确错误，刷新仍可用',async t=>{
 const page=await mount(t)
 assert.match(await page.getByRole('alert').textContent(),/你没有执行此操作的权限/)
 assert.doesNotMatch(await page.locator('body').textContent(),/HOST_SECRET|操作未完成，请稍后/)
 await page.getByRole('alert').getByRole('button').click();assert.equal(await page.evaluate(()=>(window as any).roleErrorFixture.refreshes),1)
 await page.evaluate(()=>(window as any).roleErrorFixture.render('en'));await page.getByRole('alert').filter({hasText:'You do not have permission to perform this action.'}).waitFor()
 assert.doesNotMatch(await page.locator('body').textContent(),/HOST_SECRET|The operation did not finish/)
})
test('行业同事恢复错误仍按结构化code翻译，优先于目录的已翻译string',async t=>{
 const page=await mount(t);await page.evaluate(()=>(window as any).roleErrorFixture.render('en',true))
 await page.getByRole('alert').filter({hasText:'Cannot read the recovery record in this browser. Reload and try again.'}).waitFor()
 assert.doesNotMatch(await page.getByRole('alert').textContent(),/HOST_SECRET|You do not have permission/)
})

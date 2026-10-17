import test from 'node:test'
import assert from 'node:assert/strict'
import {fileURLToPath} from 'node:url'
import {build} from 'vite'
import {retrievalPreparationDetails} from '../../../local-embedding/src/preparation-details.ts'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
// @ts-expect-error 复用既有无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

test('本地检索在资料上下文启停：取消零写入，确认不下载，关闭重开不丢资料与准备意图',async t=>{
 const details=JSON.stringify(retrievalPreparationDetails('fp32','/test/models','/test/runtime'))
 const client=fileURLToPath(new URL('../src/client/',import.meta.url))
 const entry=`import React from 'react';import {createRoot} from 'react-dom/client';import {LocalRetrievalResources} from '${client}LocalRetrievalResources.tsx';import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';import {ThemePresenter} from '${client}theme-presenter.ts';
 new ThemePresenter().apply({active:{colorScheme:'light',tokens:{}},fontSizes:{text:14}});
 let enabled=false;const calls=[];window.retrievalEntry={calls,phase:phase=>provider.preparation={phase}};
 const status={items:[],enrolled:0,chunks:0,building:false};
 const provider={id:'qwen3-embedding-0.6b',location:'host-local',catalogId:'teloa.model.qwen3-embedding-0-6b',catalogVersion:'1.0.0',profileHash:'a'.repeat(64),variant:'fp32',totalMemoryBytes:16*1024**3,memoryRisk:false,preparation:{phase:'unprepared'},preparationDetails:${details}};
 const api={status:async()=>status,modelStatus:async()=>({enabled,provider:enabled?provider:null,building:false,guidance:null}),prepare:async()=>{calls.push('prepare');throw Error('不得自动下载')},cancelPreparation:async()=>{calls.push('cancel');provider.preparation={phase:'unprepared'};return {enabled,provider,building:false,guidance:null}},enroll:async(sourceId)=>{calls.push('enroll:'+sourceId);return status}};
 const row=()=>({id:'local-embedding',packageName:'@teloa/local-embedding',version:'0.2.0-alpha.8',state:enabled?'active':'available',configuredChannels:0});
 const activationApi={list:async()=>[row()],set:async(id,value)=>{calls.push('set:'+value);enabled=value;return row()}};
 const resource={id:'own-file',sourceId:'own-source',title:'本人资料',status:'active'};
 const snapshot={locale:'zh-CN',dshLocale:'zh',revision:1};const runtime={t:(key,params)=>translateMessage('zh-CN',key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};
 function App(){const [selected,setSelected]=React.useState(resource);window.retrievalEntry.other=()=>setSelected({id:'other-file',sourceId:'other-source',title:'另一份资料',status:'active'});return <LocalRetrievalResources api={api} activationApi={activationApi} resource={selected} visible/>}createRoot(document.getElementById('root')).render(<I18nProvider runtime={runtime}><App/></I18nProvider>);`
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),temp=await mkdtemp(join(root,'.tmp-retrieval-entry-'));t.after(()=>rm(temp,{recursive:true,force:true}));const id=join(temp,'entry.tsx');await writeFile(id,entry)
 const result=await build({configFile:false,root,plugins:[{name:'forbid-host-crypto',enforce:'pre',resolveId(id){if(id==='node:crypto')return '\0forbid-host-crypto'},load(id){if(id==='\0forbid-host-crypto')return "function blocked(){throw Error('浏览器不得执行宿主摘要算法')} export {blocked as createHash,blocked as createPublicKey,blocked as verify}"}}],logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,lib:{entry:id,name:'RetrievalEntry',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 const script=bundle.output.find(row=>row.type==='chunk')!.code,style=bundle.output.filter(row=>row.type==='asset'&&row.fileName.endsWith('.css')).map(row=>String((row as any).source)).join('\n')
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close());t.signal.addEventListener('abort',()=>void browser.close().catch(()=>{}),{once:true})
 const page=await browser.newPage({viewport:{width:1280,height:900}});page.setDefaultTimeout(6000)
 const errors:string[]=[],requests:string[]=[];page.on('pageerror',(error:Error)=>{errors.push(error.message);console.error(error.message)});await page.route('**/*',(route:any)=>{requests.push(route.request().url());return route.abort()})
 await page.setContent('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>body{margin:24px}*{box-sizing:border-box}'+style+'</style><body><div id="root"></div><script>'+script.replace(/<\/script/gi,'<\\/script')+'</script>')
 const open=async()=>{await page.locator('[data-retrieval-more]>summary').click();await page.getByRole('button',{name:'检索设置',exact:true}).click()}
 await page.getByRole('button',{name:/加入.*本人资料|本人资料.*加入/}).click();const drawer=page.getByRole('dialog',{name:'本地检索',exact:true});await drawer.waitFor()
 assert.equal(await drawer.getByText('官方扩展',{exact:true}).count(),0)
 assert.doesNotMatch(await drawer.innerText(),/市场|插件|重启/)
 await drawer.getByRole('button',{name:'启用',exact:true}).click();assert.deepEqual(await page.evaluate(()=>(window as any).retrievalEntry.calls),[])
 assert.match(await drawer.innerText(),/不会下载/)
 await drawer.getByRole('button',{name:'取消',exact:true}).click();assert.deepEqual(await page.evaluate(()=>(window as any).retrievalEntry.calls),[])
 await drawer.getByRole('button',{name:'启用',exact:true}).click();await drawer.getByRole('button',{name:'确认',exact:true}).click();await drawer.getByRole('button',{name:'停用',exact:true}).waitFor()
 assert.deepEqual(await page.evaluate(()=>(window as any).retrievalEntry.calls),['set:true'])
 // 明确取消下载确认会放弃原资料意图，模型后来就绪也不能偷加。
 await drawer.getByRole('button',{name:'取消',exact:true}).click();assert.equal(await drawer.count(),0)
 await page.evaluate(()=>(window as any).retrievalEntry.phase('ready'));await open();await drawer.waitFor()
 assert.deepEqual(await page.evaluate(()=>(window as any).retrievalEntry.calls),['set:true'])
 await drawer.getByRole('button',{name:'关闭',exact:true}).click()
 // 有意图但尚无请求时不冒充“处理中”；关闭不停止原资料的后台续办。
 await page.evaluate(()=>(window as any).retrievalEntry.phase('checking'))
 await page.getByRole('button',{name:/加入.*本人资料|本人资料.*加入/}).click();await drawer.waitFor()
 await drawer.getByRole('button',{name:'关闭',exact:true}).click()
 await page.getByText('待加入：本人资料',{exact:true}).waitFor()
 await page.evaluate(()=>(window as any).retrievalEntry.other())
 assert.equal(await page.getByRole('button',{name:/加入.*另一份资料|另一份资料.*加入/}).isEnabled(),false)
 await page.evaluate(()=>(window as any).retrievalEntry.phase('ready'))
 await page.waitForFunction(()=>(window as any).retrievalEntry.calls.includes('enroll:own-source'))
 assert.deepEqual(await page.evaluate(()=>(window as any).retrievalEntry.calls),['set:true','enroll:own-source'])
 // 取消准备清理新的 B 意图；之后查看设置不再加入 B。
 await page.evaluate(()=>(window as any).retrievalEntry.phase('checking'))
 await page.getByRole('button',{name:/加入.*另一份资料|另一份资料.*加入/}).click();await drawer.waitFor()
 await drawer.getByRole('button',{name:'取消准备',exact:true}).click();await drawer.waitFor({state:'detached'})
 await page.evaluate(()=>(window as any).retrievalEntry.phase('ready'));await open();await drawer.waitFor()
 assert.deepEqual(await page.evaluate(()=>(window as any).retrievalEntry.calls),['set:true','enroll:own-source','cancel'])
 assert.deepEqual(errors,[]);assert.deepEqual(requests,[])
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
})

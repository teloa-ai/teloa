import assert from 'node:assert/strict'
import {test,before,after} from 'node:test'
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 既有无界面浏览器加载夹具为 MJS 模块。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'
// @ts-expect-error 完整协议夹具为 MJS 模块。
import {typedConfigurationFixture} from './fixtures/business-typed-view.mjs'

// 实际配置 React/CSS 和契约读取器；数据为协议夹具，不启动 PG 或真实宿主。
const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
const {chromium}=loadPlaywright()
let browser:any,script:string,styles:string,temp:string
const entry=`
import React from 'react';import {createRoot} from 'react-dom/client';
import {readBusinessConfigurationPageProjectionVersioned} from '@teloa/contract';
import {BusinessConfigurationPage} from '${client}BusinessConfigurationPage.tsx';
import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';
const locale=document.documentElement.lang,snapshot={locale,dshLocale:locale==='en'?'en':'zh',revision:1};
const runtime={t:(key,params)=>translateMessage(locale,key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};
const original=${JSON.stringify(typedConfigurationFixture())};
const state=window.typedFixture={go:[],calls:[]},root=createRoot(document.getElementById('root'));
const trap=new Proxy({},{get(){state.calls.push('flow-access');throw Error('preview must not access flow')}});
state.render=(mode='preview',corrupt=false)=>{
 const projection=structuredClone(original);
 if(mode==='saved'){projection.mode='saved';projection.configurationVersion=1;delete projection.draftId;delete projection.revision}
 readBusinessConfigurationPageProjectionVersioned(projection);
 if(corrupt)projection.page.results[1].view.rows[0].values[0].decimal='NaN';
 root.render(<I18nProvider runtime={runtime}><BusinessConfigurationPage projection={projection} colorScheme="light" recordFlow={trap} go={target=>state.go.push(target)}/></I18nProvider>);
};state.render();
`
before(async()=>{
 await mkdir(join(client,'../../.runtime'),{recursive:true});temp=await mkdtemp(join(client,'../../.runtime/typed-view-renderer-'))
 await writeFile(join(temp,'fixture.tsx'),entry)
 const result=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'TypedRendererFixture',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 script=bundle.output.find(item=>item.type==='chunk')!.code
 styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 browser=await chromium.launch(launchOptions());await mkdir('/tmp/teloa-typed-view-renderer',{recursive:true})
})
after(async()=>{await browser?.close();if(temp)await rm(temp,{recursive:true,force:true})})
async function fixture(t:any,locale:string,width:number){
 const page=await browser.newPage({viewport:{width,height:960},timezoneId:'America/Los_Angeles'});page.setDefaultTimeout(8000)
 const errors:string[]=[],requests:string[]=[]
 page.on('pageerror',(error:Error)=>errors.push(error.message));await page.route('**/*',(route:any)=>{requests.push(route.request().url());return route.abort()})
 t.after(async()=>{await page.close();assert.deepEqual(errors,[]);assert.deepEqual(requests,[])})
 await page.setContent('<!doctype html><html lang="'+locale+'"><body><main id="root"></main></body></html>')
 await page.addStyleTag({content:':root{--teloa-font-section:18px;--teloa-font-body:14px;--teloa-font-caption:12px;--teloa-font-control:14px;--teloa-font-metric:28px;--teloa-weight-heading:600;--teloa-weight-medium:500;--teloa-leading-label:1.5;--teloa-border:#ddd;--teloa-surface:#fff;--teloa-subtle:#f5f5f2;--teloa-text:#252823;--teloa-muted:#646a62;--teloa-warn-bg:#fff5d9;--teloa-accent:#9e4226}body{font-family:system-ui;margin:16px;color:var(--teloa-text)}'+styles})
 await page.addScriptTag({content:script});await page.locator('[data-typed-view="table"]').waitFor()
 return page
}
for(const locale of ['zh-CN','en'])for(const width of [390,1400])test(locale+'/'+width+' 实际配置页渲染五种类型化画法、精确金额和统计口径，十二列布局无页面溢出',async t=>{
 const page=await fixture(t,locale,width)
 for(const chart of ['number','table','bar','pie','line'])assert.equal(await page.locator('[data-typed-view="'+chart+'"]').count(),1)
 assert.equal(await page.locator('[data-typed-view="pie"] svg').count(),1)
 const trendLabels=await page.locator('[data-typed-view="line"] tbody th').allTextContents()
 assert.deepEqual(trendLabels,locale==='en'?['September 29, 2026','September 30, 2026','October 1, 2026']:['2026年9月29日','2026年9月30日','2026年10月1日'])
 const table=page.locator('[data-typed-view="table"] table')
 assert.match(await table.innerText(),/CNY 9,007,199,254,740,993\.0001/)
 assert.match(await table.innerText(),/CNY -9,999,999,999,999,999,999,999\.9999/)
 assert.match(await table.innerText(),/USD -0\.0001/)
 assert.equal(await table.getByRole('cell',{name:'CNY 0',exact:true}).count(),1)
 assert.equal(await table.getByRole('cell',{name:'—',exact:true}).count(),1)
 assert.match(await page.locator('[data-typed-view="table"] [data-typed-membership]').innerText(),locale==='en'?/multiple labels/:/同一记录可计入多个标签/)
 assert.match(await page.locator('[data-typed-view="table"] [data-typed-rounding]').innerText(),/half-even/)
 assert.equal(await page.locator('[data-view-truncated]').count(),5)
 assert.equal(await page.locator('[data-rows-truncated]').count(),4)
 assert.equal(await page.locator('[data-view-missing]').count(),5)
 assert.equal(await page.locator('img,script[src],button,[data-drilldown]').count(),0)
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
 const columns=await page.locator('[data-widget]').evaluateAll((nodes:HTMLElement[])=>nodes.map(node=>Math.round(node.getBoundingClientRect().left)))
 assert.equal(new Set(columns).size,width===390?1:2)
 assert.deepEqual(await page.evaluate(()=>(window as any).typedFixture.calls),[])
 assert.deepEqual(await page.evaluate(()=>(window as any).typedFixture.go),[])
 await page.screenshot({path:'/tmp/teloa-typed-view-renderer/'+locale+'-'+width+'.png',fullPage:true})
 await page.evaluate(()=>(window as any).typedFixture.render('saved'))
 assert.match(await table.innerText(),/9,007,199,254,740,993\.0001/)
 assert.equal(await page.getByRole('button').count(),0)
 assert.deepEqual(await page.evaluate(()=>(window as any).typedFixture.go),[])
})
test('实际组件拒绝损坏结果：保留错误提示并收回该表格，其余图形正常',async t=>{
 const page=await fixture(t,'zh-CN',390)
 await page.evaluate(()=>(window as any).typedFixture.render('preview',true))
 await page.locator('[data-widget="widget-table"] [data-widget-failed]').waitFor()
 assert.equal(await page.locator('[data-widget="widget-table"] table').count(),0)
 assert.equal(await page.locator('[data-typed-view="bar"] table').count(),1)
})

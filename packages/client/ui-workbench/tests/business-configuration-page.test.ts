import assert from 'node:assert/strict'
import {test,before,after} from 'node:test'
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 既有测试浏览器夹具为无声明的 MJS 模块。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'

// 实际 React/CSS/绘图组件；只替换 records API，浏览器禁止网络和有界面窗口。
const root=fileURLToPath(new URL('../../../../',import.meta.url))
const client=fileURLToPath(new URL('../src/client/',import.meta.url))
const {chromium}=loadPlaywright()
let browser:any,script:string,styles:string,temp:string
const entry=`
import React from 'react';
import {createRoot} from 'react-dom/client';
import {readBusinessConfigurationPageProjection} from '@teloa/contract';
import {BusinessConfigurationPage} from '${client}BusinessConfigurationPage.tsx';
import {BusinessRecordFlow} from '${client}business-record-flow.ts';
import {I18nProvider} from '${client}i18n/provider.tsx';
import {translateMessage} from '${client}i18n/messages.ts';
const locale=document.documentElement.lang;
const loc=(original,en)=>({original,defaultLocale:'zh-CN',locales:{en}});
const runtime={t:(key,params)=>translateMessage(locale,key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};
const snapshot={locale,dshLocale:locale==='en'?'en':'zh',revision:1};
const state=window.rendererFixture={calls:[],go:[],mode:'preview'};
const objectType={format:'teloa.business-object-type/v1',id:'order',version:'1.0.0',domain:'sales',title:'订单',unit:'单',lead:'从第一条记录开始',localized:{lead:loc('从第一条记录开始','Start with your first record')},sourceId:'local',fields:[{name:'done',label:'完成',from:'完成',type:'boolean',required:false},{name:'at',label:'日期',from:'日期',type:'datetime',required:false}]};
const kinds=[['board-card','number'],['distribution','pie'],['trend','line'],['distribution','bar'],['distribution','table']];
const names=[['订单总数','Order count'],['完成比例','Completion ratio'],['每日趋势','Daily trend'],['完成分布','Completion breakdown'],['完成明细','Completion details']];
const viewRefs=kinds.map(([kind,chart],index)=>({objectType,view:{format:'teloa.business-view/v1',id:'view-'+index,version:'1.0.0',domain:'sales',objectType:'order',title:names[index][0],kind,chart,...(index===0?{}:{dimension:{field:index===2?'at':'done',limit:20,...(index===2?{bucket:'day'}:{})},sort:{by:'dimension',direction:'asc'}}),measures:[{id:'count',label:'数量',localized:{label:loc('数量','Count')},aggregation:'count'}],filters:[],limit:index===0?1:20}}));
const widgets=kinds.map((_,index)=>({format:'teloa.business-widget/v1',id:'widget-'+index,version:'1.0.0',domain:'sales',title:names[index][0],localized:{title:loc(...names[index])},kind:'view-ref',viewRef:'view-'+index}));
const results=widgets.map((widget,index)=>({widgetId:widget.id,definitionHash:'a'.repeat(64),computedAt:'2026-09-29T00:00:00.000Z',status:'ok',columns:[{name:'dimension',type:'text'},{name:'label',type:'text'},{name:'count',type:'number'}],rows:index===0?[['all','all',5]]:index===2?[['2026-09-28','2026-09-28',3],['2026-09-29','2026-09-29',5]]:[['true','true',3],['false','false',2]],rowCount:index===0?1:2,truncated:false,bytes:1,stale:false}));
widgets.push({format:'teloa.business-widget/v1',id:'total',version:'1.0.0',domain:'sales',title:'所有订单',localized:{title:loc('所有订单','All orders')},kind:'metric',query:'select count(*) as n from orders',metric:{valueColumn:'n'},drilldown:{objectType:'order'}});
results.push({...results[0],widgetId:'total',columns:[{name:'n',type:'number'}],rows:[[5]],rowCount:1});
const dashboard={format:'teloa.business-dashboard/v1',id:'overview',version:'1.0.0',domain:'sales',title:'订单总览',localized:{title:loc('订单总览','Order overview')},widgets:widgets.map(w=>w.id),layout:widgets.map((w,index)=>({widget:w.id,x:index%2*6,y:Math.floor(index/2)*2,w:6,h:2})),refresh:{kind:'every',seconds:300},acknowledgeShortInterval:false};
const base={scope:'sales',configurationHash:'b'.repeat(64),mode:'preview',draftId:'00000000-0000-4000-8000-000000000001',revision:1};
const dashboardProjection={...base,page:{kind:'dashboard',definition:{id:'overview',kind:'dashboard',title:'订单总览',dashboardId:'overview'},dashboard,widgets,results,viewRefs,timeRange:'all'}};
const recordsProjection={...base,page:{kind:'records',definition:{id:'orders',kind:'records',title:locale==='en'?'Orders':'订单',objectType:'order',fields:['done'],allowCreate:true,allowEdit:true,allowArchive:true},objectType,emptyState:'no-records'}};
readBusinessConfigurationPageProjection(dashboardProjection);
readBusinessConfigurationPageProjection(recordsProjection);
const flow=new BusinessRecordFlow({list:async(input)=>{state.calls.push(['list',input]);return {sourceId:'local',items:[]}},get:async()=>{state.calls.push(['get']);throw Error('unexpected read')},create:async()=>{state.calls.push(['create']);throw Error('unexpected write')},edit:async()=>{state.calls.push(['edit']);throw Error('unexpected write')},archive:async()=>{state.calls.push(['archive']);throw Error('unexpected write')}});
const trap=new Proxy(flow,{get(){state.calls.push(['preview-flow-access']);throw Error('preview must not access flow')}});
const app=createRoot(document.getElementById('root'));
state.render=(mode='preview',missing=false)=>{
 state.mode=mode;
 const identity=mode==='preview'?{mode,draftId:'00000000-0000-4000-8000-000000000001',revision:1}:{mode:'saved',configurationVersion:1};
 const projection={scope:base.scope,configurationHash:base.configurationHash,...identity,page:{...dashboardProjection.page,viewRefs:missing?[]:viewRefs}};
 app.render(<I18nProvider runtime={runtime}><main><BusinessConfigurationPage projection={projection} colorScheme="light" go={target=>state.go.push(target)}/><BusinessConfigurationPage projection={{scope:base.scope,configurationHash:base.configurationHash,page:recordsProjection.page,...identity}} colorScheme="light" recordFlow={mode==='preview'?trap:flow} capabilities={{create:true,edit:true,archive:true}}/></main></I18nProvider>);
};
state.render();
`
before(async()=>{
 await mkdir(join(client,'../../.runtime'),{recursive:true})
 temp=await mkdtemp(join(client,'../../.runtime/task5-renderer-'))
 await writeFile(join(temp,'fixture.tsx'),entry)
 const result=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'RendererFixture',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result
 assert.ok(bundle&&'output' in bundle)
 const output=bundle.output
 script=output.find(item=>item.type==='chunk')!.code
 styles=output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 browser=await chromium.launch(launchOptions())
 await mkdir('/tmp/teloa-task5-renderer',{recursive:true})
})
after(async()=>{await browser?.close();if(temp)await rm(temp,{recursive:true,force:true})})
async function fixture(t:any,locale='zh-CN',width=1400){
 const page=await browser.newPage({viewport:{width,height:960}})
 page.setDefaultTimeout(8000)
 const errors:string[]=[],requests:string[]=[]
 page.on('pageerror',(error:Error)=>errors.push(error.message))

 await page.route('**/*',(route:any)=>{requests.push(route.request().url());return route.abort()})
 t.after(async()=>{await page.close();assert.deepEqual(errors,[]);assert.deepEqual(requests,[])})
 await page.setContent('<!doctype html><html lang="'+locale+'"><body><div id="root"></div></body></html>')
 await page.addStyleTag({content:':root{--teloa-font-section:18px;--teloa-font-body:14px;--teloa-font-caption:12px;--teloa-font-control:14px;--teloa-weight-heading:600;--teloa-weight-medium:500;--teloa-leading-label:1.5;--teloa-leading-heading:1.4;--teloa-border:#ddd;--teloa-surface:#fff;--teloa-subtle:#f5f5f2;--teloa-text:#252823;--teloa-muted:#646a62;--teloa-warn-bg:#fff5d9;--teloa-focus:#4076db;--teloa-accent:#9e4226}body{font-family:system-ui;margin:16px;color:var(--teloa-text)}'+styles})
 await page.addScriptTag({content:script})
 await page.locator('[data-view-pie]').waitFor()
 return page
}
for(const locale of ['zh-CN','en'])for(const width of [390,1400])test(locale+'/'+width+' 真实配置页面：五种绘图、布尔和度量本地化；预览零调用、零导航和零写入',async t=>{
 const page=await fixture(t,locale,width)
 for(const marker of ['board-card','pie','trend','distribution','table'])assert.equal(await page.locator('[data-view-'+marker+']').count(),1)
 assert.match(await page.locator('[data-view-table]').innerText(),locale==='en'?/Yes/:/是/)
 assert.match(await page.locator('[data-view-table]').innerText(),locale==='en'?/No/:/否/)
 assert.match(await page.locator('[data-view-table]').innerText(),locale==='en'?/Count/:/数量/)
 assert.equal(await page.getByRole('button').count(),0)
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
 assert.deepEqual(await page.evaluate(()=>({calls:(window as any).rendererFixture.calls,go:(window as any).rendererFixture.go})),{calls:[],go:[]})
 const columns=await page.locator('[data-widget]').evaluateAll((nodes:HTMLElement[])=>nodes.map(node=>Math.round(node.getBoundingClientRect().left)))
 assert.equal(new Set(columns).size,width===390?1:2)
 await page.screenshot({path:'/tmp/teloa-task5-renderer/'+locale+'-'+width+'.png',fullPage:true})
})

test('正式页复用同一绘图并按需传入导航/记录 flow；配置元数据缺失明确失败',async t=>{
 const page=await fixture(t)
 const preview=await page.locator('[data-view-pie]').innerHTML()
 await page.evaluate(()=>(window as any).rendererFixture.render('saved'))
 await page.waitForFunction(()=>(window as any).rendererFixture.calls.length>0)
 assert.equal(await page.locator('[data-view-pie]').innerHTML(),preview)
 assert.deepEqual(await page.evaluate(()=>(window as any).rendererFixture.calls),[['list',{scope:'sales',type:'order',limit:20}]])
 await page.locator('[data-widget=total]').locator('button').click()
 assert.deepEqual(await page.evaluate(()=>(window as any).rendererFixture.go),[{scope:'sales',section:'data',objectType:'order'}])
 await page.evaluate(()=>(window as any).rendererFixture.render('preview',true))
 await page.locator('[data-widget] [role="alert"]').first().waitFor()
 assert.equal(await page.locator('[data-view-table]').count(),0)
 assert.equal(await page.locator('[data-view-pie]').count(),0)
 assert.equal(await page.getByRole('button').count(),0)
 assert.equal(await page.evaluate(()=>(window as any).rendererFixture.calls.length),1)
})

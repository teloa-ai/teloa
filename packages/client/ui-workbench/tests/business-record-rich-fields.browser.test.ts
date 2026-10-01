import assert from 'node:assert/strict'
import {test,before,after} from 'node:test'
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 既有测试浏览器夹具为无声明的 MJS 模块。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'

// 实际组件与 CSS，API 为隔离夹具；禁止联网和有界面浏览器，不声称真实宿主验收。
const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
const {chromium}=loadPlaywright()
let browser:any,script:string,styles:string,temp:string
const entry=`
import React from 'react';import {createRoot} from 'react-dom/client';
import {readBusinessConfigurationPageProjectionVersioned} from '@teloa/contract';
import {BusinessConfigurationPage} from '${client}BusinessConfigurationPage.tsx';
import {BusinessRecordFlow} from '${client}business-record-flow.ts';
import {createBusinessRecordApi} from '${client}business-record-api.ts';
import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';
const locale=document.documentElement.lang,en=locale==='en',snapshot={locale,dshLocale:en?'en':'zh',revision:1};
const runtime={t:(key,params)=>translateMessage(locale,key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};
const state=window.richFixture={calls:[],mode:'preview',offline:false},hash='a'.repeat(64),stamp='2026-09-30T00:00:00.000Z';
let objectType={format:'teloa.business-object-type/v2',id:'customer',version:'1.0.0',domain:'sales',title:en?'Customer':'客户',unit:en?'people':'位',lead:en?'Customer follow-up':'跟进客户',sourceId:'records',fields:[{format:'teloa.business-rich-field/v2',name:'amount',label:en?'Amount':'金额',from:'原金额',type:'money',required:false,currencies:['CNY','USD']},{format:'teloa.business-rich-field/v2',name:'tags',label:en?'Focus':'方向',from:'原方向',type:'multi-enum',required:true,values:en?['Cloud security','Application security','Compliance']:['云安全','应用安全','合规']}]};
const definition={id:'customers',title:en?'Customers':'客户记录',kind:'records',objectType:'customer',fields:['amount','tags'],allowCreate:true,allowEdit:true,allowArchive:true};
let rows=[],latest;const versions=new Map();let sequence=0;
const api=createBusinessRecordApi(async(endpoint,input)=>{
 state.calls.push([endpoint,input]);
 if(endpoint.endsWith('/create')&&state.offline)throw Error('offline');
 if(endpoint.endsWith('/list'))return {schema:'teloa.business-data-page/v1',sourceId:'records',capturedAt:stamp,items:rows};
 if(endpoint.endsWith('/get'))return input.version?versions.get(input.version):latest;
 if(endpoint.endsWith('/archive')){latest={...latest,version:input.expectedVersion+1,deletedAt:stamp};rows=[];versions.set(latest.version,latest);return latest}
 if(endpoint.endsWith('/create')||endpoint.endsWith('/edit')){latest={scope:'sales',type:'customer',id:'customer-one',version:input.expectedVersion?input.expectedVersion+1:1,snapshotHash:hash,title:input.title,summary:input.summary,source:'本地记录',observedAt:stamp,receivedAt:stamp,quality:'complete',fields:input.fields.filter(f=>f.value!=='').map(f=>({label:objectType.fields.find(field=>field.name===f.name).from,value:f.value}))};rows=[latest];versions.set(latest.version,latest);return latest}
 throw Error('unexpected record endpoint');
});
const flow=new BusinessRecordFlow(api,()=> '11111111-1111-4111-8111-'+String(++sequence).padStart(12,'0'));
const trap=new Proxy(flow,{get(){state.calls.push(['preview-access']);throw Error('preview cannot access records flow')}}),app=createRoot(document.getElementById('root'));
state.render=(mode='preview')=>{state.mode=mode;const projection=readBusinessConfigurationPageProjectionVersioned({format:'teloa.business-configuration-page/v2',mode,scope:'sales',configurationHash:hash,page:{kind:'records',definition,objectType,emptyState:'no-records'},...(mode==='preview'?{draftId:'11111111-1111-4111-8111-111111111111',revision:1}:{configurationVersion:1})});app.render(<I18nProvider runtime={runtime}><BusinessConfigurationPage projection={projection} recordFlow={mode==='preview'?trap:flow} capabilities={{create:true,edit:true,archive:true}} colorScheme="light"/></I18nProvider>)};
state.changeCurrencies=currencies=>{objectType={...objectType,fields:objectType.fields.map(field=>field.type==='money'?{...field,currencies}:field)};state.render('saved')};state.render();
state.changeOptions=values=>{objectType={...objectType,fields:objectType.fields.map(field=>field.type==='multi-enum'?{...field,values}:field)};state.render('saved')};
`
before(async()=>{
 await mkdir(join(client,'../../.runtime'),{recursive:true});temp=await mkdtemp(join(client,'../../.runtime/rich-record-ui-'));await writeFile(join(temp,'fixture.tsx'),entry)
 const result=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'RichRecordFixture',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 script=bundle.output.find(item=>item.type==='chunk')!.code;styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 browser=await chromium.launch(launchOptions())
})
test('多选值超过规范串长度时保留合法选择并提示，不抛事件异常或发送越界值',async t=>{
 const page=await browser.newPage({viewport:{width:390,height:1000}}),errors:string[]=[]
 page.setDefaultTimeout(5000);page.on('pageerror',(error:Error)=>errors.push(error.message));await page.route('**/*',(route:any)=>route.abort())
 t.after(async()=>{await page.close();assert.deepEqual(errors,[])})
 await page.setContent('<!doctype html><html lang="zh-CN"><body><div id="root"></div></body></html>');await page.addStyleTag({content:styles});await page.addScriptTag({content:script})
 const values=Array.from({length:32},(_,index)=>String(index).padStart(2,'0')+'x'.repeat(78))
 await page.evaluate((values:string[])=>(window as any).richFixture.changeOptions(values),values)
 await page.getByRole('button',{name:'新增第一条',exact:true}).click();await page.getByRole('textbox',{name:/^记录标题/}).fill('长多选记录')
 for(const name of values.slice(0,24))await page.getByRole('checkbox',{name,exact:true}).check()
 await page.getByRole('checkbox',{name:values[24],exact:true}).click()
 await page.getByRole('alert').getByText('所选内容过长，请减少选择。',{exact:true}).waitFor()
 assert.equal(await page.getByRole('checkbox',{checked:true}).count(),24);assert.equal(await page.getByRole('checkbox',{name:values[24],exact:true}).isChecked(),false)
 await page.getByRole('checkbox',{name:values[0],exact:true}).uncheck();assert.equal(await page.getByRole('alert').count(),0)
 await page.getByRole('checkbox',{name:values[24],exact:true}).check();await page.getByRole('button',{name:'保存记录',exact:true}).click()
 await page.getByRole('button',{name:/长多选记录/}).waitFor()
 const writes=await page.evaluate(()=>(window as any).richFixture.calls.filter((row:any)=>row[0]==='business-records/create'))
 assert.equal(writes.length,1);assert.deepEqual(JSON.parse(writes[0][1].fields.find((field:any)=>field.name==='tags').value),values.slice(1,25))
})
after(async()=>{await browser?.close();if(temp)await rm(temp,{recursive:true,force:true})})
for(const locale of ['zh-CN','en'])for(const width of [390,1400])test(locale+'/'+width+' 富字段正式页保持精确金额、多选、历史和归档；候选不访问记录',async t=>{
 const page=await browser.newPage({viewport:{width,height:1000}});page.setDefaultTimeout(5000);const errors:string[]=[],requests:string[]=[]
 page.on('pageerror',(error:Error)=>errors.push(error.message));await page.route('**/*',(route:any)=>{requests.push(route.request().url());return route.abort()})
 t.after(async()=>{await page.close();assert.deepEqual(errors,[]);assert.deepEqual(requests,[])})
 await page.setContent('<!doctype html><html lang="'+locale+'"><body><div id="root"></div></body></html>')
 await page.addStyleTag({content:':root{--teloa-font-section:18px;--teloa-font-body:14px;--teloa-font-caption:12px;--teloa-font-control:14px;--teloa-weight-heading:600;--teloa-weight-medium:500;--teloa-leading-heading:1.4;--teloa-border:#ddd;--teloa-surface:#fff;--teloa-subtle:#f5f5f2;--teloa-text:#252823;--teloa-muted:#646a62;--teloa-accent:#9e4226;--teloa-on-accent:#fff}body{font-family:system-ui;margin:16px}'+styles})
 await page.addScriptTag({content:script});await page.getByRole('heading',{level:2}).waitFor()
 assert.deepEqual(await page.evaluate(()=>(window as any).richFixture.calls),[]);assert.equal(await page.getByRole('button').count(),0)
 await page.evaluate(()=>(window as any).richFixture.render('saved'))
 const en=locale==='en',title=en?'Precision customer':'精确金额客户',cloud=en?'Cloud security':'云安全',compliance=en?'Compliance':'合规',amount=en?'Amount':'金额'
 await page.getByRole('button',{name:en?'Add the first record':'新增第一条',exact:true}).click()
 await page.getByRole('textbox',{name:en?/^Record title/:/^记录标题/}).fill(title)
 await page.getByLabel(amount,{exact:true}).fill('9007199254740993.0100')
 // 倒序点击，保存仍按配置声明顺序编码；Space 可操作原生 checkbox。
 await page.getByRole('checkbox',{name:compliance,exact:true}).check();await page.getByRole('checkbox',{name:cloud,exact:true}).focus();await page.keyboard.press('Space')
 await page.getByRole('button',{name:en?'Save record':'保存记录',exact:true}).click()
 const record=page.getByRole('button',{name:new RegExp(title)});await record.waitFor();assert.match(await record.innerText(),/CNY 9007199254740993\.01/)
 const writes=await page.evaluate(()=>(window as any).richFixture.calls.filter((row:any)=>row[0]==='business-records/create'));assert.equal(writes.length,1)
 assert.deepEqual(writes[0][1].fields,[{name:'amount',value:'{"currency":"CNY","decimal":"9007199254740993.01"}'},{name:'tags',value:JSON.stringify([cloud,compliance])}])
 await record.click();await page.getByRole('button',{name:en?'Edit record':'编辑记录',exact:true}).click()
 assert.equal(await page.getByLabel(amount,{exact:true}).inputValue(),'9007199254740993.01')
 await page.getByRole('combobox',{name:amount+' · '+(en?'Currency':'币种')}).selectOption('USD');await page.getByLabel(amount,{exact:true}).fill('-10.5000')
 await page.getByRole('checkbox',{name:compliance,exact:true}).uncheck();await page.getByRole('button',{name:en?'Save record':'保存记录',exact:true}).click()
 await page.getByRole('button',{name:new RegExp(title+'.*USD -10\\.5')}).waitFor()
 await page.getByLabel(en?'Version number':'版本号',{exact:true}).fill('1');await page.getByRole('button',{name:en?'View previous version':'查看历史版本',exact:true}).click()
 await page.getByText(en?'Previous versions are read only.':'历史版本只供查看，不能直接修改。',{exact:true}).waitFor()
 assert.equal(await page.getByRole('button',{name:en?'Edit record':'编辑记录',exact:true}).count(),0)
 await page.getByRole('button',{name:en?'Back to current version':'返回当前版本',exact:true}).click();await page.getByRole('button',{name:en?'Archive record':'归档记录',exact:true}).click()
 await page.getByRole('form',{name:en?'Archive record':'归档记录',exact:true}).getByRole('button',{name:en?'Archive record':'归档记录',exact:true}).click();await page.getByRole('button',{name:en?'Add the first record':'新增第一条',exact:true}).waitFor()
 // 未受理且失回包时更换当前定义，控件仍必须展示原请求的币种和精确金额。
 await page.evaluate(()=>(window as any).richFixture.offline=true);await page.getByRole('button',{name:en?'Add the first record':'新增第一条',exact:true}).click()
 await page.getByRole('textbox',{name:en?/^Record title/:/^记录标题/}).fill(title+' pending');await page.getByLabel(amount,{exact:true}).fill('9007199254740993.01');await page.getByRole('checkbox',{name:cloud,exact:true}).check()
 await page.getByRole('button',{name:en?'Save record':'保存记录',exact:true}).click();await page.getByRole('button',{name:en?'Check save result':'核对保存结果',exact:true}).waitFor()
 await page.evaluate(()=>(window as any).richFixture.changeCurrencies(['USD']))
 const frozenCurrency=page.getByRole('combobox',{name:amount+' · '+(en?'Currency':'币种')});assert.equal(await frozenCurrency.inputValue(),'CNY');assert.deepEqual(await frozenCurrency.locator('option').allTextContents(),['CNY','USD']);assert.equal(await frozenCurrency.isDisabled(),true)
 assert.equal(await page.getByLabel(amount,{exact:true}).inputValue(),'9007199254740993.01');assert.equal(await page.evaluate(()=>(window as any).richFixture.calls.filter((row:any)=>row[0]==='business-records/create').length),2)
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
})

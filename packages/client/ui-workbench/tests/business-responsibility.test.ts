import assert from 'node:assert/strict'
import {test,before,after} from 'node:test'
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 既有测试浏览器夹具为无声明的 MJS 模块。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'
const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
const {chromium}=loadPlaywright()
let browser:any,script:string,styles:string,temp:string
const entry=`
import React from 'react';import {createRoot} from 'react-dom/client';
import {BusinessResponsibility} from '${client}BusinessResponsibility.tsx';
import {createBusinessResponsibilityApi} from '${client}business-responsibility-api.ts';
import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';
// about:blank 不是安全上下文；夹具只提供请求 ID，不替换生产 API/恢复逻辑。
let requestSequence=100;if(!crypto.randomUUID)crypto.randomUUID=()=> '00000000-0000-4000-8000-'+String(++requestSequence).padStart(12,'0');
const locale=document.documentElement.lang,snapshot={locale,dshLocale:locale==='en'?'en':'zh',revision:1};
const runtime={t:(key,params)=>translateMessage(locale,key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};
const ids=['00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000004'];
const f=window.responsibilityFixture={calls:[],rows:new Map(),saved:new Map(),receipts:new Map(),lost:false,offline:false,active:true,hold:false,release:null};
const empty=scope=>({scope,version:0,roleId:null,selectedRoleVersion:null,currentRoleVersion:null,availability:'none'});
const options={personalSpaceId:'00000000-0000-4000-8000-000000000099',isCurrent:()=>f.active,storage:{getItem:key=>f.rows.get(key)??null,setItem:(key,value)=>f.rows.set(key,value),removeItem:key=>f.rows.delete(key)}};
const call=async(method,input)=>{
 f.calls.push({method,input});if(f.offline)throw Error('offline');
 if(method.endsWith('/receipt'))return f.receipts.get(input.requestId)??null;
 if(method.endsWith('/set')){if(f.rejectSet)throw Object.assign(Error('version changed'),{rejected:true,code:'teloa/version-conflict'});const value={scope:input.scope,version:input.expectedVersion+1,roleId:input.role?.id??null,selectedRoleVersion:input.role?.expectedVersion??null,currentRoleVersion:input.role?.expectedVersion??null,availability:input.role?'ready':'none'};f.saved.set(input.scope,value);f.receipts.set(input.requestId,value);if(f.lost)throw Error('lost');if(f.failAfterSet)f.offline=true;return value;}
 const value=f.saved.get(input.scope)??empty(input.scope);if(f.hold){f.hold=false;await new Promise(resolve=>f.release=resolve);}return value;
};
const role=(id,name,state='active',kind='employee',scopes=['sales','support'])=>({id,name,state,kind,scopes,version:2,duty:f.longDuties?'Same duty '.repeat(12)+'Alpha':'Follow up',dataScope:id===ids[0]?'Customer follow-up':'Content follow-up',executionScope:'Prepare drafts'});
const roles={list:async()=>{if(f.holdRoles)await new Promise(resolve=>f.releaseRoles=resolve);return [role(ids[0],locale==='en'?'Mina':'小敏'),role(ids[1],'Paused','paused'),role(ids[2],'Twin','active','twin'),role(ids[3],'Wrong scope','active','employee',['hr']),...(f.duplicate?[{...role('00000000-0000-4000-8000-000000000005',locale==='en'?'Mina':'小敏'),duty:f.longDuties?'Same duty '.repeat(12)+'Beta':f.sameDuties?'Follow up':'Review deliveries'}]:[])]}};
const app=createRoot(document.getElementById('root'));let api=createBusinessResponsibilityApi(call,options);
f.render=(scope='sales',fresh=false)=>{if(fresh)api=createBusinessResponsibilityApi(call,options);app.render(<I18nProvider runtime={runtime}><BusinessResponsibility scope={scope} api={api} roles={roles}/></I18nProvider>);};
f.setStatus=(availability)=>{f.saved.set('sales',{scope:'sales',version:1,roleId:ids[0],selectedRoleVersion:2,currentRoleVersion:availability==='missing'?null:3,availability});f.render('sales',true)};
f.ids=ids;f.render();
`
before(async()=>{
 await mkdir(join(client,'../../.runtime'),{recursive:true});temp=await mkdtemp(join(client,'../../.runtime/responsibility-'));await writeFile(join(temp,'fixture.tsx'),entry)
 const result=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'ResponsibilityFixture',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 script=bundle.output.find(item=>item.type==='chunk')!.code;styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 browser=await chromium.launch(launchOptions());await mkdir('/tmp/teloa-responsibility-ui',{recursive:true})
})
after(async()=>{await browser?.close();if(temp)await rm(temp,{recursive:true,force:true})})
async function fixture(t:any,locale='zh-CN',width=1400){
 const page=await browser.newPage({viewport:{width,height:900}});page.setDefaultTimeout(2500);const errors:string[]=[],requests:string[]=[]
 page.on('pageerror',(error:Error)=>errors.push(error.message));await page.route('**/*',(route:any)=>{requests.push(route.request().url());return route.abort()})
 t.after(async()=>{await page.close();assert.deepEqual(errors,[]);assert.deepEqual(requests,[])})
 await page.setContent('<!doctype html><html lang="'+locale+'"><body><div id="root"></div></body></html>')
 await page.addStyleTag({content:':root{--teloa-text:#242823;--teloa-muted:#63695f;--teloa-border:#ddd;--teloa-surface:#fff;--teloa-subtle:#f5f5f2;--teloa-accent:#9e4226;--teloa-on-accent:#fff;--teloa-font-body:14px;--teloa-font-section:18px;--teloa-font-caption:12px;--teloa-leading-body:1.5}body{margin:16px;font-family:system-ui}'+styles})
 await page.addScriptTag({content:script});await page.getByRole('combobox').waitFor();return page
}
for(const locale of ['zh-CN','en'])for(const width of [390,1400])test(locale+'/'+width+' 可选负责人只列合格员工；保存/清空复用原接口且零Task/Run',async t=>{
 const page=await fixture(t,locale,width),select=page.getByRole('combobox'),save=page.getByRole('button',{name:locale==='en'?'Save responsibility':'保存负责人',exact:true})
 assert.equal(await select.locator('option').count(),2);assert.equal(await save.isDisabled(),true)
 await select.selectOption('00000000-0000-4000-8000-000000000001');await save.click();await page.waitForFunction(()=>(window as any).responsibilityFixture.rows.size===0&&(window as any).responsibilityFixture.calls.some((r:any)=>r.method.endsWith('/set')))
 await page.waitForFunction(()=>!(document.querySelector('select') as HTMLSelectElement).disabled)
 assert.equal(await select.inputValue(),'00000000-0000-4000-8000-000000000001')
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
 await page.screenshot({path:'/tmp/teloa-responsibility-ui/'+locale+'-'+width+'.png',fullPage:true})
 await select.selectOption('');await save.click();await page.waitForFunction(()=>(window as any).responsibilityFixture.saved.get('sales')?.roleId===null)
 const calls=await page.evaluate(()=>(window as any).responsibilityFixture.calls);assert.equal(calls.filter((r:any)=>r.method.endsWith('/set')).length,2);assert.equal(calls.at(-1).method,'business-responsibility/read')
 assert.ok(calls.every((r:any)=>r.method.startsWith('business-responsibility/')))
})
test('失回包刷新自动只读回执；无回执保留pending且明确恢复原请求',async t=>{
 const page=await fixture(t);await page.evaluate(()=>(window as any).responsibilityFixture.lost=true)
 await page.getByRole('combobox').selectOption('00000000-0000-4000-8000-000000000001');await page.getByRole('button',{name:'保存负责人',exact:true}).click()
 await page.getByRole('button',{name:'核对保存结果',exact:true}).waitFor();assert.equal(await page.getByRole('combobox').isDisabled(),true)
 await page.evaluate(()=>{const f=(window as any).responsibilityFixture;f.receipts.clear();f.render('sales',true)})
 await page.getByRole('button',{name:'核对保存结果',exact:true}).waitFor();assert.equal(await page.evaluate(()=>(window as any).responsibilityFixture.calls.filter((r:any)=>r.method.endsWith('/set')).length),1)
 await page.evaluate(()=>(window as any).responsibilityFixture.lost=false);await page.getByRole('button',{name:'核对保存结果',exact:true}).click()
 await page.waitForFunction(()=>(window as any).responsibilityFixture.rows.size===0)
 const writes=await page.evaluate(()=>(window as any).responsibilityFixture.calls.filter((r:any)=>r.method.endsWith('/set')));assert.equal(writes.length,2);assert.deepEqual(writes[0].input,writes[1].input)
})
test('旧scope/旧API晚回包不得覆盖新scope；读取失败必须有真重试',async t=>{
 const page=await fixture(t);await page.evaluate(()=>{const f=(window as any).responsibilityFixture;f.hold=true;f.render('sales',true)})
 await page.waitForFunction(()=>!!(window as any).responsibilityFixture.release)
 await page.evaluate(()=>(window as any).responsibilityFixture.render('support',true));await page.getByRole('combobox').waitFor()
 await page.evaluate(()=>(window as any).responsibilityFixture.release());await page.getByRole('combobox').selectOption('00000000-0000-4000-8000-000000000001');await page.getByRole('button',{name:'保存负责人',exact:true}).click()
 await page.waitForFunction(()=>(window as any).responsibilityFixture.saved.has('support'));assert.equal(await page.evaluate(()=>(window as any).responsibilityFixture.saved.has('sales')),false)
 await page.evaluate(()=>{const f=(window as any).responsibilityFixture;f.offline=true;f.render('support',true)});await page.getByRole('alert').waitFor();assert.equal(await page.getByRole('combobox').count(),0)
 await page.evaluate(()=>(window as any).responsibilityFixture.offline=false);await page.getByRole('button',{name:'重试',exact:true}).click();await page.getByRole('combobox').waitFor()
})
test('失效选择保留可读名称与原因，不显示内部ID；坏journal不发写请求',async t=>{
 const page=await fixture(t)
 for(const [status,reason] of [['paused','已暂停'],['retired','已离岗'],['missing','已不存在'],['forbidden','不再支持此业务']]){
  await page.evaluate((status:string)=>(window as any).responsibilityFixture.setStatus(status),status);await page.getByText(reason!,{exact:false}).waitFor();assert.ok(!(await page.locator('body').innerText()).includes('00000000'))
 }
 await page.evaluate(()=>{const f=(window as any).responsibilityFixture;f.rows.set('teloa.business-responsibility/v1/personal-space/00000000-0000-4000-8000-000000000099/sales','');f.render('sales',true)})
 await page.getByRole('alert').waitFor();assert.equal(await page.getByRole('combobox').count(),0);assert.equal(await page.evaluate(()=>(window as any).responsibilityFixture.calls.filter((r:any)=>r.method.endsWith('/set')).length),0)
})

test('set已完成但当前读取失败先重读，不以旧版本继续写；恢复读取失败后仍展示真实同事名称',async t=>{
 const page=await fixture(t)
 await page.evaluate(()=>(window as any).responsibilityFixture.failAfterSet=true)
 await page.getByRole('combobox').selectOption('00000000-0000-4000-8000-000000000001');await page.getByRole('button',{name:'保存负责人',exact:true}).click()
 await page.getByRole('alert').waitFor();assert.equal(await page.getByRole('combobox').count(),0)
 await page.evaluate(()=>{const f=(window as any).responsibilityFixture;f.failAfterSet=false;f.offline=false})
 await page.getByRole('button',{name:'重试',exact:true}).click();await page.getByRole('combobox').waitFor()
 await page.evaluate(()=>(window as any).responsibilityFixture.lost=true);await page.getByRole('combobox').selectOption('');await page.getByRole('button',{name:'保存负责人',exact:true}).click()
 await page.getByRole('button',{name:'核对保存结果',exact:true}).waitFor()
 await page.evaluate(()=>{const f=(window as any).responsibilityFixture;f.offline=true;f.render('sales',true)})
 await page.getByRole('combobox').waitFor({state:'hidden'});await page.getByRole('alert').waitFor();await page.evaluate(()=>(window as any).responsibilityFixture.offline=false)
 await page.getByRole('button',{name:'核对保存结果',exact:true}).click();await page.getByRole('combobox').waitFor()
 assert.equal(await page.getByRole('combobox').locator('option').count(),2)
 assert.equal(await page.evaluate(()=>(window as any).responsibilityFixture.calls.filter((r:any)=>r.method.endsWith('/set')).length),2)
})

test('API已读完但同事目录晚回时身份失效，不显示原本人选择',async t=>{
 const page=await fixture(t)
 await page.evaluate(()=>{const f=(window as any).responsibilityFixture;f.holdRoles=true;f.render('sales',true)})
 await page.waitForFunction(()=>!!(window as any).responsibilityFixture.releaseRoles)
 await page.evaluate(()=>{const f=(window as any).responsibilityFixture;f.active=false;f.releaseRoles()})
 await page.getByRole('alert').waitFor();assert.equal(await page.getByRole('combobox').count(),0)
})

test('明确过期请求提供显式重选而非无限恢复；同名角色以职责区分且不暴露ID',async t=>{
 const page=await fixture(t,'en')
 await page.evaluate(()=>{const f=(window as any).responsibilityFixture;f.duplicate=true;f.render('sales',true)})
 await page.getByRole('option',{name:'Mina — Follow up',exact:true}).waitFor({state:'attached'})
 await page.getByRole('option',{name:'Mina — Review deliveries',exact:true}).waitFor({state:'attached'})
 await page.evaluate(()=>{const f=(window as any).responsibilityFixture;f.rejectSet=true;f.saved.set('sales',{scope:'sales',version:2,roleId:null,selectedRoleVersion:null,currentRoleVersion:null,availability:'none'})})
 await page.getByRole('combobox').selectOption('00000000-0000-4000-8000-000000000001');await page.getByRole('button',{name:'Save responsibility',exact:true}).click()
 await page.getByRole('button',{name:'Choose again',exact:true}).click();await page.waitForFunction(()=>!(document.querySelector('select') as HTMLSelectElement).disabled)
 assert.equal(await page.getByRole('combobox').inputValue(),'');assert.equal(await page.evaluate(()=>(window as any).responsibilityFixture.calls.filter((r:any)=>r.method.endsWith('/set')).length),1)
 await page.evaluate(()=>(window as any).responsibilityFixture.rejectSet=false);await page.getByRole('combobox').selectOption('00000000-0000-4000-8000-000000000005');await page.getByRole('button',{name:'Save responsibility',exact:true}).click()
 await page.waitForFunction(()=>(window as any).responsibilityFixture.saved.get('sales')?.version===3)
 const writes=await page.evaluate(()=>(window as any).responsibilityFixture.calls.filter((r:any)=>r.method.endsWith('/set')));assert.notEqual(writes[0].input.requestId,writes[1].input.requestId);assert.equal(writes[1].input.expectedVersion,2)
 assert.ok(!(await page.locator('body').innerText()).includes('00000000'))
})

test('失效当前同事与同名在岗候选统一消歧，职责前100字相同仍保留可辨后缀',async t=>{
 const page=await fixture(t,'en',390)
 await page.evaluate(()=>{const f=(window as any).responsibilityFixture;f.duplicate=true;f.setStatus('paused')})
 const selected=page.getByRole('combobox').locator('option[value="00000000-0000-4000-8000-000000000001"]'),other=page.getByRole('combobox').locator('option[value="00000000-0000-4000-8000-000000000005"]')
 await page.getByRole('option',{name:'Mina — Follow up',exact:true}).waitFor({state:'attached'})
 await page.getByText('Paused',{exact:true}).waitFor();assert.equal(await selected.evaluate((option:HTMLOptionElement)=>option.disabled),true);assert.equal(await other.innerText(),'Mina — Review deliveries')
 await page.evaluate(()=>{const f=(window as any).responsibilityFixture;f.longDuties=true;f.render('sales',true)})
 await page.waitForFunction(()=>Array.from(document.querySelectorAll('option')).some(o=>o.textContent?.includes('Alpha')))
 assert.match(await selected.innerText(),/Alpha/);assert.match(await other.innerText(),/Beta/)
 await page.evaluate(()=>{const f=(window as any).responsibilityFixture;f.longDuties=false;f.sameDuties=true;f.render('sales',true)})
 await page.waitForFunction(()=>Array.from(document.querySelectorAll('option')).some(o=>o.textContent?.includes('Customer follow-up')))
 assert.match(await selected.innerText(),/Customer follow-up/);assert.match(await other.innerText(),/Content follow-up/)
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.ok(!(await page.locator('body').innerText()).includes('00000000'))
})

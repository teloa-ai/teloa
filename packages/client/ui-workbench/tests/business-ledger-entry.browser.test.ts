import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
import {block,ledger,ledgerObject,listView,viewResult} from './business-ledger-fixtures.ts'
import {readBusinessLedger} from '../src/client/business-ledger-api.ts'
// @ts-expect-error 既有浏览器夹具没有声明文件。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
let browser:any,temp:string,script:string,styles:string
const data=Object.fromEntries(['SOC','AppSec'].map(scope=>[scope,ledger({scope,actions:[],blocks:(scope==='SOC'?['alert-ticket','other']:['different']).map(id=>block({scope,definition:{id,domain:scope,title:id==='alert-ticket'?'客户问题':id==='other'?'后续跟进':'另一业务记录',progress:{stageField:'severity',unfinished:['高'],waitingForYou:[]}},objects:2,defaultAction:null,progress:{unfinished:2,waitingForYou:0,latestChangedAt:null},views:[viewResult(scope,id,id+'-analysis',[{dimension:'高',label:'高',values:[2]}]),listView(scope,id,[ledgerObject(scope,id,id+'-1'),ledgerObject(scope,id,id+'-2',{quality:'missing'})])]}))})]))
const entry=`
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {BusinessLedgerSurface} from '${client}BusinessLedger.tsx';
import {readBusinessLedger} from '${client}business-ledger-api.ts';
import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';
import {prototypeThemes} from '${client}../brand/prototype-theme.ts';import tokens from '${client}theme-tokens.module.css';
const data=${JSON.stringify(data)};
const snapshot={locale:'zh-CN',dshLocale:'zh',revision:1},runtime={t:(k,p)=>translateMessage('zh-CN',k,p),subscribe:()=>()=>{},getSnapshot:()=>snapshot};
const f=window.ledgerFixture={calls:[],targets:[],fail:false,hold:false,waiting:0};
const api={read:async(r,signal)=>{
 f.calls.push(r);if(f.hold){f.waiting++;await new Promise(resolve=>f.release=resolve)}
 if(f.fail)throw Error('private database error');
 const value=structuredClone(data[r.scope]);value.blocks=value.blocks.filter(row=>!r.objectType||row.objectType.definition.id===r.objectType);
 if(!r.objectType)for(const row of value.blocks)row.views=row.views.filter(v=>v.kind!=='list');
 return readBusinessLedger(value,r.scope)
}};
function App(){const [target,setTarget]=useState({scope:'SOC',section:'data'});f.switchScope=()=>setTarget({scope:'AppSec',section:'data'});return <I18nProvider runtime={runtime}><main className={tokens.tokens}><BusinessLedgerSurface {...target} objectId={target.id} api={api} connect={()=>f.connected=true} go={next=>{f.targets.push(next);setTarget(next)}}/></main></I18nProvider>}
f.theme=dark=>{for(const [k,v] of Object.entries(prototypeThemes[dark?'dark':'light']))document.body.style.setProperty(k,v)};f.theme(false);
createRoot(document.getElementById('root')).render(<App/>);
`
before(async()=>{
 for(const [scope,value] of Object.entries(data))await readBusinessLedger(value,scope)
 temp=await mkdtemp(join(root,'.runtime-ledger-entry-'));await writeFile(join(temp,'entry.tsx'),entry)
 const built=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'entry.tsx'),name:'LedgerEntryFixture',formats:['iife']}}})
 const bundle=Array.isArray(built)?built[0]:built;assert.ok(bundle&&'output'in bundle)
 script=bundle.output.find(x=>x.type==='chunk')!.code;styles=bundle.output.flatMap(x=>x.type==='asset'&&x.fileName.endsWith('.css')?[String(x.source)]:[]).join('\n')
 browser=await loadPlaywright().chromium.launch(launchOptions())
})
after(async()=>{await browser?.close();if(temp)await rm(temp,{recursive:true,force:true})})

for(const dark of [false,true])test((dark?'深色窄屏':'浅色桌面')+'台账首屏、类型与分析切换、筛选和详情返回',async t=>{
 const page=await browser.newPage({viewport:{width:dark?430:1400,height:960}});page.setDefaultTimeout(5000);t.after(()=>page.close())
 const errors:string[]=[];page.on('pageerror',(e:Error)=>errors.push(e.message));await page.route('**/*',(r:any)=>r.abort())
 await page.route('http://127.0.0.1:3269/ledger-fixture', (r:any)=>r.fulfill({contentType:'text/html',body:'<html lang="zh-CN"><div id="root"></div></html>'}));await page.goto('http://127.0.0.1:3269/ledger-fixture');await page.addStyleTag({content:styles+'body{margin:0;background:var(--teloa-background);color:var(--teloa-text);font-family:var(--teloa-design-font)}main{padding:20px;max-width:1100px;margin:auto}*{box-sizing:border-box}'});await page.addScriptTag({content:script})
 await page.evaluate((dark:boolean)=>(window as any).ledgerFixture.theme(dark),dark)
 const record=page.getByRole('button',{name:'工单 alert-ticket-1',exact:true});await record.waitFor()
 assert.deepEqual(await page.evaluate(()=>(window as any).ledgerFixture.calls),[{scope:'SOC'},{scope:'SOC',objectType:'alert-ticket'}])
 assert.equal(await page.locator('[data-object-type-block]').count(),0)
 await page.getByRole('button',{name:'分析',exact:true}).click();await page.locator('[data-view-distribution]').waitFor();assert.equal(await record.isVisible(),false)
 await page.getByRole('button',{name:'概览',exact:true}).click();await page.locator('[data-object-type-block]').first().waitFor();assert.equal(await page.locator('[data-object-type-block]').count(),2)
 await page.getByRole('button',{name:'台账',exact:true}).click();await record.waitFor()
 await page.getByRole('combobox',{name:'资料完整性',exact:true}).selectOption('missing');assert.equal(await record.count(),0)
 await page.getByRole('combobox',{name:'资料完整性',exact:true}).selectOption('all')
 await page.getByRole('combobox',{name:'记录类型',exact:true}).selectOption('other');await page.getByRole('button',{name:'工单 other-1',exact:true}).waitFor()
 await page.getByRole('button',{name:'工单 other-1',exact:true}).click();const drawer=page.getByRole('dialog');await drawer.waitFor()
 await page.keyboard.press('Escape');await drawer.waitFor({state:'detached'})
 assert.deepEqual(await page.evaluate(()=>(window as any).ledgerFixture.targets.at(-1)),{scope:'SOC',section:'data',objectType:'other'})
 assert.equal(await page.getByRole('combobox',{name:'记录类型',exact:true}).inputValue(),'other')
 await page.getByRole('button',{name:'概览',exact:true}).click()
 await page.locator('[data-object-type-block="other"]>button').click()
 await page.getByRole('button',{name:'工单 other-1',exact:true}).waitFor()
 assert.equal(await page.getByRole('button',{name:'台账',exact:true}).getAttribute('aria-pressed'),'true','同一类型卡也应回到台账')
 if(dark){
  assert.equal(await page.getByRole('button',{name:'工单 other-2',exact:true}).evaluate((el:HTMLElement)=>getComputedStyle(el).color),await page.locator('main').evaluate((el:HTMLElement)=>getComputedStyle(el).color),'未聚焦的记录标题继承深色文字颜色')
  assert.equal(await page.getByRole('combobox',{name:'资料完整性',exact:true}).evaluate((el:HTMLElement)=>getComputedStyle(el).backgroundColor),await page.getByRole('combobox',{name:'记录类型',exact:true}).evaluate((el:HTMLElement)=>getComputedStyle(el).backgroundColor),'筛选与类型控件使用同一主题底色')
 }
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
 if(process.env.TELOA_LEDGER_EVIDENCE)await page.screenshot({path:process.env.TELOA_LEDGER_EVIDENCE+'/ledger-'+(dark?'dark-narrow':'light-desktop')+'.png',fullPage:true})
 assert.deepEqual(errors,[])
})

test('读取失败可重试，切换业务后的旧读取不覆盖当前目录',async t=>{
 const page=await browser.newPage();page.setDefaultTimeout(5000);t.after(()=>page.close());await page.route('**/*',(r:any)=>r.abort())
 await page.route('http://127.0.0.1:3269/ledger-fixture', (r:any)=>r.fulfill({contentType:'text/html',body:'<html lang="zh-CN"><div id="root"></div></html>'}));await page.goto('http://127.0.0.1:3269/ledger-fixture');await page.addStyleTag({content:styles});await page.addScriptTag({content:script})
 await page.getByRole('button',{name:'工单 alert-ticket-1',exact:true}).waitFor()
 await page.evaluate(()=>{const f=(window as any).ledgerFixture;f.hold=true;f.switchScope()});await page.waitForFunction(()=>(window as any).ledgerFixture.waiting===1)
 await page.evaluate(()=>{const f=(window as any).ledgerFixture;f.hold=false;f.fail=true;f.release()});await page.getByRole('alert').waitFor()
 assert.doesNotMatch(await page.locator('body').innerText(),/private database error/)
 await page.evaluate(()=>(window as any).ledgerFixture.fail=false);await page.getByRole('alert').getByRole('button').click()
 await page.getByRole('button',{name:'工单 different-1',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'工单 alert-ticket-1',exact:true}).count(),0)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import {fileURLToPath} from 'node:url'
import {mkdtemp} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {build} from 'vite'
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

test('新业务包首次准备：一次确认安装全部 SKILL 并启用员工，完成后重读目录；桌面与手机均可操作',async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url)),virtual=root+'__industry_prepare_fixture.tsx'
 const entry=`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
 import {IndustryReadinessPanel} from '${client}IndustryReadinessPanel.tsx';
 import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';
 const locale='zh-CN',snapshot={locale,dshLocale:locale,revision:1},runtime={t:(key,params)=>translateMessage(locale,key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};
 const loadId='77777777-7777-4777-8777-777777777777',role='88888888-8888-4888-8888-888888888888',ids=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222'];
 const f=window.industryPrepare={writes:[],enabled:false,prepared:0,refreshed:0},records=new Map();
 const preview=id=>{const i=ids.indexOf(id);return {source:{kind:'industry-local',loadId,itemInstanceId:id},bundleHash:String(i+1).repeat(64),native:{name:'soc-method-'+i,description:'读取告警证据并整理调查结果 '+i,bodyHash:'b'.repeat(64),modelInvocable:true,userInvocable:true},files:[{path:'SKILL.md',hash:'c'.repeat(64),size:100},...(i?[{path:'scripts/check.py',hash:'d'.repeat(64),size:40}]:[])]}};
 const skills={pending:()=>undefined,preview:async source=>preview(source.itemInstanceId),install:async request=>{f.writes.push(request);const p=preview(request.source.itemInstanceId),record={...p,id:request.source.itemInstanceId,state:'installed'};records.set(record.id,record);return record},observe:async id=>({state:'available',current:records.get(id).native})};
 const read=async()=>({loadId,status:'active',title:'新安装的安全运营包',version:'1.0.0',digest:String(records.size).repeat(64),counts:{ready:records.size+1+Number(f.enabled),auto:Number(!f.enabled),needsUser:2-records.size,optional:0,pending:0},rows:[{itemInstanceId:role,kind:'role',title:'新安全分析员工',state:f.enabled?'ready':'auto',step:f.enabled?null:'role',entry:null},...ids.map((id,i)=>({itemInstanceId:id,kind:'skill',title:'soc-method-'+i,state:records.has(id)?'ready':'needs-user',step:null,entry:records.has(id)?null:'skill-confirm'})),{itemInstanceId:'99999999-9999-4999-8999-999999999999',kind:'business-configuration',title:'安全运营看板',state:'ready',step:null,entry:null}]});
 const port={read,prepare:async()=>{if(records.size!==2)throw Error('依赖未齐不能启用');f.prepared++;f.enabled=true;return {loadId,digest:String(records.size).repeat(64),results:[{itemInstanceId:role,title:'新安全分析员工',step:'role-resume',outcome:'done',code:null,message:null}],readiness:await read()}}};
 function App(){const [revision,setRevision]=useState(0);return <I18nProvider runtime={runtime}><IndustryReadinessPanel loadId={loadId} port={port} skills={skills} refreshKey={String(revision)} relations={ids.map(id=>({kind:'role-skill',from:role,to:id}))} onPrepared={async()=>{f.refreshed++;setRevision(value=>value+1)}} onOpen={()=>{}}/></I18nProvider>}
 createRoot(document.getElementById('root')).render(<App/>);`
 const built=await build({configFile:false,root,logLevel:'error',plugins:[{name:'industry-prepare-fixture',resolveId:id=>id.endsWith('industry-prepare-fixture')?virtual:null,load:id=>id===virtual?entry:null}],resolve:{alias:{'@teloa/contract':root+'packages/contract/src/index.ts'}},define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:id=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:'industry-prepare-fixture',name:'IndustryPrepareFixture',formats:['iife']}}})
 const bundle=Array.isArray(built)?built[0]:built,script=bundle.output.find(row=>row.type==='chunk').code,styles=bundle.output.flatMap(row=>row.type==='asset'&&row.fileName.endsWith('.css')?[String(row.source)]:[]).join('\n')
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const screenshots=await mkdtemp(join(tmpdir(),'teloa-package-prepare-'))
 for(const [device,viewport] of [['desktop',{width:1440,height:1000}],['mobile',{width:390,height:844}]]){
  const page=await browser.newPage({viewport});t.after(()=>page.close());page.setDefaultTimeout(10000)
  const errors=[];page.on('pageerror',error=>errors.push(error.message))
  await page.route('**/*',route=>route.request().url()==='http://127.0.0.1/industry-prepare-fixture'?route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div></html>'}):route.abort())
  await page.goto('http://127.0.0.1/industry-prepare-fixture');await page.addStyleTag({content:styles+'\nbody{margin:0;padding:20px;color:#252525;background:#fafafa;font-family:system-ui;--teloa-surface:#fff;--teloa-border:#ddd;--teloa-text:#252525;--teloa-muted:#656565;--teloa-primary:#242424;--teloa-on-primary:#fff;--teloa-focus:#555;--teloa-accent:#454545;--teloa-font-body:14px;--teloa-font-control:14px;--teloa-font-caption:12px;--teloa-font-section:18px;}'});await page.addScriptTag({content:script})
  await page.getByRole('button',{name:'一键准备',exact:true}).click()
  await page.getByText('确认安装或沿用 2 个 SKILL',{exact:true}).waitFor()
  assert.equal(await page.evaluate(()=>window.industryPrepare.writes.length),0,'确认前不得安装')
  await page.getByText('查看随包文件（2）',{exact:true}).click();await page.getByText('scripts/check.py',{exact:true}).waitFor({state:'visible'})
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'确认清单不得横向溢出')
  await page.screenshot({path:join(screenshots,device+'-confirm.png'),fullPage:true})
  await page.getByRole('button',{name:'确认',exact:true}).click()
  await page.getByRole('heading',{name:'都准备好了',exact:true}).waitFor()
  assert.deepEqual(await page.evaluate(()=>({installed:window.industryPrepare.writes.length,enabled:window.industryPrepare.enabled,prepared:window.industryPrepare.prepared,refreshed:window.industryPrepare.refreshed})),{installed:2,enabled:true,prepared:1,refreshed:1})
  assert.equal(await page.getByText('需要你操作 0',{exact:true}).count(),1)
  assert.equal(await page.getByRole('button',{name:'一键准备',exact:true}).count(),0)
  assert.deepEqual(errors,[])
 }
 console.log('业务包安装验证截图：'+screenshots)
})

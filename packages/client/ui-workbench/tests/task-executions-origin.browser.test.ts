import {test,before,after,type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import {fileURLToPath} from 'node:url'
import {build} from 'vite'
// @ts-expect-error 复用当前工作树的无头浏览器加载器。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'
const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
let browser:any,script:string,styles:string
declare global {interface Window {originFixture:{mode:string;opens:string[];calls:Array<{method:string;payload:unknown}>;switchTask:()=>void;holdOrigin:boolean;release:()=>void;waiting:boolean}}}
const entry=`
import React,{useState} from 'react';import{createRoot}from'react-dom/client';
import{TaskExecutions}from'${client}TaskExecutions.tsx';import{createTaskRunApi}from'${client}task-run-api.ts';
import{I18nProvider}from'${client}i18n/provider.tsx';import{translateMessage}from'${client}i18n/messages.ts';
const locale=document.documentElement.lang,snapshot={locale,dshLocale:locale==='en'?'en':'zh',revision:1},runtime={getSnapshot:()=>snapshot,subscribe:()=>()=>{},t:(key,params)=>translateMessage(locale,key,params)};
const taskId='22222222-2222-4222-8222-222222222222',other='55555555-5555-4555-8555-555555555555',id='11111111-1111-4111-8111-111111111111',roleId='33333333-3333-4333-8333-333333333333';
const source={kind:'conversation-work',sessionId:'original-platform-session',requestId:'44444444-4444-4444-8444-444444444444',messageId:'original-human-message',messageSeq:7,title:'Original assignment',stopped:false};
const f=window.originFixture={mode:window.originMode||'parent',opens:[],calls:[],holdOrigin:false,waiting:false,release:()=>{}};
const ordinary=f.mode.startsWith('ordinary'),prepared=['ordinary','ordinary-pending','ordinary-recovery'].includes(f.mode);
const row={id,taskId,roleId,taskVersion:1,roleVersion:2,linkVersion:1,sessionId:'failed-run-session',nativeRequestId:id,state:prepared?'prepared':'ended',evidence:prepared?null:{state:'ended',turn:0,messageSeq:1,endSeq:2,reason:ordinary?'completed':'error'},allowedTools:[],skills:[],knowledge:[],memory:[],inputText:JSON.stringify({task:{id:taskId,version:1,title:'Investigate',goal:'Check evidence',scope:'general'},role:{id:roleId,version:2,name:'Investigator',duty:'Investigate',dataScope:'Read only',executionScope:'Draft'}}),createdAt:'2026-10-12T00:00:00.000Z'};
if(f.mode.startsWith('owner-')){
 const executor={kind:'owner',grantId:source.requestId,grantVersion:1};Object.assign(row,{roleId:null,roleVersion:null,executor,evidence:{state:'ended',turn:0,messageSeq:1,endSeq:2,reason:'completed'},deliveryCheck:{state:f.mode==='owner-unknown'?'unknown':'review-required'},inputText:JSON.stringify({schema:'teloa.task-run-input/v3',executor,allowedTools:[],task:{id:taskId,version:1,title:'Investigate',goal:'Check evidence',scope:'general'},skills:[],knowledge:[]})});
}
let journal=f.mode==='ordinary-pending'?JSON.stringify({requestId:source.requestId,taskId,expectedTaskVersion:3}):f.mode==='ordinary-recovery'?'invalid recovery record':null;
const api=createTaskRunApi(async(method,payload)=>{
 f.calls.push({method,payload});
 if(method==='task-runs/list')return payload.taskId===taskId&&!f.mode.startsWith('ordinary-empty')?[row]:[];
 if(method==='task-runs/origin'){const requested=payload.taskId??taskId;if(f.holdOrigin&&requested===taskId){f.waiting=true;await new Promise(resolve=>f.release=resolve);f.waiting=false;}
  return {taskId:f.mode==='wrong-task'?other:requested,runId:null,source:ordinary||requested===other?null:f.mode==='wrong-parent'?{...source,sessionId:'different-parent'}:source};}
 throw Error('Execution must not be dispatched by the source link');
},{read:()=>journal,write:value=>journal=value,clear:()=>journal=null});
function App(){const [selected,setSelected]=useState(taskId);f.switchTask=()=>setSelected(other);
return <><textarea aria-label="Original conversation draft" defaultValue="Keep the original input"/><TaskExecutions taskId={selected} taskVersion={3} taskState={f.mode==='ordinary-ended'?'completed':'blocked'} assigned={f.mode!=='ordinary-empty'} api={api} changed={()=>{}} open={async sessionId=>f.opens.push(sessionId)}/></>;}
createRoot(document.getElementById('root')).render(<I18nProvider runtime={runtime}><App/></I18nProvider>);
`
before(async()=>{
 const virtual=root+'__task_execution_origin_browser.tsx'
 const result=await build({configFile:false,root,logLevel:'error',plugins:[{name:'task-origin-fixture',resolveId:id=>id.endsWith('task-origin-fixture')?virtual:null,load:id=>id===virtual?entry:null}],define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:')},lib:{entry:'task-origin-fixture',name:'TaskOriginFixture',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 const chunk=bundle.output.find(item=>item.type==='chunk');assert.ok(chunk&&chunk.type==='chunk');script=chunk.code;styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 browser=await loadPlaywright().chromium.launch(launchOptions())
})
after(async()=>{await browser?.close()})
async function mount(t:TestContext,mode='parent',locale='en'){
 const page=await browser.newPage();page.setDefaultTimeout(3000);const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));t.after(async()=>{await page.close();assert.deepEqual(errors,[])})
 await page.route('**/*',(route:any)=>route.abort());await page.setContent('<html lang="'+locale+'"><div id="root"></div></html>');await page.evaluate((mode:string)=>Object.assign(window,{originMode:mode}),mode);await page.addStyleTag({content:styles});await page.addScriptTag({content:script});await page.getByRole('textbox',{name:'Original conversation draft'}).waitFor();return page
}
test('父交办失败Run返回同一原会话，不暴露会被拒绝的prepare/start，原输入与失败历史保留',async t=>{
 const page=await mount(t)
 await page.getByText('Investigator',{exact:true}).waitFor()
 assert.equal(await page.locator('[data-teloa-focus="prepare"]').count(),0)
 const back=page.getByRole('button',{name:'Return to original request',exact:true});await back.click()
 assert.deepEqual(await page.evaluate(()=>window.originFixture.opens),['original-platform-session'])
 assert.equal(await page.getByRole('textbox',{name:'Original conversation draft'}).inputValue(),'Keep the original input')
 assert.equal(await page.getByRole('button',{name:'Start',exact:true}).count(),0)
 assert.equal(await page.getByText('Investigator',{exact:true}).count(),1)
 assert.equal(await page.evaluate(()=>window.originFixture.calls.some(call=>['task-runs/prepare','task-runs/start'].includes(call.method))),false)
})
test('普通非父任务保留原prepared执行启动控制',async t=>{
 const page=await mount(t,'ordinary');await page.getByRole('button',{name:'Start',exact:true}).waitFor()
 assert.equal(await page.locator('[data-teloa-focus="prepare"]').count(),0)
 assert.equal(await page.getByRole('button',{name:'Return to original request',exact:true}).count(),0)
})
test('已完成原Run隐藏无效准备按钮且保留原结果入口',async t=>{
 const page=await mount(t,'ordinary-ended');await page.getByText('Investigator',{exact:true}).waitFor()
 assert.equal(await page.locator('[data-teloa-focus="prepare"]').count(),0)
 await page.getByRole('button',{name:'Open',exact:true}).click()
 assert.deepEqual(await page.evaluate(()=>window.originFixture.opens),['failed-run-session'])
 assert.equal(await page.getByRole('textbox',{name:'Original conversation draft'}).inputValue(),'Keep the original input')
 assert.equal(await page.evaluate(()=>window.originFixture.calls.every(call=>['task-runs/list','task-runs/origin'].includes(call.method))),true)
})
test('无Run的必要引导和可准备下一轮的入口继续保留',async t=>{
 for(const [mode,enabled] of [['ordinary-empty',false],['ordinary-empty-ready',true],['ordinary-retry',true]] as const){
  const page=await mount(t,mode);await page.waitForFunction(()=>window.originFixture.calls.some(call=>call.method==='task-runs/list'))
  const prepare=page.locator('[data-teloa-focus="prepare"]');await prepare.waitFor();if(enabled)await page.waitForFunction(()=>!document.querySelector<HTMLButtonElement>('[data-teloa-focus="prepare"]')?.disabled)
  assert.equal(await prepare.isEnabled(),enabled)
  assert.equal(await page.evaluate(()=>window.originFixture.calls.every(call=>['task-runs/list','task-runs/origin'].includes(call.method))),true)
 }
})
test('已有Run的待核准备和损坏恢复入口保留，明确丢弃后不留下无效准备按钮',async t=>{
 for(const mode of ['ordinary-pending','ordinary-recovery']){
  const page=await mount(t,mode);await page.getByRole('button',{name:'Start',exact:true}).waitFor()
  assert.equal(await page.locator('[data-teloa-focus="prepare"]').count(),1)
  assert.equal(await page.locator('[data-teloa-focus="prepare"]').isEnabled(),false)
  assert.equal(await page.getByRole('button',{name:'Review pending preparation',exact:true}).count(),mode==='ordinary-pending'?1:0)
  if(mode==='ordinary-recovery')assert.equal(await page.getByRole('alert').count(),1)
  await page.getByRole('button',{name:'Discard this recovery record',exact:true}).click()
  assert.equal(await page.locator('[data-teloa-focus="prepare"]').count(),0)
  assert.equal(await page.getByRole('button',{name:'Start',exact:true}).count(),1)
  assert.equal(await page.evaluate(()=>window.originFixture.calls.every(call=>['task-runs/list','task-runs/origin'].includes(call.method))),true)
 }
})
test('错误Task来源和点击时变化的parent均fail closed，不能回错会话或丢原稿',async t=>{
 const wrong=await mount(t,'wrong-task');await wrong.getByRole('alert').waitFor()
 assert.equal(await wrong.locator('[data-teloa-focus="prepare"]').count(),0)
 assert.equal(await wrong.getByRole('button',{name:'Return to original request',exact:true}).count(),0)
 const page=await mount(t);await page.getByRole('button',{name:'Return to original request',exact:true}).waitFor();await page.evaluate(()=>window.originFixture.mode='wrong-parent');await page.getByRole('button',{name:'Return to original request',exact:true}).click();await page.getByRole('alert').waitFor()
 assert.deepEqual(await page.evaluate(()=>window.originFixture.opens),[])
 assert.equal(await page.getByRole('textbox',{name:'Original conversation draft'}).inputValue(),'Keep the original input')
})

test('后台owner缺完整复核时显示三语说明，固定Run和原交办可读且零写',async t=>{
 for(const [locale,message,open,back] of [['zh-CN','尚无完整可核对成果。','打开','返回原交办'],['zh-Hant','尚無完整可核對成果。','開啟','返回原交辦'],['en','A fully reviewed result is not available.','Open','Return to original request']] as const){
  const page=await mount(t,'owner-review-required',locale)
  await page.getByRole('alert').filter({hasText:message}).waitFor()
  await page.locator('[data-teloa-run-id="11111111-1111-4111-8111-111111111111"]').getByRole('button',{name:open,exact:true}).click()
  await page.getByRole('button',{name:back,exact:true}).click()
  assert.deepEqual(await page.evaluate(()=>window.originFixture.opens),['failed-run-session','original-platform-session'])
  assert.equal(await page.getByRole('textbox',{name:'Original conversation draft'}).inputValue(),'Keep the original input')
  assert.equal(await page.evaluate(()=>window.originFixture.calls.every(call=>['task-runs/list','task-runs/origin'].includes(call.method))),true)
 }
})
test('交付检查读取未知保持待核，不能显示缺复核或已存成果',async t=>{
 const page=await mount(t,'owner-unknown','en')
 await page.getByRole('status').filter({hasText:'This delivery is still awaiting verification'}).waitFor()
 assert.equal(await page.getByText('A fully reviewed result is not available.',{exact:false}).count(),0)
 assert.equal(await page.getByRole('button',{name:'Return to original request',exact:true}).count(),1)
 assert.equal(await page.evaluate(()=>window.originFixture.calls.every(call=>['task-runs/list','task-runs/origin'].includes(call.method))),true)
})

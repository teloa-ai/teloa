import {test,before,after} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 既有无头浏览器加载器。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'
const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
let browser:any,script:string,styles:string,temp:string
const entry=`
import React from 'react';import {createRoot} from 'react-dom/client';import {ConversationPlanCard,ConversationPlanClock,ConversationPlanTurnCards} from '${client}ConversationPlanCard.tsx';import {createConversationPlanDirectory,conversationTurnPlanIds} from '${client}conversation-plans.ts';import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';
const locale='zh-CN',snapshot={locale,dshLocale:'zh',revision:1},runtime={t:(key,params)=>translateMessage(locale,key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};
const p={id:'11111111-1111-4111-8111-111111111111',ownerId:'local:owner',title:'每周资料核对',goal:'长说明'.repeat(300),scope:'general',dataScope:'已授权资料',delivery:'结论',roleId:'22222222-2222-4222-8222-222222222222',roleVersion:1,source:{kind:'manual',sessionId:'ordinary'},state:'paused',version:1,configVersion:1,trigger:{kind:'schedule',cadence:'weekly',weekday:1,time:'09:00',timezone:'Asia/Singapore'},notificationPolicy:'attention',archivedReason:null,archivedAt:null,createdAt:'2026-10-11T00:00:00.000Z',updatedAt:'2026-10-11T00:00:00.000Z'};
let rows=[p],fail=false;const roleReads=[];const api={list:async()=>{if(fail)throw Error('offline');return rows},schedule:async()=>({available:true,overview:{nextAt:'2026-10-12T01:00:00Z'}})},directory=createConversationPlanDirectory(api),opened=[];directory.onOpen(id=>opened.push(id));
const listeners=new Set(),empty={entries:[]};let history=empty;const events={subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener)},getSnapshot:()=>history};const entries=[{event:{seq:1,type:'tool/call',data:{turn:1,name:'teloa_plans_create',callId:'create'}}},{event:{seq:2,type:'tool/result',data:{turn:1,message:{toolCallId:'create',content:[{type:'text',text:JSON.stringify({plan:p})}]}}}}];
window.scheduleFixture={opened,roleReads,owner:async()=>{rows=[{...p,roleId:null,roleVersion:null,executor:{kind:'owner',grantId:p.id,grantVersion:1},source:{kind:'method-reuse',artifactId:p.id,version:1,basisHash:'a'.repeat(64),taskId:'33333333-3333-4333-8333-333333333333'}}];directory.merge(rows);await directory.refresh()},complete:()=>{history={entries};listeners.forEach(listener=>listener())},ids:(turn)=>conversationTurnPlanIds(entries,turn),change:async(value)=>{rows=[{...rows[0],...value}];directory.merge(rows);await directory.refresh()},second:async()=>{rows=[p,{...p,id:'33333333-3333-4333-8333-333333333333',title:'第二条计划'}];await directory.refresh()},fail:async()=>{fail=true;await directory.refresh().catch(()=>{})},recover:async()=>{fail=false;await directory.refresh()}};
createRoot(document.getElementById('root')).render(<I18nProvider runtime={runtime}><div id="empty"><ConversationPlanClock sessionId="blank" directory={directory}/></div><div id="linked"><span>会话名</span><ConversationPlanClock sessionId="ordinary" directory={directory}/></div><div id="completed"><ConversationPlanTurnCards turn={{turn:1,status:'closed'}} events={events} directory={directory} api={api} roleName={async id=>{roleReads.push(id);return '小研'}}/></div><ConversationPlanCard block={{isError:false,content:[{type:'text',text:JSON.stringify({plan:p})}]}} phase="result" directory={directory} api={api} roleName={async id=>{roleReads.push(id);return '小研'}}/></I18nProvider>);directory.refresh();
`
before(async()=>{
 temp=await mkdtemp(join(root,'.runtime-conversation-schedule-'));await writeFile(join(temp,'fixture.tsx'),entry)
 const result=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'ScheduleFixture',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle);script=bundle.output.find(item=>item.type==='chunk')!.code;styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n');browser=await loadPlaywright().chromium.launch(launchOptions())
})
after(async()=>{await browser?.close();if(temp)await rm(temp,{recursive:true,force:true})})
async function mount(t:any){const page=await browser.newPage({viewport:{width:1000,height:800}}),errors:string[]=[];page.setDefaultTimeout(3000);page.on('pageerror',(error:Error)=>errors.push(error.message));t.after(async()=>{await page.close();assert.deepEqual(errors,[])});await page.route('**/*',(route:any)=>route.abort());await page.setContent('<!doctype html><html><body><div id="root"></div></body></html>');await page.addStyleTag({content:styles});await page.addScriptTag({content:script});await page.getByRole('region',{name:'定时任务卡片'}).waitFor();return page}
test('紧凑卡片和时钟打开同一计划，暂停启用归档跟随实时记录，普通会话没有时钟',async t=>{
 const page=await mount(t),card=page.getByRole('region',{name:'定时任务卡片'}),clock=page.getByRole('button',{name:'查看定时计划（1）'})
 assert.equal(await page.locator('#empty button').count(),0);assert.ok((await card.boundingBox()).height<150)
 await card.getByRole('button').click();await clock.click();assert.deepEqual(await page.evaluate(()=>(window as any).scheduleFixture.opened),['11111111-1111-4111-8111-111111111111','11111111-1111-4111-8111-111111111111'])
 await page.evaluate(()=>(window as any).scheduleFixture.change({state:'active',version:2}));await page.waitForFunction(()=>document.querySelector('#linked button')?.getAttribute('data-active')==='true');assert.match(await card.innerText(),/已启用|启用/)
 await page.evaluate(()=>(window as any).scheduleFixture.change({state:'archived',version:3}));await clock.waitFor({state:'detached'});assert.match(await card.innerText(),/已归档/)
})
test('多计划选择各自身份，Escape和外部点击关闭菜单，读取失败不展示旧时钟',async t=>{
 const page=await mount(t);await page.evaluate(()=>(window as any).scheduleFixture.second());const clock=page.getByRole('button',{name:'查看定时计划（2）'});await clock.click();const menu=page.getByRole('dialog',{name:'会话定时计划'});await menu.getByRole('button',{name:/第二条计划/}).click();assert.deepEqual(await page.evaluate(()=>(window as any).scheduleFixture.opened),['33333333-3333-4333-8333-333333333333'])
 await clock.click();await page.keyboard.press('Escape');assert.equal(await menu.count(),0);await clock.click();await page.mouse.click(800,500);assert.equal(await menu.count(),0)
 await page.evaluate(()=>(window as any).scheduleFixture.fail());assert.equal(await page.locator('#linked button').count(),0);await page.evaluate(()=>(window as any).scheduleFixture.recover());assert.equal(await clock.isVisible(),true)
})

test('完成轮的持久回执延迟加载后仍显示卡片，其他轮不会错误复用',async t=>{
 const page=await mount(t);assert.equal(await page.locator('#completed section').count(),0)
 await page.evaluate(()=>(window as any).scheduleFixture.complete());await page.locator('#completed section').waitFor()
 assert.deepEqual(await page.evaluate(()=>(window as any).scheduleFixture.ids(2)),[])
 await page.locator('#completed').getByRole('button',{name:/打开计划/}).click()
 assert.deepEqual(await page.evaluate(()=>(window as any).scheduleFixture.opened),['11111111-1111-4111-8111-111111111111'])
})


test('本人负责的计划卡片显示通用Agent，不向员工目录查询null身份',async t=>{
 const page=await mount(t)
 await page.getByText(/小研/).waitFor()
 const reads=await page.evaluate(()=>(window as any).scheduleFixture.roleReads.length)
 await page.evaluate(()=>(window as any).scheduleFixture.owner())
 const card=page.getByRole('region',{name:'定时任务卡片'})
 await page.waitForFunction(()=>document.querySelector('section footer')?.textContent?.includes('通用 Agent'))
 assert.match(await card.innerText(),/通用 Agent/)
 assert.equal(await page.evaluate(()=>(window as any).scheduleFixture.roleReads.length),reads)
 assert.equal(await page.evaluate(()=>(window as any).scheduleFixture.roleReads.includes(null)),false)
 await card.getByRole('button',{name:/打开计划/}).click()
 assert.deepEqual(await page.evaluate(()=>(window as any).scheduleFixture.opened),['11111111-1111-4111-8111-111111111111'])
})

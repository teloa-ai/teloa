import assert from 'node:assert/strict'
import test from 'node:test'
import {fileURLToPath} from 'node:url'
import {createServer} from 'node:http'
import {build} from 'vite'
// @ts-expect-error 复用现有无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

// B8 三级危险确认：退役 AI 员工接 L3——列出真实影响与数量、输入员工名称前红色终按钮不可用、回车不执行；
// L2 不要求输入名称，默认焦点在「取消」。红色只用于最终执行按钮。
const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url)),virtual=root+'__danger_confirm_fixture.tsx'
const entry=`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import tokens from '${client}theme-tokens.module.css';import {prototypeThemes} from '${client}../brand/prototype-theme.ts';
import {RoleLifecycle} from '${client}RoleLifecycle.tsx';import {DangerConfirm} from '${client}DangerConfirm.tsx';import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';
for(const [key,value] of Object.entries(prototypeThemes.light))document.body.style.setProperty(key,value);
const calls=[];window.dangerFixture={calls};
const snapshot={locale:'zh-CN',dshLocale:'zh',revision:1},runtime={getSnapshot:()=>snapshot,subscribe:()=>()=>{},t:(key,params)=>translateMessage('zh-CN',key,params)};
const initial={id:'10000000-0000-4000-8000-000000000001',name:'Alex Morgan',kind:'employee',state:'active',storage:'persistent',version:3,scopes:['general']};
function App(){
 const [role,setRole]=useState(initial),[l2,setL2]=useState(false),impact=new URLSearchParams(location.search).get('groups')==='unknown'?{tasks:0}:{tasks:3,groups:2};
 const api={pending:undefined,error:undefined,recover:async()=>{},change:async(target,action,reason)=>{calls.push([target.id,action,reason]);setRole({...target,state:'retired'})}};
 return <main className={tokens.tokens} style={{padding:24}}><RoleLifecycle role={role} api={api} impact={impact}/>
  <button onClick={()=>setL2(true)}>打开 L2</button>{l2&&<DangerConfirm title="删除这条会话？" intro="删除后不能恢复。" confirmLabel="删除" confirm={()=>{calls.push(['l2']);setL2(false)}} close={()=>setL2(false)}/>}</main>;
}
createRoot(document.getElementById('root')).render(<I18nProvider runtime={runtime}><App/></I18nProvider>);`

test('退役员工走 L3：列出真实影响，输入名称前不能执行，回车不执行；L2 焦点在取消',async t=>{
 const built=await build({configFile:false,root,logLevel:'error',plugins:[{name:'danger-confirm-fixture',resolveId:(id:string)=>id.endsWith('danger-confirm-fixture')?virtual:null,load:(id:string)=>id===virtual?entry:null}],define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:')},lib:{entry:'danger-confirm-fixture',name:'DangerConfirmFixture',formats:['iife']}}})
 const bundle=Array.isArray(built)?built[0]:built;assert.ok(bundle&&'output'in bundle)
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const server=createServer((_,response)=>{response.setHeader('Content-Type','text/html; charset=utf-8');response.end('<!doctype html><html lang="zh-CN"><body><div id="root"></div></body></html>')})
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();return new Promise<void>(resolve=>server.close(()=>resolve()))})
 const address=server.address();assert.ok(address&&typeof address==='object');const origin='http://127.0.0.1:'+address.port
 const open=async(query='')=>{
  const page=await browser.newPage({viewport:{width:1280,height:860}});page.setDefaultTimeout(4000)
  const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));await page.route('**/*',(route:any)=>route.request().url().startsWith(origin+'/')?route.continue():route.abort())
  await page.goto(origin+'/'+query);await page.addStyleTag({content:bundle.output.flatMap(x=>x.type==='asset'&&x.fileName.endsWith('.css')?[String(x.source)]:[]).join('\n')});await page.addScriptTag({content:bundle.output.find(x=>x.type==='chunk')!.code})
  return {page,errors}
 }
 const {page,errors}=await open()
 const calls=()=>page.evaluate(()=>(window as any).dangerFixture.calls)
 await page.getByRole('button',{name:'退役',exact:true}).click()
 const dialog=page.getByRole('dialog',{name:'退役「Alex Morgan」？',exact:true});await dialog.waitFor()
 assert.deepEqual(await dialog.getByRole('listitem').allInnerTexts(),['3 项未完成任务转入交接，等你安排接手','所在的 2 个协作群不能再交给它工作','历史会话、记忆与成果保留，但不能再和它开始新会话'])
 await dialog.getByText('退役后不能恢复；未完成事项将进入交接。').waitFor()
 assert.equal(await page.evaluate(()=>document.activeElement?.tagName),'TEXTAREA','焦点先落在原因输入，不落在执行按钮')
 const run=dialog.getByRole('button',{name:'确认退役',exact:true}),nameBox=dialog.getByRole('textbox',{name:'输入名称「Alex Morgan」确认',exact:true})
 assert.equal(await run.isDisabled(),true)
 await dialog.getByRole('textbox',{name:'变更说明',exact:true}).fill('业务线调整');assert.equal(await run.isDisabled(),true,'未输入名称仍不可用')
 await nameBox.fill('Alex');assert.equal(await run.isDisabled(),true,'名称不符不可用')
 await nameBox.fill('Alex Morgan');assert.equal(await run.isDisabled(),false)
 await nameBox.press('Enter');assert.deepEqual(await calls(),[],'回车不直接执行')
 const colors=await run.evaluate((element:HTMLElement)=>{const style=getComputedStyle(element);return [style.backgroundColor,style.color]})
 assert.deepEqual(colors,['rgb(154, 61, 34)','rgb(255, 255, 255)'],'只有最终执行按钮是红色')
 assert.notEqual(await dialog.getByRole('button',{name:'取消',exact:true}).evaluate((element:HTMLElement)=>getComputedStyle(element).backgroundColor),'rgb(154, 61, 34)')
 await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});assert.deepEqual(await calls(),[],'Esc 只关闭')
 await page.getByRole('button',{name:'退役',exact:true}).click();await dialog.waitFor()
 assert.equal(await dialog.getByRole('textbox',{name:'变更说明',exact:true}).inputValue(),'业务线调整','关闭后原因草稿保留')
 assert.equal(await nameBox.inputValue(),'','名称确认每次重新输入')
 await nameBox.fill('Alex Morgan');await run.click()
 await dialog.waitFor({state:'detached'});assert.deepEqual(await calls(),[['10000000-0000-4000-8000-000000000001','retire','业务线调整']])
 await page.getByText('这位员工已退役，历史仍保留。').waitFor()
 await page.getByRole('button',{name:'打开 L2',exact:true}).click()
 const l2=page.getByRole('dialog',{name:'删除这条会话？',exact:true});await l2.waitFor()
 assert.equal(await l2.getByRole('textbox').count(),0,'L2 不要求输入名称')
 assert.equal(await page.evaluate(()=>document.activeElement?.textContent),'取消','L2 默认焦点在取消')
 await l2.getByRole('button',{name:'删除',exact:true}).click();await l2.waitFor({state:'detached'});assert.deepEqual((await calls()).at(-1),['l2'])
 assert.deepEqual(errors,[])
 // 协作群数未读到时如实写「所在的协作群」，没有未完成任务时写明无需交接
 const second=await open('?groups=unknown')
 await second.page.getByRole('button',{name:'退役',exact:true}).click()
 assert.deepEqual(await second.page.getByRole('dialog').getByRole('listitem').allInnerTexts(),['没有需要交接的未完成任务','所在的协作群不能再交给它工作','历史会话、记忆与成果保留，但不能再和它开始新会话'])
 assert.deepEqual(second.errors,[])
})

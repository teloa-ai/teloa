import test from 'node:test'
import assert from 'node:assert/strict'
import {fileURLToPath} from 'node:url'
import {build} from 'vite'
// @ts-expect-error 复用已固定的无头浏览器加载器。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'

test('群成员搜索、原员工单聊与本群授权共用身份，忙碌与失败不丢讨论草稿',{timeout:30000},async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url)),virtual=root+'__group_members_parity.tsx'
 const entry=`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {SavedGroupOverview} from '${client}SavedCollaborationPage.tsx';import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';
 const roles=[{id:'original-buyer',kind:'employee',name:'采购核查员',duty:'核查采购资料',state:'active',scopes:['general']},{id:'original-reviewer',kind:'employee',name:'付款复核员',duty:'复核付款证据',state:'active',scopes:['general']}];
 const f=window.memberFixture={calls:[],hold:false,fail:false,waiting:false,release:()=>{},switchGroup:()=>{},readonly:false,render:()=>{}};
 const snapshot={locale:'zh-CN',dshLocale:'zh-CN',revision:1},runtime={getSnapshot:()=>snapshot,subscribe:()=>()=>{},t:(key,params)=>translateMessage('zh-CN',key,params)};
 const grants=Object.fromEntries(roles.map(role=>[role.id,{status:'not-granted'}]));
 function App(){const [groupId,setGroupId]=useState('original-group'),[,refresh]=useState(0);f.switchGroup=setGroupId;f.render=()=>refresh(v=>v+1);const group={id:groupId,name:'采购协作',scope:'general',archived:f.readonly};return <I18nProvider runtime={runtime}><main><textarea aria-label="群讨论草稿" defaultValue="未发送的采购资料"/><aside aria-label="群成员面板" style={{width:360}}><SavedGroupOverview group={group} members={['self',...roles.map(role=>role.id)]} roles={roles} tasks={[]} profileName="Max" tab="members" membersOnly changeTab={()=>{}} blocked={f.readonly} addMembers={()=>f.calls.push(['add',groupId])} grants={grants} configureGrant={id=>f.calls.push(['grant',groupId,id])} work={{tasks:[],openTask:()=>{},openRole:id=>f.calls.push(['profile',id]),talkRole:async id=>{f.calls.push(['chat',id]);if(f.hold){f.waiting=true;await new Promise(resolve=>f.release=resolve);f.waiting=false}if(f.fail)throw Error('internal credential failure');return true}}}/></aside></main></I18nProvider>}createRoot(document.getElementById('root')).render(<App/>);`
 // 本用例不渲染消息正文；只隔离原生 Markdown 叶组件，成员、授权与概览均为真实组件。
 const markdown='\0group-members-markdown'
 const result=await build({configFile:false,root,logLevel:'error',resolve:{alias:[{find:'@deepseek-ai/dsh-client-ui-primitives',replacement:markdown}]},plugins:[{name:'group-members-parity',resolveId:id=>id.endsWith('group-members-parity')?virtual:id===markdown?markdown:null,load:id=>id===virtual?entry:id===markdown?'export function MarkdownText(){return null}':null}],define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:')},lib:{entry:'group-members-parity',name:'GroupMembersParity',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 const script=bundle.output.find(item=>item.type==='chunk')!.code,styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1280,height:800}});t.after(()=>page.close());page.setDefaultTimeout(3000)
 const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));await page.route('**/*',(route:any)=>route.abort())
 await page.setContent('<!doctype html><html lang="zh-CN"><body><div id="root"></div></body></html>');await page.addStyleTag({content:':root{--teloa-border:#ddd;--teloa-text:#242823;--teloa-muted:#63695f;--teloa-surface:#fff}body{font-family:system-ui}'+styles});await page.addScriptTag({content:script})
 const view=page.getByRole('complementary',{name:'群成员面板'}),search=view.getByRole('textbox',{name:'搜索姓名或职责'})
 await search.waitFor()
 assert.equal(await view.getByText('Max',{exact:true}).count(),1)
 assert.equal(await view.getByText('本人',{exact:true}).count(),0)
 assert.equal(await view.getByText('我',{exact:true}).count(),1)
 await search.fill('采购')
 assert.equal(await view.getByRole('button',{name:'付款复核员',exact:true}).count(),0)
 await view.getByRole('button',{name:'采购核查员',exact:true}).click();await view.getByRole('button',{name:'采购核查员的本群授权',exact:true}).click()
 assert.deepEqual(await page.evaluate(()=>(window as any).memberFixture.calls),[['profile','original-buyer'],['grant','original-group','original-buyer']])
 const chat=view.getByRole('button',{name:'与采购核查员对话',exact:true})
 await page.evaluate(()=>(window as any).memberFixture.hold=true);await chat.click();await page.waitForFunction(()=>(window as any).memberFixture.waiting)
 assert.equal(await chat.isEnabled(),false,'同一员工原会话打开期间不能重复创建')
 await page.evaluate(()=>{const f=(window as any).memberFixture;f.fail=true;f.release()});await view.getByRole('alert').waitFor()
 assert.doesNotMatch(await view.getByRole('alert').innerText(),/credential|internal/)
 assert.equal(await page.getByLabel('群讨论草稿').inputValue(),'未发送的采购资料')
 await page.evaluate(()=>{const f=(window as any).memberFixture;f.hold=false;f.fail=false;f.readonly=true;f.render()})
 assert.equal(await view.getByRole('button',{name:'采购核查员的本群授权',exact:true}).isEnabled(),false,'归档群不能扩大授权')
 assert.equal(await chat.isEnabled(),true,'归档不影响员工原单聊的独立入口')
 await chat.click();assert.deepEqual(await page.evaluate(()=>(window as any).memberFixture.calls.at(-1)),['chat','original-buyer'])
 await page.evaluate(()=>{const f=(window as any).memberFixture;f.hold=true;f.fail=true});await chat.click();await page.waitForFunction(()=>(window as any).memberFixture.waiting)
 await page.evaluate(()=>{const f=(window as any).memberFixture;f.switchGroup('another-group');f.release()})
 await page.waitForFunction(()=>document.querySelector('input[aria-label="搜索姓名或职责"]')?.getAttribute('value')==='')
 assert.equal(await view.getByRole('alert').count(),0,'迟到的单聊失败不写入另一个群')
 assert.equal(await view.getByRole('button',{name:'付款复核员',exact:true}).count(),1)
 assert.deepEqual(errors,[])
})

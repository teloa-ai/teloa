import test from 'node:test'
import assert from 'node:assert/strict'
import {fileURLToPath} from 'node:url'
import {build} from 'vite'
// @ts-expect-error 复用已固定的无头浏览器加载器。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'

test('宽屏无偏好进入工作概览且不抢焦点；本人关闭按群保存，常规宽度不自动展开，草稿保留',{timeout:30000},async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url)),entryId=root+'__group_default_panel.tsx',markdown='\0group-default-panel-markdown'
 const entry=`import React from 'react';import {createRoot} from 'react-dom/client';import {SavedCollaborationPage} from '${client}SavedCollaborationPage.tsx';import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';import {createGroupWorkLinkApi} from '${client}group-work-links-api.ts';
 const workItems=[{kind:'business',scope:'SOC',type:'incident',id:'INC-207',title:'凭据异常调查',state:'running',available:true,objectVersion:2},{kind:'business',scope:'SOC',type:'alert',id:'ALT-521',title:null,state:null,available:false,objectVersion:null},{kind:'project',scope:'general',id:'44444444-4444-4444-8444-444444444444',title:'季度身份治理',state:'planning',available:true,objectVersion:1},{kind:'task',scope:'general',id:'55555555-5555-4555-8555-555555555555',title:'补查审计窗口',state:'waiting',available:true,objectVersion:1}];
 const roles=[{id:'employee-a',kind:'employee',name:'林析',duty:'核对证据',state:'active',scopes:['general']}];
 const stamp='2026-10-14T00:00:00.000Z',ids={a:'11111111-1111-4111-8111-111111111111',b:'22222222-2222-4222-8222-222222222222',c:'33333333-3333-4333-8333-333333333333'};
 const group=id=>({id,ownerId:'self',name:id===ids.a?'采购核查群':id===ids.b?'付款复核群':'交付协作群',scope:'general',announcement:'',rules:{historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true},pinned:false,archived:false,version:1,createdAt:stamp,updatedAt:stamp});
 const rows=new Map(),preferences={getItem:key=>rows.get(key)??null,setItem:(key,value)=>{rows.set(key,value)},removeItem:key=>{rows.delete(key)}};
 let release,gate;const hold=()=>{gate=new Promise(resolve=>{release=resolve})};hold();
 const f=window.panelFixture={ids,target:{groupId:ids.a,rootId:''},preferences:()=>Object.fromEntries(rows),release:()=>release(),hold,linkReads:0,opened:[],render:()=>{}};
 const links=createGroupWorkLinkApi(async(endpoint,request)=>{if(endpoint!=='groups/work/get')throw Error('Unexpected endpoint');f.linkReads++;return {groupId:request.groupId,groupVersion:1,version:1,items:request.groupId===ids.a?workItems:[]}});
 const work={tasks:[{id:'55555555-5555-4555-8555-555555555555',version:1,title:'补查审计窗口',scope:'general',state:'waiting',assigneeId:'employee-a'}],openTask:()=>{},openRole:id=>f.opened.push(['role',id]),links,openLink:item=>f.opened.push([item.kind,item.id])};
 const api={pending:()=>undefined,recoveryMessage:()=>undefined,list:async()=>({items:Object.values(ids).map(group)}),get:async id=>{await gate;return {group:group(id),members:[{groupId:id,roleId:null,createdAt:stamp}]}},messages:async()=>({items:[]}),resources:async()=>({items:[]})};
 const snapshot={locale:'zh-CN',dshLocale:'zh-CN',revision:1},runtime={getSnapshot:()=>snapshot,subscribe:()=>()=>{},t:(key,params)=>translateMessage('zh-CN',key,params)},app=createRoot(document.getElementById('root'));
 f.render=()=>app.render(<I18nProvider runtime={runtime}><input aria-label="目录搜索" defaultValue=""/><div id="teloa-main" tabIndex={-1} aria-label="主工作区"/><SavedCollaborationPage api={api} preferences={preferences} work={work} visible={true} target={f.target} roles={roles} profileName="Max" directory={{refresh:async()=>{},open:()=>{},select:()=>{},createRequest:0,createHandled:()=>{}}}/></I18nProvider>);`
 const result=await build({configFile:false,root,logLevel:'error',resolve:{alias:[{find:'@deepseek-ai/dsh-client-ui-primitives',replacement:markdown}]},plugins:[{name:'group-default-panel',resolveId:id=>id.endsWith('group-default-panel')?entryId:id===markdown?markdown:null,load:id=>id===entryId?entry:id===markdown?'export function MarkdownText(){return null}':null}],define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:')},lib:{entry:'group-default-panel',name:'GroupDefaultPanel',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 const styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1440,height:900}});t.after(()=>page.close());page.setDefaultTimeout(3000)
 const errors:string[]=[];page.on('pageerror',(e:Error)=>errors.push(e.message));await page.route('**/*',(r:any)=>r.abort())
 await page.setContent('<html lang="zh-CN"><body><div id="root"></div></body></html>');await page.addStyleTag({content:styles});await page.addScriptTag({content:bundle.output.find(item=>item.type==='chunk')!.code})
 const search=page.getByRole('textbox',{name:'目录搜索',exact:true}),overview=page.getByRole('complementary',{name:'工作概览',exact:true}),message=page.getByRole('textbox',{name:'群讨论消息',exact:true})
 const open=async(key:'a'|'b'|'c',name:string)=>{await page.evaluate((id:string)=>{const f=(window as any).panelFixture;f.target={groupId:f.ids[id],rootId:''};f.render()},key);await page.getByRole('heading',{name,exact:true}).waitFor()}
 const focused=()=>page.evaluate(()=>document.activeElement?.getAttribute('aria-label'))
 // 首次读取先挂起：确保焦点已在外部输入后，概览才随群一起展开。
 await page.evaluate(()=>(window as any).panelFixture.render());await search.waitFor();await search.focus()
 await page.evaluate(()=>(window as any).panelFixture.release())
 await page.getByRole('heading',{name:'采购核查群',exact:true}).waitFor();await overview.waitFor()
 assert.equal(await focused(),'目录搜索','默认展开的概览不抢走当前输入焦点')
 assert.deepEqual(await page.evaluate(()=>(window as any).panelFixture.preferences()),{},'默认展开不伪造本人偏好')
 // 概览“全部关联工作”只筛选同一份关联读取；无权限对象保持不可打开，负责员工进入原档案。
 const filter=overview.getByRole('combobox',{name:'筛选关联工作',exact:true});await filter.waitFor()
 const reads=await page.evaluate(()=>(window as any).panelFixture.linkReads)
 assert.deepEqual(await filter.locator('option').allInnerTexts(),['全部关联工作','业务记录 · 2','项目 · 1','任务 · 1'])
 await page.screenshot({path:process.env.GROUP_PANEL_SHOT??'/tmp/teloa-group-default-panel.png'})
 await filter.selectOption('business')
 assert.equal(await overview.getByRole('button',{name:'原对象已不可用',exact:true}).isDisabled(),true)
 assert.equal(await overview.getByRole('button',{name:'凭据异常调查',exact:true}).count(),1)
 assert.equal(await overview.getByRole('button',{name:'季度身份治理',exact:true}).count(),0)
 await filter.selectOption('task');await overview.getByRole('button',{name:'查看林析的档案：补查审计窗口',exact:true}).click()
 assert.deepEqual(await page.evaluate(()=>(window as any).panelFixture.opened),[['role','employee-a']])
 assert.equal(await page.evaluate(()=>(window as any).panelFixture.linkReads),reads,'筛选不重新读取关联')
 await filter.selectOption('all');assert.equal(await overview.getByRole('button',{name:'季度身份治理',exact:true}).count(),1)
 await message.fill('A 群未发送草稿');await search.focus()
 await page.evaluate(()=>(window as any).panelFixture.hold())
 await page.evaluate(()=>{const f=(window as any).panelFixture;f.target={groupId:f.ids.b,rootId:''};f.render()})
 await overview.waitFor({state:'hidden'})
 assert.equal(await focused(),'目录搜索','概览随切群收起时不把焦点拉回')
 await page.evaluate(()=>(window as any).panelFixture.release())
 await page.getByRole('heading',{name:'付款复核群',exact:true}).waitFor();await overview.waitFor()
 assert.equal(await focused(),'目录搜索','切群时概览短暂收起再展开也不拉走焦点')
 await overview.getByRole('button',{name:'关闭协作侧栏',exact:true}).click();await overview.waitFor({state:'hidden'})
 const key='teloa.group-panel/v1/22222222-2222-4222-8222-222222222222'
 assert.deepEqual(JSON.parse((await page.evaluate(()=>(window as any).panelFixture.preferences()))[key]),{schema:'teloa.group-panel/v1',kind:'closed',tab:'work'})
 await open('a','采购核查群');await overview.waitFor()
 assert.equal(await message.inputValue(),'A 群未发送草稿','切群与默认概览不改动原群草稿')
 await open('b','付款复核群');await page.waitForTimeout(100)
 assert.equal(await overview.isVisible(),false,'本人关闭过的群在宽屏也保持关闭')
 await page.setViewportSize({width:1100,height:900})
 await open('c','交付协作群');await page.waitForTimeout(100)
 assert.equal(await overview.isVisible(),false,'打开会挤掉目录的常规宽度不自动展开')
 assert.deepEqual(errors,[])
})

import test from 'node:test'
import assert from 'node:assert/strict'
import {fileURLToPath} from 'node:url'
import {build} from 'vite'
// @ts-expect-error 复用当前工作树的无头浏览器加载器。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'

test('真实群根装配切换双向只留当前群，保留各自草稿且迟到发送不串群或重发',{timeout:40000},async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url)),entryId=root+'__group_switch_root.tsx',markdown='\0group-switch-root-markdown'
 const entry=`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {CollaborationPage} from '${client}CollaborationPage.tsx';import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';
 const stamp='2026-10-21T00:00:00.000Z',ids={a:'11111111-1111-4111-8111-111111111111',b:'22222222-2222-4222-8222-222222222222'},messages=[];
 const group=id=>({id,ownerId:'self',name:id===ids.a?'来源A群':'来源B群',scope:'general',announcement:'',rules:{historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true},pinned:false,archived:false,version:1,createdAt:stamp,updatedAt:stamp});
 const f=window.groupSwitchFixture={ids,writes:[],select:()=>{},release:()=>{}};
 const api={pending:()=>undefined,recoveryMessage:()=>undefined,list:async()=>({items:Object.values(ids).map(group)}),get:async id=>({group:group(id),members:[{groupId:id,roleId:null,createdAt:stamp}]}),messages:async id=>({items:messages.filter(row=>row.groupId===id)}),resources:async()=>({items:[]}),send:async(groupId,version,text)=>{f.writes.push({groupId,version,text});await new Promise(resolve=>f.release=resolve);const row={id:'33333333-3333-4333-8333-333333333333',groupId,rootId:null,authorId:'self',text,references:[],mentions:[],createdAt:stamp};messages.push(row);return row}};
 const snapshot={locale:'zh-CN',dshLocale:'zh-CN',revision:1},runtime={getSnapshot:()=>snapshot,subscribe:()=>()=>{},t:(key,params)=>translateMessage('zh-CN',key,params)};
 // 与 WorkbenchFrame 的真实装配一致：同时提供身份和关联工作详情渲染端口。
 const work={tasks:[],openTask:()=>{},openRole:()=>{},renderRole:()=>null,renderLink:()=>null};
 function Root(){const [target,setTarget]=useState({groupId:ids.a,rootId:''});f.select=key=>setTarget({groupId:ids[key],rootId:''});return <I18nProvider runtime={runtime}><CollaborationPage visible work={work} target={target} roles={[]} profileName="本人" persistence={{api,directory:{refresh:async()=>{},open:()=>{},select:()=>{},createRequest:0,createHandled:()=>{}}}}/></I18nProvider>}
 createRoot(document.getElementById('root')).render(<Root/>);`
 const result=await build({configFile:false,root,logLevel:'error',resolve:{alias:[{find:'@deepseek-ai/dsh-client-ui-primitives',replacement:markdown}]},plugins:[{name:'group-switch-root',resolveId:id=>id.endsWith('group-switch-root')?entryId:id===markdown?markdown:null,load:id=>id===entryId?entry:id===markdown?'export function MarkdownText({text}){return text}':null}],define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:')},lib:{entry:'group-switch-root',name:'GroupSwitchRoot',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1440,height:1000}});t.after(()=>page.close());page.setDefaultTimeout(3000)
 const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));await page.route('**/*',(route:any)=>route.abort())
 await page.setContent('<html lang="zh-CN"><body style="margin:0"><div id="root" style="height:100vh"></div></body></html>')
 await page.addStyleTag({content:bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')});await page.addScriptTag({content:bundle.output.find(item=>item.type==='chunk')!.code})
 const composer=page.getByRole('textbox',{name:'群讨论消息',exact:true}),send=page.getByRole('button',{name:'发送群消息',exact:true})
 const select=async(key:'a'|'b',title:string)=>{await page.evaluate((key:string)=>(window as any).groupSwitchFixture.select(key),key);await page.getByRole('heading',{name:title,exact:true}).waitFor();assert.equal(await composer.count(),1,'切群后只能挂载当前群输入框');assert.equal(await page.getByRole('region',{name:'协作群',exact:true}).count(),1,'旧群根节点必须卸载')}
 await page.getByRole('heading',{name:'来源A群',exact:true}).waitFor();await composer.fill('A群保留输入')
 await select('b','来源B群');assert.equal(await composer.inputValue(),'');await composer.fill('B群保留输入')
 await select('a','来源A群');assert.equal(await composer.inputValue(),'A群保留输入')
 assert.deepEqual(await page.evaluate(()=>(window as any).groupSwitchFixture.writes),[],'导航不能隐式发送')
 await send.click();await page.waitForFunction(()=>(window as any).groupSwitchFixture.writes.length===1)
 await select('b','来源B群');assert.equal(await composer.inputValue(),'B群保留输入')
 await page.evaluate(()=>(window as any).groupSwitchFixture.release())
 await select('a','来源A群');await page.getByText('A群保留输入',{exact:true}).waitFor();assert.equal(await composer.inputValue(),'','迟到回执只清理已发出的原群草稿')
 await select('b','来源B群');assert.equal(await composer.inputValue(),'B群保留输入')
 assert.deepEqual(await page.evaluate(()=>(window as any).groupSwitchFixture.writes),[{groupId:'11111111-1111-4111-8111-111111111111',version:1,text:'A群保留输入'}],'明确发送一次，往返切群不得重复发送或改变原群')
 assert.deepEqual(errors,[])
})

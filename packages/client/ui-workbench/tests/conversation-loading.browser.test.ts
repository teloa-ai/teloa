import test from 'node:test'
import assert from 'node:assert/strict'
import {fileURLToPath} from 'node:url'
import {build} from 'vite'
// @ts-expect-error 复用仓库固定的无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

test('会话、员工与群连续点击：慢身份不阻塞员工，旧导航不抢回，慢资料不阻塞群消息',{timeout:60000},async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url)),entryId=root+'__conversation_loading.tsx',markdown='\0conversation-loading-markdown'
 const entry=`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
 import {WorkDirectory} from '${client}WorkDirectory.tsx';import {SavedCollaborationPage} from '${client}SavedCollaborationPage.tsx';
 import {BindingClient} from '${client}binding-client.ts';import {createConversationGroupDirectory} from '${client}conversation-group-directory.ts';
 import {createDialogueOrganization} from '${client}dialogue-organization.ts';import {ConversationSearch} from '${client}conversation-search.ts';
 import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';
 const noop=()=>()=>{},at='2026-10-30T00:00:00Z',id='11111111-1111-4111-8111-111111111111';
 const row=id=>({id:'work-'+id,sessionId:id,requestedSessionId:id,ownerId:'self',title:id,scopeIds:['general'],version:1,status:'ready',createdAt:at}),rows=['slow','fast','employee'].map(row);
 const group={id,ownerId:'self',name:'加载验证群',scope:'general',announcement:'',pinned:false,archived:false,version:1,createdAt:at,updatedAt:at,rules:{historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true}};
 const message={id:'22222222-2222-4222-8222-222222222222',groupId:id,rootId:null,authorId:'self',authorKind:'self',text:'先显示群消息，不等资料',references:[],mentions:[],mentionAll:false,createdAt:at};
 let resolveBinding,resolveIdentity,resolveResources;
 const binding=new Promise(yes=>resolveBinding=yes),identity=new Promise(yes=>resolveIdentity=yes),materials=new Promise(yes=>resolveResources=yes),f=window.loadingFixture={opened:[],ensureCalls:0,listCalls:0,mode:'directory',releaseBinding:()=>resolveBinding(row('slow')),releaseIdentity:()=>resolveIdentity([]),releaseResources:()=>resolveResources({items:[]})};
 const data=new Map(),organization=createDialogueOrganization({getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value)});
 const roles=[{id:'role',name:'快速员工',state:'active',kind:'employee',avatarKey:'squirrel-general'}],objectApi={bySession:async sessionId=>sessionId==='slow'?identity:sessionId==='employee'?[{kind:'role',sessionId,objectId:'role',active:true}]:[]};
 let show=()=>{};
 const work=new BindingClient({isNativeChild:()=>false,list:async()=>{f.listCalls++;return rows},read:async id=>row(id),ensure:async id=>{f.ensureCalls++;return id==='slow'?binding:row(id)},block:()=>{},catalog:async()=>{throw Error('不读能力')},create:async()=>{throw Error('不创建')},adopt:async id=>id,current:()=>undefined,open:id=>{f.opened.push(id)}});
 const groups=createConversationGroupDirectory({list:async()=>({items:[group]})});
 const search=new ConversationSearch(async()=>({items:[],hasMore:false}),()=>rows.map(row=>row.sessionId)),managed={ready:true,baseline:true,archived:[],workspaces:[],pending:{}},management={subscribe:noop,getSnapshot:()=>managed},native={byId:Object.fromEntries(rows.map(row=>[row.sessionId,{id:row.sessionId,title:row.title,running:false,blank:false,updatedAt:1}])),ids:rows.map(row=>row.sessionId)};
 const api={pending:()=>undefined,recoveryMessage:()=>undefined,get:async()=>({group,members:[{groupId:id,roleId:null,createdAt:at}]}),messages:async()=>({items:[message]}),resources:()=>materials,reading:async()=>({schema:'teloa.group-reading/v1',groupId:id,rootId:null,cursor:null,latest:{messageId:message.id,createdAt:at},unreadCount:0}),markRead:async()=>({schema:'teloa.group-reading/v1',groupId:id,rootId:null,cursor:{messageId:message.id,createdAt:at},latest:{messageId:message.id,createdAt:at},unreadCount:0})};
 const snapshot={locale:'zh-CN',dshLocale:'zh-CN',revision:1},runtime={getSnapshot:()=>snapshot,subscribe:noop,t:(key,params)=>translateMessage('zh-CN',key,params)};
 function App(){const [mode,setMode]=useState('directory');show=value=>{f.mode=value;setMode(value)};return <I18nProvider runtime={runtime}><div style={{height:'100vh',display:'flex'}}><div style={{width:280,flexShrink:0}}><WorkDirectory organization={organization} work={work} management={management} search={search} groups={groups} roles={roles} objectApi={objectApi} useSessions={select=>select(native)} current={undefined} onOpened={()=>show('native')} focusRequest={0} onClose={()=>{}} selectedGroup={mode==='group'?id:undefined} openGroup={()=>show('group')} createGroup={()=>{}}/></div>{mode==='group'&&<SavedCollaborationPage api={api} visible target={{groupId:id,rootId:''}} roles={[]} profileName="Max" directory={{refresh:async()=>{},open:()=>{},select:()=>{},createRequest:0,createHandled:()=>{}}}/>}</div></I18nProvider>}
 Promise.all([work.refreshDirectory(),groups.refresh()]).then(()=>createRoot(document.getElementById('root')).render(<App/>));`
 const built=await build({configFile:false,root,logLevel:'error',resolve:{alias:[{find:'@deepseek-ai/dsh-client-ui-primitives',replacement:markdown}]},plugins:[{name:'conversation-loading-fixture',resolveId:id=>id.endsWith('conversation-loading-fixture')?entryId:id===markdown?markdown:null,load:id=>id===entryId?entry:id===markdown?'import React from "react";export function MarkdownText({text,children}){return React.createElement("p",null,text??children)}':null}],define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,target:'esnext',rollupOptions:{external:(id:string)=>id.startsWith('node:')},lib:{entry:'conversation-loading-fixture',name:'ConversationLoadingFixture',formats:['iife']}}})
 const bundle=Array.isArray(built)?built[0]:built;assert.ok(bundle&&'output'in bundle)
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 for(const viewport of [{width:1440,height:900},{width:430,height:900}]){
  const page=await browser.newPage({viewport}),errors:string[]=[];t.after(()=>page.close());page.setDefaultTimeout(3000);page.on('pageerror',(error:Error)=>errors.push(error.message))
  await page.route('**/*',(route:any)=>route.abort());await page.setContent('<html lang="zh-CN"><style>html,body,#root{height:100%;margin:0}body{font:14px sans-serif;--teloa-text:#222;--teloa-background:#fff;--teloa-surface:#f6f6f6;--teloa-border:#ddd}</style><body><div id="root"></div></body></html>')
  for(const asset of bundle.output)if(asset.type==='asset'&&asset.fileName.endsWith('.css'))await page.addStyleTag({content:String(asset.source)})
  await page.addScriptTag({content:bundle.output.find(item=>item.type==='chunk')!.code})
  const directory=page.locator('[data-teloa-pane="directory"]')
  await directory.locator('[data-session-id="fast"]').waitFor()
  await directory.getByRole('button',{name:'员工',exact:true}).click();await directory.locator('[data-session-id="employee"]').waitFor()
  assert.equal(await page.evaluate(()=>(window as any).loadingFixture.ensureCalls),0,'身份读取不打开或创建会话')
  await directory.getByRole('button',{name:'会话',exact:true}).click()
  const slow=directory.locator('[data-session-id="slow"]').getByRole('button').first();await slow.click();await slow.click()
  assert.equal(await page.evaluate(()=>(window as any).loadingFixture.ensureCalls),1,'重复点击同一在途目标只读取一次')
  assert.equal(await slow.getAttribute('aria-busy'),'true')
  await directory.getByRole('button',{name:'群',exact:true}).click();await directory.locator('[data-group-id]').getByRole('button').first().click()
  await page.getByText('先显示群消息，不等资料',{exact:true}).waitFor()
  const input=page.getByRole('textbox',{name:'群讨论消息',exact:true});await input.fill('尚未发送的群草稿')
  await page.evaluate(()=>{const f=(window as any).loadingFixture;f.releaseBinding();f.releaseIdentity()});await page.waitForTimeout(100)
  assert.deepEqual(await page.evaluate(()=>(window as any).loadingFixture.opened),[])
  assert.equal(await page.evaluate(()=>(window as any).loadingFixture.mode),'group')
  await page.evaluate(()=>(window as any).loadingFixture.releaseResources());await page.waitForTimeout(100)
  assert.equal(await input.inputValue(),'尚未发送的群草稿');assert.deepEqual(errors,[])
  await page.close()
 }
})

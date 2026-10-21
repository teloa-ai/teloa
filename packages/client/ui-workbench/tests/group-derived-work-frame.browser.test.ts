import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {build} from 'vite'
import ts from 'typescript'
// @ts-expect-error 复用本工作树已有的无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

type BrowserFixture={
 controller:{getSnapshot:()=>{status:string}}
 openOriginalGroup:()=>void
 completeOriginalWork:()=>void
 refreshGroup:()=>Promise<void>
 taskReads:number
 routingReads:number
 writes:string[]
 taskIds:string[]
 taskTitles:string[]
}

test('真实 Frame 原群后台派工后刷新任务台账，右概览显示并打开原三项任务且不重复轮询台账',{timeout:60000},async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
 const source=await readFile(join(root,'packages/client/ui-workbench/tests/business-builder-frame.test.ts'),'utf8'),ast=ts.createSourceFile('fixture.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS)
 let expression:ts.Expression|undefined
 const visit=(node:ts.Node)=>{if(ts.isVariableDeclaration(node)&&node.name.getText(ast)==='entry')expression=node.initializer;ts.forEachChild(node,visit)}
 visit(ast);assert.ok(expression)
 let entry=new Function('client','return '+expression.getText(ast))(client) as string
 const setup=String.raw`
const groupId='10000000-0000-4000-8000-000000000001',messageId='20000000-0000-4000-8000-000000000001';
f.taskIds=[1,2,3].map(i=>'30000000-0000-4000-8000-00000000000'+i);f.taskTitles=['原派生任务一','原派生任务二','原派生任务三'];f.taskReads=0;f.routingReads=0;f.writes=[];f.completed=false;
const roleIds=[1,2,3].map(i=>'40000000-0000-4000-8000-00000000000'+i),runIds=[1,2,3].map(i=>'50000000-0000-4000-8000-00000000000'+i),replyIds=[1,2,3].map(i=>'60000000-0000-4000-8000-00000000000'+i);
const staff=roleIds.map((id,i)=>({...employee,id,name:'原员工'+(i+1)}));
const originalGroup={id:groupId,ownerId:'self',version:1,name:'原协作群',scope:'general',announcement:'',rules:{historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true},pinned:false,archived:false,createdAt:stamp,updatedAt:stamp};
const human={id:messageId,groupId,rootId:null,authorId:'self',text:'原群工作请求',references:[],mentions:[],createdAt:stamp};
const replies=roleIds.map((roleId,i)=>({id:replyIds[i],groupId,rootId:messageId,authorId:roleId,taskId:f.taskIds[i],runId:runIds[i],text:'原员工结果'+(i+1),references:[],createdAt:'2026-09-29T00:00:0'+(i+1)+'.000Z',contextMode:'main',replyToMessageId:messageId,author:{name:staff[i].name,kind:'employee',version:3}}));
const originalTasks=f.taskIds.map((id,i)=>({id,ownerId:'self',version:1,state:'waiting',createdAt:stamp,updatedAt:stamp,title:f.taskTitles[i],goal:'原群明确工作',scope:'general',groupId,assigneeRoleId:roleIds[i],assigneeRoleVersion:3}));
const call=async(endpoint,input)=>{
 if(endpoint==='groups/list')return [originalGroup];
 if(endpoint==='groups/get')return {group:originalGroup,members:[{groupId,roleId:null,createdAt:stamp},...roleIds.map(roleId=>({groupId,roleId,createdAt:stamp}))]};
 if(endpoint==='groups/messages/page')return groupMessagePageFixture(f.completed?[human,...replies]:[human],input);
 if(endpoint==='groups/reading/get'||endpoint==='groups/reading/mark')return groupMessageReadingFixture(f.completed?[human,...replies]:[human],input,f.cursors||(f.cursors={}));
 if(endpoint==='groups/attention')return {schema:'teloa.group-attention/v1',items:[]};
 if(endpoint==='groups/resources/list'||endpoint==='groups/attachments/list')return [];
 if(endpoint==='groups/reactions/list')return {items:[]};
 if(endpoint==='groups/agent-grants/get')return {groupVersion:1,roleVersion:3,grant:null,status:'not-granted'};
 if(endpoint==='groups/tasks/source')return null;
 if(endpoint==='groups/routing/list')return {items:input.messageIds.includes(messageId)&&f.completed?[{messageId,kind:'direct',respond:roleIds,hops:0}]:[]};
 if(endpoint==='groups/routing/status'){f.routingReads++;return {items:input.messageIds.includes(messageId)?[{messageId,attemptVersion:1,phase:f.completed?'completed':'received',recipients:f.completed?roleIds.map((roleId,i)=>({roleId,name:staff[i].name,taskId:f.taskIds[i],runId:runIds[i],phase:'completed',resultMessageId:replyIds[i],executionMode:'work'})):[],hintCode:null,canRetry:false}]:[]}};
 if(endpoint==='groups/work/get')return {groupId,groupVersion:1,version:0,items:[],projectLinks:[]};
 if(endpoint==='tasks/attention'){f.taskReads++;return {items:f.completed?originalTasks.map(task=>({task,attention:{kind:'review',reason:'task-waiting'}})):[]}};
 if(endpoint==='business-tasks/source')return null;
 f.writes.push(endpoint);throw Error('隔离群刷新不得调用未声明端口：'+endpoint);
};
props.groupApi=createGroupApi(call);props.groupRoutingApi=createGroupRoutingApi(call);props.taskApi=createTaskApi(call);props.groupWorkLinks=createGroupWorkLinkApi(call);
props.groupAttachmentApi=new Proxy(generic,{get:(target,key)=>key==='list'?async()=>[]:target[key]});props.groupReactionApi=createGroupReactionApi(call);
props.roleApi=new Proxy(generic,{get:(target,key)=>key==='list'?async()=>staff:target[key]});props.businessTaskApi=new Proxy(generic,{get:(target,key)=>key==='source'?async()=>null:target[key]});
f.openOriginalGroup=()=>store.actions.openGroupTopic(groupId,'');f.completeOriginalWork=()=>{f.completed=true};
`
 entry="import {createGroupApi} from '"+client+"group-api.ts';import {createTaskApi} from '"+client+"task-api.ts';import {createGroupRoutingApi} from '"+client+"group-routing-api.ts';import {createGroupReactionApi} from '"+client+"group-reaction-api.ts';import {createGroupWorkLinkApi} from '"+client+"group-work-links-api.ts';import {groupMessagePageFixture,groupMessageReadingFixture} from '"+client+"../../tests/fixtures/group-message-page-rpc.ts';\n"+entry
 entry=entry.replace("const frameRoot=",setup+"const frameRoot=")
 const temp=await mkdtemp(join(root,'.runtime-group-derived-frame-'));t.after(()=>rm(temp,{recursive:true,force:true}));await writeFile(join(temp,'entry.tsx'),entry)
 const isolated=['WorkDirectory','TaskPage','TeamPage','BusinessPage','MarketPage','TeamCapabilitiesPage','ResourceManager','ArtifactPanel','ProjectOverviewPage','CapabilityTargetPanel','SavedIndustryDirectory','AutoDreamSettingsPage'],stubbed=new Set(isolated.map(name=>join(client,name+'.tsx')))
 const markdown='\0group-derived-markdown',nodeCrypto='\0group-derived-node-crypto'
 const built=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},resolve:{alias:[{find:'@deepseek-ai/dsh-client-ui-primitives',replacement:markdown},{find:'node:crypto',replacement:nodeCrypto}]},plugins:[{name:'group-derived-frame',enforce:'pre',resolveId:id=>[markdown,nodeCrypto].includes(id)?id:null,load:async id=>{
  if(id===markdown)return 'export const MarkdownText=({text})=>text'
  if(id===nodeCrypto)return 'export function createHash(){throw Error("不能执行服务端摘要")};export function randomUUID(){return crypto.randomUUID()};export function createPublicKey(){throw Error("不能执行签名")};export function verify(){throw Error("不能执行签名")}'
  // 只控制调度时机；refresh 自身仍为原群正式读取，不替换 Frame、群页面或右栏逻辑。
  if(id===join(client,'group-message-refresh.ts'))return 'export function scheduleGroupMessageRefresh(refresh){const f=window.frameFixture;f.refreshGroup=refresh;return()=>{if(f.refreshGroup===refresh)f.refreshGroup=undefined}}'
  if(!stubbed.has(id))return
  const source=await readFile(id,'utf8'),exports=[...source.matchAll(/export (?:async )?(?:function|const|class) (\w+)/g)].map(match=>match[1])
  if(id===join(client,'TaskPage.tsx'))return 'import React from "react";export function TaskPage({visible,selected}){return visible?<output aria-label="原任务详情身份">{selected}</output>:null};'+exports.filter(name=>name!=='TaskPage').map(name=>'export const '+name+'=()=>null;').join('\n')
  return exports.map(name=>'export const '+name+'=()=>null;').join('\n')
 }}],build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'entry.tsx'),name:'GroupDerivedFrame',formats:['iife']}}})
 const bundle=Array.isArray(built)?built[0]:built;assert.ok(bundle&&'output'in bundle)
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1600,height:1000}});t.after(()=>page.close());page.setDefaultTimeout(4000)
 const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message))
 t.after(()=>assert.deepEqual(errors,[]))
 await page.route('**/*',async(route:{request:()=>{isNavigationRequest:()=>boolean};fulfill:(input:{contentType:string;body:string})=>Promise<void>;abort:()=>Promise<void>})=>route.request().isNavigationRequest()?route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="zh-CN"><body><div id="root"></div></body></html>'}):route.abort())
 await page.goto('https://fixture.invalid');await page.addStyleTag({content:bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')});await page.addScriptTag({content:bundle.output.find(item=>item.type==='chunk')!.code})
 await page.waitForFunction(()=> (window as unknown as {frameFixture:BrowserFixture}).frameFixture.controller.getSnapshot().status==='ready')
 await page.evaluate(()=> (window as unknown as {frameFixture:BrowserFixture}).frameFixture.openOriginalGroup())
 await page.getByRole('button',{name:'原协作群',exact:true}).waitFor().catch(async(error:unknown)=>{t.diagnostic(JSON.stringify({errors,...await page.evaluate(()=>({body:document.body.innerText.slice(-6000),state:(window as unknown as {frameFixture:{state:()=>unknown}}).frameFixture.state()}))}));throw error})
 const overview=page.getByRole('button',{name:'工作概览',exact:true})
 if(await overview.getAttribute('aria-expanded')!=='true')await overview.click()
 const panel=page.getByRole('complementary',{name:'工作概览',exact:true}),count=panel.getByRole('tab',{name:'关联工作 0',exact:true})
 await count.waitFor().catch(async(error:unknown)=>{t.diagnostic(JSON.stringify({errors,body:await page.locator('body').innerText()}));throw error});await page.waitForFunction(()=>typeof (window as unknown as {frameFixture:BrowserFixture}).frameFixture.refreshGroup==='function')
 const before=await page.evaluate(()=> (window as unknown as {frameFixture:BrowserFixture}).frameFixture.taskReads)
 await page.evaluate(async()=>{const f=(window as unknown as {frameFixture:BrowserFixture}).frameFixture;f.completeOriginalWork();await f.refreshGroup()})
 await page.locator('[data-teloa-message-id="60000000-0000-4000-8000-000000000003"]').waitFor()
 // 首个红例应发生在这里：群消息已更新，而父 Frame 尚未重读派生任务。
 await panel.getByRole('tab',{name:'关联工作 3',exact:true}).waitFor()
 const refreshed=await page.evaluate(()=> (window as unknown as {frameFixture:BrowserFixture}).frameFixture.taskReads)
 assert.equal(refreshed,before+1,'同一批真实群工作变化只需重读一次任务台账')
 const ids=await page.evaluate(()=> (window as unknown as {frameFixture:BrowserFixture}).frameFixture.taskIds),titles=await page.evaluate(()=> (window as unknown as {frameFixture:BrowserFixture}).frameFixture.taskTitles)
 for(let index=0;index<ids.length;index++){
  await panel.getByRole('button',{name:titles[index]+' · 原员工'+(index+1),exact:true}).click()
  const detail=page.getByRole('dialog',{name:titles[index],exact:true});await detail.waitFor()
  assert.equal(await detail.getByRole('status',{name:'原任务详情身份',exact:true}).textContent(),ids[index])
  await page.keyboard.press('Escape');await detail.waitFor({state:'hidden'})
 }
 await page.evaluate(async()=>{await (window as unknown as {frameFixture:BrowserFixture}).frameFixture.refreshGroup()})
 assert.equal(await page.evaluate(()=> (window as unknown as {frameFixture:BrowserFixture}).frameFixture.taskReads),refreshed,'没有新路由或 Run 结果的下一轮不重复读台账')
 assert.deepEqual(await page.evaluate(()=> (window as unknown as {frameFixture:BrowserFixture}).frameFixture.writes),[])
 assert.deepEqual(errors,[])
})

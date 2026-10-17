import test from 'node:test'
import assert from 'node:assert/strict'
import {fileURLToPath} from 'node:url'
import {build} from 'vite'
// @ts-expect-error 复用已固定的无头浏览器加载器。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'

// 真实 CollaborationPage／SavedCollaborationPage 与工作台同一组让位 helper 和呈现端口；外层只模拟工作台轨道宽度。
test('群侧栏在 963/1440 只在渲染期让出共享目录，收起、放宽或主动打开目录后原目录回来',{timeout:40000},async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url)),entryId=root+'__group_directory_yield.tsx',markdown='\0group-directory-yield-markdown'
 const entry=`import React,{useEffect,useMemo,useState} from 'react';import {createRoot} from 'react-dom/client';import {CollaborationPage} from '${client}CollaborationPage.tsx';import {directoryNeedsRoom,directoryShown,directoryTrackWidth,groupPanelReport,navigationTrackWidth} from '${client}rightbar-width.ts';import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';import {createGroupWorkLinkApi} from '${client}group-work-links-api.ts';
 const stamp='2026-10-14T00:00:00.000Z',ids={a:'11111111-1111-4111-8111-111111111111',b:'22222222-2222-4222-8222-222222222222'};
 const workItems=[{kind:'business',scope:'SOC',type:'incident',id:'INC-207',title:'凭据异常调查',state:'running',available:true,objectVersion:2},{kind:'project',scope:'general',id:'44444444-4444-4444-8444-444444444444',title:'季度身份治理',state:'planning',available:true,objectVersion:1},{kind:'task',scope:'general',id:'55555555-5555-4555-8555-555555555555',title:'补查审计窗口',state:'waiting',available:true,objectVersion:1}];
 const roles=[{id:'employee-a',kind:'employee',name:'林析',duty:'核对证据',state:'active',scopes:['general']}];
 const group=id=>({id,ownerId:'self',name:id===ids.a?'采购核查群':'付款复核群',scope:'general',announcement:'',rules:{historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true},pinned:false,archived:false,version:1,createdAt:stamp,updatedAt:stamp});
 const rows=new Map(),preferences={getItem:key=>rows.get(key)??null,setItem:(key,value)=>{rows.set(key,value)},removeItem:key=>{rows.delete(key)}};
 const f=window.yieldFixture={ids,preferences:()=>Object.fromEntries(rows),state:()=>({}),select:()=>{}};
 const links=createGroupWorkLinkApi(async(endpoint,request)=>{if(endpoint!=='groups/work/get')throw Error('Unexpected endpoint');return {groupId:request.groupId,groupVersion:1,version:1,items:request.groupId===ids.a?workItems:[]}});
 const work={tasks:[{id:'55555555-5555-4555-8555-555555555555',version:1,title:'补查审计窗口',scope:'general',state:'waiting',assigneeId:'employee-a'}],openTask:()=>{},openRole:()=>{},talkRole:async()=>true,links,openLink:()=>{}};
 const api={pending:()=>undefined,recoveryMessage:()=>undefined,list:async()=>({items:Object.values(ids).map(group)}),get:async id=>({group:group(id),members:[{groupId:id,roleId:null,createdAt:stamp},{groupId:id,roleId:'employee-a',createdAt:stamp}]}),messages:async()=>({items:[]}),resources:async()=>({items:[]}),agentGrant:async()=>({status:'not-granted'})};
 const snapshot={locale:'zh-CN',dshLocale:'zh-CN',revision:1},runtime={getSnapshot:()=>snapshot,subscribe:()=>()=>{},t:(key,params)=>translateMessage('zh-CN',key,params)};
 function Frame(){
  const [viewport,setViewport]=useState(innerWidth),[directoryOpen,setDirectoryOpen]=useState(true),[target,setTarget]=useState({groupId:ids.a,rootId:''}),[openGroupId,setOpenGroupId]=useState(),[collapse,setCollapse]=useState();
  const report=useMemo(()=>(groupId,open)=>setOpenGroupId(current=>groupPanelReport(current,groupId,open)),[]),port=useMemo(()=>({report,collapse}),[report,collapse]);
  useEffect(()=>{const resize=()=>setViewport(innerWidth);addEventListener('resize',resize);return()=>removeEventListener('resize',resize)},[]);
  // 与 WorkbenchFrame 相同的派生：按当前群身份判定群侧栏，不改写本人的目录选择。
  const occupants={rightbar:false,groupPanel:openGroupId===target.groupId},visible=directoryShown(viewport,directoryOpen,occupants);
  const openDirectory=()=>{if(directoryNeedsRoom(viewport,occupants)&&occupants.groupPanel)setCollapse(current=>({groupId:target.groupId,seq:(current?.seq??0)+1}));setDirectoryOpen(true)};
  f.state=()=>({viewport,directoryOpen,visible,openGroupId});f.select=key=>setTarget({groupId:ids[key],rootId:''});
  return <I18nProvider runtime={runtime}><div style={{display:'flex',height:'100vh'}}>
   {navigationTrackWidth(viewport)>0&&<nav aria-label="主导航" style={{width:navigationTrackWidth(viewport),flex:'none'}}/>}
   <aside aria-label="工作会话目录" hidden={!visible} style={{width:directoryTrackWidth(viewport,visible),flex:'none'}}><input aria-label="目录搜索" defaultValue=""/></aside>
   <main style={{flex:1,minWidth:0,display:'flex',flexDirection:'column'}}><button type="button" aria-label="会话目录" aria-expanded={visible} onClick={()=>visible?setDirectoryOpen(false):openDirectory()}>目录</button>
    <div style={{flex:1,minHeight:0}}><CollaborationPage work={work} visible={true} target={target} roles={roles} profileName="Max" panel={port} persistence={{preferences,api,directory:{refresh:async()=>{},open:openDirectory,select:()=>{},createRequest:0,createHandled:()=>{}}}}/></div>
   </main></div></I18nProvider>}
 createRoot(document.getElementById('root')).render(<Frame/>);`
 const result=await build({configFile:false,root,logLevel:'error',resolve:{alias:[{find:'@deepseek-ai/dsh-client-ui-primitives',replacement:markdown}]},plugins:[{name:'group-directory-yield',resolveId:id=>id.endsWith('group-directory-yield')?entryId:id===markdown?markdown:null,load:id=>id===entryId?entry:id===markdown?'export function MarkdownText(){return null}':null}],define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:')},lib:{entry:'group-directory-yield',name:'GroupDirectoryYield',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 const styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1440,height:900}});t.after(()=>page.close());page.setDefaultTimeout(3000)
 const errors:string[]=[];page.on('pageerror',(e:Error)=>errors.push(e.message));await page.route('**/*',(r:any)=>r.abort())
 await page.setContent('<html lang="zh-CN"><body style="margin:0"><div id="root"></div></body></html>');await page.addStyleTag({content:styles});await page.addScriptTag({content:bundle.output.find(item=>item.type==='chunk')!.code})
 const state=()=>page.evaluate(()=>(window as any).yieldFixture.state()),prefs=()=>page.evaluate(()=>(window as any).yieldFixture.preferences())
 const directory=page.getByRole('complementary',{name:'工作会话目录',exact:true}),overview=page.getByRole('complementary',{name:'工作概览',exact:true}),members=page.getByRole('complementary',{name:'成员',exact:true})
 const directoryButton=page.getByRole('button',{name:'会话目录',exact:true}),message=page.getByRole('textbox',{name:'群讨论消息',exact:true}),discussion=page.getByRole('region',{name:'讨论',exact:true})
 const select=async(key:'a'|'b',name:string)=>{await page.evaluate((key:string)=>(window as any).yieldFixture.select(key),key);await page.getByRole('heading',{name,exact:true}).waitFor()}
 const width=async()=>Math.round((await discussion.boundingBox())!.width)
 const shot=(name:string)=>page.screenshot({path:(process.env.GROUP_YIELD_SHOT_DIR??'/tmp')+'/teloa-group-yield-'+name+'.png'})

 // 1440：无偏好默认展开概览，目录按原型 ≤1450 让位；本人的目录选择保持打开。
 await page.getByRole('heading',{name:'采购核查群',exact:true}).waitFor();await overview.waitFor();await directory.waitFor({state:'hidden'})
 assert.deepEqual({open:(await state()).directoryOpen,visible:(await state()).visible},{open:true,visible:false})
 assert.equal(await directoryButton.getAttribute('aria-expanded'),'false','目录入口报告实际可见状态')
 assert.ok(await width()>=600,'1440 讨论区随目录让位放宽：'+await width())
 // G3：页签带真实数量，内层不再重复「关联工作」标题；参与员工是轻量行，管理只在头部成员面板。
 await overview.getByRole('tab',{name:'关联工作 3',exact:true}).waitFor()
 assert.equal(await overview.getByRole('tab',{name:'参与员工 1',exact:true}).count(),1)
 assert.equal(await overview.getByRole('heading',{name:/关联工作/}).count(),0,'概览内不重复关联工作标题')
 const filter=overview.getByRole('combobox',{name:'筛选关联工作',exact:true});await filter.selectOption('task')
 assert.equal(await overview.getByRole('button',{name:'关联工作',exact:true}).count(),1,'＋ 保留在页签下的工具行')
 await overview.getByRole('tab',{name:'参与员工 1',exact:true}).click()
 assert.equal(await overview.getByText('负责 1 项关联任务',{exact:true}).count(),1,'负责事项来自同一份关联读取')
 assert.equal(await overview.getByRole('button',{name:/对话|授权/}).count(),0,'概览不重复成员管理动作')
 await overview.getByRole('tab',{name:'关联工作 3',exact:true}).click()
 await shot('1440-overview')
 await message.fill('A 群未发送草稿')
 const before=await prefs()

 // 本人主动打开目录：收起群侧栏并显示目录，不能静默回弹；偏好、筛选、草稿保留。
 await directoryButton.click();await overview.waitFor({state:'hidden'});await directory.waitFor()
 assert.equal(await directoryButton.getAttribute('aria-expanded'),'true')
 assert.deepEqual(await prefs(),before,'为目录收起不改写本群偏好，也不记为本人关闭')
 assert.equal(await message.inputValue(),'A 群未发送草稿')
 await page.getByRole('button',{name:'工作概览',exact:true}).click();await overview.waitFor();await directory.waitFor({state:'hidden'})
 assert.equal(await filter.inputValue(),'task','重新打开概览保留原筛选')
 assert.equal(await (await state()).directoryOpen,true)
 // 本人关闭侧栏后原目录自动回来。
 await overview.getByRole('button',{name:'关闭协作侧栏',exact:true}).click();await overview.waitFor({state:'hidden'});await directory.waitFor()

 // 963：成员面板打开时目录让位，讨论区不再只剩约 369px；关闭后目录回来。
 await page.setViewportSize({width:963,height:900});await page.waitForFunction(()=>(window as any).yieldFixture.state().viewport===963)
 await page.getByRole('button',{name:'2 位成员',exact:true}).click();await members.waitFor();await directory.waitFor({state:'hidden'})
 assert.ok(await width()>=500,'963 讨论区：'+await width())
 assert.equal(await members.getByRole('button',{name:'与林析对话',exact:true}).count(),1,'对话与授权管理只在头部成员面板')
 await shot('963-members')
 await members.getByRole('button',{name:'关闭协作侧栏',exact:true}).click();await members.waitFor({state:'hidden'});await directory.waitFor()
 // 缩放：宽屏并存，缩窄让位，放宽回来。
 await page.getByRole('button',{name:'2 位成员',exact:true}).click();await members.waitFor();await directory.waitFor({state:'hidden'})
 await page.setViewportSize({width:1600,height:900});await directory.waitFor();assert.equal(await members.isVisible(),true,'1600 目录与群侧栏并存')
 await page.setViewportSize({width:963,height:900});await directory.waitFor({state:'hidden'});assert.equal(await members.isVisible(),true)
 // 切群：旧群的关闭回调不能污染新群，回到原群按本人偏好恢复面板与让位。
 await select('b','付款复核群');await directory.waitFor();assert.equal(await members.isVisible(),false,'963 无偏好的群不自动展开')
 assert.equal((await state()).openGroupId,undefined,'旧群撤回展开报告')
 await select('a','采购核查群');await members.waitFor();await directory.waitFor({state:'hidden'})
 assert.equal(await message.inputValue(),'A 群未发送草稿','切群与让位不改动原群草稿')
 await select('b','付款复核群');await directory.waitFor()
 assert.equal((await state()).directoryOpen,true,'全程未改写本人的目录选择')
 assert.deepEqual(errors,[])
})

import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp,readFile,writeFile,rm,mkdir} from 'node:fs/promises'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createServer} from 'node:http'
import {build} from 'vite'
import ts from 'typescript'
// @ts-expect-error 复用工作树的无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

test('真实 Frame 的会话、任务、项目共用成果右栏，C 列表与正文依次呈现且不写入',async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
 const temp=await mkdtemp(join(root,'.runtime-artifact-rightbar-c-'));t.after(()=>rm(temp,{recursive:true,force:true}))
 const old=await readFile(join(client,'../../tests/business-builder-frame.test.ts'),'utf8'),file=ts.createSourceFile('fixture.ts',old,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS)
 let entry:ts.Expression|undefined;const visit=(node:ts.Node)=>{if(ts.isVariableDeclaration(node)&&node.name.getText(file)==='entry')entry=node.initializer;ts.forEachChild(node,visit)};visit(file);assert.ok(entry)
 let source=new Function('client','return '+entry.getText(file))(client) as string
 source=`import {ConversationSearch} from ${JSON.stringify(join(client,'conversation-search.ts'))};import {teloaTabHost} from ${JSON.stringify(join(client,'sidebar-right-tab-host.ts'))};window.frameStartup={sessionId:'session-original',roleSession:true};`+source
 const boundary="const frameRoot="
 source=source.replace(boundary,`
 const verifiedConversationSearch=new ConversationSearch(async()=>({items:[],hasMore:false}),()=>[...rows.keys()]);f.actions=store.actions;f.host=()=>teloaTabHost();
 const sourceTask={id:'10000000-0000-4000-8000-000000000001',ownerId:'self',title:'原交付任务',goal:'保持原任务和上下文',scope:'general',groupId:null,skills:[],state:'ready',version:1,contentVersion:1,assigneeRoleId:null,assigneeRoleVersion:null,createdAt:stamp,updatedAt:stamp,result:'任务原始成果正文'};
 const makeArtifact=(id,origin,title)=>({id,source:origin,storage:'persistent',primary:true,links:[],feedback:[],versions:[1,2].map(number=>({number,title,sections:[{id:'body',title:'正文',text:'保留原成果 '+id+' 版本 '+number}],source:{ref:origin,title:origin.kind==='task'?sourceTask.title:'原会话',scope:'general',version:origin.kind==='task'?'1 · '+stamp:'binding',author:'Max',private:false,evidence:[]},note:'原版本说明',author:'Max',at:stamp,files:[]}))});
 f.artifacts=[makeArtifact('session-artifact',{kind:'session',id:'session-original'},'会话原成果'),makeArtifact('task-artifact',{kind:'task',id:sourceTask.id},'任务原成果'),makeArtifact('task-second',{kind:'task',id:sourceTask.id},'任务第二份成果')];
 const savedEmptyConversation={id:'binding-empty',ownerId:'self',title:'已有成果来源',scopeIds:['general'],version:1,status:'ready',sessionId:'saved-empty',requestedSessionId:'saved-empty',createdAt:stamp};rows.set(savedEmptyConversation.sessionId,savedEmptyConversation);byId[savedEmptyConversation.sessionId]={id:savedEmptyConversation.sessionId,title:savedEmptyConversation.title,displayTitle:savedEmptyConversation.title,blank:true,running:false,updatedAt:1};f.artifacts.push(makeArtifact('empty-artifact',{kind:'session',id:savedEmptyConversation.sessionId},'空消息会话原成果'));f.work=work;void work.refreshDirectory();
 f.reads=[];f.writes=[];props.artifactApi=new Proxy(generic,{get:(target,key)=>key==='pendingFor'?()=>[]:key==='list'?async(id,kind)=>{f.reads.push([kind,id]);return f.artifacts.filter(a=>a.source.id===id&&a.source.kind===kind)}:key==='get'?async id=>f.artifacts.find(a=>a.id===id):['create','change','save','feedback'].includes(key)?async(...args)=>{f.writes.push([key,args]);throw Error('不应写入成果')}:target[key]});
 props.taskApi=new Proxy(generic,{get:(target,key)=>key==='attention'?async()=>({items:[{task:sourceTask,attention:null}]}):key==='list'?async()=>[sourceTask]:key==='get'?async()=>sourceTask:key==='completion'?async()=>null:target[key]});
 props.industryTaskApi=new Proxy(generic,{get:(target,key)=>key==='source'?async()=>null:target[key]});
 props.resourceApi={directory:async()=>({resources:[]}),sources:async()=>[]};
 f.projectItems=[{kind:'artifact',id:'task-artifact',version:1,title:'项目固定成果',available:true,origin:'direct'}];
  `+boundary).replace('conversationSearch={generic}','conversationSearch={verifiedConversationSearch}')
 await writeFile(join(temp,'fixture.tsx'),source)
 const isolated=['WorkHome','MarketPage','TeamCapabilitiesPage','ResourceManager','CollaborationPage','ContinuousPage','ProjectOverviewPage','CapabilityTargetPanel','SavedIndustryDirectory','AutoDreamSettingsPage']
 const built=await build({root,configFile:false,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},plugins:[{name:'isolate-unrelated-pages',enforce:'pre',load:async id=>{if(!isolated.some(name=>id===join(client,name+'.tsx')))return;const source=await readFile(id,'utf8');return [...source.matchAll(/export (?:async )?(?:function|const|class) (\w+)/g)].map(m=>'export const '+m[1]+'=()=>null;').join('\n')}}],build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'ArtifactRightbarC',formats:['iife']}}})
 const bundle=Array.isArray(built)?built[0]:built;assert.ok(bundle&&'output'in bundle)
 const server=createServer((_q,r)=>{r.setHeader('Content-Type','text/html');r.end('<!doctype html><html lang="zh-CN"><body style="margin:0"><div id="root"></div></body></html>')});await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));t.after(()=>new Promise<void>(done=>server.close(()=>done())))
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:1440,height:900}});page.setDefaultTimeout(4000)
 const errors:string[]=[],requests:string[]=[];page.on('pageerror',(e:Error)=>errors.push(e.stack??e.message));const origin='http://127.0.0.1:'+((server.address() as {port:number}).port)
 await page.route('**/*',(route:any)=>{if(new URL(route.request().url()).origin===origin)return route.continue();requests.push(route.request().url());return route.abort()});await page.goto(origin)
 await page.addStyleTag({content:bundle.output.flatMap(x=>x.type==='asset'&&x.fileName.endsWith('.css')?[String(x.source)]:[]).join('\n')});await page.addScriptTag({content:bundle.output.find(x=>x.type==='chunk')!.code})
 t.after(async()=>{if(errors.length)t.diagnostic(JSON.stringify({errors,body:await page.locator('body').innerText()}))})
 await page.waitForFunction(()=>!!(window as any).frameFixture.host()).catch(async(error:unknown)=>{t.diagnostic(JSON.stringify({errors,body:await page.locator('body').innerText()}));throw error})
 // 使用实际会话宿主入口；没有原生概览挂载点时仍须落入同一外壳右栏。
 await page.evaluate(()=>(window as any).frameFixture.actions.openMessages('native'))
 await page.getByRole('textbox',{name:'slot-probe',exact:true}).waitFor()
 // 原会话没有聊天消息时，明确搜索仍可直接读保存成果，不发起原生打开或新建。
 await page.evaluate(()=>(window as any).frameFixture.actions.openConversationDirectory())
 await page.getByRole('textbox',{name:'搜索目录会话',exact:true}).fill('已有成果来源')
 const emptyRow=page.locator('[data-session-id="saved-empty"]');await emptyRow.waitFor()
 await emptyRow.getByRole('button',{name:'会话操作：已有成果来源',exact:true}).click()
 await page.getByRole('menuitem',{name:'工作成果',exact:true}).click()
 const emptyPanel=page.getByRole('dialog',{name:'工作成果',exact:true})
 await emptyPanel.getByRole('button',{name:/空消息会话原成果/}).click()
 await emptyPanel.getByText('保留原成果 empty-artifact 版本 2',{exact:true}).waitFor()
 assert.equal(await emptyPanel.evaluate((el:HTMLElement)=>!!el.closest('#teloa-details-track')&&!el.matches(':modal')),true)
 assert.equal(await emptyPanel.locator('aside').count(),0)
 assert.deepEqual(await page.evaluate(()=>{const f=(window as any).frameFixture;return [f.work.getSnapshot().sessionId,f.creates,f.writes]}),['session-original',0,[]])
 await emptyPanel.getByRole('button',{name:'关闭产物面板',exact:true}).click()
 await page.getByRole('textbox',{name:'搜索目录会话',exact:true}).fill('')
 await page.evaluate(()=>(window as any).frameFixture.actions.openMessages('native'))
 await page.evaluate(()=>(window as any).frameFixture.host().artifactPreview.open('session-original',{source:{kind:'session',id:'session-original'}}))
 const panel=page.getByRole('dialog',{name:'工作成果',exact:true}),track=page.getByRole('region',{name:'工具与详情',exact:true})
 const checkRail=async()=>{await panel.waitFor();assert.equal(await panel.evaluate((el:HTMLElement)=>!!el.closest('#teloa-details-track')),true,'成果必须在现有右栏轨道');assert.equal(await panel.locator('aside').count(),0,'不再嵌套目录');assert.equal(await panel.evaluate((el:HTMLElement)=>el.matches(':modal')),false);assert.equal(await page.locator('dialog[open]').count(),1)}
 await panel.getByRole('button',{name:/会话原成果/}).waitFor().catch(async(e:unknown)=>{t.diagnostic(JSON.stringify({errors,body:await page.locator('body').innerText()}));throw e});await checkRail()
 await panel.getByRole('button',{name:/会话原成果/}).click();await panel.getByText('保留原成果 session-artifact 版本 2',{exact:true}).waitFor()
 await page.setViewportSize({width:1280,height:720})
 // ResizeObserver 驱动的并栏分配在浏览器 resize 后提交，不能取到上一尺寸的宽度。
 await page.waitForFunction(()=>{const main=[...document.querySelectorAll('main')].find(node=>node.getClientRects().length);return (main?.getBoundingClientRect().width??0)>=400})
 const center=await page.locator('main:visible').first().boundingBox();assert.ok(center&&center.width>=400,'真实266px导航与目录、成果并栏时，主会话仍保留400px：'+JSON.stringify({center,track:await track.boundingBox()}))
 await page.setViewportSize({width:1440,height:900})
 await page.evaluate(()=>(window as any).frameFixture.actions.openRightbar());await page.waitForFunction(()=>(window as any).frameFixture.state().rightbar.shown)
 await page.evaluate(()=>(window as any).frameFixture.actions.closeRightbar());await panel.waitFor({state:'detached'})
 await page.evaluate(()=>{const f=(window as any).frameFixture;f.actions.openTask('10000000-0000-4000-8000-000000000001')})
 await page.getByRole('button',{name:'查看工作成果',exact:true}).click().catch(async(e:unknown)=>{t.diagnostic(JSON.stringify({errors,body:await page.locator('body').innerText(),state:await page.evaluate(()=>(window as any).frameFixture.state())}));throw e});await panel.getByRole('button',{name:/任务第二份成果/}).waitFor();await checkRail()
 assert.equal(await page.evaluate(()=>(window as any).frameFixture.state().view),'tasks')
 await panel.getByRole('button',{name:/任务原成果/}).click();await panel.getByText('保留原成果 task-artifact 版本 2',{exact:true}).waitFor()
 await panel.getByRole('button',{name:'版本与反馈',exact:true}).click();const feedback=panel.getByRole('textbox').last();await feedback.fill('尚未提交的反馈')
 await panel.getByRole('button',{name:'全部成果',exact:true}).click();assert.equal(await panel.getByRole('textbox').count(),0)
 await panel.getByRole('button',{name:/任务原成果/}).click();await panel.getByRole('button',{name:'版本与反馈',exact:true}).click();assert.equal(await feedback.inputValue(),'尚未提交的反馈')
 await panel.getByRole('button',{name:'放大',exact:true}).click();assert.equal(await panel.locator('aside').count(),0);await page.keyboard.press('Escape');assert.equal(await feedback.inputValue(),'尚未提交的反馈')
 await page.setViewportSize({width:3840,height:2160})
 await page.waitForFunction(()=>{const directory=[...document.querySelectorAll('[data-task-directory-mode] [data-teloa-pane="directory"]')].find(node=>node.getClientRects().length);return !!directory&&directory.getBoundingClientRect().width<=480})
 const taskDirectory=await page.locator('[data-task-directory-mode] [data-teloa-pane="directory"]:visible').boundingBox()
 assert.ok(taskDirectory&&taskDirectory.width<=480,'4K选中任务的目录有界，把更多空间交给完整详情')
 assert.equal(await feedback.inputValue(),'尚未提交的反馈','适配不重挂载原成果或草稿')
 await page.setViewportSize({width:1440,height:900})
 await panel.getByRole('button',{name:'关闭产物面板',exact:true}).click()
 await page.evaluate(()=>(window as any).frameFixture.actions.openBusiness({scope:'sales',section:'projects',id:'20000000-0000-4000-8000-000000000001'}))
 await page.getByRole('button',{name:'项目固定成果',exact:true}).first().click();await panel.getByText('保留原成果 task-artifact 版本 1',{exact:true}).waitFor();await checkRail()
 assert.deepEqual(await page.evaluate(()=>{const s=(window as any).frameFixture.state();return [s.view,s.businessTarget.section,s.businessTarget.id]}),['spaces','projects','20000000-0000-4000-8000-000000000001'])
 await panel.getByRole('button',{name:'预览',exact:true}).click();const href=await panel.getByRole('link',{name:'下载',exact:true}).getAttribute('href');assert.match(decodeURIComponent(href!),/保留原成果 task-artifact 版本 1/)
 const screenshotDir=process.env.TELOA_RIGHTBAR_SCREENSHOTS
 if(screenshotDir){await mkdir(screenshotDir,{recursive:true});await page.screenshot({path:join(screenshotDir,'project-reading-1440.png')})}
 for(const width of [900,1440]){await page.setViewportSize({width,height:900});await checkRail();assert.equal(await panel.evaluate((el:HTMLElement)=>el.scrollWidth<=el.clientWidth),true);assert.equal(await page.locator('body').evaluate((el:HTMLElement)=>el.scrollWidth<=innerWidth),true)}
 await panel.getByRole('button',{name:'版本与反馈',exact:true}).click();await panel.getByRole('textbox').last().fill('历史 v1 未提交反馈')
 await panel.getByRole('button',{name:'全部成果',exact:true}).click();if(screenshotDir)await page.screenshot({path:join(screenshotDir,'project-list-1440.png')})
 await panel.getByRole('button',{name:/任务原成果/}).click();await panel.getByText('保留原成果 task-artifact 版本 1',{exact:true}).waitFor();await panel.getByRole('button',{name:'版本与反馈',exact:true}).click();assert.equal(await panel.getByRole('textbox').last().inputValue(),'历史 v1 未提交反馈')
 await panel.getByRole('button',{name:'关闭产物面板',exact:true}).click();assert.equal(await page.locator('dialog[open]').count(),0)
 assert.deepEqual(await page.evaluate(()=>(window as any).frameFixture.writes),[]);assert.deepEqual(requests,[]);assert.deepEqual(errors,[])
})

test('群关联任务临时让出模态抽屉给同一成果右栏，关闭后恢复原草稿',async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url)),temp=await mkdtemp(join(root,'.runtime-artifact-group-handoff-'));t.after(()=>rm(temp,{recursive:true,force:true}))
 await writeFile(join(temp,'fixture.tsx'),`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {CollaborationPage} from ${JSON.stringify(join(client,'CollaborationPage.tsx'))};import {ArtifactPanel} from ${JSON.stringify(join(client,'ArtifactPanel.tsx'))};import {emptyTaskPreview} from ${JSON.stringify(join(client,'task-preview.ts'))};import {I18nProvider} from ${JSON.stringify(join(client,'i18n/provider.tsx'))};import {translateMessage} from ${JSON.stringify(join(client,'i18n/messages.ts'))};
 const snapshot={locale:'zh-CN',dshLocale:'zh',revision:1},runtime={getSnapshot:()=>snapshot,subscribe:()=>()=>{},t:(k,p)=>translateMessage('zh-CN',k,p)},source={kind:'task',id:'original-task'},artifact={id:'original-result',source,storage:'persistent',primary:true,links:[],feedback:[],versions:[{number:1,title:'群任务原成果',sections:[{id:'body',title:'正文',text:'按原群权限进入的任务成果'}],source:{ref:source,title:'关联任务',scope:'general',version:'1',author:'Max',private:false,evidence:[]},note:'',author:'Max',at:'2026-10-18T00:00:00Z',files:[]}]};
 function App(){const [open,setOpen]=useState(false),[mount,setMount]=useState(null);return <><CollaborationPage artifactOpen={open} visible target={{groupId:'original-group',rootId:''}} roles={[]} profileName="Max" persistence={{api:{}}} work={{renderLink:()=> <section><textarea aria-label="群内任务草稿" defaultValue="保留原群任务草稿"/><button onClick={()=>setOpen(true)}>打开关联任务成果</button></section>}}/><aside style={{position:'fixed',right:0,top:0,width:500,height:'100vh'}} ref={setMount}/><ArtifactPanel inline portal={mount} target={{source,artifact:{id:artifact.id,version:1}}} open={open} state={{...emptyTaskPreview(),artifacts:[artifact],tasks:[{id:source.id,storage:'persistent',title:'关联任务',scope:'general',state:'ready',version:1,assigneeId:'self',updatedAt:'2026-10-18T00:00:00Z',evidence:[]}]}} conversation={undefined} taskSources={{list:async()=>[]}} nativeArtifacts={{}} artifactFileApi={{}} close={()=>setOpen(false)} change={async()=>{throw Error('不应提交')}} openTask={()=>{}} openSource={()=>{}}/></>};createRoot(document.getElementById('root')).render(<I18nProvider runtime={runtime}><App/></I18nProvider>);`)
 const built=await build({root,configFile:false,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},plugins:[{name:'only-isolate-group-message-service',enforce:'pre',load:id=>id===join(client,'SavedCollaborationPage.tsx')?`import React from 'react';export const SavedCollaborationPage=({work})=><button onClick={()=>work.openLink({kind:'task',id:'original-task',available:true,title:'关联任务'})}>群内关联任务</button>;`:undefined}],build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'ArtifactGroupHandoff',formats:['iife']}}})
 const bundle=Array.isArray(built)?built[0]:built;assert.ok(bundle&&'output'in bundle)
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:1440,height:900}});page.setDefaultTimeout(3000)
 const errors:string[]=[];page.on('pageerror',(e:Error)=>errors.push(e.message));await page.route('**/*',(route:any)=>route.abort());await page.setContent('<html lang="zh-CN"><body><div id="root"></div></body></html>')
 await page.addStyleTag({content:bundle.output.flatMap(x=>x.type==='asset'&&x.fileName.endsWith('.css')?[String(x.source)]:[]).join('\n')});await page.addScriptTag({content:bundle.output.find(x=>x.type==='chunk')!.code})
 await page.getByRole('button',{name:'群内关联任务',exact:true}).click();const drawer=page.getByRole('dialog',{name:'关联任务',exact:true});await drawer.waitFor();assert.equal(await drawer.evaluate((el:HTMLElement)=>el.matches(':modal')),true)
 await drawer.getByRole('textbox').fill('群任务尚未提交的草稿');await drawer.getByRole('button',{name:'打开关联任务成果',exact:true}).click()
 const panel=page.getByRole('dialog',{name:'工作成果',exact:true});await panel.getByText('按原群权限进入的任务成果',{exact:true}).waitFor();assert.equal(await page.locator('dialog:modal').count(),0,'原抽屉暂时关闭，不阻止成果交互')
 await panel.getByRole('button',{name:'版本与反馈',exact:true}).click();await panel.getByRole('textbox').last().fill('成果反馈草稿');await panel.getByRole('button',{name:'关闭产物面板',exact:true}).click()
 await drawer.waitFor();assert.equal(await drawer.evaluate((el:HTMLElement)=>el.matches(':modal')),true);assert.equal(await drawer.getByRole('textbox').inputValue(),'群任务尚未提交的草稿');assert.deepEqual(errors,[])
})

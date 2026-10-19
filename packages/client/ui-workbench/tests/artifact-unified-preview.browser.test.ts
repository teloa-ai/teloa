import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
import ts from 'typescript'
import type {ArtifactRef,ArtifactSourceRef} from '../src/client/artifact-preview.js'
import type {ArtifactWorkChange} from '../src/client/artifact-work.js'

declare global {
 interface Window {
  artifactFixture:{calls:Array<ArtifactWorkChange|ArtifactSourceRef>;navigationCalls:Array<[ArtifactSourceRef,ArtifactRef,string]|'teloa.overview'>}
  missingFixture:{clear:()=>void;resolve:()=>void}
 }
}
// @ts-expect-error 既有无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

test('空成果与旧整理导航均保持预览，迟到的原成果可读且不产生手工表单或隐式提交',async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
 const temp=await mkdtemp(join(root,'.runtime-artifact-empty-'));t.after(()=>rm(temp,{recursive:true,force:true}))
 await writeFile(join(temp,'fixture.tsx'),`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {ArtifactPanel} from ${JSON.stringify(join(client,'ArtifactPanel.tsx'))};import {emptyTaskPreview} from ${JSON.stringify(join(client,'task-preview.ts'))};import {I18nProvider} from ${JSON.stringify(join(client,'i18n/provider.tsx'))};import {translateMessage} from ${JSON.stringify(join(client,'i18n/messages.ts'))};
 const locale='zh-CN',snapshot={locale,dshLocale:'zh',revision:1},runtime={t:(key,params)=>translateMessage(locale,key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};
 const source={kind:'session',id:'empty-source'},calls=[],artifact={id:'previous-artifact',source,storage:'persistent',primary:true,links:[],feedback:[],versions:[{number:1,title:'上一份成果',sections:[{id:'body',title:'正文',text:'不能误开旧正文'}],source:{ref:source,title:'本轮工作',scope:'general',version:'binding',author:'本人',private:true,evidence:[]},note:'',author:'本人',at:'2026-10-11T00:00:00Z',files:[]}]};function App(){const [open,setOpen]=useState(true),[target,setTarget]=useState({source}),[state,setState]=useState(emptyTaskPreview());return <main><textarea aria-label="会话草稿" defaultValue="保留原输入"/><button onClick={()=>{setTarget({source});setOpen(true)}}>再次查看成果</button><button onClick={()=>{setTarget({source,initialAction:'prepare'});setOpen(true)}}>工作概览整理入口</button><button onClick={()=>setState({...emptyTaskPreview(),artifacts:[artifact]})}>加载原成果台账</button><aside style={{width:380,height:700}}><ArtifactPanel inline open={open} target={target} state={state} conversation={{id:source.id,title:'本轮工作',scope:'general',bindingId:'binding'}} taskSources={{list:async()=>[]}} nativeArtifacts={{}} artifactFileApi={{}} close={()=>setOpen(false)} change={async command=>{calls.push(command)}} openSource={ref=>calls.push(ref)} openTask={()=>{}}/></aside></main>};window.artifactFixture={calls,navigationCalls:[]};createRoot(document.getElementById('root')).render(<I18nProvider runtime={runtime}><App/></I18nProvider>);`)
 const built=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'ArtifactEmptyTest',formats:['iife']}}})
 const bundle=Array.isArray(built)?built[0]:built;assert.ok(bundle&&'output'in bundle)
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1440,height:960}});t.after(()=>page.close());page.setDefaultTimeout(3000)
 const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));await page.route('**/*',(route:any)=>route.abort())
 await page.setContent('<!doctype html><html lang="zh-CN"><body><div id="root"></div></body></html>');await page.addStyleTag({content:bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')});await page.addScriptTag({content:bundle.output.find(item=>item.type==='chunk')!.code})
 const panel=page.getByRole('dialog')
 await panel.waitFor();assert.equal(await panel.getByRole('textbox').count(),0);assert.equal(await panel.getByRole('button',{name:'整理成果',exact:true}).count(),0)
 await panel.getByRole('button',{name:'放大',exact:true}).click();await page.keyboard.press('Escape');assert.equal(await panel.count(),1)
 await panel.getByRole('button',{name:'关闭产物面板',exact:true}).click()
 const legacy=page.getByRole('button',{name:'工作概览整理入口',exact:true})
 await legacy.click();await panel.waitFor();assert.equal(await panel.getByRole('textbox').count(),0,'历史prepare导航不重新打开已收掉的表单')
 await page.getByRole('button',{name:'加载原成果台账',exact:true}).click();await panel.getByText('不能误开旧正文',{exact:true}).waitFor()
 await panel.getByRole('button',{name:'关闭产物面板',exact:true}).click();await page.getByRole('button',{name:'再次查看成果',exact:true}).click()
 await panel.getByRole('button',{name:/上一份成果/}).click();await panel.getByText('不能误开旧正文',{exact:true}).waitFor();assert.equal(await panel.getByRole('textbox',{name:'工作成果名称',exact:true}).count(),0)
 assert.equal(await page.getByRole('textbox',{name:'会话草稿'}).inputValue(),'保留原输入')
 assert.deepEqual(await page.evaluate(()=>window.artifactFixture.calls),[]);assert.deepEqual(errors,[])
})

test('统一成果预览保留原版本、段落反馈和来源，放大收起及返回概况不丢草稿',async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
 const temp=await mkdtemp(join(root,'.runtime-artifact-unified-'));t.after(()=>rm(temp,{recursive:true,force:true}))
 const groupFile=ts.createSourceFile('SavedCollaborationPage.tsx',await readFile(join(client,'SavedCollaborationPage.tsx'),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX)
 const groupCard=groupFile.statements.find(statement=>ts.isFunctionDeclaration(statement)&&statement.name?.text==='SavedArtifactCard');assert.ok(groupCard)
 const frameFile=ts.createSourceFile('WorkbenchFrame.tsx',await readFile(join(client,'WorkbenchFrame.tsx'),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX)
 const frame=frameFile.statements.find(statement=>ts.isFunctionDeclaration(statement)&&statement.name?.text==='WorkbenchFrame');assert.ok(frame&&ts.isFunctionDeclaration(frame)&&frame.body)
 const route=frame.body.statements.flatMap(statement=>ts.isVariableStatement(statement)?[...statement.declarationList.declarations]:[]).find(declaration=>declaration.name.getText(frameFile)==='openArtifacts')?.initializer;assert.ok(route)
 await writeFile(join(temp,'fixture.tsx'),`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import clsx from 'clsx';import {FileText,Download} from 'lucide-react';import {WorkArtifactCard} from ${JSON.stringify(join(client,'WorkArtifactCard.tsx'))};import {ArtifactPanel} from ${JSON.stringify(join(client,'ArtifactPanel.tsx'))};import {emptyTaskPreview} from ${JSON.stringify(join(client,'task-preview.ts'))};import {I18nProvider,useI18n} from ${JSON.stringify(join(client,'i18n/provider.tsx'))};import {translateMessage} from ${JSON.stringify(join(client,'i18n/messages.ts'))};
 const css={},artifactFileKey=(ref,id)=>ref.id+':'+ref.version+':'+id,imageMime=()=>false,localizeWorkError=()=>'';
 ${groupCard.getText(groupFile)}
 const locale='zh-CN',snapshot={locale,dshLocale:'zh',revision:1},runtime={t:(key,params)=>translateMessage(locale,key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};
 const source={kind:'session',id:'main'},artifact={id:'original-artifact',source,storage:'persistent',primary:true,links:[],feedback:[],versions:[1,2].map(number=>({number,title:'原成果',sections:[{id:'body',title:'原段落',text:'正文版本 '+number}],source:{ref:source,title:'原会话',scope:'general',version:'binding',author:'本人',private:true,evidence:['原始依据']},note:'版本 '+number,author:'本人',at:'2026-10-11T00:00:00Z',files:[]}))},state={...emptyTaskPreview(),artifacts:[artifact]},calls=[];
 const navigationCalls=[];
 function App(){const [target,setTarget]=useState(null),[open,setOpen]=useState(false),[mount,setMount]=useState(null),conversationVisible=true,current='main',artifactReadIntent={current:0},CONVERSATION_OVERVIEW_KIND='teloa.overview',actions={openArtifacts:(source,ref,session)=>{navigationCalls.push([source,ref,session]);setTarget({source,artifact:ref});setOpen(true)}},sidebarRightFace=()=>({openTab:kind=>navigationCalls.push(kind)});const openArtifacts=${route.getText(frameFile)};const enter=()=>openArtifacts(source,{id:artifact.id,version:1});return <main><textarea aria-label="会话草稿" defaultValue="继续原任务"/><aside style={{width:380,height:600}}><div hidden={open}><h2>工作概况</h2>{['成果名称','任务成果','业务成果'].map(name=><button key={name} onClick={enter}>{name}</button>)}<SavedArtifactCard reference={{kind:'artifact',id:artifact.id,version:1}} summary={{state:'ready',title:'群引用的原成果',files:[]}} files={{}} openArtifactFile={()=>{}} openImage={()=>{}} openArtifact={(id,version)=>openArtifacts(source,{id,version})}/></div><div ref={setMount} hidden={!open} style={{height:'100%'}}/></aside><ArtifactPanel inline portal={mount} open={open} target={target} state={state} conversation={{id:'main',title:'原会话',scope:'general',bindingId:'binding'}} taskSources={{list:async()=>[]}} nativeArtifacts={{}} artifactFileApi={{}} close={()=>setOpen(false)} change={async command=>{calls.push(command)}} openSource={ref=>{calls.push(ref)}} openTask={()=>{}}/></main>};window.artifactFixture={calls,navigationCalls};createRoot(document.getElementById('root')).render(<I18nProvider runtime={runtime}><App/></I18nProvider>);`)
 const result=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'ArtifactUnifiedTest',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 const script=bundle.output.find(item=>item.type==='chunk')!.code,styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1440,height:960}});t.after(()=>page.close());page.setDefaultTimeout(3000)
 const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));await page.route('**/*',(route:any)=>route.abort())
 await page.setContent('<!doctype html><html lang="zh-CN"><body><div id="root"></div></body></html>');await page.addStyleTag({content:styles});await page.addScriptTag({content:script})
 await page.getByRole('button',{name:'成果名称',exact:true}).click()
 await page.getByText('正文版本 1',{exact:true}).waitFor()
 assert.ok(await page.getByRole('dialog').evaluate((element:HTMLElement)=>element.getBoundingClientRect().width)<=380)
 await page.getByRole('button',{name:'版本与反馈',exact:true}).click()
 const draft=page.getByRole('textbox').filter({visible:true}).last();await draft.fill('待提交的段落反馈')
 await page.getByRole('button',{name:'放大',exact:true}).click()
 assert.ok(await page.getByRole('dialog').evaluate((element:HTMLElement)=>element.getBoundingClientRect().width)>700)
 assert.equal(await draft.inputValue(),'待提交的段落反馈')
 await page.keyboard.press('Escape')
 assert.equal(await draft.inputValue(),'待提交的段落反馈')
 assert.ok(await page.getByRole('dialog').evaluate((element:HTMLElement)=>element.getBoundingClientRect().width)<=380)
 await page.getByRole('button',{name:'关闭产物面板',exact:true}).click()
 assert.equal(await page.getByRole('dialog').count(),0)
 assert.equal(await page.getByRole('textbox',{name:'会话草稿'}).inputValue(),'继续原任务')
 const groupButton='预览群引用的原成果'
 assert.equal(await page.getByRole('button',{name:groupButton,exact:true}).count(),1,'群成果采用同一成果名称入口')
 for(const entry of ['任务成果',groupButton,'业务成果']){
  await page.getByRole('button',{name:entry,exact:true}).click();await page.getByText('正文版本 1',{exact:true}).waitFor()
  await page.getByRole('button',{name:'版本与反馈',exact:true}).click();assert.equal(await draft.inputValue(),'待提交的段落反馈')
  await page.getByRole('button',{name:'关闭产物面板',exact:true}).click()
 }
 assert.deepEqual(await page.evaluate(()=>window.artifactFixture.calls),[],'导航不保存、不复制成果或反馈')
 assert.deepEqual(await page.evaluate(()=>window.artifactFixture.navigationCalls),Array.from({length:4},()=>[[{kind:'session',id:'main'},{id:'original-artifact',version:1},'main'],'teloa.overview']).flat(),'真实 Frame 路由与群成果卡始终携带原成果和引用版本')
 assert.deepEqual(errors,[])
})

test('缺失成果 Escape 同步关闭状态，同一成果可重新打开并接收迟到数据',async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
 const temp=await mkdtemp(join(root,'.runtime-artifact-missing-'));t.after(()=>rm(temp,{recursive:true,force:true}))
 await writeFile(join(temp,'fixture.tsx'),`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {ArtifactPanel} from ${JSON.stringify(join(client,'ArtifactPanel.tsx'))};import {emptyTaskPreview} from ${JSON.stringify(join(client,'task-preview.ts'))};import {I18nProvider} from ${JSON.stringify(join(client,'i18n/provider.tsx'))};import {translateMessage} from ${JSON.stringify(join(client,'i18n/messages.ts'))};
 const locale='zh-CN',snapshot={locale,dshLocale:'zh',revision:1},runtime={t:(key,params)=>translateMessage(locale,key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot},source={kind:'session',id:'main'},target={source,artifact:{id:'missing',version:1}},artifact={id:'missing',source,storage:'persistent',primary:true,links:[],feedback:[],versions:[{number:1,title:'迟到的原成果',sections:[{id:'body',title:'原段落',text:'迟到的正文'}],source:{ref:source,title:'原会话',scope:'general',version:'binding',author:'本人',private:true,evidence:[]},note:'',author:'本人',at:'2026-10-11T00:00:00Z',files:[]}]};
 function App(){const [open,setOpen]=useState(false),[inline,setInline]=useState(false),[mount,setMount]=useState(null),[state,setState]=useState(emptyTaskPreview());window.missingFixture={resolve:()=>setState({...emptyTaskPreview(),artifacts:[artifact]}),clear:()=>setState(emptyTaskPreview())};return <main><textarea aria-label="会话草稿" defaultValue="继续原任务"/><div hidden={open}><h2>工作概况</h2><button onClick={()=>setOpen(true)}>打开同一成果</button><button onClick={()=>setInline(true)}>使用概况预览</button></div><aside ref={setMount} style={{width:380,height:600}}/><ArtifactPanel inline={inline} portal={inline?mount:null} open={open} target={target} state={state} conversation={{id:'main',title:'原会话',scope:'general',bindingId:'binding'}} taskSources={{list:async()=>[]}} nativeArtifacts={{}} artifactFileApi={{}} close={()=>setOpen(false)} change={async()=>{}} openSource={()=>{}} openTask={()=>{}}/></main>};createRoot(document.getElementById('root')).render(<I18nProvider runtime={runtime}><App/></I18nProvider>);`)
 const result=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'ArtifactMissingTest',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1000,height:760}});t.after(()=>page.close());page.setDefaultTimeout(3000)
 const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));await page.route('**/*',(route:any)=>route.abort())
 await page.setContent('<!doctype html><html lang="zh-CN"><body><div id="root"></div></body></html>')
 await page.addStyleTag({content:bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')});await page.addScriptTag({content:bundle.output.find(item=>item.type==='chunk')!.code})
 for(const inline of [false,true]){
  if(inline){await page.evaluate(()=>window.missingFixture.clear());await page.getByRole('button',{name:'使用概况预览'}).click()}
  await page.getByRole('button',{name:'打开同一成果'}).click();await page.getByRole('alert').waitFor()
  await page.getByRole('dialog').locator('button').focus();await page.keyboard.press('Escape')
  await page.getByRole('heading',{name:'工作概况'}).waitFor()
  assert.equal(await page.getByRole('dialog').count(),0)
  await page.getByRole('button',{name:'打开同一成果'}).click();await page.getByRole('alert').waitFor()
  await page.evaluate(()=>window.missingFixture.resolve());await page.getByText('迟到的正文',{exact:true}).waitFor()
  await page.getByRole('button',{name:'关闭产物面板',exact:true}).click()
 }
 assert.equal(await page.getByRole('textbox',{name:'会话草稿'}).inputValue(),'继续原任务');assert.deepEqual(errors,[])
})

test('成果正文按原Markdown预览，段落操作只在版本页且不改原文和下载',async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
 const temp=await mkdtemp(join(root,'.runtime-artifact-markdown-'));t.after(()=>rm(temp,{recursive:true,force:true}))
 const text='# 本人材料核对\n\n| 编号 | 对象 | 状态 | 核对说明 |\n| --- | --- | --- | --- |\n| B01 | BIRCH_R83-01 | 已交付 | 原编号、原对象与原状态保留一致，仅依据本次提供的材料核对，不引入其他任务、会话或外部来源的事实。 |\n| B02 | BIRCH_R83-02 | 待确认 | 原编号、原对象与原状态保留一致，仅依据本次提供的材料核对，不引入其他任务、会话或外部来源的事实。 |\n\n## 汇总\n\n- 已交付：1\n- 待确认：1\n\n仅使用本人材料。![外部图片](https://example.invalid/private.png)\n\n```txt\nconst first = 1;\n\nconst second = 2;\n```'
 await writeFile(join(temp,'fixture.tsx'),`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {ArtifactPanel} from ${JSON.stringify(join(client,'ArtifactPanel.tsx'))};import {artifactMarkdown} from ${JSON.stringify(join(client,'artifact-preview.ts'))};import {emptyTaskPreview} from ${JSON.stringify(join(client,'task-preview.ts'))};import {I18nProvider} from ${JSON.stringify(join(client,'i18n/provider.tsx'))};import {translateMessage} from ${JSON.stringify(join(client,'i18n/messages.ts'))};
 const snapshot={locale:'zh-CN',dshLocale:'zh',revision:1},runtime={t:(k,p)=>translateMessage('zh-CN',k,p),getSnapshot:()=>snapshot,subscribe:()=>()=>{}},text=${JSON.stringify(text)},source={kind:'task',id:'original-task'},task={id:source.id,storage:'persistent',title:'原核对任务',scope:'general',version:3,updatedAt:'2026-10-16T00:00:00Z',assigneeId:'role',evidence:[],result:text,state:'waiting',approvalRequired:true,history:[]},artifact={id:'original-artifact',storage:'persistent',source,primary:true,links:[],feedback:[],versions:[{number:1,title:task.title,sections:text.split(/\\n\\s*\\n/).map((text,i)=>({id:'section-'+(i+1),title:'段落 '+(i+1),text})),source:{ref:source,title:task.title,scope:'general',version:'3 · '+task.updatedAt,author:'本人',private:false,evidence:[]},note:'保留原消息',author:'本人',at:task.updatedAt}]},calls=[],before=JSON.stringify(artifact);window.markdownArtifact={calls,before,current:()=>JSON.stringify(artifact),download:artifactMarkdown(artifact,1,runtime.t)};
 const custom={...artifact,id:'custom-artifact',versions:[{...artifact.versions[0],sections:[{id:'manual-section',title:'本人命名的交付说明',text:'**保留自定义分段正文**'}]}]};function App(){const [saved,setSaved]=useState(false),current=saved==='custom'?custom:artifact;return <><button onClick={()=>setSaved(true)}>读取同一原成果</button><button onClick={()=>setSaved('custom')}>读取自定义分段</button><ArtifactPanel open target={{source,...(saved?{artifact:{id:current.id,version:1}}:{})}} state={{...emptyTaskPreview(),tasks:[task],artifacts:saved?[current]:[]}} conversation={undefined} taskSources={{list:async()=>[]}} nativeArtifacts={{}} artifactFileApi={{}} close={()=>{}} change={async command=>{calls.push(command)}} openSource={()=>{}} openTask={()=>{}}/></>};createRoot(document.getElementById('root')).render(<I18nProvider runtime={runtime}><App/></I18nProvider>);`)
 const result=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'ArtifactMarkdownTest',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1440,height:960}});t.after(()=>page.close());page.setDefaultTimeout(3000)
 const errors:string[]=[],network:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));page.on('request',(request:any)=>network.push(request.url()));await page.route('**/*',(route:any)=>route.abort())
 await page.setContent('<!doctype html><html lang="zh-CN"><body><div id="root"></div></body></html>');await page.addStyleTag({content:bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')});await page.addScriptTag({content:bundle.output.find(item=>item.type==='chunk')!.code})
 const panel=page.getByRole('dialog'),content=panel.getByRole('article',{name:'产物内容',exact:true}),preview=content.getByRole('region',{name:'成果预览',exact:true})
 await preview.waitFor();assert.equal(await preview.getByRole('table').count(),1,'未保存原文也应显示真实Markdown表格')
 assert.equal(await preview.getByRole('heading',{name:'本人材料核对',exact:true}).count(),1);assert.equal(await preview.getByRole('cell',{name:'待确认',exact:true}).count(),1)
 assert.equal(await preview.locator('img').count(),0);assert.equal(decodeURIComponent((await panel.getByRole('link',{name:'下载',exact:true}).getAttribute('href'))!.split(',').slice(1).join(',')),text)
 await page.getByRole('button',{name:'读取同一原成果',exact:true}).click();await content.getByRole('heading',{name:'原核对任务',exact:true}).waitFor()
 assert.equal(await preview.getByRole('table').count(),1);assert.equal(await preview.getByRole('heading',{name:/^段落 \d+$/}).count(),0);assert.equal(await preview.getByRole('button').count(),0,'预览不重复放置段落编辑入口')
 assert.equal(await preview.getByRole('heading',{name:'汇总',exact:true}).count(),1);assert.equal(await preview.getByRole('listitem').count(),2);assert.equal(await preview.locator('img').count(),0)
 assert.deepEqual(await preview.locator('pre').allTextContents(),['const first = 1;\n\nconst second = 2;'],'原自动段落之间的空行仍属于同一代码块')
 const download=await panel.getByRole('link',{name:'下载',exact:true}).getAttribute('href');assert.equal(decodeURIComponent(download!.split(',').slice(1).join(',')),await page.evaluate(()=>(window as any).markdownArtifact.download))
 for(const width of [1440,760,390]){
  await page.setViewportSize({width,height:960});assert.equal(await content.evaluate((el:HTMLElement)=>el.scrollWidth<=el.clientWidth),true,'表格在原预览宽度内滚动，不撑破面板')
  const table=preview.getByRole('table')
  assert.equal(await table.locator('tbody tr:first-child td').evaluateAll((cells:HTMLElement[])=>cells.slice(0,3).every(cell=>{const range=document.createRange();range.selectNodeContents(cell);return range.getClientRects().length===1})),true,'短编号、对象与状态保持一行，不被长说明挤成竖排')
  assert.equal(await table.evaluate((el:HTMLElement)=>el.parentElement!.scrollWidth>el.parentElement!.clientWidth),true,'四列表格在自身可聚焦区域内横向滚动')
 }
 await panel.getByRole('button',{name:'版本与反馈',exact:true}).click();assert.equal(await content.getByRole('button',{name:/^段落 \d+.*$/}).count(),7,'原section身份仍由版本页明确选择')
 await content.getByRole('button',{name:/^段落 2.*$/}).click();await content.getByRole('textbox').waitFor();assert.equal(await content.getByRole('heading',{name:/段落 2 · v1/}).count(),1)
 await page.setViewportSize({width:1440,height:960});await page.getByRole('button',{name:'读取自定义分段',exact:true}).click();await preview.getByRole('heading',{name:'本人命名的交付说明',exact:true}).waitFor();assert.equal(await preview.locator('strong').textContent(),'保留自定义分段正文','非自动命名分段仍保原标题及独立正文')
 assert.equal(await page.evaluate(()=>(window as any).markdownArtifact.current()),await page.evaluate(()=>(window as any).markdownArtifact.before));assert.deepEqual(await page.evaluate(()=>(window as any).markdownArtifact.calls),[]);assert.deepEqual(network,[],'纯预览不加载远程图片或其它资源');assert.deepEqual(errors,[])
})

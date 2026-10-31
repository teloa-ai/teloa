import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,writeFile,rm,mkdir} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import ts from 'typescript'
import {build} from 'vite'
// @ts-expect-error 复用项目的无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

test('资料目录直接打开已保存成果不依赖任务缓存，固定版本和演示隔离仍有效',{timeout:60000},async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=join(root,'packages/client/ui-workbench/src/client')
 const frame=await readFile(join(client,'WorkbenchFrame.tsx'),'utf8'),ast=ts.createSourceFile('WorkbenchFrame.tsx',frame,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX)
 let openArtifact:ts.Expression|undefined
 const visit=(node:ts.Node)=>{
  if(ts.isJsxSelfClosingElement(node)&&node.tagName.getText(ast)==='ResourceManager')for(const attribute of node.attributes.properties){
   if(ts.isJsxAttribute(attribute)&&attribute.name.getText(ast)==='openArtifact'&&attribute.initializer&&ts.isJsxExpression(attribute.initializer))openArtifact=attribute.initializer.expression
  }
  ts.forEachChild(node,visit)
 };visit(ast);assert.ok(openArtifact,'复用外壳中的实际成果打开回调')
 const temp=await mkdtemp(join(root,'.runtime-library-artifact-'));t.after(()=>rm(temp,{recursive:true,force:true}))
 await writeFile(join(temp,'fixture.tsx'),`
 import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
 import {ResourceManager} from '${client}/ResourceManager.tsx';import {ArtifactPanel} from '${client}/ArtifactPanel.tsx';import {createArtifactApi} from '${client}/artifact-api.ts';import {emptyTaskPreview} from '${client}/task-preview.ts';
 import {I18nProvider} from '${client}/i18n/provider.tsx';import {translateMessage} from '${client}/i18n/messages.ts';import tokens from '${client}/theme-tokens.module.css';import {prototypeThemes} from '${client}/../brand/prototype-theme.ts';
 const stamp='2026-10-31T00:00:00Z',id=n=>'11111111-1111-4111-8111-'+String(n).padStart(12,'0'),calls=[],changes=[];
 const source={kind:'task',id:id(1),title:'原始工作任务',scope:'general',version:'1'},otherSource={...source,id:id(2),title:'另一项工作'},sourceRef={kind:'task',id:source.id},otherRef={kind:'task',id:otherSource.id};
 const saved=(artifactId,number,origin,title,text)=>({artifactId,ownerId:'self',number,source:origin,createdAt:stamp,content:{title,sections:[{id:'body',title:'正文',text}],note:'原保存说明',snapshotIds:[]}});
 const history=[saved(id(3),1,source,'每日小结第一版','第一版固定正文'),saved(id(3),2,source,'Auto Dream · 每日小结','第二版固定正文')],other=[saved(id(4),1,otherSource,'FortiGate 工作成果','另一份成果独有正文')];
 const summaries=[history.at(-1),other[0]].map(row=>({artifactId:row.artifactId,number:row.number,title:row.content.title,source:row.source,createdAt:stamp,updatedAt:stamp,attribution:'task'}));
 const artifactApi=createArtifactApi(async(method,payload)=>{calls.push({method,payload});if(method==='artifacts/role/list')return summaries;if(method==='artifacts/versions')return payload.artifactId===id(3)?history:other;if(method==='artifacts/feedback/list')return [];throw Error('不应发生的请求：'+method)});
 const space={id:id(5),ownerId:'self',workspaceId:'default',title:'知识库',rootNodeId:id(6),directoryRevision:1,scopeIds:['general'],createdAt:stamp,updatedAt:stamp};
 const api={directory:async()=>({resources:[],drafts:[]}),sources:async()=>[],knowledgeTree:async()=>({space,nodes:[{id:id(6),spaceId:space.id,parentId:null,type:'space',title:'知识库',path:[id(6)],siblingOrder:0,createdAt:stamp,updatedAt:stamp}]})},roleApi={list:async()=>[{id:id(7),name:'T1 分析员',kind:'employee',state:'active',knowledge:[]}]};
 const snapshot={locale:'zh-CN',dshLocale:'zh',revision:1},runtime={getSnapshot:()=>snapshot,subscribe:()=>()=>{},t:(key,params)=>translateMessage('zh-CN',key,params)};
 function App(){
  const [state,setState]=useState({...emptyTaskPreview(),tasks:[]}),[target,setTarget]=useState(null);
  const mergeArtifacts=rows=>setState(current=>({...current,artifacts:[...current.artifacts.filter(row=>!rows.some(next=>next.id===row.id)),...rows]}));
  const openArtifacts=(source,artifact)=>setTarget({source,artifact});
  window.libraryArtifact={calls,changes,taskCount:()=>state.tasks.length};
  return <I18nProvider runtime={runtime}><main className={tokens.tokens} style={{...prototypeThemes.light,height:'100dvh',display:'flex',minWidth:0,fontFamily:'system-ui'}}>
   <section style={{flex:1,minWidth:0}}><ResourceManager api={api} roleApi={roleApi} artifactApi={artifactApi} openArtifact={${openArtifact.getText(ast)}} visible selectedDraftId={null} targetResource={null} clearTarget={()=>{}} openConversation={()=>{}}/>
   <button onClick={()=>setTarget({source:sourceRef,artifact:{id:id(3),version:1}})}>打开固定第一版</button>
   <button onClick={()=>setTarget({source:sourceRef,artifact:{id:id(3),version:99}})}>打开缺失版本</button>
   <button onClick={()=>setTarget({source:otherRef,artifact:{id:id(3),version:2}})}>打开不匹配来源</button>
   <button onClick={()=>{setState(current=>({...current,tasks:[{id:source.id,title:'本地演示任务',scope:'general',version:1,updatedAt:stamp,assigneeId:'role',evidence:[],history:[],state:'waiting'}]}));setTarget({source:sourceRef,artifact:{id:id(3),version:2}})}}>切换演示来源</button></section>
   {target&&<aside style={{width:'min(500px,100%)',height:'100%',flexShrink:0}}><ArtifactPanel inline open target={target} state={state} conversation={undefined} nativeArtifacts={{}} artifactFileApi={{}} close={()=>setTarget(null)} change={async command=>{changes.push(command)}} openSource={()=>{}} openTask={()=>{}}/></aside>}
  </main></I18nProvider>
 };createRoot(document.getElementById('root')).render(<App/>);
 `)
 const built=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:')},lib:{entry:join(temp,'fixture.tsx'),name:'LibraryArtifact',formats:['iife']}}})
 const bundle=Array.isArray(built)?built[0]:built;assert.ok(bundle&&'output'in bundle)
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1440,height:960}});page.setDefaultTimeout(4000);t.after(()=>page.close())
 const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message))
 await page.route('**/*',(route:any)=>route.request().url()==='http://127.0.0.1:3199/library-artifact'?route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="zh-CN"><body style="margin:0"><div id="root"></div></body></html>'}):route.abort())
 await page.goto('http://127.0.0.1:3199/library-artifact')
 await page.addStyleTag({content:bundle.output.flatMap(row=>row.type==='asset'&&row.fileName.endsWith('.css')?[String(row.source)]:[]).join('\n')});await page.addScriptTag({content:bundle.output.find(row=>row.type==='chunk')!.code})
 const directory=page.locator('[data-teloa-pane=directory]'),panel=page.getByRole('dialog',{name:'工作成果',exact:true})
 await directory.getByRole('button',{name:'Auto Dream · 每日小结',exact:true}).click()
 await panel.getByText('第二版固定正文',{exact:true}).waitFor()
 assert.equal(await panel.getByText('请求的内容不存在或已不可用。',{exact:true}).count(),0)
 assert.equal(await page.evaluate(()=>(window as any).libraryArtifact.taskCount()),0,'读取成果不需要先访问任务页')
 if(process.env.TELOA_UI_SCREENSHOT_DIR){await mkdir(process.env.TELOA_UI_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:join(process.env.TELOA_UI_SCREENSHOT_DIR,'library-artifact-preview.png')})}
 await panel.getByRole('button',{name:'关闭产物面板',exact:true}).click()
 await page.getByRole('button',{name:'打开固定第一版',exact:true}).click();await panel.getByText('第一版固定正文',{exact:true}).waitFor();assert.equal(await panel.getByText('第二版固定正文',{exact:true}).count(),0)
 await panel.getByRole('button',{name:'关闭产物面板',exact:true}).click()
 await directory.getByRole('button',{name:'FortiGate 工作成果',exact:true}).click();await panel.getByText('另一份成果独有正文',{exact:true}).waitFor()
 await panel.getByRole('button',{name:'关闭产物面板',exact:true}).click()
 for(const name of ['打开缺失版本','打开不匹配来源','切换演示来源']){
  await page.getByRole('button',{name,exact:true}).click();await panel.getByRole('alert').waitFor();assert.match(await panel.innerText(),/请求的内容不存在或已不可用/)
  assert.equal(await panel.getByText('第二版固定正文',{exact:true}).count(),0);await panel.getByRole('button',{name:'返回工作概览',exact:true}).click()
 }
 const recorded=await page.evaluate(()=>(window as any).libraryArtifact);assert.deepEqual(recorded.changes,[]);assert.ok(recorded.calls.every((row:any)=>['artifacts/role/list','artifacts/versions','artifacts/feedback/list'].includes(row.method)))
 assert.deepEqual(errors,[])
})

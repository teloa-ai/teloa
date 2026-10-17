import test,{before,after,type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import ts from 'typescript'
import {build} from 'vite'
// @ts-expect-error 复用既有无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
let browser:any,script:string

// 执行 Frame 的实际端口构造语句；仅依赖服务以本机内存回执提供，不复制一套结项 producer。
async function frameCompletionSource(){
 const text=await readFile(client+'WorkbenchFrame.tsx','utf8'),file=ts.createSourceFile('WorkbenchFrame.tsx',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),statements:string[]=[]
 const names=new Set(['taskCompletionOrigin','taskCompletionPort','taskPersistence'])
 const visit=(node:ts.Node)=>{
  if(ts.isVariableStatement(node)&&node.declarationList.declarations.some(row=>ts.isIdentifier(row.name)&&names.has(row.name.text)))statements.push(node.getText(file))
  if(ts.isExpressionStatement(node)&&ts.isBinaryExpression(node.expression)&&node.expression.left.getText(file)==='taskCompletionOrigin.current')statements.push(node.getText(file))
  ts.forEachChild(node,visit)
 }
 visit(file);assert.ok(statements.some(row=>row.startsWith('const taskPersistence=')))
 return statements.join('\n')
}
before(async()=>{
 const actual=await frameCompletionSource(),virtual=root+'__task_completion_continuity.tsx'
 const entry=`import React,{useMemo,useRef,useState} from 'react';import {createRoot} from 'react-dom/client';import {TaskCompletion,type TaskCompletionPort} from '${client}TaskCompletion.tsx';import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';
 const snapshot={locale:'zh-CN',dshLocale:'zh',revision:1},runtime={getSnapshot:()=>snapshot,subscribe:()=>()=>{},t:(key,params)=>translateMessage('zh-CN',key,params)};
 const f=window.completionFixture={completedCalls:[],merges:[],refreshes:[],openCalls:[],switchConnection:()=>{},holdRead:location.hash==='#completed',releaseRead:()=>{},readWaiting:false,holdComplete:false,releaseComplete:()=>{},completeWaiting:false};
 const base={id:'task-1',storage:'persistent',state:'waiting',version:3,scope:'general',goal:'核对原始材料',title:'原营销成果',assigneeId:'employee-1',updatedAt:'2026-10-16T01:12:13.563Z'};
 const artifact={id:'artifact-1',source:{kind:'task',id:base.id},versions:[{number:1,title:'原成果 v1',source:{ref:{kind:'task',id:base.id},scope:'general',version:base.version+' · '+base.updatedAt},sections:[]}]};
 const stale={...artifact,id:'old-artifact',versions:[{...artifact.versions[0],source:{...artifact.versions[0].source,version:'2 · old-source'}}]};
 const record=owner=>({taskId:base.id,taskVersion:4,artifactId:'artifact-'+owner,artifactVersion:1,note:owner+' 的结项记录',completedAt:'2026-10-16T02:00:00Z'});
 const taskApis=[0,1].map(owner=>({completion:async()=>{if(owner===0&&f.holdRead){f.readWaiting=true;await new Promise(resolve=>f.releaseRead=resolve)}return record(owner)},pendingFields:()=>undefined,recoveryMessage:()=>undefined}));
 const artifacts=[0,1].map(()=>({list:async()=>[stale,artifact]})),transitions=[0,1].map(owner=>({pending:()=>undefined,recoveryMessage:()=>undefined,change:async(id,version,action,delivery)=>{f.completedCalls.push({owner,id,version,action,delivery});if(f.holdComplete){f.completeWaiting=true;await new Promise(resolve=>f.releaseComplete=resolve)}return {id,state:'completed',version:version+1}}}));
 function App(){const [connection,setConnection]=useState(0),[opened,setOpened]=useState(false),[task,setTask]=useState(location.hash==='#completed'?{...base,state:'completed',version:4}:base),[revision,refreshTaskState]=useState(0);
  f.switchConnection=()=>setConnection(1);const artifactApi=artifacts[connection],taskApi=taskApis[connection],taskTransitions=transitions[connection];
  const mergeSavedTasks=rows=>{f.merges.push({opened,revision,rows});setTask(current=>({...current,...rows[0]}))};
  const taskAttentionKnown=true,taskLoadError=undefined,taskAttention=[],securityAttentionKnown=true,handoffPort={},createSavedTask=async()=>'',loadTasks=()=>{},taskLoading=false,businessSourceLoadErrors={},locale='zh-CN',localizeWorkError=()=>'';
  ${actual}
  return <><TaskCompletion task={task} api={taskPersistence.completion} open={ref=>{f.openCalls.push(ref);setOpened(true);refreshTaskState(value=>value+1)}}/>{opened&&<dialog open aria-label="原成果核对"><p>原成果 v1</p><button onClick={()=>{setOpened(false);refreshTaskState(value=>value+1)}}>关闭核对</button></dialog>}</>
 }
 createRoot(document.getElementById('root')).render(<I18nProvider runtime={runtime}><App/></I18nProvider>);`
 const result=await build({configFile:false,root,logLevel:'error',resolve:{alias:{'@teloa/contract':root+'packages/contract/src/index.ts'}},plugins:[{name:'task-completion-continuity',resolveId:id=>id.endsWith('task-completion-continuity')?virtual:null,load:id=>id===virtual?entry:null}],define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:id=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:'task-completion-continuity',name:'TaskCompletionContinuity',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle);const chunk=bundle.output.find(item=>item.type==='chunk');assert.ok(chunk&&chunk.type==='chunk');script=chunk.code
 browser=await loadPlaywright().chromium.launch(launchOptions())
})
after(async()=>{await browser?.close()})
async function mount(t:TestContext,completed=false){
 const page=await browser.newPage();page.setDefaultTimeout(5000);const errors:string[]=[]
 page.on('pageerror',(error:Error)=>errors.push(error.message));t.after(async()=>{await page.close();assert.deepEqual(errors,[])})
 await page.route('**/*',(route:any)=>route.abort());await page.setContent('<html lang="zh-CN"><div id="root"></div></html>');if(completed)await page.evaluate(()=>location.hash='completed');await page.addScriptTag({content:script});return page
}

test('真实Frame端口包装重渲染：核对成果抽屉关闭后保原版本与结项说明，不自动提交',async t=>{
 const page=await mount(t),section=page.getByRole('region',{name:'任务结项',exact:true}),choice=section.getByRole('combobox'),note=section.getByRole('textbox')
 await section.getByRole('button',{name:'读取成果',exact:true}).click();await choice.locator('option[value="artifact-1:1"]').waitFor({state:'attached'})
 assert.equal(await choice.locator('option[value="old-artifact:1"]').count(),0,'旧任务source版本仍不可结项')
 await choice.selectOption('artifact-1:1');await note.fill('本人核对过原成果 v1，仅确认本项交付。')
 await section.getByRole('button',{name:'核对成果',exact:true}).click();await page.getByRole('dialog',{name:'原成果核对'}).getByRole('button',{name:'关闭核对'}).click()
 assert.equal(await choice.inputValue(),'artifact-1:1','核对抽屉重渲染不可清掉已选择的原版本')
 assert.equal(await note.inputValue(),'本人核对过原成果 v1，仅确认本项交付。')
 assert.deepEqual(await page.evaluate(()=>(window as any).completionFixture.completedCalls),[],'打开/关闭核对不得结项')
 await section.getByRole('button',{name:'完成任务',exact:true}).click()
 assert.deepEqual(await page.evaluate(()=>(window as any).completionFixture.completedCalls),[{owner:0,id:'task-1',version:3,action:'complete',delivery:{artifact:{id:'artifact-1',version:1},note:'本人核对过原成果 v1，仅确认本项交付。'}}])
 assert.equal((await page.evaluate(()=>(window as any).completionFixture.merges))[0].opened,false,'应用最新Frame handler，不锁住核对抽屉旧闭包')
 assert.equal((await page.evaluate(()=>(window as any).completionFixture.merges))[0].revision,2,'同连接的稳定端口仍使用最近两次外壳更新后的 handler')
})

test('真实连接更换仍清旧选择，已完成记录的旧API迟答不能覆盖新连接',async t=>{
 const page=await mount(t),section=page.getByRole('region',{name:'任务结项',exact:true}),choice=section.getByRole('combobox')
 await section.getByRole('button',{name:'读取成果',exact:true}).click();await choice.selectOption('artifact-1:1');await page.evaluate(()=>(window as any).completionFixture.switchConnection())
 await page.waitForFunction(()=>document.querySelector('select')?.value==='');assert.equal(await choice.locator('option[value="artifact-1:1"]').count(),0)
 const completed=await mount(t,true);await completed.waitForFunction(()=>(window as any).completionFixture.readWaiting);await completed.evaluate(()=>{(window as any).completionFixture.switchConnection()});await completed.getByText('1 的结项记录',{exact:true}).waitFor();await completed.evaluate(()=>(window as any).completionFixture.releaseRead());await completed.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));assert.equal(await completed.getByText('0 的结项记录',{exact:true}).count(),0)
 assert.deepEqual(await page.evaluate(()=>(window as any).completionFixture.completedCalls),[])
})

test('连接更换后原结项回执不合入新本人页面，也不重发原结项',async t=>{
 const page=await mount(t),section=page.getByRole('region',{name:'任务结项',exact:true})
 await section.getByRole('button',{name:'读取成果',exact:true}).click();await section.getByRole('combobox').selectOption('artifact-1:1');await section.getByRole('textbox').fill('核对原版本后结项。')
 await page.evaluate(()=>{(window as any).completionFixture.holdComplete=true});await section.getByRole('button',{name:'完成任务',exact:true}).click();await page.waitForFunction(()=>(window as any).completionFixture.completeWaiting)
 await page.evaluate(()=>(window as any).completionFixture.switchConnection());await page.waitForFunction(()=>document.querySelector('select')?.value==='');await page.evaluate(()=>(window as any).completionFixture.releaseComplete());await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
 assert.equal((await page.evaluate(()=>(window as any).completionFixture.completedCalls)).length,1)
 assert.deepEqual(await page.evaluate(()=>(window as any).completionFixture.merges),[],'旧连接已发出的真实回执只留原API，不污染新连接投影')
})

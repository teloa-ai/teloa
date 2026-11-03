import assert from 'node:assert/strict'
import {test,before,after} from 'node:test'
import {createHash} from 'node:crypto'
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
import ts from 'typescript'
// @ts-expect-error 使用当前工作树既有的无头浏览器加载器。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'

const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
const isolated=['WorkDirectory','WorkHome','TaskPage','TeamPage','BusinessPage','MarketPage','TeamCapabilitiesPage','ResourceManager','CollaborationPage','ContinuousPage','ProjectOverviewPage','CapabilityTargetPanel','SavedIndustryDirectory','AutoDreamSettingsPage']
const original='export const checked = 1;\n',next='export const checked = 2;\n'
const snapshot=(text:string)=>({schema:'teloa.file-snapshot/v1',sessionId:'library-result-session',id:'a'.repeat(64),path:'src/result.ts',sha256:createHash('sha256').update(text).digest('hex'),bytes:Buffer.byteLength(text),capturedAt:'2026-10-28T00:00:00Z',contentBase64:Buffer.from(text).toString('base64')})
let browser:any,script:string,styles:string,temp:string

before(async()=>{
 const source=await readFile(new URL('./business-builder-frame.test.ts',import.meta.url),'utf8'),ast=ts.createSourceFile('fixture.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS)
 let node:ts.Expression|undefined;const visit=(item:ts.Node)=>{if(ts.isVariableDeclaration(item)&&item.name.getText(ast)==='entry')node=item.initializer;ts.forEachChild(item,visit)};visit(ast);assert.ok(node)
 let entry=new Function('client','return '+node.getText(ast))(client) as string
 const setup=`
 f.scopeRows=[{scope:'general',title:'通用工作',kind:'general'}];
 f.renderErrors=[];class FixtureBoundary extends React.Component{state={error:null};static getDerivedStateFromError(error){return{error}};componentDidCatch(error){f.renderErrors.push(error.message)};render(){return this.state.error?<output data-frame-error>{this.state.error.message}</output>:this.props.children}}
 const task={id:'22222222-2222-4222-8222-222222222222',ownerId:'self',title:'新的合成果工作',goal:'只阅读合成原件',scope:'general',groupId:null,skills:[],version:3,state:'waiting',assigneeRoleId:null,assigneeRoleVersion:null,createdAt:stamp,updatedAt:stamp};
 const source={kind:'task',id:task.id};f.output={artifactId:'11111111-1111-4111-8111-111111111111',number:1,title:'合成代码成果',source:{kind:'task',id:task.id,scope:'general',title:task.title,version:'3 · '+stamp},createdAt:stamp,updatedAt:stamp,attribution:'task'};
 f.artifact={id:f.output.artifactId,source,storage:'persistent',primary:true,links:[],feedback:[],versions:[${JSON.stringify(snapshot(original))},${JSON.stringify(snapshot(next))}].map((file,index)=>({number:index+1,title:'合成代码成果',sections:[],source:{ref:source,title:task.title,scope:'general',version:'3 · '+stamp,author:'本人',private:false,evidence:[]},note:'固定版本 '+(index+1),author:'本人',at:stamp,files:[file]}))};
 f.artifactLists=0;f.artifactGets=0;f.writes=[];f.holdRead=false;f.releaseRead=()=>{f.holdRead=false;f.readResolver?.()};
 props.taskApi=new Proxy(props.taskApi,{get:(target,key)=>key==='attention'?async()=>({items:[{task}]}):['create','createConfirmed','recoverCreate'].includes(key)?async()=>{f.writes.push('task.'+key);throw Error('unexpected task write')}:Reflect.get(target,key)});
 props.artifactApi=new Proxy(props.artifactApi,{get:(target,key)=>key==='get'?async()=>{f.artifactGets++;if(f.holdRead)await new Promise(resolve=>f.readResolver=resolve);return structuredClone(f.artifact)}:key==='list'?async()=>{f.artifactLists++;return [structuredClone(f.artifact)]}:key==='pendingFor'||key==='recoveryItems'?()=>[]:key==='recoveryMessage'?()=>undefined:['create','revise','feedback','capture'].includes(key)?async()=>{f.writes.push('artifact.'+key);throw Error('unexpected artifact write')}:Reflect.get(target,key)});
 f.chooseVersion=number=>{f.output={...f.output,number}};f.openTaskResults=()=>store.actions.openArtifacts(source);
 `
 assert.equal(entry.split('const frameRoot=').length,2);entry=entry.replace('const frameRoot=',setup+'const frameRoot=');entry=entry.replace('<WorkbenchFrame {...props}','<FixtureBoundary><WorkbenchFrame {...props}').replace('insertConversationCapabilities={noop}/></I18nProvider>','insertConversationCapabilities={noop}/></FixtureBoundary></I18nProvider>')
 temp=await mkdtemp(join(root,'.runtime-library-artifact-'));await writeFile(join(temp,'fixture.tsx'),entry)
 const stubbed=new Set(isolated.map(name=>join(client,name+'.tsx')))
 const built=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},plugins:[{name:'library-frame-boundary',enforce:'pre',load:async id=>{
  if(!stubbed.has(id))return
  if(id===join(client,'ResourceManager.tsx'))return `import React from 'react';export const ResourceManager=props=>{window.frameFixture.libraryProps=props;return <section hidden={!props.visible} data-library><nav aria-label="资料树"><input aria-label="资料搜索" defaultValue="保留筛选"/><button onClick={()=>props.openArtifact(window.frameFixture.output)}>打开成果</button><button onClick={()=>props.onCloseArtifact?.()}>打开普通资料</button></nav><article data-library-seat ref={props.artifactReaderRef} hidden={!props.artifactReaderOpen}/></section>};export const ResourceDraftCard=()=>null;`
  if(id===join(client,'TeamPage.tsx'))return 'export const RoleForm=()=>null;export const TeamPage=()=>null;'
  return [...(await readFile(id,'utf8')).matchAll(/export (?:async )?(?:function|const|class) (\w+)/g)].map(m=>'export const '+m[1]+'=()=>null;').join('\n')
 }}],build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'LibraryArtifactFrame',formats:['iife']}}})
 const bundle=Array.isArray(built)?built[0]:built;assert.ok(bundle&&'output'in bundle);script=bundle.output.find(x=>x.type==='chunk')!.code;styles=bundle.output.flatMap(x=>x.type==='asset'&&x.fileName.endsWith('.css')?[String(x.source)]:[]).join('\n');browser=await loadPlaywright().chromium.launch({...launchOptions(),headless:true})
})
after(async()=>{await browser?.close();if(temp)await rm(temp,{recursive:true,force:true})})
async function mount(t:any){
 const page=await browser.newPage({viewport:{width:1600,height:1000},acceptDownloads:true,serviceWorkers:'block'}),errors:string[]=[],network:string[]=[];page.setDefaultTimeout(5000);page.on('pageerror',(e:Error)=>errors.push(e.message));t.after(async()=>{await page.close();assert.deepEqual(errors,[]);assert.deepEqual(network,[])})
 await page.route('**/*',(r:any)=>r.request().url()==='http://127.0.0.1:41837/__library_frame__'?r.fulfill({contentType:'text/html',body:'<html lang="zh-CN"><body><div id="root"></div></body></html>'}):(network.push(new URL(r.request().url()).protocol),r.abort()));await page.goto('http://127.0.0.1:41837/__library_frame__');await page.addStyleTag({content:styles});await page.addScriptTag({content:script});await page.waitForFunction(()=>(window as any).frameFixture?.renderErrors.length||(window as any).frameFixture?.controller.getSnapshot().status==='ready');assert.deepEqual(await page.evaluate(()=>(window as any).frameFixture.renderErrors),[]);await page.evaluate(()=>(window as any).frameFixture.navigate('resources'));await page.locator('[data-library]:visible').waitFor();return page
}
const open=async(page:any)=>{await page.getByRole('button',{name:'打开成果',exact:true}).click();await page.locator('[data-artifact-reader]').waitFor()}
test('Library目录固定v1不漂移到v2，原件读入中央座位且树和搜索不丢失',async t=>{
 const page=await mount(t);await page.getByRole('textbox',{name:'资料搜索',exact:true}).fill('自己的筛选');await page.evaluate(()=>{(window as any).savedTree=document.querySelector('[aria-label="资料树"]')});await open(page)
 assert.equal((await page.locator('[data-artifact-reader]').getByRole('button',{name:'版本历史',exact:true}).innerText()).trim(),'v1')
 assert.equal(await page.locator('[data-library-seat] [data-artifact-reader]').count(),1);assert.equal(await page.locator('[data-artifact-reader]').count(),1);assert.equal(await page.evaluate(()=>(window as any).savedTree===document.querySelector('[aria-label="资料树"]')),true);assert.equal(await page.getByRole('textbox',{name:'资料搜索',exact:true}).inputValue(),'自己的筛选');assert.equal(await page.evaluate(()=>(window as any).frameFixture.state().view),'resources')
 const downloadEvent=page.waitForEvent('download');await page.locator('[data-library-seat]').getByRole('link',{name:'下载原件',exact:true}).click();const download=await downloadEvent;assert.equal(download.suggestedFilename(),'result.ts');assert.equal((await readFile(await download.path())).toString(),original)
})
test('Library固定成果读回不触发task目录物化，普通Task无固定成果入口仍保留',async t=>{
 const page=await mount(t);await open(page);await page.waitForTimeout(3250);assert.equal(await page.evaluate(()=>(window as any).frameFixture.artifactLists),0);assert.deepEqual(await page.evaluate(()=>(window as any).frameFixture.writes),[])
 await page.evaluate(()=>(window as any).frameFixture.navigate('tasks'));await page.waitForFunction(()=>(window as any).frameFixture.state().view==='tasks');await page.evaluate(()=>(window as any).frameFixture.openTaskResults());await page.waitForFunction(()=>(window as any).frameFixture.artifactLists>0);assert.deepEqual(await page.evaluate(()=>(window as any).frameFixture.writes),[])
})
test('普通资料关闭与跨页返回使用唯一Panel，修改草稿保留且迟到读不抢别页',async t=>{
 const page=await mount(t);await page.evaluate(()=>(window as any).frameFixture.chooseVersion(2));await open(page);const reader=page.locator('[data-library-seat] [data-artifact-reader]');await reader.getByRole('button',{name:'修改',exact:true}).click();await reader.getByRole('textbox',{name:'修改要求',exact:true}).fill('保留这份修改要求');await page.getByRole('button',{name:'打开普通资料',exact:true}).click();assert.equal(await page.locator('[data-artifact-reader]:visible').count(),0);await open(page);await reader.getByRole('button',{name:'修改',exact:true}).click();assert.equal(await reader.getByRole('textbox',{name:'修改要求',exact:true}).inputValue(),'保留这份修改要求')
 await page.evaluate(()=>(window as any).frameFixture.navigate('team'));await page.waitForFunction(()=>(window as any).frameFixture.state().view==='team');assert.equal(await page.locator('[data-artifact-reader]:visible').count(),0);await page.evaluate(()=>(window as any).frameFixture.navigate('resources'));await page.getByRole('button',{name:'打开普通资料',exact:true}).click();await page.evaluate(()=>(window as any).frameFixture.holdRead=true);await page.getByRole('button',{name:'打开成果',exact:true}).click();await page.evaluate(()=>{const f=(window as any).frameFixture;f.navigate('team');f.releaseRead()});await page.waitForFunction(()=>(window as any).frameFixture.state().view==='team');assert.equal(await page.locator('[data-artifact-reader]:visible').count(),0);assert.deepEqual(await page.evaluate(()=>(window as any).frameFixture.writes),[])
})

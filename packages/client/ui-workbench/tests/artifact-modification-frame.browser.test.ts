import assert from 'node:assert/strict'
import {test,before,after} from 'node:test'
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
import ts from 'typescript'
// @ts-expect-error 使用已有工作树的无头浏览器加载器。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'
const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
const isolated=['WorkDirectory','WorkHome','TaskPage','TeamPage','BusinessPage','MarketPage','TeamCapabilitiesPage','ResourceManager','CollaborationPage','ContinuousPage','ArtifactPanel','ProjectOverviewPage','CapabilityTargetPanel','SavedIndustryDirectory','AutoDreamSettingsPage']
let browser:any,script:string,styles:string,temp:string
before(async()=>{
 const source=await readFile(new URL('./business-builder-frame.test.ts',import.meta.url),'utf8'),ast=ts.createSourceFile('fixture.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS)
 let node:ts.Expression|undefined;const visit=(item:ts.Node)=>{if(ts.isVariableDeclaration(item)&&item.name.getText(ast)==='entry')node=item.initializer;ts.forEachChild(item,visit)};visit(ast);assert.ok(node)
 let entry=new Function('client','return '+node.getText(ast))(client) as string
 const setup=`
 import {artifactDetailTarget} from '${client}workbench-detail-target.ts';
 f.scopeRows=[{scope:'general',title:'通用工作',kind:'general'},{scope:'sales',title:'验收业务',kind:'domain'}];
 f.renderErrors=[];class FrameFixtureBoundary extends React.Component{state={error:null};static getDerivedStateFromError(error){return{error}};componentDidCatch(error,info){f.renderErrors.push({message:error.message,stack:error.stack,componentStack:info.componentStack})};render(){return this.state.error?<output data-frame-error>{this.state.error.message}</output>:this.props.children}}
 f.prepared=[];props.preparation={prepare:prompt=>f.prepared.push(prompt),invalidate:noop};
 f.executionWrites=[];for(const name of ['taskApi','taskRunApi']){const original=props[name];props[name]=new Proxy(original,{get:(target,key)=>['create','createConfirmed','prepare','start','recoverCreate'].includes(key)?async()=>{f.executionWrites.push(name+'.'+key);throw Error('Unexpected execution write')}:Reflect.get(target,key)})}
 const file={schema:'teloa.file-snapshot/v1',sessionId:'old-employee-session',id:'a'.repeat(64),path:'outputs/demo.mp4',sha256:'b'.repeat(64),bytes:8,capturedAt:'2026-10-28T00:00:00Z',contentBase64:'AAAAHGZ0eXA='};
 f.file=file;f.freshArtifact={id:'11111111-1111-4111-8111-111111111111',source:{kind:'session',id:'old-employee-session'},storage:'persistent',primary:true,links:[],feedback:[],versions:[{number:1,title:'演示视频',sections:[],source:{ref:{kind:'session',id:'old-employee-session'},title:'原工作',scope:'sales',version:'1',author:'本人',private:true,evidence:[]},note:'已保存',author:'本人',at:'2026-10-28T00:00:00Z',files:[file]}]};
 let releaseArtifact;f.holdArtifact=false;f.releaseArtifact=()=>{f.holdArtifact=false;releaseArtifact?.()};
 props.artifactApi=new Proxy(props.artifactApi,{get:(target,key)=>key==='withdrawalPending'?()=>false:key==='availability'?async id=>({artifactId:id,state:f.withdrawn?'withdrawn':'available',withdrawal:f.withdrawn?{}:null}):key==='get'?async()=>{f.artifactGetStarted=true;if(f.holdArtifact)await new Promise(r=>releaseArtifact=r);return structuredClone(f.freshArtifact)}:key==='list'?async()=>[structuredClone(f.freshArtifact)]:key==='pendingFor'||key==='recoveryItems'?()=>[]:key==='recoveryMessage'?()=>undefined:Reflect.get(target,key)});
 contexts.set('old-employee-session',{sessionId:'old-employee-session',scopeId:'sales',roleId:employee.id,version:1,locked:true});
 f.openMessages=()=>store.actions.openMessages('native');f.openArtifact=()=>{store.actions.openDetail(artifactDetailTarget(f.freshArtifact.source,{id:f.freshArtifact.id,version:1},'old-employee-session'))};
 inputs.set('old-employee-session',{...emptyInput,draft:'原会话未提交内容'});f.oldDraft=()=>inputs.get('old-employee-session').draft;
 f.newPrepared=[];f.oldObjectWrites=[];f.newObjectWrites=[];f.creationOptions=[];f.opened=[];
 const originalObjectApi=props.objectConversationApi;props.objectConversationApi=new Proxy(originalObjectApi,{get:(target,key)=>key==='change'?async input=>{f.oldObjectWrites.push(input);return target.change(input)}:Reflect.get(target,key)});
 f.swapPort=kind=>{f.beforeSwapCallback=f.modification;if(kind==='preparation')props.preparation={prepare:p=>f.newPrepared.push(p),invalidate:noop};else props.objectConversationApi=new Proxy(originalObjectApi,{get:(target,key)=>key==='change'?async input=>{f.newObjectWrites.push(input);return target.change(input)}:Reflect.get(target,key)});renderFrame()};
 const originalRoleApi=props.roleApi;props.roleApi=new Proxy(originalRoleApi,{get:(target,key)=>key==='list'?async()=>{const rows=await target.list();if(f.roleGateAt===f.roleReads){f.roleGateReached=true;await new Promise(resolve=>f.releaseRoleGate=()=>{f.roleGateAt=undefined;resolve()})}return rows}:Reflect.get(target,key)});f.armRoleGate=after=>{f.roleGateAt=f.roleReads+after;f.roleGateReached=false};
 const originalCreate=work.create.bind(work);work.create=options=>{f.creationOptions.push({requestId:options.requestId,workspaceId:options.workspaceId,roleId:options.roleId,title:options.title});const opened=options.onOpened;return originalCreate({...options,...(opened?{onOpened:id=>{f.opened.push(id);opened(id)}}:{})})};
 listeners.add(()=>{if(f.delayBindingSelection)f.delayedBindingSelection=selected;else void work.select(selected)});f.binding=()=>work.getSnapshot();f.pendingCreation=()=>work.getPendingCreation();f.releaseBindingSelection=async()=>{f.delayBindingSelection=false;await work.select(selected)};
 f.seedPending=async()=>{const requestId=crypto.randomUUID();await work.create({requestId,workspaceId:'workspace',roleId:employee.id,beforeOpen:async()=>{throw Error('controlled unrelated pending')}}).catch(()=>{});f.seededPending=work.getPendingCreation();return f.seededPending};

 `
 assert.equal(entry.split('const frameRoot=').length,2);entry=entry.replace('const frameRoot=',setup+'const frameRoot=');entry=entry.replace('<WorkbenchFrame {...props}','<FrameFixtureBoundary><WorkbenchFrame {...props}').replace('insertConversationCapabilities={noop}/></I18nProvider>','insertConversationCapabilities={noop}/></FrameFixtureBoundary></I18nProvider>')
 temp=await mkdtemp(join(root,'.runtime-artifact-modification-'));await writeFile(join(temp,'fixture.tsx'),entry)
 const stubbed=new Set(isolated.map(name=>join(client,name+'.tsx')))
 const built=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},plugins:[{name:'artifact-modification-frame-boundary',enforce:'pre',load:async id=>{
  if(id===join(client,'WorkbenchFrame.tsx')){const text=await readFile(id,'utf8'),anchor='  const roleConversationOpening=useRef(new Set<string>())';assert.equal(text.split(anchor).length,2);return text.replace(anchor,'  ;(window as any).frameFixture.modification=prepareArtifactModification;(window as any).frameFixture.renderedView=state.view\n'+anchor)}
  if(!stubbed.has(id))return
  if(id===join(client,'ArtifactPanel.tsx'))return 'export const ArtifactPanel=props=>{window.frameFixture.artifactProps=props;return null};'
  if(id===join(client,'TeamPage.tsx'))return 'export const RoleForm=()=>null;export const TeamPage=()=>null;'
  return [...(await readFile(id,'utf8')).matchAll(/export (?:async )?(?:function|const|class) (\w+)/g)].map(m=>'export const '+m[1]+'=()=>null;').join('\n')
 }}],build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'ArtifactModificationFrame',formats:['iife']}}})
 const bundle=Array.isArray(built)?built[0]:built;assert.ok(bundle&&'output'in bundle);script=bundle.output.find(x=>x.type==='chunk')!.code;assert.ok(script.includes('frameFixture.modification'),'Frame callback probe must be bundled');styles=bundle.output.flatMap(x=>x.type==='asset'&&x.fileName.endsWith('.css')?[String(x.source)]:[]).join('\n');browser=await loadPlaywright().chromium.launch(launchOptions())
})
after(async()=>{await browser?.close();if(temp)await rm(temp,{recursive:true,force:true})})
async function mount(t:any){
 const page=await browser.newPage({viewport:{width:1400,height:1000}}),errors:string[]=[];page.setDefaultTimeout(5000);page.on('pageerror',(e:Error)=>errors.push(e.message));t.after(async()=>{await page.close();assert.deepEqual(errors,[])})
 await page.route('**/*',(r:any)=>r.request().isNavigationRequest()?r.fulfill({contentType:'text/html',body:'<html lang="zh-CN"><body><div id="root"></div></body></html>'}):r.abort());await page.goto('https://fixture.invalid');await page.evaluate(()=>(window as any).frameStartup={withRole:true,roleSession:true,sessionId:'old-employee-session',roleScopes:['sales']});await page.addStyleTag({content:styles});await page.addScriptTag({content:script});await page.waitForFunction(()=>(window as any).frameFixture.renderErrors?.length||typeof(window as any).frameFixture.modification==='function'&&(window as any).frameFixture.controller.getSnapshot().status==='ready');assert.deepEqual(await page.evaluate(()=>(window as any).frameFixture.renderErrors),[]);await page.evaluate(()=>(window as any).frameFixture.openMessages());await page.waitForFunction(()=>(window as any).frameFixture.renderedView==='messages');await page.evaluate(()=>(window as any).frameFixture.openArtifact());await page.waitForFunction(()=>(window as any).frameFixture.renderErrors?.length||(window as any).frameFixture.state().detail.open&&typeof(window as any).frameFixture.modification==='function').catch(async(error:unknown)=>{console.log('MOUNT_FACTS',await page.evaluate(()=>{const f=(window as any).frameFixture;return {renderErrors:f.renderErrors,state:f.state(),callback:typeof f.modification,body:document.body.innerText.slice(0,1200),mounts:f.mounts}}));throw error});assert.deepEqual(await page.evaluate(()=>(window as any).frameFixture.renderErrors),[]);return page
}
async function begin(page:any,fileChange:Record<string,string>={}){await page.evaluate((fileChange:Record<string,string>)=>{const f=(window as any).frameFixture;f.outcome='pending';Promise.resolve().then(()=>f.modification(f.freshArtifact.id,1,'把开头缩短到两秒。',{id:f.file.id,sha256:f.file.sha256,path:f.file.path,...fileChange},()=>f.allow!==false)).then(()=>f.outcome='prepared',(e:any)=>{f.outcome='rejected';f.error=e.code})},fileChange)}
const outcome=(page:any)=>page.waitForFunction(()=>(window as any).frameFixture.outcome!=='pending')
const facts=(page:any)=>page.evaluate(()=>{const f=(window as any).frameFixture;return {outcome:f.outcome,error:f.error,creates:f.creates,prepared:f.prepared,sent:f.sent,writes:f.executionWrites,oldDraft:f.oldDraft(),current:f.current(),links:f.links,newPrepared:f.newPrepared,oldObjectWrites:f.oldObjectWrites,newObjectWrites:f.newObjectWrites,bindingSession:f.binding().sessionId,delayedBindingSelection:f.delayedBindingSelection,creationOptions:f.creationOptions,opened:f.opened,pending:f.pendingCreation()}})
test('任意文件修改准备独立工作输入，固定文件与当前员工/业务，不发送或覆盖旧稿',async t=>{const page=await mount(t);await begin(page);await outcome(page);const f=await facts(page);assert.equal(f.outcome,'prepared');assert.equal(f.creates,1);assert.notEqual(f.current,'old-employee-session');assert.equal(f.prepared.length,1);assert.ok(f.prepared[0].text.includes('outputs/demo.mp4'));assert.ok(f.prepared[0].text.includes('b'.repeat(64)));assert.ok(f.links.some((l:any)=>l.objectId==='r-profile'&&l.scopeId==='sales'&&l.sessionId===f.current));assert.deepEqual(f.sent,[]);assert.deepEqual(f.writes,[]);assert.equal(f.oldDraft,'原会话未提交内容')})
test('错文件身份与来源版本变化在创建前关闭，原草稿保留',async t=>{for(const change of [{id:'wrong'},{}]){const page=await mount(t);if(!Object.keys(change).length)await page.evaluate(()=>{const f=(window as any).frameFixture;f.freshArtifact.versions.push({...f.freshArtifact.versions[0],number:2})});await begin(page,change);await outcome(page);const f=await facts(page);assert.equal(f.outcome,'rejected');assert.equal(f.creates,0);assert.equal(f.prepared.length,0);assert.equal(f.oldDraft,'原会话未提交内容');assert.deepEqual(f.sent,[])}})
test('读取期间关闭原成果，迟到结果不新建、不向别的页面带入修改',async t=>{const page=await mount(t);await page.evaluate(()=>(window as any).frameFixture.holdArtifact=true);await begin(page);await page.evaluate(()=>{const f=(window as any).frameFixture;f.allow=false;f.navigate('team');f.releaseArtifact()});await outcome(page);const f=await facts(page);assert.equal(f.outcome,'rejected');assert.equal(f.creates,0);assert.deepEqual(f.prepared,[]);assert.deepEqual(f.sent,[])})

test('原生已打开但Binding.select延迟，仍按真实opened回执准备到新会话',async t=>{
 const page=await mount(t);await page.evaluate(()=>(window as any).frameFixture.delayBindingSelection=true);await begin(page);await outcome(page);const f=await facts(page)
 assert.equal(f.outcome,'prepared');assert.equal(f.bindingSession,'old-employee-session');assert.equal(f.delayedBindingSelection,f.current);assert.deepEqual(f.opened,[f.current]);assert.equal(f.prepared.length,1);assert.equal(f.prepared[0].sessionId,f.current);assert.equal(f.creationOptions[0].roleId,'r-profile');assert.equal(f.oldDraft,'原会话未提交内容');assert.deepEqual(f.sent,[]);assert.deepEqual(f.writes,[]);await page.evaluate(()=>(window as any).frameFixture.releaseBindingSelection())
})
test('读取期间只替换preparation或object API，旧回调不能向任何端口准备或关联',async t=>{
 for(const kind of ['preparation','object']){const page=await mount(t);await page.evaluate(()=>(window as any).frameFixture.holdArtifact=true);await begin(page);await page.waitForFunction(()=>(window as any).frameFixture.artifactGetStarted);await page.evaluate((kind:string)=>(window as any).frameFixture.swapPort(kind),kind);await page.waitForFunction(()=>(window as any).frameFixture.modification!==(window as any).frameFixture.beforeSwapCallback);await page.evaluate(()=>(window as any).frameFixture.releaseArtifact());await outcome(page);const f=await facts(page);assert.equal(f.outcome,'rejected');assert.equal(f.creates,0);assert.deepEqual(f.prepared,[]);assert.deepEqual(f.newPrepared,[]);assert.deepEqual(f.oldObjectWrites,[]);assert.deepEqual(f.newObjectWrites,[]);assert.deepEqual(f.sent,[]);assert.deepEqual(f.writes,[]);assert.equal(f.oldDraft,'原会话未提交内容')}
})
test('员工回读期间出现同员工同目录旧pending，本次独立nonce拒绝复用且保留原请求',async t=>{
 const page=await mount(t);await page.evaluate(()=>(window as any).frameFixture.armRoleGate(2));await begin(page);await page.waitForFunction(()=>(window as any).frameFixture.roleGateReached);const pending=await page.evaluate(()=>(window as any).frameFixture.seedPending());assert.ok(pending?.requestId);await page.evaluate(()=>(window as any).frameFixture.releaseRoleGate());await page.getByRole('dialog').waitFor();await page.getByRole('alert').last().waitFor();const f=await facts(page)
 assert.equal(f.creationOptions.length,2);assert.equal(f.creationOptions[0].workspaceId,f.creationOptions[1].workspaceId);assert.equal(f.creationOptions[0].roleId,f.creationOptions[1].roleId);assert.notEqual(f.creationOptions[0].requestId,f.creationOptions[1].requestId);assert.equal(f.pending.requestId,pending.requestId);assert.equal(f.creates,1,'只有本夹具明确发起的旧请求；修改没有再向create端口发请求');assert.deepEqual(f.prepared,[]);assert.deepEqual(f.opened,[]);assert.deepEqual(f.sent,[]);assert.deepEqual(f.writes,[]);await page.keyboard.press('Escape');await outcome(page);const after=await facts(page);assert.equal(after.outcome,'rejected');assert.equal(after.pending.requestId,pending.requestId);assert.equal(after.oldDraft,'原会话未提交内容')
})

test('撤回在修改准备之前或读取期间发生，原会话及草稿保留且不创建新工作',async t=>{
 for(const during of [false,true]){
  const page=await mount(t)
  await page.evaluate((during:boolean)=>{const f=(window as any).frameFixture;f.withdrawn=!during;f.holdArtifact=during},during)
  await begin(page)
  if(during){await page.waitForFunction(()=>(window as any).frameFixture.artifactGetStarted);await page.evaluate(()=>{const f=(window as any).frameFixture;f.withdrawn=true;f.releaseArtifact()})}
  await outcome(page);const f=await facts(page)
  assert.equal(f.outcome,'rejected');assert.equal(f.error,'teloa/source-unavailable');assert.equal(f.creates,0);assert.deepEqual(f.prepared,[]);assert.deepEqual(f.sent,[]);assert.deepEqual(f.writes,[]);assert.equal(f.current,'old-employee-session');assert.equal(f.oldDraft,'原会话未提交内容')
 }
})

import test from 'node:test'
import assert from 'node:assert/strict'
import {registerHooks} from 'node:module'
import {readFile} from 'node:fs/promises'
import ts from 'typescript'
import type {Conversation} from '@teloa/contract'
import {BindingClient} from '../src/client/binding-client.ts'
import {restoreWorkbenchConversation} from '../src/client/workbench-conversation-restore.ts'
import {createWorkbenchLayout} from '../src/client/workbench-layout.ts'
import {createSettingsNavigation} from '../src/client/settings-navigation.ts'
import {captureWorkbenchNavigationState,emptyWorkbenchNavigationState,type WorkbenchNavigationState} from '../src/client/workbench-navigation-state.ts'

registerHooks({resolve(specifier,context,next){
 if(specifier==='./workbench-detail-target.js')return next('./workbench-detail-target.ts',context)
 if(specifier==='./workbench-navigation-state.js')return next('./workbench-navigation-state.ts',context)
 return next(specifier,context)
}})
const {createWorkbenchStore}=await import('../src/client/store.ts')
const {attachWorkbenchObjectHistory,describeWorkbenchObject,initialWorkbenchObjectNavigation,navigationForWorkbenchObject,readWorkbenchObjectHash,workbenchObjectHash,workbenchObjectLink}=await import('../src/client/workbench-object-url.ts')
type Route=NonNullable<ReturnType<typeof readWorkbenchObjectHash>>
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222',C='33333333-3333-4333-8333-333333333333'
const hash=(kind:'task'|'role'|'project'|'conversation',id=A)=>workbenchObjectHash({base:{kind,id}})
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve))

function browser(href='http://localhost:3241/'){
 const events=new EventTarget(),entries=[{href,state:null as unknown}],calls:{kind:string;href:string}[]=[]
 let index=0
 const location={get href(){return entries[index]!.href},get hash(){return new URL(this.href).hash}}
 const history={get state(){return entries[index]!.state},get length(){return entries.length},
  replaceState(state:unknown,_title:string,url?:string|URL|null){const href=url==null?location.href:new URL(String(url),location.href).href;entries[index]={href,state};calls.push({kind:'replace',href})},
  pushState(state:unknown,_title:string,url?:string|URL|null){const href=url==null?location.href:new URL(String(url),location.href).href;entries.splice(++index);entries.push({href,state});calls.push({kind:'push',href})},
  back(){if(index>0){index--;events.dispatchEvent(new Event('popstate'));events.dispatchEvent(new Event('hashchange'))}},
  forward(){if(index+1<entries.length){index++;events.dispatchEvent(new Event('popstate'));events.dispatchEvent(new Event('hashchange'))}},
 }
 return {window:{location,history,addEventListener:events.addEventListener.bind(events),removeEventListener:events.removeEventListener.bind(events)} as unknown as Window,location,history,calls,entries,pagehide:()=>events.dispatchEvent(new Event('pagehide'))}
}
function fixture(href='http://localhost:3241/',scope='owner-installation-A'){
 const ui=createWorkbenchStore().create(),web=browser(href),errors:unknown[]=[],restored:Route[]=[]
 const adapter=attachWorkbenchObjectHistory({window:web.window,scope,capture:()=>captureWorkbenchNavigationState(ui.getSnapshot()),describe:async()=>describeWorkbenchObject(ui.getSnapshot(),{}),
  restore:async(route,local,current)=>{if(!current())return;restored.push(route);ui.actions.restoreObjectNavigation(navigationForWorkbenchObject(route,local),undefined,route.detail?.kind==='role-preview'?route.detail.id:undefined)},error:error=>errors.push(error)})
 const observe=()=>adapter.observe(ui.getSnapshot().objectNavigationRevision,undefined)
 observe()
 return {ui,web,adapter,observe,errors,restored}
}

async function initialFrameStore(address:string,saved?:WorkbenchNavigationState){
 const file=ts.createSourceFile('index.ts',await readFile(new URL('../src/client/index.ts',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TS)
 let initializer:ts.Expression|undefined
 const visit=(node:ts.Node)=>{if(ts.isVariableDeclaration(node)&&node.name.getText(file)==='handle'&&node.initializer?.getText(file).startsWith('createWorkbenchStore('))initializer=node.initializer;ts.forEachChild(node,visit)};visit(file)
 assert.ok(initializer,'客户端 root 必须在挂载 Frame 前创建导航 store')
 const scope={ctx:{theme:{getTheme:()=>({active:{colorScheme:'light'}})}},createWorkbenchStore,navigationStorage:{},loadWorkbenchNavigationState:()=>saved,initialWorkbenchObjectNavigation,window:{location:{hash:address}}}
 const source=ts.transpileModule('const handle='+initializer.getText(file),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText
 return new Function(...Object.keys(scope),source+';return handle.create()')(...Object.values(scope)) as ReturnType<ReturnType<typeof createWorkbenchStore>['create']>
}

test('新认证上下文在 Frame 挂载前采用对象地址视图，不启动竞争的 Home 准备',async()=>{
 const ui=await initialFrameStore(hash('conversation')),state=ui.getSnapshot()
 assert.equal(state.view,'messages');assert.equal(state.messageMode,'native')
 assert.equal(state.objectNavigationRevision,0)
 // 这就是 Frame 首页准备 effect 的入口条件；真实对象仍由后续本人 API 验证后打开。
 assert.notEqual(state.view,'home');assert.equal(state.taskId,null);assert.deepEqual(state.detail,{open:false,target:null})
 const normal=await initialFrameStore('');assert.equal(normal.getSnapshot().view,'home')
 const saved=emptyWorkbenchNavigationState();saved.view='tasks';saved.selected.taskId=A;saved.directories.tasks={selectedId:A,query:'保留的本地筛选'}
 const restored=await initialFrameStore('',saved)
 assert.equal(restored.getSnapshot().taskId,A);assert.equal(restored.getSnapshot().navigationDirectories.tasks?.query,'保留的本地筛选')
})

test('启动只采用目标视图，身份和版本核验前不选择对象，保留本地查询且不改写原记录',()=>{
 const saved=emptyWorkbenchNavigationState();saved.view='tasks';saved.selected.taskId=C;saved.directories.tasks={selectedId:C,query:'原任务筛选',scrollTop:120};saved.detail={open:true,target:{kind:'directory-object',view:'tasks',id:C,source:{kind:'directory'}}}
 const original=structuredClone(saved)
 const cases:[Route,string][]=[
  [{base:{kind:'conversation',id:B}},'messages'],[{base:{kind:'task',id:A}},'tasks'],[{base:{kind:'role',id:A}},'team'],
  [{base:{kind:'project',id:A}},'spaces'],[{base:{kind:'business',scope:'general',section:'overview'}},'spaces'],
  [{base:{kind:'resource',id:A,version:3,sourceVersion:'a'.repeat(64)}},'resources'],[{base:{kind:'artifact',id:A,version:2}},'resources'],
  [{base:{kind:'directory',view:'messages',mode:'groups'}},'messages'],
 ]
 for(const [route,view] of cases){
  const result=initialWorkbenchObjectNavigation(saved,workbenchObjectHash(route))!
  assert.equal(result.view,view);assert.equal(result.detail.open,false)
  assert.equal(result.selected.resourceId,undefined)
  if(view==='tasks'){assert.equal(result.selected.taskId,undefined);assert.equal(result.directories.tasks?.selectedId,undefined)}
  assert.equal(result.directories.tasks?.query,'原任务筛选');assert.equal(result.directories.tasks?.scrollTop,120)
 }
 assert.deepEqual(saved,original)
 for(const address of ['', '#teloa-main','#plugin/extension','#teloa/v2/conversation/'+A,'#teloa/v1/conversation/malformed'])assert.equal(initialWorkbenchObjectNavigation(saved,address),saved)
 assert.equal(initialWorkbenchObjectNavigation(undefined,''),undefined)
})

test('冷地址等待本人读取时不运行真实 Home effect，绑定回填不抢链接，随后恢复正常历史',async()=>{
 const address='http://localhost:3241/'+hash('conversation',B),ui=await initialFrameStore(hash('conversation',B)),web=browser(address),f=await framePorts(ui,web.window)
 const frame=ts.createSourceFile('WorkbenchFrame.tsx',await readFile(new URL('../src/client/WorkbenchFrame.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX)
 let homeEffect:ts.Expression|undefined
 const visit=(node:ts.Node)=>{if(ts.isCallExpression(node)&&node.expression.getText(frame)==='useEffect'&&node.arguments[0]?.getText(frame).includes('prepareHomeSession(controller.signal)'))homeEffect=node.arguments[0];ts.forEachChild(node,visit)};visit(frame);assert.ok(homeEffect)
 let homePreparations=0
 const source=ts.transpileModule('const effect='+homeEffect.getText(frame),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText
 new Function('state','prepareHomeSession',source+';effect()')(ui.getSnapshot(),()=>{homePreparations++})
 let release=()=>{},reads=0
 const ready=new Promise<void>(resolve=>{release=resolve})
 const adapter=attachWorkbenchObjectHistory({...f.ports,window:web.window,restore:async(route,local,current)=>{reads++;await ready;await f.ports.restore(route,local,current)}})
 const observe=()=>adapter.observe(ui.getSnapshot().objectNavigationRevision,B)
 observe();adapter.observe(0,C);await tick()
 assert.equal(homePreparations,0);assert.equal(web.location.href,address);assert.equal(reads,1)
 release();await tick();observe();await tick()
 assert.equal(ui.getSnapshot().view,'messages');assert.ok(f.calls.includes('conversations/read-and-open'));assert.equal(web.location.href,address)
 ui.actions.navigate('resources');observe();await tick()
 const library=web.location.hash
 ui.actions.openTask(A);observe();await tick();assert.equal(web.location.hash,hash('task'))
 web.history.back();await tick();observe();await tick();assert.equal(web.location.hash,library);assert.equal(ui.getSnapshot().view,'resources')
 web.history.back();await tick();observe();await tick();assert.equal(web.location.hash,hash('conversation',B));assert.equal(ui.getSnapshot().view,'messages')
 web.history.forward();await tick();observe();await tick();assert.equal(ui.getSnapshot().view,'resources')
 web.history.forward();await tick();observe();await tick();assert.equal(ui.getSnapshot().taskId,A)
 adapter.dispose()
})

test('对象地址只包含稳定身份与固定版本，复制时移除认证 query 和用户信息',()=>{
 const routes:Route[]=[{base:{kind:'directory',view:'tasks'}},{base:{kind:'task',id:A}},{base:{kind:'role',id:A}},{base:{kind:'project',id:A}},{base:{kind:'conversation',id:A},detail:{kind:'role-preview',id:B}},{base:{kind:'business',scope:'business_'+A.replaceAll('-',''),section:'overview'}},{base:{kind:'resource',id:A,version:7,sourceVersion:'a'.repeat(64)}},{base:{kind:'directory',view:'resources'},detail:{kind:'artifact',id:A,version:2}}]
 for(const route of routes)assert.deepEqual(readWorkbenchObjectHash(workbenchObjectHash(route)),route)
 const legacy:Route={base:{kind:'business',scope:'安全运营',section:'overview'}}
 assert.deepEqual(readWorkbenchObjectHash(workbenchObjectHash(legacy)),legacy)
 assert.equal(workbenchObjectHash(legacy),'#teloa/v1/business/'+encodeURIComponent('安全运营')+'/overview')
 assert.throws(()=>workbenchObjectHash({base:{kind:'business',scope:'/Users/max/private',section:'overview'}}))
 const link=workbenchObjectLink('https://user:password@example.com/app?access_token=secret&code=grant#other',{base:{kind:'task',id:A}})
 assert.equal(link,'https://example.com/app'+hash('task'))
 for(const path of ['#teloa/v2/task/'+A,'#teloa/v1/task/title','#teloa/v1/task/'+A+'?start=true','#teloa/v1/resource/'+A+'/7/'+'b'.repeat(63),'#teloa/v1/task/'+A+'/detail/directory/tasks','#teloa/v1/business/私密业务正文/overview','#teloa/v1/task/'+A+'/extra'])assert.throws(()=>readWorkbenchObjectHash(path),path)
 for(const path of ['', '#teloa-main','#plugin/extension'])assert.equal(readWorkbenchObjectHash(path),undefined)
})

test('真实 store 的导航标记隔离目录同步、恢复与显式切换，目录地址不复活旧选择',()=>{
 const ui=createWorkbenchStore().create();ui.actions.openTask(A)
 const revision=ui.getSnapshot().objectNavigationRevision
 ui.actions.rememberDirectory('tasks',{query:'本人搜索词',scrollTop:88})
 ui.actions.reconcileDirectory('tasks',A,{open:false,target:null})
 ui.actions.retainDetailForSession(C);ui.actions.followConversation()
 assert.equal(ui.getSnapshot().objectNavigationRevision,revision)
 const local=captureWorkbenchNavigationState(ui.getSnapshot())
 const target=navigationForWorkbenchObject({base:{kind:'directory',view:'tasks'}},local)
 assert.equal(target.selected.taskId,undefined);assert.equal(target.directories.tasks?.selectedId,undefined)
 assert.equal(target.directories.tasks?.query,'本人搜索词');assert.equal(target.directories.tasks?.scrollTop,88)
 ui.actions.restoreObjectNavigation(target)
 assert.equal(ui.getSnapshot().objectNavigationRevision,revision)
 ui.actions.selectTask(B);assert.equal(ui.getSnapshot().objectNavigationRevision,revision+1)
})

test('A → B → Back → Forward 恢复各自查询、滚动与对象，不因同步增加历史',async()=>{
 const f=fixture();await tick()
 f.ui.actions.openTask(A);f.observe();await tick()
 f.ui.actions.rememberDirectory('tasks',{query:'A 的本地查询',scrollTop:120});f.observe()
 f.ui.actions.openTask(B);f.observe();await tick()
 f.ui.actions.rememberDirectory('tasks',{query:'B 的本地查询',scrollTop:360});f.observe()
 assert.equal(f.web.calls.filter(row=>row.kind==='push').length,2)
 f.web.history.back();await tick();f.observe();await tick()
 assert.equal(f.ui.getSnapshot().taskId,A);assert.equal(f.ui.getSnapshot().navigationDirectories.tasks?.query,'A 的本地查询');assert.equal(f.ui.getSnapshot().navigationDirectories.tasks?.scrollTop,120)
 f.web.history.forward();await tick();f.observe();await tick()
 assert.equal(f.ui.getSnapshot().taskId,B);assert.equal(f.ui.getSnapshot().navigationDirectories.tasks?.query,'B 的本地查询')
 assert.equal(f.web.calls.filter(row=>row.kind==='push').length,2)
 assert.equal(f.errors.length,0);f.adapter.dispose()
})

test('冷地址 A → Home → Back 必须重新恢复 A，不能命中离开前的事件去重缓存',async()=>{
 const f=fixture('http://localhost:3241/'+hash('conversation',A))
 await tick();f.observe();await tick()
 assert.equal(f.ui.getSnapshot().view,'messages')
 f.ui.actions.navigate('home');f.observe();await tick()
 assert.equal(f.web.location.hash,'#teloa/v1/directory/home')
 const reads=f.restored.length
 f.web.history.back();await tick();f.observe();await tick()
 assert.equal(f.web.location.hash,hash('conversation',A))
 assert.equal(f.ui.getSnapshot().view,'messages')
 assert.equal(f.restored.length,reads+1,'同一次 popstate/hashchange 只读一次，离开后返回仍须新读')
 f.web.history.forward();await tick();f.observe();await tick()
 assert.equal(f.ui.getSnapshot().view,'home')
 f.adapter.dispose()
})

test('角色抽屉有独立返回节点，Back 收起、Forward 重开并保留来源任务',async()=>{
 const f=fixture();await tick();f.ui.actions.openTask(A);f.observe();await tick()
 f.ui.actions.previewRole(B);f.observe();await tick()
 assert.equal(readWorkbenchObjectHash(f.web.location.hash)?.detail?.kind,'role-preview')
 f.web.history.back();await tick();f.observe();await tick()
 assert.equal(f.ui.getSnapshot().taskId,A);assert.equal(f.ui.getSnapshot().rolePreview,null)
 f.web.history.forward();await tick();f.observe();await tick()
 assert.equal(f.restored.at(-1)?.detail?.kind,'role-preview')
 assert.equal(f.ui.getSnapshot().rolePreview?.id,B);f.adapter.dispose()
})

test('旧根入口只 replace，外部锚点与原生 state 保留，第一次 Back 可以离站',async()=>{
 const f=fixture('http://localhost:3241/?native=1#teloa-main');await tick()
 assert.equal(f.web.history.length,1);assert.equal(f.web.location.hash,'#teloa-main')
 f.web.history.replaceState({native:{request:'kept'}},'')
 f.ui.actions.openTask(A);f.observe();await tick()
 assert.deepEqual((f.web.history.state as {native:unknown}).native,{request:'kept'})
 f.web.history.back();await tick();assert.equal(f.web.location.hash,'#teloa-main');assert.equal(f.web.history.length,2)
 f.adapter.dispose()
})

test('跨 owner/安装的本地筛选不可恢复，复制的对象仍经正常读取恢复',async()=>{
 const web=browser('http://localhost:3241/'+hash('task')),local=emptyWorkbenchNavigationState();local.directories.tasks={query:'另一本人隐私',scrollTop:900}
 web.history.replaceState({'teloa.object-history/v1':{scope:'old-owner',hash:web.location.hash,snapshot:JSON.stringify(local)}},'')
 let received:WorkbenchNavigationState|undefined,reads=0
 const adapter=attachWorkbenchObjectHistory({window:web.window,scope:'new-owner',capture:emptyWorkbenchNavigationState,describe:async()=>({base:{kind:'directory',view:'home'}}),restore:async(route,local)=>{reads++;assert.equal(route.base.kind,'task');received=local},error:error=>{throw error}})
 await tick();assert.equal(reads,1);assert.equal(received,undefined);adapter.dispose()
})

test('慢读取期间的新导航和卸载使旧响应失效；popstate/hashchange 不重复恢复',async()=>{
 const web=browser('http://localhost:3241/'+hash('task')),ui=createWorkbenchStore().create()
 let release=()=>{},reads=0,commits=0
 const adapter=attachWorkbenchObjectHistory({window:web.window,scope:'owner',capture:()=>captureWorkbenchNavigationState(ui.getSnapshot()),describe:async()=>describeWorkbenchObject(ui.getSnapshot(),{}),restore:async(_route,_local,current)=>{reads++;await new Promise<void>(resolve=>{release=resolve});if(current())commits++},error:error=>{throw error}})
 adapter.observe(0,undefined);ui.actions.openRole(B);adapter.observe(ui.getSnapshot().objectNavigationRevision,undefined);await tick();release();await tick()
 assert.equal(commits,0);assert.equal(web.location.hash,hash('role',B))
 web.history.back();assert.equal(reads,2);release();await tick();assert.equal(commits,1)
 adapter.dispose()
})

test('会话 loading 和目录轮询不创建节点，首次绑定只替换当前入口',async()=>{
 const web=browser(),ui=createWorkbenchStore().create();ui.actions.openMessages('native')
 let conversationId:string|undefined
 const adapter=attachWorkbenchObjectHistory({window:web.window,scope:'owner',capture:()=>captureWorkbenchNavigationState(ui.getSnapshot()),describe:async()=>describeWorkbenchObject(ui.getSnapshot(),{...(conversationId?{conversationId}:{})}),restore:async()=>{},error:error=>{throw error}})
 adapter.observe(1,undefined);await tick()
 conversationId=A;adapter.observe(1,A);await tick()
 assert.equal(web.location.hash,hash('conversation'));assert.equal(web.calls.filter(row=>row.kind==='push').length,0)
 conversationId=undefined;adapter.observe(1,undefined);await tick()
 conversationId=A;adapter.observe(1,A);await tick()
 assert.equal(web.calls.filter(row=>row.kind==='push').length,0)
 conversationId=B;adapter.observe(1,B);await tick();assert.equal(web.calls.filter(row=>row.kind==='push').length,1)
 adapter.dispose()
})

async function framePorts(ui=createWorkbenchStore().create(),window=browser().window,overrides:Record<string,unknown>={}){
 const file=ts.createSourceFile('WorkbenchFrame.tsx',await readFile(new URL('../src/client/WorkbenchFrame.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX)
 let callback:ts.Expression|undefined
 const visit=(node:ts.Node)=>{if(ts.isCallExpression(node)&&node.expression.getText(file)==='useEffect'&&node.arguments[0]?.getText(file).includes('attachWorkbenchObjectHistory('))callback=node.arguments[0];ts.forEachChild(node,visit)};visit(file)
 assert.ok(callback,'Frame 必须实际绑定启动、历史和正常 API 恢复')
 const pin={current:undefined as {id:string;version:number;sourceVersion:string}|undefined},restorePending={current:{tasks:true,team:true,market:true,spaces:true,plans:true}}
 const calls:string[]=[],resource={id:A,version:3,sourceVersion:'a'.repeat(64),status:'active'},project={id:A,scope:'business_'+B.replaceAll('-','')}
 let captured:Parameters<typeof attachWorkbenchObjectHistory>[0]|undefined
 const scope={builderState:{status:'ready',namespace:'owner-installation-A'},objectResourcePin:pin,objectHistory:{current:undefined},restorePending,window,
  previous:{current:undefined},captureWorkbenchNavigationState,describeWorkbenchObject,navigationForWorkbenchObject,latestState:{get current(){return ui.getSnapshot()}},actions:ui.actions,
  setObjectLink:()=>{},setObjectLinkCopied:()=>{},applicationPresentation:{getNavigationStorageScope:()=>undefined},setObjectUrlError:()=>{},localizeWorkError:(_locale:string,error:unknown)=>String(error),locale:'zh-CN',mainSession:{getSnapshot:()=>C},
  restoreWorkbenchConversation,deferNativeConversationNavigation:()=>()=>{},
  homePreparation:{current:undefined},conversationRestoration:{current:undefined},
  work:{getSnapshot:()=>({sessionId:C,status:'ready',conversation:{id:B,sessionId:C}}),refreshDirectory:async()=>{calls.push('conversations/list');return [{id:B,sessionId:C,status:'ready'}]},getDirectorySnapshot:()=>({status:'ready',rows:[{id:B,sessionId:C,status:'ready'}]}),openSessionResult:async(id:string,_signal:unknown,current:()=>boolean)=>{assert.equal(id,C);assert.equal(current(),true);calls.push('conversations/read-and-open');return 'opened'}},
  taskApi:{list:async()=>{calls.push('tasks/list');return [{id:A}]}},roleApi:{list:async()=>{calls.push('roles/list');return [{id:B}]}},
  resourceApi:{directory:async()=>{calls.push('resources/list');return {resources:[resource]}}},projectApi:{get:async(id:string)=>{calls.push('projects/get');assert.equal(id,A);return {project}}},businessScopeApi:{list:async()=>[{scope:project.scope}]},
  artifactApi:{get:async()=>({id:A,source:{kind:'task',id:A},versions:[{number:2}]})},mergeArtifacts:()=>{calls.push('artifacts/read')},
  attachWorkbenchObjectHistory:(ports:Parameters<typeof attachWorkbenchObjectHistory>[0])=>{captured=ports;return {observe:()=>{},dispose:()=>{}}},
  ...overrides,
 }
 const source=ts.transpileModule('const effect='+callback.getText(file),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText
 new Function(...Object.keys(scope),source+';effect()')(...Object.values(scope))
 assert.ok(captured);return {ports:captured,ui,pin,calls,resource,project,restorePending}
}

function connectedRestore(readById?:(id:string,signal?:AbortSignal)=>Promise<Conversation>){
 let selected:string|undefined=A,reads=0,opens=0,adopts=0
 const listeners=new Set<()=>void>(),mainSession={getSnapshot:()=>selected,subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>listeners.delete(listener)}}
 const choose=(id:string)=>{selected=id;for(const listener of listeners)listener()}
 const row=(sessionId:string):Conversation=>({id:sessionId===C?B:A,sessionId,requestedSessionId:sessionId,status:'ready',ownerId:'owner',title:'原会话',scopeIds:['general'],version:1,createdAt:'2026-10-31T00:00:00Z'})
 const control={list:async()=>[row(C)],read:async()=>row(C),open:(_id:string)=>{}}
 const work=new BindingClient({...(readById?{readById}:{}),list:()=>control.list(),read:async()=>{reads++;return control.read()},ensure:async id=>row(id),isNativeChild:()=>false,catalog:async()=>{throw Error('恢复不能读取执行目录')},block:()=>{},create:async()=>{throw Error('恢复不能创建会话')},adopt:async id=>{adopts++;return id},open:id=>{opens++;control.open(id)},current:mainSession.getSnapshot})
 return {mainSession,choose,work,control,counts:()=>({reads,opens,adopts}),listeners:()=>listeners.size}
}

test('真实 Frame 恢复等待原生选中回填，不能把 opened 派发回执当作同步完成',async()=>{
 const native=connectedRestore();await native.work.select(A)
 const homePreparation={current:new AbortController()},conversationRestoration={current:undefined as (()=>boolean)|undefined}
 const f=await framePorts(undefined,undefined,{work:native.work,mainSession:native.mainSession,homePreparation,conversationRestoration})
 const restoring=f.ports.restore({base:{kind:'conversation',id:B}},undefined,()=>true)
 await tick();assert.equal(native.counts().opens,1);assert.equal(f.ui.getSnapshot().view,'home')
 assert.equal(homePreparation.current.signal.aborted,true);assert.equal(conversationRestoration.current?.(),true)
 native.choose(C);await native.work.select(C);await restoring
 assert.equal(f.ui.getSnapshot().view,'messages');assert.equal(native.work.getSnapshot().conversation?.id,B)
 assert.equal(conversationRestoration.current,undefined)
 assert.deepEqual(native.counts(),{reads:1,opens:1,adopts:1})
})

test('原生连接默认会话在读取期间回填，只恢复原链接目标，不改投默认会话',async()=>{
 const native=connectedRestore();await native.work.select(A)
 let release=()=>{},first=true
 const ready=new Promise<void>(resolve=>{release=resolve}),read=native.control.read
 native.control.read=async()=>{if(first){first=false;await ready}return read()}
 native.control.open=id=>native.choose(id)
 const f=await framePorts(undefined,undefined,{work:native.work,mainSession:native.mainSession})
 const restoring=f.ports.restore({base:{kind:'conversation',id:B}},undefined,()=>true)
 await tick();native.choose(B);await native.work.select(B);release();await restoring
 assert.equal(native.mainSession.getSnapshot(),C);assert.equal(f.ui.getSnapshot().view,'messages')
 assert.deepEqual(native.counts(),{reads:2,opens:1,adopts:1})
})

test('正常 CID 读取独立于并发目录订阅刷新，目录仍在加载时原历史目标也可恢复',async()=>{
 let releaseTarget=()=>{},releaseWatch=()=>{}
 const target=new Promise<void>(resolve=>{releaseTarget=resolve}),watch=new Promise<void>(resolve=>{releaseWatch=resolve})
 let targetRow!:Conversation
 const native=connectedRestore(async id=>{assert.equal(id,B);await target;return targetRow});await native.work.select(A)
 targetRow=await native.control.read()
 const list=native.control.list;native.control.list=async()=>{await watch;return list()}
 native.control.open=id=>native.choose(id)
 const f=await framePorts(undefined,undefined,{work:native.work,mainSession:native.mainSession})
 const restoring=f.ports.restore({base:{kind:'conversation',id:B}},undefined,()=>true)
 await tick()
 const subscription=native.work.refreshDirectory();releaseTarget()
 try{await restoring;assert.equal(native.mainSession.getSnapshot(),C);assert.equal(f.ui.getSnapshot().view,'messages');assert.equal(native.work.getDirectorySnapshot().status,'loading')}
 finally{releaseWatch();await subscription}
})

test('真实 Frame 与导航租约跨过连接就绪、迟到读取和选中回填，默认 null 面板不抢地址',async()=>{
 const ui=await initialFrameStore(hash('conversation',B)),web=browser('http://localhost:3241/'+hash('conversation',B)),native=connectedRestore()
 await native.work.select(A)
 const layout=createWorkbenchLayout(ui.actions,()=>false,createSettingsNavigation(),{getSnapshot:()=>ui.getSnapshot().panelInfo,subscribe:ui.subscribe})
 let release=()=>{},first=true
 const ready=new Promise<void>(resolve=>{release=resolve}),read=native.control.read
 native.control.read=async()=>{if(first){first=false;await ready}return read()}
 native.control.open=id=>{native.choose(id);layout.selectPanel(null)}
 const f=await framePorts(ui,web.window,{work:native.work,mainSession:native.mainSession,deferNativeConversationNavigation:layout.deferNativeConversationNavigation})
 const adapter=attachWorkbenchObjectHistory(f.ports),observe=()=>adapter.observe(ui.getSnapshot().objectNavigationRevision,native.work.getSnapshot().conversation?.id)
 const off=[ui.subscribe(observe),native.work.subscribe(observe),native.mainSession.subscribe(observe)]
 observe();await tick();layout.selectPanel(null)
 assert.equal(ui.getSnapshot().objectNavigationRevision,0)
 native.choose(B);await native.work.select(B);release();await tick();await tick()
 assert.equal(web.location.hash,hash('conversation',B));assert.equal(native.mainSession.getSnapshot(),C)
 assert.deepEqual(native.counts(),{reads:2,opens:1,adopts:1})
 ui.actions.navigate('resources');await tick();assert.equal(web.location.hash,'#teloa/v1/directory/resources')
 for(const dispose of off)dispose();adapter.dispose();layout.dispose()
})

test('等待原生选中时本人新导航取消旧恢复，迟到回填不重开旧地址或遗留订阅',async()=>{
 const native=connectedRestore();await native.work.select(A)
 const f=await framePorts(undefined,undefined,{work:native.work,mainSession:native.mainSession}),controller=new AbortController()
 let current=true
 const restoring=f.ports.restore({base:{kind:'conversation',id:B}},undefined,()=>current,controller.signal)
 await tick();assert.equal(native.counts().opens,1)
 current=false;controller.abort();f.ui.actions.openTask(A);await restoring
 native.choose(C);await tick()
 assert.equal(f.ui.getSnapshot().view,'tasks');assert.equal(f.ui.getSnapshot().taskId,A)
 assert.equal(native.counts().opens,1);assert.equal(native.listeners(),0)
})

test('读取迟迟不回时新导航立即结束旧恢复，回包后来到也不能领养或打开',async()=>{
 const native=connectedRestore();await native.work.select(A)
 let release=()=>{}
 const read=native.control.read
 native.control.read=()=>new Promise(resolve=>{release=()=>{void read().then(resolve)}})
 const f=await framePorts(undefined,undefined,{work:native.work,mainSession:native.mainSession}),controller=new AbortController()
 let current=true
 const restoring=f.ports.restore({base:{kind:'conversation',id:B}},undefined,()=>current,controller.signal)
 await tick();current=false;controller.abort();await restoring
 assert.deepEqual(native.counts(),{reads:1,opens:0,adopts:0});assert.equal(native.listeners(),0)
 release();await tick();assert.equal(native.counts().opens,0)
})

test('目标读取失败保留原地址与重试意图，后台默认绑定不能换成另一会话',async()=>{
 const web=browser('http://localhost:3241/'+hash('conversation',B)),ui=await initialFrameStore(hash('conversation',B)),errors:unknown[]=[]
 let failed=true,aborted=false
 const adapter=attachWorkbenchObjectHistory({window:web.window,scope:'owner',capture:()=>captureWorkbenchNavigationState(ui.getSnapshot()),describe:async()=>describeWorkbenchObject(ui.getSnapshot(),{conversationId:C}),restore:async(_route,_local,_current,signal)=>{signal?.addEventListener('abort',()=>{aborted=true});if(failed)throw Error('读取失败')},error:error=>errors.push(error)})
 adapter.observe(0,undefined);await tick();adapter.observe(0,C);await tick()
 assert.equal(web.location.hash,hash('conversation',B));assert.equal(errors.length,1)
 failed=false;adapter.retry();await tick();assert.equal(aborted,true)
 ui.actions.navigate('resources');adapter.observe(ui.getSnapshot().objectNavigationRevision,C);await tick()
 assert.equal(web.location.hash,'#teloa/v1/directory/resources');adapter.dispose()
})

test('Frame 真回调经原 API 恢复 Task、Role、Project、Business 和绑定 Conversation，不能同名回退或执行',async()=>{
 const f=await framePorts(),current=()=>true
 await f.ports.restore({base:{kind:'task',id:A}},undefined,current);assert.equal(f.ui.getSnapshot().taskId,A)
 await assert.rejects(f.ports.restore({base:{kind:'task',id:C}},undefined,current),{code:'teloa/source-unavailable'})
 await f.ports.restore({base:{kind:'role',id:B}},undefined,current);assert.equal(f.ui.getSnapshot().roleId,B)
 await f.ports.restore({base:{kind:'project',id:A}},undefined,current);assert.equal(f.ui.getSnapshot().businessTarget.id,A);assert.equal(f.ui.getSnapshot().businessTarget.scope,f.project.scope)
 await f.ports.restore({base:{kind:'business',scope:f.project.scope,section:'overview'}},undefined,current);assert.equal(f.ui.getSnapshot().businessTarget.section,'overview')
 f.project.scope='安全运营'
 await f.ports.restore({base:{kind:'business',scope:f.project.scope,section:'overview'}},undefined,current);assert.equal(f.ui.getSnapshot().businessTarget.scope,'安全运营')
 await f.ports.restore({base:{kind:'conversation',id:B},detail:{kind:'role',id:B}},undefined,current)
 assert.deepEqual(f.ui.getSnapshot().detail,{open:true,target:{kind:'conversation-object',sessionId:C,objectKind:'role',id:B}})
 assert.ok(f.calls.includes('conversations/read-and-open'));assert.equal(f.ui.getSnapshot().objectNavigationRevision,0)
 assert.deepEqual(f.restorePending.current,{tasks:false,team:false,market:false,spaces:false,plans:false})
})

test('Frame 真回调固定资料/成果版本；撤回、版本变化与迟到响应不会打开最新对象',async()=>{
 const f=await framePorts(),route:Route={base:{kind:'resource',id:A,version:3,sourceVersion:'a'.repeat(64)}}
 await f.ports.restore(route,undefined,()=>true);assert.deepEqual(f.pin.current,{id:A,version:3,sourceVersion:'a'.repeat(64)})
 const request=f.ui.getSnapshot().resourceTarget?.request
 f.resource.version=4
 await assert.rejects(f.ports.restore(route,undefined,()=>true),{code:'teloa/version-conflict'})
 assert.equal(f.ui.getSnapshot().resourceTarget?.request,request)
 f.resource.version=3;f.resource.status='withdrawn'
 await assert.rejects(f.ports.restore(route,undefined,()=>true),{code:'teloa/source-unavailable'})
 await f.ports.restore({base:{kind:'task',id:A}},undefined,()=>false)
 assert.equal(f.ui.getSnapshot().resourceTarget?.request,request)
 await f.ports.restore({base:{kind:'directory',view:'resources'},detail:{kind:'artifact',id:A,version:2}},undefined,()=>true)
 assert.equal(f.ui.getSnapshot().detail.target?.kind,'artifact')
 await assert.rejects(f.ports.restore({base:{kind:'directory',view:'resources'},detail:{kind:'artifact',id:A,version:3}},undefined,()=>true),{code:'teloa/version-conflict'})
})

test('Frame 资料端口在普通选择后也固定版本；本人显式修订后更新地址，旧身份写回不改新位置',async()=>{
 const file=ts.createSourceFile('WorkbenchFrame.tsx',await readFile(new URL('../src/client/WorkbenchFrame.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX)
 let memo:ts.Expression|undefined
 const visit=(node:ts.Node)=>{if(ts.isVariableDeclaration(node)&&node.name.getText(file)==='objectResourceApi'&&node.initializer&&ts.isCallExpression(node.initializer))memo=node.initializer.arguments[0];ts.forEachChild(node,visit)};visit(file);assert.ok(memo)
 const row={id:A,version:3,sourceVersion:'a'.repeat(64),status:'active'},pin={current:{id:A,version:3,sourceVersion:row.sourceVersion} as {id:string;version:number;sourceVersion:string}|undefined},identity={current:{}},ui=createWorkbenchStore().create()
 let release=()=>{},contentReads=0
 const api={directory:async()=>({resources:[row]}),readContent:async(resource:typeof row,_signal:AbortSignal)=>{contentReads++;return {resource,text:'same pinned body'}},reviseKnowledgeResource:async()=>{await new Promise<void>(resolve=>{release=resolve});row.version++;return row}}
 const scope={resourceApi:api,objectResourcePin:pin,resourceWriteCurrent:identity,latestState:{get current(){return ui.getSnapshot()}},actions:ui.actions}
 const source=ts.transpileModule('const factory='+memo.getText(file),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText
 const port=new Function(...Object.keys(scope),source+';return factory()')(...Object.values(scope)) as typeof api
 await port.directory();row.version=4
 await assert.rejects(port.directory(),{code:'teloa/version-conflict'})
 await assert.rejects(port.readContent(row,new AbortController().signal),{code:'teloa/version-conflict'});assert.equal(contentReads,0)
 row.version=3
 const changed=port.reviseKnowledgeResource();release();await changed
 assert.equal(pin.current,undefined);assert.equal(ui.getSnapshot().objectNavigationRevision,1)
 pin.current={id:A,version:4,sourceVersion:row.sourceVersion}
 const late=port.reviseKnowledgeResource();identity.current={};release();await late
 assert.equal(pin.current.version,4);assert.equal(ui.getSnapshot().objectNavigationRevision,1)
})

test('连续查询与后台快照不重写浏览器历史，刷新前保留最终本地位置',async()=>{
 const f=fixture();await tick();f.ui.actions.openTask(A);f.observe();await tick()
 const writes=f.web.calls.length
 for(let index=0;index<200;index++){f.ui.actions.rememberDirectory('tasks',{query:'本地关键词'+index,scrollTop:index});f.observe()}
 assert.equal(f.web.calls.length,writes);assert.equal(f.web.location.hash,hash('task'))
 f.web.pagehide()
 const entry=(f.web.history.state as Record<string,{snapshot:string}>)['teloa.object-history/v1']!
 assert.equal((JSON.parse(entry.snapshot) as WorkbenchNavigationState).directories.tasks?.query,'本地关键词199')
 f.adapter.dispose()
})

test('Frame 的复制入口使用重新生成的目标，认证 query 不进入剪贴板',async()=>{
 const file=ts.createSourceFile('WorkbenchFrame.tsx',await readFile(new URL('../src/client/WorkbenchFrame.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX)
 let callback:ts.Expression|undefined
 const visit=(node:ts.Node)=>{if(ts.isVariableDeclaration(node)&&node.name.getText(file)==='copyObjectLink')callback=node.initializer;ts.forEachChild(node,visit)};visit(file);assert.ok(callback)
 let copied='',feedback=false
 const scope={objectLink:{base:{kind:'task',id:A}},workbenchObjectHash,workbenchObjectLink,window:{location:{href:'https://example.test/app?access_token=secret&code=grant'+hash('task'),hash:hash('task')}},latestState:{current:{objectNavigationRevision:2}},navigator:{clipboard:{writeText:async(text:string)=>{copied=text}}},setObjectLinkCopied:(value:boolean)=>{feedback=value},setObjectUrlError:()=>{},localizeWorkError:()=>'',locale:'zh-CN'}
 const source=ts.transpileModule('const copy='+callback.getText(file),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText
 new Function(...Object.keys(scope),source+';copy()')(...Object.values(scope));await tick()
 assert.equal(copied,'https://example.test/app'+hash('task'));assert.equal(feedback,true)
})


function historicalCIDRestore(){
 const sid='task-run-historical',history:Conversation={id:B,sessionId:sid,requestedSessionId:sid,status:'ready',ownerId:'owner',title:'本人原失败运行',scopeIds:['general'],version:1,createdAt:'2026-10-31T00:00:00Z',purpose:'task-run',run:{taskId:A,taskVersion:2,roleId:C,roleVersion:1,agentPresetId:'teloa-standard'}}
 const baseline:Conversation={id:A,sessionId:'default',requestedSessionId:'default',status:'ready',ownerId:'owner',title:'原输入面',scopeIds:['general'],version:1,createdAt:history.createdAt}
 let selected='default';const listeners=new Set<()=>void>(),counts={cid:0,list:0,normalRead:0,nativeRead:0,open:0,create:0,ensure:0,adopt:0}
 const mainSession={getSnapshot:()=>selected,subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>listeners.delete(listener)}}
 const controls={byId:async()=>history,normalRead:async()=>history},blocks=new Map<string,string|undefined>()
 const openListCounts:number[]=[]
 const work=new BindingClient({list:async()=>{counts.list++;return []},readById:async id=>{counts.cid++;assert.equal(id,B);return controls.byId()},read:async id=>{counts.normalRead++;assert.equal(id,sid);return controls.normalRead()},selectBinding:async()=>baseline,readRunSession:async id=>{counts.nativeRead++;assert.equal(id,sid);return id},ensure:async()=>{counts.ensure++;throw Error('恢复不能 ensure')},isNativeChild:()=>false,catalog:async()=>{throw Error('恢复不能加载执行工具目录')},block:(id,value)=>{blocks.set(id,value)},create:async()=>{counts.create++;throw Error('恢复不能 create')},adopt:async()=>{counts.adopt++;throw Error('历史运行不能 adopt')},open:id=>{openListCounts.push(counts.list);counts.open++;selected=id;for(const listener of listeners)listener()},current:mainSession.getSnapshot})
 return {history,work,mainSession,controls,counts,blocks,listeners,openListCounts}
}

test('合法历史 CID 不在最新目录仍沿正常 SID/运行读取恢复，不 create ensure adopt',async()=>{
 const f=historicalCIDRestore();await f.work.select('default')
 assert.equal(await restoreWorkbenchConversation(f.work,f.mainSession,B,()=>true),f.history.sessionId)
 assert.deepEqual(f.openListCounts,[0],'首次目标打开不依赖最新目录')
 assert.deepEqual(f.counts,{cid:1,list:1,normalRead:1,nativeRead:1,open:1,create:0,ensure:0,adopt:0}) // 原打开成功后正常刷新目录一次。
 assert.equal(f.work.getSnapshot().conversation?.id,B);assert.match(f.blocks.get(f.history.sessionId)??'',/任务执行编排/)
 assert.equal(f.listeners.size,0)
})

test('CID 定位不得代替正常运行授权，也不采用其他本人、错误 CID 或 pending 回包',async()=>{
 for(const kind of ['owner','cid','pending','run-authority','run-binding']){
  const f=historicalCIDRestore();await f.work.select('default')
  if(kind==='run-authority')f.controls.normalRead=async()=>{throw Object.assign(Error('原运行读取被正常授权拒绝'),{code:'teloa/forbidden'})}
  else if(kind==='run-binding')f.controls.normalRead=async()=>({...f.history,id:C})
  else f.controls.byId=async()=>({...f.history,...(kind==='owner'?{ownerId:'other-owner'}:kind==='cid'?{id:C}:{status:'pending' as const})})
  await assert.rejects(restoreWorkbenchConversation(f.work,f.mainSession,B,()=>true))
  assert.equal(f.counts.open,0);assert.equal(f.counts.nativeRead,0);assert.equal(f.counts.list,0);assert.equal(f.counts.create+f.counts.ensure+f.counts.adopt,0)
  assert.equal(f.mainSession.getSnapshot(),'default')
 }
})

test('历史 CID 本人读取迟到遇新导航取消时，不打开旧 SID 或改写当前上下文',async()=>{
 const f=historicalCIDRestore();await f.work.select('default')
 let release!:(row:Conversation)=>void;f.controls.byId=()=>new Promise(resolve=>{release=resolve})
 const controller=new AbortController();let current=true
 const restoring=restoreWorkbenchConversation(f.work,f.mainSession,B,()=>current,controller.signal)
 await tick();current=false;controller.abort();await restoring;release(f.history);await tick()
 assert.equal(f.counts.open,0);assert.equal(f.counts.normalRead,0);assert.equal(f.counts.nativeRead,0);assert.equal(f.counts.list,0)
 assert.equal(f.work.getSnapshot().sessionId,'default');assert.equal(f.mainSession.getSnapshot(),'default');assert.equal(f.listeners.size,0)
})

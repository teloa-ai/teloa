import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import ts from 'typescript'
import {BindingClient,type WorkPort} from '../src/client/binding-client.ts'
import {openTaskNativeApproval} from '../src/client/task-attention-state.ts'
import {openAttentionItem} from '../src/client/attention-item.ts'
import {homeCreationLocation} from '../src/client/home-creation-navigation.ts'

function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:Error)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject}}
const flush=()=>new Promise(resolve=>setImmediate(resolve)),noop=()=>{}
const target={kind:'native-approval' as const,taskId:'task',runId:'run',sessionId:'run-session'},item={id:'native-approval:run',kind:'approval' as const,source:'task' as const,persistence:'saved' as const,target,title:'原任务审批',reason:{kind:'text' as const,text:'待决定'},scope:'general',occurredAt:'2026-10-30T00:00:00.000Z'}
const source=readFileSync(new URL('../src/client/WorkbenchFrame.tsx',import.meta.url),'utf8'),ast=ts.createSourceFile('frame.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX)
let initializer:ts.Expression|undefined
function visit(node:ts.Node){if(ts.isVariableDeclaration(node)&&node.name.getText(ast)==='openAttention')initializer=node.initializer;ts.forEachChild(node,visit)}visit(ast);assert.ok(initializer)
const code=ts.transpileModule('const openAttention='+initializer.getText(ast),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText

function fixture({holdDirectory=false,secondDirectoryReady=false,holdNative=false,heldNativeSession=target.sessionId,delayedMain=false}={}){
 const directory=deferred<any>(),native=deferred<string>(),entered=deferred<void>(),opened:string[]=[],navigated:string[]=[],errors:string[]=[],refreshed:string[]=[]
 let main='original-session'
 const page={items:[target,{taskId:'task-b',runId:'run-b',sessionId:'run-b-session'}].map(target=>({task:{id:target.taskId,state:'running'},attention:null,nativeApproval:{runId:target.runId,sessionId:target.sessionId}}))}
 let reads=0
 const identity={},latestAttentionIdentity={current:identity},latestState={current:{view:'tasks',messageMode:'native',taskId:'task'}},taskApi={attention:()=>holdDirectory&&(!secondDirectoryReady||reads++===0)?directory.promise:Promise.resolve(page)},taskLoadApi={current:taskApi}
 const port:WorkPort={isNativeChild:()=>false,list:async()=>[],read:async id=>({id:'binding-'+id,ownerId:'owner',title:'工作',scopeIds:['general'],version:1,status:'ready',purpose:'task-run',sessionId:id,requestedSessionId:id,createdAt:'2026-10-30T00:00:00.000Z'}),readRunSession:async id=>{if(id===heldNativeSession&&holdNative){entered.resolve();return native.promise}return id},ensure:async()=>{throw Error('不能领养')},catalog:async()=>{throw Error('不能请求模型目录')},create:async()=>{throw Error('不能创建')},adopt:async()=>{throw Error('不能领养')},block:noop,current:()=>main,open:id=>{opened.push(id);if(!delayedMain){main=id;latestState.current={...latestState.current,view:'messages'}}}}
 const work=new BindingClient(port),actions={navigate:(view:string)=>{navigated.push(view);latestState.current={...latestState.current,view}},openMarket:noop,openPlans:noop,openBinding:noop,openInstallations:noop}
 const env={openAttentionItem,openTaskNativeApproval,homeCreationLocation,taskApi,attentionIdentity:identity,taskLoadApi,latestAttentionIdentity,nativeApprovalNavigationIntent:{current:0},latestState,mainSession:{getSnapshot:()=>main},work,actions,loadTasks:async(current?:()=>boolean)=>{if(current?.()!==false)refreshed.push('loaded')},locale:'zh-CN',localizeWorkError:(_locale:unknown,error:Error)=>error.message,setTaskLoadError:(error:string)=>errors.push(error),openAttentionTask:noop,enterBusiness:noop}
 const open=new Function(...Object.keys(env),code+'\nreturn openAttention;')(...Object.values(env)) as (item:unknown)=>void
 const completeDirectory=()=>directory.resolve(page)
 return {open:(next=item)=>open(next),work,opened,navigated,errors,refreshed,entered,native,directory,completeDirectory,changeConnection:()=>{latestAttentionIdentity.current={}},changeLocation:()=>{latestState.current={...latestState.current,view:'team'}}}
}

test('真实 Frame 在原目录重核后换连接，迟到原生绑定不得打开旧审批',async()=>{
 const f=fixture({holdNative:true});f.open();await f.entered.promise;f.changeConnection();f.native.resolve(target.sessionId);await flush();await flush()
 assert.deepEqual(f.opened,[]);assert.deepEqual(f.navigated,[]);assert.deepEqual(f.refreshed,[])
})

test('真实 Frame 目录重核等待时另一导航完成，不重新打开原审批',async()=>{
 const f=fixture({holdDirectory:true});f.open();await f.work.openSessionResult('new-session');f.completeDirectory();await flush();await flush()
 assert.deepEqual(f.opened,['new-session']);assert.deepEqual(f.navigated,[]);assert.deepEqual(f.refreshed,[])
})

test('真实 BindingClient 取消原打开的回执不能被当成 opened 再导航',async()=>{
 const f=fixture({holdNative:true});f.open();await f.entered.promise;await f.work.openSessionResult('new-session');f.native.resolve(target.sessionId);await flush();await flush()
 assert.deepEqual(f.opened,['new-session']);assert.deepEqual(f.navigated,[]);assert.deepEqual(f.refreshed,[])
})

test('旧连接的迟到读取错误不污染当前目录，原页面离开也不跳转',async()=>{
 const failed=fixture({holdDirectory:true});failed.open();failed.changeConnection();failed.directory.reject(Error('旧连接错误'));await flush();await flush();assert.deepEqual(failed.errors,[])
 const moved=fixture({holdDirectory:true});moved.open();moved.changeLocation();moved.completeDirectory();await flush();await flush();assert.deepEqual(moved.opened,[]);assert.deepEqual(moved.navigated,[])
})

test('真实 opened 回执在主会话投影迟到时仍可进入本次审批',async()=>{
 const f=fixture({delayedMain:true});f.open();await flush();await flush()
 assert.deepEqual(f.opened,[target.sessionId]);assert.deepEqual(f.navigated,['messages']);assert.deepEqual(f.refreshed,['loaded'])
})

test('A目录迟答不能取消较新B仍在途的原生打开，同页同主会话按最新点击归属',async()=>{
 const f=fixture({holdDirectory:true,secondDirectoryReady:true,holdNative:true,heldNativeSession:'run-b-session'})
 f.open();f.open({...item,id:'native-approval:run-b',target:{kind:'native-approval',taskId:'task-b',runId:'run-b',sessionId:'run-b-session'}})
 await f.entered.promise
 f.completeDirectory();await flush();await flush()
 assert.deepEqual(f.opened,[],'较新B仍在读原生绑定时，旧A不得先打开并取消B')
 f.native.resolve('run-b-session');await flush();await flush()
 assert.deepEqual(f.opened,['run-b-session']);assert.deepEqual(f.navigated,['messages']);assert.deepEqual(f.refreshed,['loaded'])
})

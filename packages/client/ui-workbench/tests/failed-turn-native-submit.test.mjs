import test from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {dirname,join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import {webcrypto} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import ts from 'typescript'
import {createSessionContinuation} from '../src/client/session-continuation.ts'
import {latestRetryableRequest} from '../src/client/failed-turn-continuation.ts'
const require=createRequire(import.meta.url),root=dirname(require.resolve('@deepseek-ai/dsh-api-session-controller/package.json'))
// 真实固定SDK对象层；唯一替身为无网络Remote传输，不等于宿主/模型实测。
const {Session}=await import(pathToFileURL(join(root,'lib/types/client/sessions/session.js')).href)
test('固定SDK正常beginSubmission/prompt生成全新requestId且原文与queue不变，未重用旧RPC',async()=>{
 const calls=[],sid='11111111-1111-4111-8111-111111111111',oldRpc='22222222-2222-4222-8222-222222222222',text=' 原问题\n原文 '
 const session=new Session(sid,{session:{prompt:async(request)=>{calls.push(request);return {ok:true,value:{accepted:true}}}}})
 const submission=session.beginSubmission({text,attachments:[],mode:'queue'})
 assert.notEqual(submission.requestId,oldRpc)
 const result=await session.prompt([{type:'text',text}],'queue',undefined,submission.requestId)
 assert.equal(result.ok,true);assert.equal(calls.length,1);assert.equal(calls[0].sessionId,sid);assert.equal(calls[0].requestId,submission.requestId);assert.deepEqual(calls[0].content,[{type:'text',text}]);assert.equal(calls[0].mode,'queue')
})
// 通过 TypeScript AST 取得当前生产装配，不依赖旧发送入口的文案或缩进边界。
const source=readFileSync(new URL('../src/client/index.ts',import.meta.url),'utf8')
const file=ts.createSourceFile('index.ts',source,ts.ScriptTarget.Latest,true),factories=[]
const visit=node=>{if(ts.isCallExpression(node)&&ts.isIdentifier(node.expression)&&node.expression.text==='createSessionContinuation')factories.push(node);ts.forEachChild(node,visit)}
visit(file);assert.equal(factories.length,1)
const compiled=ts.transpileModule(`function mountActual(child,sessionId,monitor,work,businessBuilder,mainSession,connection,call){const binding=child.sessions.binding(sessionId);let previousOwner,identity={};return ${factories[0].getText(file)}}`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText
const mountActual=new Function('createSessionContinuation','brandString',compiled+';return mountActual')(createSessionContinuation,value=>value)
const tick=()=>new Promise(resolve=>setImmediate(resolve))
function continuationFixture(){
 const sid='11111111-1111-4111-8111-111111111111',prefix='a'.repeat(64),original=Object.freeze({taskId:'original-task',runId:'original-run',sessionId:sid,ownerRequestId:'original-request'})
 const store=value=>({value,listeners:new Set(),getSnapshot(){return this.value},subscribe(listener){this.listeners.add(listener);return()=>this.listeners.delete(listener)}})
 const session=store({running:false,pendingSubmissions:[]}),binding={session,eventSource:store([])},monitor=store(false),work=store({...original,status:'ready'}),business=store({namespace:'owned'}),main=store(sid),connection={state:store('connected')},blocks=store(false)
 const draft={text:'本人尚未提交的草稿',attachmentIds:['owned-file'],occurrences:[{kind:'reference'}]},calls=[]
 let available=true,resume=async()=>{available=false;return {sessionId:sid,accepted:true}}
 const call=async(endpoint,payload)=>{calls.push({endpoint,payload:structuredClone(payload)});if(endpoint==='session-continuations/inspect')return {sessionId:sid,available,...available?{prefixSha256:prefix}:{}};assert.equal(endpoint,'session-continuations/resume','继续不得创建Task/Run或重发本人prompt');assert.deepEqual(payload,{sessionId:sid,prefixSha256:prefix});return resume()}
 const child={sessions:{binding:id=>id===sid?binding:undefined},conversation:{blocks:{storeFor:()=>blocks}}}
 const port=mountActual(child,sid,monitor,work,business,main,connection,call),off=port.subscribe(()=>{})
 return {sid,prefix,original,draft,calls,port,off,session,monitor,work,main,connection,blocks,setResume:value=>{resume=value},hold:()=>{available=false}}
}
test('实际index继续接线复用原Task/Run/SID票据，重复点击只恢复一次且不重发旧题或修改原稿',async()=>{
 const f=continuationFixture();try{
  await tick();assert.equal(f.port.getSnapshot().available,true)
  let finish;f.setResume(()=>new Promise(resolve=>{finish=resolve}))
  const draft=structuredClone(f.draft),selected=structuredClone(f.work.value),first=f.port.continue()
  await assert.rejects(f.port.continue());assert.equal(f.calls.filter(c=>c.endpoint.endsWith('/resume')).length,1)
  f.hold();finish({sessionId:f.sid,accepted:true});await first;await tick()
  assert.equal(f.port.getSnapshot().available,false);assert.deepEqual(f.draft,draft);assert.deepEqual(f.work.value,selected)
  assert.deepEqual(f.calls.filter(c=>c.endpoint.endsWith('/resume')),[{endpoint:'session-continuations/resume',payload:{sessionId:f.sid,prefixSha256:f.prefix}}])
  assert.ok(f.calls.every(c=>!('text'in c.payload)&&!('requestId'in c.payload)))
 }finally{f.off()}
})
test('实际index继续接线遵守当前会话/就绪/运行/待提交/阻塞与宿主held，失败不自动重发',async()=>{
 for(const change of [f=>{f.main.value='other'},f=>{f.connection.state.value='disconnected'},f=>{f.session.value.running=true},f=>{f.monitor.value=true},f=>{f.blocks.value=true},f=>f.hold()]){
  const f=continuationFixture();try{change(f);await tick();assert.equal(f.port.getSnapshot().available,false);await assert.rejects(f.port.continue());assert.equal(f.calls.filter(c=>c.endpoint.endsWith('/resume')).length,0)}finally{f.off()}
 }
 const f=continuationFixture();try{
  await tick();f.setResume(async()=>{throw Error('response lost')});await assert.rejects(f.port.continue());await tick()
  assert.equal(f.port.getSnapshot().error,true);assert.equal(f.calls.filter(c=>c.endpoint.endsWith('/resume')).length,1)
  f.setResume(async()=>({sessionId:'foreign',accepted:true}));await assert.rejects(f.port.continue());await tick()
  assert.equal(f.port.getSnapshot().error,true);assert.ok(f.calls.filter(c=>c.endpoint.endsWith('/resume')).every(c=>c.payload.sessionId===f.sid&&c.payload.prefixSha256===f.prefix))
 }finally{f.off()}
})

// 只在测试VM额外暴露包私有构造器；原bundle中的InputShell、Lexical与SubmitMachine代码不改。
// 不渲染的UI primitives为空，其他依赖为实际安装值；末端sink仅记录文本，不调用宿主/模型。
async function nativeInputShell(defaultSink){
 const packageRoot=dirname(require.resolve('@deepseek-ai/dsh-client-ui-conversation/package.json')),pkg=JSON.parse(readFileSync(join(packageRoot,'package.json'),'utf8'))
 assert.equal(pkg.version,'0.2.1-rc.2')
 const deps={'@deepseek-ai/dsh-client-ui-primitives':{}}
 for(const name of ['@deepseek-ai/dsh-client-store','@deepseek-ai/dsh-client-ui-slots','@deepseek-ai/cordis'])deps[name]=await import(pathToFileURL(require.resolve(name)).href)
 for(const name of ['react/jsx-runtime','react','react-dom'])deps[name]=require(name)
 let zodPath
 try{zodPath=require.resolve('zod')}catch{
  // pnpm未把SDK开发依赖提升到应用根；按该固定SDK声明的精确版本复用已装依赖，不下载。
  const workspace=fileURLToPath(new URL('../../../../',import.meta.url)),version=pkg.devDependencies.zod
  assert.match(version,/^\d+\.\d+\.\d+$/)
  zodPath=join(workspace,'node_modules/.pnpm','zod@'+version,'node_modules/zod/index.js')
 }
 deps.zod=await import(pathToFileURL(zodPath).href)
 const published=readFileSync(join(packageRoot,'lib/client.js'),'utf8'),anchor='exports.Config = Config;'
 assert.equal(published.split(anchor).length,2)
 const code=published.replace(anchor,'exports.__testSessionInputShell = SessionInputShell;\n'+anchor)
 let loaded
 vm.runInNewContext(code,{window:{__ModuleLoader__:{load:descriptor=>{assert.equal(descriptor.id,'@deepseek-ai/dsh-client-ui-conversation');loaded=descriptor.factory(name=>{assert.ok(name in deps,'unexpected import '+name);return deps[name]})}}},console,setTimeout,clearTimeout,setInterval,clearInterval,queueMicrotask,AbortController,crypto:webcrypto,TextEncoder,TextDecoder,performance})
 return new loaded.__testSessionInputShell({actx:{},defaultSink,commandAttachments:{serialize:async()=>[],release:()=>{},unsupportedNotice:()=>''}})
}
async function sinkText(send){
 let done
 const completed=new Promise(resolve=>{done=resolve}),calls=[]
 const input=await nativeInputShell(async(text,attachments,mode)=>{calls.push({text,attachments:[...attachments],mode});done();return {kind:'success'}})
 try{send(input);await Promise.race([completed,new Promise((_,reject)=>setTimeout(()=>reject(Error('normal SessionInput sink not reached')),1000))]);return calls}finally{input.dispose()}
}
test('真实固定SessionInput普通提交保留原文内部空白，继续原工作不冒用新输入',async()=>{
 const text='原问题\n中文引用  与内部空白保留',calls=await sinkText(input=>{input.setDraft(text);input.submit('queue','click')})
 assert.deepEqual(calls,[{text,attachments:[],mode:'queue'}])
})
test('真实默认sink会trim首尾，不能保真的历史原文不提供重试动作',async()=>{
 const text='  原问题\n中文引用  ',calls=await sinkText(input=>{input.setDraft(text);input.submit('queue','click')})
 assert.equal(calls[0].text,text.trim());assert.notEqual(calls[0].text,text)
 const event=(seq,type,data)=>({type:'event',event:{seq,time:seq,type,data}}),id='11111111-1111-4111-8111-111111111111',rpcId='22222222-2222-4222-8222-222222222222'
 const events=[event(0,'turn/start',{turn:1}),event(1,'step/start',{turn:1,step:1}),event(2,'user/message',{role:'user',id,source:{kind:'user',rpcId},content:[{type:'text',text}]}),event(3,'turn/end',{turn:1,reason:{kind:'error',error:{message:'synthetic'}}})]
 assert.equal(latestRetryableRequest(events),undefined)
})

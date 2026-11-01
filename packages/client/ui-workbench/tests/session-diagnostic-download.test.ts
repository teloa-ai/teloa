import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import ts from 'typescript'
import {createSessionDiagnosticDownloader,downloadSessionDiagnostic} from '../src/client/session-diagnostic-download.ts'
import {sessionDiagnosticCopy} from '../src/client/session-diagnostic-copy.ts'

const sessionId='11111111-1111-4111-8111-111111111111',schema='teloa.session-diagnostic/v1'
const text=(incomplete=false)=>JSON.stringify({kind:'manifest',schema,rootSessionId:sessionId})+'\n'+JSON.stringify({kind:'summary',schema,complete:!incomplete,truncated:incomplete})+'\n'
const response=(body=text())=>new Response(body,{headers:{'content-type':'application/x-ndjson'}})
const signal=()=>new AbortController().signal
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve))

test('通过原认证共享通道 GET 下载明确 schema 的本机副本，不上传或附带正文',async()=>{
 let calls=0
 const send:typeof fetch=async(input,init)=>{calls++;assert.equal(input,'/api/teloa/session-diagnostic?sessionId='+sessionId);assert.equal(init?.method,'GET');assert.equal(init?.credentials,'same-origin');assert.equal(init?.redirect,'error');assert.equal(init?.cache,'no-store');assert.equal(init?.body,undefined);return response()}
 const result=await downloadSessionDiagnostic(sessionId,signal(),send)
 assert.equal(calls,1);assert.equal(result.filename,'teloa-session-diagnostic-'+sessionId+'.ndjson');assert.equal(result.incomplete,false);assert.equal(await result.blob.text(),text())
 assert.equal((await downloadSessionDiagnostic(sessionId,signal(),async()=>response(text(true)))).incomplete,true)
})

test('拒绝未知 schema、非诊断内容和过大输出；失败只显示有限错误码',async()=>{
 for(const [status,code] of [[403,'forbidden'],[404,'not-found'],[500,'unavailable']] as const)await assert.rejects(downloadSessionDiagnostic(sessionId,signal(),async()=>new Response('PRIVATE_SERVER_STACK',{status})),{code:'diagnostic/'+code,message:''})
 for(const body of ['<html>PRIVATE</html>',text().replace(schema,'unknown'),text().split('\n')[0]!])await assert.rejects(downloadSessionDiagnostic(sessionId,signal(),async()=>response(body)),{code:'diagnostic/invalid-response'})
 let cancelled=0
 const body=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array(2*1024*1024+1))},cancel(){cancelled++}})
 await assert.rejects(downloadSessionDiagnostic(sessionId,signal(),async()=>new Response(body,{headers:{'content-type':'application/x-ndjson'}})),{code:'diagnostic/output-limit'})
 assert.equal(cancelled,1)
})

test('请求取消和本人连接 generation 切换使迟到响应失效并停止读取',async()=>{
 const controller=new AbortController();controller.abort();let calls=0
 await assert.rejects(downloadSessionDiagnostic(sessionId,controller.signal,async()=>{calls++;return response()}),{name:'AbortError'});assert.equal(calls,0)
 let generation={id:1,host:{home:'PRIVATE_HOME'}},state:'connected'|'disconnected'='connected',cancelled=0
 const callbacks=new Set<()=>void>(),subscribe=(callback:()=>void)=>{callbacks.add(callback);return()=>callbacks.delete(callback)}
 const connection={generation:{getSnapshot:()=>generation,subscribe},state:{getSnapshot:()=>state,subscribe}}
 const body=new ReadableStream<Uint8Array>({start(output){output.enqueue(new TextEncoder().encode(JSON.stringify({kind:'manifest',schema,rootSessionId:sessionId})+'\n'))},cancel(){cancelled++}})
 const download=createSessionDiagnosticDownloader(connection,async()=>new Response(body,{headers:{'content-type':'application/x-ndjson'}}))
 const pending=download(sessionId,signal());await tick();generation={id:2,host:{home:'NEW_PRIVATE_HOME'}};for(const callback of [...callbacks])callback()
 await assert.rejects(pending,{name:'AbortError'});assert.equal(cancelled,1);assert.equal(callbacks.size,0)
 state='disconnected';await assert.rejects(download(sessionId,signal()),{code:'diagnostic/unavailable'})
})

async function menuRun(){
 const file=ts.createSourceFile('SessionDiagnosticMenuItem.tsx',await readFile(new URL('../src/client/SessionDiagnosticMenuItem.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX)
 let callback:ts.Expression|undefined
 const visit=(node:ts.Node)=>{if(ts.isVariableDeclaration(node)&&node.name.getText(file)==='run')callback=node.initializer;ts.forEachChild(node,visit)};visit(file);assert.ok(callback)
 const body=callback.getText(file)
 return (scope:Record<string,unknown>)=>{const source=ts.transpileModule('const run='+body,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;return new Function(...Object.keys(scope),source+';return run')(...Object.values(scope)) as ()=>void}
}

test('实际菜单回调只在显式操作后保存，切会话/取消后不触发下载',async()=>{
 const run=await menuRun(),owner={sessionId},current={current:owner},active:{current:unknown}={current:undefined},messages:string[]=[]
 let resolve!:(value:{blob:Blob;filename:string;incomplete:boolean})=>void,saves=0
 const download=()=>new Promise<{blob:Blob;filename:string;incomplete:boolean}>(done=>{resolve=done})
 const scope={owner,current,active,alive:{current:true},sessionId,download,setPending:()=>{},copy:(key:string)=>key,toast:{show:({message}:{message:string})=>messages.push(message)},URL:{createObjectURL:()=>{saves++;return 'blob:local'},revokeObjectURL:()=>{}},document:{createElement:()=>({href:'',download:'',click:()=>{}})},setTimeout:(fn:()=>void)=>fn()}
 const open=run(scope);assert.equal(saves,0);open();current.current={sessionId:'other'};resolve({blob:new Blob(['safe']),filename:'safe.ndjson',incomplete:false});await tick();assert.equal(saves,0)
 current.current=owner;open();open();resolve({blob:new Blob(['safe']),filename:'safe.ndjson',incomplete:false});await tick();assert.equal(saves,0)
 open();resolve({blob:new Blob(['safe']),filename:'safe.ndjson',incomplete:true});await tick();assert.equal(saves,1);assert.deepEqual(messages,['incomplete'])
})

test('三类本地文案区分诊断投影和完整归档，未知语言沿英文回退',()=>{
 for(const locale of ['zh-CN','zh-Hant','zh-HK','zh-TW','en']){
  assert.ok(sessionDiagnosticCopy(locale,'download'));assert.ok(sessionDiagnosticCopy(locale,'description').includes('ZIP'))
 }
 assert.equal(sessionDiagnosticCopy('fr','download'),sessionDiagnosticCopy('en','download'))
})

test('注册接线使用现有会话菜单及原本人读取边界，未重接完整 ZIP 或116导航',async()=>{
 const [host,client,frame]=await Promise.all(['../../../harness-dsh/src/index.ts','../src/client/index.ts','../src/client/WorkbenchFrame.tsx'].map(path=>readFile(new URL(path,import.meta.url),'utf8')))
 assert.ok(host&&client&&frame)
 assert.match(host,/registerSessionDiagnosticExport\(connection/);assert.match(host,/authorizeRoot:async\(sessionId,signal\)=>\{[\s\S]*?service\.bySession\(owner,sessionId\)/)
 assert.match(host,/ctx\.sessions\.flush\(session\)/);assert.match(client,/createSessionDiagnosticDownloader\(connection\)/)
 assert.match(client,/return \{assistantActivity,assistantChat,sessionDiagnostics,/);assert.match(frame,/<SessionDiagnosticMenuItem sessionId=\{current\} download=\{sessionDiagnostics\}/)
 assert.ok(!host.includes('streamSessionLogZip('),'此切片不复制或替换完整原始 ZIP')
})

test('Task 原生 SID 可以下载；路径、控制字符及超长 ID 不发出请求',async()=>{
 const task='task-run-'+sessionId
 const result=await downloadSessionDiagnostic(task,signal(),async(input)=>{assert.equal(input,'/api/teloa/session-diagnostic?sessionId='+task);return response(text().replace(sessionId,task))})
 assert.equal(result.filename,'teloa-session-diagnostic-'+task+'.ndjson')
 let calls=0
 for(const invalid of ['/Users/private/session','../session','a'.repeat(129),'task-run-x\nsecret','a\\private'])await assert.rejects(downloadSessionDiagnostic(invalid,signal(),async()=>{calls++;return response()}),{code:'diagnostic/invalid-session'})
 assert.equal(calls,0)
})

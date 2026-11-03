import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFile,readdir} from 'node:fs/promises'
import {pathToFileURL,fileURLToPath} from 'node:url'
import ts from 'typescript'
import {Context} from '@deepseek-ai/cordis'
import {HostConnectionService} from '@deepseek-ai/dsh-client-connection'
import {diagnosticEvent,createSessionDiagnosticResponse,registerSessionDiagnosticExport,type SessionDiagnosticPorts} from '../src/session-diagnostic-export.ts'

const root='11111111-1111-4111-8111-111111111111',child='22222222-2222-4222-8222-222222222222',other='33333333-3333-4333-8333-333333333333'
const requestId='44444444-4444-4444-8444-444444444444'
const secret='F113_SYNTHETIC_SECRET_NEVER_EXPORT',privatePath='/Users/private/F113-home/private.txt'
const event=(seq:number,type='user/message')=>({seq,time:1700000000000,type,data:{turn:1,step:0,id:requestId,source:{kind:'user',rpcId:requestId},content:[{type:'text',text:secret},{type:'file',path:privatePath,bytes:24}],requestId,taskId:root,message:{id:requestId,content:[{type:'text',text:JSON.stringify({access_token:secret,authorization:'Bearer '+secret,url:'https://u:'+secret+'@example.test/?token='+secret,cwd:privatePath})},{type:'file',path:privatePath,name:secret,bytes:24,sha256:'a'.repeat(64)}]},unknown:{password:secret},stack:privatePath}})
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')

test('canary：诊断投影保留因果身份，丢弃 quoted JSON 凭据、路径、正文与未知 payload',()=>{
 const source=event(0),before=digest(source),projected=diagnosticEvent(source,root),text=JSON.stringify(projected)
 assert.ok(text.includes(requestId));assert.ok(text.includes(root))
 for(const canary of [secret,privatePath,'access_token','authorization','password','stack','example.test'])assert.equal(text.includes(canary),false,canary)
 assert.equal(digest(source),before)
 const unknown=JSON.stringify(diagnosticEvent({...source,type:secret},root))
 assert.equal(unknown.includes(secret),false);assert.ok(unknown.includes('unknown'))
 const hashed=JSON.stringify(diagnosticEvent({...source,data:{...source.data,id:privatePath,nativeRequestId:requestId}},root))
 assert.equal(hashed.includes(privatePath),false);assert.ok(hashed.includes('sha256:'));assert.ok(hashed.includes(requestId))
 assert.equal(projected.time,1700000000000)
 const poisoned='66666666-6666-4666-8666-666666666666'
 assert.equal(JSON.stringify(diagnosticEvent({...source,data:{...source.data,taskId:poisoned,requestId:poisoned,header:{id:poisoned}}},root)).includes(poisoned),false)
 assert.equal(diagnosticEvent({seq:2,time:1,type:'tool/result',data:{message:{id:requestId,source:{kind:'tool',callId:requestId},isError:true,content:[{type:'text',text:secret}]}}},root).outcome,'failed')
})

function fixture(rootId=root,childId=child){
 const rows=new Map<string,{header:Record<string,unknown>;events:ReturnType<typeof event>[]}>([[rootId,{header:{id:rootId,createdAt:1,version:1,cwd:privatePath},events:[event(0),event(1,'tool/result')]}],[childId,{header:{id:childId,createdAt:2,version:1,cwd:privatePath,parentSession:rootId,origin:'subagent'},events:[event(0,'assistant/message')]}]])
 const counters={authorize:0,flush:[] as string[],open:[] as string[],read:0,close:0,attachmentReads:0,mutations:0}
 const ports={
  authorizeRoot:async(id:string,signal:AbortSignal)=>{signal.throwIfAborted();counters.authorize++;if(id!==rootId)throw Object.assign(Error(),{code:id===other?'teloa/forbidden':'teloa/not-found'});return {conversationId:root,taskId:root,runId:'55555555-5555-4555-8555-555555555555',nativeRequestId:requestId}},
  flush:async(id:string,signal:AbortSignal)=>{signal.throwIfAborted();counters.flush.push(id)},
  persistence:{open:async(id:string,access:string,options:{signal:AbortSignal})=>{options.signal.throwIfAborted();assert.equal(access,'read');counters.open.push(id);const row=rows.get(id);if(!row)throw Error('missing');return {header:row.header,read:async(offset=0,length=128,readOptions:{signal:AbortSignal})=>{readOptions.signal.throwIfAborted();counters.read++;return {events:row.events.slice(offset,offset+length)}},close:async()=>{counters.close++},append:()=>{counters.mutations++},flush:()=>{counters.mutations++}}}},
  query:{traceSession:async()=>({target:{header:rows.get(rootId)!.header},complete:true,descendants:[{session:{header:rows.get(childId)!.header},descendants:[]}]})},
  attachments:{readImage:()=>{counters.attachmentReads++;throw Error('forbidden')},readFileStream:()=>{counters.attachmentReads++;throw Error('forbidden')}},
 } as unknown as SessionDiagnosticPorts
 return {ports,rows,counters}
}
const request=(id=root,signal?:AbortSignal,method='GET')=>new Request('http://localhost/api/teloa/session-diagnostic?sessionId='+encodeURIComponent(id),{method,...(signal?{signal}:{})})

test('固定SDK真实Context与Fetch registry接受诊断路径，GET/HEAD到达处理器（仅路由，非浏览器认证）',async t=>{
 const ctx=new Context();t.after(()=>ctx.fiber.dispose())
 // 此用例直接传入SDK创建的owner Peer；若误入认证流程立即失败，不伪装cookie认证。
 const auth={isAuthenticated:()=>{throw Error('browser authentication is outside this route test')},authenticateApi:()=>{throw Error('API authentication is outside this route test')}} as unknown as ConstructorParameters<typeof HostConnectionService>[2]
 const service=new HostConnectionService(ctx,[],auth),connection=ctx.connection,f=fixture()
 const dispose=registerSessionDiagnosticExport(connection,f.ports);t.after(dispose)
 const handler=service.createSharedFetchHandler('/api')
 const get=await handler.fetch(request(),connection.browserPeer)
 assert.equal(get.status,200);assert.match(await get.text(),/teloa\.session-diagnostic\/v1/)
 const reads=f.counters.read,head=await handler.fetch(request(root,undefined,'HEAD'),connection.browserPeer)
 assert.equal(head.status,200);assert.equal(await head.text(),'');assert.equal(f.counters.read,reads)
 assert.equal((await handler.fetch(new Request('http://localhost/teloa/session-diagnostic?sessionId='+root),connection.browserPeer)).status,404)
})

test('根与真实子会话通过公开只读接口输出；附件零读取、原始归档输入不变',async()=>{
 const f=fixture(),before=digest([...f.rows])
 const response=await createSessionDiagnosticResponse(f.ports,request()),text=await response.text()
 assert.equal(response.status,200);assert.match(response.headers.get('content-type')??'',/application\/x-ndjson/)
 const records=text.trim().split('\n').map(line=>JSON.parse(line))
 assert.deepEqual(records.filter(row=>row.kind==='session').map(row=>row.sessionId),[root,child])
 assert.equal(records.at(-1).kind,'summary');assert.equal(records.at(-1).complete,true);assert.equal(records.at(-1).events,3)
 assert.equal(text.includes(secret),false);assert.equal(text.includes(privatePath),false)
 assert.deepEqual(f.counters.flush,[root,child]);assert.equal(f.counters.close,2);assert.equal(f.counters.attachmentReads,0);assert.equal(f.counters.mutations,0)
 assert.equal(digest([...f.rows]),before)
})

test('业务读取授权、未知会话与 HEAD 正文边界；registry stub 仅捕获配置',async()=>{
 const f=fixture()
 assert.equal((await createSessionDiagnosticResponse(f.ports,request(other))).status,403)
 assert.equal((await createSessionDiagnosticResponse(f.ports,request(child))).status,404)
 assert.equal(f.counters.open.length,0)
 const head=await createSessionDiagnosticResponse(f.ports,request(root,undefined,'HEAD'))
 assert.equal(head.status,200);assert.equal(await head.text(),'');assert.equal(f.counters.read,0);assert.equal(f.counters.close,1)
 let route:unknown
 registerSessionDiagnosticExport({fetch:{register:value=>{route=value;return async()=>{}}}},f.ports)
 assert.equal((route as {path:string}).path,'/api/teloa/session-diagnostic');assert.deepEqual((route as {methods:string[]}).methods,['GET','HEAD'])
})

test('未绑定 Task SID 返回通用404，授权拒绝前不打开或刷新原生会话',async()=>{
 for(const method of ['GET','HEAD']){
  const f=fixture(),authorizeRoot:SessionDiagnosticPorts['authorizeRoot']=async()=>{f.counters.authorize++;throw Object.assign(Error(secret),{code:'teloa/not-bound'})}
  const response=await createSessionDiagnosticResponse({...f.ports,authorizeRoot},request('task-run-unbound',undefined,method))
  assert.equal(response.status,404);assert.equal(response.headers.get('cache-control'),'no-store')
  assert.equal(await response.text(),JSON.stringify({error:'session-not-found'}))
  assert.equal(f.counters.authorize,1);assert.deepEqual(f.counters.flush,[]);assert.deepEqual(f.counters.open,[])
  assert.equal(f.counters.attachmentReads,0);assert.equal(f.counters.mutations,0)
 }
})

test('取消和消费者取消关闭只读句柄，未开始的响应也释放根句柄',async()=>{
 const f=fixture(),controller=new AbortController();controller.abort()
 await assert.rejects(createSessionDiagnosticResponse(f.ports,request(root,controller.signal)),{name:'AbortError'})
 assert.equal(f.counters.open.length,0)
 const response=await createSessionDiagnosticResponse(f.ports,request())
 await response.body!.cancel();assert.equal(f.counters.open.length,f.counters.close)
})

test('事件/后代/字节上限与不完整 lineage 显式记录，不伪装完整导出',async()=>{
 for(const limits of [{events:1},{sessions:1},{bytes:4096}]){
  const f=fixture()
  if('bytes'in limits)f.rows.get(root)!.events=Array.from({length:100},(_,index)=>event(index))
  const response=await createSessionDiagnosticResponse({...f.ports,limits},request()),bytes=new Uint8Array(await response.arrayBuffer()),records=new TextDecoder().decode(bytes).trim().split('\n').map(line=>JSON.parse(line))
  assert.equal(records.at(-1).complete,false);assert.equal(records.at(-1).truncated,true)
  if('bytes'in limits)assert.ok(bytes.length<=limits.bytes)
 }
 const f=fixture(),query={traceSession:async()=>({target:{header:f.rows.get(root)!.header},complete:false,descendants:[]})}
 const response=await createSessionDiagnosticResponse({...f.ports,query} as SessionDiagnosticPorts,request()),rows=(await response.text()).trim().split('\n').map(line=>JSON.parse(line))
 assert.equal(rows.at(-1).complete,false);assert.ok(rows.at(-1).reasons.includes('lineage-partial'))
})

test('仅真实 parent/origin 的子代理可进入；伪造引用、普通 fork 与失配持久化不会扩大范围',async()=>{
 const f=fixture(),ordinary={id:other,parentSession:root,createdAt:3,origin:undefined}
 const query={traceSession:async()=>({target:{header:f.rows.get(root)!.header},complete:true,descendants:[{session:{header:ordinary},descendants:[]}]})}
 const response=await createSessionDiagnosticResponse({...f.ports,query} as SessionDiagnosticPorts,request()),text=await response.text()
 assert.equal(f.counters.open.includes(other),false);assert.equal(text.includes(other),false)
 assert.equal(JSON.parse(text.trim().split('\n').at(-1)!).omittedBranches,1)
 const mismatch=fixture();mismatch.rows.get(child)!.header.parentSession=other
 const forged={traceSession:async()=>({target:{header:mismatch.rows.get(root)!.header},complete:true,descendants:[{session:{header:{id:child,parentSession:root,origin:'subagent'}},descendants:[]}]})}
 const bad=await createSessionDiagnosticResponse({...mismatch.ports,query:forged} as SessionDiagnosticPorts,request()),badRows=(await bad.text()).trim().split('\n').map(line=>JSON.parse(line))
 assert.deepEqual(badRows.filter(row=>row.kind==='session').map(row=>row.sessionId),[root]);assert.equal(badRows.at(-1).complete,false);assert.ok(badRows.at(-1).reasons.includes('read-failed'))
 assert.equal(mismatch.counters.open.length,mismatch.counters.close)
})

test('固定官方完整日志序列化字节和原持久化输入保持不变，诊断只产生自己的 schema',async()=>{
 const store=new URL('../../../node_modules/.pnpm/',import.meta.url),entry=(await readdir(store)).find(name=>name.startsWith('@deepseek-ai+dsh-session-log-export@0.2.1-rc.2_'))
 assert.ok(entry)
 const packageRoot=new URL(entry+'/node_modules/@deepseek-ai/dsh-session-log-export/',store),manifest=JSON.parse(await readFile(new URL('package.json',packageRoot),'utf8'))
 assert.equal(manifest.version,'0.2.1-rc.2')
 const main=typeof manifest.exports?.['.']==='string'?manifest.exports['.']:manifest.exports?.['.']?.import??manifest.main
 assert.equal(typeof main,'string')
 const moduleUrl=pathToFileURL(fileURLToPath(new URL(main,packageRoot))),sourceBefore=await readFile(moduleUrl)
 const {serializeSessionLog}=await import(moduleUrl.href)
 const f=fixture(),original=[...f.rows].map(([id,row])=>[id,serializeSessionLog(row.header,row.events)])
 const before=digest(original),inputBefore=digest([...f.rows])
 const response=await createSessionDiagnosticResponse(f.ports,request()),text=await response.text()
 const after=[...f.rows].map(([id,row])=>[id,serializeSessionLog(row.header,row.events)])
 assert.equal(digest(after),before);assert.equal(digest([...f.rows]),inputBefore);assert.deepEqual(await readFile(moduleUrl),sourceBefore)
 assert.ok(JSON.stringify(original).includes(secret));assert.ok(JSON.stringify(original).includes(privatePath));assert.equal(text.includes(secret),false)
 const first=JSON.parse(text.split('\n')[0]!),last=JSON.parse(text.trim().split('\n').at(-1)!)
 assert.equal(first.schema,'teloa.session-diagnostic/v1');assert.equal(first.correlation.taskId,root);assert.equal(first.correlation.nativeRequestId,requestId);assert.equal(last.attachmentBodyReads,0)
})

test('实际注册回调从原本人服务与只读 Run 入口取得关联，不从消息正文猜测',async()=>{
 const source=await readFile(new URL('../src/index.ts',import.meta.url),'utf8'),file=ts.createSourceFile('index.ts',source,ts.ScriptTarget.Latest,true)
 let callback:ts.Expression|undefined
 const visit=(node:ts.Node)=>{if(ts.isPropertyAssignment(node)&&node.name.getText(file)==='authorizeRoot')callback=node.initializer;ts.forEachChild(node,visit)};visit(file);assert.ok(callback)
 const calls:string[]=[],owner='fixture-owner',conversation={id:root,sessionId:root,status:'ready',purpose:'task-run',requestId,run:{taskId:root,roleId:null}}
 class WorkError extends Error{code:string;constructor(code:string,message:string){super(message);this.code=code}}
 const scope={owner,WorkError,service:{bySession:async(actor:string,id:string)=>{assert.equal(actor,owner);assert.equal(id,root);calls.push('owner/by-session');return conversation}},taskRunHandler:async(endpoint:string,input:{sessionId:string})=>{assert.equal(endpoint,'task-runs/session');assert.equal(input.sessionId,root);calls.push(endpoint);return {schema:'teloa.task-run-session/v1',conversation,anchor:{id:root,nativeRequestId:root},currentRunId:other,run:{id:other,nativeRequestId:requestId}}}}
 const script=ts.transpileModule('const authorize='+callback.getText(file),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText
 const authorize=new Function(...Object.keys(scope),script+';return authorize')(...Object.values(scope)) as (id:string,signal:AbortSignal)=>Promise<Record<string,unknown>>
 const result=await authorize(root,new AbortController().signal)
 assert.deepEqual(calls,['owner/by-session','task-runs/session']);assert.equal(result.taskId,root);assert.equal(result.runId,other);assert.equal(result.nativeRequestId,requestId)
})

test('真实 Task SID 与合法前缀子会话保留 exact 身份及 parent，非法路径/控制字符/超长请求先拒绝',async()=>{
 const task='task-run-'+root,sub='subagent-'+child,f=fixture(task,sub)
 const response=await createSessionDiagnosticResponse(f.ports,request(task)),rows=(await response.text()).trim().split('\n').map(line=>JSON.parse(line))
 assert.equal(response.status,200);assert.equal(rows[0].rootSessionId,task)
 assert.deepEqual(rows.filter(row=>row.kind==='session').map(row=>row.sessionId),[task,sub]);assert.equal(rows.find(row=>row.sessionId===sub).parentSessionId,task)
 assert.equal(rows.at(-1).complete,true);assert.match(response.headers.get('content-disposition')??'',new RegExp(task))
 const calls=f.counters.authorize
 for(const invalid of ['/Users/private/session','../session','a'.repeat(129),'task-run-x\nsecret','a\\private'])assert.equal((await createSessionDiagnosticResponse(f.ports,request(invalid))).status,400)
 assert.equal(f.counters.authorize,calls)
})

test('工具名只采用可信实际 schema 名称白名单，路径或任意日志字符串仍省略',()=>{
 const source={seq:2,time:1,type:'tool/call',data:{callId:requestId,name:'exec_command',arguments:secret}},trusted=new Set(['exec_command',privatePath])
 assert.equal(diagnosticEvent(source,root,trusted).toolName,'exec_command')
 assert.equal(diagnosticEvent(source,root).toolName,'omitted')
 const path=JSON.stringify(diagnosticEvent({...source,data:{...source.data,name:privatePath}},root,trusted))
 assert.equal(path.includes(privatePath),false);assert.equal(path.includes(secret),false)
})

test('慢消费者不会预读完整日志，取消后关闭当前只读句柄',async()=>{
 const f=fixture();f.rows.get(root)!.events=Array.from({length:5000},(_,index)=>event(index))
 const response=await createSessionDiagnosticResponse(f.ports,request())
 await new Promise<void>(resolve=>setImmediate(resolve))
 assert.ok(f.counters.read>0);assert.ok(f.counters.read<8,'64 KiB 队列不能预读完整 5000 条日志')
 await response.body!.cancel();assert.equal(f.counters.open.length,f.counters.close);assert.equal(f.counters.attachmentReads,0)
})

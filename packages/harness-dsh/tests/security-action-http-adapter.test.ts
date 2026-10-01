import {fork} from 'node:child_process'
import assert from 'node:assert/strict'
import {test} from 'node:test'
import {createServer,type ServerResponse} from 'node:http'
import {once} from 'node:events'
import {randomUUID} from 'node:crypto'
import {inspect} from 'node:util'
import {SecurityActionHttpAdapter} from '../src/security-action-http-adapter.ts'
import type {SecurityActionDispatch} from '@teloa/contract'

const token='task4-secret-probe-unique-73951'
const signal=()=>new AbortController().signal
const capabilities={schema:'teloa.security-action-capabilities/v1',idempotency:{key:'operationId',persistence:'durable',sameRequest:'same-operation',differentRequest:'conflict'}}
const dispatch=():SecurityActionDispatch=>({operationId:randomUUID(),actionId:randomUUID(),tool:'security.endpoint.isolate',playbookVersion:'security.endpoint.isolate/v1',targets:['endpoint-a','endpoint-b'],params:{reason:'核验隔离'}})
function receipt(d:SecurityActionDispatch,state='succeeded') {return {operationId:d.operationId,actionId:d.actionId,receiptId:'receipt-1',state,detail:'已核验',targets:d.targets.map(id=>({id,state:state==='accepted'?'unknown':state})),observedAt:'2026-09-13T01:00:00.000Z'}}
function safe(error:unknown,code:string){assert.equal(Reflect.get(error as object,'code'),code);assert.ok(!inspect(error,{depth:10}).includes(token));return true}
async function server(handler:(response:ServerResponse,path:string,method:string,body:string,headers:Record<string,unknown>)=>void|Promise<void>){
 const requests:Array<{path:string;method:string;body:string;authenticated:boolean;accept:unknown;contentType:unknown;key:unknown}>=[]
 const s=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;const path=req.url!,method=req.method!;requests.push({path,method,body,authenticated:req.headers.authorization===`Bearer ${token}`,accept:req.headers.accept,contentType:req.headers['content-type'],key:req.headers['idempotency-key']});await handler(res,path,method,body,req.headers)})
 s.listen(0,'127.0.0.1');await once(s,'listening');const address=s.address();assert.ok(address&&typeof address!=='string')
 return {url:`http://127.0.0.1:${address.port}`,requests,close:async()=>{s.closeAllConnections();await new Promise<void>((resolve,reject)=>s.close(e=>e?reject(e):resolve()))}}
}
function json(res:ServerResponse,value:unknown,status=200){res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value))}
const adapter=(url:string,timeouts?:{headersMs:number;idleMs:number;totalMs:number})=>new SecurityActionHttpAdapter({baseUrl:url,token,...(timeouts?{timeouts}:{})})

test('配置无环境隐式读取；缺配置与非字面loopback HTTP、userinfo/query/fragment 一律拒绝且不外呼',async()=>{
 let calls=0
 for(const config of [{},{baseUrl:'https://example.test'},{token},...[
  '','http://example.test','http://localhost','http://127.1','http://2130706433','http://0x7f000001','http://127.0.0.2','ftp://127.0.0.1','https://user:password@example.test','https://@example.test','https://example.test?','https://example.test#',' https://example.test','http://127.0.0.1\\@example.test',
 ].map(baseUrl=>({baseUrl,token})),...['',' ','bad\r\nheader'].map(token=>({baseUrl:'https://example.test',token}))]){
  const a=new SecurityActionHttpAdapter({...config,fetch:async()=>{calls++;throw Error(token)}})
  assert.equal((await a.ready(signal())).ready,false);await assert.rejects(a.execute(dispatch(),signal()),e=>safe(e,'teloa/dependency-unavailable'))
 }
 assert.equal(calls,0)
})
test('HTTPS 与 IPv6 字面loopback被允许，每次 readiness 均重新核验精确 capability',async()=>{
 for(const baseUrl of ['https://example.test/base/','http://[::1]:4567']){
  const paths:string[]=[];let value:unknown=capabilities
  const a=new SecurityActionHttpAdapter({baseUrl,token,fetch:async(url,init)=>{paths.push(String(url));assert.equal(init?.redirect,'error');return new Response(JSON.stringify(value))}})
  assert.deepEqual(await a.ready(signal()),{ready:true});value={...capabilities,extra:true};assert.equal((await a.ready(signal())).ready,false);assert.equal(paths.length,2);assert.ok(paths.every(p=>p.endsWith('/v1/security-actions/capabilities')))
 }
})
test('严格capabilities失败原因不泄漏凭据或远端正文',async()=>{
 const variants:unknown[]=[{},null,[],{...capabilities,extra:true},{...capabilities,idempotency:{...capabilities.idempotency,persistence:'process'}},{...capabilities,idempotency:{...capabilities.idempotency,extra:true}},{...capabilities,schema:token}]
 for(const value of variants){const s=await server(r=>json(r,value));try{const result=await adapter(s.url).ready(signal());assert.equal(result.ready,false);assert.ok(!JSON.stringify(result).includes(token))}finally{await s.close()}}
})
test('三类固定路径与header、canonical POST、202受理和200终态严格映射',async()=>{
 const d=dispatch();let state='accepted'
 const s=await server((r,path,method)=>json(r,path.endsWith('capabilities')?capabilities:receipt(d,state),method==='POST'&&state==='accepted'?202:200))
 try{
  const a=adapter(`${s.url}/prefix/`);assert.deepEqual(await a.ready(signal()),{ready:true})
  const accepted=await a.execute(d,signal());assert.equal(accepted.status,'accepted');assert.deepEqual(accepted.targets,[{target:'endpoint-a',state:'unknown'},{target:'endpoint-b',state:'unknown'}])
  for(state of ['succeeded','failed']){const result=await a.execute(d,signal());assert.equal(result.status,state);assert.equal((await a.observe(d,signal()))?.status,state)}
  assert.deepEqual(s.requests.map(r=>r.path),['/prefix/v1/security-actions/capabilities','/prefix/v1/security-actions','/prefix/v1/security-actions',`/prefix/v1/security-actions/operations/${d.operationId}`,'/prefix/v1/security-actions',`/prefix/v1/security-actions/operations/${d.operationId}`])
  for(const r of s.requests){assert.equal(r.authenticated,true);assert.equal(r.accept,'application/json');if(r.method==='POST'){assert.equal(r.key,d.operationId);assert.equal(r.contentType,'application/json');assert.equal(r.body,`{"actionId":"${d.actionId}","operationId":"${d.operationId}","params":{"reason":"核验隔离"},"playbookVersion":"security.endpoint.isolate/v1","targets":["endpoint-a","endpoint-b"],"tool":"security.endpoint.isolate"}`)}}
  assert.ok(!JSON.stringify(s.requests).includes(token))
 }finally{await s.close()}
})
test('404是observe唯一null；POST不自动重发，redirect不跟随，状态码显式失败',async()=>{
 const d=dispatch()
 for(const status of [202,204,301,302,307,308,400,401,403,404,409,429,500,503]){
  const s=await server(r=>{r.writeHead(status,{location:'/must-not-follow'});r.end(token)})
  try{const a=adapter(s.url);if(status===404)assert.equal(await a.observe(d,signal()),null);else await assert.rejects(a.observe(d,signal()),e=>safe(e,[301,302,307,308,401,403,429,500,503].includes(status)?'teloa/dependency-unavailable':'teloa/invalid-host-response'))
   await assert.rejects(a.execute(d,signal()),e=>safe(e,status===409?'teloa/conflict':[301,302,307,308,401,403,429,500,503].includes(status)?'teloa/dependency-unavailable':'teloa/invalid-host-response'));assert.equal(s.requests.length,2)
  }finally{await s.close()}
 }
})
test('身份、目标集合、精确键与HTTP/receipt状态交集不能穿透',async()=>{
 const d=dispatch(),base=receipt(d)
 const variants:unknown[]=[{...base,operationId:randomUUID()},{...base,actionId:randomUUID()},{...base,receiptId:''},{...base,observedAt:'yesterday'},{...base,extra:true},{...base,detail:token},{...base,targets:[]},{...base,targets:[base.targets[0]]},{...base,targets:[base.targets[0],base.targets[0]]},{...base,targets:[base.targets[0],{id:'other',state:'succeeded'}]},{...base,targets:[{...base.targets[0],detail:'不允许'},base.targets[1]]},{...base,targets:[{...base.targets[0],extra:true},base.targets[1]]},{...base,state:'accepted'},{...base,state:'failed'},{...base,state:'unknown'},{...base,targets:[{id:'endpoint-a',state:'unknown'},base.targets[1]]}]
 for(const value of variants){const s=await server(r=>json(r,value));try{await assert.rejects(adapter(s.url).observe(d,signal()),e=>safe(e,'teloa/invalid-host-response'))}finally{await s.close()}}
 for(const [status,state] of [[200,'accepted'],[202,'succeeded'],[202,'failed']] as const){const s=await server(r=>json(r,receipt(d,state),status));try{await assert.rejects(adapter(s.url).execute(d,signal()),e=>safe(e,'teloa/invalid-host-response'))}finally{await s.close()}}
})
test('空、BOM、非法UTF8/JSON、64KiB超限和不合法Content-Length均拒绝',async()=>{
 const d=dispatch()
 for(const bytes of [Buffer.alloc(0),Buffer.from('\ufeff{}'),Buffer.from([0xc3,0x28]),Buffer.from('{"no":'),Buffer.alloc(65537,0x20)]){
  const s=await server(r=>{r.writeHead(200);r.end(bytes)});try{await assert.rejects(adapter(s.url).observe(d,signal()),e=>safe(e,'teloa/invalid-host-response'))}finally{await s.close()}
 }
 for(const length of ['-1','1.5','01','garbage','65537','1','999']){
  const a=new SecurityActionHttpAdapter({baseUrl:'https://example.test',token,fetch:async()=>new Response(JSON.stringify(receipt(d)),{headers:{'Content-Length':length}})})
  await assert.rejects(a.observe(d,signal()),e=>safe(e,'teloa/invalid-host-response'))
 }
})
test('调用方取消在发送前、headers前、body中保持原AbortError；内部三类时限归一依赖不可用',async()=>{
 const d=dispatch(),before=new AbortController(),reason=new DOMException('调用方取消','AbortError');before.abort(reason)
 await assert.rejects(adapter('https://example.test').execute(d,before.signal),e=>e===reason)
 for(const phase of ['headers','body','total']){
  const s=await server(async r=>{if(phase!=='headers'){r.writeHead(200);r.flushHeaders();if(phase==='total'){const timer=setInterval(()=>r.write(' '),10);r.on('close',()=>clearInterval(timer))}}})
  try{
   const a=adapter(s.url,{headersMs:phase==='headers'?40:500,idleMs:phase==='body'?40:500,totalMs:phase==='total'?60:700})
   await assert.rejects(a.observe(d,signal()),e=>safe(e,'teloa/dependency-unavailable'))
   const c=new AbortController();const pending=a.observe(d,c.signal);setTimeout(()=>c.abort(reason),15);await assert.rejects(pending,e=>e===reason)
  }finally{await s.close()}
 }
})

test('JSON转义的凭据反射也不得进入回执',async()=>{
 const d=dispatch(),raw=JSON.stringify({...receipt(d),detail:token}).replace(token,Array.from(token,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')).join(''))
 const s=await server(r=>{r.writeHead(200);r.end(raw)})
 try{await assert.rejects(adapter(s.url).observe(d,signal()),e=>safe(e,'teloa/invalid-host-response'))}finally{await s.close()}
})

// target 是独立进程及磁盘存储；本段检验真实 HTTP adapter 与外部持久边界。
import {persistentSecurityActionTarget,runSecurityActionConformance} from './fixtures/security-action-conformance.ts'
import {database,fixture,identity,command,decision} from '../../backend/tests/security-action-fixture.ts'
import {initializeSecurityActionExecutions,SecurityActionExecutionService} from '../../backend/src/security/action-executions.ts'
import {SecurityActionExecutionDriver} from '../src/security-action-execution.ts'

test('conformance跨adapter重建、目标真进程重启、同key不同body冲突且effect=1',async()=>{
 const target=await persistentSecurityActionTarget({token})
 try{const result=await runSecurityActionConformance(target,dispatch());assert.equal(result.effectCount,1);assert.ok(result.beforePid!==result.afterPid);assert.ok(!JSON.stringify(await target.snapshot()).includes(token))}finally{await target.close()}
})
test('自报durable但重复产生effect或重启遗忘绑定的目标不能通过conformance',async()=>{
 for(const defective of ['repeat-effect','volatile'] as const){const target=await persistentSecurityActionTarget({token,defective});try{await assert.rejects(runSecurityActionConformance(target,dispatch()))}finally{await target.close()}}
})
test('POST生效后断连、目标重启及adapter重建只核对同operation；所有重放body完全一致',async()=>{
 const target=await persistentSecurityActionTarget({token}),d=dispatch()
 try{
  await target.configure({losePost:true});await assert.rejects(target.adapter().execute(d,signal()),e=>safe(e,'teloa/dependency-unavailable'))
  await target.restart();const a=target.adapter();const observed=await a.observe(d,signal());assert.equal(observed?.status,'succeeded');assert.deepEqual(await a.execute(d,signal()),observed)
  const state=await target.snapshot();assert.equal(state.operations[d.operationId]?.effectCount,1);const posts=state.requests.filter(r=>r.method==='POST');assert.equal(posts.length,2);assert.equal(posts[0]?.key,posts[1]?.key);assert.equal(posts[0]?.body,posts[1]?.body)
 }finally{await target.close()}
})
test('202受理后GET丢包不返回null；重启保留受理，完成后200终态且effect=1',async()=>{
 for(const terminal of ['succeeded','failed'] as const){
  const target=await persistentSecurityActionTarget({token}),d=dispatch()
  try{await target.configure({mode:'accepted'});const accepted=await target.adapter().execute(d,signal());assert.equal(accepted.status,'accepted');await target.configure({loseGet:true});await assert.rejects(target.adapter().observe(d,signal()),e=>safe(e,'teloa/dependency-unavailable'));await target.restart();assert.deepEqual(await target.adapter().observe(d,signal()),accepted);await target.settle(d.operationId,terminal);assert.equal((await target.adapter().observe(d,signal()))?.status,terminal);assert.equal((await target.snapshot()).operations[d.operationId]?.effectCount,1)}finally{await target.close()}
 }
})
test('真实PG claim子进程SIGKILL后POST前恢复与两Driver在GET屏障后并发POST，唯一效果与DB回执均为1',async()=>{
 const db=await database(),target=await persistentSecurityActionTarget({token})
 try{
  await initializeSecurityActionExecutions(db.pool)
  const f=await fixture(db.pool),a=await f.actions.propose(f.principal,f.proposal),submitted=await f.actions.submit(f.principal,command(a));await f.approvals.decide(f.principal,decision(submitted))
  const request=command(await f.actions.get(f.principal,{actionId:a.id})),service=new SecurityActionExecutionService(db.pool,identity,f.approvals,f.journal)
  const child=fork(new URL('../../backend/tests/security-action-claim-process.ts',import.meta.url),[],{execArgv:[],stdio:['ignore','ignore','ignore','ipc']})
  let execution:Awaited<ReturnType<typeof service.claim>>['execution']
  try{
   const message=once(child,'message',{signal:AbortSignal.timeout(15000)});child.send({connectionString:db.pool.options.connectionString,principal:f.principal,request})
   const [reply]=await message as [{pid:number;error?:boolean;result:Awaited<ReturnType<typeof service.claim>>}]
   assert.equal(reply.error,undefined);assert.equal(reply.pid,child.pid);execution=reply.result.execution
   assert.equal(execution.state,'dispatching');assert.equal((await target.snapshot()).requests.filter(r=>r.method==='POST').length,0)
  }finally{const exited=once(child,'exit');child.kill('SIGKILL');await exited}
  assert.equal(child.signalCode,'SIGKILL')
  assert.equal((await db.pool.query('select state from teloa_security_action_executions where operation_id=$1',[execution.operationId])).rows[0].state,'dispatching')
  await target.configure({getBarrier:2})
  const input={requestId:randomUUID(),operationId:execution.operationId,expectedRevision:1}
  const left=new SecurityActionExecutionDriver(service,[target.adapter()]),right=new SecurityActionExecutionDriver(new SecurityActionExecutionService(db.pool,identity,f.approvals,f.journal),[target.adapter()])
  const [one,two]=await Promise.all([left.observe(f.principal,input,signal()),right.observe(f.principal,input,signal())]);assert.deepEqual(one,two);assert.equal(one.state,'succeeded')
  const state=await target.snapshot(),calls=state.requests.filter(r=>!r.path.endsWith('capabilities'));assert.deepEqual(calls.map(r=>r.method),['GET','GET','POST','POST']);assert.equal(calls[2]?.body,calls[3]?.body);assert.deepEqual(JSON.parse(calls[2]!.body),execution.dispatch);assert.equal(calls[2]?.key,execution.operationId);assert.equal(state.operations[execution.operationId]?.effectCount,1)
  assert.equal((await db.pool.query("select count(*) from teloa_security_action_execution_receipts where operation_id=$1 and kind='effect'",[execution.operationId])).rows[0].count,'1')
 }finally{await target.close();await db.close()}
})

test('fetch抛出的带凭据WorkError及cause均归一化，不能穿透安全错误边界',async()=>{
 const {WorkError}=await import('@teloa/contract')
 for(const synchronous of [false,true]){
  const unsafe=new WorkError('teloa/invalid-host-response',token);Reflect.set(unsafe,'cause',new Error(`Authorization: Bearer ${token}`))
  const fetcher:typeof fetch=synchronous?()=>{throw unsafe}:async()=>{throw unsafe}
  const a=new SecurityActionHttpAdapter({baseUrl:'https://example.test',token,fetch:fetcher})
  await assert.rejects(a.observe(dispatch(),signal()),e=>safe(e,'teloa/dependency-unavailable'))
 }
})
test('请求发出后调用方改写对象，回包仍按发送时的原身份和目标核验',async()=>{
 const d=dispatch(),original=structuredClone(d)
 let entered!:()=>void,release!:()=>void;const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r)
 const s=await server(async r=>{entered();await gate;json(r,receipt(original))})
 try{const pending=adapter(s.url).execute(d,signal());await started;d.operationId=randomUUID();d.targets.push('changed');release();assert.equal((await pending).status,'succeeded')}finally{release();await s.close()}
})

import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {runAdapterProcess} from './fixtures/security-action-adapter-process-client.ts'
test('宿主adapter进程退出后从磁盘重读原dispatch，目标重启后GET恢复且重放不增加效果',async()=>{
 const target=await persistentSecurityActionTarget({token}),d=dispatch()
 try{
  const config=target.connection(),directory=await mkdtemp(join(tmpdir(),'teloa-adapter-restart-')),file=join(directory,'dispatch.json')
  await writeFile(file,JSON.stringify(d))
  try{
  const first=await runAdapterProcess(config,file,'execute')
  await target.restart()
  const second=await runAdapterProcess(config,file,'observe')
  const third=await runAdapterProcess(config,file,'execute')
  assert.notEqual(first.pid,second.pid);assert.notEqual(second.pid,third.pid);assert.deepEqual(first.receipt,second.receipt);assert.deepEqual(first.receipt,third.receipt)
  const snapshot=await target.snapshot();assert.equal(snapshot.operations[d.operationId]?.effectCount,1);const posts=snapshot.requests.filter(r=>r.method==='POST');assert.equal(posts.length,2);assert.equal(posts[0]?.body,posts[1]?.body);assert.equal(posts[0]?.key,posts[1]?.key)
  }finally{await rm(directory,{recursive:true,force:true})}
 }finally{await target.close()}
})
test('有效JSON恰好64KiB可读，流超过边界立即取消且ready取消不降级为false',async()=>{
 const d=dispatch(),raw=JSON.stringify(receipt(d)),payload=raw+' '.repeat(65536-Buffer.byteLength(raw))
 const s=await server(r=>{r.end(payload)})
 try{assert.equal((await adapter(s.url).observe(d,signal()))?.status,'succeeded')}finally{await s.close()}
 let cancelled=false
 const stream=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array(65537))},cancel(){cancelled=true}})
 const a=new SecurityActionHttpAdapter({baseUrl:'https://example.test',token,fetch:async()=>new Response(stream)})
 await assert.rejects(a.observe(d,signal()),e=>safe(e,'teloa/invalid-host-response'));assert.equal(cancelled,true)
 const abort=new AbortController(),reason=new DOMException('主动取消','AbortError');abort.abort(reason);await assert.rejects(a.ready(abort.signal),e=>e===reason)
})

test('恶意对象状态不得触发隐式字符串转换或绕过固定错误码',async()=>{
 const d=dispatch()
 for(const value of [{...receipt(d),state:{toString:null}},{...receipt(d),targets:[{id:'endpoint-a',state:{toString:'bad'}},{id:'endpoint-b',state:'succeeded'}]}]){
  const s=await server(r=>json(r,value));try{await assert.rejects(adapter(s.url).observe(d,signal()),e=>safe(e,'teloa/invalid-host-response'))}finally{await s.close()}
 }
})


test('通用conformance必须拒绝顺序幂等但两个首次并发POST产生双效果的真实HTTP目标',async()=>{
 const target=await persistentSecurityActionTarget({token,defective:'concurrent-first-effect'})
 try{
  await assert.rejects(runSecurityActionConformance(target,dispatch()),error=>{
   assert.ok(error instanceof assert.AssertionError);assert.equal(error.actual,2);assert.equal(error.expected,1);return true
  })
  const before=await target.snapshot(),duplicates=Object.entries(before.operations).filter(([,operation])=>operation.effectCount===2)
  assert.equal(duplicates.length,1)
  const [operationId,operation]=duplicates[0]!,posts=before.requests.filter(request=>request.method==='POST'&&request.key===operationId)
  assert.equal(posts.length,2);assert.equal(posts[0]?.body,posts[1]?.body);assert.deepEqual(JSON.parse(posts[0]!.body),JSON.parse(operation.body))
  await target.restart();assert.equal((await target.snapshot()).operations[operationId]?.effectCount,2)
 }finally{await target.close()}
})

import assert from 'node:assert/strict'
import test from 'node:test'
import {createRequire} from 'node:module'
import {RuntimeAdmission} from '../../harness-dsh/src/runtime-admission.ts'
import {guardedWebServer,guardedGateway,loadHost} from '../src/runtime-admission.ts'
import {ConversationDirectoryChanges} from '../../harness-dsh/src/conversation-directory.ts'

test('已挂起的目录watch不阻塞默认关闸，关闸后仍拒绝新订阅',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date']})
 const gate=new RuntimeAdmission(),directory=new ConversationDirectoryChanges(),routes:any[]=[]
 const Server=guardedWebServer(class{register(route:any){routes.push(route)}},gate),server=new Server()
 let calls=0
 server.register({kind:'prefix',path:'/teloa',handler:async()=>{calls++;await directory.watch({revision:0},new AbortController().signal)}})
 const response=()=>({code:0,headersSent:false,writeHead(code:number){this.code=code},end(){},destroy(){}})
 const watch=routes[0].handler({method:'POST',url:'/teloa/conversations/watch'},response())
 assert.equal(calls,1)
 try{
  const drain=gate.quiesce();t.mock.timers.tick(2000);await drain;gate.assertQuiescent()
  const rejected=response();await routes[0].handler({method:'POST',url:'/teloa/conversations/watch'},rejected)
  assert.equal(rejected.code,503);assert.equal(calls,1)
 }finally{directory.dispose();await watch;gate.resume()}
})

test('目录观察仍执行原认证处理并保留取消；其他方法和相似路径均计作工作',async()=>{
 const gate=new RuntimeAdmission(),directory=new ConversationDirectoryChanges(),routes:any[]=[]
 const Server=guardedWebServer(class{register(route:any){routes.push(route)}},gate),server=new Server()
 let observed=false
 server.register({kind:'prefix',path:'/teloa',handler:async(req:any,res:any)=>{
  if(req.cookie!=='owned'){res.writeHead(401);res.end();return}
  try{await directory.watch({revision:0},req.signal)}catch(error){observed=req.signal.aborted;throw error}
 }})
 const response=()=>({code:0,headersSent:false,writeHead(code:number){this.code=code},end(){},destroy(){}})
 const denied=response();await routes[0].handler({method:'POST',url:'/teloa/conversations/watch'},denied);assert.equal(denied.code,401)
 const abort=new AbortController(),watch=routes[0].handler({method:'POST',url:'/teloa/conversations/watch',cookie:'owned',signal:abort.signal},response())
 await gate.quiesce(0);gate.assertQuiescent();abort.abort();await watch;assert.equal(observed,true);gate.resume();directory.dispose()
 for(const request of [
  {path:'/teloa',method:'GET',url:'/teloa/conversations/watch'},
  {path:'/teloa',method:'POST',url:'/teloa/conversations/watch/other'},
  {path:'/teloa',method:'POST',url:'/teloa/conversations/list'},
  {path:'/teloa',method:'POST',url:'/teloa/conversations/adopt'},
  {path:'/api',method:'POST',url:'/teloa/conversations/watch'},
 ]){
  let finish!:()=>void
  server.register({kind:'prefix',path:request.path,handler:()=>new Promise<void>(done=>{finish=done})})
  const work=routes.at(-1).handler(request,response())
  try{await assert.rejects(gate.quiesce(0),/收尾/)}finally{finish();await work;gate.resume()}
 }
})
test('从官方包依赖范围加载网关，拒绝未验证的载体版本',async()=>{
 assert.equal(typeof await loadHost('@deepseek-ai/dsh-api-gateway','0.2.0-rc.2'),'function')
 await assert.rejects(loadHost('@deepseek-ai/dsh-api-gateway','unverified'),/版本尚未验证/)
})
test('HTTP 关闸返回 503，管理通道保留认证处理，解闸后业务可用',async()=>{
 const gate=new RuntimeAdmission(),routes:any[]=[]
 const Server=guardedWebServer(class{register(route:any){routes.push(route)}},gate),server=new Server()
 let calls=0;server.register({path:'/api',handler:async()=>{calls++}})
 await gate.quiesce()
 const response={code:0,headersSent:false,writeHead(code:number){this.code=code},end(){},destroy(){}}
 await routes[0].handler({url:'/api/session/prompt'},response);assert.equal(response.code,503);assert.equal(calls,0)
 await routes[0].handler({url:'/teloa-local-runtime/resume'},response);assert.equal(calls,1)
 gate.resume();await routes[0].handler({url:'/api/session/prompt'},response);assert.equal(calls,2)
})
test('官方载体入口缺失时拒绝装配，不能静默丢失停止保护',()=>{
 assert.throws(()=>guardedGateway(class{async stream(){return []}},new RuntimeAdmission()),/停止保护/)
})
test('官方 wireStream 入口关闸后不解析请求，解闸后恢复官方校验',async t=>{
 const require=createRequire(new URL('../../../package.json',import.meta.url))
 const dsh=createRequire(require.resolve('@deepseek-ai/dsh/package.json'))
 const gatewayRequire=createRequire(dsh.resolve('@deepseek-ai/dsh-api-gateway/package.json'))
 const {Context}=await import(dsh.resolve('@deepseek-ai/cordis'))
 const {default:Registry}=await import(gatewayRequire.resolve('@deepseek-ai/dsh-typert-registry'))
 const {default:Gateway}=await import(dsh.resolve('@deepseek-ai/dsh-api-gateway'))
 const ctx=new Context(),gate=new RuntimeAdmission()
 t.after(async()=>{gate.resume();await ctx.fiber.dispose()})
 await ctx.plugin(Registry);await ctx.plugin(guardedGateway(Gateway,gate))
 const gateway=Reflect.get(ctx,'typertGateway')
 const open=()=>gateway.wireStream.open('acceptance/missing',{args:{}},undefined,undefined,new AbortController().signal)
 const local=()=>gateway.stream({namespace:'acceptance',method:'missing',args:{}})
 await gate.quiesce()
 await assert.rejects(open,/停止/)
 await assert.rejects(local,/停止/)
 gate.assertQuiescent();gate.resume()
 await assert.rejects(open,(error:any)=>error.code==='gateway/invocation-unavailable')
 await assert.rejects(local,(error:any)=>error.code==='gateway/invocation-unavailable')
})

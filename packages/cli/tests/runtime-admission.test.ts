import assert from 'node:assert/strict'
import test from 'node:test'
import {createRequire} from 'node:module'
import {RuntimeAdmission} from '../../harness-dsh/src/runtime-admission.ts'
import {guardedWebServer,guardedGateway,loadHost} from '../src/runtime-admission.ts'
test('从官方包依赖范围加载网关，拒绝未验证的载体版本',async()=>{
 assert.equal(typeof await loadHost('@deepseek-ai/dsh-api-gateway','0.1.7-rc.1'),'function')
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

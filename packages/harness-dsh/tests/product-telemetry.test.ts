import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {mkdtemp,rm,access} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createRequire} from 'node:module'
import {Context} from '@deepseek-ai/cordis'
import {createLaunchEnvironmentSnapshot} from '@deepseek-ai/dsh-launch-environment'
import TeloaProductTelemetry from '../src/product-telemetry.ts'

const require=createRequire(import.meta.url)
const official=createRequire(require.resolve('@deepseek-ai/dsh-host-product-telemetry-otel/package.json'))
const {default:OTel}=await import(official.resolve('@deepseek-ai/dsh-otel'))

for(const enabled of [true,false])test(`官方 OTel 真实 HTTP：Teloa 字段过滤与${enabled?'正式启用':'验收排除'}`,{timeout:15000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'teloa-product-events-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const received:Record<string,unknown>[]=[]
 let done!:()=>void
 const delivered=new Promise<void>(resolve=>{done=resolve})
 const server=createServer(async(request,response)=>{
  const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(chunk)
  received.push(JSON.parse(Buffer.concat(chunks).toString()))
  assert.equal(request.headers['x-channel'],'teloa_product_analytics')
  response.writeHead(200,{'content-type':'application/json'});response.end('{}');done()
 })
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())))
 const address=server.address();assert.ok(address&&typeof address!=='string')
 const ctx=new Context();t.after(()=>ctx.fiber.dispose())
 ctx.provide('launchEnvironment',createLaunchEnvironmentSnapshot([{source:'process',values:{TELOA_RUNTIME_ROOT:root,TELOA_USAGE_STATS:'on',TELOA_BROWSER_ACCEPTANCE:enabled?'0':'1'}}]))
 await ctx.plugin(OTel)
 const fiber=await ctx.plugin(TeloaProductTelemetry,{endpoint:`http://127.0.0.1:${address.port}/events`,channel:'teloa_product_analytics',serviceName:'teloa-free',serviceVersion:'0.2.0-alpha.7',compression:'none',maxExportBatchSize:1,maxQueueSize:4,scheduledDelayMillis:10,timeoutMillis:1000,exportTimeoutMillis:1500,shutdownTimeoutMillis:1000})
 ctx.productTelemetry.emit({eventName:'send_button_click',timestamp:Date.now(),body:'private prompt',attributes:{run_mode:'plan',session_id:'private-session',user_id:'private-user',device_id:'private-device',input_value:'private path'}})
 if(enabled){
  await Promise.race([delivered,new Promise((_,reject)=>{const timeout=setTimeout(()=>reject(Error('未收到测试遥测')),5000);timeout.unref()})])
  const raw=JSON.stringify(received)
  assert.doesNotMatch(raw,/private|user_id|device_id|session_id|input_value|deepseeksvc/)
  assert.match(raw,/send_button_click/);assert.match(raw,/installation_id/);assert.match(raw,/plan/)
 }else{
  await fiber.dispose()
  assert.deepEqual(received,[])
  await assert.rejects(access(join(root,'usage-stats/installation-id.json')),{code:'ENOENT'})
 }
})

// 独立代理验收子进程（规格 2026-09-27 §6 C3）：本机 CONNECT 代理桩 + 自签 HTTPS 桩，只连本机临时端口。
// 用 DSH 官方 installProxyFromEnvironment 装策略（与启动器同一入口），再核对 harness-dsh 的 pinnedHttpsRequest 按 proxyRouteFor 分流。
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {createServer as createHttpServer,type IncomingMessage} from 'node:http'
import {createServer as createHttpsServer} from 'node:https'
import {connect as netConnect} from 'node:net'
import {join} from 'node:path'
import {createSecureContext} from 'node:tls'
import {inspect} from 'node:util'
import {gzipSync} from 'node:zlib'
import {installProxyFromEnvironment,proxyRouteFor} from '@deepseek-ai/dsh-http-proxy'
import {WorkError,type MarketCatalogSkillSecret} from '@teloa/contract'
import {pinnedHttpsRequest,resolveOutboundAddresses,type AddressResolver} from '../../src/public-address.ts'
import {runSkillHttp,type SkillHttpAuditEvent,type SkillHttpPorts} from '../../src/skill-http-tool.ts'

const dir=process.argv[2]!
const tlsOptions={key:await readFile(join(dir,'server.key')),cert:await readFile(join(dir,'server.crt'))},secureContext=createSecureContext(tlsOptions)
type Seen={sni:string|undefined;host:string|undefined;acceptEncoding:string|undefined;method:string|undefined;url:string|undefined;body:string;headers:IncomingMessage['headers']}
const seen:Seen[]=[]
let lastSni:string|undefined
const readBody=(req:IncomingMessage)=>new Promise<string>(resolve=>{const chunks:Buffer[]=[];req.on('data',c=>chunks.push(c));req.on('end',()=>resolve(Buffer.concat(chunks).toString('utf8')))})
const server=createHttpsServer({...tlsOptions,SNICallback:(name,callback)=>{lastSni=name;callback(null,secureContext)}},async(req,res)=>{
 const body=await readBody(req)
 seen.push({sni:lastSni,host:req.headers.host,acceptEncoding:req.headers['accept-encoding'] as string|undefined,method:req.method,url:req.url,body,headers:req.headers})
 if(req.url==='/v1/redirect'){res.writeHead(302,{location:'/v1/echo'});res.end();return}
 if(req.url==='/v1/see-other'){res.writeHead(303,{location:'/v1/echo'});res.end();return}
 if(req.url==='/v1/cross'){res.writeHead(302,{location:'https://other.skill.test/v1/echo'});res.end();return}
 if(req.url==='/v1/outside'){res.writeHead(302,{location:'/admin'});res.end();return}
 if(req.url==='/v1/whoami'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({authorization:req.headers.authorization}));return}
 if(req.url==='/v1/slow'){res.writeHead(200,{'content-type':'text/plain'});res.write('a');return}
 if(req.url==='/v1/gzip'){res.writeHead(200,{'content-type':'application/json','content-encoding':'gzip'});res.end(gzipSync(Buffer.from('{"zipped":true}')));return}
 res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({ok:true,body}))
})
await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
const httpsPort=(server.address() as {port:number}).port

// CONNECT 代理桩：只认 api.skill.test:443，隧道接到本机 HTTPS 桩；记录每次 CONNECT 与 Proxy-Authorization。
const connects:string[]=[],proxyAuths:(string|undefined)[]=[]
const proxy=createHttpServer((_req,res)=>{res.writeHead(405);res.end()})
proxy.on('connect',(req,clientSocket,head)=>{
 connects.push('CONNECT '+req.url);proxyAuths.push(req.headers['proxy-authorization'])
 if(req.url!=='api.skill.test:443'){clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');return}
 const upstream=netConnect(httpsPort,'127.0.0.1',()=>{clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);upstream.pipe(clientSocket);clientSocket.pipe(upstream)})
 upstream.on('error',()=>clientSocket.destroy());clientSocket.on('error',()=>upstream.destroy())
})
await new Promise<void>((resolve,reject)=>{proxy.once('error',reject);proxy.listen(0,'127.0.0.1',resolve)})
const proxyPort=(proxy.address() as {port:number}).port
const password='pw-'+Math.random().toString(36).slice(2),proxyUrl=`http://proxy-user:${password}@127.0.0.1:${proxyPort}`
const env=new Map([['HTTPS_PROXY',proxyUrl],['NO_PROXY','direct.skill.test']])
let dispose=await installProxyFromEnvironment({get:name=>{const value=env.get(name);return value===undefined?undefined:{value}}},message=>{throw Error('代理策略被拒：'+message)})
const pinned=[{address:'127.0.0.1',family:4 as const}]
const signal=()=>AbortSignal.timeout(5000)
// 经 runSkillHttp 走代理路径（审查 R1 L1/L3）：本机 DNS 由注入的解析器模拟——.test 名本机解析失败（代理负责解析），private.skill.test 解析到内网。
const apiKey='sk-'+Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2)
const secret:MarketCatalogSkillSecret={envVarName:'API_KEY',label:{'zh-CN':'接口密钥',en:'API key'},required:true,target:'bearer',endpoints:['https://api.skill.test','https://refused.skill.test','https://private.skill.test'].map(origin=>({origin,pathPrefixes:['/v1/']})),methods:['GET','POST']}
const localDns:AddressResolver=async host=>{if(host==='private.skill.test')return [{address:'10.0.0.5',family:4}];throw Object.assign(Error('getaddrinfo ENOTFOUND '+host),{code:'ENOTFOUND'})}
const audit:SkillHttpAuditEvent[]=[]
const ports:SkillHttpPorts={
 skillVisible:async()=>true,
 readForUse:async()=>({secrets:[secret],values:{API_KEY:apiKey},stale:false}),
 allow:()=>true,
 webPolicy:async()=>({version:1,enabled:true,blocked:[]}),
 resolve:(host,abort)=>resolveOutboundAddresses(host,abort,localDns),
 request:pinnedHttpsRequest,
 audit:event=>audit.push(event),
}
const skill=(args:Record<string,unknown>,abort=signal())=>runSkillHttp(ports,{skill:'demo',...args},abort,{sessionId:'s-1'}).then(text=>JSON.parse(text) as {status:number;contentType:string;truncated:boolean;body:string})
try{
 // 步骤 1：同一实例——harness-dsh 源码路径 import 的 proxyRouteFor 看到启动器入口装的策略。
 const api=new URL('https://api.skill.test/v1/echo'),route=proxyRouteFor(api)
 assert.equal(route.proxied,true,'installProxyFromEnvironment 装的策略必须被 harness-dsh 侧 proxyRouteFor 看到')
 assert.equal(proxyRouteFor(new URL('https://direct.skill.test/v1/echo')).proxied,false,'NO_PROXY 命中即直连')
 // 代理路径：钉住地址 127.0.0.1:443 上没有服务，能成功只可能是经代理隧道；代理桩记录 CONNECT host:443。
 const first=await pinnedHttpsRequest(api,{method:'GET',headers:{accept:'application/json','accept-encoding':'identity'},signal:signal()},pinned)
 assert.equal(first.status,200);assert.deepEqual(await first.json(),{ok:true,body:''})
 assert.deepEqual(connects,['CONNECT api.skill.test:443'])
 assert.equal(proxyAuths[0],'Basic '+Buffer.from(`proxy-user:${password}`).toString('base64'),'代理账号由官方 dispatcher 按代理 URL 发出')
 assert.equal(seen.at(-1)!.host,'api.skill.test');assert.equal(seen.at(-1)!.sni,'api.skill.test');assert.equal(seen.at(-1)!.acceptEncoding,'identity','Accept-Encoding: identity 透传')
 assert.equal(first.headers.get('content-type'),'application/json')
 // POST 正文透传
 const posted=await pinnedHttpsRequest(api,{method:'POST',headers:{'content-type':'application/json','accept-encoding':'identity'},body:'{"a":1}',signal:signal()},pinned)
 assert.equal(posted.status,200);assert.deepEqual(await posted.json(),{ok:true,body:'{"a":1}'});assert.equal(seen.at(-1)!.method,'POST')
 // 3xx 原样返回（redirect:'manual'），由调用方 runSkillHttp 逐跳复判
 const redirect=await pinnedHttpsRequest(new URL('https://api.skill.test/v1/redirect'),{method:'GET',headers:{'accept-encoding':'identity'},signal:signal()},pinned)
 assert.equal(redirect.status,302);assert.equal(redirect.headers.get('location'),'/v1/echo');await redirect.body?.cancel()
 assert.equal(seen.filter(s=>s.url==='/v1/echo').length,2,'未跟随跳转')
 // 压缩响应：content-encoding 头原样保留，runSkillHttp 据此不读正文（两条路径规则一致）
 const zipped=await pinnedHttpsRequest(new URL('https://api.skill.test/v1/gzip'),{method:'GET',headers:{'accept-encoding':'identity'},signal:signal()},pinned)
 assert.equal(zipped.status,200);assert.equal(zipped.headers.get('content-encoding'),'gzip');await zipped.body?.cancel()
 // 直连路径（NO_PROXY 命中）：钉住地址 + 端口替换到本机 HTTPS 桩，代理桩不再收到 CONNECT
 const before=connects.length
 const direct=await pinnedHttpsRequest(new URL(`https://direct.skill.test:${httpsPort}/v1/echo`),{method:'GET',headers:{'accept-encoding':'identity'},signal:signal()},pinned)
 assert.equal(direct.status,200);await direct.body?.cancel()
 assert.equal(connects.length,before,'直连路径不经代理');assert.equal(seen.at(-1)!.sni,'direct.skill.test')
 // 代理拒绝隧道（新 origin 才会发新 CONNECT，已建隧道由 dispatcher 连接池复用）：错误里不得出现代理账号串（代理 URL 可能含账号）
 const failure=await pinnedHttpsRequest(new URL('https://refused.skill.test/v1/echo'),{method:'GET',headers:{'accept-encoding':'identity'},signal:signal()},pinned).then(()=>undefined,(error:unknown)=>error)
 assert.ok(failure instanceof Error,'代理拒绝隧道时请求必须失败');assert.equal(connects.at(-1),'CONNECT refused.skill.test:443')
 const dump=inspect(failure,{depth:10})+JSON.stringify(failure,Object.getOwnPropertyNames(failure))
 assert.ok(!dump.includes(password)&&!dump.includes('proxy-user'),'错误对象不含代理账号')
 assert.ok(!JSON.stringify({connects,seen}).includes(password))

 // 请求头对齐（审查 R1 L2）：同一组输入经代理与直连，目标服务收到的头集合逐字一致（Host 与连接类除外）；代理路径不带任何传输层默认头。
 const init={method:'POST',headers:{accept:'application/json','content-type':'application/json','accept-encoding':'identity',authorization:'Bearer t'},body:'{"a":1}'}
 await (await pinnedHttpsRequest(api,{...init,signal:signal()},pinned)).body?.cancel()
 const viaProxy=seen.at(-1)!.headers
 await (await pinnedHttpsRequest(new URL(`https://direct.skill.test:${httpsPort}/v1/echo`),{...init,signal:signal()},pinned)).body?.cancel()
 const viaDirect=seen.at(-1)!.headers
 const comparable=(headers:IncomingMessage['headers'])=>Object.fromEntries(Object.entries(headers).filter(([name])=>!['host','connection','keep-alive','transfer-encoding'].includes(name)).sort(([a],[b])=>a<b?-1:1))
 assert.deepEqual(comparable(viaProxy),comparable(viaDirect),'两条路径的请求头须一致')
 for(const name of ['user-agent','accept-language','sec-fetch-mode'])assert.equal(viaProxy[name],undefined,'代理路径不得附加默认头 '+name)

 // 以下经 runSkillHttp 端到端走代理路径；期间截获一切控制台与标准输出，核对代理地址与账号不入日志。
 const logged:string[]=[],saved={log:console.log,error:console.error,warn:console.warn,info:console.info,debug:console.debug,out:process.stdout.write,err:process.stderr.write}
 const capture=(...args:unknown[])=>{logged.push(args.map(item=>typeof item==='string'?item:inspect(item,{depth:10})).join(' '))}
 console.log=console.error=console.warn=console.info=console.debug=capture
 process.stdout.write=process.stderr.write=((chunk:unknown)=>{logged.push(String(chunk));return true}) as typeof process.stdout.write
 const outcomes:unknown[]=[]
 try{
  // L3：本机解析失败（代理负责解析）放行；密钥经 bearer 注入、回显被脱敏
  const who=await skill({method:'GET',url:'https://api.skill.test/v1/whoami'});outcomes.push(who)
  assert.equal(who.status,200);assert.equal(seen.at(-1)!.headers.authorization,'Bearer '+apiKey,'密钥在隧道内送达目标');assert.ok(!who.body.includes(apiKey)&&who.body.includes('[已隐藏]'),'回包脱敏')
  // 同源跳转放行：第二跳经同一代理、仍带密钥
  const hopped=await skill({method:'GET',url:'https://api.skill.test/v1/redirect'});outcomes.push(hopped)
  assert.equal(hopped.status,200);assert.deepEqual(seen.slice(-2).map(s=>s.url),['/v1/redirect','/v1/echo'])
  // 303：改 GET、去掉请求体
  const seeOther=await skill({method:'POST',url:'https://api.skill.test/v1/see-other',headers:'Content-Type: application/json',body:'{"secret-free":1}'});outcomes.push(seeOther)
  assert.equal(seeOther.status,200);assert.deepEqual(seen.slice(-2).map(s=>[s.url,s.method,s.body]),[['/v1/see-other','POST','{"secret-free":1}'],['/v1/echo','GET','']])
  // 跨源与声明前缀外跳转：拒绝、记 deny redirect、不发第二跳
  for(const path of ['/v1/cross','/v1/outside']){
   const before=seen.length
   const error=await skill({method:'GET',url:'https://api.skill.test'+path}).then(()=>undefined,(e:unknown)=>e);outcomes.push(error)
   assert.ok(error instanceof WorkError&&error.code==='teloa/forbidden'&&/跳转/.test(error.message),path)
   assert.equal(seen.length,before+1,path+' 不跟随');assert.equal((audit.at(-1) as {reason?:string}).reason,'redirect')
  }
  // 压缩响应不读正文
  const zippedOut=await skill({method:'GET',url:'https://api.skill.test/v1/gzip'});outcomes.push(zippedOut)
  assert.deepEqual([zippedOut.status,zippedOut.contentType,zippedOut.body],[200,'application/json','非文本响应，已省略正文。'])
  // L3：代理路径上本机解析出内网地址仍拒（不经代理、不发请求）
  const beforeConnects=connects.length,beforeSeen=seen.length
  const privateError=await skill({method:'GET',url:'https://private.skill.test/v1/echo'}).then(()=>undefined,(e:unknown)=>e);outcomes.push(privateError)
  assert.ok(privateError instanceof WorkError&&privateError.code==='teloa/forbidden'&&/网段/.test(privateError.message));assert.equal((audit.at(-1) as {reason?:string}).reason,'address')
  assert.equal(connects.length,beforeConnects);assert.equal(seen.length,beforeSeen)
  // 直连路径（NO_PROXY 命中）行为不变：本机解析失败即 dependency-unavailable
  await assert.rejects(resolveOutboundAddresses('direct.skill.test',signal(),localDns),(e:unknown)=>e instanceof WorkError&&e.code==='teloa/dependency-unavailable')
  // 超时覆盖正文读取
  const started=Date.now()
  const slow=await skill({method:'GET',url:'https://api.skill.test/v1/slow'},AbortSignal.timeout(1000)).then(()=>undefined,(e:unknown)=>e);outcomes.push(slow)
  assert.ok(slow instanceof WorkError&&slow.code==='teloa/source-unavailable');assert.ok(Date.now()-started<5000)
  // 代理拒绝隧道：回给模型的错误不含代理地址与账号
  const refused=await skill({method:'GET',url:'https://refused.skill.test/v1/echo'}).then(()=>undefined,(e:unknown)=>e);outcomes.push(refused)
  assert.ok(refused instanceof WorkError&&refused.code==='teloa/source-unavailable')
 }finally{
  Object.assign(console,{log:saved.log,error:saved.error,warn:saved.warn,info:saved.info,debug:saved.debug});process.stdout.write=saved.out;process.stderr.write=saved.err
 }
 const surfaces=JSON.stringify({logged,audit})+outcomes.map(item=>inspect(item,{depth:10})+(item instanceof Error?JSON.stringify(item,Object.getOwnPropertyNames(item)):JSON.stringify(item))).join('\n')
 for(const needle of [password,'proxy-user',`127.0.0.1:${proxyPort}`,apiKey])assert.ok(!surfaces.includes(needle),'日志、回包、错误与审计不得含 '+(needle===apiKey?'密钥':needle===password?'代理口令':needle))
 assert.ok(audit.some(event=>event.event==='skill-secret.use'))

 // 代理不可达（功能验证 复审 INFO-1）：代理端口无人监听 → ECONNREFUSED，底层错误含代理 host:port；
 // 经 runSkillHttp 后回包、错误、审计与日志只含 error.name 归类，不含代理地址与账号。
 const dead=createHttpServer()
 await new Promise<void>((resolve,reject)=>{dead.once('error',reject);dead.listen(0,'127.0.0.1',resolve)})
 const deadPort=(dead.address() as {port:number}).port
 await new Promise<void>(resolve=>dead.close(()=>resolve()))
 await dispose()
 const deadEnv=new Map([['HTTPS_PROXY',`http://proxy-user:${password}@127.0.0.1:${deadPort}`]])
 dispose=await installProxyFromEnvironment({get:name=>{const value=deadEnv.get(name);return value===undefined?undefined:{value}}},message=>{throw Error('代理策略被拒：'+message)})
 const raw=await pinnedHttpsRequest(api,{method:'GET',headers:{'accept-encoding':'identity'},signal:signal()},pinned).then(()=>undefined,(error:unknown)=>error)
 assert.ok(raw instanceof Error,'代理不可达时请求必须失败')
 assert.ok((inspect(raw,{depth:10})+JSON.stringify(raw,Object.getOwnPropertyNames(raw))).includes(`127.0.0.1:${deadPort}`),'底层错误确含代理地址（本用例才有意义）')
 const deadLogged:string[]=[],deadAudit=audit.length
 console.log=console.error=console.warn=console.info=console.debug=(...args:unknown[])=>{deadLogged.push(args.map(item=>typeof item==='string'?item:inspect(item,{depth:10})).join(' '))}
 process.stdout.write=process.stderr.write=((chunk:unknown)=>{deadLogged.push(String(chunk));return true}) as typeof process.stdout.write
 let unreachable:unknown
 try{unreachable=await skill({method:'GET',url:'https://api.skill.test/v1/echo'}).then(()=>undefined,(e:unknown)=>e)}
 finally{Object.assign(console,{log:saved.log,error:saved.error,warn:saved.warn,info:saved.info,debug:saved.debug});process.stdout.write=saved.out;process.stderr.write=saved.err}
 assert.ok(unreachable instanceof WorkError&&unreachable.code==='teloa/source-unavailable','代理不可达归为 source-unavailable')
 const deadSurfaces=JSON.stringify({deadLogged,audit:audit.slice(deadAudit)})+inspect(unreachable,{depth:10})+JSON.stringify(unreachable,Object.getOwnPropertyNames(unreachable))
 for(const needle of [`127.0.0.1:${deadPort}`,password,'proxy-user','ECONNREFUSED',apiKey])assert.ok(!deadSurfaces.includes(needle),'代理不可达时回包、错误、审计与日志不得含 '+(needle===apiKey?'密钥':needle===password?'代理口令':needle))
 console.log('skill-http-proxy: passed')
}finally{
 await dispose()
 proxy.closeAllConnections();server.closeAllConnections()
 await Promise.all([new Promise<void>(resolve=>proxy.close(()=>resolve())),new Promise<void>(resolve=>server.close(()=>resolve()))])
}

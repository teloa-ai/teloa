import {before,after,test} from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {createServer,request as httpRequest} from 'node:http'
import {mkdir,mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {prepareNativeRuntime,installNativeRuntime} from '../scripts/runtime/native-runtime.mjs'
import {launchRuntime} from '../scripts/runtime/profile.mjs'

const programRoot=fileURLToPath(new URL('../',import.meta.url)),require=createRequire(new URL('../packages/client/ui-workbench/package.json',import.meta.url))
let runtimeRoot,hook,HostConnectionService,Context,WebSocket,WebSocketServer,originalPath,originalBytes
before(async()=>{
 runtimeRoot=await realpath(await mkdtemp(join(tmpdir(),'teloa-any-host-')))
 const original=createRequire(createRequire(new URL('../package.json',import.meta.url)).resolve('@deepseek-ai/dsh/package.json'))
 originalPath=original.resolve('@deepseek-ai/dsh-client-connection');originalBytes=await readFile(originalPath)
 const plan=await prepareNativeRuntime({programRoot,runtimeRoot})
 hook=installNativeRuntime(plan)
 const owned=plan.packages.find(row=>row.name==='@deepseek-ai/dsh-client-connection');assert.ok(owned)
 ;({HostConnectionService}=await import(pathToFileURL(join(owned.root,'lib/index.js')).href))
 ;({Context}=require('@deepseek-ai/cordis'))
 const webRequire=createRequire(original.resolve('@deepseek-ai/dsh-host-webserver/package.json'))
 ;({WebSocket,WebSocketServer}=webRequire('ws'))
})
after(async()=>{hook?.deregister();if(originalBytes)assert.deepEqual(await readFile(originalPath),originalBytes,'不得修改 pnpm 中的原包');if(runtimeRoot)await rm(runtimeRoot,{recursive:true,force:true})})

function serviceFor(t){
 const ctx=new Context();ctx.provide('webServer',{host:'127.0.0.1',protocol:'http:'});t.after(()=>ctx.fiber.dispose())
 return new HostConnectionService(ctx,[],{isAuthenticated:request=>(request.headers instanceof Headers?request.headers.get('cookie'):request.headers.cookie)==='test-auth=valid',authenticateApi:()=>undefined})
}
const facts=(host,origin='http://'+host,authenticated=true,site)=>({headers:new Headers({...(host?{host}:{}),...(origin?{origin}:{}),...(authenticated?{cookie:'test-auth=valid'}:{}),...(site?{'sec-fetch-site':site}:{})})})

test('默认接受不同公网 IP、域名、端口和 IPv6，HTTP 与 WebSocket 共用原生认证',async t=>{
 const service=serviceFor(t)
 assert.equal(service.allowsRemoteAuthorities,true,'远端目录选择应走浏览器界面')
 for(const host of ['203.0.113.7:3100','198.51.100.22:9000','app.example','another.example:1234','[2001:db8::1]:3100','127.0.0.1:3100','localhost:3100']){
  assert.equal(service.requestRejection(facts(host)),undefined,host)
  const connection=service.admitConnection(facts(host));assert.equal(connection.rejection,undefined,host);await connection.release()
  assert.equal(service.requestRejection(facts(host,undefined,false)),401,'仍须登录：'+host)
  assert.equal(service.admitConnection(facts(host,undefined,false)).rejection,401,'WebSocket 仍须登录：'+host)
 }
 assert.equal(service.requestRejection(facts('app.example:80','http://app.example')),undefined,'保留原生默认端口归一规则')
})

test('取消地址白名单后仍拒绝跨站、Origin 不匹配、无效或缺失 Host',t=>{
 const service=serviceFor(t),host='203.0.113.7:3100'
 for(const request of [facts(host,'http://other.example'),facts(host,'null'),facts(host,'http://'+host,true,'cross-site'),facts('bad.example/path'),facts(undefined,'http://app.example')]){
  assert.equal(service.requestRejection(request),403)
  assert.equal(service.admitConnection(request).rejection,403)
 }
})

test('真实 HTTP 和 WebSocket 经任意 Host 访问，合法登录成功，匿名与跨站拒绝',async t=>{
 const service=serviceFor(t),sockets=new WebSocketServer({noServer:true})
 const server=createServer((req,res)=>{const rejection=service.requestRejection(req);res.writeHead(rejection??200);res.end(rejection?'denied':'ready')})
 server.on('upgrade',(req,socket,head)=>{
  const admission=service.admitConnection(req)
  if(admission.rejection){socket.end('HTTP/1.1 '+admission.rejection+' Rejected\r\nConnection: close\r\n\r\n');return}
  sockets.handleUpgrade(req,socket,head,ws=>{ws.once('close',()=>void admission.release());ws.send('ready');ws.close()})
 })
 await new Promise((done,fail)=>{server.once('error',fail);server.listen(0,'127.0.0.1',done)})
 t.after(async()=>{for(const ws of sockets.clients)ws.terminate();await new Promise(done=>sockets.close(done));await new Promise(done=>server.close(done))})
 const port=server.address().port
 const headers=(host,authenticated=true,origin='http://'+host)=>({Host:host,Origin:origin,...(authenticated?{Cookie:'test-auth=valid'}:{})})
 const http=values=>new Promise((done,fail)=>{const req=httpRequest({host:'127.0.0.1',port,path:'/teloa/test',headers:values},res=>{res.resume();res.once('end',()=>done(res.statusCode))});req.once('error',fail);req.end()})
 const socket=values=>new Promise((done,fail)=>{
  const ws=new WebSocket('ws://127.0.0.1:'+port+'/api/remote.mux',{headers:values})
  ws.once('message',value=>done(value.toString()));ws.once('unexpected-response',(_req,res)=>{res.resume();done(res.statusCode);ws.terminate()});ws.once('error',fail)
 })
 for(const host of ['203.0.113.7:3100','second.example:4567']){
  assert.equal(await http(headers(host)),200);assert.equal(await socket(headers(host)),'ready')
  assert.equal(await http(headers(host,false)),401);assert.equal(await socket(headers(host,false)),401)
  assert.equal(await http(headers(host,true,'http://other.example')),403);assert.equal(await socket(headers(host,true,'http://other.example')),403)
 }
})

test('发行启动保持回环监听，无需额外的访问地址配置',async t=>{
 const root=await mkdtemp(join(tmpdir(),'teloa-public-args-'));t.after(()=>rm(root,{recursive:true,force:true}))
 await mkdir(join(root,'scripts/runtime'),{recursive:true})
 await writeFile(join(root,'scripts/runtime/native-runtime-entry.mjs'),'console.log(JSON.stringify(process.argv.slice(2)))')
 const layout={programRoot:root,workspaceRoot:root,dshHome:join(root,'dsh'),runtimeRoot:join(root,'runtime'),profileName:'teloa-test'}
 const child=launchRuntime(layout,{port:3100});let output='';child.stdout.on('data',chunk=>{output+=chunk})
 assert.equal(await new Promise((done,fail)=>{child.once('error',fail);child.once('exit',done)}),0)
 assert.deepEqual(JSON.parse(output),['--profile','teloa-test','--no-open','--host','127.0.0.1','--port','3100'])
})

import test from 'node:test'
import assert from 'node:assert/strict'
import type {TestContext} from 'node:test'
import {createServer,type IncomingMessage,type ServerResponse} from 'node:http'
import {chmod,mkdir,mkdtemp,readdir,readFile,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import type {Context} from '@deepseek-ai/cordis'
import type {MarketCatalogConnectorEntry} from '@teloa/contract'
import {createManagedMcpConnectionHandler,type ManagedMcpConnectionRecord} from '../src/managed-mcp-connections.ts'
import {OAuthFlowManager,oauthDeniedMessage,oauthExchangeFailedMessage,oauthExpiredMessage,readTokens,saveTokens,type OAuthFlowManagerOptions} from '../src/managed-mcp-oauth.ts'
import {credentialSlotStore,memoryCredentialPort,type McpCredentialPort} from '../src/managed-mcp-credentials.ts'
import {CredentialStoreLocked} from '../src/credentials/store-state.ts'

// ─── 测试工厂 ──────────────────────────────────────────────────────────────────

/** 每个运行目录一份内存凭据端口：同一目录上「重启」出的新宿主共用它（替代一期 mcp/credentials 文件） */
const ports=new Map<string,McpCredentialPort>()
/** 按运行目录切换存储状态：read-only=可读不可写（describeRecord 报不可写、写入抛锁定）；write-fails=预检仍报可写、写入抛锁定（预检之后才锁定） */
const storeMode=new Map<string,'read-only'|'write-fails'>()
function portOf(root:string):McpCredentialPort{
 let port=ports.get(root)
 if(!port){
  const inner=memoryCredentialPort()
  const write=<T>(run:()=>Promise<T>)=>storeMode.has(root)?Promise.reject(new CredentialStoreLocked('document-corrupt')):run()
  port={
   readRecord:key=>inner.readRecord(key),
   describeRecord:async key=>({...await inner.describeRecord(key),writable:storeMode.get(root)!=='read-only'}),
   modifyRecord:(key,mutate)=>write(()=>inner.modifyRecord(key,mutate)),
   deleteRecord:key=>write(()=>inner.deleteRecord(key)),
  }
  ports.set(root,port)
 }
 return port
}
const slotsOf=(root:string)=>credentialSlotStore(portOf(root))
const hasCred=async(root:string)=>Object.keys(await slotsOf(root).read('test_oauth')).length>0

async function tempRoot(t:TestContext):Promise<string>{
 const dir=await mkdtemp(join(tmpdir(),'teloa-mcp-oauth-conn-'))
 t.after(()=>rm(dir,{recursive:true,force:true}))
 return dir
}

function oauthEntry(serverUrl:string,overrides:{requiresUserClientId?:boolean}={}):MarketCatalogConnectorEntry{
 return{
  format:'teloa.market-catalog-entry/v1',
  id:'test.mcp-oauth',
  kind:'connector',
  delivery:'managed',
  version:'1.0.0',
  taxonomy:{functions:['automation'],industries:['general']},
  upstream:null,
  connector:{
   serverName:'test_oauth',
   title:{'zh-CN':'测试 OAuth','en':'Test OAuth'},
   summary:{'zh-CN':'测试。','en':'Test.'},
   auth:{kind:'oauth',supported:true,scopes:['read'],...(overrides.requiresUserClientId?{requiresUserClientId:true}:{})},
   recipe:{transport:'streamable-http',url:serverUrl},
   tools:[{name:'test_tool',description:{'zh-CN':'测试','en':'Test'},readOnly:true}],
   upstreamUrl:'https://example.com',
  },
  modifications:[],
  license:{spdx:'MIT',files:['LICENSE']},
  compatibility:{status:'verified',teloa:'>=0.2.0-alpha.6',dsh:'0.1.7-rc.1',conditions:[]},
  requires:{tools:[],network:true,runtimes:[]},
  review:{status:'approved',reviewedAt:'2026-09-25',reviewer:'Teloa'},
 }
}

/** 本地假授权服务器（同时充当 MCP 资源地址，SDK 回退到同源 AS 元数据） */
type FakeAs={
 origin:string;serverUrl:string;tokenBodies:URLSearchParams[];revokeBodies:URLSearchParams[];refreshMode:'ok'|'invalid_grant';revokeMode:'ok'|'error'
 /** 元数据声明 authorization_response_iss_parameter_supported（RFC 9207） */
 issSupported:boolean
 /** 令牌端点收到请求时通知（参数为 grant_type），随后等 tokenGate 放行再回包 */
 onToken?:(grantType:string)=>void
 tokenGate?:Promise<void>
 /** 吊销端点收到请求时通知，随后等 revokeGate 放行再回包 */
 onRevoke?:()=>void
 revokeGate?:Promise<void>
}
async function startFakeAs(t:TestContext):Promise<FakeAs>{
 const fake:FakeAs={origin:'',serverUrl:'',tokenBodies:[],revokeBodies:[],refreshMode:'ok',revokeMode:'ok',issSupported:false}
 const readBody=(req:IncomingMessage)=>new Promise<string>(done=>{let s='';req.on('data',c=>s+=c);req.on('end',()=>done(s))})
 const json=(res:ServerResponse,status:number,body:unknown)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body))}
 const server=createServer(async(req,res)=>{
  const url=new URL(req.url??'/',fake.origin)
  if(req.method==='GET'&&url.pathname==='/.well-known/oauth-authorization-server'){
   json(res,200,{issuer:fake.origin,authorization_endpoint:`${fake.origin}/authorize`,token_endpoint:`${fake.origin}/token`,revocation_endpoint:`${fake.origin}/revoke`,registration_endpoint:`${fake.origin}/register`,response_types_supported:['code'],grant_types_supported:['authorization_code','refresh_token'],code_challenge_methods_supported:['S256'],token_endpoint_auth_methods_supported:['none'],...(fake.issSupported?{authorization_response_iss_parameter_supported:true}:{})})
   return
  }
  if(req.method==='POST'&&url.pathname==='/register'){
   const body=JSON.parse(await readBody(req)) as Record<string,unknown>
   json(res,201,{client_id:'dcr-client-1',redirect_uris:body.redirect_uris,token_endpoint_auth_method:'none'})
   return
  }
  if(req.method==='POST'&&url.pathname==='/token'){
   const params=new URLSearchParams(await readBody(req))
   fake.tokenBodies.push(params)
   fake.onToken?.(params.get('grant_type')??'')
   if(fake.tokenGate)await fake.tokenGate
   if(params.get('grant_type')==='authorization_code'){
    if(params.get('code')!=='good-code'){json(res,400,{error:'invalid_grant',error_description:'CODE-DESC-SECRET'});return}
    json(res,200,{access_token:'AT-first-secret',token_type:'Bearer',expires_in:120,refresh_token:'RT-first-secret'})
    return
   }
   if(fake.refreshMode==='invalid_grant'){json(res,400,{error:'invalid_grant'});return}
   json(res,200,{access_token:'AT-second-secret',token_type:'Bearer',expires_in:3600,refresh_token:'RT-second-secret'})
   return
  }
  if(req.method==='POST'&&url.pathname==='/revoke'){
   fake.revokeBodies.push(new URLSearchParams(await readBody(req)))
   fake.onRevoke?.()
   if(fake.revokeGate)await fake.revokeGate
   res.writeHead(fake.revokeMode==='ok'?200:500);res.end()
   return
  }
  res.writeHead(404);res.end()
 })
 await new Promise<void>(done=>server.listen(0,'127.0.0.1',done))
 t.after(()=>new Promise<void>(done=>server.close(()=>done())))
 const addr=server.address()
 if(!addr||typeof addr==='string')throw new Error('fake AS 未监听')
 fake.origin=`http://127.0.0.1:${addr.port}`
 fake.serverUrl=`${fake.origin}/mcp`
 return fake
}

type Route={kind:string;path:string;handler:(req:IncomingMessage,res:ServerResponse)=>void|Promise<void>}

/**
 * 模拟 Cordis Context：webServer 是真实监听 127.0.0.1 的 node:http 服务，按注册表分派路由；
 * plugin() 记录每次建连的 McpClient 配置（用于核对 Bearer 头），dispose 注销工具。
 */
async function makeCtx(t:TestContext,host:'127.0.0.1'|'0.0.0.0'='127.0.0.1',credentials:McpCredentialPort=memoryCredentialPort()){
 const routes=new Map<string,Route>()
 const configs:{serverName:string;headers?:Record<string,string>}[]=[]
 const disposed:string[]=[]
 const schemas:{name:string}[]=[]
 const server=createServer((req,res)=>{
  const route=routes.get(new URL(req.url??'/','http://127.0.0.1').pathname)
  if(!route){res.writeHead(404);res.end();return}
  void route.handler(req,res)
 })
 await new Promise<void>(done=>server.listen(0,'127.0.0.1',done))
 t.after(()=>new Promise<void>(done=>server.close(()=>done())))
 const port=(server.address() as {port:number}).port
 const ctx={
  webServer:{host,port,register(route:Route){if(routes.has(route.path))throw new Error('duplicate');routes.set(route.path,route);return ()=>{routes.delete(route.path)}}},
  plugin(_:unknown,config:{serverName:string;headers?:Record<string,string>}){
   configs.push({serverName:config.serverName,...(config.headers?{headers:{...config.headers}}:{})})
   const toolName=`mcp__${config.serverName}__test_tool`
   schemas.push({name:toolName})
   let done=false
   return Object.assign(Promise.resolve(),{dispose:async()=>{
    if(done)return
    done=true;disposed.push(config.serverName)
    const idx=schemas.findIndex(s=>s.name===toolName);if(idx!==-1)schemas.splice(idx,1)
   }})
  },
  tools:{schemas:()=>schemas},
  logger:{warn(){}},
  credentials,
 } as unknown as Context
 return {ctx,routes,configs,disposed,port,callbackBase:`http://127.0.0.1:${port}/oauth/callback`}
}

/** 测试专用管理器工厂：只有测试放行环回授权服务器 */
function testManager(captured:Partial<OAuthFlowManagerOptions>[]=[]){
 return (options:OAuthFlowManagerOptions)=>{captured.push(options);return new OAuthFlowManager({...options,insecureAllowLoopbackServers:true})}
}

async function setup(t:TestContext,opts:{requiresUserClientId?:boolean;host?:'127.0.0.1'|'0.0.0.0'}={}){
 const root=await tempRoot(t)
 const fake=await startFakeAs(t)
 const env=await makeCtx(t,opts.host,portOf(root))
 const entry=oauthEntry(fake.serverUrl,opts)
 const captured:Partial<OAuthFlowManagerOptions>[]=[]
 const managed=createManagedMcpConnectionHandler(env.ctx,root,()=>entry,undefined,testManager(captured))
 t.after(()=>managed.dispose())
 return {root,fake,entry,captured,...env,...managed}
}

async function addAndStart(s:Awaited<ReturnType<typeof setup>>){
 const rec=await s.handler('mcp-connections/add',{catalogId:'test.mcp-oauth'}) as ManagedMcpConnectionRecord
 const started=await s.handler('mcp-connections/oauth-start',{id:rec.id}) as {authorizationUrl:string}
 const state=new URL(started.authorizationUrl).searchParams.get('state')!
 return {rec,started,state}
}

/** 模拟发起授权的那个浏览器：首次打开 /oauth/start 取跳转地址与绑定 cookie，按 state 缓存 */
const browser=new Map<string,Promise<{status:number;location:string;cookie:string}>>()
function openStart(startUrl:string){
 const state=new URL(startUrl).searchParams.get('state')!
 let opened=browser.get(state)
 if(!opened){
  opened=fetch(startUrl,{redirect:'manual'}).then(res=>({status:res.status,location:res.headers.get('location')??'',cookie:(res.headers.get('set-cookie')??'').split(';')[0]!}))
  browser.set(state,opened)
 }
 return opened
}
/** oauth-start 回包里的是宿主 /oauth/start 链接；授权服务器链接要经它跳转得到 */
const asUrl=async(startUrl:string)=>new URL((await openStart(startUrl)).location)
const callback=async(s:{callbackBase:string},query:Record<string,string>,cookie?:string)=>{
 const bound=cookie??(query.state?(await openStart(`${s.callbackBase.replace(/callback$/,'start')}?state=${query.state}`)).cookie:'')
 return fetch(`${s.callbackBase}?${new URLSearchParams(query)}`,{headers:bound?{cookie:bound}:{}})
}
const statusOf=async(s:{handler:(e:string,p:unknown)=>Promise<unknown>},id:string)=>await s.handler('mcp-connections/oauth-status',{id}) as {status:string;errorMessage?:string}

function assertSafePage(res:Response,body:string,secrets:string[]){
 assert.equal(res.headers.get('cache-control'),'no-store')
 assert.equal(res.headers.get('x-content-type-options'),'nosniff')
 assert.equal(res.headers.get('referrer-policy'),'no-referrer')
 assert.equal(res.headers.get('x-frame-options'),'DENY')
 assert.match(res.headers.get('content-security-policy')??'',/default-src 'none'/)
 assert.match(res.headers.get('content-type')??'',/^text\/html; charset=utf-8/)
 assert.equal(res.headers.get('location'),null)
 for(const secret of secrets)assert.ok(!body.includes(secret),`回调页含敏感值 ${secret}`)
}

// ─── add / oauth-start / oauth-status ─────────────────────────────────────────

test('add：OAuth 连接器登记为 pending-oauth；requiresUserClientId 时只接受 oauth_client_id 并写入 0600 凭据',async t=>{
 const s=await setup(t)
 await assert.rejects(s.handler('mcp-connections/add',{catalogId:'test.mcp-oauth',credentials:{oauth_client_id:'x'}}),{code:'teloa/invalid-input'})
 const rec=await s.handler('mcp-connections/add',{catalogId:'test.mcp-oauth'}) as ManagedMcpConnectionRecord
 assert.equal(rec.status,'pending-oauth')

 const u=await setup(t,{requiresUserClientId:true})
 await assert.rejects(u.handler('mcp-connections/add',{catalogId:'test.mcp-oauth',credentials:{oauth_access_token:'forged'}}),{code:'teloa/invalid-input'})
 await assert.rejects(u.handler('mcp-connections/add',{catalogId:'test.mcp-oauth',credentials:{oauth_client_id:7}}),{code:'teloa/invalid-input'})
 const withId=await u.handler('mcp-connections/add',{catalogId:'test.mcp-oauth',credentials:{oauth_client_id:'user-app-1'}}) as ManagedMcpConnectionRecord
 assert.equal(withId.status,'pending-oauth')
 const cred=await slotsOf(u.root).read('test_oauth')
 assert.deepEqual(cred,{oauth_client_id:'user-app-1'})
 // 用户 client_id 用于发起授权
 const started=await u.handler('mcp-connections/oauth-start',{id:withId.id}) as {authorizationUrl:string}
 assert.equal((await asUrl(started.authorizationUrl)).searchParams.get('client_id'),'user-app-1')
})

test('oauth-start：返回只含授权链接的回包，连接置为 pending-oauth；已连接时回 already-connected；非 OAuth 连接拒绝',async t=>{
 const s=await setup(t)
 const {rec,started}=await addAndStart(s)
 assert.deepEqual(Object.keys(started),['authorizationUrl'])
 assert.match(started.authorizationUrl,new RegExp(`^http://127\\.0\\.0\\.1:${s.port}/oauth/start\\?state=[0-9a-f]{32}$`))
 const url=await asUrl(started.authorizationUrl)
 assert.equal(url.searchParams.get('redirect_uri'),s.callbackBase)
 assert.equal(url.searchParams.get('code_challenge_method'),'S256')
 assert.deepEqual(await statusOf(s,rec.id),{status:'pending-oauth'})
 assert.equal((await s.handler('mcp-connections/get',{id:rec.id}) as ManagedMcpConnectionRecord).status,'pending-oauth')
 await assert.rejects(s.handler('mcp-connections/oauth-start',{id:rec.id,extra:1}),{code:'teloa/invalid-input'})
 await assert.rejects(s.handler('mcp-connections/oauth-start',{id:'not-a-uuid'}),{code:'teloa/invalid-input'})

 const res=await callback(s,{state:new URL(started.authorizationUrl).searchParams.get('state')!,code:'good-code'})
 assert.equal(res.status,200)
 assert.deepEqual(await s.handler('mcp-connections/oauth-start',{id:rec.id}),{status:'already-connected'})

 // 非 OAuth 连接器
 const root=await tempRoot(t)
 const plain=oauthEntry('https://example.com/mcp');plain.connector.auth={kind:'none'}
 const other=createManagedMcpConnectionHandler((await makeCtx(t)).ctx,root,()=>plain,undefined,testManager())
 t.after(()=>other.dispose())
 const plainRec=await other.handler('mcp-connections/add',{catalogId:'test.mcp-oauth'}) as ManagedMcpConnectionRecord
 await assert.rejects(other.handler('mcp-connections/oauth-start',{id:plainRec.id}),{code:'teloa/invalid-input'})
})

// ─── 回调路由 ─────────────────────────────────────────────────────────────────

test('回调成功：固定文案页 + no-store 与安全头，不含 code/state/令牌；以新 Bearer 头连接并进入 liveConnections',async t=>{
 const s=await setup(t)
 const {rec,state}=await addAndStart(s)
 const res=await callback(s,{state,code:'good-code'})
 const body=await res.text()
 assert.equal(res.status,200)
 assert.match(body,/授权成功，可返回 Teloa 工作台/)
 assertSafePage(res,body,['good-code',state,'AT-first-secret','RT-first-secret'])

 assert.deepEqual(s.configs,[{serverName:'test_oauth',headers:{Authorization:'Bearer AT-first-secret'}}])
 assert.deepEqual(await statusOf(s,rec.id),{status:'connected'})
 const got=await s.handler('mcp-connections/get',{id:rec.id}) as ManagedMcpConnectionRecord
 assert.equal(got.status,'connected')
 assert.deepEqual(got.tools?.map(tool=>tool.fullName),['mcp__test_oauth__test_tool'])
 assert.deepEqual(s.getManagedMcpToolRules().map(rule=>rule.name),['mcp__test_oauth__test_tool'])
 // 回包与状态文件都不含令牌
 const stateFile=await readFile(join(s.root,'mcp','connections.json'),'utf8')
 for(const text of [JSON.stringify(got),JSON.stringify(await s.handler('mcp-connections/list',{})),stateFile])assert.ok(!/AT-first-secret|RT-first-secret|oauth_(access|refresh|token|client|as)_/.test(text),text)
 // state 一次性：重放同一回调得 400
 const replay=await callback(s,{state,code:'good-code'})
 assert.equal(replay.status,400)
})

test('回调失败：state 无效 400 固定文案；用户拒绝 / 换取失败 400 且连接置 error 附录文案，不含 AS 报错',async t=>{
 const s=await setup(t)
 const bad=await callback(s,{state:'0'.repeat(32),code:'good-code'})
 const badBody=await bad.text()
 assert.equal(bad.status,400)
 assert.match(badBody,/OAuth 回调验证失败（state 不匹配或已超时），请重新发起授权。/)
 assertSafePage(bad,badBody,['good-code','0'.repeat(32)])
 const missing=await fetch(s.callbackBase)
 assert.equal(missing.status,400)

 const {rec,state}=await addAndStart(s)
 const denied=await callback(s,{state,error:'access_denied',error_description:'USER-DENIED-DESC'})
 const deniedBody=await denied.text()
 assert.equal(denied.status,400)
 assert.ok(deniedBody.includes(oauthDeniedMessage))
 assertSafePage(denied,deniedBody,['USER-DENIED-DESC',state])
 assert.deepEqual(await statusOf(s,rec.id),{status:'error',errorMessage:oauthDeniedMessage})

 const second=new URL((await s.handler('mcp-connections/oauth-start',{id:rec.id}) as {authorizationUrl:string}).authorizationUrl).searchParams.get('state')!
 assert.deepEqual(await statusOf(s,rec.id),{status:'pending-oauth'})
 const failed=await callback(s,{state:second,code:'bad-code'})
 const failedBody=await failed.text()
 assert.equal(failed.status,400)
 assert.ok(failedBody.includes(oauthExchangeFailedMessage))
 assertSafePage(failed,failedBody,['bad-code','CODE-DESC-SECRET',second])
 assert.deepEqual(await statusOf(s,rec.id),{status:'error',errorMessage:oauthExchangeFailedMessage})
 assert.equal(s.configs.length,0)
})

test('回调路由只接受 GET；dispose 后撤回路由',async t=>{
 const s=await setup(t)
 const post=await fetch(s.callbackBase,{method:'POST'})
 assert.equal(post.status,405)
 assert.equal(post.headers.get('allow'),'GET')
 assert.equal(post.headers.get('cache-control'),'no-store')
 assert.ok(s.routes.has('/oauth/callback'))
 await s.dispose()
 assert.equal(s.routes.has('/oauth/callback'),false)
})

// ─── connect / delete ─────────────────────────────────────────────────────────

test('connect：OAuth 连接未授权时拒绝且不建连',async t=>{
 const s=await setup(t)
 const rec=await s.handler('mcp-connections/add',{catalogId:'test.mcp-oauth'}) as ManagedMcpConnectionRecord
 await assert.rejects(s.handler('mcp-connections/connect',{id:rec.id}),{code:'teloa/invalid-input'})
 assert.equal(s.configs.length,0)
})

test('delete：先吊销（以仍在的 refresh_token）再删凭据；吊销失败不阻塞删除；待处理授权随之作废',async t=>{
 const s=await setup(t)
 const {rec,state}=await addAndStart(s)
 assert.equal((await callback(s,{state,code:'good-code'})).status,200)
 assert.ok(await hasCred(s.root))
 assert.deepEqual(await s.handler('mcp-connections/delete',{id:rec.id}),{})
 assert.deepEqual(revoked(s.fake),['access_token:AT-first-secret','refresh_token:RT-first-secret'])
 assert.equal(await hasCred(s.root),false)
 assert.deepEqual(s.disposed,['test_oauth'])

 // 吊销端点 500：删除照常完成
 s.fake.revokeMode='error'
 const again=await addAndStart(s)
 assert.equal((await callback(s,{state:again.state,code:'good-code'})).status,200)
 assert.deepEqual(await s.handler('mcp-connections/delete',{id:again.rec.id}),{})
 assert.equal(await hasCred(s.root),false)

 // 删除时未完成的授权：回调视为无效，不再写出令牌文件
 const pending=await addAndStart(s)
 await s.handler('mcp-connections/delete',{id:pending.rec.id})
 const late=await callback(s,{state:pending.state,code:'good-code'})
 assert.equal(late.status,400)
 assert.equal(await hasCred(s.root),false)
})

// ─── 恢复与刷新 ───────────────────────────────────────────────────────────────

async function writeConnectedState(root:string,status:ManagedMcpConnectionRecord['status']){
 const id='11111111-1111-4111-8111-111111111111',stamp='2026-09-25T00:00:00.000Z'
 await mkdir(join(root,'mcp'),{recursive:true})
 await writeFile(join(root,'mcp','connections.json'),JSON.stringify({connections:[{id,catalogId:'test.mcp-oauth',serverName:'test_oauth',status,createdAt:stamp,updatedAt:stamp,_credentialsStored:true}]}))
 return id
}

/** 通过一次真实授权拿到 AS 元数据与 client 信息槽，再按需改写令牌到期时间 */
async function authorizedRoot(t:TestContext,expiresIn:number){
 const s=await setup(t)
 const {state}=await addAndStart(s)
 assert.equal((await callback(s,{state,code:'good-code'})).status,200)
 await saveTokens(slotsOf(s.root),'test_oauth',{access_token:'AT-first-secret',token_type:'Bearer',expires_in:expiresIn,refresh_token:'RT-first-secret'})
 await s.dispose()
 return s
}

test('restoreConnections：跳过 pending-oauth；令牌有效直接以原 Bearer 重连',async t=>{
 const pending=await setup(t)
 await writeConnectedState(pending.root,'pending-oauth')
 await pending.restoreConnections()
 assert.equal(pending.configs.length,0)

 const prior=await authorizedRoot(t,3600)
 const env=await makeCtx(t,undefined,portOf(prior.root))
 const id=await writeConnectedState(prior.root,'connected')
 const managed=createManagedMcpConnectionHandler(env.ctx,prior.root,()=>prior.entry,undefined,testManager());t.after(()=>managed.dispose())
 await managed.restoreConnections()
 assert.deepEqual(env.configs,[{serverName:'test_oauth',headers:{Authorization:'Bearer AT-first-secret'}}])
 assert.equal(prior.fake.tokenBodies.filter(p=>p.get('grant_type')==='refresh_token').length,0)
 assert.equal((await managed.handler('mcp-connections/get',{id}) as ManagedMcpConnectionRecord).status,'connected')
})

test('restoreConnections：临近到期先刷新再以新 Bearer 重连；刷新失败置 error 固定文案且不建连',async t=>{
 const prior=await authorizedRoot(t,60)
 const env=await makeCtx(t,undefined,portOf(prior.root))
 await writeConnectedState(prior.root,'connected')
 const managed=createManagedMcpConnectionHandler(env.ctx,prior.root,()=>prior.entry,undefined,testManager());t.after(()=>managed.dispose())
 await managed.restoreConnections()
 assert.deepEqual(env.configs,[{serverName:'test_oauth',headers:{Authorization:'Bearer AT-second-secret'}}])

 const expired=await authorizedRoot(t,60)
 expired.fake.refreshMode='invalid_grant'
 const env2=await makeCtx(t,undefined,portOf(expired.root))
 const id=await writeConnectedState(expired.root,'connected')
 const managed2=createManagedMcpConnectionHandler(env2.ctx,expired.root,()=>expired.entry,undefined,testManager());t.after(()=>managed2.dispose())
 await managed2.restoreConnections()
 assert.equal(env2.configs.length,0)
 assert.deepEqual(await managed2.handler('mcp-connections/oauth-status',{id}),{status:'error',errorMessage:oauthExpiredMessage})
 assert.equal(await readTokens(slotsOf(expired.root),'test_oauth'),undefined)
})

test('定时刷新：临近到期的已连接 OAuth 连接刷新后释放旧客户端并以新 Bearer 重连；刷新失败断开并置 error',async t=>{
 const s=await setup(t)
 const {rec,state}=await addAndStart(s)
 assert.equal((await callback(s,{state,code:'good-code'})).status,200)
 // 假 AS 给的 expires_in=120s，落在 5 分钟刷新窗口内
 await s.refreshOAuthConnections()
 assert.deepEqual(s.disposed,['test_oauth'])
 assert.deepEqual(s.configs.map(c=>c.headers?.Authorization),['Bearer AT-first-secret','Bearer AT-second-secret'])
 assert.equal((await s.handler('mcp-connections/get',{id:rec.id}) as ManagedMcpConnectionRecord).status,'connected')

 await saveTokens(slotsOf(s.root),'test_oauth',{access_token:'AT-x',token_type:'Bearer',expires_in:30,refresh_token:'RT-x'})
 s.fake.refreshMode='invalid_grant'
 await s.refreshOAuthConnections()
 assert.deepEqual(s.disposed,['test_oauth','test_oauth'])
 assert.deepEqual(await statusOf(s,rec.id),{status:'error',errorMessage:oauthExpiredMessage})
 assert.deepEqual(s.getManagedMcpToolRules(),[])
})

// ─── 公开回调地址来源 ─────────────────────────────────────────────────────────

test('公开回调地址：以运行目录配置文件 oauth.publicCallbackUrl 为准；缺省时交给管理器按环境变量兜底',async t=>{
 const s=await setup(t)
 assert.deepEqual(s.captured.map(o=>o.publicCallbackUrl),[undefined])

 const root=await tempRoot(t)
 await writeFile(join(root,'config.json'),JSON.stringify({oauth:{publicCallbackUrl:'https://teloa.example.com/oauth/callback'}}))
 const captured:Partial<OAuthFlowManagerOptions>[]=[]
 const managed=createManagedMcpConnectionHandler((await makeCtx(t)).ctx,root,()=>s.entry,undefined,testManager(captured));t.after(()=>managed.dispose())
 assert.deepEqual(captured.map(o=>[o.runtimeRoot,o.publicCallbackUrl]),[[root,'https://teloa.example.com/oauth/callback']])

 // 配置优先于环境变量：授权链接里的 redirect_uri 取配置值
 const saved=process.env.TELOA_OAUTH_PUBLIC_CALLBACK_URL
 process.env.TELOA_OAUTH_PUBLIC_CALLBACK_URL='https://env.example.com/oauth/callback'
 t.after(()=>{if(saved===undefined)delete process.env.TELOA_OAUTH_PUBLIC_CALLBACK_URL;else process.env.TELOA_OAUTH_PUBLIC_CALLBACK_URL=saved})
 const rec=await managed.handler('mcp-connections/add',{catalogId:'test.mcp-oauth'}) as ManagedMcpConnectionRecord
 const started=await managed.handler('mcp-connections/oauth-start',{id:rec.id}) as {authorizationUrl:string}
 // 授权从公开地址同目录的 /oauth/start 打开（cookie 与回调同源同路径），redirect_uri 为其同级 callback
 assert.match(started.authorizationUrl,/^https:\/\/teloa\.example\.com\/oauth\/start\?state=[0-9a-f]{32}$/)
})

test('服务器部署（监听 0.0.0.0）未配置公开回调：oauth-start 按附录文案拒绝',async t=>{
 const saved=process.env.TELOA_OAUTH_PUBLIC_CALLBACK_URL
 delete process.env.TELOA_OAUTH_PUBLIC_CALLBACK_URL
 t.after(()=>{if(saved!==undefined)process.env.TELOA_OAUTH_PUBLIC_CALLBACK_URL=saved})
 const s=await setup(t,{host:'0.0.0.0'})
 const rec=await s.handler('mcp-connections/add',{catalogId:'test.mcp-oauth'}) as ManagedMcpConnectionRecord
 await assert.rejects(s.handler('mcp-connections/oauth-start',{id:rec.id}),{code:'teloa/invalid-input',message:'服务器部署需在配置文件中设置 oauth.publicCallbackUrl 才能使用 OAuth 授权。'})
})

// ─── 安全审查修复轮 1 ─────────────────────────────────────────────────────────

/** 令牌端点收到指定 grant_type 的请求后挂起，直到调用 release() */
function gateTokens(fake:FakeAs,grantType:string){
 let open!:()=>void
 fake.tokenGate=new Promise<void>(done=>{open=done})
 const arrived=new Promise<void>(done=>{fake.onToken=g=>{if(g===grantType)done()}})
 return {arrived,release(){delete fake.tokenGate;delete fake.onToken;open()}}
}

const revoked=(fake:FakeAs)=>fake.revokeBodies.map(b=>`${b.get('token_type_hint')}:${b.get('token')}`).sort()
const credSlots=(root:string)=>slotsOf(root).read('test_oauth')

test('disconnect：OAuth 连接在令牌锁内吊销 refresh_token 与 access_token，只清令牌槽（保留 client 信息），状态回到 pending-oauth',async t=>{
 const s=await setup(t)
 const {rec,state}=await addAndStart(s)
 assert.equal((await callback(s,{state,code:'good-code'})).status,200)
 const out=await s.handler('mcp-connections/disconnect',{id:rec.id}) as ManagedMcpConnectionRecord
 assert.equal(out.status,'pending-oauth')
 assert.deepEqual(s.disposed,['test_oauth'])
 assert.deepEqual(s.getManagedMcpToolRules(),[])
 assert.deepEqual(revoked(s.fake),['access_token:AT-first-secret','refresh_token:RT-first-secret'])
 assert.deepEqual(Object.keys(await credSlots(s.root)).sort(),['oauth_as_metadata','oauth_client_info'])
 assert.deepEqual(await statusOf(s,rec.id),{status:'pending-oauth'})
 assert.equal((await s.handler('mcp-connections/get',{id:rec.id}) as ManagedMcpConnectionRecord).status,'pending-oauth')
 // 令牌已清：不能直接重连，须重新授权
 await assert.rejects(s.handler('mcp-connections/connect',{id:rec.id}),{code:'teloa/invalid-input'})

 // 用户自建 OAuth App：保留 oauth_client_id，吊销用同一 client_id
 const u=await setup(t,{requiresUserClientId:true})
 const added=await u.handler('mcp-connections/add',{catalogId:'test.mcp-oauth',credentials:{oauth_client_id:'user-app-1'}}) as ManagedMcpConnectionRecord
 const st=new URL((await u.handler('mcp-connections/oauth-start',{id:added.id}) as {authorizationUrl:string}).authorizationUrl).searchParams.get('state')!
 assert.equal((await callback(u,{state:st,code:'good-code'})).status,200)
 await u.handler('mcp-connections/disconnect',{id:added.id})
 const slots=await credSlots(u.root)
 assert.equal(slots.oauth_client_id,'user-app-1')
 assert.equal(slots.oauth_access_token,undefined)
 assert.equal(slots.oauth_refresh_token,undefined)
 assert.equal(u.fake.revokeBodies.length,2)
 assert.ok(u.fake.revokeBodies.every(b=>b.get('client_id')==='user-app-1'))
})

test('并发：刷新进行中删除连接 → 最终无客户端、无工具注册、令牌已吊销',async t=>{
 const s=await setup(t)
 const {rec,state}=await addAndStart(s)
 assert.equal((await callback(s,{state,code:'good-code'})).status,200)
 const gate=gateTokens(s.fake,'refresh_token')
 const refreshing=s.refreshOAuthConnections()
 await gate.arrived
 const deleting=s.handler('mcp-connections/delete',{id:rec.id})
 gate.release()
 await Promise.all([refreshing,deleting])
 assert.equal(s.configs.length,s.disposed.length,'建过的客户端必须全部释放')
 assert.deepEqual(s.getManagedMcpToolRules(),[])
 assert.ok(revoked(s.fake).includes('refresh_token:RT-second-secret'))
 assert.equal(await hasCred(s.root),false)
 assert.deepEqual(await s.handler('mcp-connections/list',{}),{items:[]})
})

test('并发：回调换取进行中删除连接 → 不重连、令牌已吊销、不留凭据文件',async t=>{
 const s=await setup(t)
 const {rec,state}=await addAndStart(s)
 const gate=gateTokens(s.fake,'authorization_code')
 const pending=callback(s,{state,code:'good-code'})
 await gate.arrived
 const deleting=s.handler('mcp-connections/delete',{id:rec.id})
 gate.release()
 const [res]=await Promise.all([pending,deleting])
 await res.text()
 assert.equal(res.status,400)
 assert.equal(s.configs.length,s.disposed.length,'建过的客户端必须全部释放')
 assert.deepEqual(s.getManagedMcpToolRules(),[])
 assert.ok(revoked(s.fake).includes('refresh_token:RT-first-secret'))
 assert.equal(await hasCred(s.root),false)
 assert.deepEqual(await s.handler('mcp-connections/list',{}),{items:[]})
})

test('并发：回调换取进行中断开连接 → 令牌已吊销清除、无客户端、状态 pending-oauth',async t=>{
 const s=await setup(t)
 const {rec,state}=await addAndStart(s)
 const gate=gateTokens(s.fake,'authorization_code')
 const pending=callback(s,{state,code:'good-code'})
 await gate.arrived
 const disconnecting=s.handler('mcp-connections/disconnect',{id:rec.id})
 gate.release()
 const [res]=await Promise.all([pending,disconnecting])
 await res.text()
 assert.equal(s.configs.length,s.disposed.length,'建过的客户端必须全部释放')
 assert.deepEqual(s.getManagedMcpToolRules(),[])
 assert.ok(revoked(s.fake).includes('refresh_token:RT-first-secret'))
 assert.equal(await readTokens(slotsOf(s.root),'test_oauth'),undefined)
 assert.deepEqual(await statusOf(s,rec.id),{status:'pending-oauth'})
})

test('回调参数长度上限：code 超 4096 或 error 超 128 时 400 固定文案，不换取、不消耗 state',async t=>{
 const s=await setup(t)
 const {rec,state}=await addAndStart(s)
 for(const query of [{state,code:'c'.repeat(4097)},{state,error:'e'.repeat(129)}]){
  const res=await callback(s,query)
  const body=await res.text()
  assert.equal(res.status,400)
  assert.match(body,/授权处理失败，请返回 Teloa 工作台重新发起授权。/)
  assertSafePage(res,body,['c'.repeat(64),'e'.repeat(64),state])
 }
 assert.equal(s.fake.tokenBodies.length,0)
 assert.deepEqual(await statusOf(s,rec.id),{status:'pending-oauth'})
 assert.equal((await callback(s,{state,code:'good-code'})).status,200)
})

test('RFC 9207：AS 声明 authorization_response_iss_parameter_supported 时回调 iss 缺失或与 issuer 不一致均 400 且不换取',async t=>{
 const s=await setup(t)
 s.fake.issSupported=true
 const {rec,state}=await addAndStart(s)
 assert.equal((await callback(s,{state,code:'good-code'})).status,400)
 const again=async()=>new URL((await s.handler('mcp-connections/oauth-start',{id:rec.id}) as {authorizationUrl:string}).authorizationUrl).searchParams.get('state')!
 assert.equal((await callback(s,{state:await again(),code:'good-code',iss:'https://evil.example.com'})).status,400)
 assert.equal(s.fake.tokenBodies.length,0)
 assert.equal((await callback(s,{state:await again(),code:'good-code',iss:s.fake.origin})).status,200)
 assert.deepEqual(await statusOf(s,rec.id),{status:'connected'})
})

test('config.json 对其他用户可写时忽略 oauth.publicCallbackUrl 并告警，回退环境变量',{skip:process.platform==='win32'},async t=>{
 const root=await tempRoot(t)
 const file=join(root,'config.json')
 await writeFile(file,JSON.stringify({oauth:{publicCallbackUrl:'https://attacker.example.com/oauth/callback'}}))
 await chmod(file,0o666)
 const env=await makeCtx(t)
 const warns:string[]=[]
 Object.assign(env.ctx,{logger:{warn:(message:string)=>{warns.push(message)}}})
 const captured:Partial<OAuthFlowManagerOptions>[]=[]
 const managed=createManagedMcpConnectionHandler(env.ctx,root,()=>oauthEntry('https://example.com/mcp'),undefined,testManager(captured))
 t.after(()=>managed.dispose())
 assert.deepEqual(captured.map(o=>o.publicCallbackUrl),[undefined])
 assert.equal(warns.length,1)
 assert.ok(!warns[0]!.includes('attacker'))
})

test('config.json 所有者不是当前用户时忽略 oauth.publicCallbackUrl 并告警',{skip:process.platform==='win32'||process.getuid?.()===0},async t=>{
 const root=await tempRoot(t)
 // /etc/hosts 属 root 且其他用户不可写：只有所有者校验能拒绝它
 const {symlink}=await import('node:fs/promises')
 await symlink('/etc/hosts',join(root,'config.json'))
 const env=await makeCtx(t)
 const warns:string[]=[]
 Object.assign(env.ctx,{logger:{warn:(message:string)=>{warns.push(message)}}})
 const captured:Partial<OAuthFlowManagerOptions>[]=[]
 const managed=createManagedMcpConnectionHandler(env.ctx,root,()=>oauthEntry('https://example.com/mcp'),undefined,testManager(captured))
 t.after(()=>managed.dispose())
 assert.deepEqual(captured.map(o=>o.publicCallbackUrl),[undefined])
 assert.equal(warns.length,1)
 assert.match(warns[0]!,/所有者/)
})

test('oauth-start：连接器改为白名单制（requiresAllowlist 且无用户 client_id）后拒绝发起授权，与 add 同一判断',async t=>{
 const s=await setup(t)
 const rec=await s.handler('mcp-connections/add',{catalogId:'test.mcp-oauth'}) as ManagedMcpConnectionRecord
 s.entry.connector.auth={kind:'oauth',supported:true,scopes:['read'],requiresAllowlist:true}
 await assert.rejects(s.handler('mcp-connections/oauth-start',{id:rec.id}),(err:any)=>err?.code==='teloa/dependency-unavailable'&&/白名单/.test(err.message))
 assert.equal(s.fake.tokenBodies.length,0)
})

// ─── 测试放行开关守卫 ─────────────────────────────────────────────────────────

test('insecureAllowLoopbackServers 只在测试中传入：生产源码除管理器定义与验收夹具模块外不得出现',async()=>{
 const srcDir=fileURLToPath(new URL('../src/',import.meta.url))
 const offenders:string[]=[]
 const walk=async(dir:string):Promise<void>=>{
  for(const item of await readdir(dir,{withFileTypes:true})){
   const path=join(dir,item.name)
   if(item.isDirectory()){await walk(path);continue}
   // 验收夹具模块只在 TELOA_BROWSER_ACCEPTANCE=1 且给出本机假 MCP 地址时放行（见 managed-mcp-acceptance.test.ts）
   if(!/\.(ts|tsx|mts|js|mjs)$/.test(item.name)||path.endsWith('managed-mcp-oauth.ts')||path.endsWith('managed-mcp-acceptance.ts'))continue
   if((await readFile(path,'utf8')).includes('insecureAllowLoopbackServers'))offenders.push(path)
  }
 }
 await walk(srcDir)
 assert.deepEqual(offenders,[])
})

// ─── 任务 4：凭据槽白名单与状态文件写入加锁 ───────────────────────────────────

test('凭据槽白名单：宿主写入的 oauth_* 槽一律不可由用户提交；oauth_client_id 仅 requiresUserClientId 时接受',async t=>{
 const hostSlots=['oauth_access_token','oauth_refresh_token','oauth_token_expiry','oauth_client_info','oauth_as_metadata']
 const u=await setup(t,{requiresUserClientId:true})
 for(const key of hostSlots){
  await assert.rejects(u.handler('mcp-connections/add',{catalogId:'test.mcp-oauth',credentials:{[key]:'forged'}}),{code:'teloa/invalid-input'},key)
  await assert.rejects(u.handler('mcp-connections/add',{catalogId:'test.mcp-oauth',credentials:{oauth_client_id:'user-app-1',[key]:'forged'}}),{code:'teloa/invalid-input'},`oauth_client_id+${key}`)
 }
 await assert.rejects(u.handler('mcp-connections/add',{catalogId:'test.mcp-oauth',credentials:{oauth_client_id:'has space'}}),{code:'teloa/invalid-input'})
 // 被拒绝的提交不落盘、不登记
 assert.equal(await hasCred(u.root),false)
 assert.deepEqual(await u.handler('mcp-connections/list',{}),{items:[]})

 const d=await setup(t)
 for(const key of [...hostSlots,'oauth_client_id'])await assert.rejects(d.handler('mcp-connections/add',{catalogId:'test.mcp-oauth',credentials:{[key]:'forged'}}),{code:'teloa/invalid-input'},key)
 assert.equal(await hasCred(d.root),false)
 assert.deepEqual(await d.handler('mcp-connections/list',{}),{items:[]})
})

test('requiresAllowlist（needs-configuration）：无官方白名单 client_id 时 add 报 dependency-unavailable；要求用户自带已获批 client_id 时可登记',async t=>{
 const root=await tempRoot(t)
 const {ctx}=await makeCtx(t)
 const entry=oauthEntry('https://example.com/mcp')
 entry.connector.auth={kind:'oauth',supported:true,scopes:['read'],requiresAllowlist:true}
 entry.compatibility={...entry.compatibility,status:'needs-configuration',conditions:[{'zh-CN':'厂商只允许白名单客户端','en':'Vendor allows allowlisted clients only'}]}
 const blocked=createManagedMcpConnectionHandler(ctx,root,()=>entry,undefined,testManager())
 t.after(()=>blocked.dispose())
 await assert.rejects(blocked.handler('mcp-connections/add',{catalogId:'test.mcp-oauth'}),(err:any)=>err?.code==='teloa/dependency-unavailable'&&/白名单/.test(err.message))
 assert.deepEqual(await blocked.handler('mcp-connections/list',{}),{items:[]})

 const byo=oauthEntry('https://example.com/mcp')
 byo.connector.auth={kind:'oauth',supported:true,scopes:['read'],requiresAllowlist:true,requiresUserClientId:true}
 byo.compatibility={...entry.compatibility}
 const root2=await tempRoot(t)
 const allowed=createManagedMcpConnectionHandler((await makeCtx(t)).ctx,root2,()=>byo,undefined,testManager())
 t.after(()=>allowed.dispose())
 const rec=await allowed.handler('mcp-connections/add',{catalogId:'test.mcp-oauth',credentials:{oauth_client_id:'approved-app'}}) as ManagedMcpConnectionRecord
 assert.equal(rec.status,'pending-oauth')
})

test('并发：同一连接器同时 add 两次 → 只登记一条，另一条 conflict，凭据不被覆盖',async t=>{
 const s=await setup(t,{requiresUserClientId:true})
 const results=await Promise.allSettled([
  s.handler('mcp-connections/add',{catalogId:'test.mcp-oauth',credentials:{oauth_client_id:'app-a'}}),
  s.handler('mcp-connections/add',{catalogId:'test.mcp-oauth',credentials:{oauth_client_id:'app-b'}}),
 ])
 const ok=results.filter(r=>r.status==='fulfilled')
 const failed=results.filter((r):r is PromiseRejectedResult=>r.status==='rejected')
 assert.equal(ok.length,1)
 assert.equal(failed.length,1)
 assert.equal(failed[0]!.reason?.code,'teloa/conflict')
 const {items}=await s.handler('mcp-connections/list',{}) as {items:ManagedMcpConnectionRecord[]}
 assert.equal(items.length,1)
 const winner=results[0]!.status==='fulfilled'?'app-a':'app-b'
 assert.deepEqual(await credSlots(s.root),{oauth_client_id:winner})
})

test('并发：oauth-start 发起后遇进行中的删除 → 等删除完成后报连接不存在，不回授权链接、不留待处理授权、不复活记录',async t=>{
 const root=await tempRoot(t)
 const fake=await startFakeAs(t)
 const env=await makeCtx(t,undefined,portOf(root))
 const entry=oauthEntry(fake.serverUrl)
 let manager!:OAuthFlowManager
 let afterStart:(()=>Promise<void>)|undefined
 class HookedManager extends OAuthFlowManager{
  override async startFlow(...args:Parameters<OAuthFlowManager['startFlow']>){
   const started=await super.startFlow(...args)
   if(afterStart)await afterStart()
   return started
  }
 }
 const s=createManagedMcpConnectionHandler(env.ctx,root,()=>entry,undefined,options=>(manager=new HookedManager({...options,insecureAllowLoopbackServers:true})))
 t.after(()=>s.dispose())
 // 先完成一次授权拿到令牌，再把连接置为 error（令牌仍在，删除时会发吊销请求）
 const rec=await s.handler('mcp-connections/add',{catalogId:'test.mcp-oauth'}) as ManagedMcpConnectionRecord
 const first=await s.handler('mcp-connections/oauth-start',{id:rec.id}) as {authorizationUrl:string}
 assert.equal((await callback(env,{state:new URL(first.authorizationUrl).searchParams.get('state')!,code:'good-code'})).status,200)
 const statePath=join(root,'mcp','connections.json')
 const persisted=JSON.parse(await readFile(statePath,'utf8')) as {connections:{status:string}[]}
 persisted.connections[0]!.status='error'
 await writeFile(statePath,JSON.stringify(persisted))

 let open!:()=>void
 fake.revokeGate=new Promise<void>(done=>{open=done})
 const revokeArrived=new Promise<void>(done=>{fake.onRevoke=done})
 let deleting:Promise<unknown>|undefined
 afterStart=async()=>{afterStart=undefined;deleting=s.handler('mcp-connections/delete',{id:rec.id});await revokeArrived}
 const starting=s.handler('mcp-connections/oauth-start',{id:rec.id})
 let settled=false
 void starting.then(()=>{settled=true},()=>{settled=true})
 await revokeArrived
 await new Promise(done=>setTimeout(done,50))
 const settledDuringDelete=settled
 delete fake.onRevoke;delete fake.revokeGate;open()
 await deleting
 await assert.rejects(starting,{code:'teloa/invalid-input'})
 assert.equal(settledDuringDelete,false,'oauth-start 的状态写入必须等同一 serverName 的删除完成')
 assert.deepEqual([...manager.pendingFlows.values()].filter(f=>f.connectionId===rec.id),[])
 assert.deepEqual(await s.handler('mcp-connections/list',{}),{items:[]})
 assert.equal(await hasCred(root),false)
})

// ─── 任务 5：官方目录 OAuth 配方 ──────────────────────────────────────────────

test('官方目录 OAuth 配方：新旧 auth 结构均可解析；白名单制条目宿主拒绝添加，自带 client_id 条目只收 oauth_client_id',async t=>{
 const {readMarketCatalogIndex}=await import('@teloa/contract')
 const {createHash}=await import('node:crypto')
 const {officialCatalogIndex}=await import('../../backend/src/market/official-catalog-snapshot.ts')
 const index=readMarketCatalogIndex(officialCatalogIndex,text=>createHash('sha256').update(text).digest('hex'))
 const byId=new Map(index.entries.map(entry=>[entry.id,entry]))
 const connector=(id:string)=>{const entry=byId.get(id);assert.ok(entry&&entry.kind==='connector',id);return entry as MarketCatalogConnectorEntry}
 for(const id of ['teloa.mcp-supabase-remote','teloa.mcp-gitlab']){
  const entry=connector(id)
  assert.equal(entry.connector.auth.kind==='oauth'&&entry.connector.auth.supported,true,id)
  assert.equal(entry.compatibility.status,'needs-configuration',id)
 }
 // 裁定（第一性原理复核 §8-4，市场仓 2026.9.28.6）：Notion 远端与 Composio 按 sentry/gitlab 同等证据开放授权
 const notion=connector('teloa.mcp-notion-remote')
 assert.deepEqual(notion.connector.auth,{kind:'oauth',supported:true,scopes:['default']})
 assert.equal(notion.compatibility.status,'needs-configuration')
 // 裁定：Supabase 默认只读，条件写明全权限风险
 const supabase=connector('teloa.mcp-supabase-remote')
 assert.ok(supabase.connector.recipe.transport==='streamable-http'&&new URL(supabase.connector.recipe.url).searchParams.get('read_only')==='true')
 assert.ok(supabase.compatibility.conditions.some(c=>/全部权限/.test(c['zh-CN'])&&/只读/.test(c['zh-CN'])))
 assert.deepEqual(connector('teloa.mcp-gitlab').connector.auth,{kind:'oauth',supported:true,scopes:['mcp']})
 const slack=connector('teloa.mcp-slack')
 assert.ok(slack.connector.auth.kind==='oauth'&&slack.connector.auth.supported&&slack.connector.auth.requiresUserClientId)
 // Slack 只申请读取所需最小 scope，不含任何写权限
 assert.deepEqual(slack.connector.auth.scopes.filter(scope=>/write|admin/.test(scope)),[])
 assert.equal(slack.connector.auth.clientIdPattern,'^\\d+\\.\\d+$')
 assert.ok(slack.compatibility.conditions.some(c=>/工具清单待实测/.test(c['zh-CN'])))
 const figma=connector('teloa.mcp-figma')
 assert.ok(figma.connector.auth.kind==='oauth'&&figma.connector.auth.supported&&figma.connector.auth.requiresAllowlist)
 assert.equal(figma.compatibility.status,'needs-configuration')
 const composio=connector('teloa.mcp-composio')
 assert.deepEqual(composio.connector.auth,{kind:'oauth',supported:true,scopes:[]})
 assert.equal(composio.compatibility.status,'needs-configuration')

 const root=await tempRoot(t)
 const managed=createManagedMcpConnectionHandler((await makeCtx(t)).ctx,root,id=>byId.get(id)?.kind==='connector'?byId.get(id) as MarketCatalogConnectorEntry:undefined,undefined,testManager())
 t.after(()=>managed.dispose())
 await assert.rejects(managed.handler('mcp-connections/add',{catalogId:'teloa.mcp-figma'}),{code:'teloa/dependency-unavailable'})
 assert.equal((await managed.handler('mcp-connections/add',{catalogId:'teloa.mcp-composio'}) as ManagedMcpConnectionRecord).status,'pending-oauth')
 await assert.rejects(managed.handler('mcp-connections/add',{catalogId:'teloa.mcp-slack',credentials:{oauth_access_token:'x'}}),{code:'teloa/invalid-input'})
 for(const clientId of ['abc','1234','1234.5678x','1234.5678 '])await assert.rejects(managed.handler('mcp-connections/add',{catalogId:'teloa.mcp-slack',credentials:{oauth_client_id:clientId}}),{code:'teloa/invalid-input'},clientId)
 assert.equal((await managed.handler('mcp-connections/add',{catalogId:'teloa.mcp-slack',credentials:{oauth_client_id:'1234.5678'}}) as ManagedMcpConnectionRecord).status,'pending-oauth')
 assert.equal((await managed.handler('mcp-connections/add',{catalogId:'teloa.mcp-gitlab'}) as ManagedMcpConnectionRecord).status,'pending-oauth')
 await assert.rejects(managed.handler('mcp-connections/add',{catalogId:'teloa.mcp-supabase-remote',credentials:{oauth_client_id:'x'}}),{code:'teloa/invalid-input'})
})

// ─── 功能验证 安全专项自查 ──────────────────────────────────────────────────────

test('安全自查：RPC 回包白名单——add / oauth-start / oauth-status / get / list / disconnect 全程不含 oauth_* 槽与令牌值',async t=>{
 const s=await setup(t,{requiresUserClientId:true})
 const replies:unknown[]=[]
 const rec=await s.handler('mcp-connections/add',{catalogId:'test.mcp-oauth',credentials:{oauth_client_id:'user-app-id'}}) as ManagedMcpConnectionRecord
 replies.push(rec)
 const started=await s.handler('mcp-connections/oauth-start',{id:rec.id}) as {authorizationUrl:string}
 assert.deepEqual(Object.keys(started),['authorizationUrl'])
 replies.push(await statusOf(s,rec.id))
 const state=new URL(started.authorizationUrl).searchParams.get('state')!
 assert.equal((await callback(s,{state,code:'good-code'})).status,200)
 replies.push(await statusOf(s,rec.id),await s.handler('mcp-connections/get',{id:rec.id}),await s.handler('mcp-connections/list',{}),await s.handler('mcp-connections/oauth-start',{id:rec.id}))
 replies.push(await s.handler('mcp-connections/disconnect',{id:rec.id}))
 const allowed=new Set(['id','catalogId','serverName','status','errorMessage','tools','createdAt','updatedAt','items','name','fullName','readOnly'])
 const walk=(value:unknown):void=>{
  if(Array.isArray(value)){value.forEach(walk);return}
  if(value&&typeof value==='object')for(const [key,child] of Object.entries(value)){assert.ok(allowed.has(key),`回包含非白名单字段 ${key}`);walk(child)}
 }
 for(const reply of replies){
  walk(reply)
  assert.ok(!/AT-first-secret|RT-first-secret|good-code|user-app-id|"oauth_/.test(JSON.stringify(reply)),JSON.stringify(reply))
 }
})

test('安全自查：代理无法触发 OAuth——会话工具端口只含 add/connect/list，任务工具候选只有 mcp__ 工具名，oauth 端点不在任何工具注册面',async t=>{
 const {readFile:read}=await import('node:fs/promises')
 const srcDir=fileURLToPath(new URL('../src/',import.meta.url))
 const sessionTools=await read(join(srcDir,'market-session-tools.ts'),'utf8')
 assert.match(sessionTools,/mcp:\(endpoint:'mcp-connections\/add'\|'mcp-connections\/connect'\|'mcp-connections\/list',payload:unknown\)=>Promise<unknown>/)
 const called=[...sessionTools.matchAll(/ports\.mcp\('([^']+)'/g)].map(match=>match[1])
 assert.ok(called.length>0)
 assert.deepEqual([...new Set(called)].sort(),['mcp-connections/add','mcp-connections/connect','mcp-connections/list'])
 // oauth-start / oauth-status 只出现在受管连接模块的端点表里，由本人 RPC 分派
 const offenders:string[]=[]
 for(const item of await readdir(srcDir,{withFileTypes:true})){
  if(!item.isFile()||!/\.ts$/.test(item.name)||item.name==='managed-mcp-connections.ts')continue
  if(/mcp-connections\/oauth-/.test(await read(join(srcDir,item.name),'utf8')))offenders.push(item.name)
 }
 assert.deepEqual(offenders,[])
 // 已连接后任务工具候选只含 MCP 工具全名，不含任何 RPC 端点
 const s=await setup(t)
 const {state}=await addAndStart(s)
 assert.equal((await callback(s,{state,code:'good-code'})).status,200)
 const rules=s.getManagedMcpToolRules()
 assert.ok(rules.length>0)
 for(const rule of rules){
  assert.match(rule.name,/^mcp__[A-Za-z0-9_-]{1,32}__[A-Za-z0-9_-]{1,128}$/)
  assert.doesNotMatch(rule.name,/mcp-connections|oauth-start|oauth-status/)
 }
})

// ─── 终审 L4：浏览器绑定 cookie ────────────────────────────────────────────────

test('L4 /oauth/start 首次打开下发 HttpOnly、SameSite=Lax、Path=/oauth 的一次性 cookie 并跳转授权服务器；回调缺失或不符 400 固定文案且不消耗 state',async t=>{
 const s=await setup(t)
 const {rec,started,state}=await addAndStart(s)
 const first=await fetch(started.authorizationUrl,{redirect:'manual'})
 assert.equal(first.status,302)
 assert.equal(first.headers.get('cache-control'),'no-store')
 assert.equal(first.headers.get('referrer-policy'),'no-referrer')
 const location=new URL(first.headers.get('location')!)
 assert.equal(location.origin+location.pathname,`${s.fake.origin}/authorize`)
 assert.equal(location.searchParams.get('state'),state)
 const setCookie=first.headers.get('set-cookie')!
 assert.match(setCookie,/^teloa_oauth_[0-9a-f]{16}=[0-9a-f]{32}; /)
 assert.match(setCookie,/; HttpOnly/);assert.match(setCookie,/; SameSite=Lax/);assert.match(setCookie,/; Path=\/oauth(;|$)/);assert.doesNotMatch(setCookie,/Secure/)
 const cookie=setCookie.split(';')[0]!
 // 再次打开只跳转、不再下发（拿到链接的其他浏览器得不到绑定）
 const again=await fetch(started.authorizationUrl,{redirect:'manual'})
 assert.equal(again.status,302);assert.equal(again.headers.get('set-cookie'),null)
 // 未知 state：400 固定文案，不跳转；只接受 GET
 const unknown=await fetch(`${s.callbackBase.replace(/callback$/,'start')}?state=${'0'.repeat(32)}`,{redirect:'manual'})
 assert.equal(unknown.status,400);assert.equal(unknown.headers.get('location'),null);assert.equal(unknown.headers.get('set-cookie'),null)
 assert.ok((await unknown.text()).includes('授权链接无效或已过期，请回到 Teloa 重新发起。'))
 assert.equal((await fetch(started.authorizationUrl,{method:'POST',redirect:'manual'})).status,405)

 const mismatch='OAuth 回调验证失败（不是发起授权的浏览器），请在发起授权的同一浏览器中重新授权。'
 for(const bad of ['x=y',cookie.replace(/=.*/,'=')+'f'.repeat(32),'teloa_oauth_0000000000000000='+cookie.split('=')[1]]){
  const res=await callback(s,{state,code:'good-code'},bad)
  const body=await res.text()
  assert.equal(res.status,400,bad);assert.ok(body.includes(mismatch),bad);assertSafePage(res,body,[cookie.split('=')[1]!])
 }
 assert.equal(s.fake.tokenBodies.length,0)
 assert.deepEqual(await statusOf(s,rec.id),{status:'pending-oauth'})
 // 同一浏览器带回 cookie：成功，并清除 cookie
 const ok=await callback(s,{state,code:'good-code'},cookie)
 assert.equal(ok.status,200)
 assert.match(ok.headers.get('set-cookie')??'',new RegExp(`^${cookie.split('=')[0]}=; .*Max-Age=0`))
})

// ─── 凭据存储可读不可写（审查修复 R1） ────────────────────────────────────────

const storageLocked={code:'teloa/storage-unavailable',message:'密钥存储已锁定，请到设置页处理后重试'}

test('存储可读不可写：删除已连接的 OAuth 连接被拒绝，零副作用（不吊销、不释放客户端、状态仍 connected、凭据仍在）',async t=>{
 const s=await setup(t)
 const {rec,state}=await addAndStart(s)
 assert.equal((await callback(s,{state,code:'good-code'})).status,200)
 storeMode.set(s.root,'read-only');t.after(()=>storeMode.delete(s.root))
 await assert.rejects(s.handler('mcp-connections/delete',{id:rec.id}),storageLocked)
 assert.equal(s.fake.revokeBodies.length,0)
 assert.deepEqual(s.disposed,[])
 assert.equal(s.getManagedMcpToolRules().length,1)
 assert.deepEqual(await statusOf(s,rec.id),{status:'connected'})
 assert.equal((await slotsOf(s.root).read('test_oauth')).oauth_access_token,'AT-first-secret')
})

test('存储可读不可写：断开已连接的 OAuth 连接被拒绝，零副作用（不吊销、不释放客户端、状态仍 connected、令牌仍在）',async t=>{
 const s=await setup(t)
 const {rec,state}=await addAndStart(s)
 assert.equal((await callback(s,{state,code:'good-code'})).status,200)
 storeMode.set(s.root,'read-only');t.after(()=>storeMode.delete(s.root))
 await assert.rejects(s.handler('mcp-connections/disconnect',{id:rec.id}),storageLocked)
 assert.equal(s.fake.revokeBodies.length,0)
 assert.deepEqual(s.disposed,[])
 assert.equal(s.getManagedMcpToolRules().length,1)
 assert.deepEqual(await statusOf(s,rec.id),{status:'connected'})
 assert.equal((await slotsOf(s.root).read('test_oauth')).oauth_refresh_token,'RT-first-secret')
})

test('存储可读不可写：定时刷新不发刷新请求，保留旧令牌与 connected 状态',async t=>{
 const s=await setup(t)
 const {rec,state}=await addAndStart(s)
 assert.equal((await callback(s,{state,code:'good-code'})).status,200)
 storeMode.set(s.root,'read-only');t.after(()=>storeMode.delete(s.root))
 await s.refreshOAuthConnections()
 assert.equal(s.fake.tokenBodies.filter(p=>p.get('grant_type')==='refresh_token').length,0)
 assert.equal((await slotsOf(s.root).read('test_oauth')).oauth_refresh_token,'RT-first-secret')
 assert.deepEqual(await statusOf(s,rec.id),{status:'connected'})
})

test('回调时存储锁定：预检不可写则不换取；预检后才锁定则吊销刚换得的令牌；两者都回 503 固定文案且不改连接状态',async t=>{
 const s=await setup(t)
 const {rec,state}=await addAndStart(s)
 storeMode.set(s.root,'read-only');t.after(()=>storeMode.delete(s.root))
 const res=await callback(s,{state,code:'good-code'})
 assert.equal(res.status,503)
 assert.match(await res.text(),/密钥存储已锁定/)
 assert.equal(s.fake.tokenBodies.length,0)
 assert.deepEqual(await statusOf(s,rec.id),{status:'pending-oauth'})

 // 重新发起（可写），换取前存储才变为写入失败：换得的令牌被吊销，不保存
 storeMode.delete(s.root)
 const again=new URL((await s.handler('mcp-connections/oauth-start',{id:rec.id}) as {authorizationUrl:string}).authorizationUrl).searchParams.get('state')!
 storeMode.set(s.root,'write-fails')
 const late=await callback(s,{state:again,code:'good-code'})
 assert.equal(late.status,503)
 await late.text()
 assert.equal(s.fake.tokenBodies.length,1)
 assert.deepEqual(revoked(s.fake),['access_token:AT-first-secret','refresh_token:RT-first-secret'])
 assert.equal((await slotsOf(s.root).read('test_oauth')).oauth_access_token,undefined)
 assert.deepEqual(await statusOf(s,rec.id),{status:'pending-oauth'})
 assert.equal(s.configs.length,0)
})

test('删除时预检通过、删凭据记录才遇锁定：状态对齐为 error（固定文案），不吊销',async t=>{
 const s=await setup(t)
 const {rec,state}=await addAndStart(s)
 assert.equal((await callback(s,{state,code:'good-code'})).status,200)
 storeMode.set(s.root,'write-fails');t.after(()=>storeMode.delete(s.root))
 await assert.rejects(s.handler('mcp-connections/delete',{id:rec.id}),storageLocked)
 assert.equal(s.fake.revokeBodies.length,0)
 assert.deepEqual(await statusOf(s,rec.id),{status:'error',errorMessage:storageLocked.message})
 assert.equal((await slotsOf(s.root).read('test_oauth')).oauth_access_token,'AT-first-secret')
})

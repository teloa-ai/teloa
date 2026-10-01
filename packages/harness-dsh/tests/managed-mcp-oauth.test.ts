import test from 'node:test'
import assert from 'node:assert/strict'
import type {TestContext} from 'node:test'
import {createServer,type IncomingMessage,type ServerResponse} from 'node:http'
import {createHash} from 'node:crypto'
import {mkdtemp,rm} from 'node:fs/promises'
import {existsSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import type {MarketCatalogConnectorEntry} from '@teloa/contract'
import {
 OAuthFlowManager,assertPublicHttpsUrl,clearOAuthCredentials,clientMetadata,newState,readTokens,redirectUrl,saveTokens,
 pendingFlowTtlMs,refreshAheadMs,
} from '../src/managed-mcp-oauth.ts'
import {memorySlotStore,type McpSlotStore} from '../src/managed-mcp-credentials.ts'
import {CredentialStoreLocked} from '../src/credentials/store-state.ts'

// ─── 测试工厂 ──────────────────────────────────────────────────────────────────

async function tempRoot(t:TestContext):Promise<string>{
 const dir=await mkdtemp(join(tmpdir(),'teloa-oauth-test-'))
 t.after(()=>rm(dir,{recursive:true,force:true}))
 return dir
}

const webCtx=(port:number,host:'127.0.0.1'|'0.0.0.0'='127.0.0.1')=>({webServer:{host,port}})

function oauthEntry(serverUrl:string,overrides:{scopes?:string[];requiresUserClientId?:boolean;serverName?:string}={}):MarketCatalogConnectorEntry{
 return{
  format:'teloa.market-catalog-entry/v1',
  id:'test.mcp-oauth',
  kind:'connector',
  delivery:'managed',
  version:'1.0.0',
  taxonomy:{functions:['automation'],industries:['general']},
  upstream:null,
  connector:{
   serverName:overrides.serverName??'test_oauth',
   title:{'zh-CN':'测试 OAuth','en':'Test OAuth'},
   summary:{'zh-CN':'测试。','en':'Test.'},
   auth:{kind:'oauth',supported:true,scopes:overrides.scopes??['read','write'],...(overrides.requiresUserClientId?{requiresUserClientId:true}:{})},
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

/** 本地假授权服务器：同时充当 MCP 资源服务器（不提供 RFC 9728 元数据，SDK 回退到同源 AS）。 */
type FakeAs={
 origin:string
 serverUrl:string
 registerBodies:Record<string,unknown>[]
 tokenBodies:URLSearchParams[]
 revokeBodies:URLSearchParams[]
 refreshMode:'ok'|'invalid_grant'|'unauthorized_client'|'server_error_500'|'no_rotation'
 registerMode:'ok'|'error'
 registrationEnabled:boolean
 asMetadataOverride?:Record<string,unknown>
}

async function startFakeAs(t:TestContext):Promise<FakeAs>{
 const fake:FakeAs={origin:'',serverUrl:'',registerBodies:[],tokenBodies:[],revokeBodies:[],refreshMode:'ok',registerMode:'ok',registrationEnabled:true}
 const readBody=(req:IncomingMessage)=>new Promise<string>(done=>{let s='';req.on('data',c=>s+=c);req.on('end',()=>done(s))})
 const json=(res:ServerResponse,status:number,body:unknown)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body))}
 const server=createServer(async(req,res)=>{
  const url=new URL(req.url??'/',fake.origin)
  if(req.method==='GET'&&url.pathname==='/.well-known/oauth-authorization-server'){
   json(res,200,fake.asMetadataOverride??{
    issuer:fake.origin,
    authorization_endpoint:`${fake.origin}/authorize`,
    token_endpoint:`${fake.origin}/token`,
    revocation_endpoint:`${fake.origin}/revoke`,
    ...(fake.registrationEnabled?{registration_endpoint:`${fake.origin}/register`}:{}),
    response_types_supported:['code'],
    grant_types_supported:['authorization_code','refresh_token'],
    code_challenge_methods_supported:['S256'],
    token_endpoint_auth_methods_supported:['none'],
   })
   return
  }
  if(req.method==='POST'&&url.pathname==='/register'){
   const body=JSON.parse(await readBody(req)) as Record<string,unknown>
   fake.registerBodies.push(body)
   if(fake.registerMode==='error'){json(res,400,{error:'invalid_client_metadata',error_description:'REGISTER-DESC-SECRET'});return}
   json(res,201,{client_id:'dcr-client-1',client_id_issued_at:1700000000,redirect_uris:body.redirect_uris,token_endpoint_auth_method:'none'})
   return
  }
  if(req.method==='POST'&&url.pathname==='/token'){
   const params=new URLSearchParams(await readBody(req))
   fake.tokenBodies.push(params)
   if(params.get('grant_type')==='authorization_code'){
    if(params.get('code')!=='good-code'||!params.get('code_verifier')){json(res,400,{error:'invalid_grant',error_description:'bad code'});return}
    json(res,200,{access_token:'AT-first-secret',token_type:'Bearer',expires_in:120,refresh_token:'RT-first-secret',scope:'read write'})
    return
   }
   if(params.get('grant_type')==='refresh_token'){
    if(fake.refreshMode==='invalid_grant'){json(res,400,{error:'invalid_grant',error_description:`token ${params.get('refresh_token')} revoked`});return}
    if(fake.refreshMode==='unauthorized_client'){json(res,400,{error:'unauthorized_client'});return}
    if(fake.refreshMode==='server_error_500'){res.writeHead(500,{'content-type':'text/html'});res.end('<html>upstream down</html>');return}
    if(fake.refreshMode==='no_rotation'){json(res,200,{access_token:'AT-third-secret',token_type:'Bearer',expires_in:120});return}
    json(res,200,{access_token:'AT-second-secret',token_type:'Bearer',expires_in:3600,refresh_token:'RT-second-secret'})
    return
   }
   json(res,400,{error:'unsupported_grant_type'})
   return
  }
  if(req.method==='POST'&&url.pathname==='/revoke'){
   fake.revokeBodies.push(new URLSearchParams(await readBody(req)))
   res.writeHead(200);res.end()
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

/** 每个临时运行目录一份内存凭据槽（替代一期 mcp/credentials/<serverName> 文件） */
const slotStores=new Map<string,McpSlotStore>()
function slotsOf(root:string):McpSlotStore{
 let slots=slotStores.get(root)
 if(!slots){slots=memorySlotStore();slotStores.set(root,slots)}
 return slots
}

function makeManager(root:string,opts:Partial<ConstructorParameters<typeof OAuthFlowManager>[0]>={}){
 return new OAuthFlowManager({runtimeRoot:root,slots:slotsOf(root),insecureAllowLoopbackServers:true,...opts})
}

async function readCredFile(root:string,serverName:string):Promise<Record<string,string>>{
 return slotsOf(root).read(serverName)
}

const s256=(verifier:string)=>createHash('sha256').update(verifier).digest('base64url')

// ─── 纯函数 ────────────────────────────────────────────────────────────────────

test('newState 为 128 bit 十六进制且两次不同',()=>{
 const a=newState(),b=newState()
 assert.match(a,/^[0-9a-f]{32}$/)
 assert.notEqual(a,b)
})

test('clientMetadata 为 PKCE public client：token_endpoint_auth_method=none、不含 client_secret',()=>{
 const meta=clientMetadata('http://127.0.0.1:3100/oauth/callback')
 assert.deepEqual(meta,{client_name:'Teloa',redirect_uris:['http://127.0.0.1:3100/oauth/callback'],grant_types:['authorization_code','refresh_token'],response_types:['code'],token_endpoint_auth_method:'none'})
})

test('redirectUrl：本地 loopback 用宿主端口；0.0.0.0 无公开回调时拒绝；publicCallbackUrl 必须 https',()=>{
 assert.equal(redirectUrl(webCtx(3100)),'http://127.0.0.1:3100/oauth/callback')
 assert.throws(()=>redirectUrl(webCtx(3100,'0.0.0.0')),{code:'teloa/invalid-input'})
 assert.equal(redirectUrl(webCtx(3100,'0.0.0.0'),'https://teloa.example.com/oauth/callback'),'https://teloa.example.com/oauth/callback')
 assert.throws(()=>redirectUrl(webCtx(3100),'http://teloa.example.com/oauth/callback'),{code:'teloa/invalid-input'})
 assert.throws(()=>redirectUrl(webCtx(3100),'https://user:pw@teloa.example.com/oauth/callback'),{code:'teloa/invalid-input'})
})

test('assertPublicHttpsUrl：拒绝 http、内网/环回/链路本地地址与 localhost，放行公网 https',()=>{
 for(const bad of['http://mcp.example.com/mcp','https://127.0.0.1/mcp','https://localhost/mcp','https://10.1.2.3/mcp','https://172.16.0.9/mcp','https://192.168.1.1/mcp','https://169.254.169.254/latest','https://[::1]/mcp','https://[fd00::1]/mcp','https://[fe80::1]/mcp','https://[::ffff:10.0.0.1]/mcp','https://0.0.0.0/mcp','https://foo.local/mcp','https://foo.internal/mcp','https://a:b@mcp.example.com/mcp','not a url',
  // 修复轮 1：尾点主机名、IPv4 映射/兼容形态、NAT64、基准测试段、组播
  'https://localhost./mcp','https://foo.internal./mcp','https://[::ffff:127.0.0.1]/mcp','https://[::ffff:7f00:1]/mcp','https://[::7f00:1]/mcp','https://[::127.0.0.1]/mcp',
  'https://[64:ff9b::a00:1]/mcp','https://[64:ff9b::808:808]/mcp','https://198.18.0.1/mcp','https://198.19.255.254/mcp','https://[ff02::1]/mcp','https://[ff0e::1]/mcp',
  // 6to4（2002::/16）与 Teredo（2001::/32）可隧道到任意 IPv4
  'https://[2002:a00:1::1]/mcp','https://[2002:7f00:1::]/mcp','https://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/mcp','https://[2001::1]/mcp']){
  assert.throws(()=>assertPublicHttpsUrl(bad,'测试'),{code:'teloa/invalid-input'},bad)
 }
 assert.doesNotThrow(()=>assertPublicHttpsUrl('https://mcp.supabase.com/mcp','测试'))
 assert.doesNotThrow(()=>assertPublicHttpsUrl('https://8.8.8.8/mcp','测试'))
 assert.doesNotThrow(()=>assertPublicHttpsUrl('https://198.20.0.1/mcp','测试'))
 assert.doesNotThrow(()=>assertPublicHttpsUrl('https://[2606:4700:4700::1111]/mcp','测试'))
 assert.doesNotThrow(()=>assertPublicHttpsUrl('https://[2001:4860:4860::8888]/mcp','测试'))
})

test('redirectUrl：publicCallbackUrl 带 fragment 时拒绝',()=>{
 assert.throws(()=>redirectUrl(webCtx(3100,'0.0.0.0'),'https://teloa.example.com/oauth/callback#x'),{code:'teloa/invalid-input'})
 assert.throws(()=>redirectUrl(webCtx(3100,'0.0.0.0'),'https://teloa.example.com/oauth/callback#'),{code:'teloa/invalid-input'})
})

test('受管 fetch：请求前校验 DNS 全部解析结果，任一落在内网即拒绝且不发请求',async t=>{
 const root=await tempRoot(t)
 let fetched=0
 const fetchFn=async()=>{fetched++;return new Response('{}',{status:404})}
 const lookups:string[]=[]
 const lookup=async(host:string)=>{lookups.push(host);return [{address:'93.184.216.34',family:4},{address:'10.0.0.7',family:4}]}
 const strict=new OAuthFlowManager({runtimeRoot:root,slots:slotsOf(root),fetchFn,lookup})
 await assert.rejects(strict.startFlow(webCtx(3100),'11111111-1111-4111-8111-111111111111',oauthEntry('https://mcp.rebind.example/mcp')),{code:'teloa/invalid-input'})
 assert.equal(fetched,0)
 assert.deepEqual([...new Set(lookups)],['mcp.rebind.example'])
})

// ─── startFlow ────────────────────────────────────────────────────────────────

test('startFlow：DCR 注册 public client 并返回含 PKCE S256/state/resource/scope 的授权链接，pendingFlows 记录 state',async t=>{
 const root=await tempRoot(t)
 const fake=await startFakeAs(t)
 const mgr=makeManager(root)
 const entry=oauthEntry(fake.serverUrl)

 const result=await mgr.startFlow(webCtx(3100),'11111111-1111-4111-8111-111111111111',entry)
 assert.deepEqual(Object.keys(result),['authorizationUrl','state','startUrl'])
 // 宿主授权入口与回调同目录，只带 state
 assert.equal(result.startUrl,`http://127.0.0.1:3100/oauth/start?state=${result.state}`)
 assert.equal(new URL(result.authorizationUrl).searchParams.get('state'),result.state)

 const url=new URL(result.authorizationUrl)
 assert.equal(url.origin+url.pathname,`${fake.origin}/authorize`)
 assert.equal(url.searchParams.get('response_type'),'code')
 assert.equal(url.searchParams.get('client_id'),'dcr-client-1')
 assert.equal(url.searchParams.get('code_challenge_method'),'S256')
 assert.equal(url.searchParams.get('redirect_uri'),'http://127.0.0.1:3100/oauth/callback')
 assert.equal(url.searchParams.get('scope'),'read write')
 assert.equal(url.searchParams.get('resource'),fake.serverUrl)
 const state=url.searchParams.get('state')
 assert.match(state??'',/^[0-9a-f]{32}$/)
 assert.equal(url.searchParams.has('client_secret'),false)

 // DCR 请求体：public client、redirect_uri 严格为本宿主回调
 assert.equal(fake.registerBodies.length,1)
 assert.deepEqual(fake.registerBodies[0]?.redirect_uris,['http://127.0.0.1:3100/oauth/callback'])
 assert.equal(fake.registerBodies[0]?.token_endpoint_auth_method,'none')

 // pending map：state -> {connectionId, codeVerifier, expiresAt}
 const pending=mgr.pendingFlows.get(state!)
 assert.ok(pending)
 assert.equal(pending.connectionId,'11111111-1111-4111-8111-111111111111')
 assert.equal(s256(pending.codeVerifier),url.searchParams.get('code_challenge'))
 assert.ok(pending.expiresAt>Date.now()&&pending.expiresAt<=Date.now()+pendingFlowTtlMs)

 // 凭据槽：client_info 与 AS 元数据缓存写入，无 client_secret
 const cred=await readCredFile(root,'test_oauth')
 assert.ok(cred.oauth_client_info)
 assert.ok(cred.oauth_as_metadata)
 assert.equal(JSON.stringify(cred).includes('client_secret'),false)
})

test('startFlow：同一连接再次发起时旧 state 作废，只保留一个待处理流程',async t=>{
 const root=await tempRoot(t)
 const fake=await startFakeAs(t)
 const mgr=makeManager(root)
 const entry=oauthEntry(fake.serverUrl)
 const first=new URL((await mgr.startFlow(webCtx(3100),'11111111-1111-4111-8111-111111111111',entry)).authorizationUrl).searchParams.get('state')!
 const second=new URL((await mgr.startFlow(webCtx(3100),'11111111-1111-4111-8111-111111111111',entry)).authorizationUrl).searchParams.get('state')!
 assert.notEqual(first,second)
 assert.equal(mgr.pendingFlows.has(first),false)
 assert.equal(mgr.pendingFlows.has(second),true)
 // 已注册过的 client 复用，不重复 DCR
 assert.equal(fake.registerBodies.length,1)
})

test('startFlow：requiresUserClientId=true 时从凭据槽 oauth_client_id 取 client_id、不做 DCR；缺失时报 invalid-input',async t=>{
 const root=await tempRoot(t)
 const fake=await startFakeAs(t)
 const mgr=makeManager(root)
 const entry=oauthEntry(fake.serverUrl,{requiresUserClientId:true})

 await assert.rejects(mgr.startFlow(webCtx(3100),'11111111-1111-4111-8111-111111111111',entry),{code:'teloa/invalid-input'})
 assert.equal(fake.registerBodies.length,0)

 await slotsOf(root).replace('test_oauth',{oauth_client_id:'user-slack-app-id'})
 const {authorizationUrl}=await mgr.startFlow(webCtx(3100),'11111111-1111-4111-8111-111111111111',entry)
 assert.equal(new URL(authorizationUrl).searchParams.get('client_id'),'user-slack-app-id')
 assert.equal(fake.registerBodies.length,0)
 // 用户填写的 client_id 槽保留
 assert.equal((await readCredFile(root,'test_oauth')).oauth_client_id,'user-slack-app-id')
})

test('startFlow：AS 不支持 DCR 且未提供用户 client_id 时报 dependency-unavailable',async t=>{
 const root=await tempRoot(t)
 const fake=await startFakeAs(t)
 fake.registrationEnabled=false
 const mgr=makeManager(root)
 await assert.rejects(mgr.startFlow(webCtx(3100),'11111111-1111-4111-8111-111111111111',oauthEntry(fake.serverUrl)),{code:'teloa/dependency-unavailable'})
})

test('startFlow：默认策略下 http/环回 MCP 地址被 SSRF 防护拒绝，且不发出任何请求',async t=>{
 const root=await tempRoot(t)
 const fake=await startFakeAs(t)
 const strict=new OAuthFlowManager({runtimeRoot:root,slots:slotsOf(root)})
 await assert.rejects(strict.startFlow(webCtx(3100),'11111111-1111-4111-8111-111111111111',oauthEntry(fake.serverUrl)),{code:'teloa/invalid-input'})
 assert.equal(fake.registerBodies.length,0)
})

test('startFlow：AS 元数据里的端点指向内网时拒绝（受管 fetch 逐个校验）',async t=>{
 const root=await tempRoot(t)
 const fake=await startFakeAs(t)
 fake.asMetadataOverride={
  issuer:fake.origin,
  authorization_endpoint:`${fake.origin}/authorize`,
  token_endpoint:`${fake.origin}/token`,
  registration_endpoint:'http://10.0.0.5/register',
  response_types_supported:['code'],
  code_challenge_methods_supported:['S256'],
 }
 const mgr=makeManager(root)
 await assert.rejects(mgr.startFlow(webCtx(3100),'11111111-1111-4111-8111-111111111111',oauthEntry(fake.serverUrl)),{code:'teloa/invalid-input'})
})

test('startFlow：AS 元数据未声明 code_challenge_methods_supported 含 S256 时报 dependency-unavailable',async t=>{
 const root=await tempRoot(t)
 const fake=await startFakeAs(t)
 fake.asMetadataOverride={
  issuer:fake.origin,
  authorization_endpoint:`${fake.origin}/authorize`,
  token_endpoint:`${fake.origin}/token`,
  registration_endpoint:`${fake.origin}/register`,
  response_types_supported:['code'],
 }
 const mgr=makeManager(root)
 await assert.rejects(mgr.startFlow(webCtx(3100),'11111111-1111-4111-8111-111111111111',oauthEntry(fake.serverUrl)),{code:'teloa/dependency-unavailable'})
 assert.equal(mgr.pendingFlows.size,0)
})

test('startFlow：SDK 原生错误统一包成 dependency-unavailable 固定文案，不透出 error_description',async t=>{
 const root=await tempRoot(t)
 const fake=await startFakeAs(t)
 fake.registerMode='error'
 const mgr=makeManager(root)
 await assert.rejects(mgr.startFlow(webCtx(3100),'11111111-1111-4111-8111-111111111111',oauthEntry(fake.serverUrl)),(error:unknown)=>{
  assert.equal((error as {code?:string}).code,'teloa/dependency-unavailable')
  assert.equal(String((error as Error).message).includes('REGISTER-DESC-SECRET'),false)
  return true
 })
})

// ─── handleCallback ───────────────────────────────────────────────────────────

test('handleCallback：未知 state 返回 invalid-state；有效 state 换取令牌写 0600 文件并一次性作废',async t=>{
 const root=await tempRoot(t)
 const fake=await startFakeAs(t)
 const mgr=makeManager(root)
 const entry=oauthEntry(fake.serverUrl)

 assert.deepEqual(await mgr.handleCallback('0'.repeat(32),'good-code'),{kind:'invalid-state'})

 const {authorizationUrl}=await mgr.startFlow(webCtx(3100),'11111111-1111-4111-8111-111111111111',entry)
 const url=new URL(authorizationUrl)
 const state=url.searchParams.get('state')!
 const verifier=mgr.pendingFlows.get(state)!.codeVerifier

 const result=await mgr.handleCallback(state,'good-code')
 assert.deepEqual(result,{kind:'authorized',connectionId:'11111111-1111-4111-8111-111111111111',serverName:'test_oauth'})

 // 令牌请求：PKCE verifier 与授权链接的 challenge 对应，redirect_uri 与 resource 一致
 const tokenReq=fake.tokenBodies[0]!
 assert.equal(tokenReq.get('grant_type'),'authorization_code')
 assert.equal(tokenReq.get('code_verifier'),verifier)
 assert.equal(s256(tokenReq.get('code_verifier')!),url.searchParams.get('code_challenge'))
 assert.equal(tokenReq.get('redirect_uri'),'http://127.0.0.1:3100/oauth/callback')
 assert.equal(tokenReq.get('resource'),fake.serverUrl)
 assert.equal(tokenReq.get('client_id'),'dcr-client-1')
 assert.equal(tokenReq.has('client_secret'),false)

 // 令牌写入凭据槽：expiry 为 ISO 时间
 const cred=await readCredFile(root,'test_oauth')
 assert.equal(cred.oauth_access_token,'AT-first-secret')
 assert.equal(cred.oauth_refresh_token,'RT-first-secret')
 assert.ok(!Number.isNaN(Date.parse(cred.oauth_token_expiry!)))
 const tokens=await readTokens(slotsOf(root),'test_oauth')
 assert.equal(tokens?.accessToken,'AT-first-secret')
 assert.ok(tokens!.expiresAt-Date.now()<=120_000)

 // state 一次性：再用即失效
 assert.equal(mgr.pendingFlows.has(state),false)
 assert.deepEqual(await mgr.handleCallback(state,'good-code'),{kind:'invalid-state'})
})

test('handleCallback：超过 10 分钟的待处理流程被清理并视为 invalid-state',async t=>{
 const root=await tempRoot(t)
 const fake=await startFakeAs(t)
 let now=Date.now()
 const mgr=makeManager(root,{now:()=>now})
 const {authorizationUrl}=await mgr.startFlow(webCtx(3100),'11111111-1111-4111-8111-111111111111',oauthEntry(fake.serverUrl))
 const state=new URL(authorizationUrl).searchParams.get('state')!
 now+=pendingFlowTtlMs+1
 assert.deepEqual(await mgr.handleCallback(state,'good-code'),{kind:'invalid-state'})
 assert.equal(mgr.pendingFlows.size,0)
 assert.equal(fake.tokenBodies.length,0)
})

test('handleCallback：换取失败或用户拒绝时返回脱敏结果，state 同样作废，且不写令牌',async t=>{
 const root=await tempRoot(t)
 const fake=await startFakeAs(t)
 const mgr=makeManager(root)
 const entry=oauthEntry(fake.serverUrl)

 const s1=new URL((await mgr.startFlow(webCtx(3100),'11111111-1111-4111-8111-111111111111',entry)).authorizationUrl).searchParams.get('state')!
 const failed=await mgr.handleCallback(s1,'bad-code-SECRET')
 assert.equal(failed.kind,'exchange-failed')
 assert.equal(failed.kind==='exchange-failed'&&failed.errorMessage,'OAuth 凭据无效或授权码已过期，请重新连接并完成授权。')
 assert.equal(failed.kind==='exchange-failed'&&failed.connectionId,'11111111-1111-4111-8111-111111111111')
 assert.equal(JSON.stringify(failed).includes('SECRET'),false)
 assert.equal(JSON.stringify(failed).includes('bad code'),false)
 assert.equal(mgr.pendingFlows.has(s1),false)
 assert.equal((await readCredFile(root,'test_oauth')).oauth_access_token,undefined)

 const s2=new URL((await mgr.startFlow(webCtx(3100),'11111111-1111-4111-8111-111111111111',entry)).authorizationUrl).searchParams.get('state')!
 const denied=await mgr.handleCallback(s2,undefined,'access_denied')
 assert.equal(denied.kind,'denied')
 assert.equal(denied.kind==='denied'&&denied.errorMessage,'OAuth 授权被取消或拒绝，请重新连接并完成授权。')
 assert.equal(mgr.pendingFlows.has(s2),false)
 assert.equal(fake.tokenBodies.filter(p=>p.get('grant_type')==='authorization_code').length,1)
})

test('handleCallback：client_id 与 AS 元数据取自发起时的 PendingFlow（用户 client_id 优先于残留 DCR 信息，不回读元数据槽）',async t=>{
 const root=await tempRoot(t)
 const fake=await startFakeAs(t)
 const mgr=makeManager(root)
 const entry=oauthEntry(fake.serverUrl,{requiresUserClientId:true})
 await slotsOf(root).replace('test_oauth',{oauth_client_id:'user-app-id',oauth_client_info:JSON.stringify({client_id:'stale-dcr-id',redirect_uri:'http://127.0.0.1:3100/oauth/callback'})})
 const {authorizationUrl}=await mgr.startFlow(webCtx(3100),'11111111-1111-4111-8111-111111111111',entry)
 assert.equal(new URL(authorizationUrl).searchParams.get('client_id'),'user-app-id')
 // 发起后元数据槽被改写/删除，不影响回调
 const cred=await readCredFile(root,'test_oauth')
 delete cred.oauth_as_metadata
 await slotsOf(root).replace('test_oauth',cred)
 const result=await mgr.handleCallback(new URL(authorizationUrl).searchParams.get('state')!,'good-code')
 assert.equal(result.kind,'authorized')
 assert.equal(fake.tokenBodies[0]!.get('client_id'),'user-app-id')
})

// ─── refreshIfNeeded ──────────────────────────────────────────────────────────

test('refreshIfNeeded：过期前 5 分钟内刷新并轮换 refresh_token；未到期跳过；非 connected 跳过',async t=>{
 const root=await tempRoot(t)
 const fake=await startFakeAs(t)
 const mgr=makeManager(root)
 const entry=oauthEntry(fake.serverUrl)
 const state=new URL((await mgr.startFlow(webCtx(3100),'11111111-1111-4111-8111-111111111111',entry)).authorizationUrl).searchParams.get('state')!
 assert.equal((await mgr.handleCallback(state,'good-code')).kind,'authorized')
 // 假 AS 给的 expires_in=120s，处于 5 分钟窗口内
 assert.ok(refreshAheadMs>120_000)

 const conn={id:'11111111-1111-4111-8111-111111111111',serverName:'test_oauth',status:'connected' as const,entry}
 const outcomes=await mgr.refreshIfNeeded([conn,{...conn,id:'22222222-2222-4222-8222-222222222222',serverName:'other',status:'pending-oauth' as const}])
 assert.deepEqual(outcomes,[
  {connectionId:'11111111-1111-4111-8111-111111111111',serverName:'test_oauth',result:'refreshed'},
  {connectionId:'22222222-2222-4222-8222-222222222222',serverName:'other',result:'skipped'},
 ])
 const refreshReq=fake.tokenBodies.find(p=>p.get('grant_type')==='refresh_token')!
 assert.equal(refreshReq.get('refresh_token'),'RT-first-secret')
 assert.equal(refreshReq.get('client_id'),'dcr-client-1')
 assert.equal(refreshReq.get('resource'),fake.serverUrl)

 const cred=await readCredFile(root,'test_oauth')
 assert.equal(cred.oauth_access_token,'AT-second-secret')
 assert.equal(cred.oauth_refresh_token,'RT-second-secret')
 assert.ok(Date.parse(cred.oauth_token_expiry!)-Date.now()>3000_000)

 // 新令牌一小时后到期：再次调用跳过
 assert.deepEqual(await mgr.refreshIfNeeded([conn]),[{connectionId:conn.id,serverName:'test_oauth',result:'skipped'}])
})

test('refreshIfNeeded：refresh_token 失效时结果为 failed，错误消息为固定脱敏文本且不含令牌',async t=>{
 const root=await tempRoot(t)
 const fake=await startFakeAs(t)
 const mgr=makeManager(root)
 const entry=oauthEntry(fake.serverUrl)
 const state=new URL((await mgr.startFlow(webCtx(3100),'11111111-1111-4111-8111-111111111111',entry)).authorizationUrl).searchParams.get('state')!
 assert.equal((await mgr.handleCallback(state,'good-code')).kind,'authorized')
 fake.refreshMode='invalid_grant'

 const [outcome]=await mgr.refreshIfNeeded([{id:'11111111-1111-4111-8111-111111111111',serverName:'test_oauth',status:'connected',entry}])
 assert.deepEqual(outcome,{connectionId:'11111111-1111-4111-8111-111111111111',serverName:'test_oauth',result:'failed',errorMessage:'授权已过期或被吊销，请重新连接并完成 OAuth 授权。'})
 assert.equal(JSON.stringify(outcome).includes('RT-first-secret'),false)
 // 旧令牌不再可用：清除令牌槽，保留 client_info 以便重新授权
 const cred=await readCredFile(root,'test_oauth')
 assert.equal(cred.oauth_access_token,undefined)
 assert.equal(cred.oauth_refresh_token,undefined)
 assert.ok(cred.oauth_client_info)
})

async function connectedManager(t:TestContext,opts:Partial<ConstructorParameters<typeof OAuthFlowManager>[0]>={}){
 const root=await tempRoot(t)
 const fake=await startFakeAs(t)
 const mgr=makeManager(root,opts)
 const entry=oauthEntry(fake.serverUrl)
 const state=new URL((await mgr.startFlow(webCtx(3100),'11111111-1111-4111-8111-111111111111',entry)).authorizationUrl).searchParams.get('state')!
 assert.equal((await mgr.handleCallback(state,'good-code')).kind,'authorized')
 const conn={id:'11111111-1111-4111-8111-111111111111',serverName:'test_oauth',status:'connected',entry}
 return {root,fake,mgr,conn}
}

test('handleCallback：写令牌与同一 serverName 的刷新串行，进行中的刷新完成后才换取授权码',async t=>{
 const order:string[]=[]
 let release=()=>{}
 const released=new Promise<void>(done=>{release=done})
 const fetchFn=async(url:string|URL,init?:RequestInit)=>{
  const body=String(init?.body??'')
  if(body.includes('grant_type=refresh_token')){order.push('refresh-start');await released;order.push('refresh-end')}
  if(body.includes('grant_type=authorization_code'))order.push('exchange')
  return fetch(url,init)
 }
 const {root,mgr,conn}=await connectedManager(t,{fetchFn})
 const state=new URL((await mgr.startFlow(webCtx(3100),conn.id,conn.entry)).authorizationUrl).searchParams.get('state')!
 order.length=0
 const refreshing=mgr.refreshIfNeeded([conn])
 while(!order.includes('refresh-start'))await new Promise(done=>setTimeout(done,5))
 const callback=mgr.handleCallback(state,'good-code')
 await new Promise(done=>setTimeout(done,50))
 assert.deepEqual(order,['refresh-start'],'刷新未完成前回调不得换取令牌')
 release()
 assert.equal((await refreshing)[0]?.result,'refreshed')
 assert.equal((await callback).kind,'authorized')
 assert.deepEqual(order,['refresh-start','refresh-end','exchange'])
 // 回调最后写入：留下的是授权码换得的令牌，而不是被刷新覆盖
 assert.equal((await readTokens(slotsOf(root),'test_oauth'))?.accessToken,'AT-first-secret')
})

test('服务器部署未配置公开回调的提示与计划附录一致（配置文件中）',async t=>{
 const root=await tempRoot(t)
 const mgr=new OAuthFlowManager({runtimeRoot:root,slots:slotsOf(root)})
 const saved=process.env.TELOA_OAUTH_PUBLIC_CALLBACK_URL
 delete process.env.TELOA_OAUTH_PUBLIC_CALLBACK_URL
 t.after(()=>{if(saved!==undefined)process.env.TELOA_OAUTH_PUBLIC_CALLBACK_URL=saved})
 await assert.rejects(mgr.startFlow(webCtx(3100,'0.0.0.0'),'11111111-1111-4111-8111-111111111111',oauthEntry('https://mcp.example.com/mcp')),
  {code:'teloa/invalid-input',message:'服务器部署需在配置文件中设置 oauth.publicCallbackUrl 才能使用 OAuth 授权。'})
})

test('公开回调地址只由调用方传入：被 DSH 从工作区 .env 合入 process.env 的 TELOA_OAUTH_PUBLIC_CALLBACK_URL 不生效',async t=>{
 const root=await tempRoot(t)
 const mgr=new OAuthFlowManager({runtimeRoot:root,slots:slotsOf(root)})
 const saved=process.env.TELOA_OAUTH_PUBLIC_CALLBACK_URL
 process.env.TELOA_OAUTH_PUBLIC_CALLBACK_URL='https://attacker.example/oauth/callback'
 t.after(()=>{if(saved===undefined)delete process.env.TELOA_OAUTH_PUBLIC_CALLBACK_URL;else process.env.TELOA_OAUTH_PUBLIC_CALLBACK_URL=saved})
 await assert.rejects(mgr.startFlow(webCtx(3100,'0.0.0.0'),'11111111-1111-4111-8111-111111111111',oauthEntry('https://mcp.example.com/mcp')),
  {code:'teloa/invalid-input',message:'服务器部署需在配置文件中设置 oauth.publicCallbackUrl 才能使用 OAuth 授权。'})
})

test('refreshIfNeeded：unauthorized_client 时清令牌并 failed',async t=>{
 const {root,fake,mgr,conn}=await connectedManager(t)
 fake.refreshMode='unauthorized_client'
 const [outcome]=await mgr.refreshIfNeeded([conn])
 assert.equal(outcome?.result,'failed')
 assert.equal((await readCredFile(root,'test_oauth')).oauth_refresh_token,undefined)
})

test('refreshIfNeeded：AS 5xx 或网络错误时 skipped 且保留令牌，下轮可重试',async t=>{
 let failNetwork=false
 const {root,fake,mgr,conn}=await connectedManager(t,{fetchFn:async(url,init)=>{if(failNetwork)throw new TypeError('fetch failed');return fetch(url,init)}})
 fake.refreshMode='server_error_500'
 assert.deepEqual(await mgr.refreshIfNeeded([conn]),[{connectionId:conn.id,serverName:'test_oauth',result:'skipped'}])
 assert.equal((await readCredFile(root,'test_oauth')).oauth_refresh_token,'RT-first-secret')
 failNetwork=true
 assert.deepEqual(await mgr.refreshIfNeeded([conn]),[{connectionId:conn.id,serverName:'test_oauth',result:'skipped'}])
 assert.equal((await readCredFile(root,'test_oauth')).oauth_access_token,'AT-first-secret')
 failNetwork=false
 fake.refreshMode='ok'
 assert.equal((await mgr.refreshIfNeeded([conn]))[0]?.result,'refreshed')
})

test('refreshIfNeeded：同一 serverName 并发两次只发一次 refresh 请求；前一次失败不阻塞后续',async t=>{
 const {fake,mgr,conn}=await connectedManager(t)
 const [a,b]=await Promise.all([mgr.refreshIfNeeded([conn]),mgr.refreshIfNeeded([conn])])
 assert.deepEqual([a[0]?.result,b[0]?.result].sort(),['refreshed','skipped'])
 assert.equal(fake.tokenBodies.filter(p=>p.get('grant_type')==='refresh_token').length,1)
})

test('refreshIfNeeded：并发时前一次 5xx 失败不阻塞后续刷新',async t=>{
 const {fake,mgr,conn}=await connectedManager(t)
 fake.refreshMode='server_error_500'
 const first=mgr.refreshIfNeeded([conn])
 const second=mgr.refreshIfNeeded([conn])
 assert.equal((await first)[0]?.result,'skipped')
 assert.equal((await second)[0]?.result,'skipped')
 fake.refreshMode='ok'
 assert.equal((await mgr.refreshIfNeeded([conn]))[0]?.result,'refreshed')
})

test('凭据存储锁定时写令牌抛出锁定错误，不当作写成功',async()=>{
 const locked=()=>{throw new CredentialStoreLocked('key-unavailable')}
 const slots:McpSlotStore={read:async()=>locked(),patch:async()=>locked(),replace:async()=>locked(),remove:async()=>locked(),assertWritable:async()=>locked()}
 await assert.rejects(saveTokens(slots,'locked',{access_token:'AT',token_type:'Bearer'}),{name:'CredentialStoreLocked'})
})

test('refreshOne 遇凭据存储锁定：返回 skipped，不清令牌、不判失败',async t=>{
 const root=await tempRoot(t)
 const fake=await startFakeAs(t)
 const writes:string[]=[]
 const slots:McpSlotStore={
  read:async()=>{throw new CredentialStoreLocked('key-unavailable')},
  patch:async name=>{writes.push(`patch:${name}`)},
  replace:async name=>{writes.push(`replace:${name}`)},
  remove:async name=>{writes.push(`remove:${name}`)},
  assertWritable:async()=>{},
 }
 const mgr=makeManager(root,{slots})
 const conn={id:'11111111-1111-4111-8111-111111111111',serverName:'test_oauth',status:'connected' as const,entry:oauthEntry(fake.serverUrl)}
 assert.deepEqual(await mgr.refreshIfNeeded([conn]),[{connectionId:conn.id,serverName:'test_oauth',result:'skipped'}])
 assert.deepEqual(writes,[])
 assert.equal(fake.tokenBodies.length,0)
})

// ─── 吊销与清理 ───────────────────────────────────────────────────────────────

test('revokeTokens：向 revocation_endpoint 提交 refresh_token；端点不可用时不抛出',async t=>{
 const root=await tempRoot(t)
 const fake=await startFakeAs(t)
 const mgr=makeManager(root)
 const entry=oauthEntry(fake.serverUrl)
 const state=new URL((await mgr.startFlow(webCtx(3100),'11111111-1111-4111-8111-111111111111',entry)).authorizationUrl).searchParams.get('state')!
 assert.equal((await mgr.handleCallback(state,'good-code')).kind,'authorized')

 await mgr.revokeTokens('test_oauth')
 // refresh_token 与 access_token 各吊销一次
 assert.deepEqual(fake.revokeBodies.map(b=>[b.get('token_type_hint'),b.get('token'),b.get('client_id')]).sort(),[['access_token','AT-first-secret','dcr-client-1'],['refresh_token','RT-first-secret','dcr-client-1']])

 // 无令牌 / 无凭据文件：静默
 await mgr.revokeTokens('never_connected')
 assert.equal(fake.revokeBodies.length,2)
})

test('revokeTokens：client_id 取值顺序与刷新一致（用户 client_id 优先于残留 DCR 信息）',async t=>{
 const root=await tempRoot(t)
 const fake=await startFakeAs(t)
 const mgr=makeManager(root)
 await slotsOf(root).replace('test_oauth',{oauth_client_id:'user-app-id',oauth_client_info:JSON.stringify({client_id:'stale-dcr-id',redirect_uri:'http://127.0.0.1:3100/oauth/callback'})})
 const state=new URL((await mgr.startFlow(webCtx(3100),'11111111-1111-4111-8111-111111111111',oauthEntry(fake.serverUrl,{requiresUserClientId:true}))).authorizationUrl).searchParams.get('state')!
 assert.equal((await mgr.handleCallback(state,'good-code')).kind,'authorized')
 await mgr.revokeTokens('test_oauth')
 assert.deepEqual(fake.revokeBodies.map(b=>b.get('client_id')),['user-app-id','user-app-id'])
})

test('handleCallback：连接已不是发起授权的那条（isCurrent 为假）时吊销换得的令牌、不写入凭据，按无效 state 处理',async t=>{
 const root=await tempRoot(t)
 const fake=await startFakeAs(t)
 const mgr=makeManager(root)
 const state=new URL((await mgr.startFlow(webCtx(3100),'11111111-1111-4111-8111-111111111111',oauthEntry(fake.serverUrl))).authorizationUrl).searchParams.get('state')!
 const asked:string[]=[]
 const result=await mgr.handleCallback(state,'good-code',undefined,{isCurrent:async id=>{asked.push(id);return false}})
 assert.deepEqual(result,{kind:'invalid-state'})
 assert.deepEqual(asked,['11111111-1111-4111-8111-111111111111'])
 assert.equal(await readTokens(slotsOf(root),'test_oauth'),undefined)
 assert.deepEqual(fake.revokeBodies.map(b=>`${b.get('token_type_hint')}:${b.get('token')}`).sort(),['access_token:AT-first-secret','refresh_token:RT-first-secret'])
})

test('startFlow：写 AS 元数据与 client 信息纳入令牌锁，锁被占用时不写入',async t=>{
 const root=await tempRoot(t)
 const fake=await startFakeAs(t)
 const mgr=makeManager(root)
 let release!:()=>void
 const held=mgr.exclusive('test_oauth',()=>new Promise<void>(done=>{release=done}))
 const flow=mgr.startFlow(webCtx(3100),'11111111-1111-4111-8111-111111111111',oauthEntry(fake.serverUrl))
 await new Promise(done=>setTimeout(done,200))
 assert.deepEqual(await readCredFile(root,'test_oauth'),{})
 release()
 await held
 await flow
 const cred=await readCredFile(root,'test_oauth')
 assert.ok(cred.oauth_as_metadata)
 assert.ok(cred.oauth_client_info)
})

test('saveTokens / clearOAuthCredentials：无 expires_in 时按 3600 s；清理只移除宿主写入的 oauth_* 槽，保留其他槽与用户 client_id',async t=>{
 const root=await tempRoot(t)
 await slotsOf(root).replace('mixed',{bearer_mixed:'keep-me',oauth_client_id:'user-id'})
 const before=Date.now()
 await saveTokens(slotsOf(root),'mixed',{access_token:'AT',token_type:'Bearer',refresh_token:'RT'})
 const tokens=await readTokens(slotsOf(root),'mixed')
 assert.ok(tokens)
 assert.ok(tokens.expiresAt>=before+3600_000-1000&&tokens.expiresAt<=Date.now()+3600_000)

 await clearOAuthCredentials(slotsOf(root),'mixed')
 assert.deepEqual(await readCredFile(root,'mixed'),{bearer_mixed:'keep-me',oauth_client_id:'user-id'})
 assert.equal(await readTokens(slotsOf(root),'mixed'),undefined)
 // 记录不存在时静默
 await clearOAuthCredentials(slotsOf(root),'absent')
})

// ─── 安全审查修复轮 1：SDK 请求超时 ──────────────────────────────────────────

test('受管 fetch：SDK 请求未带 signal 时补超时 signal；挂起的授权服务器超时后换取失败并释放令牌锁',async t=>{
 const fake=await startFakeAs(t)
 const root=await tempRoot(t)
 const signals:unknown[]=[]
 const fetchFn=async(url:string|URL,init?:RequestInit)=>{
  signals.push(init?.signal)
  // 令牌端点挂起：只有 signal 触发才结束
  if(String(init?.body??'').includes('grant_type=authorization_code'))return new Promise<Response>((_,reject)=>{
   const signal=init?.signal
   if(!signal)return
   signal.addEventListener('abort',()=>reject(signal.reason))
  })
  return fetch(url,init)
 }
 const mgr=makeManager(root,{fetchFn,requestTimeoutMs:100} as never)
 const entry=oauthEntry(fake.serverUrl)
 const state=new URL((await mgr.startFlow(webCtx(3100),'11111111-1111-4111-8111-111111111111',entry)).authorizationUrl).searchParams.get('state')!
 const callback=mgr.handleCallback(state,'good-code')
 const result=await Promise.race([callback,new Promise(done=>setTimeout(()=>done('hung'),3000))])
 assert.ok(signals.length>=3&&signals.every(s=>s instanceof AbortSignal),'发现 / DCR / 换取请求都应带 signal')
 assert.equal((result as {kind?:string}).kind,'exchange-failed')
 assert.equal(await mgr.exclusive('test_oauth',async()=>'free'),'free')
})

// ─── 功能验证 安全专项自查 ──────────────────────────────────────────────────────

test('安全自查：发起 / 回调 / 刷新 / 清理只写凭据存储记录，不再创建一期 0600 凭据文件；清理保留其他槽',async t=>{
 const root=await tempRoot(t)
 const fake=await startFakeAs(t)
 const mgr=makeManager(root)
 const entry=oauthEntry(fake.serverUrl)
 await slotsOf(root).replace('test_oauth',{bearer_x:'keep'})
 const state=new URL((await mgr.startFlow(webCtx(3100),'11111111-1111-4111-8111-111111111111',entry)).authorizationUrl).searchParams.get('state')!
 assert.equal((await mgr.handleCallback(state,'good-code')).kind,'authorized')
 const conn={id:'11111111-1111-4111-8111-111111111111',serverName:'test_oauth',status:'connected' as const,entry}
 assert.equal((await mgr.refreshIfNeeded([conn]))[0]!.result,'refreshed')
 await clearOAuthCredentials(slotsOf(root),'test_oauth')
 assert.equal(existsSync(join(root,'mcp','credentials')),false)
 assert.deepEqual(await readCredFile(root,'test_oauth'),{bearer_x:'keep'})
})

test('安全自查：刷新令牌轮换——AS 回新 refresh_token 时替换旧值，未回时保留旧值（SDK 原样返回，宿主不丢令牌）',async t=>{
 const root=await tempRoot(t)
 const fake=await startFakeAs(t)
 let clock=Date.now()
 const mgr=makeManager(root,{now:()=>clock})
 const entry=oauthEntry(fake.serverUrl)
 const state=new URL((await mgr.startFlow(webCtx(3100),'11111111-1111-4111-8111-111111111111',entry)).authorizationUrl).searchParams.get('state')!
 assert.equal((await mgr.handleCallback(state,'good-code')).kind,'authorized')
 const conn={id:'11111111-1111-4111-8111-111111111111',serverName:'test_oauth',status:'connected' as const,entry}
 assert.equal((await mgr.refreshIfNeeded([conn]))[0]!.result,'refreshed')
 assert.equal((await readCredFile(root,'test_oauth')).oauth_refresh_token,'RT-second-secret')
 // 时间推进到新令牌临期；AS 这次不轮换 refresh_token
 clock+=3600_000-60_000
 fake.refreshMode='no_rotation'
 assert.equal((await mgr.refreshIfNeeded([conn]))[0]!.result,'refreshed')
 const cred=await readCredFile(root,'test_oauth')
 assert.equal(cred.oauth_access_token,'AT-third-secret')
 assert.equal(cred.oauth_refresh_token,'RT-second-secret')
 assert.equal(fake.tokenBodies.filter(p=>p.get('grant_type')==='refresh_token').at(-1)!.get('refresh_token'),'RT-second-secret')
})

test('安全自查：state 为 128 bit 且每次发起不同；授权链接带 S256 challenge，verifier 不出现在链接中；回调一次后 state 作废',async t=>{
 const root=await tempRoot(t)
 const fake=await startFakeAs(t)
 const mgr=makeManager(root)
 const entry=oauthEntry(fake.serverUrl)
 const a=new URL((await mgr.startFlow(webCtx(3100),'11111111-1111-4111-8111-111111111111',entry)).authorizationUrl)
 const b=new URL((await mgr.startFlow(webCtx(3100),'22222222-2222-4222-8222-222222222222',{...entry,connector:{...entry.connector,serverName:'other'}})).authorizationUrl)
 assert.match(a.searchParams.get('state')!,/^[0-9a-f]{32}$/)
 assert.notEqual(a.searchParams.get('state'),b.searchParams.get('state'))
 assert.equal(a.searchParams.get('code_challenge_method'),'S256')
 const flow=mgr.pendingFlows.get(a.searchParams.get('state')!)!
 assert.equal(a.searchParams.get('code_challenge'),s256(flow.codeVerifier))
 assert.ok(!a.toString().includes(flow.codeVerifier))
 assert.equal(a.searchParams.get('redirect_uri'),'http://127.0.0.1:3100/oauth/callback')
 assert.equal((await mgr.handleCallback(a.searchParams.get('state')!,'good-code')).kind,'authorized')
 assert.equal((await mgr.handleCallback(a.searchParams.get('state')!,'good-code')).kind,'invalid-state')
})

// ─── 终审 Low 修复 ─────────────────────────────────────────────────────────────

test('L1 saveTokens 同时写 oauth_token_client_id；刷新与吊销用令牌签发时的 client_id，不受之后 DCR 信息变化影响',async t=>{
 const root=await tempRoot(t)
 const fake=await startFakeAs(t)
 const mgr=makeManager(root)
 const entry=oauthEntry(fake.serverUrl)
 const state=new URL((await mgr.startFlow(webCtx(3100),'11111111-1111-4111-8111-111111111111',entry)).authorizationUrl).searchParams.get('state')!
 assert.equal((await mgr.handleCallback(state,'good-code')).kind,'authorized')
 const cred=await readCredFile(root,'test_oauth')
 assert.equal(cred.oauth_token_client_id,'dcr-client-1')
 // 之后 client 信息被改写（如回调地址变化重新注册）：已签发令牌仍按原 client_id 刷新与吊销
 cred.oauth_client_info=JSON.stringify({client_id:'dcr-client-2',redirect_uri:'http://127.0.0.1:3200/oauth/callback'})
 await slotsOf(root).replace('test_oauth',cred)
 const conn={id:'11111111-1111-4111-8111-111111111111',serverName:'test_oauth',status:'connected' as const,entry}
 assert.equal((await mgr.refreshIfNeeded([conn]))[0]!.result,'refreshed')
 assert.equal(fake.tokenBodies.find(p=>p.get('grant_type')==='refresh_token')!.get('client_id'),'dcr-client-1')
 assert.equal((await readCredFile(root,'test_oauth')).oauth_token_client_id,'dcr-client-1')
 await mgr.revokeTokens('test_oauth')
 assert.deepEqual(fake.revokeBodies.map(b=>b.get('client_id')),['dcr-client-1','dcr-client-1'])
 // 清令牌 / 清凭据一并移除该槽
 await clearOAuthCredentials(slotsOf(root),'test_oauth')
 assert.equal('oauth_token_client_id' in await readCredFile(root,'test_oauth'),false)
})

test('L2 allowedLoopbackOrigin 只放行给定的一个环回 origin：其他端口、localhost 仍被 SSRF 防护拒绝',async t=>{
 const root=await tempRoot(t)
 const fake=await startFakeAs(t)
 const entry=oauthEntry(fake.serverUrl)
 const exact=new OAuthFlowManager({runtimeRoot:root,slots:slotsOf(root),allowedLoopbackOrigin:fake.origin})
 assert.match((await exact.startFlow(webCtx(3100),'11111111-1111-4111-8111-111111111111',entry)).authorizationUrl,/^http:\/\/127\.0\.0\.1:/)
 const port=Number(new URL(fake.origin).port)
 const otherPort=new OAuthFlowManager({runtimeRoot:root,slots:slotsOf(root),allowedLoopbackOrigin:`http://127.0.0.1:${port+1}`})
 await assert.rejects(otherPort.startFlow(webCtx(3100),'11111111-1111-4111-8111-111111111111',entry),{code:'teloa/invalid-input'})
 await assert.rejects(exact.startFlow(webCtx(3100),'11111111-1111-4111-8111-111111111111',oauthEntry(`http://localhost:${port}/mcp`)),{code:'teloa/invalid-input'})
})

test('L3 发现阶段 issuer 须与授权服务器地址规范化后相等（RFC 8414 §3.3），不等则不发起授权；尾斜杠差异视为相等',async t=>{
 const root=await tempRoot(t)
 const fake=await startFakeAs(t)
 const mgr=makeManager(root)
 const metadata=(issuer:string)=>({issuer,authorization_endpoint:`${fake.origin}/authorize`,token_endpoint:`${fake.origin}/token`,registration_endpoint:`${fake.origin}/register`,response_types_supported:['code'],code_challenge_methods_supported:['S256']})
 fake.asMetadataOverride=metadata('https://evil.example.com')
 await assert.rejects(mgr.startFlow(webCtx(3100),'11111111-1111-4111-8111-111111111111',oauthEntry(fake.serverUrl)),(error:Error&{code?:string})=>error.code==='teloa/dependency-unavailable'&&/issuer/.test(error.message))
 assert.equal(mgr.pendingFlows.size,0)
 fake.asMetadataOverride=metadata(fake.origin+'/')
 assert.ok((await mgr.startFlow(webCtx(3100),'11111111-1111-4111-8111-111111111111',oauthEntry(fake.serverUrl))).authorizationUrl)
})

test('browserBound：cookie nonce 不是 32 位小写十六进制时直接 false（含等长多字节值，不因 timingSafeEqual 长度异常抛出）',async t=>{
 const root=await tempRoot(t)
 const fake=await startFakeAs(t)
 const mgr=makeManager(root)
 const {state}=await mgr.startFlow(webCtx(3100),'11111111-1111-4111-8111-111111111111',oauthEntry(fake.serverUrl))
 const nonce=mgr.bindBrowser(state)?.nonce
 assert.match(nonce??'',/^[0-9a-f]{32}$/)
 for(const bad of ['中'.repeat(32),nonce!.toUpperCase(),'g'.repeat(32),nonce!.slice(1),nonce+'0','']){
  assert.equal(mgr.browserBound(state,bad),false,bad)
 }
 assert.equal(mgr.browserBound(state,nonce),true)
})

test('refreshOne：读到令牌、AS 判 invalid_grant，但清令牌遇存储锁定时返回 skipped（不判失败）',async t=>{
 const {root,fake,conn}=await connectedManager(t)
 fake.refreshMode='invalid_grant'
 const inner=slotsOf(root)
 const slots:McpSlotStore={...inner,patch:async()=>{throw new CredentialStoreLocked('document-corrupt')}}
 const mgr=makeManager(root,{slots})
 assert.deepEqual(await mgr.refreshIfNeeded([conn]),[{connectionId:conn.id,serverName:'test_oauth',result:'skipped'}])
 assert.equal(fake.tokenBodies.filter(p=>p.get('grant_type')==='refresh_token').length,1)
 assert.equal((await readCredFile(root,'test_oauth')).oauth_refresh_token,'RT-first-secret')
})

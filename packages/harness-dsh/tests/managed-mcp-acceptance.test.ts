import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import type {AddressInfo} from 'node:net'
import {mkdtemp,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {acceptanceOAuthFixture} from '../src/managed-mcp-acceptance.ts'
import {OAuthFlowManager} from '../src/managed-mcp-oauth.ts'
import {memorySlotStore} from '../src/managed-mcp-credentials.ts'

const url='http://127.0.0.1:43123/mcp'

test('验收夹具：未同时设置 TELOA_BROWSER_ACCEPTANCE=1 与夹具地址时一律不启用（生产路径不受影响）',()=>{
 assert.equal(acceptanceOAuthFixture({}),undefined)
 assert.equal(acceptanceOAuthFixture({TELOA_ACCEPTANCE_MCP_OAUTH_URL:url}),undefined)
 assert.equal(acceptanceOAuthFixture({TELOA_BROWSER_ACCEPTANCE:'true',TELOA_ACCEPTANCE_MCP_OAUTH_URL:url}),undefined)
 assert.equal(acceptanceOAuthFixture({TELOA_BROWSER_ACCEPTANCE:'1'}),undefined)
 assert.equal(acceptanceOAuthFixture({TELOA_ACCEPTANCE_MCP_OAUTH_URL:url})?.entry('acceptance.mcp-business-sync'),undefined)
})

test('持续规则验收来源仅在精确验收开关下提供固定只读 MCP 工具',()=>{
 const fixture=acceptanceOAuthFixture({TELOA_BROWSER_ACCEPTANCE:'1',TELOA_ACCEPTANCE_MCP_OAUTH_URL:url})
 const entry=fixture?.entry('acceptance.mcp-business-sync')
 assert.ok(entry)
 assert.equal(entry.connector.serverName,'acc_business_sync')
 assert.deepEqual(entry.connector.auth,{kind:'none'})
 assert.deepEqual(entry.connector.recipe,{transport:'streamable-http',url})
 assert.deepEqual(entry.connector.tools.map(tool=>[tool.name,tool.readOnly]),[['list_items',true],['list_race_items',true]])
})

test('验收夹具：地址只接受 http://127.0.0.1:<端口>/mcp，其余一律拒绝启动',()=>{
 for(const bad of ['https://mcp.supabase.com/mcp','http://localhost:43123/mcp','http://10.0.0.1:43123/mcp','http://127.0.0.1/mcp','http://127.0.0.1:43123/other','http://user@127.0.0.1:43123/mcp','http://127.0.0.1:43123/mcp?x=1','not a url']){
  assert.throws(()=>acceptanceOAuthFixture({TELOA_BROWSER_ACCEPTANCE:'1',TELOA_ACCEPTANCE_MCP_OAUTH_URL:bad}),/验收/,bad)
 }
})

test('验收夹具：固定两条 OAuth 连接器（DCR 与用户自带 client_id），管理器放行环回授权服务器',()=>{
 const fixture=acceptanceOAuthFixture({TELOA_BROWSER_ACCEPTANCE:'1',TELOA_ACCEPTANCE_MCP_OAUTH_URL:url})
 assert.ok(fixture)
 const dcr=fixture.entry('acceptance.mcp-oauth-dcr'),user=fixture.entry('acceptance.mcp-oauth-user')
 assert.ok(dcr&&user)
 assert.equal(fixture.entry('teloa.mcp-supabase-remote'),undefined)
 assert.deepEqual(dcr.connector.recipe,{transport:'streamable-http',url})
 assert.ok(dcr.connector.auth.kind==='oauth'&&dcr.connector.auth.supported&&!dcr.connector.auth.requiresUserClientId)
 assert.ok(user.connector.auth.kind==='oauth'&&user.connector.auth.supported&&user.connector.auth.requiresUserClientId)
 assert.notEqual(dcr.connector.serverName,user.connector.serverName)
 const slots=memorySlotStore()
 const manager=fixture.createOAuthManager({runtimeRoot:'/tmp/x',slots})
 assert.ok(manager instanceof OAuthFlowManager)
 // 凭据槽原样透传给管理器
 assert.equal((manager as unknown as {slots:unknown}).slots,slots)
})

test('L2 验收夹具管理器只放行夹具那一个 origin：localhost、其他端口的环回地址仍被拒绝（发请求前）',async()=>{
 const fixture=acceptanceOAuthFixture({TELOA_BROWSER_ACCEPTANCE:'1',TELOA_ACCEPTANCE_MCP_OAUTH_URL:url})!
 const manager=fixture.createOAuthManager({runtimeRoot:'/tmp/x',slots:memorySlotStore()})
 const entry=fixture.entry('acceptance.mcp-oauth-dcr')!
 for(const other of ['http://localhost:43123/mcp','http://127.0.0.1:43124/mcp','http://127.0.0.2:43123/mcp']){
  const moved={...entry,connector:{...entry.connector,recipe:{transport:'streamable-http' as const,url:other}}}
  await assert.rejects(manager.startFlow({webServer:{host:'127.0.0.1',port:3100}},'11111111-1111-4111-8111-111111111111',moved),{code:'teloa/invalid-input'},other)
 }
 const source=await readFile(fileURLToPath(new URL('../src/managed-mcp-acceptance.ts',import.meta.url)),'utf8')
 assert.doesNotMatch(source,/insecureAllowLoopbackServers/)
})

test('insecureAllowLoopbackServers 在生产源码中只出现在管理器定义与验收夹具模块，宿主装配只经夹具函数接入',async()=>{
 const index=await readFile(fileURLToPath(new URL('../src/index.ts',import.meta.url)),'utf8')
 assert.doesNotMatch(index,/insecureAllowLoopbackServers/)
 assert.match(index,/acceptanceOAuthFixture\(trusted\)/) // 验收开关只认只读启动快照（launch-env.ts）
})

test('验收夹具管理器：MCP 在放行 origin、但其元数据指向另一端口的环回授权服务器时仍被拒绝，且不向该授权服务器发请求',async t=>{
 const asHits:string[]=[]
 const asServer=createServer((req,res)=>{asHits.push(req.url??'');res.writeHead(404);res.end()})
 await new Promise<void>(done=>asServer.listen(0,'127.0.0.1',done))
 t.after(()=>new Promise<void>(done=>asServer.close(()=>done())))
 const asOrigin=`http://127.0.0.1:${(asServer.address() as AddressInfo).port}`
 const mcpServer=createServer((req,res)=>{
  if(req.url?.startsWith('/.well-known/oauth-protected-resource')){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({resource:mcpUrl,authorization_servers:[asOrigin]}));return}
  res.writeHead(404);res.end()
 })
 await new Promise<void>(done=>mcpServer.listen(0,'127.0.0.1',done))
 t.after(()=>new Promise<void>(done=>mcpServer.close(()=>done())))
 const mcpUrl=`http://127.0.0.1:${(mcpServer.address() as AddressInfo).port}/mcp`
 const fixture=acceptanceOAuthFixture({TELOA_BROWSER_ACCEPTANCE:'1',TELOA_ACCEPTANCE_MCP_OAUTH_URL:mcpUrl})!
 const manager=fixture.createOAuthManager({runtimeRoot:await mkdtemp(join(tmpdir(),'teloa-acc-fixture-')),slots:memorySlotStore()})
 await assert.rejects(manager.startFlow({webServer:{host:'127.0.0.1',port:3100}},'11111111-1111-4111-8111-111111111111',fixture.entry('acceptance.mcp-oauth-dcr')!))
 assert.deepEqual(asHits,[])
 assert.equal(manager.pendingFlows.size,0)
})

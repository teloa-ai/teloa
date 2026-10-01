import test from 'node:test'
import assert from 'node:assert/strict'
import {createManagedMcpConnectionApi} from '../src/client/mcp-connections-api.ts'

const id='12345678-1234-4234-8234-123456789012',stamp='2026-09-25T00:00:00.000Z'
const record=(status:string)=>({id,catalogId:'teloa.mcp-test',serverName:'test_conn',status,createdAt:stamp,updatedAt:stamp})

test('受管 MCP 连接 API：readRecord 接受 pending-oauth，未知状态仍拒绝',async()=>{
 const api=(value:unknown)=>createManagedMcpConnectionApi(async()=>value)
 assert.deepEqual(await api(record('pending-oauth')).get(id),record('pending-oauth'))
 assert.deepEqual(await api(record('saved')).get(id),record('saved'))
 await assert.rejects(api(record('authorized')).get(id),/格式不正确/)
 await assert.rejects(api({items:[record('pending')]}).list(),/格式不正确/)
})

test('受管 MCP 连接 API：oauthStart / oauthStatus 只提交 {id}，回包按白名单解析',async()=>{
 const calls:unknown[][]=[]
 const api=(value:unknown)=>createManagedMcpConnectionApi(async(method,payload)=>{calls.push([method,payload]);return value})
 assert.deepEqual(await api({authorizationUrl:'https://auth.example.com/authorize?state=x'}).oauthStart(id.toUpperCase()),{authorizationUrl:'https://auth.example.com/authorize?state=x'})
 assert.deepEqual(await api({status:'already-connected'}).oauthStart(id),{status:'already-connected'})
 assert.deepEqual(await api({status:'pending-oauth'}).oauthStatus(id),{status:'pending-oauth'})
 assert.deepEqual(await api({status:'connected'}).oauthStatus(id),{status:'connected'})
 assert.deepEqual(await api({status:'error',errorMessage:'授权已过期或被吊销，请重新连接并完成 OAuth 授权。'}).oauthStatus(id),{status:'error',errorMessage:'授权已过期或被吊销，请重新连接并完成 OAuth 授权。'})
 assert.deepEqual(calls,[['mcp-connections/oauth-start',{id}],['mcp-connections/oauth-start',{id}],['mcp-connections/oauth-status',{id}],['mcp-connections/oauth-status',{id}],['mcp-connections/oauth-status',{id}]])
 // 回包白名单：多余字段、非 https 授权地址、未知状态、令牌字段一律拒绝
 await assert.rejects(api({authorizationUrl:'https://auth.example.com/a',accessToken:'x'}).oauthStart(id),/格式不正确/)
 await assert.rejects(api({authorizationUrl:'http://auth.example.com/a'}).oauthStart(id),/格式不正确/)
 // 本地宿主授权入口（下发浏览器绑定 cookie 后跳转授权服务器）：只收 http://127.0.0.1:<端口>/oauth/start?state=<32 位十六进制>
 const local='http://127.0.0.1:3100/oauth/start?state='+'a'.repeat(32)
 assert.deepEqual(await api({authorizationUrl:local}).oauthStart(id),{authorizationUrl:local})
 for(const bad of ['http://localhost:3100/oauth/start?state='+'a'.repeat(32),'http://127.0.0.1:3100/oauth/callback?state='+'a'.repeat(32),'http://127.0.0.1:3100/oauth/start?state=x','http://127.0.0.1/oauth/start?state='+'a'.repeat(32)])await assert.rejects(api({authorizationUrl:bad}).oauthStart(id),/格式不正确/,bad)
 await assert.rejects(api({status:'connected'}).oauthStart(id),/格式不正确/)
 await assert.rejects(api({status:'saved'}).oauthStatus(id),/格式不正确/)
 await assert.rejects(api({status:'pending-oauth',errorMessage:''}).oauthStatus(id),/格式不正确/)
 await assert.rejects(api({status:'connected',accessToken:'x'}).oauthStatus(id),/格式不正确/)
 // id 非 UUID 不发请求
 await assert.rejects(api({status:'connected'}).oauthStart('not-a-uuid'),/id 格式不正确/)
 await assert.rejects(api({status:'connected'}).oauthStatus('not-a-uuid'),/id 格式不正确/)
})

test('受管 MCP 连接 API：add 只提交 catalogId 与凭据；oauth_* 槽只允许用户自带的 oauth_client_id',async()=>{
 const calls:unknown[][]=[]
 const api=createManagedMcpConnectionApi(async(method,payload)=>{calls.push([method,payload]);return record('pending-oauth')})
 await api.add('teloa.mcp-slack',{oauth_client_id:'123.456'})
 await api.add('teloa.mcp-gitlab')
 assert.deepEqual(calls,[['mcp-connections/add',{catalogId:'teloa.mcp-slack',credentials:{oauth_client_id:'123.456'}}],['mcp-connections/add',{catalogId:'teloa.mcp-gitlab'}]])
 for(const key of ['oauth_access_token','oauth_refresh_token','oauth_token_expiry','oauth_client_info','oauth_as_metadata','OAUTH_CLIENT_ID']){
  await assert.rejects(api.add('teloa.mcp-slack',{[key]:'x'}),/密钥字段/,key)
 }
 assert.equal(calls.length,2)
})

test('受管 MCP 连接 API：readRecord 接受 installing 与安装错误码，未知错误码拒绝',async()=>{
 const api=(value:unknown)=>createManagedMcpConnectionApi(async()=>value)
 assert.deepEqual(await api(record('installing')).get(id),record('installing'))
 const failed={...record('error'),errorMessage:'安装超时',errorCode:'install-timeout'}
 assert.deepEqual(await api(failed).get(id),failed)
 assert.deepEqual(await api({...failed,errorCode:'install-failed'}).get(id),{...failed,errorCode:'install-failed'})
 await assert.rejects(api({...failed,errorCode:'other'}).get(id),/格式不正确/)
})

test('受管 MCP 连接 API（规格 2026-09-27 §7.1）：add 原样提交 header / basic 槽键；回包带任何凭据字段即拒绝',async()=>{
 const calls:unknown[][]=[]
 const api=(value:unknown)=>createManagedMcpConnectionApi(async(method,payload)=>{calls.push([method,payload]);return value})
 const credentials={'header_test_conn__x-api-key':'key-12345678',basic_user_test_conn:'alice',basic_pass_test_conn:'pass-12345678'}
 assert.deepEqual(await api(record('saved')).add('teloa.mcp-test',credentials),record('saved'))
 assert.deepEqual(calls,[['mcp-connections/add',{catalogId:'teloa.mcp-test',credentials}]])
 for(const extra of [{credentials},{basic_user_test_conn:'alice'},{'header_test_conn__x-api-key':'key-12345678'}])await assert.rejects(api({...record('saved'),...extra}).add('teloa.mcp-test',credentials),/格式不正确/,JSON.stringify(Object.keys(extra)))
})

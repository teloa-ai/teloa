import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import {mcpCredentialKey} from '../src/managed-mcp-credentials.ts'
import {customMcpAuthorizationFixture as fixture} from './fixtures/custom-mcp-authorization.ts'

test('同定义/权限的空凭据续用不改真实状态及加密槽，原来源身份跨并发与重启保持',{timeout:30000},async t=>{
 const f=await fixture(t),bytes=await readFile(f.statePath,'utf8'),encrypted=await readFile(f.credentialPath,'utf8'),writes=f.writes(),calls=f.seen.length,authority=await f.managed.captureSourceAuthority('reuse_source','read_a')
 await Promise.all([f.authorize(f.managed),f.authorize(f.managed,{},['read_b','read_a'])])
 assert.equal(await readFile(f.statePath,'utf8'),bytes);assert.equal(await readFile(f.credentialPath,'utf8'),encrypted);assert.equal(f.writes(),writes);assert.equal(f.seen.length,calls);assert.equal(f.managed.isConnected('reuse_source'),true)
 assert.equal((await f.managed.captureSourceAuthority('reuse_source','read_a')).bindingKey,authority.bindingKey)
 await f.managed.withSourceAuthority(authority,async verify=>{await verify()})
 f.managed.dispose();await f.ctx.fiber.dispose();const restarted=await f.start();await restarted.managed.restoreConnections()
 assert.equal((await restarted.managed.captureSourceAuthority('reuse_source','read_a')).bindingKey,authority.bindingKey)
 assert.equal(await readFile(f.credentialPath,'utf8'),encrypted);assert.equal(f.writes(),writes)
})

test('真实权限、显式凭据或定义变化仍换来源身份并拒旧授权快照',{timeout:30000},async t=>{
 const f=await fixture(t,'bearer'),first=await f.managed.captureSourceAuthority('reuse_source','read_a'),generation=(await f.state())._customAuthorization.generation
 await f.authorize(f.managed,{},['read_a']);assert.notEqual((await f.state())._customAuthorization.generation,generation)
 await assert.rejects(f.managed.withSourceAuthority(first,async verify=>{await verify()}),{code:'teloa/source-unavailable'})
 await f.managed.handler('mcp-connections/connect',{id:f.saved.id});const permissions=await f.managed.captureSourceAuthority('reuse_source','read_a');assert.notEqual(permissions.bindingKey,first.bindingKey);assert.equal(f.managed.isReadOnlyTool('reuse_source','read_b'),false)
 await f.authorize(f.managed,{bearer:'synthetic-two'},['read_a']);await f.managed.handler('mcp-connections/connect',{id:f.saved.id});const credentials=await f.managed.captureSourceAuthority('reuse_source','read_a');assert.notEqual(credentials.bindingKey,permissions.bindingKey);await assert.rejects(f.managed.withSourceAuthority(permissions,async verify=>{await verify()}),{code:'teloa/source-unavailable'})
 const definition={...f.definition,url:f.definition.url+'/changed'},preview=await f.managed.handler('mcp-connections/preview-custom',{definition}) as {definitionHash:string}
 await f.managed.handler('mcp-connections/update-custom',{id:f.saved.id,requestId:randomUUID(),definition,expectedDefinitionHash:f.preview.definitionHash});await assert.rejects(f.managed.handler('mcp-connections/connect',{id:f.saved.id}));await assert.rejects(f.managed.withSourceAuthority(credentials,async verify=>{await verify()}),{code:'teloa/source-unavailable'})
 await f.authorize(f.managed,{bearer:'synthetic-two'},['read_a'],preview.definitionHash);await f.managed.handler('mcp-connections/connect',{id:f.saved.id});assert.notEqual((await f.managed.captureSourceAuthority('reuse_source','read_a')).bindingKey,credentials.bindingKey)
 assert.doesNotMatch(await readFile(f.credentialPath,'utf8'),/synthetic-one|synthetic-two/)
 const stored=await f.provider.readRecord(mcpCredentialKey('reuse_source'));assert.deepEqual(stored,{kind:'grant',payload:{bearer:'synthetic-two'}})
})

test('Bearer 与静态 Header 的空控件续用保留加密槽和同一授权身份',{timeout:30000},async t=>{
 for(const kind of ['bearer','headers'] as const){
  const f=await fixture(t,kind),before=await readFile(f.statePath,'utf8'),encrypted=await readFile(f.credentialPath,'utf8'),writes=f.writes(),authority=await f.managed.captureSourceAuthority('reuse_source','read_a')
  await f.authorize(f.managed,{},['read_b','read_a'])
  assert.equal((await f.state())._customAuthorization.kind,kind);assert.equal(await readFile(f.statePath,'utf8'),before);assert.equal(await readFile(f.credentialPath,'utf8'),encrypted);assert.equal(f.writes(),writes)
  assert.equal((await f.managed.captureSourceAuthority('reuse_source','read_a')).bindingKey,authority.bindingKey);await f.managed.withSourceAuthority(authority,async verify=>{await verify()})
 }
})

test('无变更续用与真实改权共用原server锁，等待期间不改状态或凭据槽',{timeout:30000},async t=>{
 const f=await fixture(t),before=await readFile(f.statePath,'utf8'),encrypted=await readFile(f.credentialPath,'utf8'),writes=f.writes(),entered=f.holdNextRead(),repeat=f.authorize(f.managed)
 await entered;let changed=false
 const change=f.authorize(f.managed,{},['read_a']).then(value=>{changed=true;return value})
 await new Promise<void>(done=>setTimeout(done,20));assert.equal(changed,false);assert.equal(await readFile(f.statePath,'utf8'),before);assert.equal(await readFile(f.credentialPath,'utf8'),encrypted)
 f.releaseRead();await Promise.all([repeat,change]);assert.equal(f.writes(),writes+1,'仅真实改权落盘一次')
 assert.deepEqual((await f.state())._customAuthorization.readOnlyTools,['read_a']);assert.notEqual(await readFile(f.statePath,'utf8'),before)
})

test('正式断开清除发现工具后仍可读取原授权集合，重开无改动续用，明确撤空才换身份',{timeout:30000},async t=>{
 const f=await fixture(t),authority=await f.managed.captureSourceAuthority('reuse_source','read_a'),authorization=(await f.state())._customAuthorization
 await f.managed.handler('mcp-connections/disconnect',{id:f.saved.id})
 const preview=await f.managed.handler('mcp-connections/get-custom',{id:f.saved.id}) as {authorizationConfigured:boolean;authorizedReadOnlyTools?:string[];connection:{tools?:unknown[]}}
 assert.equal(preview.connection.tools,undefined,'已断开不广告当前工具可用');assert.equal(preview.authorizationConfigured,true);assert.deepEqual(preview.authorizedReadOnlyTools,['read_a','read_b'])
 const bytes=await readFile(f.statePath,'utf8'),encrypted=await readFile(f.credentialPath,'utf8'),writes=f.writes()
 await f.authorize(f.managed,{},preview.authorizedReadOnlyTools);assert.equal(await readFile(f.statePath,'utf8'),bytes);assert.equal(await readFile(f.credentialPath,'utf8'),encrypted);assert.equal(f.writes(),writes)
 await f.managed.handler('mcp-connections/connect',{id:f.saved.id});assert.equal((await f.managed.captureSourceAuthority('reuse_source','read_a')).bindingKey,authority.bindingKey)
 await f.authorize(f.managed,{},[]);assert.notEqual((await f.state())._customAuthorization.generation,authorization.generation)
 const withdrawn=await f.managed.handler('mcp-connections/get-custom',{id:f.saved.id}) as {authorizedReadOnlyTools?:string[]};assert.deepEqual(withdrawn.authorizedReadOnlyTools,[])
 await f.managed.handler('mcp-connections/connect',{id:f.saved.id});assert.equal(f.managed.isReadOnlyTool('reuse_source','read_a'),false);assert.equal(f.managed.isReadOnlyTool('reuse_source','read_b'),false);assert.notEqual((await f.managed.captureSourceAuthority('reuse_source','read_a')).bindingKey,authority.bindingKey)
})

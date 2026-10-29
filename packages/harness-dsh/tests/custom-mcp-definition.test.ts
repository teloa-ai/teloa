import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {mkdtemp,rm,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {Context} from '@deepseek-ai/cordis'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {readCustomMcpDefinition,customMcpDefinitionHash} from '../src/custom-mcp-definition.ts'
import {createManagedMcpConnectionHandler,registerManagedMcpWriteApproval,type ManagedMcpConnectionRecord} from '../src/managed-mcp-connections.ts'
import {memoryCredentialPort} from '../src/managed-mcp-credentials.ts'

const definition={schema:'teloa.mcp-server/v1',serverName:'custom_server',title:'本人 HTTP 连接',transport:'streamable-http',url:'https://example.com/mcp'} as const
test('自定义定义只接受无凭据 HTTP 结构，拒绝秘密、命令和地址认证',()=>{
 const parsed=readCustomMcpDefinition(definition)
 assert.equal(customMcpDefinitionHash(parsed),customMcpDefinitionHash(readCustomMcpDefinition({...definition})))
 for(const value of [{...definition,headers:{Authorization:'secret'}},{...definition,credentials:{key:'secret'}},{...definition,ownerId:'other'},{...definition,transport:'stdio',command:'node'}])assert.throws(()=>readCustomMcpDefinition(value),{code:'teloa/invalid-input'})
})

test('自定义 MCP 允许任意主机的 HTTP/HTTPS，仍拒绝其他协议和地址内凭据',()=>{
 for(const url of ['http://example.com/mcp','http://192.0.2.10:8080/mcp','http://service.internal/mcp','http://localhost:9001/mcp','http://127.0.0.1:9001/mcp','http://[::1]:9001/mcp','https://example.com/mcp']){
  assert.equal(readCustomMcpDefinition({...definition,url}).url,url)
 }
 for(const url of ['ftp://example.com/mcp','file:///tmp/mcp','ws://example.com/mcp','javascript:alert(1)','https://name:password@example.com/mcp','http://name:password@example.com/mcp','http://name@example.com/mcp','http://example.com/mcp?token=secret','https://example.com/mcp?token=secret','http://example.com/mcp#secret']){
  assert.throws(()=>readCustomMcpDefinition({...definition,url}),{code:'teloa/invalid-input'},url)
 }
})

test('真实 HTTP MCP 保存、重试、连接、恢复和断开复用受管生命周期',{timeout:30000},async t=>{
 let requests=0
 const http=createServer(async(req,res)=>{
  requests++
  if(req.method!=='POST'){res.writeHead(405);res.end();return}
  let raw='';for await(const chunk of req)raw+=chunk
  const message=JSON.parse(raw)
  if(message.id===undefined){res.writeHead(202);res.end();return}
  const result=message.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'owned-mcp-fixture',version:'1.0.0'}}:message.method==='tools/list'?{tools:[{name:'update_record',description:'测试写入工具',inputSchema:{type:'object',properties:{},additionalProperties:false}}]}:{content:[{type:'text',text:'ok'}]}
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:message.id,result}))
 })
 await new Promise<void>(resolve=>http.listen(0,'127.0.0.1',resolve))
 t.after(()=>new Promise<void>(resolve=>http.close(()=>resolve())))
 const address=http.address();assert.ok(address&&typeof address!=='string')
 const root=await mkdtemp(join(tmpdir(),'teloa-custom-mcp-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const ctx=new Context();await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime)
 Reflect.set(ctx,'credentials',memoryCredentialPort())
 t.after(()=>ctx.fiber.dispose())
 const managed=createManagedMcpConnectionHandler(ctx,root,()=>undefined);t.after(()=>managed.dispose())
 registerManagedMcpWriteApproval(ctx,managed.writeToolLabel)
 const local=readCustomMcpDefinition({...definition,url:`http://127.0.0.1:${address.port}/mcp`})
 const preview=await managed.handler('mcp-connections/preview-custom',{definition:local}) as {definitionHash:string}
 assert.equal(requests,0,'预览不得联网')
 const payload={requestId:randomUUID(),definition:local,expectedDefinitionHash:preview.definitionHash}
 await assert.rejects(()=>managed.handler('mcp-connections/save-custom',{...payload,expectedDefinitionHash:'a'.repeat(64)}),{code:'teloa/version-conflict'})
 const saved=await managed.handler('mcp-connections/save-custom',payload) as ManagedMcpConnectionRecord
 assert.equal(saved.status,'saved');assert.equal(requests,0,'保存不得联网')
 assert.deepEqual(await managed.handler('mcp-connections/save-custom',payload),saved)
 assert.deepEqual(await managed.handler('mcp-connections/save-custom',{...payload,requestId:randomUUID()}),saved)
 await assert.rejects(()=>managed.handler('mcp-connections/save-custom',{...payload,definition:{...local,title:'不同定义'},expectedDefinitionHash:customMcpDefinitionHash({...local,title:'不同定义'})}),{code:'teloa/conflict'})
 const connected=await managed.handler('mcp-connections/connect',{id:saved.id}) as ManagedMcpConnectionRecord
 assert.equal(connected.status,'connected');assert.ok(requests>0)
 assert.deepEqual(connected.tools,[{name:'update_record',fullName:'mcp__custom_server__update_record',readOnly:false,description:'测试写入工具',inputSchema:{type:'object',properties:{},additionalProperties:false}}])
 assert.match(managed.writeToolLabel('mcp__custom_server__update_record')??'',/update_record/)
 assert.equal(managed.isReadOnlyTool('custom_server','update_record'),false)
 assert.ok(ctx.tools.get('mcp__custom_server__update_record'))
 assert.doesNotMatch(JSON.stringify(connected),/_customDefinition|_credentialsStored|definitionHash|credentials/)
 const stored=JSON.parse(await readFile(join(root,'mcp','connections.json'),'utf8'))
 assert.equal(stored.connections[0]._customDefinition.url,local.url)
 const current=await managed.handler('mcp-connections/get-custom',{id:saved.id}) as {definitionHash:string}
 const changed={...local,title:'修改后的同一连接'}
 const update={id:saved.id,requestId:randomUUID(),definition:changed,expectedDefinitionHash:current.definitionHash}
 await assert.rejects(()=>managed.handler('mcp-connections/update-custom',{...update,expectedDefinitionHash:'a'.repeat(64)}),{code:'teloa/version-conflict'})
 assert.equal(managed.isConnected('custom_server'),true,'过期摘要不得断开原连接')
 const updated=await managed.handler('mcp-connections/update-custom',update) as ManagedMcpConnectionRecord
 assert.equal(updated.id,saved.id);assert.equal(updated.status,'saved');assert.equal(managed.isConnected('custom_server'),false)
 assert.deepEqual(await managed.handler('mcp-connections/update-custom',update),updated)
 await assert.rejects(()=>managed.handler('mcp-connections/update-custom',{...update,requestId:randomUUID()}),{code:'teloa/version-conflict'})
 const fresh=await managed.handler('mcp-connections/get-custom',{id:saved.id}) as {definition:{title:string};definitionHash:string}
 assert.equal(fresh.definition.title,changed.title);assert.notEqual(fresh.definitionHash,current.definitionHash)
 await managed.handler('mcp-connections/connect',{id:saved.id})
 await managed.handler('mcp-connections/disconnect',{id:saved.id})
 assert.equal(ctx.tools.get('mcp__custom_server__update_record'),undefined)
 assert.equal(managed.isConnected('custom_server'),false)
 await managed.handler('mcp-connections/connect',{id:saved.id})
 assert.equal(managed.isConnected('custom_server'),true)
 // 宿主正常退役原客户端但保留 connected 记录，下一实例按同一定义恢复。
 await ctx.fiber.dispose();managed.dispose()
 const restoredCtx=new Context();await restoredCtx.plugin(SystemPrompt);await restoredCtx.plugin(ToolRuntime);Reflect.set(restoredCtx,'credentials',memoryCredentialPort());t.after(()=>restoredCtx.fiber.dispose())
 const restored=createManagedMcpConnectionHandler(restoredCtx,root,()=>undefined);t.after(()=>restored.dispose())
 await restored.restoreConnections()
 assert.equal(restored.isConnected('custom_server'),true)
 assert.ok(restoredCtx.tools.get('mcp__custom_server__update_record'))
 await restored.handler('mcp-connections/delete',{id:saved.id})
 assert.deepEqual(await restored.handler('mcp-connections/list',{}),{items:[]})
})

test('真实连接失败不写 connected，保存定义仍可读并重试',{timeout:15000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'teloa-custom-mcp-failure-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const ctx=new Context();await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);Reflect.set(ctx,'credentials',memoryCredentialPort());t.after(()=>ctx.fiber.dispose())
 const managed=createManagedMcpConnectionHandler(ctx,root,()=>undefined);t.after(()=>managed.dispose())
 const local=readCustomMcpDefinition({...definition,url:'http://127.0.0.1:1/mcp'})
 const saved=await managed.handler('mcp-connections/save-custom',{requestId:randomUUID(),definition:local,expectedDefinitionHash:customMcpDefinitionHash(local)}) as ManagedMcpConnectionRecord
 await assert.rejects(()=>managed.handler('mcp-connections/connect',{id:saved.id}),{code:'teloa/dependency-unavailable'})
 const current=await managed.handler('mcp-connections/get',{id:saved.id}) as ManagedMcpConnectionRecord
 assert.equal(current.status,'error');assert.equal(current.tools,undefined);assert.equal(managed.isConnected('custom_server'),false)
})

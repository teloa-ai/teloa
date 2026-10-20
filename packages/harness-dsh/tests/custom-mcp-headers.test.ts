import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {Context} from '@deepseek-ai/cordis'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {readCustomMcpDefinition} from '@teloa/contract'
import {createManagedMcpConnectionHandler} from '../src/managed-mcp-connections.ts'
import {memoryCredentialPort} from '../src/managed-mcp-credentials.ts'

const base={schema:'teloa.mcp-server/v1',serverName:'headers',title:'本机测试连接',transport:'streamable-http',url:'http://127.0.0.1/mcp'}
test('静态多 Header 严格校验声明，不接收认证值、重复名、危险头、非法前缀或超过8个头',()=>{
 assert.equal(readCustomMcpDefinition({...base,auth:{kind:'headers',headers:[{name:'Authorization',scheme:'Basic'},{name:'X-API-Key'}]}}).auth?.headers.length,2)
 for(const headers of [[],Array.from({length:9},(_,i)=>({name:'X-Key-'+i})),[{name:'X-API-Key'},{name:'x-api-key'}],[{name:'Cookie'}],[{name:'Host'}],[{name:'X-Key',value:'must-not-enter-definition'}],[{name:'Authorization',scheme:'Bearer\r\nX-Other'}]])assert.throws(()=>readCustomMcpDefinition({...base,auth:{kind:'headers',headers}}),{code:'teloa/invalid-input'})
 assert.throws(()=>readCustomMcpDefinition({...base,auth:{kind:'oauth',headers:[{name:'Authorization'}]}}),{code:'teloa/invalid-input'})
})

test('真实 HTTP MCP 双 Header 认证、轮换及重启恢复，旧定义凭据不会发往新地址',async t=>{
 const seen:{authorization:string|undefined;key:string|undefined}[]=[],server=createServer(async(req,res)=>{
  if(req.method!=='POST'){res.writeHead(405).end();return}
  seen.push({authorization:req.headers.authorization,key:req.headers['x-api-key'] as string|undefined})
  if(!req.headers.authorization||!req.headers['x-api-key']){res.writeHead(401).end();return}
  let body='';for await(const chunk of req)body+=chunk
  const message=JSON.parse(body)
  if(message.id===undefined){res.writeHead(202).end();return}
  const result=message.method==='initialize'?{protocolVersion:message.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'header-fixture',version:'1'}}:message.method==='tools/list'?{tools:[{name:'read',inputSchema:{type:'object',properties:{}},annotations:{readOnlyHint:true}}]}:{content:[{type:'text',text:'fixture'}]}
  res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:message.id,result}))
 });await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise<void>(r=>server.close(()=>r())))
 const address=server.address();assert.ok(address&&typeof address!=='string')
 const root=await mkdtemp(join(tmpdir(),'teloa-header-fixture-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const credentials=memoryCredentialPort()
 const context=async()=>{const ctx=new Context();await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);Reflect.set(ctx,'credentials',credentials);return ctx}
 let ctx=await context();t.after(()=>ctx.fiber.dispose())
 let managed=createManagedMcpConnectionHandler(ctx,root,()=>undefined);t.after(()=>managed.dispose())
 const definition={...base,url:'http://127.0.0.1:'+address.port+'/mcp',auth:{kind:'headers',headers:[{name:'Authorization',scheme:'Bearer'},{name:'X-API-Key'}]}}
 const preview=await managed.handler('mcp-connections/preview-custom',{definition}) as {definitionHash:string}
 const saved=await managed.handler('mcp-connections/save-custom',{requestId:randomUUID(),definition,expectedDefinitionHash:preview.definitionHash}) as {id:string}
 const authorize=(key:string)=>managed.handler('mcp-connections/authorize-custom',{id:saved.id,expectedDefinitionHash:preview.definitionHash,credentials:{Authorization:'synthetic-token', 'X-API-Key':key},readOnlyTools:[]})
 await assert.rejects(()=>managed.handler('mcp-connections/connect',{id:saved.id}),{code:'teloa/invalid-input'});assert.equal(seen.length,0)
 await authorize('synthetic-key-one');const connected=await managed.handler('mcp-connections/connect',{id:saved.id})
 assert.ok(seen.length>0);assert.ok(seen.every(row=>row.authorization==='Bearer synthetic-token'&&row.key==='synthetic-key-one'))
 assert.equal(managed.isReadOnlyTool('headers','read'),false,'远端提示不能替代本人的只读确认')
 await authorize('synthetic-key-two');seen.length=0;await managed.handler('mcp-connections/connect',{id:saved.id})
 assert.ok(seen.length>0&&seen.every(row=>row.key==='synthetic-key-two'))
 managed.dispose();await ctx.fiber.dispose();ctx=await context();managed=createManagedMcpConnectionHandler(ctx,root,()=>undefined);seen.length=0;await managed.restoreConnections()
 assert.ok(seen.length>0&&seen.every(row=>row.key==='synthetic-key-two'))
 const restoredCalls=seen.length;await managed.handler('mcp-connections/connect',{id:saved.id});assert.equal(seen.length,restoredCalls,'已恢复的连接不重复发现')
 const state=await readFile(join(root,'mcp/connections.json'),'utf8');assert.doesNotMatch(state+JSON.stringify(connected),/synthetic-token|synthetic-key/)
 await managed.handler('mcp-connections/update-custom',{id:saved.id,requestId:randomUUID(),definition:{...definition,url:definition.url+'/new'},expectedDefinitionHash:preview.definitionHash})
 seen.length=0;await assert.rejects(()=>managed.handler('mcp-connections/connect',{id:saved.id}));assert.equal(seen.length,0)
})

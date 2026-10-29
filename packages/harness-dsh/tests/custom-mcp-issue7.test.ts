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
import {mcpToolFullName,readCustomMcpDefinition,type CustomMcpDefinition} from '@teloa/contract'
import {connectFailureKind,createManagedMcpConnectionHandler,type ManagedMcpConnectionRecord} from '../src/managed-mcp-connections.ts'
import {memoryCredentialPort} from '../src/managed-mcp-credentials.ts'

test('认证规则显式区分全部与任选，缺省保持全部必填',()=>{
 const base={schema:'teloa.mcp-server/v1',serverName:'review',title:'核对服务',transport:'streamable-http',url:'https://example.test/mcp'},headers=[{name:'Authorization',scheme:'Bearer'},{name:'X-API-Key'}]
 assert.equal(readCustomMcpDefinition({...base,auth:{kind:'headers',headers}}).auth?.requirement,undefined)
 assert.equal(readCustomMcpDefinition({...base,auth:{kind:'headers',headers,requirement:'any'}}).auth?.requirement,'any')
 assert.throws(()=>readCustomMcpDefinition({...base,auth:{kind:'headers',headers,requirement:'optional'}}),{code:'teloa/invalid-input'})
 assert.equal(connectFailureKind(new Error('startup failed',{cause:new Error('HTTP 403 secret body')})),'mcp-auth-rejected')
 assert.equal(connectFailureKind(new Error('startup failed',{cause:new Error('ECONNREFUSED')})),'mcp-network-unavailable')
})

test('真实 HTTP 二选一认证、修订恢复、原始工具与只读声明核对，错误回包不泄露秘密',{timeout:30000},async t=>{
 const secret='synthetic-issue7-private-key',seen:{auth?:string;key?:string}[]=[],rawName='audit.events.list_records_with_an_intentionally_long_tool_name',schema={type:'object',properties:{query:{type:'string'}},required:['query']}
 let rejectCode=0,executions=0
 const server=createServer(async(req,res)=>{
  if(req.method!=='POST'){res.writeHead(405).end();return}
  seen.push({...req.headers.authorization?{auth:req.headers.authorization}:{},...req.headers['x-api-key']?{key:String(req.headers['x-api-key'])}:{}})
  if(rejectCode){res.writeHead(rejectCode).end('reflected '+secret);return}
  if(req.headers['x-api-key']!==secret&&req.headers.authorization!=='Bearer '+secret){res.writeHead(401).end();return}
  let text='';for await(const chunk of req)text+=chunk
  const message=JSON.parse(text)
  if(message.id===undefined){res.writeHead(202).end();return}
  if(message.method==='tools/call')executions++
  const result=message.method==='initialize'?{protocolVersion:message.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'issue7',version:'1'}}:message.method==='tools/list'?{tools:[{name:rawName,description:'仅搜索审计事件，query 为查询正文',inputSchema:schema,annotations:{readOnlyHint:true,destructiveHint:false}}]}:{content:[{type:'text',text:'fixture'}]}
  res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:message.id,result}))
 })
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())))
 const address=server.address();assert.ok(address&&typeof address!=='string')
 const root=await mkdtemp(join(tmpdir(),'teloa-mcp-issue7-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const ctx=new Context();await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);Reflect.set(ctx,'credentials',memoryCredentialPort());t.after(()=>ctx.fiber.dispose())
 const managed=createManagedMcpConnectionHandler(ctx,root,()=>undefined);t.after(()=>managed.dispose())
 const definition:CustomMcpDefinition=readCustomMcpDefinition({schema:'teloa.mcp-server/v1',serverName:'review',title:'原审计服务',transport:'streamable-http',url:'http://127.0.0.1:'+address.port+'/mcp',auth:{kind:'headers',requirement:'any',headers:[{name:'Authorization',scheme:'Bearer'},{name:'X-API-Key'}]}})
 const preview=await managed.handler('mcp-connections/preview-custom',{definition}) as {definitionHash:string}
 const saved=await managed.handler('mcp-connections/save-custom',{requestId:randomUUID(),definition,expectedDefinitionHash:preview.definitionHash}) as ManagedMcpConnectionRecord
 await assert.rejects(()=>managed.handler('mcp-connections/authorize-custom',{id:saved.id,expectedDefinitionHash:preview.definitionHash,credentials:{},readOnlyTools:[]}),{code:'teloa/invalid-input'})
 const authorize=(hash:string,readOnlyTools:string[]=[])=>managed.handler('mcp-connections/authorize-custom',{id:saved.id,expectedDefinitionHash:hash,credentials:{'X-API-Key':secret},readOnlyTools})
 await authorize(preview.definitionHash)
 let connected=await managed.handler('mcp-connections/connect',{id:saved.id}) as ManagedMcpConnectionRecord
 assert.ok(seen.length>0&&seen.every(row=>row.key===secret&&row.auth===undefined),'仅发送选中的一种认证')
 assert.deepEqual(connected.tools,[{name:rawName,fullName:mcpToolFullName('review',rawName),readOnly:false,description:'仅搜索审计事件，query 为查询正文',inputSchema:schema,annotations:{readOnlyHint:true,destructiveHint:false}}])
 assert.equal(managed.isReadOnlyTool('review',rawName),false,'服务声明不是本人授权')
 assert.equal(executions,0,'工具核对不执行工具')
 await authorize(preview.definitionHash,[rawName]);connected=await managed.handler('mcp-connections/connect',{id:saved.id}) as ManagedMcpConnectionRecord
 assert.equal(connected.tools?.[0]?.readOnly,true)
 const revised={...definition,title:'新版审计服务'},next=await managed.handler('mcp-connections/preview-custom',{definition:revised}) as {definitionHash:string;savedDefinitionHash:string;connection:ManagedMcpConnectionRecord;authorizationConfigured:boolean}
 assert.equal(next.connection.id,saved.id);assert.equal(next.savedDefinitionHash,preview.definitionHash);assert.notEqual(next.definitionHash,preview.definitionHash);assert.equal(next.authorizationConfigured,false)
 await managed.handler('mcp-connections/update-custom',{id:saved.id,requestId:randomUUID(),definition:revised,expectedDefinitionHash:next.savedDefinitionHash})
 await assert.rejects(()=>managed.handler('mcp-connections/update-custom',{id:saved.id,requestId:randomUUID(),definition,expectedDefinitionHash:preview.definitionHash}),{code:'teloa/version-conflict'})
 await authorize(next.definitionHash)
 for(const status of [401,403]){
  rejectCode=status
  await assert.rejects(()=>managed.handler('mcp-connections/connect',{id:saved.id}),(error:any)=>error.code==='teloa/dependency-unavailable'&&error.details?.reason==='mcp-auth-rejected'&&!JSON.stringify(error).includes(secret))
  const failed=await managed.handler('mcp-connections/get',{id:saved.id}) as ManagedMcpConnectionRecord
  assert.equal(failed.status,'error');assert.match(failed.errorMessage??'',/认证头和前缀/)
 }
 rejectCode=0;await managed.handler('mcp-connections/connect',{id:saved.id})
 assert.doesNotMatch(await readFile(join(root,'mcp/connections.json'),'utf8'),new RegExp(secret))
})

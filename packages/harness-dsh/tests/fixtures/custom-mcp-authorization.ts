import type {TestContext} from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {mkdir,readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {Context} from '@deepseek-ai/cordis'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {createManagedMcpConnectionHandler} from '../../src/managed-mcp-connections.ts'
import TeloaCredentialProvider from '../../src/credentials/provider.ts'
import {memoryKeyring,tempHome} from './credentials.ts'

export async function customMcpAuthorizationFixture(t:TestContext,credentialKind:'none'|'bearer'|'headers'='none'){
 const root=await tempHome(t,'teloa-mcp-reuse-'),home=join(root,'dsh'),runtime=join(root,'runtime'),keyring=memoryKeyring(),deps={keyring:keyring.port,env:{},keyDir:join(root,'keys')},seen:string[]=[]
 const server=createServer(async(req,res)=>{
  if(req.method!=='POST'){res.writeHead(405).end();return}
  let text='';for await(const chunk of req)text+=chunk
  const message=JSON.parse(text);seen.push(message.method)
  if(message.id===undefined){res.writeHead(202).end();return}
  const result=message.method==='initialize'?{protocolVersion:message.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'reuse-fixture',version:'1'}}:message.method==='tools/list'?{tools:['read_a','read_b'].map(name=>({name,inputSchema:{type:'object',properties:{}},annotations:{readOnlyHint:true}}))}:{content:[{type:'text',text:'fixture'}]}
  res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:message.id,result}))
 });await new Promise<void>(done=>server.listen(0,'127.0.0.1',done))
 const cleanup:Array<()=>Promise<void>>=[]
 t.after(async()=>{for(const close of cleanup.reverse())await close();server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()))})
 const address=server.address();assert.ok(address&&typeof address!=='string')
 let held=false,release:()=>void=()=>{},entered:()=>void=()=>{},writes=0
 const start=async()=>{
  await mkdir(home,{recursive:true})
  const ctx=new Context();cleanup.push(async()=>{await ctx.fiber.dispose()});class Provider extends TeloaCredentialProvider{
   constructor(c:Context,config:{dshHome?:string}){super(c,config,deps)}
   override async readRecord(...args:Parameters<TeloaCredentialProvider['readRecord']>){if(held){held=false;entered();await new Promise<void>(done=>{release=done})}return super.readRecord(...args)}
   override async modifyRecord(...args:Parameters<TeloaCredentialProvider['modifyRecord']>){writes++;return super.modifyRecord(...args)}
  }
  await ctx.plugin(Provider,{dshHome:home});await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime)
  const provider=ctx.credentials as TeloaCredentialProvider
  const managed=createManagedMcpConnectionHandler(ctx,runtime,()=>undefined);cleanup.push(async()=>{managed.dispose()})
  return {ctx,provider,managed}
 }
 const initial=await start(),definition={schema:'teloa.mcp-server/v1',serverName:'reuse_source',title:'原只读来源',transport:'streamable-http',url:'http://127.0.0.1:'+address.port+'/mcp',...(credentialKind==='headers'?{auth:{kind:'headers',headers:[{name:'X-API-Key'}]}}:{})},preview=await initial.managed.handler('mcp-connections/preview-custom',{definition}) as {definitionHash:string},saved=await initial.managed.handler('mcp-connections/save-custom',{requestId:randomUUID(),definition,expectedDefinitionHash:preview.definitionHash}) as {id:string}
 const authorize=(managed:typeof initial.managed,credentials:Record<string,string>={},readOnlyTools=['read_a','read_b'],definitionHash=preview.definitionHash)=>managed.handler('mcp-connections/authorize-custom',{id:saved.id,expectedDefinitionHash:definitionHash,credentials,readOnlyTools})
 const initialCredentials:Record<string,string>=credentialKind==='bearer'?{bearer:'synthetic-one'}:credentialKind==='headers'?{'X-API-Key':'synthetic-header'}:{}
 await authorize(initial.managed,initialCredentials);await initial.managed.handler('mcp-connections/connect',{id:saved.id})
 const statePath=join(runtime,'mcp','connections.json'),credentialPath=join(home,'.credentials.enc'),state=async()=>JSON.parse(await readFile(statePath,'utf8')).connections[0] as {_customAuthorization:{generation:string;kind:string;readOnlyTools:string[];definitionHash:string}}
 return {...initial,start,definition,preview,saved,authorize,statePath,credentialPath,state,seen,writes:()=>writes,holdNextRead:()=>{held=true;return new Promise<void>(done=>{entered=done})},releaseRead:()=>release()}
}

import test from'node:test';import assert from'node:assert/strict';import{createServer}from'node:http';import{mkdtemp,rm,readFile}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';import{randomUUID}from'node:crypto';
import{Context}from'@deepseek-ai/cordis';import{ToolRuntime}from'@deepseek-ai/dsh-tools';import{SystemPrompt}from'@deepseek-ai/dsh-system-prompt';
import{createManagedMcpConnectionHandler,type ManagedMcpConnectionRecord}from'../src/managed-mcp-connections.ts';import{memoryCredentialPort}from'../src/managed-mcp-credentials.ts';
test('自定义应用认证进入凭据槽，显式只读清单不由远端声明扩权，定义改变不向新地址发送旧凭据',async t=>{
 const token='synthetic-fixture-token',auths:string[]=[];const http=createServer(async(req,res)=>{
  if(req.method!=='POST'){res.writeHead(405).end();return}
  auths.push(req.headers.authorization??'');if(req.headers.authorization!=='Bearer '+token){res.writeHead(401).end();return}
  const b:Buffer[]=[];for await(const chunk of req)b.push(chunk);const m=JSON.parse(Buffer.concat(b).toString());
  if(m.id===undefined){res.writeHead(202).end();return}
  const result=m.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:m.method==='tools/list'?{tools:['read_logs','delete_logs'].map(name=>({name,inputSchema:{type:'object',properties:{}},annotations:{readOnlyHint:true}}))}:{content:[{type:'text',text:'{"items":[]}'}]};
  res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));
 });await new Promise<void>(r=>http.listen(0,'127.0.0.1',r));t.after(()=>new Promise<void>(r=>http.close(()=>r())));
 const address=http.address();assert.ok(address&&typeof address!=='string');const root=await mkdtemp(join(tmpdir(),'custom-auth-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const ctx=new Context();await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);Reflect.set(ctx,'credentials',memoryCredentialPort());t.after(()=>ctx.fiber.dispose());
 const managed=createManagedMcpConnectionHandler(ctx,root,()=>undefined);t.after(()=>managed.dispose());
 const definition={schema:'teloa.mcp-server/v1',serverName:'owned',title:'日志应用',transport:'streamable-http',url:'http://127.0.0.1:'+address.port+'/mcp'};
 const preview=await managed.handler('mcp-connections/preview-custom',{definition}) as {definitionHash:string};
 const saved=await managed.handler('mcp-connections/save-custom',{requestId:randomUUID(),definition,expectedDefinitionHash:preview.definitionHash}) as ManagedMcpConnectionRecord;
 await managed.handler('mcp-connections/authorize-custom',{id:saved.id,expectedDefinitionHash:preview.definitionHash,credentials:{bearer:token},readOnlyTools:['read_logs']});
 assert.equal(auths.length,0);
 const connected=await managed.handler('mcp-connections/connect',{id:saved.id}) as ManagedMcpConnectionRecord;
 assert.ok(auths.length>0&&auths.every(x=>x==='Bearer '+token));assert.equal(managed.isReadOnlyTool('owned','read_logs'),true);assert.equal(managed.isReadOnlyTool('owned','delete_logs'),false);
 assert.ok(!JSON.stringify(connected).includes(token));assert.ok(!(await readFile(join(root,'mcp/connections.json'),'utf8')).includes(token));
 const next={...definition,url:'http://127.0.0.1:'+address.port+'/different'};
 await managed.handler('mcp-connections/update-custom',{id:saved.id,requestId:randomUUID(),definition:next,expectedDefinitionHash:preview.definitionHash});
 const count=auths.length;await assert.rejects(()=>managed.handler('mcp-connections/connect',{id:saved.id}));assert.equal(auths.length,count);
});

import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Context} from '@deepseek-ai/cordis'
import {PostgreSqlContainer} from '@testcontainers/postgresql'
import {Client} from '@modelcontextprotocol/sdk/client/index.js'
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {initializeTeloaDatabase,RoleService} from '@teloa/backend'
import type {EmployeeApiRuntime} from '@teloa/backend'
import {Pool} from '../../backend/tests/postgres-test-lifecycle.ts'
import {testRoleResponsibility} from '../../backend/tests/role-test-fixture.ts'
import {TeloaClient} from '../../sdk/index.mjs'
import {EmployeeApiError} from '../../sdk/contract.mjs'
import {memoryCredentialPort} from '../src/managed-mcp-credentials.ts'
import {createEmployeeIntegrationHost} from '../src/employee-integration-host.ts'

test('独立员工HTTP/MCP鉴权、SDK和跨协议幂等、权限隔离、密钥轮换及撤销',{timeout:120_000},async t=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock');process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 const container=await new PostgreSqlContainer('postgres:17-alpine').start()
 const pool=new Pool({connectionString:container.getConnectionUri()});let host:ReturnType<typeof createEmployeeIntegrationHost>|undefined,server:ReturnType<typeof createServer>|undefined,mcp:Client|undefined,readMcp:Client|undefined
 t.after(async()=>{await readMcp?.close();await mcp?.close();await host?.close();if(server?.listening)await new Promise<void>(done=>server!.close(()=>done()));await pool.end();await container.stop()})
 await initializeTeloaDatabase(pool)
 const owner='local:'+randomUUID(),role=await new RoleService(pool,{id:randomUUID,now:()=>new Date().toISOString()}).create(owner,{requestId:randomUUID(),fields:{name:'HTTP协议验收岗',kind:'employee',scopes:['general'],duty:'核对本人资料',dataScope:'已授权资料',executionScope:'只读',skills:[],knowledge:[],responsibility:testRoleResponsibility}})
 await pool.query("update teloa_roles set state='active' where id=$1",[role.id]);role.state='active'
 const routes:any[]=[],ctx=new Context(),credentials=memoryCredentialPort()
 Reflect.set(ctx,'credentials',credentials);Reflect.set(ctx,'webServer',{register:(route:any)=>{routes.push(route);return()=>{routes.splice(routes.indexOf(route),1)}}})
 // 这里检验HTTP/协议和持久来源；真实原生执行另在隔离工作台验收，不以此替身冒充。
 const unused=async():Promise<never>=>{throw new EmployeeApiError('service_unavailable','Local protocol fixture does not execute models.',503)}
 const runtime:EmployeeApiRuntime={prepare:unused,start:unused,read:unused,stop:unused,withdraw:unused,result:async()=>undefined}
 host=createEmployeeIntegrationHost(ctx,{owner,pool:async()=>pool,employees:async()=>[role],scopes:async()=>['general'],runtime,admit:run=>Promise.resolve().then(run),report:()=>{}})
 server=createServer((req,res)=>{const path=new URL(req.url!,'http://127.0.0.1').pathname,route=routes.find(r=>r.kind==='exact'?r.path===path:path===r.path||path.startsWith(r.path+'/'));if(route)void route.handler(req,res);else res.writeHead(404).end()})
 await new Promise<void>(done=>server.listen(0,'127.0.0.1',done))
 const origin='http://127.0.0.1:'+(server.address() as {port:number}).port
 const noKey=await fetch(origin+'/api/v1/employees',{headers:{cookie:'startup-token=not-an-integration-key'}});assert.equal(noKey.status,401)
 assert.equal((await (await fetch(origin+'/api/v1/openapi.json')).json()).openapi,'3.1.0')
 const create=(name:string,permissions:string[],webhookUrl?:string)=>host.owner('employee-integrations/create',{name,employeeId:role.id,expectedEmployeeVersion:role.version,scope:'general',permissions,maxConcurrent:2,expiresInDays:7,...webhookUrl?{webhookUrl}:{}}) as Promise<{integration:{id:string};apiKey:string;signingSecret?:string}>
 const issued=await create('业务集成',['read','execute','cancel'],'http://127.0.0.1:1/unused-callback'),readonly=await create('只读集成',['read'])
 assert.equal(issued.signingSecret?.length,43,'按正式CredentialKey规则派生凭据槽，不能直接使用数字开头的UUID')
 assert.equal((await credentials.readRecord(('teloa-employee-api/i'+issued.integration.id.replaceAll('-','')) as never))?.kind,'grant')
 const client=new TeloaClient({baseUrl:origin,apiKey:issued.apiKey}),readClient=new TeloaClient({baseUrl:origin,apiKey:readonly.apiKey})
 assert.equal((await client.listEmployees()).items[0]?.id,role.id)
 const requestId=randomUUID(),input={employeeId:role.id,input:'核对本机测试资料'},work=await client.startWork(input,{requestId})
 await assert.rejects(()=>client.startWork({...input,input:'不同正文'},{requestId}),{code:'idempotency_conflict'})
 await assert.rejects(()=>readClient.getWork(work.id),{code:'not_found'})
 await assert.rejects(()=>readClient.startWork(input,{requestId:randomUUID()}),{code:'forbidden'})
 mcp=new Client({name:'teloa-test',version:'1'},{capabilities:{}})
 await mcp.connect(new StreamableHTTPClientTransport(new URL(origin+'/mcp'),{requestInit:{headers:{authorization:'Bearer '+issued.apiKey}}}) as Parameters<Client['connect']>[0])
 const toolList=await mcp.listTools();assert.equal(toolList.tools.length,7)
 const retry=await mcp.callTool({name:'teloa_start_work',arguments:{...input,requestId}});assert.equal(JSON.parse((retry.content as {text:string}[])[0]!.text).id,work.id)
 readMcp=new Client({name:'readonly',version:'1'},{capabilities:{}})
 await readMcp.connect(new StreamableHTTPClientTransport(new URL(origin+'/mcp'),{requestInit:{headers:{authorization:'Bearer '+readonly.apiKey}}}) as Parameters<Client['connect']>[0])
 assert.ok((await readMcp.listTools()).tools.every(tool=>tool.annotations?.readOnlyHint===true))
 const refused=await readMcp.callTool({name:'teloa_start_work',arguments:{...input,requestId:randomUUID()}});assert.equal(refused.isError,true);assert.equal(JSON.parse((refused.content as {text:string}[])[0]!.text).error.code,'forbidden')
 const headers={authorization:'Bearer '+issued.apiKey}
 assert.equal((await fetch(origin+'/api/v1/employees',{headers:{...headers,origin:'https://unrelated.example'}})).status,403)
 assert.equal((await fetch(origin+'/api/v1/works/'+work.id+'?unknown=true',{headers})).status,400)
 assert.equal((await fetch(origin+'/api/v1/works',{method:'POST',headers:{...headers,'content-type':'application/json','idempotency-key':randomUUID()},body:'x'.repeat(65537)})).status,413)
 const rotated=await host.owner('employee-integrations/rotate',{id:issued.integration.id}) as {apiKey:string}
 await assert.rejects(()=>client.getWork(work.id),{code:'unauthorized'})
 const replacement=new TeloaClient({baseUrl:origin,apiKey:rotated.apiKey});assert.equal((await replacement.getWork(work.id)).id,work.id)
 await host.owner('employee-integrations/revoke',{id:issued.integration.id});await assert.rejects(()=>replacement.getWork(work.id),{code:'unauthorized'})
 assert.equal(await credentials.readRecord(('teloa-employee-api/i'+issued.integration.id.replaceAll('-','')) as never),undefined)
})

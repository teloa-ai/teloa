import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {randomUUID,createHmac} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {TeloaClient,verifyWebhook} from '../index.mjs'
import {EmployeeApiError,employeeApiPermissionModes,employeeApiSchemas,employeeApiOperations,readEmployeeApiRequest} from '../contract.mjs'
const key='teloa_api_'+'a'.repeat(43)
test('SDK真实HTTP传输固定幂等键、不用Cookie、不跟随跳转，错误保留稳定码及请求ID',async t=>{
 const seen=[],id=randomUUID(),requestId=randomUUID(),server=createServer(async(req,res)=>{
  let text='';for await(const chunk of req)text+=chunk
  seen.push({url:req.url,authorization:req.headers.authorization,cookie:req.headers.cookie,idempotency:req.headers['idempotency-key'],body:text?JSON.parse(text):undefined})
  if(req.url.endsWith('/result')){res.writeHead(409,{'content-type':'application/json'}).end(JSON.stringify({error:{code:'result_not_ready',message:'Wait for a result.',requestId}}));return}
  if(req.url.endsWith('/employees')){res.writeHead(302,{location:'http://127.0.0.1:1/should-not-follow'}).end();return}
  res.writeHead(202,{'content-type':'application/json'}).end(JSON.stringify({id}))
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)))
 const client=new TeloaClient({baseUrl:'http://127.0.0.1:'+server.address().port,apiKey:key})
 const input={employeeId:randomUUID(),input:'核对本人提供的资料'}
 assert.deepEqual(await client.startWork(input,{requestId}),{id});await client.startWork(input,{requestId})
 assert.deepEqual(seen[0],seen[1]);assert.equal(seen[0].cookie,undefined);assert.equal(seen[0].idempotency,requestId);assert.deepEqual(seen[0].body,input)
 await assert.rejects(()=>client.getResult(id),error=>error instanceof EmployeeApiError&&error.code==='result_not_ready'&&error.status===409&&error.requestId===requestId)
 await assert.rejects(()=>client.listEmployees(),/fetch failed/)
 for(const bad of ['http://example.test','https://user:password@example.test','https://example.test?token=value'])assert.throws(()=>new TeloaClient({baseUrl:bad,apiKey:key}))
 await assert.rejects(()=>client.startWork({...input,permission:'full'},{requestId}));assert.equal(seen.length,4)
})
test('OpenAPI和MCP共用的请求契约拒绝未知字段与无效版本，不丢失业务原文',async()=>{
 const input={employeeId:randomUUID(),input:'正文\n保留原文'}
 assert.deepEqual(readEmployeeApiRequest('StartWork',input),input)
 const selected={...input,permissionMode:'workspace-write',model:{provider:'custom-provider',model:'example-model',reasoningEffort:'high'}}
 assert.deepEqual(readEmployeeApiRequest('StartWork',selected),selected)
 assert.deepEqual(readEmployeeApiRequest('ContinueWork',{expectedVersion:1,input:'继续',permissionMode:'read-only',model:{provider:'custom-provider',model:'example-model'}}),{expectedVersion:1,input:'继续',permissionMode:'read-only',model:{provider:'custom-provider',model:'example-model'}})
 assert.deepEqual([...employeeApiPermissionModes],['danger-full-access','workspace-write','read-only'])
 for(const body of [{...input,input:''},{...input,scope:'other'},{...input,input:'x'.repeat(6001)},{...input,employeeId:'bad'},{...input,permissionMode:'auto'},{...input,model:{provider:'p',model:'m',apiKey:'secret'}},{...input,model:{provider:'p'}},{...input,permissionMode:'read-only',model:{provider:'p',model:'m',reasoningEffort:'bad effort'}}])assert.throws(()=>readEmployeeApiRequest('StartWork',body))
 assert.throws(()=>readEmployeeApiRequest('ContinueWork',{expectedVersion:0,input:'继续'}))
 assert.equal(employeeApiSchemas.StartWork.required.includes('permissionMode'),false)
 assert.equal(employeeApiSchemas.ContinueWork.required.includes('model'),false)
 const document=JSON.parse(await readFile(new URL('../openapi.json',import.meta.url),'utf8'))
 assert.equal(document.openapi,'3.1.0');assert.deepEqual(document.components.schemas,employeeApiSchemas)
 assert.equal(document.components.schemas.StartWork.properties.permissionMode.enum.includes('danger-full-access'),true)
 assert.equal(document.components.schemas.ContinueWork.properties.model.required.join(','),'provider,model')
 assert.equal(Object.values(document.paths).flatMap(path=>Object.values(path)).length,employeeApiOperations.length)
})
test('回调签名验证原始正文、时间窗口与签名格式，修改或重放过期事件失败',async()=>{
 const secret='synthetic-signing-secret',body=JSON.stringify({id:randomUUID(),specversion:'1.0'}),timestamp=String(Math.floor(Date.now()/1000)),signature='v1='+createHmac('sha256',secret).update(timestamp+'.'+body).digest('hex')
 assert.equal(await verifyWebhook({body,secret,timestamp,signature}),true)
 assert.equal(await verifyWebhook({body:body+' ',secret,timestamp,signature}),false)
 assert.equal(await verifyWebhook({body,secret,timestamp,signature,now:Number(timestamp)*1000+300001}),false)
 assert.equal(await verifyWebhook({body,secret,timestamp,signature:'v1=bad'}),false)
})

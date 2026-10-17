import test from 'node:test'
import assert from 'node:assert/strict'
import {Client} from '@modelcontextprotocol/sdk/client/index.js'
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js'
import {WorkError} from '@teloa/contract'
import * as implementation from '../src/server.ts'

test('只暴露三个窄工具，额外身份字段不能传给宿主',async t=>{
 assert.equal(typeof implementation.createXiaozhiServer,'function')
 const operationId='b3442f0c-4c42-4c2c-b50f-acb0353b019f'
 const calls:string[]=[]
 const server=implementation.createXiaozhiServer({prepare:async text=>{calls.push(text);return {operationId,state:'prepared',speakableText:'已准备',resultRef:null}},submit:async()=>({operationId,state:'pending',speakableText:'正在处理',resultRef:null}),result:async()=>({operationId,state:'completed',speakableText:'已整理完成',resultRef:null})})
 const client=new Client({name:'isolated-hardware-test',version:'1'})
 const [a,b]=InMemoryTransport.createLinkedPair()
 t.after(async()=>{await client.close();await server.close()})
 await server.connect(a);await client.connect(b)
 assert.deepEqual((await client.listTools()).tools.map(x=>x.name),['teloa_request_prepare','teloa_request_submit','teloa_request_result'])
 const rejected=await client.callTool({name:'teloa_request_prepare',arguments:{text:'整理任务',ownerId:'foreign'}})
 assert.equal(rejected.isError,true);assert.deepEqual(calls,[])
 const prepared=await client.callTool({name:'teloa_request_prepare',arguments:{text:'整理任务'}})
 assert.match(JSON.stringify(prepared),/已准备/)
 const result=await client.callTool({name:'teloa_request_result',arguments:{operationId}})
 assert.match(JSON.stringify(result),/已整理完成/)
 const unknown=await client.callTool({name:'shell',arguments:{command:'ls'}})
 assert.equal(unknown.isError,true)
})

test('宿主失败回包不带出秘密和原始异常',async t=>{
 const fail=async()=>{throw new WorkError('teloa/unavailable','private-endpoint-secret')}
 const server=implementation.createXiaozhiServer({prepare:fail,submit:fail,result:fail})
 const client=new Client({name:'failure-test',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair()
 t.after(async()=>{await client.close();await server.close()})
 await server.connect(a);await client.connect(b)
 const reply=await client.callTool({name:'teloa_request_result',arguments:{}})
 assert.equal(reply.isError,true)
 assert.ok(!JSON.stringify(reply).includes('private-endpoint-secret'))
})

for(const initial of ['pending','unknown'] as const)test(`查询在 ${initial} 后等待原结果并固定首次选中的操作`,async t=>{
 const operationId='b3442f0c-4c42-4c2c-b50f-acb0353b019f',ids:(string|undefined)[]=[]
 const fail=async()=>{throw Error('查询不能重新准备或提交')}
 const server=implementation.createXiaozhiServer({prepare:fail,submit:fail,result:async id=>{
  ids.push(id)
  return {operationId,state:ids.length===1?initial:'completed',speakableText:ids.length===1?'正在处理':'原请求的最终答案',resultRef:null}
 }})
 const client=new Client({name:'wait-result-test',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair()
 t.after(async()=>{await client.close();await server.close()})
 await server.connect(a);await client.connect(b)
 const reply=await client.callTool({name:'teloa_request_result',arguments:{}})
 assert.match(JSON.stringify(reply),/原请求的最终答案/)
 assert.deepEqual(ids,[undefined,operationId])
})

test('取消 MCP 查询会结束等候，不取消或重提原工作',async t=>{
 const operationId='b3442f0c-4c42-4c2c-b50f-acb0353b019f'
 let calls=0,started!:()=>void
 const ready=new Promise<void>(resolve=>{started=resolve}),controller=new AbortController()
 const fail=async()=>{throw Error('查询不能重新准备或提交')}
 const server=implementation.createXiaozhiServer({prepare:fail,submit:fail,result:async()=>{calls++;started();return {operationId,state:'pending',speakableText:'正在处理',resultRef:null}}})
 const client=new Client({name:'cancel-result-test',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair()
 t.after(async()=>{await client.close();await server.close()})
 await server.connect(a);await client.connect(b)
 const waiting=client.callTool({name:'teloa_request_result',arguments:{operationId}},undefined,{signal:controller.signal})
 await ready;controller.abort()
 await assert.rejects(waiting)
 await new Promise(resolve=>setTimeout(resolve,300))
 assert.equal(calls,1)
})

test('原工作持续进行时在有界等候后如实返回，不伪造完成', {timeout:10000},async t=>{
 const operationId='b3442f0c-4c42-4c2c-b50f-acb0353b019f'
 let reads=0
 const fail=async()=>{throw Error('查询不能重新准备或提交')}
 const server=implementation.createXiaozhiServer({prepare:fail,submit:fail,result:async()=>{reads++;return {operationId,state:'pending',speakableText:'仍在处理',resultRef:null}}})
 const client=new Client({name:'bounded-result-test',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair()
 t.after(async()=>{await client.close();await server.close()})
 await server.connect(a);await client.connect(b)
 const start=performance.now(),reply=await client.callTool({name:'teloa_request_result',arguments:{operationId}})
 assert.ok(performance.now()-start>=7900)
 assert.match(JSON.stringify(reply),/仍在处理/)
 assert.ok(reads>1)
})

test('查询拒绝不同操作的结果，原审批直接返回',async t=>{
 const operationId='b3442f0c-4c42-4c2c-b50f-acb0353b019f',foreignId='9119c713-bb4f-44f8-95ae-011c478fae2e'
 let foreign=true,reads=0
 const fail=async()=>{throw Error('查询不能重新准备或提交')}
 const server=implementation.createXiaozhiServer({prepare:fail,submit:fail,result:async()=>{reads++;return {operationId:foreign?foreignId:operationId,state:foreign?'completed':'needs_approval',speakableText:foreign?'不能外发的另一条结果':'请在 Teloa 审批',resultRef:null}}})
 const client=new Client({name:'fixed-result-test',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair()
 t.after(async()=>{await client.close();await server.close()})
 await server.connect(a);await client.connect(b)
 const reply=await client.callTool({name:'teloa_request_result',arguments:{operationId}})
 assert.equal(reply.isError,true);assert.ok(!JSON.stringify(reply).includes('不能外发的另一条结果'))
 foreign=false
 assert.match(JSON.stringify(await client.callTool({name:'teloa_request_result',arguments:{operationId}})),/请在 Teloa 审批/)
 assert.equal(reads,2)
})

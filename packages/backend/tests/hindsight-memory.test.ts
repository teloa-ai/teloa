import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {HindsightMemoryProvider} from '../src/work/hindsight-memory.ts'

test('Retain 使用固定操作身份和文档来源；Recall 与 operation 核验服务响应',async t=>{
 const requests:{path:string;body:any;authorization:string|undefined}[]=[]
 const server=createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk
  requests.push({path:req.url!,body:raw?JSON.parse(raw):null,authorization:req.headers.authorization})
  res.setHeader('content-type','application/json')
  if(req.url!.endsWith('/recall'))res.end(JSON.stringify({results:[{id:'fact-1',text:'核对部署版本',type:'experience',document_id:'memory-1'}]}))
  else if(req.method==='GET')res.end(JSON.stringify({operation_id:'op-1',status:'completed'}))
  else res.end(JSON.stringify({success:true,bank_id:'bank-1',items_count:1,async:true,operation_id:'op-1'}))
 })
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())))
 const endpoint=`http://127.0.0.1:${(server.address() as {port:number}).port}`
 const client=new HindsightMemoryProvider({endpoint,token:'test-token',timeoutMs:1000})
 await client.retain('bank-1','op-1',[{documentId:'memory-1',content:'先核对部署版本',metadata:{memoryId:'memory-1'}}])
 assert.equal(await client.operation('bank-1','op-1'),'completed')
 assert.deepEqual(await client.recall('bank-1','如何部署？'),[{id:'fact-1',text:'核对部署版本',type:'experience',documentId:'memory-1',sourceFactIds:[]}])
 assert.equal(requests[0]!.body.operation_id,'op-1')
 assert.equal(requests[0]!.body.async,true)
 assert.equal(requests[0]!.body.items[0].document_id,'memory-1')
 assert.equal(requests[0]!.authorization,'Bearer test-token')
 assert.equal(requests[2]!.body.max_tokens,2048)
 assert.deepEqual(requests[2]!.body.types,['world','experience','observation'])
})

test('远端 HTTP、URL 凭据、query 和无效配置被拒绝；明确容器私网许可可用',()=>{
 for(const endpoint of ['http://example.com','https://user:pass@example.com','https://example.com?token=secret','file:///tmp/memory'])assert.throws(()=>new HindsightMemoryProvider({endpoint}))
 assert.doesNotThrow(()=>new HindsightMemoryProvider({endpoint:'http://hindsight:8888',allowHttp:true}))
 assert.throws(()=>new HindsightMemoryProvider({endpoint:'https://example.com',timeoutMs:0}))
})

test('错误身份、服务失败、重定向和异常来源不会成为记忆',async()=>{
 const responses=[
  new Response(JSON.stringify({success:true,bank_id:'other',operation_id:'op'})),
  new Response('secret upstream error',{status:500}),
  new Response(null,{status:302,headers:{location:'https://other.example'}}),
 ]
 for(const response of responses){
  const client=new HindsightMemoryProvider({endpoint:'https://example.com',fetch:async(_url,init)=>{assert.equal(init?.redirect,'error');return response}})
  await assert.rejects(client.retain('bank','op',[]),error=>error instanceof Error&&!error.message.includes('secret upstream'))
 }
 const client=new HindsightMemoryProvider({endpoint:'https://example.com',fetch:async()=>new Response(JSON.stringify({results:[{id:'a',text:123,type:'world',document_id:'x'}]}))})
 await assert.rejects(client.recall('bank','query'))
})

test('操作响应身份和事实类型必须匹配，正文受总量限制',async()=>{
 const transport=(body:unknown)=>async()=>new Response(JSON.stringify(body))
 await assert.rejects(new HindsightMemoryProvider({endpoint:'https://example.com',fetch:transport({operation_id:'other',status:'completed'})}).operation('bank','op'))
 await assert.rejects(new HindsightMemoryProvider({endpoint:'https://example.com',fetch:transport({results:[{id:'a',text:'text',type:'instruction'}]})}).recall('bank','query'))
 await assert.rejects(new HindsightMemoryProvider({endpoint:'https://example.com',fetch:transport({results:[{id:'a',text:'x'.repeat(1024*1024),type:'world'}]})}).recall('bank','query'))
})

test('调用方取消在网络请求前生效',async()=>{
 let called=false
 const client=new HindsightMemoryProvider({endpoint:'https://example.com',fetch:async()=>{called=true;return new Response('{}')}})
 const abort=new AbortController();abort.abort()
 await assert.rejects(client.recall('bank','query',abort.signal))
 assert.equal(called,false)
})

test('操作不存在可重提同一操作；鉴权失败不能冒充不存在',async()=>{
 const absent=new HindsightMemoryProvider({endpoint:'https://example.com',fetch:async()=>new Response('not found',{status:404})})
 assert.equal(await absent.operation('bank','op'),'not_found')
 const denied=new HindsightMemoryProvider({endpoint:'https://example.com',fetch:async()=>new Response('denied',{status:401})})
 await assert.rejects(denied.operation('bank','op'))
})

test('真实 HTTP 的响应正文停滞也受超时限制',async t=>{
 const server=createServer((_req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.write('{')})
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
 t.after(()=>{server.closeAllConnections();return new Promise<void>(resolve=>server.close(()=>resolve()))})
 const client=new HindsightMemoryProvider({endpoint:`http://127.0.0.1:${(server.address() as {port:number}).port}`,timeoutMs:50})
 const started=Date.now();await assert.rejects(client.recall('bank','query'));assert.ok(Date.now()-started<1000)
})

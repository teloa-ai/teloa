import test from 'node:test'
import assert from 'node:assert/strict'
import {createMiniMaxModelHttp} from '../src/minimax-model-http.ts'

test('只为MiniMax模型使用宿主连接池，保留请求正文、凭据头、取消信号与流式响应',async()=>{
 const dispatcher={async close(){}},seen:unknown[][]=[];let created=0,fallback=0
 const response=new Response('synthetic-stream'),transport=createMiniMaxModelHttp({agent:()=>{created++;return dispatcher},route:()=>({proxied:false}) as never,send:async(...args)=>{seen.push(args);return response},fallback:async()=>{fallback++;return new Response('original')}})
 assert.equal(transport.forProvider('other-vendor'),undefined)
 const send=transport.forProvider('minimax')!,control=new AbortController(),headers={authorization:'Bearer synthetic-key'},body='{"model":"MiniMax-M3"}'
 assert.equal(await send('https://api.minimax.io/anthropic/v1/messages',{method:'POST',headers,body,signal:control.signal}),response)
 const options=seen[0]![1] as RequestInit&{dispatcher:unknown}
 assert.equal(options.headers,headers);assert.equal(options.body,body);assert.equal(options.signal,control.signal);assert.equal(options.dispatcher,dispatcher)
 await send('https://api.minimax.io/v1/responses',{method:'POST',signal:control.signal})
 assert.equal(created,1);assert.equal(seen.length,2)
 for(const url of ['https://api.minimax.io/v1/t2a_v2','https://api.minimax.io/v1/files','https://other.test/anthropic/v1/messages','http://api.minimax.io/anthropic/v1/messages'])await send(url)
 await send(new Request('https://api.minimax.io/anthropic/v1/messages'))
 await send('https://api.minimax.io/anthropic/v1/messages',{method:'POST',body:new Uint8Array([1])})
 assert.equal(fallback,6);assert.equal(seen.length,2,'语音、文件、Request及非JSON流保留原始消费语义')
 await transport.close()
})

test('官方代理路由保持不变，不创建直连池或关闭共享代理；信号仍由原工作拥有',async()=>{
 const dispatcher={},control=new AbortController();let calls=0
 const transport=createMiniMaxModelHttp({route:()=>({proxied:true,dispatcher}) as never,agent:()=>{throw Error('代理路径不得直连')},send:async(_input,init)=>{
  calls++;assert.equal((init as RequestInit&{dispatcher:unknown}).dispatcher,dispatcher);assert.equal(init?.signal,control.signal)
  init?.signal?.throwIfAborted();return new Response('proxied')
 }})
 const send=transport.forProvider('minimax')!
 await send('https://api.minimax.io/v1/chat/completions',{signal:control.signal})
 control.abort();await assert.rejects(send('https://api.minimax.io/v1/chat/completions',{signal:control.signal}))
 assert.equal(calls,2);await transport.close()
})

test('宿主关闭后不重新建连，已捕获的模型传输不能复活，重复关闭只回收一次',async()=>{
 let closed=0,sent=0
 const transport=createMiniMaxModelHttp({route:()=>({proxied:false}) as never,agent:()=>({async close(){closed++}}),send:async()=>{sent++;return new Response('once')}})
 const send=transport.forProvider('minimax')!
 await send('https://api.minimax.io/anthropic/v1/messages');await transport.close();await transport.close()
 assert.equal(closed,1);assert.equal(transport.forProvider('minimax'),undefined)
 await assert.rejects(send('https://api.minimax.io/anthropic/v1/messages'),{code:'teloa/host-unavailable'});assert.equal(sent,1)
})

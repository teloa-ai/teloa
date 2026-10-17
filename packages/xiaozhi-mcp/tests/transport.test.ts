import test from 'node:test'
import assert from 'node:assert/strict'
import {once} from 'node:events'
import {WebSocket,WebSocketServer} from 'ws'
import {Client} from '@modelcontextprotocol/sdk/client/index.js'
import * as implementation from '../src/index.ts'
import * as transports from '../src/transport.ts'

test('电脑主动连接接入点，停止后不重连，协议和工具通过真实 WebSocket',async t=>{
 assert.equal(typeof implementation.createXiaozhiBridge,'function')
 const wsServer=new WebSocketServer({host:'127.0.0.1',port:0})
 await once(wsServer,'listening')
 t.after(()=>new Promise<void>(resolve=>wsServer.close(()=>resolve())))
 const address=wsServer.address();assert.ok(address&&typeof address!=='string')
 const peer=new Promise<Client>(resolve=>wsServer.once('connection',async socket=>{
  const client=new Client({name:'local-cloud-protocol-test',version:'1'})
  await client.connect(transports.createSocketTransport(socket));resolve(client)
 }))
 let connects=0
 const states:string[]=[]
 const bridge=implementation.createXiaozhiBridge({endpoint:async()=> 'wss://api.xiaozhi.me/mcp/?token=private-test-secret',connect:()=>{connects++;return new WebSocket(`ws://127.0.0.1:${address.port}`)},requests:{prepare:async()=>{throw Error('unused')},submit:async()=>{throw Error('unused')},result:async()=>({operationId:'b3442f0c-4c42-4c2c-b50f-acb0353b019f',state:'completed',speakableText:'测试任务已完成',resultRef:null})},onStatus:state=>states.push(state)})
 t.after(()=>bridge.stop())
 bridge.start()
 const client=await peer;t.after(()=>client.close())
 const reply=await client.callTool({name:'teloa_request_result',arguments:{}})
 assert.match(JSON.stringify(reply),/测试任务已完成/)
 assert.ok(states.includes('ready'))
 await bridge.stop()
 assert.equal(connects,1);assert.equal(states.at(-1),'stopped')
})

test('停止后重新启用，旧世代的接入点读取失败不能覆盖新连接',async t=>{
 const wsServer=new WebSocketServer({host:'127.0.0.1',port:0})
 await once(wsServer,'listening')
 const address=wsServer.address();assert.ok(address&&typeof address!=='string')
 const peer=new Promise<Client>(resolve=>wsServer.once('connection',async socket=>{
  const client=new Client({name:'generation-test',version:'1'})
  await client.connect(transports.createSocketTransport(socket));resolve(client)
 }))
 let rejectFirst!:(error:Error)=>void,reads=0
 const initial=new Promise<string>((_resolve,reject)=>{rejectFirst=reject})
 const bridge=implementation.createXiaozhiBridge({
  endpoint:async()=>++reads===1?initial:'wss://api.xiaozhi.me/mcp/?token=test',
  connect:()=>new WebSocket(`ws://127.0.0.1:${address.port}`),
  requests:{prepare:async()=>{throw Error('unused')},submit:async()=>{throw Error('unused')},result:async()=>{throw Error('unused')}},
 })
 let client:Client|undefined
 t.after(async()=>{await bridge.stop();await client?.close();await new Promise<void>(resolve=>wsServer.close(()=>resolve()))})
 bridge.start();await bridge.stop();bridge.start()
 client=await peer
 await client.listTools()
 assert.equal(bridge.state,'ready')
 rejectFirst(new Error('旧连接读取失败'))
 await new Promise(resolve=>setImmediate(resolve))
 assert.equal(bridge.state,'ready')
})

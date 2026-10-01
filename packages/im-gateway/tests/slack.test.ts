import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createSlackAdapter} from '../src/channels/slack.ts'
import type {ImInbound} from '../src/core/types.ts'

const envelopes=JSON.parse(readFileSync(new URL('./fixtures/slack-envelopes.json',import.meta.url),'utf8')) as Record<string,Record<string,unknown>>
const botToken='xoxb-TEST-bot-token'
const appToken='xapp-1-TEST-app-token'
const socketUrl='wss://wss-primary.slack.com/link/?ticket=TEST-ticket&app_id=A0TEST'

type Reply={status?:number;headers?:Record<string,string>;body:Record<string,unknown>}|'network'
type Call={method:string;auth:string;body:Record<string,unknown>}

/** 本地假 Slack Web API：拦截 deps.fetch，只认 https://slack.com/api/<method>；队列耗尽时回默认成功体。 */
function fakeSlack(routes:Record<string,Reply[]>){
 const calls:Call[]=[]
 const defaults:Record<string,Record<string,unknown>>={
  'auth.test':{ok:true,user_id:'UBOT',team_id:'T0TEST'},
  'apps.connections.open':{ok:true,url:socketUrl},
  'chat.postMessage':{ok:true,channel:'C0CHAN001',ts:'1790000020.001000'},
  'chat.update':{ok:true,channel:'C0CHAN001',ts:'1790000020.001000'},
 }
 const fetchImpl=(async(input:string|URL|Request,init?:RequestInit)=>{
  const url=new URL(String(input))
  assert.equal(url.origin,'https://slack.com')
  const match=/^\/api\/([\w.]+)$/.exec(url.pathname)
  assert.ok(match)
  const method=match[1]!
  const auth=new Headers(init?.headers).get('authorization')??''
  calls.push({method,auth,body:JSON.parse(String(init?.body??'{}')) as Record<string,unknown>})
  const reply=routes[method]?.shift()
  if(reply==='network')throw new TypeError(`fetch failed ${url.href}`)
  return Response.json(reply?.body??defaults[method]??{ok:true},{status:reply?.status??200,...(reply?.headers?{headers:reply.headers}:{})})
 }) as typeof fetch
 return {calls,fetchImpl}
}

type Order=string[]
/** 假 WebSocket：记录实例与 send；测试手动触发 onopen/onmessage/onclose。 */
function fakeSocketClass(order:Order){
 const instances:FakeSocket[]=[]
 class FakeSocket{
  onopen:((ev:unknown)=>void)|null=null
  onmessage:((ev:{data:unknown})=>void)|null=null
  onclose:((ev:{code:number})=>void)|null=null
  onerror:((ev:unknown)=>void)|null=null
  readonly url:string
  readonly sent:string[]=[]
  closed:number|undefined
  constructor(url:string){
   this.url=url
   instances.push(this)
  }
  send(data:string){
   this.sent.push(data)
   order.push(`send:${data}`)
  }
  close(code=1000){
   this.closed=code
  }
  deliver(envelope:unknown){
   this.onmessage?.({data:JSON.stringify(envelope)})
  }
 }
 return {instances,FakeSocket}
}

const tick=()=>new Promise(resolve=>setImmediate(resolve))
async function until(check:()=>boolean,limit=200):Promise<void>{
 for(let i=0;i<limit&&!check();i+=1)await tick()
 assert.ok(check(),'等待条件超时')
}

function harness(routes:Record<string,Reply[]>={},env:Record<string,string>={SLACK_BOT_TOKEN:botToken,SLACK_APP_TOKEN:appToken}){
 const slack=fakeSlack(routes)
 const order:Order=[]
 const sockets=fakeSocketClass(order)
 const sleeps:number[]=[]
 const logs:string[]=[]
 const got:ImInbound[]=[]
 const adapter=createSlackAdapter({
  env:async()=>env,
  log:{info:(f,...v)=>logs.push([f,...v].join(' ')),warn:(f,...v)=>logs.push([f,...v].join(' '))},
  now:()=>new Date('2026-09-26T00:00:00Z'),
  fetch:slack.fetchImpl,
  WebSocketImpl:sockets.FakeSocket as unknown as typeof WebSocket,
  sleep:ms=>{sleeps.push(ms);return new Promise(resolve=>setImmediate(resolve))},
 })
 const handler=async(m:ImInbound)=>{
  order.push(`handler:${m.messageId}`)
  got.push(m)
 }
 const opens=()=>slack.calls.filter(call=>call.method==='apps.connections.open').length
 return {...slack,...sockets,order,sleeps,logs,got,adapter,handler,opens}
}

async function connected(h:ReturnType<typeof harness>,count=1){
 await h.adapter.start(h.handler)
 await until(()=>h.instances.length>=count)
 const socket=h.instances.at(-1)!
 socket.onopen?.({})
 socket.deliver(envelopes.hello)
 return socket
}

test('启动：auth.test 用 bot token、apps.connections.open 用 app token，按返回的 wss 地址建连',async()=>{
 const h=harness()
 const socket=await connected(h)
 assert.deepEqual(h.calls.map(call=>call.method),['auth.test','apps.connections.open'])
 assert.equal(h.calls[0]!.auth,`Bearer ${botToken}`)
 assert.equal(h.calls[1]!.auth,`Bearer ${appToken}`)
 assert.equal(socket.url,socketUrl)
 assert.equal(h.adapter.status().connected,true)
 assert.equal(socket.sent.length,0,'hello 无 envelope_id，不 ack')
 await h.adapter.stop()
 assert.equal(h.adapter.status().connected,false)
 assert.equal(socket.closed,1000)
})

test('1. 任意 envelope 先 ack {envelope_id}，再调用 handler',async()=>{
 const h=harness()
 const socket=await connected(h)
 socket.deliver(envelopes.im)
 socket.deliver(envelopes.blockActions)
 socket.deliver(envelopes.botMessage)
 await until(()=>h.got.length===2)
 assert.deepEqual(h.order,[
  'send:{"envelope_id":"env-im-1"}',
  'handler:1790000000.000100',
  'send:{"envelope_id":"env-action-1"}',
  'handler:1790000010.000900',
  'send:{"envelope_id":"env-bot-1"}',
 ])
 assert.deepEqual(JSON.parse(socket.sent[0]!),{envelope_id:'env-im-1'})
 await h.adapter.stop()
})

test('2. im → direct；含 thread_ts（≠ts）→ thread 且 threadId===thread_ts；thread_ts===ts → group',async()=>{
 const h=harness()
 const socket=await connected(h)
 socket.deliver(envelopes.im)
 socket.deliver(envelopes.thread)
 socket.deliver(envelopes.threadRoot)
 await until(()=>h.got.length===3)
 const [dm,reply,root]=h.got as [ImInbound,ImInbound,ImInbound]
 assert.equal(dm.channelId,'slack')
 assert.equal(dm.chatId,'D0DM12345')
 assert.equal(dm.chatKind,'direct')
 assert.equal(dm.messageId,'1790000000.000100')
 assert.equal(dm.text,'你好')
 assert.deepEqual(dm.sender,{imUserId:'U123',displayName:'Ada'})
 assert.equal(dm.threadId,undefined)
 assert.equal(dm.at,new Date(1790000000000).toISOString())
 assert.equal(reply.chatKind,'thread')
 assert.equal(reply.threadId,'1790000001.000200')
 assert.equal(reply.chatId,'C0CHAN001')
 assert.equal(root.chatKind,'group')
 assert.equal(root.threadId,undefined)
 await h.adapter.stop()
})

test('3. 含 bot_id 或非白名单 subtype（message_changed）的 message 不触发 handler（仍 ack）；file_share／thread_broadcast 放行，文件记入 media',async()=>{
 const h=harness()
 const socket=await connected(h)
 socket.deliver(envelopes.botMessage)
 socket.deliver(envelopes.subtypeMessage)
 socket.deliver(envelopes.im)
 socket.deliver(envelopes.fileShare)
 socket.deliver(envelopes.fileShareNoText)
 socket.deliver(envelopes.threadBroadcast)
 await until(()=>h.got.length===4)
 assert.deepEqual(h.got.map(m=>m.messageId),['1790000000.000100','1790000006.000700','1790000006.000800','1790000007.000900'])
 assert.deepEqual(socket.sent.map(data=>(JSON.parse(data) as {envelope_id:string}).envelope_id),['env-bot-1','env-sub-1','env-im-1','env-file-1','env-file-2','env-bc-1'])
 const [,file,fileOnly,broadcast]=h.got as [ImInbound,ImInbound,ImInbound,ImInbound]
 assert.equal(file.text,'看看这个')
 assert.deepEqual(file.media,[{kind:'image',name:'shot.png',mime:'image/png',bytes:2048},{kind:'file',name:'spec.pdf',mime:'application/pdf',bytes:4096}])
 assert.equal(fileOnly.text,'')
 assert.deepEqual(fileOnly.media,[{kind:'file',name:'a.txt',mime:'text/plain',bytes:12}])
 assert.equal(broadcast.chatKind,'thread')
 assert.equal(broadcast.threadId,'1790000001.000200')
 assert.equal(broadcast.text,'线程回复同时发到频道')
 await h.adapter.stop()
})

test('4. <@UBOT> → botSelf；<@U456> → user',async()=>{
 const h=harness()
 const socket=await connected(h)
 socket.deliver(envelopes.mentions)
 await until(()=>h.got.length===1)
 assert.deepEqual(h.got[0]!.mentions,[{kind:'botSelf',raw:'<@UBOT>'},{kind:'user',imUserId:'U456',raw:'<@U456>'}])
 assert.equal(h.got[0]!.chatKind,'group')
 await h.adapter.stop()
})

test('5. block_actions → action approve、callbackId 为按钮 value；不实现 ack 故 callbackToken 为空且 raw 剔除 response_url；非本适配器按钮丢弃',async()=>{
 const h=harness()
 const socket=await connected(h)
 socket.deliver(envelopes.badAction)
 socket.deliver(envelopes.blockActions)
 await until(()=>h.got.length===1)
 const m=h.got[0]!
 assert.deepEqual(m.action,{callbackId:'1a2b3c4d',value:'approve',callbackToken:''})
 assert.doesNotMatch(JSON.stringify(m.raw),/response_url|hooks\.slack\.com/)
 assert.equal((m.raw as {payload:{actions:unknown[]}}).payload.actions.length,1)
 assert.equal(m.chatId,'D0DM12345')
 assert.equal(m.chatKind,'direct')
 assert.equal(m.messageId,'1790000010.000900')
 assert.equal(m.sender.imUserId,'U123')
 assert.equal(m.text,'')
 assert.equal(socket.sent.length,2)
 await h.adapter.stop()
})

test('6. disconnect envelope → 主动重连：apps.connections.open 再调用一次、旧连接关闭且其 onclose 不触发退避',async()=>{
 const h=harness()
 const first=await connected(h)
 assert.equal(h.opens(),1)
 first.deliver(envelopes.disconnect)
 await until(()=>h.instances.length===2)
 assert.equal(h.opens(),2)
 assert.equal(first.closed,1000)
 first.onclose?.({code:1000})
 await tick()
 assert.deepEqual(h.sleeps,[])
 assert.equal(h.instances.length,2)
 assert.equal(h.calls.filter(call=>call.method==='auth.test').length,1)
 await h.adapter.stop()
})

test('7. onclose 三次 → sleep [1000,2000,4000]；stop() 后 onclose 不重连',async()=>{
 const h=harness()
 await h.adapter.start(h.handler)
 for(let i=1;i<=3;i+=1){
  await until(()=>h.instances.length===i)
  h.instances[i-1]!.onclose?.({code:1006})
 }
 await until(()=>h.instances.length===4)
 assert.deepEqual(h.sleeps,[1000,2000,4000])
 assert.equal(h.adapter.status().connected,false)
 await h.adapter.stop()
 h.instances[3]!.onclose?.({code:1006})
 await tick();await tick()
 assert.deepEqual(h.sleeps,[1000,2000,4000])
 assert.equal(h.instances.length,4)
 assert.equal(h.opens(),4)
})

test('hello 后退避计数归零',async()=>{
 const h=harness()
 const first=await connected(h)
 first.onclose?.({code:1006})
 await until(()=>h.instances.length===2)
 h.instances[1]!.deliver(envelopes.hello)
 h.instances[1]!.onclose?.({code:1006})
 await until(()=>h.instances.length===3)
 assert.deepEqual(h.sleeps,[1000,1000])
 await h.adapter.stop()
})

test('8. apps.connections.open 返回 invalid_auth → status().error 含「凭据」且不重连',async()=>{
 const h=harness({'apps.connections.open':[{body:{ok:false,error:'invalid_auth'}}]})
 await h.adapter.start(h.handler)
 await until(()=>h.adapter.status().error!==undefined)
 await tick();await tick()
 assert.equal(h.adapter.status().error,'credentials-invalid')
 assert.equal(h.adapter.status().connected,false)
 assert.equal(h.opens(),1)
 assert.deepEqual(h.sleeps,[])
 assert.equal(h.instances.length,0)
 await h.adapter.stop()
})

test('auth.test 返回 token_revoked 同为终态；凭据格式不合法不出网',async()=>{
 const revoked=harness({'auth.test':[{body:{ok:false,error:'token_revoked'}}]})
 await revoked.adapter.start(revoked.handler)
 await until(()=>revoked.adapter.status().error!==undefined)
 assert.equal(revoked.adapter.status().error,'credentials-invalid')
 assert.equal(revoked.opens(),0)
 assert.deepEqual(revoked.sleeps,[])
 const bad=harness({},{SLACK_BOT_TOKEN:'xoxb-ok',SLACK_APP_TOKEN:'not-an-app-token'})
 await bad.adapter.start(bad.handler)
 await until(()=>bad.adapter.status().error!==undefined)
 assert.equal(bad.adapter.status().error,'credentials-invalid')
 assert.deepEqual(bad.calls.map(call=>call.method),['auth.test'])
 assert.deepEqual(bad.sleeps,[])
})

test('非终态错误（网络、ratelimited、非 wss 或非 slack.com 地址）退避重试；日志与状态不含凭据与 ticket',async()=>{
 const h=harness({
  'apps.connections.open':['network',{status:429,body:{ok:false,error:'ratelimited'}},{body:{ok:true,url:'ws://wss-primary.slack.com/link'}},{body:{ok:true,url:'wss://evil.example.com/link'}}],
 })
 await h.adapter.start(h.handler)
 await until(()=>h.instances.length===1)
 assert.deepEqual(h.sleeps,[1000,2000,4000,8000])
 assert.equal(h.opens(),5)
 const text=h.logs.join('\n')+JSON.stringify(h.adapter.status())
 for(const secret of [botToken,appToken,'TEST-ticket'])assert.ok(!text.includes(secret),secret)
 await h.adapter.stop()
})

test('apps.connections.open 429 带 Retry-After → 按其等待；send 429 抛给上层且错误带 retryAfterMs',async()=>{
 const h=harness({
  'apps.connections.open':[{status:429,headers:{'retry-after':'9'},body:{ok:false,error:'ratelimited'}}],
  'chat.postMessage':[{status:429,headers:{'retry-after':'4'},body:{ok:false,error:'ratelimited'}}],
 })
 await h.adapter.start(h.handler)
 await until(()=>h.instances.length===1)
 assert.deepEqual(h.sleeps,[9000])
 await assert.rejects(h.adapter.send('C0CHAN001','x'),(err:unknown)=>(err as {retryAfterMs?:number}).retryAfterMs===4000)
 await h.adapter.stop()
})

test('stop() 期间挂起的退避被取消，不再建连',async()=>{
 const h=harness({'apps.connections.open':['network']})
 let release:(()=>void)|undefined
 const adapter=createSlackAdapter({
  env:async()=>({SLACK_BOT_TOKEN:botToken,SLACK_APP_TOKEN:appToken}),
  log:{info(){},warn(){}},
  now:()=>new Date(),
  fetch:h.fetchImpl,
  WebSocketImpl:h.FakeSocket as unknown as typeof WebSocket,
  sleep:()=>new Promise<void>(resolve=>{release=resolve}),
 })
 await adapter.start(h.handler)
 await until(()=>release!==undefined)
 await adapter.stop()
 release!()
 await tick();await tick()
 assert.equal(h.instances.length,0)
 assert.equal(h.opens(),1)
})

test('stop()→start() 后旧一轮的退避醒来不再建连，只有新一轮的一条连接',async()=>{
 const h=harness({'apps.connections.open':['network']})
 const pending:(()=>void)[]=[]
 const adapter=createSlackAdapter({
  env:async()=>({SLACK_BOT_TOKEN:botToken,SLACK_APP_TOKEN:appToken}),
  log:{info(){},warn(){}},
  now:()=>new Date(),
  fetch:h.fetchImpl,
  WebSocketImpl:h.FakeSocket as unknown as typeof WebSocket,
  sleep:()=>new Promise<void>(resolve=>{pending.push(resolve)}),
 })
 await adapter.start(h.handler)
 await until(()=>pending.length===1)
 await adapter.stop()
 await adapter.start(h.handler)
 await until(()=>h.instances.length===1)
 pending[0]!()
 await tick();await tick()
 assert.equal(h.instances.length,1)
 assert.equal(h.opens(),2)
 await adapter.stop()
})

const noUnfurl={unfurl_links:false,unfurl_media:false}

test('send：chat.postMessage{channel,text,thread_ts} 用 bot token，返回 ts；文本转义 & < >；关闭链接展开',async()=>{
 const h=harness()
 const result=await h.adapter.send('C0CHAN001','a < b & <!channel>',{threadId:'1790000001.000200'})
 assert.deepEqual(result,{messageId:'1790000020.001000'})
 assert.equal(h.calls[0]!.method,'chat.postMessage')
 assert.equal(h.calls[0]!.auth,`Bearer ${botToken}`)
 assert.deepEqual(h.calls[0]!.body,{channel:'C0CHAN001',text:'a &lt; b &amp; &lt;!channel&gt;',thread_ts:'1790000001.000200',...noUnfurl})
 await h.adapter.send('D0DM12345','hi')
 assert.deepEqual(h.calls[1]!.body,{channel:'D0DM12345',text:'hi',...noUnfurl})
})

test('send 失败：错误只含方法与平台错误码，不含凭据',async()=>{
 const h=harness({'chat.postMessage':[{body:{ok:false,error:'channel_not_found'}},'network']})
 await assert.rejects(h.adapter.send('C0NOPE','x'),(err:Error)=>/chat\.postMessage/.test(err.message)&&/channel_not_found/.test(err.message)&&!err.message.includes(botToken))
 await assert.rejects(h.adapter.send('C0NOPE','x'),(err:Error)=>!err.message.includes(botToken)&&!err.message.includes('slack.com'))
})

test('9. sendCard：section + actions 两按钮（im_approve primary / im_reject danger，value=callbackId）；editMessage：chat.update 且 blocks 为空数组',async()=>{
 const h=harness()
 const card={title:'需要审批',lines:['工具：shell','命令：ls'],callbackId:'1a2b3c4d',approveLabel:'允许',rejectLabel:'拒绝'}
 const result=await h.adapter.sendCard!('C0CHAN001',card,{threadId:'1790000001.000200'})
 assert.deepEqual(result,{messageId:'1790000020.001000'})
 const body=h.calls[0]!.body as {channel:string;thread_ts:string;text:string;unfurl_links:boolean;unfurl_media:boolean;blocks:{type:string;text?:{type:string;text:string};elements?:Record<string,unknown>[]}[]}
 assert.equal(body.channel,'C0CHAN001')
 assert.equal(body.thread_ts,'1790000001.000200')
 assert.equal(body.text,'需要审批')
 assert.equal(body.unfurl_links,false)
 assert.equal(body.unfurl_media,false)
 assert.equal(body.blocks[0]!.type,'section')
 assert.deepEqual(body.blocks[0]!.text,{type:'plain_text',text:'需要审批\n工具：shell\n命令：ls'})
 assert.equal(body.blocks[1]!.type,'actions')
 assert.equal(body.blocks[1]!.elements![0]!.action_id,'im_approve')
 assert.deepEqual(body.blocks[1]!.elements,[
  {type:'button',text:{type:'plain_text',text:'允许'},action_id:'im_approve',value:'1a2b3c4d',style:'primary'},
  {type:'button',text:{type:'plain_text',text:'拒绝'},action_id:'im_reject',value:'1a2b3c4d',style:'danger'},
 ])
 await h.adapter.editMessage!('C0CHAN001','1790000020.001000','已允许')
 assert.equal(h.calls[1]!.method,'chat.update')
 assert.deepEqual(h.calls[1]!.body,{channel:'C0CHAN001',ts:'1790000020.001000',text:'已允许',blocks:[]})
})

test('sendCard：section 超 3000 字、按钮文字超 75 字截断并以省略号结尾',async()=>{
 const h=harness()
 await h.adapter.sendCard!('C0CHAN001',{title:'需要审批',lines:['x'.repeat(4000)],callbackId:'1a2b3c4d',approveLabel:'y'.repeat(100),rejectLabel:'拒绝'})
 const blocks=(h.calls[0]!.body as {blocks:{text?:{text:string};elements?:{text:{text:string}}[]}[]}).blocks
 const section=blocks[0]!.text!.text
 assert.equal(section.length,3000)
 assert.ok(section.endsWith('…'))
 const approve=blocks[1]!.elements![0]!.text.text
 assert.equal(approve.length,75)
 assert.ok(approve.endsWith('…'))
 assert.equal(blocks[1]!.elements![1]!.text.text,'拒绝')
})

test('sendCard：callbackId 不合法时构造期抛错、不出网',async()=>{
 const h=harness()
 await assert.rejects(h.adapter.sendCard!('C0CHAN001',{title:'t',lines:[],callbackId:'bad id!',approveLabel:'a',rejectLabel:'r'}))
 assert.equal(h.calls.length,0)
})

test('capabilities 按简报',()=>{
 const h=harness()
 assert.deepEqual(h.adapter.capabilities,{text:true,card:true,button:true,thread:true,file:false,edit:true,maxMessageLength:3000,rateLimitPerMinute:50})
 assert.equal(h.adapter.id,'slack')
})

test('sendCard：无 approveLabel（取不到调用参数）→ actions 只有 im_reject',async()=>{
 const h=harness()
 await h.adapter.sendCard!('C0CHAN001',{title:'需要审批',lines:['参数请到工作台查看'],callbackId:'1a2b3c4d',rejectLabel:'拒绝'})
 const body=h.calls[0]!.body as {blocks:{elements?:{action_id:string}[]}[]}
 assert.deepEqual(body.blocks[1]!.elements!.map(e=>e.action_id),['im_reject'])
})

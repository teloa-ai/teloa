import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createFeishuAdapter} from '../src/channels/feishu.ts'
import type {FeishuSdk} from '../src/channels/feishu-sdk.ts'
import type {ImInbound} from '../src/core/types.ts'

const events=JSON.parse(readFileSync(new URL('./fixtures/feishu-events.json',import.meta.url),'utf8')) as Record<string,Record<string,unknown>>
const appId='cli_0123456789abcdef'
const appSecret='TEST-feishu-secret'

type Reply=unknown|Error
type Call={method:string;payload:unknown}
type Handles=Record<string,(data:unknown)=>Promise<unknown>>

/** 假飞书 SDK：Client 记录调用并按队列回包，EventDispatcher 捕获处理器，WSClient 记录 start/close 与构造参数。 */
function fakeSdk(responses:Record<string,Reply[]>={},wsStarts:((socket:{opts:{onReady?:()=>void;onError?:(err:Error)=>void}})=>Promise<void>)[]=[]){
 const calls:Call[]=[]
 const clients:{opts:Record<string,unknown>}[]=[]
 const dispatchers:{opts:Record<string,unknown>;handles:Handles}[]=[]
 const sockets:{opts:Record<string,unknown>&{onReady?:()=>void;onError?:(err:Error)=>void;onReconnecting?:()=>void;onReconnected?:()=>void};started:boolean;closed?:{force?:boolean}|undefined}[]=[]
 const defaults:Record<string,unknown>={
  request:{code:0,bot:{open_id:'ou_bot',app_name:'Teloa 助手'}},
  create:{code:0,data:{message_id:'om_new'}},
  reply:{code:0,data:{message_id:'om_reply'}},
  patch:{code:0,data:{}},
 }
 const respond=async(method:string,payload:unknown)=>{
  calls.push({method,payload})
  const reply=responses[method]?.length?responses[method]!.shift():defaults[method]
  if(reply instanceof Error)throw reply
  return reply
 }
 class Client{
  readonly opts:Record<string,unknown>
  readonly im={message:{
   create:(payload:unknown)=>respond('create',payload),
   reply:(payload:unknown)=>respond('reply',payload),
   patch:(payload:unknown)=>respond('patch',payload),
  }}
  constructor(opts:Record<string,unknown>){this.opts=opts;clients.push(this)}
  request(payload:unknown){return respond('request',payload)}
 }
 class EventDispatcher{
  readonly opts:Record<string,unknown>
  readonly handles:Handles={}
  constructor(opts:Record<string,unknown>){this.opts=opts;dispatchers.push(this)}
  register(handles:Handles){Object.assign(this.handles,handles);return this}
 }
 class WSClient{
  readonly opts:(typeof sockets)[number]['opts']
  started=false
  closed:{force?:boolean}|undefined
  constructor(opts:(typeof sockets)[number]['opts']){this.opts=opts;sockets.push(this)}
  async start(){this.started=true;const custom=wsStarts.shift();if(custom)return custom(this);this.opts.onReady?.()}
  close(params?:{force?:boolean}){this.closed=params??{}}
 }
 // 与 1.74.0 lib/index.js 的数值枚举一致：Feishu=0、Lark=1（formatDomain 分别映射 open.feishu.cn／open.larksuite.com）。
 const Domain={Feishu:0,Lark:1,0:'Feishu',1:'Lark'}
 return {calls,clients,dispatchers,sockets,module:{Client,EventDispatcher,WSClient,Domain} as unknown as FeishuSdk}
}

const tick=()=>new Promise(resolve=>setImmediate(resolve))
async function until(check:()=>boolean,limit=200):Promise<void>{
 for(let i=0;i<limit&&!check();i+=1)await tick()
 assert.ok(check(),'等待条件超时')
}

function harness(opts:{responses?:Record<string,Reply[]>;env?:Record<string,string>;loadSdk?:()=>Promise<FeishuSdk>;wsStarts?:Parameters<typeof fakeSdk>[1];brand?:'feishu'|'lark';sdk?:ReturnType<typeof fakeSdk>}={}){
 const sdk=opts.sdk??fakeSdk(opts.responses,opts.wsStarts)
 const sleeps:number[]=[]
 const logs:string[]=[]
 const got:ImInbound[]=[]
 let loads=0
 const adapter=createFeishuAdapter({
  env:async()=>opts.env??(opts.brand==='lark'?{LARK_APP_ID:appId,LARK_APP_SECRET:appSecret}:{FEISHU_APP_ID:appId,FEISHU_APP_SECRET:appSecret}),
  log:{info:(f,...v)=>logs.push([f,...v].join(' ')),warn:(f,...v)=>logs.push([f,...v].join(' '))},
  now:()=>new Date('2026-09-26T00:00:00Z'),
  sleep:ms=>{sleeps.push(ms);return new Promise(resolve=>setImmediate(resolve))},
  loadSdk:async()=>{loads+=1;return opts.loadSdk?opts.loadSdk():sdk.module},
  ...(opts.brand===undefined?{}:{brand:opts.brand}),
 })
 const handler=async(m:ImInbound)=>{got.push(m)}
 return {...sdk,sleeps,logs,got,adapter,handler,loads:()=>loads}
}

async function started(h:ReturnType<typeof harness>,handler=h.handler){
 await h.adapter.start(handler)
 await until(()=>h.sockets.some(socket=>socket.started))
 return h.dispatchers.at(-1)!.handles
}

async function deliver(h:ReturnType<typeof harness>,key:string){
 const handles=await started(h)
 const event=events[key]!
 return handles[event.event_type as string]!(event)
}

test('1. loadSdk reject → status.error 含「未安装」、connected=false、不重试',async()=>{
 const h=harness({loadSdk:async()=>{throw new Error('missing')}})
 await h.adapter.start(h.handler)
 await until(()=>h.adapter.status().error!==undefined)
 for(let i=0;i<20;i+=1)await tick()
 assert.equal(h.adapter.status().error,'sdk-missing')
 assert.equal(h.adapter.status().connected,false)
 assert.equal(h.loads(),1)
 assert.deepEqual(h.sleeps,[])
 await h.adapter.stop()
})

test('启动：Client/WSClient 用 FEISHU_APP_ID/SECRET 构造，GET /open-apis/bot/v3/info 取机器人 open_id；onReady → connected；无 encryptKey 时不传',async()=>{
 const h=harness()
 await started(h)
 assert.equal(h.clients[0]!.opts.appId,appId)
 assert.equal(h.clients[0]!.opts.appSecret,appSecret)
 assert.equal(h.sockets[0]!.opts.appId,appId)
 assert.deepEqual(h.calls[0],{method:'request',payload:{url:'/open-apis/bot/v3/info',method:'GET'}})
 assert.equal(h.adapter.status().connected,true)
 assert.equal('encryptKey' in h.dispatchers[0]!.opts,false)
 assert.ok(h.logs.every(line=>!line.includes(appSecret)))
 await h.adapter.stop()
})

test('2. p2p 文本 → direct、text、sender.imUserId===open_id、messageId、at 取 create_time',async()=>{
 const h=harness()
 await deliver(h,'p2p')
 await until(()=>h.got.length===1)
 const m=h.got[0]!
 assert.equal(m.channelId,'feishu')
 assert.equal(m.chatId,'oc_p2p')
 assert.equal(m.chatKind,'direct')
 assert.equal(m.messageId,'om_p2p1')
 assert.equal(m.text,'你好')
 assert.equal(m.sender.imUserId,'ou_user1')
 assert.equal(m.threadId,undefined)
 assert.equal(m.at,new Date(1790000000000).toISOString())
 await h.adapter.stop()
})

test('3. 群消息 mentions 含机器人 open_id → botSelf；正文 @_user_N 替换回 @名字',async()=>{
 const h=harness()
 await deliver(h,'groupMention')
 await until(()=>h.got.length===1)
 const m=h.got[0]!
 assert.equal(m.chatKind,'group')
 assert.equal(m.text,'@Teloa 助手 做X，@Bob 看看')
 assert.deepEqual(m.mentions,[{kind:'botSelf',raw:'@Teloa 助手'},{kind:'user',imUserId:'ou_bob',raw:'@Bob'}])
 await h.adapter.stop()
})

test('4. thread_id 存在 → thread；threadId 为话题根消息 id（root_id，新话题根消息取自身 message_id），可直接用于 reply_in_thread',async()=>{
 const h=harness()
 const handles=await started(h)
 await handles['im.message.receive_v1']!(events.thread)
 await handles['im.message.receive_v1']!(events.threadRoot)
 await until(()=>h.got.length===2)
 assert.equal(h.got[0]!.chatKind,'thread')
 assert.equal(h.got[0]!.threadId,'om_root1')
 assert.equal(h.got[1]!.chatKind,'thread')
 assert.equal(h.got[1]!.threadId,'om_root2')
 await h.adapter.stop()
})

test('post 富文本：提取纯文本（标题、段落换行、链接文字、@占位还原、代码块），忽略图片与表情；按语言包裹也可解析；无文字的 post 记为图片',async()=>{
 const h=harness()
 const handles=await started(h)
 for(const key of ['post','postLocale','postEmpty'])await handles['im.message.receive_v1']!(events[key])
 await until(()=>h.got.length===3)
 assert.equal(h.got[0]!.text,'周报\n@Teloa 助手 整理一下这份文档\n第二行\nfmt.Println(1)')
 assert.deepEqual(h.got[0]!.mentions,[{kind:'botSelf',raw:'@Teloa 助手'}])
 assert.deepEqual(h.got[0]!.media,[{kind:'image'}])
 assert.equal(h.got[1]!.text,'按语言包裹')
 assert.deepEqual([h.got[2]!.messageId,h.got[2]!.text,h.got[2]!.media],['om_post_empty','',[{kind:'image'}]])
 await h.adapter.stop()
})

test('图片／文件消息 text 为空、media 记类型与文件名；机器人自己发的消息丢弃',async()=>{
 const h=harness()
 const handles=await started(h)
 for(const key of ['appSender','image','file'])await handles['im.message.receive_v1']!(events[key])
 await until(()=>h.got.length===2)
 await tick()
 assert.deepEqual(h.got.map(m=>[m.messageId,m.text,m.media]),[['om_img','',[{kind:'image'}]],['om_file','',[{kind:'file',name:'spec.pdf'}]]])
 await h.adapter.stop()
})

test('5. card.action.trigger → action approve、callbackId、callbackToken 为空；sender=operator.open_id；按钮数据格式不符丢弃',async()=>{
 const h=harness()
 const handles=await started(h)
 assert.equal(await handles['card.action.trigger']!(events.badCardAction),undefined)
 await handles['card.action.trigger']!(events.cardAction)
 await until(()=>h.got.length===1)
 const m=h.got[0]!
 assert.deepEqual(m.action,{callbackId:'1a2b3c4d',value:'approve',callbackToken:''})
 assert.equal(m.sender.imUserId,'ou_user1')
 assert.equal(m.chatId,'oc_p2p')
 assert.equal(m.messageId,'om_card1')
 assert.equal(m.text,'')
 assert.doesNotMatch(JSON.stringify(m.raw),/c-token-1/)
 await h.adapter.stop()
})

test('card.action.trigger 同步回包：handler 内 ack(m,text) → 返回 toast；handler 不 ack 则结束后返回 undefined',async()=>{
 const h=harness()
 const handles=await started(h,async m=>{await h.adapter.ack!(m,'已批准')})
 assert.deepEqual(await handles['card.action.trigger']!(events.cardAction),{toast:{type:'info',content:'已批准'}})
 await h.adapter.stop()
 const quiet=harness()
 const quietHandles=await started(quiet)
 assert.equal(await quietHandles['card.action.trigger']!(events.cardAction),undefined)
 await quiet.adapter.stop()
})

test('6. send → im.message.create(chat_id, text)；带 threadId → im.message.reply(reply_in_thread)；<at> 标签被中和',async()=>{
 const h=harness()
 assert.deepEqual(await h.adapter.send('oc_p2p','你好'),{messageId:'om_new'})
 assert.deepEqual(h.calls.at(-1),{method:'create',payload:{params:{receive_id_type:'chat_id'},data:{receive_id:'oc_p2p',msg_type:'text',content:JSON.stringify({text:'你好'})}}})
 assert.deepEqual(await h.adapter.send('oc_group','线程回复',{threadId:'om_root1'}),{messageId:'om_reply'})
 assert.deepEqual(h.calls.at(-1),{method:'reply',payload:{path:{message_id:'om_root1'},data:{msg_type:'text',content:JSON.stringify({text:'线程回复'}),reply_in_thread:true}}})
 await h.adapter.send('oc_group','提醒<at user_id="all">所有人</at>')
 const text=(JSON.parse((h.calls.at(-1)!.payload as {data:{content:string}}).data.content) as {text:string}).text
 assert.doesNotMatch(text,/<\/?at[\s>]/)
 assert.match(text,/所有人/)
})

test('send 错误：业务码非 0 抛错；429 带 retryAfterMs（x-ogw-ratelimit-reset）；错误不含凭据与请求头',async()=>{
 const axiosLike=Object.assign(new Error('Request failed with status code 429'),{
  response:{status:429,headers:{'x-ogw-ratelimit-reset':'5'},data:{code:99991400,msg:'request trigger frequency limit'}},
  config:{headers:{Authorization:'Bearer t-TENANT-TOKEN'}},
 })
 const h=harness({responses:{create:[{code:230002,msg:'Bot/User can NOT be out of the chat.'},axiosLike]}})
 await assert.rejects(h.adapter.send('oc_x','a'),(err:Error)=>/230002/.test(err.message))
 await assert.rejects(h.adapter.send('oc_x','a'),(err:Error)=>(err as Error&{retryAfterMs?:number}).retryAfterMs===5000&&!err.message.includes('t-TENANT-TOKEN')&&!JSON.stringify(err).includes('t-TENANT-TOKEN'))
})

test('7. sendCard：interactive 卡片，header 标题、正文 plain_text、两按钮 value 同 callbackId、decision 分别 approve/reject；超长截断；非法 callbackId 不出网',async()=>{
 const h=harness()
 const result=await h.adapter.sendCard!('oc_p2p',{title:'需要审批',lines:['工具：shell','x'.repeat(5000)],callbackId:'1a2b3c4d',approveLabel:'y'.repeat(100),rejectLabel:'拒绝'})
 assert.deepEqual(result,{messageId:'om_new'})
 const payload=h.calls.at(-1)!.payload as {data:{msg_type:string;content:string;receive_id:string}}
 assert.equal(payload.data.msg_type,'interactive')
 const card=JSON.parse(payload.data.content) as {header:{title:{tag:string;content:string}};elements:{tag:string;text?:{tag:string;content:string};actions?:{tag:string;type:string;text:{content:string};value:{callbackId:string;decision:string}}[]}[]}
 assert.deepEqual(card.header.title,{tag:'plain_text',content:'需要审批'})
 assert.equal(card.elements[0]!.tag,'div')
 assert.equal(card.elements[0]!.text!.tag,'plain_text')
 assert.equal(card.elements[0]!.text!.content.length,4000)
 assert.ok(card.elements[0]!.text!.content.endsWith('…'))
 const actions=card.elements[1]!.actions!
 assert.equal(actions.length,2)
 assert.deepEqual(actions.map(a=>[a.type,a.value.callbackId,a.value.decision]),[['primary','1a2b3c4d','approve'],['danger','1a2b3c4d','reject']])
 assert.equal(actions[0]!.text.content.length,75)
 const count=h.calls.length
 await assert.rejects(h.adapter.sendCard!('oc_p2p',{title:'t',lines:[],callbackId:'bad id!',approveLabel:'a',rejectLabel:'r'}))
 assert.equal(h.calls.length,count)
})

test('卡片按钮回调带回 sendCard 的话题：threadId 与 thread',async()=>{
 const h=harness({responses:{reply:[{code:0,data:{message_id:'om_card1'}}]}})
 const handles=await started(h)
 await h.adapter.sendCard!('oc_p2p',{title:'t',lines:[],callbackId:'1a2b3c4d',approveLabel:'a',rejectLabel:'r'},{threadId:'om_root1'})
 await handles['card.action.trigger']!(events.cardAction)
 await until(()=>h.got.length===1)
 assert.equal(h.got[0]!.chatKind,'thread')
 assert.equal(h.got[0]!.threadId,'om_root1')
 await h.adapter.stop()
})

test('8. editMessage → im.message.patch，content 为无按钮卡片',async()=>{
 const h=harness()
 await h.adapter.editMessage!('oc_p2p','om_card1','已批准')
 const call=h.calls.at(-1)!
 assert.equal(call.method,'patch')
 const payload=call.payload as {path:{message_id:string};data:{content:string}}
 assert.equal(payload.path.message_id,'om_card1')
 assert.doesNotMatch(payload.data.content,/"actions"/)
 assert.match(payload.data.content,/已批准/)
})

test('9. stop() 调 WSClient.close({force:true})',async()=>{
 const h=harness()
 await started(h)
 await h.adapter.stop()
 assert.deepEqual(h.sockets[0]!.closed,{force:true})
 assert.equal(h.adapter.status().connected,false)
})

test('10. FEISHU_ENCRYPT_KEY 存在时 EventDispatcher 构造参数含 encryptKey',async()=>{
 const h=harness({env:{FEISHU_APP_ID:appId,FEISHU_APP_SECRET:appSecret,FEISHU_ENCRYPT_KEY:'enc-key'}})
 await started(h)
 assert.equal(h.dispatchers[0]!.opts.encryptKey,'enc-key')
 await h.adapter.stop()
})

test('凭据错误码 99991663 → 凭据终态、不重试；App ID 格式不合法 → 不构造 Client',async()=>{
 const h=harness({responses:{request:[{code:99991663,msg:'invalid access token'}]}})
 await h.adapter.start(h.handler)
 await until(()=>h.adapter.status().error!==undefined)
 for(let i=0;i<20;i+=1)await tick()
 assert.equal(h.adapter.status().error,'credentials-invalid')
 assert.deepEqual(h.sleeps,[])
 assert.equal(h.sockets.length,0)
 const bad=harness({env:{FEISHU_APP_ID:'not-an-app',FEISHU_APP_SECRET:appSecret}})
 await bad.adapter.start(bad.handler)
 await until(()=>bad.adapter.status().error!==undefined)
 assert.equal(bad.adapter.status().error,'credentials-invalid')
 assert.equal(bad.clients.length,0)
})

test('启动失败（网络）按 reconnectDelayMs 退避重试；WSClient onError 后关闭旧连接并重建',async()=>{
 const h=harness({responses:{request:[new Error('ECONNRESET')]}})
 await started(h)
 assert.deepEqual(h.sleeps,[1000])
 h.sockets[0]!.opts.onError?.(new Error('exhausted'))
 await until(()=>h.sockets.length===2&&h.sockets[1]!.started)
 assert.deepEqual(h.sockets[0]!.closed,{force:true})
 assert.equal(h.sleeps.length,2)
 h.sockets[1]!.opts.onReconnecting?.()
 assert.equal(h.adapter.status().connected,false)
 h.sockets[1]!.opts.onReconnected?.()
 assert.equal(h.adapter.status().connected,true)
 await h.adapter.stop()
})

test('WSClient.start 内先触发 onError 再抛错 → 只有一条重建路径：共 2 个 WSClient、1 次退避，旧连接 close({force:true})',async()=>{
 const h=harness({wsStarts:[async socket=>{socket.opts.onError?.(new Error('exhausted'));throw new Error('handshake failed')}]})
 await h.adapter.start(h.handler)
 await until(()=>h.sockets.length>=2&&h.sockets[1]!.started)
 for(let i=0;i<50;i+=1)await tick()
 assert.equal(h.sockets.length,2)
 assert.equal(h.sleeps.length,1)
 assert.deepEqual(h.sockets[0]!.closed,{force:true})
 assert.equal(h.adapter.status().connected,true)
 await h.adapter.stop()
})

test('WSClient.start 抛错（未触发 onError）→ catch 先关闭该连接再退避重建；旧连接迟到的 onError 不再触发第二条重建',async()=>{
 const h=harness({wsStarts:[async()=>{throw new Error('handshake failed')}]})
 await h.adapter.start(h.handler)
 await until(()=>h.sockets.length>=2&&h.sockets[1]!.started)
 assert.deepEqual(h.sockets[0]!.closed,{force:true})
 h.sockets[0]!.opts.onError?.(new Error('late'))
 for(let i=0;i<50;i+=1)await tick()
 assert.equal(h.sockets.length,2)
 assert.equal(h.sleeps.length,1)
 await h.adapter.stop()
})

test('连接中（start 未返回）触发 onError、随后 start 正常返回 → 仍按失败走同一重建路径，只重建一次',async()=>{
 const h=harness({wsStarts:[async socket=>{socket.opts.onError?.(new Error('exhausted'))}]})
 await h.adapter.start(h.handler)
 await until(()=>h.sockets.length>=2&&h.sockets[1]!.started)
 for(let i=0;i<50;i+=1)await tick()
 assert.equal(h.sockets.length,2)
 assert.equal(h.sleeps.length,1)
 assert.equal(h.adapter.status().connected,true)
 await h.adapter.stop()
})

test('send：Markdown 链接 [文字](链接) 被中和（] 与 ( 之间插零宽空格），原文字仍在',async()=>{
 const h=harness()
 await h.adapter.send('oc_group','点[这里](https://evil.example/phish)领奖')
 const text=(JSON.parse((h.calls.at(-1)!.payload as {data:{content:string}}).data.content) as {text:string}).text
 assert.doesNotMatch(text,/\]\(/)
 assert.equal(text.replace(/\u200b/g,''),'点[这里](https://evil.example/phish)领奖')
})

test('业务码 99991400（200 回包、无重置头）→ 按指数退避；带 x-ogw-ratelimit-reset 头 → 按重置时间',async()=>{
 const noHeader=harness({responses:{request:[{code:99991400,msg:'request trigger frequency limit'}]}})
 await started(noHeader)
 assert.deepEqual(noHeader.sleeps,[1000])
 await noHeader.adapter.stop()
 const withHeader=harness({responses:{request:[{code:99991400,msg:'request trigger frequency limit',headers:{'x-ogw-ratelimit-reset':'7'}}]}})
 await started(withHeader)
 assert.deepEqual(withHeader.sleeps,[7000])
 await withHeader.adapter.stop()
 const axios400=Object.assign(new Error('Request failed with status code 400'),{response:{status:400,headers:{'x-ogw-ratelimit-reset':'3'},data:{code:99991400}}})
 const viaError=harness({responses:{request:[axios400]}})
 await started(viaError)
 assert.deepEqual(viaError.sleeps,[3000])
 await viaError.adapter.stop()
})

test('capabilities 按简报',()=>{
 const h=harness()
 assert.deepEqual(h.adapter.capabilities,{text:true,card:true,button:true,thread:true,file:false,edit:true,maxMessageLength:4000,rateLimitPerMinute:50})
 assert.equal(h.adapter.id,'feishu')
})

test('sendCard：无 approveLabel（取不到调用参数）→ 只有 reject 按钮',async()=>{
 const h=harness()
 await h.adapter.sendCard!('oc_p2p',{title:'需要审批',lines:['参数请到工作台查看'],callbackId:'1a2b3c4d',rejectLabel:'拒绝'})
 const payload=h.calls.at(-1)!.payload as {data:{content:string}}
 const card=JSON.parse(payload.data.content) as {elements:{actions?:{value:{decision:string}}[]}[]}
 assert.deepEqual(card.elements[1]!.actions!.map(a=>a.value.decision),['reject'])
})

test('飞书：Client 与 WSClient 显式用 SDK 常量 Domain.Feishu（open.feishu.cn），id/label 为飞书',async()=>{
 const h=harness()
 await started(h)
 assert.equal(h.clients[0]!.opts.domain,0)
 assert.equal(h.sockets[0]!.opts.domain,0)
 assert.equal(h.adapter.id,'feishu')
 assert.equal(h.adapter.label,'飞书')
 await h.adapter.stop()
})

test('Lark：用 LARK_APP_ID/SECRET 构造、Client 与 WSClient 用 Domain.Lark（open.larksuite.com）；入站 channelId 为 lark；能力与飞书相同',async()=>{
 const h=harness({brand:'lark',env:{LARK_APP_ID:appId,LARK_APP_SECRET:appSecret,LARK_ENCRYPT_KEY:'TEST-lark-encrypt'}})
 const handles=await started(h)
 assert.equal(h.adapter.id,'lark')
 assert.equal(h.adapter.label,'Lark')
 assert.deepEqual([h.clients[0]!.opts.appId,h.clients[0]!.opts.appSecret,h.clients[0]!.opts.domain],[appId,appSecret,1])
 assert.deepEqual([h.sockets[0]!.opts.appId,h.sockets[0]!.opts.domain],[appId,1])
 assert.equal(h.dispatchers[0]!.opts.encryptKey,'TEST-lark-encrypt')
 assert.deepEqual(h.calls[0],{method:'request',payload:{url:'/open-apis/bot/v3/info',method:'GET'}})
 await handles['im.message.receive_v1']!(events.p2p)
 await handles['card.action.trigger']!(events.cardAction)
 await until(()=>h.got.length===2)
 assert.deepEqual(h.got.map(m=>m.channelId),['lark','lark'])
 assert.equal(h.got[1]!.action?.value,'approve')
 assert.deepEqual(h.adapter.capabilities,harness().adapter.capabilities)
 assert.ok(h.logs.every(line=>!line.includes(appSecret)&&!line.includes('TEST-lark-encrypt')))
 assert.ok(h.logs.some(line=>line.startsWith('[lark]')))
 await h.adapter.stop()
})

test('Lark 只读 LARK_* 键：只有飞书键时按凭据不合法终态处理、不构造 Client',async()=>{
 const h=harness({brand:'lark',env:{FEISHU_APP_ID:appId,FEISHU_APP_SECRET:appSecret}})
 await h.adapter.start(h.handler)
 await until(()=>h.adapter.status().error!==undefined)
 assert.equal(h.adapter.status().error,'credentials-invalid')
 assert.equal(h.clients.length,0)
 assert.equal(h.sockets.length,0)
 await h.adapter.stop()
})

test('飞书与 Lark 同时连接：共用同一份 SDK，各用各的域名与凭据，入站各归各渠道；停一个不影响另一个',async()=>{
 const shared=fakeSdk()
 const feishu=harness({sdk:shared,env:{FEISHU_APP_ID:appId,FEISHU_APP_SECRET:'TEST-feishu-only'}})
 const lark=harness({sdk:shared,brand:'lark',env:{LARK_APP_ID:'cli_fedcba9876543210',LARK_APP_SECRET:'TEST-lark-only'}})
 await feishu.adapter.start(feishu.handler)
 await until(()=>shared.sockets.length===1&&shared.sockets[0]!.started)
 await lark.adapter.start(lark.handler)
 await until(()=>shared.sockets.length===2&&shared.sockets[1]!.started)
 assert.deepEqual(shared.clients.map(c=>[c.opts.appId,c.opts.appSecret,c.opts.domain]),[[appId,'TEST-feishu-only',0],['cli_fedcba9876543210','TEST-lark-only',1]])
 assert.deepEqual(shared.sockets.map(s=>s.opts.domain),[0,1])
 await shared.dispatchers[0]!.handles['im.message.receive_v1']!(events.p2p)
 await shared.dispatchers[1]!.handles['im.message.receive_v1']!(events.groupMention)
 await until(()=>feishu.got.length===1&&lark.got.length===1)
 assert.equal(feishu.got[0]!.channelId,'feishu')
 assert.equal(lark.got[0]!.channelId,'lark')
 await feishu.adapter.stop()
 assert.deepEqual(shared.sockets[0]!.closed,{force:true})
 assert.equal(shared.sockets[1]!.closed,undefined)
 assert.equal(lark.adapter.status().connected,true)
 await lark.adapter.send('oc_x','hi')
 assert.equal(shared.clients.length,2)
 await lark.adapter.stop()
})

test('App ID 规则放宽：cli_ 后 8–64 位字母数字即可（含非十六进制字母）；过短、带符号、缺前缀仍按凭据不合法终态处理',async()=>{
 for(const ok of ['cli_a1B2c3D4e5F6g7H8','cli_ZZZZzzzz','cli_'+'x'.repeat(64)]){
  const h=harness({env:{FEISHU_APP_ID:ok,FEISHU_APP_SECRET:appSecret}})
  await h.adapter.start(h.handler)
  await until(()=>h.adapter.status().error!==undefined)
  assert.notEqual(h.adapter.status().error,'credentials-invalid',ok)
  await h.adapter.stop()
 }
 for(const bad of ['cli_abc1234','cli_'+'x'.repeat(65),'cli_abcd-efgh','xli_abcdefgh','cli_abcdefgh\n']){
  const h=harness({env:{FEISHU_APP_ID:bad,FEISHU_APP_SECRET:appSecret}})
  await h.adapter.start(h.handler)
  await until(()=>h.adapter.status().error!==undefined)
  assert.equal(h.adapter.status().error,'credentials-invalid',bad)
  assert.equal(h.clients.length,0,bad)
 }
})

test('tenant token 缓存按适配器隔离：飞书与 Lark 用同一 App ID 也各自向本域名取 token，互不复用',async()=>{
 const shared=fakeSdk()
 const feishu=harness({sdk:shared,env:{FEISHU_APP_ID:appId,FEISHU_APP_SECRET:'TEST-feishu-only'}})
 const lark=harness({sdk:shared,brand:'lark',env:{LARK_APP_ID:appId,LARK_APP_SECRET:'TEST-lark-only'}})
 await feishu.adapter.start(feishu.handler)
 await lark.adapter.start(lark.handler)
 await until(()=>shared.clients.length===2)
 const [a,b]=shared.clients.map(c=>c.opts.cache as {get:(key:unknown,opts?:{namespace?:string})=>Promise<unknown>;set:(key:unknown,value:unknown,expire?:number,opts?:{namespace?:string})=>Promise<boolean>})
 assert.ok(a&&b&&a!==b,'每个 Client 各自带 cache')
 const token=Symbol('tenant-access-token')
 await a!.set(token,'t-feishu',Date.now()+60_000,{namespace:appId})
 assert.equal(await a!.get(token,{namespace:appId}),'t-feishu')
 assert.equal(await b!.get(token,{namespace:appId}),undefined,'Lark 不得拿到飞书的 token')
 await b!.set(token,'t-old',Date.now()-1,{namespace:appId})
 assert.equal(await b!.get(token,{namespace:appId}),undefined,'过期即失效')
 await b!.set(token,'t-forever',undefined,{namespace:appId})
 assert.equal(await b!.get(token,{namespace:appId}),'t-forever')
 await feishu.adapter.stop()
 await lark.adapter.stop()
})

test('App ID 能保存但不是 SDK 长连接接受的 cli_+16 位十六进制：建长连接前停下，状态给 app-id-unsupported，不静默「未连接」、不重试、不建 WSClient',async()=>{
 for(const brand of ['feishu','lark'] as const){
  const idKey=brand==='lark'?'LARK_APP_ID':'FEISHU_APP_ID',secretKey=brand==='lark'?'LARK_APP_SECRET':'FEISHU_APP_SECRET'
  const h=harness({brand,env:{[idKey]:'cli_a1B2c3D4e5F6g7H8',[secretKey]:appSecret}})
  await h.adapter.start(h.handler)
  await until(()=>h.adapter.status().error!==undefined)
  for(let i=0;i<20;i+=1)await tick()
  assert.equal(h.adapter.status().error,'app-id-unsupported',brand)
  assert.equal(h.adapter.status().connected,false)
  assert.equal(h.sockets.length,0,brand)
  assert.deepEqual(h.sleeps,[],'不重试')
  assert.ok(h.logs.every(line=>!line.includes(appSecret)&&!line.includes('cli_a1B2')),'日志不含 App ID 与密钥')
  await h.adapter.stop()
 }
 const ok=harness({env:{FEISHU_APP_ID:'cli_A1B2C3D4E5F60718',FEISHU_APP_SECRET:appSecret}})
 await started(ok)
 assert.equal(ok.adapter.status().error,undefined,'大写十六进制照常连接')
 await ok.adapter.stop()
})

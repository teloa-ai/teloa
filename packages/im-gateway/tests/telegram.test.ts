import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createTelegramAdapter,telegramCallbackData} from '../src/channels/telegram.ts'
import type {ImInbound} from '../src/core/types.ts'

const fixtures=JSON.parse(readFileSync(new URL('./fixtures/telegram-updates.json',import.meta.url),'utf8')) as Record<string,unknown>
const token='123456:TEST-token_value'

type Reply={status?:number;body?:unknown;parameters?:Record<string,unknown>}|'network'
type Call={method:string;body:Record<string,unknown>}

/** 本地假 Telegram：拦截 deps.fetch，只认 https://api.telegram.org/bot<token>/<method>；队列耗尽后 getUpdates 挂起直到 abort。 */
function fakeTelegram(routes:Record<string,Reply[]>){
 const calls:Call[]=[]
 const urls:string[]=[]
 const fetchImpl=(async(input:string|URL|Request,init?:RequestInit)=>{
  const url=new URL(String(input))
  urls.push(url.origin)
  assert.equal(url.origin,'https://api.telegram.org')
  const match=/^\/bot([^/]+)\/(\w+)$/.exec(url.pathname)
  assert.ok(match&&match[1]===token)
  const method=match[2]!
  calls.push({method,body:JSON.parse(String(init?.body??'{}')) as Record<string,unknown>})
  const reply=routes[method]?.shift()
  if(!reply){
   if(method!=='getUpdates')return Response.json({ok:true,result:true})
   return new Promise<Response>((_,reject)=>init?.signal?.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')),{once:true}))
  }
  if(reply==='network')throw new TypeError('fetch failed')
  const status=reply.status??200
  return Response.json(status===200?{ok:true,result:reply.body}:{ok:false,error_code:status,description:'boom',...(reply.parameters?{parameters:reply.parameters}:{})},{status})
 }) as typeof fetch
 return {calls,urls,fetchImpl}
}

function harness(routes:Record<string,Reply[]>,envToken=token){
 const tg=fakeTelegram(routes)
 const sleeps:number[]=[]
 const logs:string[]=[]
 const adapter=createTelegramAdapter({
  env:async()=>({TELEGRAM_BOT_TOKEN:envToken}),
  log:{info:(f,...v)=>logs.push([f,...v].join(' ')),warn:(f,...v)=>logs.push([f,...v].join(' '))},
  now:()=>new Date('2026-09-26T00:00:00Z'),
  fetch:tg.fetchImpl,
  sleep:ms=>{sleeps.push(ms);return new Promise(resolve=>setImmediate(resolve))},
 })
 return {...tg,sleeps,logs,adapter}
}

const tick=()=>new Promise(resolve=>setImmediate(resolve))
async function until(check:()=>boolean,limit=200):Promise<void>{
 for(let i=0;i<limit&&!check();i+=1)await tick()
 assert.ok(check(),'等待条件超时')
}
const me={body:fixtures.getMe}
const updates=(...keys:string[])=>({body:keys.map(key=>fixtures[key])})

async function collect(keys:string[]){
 const h=harness({getMe:[me],getUpdates:[updates(...keys)]})
 const got:ImInbound[]=[]
 await h.adapter.start(async m=>{got.push(m)})
 await until(()=>h.calls.filter(call=>call.method==='getUpdates').length>=2)
 await h.adapter.stop()
 return {...h,got}
}

test('私聊文本 → direct、发送者、messageId、text；offset 递增为 update_id+1；allowed_updates 含 callback_query',async()=>{
 const {got,calls,logs}=await collect(['private'])
 assert.equal(got.length,1)
 const m=got[0]!
 assert.equal(m.channelId,'telegram')
 assert.equal(m.chatId,'424242')
 assert.equal(m.chatKind,'direct')
 assert.equal(m.messageId,'11')
 assert.equal(m.text,'你好')
 assert.deepEqual(m.sender,{imUserId:'424242',displayName:'Ada Lovelace'})
 assert.equal(m.threadId,undefined)
 const polls=calls.filter(call=>call.method==='getUpdates')
 assert.equal(calls[0]!.method,'getMe')
 assert.deepEqual(polls[0]!.body,{timeout:30,allowed_updates:['message','callback_query']})
 assert.equal(polls[1]!.body.offset,1002)
 assert.ok(logs.every(line=>!line.includes(token)))
})

test('超群话题 message_thread_id → thread 与 threadId',async()=>{
 const {got}=await collect(['topic'])
 assert.equal(got[0]!.chatKind,'thread')
 assert.equal(got[0]!.threadId,'77')
 assert.equal(got[0]!.chatId,'-1001234567890')
})

test('非话题超群的普通回复带 message_thread_id 但无 is_topic_message → group，不带 threadId',async()=>{
 const {got}=await collect(['supergroupReply'])
 assert.equal(got[0]!.chatKind,'group')
 assert.equal(got[0]!.threadId,undefined)
 assert.equal(got[0]!.replyToId,'12')
})

test('entities：@bot_username → botSelf（大小写不敏感）；text_mention → user；他人 @username 不计',async()=>{
 const {got}=await collect(['mentions'])
 assert.equal(got[0]!.chatKind,'group')
 assert.deepEqual(got[0]!.mentions,[{kind:'botSelf',raw:'@Teloa_Test_Bot'},{kind:'user',imUserId:'515151',raw:'Bob'}])
})

test('callback_query a:1a2b3c4d → approve、callbackId、callbackToken=query id；非法 data 由适配器应答后丢弃；频道消息丢弃',async()=>{
 const {got,calls}=await collect(['callback','badCallback','channelPost'])
 assert.equal(got.length,1)
 assert.deepEqual(got[0]!.action,{callbackId:'1a2b3c4d',value:'approve',callbackToken:'4382bfdwdsb323b2d9'})
 assert.equal(got[0]!.messageId,'21')
 assert.equal(got[0]!.chatId,'424242')
 const answers=calls.filter(call=>call.method==='answerCallbackQuery')
 assert.deepEqual(answers.map(call=>call.body.callback_query_id),['cq-bad-1'])
})

test('telegramCallbackData：超 64 字节 throw；a:1a2b3c4d 长 10',()=>{
 assert.throws(()=>telegramCallbackData('a','x'.repeat(63)))
 assert.equal(telegramCallbackData('a','1a2b3c4d'),'a:1a2b3c4d')
 assert.equal(telegramCallbackData('a','1a2b3c4d').length,10)
})

test('sendCard 超长 callbackId 构造期失败、不出网',async()=>{
 const h=harness({})
 await assert.rejects(h.adapter.sendCard!('424242',{title:'t',lines:[],callbackId:'x'.repeat(63),approveLabel:'批准',rejectLabel:'拒绝'}))
 assert.equal(h.calls.length,0)
})

test('telegramCallbackData：字符集与入站同一正则，非法字符构造期失败、不出网',async()=>{
 assert.throws(()=>telegramCallbackData('a','bad id!'))
 assert.throws(()=>telegramCallbackData('r','a:b'))
 assert.throws(()=>telegramCallbackData('a',''))
 const h=harness({})
 await assert.rejects(h.adapter.sendCard!('424242',{title:'t',lines:[],callbackId:'<script>',approveLabel:'批准',rejectLabel:'拒绝'}))
 assert.equal(h.calls.length,0)
})

for(const [status,needle] of [[409,'another-host'],[401,'credentials-invalid'],[403,'credentials-invalid']] as const){
 test(`getUpdates 返回 ${status} → error 含「${needle}」且不再调用 fetch`,async()=>{
  const h=harness({getMe:[me],getUpdates:[{status}]})
  await h.adapter.start(async()=>{})
  await until(()=>h.adapter.status().error!==undefined)
  const count=h.calls.length
  for(let i=0;i<20;i+=1)await tick()
  assert.equal(h.calls.length,count)
  assert.equal(count,2)
  assert.equal(h.adapter.status().connected,false)
  assert.equal(h.adapter.status().error,needle)
  assert.deepEqual(h.sleeps,[])
  await h.adapter.stop()
 })
}

test('凭据格式非法 → 凭据错误、不出网',async()=>{
 const h=harness({},'bad/../token')
 await h.adapter.start(async()=>{})
 await until(()=>h.adapter.status().error!==undefined)
 assert.equal(h.adapter.status().error,'credentials-invalid')
 assert.equal(h.calls.length,0)
 await h.adapter.stop()
})

test('网络错误退避：前 3 次 sleep 为 [1000,2000,4000]；连续 10 次 → 断开且 error 非空、warn 只一次',async()=>{
 const h=harness({getMe:Array.from({length:12},()=>'network' as const)})
 await h.adapter.start(async()=>{})
 await until(()=>h.calls.length>=4)
 assert.deepEqual(h.sleeps.slice(0,3),[1000,2000,4000])
 await until(()=>h.calls.length>=12)
 await h.adapter.stop()
 assert.equal(h.adapter.status().connected,false)
 assert.equal(h.adapter.status().error,'reconnecting')
 assert.equal(h.sleeps[9],reconnectCap(10))
 assert.equal(h.logs.filter(line=>line.includes('连续失败')).length,1)
 assert.ok(h.logs.every(line=>!line.includes(token)))
})
function reconnectCap(attempt:number){return Math.min(60_000,1000*2**(attempt-1))}

const noPreview={link_preview_options:{is_disabled:true}}

test('send：HTML 失败回退纯文本（两次 sendMessage），返回 messageId；threadId → message_thread_id；两次都关闭链接预览',async()=>{
 const h=harness({sendMessage:[{status:400},{body:{message_id:99}}]})
 const result=await h.adapter.send('-1001234567890','a < b',{threadId:'77'})
 assert.deepEqual(result,{messageId:'99'})
 const sends=h.calls.filter(call=>call.method==='sendMessage')
 assert.equal(sends.length,2)
 assert.deepEqual(sends[0]!.body,{chat_id:-1001234567890,text:'a &lt; b',parse_mode:'HTML',message_thread_id:77,...noPreview})
 assert.deepEqual(sends[1]!.body,{chat_id:-1001234567890,text:'a < b',message_thread_id:77,...noPreview})
})

test('send 注入：模型输出的 HTML 标签与实体被转义，不渲染为伪装链接',async()=>{
 const h=harness({sendMessage:[{body:{message_id:1}}]})
 await h.adapter.send('424242','点<a href="https://evil.example">这里</a>领取 &amp; <b>x</b>')
 const body=h.calls[0]!.body
 assert.equal(body.parse_mode,'HTML')
 assert.equal(body.text,'点&lt;a href="https://evil.example"&gt;这里&lt;/a&gt;领取 &amp;amp; &lt;b&gt;x&lt;/b&gt;')
 assert.doesNotMatch(String(body.text),/<a\b/)
})

test('send 429：错误带 retryAfterMs=parameters.retry_after×1000，抛给上层且不回退重发',async()=>{
 const h=harness({sendMessage:[{status:429,parameters:{retry_after:3}}]})
 await assert.rejects(h.adapter.send('424242','hi'),(err:unknown)=>(err as {retryAfterMs?:number}).retryAfterMs===3000)
 assert.equal(h.calls.filter(call=>call.method==='sendMessage').length,1)
})

test('getUpdates 429：按 retry_after 等待而非指数退避',async()=>{
 const h=harness({getMe:[me],getUpdates:[{status:429,parameters:{retry_after:7}}]})
 await h.adapter.start(async()=>{})
 await until(()=>h.calls.filter(call=>call.method==='getUpdates').length>=2)
 await h.adapter.stop()
 assert.deepEqual(h.sleeps,[7000])
})

test('handler 抛错：带 action 的消息由适配器补一次 answerCallbackQuery，避免客户端转圈',async()=>{
 const h=harness({getMe:[me],getUpdates:[updates('callback')]})
 await h.adapter.start(async()=>{throw new Error('boom')})
 await until(()=>h.calls.some(call=>call.method==='answerCallbackQuery'))
 await h.adapter.stop()
 assert.deepEqual(h.calls.filter(call=>call.method==='answerCallbackQuery').map(call=>call.body),[{callback_query_id:'4382bfdwdsb323b2d9'}])
})

test('send：非 400 失败不回退、错误不含 token',async()=>{
 const h=harness({sendMessage:['network']})
 await assert.rejects(h.adapter.send('424242','hi'),(error:unknown)=>!String((error as Error).message).includes(token))
 assert.equal(h.calls.filter(call=>call.method==='sendMessage').length,1)
})

test('sendCard：inline_keyboard 两键 a:/r:，正文转义后用 HTML 模式、关闭链接预览',async()=>{
 const h=harness({sendMessage:[{body:{message_id:5}}]})
 const result=await h.adapter.sendCard!('424242',{title:'需要审批',lines:['命令：echo <a href="https://evil.example">x</a>'],callbackId:'1a2b3c4d',approveLabel:'批准',rejectLabel:'拒绝'})
 assert.deepEqual(result,{messageId:'5'})
 assert.deepEqual(h.calls[0]!.body,{chat_id:424242,text:'需要审批\n命令：echo &lt;a href="https://evil.example"&gt;x&lt;/a&gt;',parse_mode:'HTML',...noPreview,reply_markup:{inline_keyboard:[[{text:'批准',callback_data:'a:1a2b3c4d'},{text:'拒绝',callback_data:'r:1a2b3c4d'}]]}})
})

test('sendCard：正文超 4096 字截断并以省略号结尾',async()=>{
 const h=harness({sendMessage:[{body:{message_id:5}}]})
 await h.adapter.sendCard!('424242',{title:'需要审批',lines:['x'.repeat(5000)],callbackId:'1a2b3c4d',approveLabel:'批准',rejectLabel:'拒绝'})
 const text=String(h.calls[0]!.body.text)
 assert.equal(text.length,4096)
 assert.ok(text.endsWith('…'))
})

test('editMessage：请求体含 reply_markup.inline_keyboard:[]',async()=>{
 const h=harness({})
 await h.adapter.editMessage!('424242','5','已批准')
 assert.deepEqual(h.calls[0],{method:'editMessageText',body:{chat_id:424242,message_id:5,text:'已批准',reply_markup:{inline_keyboard:[]}}})
})

test('ack：answerCallbackQuery 带 callbackToken 与可选 text；无 action 不调用',async()=>{
 const h=harness({})
 const base={channelId:'telegram',chatId:'424242',chatKind:'direct',messageId:'21',sender:{imUserId:'1',displayName:'A'},text:'',mentions:[],media:[],at:'',raw:null} as const
 await h.adapter.ack!({...base,action:{callbackId:'1a2b3c4d',value:'reject',callbackToken:'cq-1'}},'无权')
 await h.adapter.ack!(base)
 assert.deepEqual(h.calls,[{method:'answerCallbackQuery',body:{callback_query_id:'cq-1',text:'无权'}}])
})

test('stop() 中断挂起的长轮询，此后 fetch 调用数不再增长',async()=>{
 const h=harness({getMe:[me]})
 await h.adapter.start(async()=>{})
 await until(()=>h.calls.some(call=>call.method==='getUpdates'))
 await h.adapter.stop()
 const count=h.calls.length
 for(let i=0;i<20;i+=1)await tick()
 assert.equal(h.calls.length,count)
 assert.equal(h.adapter.status().connected,false)
})

test('capabilities 按简报',()=>{
 const h=harness({})
 assert.deepEqual(h.adapter.capabilities,{text:true,card:true,button:true,thread:true,file:false,edit:true,maxMessageLength:4096,rateLimitPerMinute:20})
 assert.equal(h.adapter.id,'telegram')
})

test('sendCard：无 approveLabel（取不到调用参数）→ 只有「拒绝」一键',async()=>{
 const h=harness({sendMessage:[{body:{message_id:5}}]})
 await h.adapter.sendCard!('424242',{title:'需要审批',lines:['参数请到工作台查看'],callbackId:'1a2b3c4d',rejectLabel:'拒绝'})
 assert.deepEqual((h.calls[0]!.body as {reply_markup:unknown}).reply_markup,{inline_keyboard:[[{text:'拒绝',callback_data:'r:1a2b3c4d'}]]})
})

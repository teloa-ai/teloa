import test from 'node:test'
import assert from 'node:assert/strict'
import type {SessionEvent} from '@deepseek-ai/dsh-session/types'
import type {ImBinding,ImGroupBinding} from '../src/core/bindings.ts'
import {createOutbound} from '../src/core/outbound.ts'
import type {ImChannelAdapter} from '../src/core/types.ts'
import {bindingOf,groupId,roleA} from './router-fakes.ts'

type Sent={chatId:string;text:string;opts?:{threadId?:string}}

function recordingAdapter(options:{fail?:(attempt:number)=>unknown}={}){
 const sent:Sent[]=[]
 let attempt=0
 const adapter:ImChannelAdapter={
  id:'telegram',label:'Telegram',
  capabilities:{text:true,card:true,button:true,thread:true,file:false,edit:true,maxMessageLength:4096,rateLimitPerMinute:20},
  async start(){},async stop(){},
  async send(chatId,text,opts){
   attempt+=1
   const error=options.fail?.(attempt)
   if(error)throw error
   sent.push({chatId,text,...(opts?{opts}:{})});return {messageId:String(sent.length)}
  },
  status:()=>({connected:true}),
 }
 return {adapter,sent}
}

const assistant=(content:{type:string;text:string}[],patch:Record<string,unknown>={})=>({
 type:'assistant/message',seq:1,time:0,surfaceOp:'append',
 data:{turn:1,step:1,message:{id:'m1',role:'assistant',content,source:{kind:'model'}},stream:[]},
 ...patch,
}) as unknown as SessionEvent

function setup(options:{fail?:(attempt:number)=>unknown;take?:()=>boolean;runs?:Record<string,string[]>}={}){
 const a=recordingAdapter(options)
 const slept:number[]=[]
 const warnings:string[]=[]
 /** 假绑定表：默认 u1 的当前会话为 s1；测试可同步改写，模拟解绑、/new、切换同事。 */
 const bindings=new Map<string,ImBinding>([['telegram\nu1',bindingOf({assistantSessionId:'s1'})]])
 const groups=new Map<string,ImGroupBinding>([['telegram\n-200',{channelId:'telegram',chatId:'-200',groupId,boundAt:'2026-09-26T00:00:00.000Z'}]])
 const lookups:string[]=[]
 const clock={now:Date.parse('2026-09-26T00:00:00Z')}
 const outbound=createOutbound({
  adapter:id=>id==='telegram'?a.adapter:undefined,
  bindings:{
   async find(channelId,imUserId){return bindings.get(`${channelId}\n${imUserId}`)},
   async list(){return [...bindings.values()]},
   groups:{async byChat(channelId,chatId){return groups.get(`${channelId}\n${chatId}`)}},
  },
  groupRunSessions:async trigger=>{lookups.push(trigger.messageId);return (options.runs?.[trigger.messageId]??[]).map(sessionId=>({sessionId,name:sessionId==='run-b'?'老李':'小王'}))},
  now:()=>clock.now,
  rateLimit:{take:options.take??(()=>true)},
  log:{info(){},warn(format:string){warnings.push(format)}},
  sleep:async ms=>{slept.push(ms)},
 })
 return {outbound,slept,warnings,bindings,groups,lookups,clock,...a}
}

test('5a. assistant/message 整条完成 → 9000 字按 4096 分 3 片、顺序正确、带 threadId；思考块不外发',async()=>{
 const {outbound,sent}=setup()
 outbound.track('s1',{channelId:'telegram',imUserId:'u1',chatId:'100',threadId:'t1'})
 const text='甲'.repeat(4096)+'乙'.repeat(4096)+'丙'.repeat(808)
 outbound.onSessionEvent({id:'s1'},assistant([{type:'reasoning',text:'内部思考'},{type:'text',text}]))
 await outbound.idle()
 assert.equal(sent.length,3)
 assert.deepEqual(sent.map(row=>row.text.length),[4096,4096,808])
 assert.ok(sent[0]!.text.startsWith('甲')&&sent[1]!.text.startsWith('乙')&&sent[2]!.text.startsWith('丙'))
 assert.ok(sent.every(row=>row.chatId==='100'&&row.opts?.threadId==='t1'))
 assert.ok(sent.every(row=>!row.text.includes('内部思考')))
})

test('5b. Markdown 转纯文本；两条回复按到达顺序投递',async()=>{
 const {outbound,sent}=setup()
 outbound.track('s1',{channelId:'telegram',imUserId:'u1',chatId:'100'})
 outbound.onSessionEvent({id:'s1'},assistant([{type:'text',text:'**第一条**'}]))
 outbound.onSessionEvent({id:'s1'},assistant([{type:'text',text:'第二条'}]))
 await outbound.idle()
 assert.deepEqual(sent.map(row=>row.text),['第一条','第二条'])
 assert.equal(sent[0]!.opts,undefined)
})

test('5c. 未 track 的会话不投递；tool/result、tool/call、replace（压缩）、中断、纯工具调用的消息均不投递',async()=>{
 const {outbound,sent}=setup()
 outbound.onSessionEvent({id:'other'},assistant([{type:'text',text:'不该发'}]))
 outbound.track('s1',{channelId:'telegram',imUserId:'u1',chatId:'100'})
 outbound.onSessionEvent({id:'s1'},{type:'tool/result',seq:2,time:0,surfaceOp:'append',data:{turn:1,step:1,message:{id:'t',role:'tool',toolCallId:'c1',content:[{type:'text',text:'工具结果'}],source:{kind:'tool'}}}} as unknown as SessionEvent)
 outbound.onSessionEvent({id:'s1'},{type:'tool/call',seq:3,time:0,data:{turn:1,step:1,callId:'c1',name:'fs_read',arguments:'{}'}} as unknown as SessionEvent)
 outbound.onSessionEvent({id:'s1'},assistant([{type:'text',text:'压缩摘要'}],{surfaceOp:{op:'replace',startSeq:1,endSeq:2}}))
 outbound.onSessionEvent({id:'s1'},assistant([{type:'tool_call',text:''}]))
 outbound.onSessionEvent({id:'s1'},assistant([{type:'text',text:'半截'}],{data:{turn:1,step:1,message:{id:'m',role:'assistant',content:[{type:'text',text:'半截'}],source:{kind:'model'}},stream:[],interrupted:true}}))
 await outbound.idle()
 assert.deepEqual(sent,[])
})

test('5d. 适配器抛 retryAfterMs → 等待该时长后重试同一片，后续片顺序不乱',async()=>{
 const {outbound,sent,slept}=setup({fail:attempt=>attempt===2?Object.assign(new Error('429'),{retryAfterMs:3000}):undefined})
 outbound.track('s1',{channelId:'telegram',imUserId:'u1',chatId:'100'})
 outbound.onSessionEvent({id:'s1'},assistant([{type:'text',text:'甲'.repeat(4096)+'乙'.repeat(4096)+'丙'}]))
 await outbound.idle()
 assert.deepEqual(slept,[3000])
 assert.deepEqual(sent.map(row=>row.text[0]),['甲','乙','丙'])
})

test('5e. 非限流错误 → 放弃本条剩余分片并记告警，不影响下一条',async()=>{
 const {outbound,sent,warnings}=setup({fail:attempt=>attempt===1?new Error('boom'):undefined})
 outbound.track('s1',{channelId:'telegram',imUserId:'u1',chatId:'100'})
 outbound.onSessionEvent({id:'s1'},assistant([{type:'text',text:'甲'.repeat(4096)+'乙'}]))
 outbound.onSessionEvent({id:'s1'},assistant([{type:'text',text:'下一条'}]))
 await outbound.idle()
 assert.deepEqual(sent.map(row=>row.text),['下一条'])
 assert.equal(warnings.length,1)
 assert.doesNotMatch(warnings[0]!,/boom|甲/)
})

test('5f. 渠道出站限流 → 等待后再发，不丢片',async()=>{
 let budget=1
 const {outbound,sent,slept}=setup({take:()=>{if(budget>0){budget-=1;return true}budget=1;return false}})
 outbound.track('s1',{channelId:'telegram',imUserId:'u1',chatId:'100'})
 outbound.onSessionEvent({id:'s1'},assistant([{type:'text',text:'甲'.repeat(4096)+'乙'}]))
 await outbound.idle()
 assert.deepEqual(sent.map(row=>row.text[0]),['甲','乙'])
 assert.equal(slept.length,1)
})

test('M2. 投递前重查绑定：解绑、/new、切换同事、移除渠道之后不再外发；当前同事会话照常外发',async()=>{
 const {outbound,sent,bindings}=setup()
 const route={channelId:'telegram',imUserId:'u1',chatId:'100'}
 outbound.track('s1',route)
 outbound.onSessionEvent({id:'s1'},assistant([{type:'text',text:'解绑前'}]))
 await outbound.idle()
 // 事件已进队、尚未投递时解绑：投递前重查，丢弃。
 outbound.onSessionEvent({id:'s1'},assistant([{type:'text',text:'解绑后'}]))
 bindings.delete('telegram\nu1')
 await outbound.idle()
 bindings.set('telegram\nu1',bindingOf({assistantSessionId:'s2'}))
 outbound.onSessionEvent({id:'s1'},assistant([{type:'text',text:'new 之后的旧会话'}]))
 await outbound.idle()
 bindings.set('telegram\nu1',bindingOf({assistantSessionId:'s1',target:{kind:'role',roleId:roleA.id},roleSessionIds:{[roleA.id]:'s3'}}))
 outbound.onSessionEvent({id:'s1'},assistant([{type:'text',text:'切换同事后的助理会话'}]))
 outbound.track('s3',route)
 outbound.onSessionEvent({id:'s3'},assistant([{type:'text',text:'同事会话'}]))
 await outbound.idle()
 bindings.clear()
 outbound.onSessionEvent({id:'s3'},assistant([{type:'text',text:'移除渠道后'}]))
 await outbound.idle()
 assert.deepEqual(sent.map(row=>row.text),['解绑前','同事会话'])
})

test('M2. 路由带 imUserId：会话属于另一绑定（imUserId 不符）→ 丢弃',async()=>{
 const {outbound,sent,bindings}=setup()
 bindings.set('telegram\nu2',bindingOf({imUserId:'u2',assistantSessionId:'s9'}))
 outbound.track('s9',{channelId:'telegram',imUserId:'u1',chatId:'100'})
 outbound.onSessionEvent({id:'s9'},assistant([{type:'text',text:'串线'}]))
 await outbound.idle()
 assert.deepEqual(sent,[])
})

test('I1. 未 track（宿主重启后）：按绑定里的私聊 chatId 与当前会话重建路由，无需本人先发消息；旧绑定缺 chatId 不投递',async()=>{
 const {outbound,sent,bindings}=setup()
 bindings.set('telegram\nu1',bindingOf({assistantSessionId:'s1',chatId:'100'}))
 outbound.onSessionEvent({id:'s1'},assistant([{type:'text',text:'重启后回复'}]))
 outbound.onSessionEvent({id:'s-workbench'},assistant([{type:'text',text:'工作台会话'}]))
 await outbound.idle()
 bindings.set('telegram\nu1',bindingOf({assistantSessionId:'s1'}))
 outbound.onSessionEvent({id:'s1'},assistant([{type:'text',text:'旧绑定'}]))
 await outbound.idle()
 assert.deepEqual(sent.map(row=>[row.chatId,row.text]),[['100','重启后回复']])
})

const trigger={channelId:'telegram',chatId:'-200',imUserId:'u1',groupId,messageId:'m1',since:'2026-09-26T00:00:00.000Z'}

test('I2. 群 @ 触发的同事运行会话 → 回发到对应 IM 群（分片、串行不交错、retryAfterMs）；别的会话不外发、反查合并且无关会话不重复反查',async()=>{
 const {outbound,sent,slept,lookups}=setup({runs:{m1:['run-a','run-b']},fail:attempt=>attempt===2?Object.assign(new Error('429'),{retryAfterMs:1500}):undefined})
 outbound.expectGroup(trigger)
 outbound.onSessionEvent({id:'run-a'},assistant([{type:'text',text:'甲'.repeat(4092)+'乙'}]))
 outbound.onSessionEvent({id:'run-b'},assistant([{type:'text',text:'丙'.repeat(4092)+'丁'}]))
 outbound.onSessionEvent({id:'s-workbench'},assistant([{type:'text',text:'工作台会话'}]))
 outbound.onSessionEvent({id:'s-workbench'},assistant([{type:'text',text:'工作台会话 2'}]))
 await outbound.idle()
 assert.ok(sent.every(row=>row.chatId==='-200'))
 // 每条回复首片带固定格式的同事名前缀（4 字 + 4092 字恰满一片），续片不重复。
 const firsts=sent.filter(row=>row.text.startsWith('【'))
 assert.deepEqual(firsts.map(row=>row.text.slice(0,4)).sort(),['【小王】','【老李】'].sort())
 const heads=sent.map(row=>row.text.replace(/^【[^】]+】/,'')[0])
 assert.deepEqual([...heads].sort(),[...'丁丙乙甲'].sort())
 assert.ok(heads.indexOf('乙')===heads.indexOf('甲')+1&&heads.indexOf('丁')===heads.indexOf('丙')+1,'同一条回复的分片连续：'+heads.join(''))
 assert.deepEqual(slept,[1500])
 // 四条事件同时到达：共用一次反查（run-a、run-b 一并登记，工作台会话判为无关）；无关会话此后不再反查。
 outbound.onSessionEvent({id:'s-workbench'},assistant([{type:'text',text:'工作台会话 3'}]))
 await outbound.idle()
 assert.deepEqual(lookups,['m1'])
 assert.equal(sent.length,4)
})

test('I2. 群绑定解除、触发者解绑、触发超时后 → 不再回发',async()=>{
 {
  const {outbound,sent,groups}=setup({runs:{m1:['run-a']}})
  outbound.expectGroup(trigger)
  outbound.onSessionEvent({id:'run-a'},assistant([{type:'text',text:'一'}]))
  groups.clear()
  await outbound.idle()
  assert.deepEqual(sent,[])
 }
 {
  const {outbound,sent,bindings}=setup({runs:{m1:['run-a']}})
  outbound.expectGroup(trigger)
  bindings.clear()
  outbound.onSessionEvent({id:'run-a'},assistant([{type:'text',text:'二'}]))
  await outbound.idle()
  assert.deepEqual(sent,[])
 }
 {
  const {outbound,sent,clock}=setup({runs:{m1:['run-a']}})
  outbound.expectGroup(trigger)
  clock.now+=61*60_000
  outbound.onSessionEvent({id:'run-a'},assistant([{type:'text',text:'三'}]))
  await outbound.idle()
  assert.deepEqual(sent,[])
 }
})

const turnEnd=()=>({type:'turn/end',seq:2,time:0,data:{turn:1,reason:'completed'}}) as unknown as SessionEvent

test('L2 群 @ 派生会话：首条完整回复（无工具调用）投递后即摘除回发登记，此后同一会话不再外发；带工具调用的中间回复不摘除',async()=>{
 const {outbound,sent,lookups}=setup({runs:{m1:['run-a']}})
 outbound.expectGroup(trigger)
 outbound.onSessionEvent({id:'run-a'},assistant([{type:'text',text:'我先查一下'},{type:'tool-call',text:''}]))
 outbound.onSessionEvent({id:'run-a'},assistant([{type:'text',text:'结论'}]))
 outbound.onSessionEvent({id:'run-a'},assistant([{type:'text',text:'后续回合'}]))
 await outbound.idle()
 assert.deepEqual(sent.map(row=>row.text),['【小王】我先查一下','【小王】结论'])
 // 同一触发仍有效：已摘除的会话不因再次反查而重新登记。
 outbound.onSessionEvent({id:'run-a'},assistant([{type:'text',text:'再后续'}]))
 await outbound.idle()
 assert.equal(sent.length,2)
 assert.deepEqual(lookups,['m1'])
})

test('L2 群 @ 派生会话：运行结束（turn/end）即摘除回发登记；私聊会话不受影响',async()=>{
 const {outbound,sent}=setup({runs:{m1:['run-a']}})
 outbound.expectGroup(trigger)
 outbound.onSessionEvent({id:'run-a'},assistant([{type:'text',text:'查询中'},{type:'tool-call',text:''}]))
 outbound.onSessionEvent({id:'run-a'},turnEnd())
 outbound.onSessionEvent({id:'run-a'},assistant([{type:'text',text:'下一回合'}]))
 outbound.track('s1',{channelId:'telegram',imUserId:'u1',chatId:'100'})
 outbound.onSessionEvent({id:'s1'},assistant([{type:'text',text:'私聊一'}]))
 outbound.onSessionEvent({id:'s1'},turnEnd())
 outbound.onSessionEvent({id:'s1'},assistant([{type:'text',text:'私聊二'}]))
 await outbound.idle()
 assert.deepEqual(sent.filter(row=>row.chatId==='-200').map(row=>row.text),['【小王】查询中'])
 assert.deepEqual(sent.filter(row=>row.chatId==='100').map(row=>row.text),['私聊一','私聊二'])
})

test('L2 sendDirect（通知用）：先等渠道令牌再发、排入该聊天的串行队列，返回平台 messageId；渠道不在线 → 抛错',async()=>{
 let tokens=0
 const h=setup({take:()=>(tokens+=1)>1})
 const receipt=await h.outbound.sendDirect({channelId:'telegram',chatId:'100'},'任务运行已完成')
 assert.deepEqual(h.slept,[3000])
 assert.deepEqual(receipt,{messageId:'1'})
 assert.deepEqual(h.sent.map(row=>row.text),['任务运行已完成'])
 await assert.rejects(h.outbound.sendDirect({channelId:'slack',chatId:'D1'},'x'),/offline/)
})

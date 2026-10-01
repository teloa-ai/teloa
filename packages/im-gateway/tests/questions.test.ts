import test from 'node:test'
import assert from 'node:assert/strict'
import type {AskUserQuestionAnswer,AskUserQuestionRequestEvent} from '@deepseek-ai/dsh-user-questions/types'
import {createImQuestions} from '../src/core/questions.ts'
import type {ImInbound} from '../src/core/types.ts'
import {approvalHarness,deferred,probe,tick} from './approval-fakes.ts'
import {bindingOf} from './router-fakes.ts'

const binding=bindingOf({chatId:'100'})
const single:AskUserQuestionRequestEvent={questions:[{id:'q1',question:'用哪个方案？',options:[{label:'方案甲'},{label:'方案乙',description:'更快'}]}]}
const reply=(text:string,patch:Partial<ImInbound>={}):ImInbound=>({
 channelId:'telegram',chatId:'100',chatKind:'direct',messageId:'m'+Math.random(),sender:{imUserId:'u1',displayName:'张三'},
 text,mentions:[],media:[],at:'2026-09-26T00:00:00.000Z',raw:{},...patch,
})
/** dsh-user-questions 链尾默认：reject UserQuestionError NO_PROVIDER（lib/index.js noAnswerer）。 */
const noProvider=()=>Object.assign(new Error('no user-questions answerer accepted the request'),{name:'UserQuestionError',code:'NO_PROVIDER'})

async function ask(im:ReturnType<typeof createImQuestions>,request=single){
 const workbench=deferred<AskUserQuestionAnswer>()
 const promise=im.answerer(request,()=>workbench.promise)
 await tick()
 return {workbench,promise,result:probe(promise)}
}

test('无绑定或无在线渠道 → 直接 next()、不发文字',async()=>{
 for(const options of [{bindings:[]},{online:[]}]){
  const {deps,tg}=approvalHarness(options)
  const im=createImQuestions(deps)
  const answer={answers:[{id:'q1',selected:['方案甲']}]}
  assert.deepEqual(await im.answerer(single,async()=>answer),answer)
  assert.equal(tg.sent.length,0)
 }
})

test('13. 单题两选项 → IM 收到编号文本；回复 2 → selected 为第二个选项的 label；审计 question-answer',async()=>{
 const {deps,tg,audit}=approvalHarness()
 const im=createImQuestions(deps)
 const run=await ask(im)
 assert.equal(tg.sent.length,1)
 assert.equal(tg.sent[0]!.chatId,'100')
 assert.match(tg.sent[0]!.text,/用哪个方案？/)
 assert.match(tg.sent[0]!.text,/1\. 方案甲/)
 assert.match(tg.sent[0]!.text,/2\. 方案乙/)
 assert.match(tg.sent[0]!.text,/回复编号或直接输入/)
 assert.equal(await im.tryAnswer('telegram',reply('2'),binding),true)
 assert.deepEqual(await run.promise,{answers:[{id:'q1',selected:['方案乙']}]})
 assert.deepEqual(audit.map(row=>[row.action,row.result]),[['question-answer','ok']])
 assert.equal(audit[0]!.text,undefined,'回答原文不进审计')
 assert.equal(im.pendingCount(),0)
})

test('13. 回复自由文本 → custom；超出范围的编号也按自由文本',async()=>{
 for(const text of ['两个都不要','9']){
  const {deps}=approvalHarness()
  const im=createImQuestions(deps)
  const run=await ask(im)
  await im.tryAnswer('telegram',reply(text),binding)
  assert.deepEqual(await run.promise,{answers:[{id:'q1',selected:[],custom:text}]})
 }
})

test('13. 工作台先答 → IM 收到「已在网页回答」、返回工作台答案；随后回复不被消费',async()=>{
 const {deps,tg}=approvalHarness()
 const im=createImQuestions(deps)
 const run=await ask(im)
 const answer={answers:[{id:'q1',selected:['方案甲']}]}
 run.workbench.resolve(answer)
 assert.deepEqual(await run.promise,answer)
 assert.equal(tg.sent.at(-1)!.text,'已在网页回答')
 assert.equal(await im.tryAnswer('telegram',reply('1'),binding),false)
})

test('多选题：回复「1,2」→ 两个 label；多题逐题问下一题',async()=>{
 const {deps,tg}=approvalHarness()
 const im=createImQuestions(deps)
 const run=await ask(im,{questions:[
  {id:'a',question:'要哪些？',multiSelect:true,options:[{label:'甲'},{label:'乙'},{label:'丙'}]},
  {id:'b',question:'备注？'},
 ]})
 assert.match(tg.sent[0]!.text,/（1\/2）/)
 await im.tryAnswer('telegram',reply('1, 3'),binding)
 assert.equal(run.result.settled,false)
 assert.match(tg.sent.at(-1)!.text,/（2\/2）[\s\S]*备注？/)
 await im.tryAnswer('telegram',reply('尽快'),binding)
 assert.deepEqual(await run.promise,{answers:[{id:'a',selected:['甲','丙']},{id:'b',selected:[],custom:'尽快'}]})
})

test('非绑定者或别的聊天的消息不被消费；同一聊天已有待答提问 → 新提问直接交工作台',async()=>{
 const {deps,tg}=approvalHarness()
 const im=createImQuestions(deps)
 const run=await ask(im)
 assert.equal(await im.tryAnswer('telegram',reply('1',{sender:{imUserId:'u9',displayName:'李四'}}),bindingOf({imUserId:'u9',chatId:'100'})),false)
 assert.equal(await im.tryAnswer('telegram',reply('1',{chatId:'200'}),binding),false)
 const answer={answers:[{id:'x',selected:[]}]}
 assert.deepEqual(await im.answerer({questions:[{id:'x',question:'另一个问题'}]},async()=>answer),answer)
 assert.equal(tg.sent.length,1)
 assert.equal(run.result.settled,false)
})

test('H2：工作台 next() 立即 NO_PROVIDER 不算回答 → 继续等 IM；IM 回答照常生效',async()=>{
 const {deps}=approvalHarness()
 const im=createImQuestions(deps)
 const run=await ask(im)
 run.workbench.reject(noProvider())
 await tick()
 assert.equal(run.result.settled,false)
 await im.tryAnswer('telegram',reply('1'),binding)
 assert.deepEqual(await run.promise,{answers:[{id:'q1',selected:['方案甲']}]})
})

test('H2：工作台 NO_PROVIDER、无人回答 → 超时才撤下并原样抛出链尾错误',async()=>{
 const {deps,tg,timers}=approvalHarness()
 const im=createImQuestions(deps)
 const run=await ask(im)
 const error=noProvider()
 run.workbench.reject(error)
 await tick()
 assert.equal(run.result.settled,false)
 assert.deepEqual(timers.ms(),[30*60_000])
 timers.fire()
 await assert.rejects(run.promise,thrown=>thrown===error)
 assert.match(tg.sent.at(-1)!.text,/^已过期/)
 assert.equal(im.pendingCount(),0)
 assert.equal(await im.tryAnswer('telegram',reply('1'),binding),false)
})

test('超时时工作台仍未答 → 撤下 IM 提问，继续等工作台',async()=>{
 const {deps,timers}=approvalHarness()
 const im=createImQuestions(deps)
 const run=await ask(im)
 timers.fire()
 await tick()
 assert.equal(run.result.settled,false)
 const answer={answers:[{id:'q1',selected:['方案乙']}]}
 run.workbench.resolve(answer)
 assert.deepEqual(await run.promise,answer)
})

test('signal abort → IM 提问撤下；工作台已报 NO_PROVIDER 时抛出取消原因（由服务转成 ASK_ABORTED）',async()=>{
 const {deps,tg}=approvalHarness()
 const im=createImQuestions(deps)
 const controller=new AbortController()
 const run=await ask(im,{...single,signal:controller.signal})
 run.workbench.reject(noProvider())
 await tick()
 controller.abort()
 await assert.rejects(run.promise,thrown=>thrown===controller.signal.reason)
 assert.equal(tg.sent.at(-1)!.text,'提问已取消')
 assert.equal(im.pendingCount(),0)
})

test('withdrawChannel／withdrawUser → 发撤下文案、pending 清空，不产生回答',async()=>{
 for(const withdraw of ['channel','user'] as const){
  const {deps,tg}=approvalHarness()
  const im=createImQuestions(deps)
  const run=await ask(im)
  if(withdraw==='channel')await im.withdrawChannel('telegram');else await im.withdrawUser('telegram','u1')
  assert.equal(tg.sent.at(-1)!.text,withdraw==='channel'?'渠道已停用，请到工作台处理':'已失效')
  assert.equal(im.pendingCount(),0)
  await tick()
  assert.equal(run.result.settled,false)
  const answer={answers:[{id:'q1',selected:['方案甲']}]}
  run.workbench.resolve(answer)
  assert.deepEqual(await run.promise,answer)
 }
})

test('提问正文按审计口径脱敏并按渠道上限截断',async()=>{
 const {deps,tg}=approvalHarness({maxMessageLength:120})
 const im=createImQuestions(deps)
 await ask(im,{questions:[{id:'q',question:'确认 token=ghp_abcdefghijklmnop1234 可用吗？'+'长'.repeat(500)}]})
 assert.doesNotMatch(tg.sent[0]!.text,/ghp_abcdefghijklmnop1234/)
 assert.ok(tg.sent[0]!.text.length<=120)
})

test('M2 发提问超过 5 秒 → 立即交工作台、占位撤下；迟到送达后补一条转工作台文案',async()=>{
 const hold=deferred<void>()
 const {deps,tg,timers}=approvalHarness({holdSend:hold.promise,workbenchUrl:'http://127.0.0.1:3100/'})
 const im=createImQuestions(deps)
 const answer={answers:[{id:'q1',selected:['方案甲']}]}
 let nextCalls=0
 const result=probe(im.answerer(single,async()=>{nextCalls+=1;return answer}))
 await tick()
 assert.deepEqual(timers.ms(),[5000])
 assert.equal(nextCalls,0)
 timers.fire()
 await tick()
 assert.equal(nextCalls,1)
 assert.deepEqual(result.value,answer)
 assert.equal(im.pendingCount(),0)
 hold.resolve()
 await tick()
 assert.deepEqual(tg.sent.map(row=>row.text.split('\n')[0]),['用哪个方案？','发送超时，请到工作台回答'])
 assert.equal(tg.sent[1]!.text,'发送超时，请到工作台回答\nhttp://127.0.0.1:3100/')
 assert.equal(timers.size(),0)
})

test('M2 发提问在 5 秒内完成 → 清掉发送定时器，只剩 30 分钟超时',async()=>{
 const {deps,timers}=approvalHarness()
 const im=createImQuestions(deps)
 await ask(im)
 assert.deepEqual(timers.ms(),[30*60_000])
})

test('L2 提问超时文案附工作台链接',async()=>{
 const {deps,tg,timers}=approvalHarness({workbenchUrl:'http://127.0.0.1:3100/'})
 const im=createImQuestions(deps)
 await ask(im)
 timers.fire()
 await tick()
 assert.equal(tg.sent.at(-1)!.text,'已过期，请到工作台回答\nhttp://127.0.0.1:3100/')
})

test('L1 withdrawAll → 全部提问发停止文案并撤下，不产生回答',async()=>{
 const {deps,tg}=approvalHarness()
 const im=createImQuestions(deps)
 const run=await ask(im)
 await im.withdrawAll()
 assert.equal(tg.sent.at(-1)!.text,'IM 通道已停止，请到工作台处理')
 assert.equal(im.pendingCount(),0)
 assert.equal(run.result.settled,false)
})

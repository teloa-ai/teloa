import test from 'node:test'
import assert from 'node:assert/strict'
import {searchConversationContent} from '../src/conversation-content-search.ts'

const record=(id:string)=>({header:{id},updatedAt:1})
const document=(sessionId:string,text:string)=>({sessionId,text,type:'user/message',surface:'current',source:{kind:'user'}})
test('正文检索沿本人绑定调用原生语义过滤，中文子串命中；不读取内部、子 Agent 或他人会话',async()=>{
 const calls:string[]=[],row=(sessionId:string)=>({sessionId,status:'ready',purpose:undefined})
 const result=await searchConversationContent({list:async()=>[row('owned'),row('task-run-12345678-1234-4234-8234-123456789012'),row('subagent')],sessions:async()=>[record('owned'),record('private'),{header:{id:'subagent',origin:'subagent'},updatedAt:1}],filter:async(id,query)=>{calls.push(id+':'+query);return [document(id,'请知回复语音通话测试成功，不要操作文件。')]}},{query:' 语音 '},new AbortController().signal)
 assert.deepEqual(calls,['owned:语音'])
 assert.deepEqual(result,{items:[{sessionId:'owned',snippet:'请知回复语音通话测试成功，不要操作文件。'}],hasMore:false})
})

test('取消和目录归属变化不得发布迟到正文，失败不假装成无匹配',async()=>{
 const abort=new AbortController(),row={sessionId:'owned',status:'ready',purpose:undefined};let calls=0
 const ports={list:async()=>++calls===1?[row]:[],sessions:async()=>[record('owned')],filter:async()=>[document('owned','可读的旧结论')]}
 assert.deepEqual(await searchConversationContent(ports,{query:'结论'},abort.signal),{items:[],hasMore:false})
 await assert.rejects(searchConversationContent({...ports,list:async()=>[row],filter:async()=>{abort.abort();return [document('owned','不能发布')]}},{query:'结论'},abort.signal),{name:'AbortError'})
 await assert.rejects(searchConversationContent({...ports,list:async()=>[row],filter:async()=>{throw Error('原生读取失败')}},{query:'结论'},new AbortController().signal),/原生读取失败/)
})

test('空本人目录不枚举原生历史，来源或可见面不匹配时拒绝发布',async()=>{
 const signal=new AbortController().signal
 assert.deepEqual(await searchConversationContent({list:async()=>[],sessions:async()=>{throw Error('不应枚举他人历史')},filter:async()=>[]},{query:'资料'},signal),{items:[],hasMore:false})
 for(const patch of [{sessionId:'private'},{surface:'log-only'},{type:'tool/result'},{source:{kind:undefined}}]){
  await assert.rejects(searchConversationContent({list:async()=>[{sessionId:'owned',status:'ready'}],sessions:async()=>[record('owned')],filter:async()=>[{...document('owned','资料'),...patch}] as never},{query:'资料'},signal),{code:'teloa/invalid-host-response'})
 }
})

test('普通正文排除自动指令和上下文快照，仍检索模型回复与可见工作通知',async()=>{
 const notes=[{...document('owned','隐藏的系统指令'),source:{kind:'runtime-context',form:'instructions'}},{...document('owned','隐藏的环境快照'),source:{kind:'runtime-context',form:'snapshot'}}]
 const ports={list:async()=>[{sessionId:'owned',status:'ready'}],sessions:async()=>[record('owned')],filter:async()=>notes}
 assert.deepEqual(await searchConversationContent(ports,{query:'隐藏'},new AbortController().signal),{items:[],hasMore:false})
 for(const visible of [{...document('owned','通知语音结果'),source:{kind:'plugin:teloa.work',form:'notice'}},{...document('owned','模型语音结果'),type:'assistant/message',source:{kind:'model'}}]){
  const result=await searchConversationContent({...ports,filter:async()=>[visible,...notes]},{query:'语音'},new AbortController().signal)
  assert.equal(result.items[0]?.snippet,visible.text)
 }
})

test('结果范围有明确截断信号，片段保留命中位置和 Unicode；非法载荷不访问来源',async()=>{
 let reads=0
 const ids=Array.from({length:52},(_,i)=>'owned-'+i),ports={list:async()=>ids.map(sessionId=>({sessionId,status:'ready',purpose:undefined})),sessions:async()=>ids.map(record),filter:async(id:string)=>{reads++;return [document(id,'🙂'.repeat(300)+'语音结果'+'后续'.repeat(300))]}}
 for(const query of ['',String.fromCharCode(0),'x'.repeat(1001)])await assert.rejects(searchConversationContent(ports,{query},new AbortController().signal),{code:'teloa/invalid-input'})
 assert.equal(reads,0)
 const result=await searchConversationContent(ports,{query:'语音'},new AbortController().signal)
 assert.equal(result.items.length,50);assert.equal(result.hasMore,true);assert.match(result.items[0]!.snippet,/语音结果/);assert.ok(Array.from(result.items[0]!.snippet).length<=242)
})

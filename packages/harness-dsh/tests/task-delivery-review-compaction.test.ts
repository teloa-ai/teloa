import test from 'node:test'
import assert from 'node:assert/strict'
import {TokenMeter} from '@deepseek-ai/dsh-token-meter'
import {createUserMessage,type StreamChunk} from '@deepseek-ai/dsh-llm'
import type {SessionEvent} from '@deepseek-ai/dsh-session'
import {createReviewSourceCatalog,deliveryReviewSource,deliveryReviewToolName,leaseTaskDeliveryReview,splitReviewUnits,type DeliveryReviewTrace,type ReviewMaterial} from '../src/task-delivery-review.ts'
import {LocalModelCompaction} from '../src/local-model-compaction.ts'
import {readTaskRunGroupResult} from '../src/task-run-group-result.ts'
import {registerTaskToolGuard} from '../src/task-tool-guard.ts'
import {loopWorkFixture} from './fixtures/native-loop-work-admission.ts'

// 实跑形态（MiniMax-M2.7）：R1 单元之间官方自动压力压缩把「待校正草稿」数据节点并入摘要，R1→R2 收为 round-surface。
type Reply=readonly StreamChunk[]
const text=(value:string):Reply=>[{type:'block-start',index:0,blockType:'text'},{type:'text-delta',index:0,text:value},{type:'block-end',index:0,block:{type:'text',text:value}},{type:'finish',reason:{kind:'stop'}}]
let serial=0
const call=(args:unknown):Reply=>[
 {type:'block-start',index:0,blockType:'tool-call'},
 {type:'block-end',index:0,block:{type:'tool-call',id:'compaction-call-'+(++serial),name:deliveryReviewToolName,arguments:JSON.stringify(args)}},
 {type:'finish',reason:{kind:'tool-calls'}},
] as unknown as Reply
const goal='按原资料整理九节说明。'
const catalog=createReviewSourceCatalog([{id:'goal',kind:'goal',title:'原目标',text:goal,origin:{field:'inputText',pointer:'/task/goal'}}])
const material:ReviewMaterial={goal,inputs:{knowledge:0,group:false,context:false},methods:[],catalog}
const checks=(['goal',1,2,3,4,5,6,7,8] as const).map(id=>({id,status:'pass'}))
const revise=()=>call({phase:'revise',issues:[]})
const verify=()=>call({phase:'verify',verdict:'accept',checks,changeChecks:[],findings:[]})
const section=(n:number)=>`## 第${n}节\n\n`+Array.from({length:140},(_,j)=>`第${n}节第${j}句内容。`).join('')+'\n'
const longDraft=Array.from({length:9},(_,i)=>section(i+1)).join('\n')
const draftData=(event:SessionEvent)=>event.type==='user/message'&&event.data.source.kind===deliveryReviewSource&&Reflect.get(event.data.source,'summary')==='待校正草稿'

test('真实Loop：R1单元之间官方自动压力压缩只摘要复核前历史，复核数据与R1尾段保持原样，R2照常独立验收并可冷读',async t=>{
 assert.equal(splitReviewUnits(longDraft).length,4,'R1与R2各四个单元，压缩发生在R1单元之间')
 const f=await loopWorkFixture(t,true),traces:DeliveryReviewTrace[]=[]
 // 起草与R1首单元按大窗口运行；R1首单元回执落盘后窗口收紧，下一单元的官方 pre-step 压力检查实际触发压缩；压缩结束后恢复，避免额外摘要调用。
 let window=1_000_000
 f.adapter.resolveModel=async(provider,model)=>({provider,id:model,name:model,inputModalities:['text'] as const,context:{contextWindow:window},defaultMaxTokens:256})
 await f.ctx.plugin(TokenMeter)
 await f.agent.ctx.plugin(LocalModelCompaction,{headroomTokens:128,maxTokens:256,retainTokens:0,compactionRetries:0,maxOverflowRetries:1})
 f.agent.ctx.on('session/event',(_session,event)=>{
  if(event.type==='tool/result'&&f.adapter.requests.length===2)window=2400
  if(event.type==='compaction/end')window=1_000_000
 })
 f.adapter.scripts.push(text(longDraft),revise(),text('早前对话摘要。'),revise(),revise(),revise(),verify(),verify(),verify(),verify())
 registerTaskToolGuard(f.ctx,async()=>({allowedTools:[],nativeRequestId:'loop-input'}))
 leaseTaskDeliveryReview(f.agent,{runId:'compaction-run',requestId:'loop-input',material,trace:entry=>{traces.push(entry)},publish:async message=>{f.agent.inject(message)}})
 const history='原始取证资料（大段工具回执的替身）：'+'a'.repeat(9000)
 f.agent.followup(createUserMessage({source:{kind:'user',rpcId:'loop-input'},content:[{type:'text',text:history}]}));await f.agent.whenIdle()

 assert.ok(!traces.some(entry=>entry.state==='failed'),JSON.stringify(traces.filter(entry=>entry.state==='failed')))
 assert.deepEqual(f.adapter.requests.map(request=>request.purpose??'main'),['main','main','compaction',...Array.from({length:7},()=>'main')],'压缩确实发生在R1第1与第2单元之间')
 const compactions=f.events.filter(event=>event.type==='compaction/end')
 assert.equal(compactions.length,1);assert.ok(compactions[0]!.type==='compaction/end'&&!compactions[0]!.data.error,'压缩真实提交')
 const firstData=f.events.find(draftData)!,checkpoint=f.events.find(event=>event.type==='user/message'&&event.data.source.kind==='compact-checkpoint')
 assert.ok(checkpoint&&typeof checkpoint.surfaceOp==='object')
 assert.ok(checkpoint.surfaceOp.endSeq<firstData.seq&&!(checkpoint.sourceEventSeqs??[]).includes(firstData.seq),'压缩只摘要复核前历史，不吞复核数据节点')
 assert.deepEqual(f.events.flatMap(event=>event.type==='turn/end'?[event.data.reason.kind]:[]),['completed'])
 const output=longDraft.trim()
 assert.equal(readTaskRunGroupResult(f.events,'loop-input',undefined,undefined,{requireReview:true,runId:'compaction-run'}),output)
 assert.equal(readTaskRunGroupResult(JSON.parse(JSON.stringify(f.events)) as SessionEvent[],'loop-input',undefined,undefined,{requireReview:true,runId:'compaction-run'}),output,'冷读复核记录仍成立')
 // R2 独立验收：看到完整当前稿，不再看到 R1 回执。
 const r2=JSON.stringify(f.adapter.requests[6]!.messages)
 assert.ok(r2.includes('第9节第139句内容。')&&!r2.includes('compaction-call-1'),'R2按完整当前稿独立验收')
 assert.equal(f.events.filter(draftData).length,2,'R1与R2各一次复核数据替换')
})

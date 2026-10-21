import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {SubagentRuntime} from '@deepseek-ai/dsh-subagent'
import TeamService from '@deepseek-ai/dsh-experimental-agent-team'
import * as TeamTools from '@deepseek-ai/dsh-experimental-tool-agent-team'
import {createUserMessage,type GenerateOptions,type StreamChunk} from '@deepseek-ai/dsh-llm'
import {defineTool} from '@deepseek-ai/dsh-tools'
import type {SessionEvent} from '@deepseek-ai/dsh-session'
import {loopWorkFixture} from './fixtures/native-loop-work-admission.ts'
import {installNativeWorkingDirectory} from './fixtures/native-working-directory.ts'
import {collectReviewToolEvidence,replayReviewToolEvidence,reviewToolSources,type DeliveryReviewExecutionSnapshot} from '../src/task-delivery-review-tools.ts'
import {createReviewSourceCatalog,deliveryReviewToolName,leaseTaskDeliveryReview,splitReviewBlocks,type DeliveryReviewTrace} from '../src/task-delivery-review.ts'
import {readTaskRunGroupResult} from '../src/task-run-group-result.ts'
import {readSessionEvents} from '../src/session-events.ts'

type Reply=readonly StreamChunk[]
let serial=0
const text=(value:string):Reply=>[{type:'block-start',index:0,blockType:'text'},{type:'text-delta',index:0,text:value},{type:'block-end',index:0,block:{type:'text',text:value}},{type:'finish',reason:{kind:'stop'}}]
const call=(name:string,args:unknown,body?:string):Reply=>[...body?text(body).slice(0,-1):[],{type:'block-start',index:body?1:0,blockType:'tool-call'},{type:'block-end',index:body?1:0,block:{type:'tool-call',id:'book-call-'+(++serial),name,arguments:JSON.stringify(args)}},{type:'finish',reason:{kind:'tool-calls'}}] as Reply
const goal='计算37×23，结果必须为851，并完整说明计算过程；只在本会话内计算。'
const full='**37 × 23 = 851**\n\n计算过程：\n\n1. **分解法**：将 23 拆分为 20 + 3\n   - 37 × 20 = 740\n   - 37 × 3 = 111\n   - 740 + 111 = **851**\n\n2. **竖式验证**：\n```\n    37\n  × 23\n  -----\n   111   ← 37 × 3\n   740   ← 37 × 20（即 37 × 2 = 74 后补 0）\n  -----\n   851\n```\n\n结果为 **851**，与完成标准一致。'
const summary='结果为851，计算过程见上方中文说明。'
const checks=(accepted=true)=>(['goal',1,2,3,4,5,6,7,8] as const).map(id=>({id,status:id==='goal'&&!accepted?'fail':'pass'}))

test('官方Team任务簿不等于子Agent：原生回执可复核、摘要缺正文沿原R3/R4恢复全部计算，cold相同',async t=>{
 const root=await mkdtemp(join(tmpdir(),'teloa-review-book-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const f=await loopWorkFixture(t,true,root);await installNativeWorkingDirectory(f.ctx,root)
 await f.ctx.plugin(SubagentRuntime,{maxActiveSubagents:2,maxDepth:1})
 await f.ctx.plugin(TeamService,{})
 await f.ctx.plugin(TeamTools,{})
 const rpc='book-rpc',runId='book-run',allowedTools=['team_task_create','team_task_update'],traces:DeliveryReviewTrace[]=[]
 const snapshot:DeliveryReviewExecutionSnapshot={runId,sessionId:f.agent.id,requestId:rpc,allowedTools,continuationMessageIds:new Set(),runtimeLinks:[],jobs:[],pendingJobCompletion:false,pendingInput:false,children:'none',flow:'none'}
 const binding={runId,sessionId:f.agent.id,requestId:rpc,turn:1},catalog=createReviewSourceCatalog([{id:'goal',kind:'goal',title:'本人原目标',text:goal,origin:{field:'workRequest',pointer:'/sourceText'}}])
 let nativePrefix:SessionEvent[]=[],basis:{sourceId:string;passageId:string}[]=[]
 const adapter=f.adapter,stream=adapter.stream.bind(adapter)
 adapter.stream=async function*(options:GenerateOptions){
  const index=this.requests.length
  if(index===4){
   const rows=[...readSessionEvents(f.agent.session)],last=rows.find(event=>event.type==='assistant/message'&&event.data.message.content.some(part=>part.type==='text'&&part.text===summary));assert.ok(last)
   nativePrefix=rows.filter(event=>event.seq<=last.seq)
   const found=collectReviewToolEvidence(nativePrefix,binding,snapshot);assert.equal(found.state,'ready')
   if(found.state==='ready'){
    const candidates=reviewToolSources(found.evidence);assert.ok(candidates.some(source=>source.text.includes(full)&&source.title.includes('未复核')),'早期计算仅作为未复核候选供原复核核算')
    const sources=createReviewSourceCatalog([...catalog.sources,...candidates]),candidate=sources.passages.find(row=>row.sourceId.startsWith('assistant-draft:'))!,original=sources.passages.find(row=>row.sourceId==='goal')!
    assert.ok(candidate);basis=[{sourceId:original.sourceId,passageId:original.id},{sourceId:candidate.sourceId,passageId:candidate.id}]
   }
  }
  if(index===5)this.scripts[0]=call(deliveryReviewToolName,{phase:'verify',verdict:'reject',checks:checks(false),changeChecks:[],findings:[{problem:'最后摘要没有完整计算，不能把见上方当作本次交付正文。',basis,blockIds:[1]}]})
  if(index===6)this.scripts[0]=call(deliveryReviewToolName,{phase:'revise',issues:[{problem:'恢复并核算原中间稿的完整分解计算与竖式，不把内部任务簿完成称为平台结项。',basis,affectedBlockIds:[1],coverage:{change:[1],retain:[],unrelated:[],unknown:[]},edits:[{blockId:1,after:full}]}]})
  if(index===7)this.scripts[0]=call(deliveryReviewToolName,{phase:'verify',verdict:'accept',checks:checks(),changeChecks:['r2:u1:f1','r3:u1:i1'].map(issueId=>({issueId,status:'verified',reviewedBlockIds:splitReviewBlocks(full).map((_,i)=>i+1)})),findings:[]})
  yield* stream(options)
 }
 adapter.scripts.push(call('team_task_create',{subject:'计算',description:goal,write_scopes:[]}),call('team_task_update',{task_id:'task-1',expected_revision:1,action:'claim'}),call('team_task_update',{task_id:'task-1',expected_revision:2,action:'complete'},full),text(summary),call(deliveryReviewToolName,{phase:'revise',issues:[]}),text('placeholder'),text('placeholder'),text('placeholder'))
 const release=leaseTaskDeliveryReview(f.agent,{runId,requestId:rpc,material:{goal,inputs:{knowledge:0,group:false,context:false},methods:[],catalog},requireReview:true,readExecution:async()=>snapshot,publish:async message=>{f.agent.inject(message)},trace:entry=>traces.push(entry)});t.after(release)
 f.agent.followup(createUserMessage({source:{kind:'user',rpcId:rpc},content:[{type:'text',text:goal}]}));await f.agent.whenIdle()
 assert.equal(adapter.requests.length,8,'创建/领取/完成/摘要及原四轮复核，不另开Run或模型重试 '+JSON.stringify({traces,results:readSessionEvents(f.agent.session).filter(event=>event.type==='tool/result').map(event=>event.type==='tool/result'?event.data.message:undefined)}))
 assert.ok(traces.some(row=>row.state==='delivered'),JSON.stringify(traces))
 const events=readSessionEvents(f.agent.session),cold=JSON.parse(JSON.stringify(events)) as SessionEvent[]
 assert.equal(readTaskRunGroupResult(cold,rpc,undefined,undefined,{requireReview:true,runId}),full)
 assert.ok(!adapter.requests.slice(4).some(request=>(request.tools??[]).some(tool=>tool.name!==deliveryReviewToolName)),'复核阶段不重新开放团队或执行工具')
 assert.equal(events.filter(event=>event.type==='team/task').length,3,'复核不自动回写团队任务')
 const found=collectReviewToolEvidence(nativePrefix,binding,snapshot);assert.equal(found.state,'ready');if(found.state==='ready'){
  assert.equal(replayReviewToolEvidence(nativePrefix,found.evidence),true)
  const {schema:_schema,drafts:_drafts,sha256:_sha256,...same}=found.evidence,legacy={schema:'teloa.delivery-review-tools/v1' as const,...same}
  assert.equal(replayReviewToolEvidence(nativePrefix,{...legacy,sha256:createHash('sha256').update(JSON.stringify(legacy)).digest('hex')}),false,'旧v1不能被重新解释为接受当时拒绝的team/task')
  if(found.evidence.schema==='teloa.delivery-review-tools/v2'){
   const {sha256:_hash,...changed}={...found.evidence,drafts:found.evidence.drafts.map(row=>({...row,text:'伪造的中间稿',sha256:createHash('sha256').update('伪造的中间稿').digest('hex')}))}
   assert.equal(replayReviewToolEvidence(nativePrefix,{...changed,sha256:createHash('sha256').update(JSON.stringify(changed)).digest('hex')}),false,'中间稿必须逐字来自原生助手正文，重算外层hash不能替代原来源')
  }
 }
 for(const mode of ['missing-result','foreign-session','foreign-owner','revision-gap','unknown-version','unknown-event','unproven-child','missing-task-event'] as const)await t.test(mode,()=>{
  let changed=structuredClone(nativePrefix);const event=changed.filter(row=>row.type==='team/task')[mode==='revision-gap'?1:0];assert.ok(event?.type==='team/task')
  if(mode==='missing-result')changed=changed.filter(row=>row.type!=='tool/result')
  if(mode==='foreign-session')event.data.teamId='another-session' as never
  if(mode==='foreign-owner')event.data.task={...event.data.task,ownerId:'another-session' as never}
  if(mode==='revision-gap'){
   event.data.task={...event.data.task,revision:9}
   const call=[...changed].reverse().find(row=>row.type==='tool/call'&&row.seq<event.seq),result=changed.find(row=>row.type==='tool/result'&&call?.type==='tool/call'&&row.data.message.toolCallId===call.data.callId);assert.ok(result?.type==='tool/result')
   const part=result.data.message.content[0];assert.ok(part?.type==='text');part.text=JSON.stringify({...JSON.parse(part.text),revision:9})
  }
  if(mode==='unknown-version')Reflect.set(event.data,'version',3)
  if(mode==='unknown-event')Reflect.set(event,'type','team/unknown')
  if(mode==='unproven-child')Reflect.set(event,'type','team/member')
  if(mode==='missing-task-event')changed=changed.filter(row=>row.type!=='team/task')
  assert.equal(collectReviewToolEvidence(changed,binding,snapshot).state,'blocked',mode)
 })
})

test('同一步并列创建的官方任务簿按各自结果身份核对，不把调用时间重叠误当来源不明',async t=>{
 const root=await mkdtemp(join(tmpdir(),'teloa-review-book-parallel-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const f=await loopWorkFixture(t,true,root);await installNativeWorkingDirectory(f.ctx,root);await f.ctx.plugin(SubagentRuntime,{maxActiveSubagents:2,maxDepth:1});await f.ctx.plugin(TeamService,{});await f.ctx.plugin(TeamTools,{})
 const first=call('team_task_create',{subject:'第一项',description:goal}),second=call('team_task_create',{subject:'第二项',description:goal})
 f.adapter.scripts.push([...first.slice(0,-1),...second.map(chunk=>'index'in chunk?{...chunk,index:chunk.index+1}:chunk)] as Reply,text(summary))
 const requestId='parallel-book';f.agent.followup(createUserMessage({source:{kind:'user',rpcId:requestId},content:[{type:'text',text:goal}]}));await f.agent.whenIdle()
 const snapshot:DeliveryReviewExecutionSnapshot={runId:'parallel-run',sessionId:f.agent.id,requestId,allowedTools:['team_task_create'],continuationMessageIds:new Set(),runtimeLinks:[],jobs:[],pendingJobCompletion:false,pendingInput:false,children:'none',flow:'none'}
 assert.equal(readSessionEvents(f.agent.session).filter(event=>event.type==='team/task').length,2)
 assert.equal(collectReviewToolEvidence(readSessionEvents(f.agent.session),{runId:snapshot.runId,sessionId:f.agent.id,requestId,turn:1},snapshot).state,'ready')
})

test('旧v1当前请求的普通计算可冷读，无关前一请求的官方任务簿不改变证明',async t=>{
 const root=await mkdtemp(join(tmpdir(),'teloa-review-book-prior-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const f=await loopWorkFixture(t,true,root);await installNativeWorkingDirectory(f.ctx,root);await f.ctx.plugin(SubagentRuntime,{maxActiveSubagents:2,maxDepth:1});await f.ctx.plugin(TeamService,{});await f.ctx.plugin(TeamTools,{})
 f.ctx.tools.register(defineTool({name:'calculation',description:'本机纯计算',parameters:{},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async()=>'851'}))
 f.adapter.scripts.push(call('team_task_create',{subject:'旧任务簿',description:'属于前一请求'}),text('旧请求登记完成'));await f.send('previous-rpc')
 f.adapter.scripts.push(call('calculation',{}),text('37×23=851'));await f.send('current-rpc')
 const events=readSessionEvents(f.agent.session),last=[...events].reverse().find(event=>event.type==='assistant/message');assert.ok(last?.type==='assistant/message')
 const snapshot:DeliveryReviewExecutionSnapshot={runId:'current-run',sessionId:f.agent.id,requestId:'current-rpc',allowedTools:['calculation'],continuationMessageIds:new Set(),runtimeLinks:[],jobs:[],pendingJobCompletion:false,pendingInput:false,children:'none',flow:'none'}
 const read=collectReviewToolEvidence(events,{...snapshot,turn:last.data.turn},snapshot);assert.equal(read.state,'ready')
 if(read.state==='ready'){
  const {schema:_schema,drafts:_drafts,sha256:_hash,...same}=read.evidence,body={schema:'teloa.delivery-review-tools/v1' as const,...same},legacy={...body,sha256:createHash('sha256').update(JSON.stringify(body)).digest('hex')}
  assert.equal(replayReviewToolEvidence(events,legacy),true,'当前证明只能约束已核唯一原请求窗口，不能受旧请求的任务簿影响')
  assert.equal(replayReviewToolEvidence(events,read.evidence),true)
 }
})

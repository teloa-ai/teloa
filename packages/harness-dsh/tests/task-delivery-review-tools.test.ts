import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import type {TaskRunRuntimeLink} from '@teloa/backend'
import {Context} from '@deepseek-ai/cordis'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {LlmAdapter,LlmRuntime,ToolCallId,createUserMessage,type GenerateOptions,type StreamChunk,type UserMessage} from '@deepseek-ai/dsh-llm'
import {Session,SessionId,SessionStore} from '@deepseek-ai/dsh-session'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {ToolRuntime,defineTool} from '@deepseek-ai/dsh-tools'
import * as RepeatToolReminder from '@deepseek-ai/dsh-repeat-tool-reminder'
import {LocalJobRegistry} from '@deepseek-ai/dsh-jobs-local'
import type {JobId,JobOutcome,JobView} from '@deepseek-ai/dsh-jobs'
import {leaseTaskDeliveryReview,createReviewSourceCatalog,deliveryReviewToolName,splitReviewUnits,type DeliveryReviewTrace} from '../src/task-delivery-review.ts'
import {readTaskRunGroupResult} from '../src/task-run-group-result.ts'
import {readSessionEvents} from '../src/session-events.ts'
import {collectReviewToolEvidence,replayReviewToolEvidence,type DeliveryReviewExecutionSnapshot} from '../src/task-delivery-review-tools.ts'
import {nativeHotCausalityFixture,toolAnswer} from './fixtures/native-hot-causality.ts'
import {patchedNativePackage} from './fixtures/native-patched-package.ts'
import type {NativeJobCompletion} from '../src/native-work-causality.ts'
import {nativeHotSubagentFixture} from './fixtures/native-hot-subagent.ts'
import {registerExternalHarnessAdmission} from '../src/external-harness-admission.ts'

const goal='仅根据本轮合成计算结果整理正文；不得虚构已执行动作。',draft='合成结果为7500。',result='本轮合成计算结果为7500。'
const text=(value:string):StreamChunk[]=>[{type:'block-start',index:0,blockType:'text'},{type:'text-delta',index:0,text:value},{type:'block-end',index:0,block:{type:'text',text:value}},{type:'finish',reason:{kind:'stop'}}]
const call=(name:string,id:string,args:unknown):StreamChunk[]=>[{type:'block-start',index:0,blockType:'tool-call'},{type:'block-end',index:0,block:{type:'tool-call',name,id:ToolCallId(id),arguments:JSON.stringify(args)}},{type:'finish',reason:{kind:'tool-calls'}}]
const revise=()=>call(deliveryReviewToolName,'review-r1',{phase:'revise',issues:[]})
const verify=()=>call(deliveryReviewToolName,'review-r2',{phase:'verify',verdict:'accept',checks:['goal',1,2,3,4,5,6,7,8].map(id=>({id,status:'pass'})),changeChecks:[],findings:[]})
class ToolReviewAdapter extends LlmAdapter{
 readonly requests:GenerateOptions[]=[]
 readonly scripts:StreamChunk[][]
 constructor(scripts:StreamChunk[][]){super();this.scripts=scripts}
 async *stream(options:GenerateOptions){this.requests.push(options);const script=this.scripts.shift();assert.ok(script,'不增加模型请求');yield* script}
}
type HotFixture=Awaited<ReturnType<typeof nativeHotCausalityFixture>>
async function installReviewJobs(t:Parameters<typeof nativeHotCausalityFixture>[0],f:HotFixture){
 await f.ctx.plugin(LocalJobRegistry,{})
 type Admission=(candidate:NativeJobCompletion,dispatch:()=>void)=>Promise<void>
 const sdk=await patchedNativePackage<typeof import('@deepseek-ai/dsh-tool-jobs')&{apply:(ctx:typeof f.ctx,config:import('@deepseek-ai/dsh-tool-jobs').Config,options:{requireCompletionAdmission:true;admitCompletion:Admission;observeCompletionDecision:(job:JobView,notify:boolean)=>void})=>void}>(t,{packageName:'@deepseek-ai/dsh-tool-jobs',compatBasename:'dsh-tool-jobs-0.2.1-rc.2-completion-admission'})
 await f.ctx.plugin({name:'review-fixed-job-tools',inject:sdk.namespace.inject,apply:(ctx:typeof f.ctx,config:import('@deepseek-ai/dsh-tool-jobs').Config)=>sdk.namespace.apply(ctx,config,{requireCompletionAdmission:true,admitCompletion:f.work.withJobCompletion,observeCompletionDecision:f.work.jobCompletionDecision})},{completionDelivery:'wakeup'})
}
function jobSnapshot(f:HotFixture,rpc:string,runId:string):DeliveryReviewExecutionSnapshot{
 const state=f.work.readReviewState(f.agent,rpc),jobs=f.ctx.jobs.list(f.agent.id)
 return {runId,sessionId:f.agent.id,requestId:rpc,allowedTools:['hot_result','job_output'],continuationMessageIds:new Set(state.continuationMessageIds),runtimeLinks:jobs.map(job=>({kind:'job',runId,sessionId:f.agent.id,nativeId:'runtime:'+job.id,payload:{record:'job',runtimeId:'runtime',requestId:rpc,jobId:job.id,status:job.status}})),jobs:jobs.map(job=>({id:job.id,owner:job.owner,status:job.status})),pendingJobCompletion:state.pendingJobCompletion,pendingInput:state.pendingInput,children:'none',flow:'none'}
}

test('真实ToolRuntime已完成工具后的最终正文仍须原R1/R2，普通工具结果进入固定依据，cold requireReview可读',async t=>{
 const ctx=new Context();t.after(()=>ctx.fiber.dispose())
 for(const plugin of [LlmRuntime,SessionStore,SessionProjectionRegistry,SystemPrompt,ToolRuntime,AgentRegistry])await ctx.plugin(plugin)
 await ctx.plugin(AgentLoop,{agents:[]})
 let executed=0
 ctx.tools.register(defineTool({name:'calculation',description:'本机纯合成计算',parameters:{},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async()=>{executed++;return result}}))
 const adapter=new ToolReviewAdapter([call('calculation','calculation-call',{}),text(draft),revise(),verify()]);ctx.llm.registerAdapter(['minimax'],adapter)
 const {agent}=await ctx.agents.create({sessionId:SessionId('tool-review-owner'),agentOptions:{provider:'minimax',model:'MiniMax-M3',maxTokens:65536}})
 const traces:DeliveryReviewTrace[]=[],catalog=createReviewSourceCatalog([{id:'goal',kind:'goal',title:'本人目标',text:goal,origin:{field:'workRequest',pointer:'/sourceText'}}])
 const lease={runId:'run',requestId:'rpc',requireReview:true as const,material:{goal,inputs:{knowledge:0,group:false,context:false},methods:[],catalog},publish:async(message:UserMessage,signal:AbortSignal)=>{signal.throwIfAborted();agent.inject(message)},trace:(entry:DeliveryReviewTrace)=>traces.push(entry),readExecution:async()=>({runId:'run',sessionId:agent.id,requestId:'rpc',allowedTools:['calculation'],continuationMessageIds:new Set<string>(),runtimeLinks:[],jobs:[],pendingJobCompletion:false,pendingInput:false,children:'none' as const,flow:'none' as const})}
 const release=leaseTaskDeliveryReview(agent,lease);t.after(release)
 agent.followup(createUserMessage({source:{kind:'user',rpcId:'rpc'},content:[{type:'text',text:goal}]}));await agent.whenIdle()
 assert.equal(executed,1)
 assert.equal(adapter.requests.length,4,'工具调用、最终正文和原R1/R2各一次；不能因tool事件跳过requireReview')
 assert.deepEqual(adapter.requests.slice(2).map(r=>(r.tools??[]).map(t=>t.name)),[[deliveryReviewToolName],[deliveryReviewToolName]])
 assert.ok(JSON.stringify(adapter.requests[2]).includes(result),'真实普通tool结果不丢失')
 assert.ok(!JSON.stringify(adapter.requests[2]).includes('原任务生成下列草稿前没有工具调用或执行回执'),'有工具分支不作无工具声明')
 assert.ok(traces.some(row=>row.state==='delivered'))
 const events=readSessionEvents(agent.session),cold=readSessionEvents(Session.create(agent.id,JSON.parse(JSON.stringify(events)),agent.session.header))
 const original=events.find(event=>event.type==='assistant/message'&&event.data.message.content.some(block=>block.type==='text'&&block.text===draft))!
 const prefix=events.filter(event=>event.seq<=original.seq),turn=Reflect.get(original.data,'turn') as number,snapshot:DeliveryReviewExecutionSnapshot=await lease.readExecution(),binding={runId:'run',sessionId:agent.id,requestId:'rpc',turn}
 assert.equal(collectReviewToolEvidence(prefix,binding,snapshot).state,'ready')
 for(const [label,changed,expected]of [
  ['异Run', {...snapshot,runId:'other'},'blocked'],
  ['非授权工具', {...snapshot,allowedTools:[]},'blocked'],
  ['完成通知仍待入轮', {...snapshot,pendingJobCompletion:true},'pending'],
  ['后续输入仍排队', {...snapshot,pendingInput:true},'pending'],
  ['子工作未结清', {...snapshot,children:'outstanding' as const},'pending'],
  ['flow未结清', {...snapshot,flow:'outstanding' as const},'pending'],
 ]as const)await t.test(label,()=>assert.equal(collectReviewToolEvidence(prefix,binding,changed).state,expected))
 for(const mode of ['missing-result','changed-call','foreign-user']as const)await t.test(mode,()=>{
  let changed=structuredClone(prefix)
  if(mode==='missing-result')changed=changed.filter(event=>event.type!=='tool/result')
  if(mode==='changed-call'){const call=changed.find(event=>event.type==='tool/call');assert.ok(call?.type==='tool/call');call.data.arguments='{"foreign":true}'}
  if(mode==='foreign-user'){const root=changed.find(event=>event.type==='user/message'&&event.data.source.kind==='user');assert.ok(root?.type==='user/message');changed.splice(changed.indexOf(root)+1,0,{...root,data:createUserMessage({source:{kind:'user',rpcId:'foreign'},content:[{type:'text',text:'外来输入'}]})})}
  assert.equal(collectReviewToolEvidence(changed,binding,snapshot).state,'blocked')
 })
 await t.test('外部工具须有同call派生的真实终态关联，unknown/foreign/无登记均拒绝',()=>{
  const changed=structuredClone(prefix),call=changed.find(event=>event.type==='tool/call'),assistant=changed.find(event=>event.type==='assistant/message'&&event.data.message.content.some(block=>block.type==='tool-call'))
  assert.ok(call?.type==='tool/call'&&assistant?.type==='assistant/message')
  call.data.name='subagent_codex'
  const block=assistant.data.message.content.find(block=>block.type==='tool-call');assert.ok(block?.type==='tool-call');block.name=call.data.name
  const reservationId='external:'+createHash('sha256').update(JSON.stringify(['runtime',agent.id,call.data.callId,'codex'])).digest('hex')
  const link={kind:'external' as const,runId:'run',sessionId:agent.id,nativeId:reservationId,payload:{runtimeId:'runtime',requestId:'rpc',reservationId,provider:'codex' as const,workspaceRoot:'/tmp/synthetic-owner-review',activationId:'activation',status:'completed' as const}}
  const current={...snapshot,allowedTools:['subagent_codex'],runtimeLinks:[link]}
  assert.equal(collectReviewToolEvidence(changed,binding,current).state,'blocked','单独拼接link没有原生activation目录也不能冒真实执行')
  assert.equal(collectReviewToolEvidence(changed,binding,{...current,runtimeLinks:[]}).state,'blocked')
  assert.equal(collectReviewToolEvidence(changed,binding,{...current,runtimeLinks:[{...link,sessionId:'foreign'}]}).state,'blocked')
  assert.equal(collectReviewToolEvidence(changed,binding,{...current,runtimeLinks:[{...link,payload:{...link.payload,status:'unknown'}}]}).state,'blocked')
  assert.equal(collectReviewToolEvidence(changed,binding,{...current,runtimeLinks:[{...link,payload:{...link.payload,status:'running'}}]}).state,'pending')
 })
 assert.equal(readTaskRunGroupResult(cold,'rpc',undefined,undefined,{requireReview:true,runId:'run'}),draft)
 for(const mode of ['changed-result','missing-evidence','bad-evidence']as const)await t.test('冷读拒绝 '+mode,()=>{
  const changed=structuredClone(cold)
  if(mode==='changed-result'){const result=changed.find(event=>event.type==='tool/result'&&event.data.message.toolCallId==='calculation-call');assert.ok(result?.type==='tool/result');result.data.message={...result.data.message,content:[{type:'text',text:'被更换的结果'}]}}
  else{const output=changed.find(event=>event.type==='user/message'&&event.data.source.kind==='plugin:teloa.delivery-review'&&Reflect.get(event.data.source,'summary')==='复核后交付');assert.ok(output?.type==='user/message');if(mode==='missing-evidence')Reflect.deleteProperty(output.data.source,'toolEvidence');else Reflect.set(output.data.source,'toolEvidence',{})}
  assert.equal(readTaskRunGroupResult(changed,'rpc',undefined,undefined,{requireReview:true,runId:'run'}),undefined)
 })
 assert.ok(adapter.requests.every(r=>r.provider==='minimax'&&r.model==='MiniMax-M3'&&r.maxTokens===65536))
 // 同一会话再进入别的请求，旧证据不能扩大到后轮；旧请求仍只读其原endSeq以前的结果。
 release();adapter.scripts.push(text('相邻普通会话回复'))
 agent.followup(createUserMessage({source:{kind:'user',rpcId:'next-rpc'},content:[{type:'text',text:'相邻请求'}]}));await agent.whenIdle()
 const adjacent=readSessionEvents(agent.session)
 assert.equal(readTaskRunGroupResult(adjacent,'rpc',undefined,undefined,{requireReview:true,runId:'run'}),draft)
 assert.equal(readTaskRunGroupResult(adjacent,'next-rpc',undefined,undefined,{requireReview:true,runId:'run'}),undefined)
})

for(const [provider,name]of [['codex','subagent_codex'],['claude-code','subagent_claude_code']]as const)test('真实外部SubagentRuntime/admission/catalog完成后仍须R1/R2：'+provider,{timeout:10000},async t=>{
 const f=await nativeHotSubagentFixture(t,'one-shot',false,true),rpc='review-external-'+provider,runId='external-run'
 const require=createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json')),nativeTool=await import(require.resolve('@deepseek-ai/dsh-tool-subagent'))
 let starts=0,disposed=0,consents=0
 f.service.registerProvider({name:provider,capabilities:{agentOptions:false,agentPreset:false,outputSchema:false,depthLimit:false},inheritsParentContext:false,async start(){starts++;return {id:SessionId('external-review-'+provider),result:Promise.resolve({output:[{type:'text',text:result}],stopReason:'completed' as const}),dispose:async()=>{disposed++}}}})
 await f.ctx.plugin(nativeTool,{provider,toolName:name,maxDepth:'provider-managed'})
 const rows=new Map<string,TaskRunRuntimeLink>(),control=registerExternalHarnessAdmission(f.ctx,{consent:async()=>{consents++},authorize:async input=>({runId,requestId:rpc,reservationId:'external:'+createHash('sha256').update(JSON.stringify(['runtime',input.sessionId,input.callId,input.provider])).digest('hex'),runtimeId:'runtime',workspaceRoot:await f.ctx.workingDirectory.ensure(f.parent,input.signal),provider:input.provider,assertCurrent(){}}),reserve:async()=>{},save:async()=>{},links:{list:async()=>[...rows.values()],put:async row=>{rows.set(row.nativeId,structuredClone(row))}}})
 t.after(()=>control.dispose())
 const scripts=[call(name,'external-call',{prompt:'仅整理本轮合成资料',description:'本机SDK确定性子执行'}),text(draft),revise(),verify()]
 f.adapter.stream=async function*(options:GenerateOptions){f.adapter.requests.push(options);const script=scripts.shift();assert.ok(script,'不增加模型请求');yield* script}
 const traces:DeliveryReviewTrace[]=[],catalog=createReviewSourceCatalog([{id:'goal',kind:'goal',title:'原目标',text:goal,origin:{field:'workRequest',pointer:'/sourceText'}}])
 const release=leaseTaskDeliveryReview(f.parent,{runId,requestId:rpc,material:{goal,inputs:{knowledge:0,group:false,context:false},methods:[],catalog},readExecution:async()=>{const state=f.work.readReviewState(f.parent,rpc);return {runId,sessionId:f.parent.id,requestId:rpc,allowedTools:[name],continuationMessageIds:new Set(state.continuationMessageIds),runtimeLinks:[...rows.values()],jobs:[],pendingJobCompletion:state.pendingJobCompletion,pendingInput:state.pendingInput,children:'none',flow:'none'}},publish:async(message,signal)=>f.work.withNewInput(f.parent,message,{producer:'prompt',identity:message.id},()=>f.parent.inject(message),signal),trace:entry=>traces.push(entry)})
 t.after(release)
 await f.send(rpc,goal)
 assert.equal(f.adapter.requests.length,4,JSON.stringify({traces,events:f.events().map(event=>({type:event.type,...event.type==='user/message'?{source:event.data.source}:{}}))}))
 assert.equal(starts,1);assert.equal(consents,1);assert.equal(disposed,1)
 assert.ok(JSON.stringify(f.adapter.requests[2]).includes(result),'只有实际已核ordinary子结果进入复核，不读取child reasoning')
 assert.equal(readTaskRunGroupResult(JSON.parse(JSON.stringify(f.events())),rpc,undefined,undefined,{requireReview:true,runId}),draft)
})

for(const proof of ['accepted-root','missing-root-proof']as const)test('真实JobTools占位不复核，只有已登记原root续轮最终正文可复核：'+proof,{timeout:10000},async t=>{
 const f=await nativeHotCausalityFixture(t),rpc='review-job-'+proof
 await installReviewJobs(t,f)
 let settle!:(value:JobOutcome)=>void,id:JobId|undefined
 f.setToolAction(async()=>{id=f.ctx.jobs.start({kind:'bash',label:'合成后台计算',owner:f.agent.id,run:()=>({done:new Promise<JobOutcome>(resolve=>{settle=resolve}),cancel:()=>settle({status:'killed'})})})})
 f.adapter.scripts.push(toolAnswer,text('后台仍在运行，尚无结果。'))
 const traces:DeliveryReviewTrace[]=[],catalog=createReviewSourceCatalog([{id:'goal',kind:'goal',title:'原目标',text:goal,origin:{field:'workRequest',pointer:'/sourceText'}}])
 const readExecution=async():Promise<DeliveryReviewExecutionSnapshot>=>{
  const state=jobSnapshot(f,rpc,'job-run')
  return {...state,continuationMessageIds:proof==='accepted-root'?state.continuationMessageIds:new Set()}
 }
 const release=leaseTaskDeliveryReview(f.agent,{runId:'job-run',requestId:rpc,material:{goal,inputs:{knowledge:0,group:false,context:false},methods:[],catalog},readExecution,publish:async(message,signal)=>f.work.withNewInput(f.agent,message,{producer:'prompt',identity:message.id},()=>f.agent.inject(message),signal),trace:entry=>traces.push(entry)})
 t.after(release)
 await f.send(rpc);await f.agent.whenIdle()
 assert.ok(id);assert.equal(f.ctx.jobs.get(id,f.agent.id).status,'running')
 assert.equal(f.adapter.requests.length,2,'真实后台占位不能启动R1，也不能消费复核租约')
 assert.equal(traces.some(row=>row.state==='requested'||row.state==='delivered'),false)
 assert.equal(readTaskRunGroupResult(f.events(),rpc,undefined,undefined,{requireReview:true,runId:'job-run'}),undefined)
 f.adapter.scripts.push(call('job_output','collect-job',{job_id:id}),text(draft),revise(),verify())
 settle({status:'completed',result})
 const deadline=Date.now()+3000
 while(!f.events().some(event=>event.type==='user/message'&&event.data.source.kind==='tool-jobs')){assert.ok(Date.now()<deadline,'真实Job完成通知须入原轮');await new Promise(resolve=>setTimeout(resolve,5))}
 await f.agent.whenIdle()
 const events=f.events(),cold=JSON.parse(JSON.stringify(events))
 if(proof==='accepted-root'){
  assert.equal(f.adapter.requests.length,6,'工具/占位/实际收集结果/完成正文/R1/R2；'+JSON.stringify(traces))
  assert.equal(traces.some(row=>row.state==='delivered'),true)
  assert.ok(JSON.stringify(f.adapter.requests[4]).includes(result),'原生job_output实际收集的普通结果进入冻结来源')
  assert.equal(readTaskRunGroupResult(cold,rpc,undefined,undefined,{requireReview:true,runId:'job-run'}),draft)
 }else{
  assert.equal(f.adapter.requests.length,4,'同kind但缺可信原root proof不得开始R1')
  assert.equal(traces.some(row=>row.state==='delivered'),false)
  assert.equal(readTaskRunGroupResult(cold,rpc,undefined,undefined,{requireReview:true,runId:'job-run'}),undefined)
 }
})

test('两个真实Job的可信完成通知可在原同一turn批量入步，重复ID或漏一条proof仍拒',{timeout:10000},async t=>{
 const f=await nativeHotCausalityFixture(t),rpc='review-batched-jobs',runId='batch-run';await installReviewJobs(t,f)
 f.adapter.scripts.push(toolAnswer)
 f.setToolAction(async()=>{
  const jobs=[0,1].map(index=>{
   let settle!:(value:JobOutcome)=>void
   const id=f.ctx.jobs.start({kind:'bash',label:'同轮合成工作'+index,owner:f.agent.id,run:()=>({done:new Promise<JobOutcome>(resolve=>{settle=resolve}),cancel:()=>settle({status:'killed'})})})
   return {id,settle}
  })
  f.adapter.scripts.push(...jobs.map((job,index)=>call('job_output','collect-batch-'+index,{job_id:job.id})),text(draft),revise(),verify())
  for(const job of jobs)job.settle({status:'completed',result})
  const deadline=Date.now()+3000
  while(f.agent.inbox.nextStep.length!==2){assert.ok(Date.now()<deadline,'两个真实完成通知应都已受理入队');await new Promise(resolve=>setTimeout(resolve,5))}
 })
 const traces:DeliveryReviewTrace[]=[],catalog=createReviewSourceCatalog([{id:'goal',kind:'goal',title:'原目标',text:goal,origin:{field:'workRequest',pointer:'/sourceText'}}])
 let snapshot:DeliveryReviewExecutionSnapshot|undefined
 const release=leaseTaskDeliveryReview(f.agent,{runId,requestId:rpc,material:{goal,inputs:{knowledge:0,group:false,context:false},methods:[],catalog},readExecution:async()=>snapshot=jobSnapshot(f,rpc,runId),publish:async(message,signal)=>f.work.withNewInput(f.agent,message,{producer:'prompt',identity:message.id},()=>f.agent.inject(message),signal),trace:entry=>traces.push(entry)})
 t.after(release)
 await f.send(rpc);await f.agent.whenIdle()
 assert.equal(f.adapter.requests.length,6,JSON.stringify(traces));assert.ok(snapshot)
 const events=f.events(),notices=events.filter(event=>event.type==='user/message'&&event.data.source.kind==='tool-jobs')
 assert.equal(notices.length,2)
 assert.equal(events.filter(event=>event.type==='turn/start').length,1,'真实两个通知与原请求处于同一轮')
 assert.equal(readTaskRunGroupResult(JSON.parse(JSON.stringify(events)),rpc,undefined,undefined,{requireReview:true,runId}),draft)
 const original=events.find(event=>event.type==='assistant/message'&&event.data.message.content.some(block=>block.type==='text'&&block.text===draft))!
 const prefix=events.filter(event=>event.seq<=original.seq),binding={runId,sessionId:f.agent.id,requestId:rpc,turn:Reflect.get(original.data,'turn') as number}
 assert.equal(collectReviewToolEvidence(prefix,binding,snapshot).state,'ready')
 const ids=[...snapshot.continuationMessageIds]
 assert.equal(collectReviewToolEvidence(prefix,binding,{...snapshot,continuationMessageIds:new Set(ids.slice(1))}).state,'blocked')
 const duplicate=structuredClone(prefix),first=duplicate.find(event=>event.type==='user/message'&&event.data.id===ids[0])!
 duplicate.splice(duplicate.indexOf(first)+1,0,structuredClone(first))
 assert.equal(collectReviewToolEvidence(duplicate,binding,snapshot).state,'blocked')
})

test('官方重复提醒不能打断不同冻结单元的合法相同验收，普通工具重复提醒仍保留',async t=>{
 const ctx=new Context();t.after(()=>ctx.fiber.dispose())
 for(const plugin of [LlmRuntime,SessionStore,SessionProjectionRegistry,SystemPrompt,ToolRuntime,AgentRegistry])await ctx.plugin(plugin)
 await ctx.plugin(AgentLoop,{agents:[]});await ctx.plugin(RepeatToolReminder,{thresholds:[3]})
 ctx.tools.register(defineTool({name:'calculation',description:'合成计算',parameters:{},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async()=>result}))
 const body=Array.from({length:4},(_,i)=>`## 第${i+1}节\n\n`+'已提供的合成事实。'.repeat(125)).join('\n\n'),units=splitReviewUnits(body)
 assert.equal(units.length,4)
 const scripts=[call('calculation','first-calculation',{}),call('calculation','second-calculation',{}),text(body),...units.map((_,i)=>call(deliveryReviewToolName,'r1-unit-'+i,{phase:'revise',issues:[]})),...units.map((_,i)=>call(deliveryReviewToolName,'r2-unit-'+i,{phase:'verify',verdict:'accept',checks:['goal',1,2,3,4,5,6,7,8].map(id=>({id,status:'pass'})),changeChecks:[],findings:[]}))]
 const adapter=new ToolReviewAdapter(scripts);ctx.llm.registerAdapter(['minimax'],adapter)
 const {agent}=await ctx.agents.create({sessionId:SessionId('review-repeat-units'),agentOptions:{provider:'minimax',model:'MiniMax-M3',maxTokens:65536}})
 const catalog=createReviewSourceCatalog([{id:'goal',kind:'goal',title:'本人目标',text:goal,origin:{field:'workRequest',pointer:'/sourceText'}}]),traces:DeliveryReviewTrace[]=[]
 const release=leaseTaskDeliveryReview(agent,{runId:'repeat-units-run',requestId:'review-input',requireReview:true,material:{goal,inputs:{knowledge:0,group:false,context:false},methods:[],catalog},publish:async(message,signal)=>{signal.throwIfAborted();agent.inject(message)},trace:entry=>traces.push(entry),readExecution:async()=>({runId:'repeat-units-run',sessionId:agent.id,requestId:'review-input',allowedTools:['calculation'],continuationMessageIds:new Set(),runtimeLinks:[],jobs:[],pendingJobCompletion:false,pendingInput:false,children:'none',flow:'none'})});t.after(release)
 agent.followup(createUserMessage({source:{kind:'user',rpcId:'review-input'},content:[{type:'text',text:goal}]}));await agent.whenIdle()
 assert.equal(adapter.requests.length,11,'两步取证、完整草稿、四次修订与四次验收都必须实际提交，不跳单元')
 assert.ok(traces.some(row=>row.state==='delivered'))
 const events=readSessionEvents(agent.session)
 assert.equal(readTaskRunGroupResult(events,'review-input',undefined,undefined,{requireReview:true,runId:'repeat-units-run'}),body)
 assert.ok(!events.some(event=>event.type==='agent/inbox/spliced'&&event.data.inserted?.some(message=>message.source.kind==='repeat-tool-reminder')))
 release()
 adapter.scripts.push(...[0,1,2].map(i=>call('calculation','ordinary-repeat-'+i,{})),text('普通任务结束。'))
 agent.followup(createUserMessage({source:{kind:'user',rpcId:'ordinary-input'},content:[{type:'text',text:'普通合成计算'}]}));await agent.whenIdle()
 assert.ok(readSessionEvents(agent.session).some(event=>event.type==='agent/inbox/spliced'&&event.data.inserted?.some(message=>message.source.kind==='repeat-tool-reminder'&&Reflect.get(message.source,'summary')==='calculation × 3')),'不能把普通工具防循环提醒关闭')
})

test('实跑：模型误调用未授权给它的工具、宿主拒绝只回错误时按错误回执封存并可冷读；未授权工具返回成功仍拒',()=>{
 const rpc='rpc-refused',args='{}'
 const events=(isError:boolean)=>{
  const rows:any[]=[]
  const push=(type:string,data:unknown,extra:Record<string,unknown>={})=>{rows.push({type,seq:rows.length,data,...extra});return rows.length-1}
  push('turn/start',{turn:1})
  push('user/message',{id:'root',source:{kind:'user',rpcId:rpc},content:[{type:'text',text:goal}],role:'user'},{surfaceOp:'append'})
  push('assistant/message',{turn:1,step:1,message:{id:'a1',content:[{type:'tool-call',id:'c1',name:'list_agents',arguments:args}]}},{surfaceOp:'append'})
  const callSeq=push('tool/call',{turn:1,step:1,callId:'c1',name:'list_agents',arguments:args})
  push('tool/result',{turn:1,step:1,message:{toolCallId:'c1',isError,content:[{type:'text',text:isError?'Error: 当前会话不能使用此委派工具，请核对员工执行范围。':'[]'}]}},{sourceEventSeqs:[callSeq]})
  push('assistant/message',{turn:1,step:2,message:{id:'draft',content:[{type:'text',text:draft}]}},{surfaceOp:'append'})
  return rows as never
 }
 const snapshot:DeliveryReviewExecutionSnapshot={runId:'run',sessionId:'session',requestId:rpc,allowedTools:['hot_result'],continuationMessageIds:new Set(),runtimeLinks:[],jobs:[],pendingJobCompletion:false,pendingInput:false,children:'none',flow:'none'}
 const binding={runId:'run',sessionId:'session',requestId:rpc,turn:1}
 const refused=collectReviewToolEvidence(events(true),binding,snapshot)
 assert.equal(refused.state,'ready','一次被拒的误调用不废掉整份交付')
 if(refused.state==='ready'){
  assert.deepEqual(refused.evidence.receipts.map(row=>[row.name,row.isError]),[['list_agents',true]],'按错误回执原样封存')
  assert.equal(replayReviewToolEvidence(events(true),refused.evidence),true,'冷读复算一致')
  const {schema:_schema,drafts:_drafts,sha256:_sha256,...same}=refused.evidence,legacy={schema:'teloa.delivery-review-tools/v1' as const,...same}
  assert.equal(replayReviewToolEvidence(events(true),{...legacy,sha256:createHash('sha256').update(JSON.stringify(legacy)).digest('hex')}),true,'旧v1证据原样冷读，不要求补写早期候选或改历史')
 }
 assert.deepEqual(collectReviewToolEvidence(events(false),binding,snapshot),{state:'blocked',reason:'tool-identity'},'未授权工具返回成功仍是身份异常')
})

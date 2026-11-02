import test,{type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {Context} from '@deepseek-ai/cordis'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {LlmAdapter,LlmRuntime,ToolCallId,createUserMessage,type GenerateOptions,type StreamChunk} from '@deepseek-ai/dsh-llm'
import {SessionId,SessionStore} from '@deepseek-ai/dsh-session'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {runContextMode,runContextNotice,runSkillCatalog,runKnowledgeCatalog,readRunKnowledge,type TaskRun,type TaskRunRuntimeLink} from '@teloa/backend'
import {LocalJobRegistry} from '@deepseek-ai/dsh-jobs-local'
import {dshTaskRunPorts,type DshTaskNativeInput} from '../src/task-run-dsh.ts'
import {registerTaskToolGuard} from '../src/task-tool-guard.ts'
import {runContextToolNames} from '@teloa/backend'
import {registerTaskRunContextTools} from '../src/task-run-context-tools.ts'
import {activateDeferredReviewMethods,createReviewSourceCatalog,deliveryReviewPrompt,leaseTaskDeliveryReview,deliveryReviewToolName} from '../src/task-delivery-review.ts'
import {collectReviewToolEvidence,replayReviewToolEvidence,type DeliveryReviewExecutionSnapshot} from '../src/task-delivery-review-tools.ts'
import {readTaskRunGroupResult} from '../src/task-run-group-result.ts'
import {installNativeWorkingDirectory} from './fixtures/native-working-directory.ts'

const sha=(text:string)=>createHash('sha256').update(text).digest('hex')
const content='---\nname: original-method\n---\nPTC-ONLY-METHOD: 保留每项依据与未知。\n'+'固定方法内容。'.repeat(500)
const skill={name:'review',provider:'native',source:'project',description:'复核方法',content,sha256:sha(content)}
async function fixture(t:TestContext,language:'typescript'|'python',mode:'load'|'print-only'|'outer-error'='load',review=false,execution?:{presentation:'ptc'|'native';kind:'tools'|'text'|'digest'|'knowledge';enforceGuard?:boolean}){
 const ctx=new Context();t.after(()=>ctx.fiber.dispose())
 for(const plugin of [LlmRuntime,SessionStore,SessionProjectionRegistry,SystemPrompt,AgentRegistry])await ctx.plugin(plugin)
 // 与正式PTC预设一致，由tools组合配置选择呈现；Agent自身保留复核期原生覆盖层。
 await ctx.plugin(ToolRuntime,{mode:execution?.presentation??'ptc'});await ctx.plugin(AgentLoop,{agents:[]});await installNativeWorkingDirectory(ctx)
 const {agent}=await ctx.agents.create({sessionId:SessionId('review-ptc-'+language+'-'+mode),agentOptions:{provider:'test',model:'test'}})
 const goal='本轮合成目标',ownerRun=execution?.kind==='text'||execution?.kind==='knowledge',skills=ownerRun?[]:[skill]
 const body='本轮固定资料正文',knowledge=execution?.kind==='knowledge'?readRunKnowledge([{id:'22222222-2222-4222-8222-222222222222',version:1,title:'合成资料',sourceId:'fixture',sourceVersion:sha(body),scopeIds:['general'],text:body}]):[]
 const groupContext={taskId:'task',groupId:'group',groupVersion:1,roleId:'role',roleVersion:1,grantVersion:1,source:{messageId:'source',rootId:'source',createdAt:'2026-11-02T00:00:00.000Z',text:goal},messages:[],files:[]}
 const run={id:'run',taskId:'task',taskVersion:1,linkVersion:1,nativeRequestId:'rpc',sessionId:agent.id,contextMode:runContextMode,state:'active',stopRequestedAt:null,skills,knowledge,allowedTools:[],...(ownerRun?{executor:{kind:'owner'}}:{groupContext}),inputText:JSON.stringify({schema:ownerRun?'teloa.task-run-input/v3':'teloa.task-run-input/v2',contextMode:runContextMode,contextNotice:runContextNotice,task:{id:'task',version:1,goal},skills:runSkillCatalog(skills),knowledge:runKnowledgeCatalog(knowledge),...(ownerRun?{planContext:{occurrenceId:'11111111-1111-4111-8111-111111111111',goal,dataScope:'general',delivery:'正文'}}:{})})} as unknown as TaskRun
 registerTaskRunContextTools(ctx,async()=>run)
 // 使用真实官方PTC派发桥；运行器仅替代语言求值，不伪造子调用日志。
 ctx.provide('ptcRuntime',{language,isolation:'fixture',resolve:(request:unknown)=>request,run:async(spec:{bindings:Array<{functions:Record<string,(args:Record<string,unknown>)=>Promise<unknown>>}>})=>{
  if(mode!=='print-only'){
   if(execution?.kind==='knowledge'){const doc=knowledge[0]!;await spec.bindings[0]!.functions.teloa_knowledge_read!({resourceId:doc.id,resourceVersion:doc.version,sourceVersion:doc.sourceVersion})}
   else await spec.bindings[0]!.functions.teloa_skill_load!({name:skill.name,sha256:skill.sha256})
  }
  if(mode==='outer-error')throw Error('加载完成后程序失败')
  return mode==='print-only'?{logs:[JSON.stringify(skill)],value:JSON.stringify(skill)}:{logs:[],value:'已加载'}
 }} as never)
 const snapshot:DeliveryReviewExecutionSnapshot={runId:'run',sessionId:agent.id,requestId:'rpc',allowedTools:['run_code','teloa_skill_load'],continuationMessageIds:new Set(),runtimeLinks:[],jobs:[],pendingJobCompletion:false,pendingInput:false,children:'none',flow:'none'}
 const material={goal:'本轮合成目标',inputs:{knowledge:0,group:false,context:false},methods:[],deferredMethods:[{name:skill.name,sha256:skill.sha256}],catalog:createReviewSourceCatalog([{id:'goal',kind:'goal',title:'目标',text:'本轮合成目标',origin:{field:'workRequest',pointer:'/sourceText'}}])}
 const traces:unknown[]=[]
 if(execution){const logger=ctx.logger,original=logger.info;logger.info=(...args:unknown[])=>{for(const value of args)if(typeof value==='string'){try{traces.push(JSON.parse(value))}catch{}}};t.after(()=>{logger.info=original})}
 if(review&&!execution)t.after(leaseTaskDeliveryReview(agent,{runId:'run',requestId:'rpc',requireReview:true,material,trace:entry=>traces.push(entry),readExecution:async()=>snapshot,publish:async(message,signal)=>{signal.throwIfAborted();agent.inject(message)}}))
 class Adapter extends LlmAdapter{
  requests:GenerateOptions[]=[]
  async *stream(request:GenerateOptions):AsyncGenerator<StreamChunk>{
   this.requests.push(request)
   if(this.requests.length===1){const direct=execution?.presentation==='native';yield {type:'block-start',index:0,blockType:'tool-call'};yield {type:'block-end',index:0,block:{type:'tool-call',id:ToolCallId('outer'),name:direct?'teloa_skill_load':'run_code',arguments:JSON.stringify(direct?{name:skill.name,sha256:skill.sha256}:{code:'fixture',description:'加载本轮方法'})}};yield {type:'finish',reason:{kind:'tool-calls'}};return}
   if(review&&this.requests.length>=3){
    assert.ok(request.tools?.some(tool=>tool.name===deliveryReviewToolName),'PTC运行的复核请求必须实际提供原生回执工具')
    if(skills.length)assert.match(JSON.stringify(request.messages),/original-method/)
    const args=this.requests.length===3?{phase:'revise',issues:[]}:{phase:'verify',verdict:'accept',checks:['goal',1,2,3,4,5,6,7,8].map(id=>({id,status:'pass'})),changeChecks:[],findings:[]}
    assert.ok(this.requests.length<=4)
    yield {type:'block-start',index:0,blockType:'tool-call'};yield {type:'block-end',index:0,block:{type:'tool-call',id:ToolCallId('review-'+this.requests.length),name:deliveryReviewToolName,arguments:JSON.stringify(args)}};yield {type:'finish',reason:{kind:'tool-calls'}};return
   }
   yield {type:'block-start',index:0,blockType:'text'};yield {type:'block-end',index:0,block:{type:'text',text:'待复核正文'}};yield {type:'finish',reason:{kind:'stop'}}
  }
 }
 const adapter=new Adapter();ctx.llm.registerAdapter(['test'],adapter)
 if(execution){
  await ctx.plugin(LocalJobRegistry,{})
  const rows=new Map<string,TaskRunRuntimeLink>()
  const links={list:async()=>[...rows.values()],put:async(row:TaskRunRuntimeLink)=>{rows.set(row.kind+':'+row.nativeId,structuredClone(row))}}
  ctx.provide('agentPresets',{serviceFor:()=>({get:async()=>({...skill,invocation:{modelInvocable:true,userInvocable:true}})})} as never)
  ctx.provide('sessionController',{resolveAgent:async()=>({agent}),prompt:async(request:{requestId:string;content:Parameters<typeof createUserMessage>[0]['content']})=>{agent.followup(createUserMessage({source:{kind:'user',rpcId:request.requestId},content:request.content}));return {accepted:true}}} as never)
  const input:DshTaskNativeInput={withNewInput:async(_agent,_message,_context,submit)=>submit(),readReviewState:()=>({continuationMessageIds:[],pendingJobCompletion:false,pendingInput:false})}
  const ports=dshTaskRunPorts(ctx,'owner',async sessionId=>({ownerId:'owner',sessionId,status:'ready'}),async()=>knowledge,undefined,undefined,undefined,undefined,undefined,links,undefined,undefined,input)
  ports.subagentState=async()=> 'none';ports.flowState=async()=> 'none';ports.isDigestRun=async()=>execution.kind==='digest'
  if(execution.enforceGuard)registerTaskToolGuard(ctx,async()=>({allowedTools:run.allowedTools,nativeRequestId:run.nativeRequestId}),runContextToolNames)
  await ports.send(run,AbortSignal.timeout(5000),{taskId:'task',taskVersion:1,linkVersion:1,sessionId:agent.id,scope:'general'})
 }else agent.followup(createUserMessage({source:{kind:'user',rpcId:'rpc'},content:[{type:'text',text:'本轮合成目标'}]}))
 await agent.whenIdle()
 const events=agent.session.snapshotEvents(),draft=events.find(event=>event.type==='assistant/message'&&event.data.message.content.some(block=>block.type==='text'&&block.text==='待复核正文'))
 assert.ok(draft?.type==='assistant/message')
 const prefix=events.filter(event=>event.seq<=draft.seq)
 const binding={runId:'run',sessionId:agent.id,requestId:'rpc',turn:draft.data.turn}
 if(review){
  assert.equal(adapter.requests.length,4,JSON.stringify(traces))
  if(execution?.presentation!=='native'&&skills.length)assert.ok(adapter.requests.slice(2).every(request=>request.messages.some(message=>message.role==='system'&&message.content.some(part=>part.type==='text'&&part.text.includes(content)))),'PTC正文即使未打印，也必须逐字供R1/R2读取，片段目录不能替代完整方法')
  assert.equal(readTaskRunGroupResult(JSON.parse(JSON.stringify(events)),'rpc',undefined,undefined,{requireReview:true,runId:'run'}),'待复核正文')
  const assembly=await ctx.systemPrompt.assemble({agent,scope:agent})
  if(execution?.presentation!=='native')assert.ok(assembly.tools.some(tool=>tool.name==='run_code'),'复核租约结束恢复PTC呈现')
  assert.ok(!assembly.tools.some(tool=>tool.name===deliveryReviewToolName),'复核工具不残留')
  assert.ok(!assembly.sections.some(section=>section.text.includes(content)),'已加载方法的复核租约正文不残留')
 }
 return {prefix,snapshot,binding,material,events,run,requests:adapter.requests,traces}
}

for(const language of ['typescript','python'] as const)test('官方PTC桥的成功加载激活固定方法且冷读可重放：'+language,async t=>{
 const f=await fixture(t,language),read=collectReviewToolEvidence(f.prefix,f.binding,f.snapshot)
 assert.equal(read.state,'ready');if(read.state!=='ready')return
 const active=activateDeferredReviewMethods(f.material,read.evidence)
 assert.deepEqual(active.methods,[{name:skill.name,originalName:'original-method',sha256:skill.sha256}])
 assert.ok(active.catalog.sources.some(source=>source.kind==='method'&&source.text===content))
 assert.match(deliveryReviewPrompt(active,{index:0,total:1,blockCount:1,tag:{open:'<review-block>',close:'</review-block>',end:'<review-end>'},blocks:[{id:1,text:'待复核正文'}]}),/original-method/)
 assert.equal(replayReviewToolEvidence(JSON.parse(JSON.stringify(f.prefix)),read.evidence),true)
 for(const mode of ['missing-start','missing-result','duplicate','foreign-parent','foreign-root','changed-arguments','unauthorized'] as const){
  const events=structuredClone(f.prefix),start=events.find(event=>event.type==='tool/ptc-dispatch-start'),settled=events.find(event=>event.type==='tool/ptc-dispatch')
  assert.ok(start?.type==='tool/ptc-dispatch-start'&&settled?.type==='tool/ptc-dispatch')
  if(mode==='missing-start')events.splice(events.indexOf(start),1)
  if(mode==='missing-result')events.splice(events.indexOf(settled),1)
  if(mode==='duplicate')events.splice(events.indexOf(settled),0,structuredClone(settled))
  if(mode==='foreign-parent')settled.data.parentCallId=ToolCallId('foreign')
  if(mode==='foreign-root')settled.data.rootCallId=ToolCallId('foreign')
  if(mode==='changed-arguments')settled.data.arguments={name:'foreign',sha256:skill.sha256}
  const snapshot=mode==='unauthorized'?{...f.snapshot,allowedTools:['run_code']}:f.snapshot
  assert.equal(collectReviewToolEvidence(events,f.binding,snapshot).state,'blocked',mode)
 }
 const failed=structuredClone(f.prefix),receipt=failed.find(event=>event.type==='tool/ptc-dispatch');assert.ok(receipt?.type==='tool/ptc-dispatch');receipt.data.isError=true
 const denied=collectReviewToolEvidence(failed,f.binding,f.snapshot);assert.equal(denied.state,'ready');if(denied.state==='ready')assert.deepEqual(activateDeferredReviewMethods(f.material,denied.evidence).methods,[])
 const changed=structuredClone(f.prefix),body=changed.find(event=>event.type==='tool/ptc-dispatch');assert.ok(body?.type==='tool/ptc-dispatch');body.data.content=[{type:'text',text:JSON.stringify({...skill,content:'被替换的正文'})}]
 const corrupt=collectReviewToolEvidence(changed,f.binding,f.snapshot);assert.equal(corrupt.state,'ready');if(corrupt.state==='ready')assert.throws(()=>activateDeferredReviewMethods(f.material,corrupt.evidence),/固定版本/)
 assert.equal(replayReviewToolEvidence(changed,read.evidence),false)
 body.data.content=[{type:'text',text:'not-json'}]
 const malformed=collectReviewToolEvidence(changed,f.binding,f.snapshot);assert.equal(malformed.state,'ready');if(malformed.state==='ready')assert.throws(()=>activateDeferredReviewMethods(f.material,malformed.evidence),/回执损坏/)
})

test('run_code打印合法摘要和正文不能伪造加载，外层失败不抹掉已完成的真实加载',async t=>{
 for(const mode of ['print-only','outer-error'] as const){
  const f=await fixture(t,'typescript',mode),read=collectReviewToolEvidence(f.prefix,f.binding,f.snapshot)
  assert.equal(read.state,'ready');if(read.state!=='ready')continue
  assert.equal(activateDeferredReviewMethods(f.material,read.evidence).methods.length,mode==='print-only'?0:1)
 }
})

for(const language of ['typescript','python'] as const)test('PTC加载的固定方法贯穿真实R1/R2与冷读：'+language,async t=>{await fixture(t,language,'load',true)})

for(const language of ['typescript','python'] as const)test('真实Run发送的readExecution冻结PTC传输，接入collector并完成R1/R2：'+language,async t=>{
 const f=await fixture(t,language,'load',true,{presentation:'ptc',kind:'tools'})
 const delivered=f.events.find(event=>event.type==='user/message'&&Reflect.get(event.data.source,'summary')==='复核后交付')
 assert.ok(delivered?.type==='user/message')
 const evidence=Reflect.get(delivered.data.source,'toolEvidence') as import('../src/task-delivery-review-tools.ts').ReviewToolEvidence
 assert.ok(evidence.execution.allowedTools.includes('run_code'),'值必须来自真实dshTaskRunPorts.readExecution，而非手工snapshot')
 assert.deepEqual(f.run.allowedTools,[],'岗位逻辑白名单不能被传输包装改写')
 const snapshot={...evidence.execution,continuationMessageIds:new Set(evidence.execution.continuationMessageIds)}
 assert.equal(collectReviewToolEvidence(f.prefix,f.binding,snapshot).state,'ready')
 assert.ok(!f.requests[2]!.tools?.some(tool=>tool.name==='run_code'),'复核切原生后不依赖此刻的SDK重新猜运行期传输')
 const forged=structuredClone(f.prefix)
 for(const event of forged)if(event.type==='tool/ptc-dispatch-start'||event.type==='tool/ptc-dispatch')event.data.name='run_code'
 assert.equal(collectReviewToolEvidence(forged,f.binding,snapshot).state,'blocked','冻结的root传输不能被当作嵌套逻辑工具授权')
})

test('真实Run原生模式不冻结PTC传输，纯文本/digest拒绝仅打印的run_code冒充',async t=>{
 const native=await fixture(t,'typescript','load',true,{presentation:'native',kind:'tools'})
 const delivered=native.events.find(event=>event.type==='user/message'&&Reflect.get(event.data.source,'summary')==='复核后交付');assert.ok(delivered?.type==='user/message')
 const evidence=Reflect.get(delivered.data.source,'toolEvidence') as import('../src/task-delivery-review-tools.ts').ReviewToolEvidence
 assert.ok(!evidence.execution.allowedTools.includes('run_code'))
 for(const kind of ['text','digest'] as const){
  const f=await fixture(t,'typescript','print-only',false,{presentation:'ptc',kind})
  assert.equal(f.requests.length,2)
  assert.ok(f.traces.some(row=>row&&typeof row==='object'&&String(Reflect.get(row,'reason')).endsWith('tool-identity')),kind)
  assert.equal(readTaskRunGroupResult(f.events,'rpc',undefined,undefined,{requireReview:true,runId:'run'}),undefined)
 }
})

test('实际按需资料读取属于有工具运行，即使岗位没有外部工具与Skill也冻结真实PTC传输',async t=>{
 const f=await fixture(t,'python','load',true,{presentation:'ptc',kind:'knowledge'})
 const delivered=f.events.find(event=>event.type==='user/message'&&Reflect.get(event.data.source,'summary')==='复核后交付');assert.ok(delivered?.type==='user/message')
 const evidence=Reflect.get(delivered.data.source,'toolEvidence') as import('../src/task-delivery-review-tools.ts').ReviewToolEvidence
 assert.ok(evidence.execution.allowedTools.includes('run_code'));assert.deepEqual(f.run.allowedTools,[]);assert.deepEqual(f.run.skills,[])
 assert.ok(evidence.schema==='teloa.delivery-review-tools/v3'&&evidence.ptcReceipts.some(receipt=>receipt.name==='teloa_knowledge_read'&&!receipt.isError))
})

test('冻结复核传输不授予岗位编排权限，真实任务守卫仍拒绝未授权run_code',async t=>{
 const f=await fixture(t,'typescript','load',false,{presentation:'ptc',kind:'tools',enforceGuard:true})
 const result=f.events.find(event=>event.type==='tool/result'&&event.data.message.toolCallId==='outer')
 assert.ok(result?.type==='tool/result');assert.equal(result.data.message.isError,true)
 assert.ok(result.data.message.content.some(part=>part.type==='text'&&/编排类工具未在员工执行范围内授权/.test(part.text)))
 assert.ok(!f.events.some(event=>event.type==='tool/ptc-dispatch-start'||event.type==='tool/ptc-dispatch'))
 assert.deepEqual(f.run.allowedTools,[])
})

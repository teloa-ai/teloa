import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {SessionId,type SessionEvent} from '@deepseek-ai/dsh-session'
import {ToolCallId,type GenerateOptions,type StreamChunk} from '@deepseek-ai/dsh-llm'
import type {TaskRunSubagent} from '@teloa/backend'
import {nativeHotSubagentFixture} from './fixtures/native-hot-subagent.ts'
import {registerTaskSubagentTool} from '../src/task-subagent-tool.ts'
import {readSessionEvents} from '../src/session-events.ts'
import {collectReviewToolEvidence,replayReviewToolEvidence,type DeliveryReviewExecutionSnapshot} from '../src/task-delivery-review-tools.ts'
import {readNativeReviewChildren} from '../src/task-delivery-review-native-children.ts'
import {leaseTaskDeliveryReview,createReviewSourceCatalog,deliveryReviewToolName,type DeliveryReviewTrace} from '../src/task-delivery-review.ts'
import {readTaskRunGroupResult} from '../src/task-run-group-result.ts'

const goal='计算37×23，给出分配律过程。',answer='37 × 23 = 37 × (20 + 3) = 740 + 111 = 851。'
const text=(value:string):StreamChunk[]=>[{type:'block-start',index:0,blockType:'text'},{type:'block-end',index:0,block:{type:'text',text:value}},{type:'finish',reason:{kind:'stop'}}]
const call=(name:string,id:string,args:unknown):StreamChunk[]=>[{type:'block-start',index:0,blockType:'tool-call'},{type:'block-end',index:0,block:{type:'tool-call',name,id:ToolCallId(id),arguments:JSON.stringify(args)}},{type:'finish',reason:{kind:'tool-calls'}}]

test('真实原生subagent_task的固定归属和完成正文进入原R1/R2，子输出不能绕过正式复核，cold同源',{timeout:15000},async t=>{
 const f=await nativeHotSubagentFixture(t,'one-shot',false,true),runId='review-native-run',requestId='review-native-request',registrations:TaskRunSubagent[]=[],traces:DeliveryReviewTrace[]=[]
 const remove=registerTaskSubagentTool(f.ctx,{
  limits:{maxDepth:1,maxPerRun:1},runId:async id=>id===f.parent.id?runId:undefined,
  reserve:async({reservationId})=>{registrations.push({runId,reservationId,state:'reserved',createdAt:new Date().toISOString()})},
  bind:async({reservationId,childSessionId,depth})=>{const row=registrations.find(row=>row.reservationId===reservationId)!;Object.assign(row,{state:'started',childSessionId,depth,startedAt:new Date().toISOString()})},
  settle:async({childSessionId,stopReason})=>{const row=registrations.find(row=>row.childSessionId===childSessionId)!;Object.assign(row,{state:'ended',stopReason,endedAt:new Date().toISOString()})},
  release:async()=>{throw Error('本用例不能释放已经真实启动的子任务')},abandon:async()=>{throw Error('本用例不能把正常结果伪装为abandoned')},
 });t.after(remove)
 const parentScripts=[call('subagent_task','native-call',{description:'纯计算子任务',prompt:goal}),text(answer),call(deliveryReviewToolName,'r1',{phase:'revise',issues:[]}),call(deliveryReviewToolName,'r2',{phase:'verify',verdict:'accept',checks:['goal',1,2,3,4,5,6,7,8].map(id=>({id,status:'pass'})),changeChecks:[],findings:[]})]
 f.adapter.stream=async function*(options:GenerateOptions){this.requests.push(options);const script=options.sessionId===f.parent.id?parentScripts.shift():text(answer);assert.ok(script,'不增加模型请求或复做子任务');yield* script}
 const binding={runId,sessionId:f.parent.id,requestId}
 const inspect=async(id:string,signal:AbortSignal)=>{const handle=await f.ctx.sessionPersistence.open(SessionId(id),'read',{signal});try{return {meta:handle.header,inheritedEventCount:handle.inheritedEventCount,events:(await handle.read(undefined,undefined,{signal})).events}}finally{await handle.close()}}
 const ports={inspect,live:(id:string)=>f.ctx.agents.get(SessionId(id))}
 let snapshot:DeliveryReviewExecutionSnapshot|undefined,nativePrefix:readonly SessionEvent[]=[]
 const readExecution=async():Promise<DeliveryReviewExecutionSnapshot>=>{
  nativePrefix=[...readSessionEvents(f.parent.session)]
  const nativeChildren=await readNativeReviewChildren(ports,nativePrefix,binding,registrations,new AbortController().signal)
  const state=f.work.readReviewState(f.parent,requestId)
  const current:DeliveryReviewExecutionSnapshot={...binding,allowedTools:['subagent_task'],continuationMessageIds:new Set(state.continuationMessageIds),runtimeLinks:[],jobs:[],pendingJobCompletion:state.pendingJobCompletion,pendingInput:state.pendingInput,children:'none',flow:'none',...(nativeChildren?{nativeChildren}:{})}
  snapshot=current;return current
 }
 const catalog=createReviewSourceCatalog([{id:'goal',kind:'goal',title:'本人目标',text:goal,origin:{field:'workRequest',pointer:'/sourceText'}}])
 const release=leaseTaskDeliveryReview(f.parent,{runId,requestId,requireReview:true,material:{goal,inputs:{knowledge:0,group:false,context:false},methods:[],catalog},readExecution,publish:async(message,signal)=>f.work.withNewInput(f.parent,message,{producer:'prompt',identity:message.id},()=>f.parent.inject(message),signal),trace:row=>traces.push(row)});t.after(release)
 await f.send(requestId,goal)
 assert.equal(f.adapter.requests.filter(request=>request.sessionId===f.parent.id).length,4,JSON.stringify(traces))
 assert.equal(f.adapter.requests.filter(request=>request.sessionId!==f.parent.id).length,1,'只执行原子调用一次')
 assert.ok(traces.some(row=>row.state==='delivered'),JSON.stringify(traces))
 const events=readSessionEvents(f.parent.session),cold=JSON.parse(JSON.stringify(events)) as SessionEvent[]
 assert.equal(readTaskRunGroupResult(cold,requestId,undefined,undefined,{requireReview:true,runId}),answer)
 assert.ok(snapshot?.nativeChildren?.length===1)
 assert.ok(JSON.stringify(snapshot.nativeChildren).length<4096,'只冻结必要归属/正文/终态，不带子会话上下文或推理')
 const collection=collectReviewToolEvidence(nativePrefix,{...binding,turn:1},snapshot)
 assert.equal(collection.state,'ready');if(collection.state!=='ready')return
 assert.equal(replayReviewToolEvidence(nativePrefix,collection.evidence),true)
 assert.ok(!JSON.stringify(snapshot.nativeChildren).includes('system/message'))
 const parentRequests=f.adapter.requests.filter(request=>request.sessionId===f.parent.id)
 assert.deepEqual(parentRequests.slice(2).map(request=>(request.tools??[]).map(tool=>tool.name)),[[deliveryReviewToolName],[deliveryReviewToolName]])
 assert.ok(JSON.stringify(parentRequests[2]).includes(answer),'原调用输出作为资料进入原复核，不直接发布')
 for(const mode of ['missing-proof','foreign-run','foreign-parent','wrong-call','wrong-prompt','wrong-output','unfinished','unknown-catalog','missing-result','duplicate-child'] as const)await t.test(mode,()=>{
  const changed=structuredClone(nativePrefix),current=structuredClone(snapshot!),child=current.nativeChildren![0]!
  if(mode==='missing-proof')Reflect.deleteProperty(current,'nativeChildren')
  if(mode==='foreign-run')child.registration.runId='other'
  if(mode==='foreign-parent')Reflect.set(child.header,'parentSession',SessionId('other-parent'))
  if(mode==='wrong-call')child.registration.reservationId='call:foreign'
  if(mode==='wrong-prompt')child.input.text='另一个请求'
  if(mode==='wrong-output')child.answer.text='伪造结果'
  if(mode==='unfinished')child.registration.state='started'
  if(mode==='duplicate-child')Reflect.set(current,'nativeChildren',[child,structuredClone(child)])
  if(mode==='unknown-catalog'){const event=changed.find(event=>event.type==='subagent/catalog');assert.ok(event?.type==='subagent/catalog');Reflect.set(event.data,'version',1)}
  const rows=mode==='missing-result'?changed.filter(event=>event.type!=='tool/result'):changed
  assert.equal(collectReviewToolEvidence(rows,{...binding,turn:1},current).state,'blocked')
 })
 await t.test('异request或仍有后台子级不接受',()=>{
  assert.equal(collectReviewToolEvidence(nativePrefix,{...binding,requestId:'other',turn:1},snapshot!).state,'blocked')
  assert.equal(collectReviewToolEvidence(nativePrefix,{...binding,turn:1},{...snapshot!,children:'outstanding'}).state,'pending')
 })
 await t.test('未知子归属与在途输入不能由完成文本代替，reader保持拒绝',async()=>{
  await assert.rejects(readNativeReviewChildren(ports,nativePrefix,binding,[],new AbortController().signal))
  await assert.rejects(readNativeReviewChildren({...ports,live:()=>({status:'idle',inbox:{nextTurn:[{}],nextStep:[]}})},nativePrefix,binding,registrations,new AbortController().signal))
  await assert.rejects(readNativeReviewChildren({...ports,inspect:async(id,signal)=>{const original=await inspect(id,signal);return {...original,meta:{...original.meta,parentSession:SessionId('other-parent')}}}},nativePrefix,binding,registrations,new AbortController().signal))
  await assert.rejects(readNativeReviewChildren({...ports,inspect:async(id,signal)=>{const original=await inspect(id,signal),events=structuredClone(original.events),input=events.find(event=>event.type==='user/message'&&event.data.source.kind==='user');assert.ok(input?.type==='user/message');Reflect.set(input.data,'source',{kind:'agent-message',form:'relay',senderSessionId:'another-parent'});return {...original,events}}},nativePrefix,binding,registrations,new AbortController().signal))
  await assert.rejects(readNativeReviewChildren({...ports,inspect:async(id,signal)=>{const original=await inspect(id,signal),events=structuredClone(original.events),answer=[...events].reverse().find(event=>event.type==='assistant/message');assert.ok(answer?.type==='assistant/message');Reflect.set(answer.data.message,'content',[{type:'text',text:'x'.repeat(200*1024)}]);return {...original,events}}},nativePrefix,binding,registrations,new AbortController().signal))
 })
 await t.test('新native proof不能伪降旧v1，旧证据兼容另由原测试约束',()=>{
  const {schema:_schema,drafts:_drafts,sha256:_hash,...same}=collection.evidence,body={schema:'teloa.delivery-review-tools/v1' as const,...same}
  assert.equal(replayReviewToolEvidence(nativePrefix,{...body,sha256:createHash('sha256').update(JSON.stringify(body)).digest('hex')}),false)
 })
})

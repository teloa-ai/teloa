import test,{type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import {Context} from '@deepseek-ai/cordis'
import {AgentRegistry,type Agent} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {LlmAdapter,LlmRuntime,createUserMessage,type GenerateOptions,type StreamChunk} from '@deepseek-ai/dsh-llm'
import {SessionId,SessionStore,type SessionEvent} from '@deepseek-ai/dsh-session'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {ToolRuntime,defineTool,type ToolDefinition} from '@deepseek-ai/dsh-tools'
import {createReviewSourceCatalog,deliveryReviewToolName,draftSha256,leaseTaskDeliveryReview,ownsDeliveryReviewSubmission,type DeliveryReviewTrace,type ReviewMaterial} from '../src/task-delivery-review.ts'
import {registerTaskToolGuard} from '../src/task-tool-guard.ts'
import {readTaskRunGroupResult} from '../src/task-run-group-result.ts'
import {readSessionEvents} from '../src/session-events.ts'

type Reply=readonly StreamChunk[]
type Call={name:string;arguments:unknown}
const text=(value:string):Reply=>[{type:'block-start',index:0,blockType:'text'},{type:'text-delta',index:0,text:value},{type:'block-end',index:0,block:{type:'text',text:value}},{type:'finish',reason:{kind:'stop'}}]
let callSerial=0
/** 一条助手回复里的若干原生工具调用，以 tool-calls 收尾。 */
const calls=(...items:Call[]):Reply=>[...items.flatMap((item,index)=>[{type:'block-start',index,blockType:'tool-call'},{type:'block-end',index,block:{type:'tool-call',id:'call-'+(++callSerial),name:item.name,arguments:item.arguments}}]),{type:'finish',reason:{kind:'tool-calls'}}] as unknown as Reply
type Edit={blockId:number;after:string}
const coverageFor=(count:number,change:readonly number[],retain:readonly number[]=[])=>({change:[...new Set(change)],retain:[...retain],unrelated:Array.from({length:count},(_,index)=>index+1).filter(id=>!change.includes(id)&&!retain.includes(id)),unknown:[] as number[]})

function passageBasis(catalog:ReturnType<typeof createReviewSourceCatalog>,sourceId:string,needle:string){
 const source=catalog.sources.find(source=>source.id===sourceId);assert.ok(source)
 const passage=catalog.passages.find(passage=>passage.sourceId===sourceId&&source.text.slice(passage.start,passage.end).includes(needle));assert.ok(passage,'引用必须来自完整冻结目录的真实片段')
 return {sourceId,passageId:passage.id}
}
type Revision={phase:'revise';issues:{problem:string;basis:{sourceId:string;passageId:string}[];affectedBlockIds:number[];coverage:ReturnType<typeof coverageFor>;edits:Edit[]}[]}
type Verification={phase:'verify';verdict:'accept'|'reject';checks:{id:'goal'|number;status:'pass'|'fail'|'unknown'}[];changeChecks:{issueId:string;status:'verified'|'unresolved'|'unknown';reviewedBlockIds:number[]}[];findings:{problem:string;basis:{sourceId:string;passageId:string}[];blockIds:number[]}[]}
type Submission=Revision|Verification
const verify=(issueIds:readonly string[]=[],blocks:readonly (readonly number[])[]=issueIds.map(()=>[1])):Verification=>({phase:'verify',verdict:'accept',checks:(['goal',1,2,3,4,5,6,7,8] as const).map(id=>({id,status:'pass'})),changeChecks:issueIds.map((issueId,index)=>({issueId,status:'verified',reviewedBlockIds:[...blocks[index]!]})),findings:[]})
const submission=(edits:Edit[]=[],blockCount=2):Call=>({name:deliveryReviewToolName,arguments:{phase:'revise',issues:edits.length?[{problem:'原结论超出资料。',basis:[passageBasis(material.catalog,'goal',material.goal)],affectedBlockIds:[...new Set(edits.map(edit=>edit.blockId))],coverage:coverageFor(blockCount,edits.map(edit=>edit.blockId)),edits}]:[]}})
const acceptance=(ids:readonly string[]=[]):Call=>({name:deliveryReviewToolName,arguments:verify(ids)})
/** 回复可按本次请求现场生成，用于在复核步进行中观察租约状态。 */
type Step=Reply|((options:GenerateOptions)=>Reply)
class ScriptAdapter extends LlmAdapter{
 requests:GenerateOptions[]=[]
 readonly replies:Map<string,Step[]>
 constructor(replies:Map<string,Step[]>){super();this.replies=replies}
 override async resolveModel(provider:string,model:string){return {provider,id:model,name:model,inputModalities:['text'] as const}}
 async *stream(options:GenerateOptions):AsyncGenerator<StreamChunk>{
  this.requests.push(options)
  // 按模型名区分两个并发 agent 的回放队列；交错调度不影响各自顺序。
  const step=this.replies.get(options.model)?.shift()??text('多余请求')
  for(const chunk of typeof step==='function'?step(options):step)yield chunk
 }
}
const material:ReviewMaterial={goal:'资料：1 家已付款（口述）。',inputs:{knowledge:0,group:false,context:false},methods:[],catalog:createReviewSourceCatalog([{id:'goal',kind:'goal',title:'原目标',text:'资料：1 家已付款（口述）。',origin:{field:'inputText',pointer:'/task/goal'}}])}
const draft='结论：1 家已付款，记为 A 级。\n\n说明：仅依据资料。'
const fixed='结论：1 家已付款（口述，未经佐证）。'
const result=draft.replace('结论：1 家已付款，记为 A 级。',fixed)

/** 真实 AgentLoop 与 ToolRuntime；可选装真实任务工具闸（受管运行策略 allowedTools=[]），并登记一个普通业务工具用于越权尝试。 */
async function runtime(t:TestContext,scripts:Record<string,Step[]>,guard?:{allowedTools:string[]}){
 const ctx=new Context();t.after(()=>ctx.fiber.dispose())
 for(const plugin of [LlmRuntime,SessionStore,SessionProjectionRegistry,SystemPrompt,ToolRuntime,AgentRegistry])await ctx.plugin(plugin)
 await ctx.plugin(AgentLoop,{agents:[]})
 let executed=0
 ctx.tools.register(defineTool({name:'teloa_business_write',description:'业务写入替身',parameters:{},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async()=>{executed++;return 'ok'}}))
 if(guard)registerTaskToolGuard(ctx,async()=>({allowedTools:guard.allowedTools,nativeRequestId:'rpc'}))
 const adapter=new ScriptAdapter(new Map(Object.entries(scripts)));ctx.llm.registerAdapter(['script'],adapter)
 const lease=async(model:string)=>{
  const {agent}=await ctx.agents.create({sessionId:SessionId('structured-'+model+'-'+t.name),agentOptions:{provider:'script',model}})
  const traces:DeliveryReviewTrace[]=[]
  leaseTaskDeliveryReview(agent,{runId:'run-'+model,requestId:'rpc',material,trace:entry=>{traces.push(entry)},publish:async message=>{agent.inject(message)}})
  const send=async(rpcId='rpc')=>{agent.followup(createUserMessage({source:{kind:'user',rpcId},content:[{type:'text',text:'任务'}]}));await agent.whenIdle()}
  return {agent,traces,send,events:()=>readSessionEvents(agent.session) as readonly SessionEvent[]}
 }
 return {ctx,adapter,lease,executed:()=>executed}
}
const ends=(events:readonly SessionEvent[])=>events.flatMap(event=>event.type==='turn/end'?[event.data.reason.kind]:[])
const toolsOf=(request:GenerateOptions)=>(request.tools??[]).map(tool=>tool.name).sort()
const results=(events:readonly SessionEvent[])=>events.flatMap(event=>event.type==='tool/result'?[{callId:event.data.message.toolCallId,isError:event.data.message.isError}]:[])
const owns=(agent:Agent)=>ownsDeliveryReviewSubmission({name:deliveryReviewToolName,agent})

/** 真实 N24 失败的参数类型：空集合被模型写成字符串，不能在宿主侧静默转换。 */
const coverageSubmission=(unknown:unknown):Call=>{
 const call=submission([{blockId:1,after:fixed}])
 const args=call.arguments as Revision
 return {...call,arguments:{...args,issues:args.issues.map(({affectedBlockIds:_ids,...issue})=>({...issue,affectedScope:'coverage',coverage:{...issue.coverage,unknown}}))}}
}
const invalidCoverage=()=>coverageSubmission('')

test('严格 schema 失败后仅一次原生纠参：保留真实错误，同 R1 修正成功才进入原 R2，冷读仍可复原',async t=>{
 const f=await runtime(t,{m:[text(draft),calls(invalidCoverage()),calls(coverageSubmission([])),calls(acceptance(['r1:u1:i1']))]},{allowedTools:[]})
 const a=await f.lease('m')
 await a.send()
 assert.deepEqual(ends(a.events()),['completed'])
 assert.equal(f.adapter.requests.length,4,'草稿、R1失败、同单元纠参、R2；没有额外复核轮次')
 assert.deepEqual(results(a.events()).map(entry=>entry.isError),[true,false,false],'错误不能改写为成功')
 assert.equal(readTaskRunGroupResult(a.events(),'rpc'),result)
 assert.equal(readTaskRunGroupResult(JSON.parse(JSON.stringify(a.events())) as SessionEvent[],'rpc'),result,'持久化后只以成功 R1/R2 回执重算')
 const retry=JSON.stringify(f.adapter.requests[2]!.messages),r2=JSON.stringify(f.adapter.requests[3]!.messages)
 assert.match(retry,/invalid arguments:/,'模型收到 SDK 实际 schema 错误，而非新造用户反馈')
 assert.match(retry,/\\"unknown\\":\\"\\"|"unknown":""/,'非法参数仍是原值')
 assert.ok(!r2.includes('invalid arguments:'),'R2 不把失败回执作为依据')
 assert.deepEqual(f.adapter.requests.slice(1).map(toolsOf),Array.from({length:3},()=>[deliveryReviewToolName]))
 const callsMade=a.events().filter(event=>event.type==='tool/call')
 assert.ok(callsMade.every(event=>event.type==='tool/call'&&event.data.turn===callsMade[0]!.data.turn),'纠参没有另起请求轮次')
 assert.equal(a.traces.filter(entry=>entry.state==='planned'&&entry.round===1).length,1,'失败尝试不能登记为成功计划')
 assert.equal(a.events().filter(event=>event.type==='user/message'&&Reflect.get(event.data.source,'summary')==='交付编辑计划').length,2,'纠参不新增用户输入或复核通知')
 assert.equal(f.executed(),0)
})

test('严格 schema 纠参不放行重复调用、夹带业务工具或新输入',async t=>{
 for(const kind of ['duplicate','business','new-input'] as const)await t.test(kind,async sub=>{
  const first=kind==='duplicate'?calls(invalidCoverage(),invalidCoverage()):kind==='business'?calls(invalidCoverage(),{name:'teloa_business_write',arguments:{}}):calls(invalidCoverage())
  const f=await runtime(sub,{m:[text(draft),first,calls(submission()),calls(acceptance())]})
  const a=await f.lease('m')
  if(kind==='new-input')a.agent.ctx.on('tools/pre-execute',async(_exec,next)=>{a.agent.inject(createUserMessage({source:{kind:'user',rpcId:'foreign'},content:[{type:'text',text:'其他请求'}]}));return next()})
  await a.send()
  assert.equal(f.adapter.requests.length,2)
  assert.deepEqual(ends(a.events()),['error'])
  assert.equal(readTaskRunGroupResult(a.events(),'rpc'),undefined)
  assert.equal(f.executed(),0)
 })
})

test('严格 schema 的唯一纠参名额由 R1/R2 共享：R2 可纠参，R1 已使用后 R2 不能再加步',async t=>{
 for(const usedInR1 of [false,true])await t.test(usedInR1?'R1已耗尽':'R2首次使用',async sub=>{
  const invalidVerify={name:deliveryReviewToolName,arguments:{...verify(),checks:''}}
  const f=await runtime(sub,{m:[text(draft),...usedInR1?[calls(invalidCoverage())]:[],calls(submission()),calls(invalidVerify),calls(acceptance())]})
  const a=await f.lease('m');await a.send()
  assert.equal(f.adapter.requests.length,4,'全租约最多增加一次纠参')
  assert.deepEqual(ends(a.events()),[usedInR1?'error':'completed'])
  assert.equal(readTaskRunGroupResult(a.events(),'rpc'),usedInR1?undefined:draft)
  assert.deepEqual(results(a.events()).map(entry=>entry.isError),usedInR1?[true,false,true]:[false,true,false])
  if(!usedInR1){
   assert.match(JSON.stringify(f.adapter.requests[3]!.messages),/invalid arguments:/,'R2纠参仍看到真实错误')
   assert.equal(readTaskRunGroupResult(JSON.parse(JSON.stringify(a.events())) as SessionEvent[],'rpc'),draft)
  }
 })
})

test('严格 schema 纠参机会全租约仅一次，第二次非法立即结束，不进入 R2 或交付',async t=>{
 const f=await runtime(t,{m:[text(draft),calls(invalidCoverage()),calls(invalidCoverage()),calls(submission()),calls(acceptance())]})
 const a=await f.lease('m');await a.send()
 assert.equal(f.adapter.requests.length,3)
 assert.deepEqual(ends(a.events()),['error'])
 assert.deepEqual(results(a.events()).map(entry=>entry.isError),[true,true])
 assert.equal(readTaskRunGroupResult(a.events(),'rpc'),undefined)
 assert.ok(!a.traces.some(entry=>entry.state==='applied'))
})

test('严格 schema 纠参沿用取消和模型准入：取消、来源许可过期或预算拒绝不得调用模型',async t=>{
 for(const kind of ['cancel','expired','budget'] as const)await t.test(kind,async sub=>{
  const f=await runtime(sub,{m:[text(draft),calls(invalidCoverage()),calls(submission()),calls(acceptance())]})
  const a=await f.lease('m')
  let refused=0
  if(kind==='cancel')a.agent.ctx.on('session/event',(_session,event)=>{if(event.type==='tool/result'&&event.data.message.isError){refused++;a.agent.cancel({kind:'hook',reason:'任务时限已到'})}})
  else a.agent.ctx.on('llm/stream',async function*(_request,next){if(f.adapter.requests.length===2){refused++;throw Error(kind==='expired'?'source lease expired':'model budget exhausted')}yield* next()})
  await a.send()
  assert.equal(f.adapter.requests.length,2,'未调用第三次模型')
  assert.deepEqual(ends(a.events()),[kind==='cancel'?'aborted':'error'])
  assert.equal(refused,1,'纠参必须实际经过原有取消或模型准入闸，不能以更早失败冒充守卫覆盖')
  assert.equal(readTaskRunGroupResult(a.events(),'rpc'),undefined)
  assert.ok(!a.traces.some(entry=>entry.state==='applied'))
 })
})

test('受管运行 allowedTools=[]：真实任务工具闸只放行本租约正在接收的回执，不把它加入岗位授权；复核步的业务工具仍被拒绝；释放后普通请求看不到也调不动回执',async t=>{
 const f=await runtime(t,{m:[text(draft),calls(submission([{blockId:1,after:fixed}])),calls(acceptance(['r1:u1:i1'])),calls(submission()),text('追问回复')]},{allowedTools:[]})
 const a=await f.lease('m')
 assert.equal(owns(a.agent),false,'租约尚未进入复核步时不接收')
 await a.send()
 assert.deepEqual(ends(a.events()),['completed'])
 assert.equal(readTaskRunGroupResult(a.events(),'rpc'),result,'两轮回执经真实闸接收并原子应用')
 assert.deepEqual(f.adapter.requests.slice(0,3).map(toolsOf),[['teloa_business_write'],[deliveryReviewToolName],[deliveryReviewToolName]],'复核步只提供回执工具')
 assert.deepEqual(results(a.events()).map(entry=>entry.isError),[false,false])
 // 释放后：作用域定义已注销、不再接收；模型即使照旧调用，也只得到原生错误结果，不产生交付。
 assert.equal(a.agent.ctx.tools.get(deliveryReviewToolName,a.agent),undefined);assert.equal(owns(a.agent),false)
 await a.send('rpc-2')
 assert.ok(!toolsOf(f.adapter.requests[3]!).includes(deliveryReviewToolName),'普通追问不提供回执工具')
 const late=results(a.events()).slice(2)
 assert.ok(late.length===1&&late[0]!.isError,'释放后的回执调用如实落为错误结果')
 assert.equal(a.events().filter(event=>event.type==='user/message'&&Reflect.get(event.data.source,'summary')==='复核后交付').length,1,'不追加交付')
 assert.equal(f.executed(),0)
})

test('宿主按调用方 Context 包装工具登记（同 tool-resource-provenance 的 internal/get：register 实际登记浅拷贝）时，真实任务工具闸仍只接收本租约登记的那一份，不按工具名放行',async t=>{
 const f=await runtime(t,{m:[text(draft),calls(submission()),calls(acceptance())]},{allowedTools:[]})
 // 与真实宿主同一机制：取 tools 时返回的 registry 把 register 的定义换成包装副本，作用域里存的不是调用方传入的对象。
 let wrapped=0
 f.ctx.on('internal/get',(_owner,name,_error,next)=>{
  const tools=next()
  if(name!=='tools'||!tools)return tools
  return new Proxy(tools,{get:(target,prop)=>prop==='register'?(definition:ToolDefinition)=>{wrapped++;return target.register({...definition,output:{...definition.output}})}:Reflect.get(target,prop)})
 })
 const a=await f.lease('m')
 await a.send()
 assert.ok(wrapped>0,'回执登记确实经过宿主包装')
 assert.deepEqual(results(a.events()).map(entry=>entry.isError),[false,false],'包装后的同一份登记仍被接收')
 assert.equal(readTaskRunGroupResult(a.events(),'rpc'),draft)
 assert.equal(owns(a.agent),false,'释放后不再接收')
})

test('复核步里同一回复夹带业务工具或重复提交：业务工具不执行，本单元收为错误、不交付、不追加调用',async t=>{
 for(const [label,reply,reason] of [
  ['夹带业务工具',calls(submission(),{name:'teloa_business_write',arguments:{}}),'rewrite-plan:submission-shape'],
  ['同一回复提交两次',calls(submission(),submission([{blockId:1,after:fixed}])),'rewrite-plan:submission-shape'],
 ] as const)await t.test(label,async sub=>{
  const f=await runtime(sub,{m:[text(draft),reply,text('不应出现')]})
  const a=await f.lease('m')
  await a.send()
  assert.equal(f.adapter.requests.length,2,'不追加调用')
  assert.deepEqual(ends(a.events()),['error'])
  assert.equal(a.traces.at(-1)!.reason,reason)
  assert.ok(!a.traces.some(entry=>entry.state==='applied'),'不部分应用')
  assert.equal(readTaskRunGroupResult(a.events(),'rpc'),undefined,'草稿与回执都不成为交付')
  assert.equal(f.executed(),0,'业务工具体没有执行')
  assert.ok(results(a.events()).some(entry=>entry.isError),'被拒绝的调用如实落为错误结果')
 })
})

test('回执带摘要字段或块编号不合格：工具体拒绝并如实落为错误结果，本单元原子失败，不再请求模型重交',async t=>{
 for(const [label,call,reason] of [
  // 活动契约不接受模型输入的摘要：即使抄对也不吞掉、不静默替换，按多余字段拒绝。
  ['显式摘要字段（抄对）',{name:deliveryReviewToolName,arguments:{phase:'revise',issues:[],snapshotHash:draftSha256(draft)}},'rewrite-plan:shape'],
  ['显式摘要字段（抄错一位）',{name:deliveryReviewToolName,arguments:{phase:'revise',issues:[],snapshotHash:draftSha256(draft).replace(/^./,c=>c==='0'?'1':'0')}},'rewrite-plan:shape'],
  ['块编号不存在',submission([{blockId:9,after:'x'}]),'rewrite-plan:affected-blocks'],
  ['参数多余字段',{name:deliveryReviewToolName,arguments:{phase:'revise',issues:[],note:'x'}},'rewrite-plan:shape'],
 ] as const)await t.test(label,async sub=>{
  const f=await runtime(sub,{m:[text(draft),calls(call),text('不应出现')]})
  const a=await f.lease('m')
  await a.send()
  assert.equal(f.adapter.requests.length,2)
  assert.deepEqual(ends(a.events()),['error']);assert.equal(a.traces.at(-1)!.reason,reason)
  assert.deepEqual(results(a.events()).map(entry=>entry.isError),[true])
  assert.equal(readTaskRunGroupResult(a.events(),'rpc'),undefined)
 })
})

test('两个 agent 并发复核：回执定义只在各自作用域、只被各自租约接收；进行中跨 agent 查不到对方定义，结束后都注销',async t=>{
 const seen:Array<{self:boolean;shared:boolean}>=[]
 let agents:Record<string,Agent>={}
 // 复核请求发出时：本租约正在接收；对方作用域即使也登记了回执，也不是本 agent 的同一份定义。
 const observe=(model:string,other:string,next:Reply)=>(options:GenerateOptions):Reply=>{
  const own=agents[model]!.ctx.tools.get(deliveryReviewToolName,agents[model]!)
  seen.push({self:owns(agents[model]!),shared:own!==undefined&&agents[model]!.ctx.tools.get(deliveryReviewToolName,agents[other]!)===own})
  assert.deepEqual(toolsOf(options),[deliveryReviewToolName])
  return next
 }
 const draftB='乙稿：资料只说 1 家口述付款。'
 const f=await runtime(t,{
  a:[text(draft),observe('a','b',calls(submission([{blockId:1,after:fixed}]))),observe('a','b',calls(acceptance(['r1:u1:i1'])))],
  b:[text(draftB),observe('b','a',calls(submission())),observe('b','a',calls(acceptance()))],
 })
 const [a,b]=[await f.lease('a'),await f.lease('b')]
 agents={a:a.agent,b:b.agent}
 await Promise.all([a.send(),b.send()])
 assert.equal(readTaskRunGroupResult(a.events(),'rpc'),result)
 assert.equal(readTaskRunGroupResult(b.events(),'rpc'),draftB)
 assert.equal(seen.length,4)
 assert.ok(seen.every(entry=>entry.self),'进入复核步的租约接收自己的回执')
 assert.ok(seen.every(entry=>!entry.shared),'对方作用域里的定义与本 agent 的不是同一份')
 assert.ok(results(a.events()).every(entry=>!entry.isError)&&results(b.events()).every(entry=>!entry.isError))
 assert.ok(!results(a.events()).some(entry=>results(b.events()).some(other=>other.callId===entry.callId)),'各自的调用与结果只落在自己的会话')
 for(const agent of [a.agent,b.agent]){assert.equal(agent.ctx.tools.get(deliveryReviewToolName,agent),undefined);assert.equal(owns(agent),false)}
})

test('恢复读取：交付来源如实指向草稿与原生回执结果，重新读取会话事件即可复原交付与审计链，不伪造助手消息',async t=>{
 const f=await runtime(t,{m:[text(draft),calls(submission()),calls(acceptance())]})
 const a=await f.lease('m')
 await a.send()
 const events=readSessionEvents(a.agent.session) as readonly SessionEvent[]
 const delivery=events.find(event=>event.type==='user/message'&&Reflect.get(event.data.source,'summary')==='复核后交付')!
 const call=events.find(event=>event.type==='tool/call')!,result=events.find(event=>event.type==='tool/result')!
 assert.equal(readTaskRunGroupResult(events,'rpc'),draft)
 assert.deepEqual(result.sourceEventSeqs,[call.seq],'原生结果引用调用事件')
 assert.ok(delivery.sourceEventSeqs?.includes(result.seq),'交付来源包含回执结果')
 assert.equal(Reflect.get(delivery.data,'role'),'user','宿主应用结果以宿主来源追加，不伪造助手消息')
 const rounds=Reflect.get(Reflect.get(delivery.data,'source'),'rounds') as {units:{callId:string}[]}[]
 assert.equal(rounds[0]!.units[0]!.callId,Reflect.get(call.data,'callId'),'轮次记录绑定真实回执调用')
 assert.equal(events.filter(event=>event.type==='assistant/message').length,3,'草稿、成组修订与验收均是模型真实产生的助手消息')
 // 新协议的持久交付不能只凭宿主摘要标签读取：验收证据丢失或变成未知时拒绝，旧无protocol历史另有专门用例。
 for(const damage of ['missing-r2','unknown-check','unknown-protocol'] as const){
  const changed=structuredClone(events),copy=changed.find(event=>event.seq===delivery.seq)!
  assert.ok(copy.type==='user/message')
  const source=copy.data.source as unknown as {protocol:string;rounds:{units:{checks:{status:string}[]}[]}[]}
  if(damage==='missing-r2')source.rounds.pop()
  else if(damage==='unknown-check')source.rounds[1]!.units[0]!.checks[0]!.status='unknown'
  else source.protocol='future-unknown'
  assert.equal(readTaskRunGroupResult(changed,'rpc'),undefined,'持久验收损坏不能回退草稿或接受标签：'+damage)
 }
 // 按已提交f038的v1持久结构建立冷读夹具，不把它宣称为保存过的真实旧模型回执。
 const legacy=JSON.parse(JSON.stringify(events)) as SessionEvent[]
 const saved=legacy.find(event=>event.seq===delivery.seq)!
 assert.ok(saved.type==='user/message')
 const source=saved.data.source as unknown as {protocol:string;sourceCatalogSha256:string;rounds:{protocol:string;sourceCatalogSha256:string;units:{protocol:string;checks?:{status:string}[]}[]}[]}
 source.protocol='revise-verify/v1';source.sourceCatalogSha256=draftSha256(JSON.stringify(material.catalog.sources))
 for(const round of source.rounds){round.protocol=source.protocol;round.sourceCatalogSha256=source.sourceCatalogSha256;for(const unit of round.units)unit.protocol=source.protocol}
 assert.equal(readTaskRunGroupResult(JSON.parse(JSON.stringify(legacy)) as SessionEvent[],'rpc'),draft,'v1两轮明确验收的序列化冷快照仍可读取，不要求新片段目录')
 source.rounds[1]!.units[0]!.checks![0]!.status='unknown'
 assert.equal(readTaskRunGroupResult(legacy,'rpc'),undefined,'v1也必须通过完整验收，不因历史分支而接受未知结论')
})

test('宿主自持摘要：真实原生回执不带摘要即被接收并两轮交付；回执结果与 planned 记录写宿主算出的本轮输入摘要（带轮次与单元），与最终轮输入及交付一致；模型输入不再要求抄摘要',async t=>{
 const f=await runtime(t,{m:[text(draft),calls(submission([{blockId:1,after:fixed}])),calls(acceptance(['r1:u1:i1']))]},{allowedTools:[]})
 const a=await f.lease('m')
 const registered:ToolDefinition[]=[]
 f.ctx.on('system-prompt/assemble',async(_assembly,_context,next)=>{
  const prompt=await next(),definition=a.agent.ctx.tools.get(deliveryReviewToolName,a.agent)
  if(definition&&prompt.tools.some(tool=>tool.name===deliveryReviewToolName))registered.push(definition)
  return prompt
 })
 await a.send()
 assert.deepEqual(ends(a.events()),['completed'])
 assert.equal(readTaskRunGroupResult(a.events(),'rpc'),result)
 const events=a.events()
 const delivery=events.find(event=>event.type==='user/message'&&Reflect.get(event.data.source,'summary')==='复核后交付')!
 const source=Reflect.get(delivery.data,'source') as {deliverySha256:string;rounds:{round:number;inputSha256:string}[]}
 assert.deepEqual(source.rounds.map(entry=>[entry.round,entry.inputSha256]),[[1,draftSha256(draft)],[2,draftSha256(result)]])
 assert.equal(source.rounds.at(-1)!.inputSha256,source.deliverySha256,'最终轮输入就是交付正文')
 const toolResults=events.filter(event=>event.type==='tool/result')
 assert.equal(toolResults.length,2)
 source.rounds.forEach((entry,index)=>{
  const body=JSON.stringify(Reflect.get(toolResults[index]!.data,'message'))
  assert.ok(body.includes(entry.inputSha256),'回执结果写宿主算出的本轮输入摘要')
  assert.ok(body.includes(`第 ${entry.round} 轮第 1 单元`),'回执结果带轮次与单元')
 })
 assert.deepEqual(a.traces.filter(entry=>entry.state==='planned').map(entry=>[entry.round,entry.unit,entry.inputSha256]),[[1,0,draftSha256(draft)],[2,0,draftSha256(result)]])
 assert.ok(delivery.sourceEventSeqs?.length===3&&toolResults.every(event=>delivery.sourceEventSeqs!.includes(event.seq)),'交付来源仍指向草稿与两轮回执结果')
 // 两阶段复用同一登记定义，正文摘要由宿主自持；R2必须是显式验收而非空编辑。
 for(const request of f.adapter.requests.slice(1)){
  const input=JSON.stringify(request.messages)
  assert.ok(!input.includes('snapshotHash')&&!input.includes('待复核正文摘要')&&!input.includes('冻结草稿摘要'),'复核要求不含摘要输入要求')
  assert.ok(!input.includes(draftSha256(draft))||request===f.adapter.requests[2],'第 1 轮请求不含待抄摘要')
  const tool=request.tools!.find(entry=>entry.name===deliveryReviewToolName)!
  assert.ok(Object.keys(Reflect.get(tool.parameters as object,'properties') as object).includes('phase'))
  assert.equal(tool.name,deliveryReviewToolName)
 }
 assert.equal(registered.length,2);assert.strictEqual(registered[0],registered[1],'模型可见参数分阶段投影，真实登记definition身份不变')
 assert.equal(a.agent.ctx.tools.get(deliveryReviewToolName,a.agent),undefined,'租约完成后原definition仍正常注销')
})

test('工具体严格绑定：他人 agent、未落盘的 callId、跨步重放上一单元的 callId 都被拒绝；他人 agent 不改变本单元，伪造或重放即本单元原子失败',async t=>{
 // 在复核请求进行中直接执行本租约登记的那一份定义（工具体内的核对不依赖调度器），记录拒绝原因。
 const forge=(agent:Agent,exec:Record<string,unknown>,outcomes:string[])=>{
  const definition=agent.ctx.tools.get(deliveryReviewToolName,agent)!
  definition.execute({phase:'revise',issues:[]},{signal:new AbortController().signal,agent,callId:'forged',concludeTurn(){},deferContext(){},...exec} as never).then(()=>outcomes.push('accepted'),(error:Error)=>outcomes.push(error.message))
 }
 await t.test('他人 agent',async sub=>{
  const outcomes:string[]=[]
  let a:{agent:Agent}|undefined,other:Agent|undefined
  const f=await runtime(sub,{m:[text(draft),()=>{forge(a!.agent,{agent:other},outcomes);return calls(submission())},calls(acceptance())]})
  other=(await f.ctx.agents.create({sessionId:SessionId('other-'+sub.name),agentOptions:{provider:'script',model:'x'}})).agent
  const lease=await f.lease('m');a=lease
  await lease.send()
  assert.deepEqual(outcomes,['复核计划只在本复核单元内提交一次。'])
  assert.deepEqual(ends(lease.events()),['completed'],'他人 agent 的执行不改变本单元状态')
  assert.equal(readTaskRunGroupResult(lease.events(),'rpc'),draft)
 })
 for(const [label,replay,reason] of [['未落盘的 callId',false,'rewrite-plan:stale-call'],['跨步重放上一单元的 callId',true,'rewrite-r2-plan:stale-call']] as const)await t.test(label,async sub=>{
  const outcomes:string[]=[]
  let a:{agent:Agent;events:()=>readonly SessionEvent[]}|undefined
  const forged=()=>{
   const previous=a!.events().find(event=>event.type==='tool/call')
   forge(a!.agent,{callId:replay&&previous?.type==='tool/call'?previous.data.callId:'forged'},outcomes)
   return calls(submission())
  }
  const f=await runtime(sub,{m:replay?[text(draft),calls(submission([{blockId:1,after:fixed}])),forged,text('不应出现')]:[text(draft),forged,text('不应出现')]})
  const lease=await f.lease('m');a=lease
  await lease.send()
  assert.deepEqual(outcomes,['复核计划不属于当前复核单元。'])
  assert.deepEqual(ends(lease.events()),['error'])
  assert.equal(lease.traces.at(-1)!.reason,reason)
  assert.equal(readTaskRunGroupResult(lease.events(),'rpc'),undefined,'伪造或重放后不交付')
  assert.equal(f.adapter.requests.length,replay?3:2,'不追加调用')
 })
})

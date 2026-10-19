import test,{type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import {Context} from '@deepseek-ai/cordis'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {LlmAdapter,LlmRuntime,ToolCallId,createUserMessage,type GenerateOptions,type StreamChunk,type UserMessage} from '@deepseek-ai/dsh-llm'
import {SessionId,SessionStore,type SessionEvent} from '@deepseek-ai/dsh-session'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {ToolRuntime,defineTool} from '@deepseek-ai/dsh-tools'
import {createReviewSourceCatalog,deliveryReviewToolName,leaseTaskDeliveryReview,maxReviewModelSteps,splitReviewUnits,type DeliveryReviewTrace,type ReviewMaterial} from '../src/task-delivery-review.ts'
import {readTaskRunGroupResult} from '../src/task-run-group-result.ts'
import {readSessionEvents} from '../src/session-events.ts'

// 真实 3110 失败形态：复核单元只写推理或说明即收尾、验收回执漏写全稿依赖块、取证步数多于三步。
type Reply=readonly StreamChunk[]
const text=(value:string,finish:'stop'|'max-tokens'='stop'):Reply=>[{type:'block-start',index:0,blockType:'text'},{type:'text-delta',index:0,text:value},{type:'block-end',index:0,block:{type:'text',text:value}},{type:'finish',reason:{kind:finish}}] as unknown as Reply
let serial=0
const call=(name:string,args:unknown):Reply=>[{type:'block-start',index:0,blockType:'tool-call'},{type:'block-end',index:0,block:{type:'tool-call',name,id:ToolCallId('call-'+(++serial)),arguments:JSON.stringify(args)}},{type:'finish',reason:{kind:'tool-calls'}}] as unknown as Reply
const checks=['goal',1,2,3,4,5,6,7,8].map(id=>({id,status:'pass'}))
const revise=(issues:unknown[]=[])=>call(deliveryReviewToolName,{phase:'revise',issues})
const verify=(changeChecks:unknown[]=[])=>call(deliveryReviewToolName,{phase:'verify',verdict:'accept',checks,changeChecks,findings:[]})

class ScriptAdapter extends LlmAdapter{
 readonly requests:GenerateOptions[]=[]
 readonly scripts:Reply[]
 constructor(scripts:Reply[]){super();this.scripts=scripts}
 override async resolveModel(provider:string,model:string){return {provider,id:model,name:model,inputModalities:['text'] as const}}
 async *stream(options:GenerateOptions){this.requests.push(options);const script=this.scripts.shift();assert.ok(script,'不增加模型请求');yield* script}
}

const goal='资料：1 家已付款（口述）。'
const catalog=createReviewSourceCatalog([{id:'goal',kind:'goal',title:'原目标',text:goal,origin:{field:'inputText',pointer:'/task/goal'}}])
const material:ReviewMaterial={goal,inputs:{knowledge:0,group:false,context:false},methods:[],catalog}
const goalBasis=()=>{const passage=catalog.passages.find(row=>row.sourceId==='goal')!;return [{sourceId:'goal',passageId:passage.id}]}
/** 四个标题小节的长稿：确定性分成四个复核单元。 */
const body=Array.from({length:4},(_,i)=>`## 第${i+1}节\n\n`+'已提供的合成事实。'.repeat(125)).join('\n\n')

/** 真实 AgentLoop/ToolRuntime；带取证工具时走原生工具证据路径（readExecution），否则走纯文本草稿路径。 */
async function runtime(t:TestContext,scripts:Reply[],withTools=false){
 const ctx=new Context();t.after(()=>ctx.fiber.dispose())
 for(const plugin of [LlmRuntime,SessionStore,SessionProjectionRegistry,SystemPrompt,ToolRuntime,AgentRegistry])await ctx.plugin(plugin)
 await ctx.plugin(AgentLoop,{agents:[]})
 if(withTools)ctx.tools.register(defineTool({name:'calculation',description:'合成计算',parameters:{},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async()=>'7500'}))
 const adapter=new ScriptAdapter(scripts);ctx.llm.registerAdapter(['minimax'],adapter)
 const {agent}=await ctx.agents.create({sessionId:SessionId('review-correction-'+(++serial)),agentOptions:{provider:'minimax',model:'MiniMax-M3',maxTokens:65536}})
 const traces:DeliveryReviewTrace[]=[]
 const release=leaseTaskDeliveryReview(agent,{runId:'correction-run',requestId:'rpc',requireReview:true,material,
  publish:async(message:UserMessage,signal:AbortSignal)=>{signal.throwIfAborted();agent.inject(message)},trace:entry=>traces.push(entry),
  ...withTools?{readExecution:async()=>({runId:'correction-run',sessionId:agent.id,requestId:'rpc',allowedTools:['calculation'],continuationMessageIds:new Set<string>(),runtimeLinks:[],jobs:[],pendingJobCompletion:false,pendingInput:false,children:'none' as const,flow:'none' as const})}:{}})
 t.after(release)
 const send=async()=>{agent.followup(createUserMessage({source:{kind:'user',rpcId:'rpc'},content:[{type:'text',text:goal}]}));await agent.whenIdle()}
 const events=()=>readSessionEvents(agent.session) as readonly SessionEvent[]
 const result=(rows=events())=>readTaskRunGroupResult(rows,'rpc',undefined,undefined,{requireReview:true,runId:'correction-run'})
 return {adapter,traces,send,events,result}
}
const ends=(events:readonly SessionEvent[])=>events.flatMap(event=>event.type==='turn/end'?[event.data.reason.kind]:[])
const reminders=(events:readonly SessionEvent[])=>events.filter(event=>event.type==='user/message'&&Reflect.get(event.data.source,'summary')==='交付复核补交')
const errors=(events:readonly SessionEvent[])=>events.flatMap(event=>event.type==='tool/result'&&event.data.message.isError?[event.data.message.content.flatMap(part=>part.type==='text'?[part.text]:[]).join('\n')]:[])
const clone=(events:readonly SessionEvent[])=>JSON.parse(JSON.stringify(events)) as SessionEvent[]

test('复核预算从复核起另计：五步取证加草稿后，四个修订与四个验收单元都实际提交并交付',async t=>{
 const units=splitReviewUnits(body)
 assert.equal(units.length,4)
 assert.ok(maxReviewModelSteps>=2*units.length+1,'复核预算至少覆盖R1、R2各四个单元与一次纠正')
 const f=await runtime(t,[...Array.from({length:5},()=>call('calculation',{})),text(body),...units.map(()=>revise()),...units.map(()=>verify())],true)
 await f.send()
 assert.equal(f.adapter.requests.length,14,'五步取证、草稿、四次修订、四次验收；取证步数不挤占复核')
 assert.deepEqual(ends(f.events()),['completed'])
 assert.ok(f.traces.some(row=>row.state==='delivered'))
 assert.ok(!f.traces.some(row=>row.reason==='review-model-step-limit'))
 assert.equal(f.result(),body)
 assert.equal(f.result(clone(f.events())),body,'持久化后冷读仍按原生回执复原')
})

test('单元只写说明未调用回执工具：同轮唯一一次补交提醒后正式提交，后续单元与R2照常，冷读可复原',async t=>{
 const units=splitReviewUnits(body)
 const f=await runtime(t,[text(body),revise(),text('第 2/4 复核单元已逐项核对，无需修改，现在提交回执。'),revise(),revise(),revise(),...units.map(()=>verify())])
 await f.send()
 assert.equal(f.adapter.requests.length,10,'草稿、四个修订单元与一次补交、四个验收单元')
 assert.deepEqual(ends(f.events()),['completed'])
 const sent=reminders(f.events())
 assert.equal(sent.length,1,'宿主只发一次补交提醒')
 assert.match(JSON.stringify(sent[0]!.data),/没有通过真实工具调用提交本单元回执/)
 assert.match(JSON.stringify(f.adapter.requests[3]!.messages),/没有通过真实工具调用提交本单元回执/,'补交请求实际带着提醒进入模型')
 assert.deepEqual(f.adapter.requests[3]!.tools?.map(tool=>tool.name),[deliveryReviewToolName],'补交步仍只提供回执工具')
 assert.ok(f.traces.some(row=>row.state==='requested'&&row.reason==='correction:plan:missing-submission'&&row.unit===1))
 assert.equal(f.traces.filter(row=>row.state==='planned'&&row.round===1).length,4,'漏交那一步不登记为计划')
 assert.equal(f.result(),body)
 assert.equal(f.result(clone(f.events())),body)
})

test('长度截断不补交（原生循环以截断收尾整轮）；补交后第二次缺交如实收错，不以草稿冒充结果',async t=>{
 await t.test('长度截断仍直接收错',async sub=>{
  const f=await runtime(sub,[text('草稿：1 家已付款（口述）。'),text('推理过长被截断','max-tokens'),revise(),verify()])
  await f.send()
  assert.equal(f.adapter.requests.length,2)
  assert.deepEqual(ends(f.events()),['error'])
  assert.equal(f.traces.at(-1)!.reason,'rewrite-finish:max-tokens')
  assert.equal(reminders(f.events()).length,0)
  assert.equal(f.result(),undefined)
 })
 await t.test('补交后仍只写说明',async sub=>{
  const f=await runtime(sub,[text(body),text('我将提交回执。'),text('现在提交回执。'),revise()])
  await f.send()
  assert.equal(f.adapter.requests.length,3,'名额用尽后不再请求模型')
  assert.deepEqual(ends(f.events()),['error'])
  assert.equal(f.traces.at(-1)!.reason,'rewrite-plan:missing-submission')
  assert.equal(reminders(f.events()).length,1)
  assert.equal(f.result(),undefined)
 })
})

test('R2漏写全稿依赖块：语义拒绝附宿主核对表，同轮纠正一次后验收通过；冷读仍复原修订后正文',async t=>{
 const draft='结论：1 家已付款，记为 A 级。\n\n说明：仅依据资料。',fixed='结论：1 家已付款（口述，未经佐证）。'
 const issue={problem:'原结论超出资料。',basis:goalBasis(),affectedBlockIds:[1],coverage:{change:[1],retain:[],unrelated:[2],unknown:[]},edits:[{blockId:1,after:fixed}]}
 const f=await runtime(t,[text(draft),revise([issue]),verify([{issueId:'r1:u1:i1',status:'verified',reviewedBlockIds:[1,2]}]),verify([{issueId:'r1:u1:i1',status:'verified',reviewedBlockIds:[1]}])])
 await f.send()
 assert.deepEqual(ends(f.events()),['completed'])
 const failed=errors(f.events())
 assert.equal(failed.length,1)
 assert.match(failed[0]!,/复核回执未通过校验：change-blocks/)
 assert.ok(failed[0]!.includes('宿主当前依赖块核对表：[{"issueId":"r1:u1:i1","blockIds":[1]}]'),'报错附宿主核对表，模型无需猜测')
 assert.equal(f.adapter.requests.length,4,'草稿、R1、R2失败、同单元纠正；不新增用户输入')
 assert.equal(reminders(f.events()).length,0)
 const expected=draft.replace('结论：1 家已付款，记为 A 级。',fixed)
 assert.equal(f.result(),expected)
 assert.equal(f.result(clone(f.events())),expected)
})

test('纠正名额整租约共享：R1已用补交后，R2语义拒绝直接收错；调用其他工具从不纠正',async t=>{
 const f=await runtime(t,[text('草稿：1 家已付款（口述）。'),text('先说明再提交。'),revise(),call(deliveryReviewToolName,{phase:'verify',verdict:'accept',checks:checks.slice(1),changeChecks:[],findings:[]}),verify()])
 await f.send()
 assert.equal(f.adapter.requests.length,4,'不再给第二次纠正')
 assert.deepEqual(ends(f.events()),['error'])
 assert.equal(f.traces.at(-1)!.reason,'rewrite-r2-plan:checks')
 assert.equal(f.result(),undefined)
 const other=await runtime(t,[text('草稿：1 家已付款（口述）。'),call('teloa_capabilities',{}),revise(),verify()])
 await other.send()
 assert.equal(other.adapter.requests.length,2,'调用其他工具不是可纠正的回执失败')
 assert.equal(other.traces.at(-1)!.reason,'rewrite-plan:step-tool-error')
})

test('数组字段被写成字符串化 JSON：保留原生 schema 错误并指出字段与正确形态，唯一纠参后正常交付',async t=>{
 const f=await runtime(t,[text('草稿：1 家已付款（口述）。'),call(deliveryReviewToolName,{phase:'revise',issues:'[]'}),revise(),verify()])
 await f.send()
 assert.deepEqual(ends(f.events()),['completed'])
 const failed=errors(f.events())
 assert.equal(failed.length,1)
 assert.match(failed[0]!,/invalid arguments:/,'原生严格错误仍在')
 assert.match(failed[0]!,/issues 被写成了字符串化的 JSON/,'指出被字符串化的字段')
 assert.equal(f.result(),'草稿：1 家已付款（口述）。')
 assert.equal(f.result(clone(f.events())),'草稿：1 家已付款（口述）。')
})

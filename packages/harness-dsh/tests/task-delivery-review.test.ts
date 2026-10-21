import test,{type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {Context} from '@deepseek-ai/cordis'
import {AgentRegistry,type Agent} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {LlmAdapter,LlmRuntime,createUserMessage,createAssistantMessage,createDeveloperMessage,createToolResultMessage,type GenerateOptions,type StreamChunk,type UserMessage} from '@deepseek-ai/dsh-llm'
import {SessionId,SessionStore,type SessionEvent} from '@deepseek-ai/dsh-session'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {ToolRuntime,defineTool} from '@deepseek-ai/dsh-tools'
import type {TaskExecutionScope,TaskRun} from '@teloa/backend'
import {createReviewSourceCatalog,reviewSourceDirectory,readRevisionSubmission,applyDeliveryPlan,deliveryReviewPrompt,deliveryReviewSource,deliveryReviewText,deliveryReviewToolName,draftSha256,leaseTaskDeliveryReview,readDeliveryDraft,reviewBlockTag,reviewInputSources,splitReviewBlocks,type DeliveryReviewTrace,type DeliveryReviewLease,type ReviewMaterial} from '../src/task-delivery-review.ts'
import {readRunKnowledge} from '@teloa/backend'
import {planContextNotice} from '../../backend/src/work/task-run-plan-context.ts'
import {groupContinuationNotice} from '../../backend/src/work/task-runs.ts'
import {dshTaskRunPorts,leaseTaskRunMethods,taskRunReviewMaterial,taskSkillUsageNotice,ownerReviewDeclarations} from '../src/task-run-dsh.ts'
import {readTaskRunGroupResult} from '../src/task-run-group-result.ts'
import {readSessionEvents} from '../src/session-events.ts'

type Reply=readonly StreamChunk[]|Error
const receiptArgs=(value:unknown):Record<string,unknown>=>{assert.ok(value!==null&&typeof value==='object'&&!Array.isArray(value));return value as Record<string,unknown>}
/** 活动回执显式区分成组修订与只读验收；正文摘要由宿主自持。 */
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
let callSerial=0
/** 模型以原生工具调用提交复核计划（可带推理块）；与真实回复一样以 tool-calls 收尾。 */
const submit=(args:Submission,reasoning?:string):Reply=>{
 const id='review-call-'+(++callSerial),offset=reasoning?1:0
 return [...(reasoning?[{type:'block-start',index:0,blockType:'reasoning'},{type:'reasoning-delta',index:0,text:reasoning},{type:'block-end',index:0,block:{type:'reasoning',text:reasoning}}]:[]),{type:'block-start',index:offset,blockType:'tool-call'},{type:'block-end',index:offset,block:{type:'tool-call',id,name:deliveryReviewToolName,arguments:args}},{type:'finish',reason:{kind:'tool-calls'}}] as unknown as Reply
}
/** 纯文本回复；传入回执参数时改为原生回执调用，截断时则只留被截断的文字（没有完整调用）。 */
const text=(value:string|Submission,reason:'stop'|'max-tokens'='stop'):Reply=>typeof value!=='string'?(reason==='stop'?submit(value):text('（复核回执写到一半）',reason)):[{type:'block-start',index:0,blockType:'text'},{type:'text-delta',index:0,text:value},{type:'block-end',index:0,block:{type:'text',text:value}},{type:'finish',reason:{kind:reason}}]
const call=(name:string,id='call-1'):Reply=>[{type:'block-start',index:0,blockType:'tool-call'},{type:'block-end',index:0,block:{type:'tool-call',id,name,arguments:{}}},{type:'finish',reason:{kind:'tool-calls'}}] as unknown as Reply

/** 按次序回放的模型：每次请求留下完整 options，供核对上下文、工具与次数。 */
class ScriptAdapter extends LlmAdapter{
 requests:GenerateOptions[]=[]
 readonly replies:Reply[]
 constructor(replies:Reply[]){super();this.replies=replies}
 override async resolveModel(provider:string,model:string){return {provider,id:model,name:model,inputModalities:['text'] as const}}
 async *stream(options:GenerateOptions):AsyncGenerator<StreamChunk>{
  this.requests.push(options)
  const reply=this.replies.shift()??text('多余请求')
  if(reply instanceof Error)throw reply
  for(const chunk of reply)yield chunk
 }
}

const material='资料：12 家试用店，8 家说有用，3 家说愿意付费，1 家已付款（创始人口述）。下月是否续费未知。'
const grading='---\nname: grading\n---\nGrade founder-supplied Evidence as first-party claimed behavior unless independently corroborated.'
const gradingSha=createHash('sha256').update(grading).digest('hex')
const reviewMaterial:ReviewMaterial={goal:material,inputs:{knowledge:0,group:false,context:false},methods:[{name:'grading',sha256:gradingSha}],catalog:createReviewSourceCatalog([{id:'goal',kind:'goal',title:'原目标',text:material,origin:{field:'inputText',pointer:'/task/goal'}},{id:'method:1',kind:'method',title:'grading',text:grading,origin:{field:'skills',pointer:'/0/content'}}])}
const revise=(edits:Edit[]=[],blockCount=1):Revision=>({phase:'revise',issues:edits.length?[{problem:'结论应按原资料核对。',basis:[passageBasis(reviewMaterial.catalog,'goal',material)],affectedBlockIds:[...new Set(edits.map(edit=>edit.blockId))],coverage:coverageFor(blockCount,edits.map(edit=>edit.blockId)),edits}]:[]})
async function runtime(t:TestContext,replies:Reply[],publish?:(agent:Agent,message:UserMessage,signal:AbortSignal)=>Promise<void>,reviewOptions:Partial<Pick<DeliveryReviewLease,'requireReview'|'readExecution'>>={}){
 const ctx=new Context();t.after(()=>ctx.fiber.dispose())
 for(const plugin of [LlmRuntime,SessionStore,SessionProjectionRegistry,SystemPrompt,ToolRuntime,AgentRegistry])await ctx.plugin(plugin)
 await ctx.plugin(AgentLoop,{agents:[]})
 const adapter=new ScriptAdapter(replies);ctx.llm.registerAdapter(['script'],adapter)
 let executed=0
 ctx.tools.register(defineTool({name:'teloa_capabilities',description:'测试工具',parameters:{},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async()=>{executed++;return 'fixture'}}))
 ctx.tools.register(defineTool({name:'teloa_group_mention',description:'测试原生提醒声明',parameters:{},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async()=>JSON.stringify({mentionSelf:true})}))
 const create=()=>ctx.agents.create({sessionId:SessionId('review-'+t.name),agentOptions:{provider:'script',model:'model'}})
 const {agent}=await create()
 const traces:DeliveryReviewTrace[]=[]
 const release=leaseTaskDeliveryReview(agent,{runId:'run',requestId:'rpc',material:reviewMaterial,...reviewOptions,trace:entry=>{traces.push(entry)},publish:publish?(message,signal)=>publish(agent,message,signal):async message=>{agent.inject(message)}})
 const send=async(rpcId='rpc')=>{agent.followup(createUserMessage({source:{kind:'user',rpcId},content:[{type:'text',text:material}]}));await agent.whenIdle()}
 return {agent,adapter,traces,release,send,executed:()=>executed,events:()=>readSessionEvents(agent.session) as readonly SessionEvent[]}
}
const hostMessages=(events:readonly SessionEvent[])=>events.filter((event):event is Extract<SessionEvent,{type:'user/message'}>=>event.type==='user/message'&&event.data.source.kind===deliveryReviewSource)
const reviews=(events:readonly SessionEvent[])=>hostMessages(events).filter(event=>event.type==='user/message'&&event.surfaceOp==='append')

test('本人自然语言质检要求形成提醒义务，否定与引用示例不形成义务',()=>{
 for(const goal of ['最后交给@Max质检。','完成后提醒我核对成果。','交给我复核。','不要修改原始数据，完成后提醒我核对成果。','不得处置；最后交给 @Max 质检。'])assert.deepEqual(ownerReviewDeclarations(goal,['Max']),['owner-mention'])
 for(const goal of ['不要@Max质检。','不要提醒我。','示例：最后交给@Max质检。','> 最后交给@Max质检。','不要调用 teloa_group_mention target=self。','请@调查员独立复核。'])assert.equal(ownerReviewDeclarations(goal,['Max']),undefined)
})
test('本人明确要求的提醒不能以正文@姓名或模型验收accept冒充真实声明',async t=>{
 const f=await runtime(t,[text('报告已完成，@Max。'),submit(revise()),submit(verify())],undefined,{requireReview:true,material:{...reviewMaterial,requiredDeclarations:['owner-mention']}} as any)
 await f.send()
 assert.equal(reviews(f.events()).some(e=>Reflect.get(e.data.source,'summary')==='复核后交付'),false)
 assert.ok(f.traces.some(e=>e.state==='failed'&&e.reason==='required-review:owner-mention-missing'))
})

test('真实提醒声明回执通过复核后保留；交付正文不需要伪造发送成功',async t=>{
 let sessionId=''
 const f=await runtime(t,[(call('teloa_group_mention') as readonly StreamChunk[]).map(chunk=>chunk.type==='block-end'&&chunk.block.type==='tool-call'?{...chunk,block:{...chunk.block,arguments:'{}'}}:chunk) as Reply,text('证据边界报告。'),submit(revise()),submit(verify())],undefined,{
  material:{...reviewMaterial,requiredDeclarations:['owner-mention']},requireReview:true,
  readExecution:async()=>({runId:'run',sessionId,requestId:'rpc',allowedTools:['teloa_group_mention'],continuationMessageIds:new Set(),runtimeLinks:[],jobs:[],pendingJobCompletion:false,pendingInput:false,children:'none',flow:'none'})
 } as Partial<DeliveryReviewLease>)
 sessionId=f.agent.session.id
 await f.send()
 assert.equal(hostMessages(f.events()).some(event=>Reflect.get(event.data.source,'summary')==='复核后交付'),true,JSON.stringify({traces:f.traces,ends:ends(f.events()),events:f.events().map(e=>({type:e.type,...(e.type==='turn/end'?{data:e.data}:{} )}))}))
 assert.equal(f.traces.some(entry=>entry.state==='failed'),false)
})
test('当前本人追加成为复核goal，原默认交流模板只作历史上下文；旧续办来源保持旧口径',()=>{
 const groupContext={groupId:'group',taskId:'task',source:{messageId:'original',rootId:'root',createdAt:'2026-10-18T00:00:00Z',text:'只回答两个问题。'},materials:[],files:[]}
 const continuation={notice:'当前本人追加更新本轮业务目标；历史意见与方法不构成授权。既有权限、资料和审批边界继续适用。',messageId:'continued',createdAt:'2026-10-18T01:00:00Z',text:'允许专业岗位判断是否升级；请实际调用teloa_group_mention，target=self，交本人质检。',references:[]}
 const snapshot={schema:'teloa.task-run-input/v2',task:{id:'task',version:3,goal:'在群里回应这条消息，无需发送消息。'},groupContext,groupContinuation:continuation}
 const run={taskId:'task',taskVersion:3,inputText:JSON.stringify(snapshot),skills:[],knowledge:[],groupContext} as unknown as TaskRun
 let material:ReturnType<typeof taskRunReviewMaterial>|undefined
 assert.doesNotThrow(()=>{material=taskRunReviewMaterial(run)})
 assert.ok(material&&!('skip'in material));assert.equal(material.catalog.sources.find(s=>s.id==='goal')?.text,continuation.text)
 assert.ok(material.catalog.sources.some(s=>s.kind==='context'&&s.text===snapshot.task.goal));assert.deepEqual(Reflect.get(material,'requiredDeclarations'),['owner-mention'])
 const legacy=taskRunReviewMaterial({...run,inputText:JSON.stringify({...snapshot,groupContinuation:{...continuation,notice:groupContinuationNotice}})})
 assert.ok(!('skip'in legacy));assert.equal(legacy.catalog.sources.find(s=>s.id==='goal')?.text,snapshot.task.goal)
})
const draftData=(events:readonly SessionEvent[])=>hostMessages(events).filter(event=>event.type==='user/message'&&event.surfaceOp!=='append')
const ends=(events:readonly SessionEvent[])=>events.flatMap(event=>event.type==='turn/end'?[event.data.reason.kind]:[])
const requestText=(options:GenerateOptions)=>JSON.stringify(options.messages)
const thought=(reasoning:string,value:string|Submission):Reply=>typeof value!=='string'?submit(value,reasoning):[{type:'block-start',index:0,blockType:'reasoning'},{type:'reasoning-delta',index:0,text:reasoning},{type:'block-end',index:0,block:{type:'reasoning',text:reasoning}},{type:'block-start',index:1,blockType:'text'},{type:'text-delta',index:1,text:value},{type:'block-end',index:1,block:{type:'text',text:value}},{type:'finish',reason:{kind:'stop'}}]
const textOf=(message:GenerateOptions['messages'][number])=>message.content.flatMap(block=>block.type==='text'?[block.text]:[]).join('\n')
const hostedOf=(request:GenerateOptions)=>request.messages.filter(message=>message.role==='user'&&message.source?.kind===deliveryReviewSource)
/** 旧「原文 → 改为」锚点计划（legacy 解析辅助的测试用）：首行草稿摘要，之后每处一组；无编辑时写「无需修改」。 */
const anchorPlanOf=(draft:string,edits:readonly (readonly [string,string])[])=>'草稿 SHA-256：'+draftSha256(draft)+'\n'+(edits.length?edits.map(([before,after])=>'<<<原文>>>\n'+before+'\n<<<改为>>>\n'+(after?after+'\n':'')+'<<<结束>>>').join('\n'):'无需修改')
/**
 * 按宿主契约写结构化回执参数：把「原文片段 → 改为」落到包含它的宿主块上，整块写出修改后的内容（同块多处合并为一项）；
 * 片段不在任何单个块内时写一个不存在的编号，模拟模型引用了宿主没有标注的块。无编辑时 edits 为空数组。
 */
const planOf=(snapshot:string,edits:readonly (readonly [string,string])[]):Submission=>{
 const blocks=splitReviewBlocks(snapshot),groups=new Map<number,string>()
 for(const [before,after] of edits){
  const at=snapshot.indexOf(before),position=at<0?-1:blocks.findIndex(block=>at>=block.start&&at+before.length<=block.end)
  if(position<0){groups.set(blocks.length,'x');continue}
  groups.set(position,(groups.get(position)??snapshot.slice(blocks[position]!.start,blocks[position]!.end)).replace(before,after))
 }
 return revise([...groups].map(([position,after])=>({blockId:position+1,after})),blocks.length)
}
/** 与宿主同一划分写出的单单元复核提示，用于逐字核对发布的复核要求。 */
const promptOf=(material:ReviewMaterial,snapshot:string,phase:'revise'|'verify'='revise',issueIds:readonly string[]=[])=>deliveryReviewPrompt(material,{index:0,total:1,blockCount:splitReviewBlocks(snapshot).length,tag:reviewBlockTag(snapshot),blocks:splitReviewBlocks(snapshot).map((block,position)=>({id:position+1,text:snapshot.slice(block.start,block.end)}))},phase,issueIds)+(phase==='verify'?'\n宿主当前依赖块核对表：'+JSON.stringify(issueIds.map(issueId=>({issueId,blockIds:[1]}))):'')
const oldRoundFields=(value:unknown)=>(value as {round:number;inputSha256:string;outputSha256:string;edits:number;units:Record<string,unknown>[]}[]).map(({round,inputSha256,outputSha256,edits,units})=>({round,inputSha256,outputSha256,edits,units:units.map(({unit,start,end,planMessageId,callId,edits,duplicates,unchanged})=>({unit,start,end,planMessageId,...callId?{callId}:{},edits,...duplicates?{duplicates}:{},...unchanged?{unchanged}:{}}))}))
const oldTraceFields=({reviewPhase:_reviewPhase,protocol:_protocol,verdict:_verdict,sourceCatalogSha256:_catalog,...entry}:DeliveryReviewTrace)=>entry
const applied=(events:readonly SessionEvent[])=>hostMessages(events).filter(event=>event.type==='user/message'&&event.surfaceOp==='append'&&Reflect.get(event.data.source,'summary')==='复核后交付')
const withMethod=(t:TestContext,agent:Parameters<typeof leaseTaskRunMethods>[0])=>t.after(leaseTaskRunMethods(agent,[{...skill,name:'grading',content:grading,sha256:gradingSha}]))

test('R1 每个问题独立覆盖全稿；不能以多个问题合并 coverage 替代逐项完整声明',()=>{
 const first=revise([{blockId:1,after:'段甲已核对。'}],3).issues[0]!,second=revise([{blockId:3,after:'段丙已核对。'}],3).issues[0]!
 const context={catalog:reviewMaterial.catalog,blockCount:3,unit:{first:0,last:2},unitIndex:0}
 const incomplete={phase:'revise',issues:[{...first,coverage:{...first.coverage,unrelated:[]}},{...second,coverage:{...second.coverage,unrelated:[2]}}]}
 assert.deepEqual(readRevisionSubmission(incomplete,context),{reason:'coverage'},'各问题合并后虽含1/2/3，每个问题仍必须独立声明全稿')
 const complete=readRevisionSubmission({phase:'revise',issues:[first,second]},context)
 assert.ok(!('reason' in complete))
 assert.deepEqual(complete.issues.map(issue=>issue.coverage),[coverageFor(3,[1]),coverageFor(3,[3])])
})

test('实际复核请求逐项声明全稿 coverage，工具投影提供明确数组类型及完整问题形状',async t=>{
 const draft='段甲。\n\n段乙。\n\n段丙。',first=revise([{blockId:1,after:'段甲已核对。'}],3).issues[0]!,second=revise([{blockId:3,after:'段丙已核对。'}],3).issues[0]!
 const f=await runtime(t,[text(draft),submit({phase:'revise',issues:[first,second]}),submit(verify(['r1:u1:i1','r1:u1:i2'],[[1],[3]]))])
 await f.send()
 assert.equal(f.adapter.requests.length,3)
 assert.equal(readTaskRunGroupResult(f.events(),'rpc'),'段甲已核对。\n\n段乙。\n\n段丙已核对。')
 const request=f.adapter.requests[1]!,prompt=textOf(hostedOf(request).at(-1)!),tool=request.tools?.find(tool=>tool.name===deliveryReviewToolName)
 assert.ok(tool)
 assert.match(prompt,/每一个 issues\[i\]\.coverage 都必须各自覆盖整稿块编号 1\.\.N/)
 assert.match(prompt,/不能只列 affectedBlockIds，也不能由多个问题合并覆盖全稿/)
 assert.ok(prompt.includes('{change:[2],retain:[],unrelated:[1,3],unknown:[]}'))
 const schema=JSON.stringify(tool)
 assert.match(schema,/每个问题独立划分整稿的全部块编号/)
 assert.match(schema,/四个字段都是必填整数数组，无项写 \[\]/)
 assert.ok(prompt.includes('"affectedScope":"coverage","coverage":{"change":[1],"retain":[],"unrelated":[],"unknown":[],"unlisted":"retain"},"edits":'),'实际提示包含问题内字段与显式未列归属的完整JSON形状')
 assert.match(tool.description??'',/每个问题各自提交覆盖全稿的 coverage，不能跨问题合并/)
})

test('升级后旧单步复核的完整交付仍可读取：不回退草稿、不接受截断或后续轮次',async t=>{
 for(const [label,reply,expected] of [
  ['完整',text('旧版完整交付'),'旧版完整交付'],
  ['截断',text('旧版截断', 'max-tokens'),undefined],
  ['空正文',text(''),undefined],
 ] as const)await t.test(label,async sub=>{
  const f=await runtime(sub,[text('未经复核的旧草稿'),reply,text('下一轮')])
  f.release()
  let published=false
  const release=f.agent.ctx.on('agent/turn-stopping',async()=>{
   if(published)return
   published=true
   const draft=f.events().find(event=>event.type==='assistant/message')
   assert.ok(draft?.type==='assistant/message')
   f.agent.inject(createUserMessage({source:{kind:deliveryReviewSource,form:'notice',summary:'交付前复核',runId:'legacy-run',draftMessageId:draft.data.message.id},content:[{type:'text',text:'旧版单步复核要求'}]}))
  })
  sub.after(release)
  await f.send()
  assert.equal(readTaskRunGroupResult(f.events(),'rpc'),expected)
  assert.notEqual(readTaskRunGroupResult(f.events(),'rpc'),'未经复核的旧草稿')
  await f.send('later-rpc')
  assert.equal(readTaskRunGroupResult(f.events(),'rpc'),expected,'下一轮不能覆盖原结果')
 })
})

test('已保存的三步旧会话：发布过盲核对但未进入改写时没有可交付正文，不回退草稿或台账',async t=>{
 const f=await runtime(t,[text('未经复核的旧草稿'),text('{"facts":[]}'),text('下一轮')])
 f.release()
 let published=false
 const release=f.agent.ctx.on('agent/turn-stopping',async()=>{
  if(published)return
  published=true
  const draft=f.events().find(event=>event.type==='assistant/message')
  assert.ok(draft?.type==='assistant/message')
  f.agent.inject(createUserMessage({source:{kind:deliveryReviewSource,form:'notice',summary:'交付前核对',runId:'legacy-run',draftMessageId:draft.data.message.id},content:[{type:'text',text:'旧版核对要求'}]}))
 })
 t.after(release)
 await f.send()
 assert.equal(readTaskRunGroupResult(f.events(),'rpc'),undefined)
})

test('有界复核：第 1 轮编辑计划有修改时，宿主应用后对修改后的整稿进入独立验收阶段（重新绑定当前正文与摘要），第 2 轮显式验收通过才交付；共 3 次调用，原生事件不改写、不伪造助手消息',async t=>{
 const draftText='草稿：口述付款记为最高级。\n说明：未改动。'
 const plan=planOf(draftText,[['口述付款记为最高级','口述付款按方法定义有条件分级'],['说明：未改动。','说明：分级改为有条件。']])
 const finalText='草稿：口述付款按方法定义有条件分级。\n说明：分级改为有条件。'
 const f=await runtime(t,[thought('草稿推理：口述付款直接给最高级。',draftText),thought('复核推理：逐项对照原资料。',plan),thought('第 2 轮复核推理。',verify(['r1:u1:i1'])),text('下一轮回复')])
 withMethod(t,f.agent)
 await f.send()
 assert.equal(f.adapter.requests.length,3,'草稿、第 1 轮复核、第 2 轮复核各一次同模型请求')
 const [first,review,second]=f.adapter.requests as [GenerateOptions,GenerateOptions,GenerateOptions]
 for(const request of [review,second]){
  const prompt=hostedOf(request).find(message=>message.source?.kind===deliveryReviewSource&&Reflect.get(message.source,'summary')==='交付编辑计划')
  assert.ok(prompt)
  assert.doesNotMatch(textOf(prompt),/修改上方草稿并作为本次最终交付/,'实际复核请求不能把成功提交计划承诺为无条件交付')
  assert.ok(textOf(prompt).includes(request===review?'revise':'verify'),'两轮分别声明成组修订和验收，成功回执不等于交付')
 }
 assert.equal(second.provider,first.provider);assert.deepEqual(second.tools?.map(tool=>tool.name),[deliveryReviewToolName],'第 2 轮复核同样只提供结构化回执工具')
 assert.ok(!(first.tools??[]).some(tool=>tool.name===deliveryReviewToolName),'草稿步不提供回执工具')
 const secondHosted=hostedOf(second)
 assert.ok(secondHosted.some(message=>textOf(message).startsWith('验收输入投影 current-draft/v1（第 2 轮')&&textOf(message).includes('<<<草稿开始>>>\n'+finalText+'\n<<<草稿结束>>>')),'第 2 轮进入时草稿数据节点换成修改后的完整快照，两份正文不并列')
 assert.ok(!requestText(second).includes(JSON.stringify('<<<草稿开始>>>\n'+draftText).slice(1,-1)),'第 2 轮模型视图中不再有旧草稿的数据块')
 assert.equal(second.messages.some(message=>message.role==='assistant'||message.role==='tool'),false,'R2 provider 请求不能带自己的 R1 编辑计划或回执')
 assert.equal(secondHosted.length,2,'R2 只有当前完整正文与当前复核要求，不并列旧要求')
 assert.ok(!JSON.stringify(second).includes('复核推理：逐项对照原资料。')&&!JSON.stringify(second).includes('宿主已接收第 1 轮'),'请求相关字段不残留前轮自评与成功 ACK')
 assert.equal(textOf(secondHosted.at(-1)!),promptOf(reviewMaterial,finalText,'verify',['r1:u1:i1']),'第 2 轮复核要求按修改后整稿重新标注块，不给模型待抄的摘要（摘要由宿主自持）')
 assert.equal(review.provider,first.provider);assert.equal(review.model,first.model);assert.deepEqual(review.tools?.map(tool=>tool.name),[deliveryReviewToolName],'复核步只提供结构化回执工具')
 assert.equal(review.messages.some(message=>message.role==='assistant'),false,'草稿不以助手身份进入')
 assert.ok(!requestText(review).includes('草稿推理'),'不重放草稿推理')
 assert.ok(requestText(review).includes(material),'本次原始任务资料原样保留')
 assert.ok(review.messages.some(message=>message.role==='system'&&textOf(message).includes(grading)),'选中方法全文逐字保留')
 const hosted=hostedOf(review)
 assert.equal(hosted.length,2,'复核步：草稿数据、复核要求')
 assert.ok(textOf(hosted[0]!).includes('待校正草稿')&&textOf(hosted[0]!).includes(draftText)&&textOf(hosted[0]!).includes('未经复核'),'草稿正文作为明确未确认的数据')
 assert.equal(textOf(hosted[1]!),promptOf(reviewMaterial,draftText),'复核要求（附冻结原目标与方法身份，不附待抄摘要）在最后')
 const events=f.events(),[draft,reviewed,confirmed]=events.filter(event=>event.type==='assistant/message')
 assert.ok(draft?.type==='assistant/message'&&draft.data.message.content.some(block=>block.type==='reasoning'&&block.text.includes('草稿推理')),'持久历史中的草稿与推理原样保留')
 assert.ok(reviewed?.type==='assistant/message'&&reviewed.data.message.content.some(block=>block.type==='reasoning'&&block.text.includes('复核推理'))&&reviewed.data.message.content.some(block=>block.type==='tool-call'&&block.name===deliveryReviewToolName&&JSON.stringify(block.arguments)===JSON.stringify(plan)),'真实编辑计划作为原生工具调用原样留在模型回复，不被改写')
 // 原生回执真实落盘：每轮一条 tool/call 与一条成功的 tool/result，结果引用调用事件。
 const calls=events.filter(event=>event.type==='tool/call'),results=events.filter(event=>event.type==='tool/result')
 assert.deepEqual(calls.map(event=>event.type==='tool/call'?event.data.name:''),[deliveryReviewToolName,deliveryReviewToolName])
 assert.ok(results.length===2&&results.every((event,index)=>event.type==='tool/result'&&event.data.message.isError===false&&JSON.stringify(event.sourceEventSeqs)===JSON.stringify([calls[index]!.seq])),'回执结果成功并引用各自的调用事件')
 const data=draftData(events)
 assert.equal(data.length,2,'两次官方 surface 替换：草稿→草稿数据，第 1 轮草稿数据→第 2 轮完整快照')
 assert.ok(data[1]?.type==='user/message'&&typeof data[1].surfaceOp==='object'&&data[1].surfaceOp.startSeq===data[0]!.seq&&data[1].surfaceOp.endSeq===results[0]!.seq,'R2 替换边界是原草稿数据节点到 R1 最后成功回执')
 for(const seq of [data[0]!.seq,reviewed!.seq,results[0]!.seq])assert.ok(data[1].sourceEventSeqs?.includes(seq),'持久来源包含完整被 shadow 节点')
 const node=data[0]
 assert.ok(node?.type==='user/message'&&typeof node.surfaceOp==='object'&&node.surfaceOp.startSeq===draft!.seq&&node.surfaceOp.endSeq===draft!.seq&&JSON.stringify(node.sourceEventSeqs)===JSON.stringify([draft!.seq]),'草稿数据替换草稿节点并引用原草稿事件')
 const [delivery]=applied(events)
 assert.ok(delivery?.type==='user/message'&&reviewed?.type==='assistant/message','宿主以插件来源追加一条「复核后交付」，不伪造助手消息')
 assert.equal(textOf(delivery.data as never),finalText,'交付是宿主对冻结草稿原子应用编辑后的正文')
 assert.ok(confirmed?.type==='assistant/message')
 assert.deepEqual(delivery.sourceEventSeqs,[draft!.seq,...results.map(event=>event.seq)],'来源指向原草稿与两轮真实回执结果')
 const callIds=calls.map(event=>event.type==='tool/call'?event.data.callId:'')
 assert.deepEqual({plan:Reflect.get(delivery.data.source,'planMessageId'),draft:Reflect.get(delivery.data.source,'draftSha256'),delivery:Reflect.get(delivery.data.source,'deliverySha256'),edits:Reflect.get(delivery.data.source,'edits')},{plan:confirmed.data.message.id,draft:draftSha256(draftText),delivery:draftSha256(finalText),edits:1})
 // 草稿两行同属一个宿主块：两处修改是同一块的一组整块替换，实际修改数为 1。
 assert.deepEqual(oldRoundFields(Reflect.get(delivery.data.source,'rounds')),[{round:1,inputSha256:draftSha256(draftText),outputSha256:draftSha256(finalText),edits:1,units:[{unit:0,start:0,end:draftText.length,planMessageId:reviewed.data.message.id,callId:callIds[0],edits:1}]},{round:2,inputSha256:draftSha256(finalText),outputSha256:draftSha256(finalText),edits:0,units:[{unit:0,start:0,end:finalText.length,planMessageId:confirmed.data.message.id,callId:callIds[1],edits:0}]}],'逐轮逐单元记录计划、回执调用、范围、输入与输出摘要和编辑数')
 const protocolRounds=Reflect.get(delivery.data.source,'rounds') as {phase:string;verdict:string;units:{phase:string;verdict:string;checks?:{id:string|number;status:string}[];changeChecks?:{issueId:string;status:string}[]}[]}[]
 assert.equal(Reflect.get(delivery.data.source,'protocol'),'revise-verify/v3')
 const resolved=(Reflect.get(protocolRounds[0]!.units[0]!,'issues') as {basis:unknown[]}[])[0]!.basis
 assert.deepEqual(resolved,[{...passageBasis(reviewMaterial.catalog,'goal',material),sourceSha256:draftSha256(material),quote:material}],'活动只提交片段ID，持久依据由宿主从冻结原文解析')
 assert.deepEqual(protocolRounds.map(round=>[round.phase,round.verdict]),[['revise','pending'],['verify','accepted']],'新元数据不把R1工具成功冒作验收')
 assert.deepEqual(protocolRounds[1]!.units[0]!.checks?.map(check=>[check.id,check.status]),(['goal',1,2,3,4,5,6,7,8] as const).map(id=>[id,'pass']))
 assert.deepEqual(protocolRounds[1]!.units[0]!.changeChecks,[{issueId:'r1:u1:i1',status:'verified',reviewedBlockIds:[1]}],'原生验收回执可复原本轮问题的逐项处置')
 assert.ok(events.findIndex(event=>event===delivery)<events.findIndex(event=>event.type==='turn/end'),'在原生 turn/end 之前写入')
 assert.equal(readTaskRunGroupResult(events,'rpc'),finalText,'最终任务结果就是宿主应用后的交付，不是编辑计划或草稿')
 assert.deepEqual(ends(events),['completed'],'仍是原请求的同一轮')
 assert.deepEqual(f.traces.map(entry=>[entry.state,entry.round,entry.unit??null,entry.edits??null]),[['requested',1,0,null],['planned',1,0,1],['applied',1,null,1],['requested',2,0,null],['planned',2,0,0],['delivered',2,null,1]])
 assert.ok(reviews(events).filter(event=>Reflect.get(event.data.source,'summary')==='交付编辑计划').length===2&&reviews(events).every(event=>event.type==='user/message'&&event.data.source.kind===deliveryReviewSource&&draft?.type==='assistant/message'&&event.data.source.draftMessageId===draft.data.message.id),'宿主输入以插件来源记录并指向原草稿')
 await f.send('rpc-2')
 const later=f.adapter.requests.at(-1)!
 // 原计划仍在事件日志，普通追问只沿当前模型视图，不恢复已被隔离的自评计划。
 assert.ok(!later.messages.some(message=>message.role==='assistant'&&textOf(message)===draftText),'后续轮次不把草稿当作助手回复')
 assert.ok(hostedOf(later).some(message=>textOf(message)===finalText),'后续轮次能看到宿主应用后的交付')
 assert.ok(!JSON.stringify(later).includes('复核推理：逐项对照原资料。'),'普通追问不恢复旧 R1 自评推理')
 assert.equal(applied(f.events()).length,1,'后续轮次不再复核或追加交付')
 assert.ok(!(later.tools??[]).some(tool=>tool.name===deliveryReviewToolName),'运行结束后的普通请求不再提供回执工具')
 assert.equal(f.agent.ctx.tools.get(deliveryReviewToolName,f.agent),undefined,'租约释放后回执工具已从本 agent 作用域注销')
})

test('R2 只隔离本租约尾段，不按 assistant/tool 角色删除起草前的普通历史',async t=>{
 const draft='草稿：旧判断。',final='草稿：核对后判断。'
 const f=await runtime(t,[text('原普通历史答复'),text(draft),text(planOf(draft,[['旧判断','核对后判断']])),text(verify(['r1:u1:i1']))])
 withMethod(t,f.agent)
 await f.send('prior-request')
 const prefix=f.agent.session.deriveMessages().filter(message=>message.role!=='system')
 await f.send()
 const r2=f.adapter.requests[3]!
 for(const message of prefix)assert.deepEqual(r2.messages.find(next=>next.id===message.id),message,'原历史身份与完整内容不变')
 assert.ok(r2.messages.some(message=>message.role==='assistant'&&textOf(message)==='原普通历史答复'))
 const reviewCall=f.events().find(event=>event.type==='tool/call');assert.ok(reviewCall?.type==='tool/call')
 assert.ok(!JSON.stringify(r2).includes(reviewCall.data.callId),'只移出本租约的自评调用')
 assert.equal(readTaskRunGroupResult(f.events(),'rpc'),final)
})

test('R2 隔离遇到额外 claim 或非本租约 surface 节点时收错，原输入与真实计划仍留日志且不再发模型请求',async t=>{
 const draft='草稿：旧判断。',revised='草稿：核对后判断。',plan=planOf(draft,[['旧判断','核对后判断']])
 for(const kind of ['claimed-user','claimed-runtime','surface-user','surface-runtime','assistant','result-step','registry'] as const)await t.test(kind,async sub=>{
  let published=0,inserted=false
  const foreign=()=>kind.endsWith('runtime')?createUserMessage({source:{kind:'runtime-context',form:'snapshot',sections:[{name:'foreign-material',text:'不可丢的额外资料'}]},content:[{type:'text',text:'不可丢的额外资料'}]}):createUserMessage({source:{kind:'user',rpcId:'other-request'},content:[{type:'text',text:'不可丢的额外资料'}]})
  const f=await runtime(sub,[text(draft),text(plan),text(verify(['r1:u1:i1'])),text('不得追加')],async(agent,message)=>{
   if(++published===2&&kind.startsWith('claimed-'))agent.inject(foreign())
   agent.inject(message)
  })
  sub.after(f.agent.ctx.on('tools/pre-execute',async(exec,next)=>{
   if(!inserted&&exec.name===deliveryReviewToolName){
    inserted=true
    const events=f.events(),call=[...events].reverse().find(event=>event.type==='tool/call'),assistant=[...events].reverse().find(event=>event.type==='assistant/message')
    assert.ok(call?.type==='tool/call'&&assistant?.type==='assistant/message')
    if(kind.startsWith('surface-'))f.agent.session.append('user/message',foreign(),{surfaceOp:'append'})
    if(kind==='assistant'){
     const {id:_id,role:_role,source:{kind:_kind,...source},...body}=assistant.data.message
     f.agent.session.append('assistant/message',{...assistant.data,message:createAssistantMessage({...body,source})},{surfaceOp:'append'})
    }
    if(kind==='result-step')f.agent.session.append('tool/result',{turn:call.data.turn,step:call.data.step+100,message:createToolResultMessage({callId:call.data.callId,isError:false,content:[{type:'text',text:'不匹配步骤的回执'}]})},{surfaceOp:'append',sourceEventSeqs:[call.seq]})
    if(kind==='registry')f.agent.session.append('developer/message',{turn:call.data.turn,step:call.data.step,message:createDeveloperMessage({source:{kind:'tool-registry'},content:[{type:'text',text:'未经核对的工具声明'}]})},{surfaceOp:'append'})
   }
   return next()
  }))
  await f.send()
  assert.equal(f.adapter.requests.length,2,'R2 准入失败，不把额外资料吞掉后继续请求')
  assert.deepEqual(ends(f.events()),['error']);assert.equal(readTaskRunGroupResult(f.events(),'rpc'),undefined)
  assert.ok(f.events().some(event=>event.type==='tool/call'&&event.data.name===deliveryReviewToolName),'原 R1 计划保留')
  if(kind.startsWith('claimed-'))assert.ok(f.events().some(event=>event.type==='agent/inbox/spliced'&&event.data.inserted.some(message=>textOf(message).includes('不可丢的额外资料'))),'拒绝的额外 claim 仍有原生收件箱历史')
  else assert.ok(f.events().some(event=>event.type==='user/message'&&event.data.source.kind==='user'&&textOf(event.data)===material),'原本人材料仍留日志')
 })
})

test('复核要求：不建台账，依原资料与方法原文逐项核对；未知资格写成开始前核实步骤；按真实工具回执区分资料阅读与助手动作；说明与最终正文一致；不含模板专属规则',()=>{
 assert.match(deliveryReviewText,/只依据本轮任务目标（宿主在下方逐字附上冻结的原目标）、随任务提供的资料和固定工作方法原文（下方列出本轮选中方法的名称与 SHA-256），并按下方宿主给出的「本轮输入来源」逐项核对草稿/)
 assert.match(deliveryReviewText,/草稿中的事实转述、等级、判断、理由与说明都不作为依据/)
 // 活动输出契约在真实 Loop 的 R1/R2 请求与回执中验证，旧 edits-only 提示不再是当前协议。
 assert.doesNotMatch(deliveryReviewText,/结束标签|无需修改」|草稿 SHA-256：/,'不再叠加文本标签协议')
 assert.doesNotMatch(deliveryReviewText,/逐字复制草稿中需要改的连续原文/)
 assert.match(deliveryReviewText,/原工作方法要求的编辑说明等组成必须保留/)
 // R56：复核以草稿为底本时整篇照搬（Writing 逐字相同）、把草稿补出的转述当成事实保留；底本改为原任务，不再有原样输出的出口。
 assert.doesNotMatch(deliveryReviewText,/原样输出/)
 assert.match(deliveryReviewText,/草稿中的事实转述、等级、判断、理由与说明都不作为依据，每一句只有对照原文仍成立时才保留/)
 // 资格、重叠与周期未知：写成开始前的核实步骤，不假定、不写成已完成。
 assert.match(deliveryReviewText,/实验对象的重叠、资格、已有行为或阶段状态未知时，先列验证这些条件的步骤/)
 assert.match(deliveryReviewText,/判据、选择理由与结论相互一致/)
 // R68：Product 理由段假定了未建立的成员归属、阈值区间重叠且有空缺；R57：可发外联草稿沿用了写作风格样例里的业绩数字。
 assert.match(deliveryReviewText,/先按整篇从原材料确定事实、事实之间的关系与未知前提；理由、结论、建议、可发草稿与行动文案用到的关系与未知都须与此一致/)
 assert.match(deliveryReviewText,/按明确顺序排他（先判一档，不满足再判下一档，其余归最后一档），覆盖全部可能结果，并自行枚举最小样本与边界情形核对每种结果恰落入一档/)
 assert.match(deliveryReviewText,/写作风格样例或范文（来自方法或资料）只借语气与结构，其中的数字、案例与成果不作为本人事实写进可直接使用的草稿，需要时写成明确的待填字段或列为内部缺项/)
 // 方法定义与例外：按原文指向适用；前提不确定时写有条件结论，不追加身份假设，也不要本人先选定假设。
 assert.match(deliveryReviewText,/限定或例外只在其原文指向该术语时适用，不扩大到其他方法各自定义的术语，未运行的技能不补做其流程/)
 assert.match(deliveryReviewText,/以资料提供者身份、来源或是否经独立佐证为前提时，按下方「本轮输入来源」判断该前提是否已知：未知时写成有条件的结论/)
 assert.match(deliveryReviewText,/不从方法中的角色设定、称呼或示例推断，也不改写成相反的断言；不要求本人先在几种假设之间选定/)
 // 草稿生成前没有工具事件；之后的内部复核回执不代表访问过资料中的应用。
 assert.match(deliveryReviewText,/原任务生成下列草稿前没有工具调用或执行回执/)
 assert.match(deliveryReviewText,/内部复核回执不代表执行了任何外部动作/)
 assert.doesNotMatch(deliveryReviewText,/本轮没有任何工具调用/)
 assert.match(deliveryReviewText,/不写助手已打开、查看、查询、搜索、读取/)
 assert.match(deliveryReviewText,/摘录是本人随任务提供的文本，引用时写明依据本人提供的摘录，不写成助手访问了该应用/)
 assert.match(deliveryReviewText,/行动日志或执行记录只记录本轮实际发生的动作/)
 assert.match(deliveryReviewText,/方法示例中的动作不代表本轮的能力或授权/)
 assert.match(deliveryReviewText,/转述资料中的事实时只写原文载明的内容，不添加原文没有的方式、渠道、时点或先后等细节/)
 // 说明与正文一致：不能只看「有修改说明」。
 assert.match(deliveryReviewText,/修改说明、自查、摘要、数量声明以及样本范围与口径（如全体对象还是抽样）等描述交付本身的文字，逐条对照最终正文与交付的其他部分/)
 assert.match(deliveryReviewText,/与最终正文不符的说明改正或删除，不保留草稿中已不成立的说明/)
 // 不再要求模型构建闭集 JSON 台账或锚点交叉图。
 assert.doesNotMatch(deliveryReviewText,/(?:facts|definitions|bindings|gates|qualifiers)\s*[:=]\s*[\[{]|锚点/,'不要求模型维护闭集JSON字段；普通英文事实说明不是台账契约')
 assert.doesNotMatch(deliveryReviewText,/最多\s*\d+\s*条|不超过\s*\d+/,'不加任意条目数上限')
 assert.doesNotMatch(deliveryReviewText,/独立核实证据的等级/,'宿主不以转述另定分级语义')
 assert.doesNotMatch(deliveryReviewText,/创始人|咖啡|付款必须|日历|CRM|Slack/i,'不含模板或客户专属规则，通用期限约束仍保留')
})

test('技能是否运行按其原文触发与从属条件决定；只对运行的技能要求完整输出契约；使用某技能自身定义时才引用其限定例外，不覆盖其他方法的定义；自查过程只限最终交付不输出',()=>{
 assert.match(taskSkillUsageNotice,/exact trigger, non-trigger and dependency conditions; this notice activates none/)
 assert.match(taskSkillUsageNotice,/Explain activation only from those original conditions/)
 assert.match(taskSkillUsageNotice,/For active skills, fulfill every output item/)
 assert.doesNotMatch(taskSkillUsageNotice,/fulfill every skill output whether active or not/,'不再无条件激活所有技能的输出契约')
 assert.match(taskSkillUsageNotice,/Do not run inactive workflows/)
 assert.match(taskSkillUsageNotice,/When using method-defined grades, labels or terms, cite the original definitions, qualifiers and exceptions/)
 assert.match(taskSkillUsageNotice,/Apply a qualifier across methods only where its original text explicitly points/,'保留原文明确的跨方法关联')
 assert.match(taskSkillUsageNotice,/state the unresolved prerequisite without inventing a grade/,'指向不确定时不由宿主强制 A 或 B')
 assert.doesNotMatch(taskSkillUsageNotice,/Never apply qualifiers across methods/,'不一律切断跨方法关联')
 assert.match(taskSkillUsageNotice,/Keep this self-check out of the final deliverable/)
 assert.doesNotMatch(taskSkillUsageNotice,/\p{Script=Han}/u)
})

test('复核开始前草稿节点已不在模型视图（如被压缩替换）时拒绝复核，不改用其他内容或另调模型',async t=>{
 const f=await runtime(t,[text('草稿'),text('不应出现')],async(agent,message)=>{
  agent.inject(message)
  const draft=readSessionEvents(agent.session).find(event=>event.type==='assistant/message')!
  agent.session.append('user/message',createUserMessage({source:{kind:'user',rpcId:'compaction-fixture'},content:[{type:'text',text:'摘要'}]}),{surfaceOp:{op:'replace',startSeq:draft.seq,endSeq:draft.seq},sourceEventSeqs:[draft.seq]})
 })
 await f.send()
 assert.equal(f.adapter.requests.length,1,'不再调用模型')
 assert.deepEqual(ends(f.events()),['error'],'如实收为需核对')
 assert.deepEqual(f.traces.map(entry=>[entry.state,entry.phase??null,entry.reason??null]),[['requested','rewrite',null],['failed','rewrite','draft-surface']])
 assert.equal(draftData(f.events()).length,0)
 assert.equal(readTaskRunGroupResult(f.events(),'rpc'),undefined,'不退回草稿冒充结果')
})

test('复核步企图调用工具：不提供、不执行，也不跟随工具循环追加步骤，本轮收为错误且不以草稿冒充结果',async t=>{
 const f=await runtime(t,[text('草稿'),call('teloa_capabilities'),text('不应出现')])
 await f.send()
 assert.ok(f.adapter.requests[0]!.tools?.some(tool=>tool.name==='teloa_capabilities'),'草稿步保持原工具面')
 assert.equal(f.adapter.requests.length,2,'不跟随工具循环');assert.equal(f.executed(),0,'工具体没有执行')
 assert.deepEqual(f.adapter.requests[1]!.tools?.map(tool=>tool.name),[deliveryReviewToolName],'复核请求只提供回执工具')
 assert.deepEqual(ends(f.events()),['error']);assert.equal(readTaskRunGroupResult(f.events(),'rpc'),undefined)
 assert.deepEqual(f.traces.map(entry=>[entry.state,entry.phase,entry.reason??null]),[['requested','rewrite',null],['failed','rewrite','rewrite-plan:step-tool-error']])
 // 复核轮收尾后撤下限制，后续轮次恢复原工具面且不再复核。
 await f.send('rpc-2')
 assert.ok(f.adapter.requests.at(-1)!.tools?.some(tool=>tool.name==='teloa_capabilities'))
 assert.equal(reviews(f.events()).length,1)
})

test('复核因长度截断或空正文未形成完整内容时，本轮如实收为错误，不追加步骤、不以截断稿或草稿冒充结果',async t=>{
 const truncated=await runtime(t,[text('草稿：完整初稿'),text('终稿写到一半','max-tokens'),text('不应出现')])
 await truncated.send()
 assert.equal(truncated.adapter.requests.length,2,'不追加第三步')
 assert.deepEqual(ends(truncated.events()),['error']);assert.equal(readTaskRunGroupResult(truncated.events(),'rpc'),undefined,'截断稿与草稿都不成为交付')
 assert.deepEqual(truncated.traces.map(entry=>[entry.state,entry.phase,entry.reason??null]),[['requested','rewrite',null],['failed','rewrite','rewrite-finish:max-tokens']])
 const empty=await runtime(t,[text('草稿'),text('  ')])
 await empty.send()
 assert.deepEqual(ends(empty.events()),['error']);assert.equal(empty.traces.at(-1)!.reason,'rewrite-plan:missing-submission')
 assert.equal(readTaskRunGroupResult(empty.events(),'rpc'),undefined)
})

test('复核输入发布时取消：保持取消，不再调用模型，也不以草稿冒充结果',async t=>{
 const f=await runtime(t,[text('草稿'),text('不应出现')],async(agent,message)=>{
  if(message.source.kind===deliveryReviewSource&&Reflect.get(message.source,'summary')==='交付编辑计划'){agent.cancel({kind:'hook',reason:'本人停止'});await Promise.resolve();return}
  agent.inject(message)
 })
 await f.send()
 assert.equal(f.adapter.requests.length,1,'取消后不再调用模型')
 assert.deepEqual(ends(f.events()),['aborted'],'取消保持取消')
 assert.equal(readTaskRunGroupResult(f.events(),'rpc'),undefined)
})

test('草稿缺少明确完成回执时不进入复核',async t=>{
 const f=await runtime(t,[text('草稿'),text('修订稿')]);await f.send()
 const events=f.events(),index=events.findIndex(event=>event.type==='assistant/message')
 const incomplete=events.slice(0,index+1).map(event=>event.type==='assistant/message'?{...event,data:{...event.data,stream:event.data.stream.filter(record=>!(record.type==='chunk'&&record.chunk.type==='finish'))}}:event)
 assert.deepEqual(readDeliveryDraft(incomplete,'rpc',1),{skip:'finish:missing'})
})

test('必须复核的群交付不能因工具证据不支持而退回未经复核的正文',async t=>{
 const f=await runtime(t,[call('teloa_capabilities'),text('不应直接交付的工具后正文')],undefined,{requireReview:true})
 await f.send()
 assert.deepEqual(ends(f.events()),['error'],'跳过复核必须收错，不能作为completed回群再触发交接')
 assert.equal(readTaskRunGroupResult(f.events(),'rpc'),undefined)
 assert.ok(f.traces.some(entry=>entry.state==='failed'&&entry.reason==='required-review:tools'))
 let blocked:Awaited<ReturnType<typeof runtime>>
 blocked=await runtime(t,[call('teloa_capabilities'),text('不应绕过授权证据的正文')],undefined,{requireReview:true,readExecution:async()=>({runId:'run',sessionId:blocked.agent.id,requestId:'rpc',allowedTools:[],continuationMessageIds:new Set(),runtimeLinks:[],jobs:[],pendingJobCompletion:false,pendingInput:false,children:'none',flow:'none'})})
 await blocked.send()
 assert.deepEqual(ends(blocked.events()),['error'])
 assert.equal(readTaskRunGroupResult(blocked.events(),'rpc'),undefined)
 assert.ok(blocked.traces.some(entry=>entry.state==='failed'&&entry.reason==='required-review:tool-identity'),'不支持的工具证据也不能降级交付')
})

test('空回复、长度截断、带工具的轮次与他人请求的轮次都不启动复核；复核要求中「本轮没有工具回执」只对无工具轮次成立',async t=>{
 const empty=await runtime(t,[text('   ')]);await empty.send()
 assert.equal(empty.adapter.requests.length,1);assert.equal(reviews(empty.events()).length,0)
 assert.deepEqual(empty.traces,[{runId:'run',state:'skipped',reason:'empty'}])
 const truncated=await runtime(t,[text('写到一半','max-tokens')]);await truncated.send()
 assert.equal(truncated.adapter.requests.length,1);assert.equal(reviews(truncated.events()).length,0)
 assert.deepEqual(truncated.traces.map(entry=>entry.reason),['finish:max-tokens'])
 const tooled=await runtime(t,[call('teloa_capabilities'),text('读完工具后的交付')]);await tooled.send()
 assert.equal(tooled.executed(),1,'正常工具轮照常执行');assert.equal(tooled.adapter.requests.length,2)
 assert.equal(reviews(tooled.events()).length,0,'有工具回执的轮次不进入「没有工具回执」的复核，不覆盖动作状态')
 assert.deepEqual(tooled.traces.map(entry=>entry.reason),['tools'])
 const foreign=await runtime(t,[text('别的请求的回复'),text('本次请求的草稿'),text(planOf('本次请求的草稿',[['本次请求的草稿','本次修订']])),text(verify(['r1:u1:i1']))])
 await foreign.send('other')
 assert.equal(foreign.adapter.requests.length,1);assert.equal(foreign.traces.length,0,'他人轮次不消费复核机会')
 await foreign.send('rpc')
 assert.equal(readTaskRunGroupResult(foreign.events(),'rpc'),'本次修订')
})

test('模型错误与取消不进入复核；复核输入发布失败时本轮如实收为错误而不是假称完成',async t=>{
 const failed=await runtime(t,[new Error('UNKNOWN 传输失败')]);await failed.send()
 assert.deepEqual(ends(failed.events()),['error']);assert.equal(reviews(failed.events()).length,0);assert.equal(failed.traces.length,0)
 const denied=await runtime(t,[text('草稿')],async()=>{throw Object.assign(new Error('预算不足'),{name:'WorkError'})})
 await denied.send()
 assert.deepEqual(ends(denied.events()),['error'],'需核对，不吞掉复核失败')
 assert.equal(denied.adapter.requests.length,1)
 assert.deepEqual(denied.traces.map(entry=>[entry.state,entry.reason]),[['failed','WorkError']])
 assert.equal(hostMessages(denied.events()).length,0,'复核未受理时不改模型视图')
 assert.equal(readTaskRunGroupResult(denied.events(),'rpc'),undefined,'发布失败不泄漏草稿为交付')
 let cancelled!:Awaited<ReturnType<typeof runtime>>
 cancelled=await runtime(t,[text('草稿'),text('不应出现')],async agent=>{agent.cancel({kind:'hook',reason:'本人停止'});await Promise.resolve()})
 await cancelled.send()
 assert.deepEqual(ends(cancelled.events()),['aborted'],'取消保持取消')
 assert.equal(cancelled.adapter.requests.length,1,'取消后不再调用模型')
})

const target:TaskExecutionScope={taskId:'task',taskVersion:3,sessionId:'session',linkVersion:2,scope:'SOC'}
const skill={name:'review',provider:'native',source:'project',description:'核对',content:'正文',sha256:createHash('sha256').update('正文').digest('hex')}
function fakeSend(nativeInput?:{withNewInput:(...args:never[])=>Promise<void>}){
 const listeners=new Map<string,Array<(...args:never[])=>unknown>>(),injected:UserMessage[]=[],appended:Array<{seq:number;data:UserMessage;surfaceOp:unknown;sourceEventSeqs:unknown}>=[]
 let events:SessionEvent[]=[],nodes:number[]=[]
 const registered=new Map<string,unknown>()
 const logs:string[]=[]
 // 官方 surface 替换的最小替身：新节点取代 startSeq 所在位置，返回带 seq 的事件。
 const append=(_type:string,data:UserMessage,opts:{surfaceOp:{startSeq:number};sourceEventSeqs?:number[]})=>{const seq=events.length+appended.length;appended.push({seq,data,surfaceOp:opts.surfaceOp,sourceEventSeqs:opts.sourceEventSeqs});nodes=nodes.map(node=>node===opts.surfaceOp.startSeq?seq:node);return {seq}}
 const agent={id:'session',status:'idle',inbox:{nextTurn:[],nextStep:[]},session:{id:'session',header:{cwd:'/target'},snapshotEvents:()=>events,surface:{get nodes(){return nodes}},append},inject:(message:UserMessage)=>{injected.push(message)},ctx:{tools:{schemas:()=>[],restrict:()=>()=>{},guard:()=>()=>{},register:(definition:{name:string})=>{registered.set(definition.name,definition);return ()=>{registered.delete(definition.name)}},get:(name:string)=>registered.get(name)},on:(name:string,listener:(...args:never[])=>unknown)=>{listeners.set(name,[...listeners.get(name)??[],listener]);return ()=>{}}}}
 const skills={get:async()=>({...skill,invocation:{modelInvocable:true,userInvocable:true}})}
 const ctx={sessionController:{resolveAgent:async()=>({agent}),prompt:async()=>({accepted:true})},agents:{get:()=>agent},sessions:{get:()=>agent.session},agentPresets:{serviceFor:()=>skills},logger:{warn:()=>{},info:(line:string)=>{logs.push(line)}}} as unknown as Context
 const ports=dshTaskRunPorts(ctx,'owner',async()=>({ownerId:'owner',sessionId:'session',status:'ready'}),undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,nativeInput as never)
 const run=(over:Record<string,unknown>={})=>({id:'run',taskId:'task',taskVersion:3,linkVersion:2,sessionId:'session',nativeRequestId:'rpc',inputText:'固定目标',allowedTools:[],...over}) as unknown as TaskRun
 return {ports,run,listeners,injected,appended,logs,setEvents:(next:SessionEvent[],surface:number[])=>{events=next;nodes=surface}}
}
const draftTurn=[
 {type:'turn/start',seq:0,time:0,data:{turn:1}},
 {type:'user/message',seq:1,time:0,surfaceOp:'append',data:{id:'u',role:'user',source:{kind:'user',rpcId:'rpc'},content:[{type:'text',text:'固定目标'}]}},
 {type:'assistant/message',seq:2,time:0,surfaceOp:'append',data:{turn:1,step:1,message:{id:'a',role:'assistant',source:{kind:'model',provider:'p',model:'m'},content:[{type:'text',text:'草稿'}]},stream:[{type:'chunk',time:0,chunk:{type:'finish',reason:{kind:'stop'}}}]}},
] as unknown as SessionEvent[]

test('任务运行只为带固定技能的运行装配复核；有原生输入准入时经原运行身份的 task-run 许可发布',async()=>{
 const plain=fakeSend();await plain.ports.send(plain.run(),new AbortController().signal,target)
 assert.equal(plain.listeners.get('agent/turn-stopping')?.length??0,0,'普通无技能运行不复核')
 const calls:Array<{message:UserMessage;context:{producer:string;identity:string}}>=[]
 const withSkill=fakeSend({withNewInput:(async(_agent:unknown,message:UserMessage,context:{producer:string;identity:string},submit:()=>void)=>{calls.push({message,context});submit()}) as never})
 await withSkill.ports.send(withSkill.run({skills:[skill],roleSnapshot:undefined,inputText:goalSnapshot}),new AbortController().signal,target)
 const [stopping]=withSkill.listeners.get('agent/turn-stopping')??[]
 assert.ok(stopping,'带技能运行装配复核')
 withSkill.setEvents(draftTurn,[1,2])
 await (stopping as (payload:{turn:number;signal:AbortSignal})=>Promise<void>)({turn:1,signal:new AbortController().signal})
 assert.equal(calls.length,1)
 assert.equal(calls[0]!.context.producer,'task-run')
 assert.ok(calls[0]!.context.identity.includes('"rpc"'),'许可上下文绑定原运行与原请求身份')
 assert.equal(calls[0]!.message.source.kind,deliveryReviewSource)
 assert.deepEqual(withSkill.injected,[calls[0]!.message],'许可内只把复核输入放进原 Agent 的 next-step')
})

const goalSnapshot=JSON.stringify({schema:'teloa.task-run-input/v2',task:{id:'task',version:3,goal:'资料：1 家已付款。'}})
test('任务运行把冻结原目标与本次运行的方法身份交给复核，进入时把草稿节点换成未确认草稿数据，同一轮只判定一次；正文写计划仅得一次同轮补交提醒；无合法原目标明确跳过；v2 身份损坏仍是存储损坏',async()=>{
 const f=fakeSend({withNewInput:(async(_agent:unknown,_message:UserMessage,_context:unknown,submit:()=>void)=>{submit()}) as never})
 await f.ports.send(f.run({skills:[skill],roleSnapshot:undefined,inputText:goalSnapshot}),new AbortController().signal,target)
 const [stopping]=f.listeners.get('agent/turn-stopping')??[],[preStep]=f.listeners.get('agent/pre-step')??[]
 assert.ok(stopping&&preStep)
 const stop=stopping as (payload:{turn:number;signal:AbortSignal})=>Promise<void>,enter=preStep as (payload:{step:number;messages:UserMessage[];signal:AbortSignal},next:()=>Promise<unknown>)=>Promise<unknown>
 f.setEvents(draftTurn,[1,2])
 await stop({turn:1,signal:new AbortController().signal})
 assert.equal(f.injected.length,1);assert.equal(Reflect.get(f.injected[0]!.source,'summary'),'交付编辑计划')
 assert.equal(textOf(f.injected[0]!),promptOf(taskRunReviewMaterial(f.run({skills:[skill],inputText:goalSnapshot})) as ReviewMaterial,'草稿'),'复核要求附本轮冻结原目标与本次运行的方法身份')
 await enter({step:2,messages:[f.injected[0]!],signal:new AbortController().signal},async()=>undefined)
 assert.equal(f.appended.length,1);assert.ok(textOf(f.appended[0]!.data).includes('<<<草稿开始>>>\n草稿\n<<<草稿结束>>>'),'复核步看到标注为未确认的草稿正文')
 assert.deepEqual(f.appended[0]!.sourceEventSeqs,[2])
 // 装配层只核对交接与租约；回执工具的接收、两轮推进与交付由真实 AgentLoop 用例覆盖。替身不执行工具，正文里写计划不被接受。
 const reviewEvent={type:'assistant/message',seq:4,time:0,surfaceOp:'append',data:{turn:1,step:2,message:{id:'b',role:'assistant',source:{kind:'model',provider:'p',model:'m'},content:[{type:'text',text:'正文写的计划'}]},stream:[{type:'chunk',time:0,chunk:{type:'finish',reason:{kind:'stop'}}}]}}
 f.setEvents([...draftTurn,reviewEvent] as unknown as SessionEvent[],[1,3,4])
 await stop({turn:1,signal:new AbortController().signal})
 assert.equal(f.injected.length,2);assert.equal(Reflect.get(f.injected[1]!.source,'summary'),'交付复核补交','正文写的计划不被接受；唯一纠正名额用于同一轮的补交提醒，不是新一轮复核输入')
 await enter({step:3,messages:[f.injected[1]!],signal:new AbortController().signal},async()=>undefined)
 assert.equal(f.appended.length,1,'补交提醒不重复替换视图')
 const again={...reviewEvent,seq:5,data:{...reviewEvent.data,step:3,message:{...reviewEvent.data.message,id:'c'}}}
 f.setEvents([...draftTurn,reviewEvent,again] as unknown as SessionEvent[],[1,3,4,5])
 await assert.rejects(stop({turn:1,signal:new AbortController().signal}),/交付复核未形成完整编辑计划/)
 assert.equal(f.appended.length,1,'没有原生回执不追加交付');assert.equal(f.injected.length,2,'名额用尽后仍缺交即收错，不发布第 2 轮')
 const legacy=fakeSend({withNewInput:(async(_agent:unknown,_message:UserMessage,_context:unknown,submit:()=>void)=>{submit()}) as never})
 await legacy.ports.send(legacy.run({skills:[skill],roleSnapshot:undefined,inputText:'固定目标'}),new AbortController().signal,target)
 const legacyStop=(legacy.listeners.get('agent/turn-stopping')??[])[0] as typeof stop
 legacy.setEvents(draftTurn,[1,2]);await legacyStop({turn:1,signal:new AbortController().signal})
 assert.equal(legacy.injected.length,0,'没有可核对原目标的旧合法输入不进入复核，也不从历史猜目标')
 assert.ok(legacy.logs.some(line=>line.includes('"state":"skipped"')&&line.includes('"reason":"no-material"')),'明确记录跳过原因')
 await legacyStop({turn:1,signal:new AbortController().signal})
 assert.equal(legacy.injected.length,0,'同一轮只判定一次')
 const corrupt=fakeSend({withNewInput:(async(_agent:unknown,_message:UserMessage,_context:unknown,submit:()=>void)=>{submit()}) as never})
 await assert.rejects(corrupt.ports.send(corrupt.run({skills:[skill],roleSnapshot:undefined,inputText:JSON.stringify({schema:'teloa.task-run-input/v2',task:{id:'task',version:4,goal:'资料'}})}),new AbortController().signal,target),(error:unknown)=>Reflect.get(error as object,'code')==='teloa/storage-corrupt','v2 身份不一致仍是存储损坏')
})

const imageDraftTurn=[draftTurn[0],{...draftTurn[1],data:{...(draftTurn[1] as {data:object}).data,content:[{type:'text',text:'固定目标'},{type:'image',attachment:{id:'picture'}}]}},draftTurn[2]] as unknown as SessionEvent[]
test('本轮实际带图片进入模型时明确跳过文字复核，沿用原交付；只在材料里列出而未进模型的图片不算可见',async()=>{
 const sent=()=>fakeSend({withNewInput:(async(_agent:unknown,_message:UserMessage,_context:unknown,submit:()=>void)=>{submit()}) as never})
 const visible=sent()
 await visible.ports.send(visible.run({skills:[skill],roleSnapshot:undefined,inputText:goalSnapshot}),new AbortController().signal,target)
 const stopOf=(f:ReturnType<typeof sent>)=>(f.listeners.get('agent/turn-stopping')??[])[0] as (payload:{turn:number;signal:AbortSignal})=>Promise<void>
 visible.setEvents(imageDraftTurn,[1,2]);await stopOf(visible)({turn:1,signal:new AbortController().signal})
 assert.equal(visible.injected.length,0,'可见图片的事实无法逐项文字对照，不进入复核')
 assert.ok(visible.logs.some(line=>line.includes('"state":"skipped"')&&line.includes('"reason":"images"')))
 await stopOf(visible)({turn:1,signal:new AbortController().signal});assert.equal(visible.injected.length,0,'同一轮只判定一次')
 assert.deepEqual(readDeliveryDraft(imageDraftTurn,'rpc',1),{skip:'images'})
 // 没有群图片读口：材料里有图片文件，但本轮模型输入只有文字，照常复核。
 const listed=sent()
 const groupContext={source:{messageId:'m',rootId:'m',createdAt:'2026-10-15T00:00:00.000Z',text:'群消息'},materials:[],files:[{kind:'attachment',id:'g',version:1,sha256:'1'.repeat(64),mime:'image/png',bytes:1,name:'b.png',width:1,height:1}]}
 await listed.ports.send(listed.run({skills:[skill],roleSnapshot:undefined,inputText:goalSnapshot,groupContext}),new AbortController().signal,target)
 listed.setEvents(draftTurn,[1,2]);await stopOf(listed)({turn:1,signal:new AbortController().signal})
 assert.equal(listed.injected.length,1,'未提供给模型的图片不被当作可见')
 assert.equal(Reflect.get(listed.injected[0]!.source,'summary'),'交付编辑计划')
})

test('复核固定输入：原目标只取合法 v2 冻结输入；方法身份来自本次运行选中的同一份正文，原模板名与原生名不同时才附，同显示名不同正文各按自身 SHA-256 列出',()=>{
 const revision='---\nname: Writing revision\ndescription: Draft or revise any kind of writing.\n---\nAvoid em dashes.'
 const twin='---\nname: Writing revision\n---\nOther body.'
 const installed={...skill,name:'writing-bot-writing-revision-b212817e',content:revision,sha256:createHash('sha256').update(revision).digest('hex')}
 const other={...skill,name:'other-bot-writing-revision-0000ffff',content:twin,sha256:createHash('sha256').update(twin).digest('hex')}
 const same={...skill,name:'grading',content:grading,sha256:gradingSha}
 const run={id:'run',taskId:'task',taskVersion:3,inputText:goalSnapshot,skills:[installed,other,same,skill]} as unknown as TaskRun
 const value=taskRunReviewMaterial(run)
 assert.ok(!('skip' in value))
 assert.equal(value.goal,'资料：1 家已付款。','原目标逐字取自冻结输入')
 assert.deepEqual(value.methods,[{name:installed.name,originalName:'Writing revision',sha256:installed.sha256},{name:other.name,originalName:'Writing revision',sha256:other.sha256},{name:'grading',sha256:gradingSha},{name:'review',sha256:skill.sha256}])
 const prompt=promptOf(value,'草稿')
 assert.ok(prompt.startsWith(deliveryReviewText))
 assert.ok(prompt.includes('<<<原目标开始>>>\n资料：1 家已付款。\n<<<原目标结束>>>'),'复核要求逐字附上冻结原目标')
 // 原目标字节相等：含换行、引号、全角符号与尾随空白的原文，复核要求中两标记之间的内容与冻结输入逐字节一致，不重新拼接或截断。
 const rawGoal='任务：\n  8 家说"省时"，3 家愿意付费；\r\n资料末尾有空格  \n'
 const raw=taskRunReviewMaterial({...run,inputText:JSON.stringify({schema:'teloa.task-run-input/v2',task:{id:'task',version:3,goal:rawGoal}})} as TaskRun)
 assert.ok(!('skip' in raw))
 const rendered=promptOf(raw,'草稿'),between=rendered.slice(rendered.indexOf('<<<原目标开始>>>\n')+'<<<原目标开始>>>\n'.length,rendered.indexOf('\n<<<原目标结束>>>'))
 assert.ok(Buffer.from(between,'utf8').equals(Buffer.from(rawGoal,'utf8')),'复核要求中的原目标与冻结输入逐字节相等')
 for(const method of value.methods)assert.ok(prompt.includes(JSON.stringify(method.name))&&prompt.includes('SHA-256 '+method.sha256),method.name)
 assert.ok(prompt.includes('（原模板名 "Writing revision"）'))
 // v2保留原方法身份，增加完整片段ID与有界预览；短来源的预览可以刚好覆盖其全文。
 assert.ok(prompt.includes(reviewSourceDirectory(value.catalog)),'实际复核要求完整接入本轮目录，不省略后部来源或片段ID')
 const bigBody='x'.repeat(200_000),bigMethod={...skill,name:'big',content:bigBody,sha256:createHash('sha256').update(bigBody).digest('hex')}
 const big=taskRunReviewMaterial({...run,skills:[bigMethod]} as unknown as TaskRun);assert.ok(!('skip'in big))
 const bounded=promptOf(big,'草稿')
 assert.ok(big.catalog.passages.filter(passage=>passage.sourceId.startsWith('method:')).length>1,'长方法具有多个真实片段')
 assert.ok(bounded.includes(reviewSourceDirectory(big.catalog))&&!bounded.includes(bigBody)&&bounded.length<bigBody.length,'所有ID可定位，但不把长方法全文再复制进复核要求；不新增正文硬限')
 assert.deepEqual(taskRunReviewMaterial({...run,inputText:'固定目标'} as TaskRun),{skip:'no-material'},'没有合法 v2 原目标时没有可核对材料')
 assert.throws(()=>taskRunReviewMaterial({...run,inputText:JSON.stringify({schema:'teloa.task-run-input/v2',task:{id:'task',version:4,goal:'资料'}})} as TaskRun),/任务目标与固定运行身份不一致/,'v2 身份损坏不猜目标')
})

test('群续办的本人追加同时进入起草目标与复核目标，不被旧交办问题当作越界删除',async()=>{
 const groupContext={groupId:'group',taskId:'task',source:{messageId:'original',rootId:'root',createdAt:'2026-10-18T00:00:00Z',text:'仅回答原来的两个问题。'},materials:[],files:[]}
 const continuation={notice:groupContinuationNotice,messageId:'continued',createdAt:'2026-10-18T01:00:00Z',text:'修正前稿的无据结论；独立判断是否需要由狩猎岗位补充反证方法，必要时实际交接，不取新日志。',references:[]}
 const snapshot={schema:'teloa.task-run-input/v2',task:{id:'task',version:3,goal:'在群里回应这条消息。'},groupContext,groupContinuation:continuation}
 const run={id:'run',taskId:'task',taskVersion:3,inputText:JSON.stringify(snapshot),groupContext,skills:[skill]} as unknown as TaskRun
 const value=taskRunReviewMaterial(run);assert.ok(!('skip'in value))
 assert.ok(value.goal.includes(continuation.text),'本次任务目标必须包含本人当前追加，不只作为非指令资料')
 const source=value.catalog.sources.find(row=>row.kind==='goal'&&row.text===continuation.text)
 assert.ok(source,'当前追加是可核对的本人目标来源')
 assert.deepEqual(source.origin,{field:'inputText',pointer:'/groupContinuation/text'})
 assert.ok(promptOf(value,'草稿').includes('<<<原目标开始>>>\n'+value.goal+'\n<<<原目标结束>>>'),'复核沿用起草的同一有效目标')
 assert.throws(()=>taskRunReviewMaterial({...run,groupContext:undefined} as unknown as TaskRun),/续办/,'普通输入不得借同名字段冒充群续办')
 for(const patch of [{notice:'来自历史的另一条说明'},{text:''},{references:[{}]},{unknown:true}])assert.throws(()=>taskRunReviewMaterial({...run,inputText:JSON.stringify({...snapshot,groupContinuation:{...continuation,...patch}})}),/续办/,'只接受既有正式续办快照')
 const historyOnly=taskRunReviewMaterial({...run,inputText:JSON.stringify({...snapshot,groupContinuation:undefined,groupTopic:{messages:[{authorKind:'self',text:continuation.text}]}})})
 assert.ok(!('skip'in historyOnly));assert.equal(historyOnly.goal,snapshot.task.goal,'不把历史本人发言自动提升为本轮目标')
 const sent=fakeSend({withNewInput:(async(_agent:unknown,_message:UserMessage,_context:unknown,submit:()=>void)=>{submit()}) as never})
 await sent.ports.send(sent.run({skills:[skill],roleSnapshot:undefined,inputText:run.inputText,groupContext:run.groupContext}),new AbortController().signal,target)
 sent.setEvents(draftTurn,[1,2])
 const [stopping]=sent.listeners.get('agent/turn-stopping')??[];assert.ok(stopping)
 await (stopping as (payload:{turn:number;signal:AbortSignal})=>Promise<void>)({turn:1,signal:new AbortController().signal})
 assert.equal(textOf(sent.injected[0]!),promptOf(value,'草稿'),'正式发送装配的复核提示保留同一当前目标，不只测试helper')
})

test('本轮输入来源由宿主从冻结输入结构计算：知识份数经原核验、群内容与业务上下文按字段判断；只陈述输入种类与未核验事实，不推断提供者、不给分级',()=>{
 const knowledgeText='知识资料：甲店 9 月售出 1200 件。'
 const knowledge=readRunKnowledge([{id:'d87222d1-d5a2-4d4b-8860-9b1bfd331ddb',version:1,title:'依据',sourceId:'source',sourceVersion:createHash('sha256').update(knowledgeText).digest('hex'),scopeIds:['general'],text:knowledgeText}])
 const base=JSON.parse(goalSnapshot)
 const run=(over:Record<string,unknown>={},snapshot:object=base)=>({id:'run',taskId:'task',taskVersion:3,inputText:JSON.stringify(snapshot),skills:[skill],...over}) as unknown as TaskRun
 const inputsOf=(value:ReturnType<typeof taskRunReviewMaterial>)=>{assert.ok(!('skip' in value));return value.inputs}
 assert.deepEqual(inputsOf(taskRunReviewMaterial(run())),{knowledge:0,group:false,context:false},'只有原目标')
 assert.deepEqual(inputsOf(taskRunReviewMaterial(run({knowledge}))),{knowledge:1,group:false,context:false})
 assert.throws(()=>taskRunReviewMaterial(run({knowledge:[{...knowledge[0]!,text:'被改过的正文'}]})),/知识资料快照损坏/,'知识资料必须经原核验，不按自述份数')
 const groupContext={source:{messageId:'m',rootId:'m',createdAt:'2026-10-15T00:00:00.000Z',text:'群消息'},materials:[],files:[]}
 assert.equal(inputsOf(taskRunReviewMaterial(run({groupContext}))).group,true,'群任务')
 assert.equal(inputsOf(taskRunReviewMaterial(run({},{...base,groupTopic:{notice:'n',messages:[]}}))).group,true,'冻结群话题')
 for(const key of ['businessContext','industryContext'])assert.equal(inputsOf(taskRunReviewMaterial(run({},{...base,[key]:{notice:'n'}}))).context,true,key)
 const planContext={occurrenceId:'775c9f03-156e-47bc-92ef-e7249523ca92',goal:base.task.goal,dataScope:'general',delivery:'本轮文字交付',notice:planContextNotice}
 assert.equal(inputsOf(taskRunReviewMaterial(run({},{...base,planContext}))).context,true,'planContext：正式executionInput附原notice，goal仍为固定task.goal')
 const only=reviewInputSources({knowledge:0,group:false,context:false}),all=reviewInputSources({knowledge:2,group:true,context:true})
 assert.ok(only.includes('只有本人本轮的任务目标文字，')&&!only.includes('知识资料')&&!only.includes('群消息'),'没有的来源不列出')
 assert.ok(all.includes('知识资料 2 份')&&all.includes('群消息、群资料或文件正文')&&all.includes('业务、计划或行业上下文'))
 for(const value of [only,all]){
  assert.match(value,/宿主没有在本轮额外核验资料的提供者身份、采集渠道、真伪或独立佐证/,'只陈述本轮未额外核验')
  assert.match(value,/不表示资料中没有凭证或核实记载，也不表示资料不实/,'未核验不等于不存在或不实')
  assert.match(value,/资料原文明确记载的凭证、核实情况及其限制，按原文评估；宿主不替资料作真实背书/)
  assert.match(value,/角色设定、对使用者的称呼与示例）只规定做法与定义，不能用来补出本人、资料提供者或佐证情况等前提/,'方法角色不能补出前提')
  // 来源文字只能说宿主本轮没有额外核验，不能断言资料本身没有凭证、佐证或核实记录，也不能断言资料已核实。
  // 唯一允许出现的「没有凭证」是明确的否定说明「不表示资料中没有凭证……」；去掉它后不得再有任何此类断言。
  assert.doesNotMatch(value.replace('不表示资料中没有凭证或核实记载','').replace('也不表示资料不实',''),/(没有|无|不存在)(任何)?(独立佐证|交易凭证|凭证|佐证|核实记录|核实记载)|资料不实|不是已核实的事实|已核实的事实|资料(属实|为真|可信)/,'宿主未额外核验不能写成材料没有凭证、佐证、不实，或替材料背书')
  assert.doesNotMatch(value,/不是\s*founder|不是创始人|Grade|[A-E]\s*级/i,'不把未声明身份改成相反断言，也不给分级答案')
 }
 const prompt=promptOf({goal:'g',inputs:{knowledge:1,group:false,context:false},methods:[],catalog:createReviewSourceCatalog([{id:'goal',kind:'goal',title:'原目标',text:'g',origin:{field:'inputText',pointer:'/task/goal'}}])},'草稿')
 assert.ok(prompt.indexOf(reviewInputSources({knowledge:1,group:false,context:false}))>prompt.indexOf(deliveryReviewText.slice(-20))&&prompt.indexOf('本轮输入来源')<prompt.indexOf('<<<原目标开始>>>'),'来源说明紧随检查项、位于原目标之前')
})

test('草稿轮次里出现过被拒绝或未执行的工具调用尝试时不进入复核，宿主不会对这种轮次声称「本轮没有工具调用」',()=>{
 const attempt={type:'assistant/attempt',seq:2,time:0,data:{turn:1,step:1,stream:[{type:'tool-call-chunks',index:0,chunks:[]}]}}
 const turn=[draftTurn[0],draftTurn[1],attempt,{...draftTurn[2],seq:3}] as unknown as SessionEvent[]
 assert.deepEqual(readDeliveryDraft(turn,'rpc',1),{skip:'tools'})
 assert.deepEqual(readDeliveryDraft([draftTurn[0],draftTurn[1],{...draftTurn[2],seq:3}] as unknown as SessionEvent[],'rpc',1),{draftMessageId:'a',draftSeq:3,draftText:'草稿'},'同样的纯文本轮次没有尝试时照常复核')
})

test('legacy 锚点计划校验（复核租约已不使用，仅保留解析辅助）：摘要必须等于冻结草稿；原文非空、唯一命中、互不重叠；全部通过才一次性应用，任何不合格都不部分应用',()=>{
 const draft='一、已知：8 家说省时。\n二、分级：付款为最高级。\n三、说明：未改动。'
 const ok=applyDeliveryPlan(anchorPlanOf(draft,[['付款为最高级','付款按定义有条件分级'],['三、说明：未改动。','三、说明：分级改为有条件。']]),draft)
 assert.deepEqual(ok,{text:'一、已知：8 家说省时。\n二、分级：付款按定义有条件分级。\n三、说明：分级改为有条件。',edits:2},'按原文位置一次性应用，与计划中的书写顺序无关')
 assert.deepEqual(applyDeliveryPlan(anchorPlanOf(draft,[]),draft),{text:draft,edits:0},'显式无需修改时原样返回冻结草稿')
 assert.deepEqual(applyDeliveryPlan(anchorPlanOf(draft,[['\n三、说明：未改动。','']]),draft),{text:'一、已知：8 家说省时。\n二、分级：付款为最高级。',edits:1},'改为留空即删除')
 assert.deepEqual(applyDeliveryPlan(anchorPlanOf(draft,[['付款为最高级','x']]).replace(/\n/g,'\r\n'),draft),{text:'一、已知：8 家说省时。\n二、分级：x。\n三、说明：未改动。',edits:1},'计划的 CRLF 换行按 LF 读取')
 const reasons:Array<[string,string]>=[
  [anchorPlanOf('别的草稿',[['付款为最高级','x']]),'hash'],
  [anchorPlanOf(draft,[['付款为最高','x']]).replace('草稿 SHA-256：','摘要：'),'shape'],
  ['付款按定义有条件分级','shape'],
  [anchorPlanOf(draft,[['付款为最高级','x']])+'\n以上是我的修改。','shape'],
  [anchorPlanOf(draft,[['8 家说省时','x']]).replace('<<<原文>>>','说明：\n<<<原文>>>'),'shape'],
  [anchorPlanOf(draft,[['付款是最高级','x']]),'anchor-missing:0'],
  [anchorPlanOf(draft,[['、','x']]),'anchor-ambiguous:0'],
  [anchorPlanOf(draft,[['付款为最高级','x'],['分级：付款','y']]),'overlap:0'],
  ['草稿 SHA-256：'+draftSha256(draft)+'\n<<<原文>>>\n\n<<<改为>>>\nx\n<<<结束>>>','anchor-empty:0'],
  [anchorPlanOf(draft,[[draft,'']]),'empty-result'],
 ]
 for(const [plan,reason] of reasons)assert.deepEqual(applyDeliveryPlan(plan,draft),{reason},reason)
})

test('真实 AgentLoop：编辑计划未通过校验时唯一纠正名额用尽后本轮如实收为错误，不部分应用、不追加交付、不把草稿或计划当结果；显式无需修改且完整收尾时交付即冻结草稿',async t=>{
 for(const [label,plan,reason] of [
  ['引用不存在的块编号',(draft:string)=>planOf(draft,[['不存在的句子','x']]),'rewrite-plan:affected-blocks'],
  ['旧原文锚点格式不再被接受',(draft:string)=>anchorPlanOf(draft,[['口述付款记为最高级','x']]),'rewrite-plan:missing-submission'],
  ['显式带摘要字段（旧契约，即使抄对）',(draft:string)=>({...planOf(draft,[]),snapshotHash:draftSha256(draft)}) as unknown as Submission,'rewrite-plan:shape'],
  ['重写整篇而不是编辑计划',()=>'终稿：重写后的整篇交付。','rewrite-plan:missing-submission'],
 ] as const)await t.test(label,async sub=>{
  const draft='草稿：口述付款记为最高级。'
  // 同一类不合格回执连续两次：第一次用掉唯一纠正名额（语义拒绝沿错误回执续步；缺交得一次补交提醒），第二次收错。
  const f=await runtime(sub,[text(draft),text(plan(draft)),text(plan(draft)),text('不应出现')])
  await f.send()
  assert.equal(f.adapter.requests.length,3,'纠正一次后不追加第四步')
  assert.deepEqual(ends(f.events()),['error'])
  const missing=reason==='rewrite-plan:missing-submission'
  assert.deepEqual(f.traces.map(entry=>[entry.state,entry.phase,entry.reason??null]),[['requested','rewrite',null],...missing?[['requested','rewrite','correction:plan:missing-submission']]:[],['failed','rewrite',reason]])
  assert.equal(f.events().filter(event=>event.type==='tool/result'&&Reflect.get(event.data,'message').isError===true).length,missing?0:2,'语义拒绝的两次真实错误回执如实落盘')
  assert.equal(applied(f.events()).length,0,'不追加复核后交付')
  assert.equal(readTaskRunGroupResult(f.events(),'rpc'),undefined,'草稿、计划都不成为交付')
 })
 const draft='草稿：已按原文分级。'
 const unchanged=await runtime(t,[text(draft),text(planOf(draft,[])),text(verify())])
 await unchanged.send()
 assert.deepEqual(ends(unchanged.events()),['completed'])
 assert.equal(readTaskRunGroupResult(unchanged.events(),'rpc'),draft,'显式无需修改：交付就是冻结草稿')
 assert.equal(Reflect.get(applied(unchanged.events())[0]!.data.source as object,'edits'),0)
 const truncated=await runtime(t,[text(draft),text(planOf(draft,[]),'max-tokens')])
 await truncated.send()
 assert.deepEqual(oldTraceFields(truncated.traces.at(-1)!),{runId:'run',state:'failed',phase:'rewrite',round:1,unit:0,reason:'rewrite-finish:max-tokens',draftMessageId:truncated.traces[0]!.draftMessageId},'截断的「无需修改」不被接受')
 assert.equal(readTaskRunGroupResult(truncated.events(),'rpc'),undefined)
})

test('已保存的整篇改写旧会话（交付改写输入后的完整助手回复）升级后仍按原规则读取；未完成或截断仍无交付',async t=>{
 for(const [label,reply,expected] of [['完整',text('旧版整篇改写终稿'),'旧版整篇改写终稿'],['截断',text('旧版写到一半','max-tokens'),undefined]] as const)await t.test(label,async sub=>{
  const f=await runtime(sub,[text('未经复核的旧草稿'),reply])
  f.release()
  let published=false
  sub.after(f.agent.ctx.on('agent/turn-stopping',async()=>{
   if(published)return
   published=true
   const draft=f.events().find(event=>event.type==='assistant/message')
   assert.ok(draft?.type==='assistant/message')
   f.agent.inject(createUserMessage({source:{kind:deliveryReviewSource,form:'notice',summary:'交付改写',runId:'legacy-run',draftMessageId:draft.data.message.id},content:[{type:'text',text:'旧版整篇改写要求'}]}))
  }))
  await f.send()
  assert.equal(readTaskRunGroupResult(f.events(),'rpc'),expected)
 })
})

test('会话中的「复核后交付」正文与任务结果正文逐字节一致：宿主按任务结果同一规范（去首尾空白）保存并计算交付摘要',async t=>{
 const draft='\n  草稿：口述付款记为最高级。  \n'
 const f=await runtime(t,[text(draft),text(planOf(draft,[['口述付款记为最高级','口述付款按定义有条件分级']])),text(verify(['r1:u1:i1']))])
 await f.send()
 const result=readTaskRunGroupResult(f.events(),'rpc')!
 const [delivery]=applied(f.events())
 assert.ok(delivery?.type==='user/message')
 assert.equal(textOf(delivery.data as never),result,'会话展示正文就是任务结果正文')
 assert.equal(Reflect.get(delivery.data.source,'deliverySha256'),createHash('sha256').update(result,'utf8').digest('hex'),'交付摘要对应任务结果正文')
 assert.equal(result,'草稿：口述付款按定义有条件分级。')
})

test('R2拒绝不交付：只有有依据的新问题进入有界修订，其他未知、漏项或夹带替换立即收错',async t=>{
 const draft='草稿：口述付款记为最高级。'
 const firstRound=planOf(draft,[['口述付款记为最高级','口述付款按定义有条件分级']])
 const accepted=()=>verify(['r1:u1:i1'])
 const unknown=accepted();unknown.checks[1]!.status='unknown'
 const unresolved=accepted();unresolved.verdict='reject';unresolved.changeChecks[0]!.status='unresolved'
 const finding=accepted();finding.verdict='reject';finding.findings=[{problem:'仍存在没有依据的结论。',basis:[passageBasis(reviewMaterial.catalog,'goal',material)],blockIds:[1]}]
 for(const [label,second] of [
  ['R1问题仍未解决',text(unresolved)],['检查未知',text(unknown)],['新增阻断',text(finding)],
  ['检查缺项',text({...accepted(),checks:accepted().checks.slice(1)})],
  ['漏验宿主R1问题',text({...accepted(),changeChecks:[]})],
  ['验收夹带after',text({...accepted(),after:'不能用新稿替代验收'} as Submission)],
  ['旧空编辑不是验收',text({edits:[]} as unknown as Submission)],
  ['第2轮截断',text(accepted(),'max-tokens')],['第2轮调用业务工具',call('teloa_capabilities')],
 ] as const)await t.test(label,async sub=>{
  // 严格schema或工具体语义拒绝的回执连续出现两次，耗尽整租约唯一纠正名额；截断与调用其他工具不可纠正。
  const repeated=['检查未知','检查缺项','漏验宿主R1问题','验收夹带after','旧空编辑不是验收'].includes(label)
  const tail=label==='新增阻断'?[text('R3 只写说明不交回执'),text('补交提醒后仍不交回执')]:repeated?[second]:[]
  const f=await runtime(sub,[text(draft),text(firstRound),second,...tail,text('不应出现')])
  await f.send()
  assert.equal(f.adapter.requests.length,label==='新增阻断'?5:repeated?4:3,'有依据拒绝可进入唯一R3；R3补交后仍无合法回执收错；其他未知或非法回执纠正一次仍不合格即收错，不修稿')
  if(label==='新增阻断')assert.equal(f.traces.at(-1)!.reason,'rewrite-r3-plan:missing-submission')
  assert.equal(f.executed(),0);assert.deepEqual(ends(f.events()),['error'])
  assert.equal(applied(f.events()).length,0);assert.equal(readTaskRunGroupResult(f.events(),'rpc'),undefined)
 })
 await t.test('R2发布时取消',async sub=>{
  let published=0
  const f=await runtime(sub,[text(draft),text(firstRound),text('不应出现')],async(agent,message)=>{
   if(++published===2){agent.cancel({kind:'hook',reason:'任务时限已到'});await Promise.resolve();return}
   agent.inject(message)
  })
  await f.send();assert.equal(f.adapter.requests.length,2);assert.deepEqual(ends(f.events()),['aborted']);assert.equal(readTaskRunGroupResult(f.events(),'rpc'),undefined)
 })
 await t.test('R1零修改仍须整稿验收',async sub=>{
  const f=await runtime(sub,[text(draft),text(revise()),text(verify()),text('不应出现')])
  await f.send();assert.equal(f.adapter.requests.length,3);assert.equal(readTaskRunGroupResult(f.events(),'rpc'),draft)
  const phases=f.events().flatMap(event=>event.type==='assistant/message'?event.data.message.content.flatMap(block=>block.type==='tool-call'?[receiptArgs(block.arguments).phase]:[]):[])
  assert.deepEqual(phases,['revise','verify'])
  assert.deepEqual(f.traces.filter(entry=>entry.state==='delivered').map(entry=>entry.round),[2])
 })
})

test('实际执行校验与本轮来源枚举一致：错误片段沿原生工具错误只纠参一次，仍须R2验收',async t=>{
 const invalid=revise([{blockId:1,after:'核对后的结果'}]);invalid.issues[0]!.basis=[{sourceId:'goal',passageId:'p999'}]
 const f=await runtime(t,[text('原草稿'),submit(invalid),submit(revise([{blockId:1,after:'核对后的结果'}])),submit(verify(['r1:u1:i1'],[[1]]))])
 await f.send();assert.equal(f.adapter.requests.length,4);assert.equal(readTaskRunGroupResult(f.events(),'rpc'),'核对后的结果')
 assert.deepEqual(f.events().filter(e=>e.type==='tool/result').map(e=>e.type==='tool/result'&&e.data.message.isError),[true,false,false])
 const error=f.events().find(e=>e.type==='tool/result'&&e.data.message.isError)
 assert.ok(error?.type==='tool/result')
 const diagnostic=error.data.message.content.flatMap(part=>part.type==='text'?[part.text]:[]).join('\n')
 assert.match(diagnostic,/当前可用来源片段组合/)
 assert.ok(diagnostic.includes('"sourceId":"goal"')&&diagnostic.includes('"passageIds":["p1"]'),'按冻结目录明确列出可选组合，不让模型拆路径或猜编号')
})

test('来源枚举重复非法不能续领纠参名额，冻结草稿不作为交付',async t=>{
 const invalid=revise([{blockId:1,after:'核对后的结果'}]);invalid.issues[0]!.basis=[{sourceId:'goal',passageId:'p999'}]
 const f=await runtime(t,[text('原草稿'),submit(invalid),submit(invalid)]);await f.send()
 assert.equal(f.adapter.requests.length,3);assert.equal(readTaskRunGroupResult(f.events(),'rpc'),undefined);assert.equal(ends(f.events()).at(-1),'error')
})

test('复核阶段以宿主系统段明确工具回执协议，普通起草不带该段且JSON正文不代替工具',async t=>{
 const f=await runtime(t,[text('原草稿'),submit(revise()),submit(verify())]);await f.send()
 const marker='当前处于宿主交付复核阶段'
 assert.ok(!JSON.stringify(f.adapter.requests[0]).includes(marker))
 assert.ok(JSON.stringify(f.adapter.requests[1]).includes(marker))
 assert.match(JSON.stringify(f.adapter.requests[1]),/JSON正文或代码块不构成工具回执/)
 assert.match(JSON.stringify(f.adapter.requests[2]),/verify/)
})

test('当前覆盖简写漏掉未列归属时由模型纠参一次，R2仍须核对整稿保留块',async t=>{
 const draft='保留的第1块。\n\n需改的第2块。'
 const invalid={phase:'revise',issues:[{problem:'修正第2块。',basis:[passageBasis(reviewMaterial.catalog,'goal',material)],affectedScope:'coverage',coverage:{change:[2],retain:[],unrelated:[],unknown:[]},edits:[{blockId:2,after:'核对后的第2块。'}]}]}
 const corrected=structuredClone(invalid) as Record<string,any>;corrected.issues[0].coverage.unlisted='retain'
 const f=await runtime(t,[text(draft),submit(invalid as unknown as Submission),submit(corrected as Submission),submit(verify(['r1:u1:i1'],[[1,2]]))])
 await f.send();assert.equal(f.adapter.requests.length,4);assert.equal(readTaskRunGroupResult(f.events(),'rpc'),'保留的第1块。\n\n核对后的第2块。')
 assert.deepEqual(f.events().filter(e=>e.type==='tool/result').map(e=>e.type==='tool/result'&&e.data.message.isError),[true,false,false])
})

test('覆盖简写重复漏项不能重复纠参，也不能把草稿交付到群',async t=>{
 const invalid={phase:'revise',issues:[{problem:'修正第2块。',basis:[passageBasis(reviewMaterial.catalog,'goal',material)],affectedScope:'coverage',coverage:{change:[2],retain:[],unrelated:[],unknown:[]},edits:[{blockId:2,after:'核对后的第2块。'}]}]}
 const f=await runtime(t,[text('保留的第1块。\n\n需改的第2块。'),submit(invalid as unknown as Submission),submit(invalid as unknown as Submission)])
 await f.send();assert.equal(f.adapter.requests.length,3);assert.equal(readTaskRunGroupResult(f.events(),'rpc'),undefined);assert.equal(ends(f.events()).at(-1),'error')
})

test('显式保留的未列块仍属R2必核依赖，漏验时不能交付',async t=>{
 const revision={phase:'revise',issues:[{problem:'修正第2块。',basis:[passageBasis(reviewMaterial.catalog,'goal',material)],affectedScope:'coverage',coverage:{change:[2],retain:[],unrelated:[],unknown:[],unlisted:'retain'},edits:[{blockId:2,after:'核对后的第2块。'}]}]}
 const f=await runtime(t,[text('保留的第1块。\n\n需改的第2块。'),submit(revision as unknown as Submission),submit(verify(['r1:u1:i1'],[[2]]))])
 await f.send();assert.equal(readTaskRunGroupResult(f.events(),'rpc'),undefined);assert.equal(ends(f.events()).at(-1),'error')
})

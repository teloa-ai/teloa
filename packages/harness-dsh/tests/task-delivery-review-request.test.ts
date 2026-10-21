import test,{type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {brotliDecompressSync} from 'node:zlib'
import {Context} from '@deepseek-ai/cordis'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {LlmAdapter,LlmRuntime,ReasoningEffortId,createUserMessage,type GenerateOptions,type StreamChunk,type UserMessage} from '@deepseek-ai/dsh-llm'
import {SessionId,SessionStore,type SessionEvent} from '@deepseek-ai/dsh-session'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {readRunKnowledge,type TaskExecutionScope,type TaskRun} from '@teloa/backend'
import {artifactRevisionScope,createReviewSourceCatalog,applyPlanEdits,deliveryReviewPrompt,deliveryReviewToolName,deliveryRoundData,draftSha256,readReviewSubmission,reviewBlockLabel,reviewBlockTag,splitReviewBlocks,splitReviewUnits,wholeReviewMaxChars,wholeReviewMaxBytes,maxReviewUnits,type ReviewRound} from '../src/task-delivery-review.ts'
import {dshTaskRunPorts,taskRunReviewMaterial,type DshTaskNativeInput} from '../src/task-run-dsh.ts'
import {artifactRevisionNotice,readArtifactRevisionContext} from '../../backend/src/work/artifact-revision-requests.ts'
import {ownerRunInput} from '../../backend/src/work/owner-task-run-snapshot.ts'
import {taskInputWithoutMemory} from '../src/task-memory-input.ts'
import {readTaskRunGroupResult} from '../src/task-run-group-result.ts'
import {readSessionEvents} from '../src/session-events.ts'
import {planContextNotice,planWorkContextNotice} from '../../backend/src/work/task-run-plan-context.ts'

type Reply=readonly StreamChunk[]
const text=(value:string):Reply=>[{type:'block-start',index:0,blockType:'text'},{type:'text-delta',index:0,text:value},{type:'block-end',index:0,block:{type:'text',text:value}},{type:'finish',reason:{kind:'stop'}}]
let callSerial=0
/** 模型以原生工具调用提交复核回执，与真实回复一样以 tool-calls 收尾。 */
const submit=(args:unknown):Reply=>[{type:'block-start',index:0,blockType:'tool-call'},{type:'block-end',index:0,block:{type:'tool-call',id:'review-call-'+(++callSerial),name:deliveryReviewToolName,arguments:args}},{type:'finish',reason:{kind:'tool-calls'}}] as unknown as Reply

/** 声明真实推理档位（与固定 pi-ai 对推理模型报告的同一组）的回放模型；记录每次请求实际收到的档位。 */
class EffortAdapter extends LlmAdapter{
 requests:GenerateOptions[]=[]
 readonly replies:Reply[]
 constructor(replies:Reply[]){super();this.replies=replies}
 override async resolveModel(provider:string,model:string){return {provider,id:model,name:model,inputModalities:['text'] as const,reasoning:{efforts:['off','minimal','low','medium','high'].map(id=>({id:ReasoningEffortId(id),name:id}))}}}
 async *stream(options:GenerateOptions):AsyncGenerator<StreamChunk>{
  this.requests.push(options)
  for(const chunk of this.replies.shift()??text('多余请求'))yield chunk
 }
}

const skill={name:'review',provider:'native',source:'project',description:'核对',content:'正文',sha256:createHash('sha256').update('正文').digest('hex')}
const fixedSkills=Array.from({length:4},(_,index)=>{const content=index?'完整固定方法 '+index+'：保留全部限定与原文。':skill.content;return {...skill,name:index?'review-'+index:skill.name,content,sha256:createHash('sha256').update(content).digest('hex')}})
const fixedKnowledge=readRunKnowledge(Array.from({length:12},(_,index)=>{const text='完整参考 '+index+'：原文，不得丢失。';return {id:'00000000-0000-4000-8000-'+String(index+1).padStart(12,'0'),version:1,title:'参考 '+index,sourceId:'reference-'+index,sourceVersion:createHash('sha256').update(text).digest('hex'),scopeIds:['SOC'],text}}))
const goalSnapshot=JSON.stringify({schema:'teloa.task-run-input/v2',task:{id:'task',version:3,goal:'资料：1 家已付款。'},knowledge:{contents:fixedKnowledge},skills:fixedSkills})
const draft='结论：1 家已付款（且必然续费）。\n\n说明：仅依据资料。'
const finalText='结论：1 家已付款。\n\n说明：仅依据资料。'
const tag=reviewBlockTag(draft)
/** 块编号回执：第 1 块整块重写为去掉无依据推断后的内容。 */
type Edit={blockId:number;after:string}
const coverageFor=(count:number,change:readonly number[],retain:readonly number[]=[])=>({change:[...new Set(change)],retain:[...retain],unrelated:Array.from({length:count},(_,index)=>index+1).filter(id=>!change.includes(id)&&!retain.includes(id)),unknown:[] as number[]})

function passageBasis(catalog:ReturnType<typeof createReviewSourceCatalog>,sourceId:string,needle:string){
 const source=catalog.sources.find(source=>source.id===sourceId);assert.ok(source)
 const passage=catalog.passages.find(passage=>passage.sourceId===sourceId&&source.text.slice(passage.start,passage.end).includes(needle));assert.ok(passage,'引用必须来自完整冻结目录的真实片段')
 return {sourceId,passageId:passage.id}
}
const goalBasis=(goal:string)=>passageBasis(createReviewSourceCatalog([{id:'goal',kind:'goal',title:'原目标',text:goal,origin:{field:'inputText',pointer:'/task/goal'}}]),'goal',goal)
type Revision={phase:'revise';issues:{problem:string;basis:{sourceId:string;passageId:string}[];affectedBlockIds:number[];coverage:ReturnType<typeof coverageFor>;edits:Edit[]}[]}
type Verification={phase:'verify';verdict:'accept'|'reject';checks:{id:'goal'|number;status:'pass'|'fail'|'unknown'}[];changeChecks:{issueId:string;status:'verified'|'unresolved'|'unknown';reviewedBlockIds:number[]}[];findings:{problem:string;basis:{sourceId:string;passageId:string}[];blockIds:number[]}[]}
type Submission=Revision|Verification
const verify=(issueIds:readonly string[]=[],blocks:readonly (readonly number[])[]=issueIds.map(()=>[1])):Verification=>({phase:'verify',verdict:'accept',checks:(['goal',1,2,3,4,5,6,7,8] as const).map(id=>({id,status:'pass'})),changeChecks:issueIds.map((issueId,index)=>({issueId,status:'verified',reviewedBlockIds:[...blocks[index]!]})),findings:[]})
const revision=(edits:Edit[]=[],goal='资料：1 家已付款。',blockCount=2):Revision=>({phase:'revise',issues:edits.length?[{problem:'原结论超出资料。',basis:[goalBasis(goal)],affectedBlockIds:[...new Set(edits.map(edit=>edit.blockId))],coverage:coverageFor(blockCount,edits.map(edit=>edit.blockId)),edits}]:[]})
const editPlan=revision([{blockId:1,after:'结论：1 家已付款。'}])
const noChange=()=>revision()

/** 真实任务端口装配：官方 Agent Loop、固定模型路由与复核租约都由 dshTaskRunPorts 安装，只有模型回放是替身。 */
async function fixture(t:TestContext,model:string,replies:Reply[],nativeInput?:DshTaskNativeInput){
 const ctx=new Context();t.after(()=>ctx.fiber.dispose())
 for(const plugin of [LlmRuntime,SessionStore,SessionProjectionRegistry,SystemPrompt,ToolRuntime,AgentRegistry])await ctx.plugin(plugin)
 await ctx.plugin(AgentLoop,{agents:[]})
 const adapter=new EffortAdapter(replies);ctx.llm.registerAdapter(['minimax'],adapter)
 const {agent}=await ctx.agents.create({sessionId:SessionId('review-request-'+t.name),agentOptions:{provider:'minimax',model,maxTokens:65536}})
 const skills={get:async(name:string)=>{const selected=fixedSkills.find(skill=>skill.name===name);return selected?{...selected,invocation:{modelInvocable:true,userInvocable:true}}:undefined}}
 ctx.provide('sessionController',{resolveAgent:async()=>({agent})} as never)
 ctx.provide('attachments',{admitPromptContent:async(content:UserMessage['content'])=>structuredClone(content)} as never)
 ctx.provide('agentPresets',{serviceFor:()=>skills} as never)
 const ports=dshTaskRunPorts(ctx,'owner',async sessionId=>({ownerId:'owner',sessionId,status:'ready'}),async()=>fixedKnowledge,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,nativeInput)
 const run={id:'run',taskId:'task',taskVersion:3,linkVersion:2,sessionId:agent.id,nativeRequestId:'rpc',inputText:goalSnapshot,allowedTools:[],skills:fixedSkills,knowledge:fixedKnowledge,modelPolicy:{primary:{provider:'minimax',model}}} as unknown as TaskRun
 const target:TaskExecutionScope={taskId:'task',taskVersion:3,sessionId:agent.id,linkVersion:2,scope:'SOC'}
 const signal=new AbortController().signal
 const later=async()=>{agent.followup(createUserMessage({source:{kind:'user',rpcId:'rpc-2'},content:[{type:'text',text:'普通追问'}]}));await agent.whenIdle()}
 return {agent,adapter,ports,run,target,signal,later,events:()=>readSessionEvents(agent.session) as readonly SessionEvent[]}
}
const efforts=(adapter:EffortAdapter)=>adapter.requests.map(request=>request.reasoningEffort)
const ends=(events:readonly SessionEvent[])=>events.flatMap(event=>event.type==='turn/end'?[event.data.reason.kind]:[])
const multiMethodDraft=['结论：1 家已付款（且必然续费）。','说明：付款均已独立核实。','资料限制：'+'只按给定原文核对，不把未知写成已知。'.repeat(90)].join('\n\n')

test('真实Loop的复核专用系统规则使用英文，保留真实工具提交与R1/R2字段边界',async t=>{
 const f=await fixture(t,'MiniMax-M3',[text(draft),submit(noChange()),submit(verify())])
 await f.ports.send(f.run,f.signal,f.target);await f.agent.whenIdle()
 assert.deepEqual(ends(f.events()),['completed']);assert.equal(f.adapter.requests.length,3)
 for(const [index,phase] of (['revise','verify'] as const).entries()){
  const request=f.adapter.requests[index+1]!,system=request.messages.filter(message=>message.role==='system').flatMap(message=>message.content.flatMap(part=>part.type==='text'?[part.text]:[])).join('\n')
  const rule=/Host delivery-review phase:[\s\S]*?Do not output a rewritten body or self-check, or call other tools\./.exec(system)?.[0]
  assert.ok(rule,'模型实际system中必须装配专用英文规则')
  assert.ok(rule.startsWith('Host delivery-review phase: '+phase+'. '))
  assert.ok(rule.includes('real '+deliveryReviewToolName+' call; JSON prose/code fences are not receipts'))
  assert.ok(rule.includes('Direct-answer instructions apply to the final deliverable, not this review step'))
  assert.equal(/\p{Script=Han}/u.test(rule),false)
  assert.deepEqual(request.tools?.map(tool=>tool.name),[deliveryReviewToolName],'复核步仍只提供原回执工具')
  if(phase==='revise')assert.ok(rule.includes('Even with no corrections, call with phase:revise and issues:[]'))
  else{
   assert.ok(rule.includes('Submit only phase, verdict, checks, changeChecks and findings; no issues or editing fields'))
   assert.ok(rule.includes('Fill every acceptance check from actual review; never default to acceptance'))
  }
 }
 assert.equal(readTaskRunGroupResult(f.events(),'rpc'),draft,'仅改系统脚手架，不改无修改回执交付的原正文')
})

test('常规多方法整稿共同纠正全部标准，再由独立整稿R2决定交付',async t=>{
 const original=multiMethodDraft
 const expected=original.replace('结论：1 家已付款（且必然续费）。','结论：1 家已付款。').replace('说明：付款均已独立核实。','说明：来源未额外核实。')
 const joint={phase:'revise',issues:[...revision([{blockId:2,after:'说明：来源未额外核实。'}],'资料：1 家已付款。',3).issues,...revision([{blockId:1,after:'结论：1 家已付款。'}],'资料：1 家已付款。',3).issues]}
 const f=await fixture(t,'MiniMax-M3',[text(original),submit(joint),submit(verify(['r1:u1:i1','r1:u1:i2'],[[2],[1]]))])
 await f.ports.send(f.run,f.signal,f.target);await f.agent.whenIdle()
 assert.deepEqual(ends(f.events()),['completed'])
 assert.equal(f.adapter.requests.length,3,'常规整稿只有草稿、共同R1、独立R2，不按方法数量重复改写同一正文')
 assert.equal(readTaskRunGroupResult(f.events(),'rpc'),expected)
 assert.ok(f.adapter.requests.every(request=>request.reasoningEffort==='high'&&request.maxTokens===65536))
 const r1=f.adapter.requests[1]!,prompt=r1.messages.flatMap(message=>typeof message.content==='string'?[message.content]:message.content.flatMap(part=>part.type==='text'?[part.text]:[])).join('\n')
 for(let id=1;id<=8;id++)assert.match(prompt,new RegExp('\\n'+id+'\\. '),'原八项检查逐项送入同一R1')
 assert.ok(prompt.includes('本轮冻结的原目标（宿主逐字附上）')&&prompt.includes('资料：1 家已付款。'))
 assert.ok(prompt.includes('第 1/1 单元')&&!prompt.includes('本单元专门核对原标准'),'不再只要求本单元的一组标准')
 const call=f.events().find(event=>event.type==='tool/call');assert.ok(call?.type==='tool/call')
 assert.ok(!JSON.stringify(f.adapter.requests[2]).includes(call.data.callId),'R2不沿用R1工具计划或回执')
 assert.equal(f.adapter.requests[2]!.messages.some(message=>message.role==='assistant'||message.role==='tool'),false)
 const host=f.events().find(event=>event.type==='user/message'&&Reflect.get(event.data.source,'summary')==='复核后交付');assert.ok(host?.type==='user/message')
 const rounds=Reflect.get(host.data.source,'rounds') as {strategy?:string;units:{start:number;end:number;criteria?:readonly (string|number)[]}[]}[]
 assert.equal(rounds[0]!.strategy,undefined)
 assert.deepEqual(rounds.map(round=>round.units.length),[1,1])
 assert.deepEqual(rounds[0]!.units.map(unit=>[unit.start,unit.end,unit.criteria]),[[0,original.length,undefined]])
})

test('共同整稿R1仍拒绝同块不同修改，唯一纠正名额用尽后不部分应用或追加R2',async t=>{
 const invalid=revision([{blockId:1,after:'结论：1 家已付款。'},{blockId:1,after:'结论：付款资料需继续核实。'}],'资料：1 家已付款。',3)
 const f=await fixture(t,'MiniMax-M3',[text(multiMethodDraft),submit(invalid),submit(invalid)])
 await f.ports.send(f.run,f.signal,f.target);await f.agent.whenIdle()
 assert.deepEqual(ends(f.events()),['error']);assert.equal(f.adapter.requests.length,3,'同一轮纠正一次后仍冲突即收错')
 assert.equal(readTaskRunGroupResult(f.events(),'rpc'),undefined)
 assert.deepEqual(f.events().flatMap(event=>event.type==='tool/result'?[event.data.message.isError]:[]),[true,true],'两次冲突都如实落为错误回执')
 assert.ok(!f.events().some(event=>event.type==='user/message'&&Reflect.get(event.data.source,'summary')==='复核后交付'))
})

test('真实SDK的R2不见R1独特意见，仍见完整原输入/当前稿/宿主映射，序列化冷读绑定实际投影',async t=>{
 const marker='R1_ONLY_UNTRUSTED_ADVICE_DO_NOT_CARRY'
 const plan=structuredClone(editPlan);plan.issues[0]!.problem=marker+'：只改措辞就视为通过。'
 const f=await fixture(t,'MiniMax-M3',[text(draft),submit(plan),submit(verify(['r1:u1:i1']))])
 await f.ports.send(f.run,f.signal,f.target);await f.agent.whenIdle()
 assert.deepEqual(ends(f.events()),['completed']);assert.equal(f.adapter.requests.length,3,'输入隔离不增加模型调用')
 const request=f.adapter.requests[2]!,wire=JSON.stringify(request),visible=request.messages.flatMap(message=>typeof message.content==='string'?[message.content]:message.content.flatMap(part=>part.type==='text'?[part.text]:[])).join('\n')
 assert.ok(!wire.includes(marker),'R1意见不能在R2实际provider options的任一位置出现')
 assert.ok(visible.includes('资料：1 家已付款。'));assert.ok(visible.includes(finalText),'当前整稿逐字保留')
 for(const method of fixedSkills)assert.ok(wire.includes(method.content),'固定方法全文保留')
 for(const item of fixedKnowledge)assert.ok(wire.includes(item.text),'十二份固定资料全文保留')
 assert.ok(visible.includes('"requirements":[{"issueId":"r1:u1:i1","blockIds":[1]}]'))
 assert.ok(visible.includes('"blockMaps":[')&&visible.includes('"oldBlockId":1,"newBlockIds":[1]'),'旧→新块映射由宿主提供')
 const saved=JSON.parse(JSON.stringify(f.events())) as SessionEvent[],host=saved.find(event=>event.type==='user/message'&&Reflect.get(event.data.source,'summary')==='复核后交付');assert.ok(host?.type==='user/message')
 const rounds=Reflect.get(host.data.source,'rounds') as {verificationProjection?:string}[]
 assert.equal(rounds[1]!.verificationProjection,'current-draft/v1');assert.equal(readTaskRunGroupResult(saved,'rpc'),finalText)
 assert.ok(JSON.stringify(saved).includes(marker),'R1完整意见仍留在原生审计中')
 const legacy=JSON.parse(JSON.stringify(saved)) as SessionEvent[],legacyHost=legacy.find(event=>event.seq===host.seq)!;assert.ok(legacyHost.type==='user/message')
 const legacyRounds=Reflect.get(legacyHost.data.source,'rounds') as ReviewRound[]
 Reflect.deleteProperty(legacyRounds[1]!,'verificationProjection')
 const legacyData=legacy.find(event=>event.type==='user/message'&&event.data.content.some(part=>part.type==='text'&&part.text.startsWith('验收输入投影 current-draft/v1')));assert.ok(legacyData?.type==='user/message')
 Reflect.set(legacyData.data,'content',[{type:'text',text:deliveryRoundData(finalText,2,legacyRounds[0]!.units.flatMap(unit=>unit.issues??[]),legacyRounds[0]!.blockMap)}])
 assert.equal(readTaskRunGroupResult(legacy,'rpc'),finalText,'旧v3完整R1数据投影仍沿历史契约冷读，不强迫改写存量')
 for(const damage of ['drop-projection','wrong-projection','change-input'] as const){
  const changed=JSON.parse(JSON.stringify(saved)) as SessionEvent[],delivery=changed.find(event=>event.seq===host.seq)!;assert.ok(delivery.type==='user/message')
  const records=Reflect.get(delivery.data.source,'rounds') as {verificationProjection?:string}[]
  if(damage==='drop-projection')delete records[1]!.verificationProjection
  else if(damage==='wrong-projection')records[1]!.verificationProjection='unproved/v1'
  else{
   const data=changed.find(event=>event.type==='user/message'&&event.data.content.some(part=>part.type==='text'&&part.text.startsWith('验收输入投影 current-draft/v1')));assert.ok(data?.type==='user/message')
   Reflect.set(data.data,'content',[{type:'text',text:'改写过的另一个验收输入。'}])
  }
  assert.equal(readTaskRunGroupResult(changed,'rpc'),undefined,damage)
 }
})

test('整稿字符与UTF8双边界保持一单元，超界按完整块分为最多四个不相交单元',()=>{
 const ascii='a'.repeat(2999)+'\n\n'+'b'.repeat(2999)
 assert.equal(ascii.length,wholeReviewMaxChars);assert.deepEqual(splitReviewUnits(ascii),[{start:0,end:ascii.length}])
 assert.ok(splitReviewUnits(ascii+'b').length>1)
 const unicode='汉'.repeat(1365)+'\n\n'+'汉'.repeat(1365)
 assert.equal(Buffer.byteLength(unicode),wholeReviewMaxBytes);assert.deepEqual(splitReviewUnits(unicode),[{start:0,end:unicode.length}])
 assert.ok(splitReviewUnits(unicode+'汉').length>1,'字符未超界而UTF8超界也必须切分')
 const long=Array.from({length:12},(_,index)=>'## 第'+index+'节\n'+'长正文'.repeat(300)).join('\n\n'),units=splitReviewUnits(long)
 assert.equal(units.length,maxReviewUnits);assert.equal(maxReviewUnits,4)
 assert.equal(units.map(unit=>long.slice(unit.start,unit.end)).join(''),long)
 assert.equal(units[0]!.start,0);assert.equal(units.at(-1)!.end,long.length)
 for(let index=1;index<units.length;index++)assert.equal(units[index]!.start,units[index-1]!.end,'相邻单元首尾相接，无交叠和空档')
 const starts=new Set(splitReviewBlocks(long).map(block=>block.start))
 assert.ok(units.every(unit=>starts.has(unit.start)),'不切开完整块')
})

/** 旧whole-constraints/v1真实SDK回放的三份完整普通事件（主例、同改折叠、冲突），不含模型推理。
 * 在活动切分改变前由原request用例生成；压缩只去重复存储，解压后hash固定，不能用新活动路径重造旧历史。
 */
const legacyWholeHistory=()=>{
 const bytes=brotliDecompressSync(Buffer.from([
  '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',
  'j/eQL34O',
 ].join(''),'base64'))
 assert.equal(createHash('sha256').update(bytes).digest('hex'),'7d5ff6adb1933e4c696b0784a24d17464dda02eda8ec94e1cb789f5f75358e47')
 return JSON.parse(bytes.toString('utf8')) as Record<'main'|'duplicate'|'conflict',{events:SessionEvent[];expected:string|null}>
}

test('旧whole-constraints真实SDK历史仍冷读，并拒绝缺单元、改约束或伪造实际提示',()=>{
 const histories=legacyWholeHistory()
 for(const [kind,history]of Object.entries(histories))assert.equal(readTaskRunGroupResult(history.events,'rpc'),history.expected??undefined,'保留旧'+kind+'原生回执结果')
 const events=histories.main.events,host=events.find(event=>event.type==='user/message'&&Reflect.get(event.data.source,'summary')==='复核后交付');assert.ok(host?.type==='user/message')
 type Round={strategy?:string;units:{criteria?:readonly (string|number)[]}[]}
 const rounds=Reflect.get(host.data.source,'rounds') as Round[]
 assert.equal(rounds[0]!.strategy,'whole-constraints/v1')
 assert.deepEqual(rounds[0]!.units.map(unit=>unit.criteria),[[1,6,7],[2,3],[4,5],['goal',8]])
 for(const mutate of [
  (round:Round)=>{round.units.pop()},
  (round:Round)=>{round.units[1]!.criteria=[4,5]},
  (round:Round)=>{round.strategy='unknown'},
 ]){
  const altered=structuredClone(events),delivery=altered.find(event=>event.seq===host.seq);assert.ok(delivery?.type==='user/message')
  mutate((Reflect.get(delivery.data.source,'rounds') as Round[])[0]!)
  assert.equal(readTaskRunGroupResult(altered,'rpc'),undefined,'旧历史仍按原策略与实际证据严格核对')
 }
 const alteredPrompt=structuredClone(events),plan=alteredPrompt.find(event=>event.type==='user/message'&&Reflect.get(event.data.source,'summary')==='交付编辑计划');assert.ok(plan?.type==='user/message')
 const part=plan.data.content[0];assert.ok(part?.type==='text');part.text=part.text.replace('原标准 [1,6,7]','原标准 [8]')
 assert.equal(readTaskRunGroupResult(alteredPrompt,'rpc'),undefined,'实际提示篡改不能凭绿色metadata通过')
 const alteredPriority=structuredClone(events),priorityPlan=alteredPriority.find(event=>event.type==='user/message'&&Reflect.get(event.data.source,'summary')==='交付编辑计划');assert.ok(priorityPlan?.type==='user/message')
 const priorityPart=priorityPlan.data.content[0];assert.ok(priorityPart?.type==='text');const originalPriority=priorityPart.text;priorityPart.text=priorityPart.text.replace('以当前任务为准','以方法要求为准');assert.notEqual(priorityPart.text,originalPriority,'固定旧历史确实含被核对的优先级约束')
 assert.equal(readTaskRunGroupResult(alteredPriority,'rpc'),undefined,'旧静态文本仅精确白名单，变造任务优先级不得冷读通过')
 const duplicate=histories.duplicate.events.find(event=>event.type==='user/message'&&Reflect.get(event.data.source,'summary')==='复核后交付');assert.ok(duplicate?.type==='user/message')
 assert.equal(Reflect.get(duplicate.data.source,'edits'),1,'旧两单元同改仍只应用一次')
})

test('MiniMax-M3 经真实固定路由与复核钩子：草稿、各轮复核及普通追问保持 high；预检先装路由或发送时才装路由都成立',async t=>{
 for(const preflight of [false,true])await t.test(preflight?'预检后发送':'直接发送',async sub=>{
  const f=await fixture(sub,'MiniMax-M3',[text(draft),submit(editPlan),submit(verify(['r1:u1:i1'])),text('普通回复')])
  if(preflight)await f.ports.check(f.run,f.signal,f.target)
  await f.ports.send(f.run,f.signal,f.target);await f.agent.whenIdle()
  assert.deepEqual(efforts(f.adapter),['high','high','high'],'复核不覆盖固定路由的思考档位')
  // 运行策略 allowedTools=[]：只有本租约的回执工具出现在复核请求并被接收，草稿与追问不带它。
  assert.deepEqual(f.adapter.requests.map(request=>(request.tools??[]).map(tool=>tool.name)),[[],[deliveryReviewToolName],[deliveryReviewToolName]])
  assert.ok(f.events().filter(event=>event.type==='tool/result').every(event=>event.type==='tool/result'&&event.data.message.isError===false))
  assert.ok(f.adapter.requests.every(request=>request.provider==='minimax'&&request.model==='MiniMax-M3'),'模型与路由不变')
  assert.ok(f.adapter.requests.every(request=>request.maxTokens===65536),'起草与两轮均保留65536输出上限')
  assert.deepEqual(ends(f.events()),['completed'])
  assert.equal(readTaskRunGroupResult(f.events(),'rpc'),finalText,'块编号替换被宿主原子应用，第 2 轮确认后原生交付')
  for(const request of f.adapter.requests){
   assert.ok(request.messages.some(message=>message.role==='user'&&message.content.some(part=>part.type==='text'&&part.text===goalSnapshot)),'原固定 JSON（含完整十二参考）逐字保留')
   for(const method of fixedSkills)assert.ok(request.messages.some(message=>message.role==='system'&&message.content.some(part=>part.type==='text'&&part.text.includes(method.content))),'四个方法完整正文仍在系统输入')
  }
  const firstCall=f.events().find(event=>event.type==='tool/call');assert.ok(firstCall?.type==='tool/call')
  assert.ok(!JSON.stringify(f.adapter.requests[2]).includes(firstCall.data.callId),'provider 实际 options 含 toolHistory 无旧 R1 调用身份')
  assert.equal(f.adapter.requests[2]!.messages.some(message=>message.role==='assistant'||message.role==='tool'),false)
  await f.later()
  assert.deepEqual(efforts(f.adapter),['high','high','high','high'],'包括普通追问在内的每次实际请求均不被改写')
  assert.deepEqual(f.adapter.requests[3]!.tools??[],[],'租约释放后普通追问不再看到回执工具')
  // 原生相同配置可以复用已记录的 header；所有持久化配置与每次实际请求保持一致。
  const header=f.events().flatMap(event=>event.type==='request/header'?[event.data.header.config.reasoningEffort]:[])
  assert.ok(header.length>0&&header.every(effort=>effort==='high'),'持久化配置没有出现被宿主降级的档位')
 })
})

/** 一次实际请求里各条消息的文字部件（系统提示、固定输入、宿主约定与复核要求均按模型实际收到的顺序）。 */
const requestTexts=(request:GenerateOptions)=>request.messages.map(message=>typeof message.content==='string'?message.content:message.content.flatMap(part=>part.type==='text'?[part.text]:[]).join('\n'))
test('员工会话交办实际SDK以原本人文字起草，有技能沿原两轮，无技能仍单步',async t=>{
 for(const reviewed of [false,true])await t.test(reviewed?'有技能原三阶段':'无技能原单步',async sub=>{
  const original='资料：1 家已付款。仅用给出资料整理记录。',summary='本周付款充足。'
  const f=await fixture(sub,'MiniMax-M3',[text('记录：1 家已付款。'),...reviewed?[submit(noChange()),submit(verify())]:[]])
  const run={...f.run,roleId:'60000000-0000-4000-8000-000000000006',roleVersion:2,skills:reviewed?f.run.skills:[],knowledge:[],inputText:JSON.stringify({schema:'teloa.task-run-input/v2',task:{id:'task',version:3,goal:summary+'\n\n本人原指令：\n'+original}})}
  const source={runId:run.id,taskId:run.taskId,taskVersion:run.taskVersion,roleId:run.roleId,roleVersion:run.roleVersion,sessionId:run.sessionId,nativeRequestId:run.nativeRequestId,inputSha256:createHash('sha256').update(run.inputText).digest('hex'),source:{sessionId:'original-session',messageId:'original-message',messageSeq:1,requestId:'30000000-0000-4000-8000-000000000003'},sourceText:original,summary}
  f.ports.conversationReviewSource=async()=>({...source,roleId:'another-role'})
  await assert.rejects(f.ports.send(run,f.signal,f.target),{code:'teloa/forbidden'});assert.equal(f.adapter.requests.length,0)
  f.ports.conversationReviewSource=async()=>source
  await f.ports.send(run,f.signal,f.target);await f.agent.whenIdle()
  assert.equal(f.adapter.requests.length,reviewed?3:1)
  const instruction=f.adapter.requests[0]!.messages.flatMap(message=>message.content.flatMap(part=>part.type==='text'?[part.text]:[])).find(text=>text.startsWith('Current task (fulfill the original goal)'))!
  assert.ok(instruction.endsWith(original));assert.ok(!instruction.includes(summary))
  const material=taskRunReviewMaterial(run,run.inputText,source);assert.ok(!('skip'in material));assert.equal(material.catalog.sources.some(row=>row.text.includes(summary)),false)
  assert.equal(readTaskRunGroupResult(f.events(),'rpc'),'记录：1 家已付款。')
 })
})
test('员工固定修订与计划来源优先于派发概述，真实SDK仍沿原三阶段',async t=>{
 for(const kind of ['revision','plan'] as const)await t.test(kind,async sub=>{
  const f=await fixture(sub,'MiniMax-M3',[text('仅交付固定来源内的正文。'),submit(noChange()),submit(verify())])
  const revision=readArtifactRevisionContext({requestId:'10000000-0000-4000-8000-000000000001',artifactId:'20000000-0000-4000-8000-000000000002',baseVersion:1,sectionId:'review',title:'所选节',originalText:'保留原数量。',feedback:'仅删除无据的本周判断。',notice:artifactRevisionNotice})
  const planContext={occurrenceId:'10000000-0000-4000-8000-000000000001',goal:'仅按已采用的计划目标执行。',dataScope:'合成资料',delivery:'Markdown正文',notice:planContextNotice,work:{sourceDigest:'a'.repeat(64),method:'核对给出资料。',requirements:['只核对固定要求。'],output:'Markdown正文',skills:[],notice:planWorkContextNotice}}
  const goal=kind==='revision'?'派发概述：本周情况良好。':planContext.goal
  const run={...f.run,roleId:'60000000-0000-4000-8000-000000000006',roleVersion:2,inputText:JSON.stringify({schema:'teloa.task-run-input/v2',task:{id:'task',version:3,goal},...(kind==='revision'?{artifactRevision:revision}:{planContext})})}
  f.ports.conversationReviewSource=async()=>assert.fail('固定修订/计划不得读取普通会话来源')
  const material=taskRunReviewMaterial(run);assert.ok(!('skip'in material))
  if(kind==='plan'){
   assert.ok(material.catalog.sources.some(row=>row.text===planContext.work.method))
   for(const patch of [{notice:'错误的计划授权说明'},{work:{...planContext.work,notice:'错误的工作授权说明'}},{unknown:'不能静默丢弃'},{work:{...planContext.work,unknown:'不能静默丢弃'}}])assert.throws(()=>taskRunReviewMaterial({...run,inputText:JSON.stringify({...JSON.parse(run.inputText),planContext:{...planContext,...patch}})}))
   const {notice:_planNotice,work,...fields}=planContext,{notice:_workNotice,...workFields}=work
   const owner={...run,executor:{kind:'owner' as const,grantId:'30000000-0000-4000-8000-000000000003',grantVersion:1},roleId:null,roleVersion:null,inputText:JSON.stringify({schema:'teloa.task-run-input/v3',task:{id:'task',version:3,goal:planContext.goal},planContext:{...fields,work:workFields}})}
   const ownerMaterial=taskRunReviewMaterial(owner);assert.ok(!('skip'in ownerMaterial));assert.equal(ownerMaterial.goal,planContext.goal)
  }
  assert.equal(material.goal,kind==='revision'?revision.notice+'\n\n本人已保存的反馈：\n'+revision.feedback:planContext.goal)
  assert.equal(material.catalog.sources.some(row=>row.text.includes('派发概述')),false)
  await f.ports.send(run,f.signal,f.target);await f.agent.whenIdle();assert.equal(f.adapter.requests.length,3)
  const instruction=f.adapter.requests[0]!.messages.flatMap(message=>message.content.flatMap(part=>part.type==='text'?[part.text]:[])).find(text=>text.startsWith('Current task (fulfill the original goal)'))!
  assert.ok(instruction.endsWith(kind==='revision'?revision.feedback:planContext.goal))
 })
})
test('无固定技能的 owner 实际请求约束事实判断、系统日期与局部反馈，保原输入与角色分支',async t=>{
 const goal='仅使用提供资料：记录甲共14项，已核对5项。整理核对记录，建议与已知事实分开。'
 const revision=readArtifactRevisionContext({requestId:'10000000-0000-4000-8000-000000000001',artifactId:'20000000-0000-4000-8000-000000000002',baseVersion:1,sectionId:'review',title:'核对记录',originalText:'# 核对记录\r\n\n## 核对清单\n| 已核对 | 5 项 |\n\n## 风险与下一步\n核对节奏正常。\n保留标记 🔒\n',feedback:'仅修订风险与下一步，保留清单与已核对数量；缺少计划基线，删除无依据的状态判断，不新增时间安排。',notice:artifactRevisionNotice})
 for(const kind of ['owner-draft','owner-revision','role'] as const)await t.test(kind,async sub=>{
  const admitted:Parameters<DshTaskNativeInput['withNewInput']>[2][]=[]
  const f=await fixture(sub,'MiniMax-M3',[text('普通结果正文'),...kind==='role'?[]:[submit(noChange()),submit(verify())]],{withNewInput:async(_agent,_message,context,submit)=>{admitted.push(context);submit()}})
  const executor={kind:'owner' as const,grantId:'30000000-0000-4000-8000-000000000003',grantVersion:1}
  const task={id:'task',version:3,title:'资料核对',goal,scope:'general',groupId:null,skills:[],ownerId:'owner',state:'running' as const,assigneeRoleId:null,assigneeRoleVersion:null,createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z'}
  const input=kind==='role'?JSON.stringify({schema:'teloa.task-run-input/v2',task:{id:task.id,version:task.version,goal},skills:[],knowledge:{contents:[]}}):ownerRunInput(task,executor,{schema:'teloa.work-lineage/v1',ownerId:'owner',rootTaskId:task.id,definition:null,parentRunId:null,definitionControlId:null,roundControlId:'40000000-0000-4000-8000-000000000004',controlGeneration:1,budgetAccountId:'50000000-0000-4000-8000-000000000005'},[],undefined,f.run.modelPolicy,undefined,[],kind==='owner-revision'?revision:undefined)
  const run={...f.run,inputText:input,skills:[],knowledge:[],...(kind==='role'?{}:{executor,roleId:null,roleVersion:null})}
  f.ports.ownerReviewSource=async current=>({runId:current.id,taskId:current.taskId,taskVersion:current.taskVersion,roleId:current.roleId,roleVersion:current.roleVersion,sessionId:current.sessionId,nativeRequestId:current.nativeRequestId,inputSha256:createHash('sha256').update(current.inputText).digest('hex'),source:{sessionId:'original-session',messageId:'original-message',messageSeq:1,requestId:executor.grantId},sourceText:goal,summary:goal})
  await f.ports.send(run,f.signal,{...f.target,scope:'general'});await f.agent.whenIdle()
  assert.deepEqual(ends(f.events()),['completed']);assert.equal(f.adapter.requests.length,kind==='role'?1:3,'无技能owner也复用原两轮复核；普通角色分支不扩大')
  const request=f.adapter.requests[0]!,messages=requestTexts(request)
  assert.ok(request.messages.some(message=>message.role==='user'&&message.content.some(part=>part.type==='text'&&part.text===input)),'本轮完整JSON、原文与反馈逐字发送')
  assert.ok(messages.some(message=>message.includes('Run date: ')),'运行参照日期沿原发送路径保留，不改成业务事实')
  assert.deepEqual(request.tools??[],[]);assert.equal(request.provider,'minimax');assert.equal(request.model,'MiniMax-M3');assert.equal(request.reasoningEffort,'high');assert.equal(request.maxTokens,65536)
  assert.equal(admitted.length,kind==='role'?1:3);assert.ok(admitted.every(context=>context.producer==='task-run'))
  const instruction=request.messages.flatMap(message=>message.content.flatMap(part=>part.type==='text'?[part.text]:[])).find(part=>part.includes('Current task (fulfill the original goal)'))!
  assert.ok(instruction.endsWith(kind==='owner-revision'?revision.feedback:goal))
  if(kind==='role'){assert.equal(instruction,'Current task (fulfill the original goal):\n'+goal);return}
  assert.match(instruction,/Base facts on current material or verifiable calculation/)
  assert.match(instruction,/labeling a suggestion does not validate such a judgment/)
  assert.match(instruction,/supplied-material-only work.*system date is a runtime reference, not evidence for business dates\/windows/)
  assert.match(instruction,/correct affected judgments\/dependencies in the selected content, preserve ownership and unselected content/)
  assert.match(instruction,/Dispatch, execution creation and native approval are already complete; do not repeat them/)
  if(kind==='owner-draft')assert.equal(instruction.includes(artifactRevisionScope),false,'普通独立任务没有编辑基线，不增加虚构替换单位')
  if(kind==='owner-revision'){
   assert.deepEqual(JSON.parse(input).artifactRevision,revision,'真实notice/原文/反馈由官方canonical输入逐值保留，不从提示中另写答案')
   assert.ok(instruction.includes(artifactRevisionScope),'起草请求明确 originalText 全文为替换单位，不能只回反馈点名的子节')
   const material=taskRunReviewMaterial(run);assert.ok(!('skip'in material))
   const baseline=material.catalog.sources.find(source=>source.kind==='baseline');assert.ok(baseline)
   for(const request of f.adapter.requests.slice(1)){
    const actual=requestTexts(request).find(value=>value.includes('<<<编辑基线开始>>>\n'));assert.ok(actual,'真实 Loop 的 R1/R2 均收到完整编辑基线')
    const start=actual.indexOf('<<<编辑基线开始>>>\n')+'<<<编辑基线开始>>>\n'.length,end=actual.indexOf('\n<<<编辑基线结束>>>',start)
    assert.equal(actual.slice(start,end),revision.originalText,'多标题、表格、CRLF、Unicode与末尾换行逐字保留')
    assert.ok(actual.includes(artifactRevisionScope)&&actual.includes(baseline.sha256))
    assert.match(actual,/基线不提供可引用的 passage.*不能.*用作 basis/)
    assert.match(actual,/缺失章节不能因为当前稿的块索引里没有它就判为通过/)
   }
   const delivery=f.events().find(event=>event.type==='user/message'&&event.data.source.kind==='plugin:teloa.delivery-review'&&Reflect.get(event.data.source,'summary')==='复核后交付')
   assert.ok(delivery?.type==='user/message');assert.equal(Reflect.get(delivery.data.source,'sourceCatalogSha256'),material.catalog.sha256,'实际两轮回执绑定包含编辑基线的冻结摘要')
  }
 })
})
test('当前任务优先：起草与复核的实际请求带同一句任务期限与范围优先约定；复核清单不再引导以超出任务期限的观察补足方法要求',async t=>{
 const f=await fixture(t,'MiniMax-M3',[text(draft),submit(noChange()),submit(verify())])
 await f.ports.send(f.run,f.signal,f.target);await f.agent.whenIdle()
 assert.deepEqual(ends(f.events()),['completed'])
 const [drafting,review]=f.adapter.requests.map(requestTexts)
 const priority=/The current task overrides conflicting skill deadlines\/scope\.[\s\S]*?outside material\./.exec(drafting!.join('\n'))?.[0]
 assert.ok(priority,'起草请求带任务优先约定')
 const reviewMessage=review!.find(message=>message.includes('交付复核（宿主固定步骤'))
 assert.ok(reviewMessage?.includes(priority),'复核要求逐字带起草阶段的同一句任务优先约定，不另维护一份')
 for(const forbidden of ['do not extend time','fill gaps from model knowledge/outside material'])assert.ok(priority.includes(forbidden),'方法做不到时只能受限或降级：'+forbidden)
 assert.ok([...drafting!,...review!].every(message=>!message.includes('不用短期行为替代原方法要求的长期证据')),'不再把方法的长期观察引导为超出任务期限的补足')
})

test('可判定前提：真实 Loop 起草与两轮复核先区分缺测、有效零值和流程停止，再对有效观测划分业务结果',async t=>{
 // 真实诊断中，复核为补齐排他区间把不可测并入零值并否证假设；此例只验证共享约定的实际请求接线，不冒充模型语义验收。
 const goal='资料：指标甲尚未测得；指标乙有效观测值为 0。先核对观测与比较前提；采集失败可停止流程，但不能据此认定业务假设失败。'
 const input=JSON.stringify({...JSON.parse(goalSnapshot),task:{id:'task',version:3,goal}})
 const invalid='指标甲无法测得，等于实测为零，因此业务假设失败。'
 const corrected='指标甲缺少有效观测，业务结论尚不可判定；可按方法停止采集流程。'
 const retained='指标乙有效观测值为 0，按原方法阈值判定。'
 const f=await fixture(t,'MiniMax-M3',[text(invalid+'\n\n'+retained),submit(revision([{blockId:1,after:corrected}],goal)),submit(verify(['r1:u1:i1']))])
 await f.ports.send({...f.run,inputText:input},f.signal,f.target);await f.agent.whenIdle()
 assert.deepEqual(ends(f.events()),['completed'])
 assert.equal(f.adapter.requests.length,3,'仍是起草与最多两轮结构化复核，不新增模型步骤')
 assert.deepEqual(efforts(f.adapter),['high','high','high'])
 assert.equal(readTaskRunGroupResult(f.events(),'rpc'),corrected+'\n\n'+retained,'仅验证回放计划经原块替换生效，不把回放答案当模型质量')
 const assertObservationGate=(message:string)=>{
  assert.match(message,/Check observation\/comparison prerequisites before judging outcomes/,'分类前先核观测有效性与可比性')
  assert.match(message,/missing\/unmeasurable is not measured zero or disproval/,'未知不能进入零值或否证结果桶')
  assert.match(message,/valid zero\/failure may meet the original criterion/,'不排除真实零值或失败')
  assert.match(message,/Distinguish collection-related process stop from business-hypothesis failure/,'保留方法的流程停止出口')
 }
 const drafting=f.adapter.requests[0]!
 const methodNotices=drafting.messages.filter(message=>requestTexts({...drafting,messages:[message]}).join('\n').includes('Selected skills supply methods and output contracts'))
 assert.equal(methodNotices.length,1,'共享方法约定只进一份实际system，不重复附到用户输入')
 assert.equal(methodNotices[0]!.role,'system');assertObservationGate(requestTexts({...drafting,messages:[methodNotices[0]!]}).join('\n'))
 for(const request of f.adapter.requests){
  assert.ok(request.messages.some(message=>message.role==='user'&&message.content.some(part=>part.type==='text'&&part.text===input)),'原目标、完整参考与方法快照不改写')
  for(const method of fixedSkills)assert.ok(request.messages.some(message=>message.role==='system'&&message.content.some(part=>part.type==='text'&&part.text.includes(method.content))),'固定方法原文逐字送达')
 }
 for(const request of f.adapter.requests.slice(1)){
  const review=requestTexts(request).find(message=>message.includes('交付复核（宿主固定步骤'))
  assert.ok(review)
  assertObservationGate(review)
  const threshold=review.split('\n').find(line=>line.startsWith('3. '))
  assert.match(threshold??'',/^3\. 前提成立的有效观测进入判定区间或验收判据后，按明确顺序排他/,'第 3 项仅穷尽可判定的有效观测，不把未知强塞最后一档')
  assert.equal(review.split('\n').filter(line=>/^[1-9]\. /.test(line)).length,8,'只澄清原规则，不叠加第九项')
 }
})

test('提案与事实边界：真实 Loop 允许有理由的设计参数，保观测前提并明确 retain 不是整稿验收豁免',async t=>{
 // 只验证正式请求中的契约及原两轮接线；回放的修正与接受不冒充真实模型语义通过。
 const goal='请提出一项两天内的小成本实验，明确建议样本、量化阈值与下一步；资料未给设备下次维护时间。区分建议设计参数与尚待核实的观测资格。'
 const input=JSON.stringify({...JSON.parse(goalSnapshot),task:{id:'task',version:3,goal}})
 const original='建议：样本规模和判定阈值均未在资料给出，因此只能全部留待本人补齐。'
 const proposed='建议：提出小样本与预先量化的判定阈值并说明取舍；这些是方案参数，不是已测事实。'
 const retained='下次维护时间未知，须先核实是否落在实验窗口内；不可观测不作实测零值。'
 const tail='有效结果按明确顺序唯一归档；待核实项与后续观察另列。'
 const plan:Revision={phase:'revise',issues:[{problem:'任务要求提出设计参数，不能仅因资料未给就全部退为缺项；观测前提仍保留未知。',basis:[goalBasis(goal)],affectedBlockIds:[1,2],coverage:coverageFor(3,[1],[2]),edits:[{blockId:1,after:proposed}]}]}
 const f=await fixture(t,'MiniMax-M3',[text([original,retained,tail].join('\n\n')),submit(plan),submit(verify(['r1:u1:i1'],[[1,2]]))])
 await f.ports.send({...f.run,inputText:input},f.signal,f.target);await f.agent.whenIdle()
 assert.deepEqual(ends(f.events()),['completed'])
 assert.equal(f.adapter.requests.length,3,'只保原起草/R1/R2，不新增模型步骤')
 assert.deepEqual(efforts(f.adapter),['high','high','high'])
 assert.ok(f.adapter.requests.every(request=>request.maxTokens===65536))
 assert.equal(readTaskRunGroupResult(f.events(),'rpc'),[proposed,retained,tail].join('\n\n'))
 const reviews=f.adapter.requests.slice(1).map(request=>requestTexts(request).find(message=>message.includes('交付复核（宿主固定步骤'))!)
 await t.test('设计参数允许提出而不伪造事实，真实起草及两轮复核共享此边界',()=>{
  for(const [index,request] of f.adapter.requests.entries()){
   const messages=index===0?['system'].map(role=>request.messages.find(message=>message.role===role&&requestTexts({...request,messages:[message]}).join('\n').includes('Selected skills supply methods and output contracts'))).map(message=>message&&requestTexts({...request,messages:[message]}).join('\n')):[reviews[index-1]]
   for(const message of messages){
    assert.ok(message,'真实起草的单份系统方法约定及R1/R2均含事实与提案边界')
    assert.match(message,/propose explicitly labeled concrete sample sizes, interventions, thresholds, later scale\/cycles/)
    assert.match(message,/reasons\/tradeoffs/)
    assert.match(message,/even if absent from the source; do not replace all design choices with missing fields/)
    assert.match(message,/Proposed parameters do not establish implementation resources, participant eligibility or event cycles/)
   }
   assert.ok(request.messages.some(message=>message.role==='user'&&message.content.some(part=>part.type==='text'&&part.text===input)),'原材料逐字不改')
  }
 })
 await t.test('保留块不等于已确认，R1/R2仍须检查修后整稿和唯一结果分支',()=>{
  for(const review of reviews){
   assert.ok(review)
   assert.match(review,/retain 只表示保留原文，不表示该块已获事实确认或可豁免修改后整稿一致性检查/)
   assert.match(review,/依赖它的计数、理由、判定分支、下一步与结论/)
   assert.match(review,/有效观测的分支按明确顺序互斥且无空档/)
   assert.equal(review.split('\n').filter(line=>/^[1-9]\. /.test(line)).length,8,'不增删原八项检查')
  }
 })
})

test('长稿各单元的真实请求区分整稿 coverage 与单元编辑范围，不让模型只枚举当前单元',async t=>{
 const longDraft=Array.from({length:4},(_,index)=>`## 部分 ${index+1}\n\n`+'已知：1 家已付款。'.repeat(210)).join('\n\n')
 const blocks=splitReviewBlocks(longDraft),units=splitReviewUnits(longDraft)
 assert.ok(units.length>1)
 const f=await fixture(t,'MiniMax-M3',[text(longDraft),...units.map(()=>submit(noChange())),...units.map(()=>submit(verify()))])
 await f.ports.send(f.run,f.signal,f.target);await f.agent.whenIdle()
 assert.deepEqual(ends(f.events()),['completed'])
 assert.equal(readTaskRunGroupResult(f.events(),'rpc'),longDraft)
 assert.equal(f.adapter.requests.length,1+2*units.length,'保持两轮及原单元数，不追加重试')
 for(const request of f.adapter.requests.slice(1,1+units.length)){
  const prompt=requestTexts(request).find(message=>message.includes('本次复核单元：'))!
  assert.ok(prompt)
  assert.ok(prompt.includes(`本轮整稿共 ${blocks.length} 块`),'每个实际R1请求带整稿块数，而非单元块数')
  assert.ok(prompt.includes(`不重不漏覆盖编号 1 至 ${blocks.length}`),'coverage仍覆盖冻结整稿，不放宽校验')
  assert.match(prompt,/不能只覆盖本单元/)
  assert.match(prompt,/edits\[\]\.blockId 才只限下方本单元块编号/)
 }
 assert.ok(f.adapter.requests.every(request=>request.reasoningEffort==='high'&&request.maxTokens===65536),'不改变原档位与输出上限')
})

test('其他推理模型的复核请求保持路由档位；复核回执参数不符合声明格式时收为错误，不交付、不回退草稿',async t=>{
 await t.test('其他模型',async sub=>{
  const f=await fixture(sub,'other-reasoning',[text(draft),submit(noChange()),submit(verify())])
  await f.ports.send(f.run,f.signal,f.target);await f.agent.whenIdle()
  assert.deepEqual(efforts(f.adapter),['high','high','high'],'其他模型同样保持固定路由档位')
  assert.equal(readTaskRunGroupResult(f.events(),'rpc'),draft)
 })
 await t.test('回执连续缺 after：纠参仍用原固定档位，第二次错误即结束',async sub=>{
  const invalid={phase:'revise',issues:[{problem:'须改正无据推论。',basis:[goalBasis('资料：1 家已付款。')],affectedBlockIds:[1],coverage:coverageFor(2,[1]),edits:[{blockId:1}]}]}
  const f=await fixture(sub,'MiniMax-M3',[text(draft),submit(invalid),submit(invalid),text('不应出现')])
  await f.ports.send(f.run,f.signal,f.target);await f.agent.whenIdle()
  assert.deepEqual(efforts(f.adapter),['high','high','high'])
  assert.deepEqual(ends(f.events()),['error'],'第 1 轮纠参仍不合格即收错，不追加轮次')
  assert.equal(readTaskRunGroupResult(f.events(),'rpc'),undefined,'没有交付，草稿不冒充结果')
  assert.ok(f.events().some(event=>event.type==='tool/result'&&event.data.message.isError===true),'参数校验失败如实落为错误工具结果')
 })
})

test('legacy 回执解析辅助：按宿主块编号整块替换、删除写空字符串、不复述原文；参数多余字段（含旧契约 snapshotHash，抄对抄错一样）或类型不符判为格式错误',()=>{
 const editPlan={edits:[{blockId:1,after:'结论：1 家已付款。'}]}
 const blocks=splitReviewBlocks(draft)
 const prompt=deliveryReviewPrompt({goal:'资料：1 家已付款。',inputs:{knowledge:0,group:false,context:false},methods:[{name:skill.name,sha256:skill.sha256}],catalog:createReviewSourceCatalog([{id:'goal',kind:'goal',title:'原目标',text:'资料：1 家已付款。',origin:{field:'inputText',pointer:'/task/goal'}}])},{index:0,total:1,blockCount:blocks.length,tag,blocks:blocks.map((block,position)=>({id:position+1,text:draft.slice(block.start,block.end)}))})
 assert.ok(prompt.includes('after')&&prompt.includes('revise'),'当前R1保持整块替换，旧解析辅助独立保留')
 assert.ok(!prompt.includes(tag.end)&&prompt.includes(reviewBlockLabel(tag,1)+'\n结论：1 家已付款（且必然续费）。'),'只给带编号的块，不再给文本结束标签')
 assert.ok(!prompt.includes('<<<原文>>>'),'不使用旧锚点替换协议；新basis引用与此不同')
 const all={first:0,last:blocks.length-1}
 const read=readReviewSubmission(editPlan,draft,blocks,all)
 assert.ok(!('reason' in read))
 assert.deepEqual(applyPlanEdits(draft,read.edits),{text:finalText,edits:1})
 const removal=readReviewSubmission({edits:[{blockId:2,after:''}]},draft,blocks,all)
 assert.ok(!('reason' in removal))
 assert.deepEqual(applyPlanEdits(draft,removal.edits),{text:'结论：1 家已付款（且必然续费）。\n\n',edits:1},'删除只删块本身')
 for(const args of [{...editPlan,note:'x'},{edits:[{blockId:'1',after:'x'}]},{edits:[{blockId:1.5,after:'x'}]},{},{...editPlan,snapshotHash:draftSha256(draft)},{...editPlan,snapshotHash:draftSha256('别的')},'草稿 SHA-256：'+draftSha256(draft)])
  assert.deepEqual(readReviewSubmission(args,draft,blocks,all),{reason:'shape'},JSON.stringify(args))
 assert.ok(!prompt.includes(draftSha256(draft))&&!prompt.includes('snapshotHash'),'提示不给待抄摘要，也不要求填写')
})


test('实际发送目录：experience裁剪记忆后才装复核租约，保数字JSON原文及完整资料，旧memory不进入R1/R2依据',async t=>{
 const snapshot={...JSON.parse(goalSnapshot),role:{id:'role',version:3},memory:{privateNote:'只在冻结审计里的旧记忆，不应进入模型或复核依据。'},businessContext:{knownCount:0}}
 const input=JSON.stringify(snapshot),sent=taskInputWithoutMemory(input),draft='已知计数尚待核实。',final='当前已知计数为 0。'
 const f=await fixture(t,'MiniMax-M3',[text(draft)])
 f.ports.employeeExperienceEnabled=async()=>true
 const run={...f.run,inputText:input}
 const bound=taskRunReviewMaterial(run,sent);assert.ok(!('skip'in bound))
 const reference=passageBasis(bound.catalog,'input','"knownCount":0')
 const revise:Revision={phase:'revise',issues:[{problem:'数字计数必须按本次固定输入表述。',basis:[reference],affectedBlockIds:[1],coverage:coverageFor(1,[1]),edits:[{blockId:1,after:final}]}]}
 f.adapter.replies.push(submit(revise),submit(verify(['r1:u1:i1'])))
 await f.ports.send(run,f.signal,f.target);await f.agent.whenIdle()
 assert.deepEqual(ends(f.events()),['completed']);assert.equal(f.adapter.requests.length,3)
 assert.equal(readTaskRunGroupResult(f.events(),'rpc'),final)
 assert.ok(!sent.includes(snapshot.memory.privateNote)&&sent.includes('"knownCount":0'))
 for(const request of f.adapter.requests){
  const messages=requestTexts(request)
  assert.ok(request.messages.some(message=>message.role==='user'&&message.content.some(part=>part.type==='text'&&part.text===sent)),'目录绑定的整段固定输入就是实际发送值')
  assert.ok(!JSON.stringify(request).includes(snapshot.memory.privateNote),'起草和R1/R2都不回带裁去的记忆')
  assert.equal(request.maxTokens,65536);assert.equal(request.reasoningEffort,'high')
  for(const reference of fixedKnowledge)assert.ok(messages.some(message=>message.includes(reference.text)))
 }
 const actual=bound.catalog.sources.find(source=>source.id==='input')!
 assert.equal(actual.text,sent);assert.equal(actual.sha256,draftSha256(sent));assert.deepEqual(actual.origin,{field:'inputText',pointer:''})
 assert.ok(bound.catalog.sources.every(source=>!source.text.includes(snapshot.memory.privateNote)))
 const delivery=f.events().find(event=>event.type==='user/message'&&Reflect.get(event.data.source,'summary')==='复核后交付')!
 assert.ok(delivery.type==='user/message')
 const rounds=Reflect.get(delivery.data.source,'rounds') as {units:{issues:{basis:unknown[]}[]}[]}[]
 const passage=bound.catalog.passages.find(passage=>passage.sourceId===reference.sourceId&&passage.id===reference.passageId)!
 assert.deepEqual(rounds[0]!.units[0]!.issues[0]!.basis,[{...reference,sourceSha256:actual.sha256,quote:actual.text.slice(passage.start,passage.end)}],'宿主按冻结input的真实片段持久化原文与来源SHA，而不是抄模型引文')
 const results=f.events().filter(event=>event.type==='tool/result')
 assert.ok(results.length===2&&results.every(event=>JSON.stringify(event.data.message).includes(bound.catalog.sha256)),'两轮真实ACK绑定同一个实际发送目录摘要')
})

// 真实失败的普通正文与公开回执参数：只回放合成资料，不读取原生推理或调用外部模型。
const omittedCoverageDraft="# 行动清单\n\n| # | 事项 | 负责人 | 截止日期 |\n|---|---|---|---|\n| 1 | 供应商回访 | 小林 | 2026-10-20 |\n| 2 | 预算复核 | 阿文 | 2026-10-21 |\n\n# 风险与下一步\n\n**预算与节奏（基于本轮合成事实）**\n\n- 剩余预算：总预算 12,000 元 − 已支出 4,500 元 = **7,500 元**。两项待办在收口前，建议暂缓新增非必要支出，避免预算后段被动收紧。\n- 截止节点：两项行动截止日期均落在本周内（2026-10-20、2026-10-21），任一项延迟都会顺延到下周，建议在节点上提前对齐。\n\n**建议后续动作（仅作为建议，非已发生事项）**\n\n- 小林：按 2026-10-20 节点完成供应商回访，并形成简短的回访纪要；建议在回访前先确认联系人与议题，避免临期被动。\n- 阿文：按 2026-10-21 节点完成预算复核；建议把已支出 4,500 元逐项对齐到凭证或台账，并就剩余 7,500 元给出可释放额度结论。\n- 收口对齐：两项完成后建议做一次简短的复盘，确认是否存在跨项影响（例如供应商回访结论是否触发预算调整）。\n\n> 说明：本交付仅基于任务提供的合成事实；未引入其他业务资料、文件或外部工具；预算核算为可直接验证的算术结果。"
const omittedCoverageSubmission={"phase": "revise", "issues": [{"problem": "块 6 断言两项行动截止日期「均落在本周内」并称「任一项延迟都会顺延到下周」。原目标只给出 2026-10-20 与 2026-10-21 两个日期与负责人，并未定义本周/下周的工作日边界；任务说明也明确「当前系统日期只是运行参照，不据此新增交付中的业务日期或时间窗口」。因此「本周内 / 下周」属于合成事实之外、未经资料支持的判断性陈述，需改写为只引用截止日期本身、不引入周界划分的事实表述。", "basis": [{"sourceId": "goal", "passageId": "p1"}], "affectedBlockIds": [6, 7, 8, 9, 10], "coverage": {"change": [6], "retain": [7, 8, 9, 10], "unrelated": [1, 2, 3, 4, 11], "unknown": []}, "edits": [{"blockId": 6, "after": "- 截止节点：两项行动截止日期分别为 2026-10-20 与 2026-10-21，间隔仅一天，建议在节点前预留确认与交接时间，避免临期被动。"}]}]}
const unlistedGoal='请用通用 Agent 独立整理一份周会行动单，不创建员工，不读取真实资料，不使用文件、网页或其他外部工具。仅使用这些合成事实：小林负责供应商回访，截止2026年10月20日；阿文负责预算复核，截止2026年10月21日；总预算12000元，已支出4500元。交付 Markdown，包含「行动清单」和「风险与下一步」，保留负责人、截止日期，并正确算出剩余预算。'
const unlistedRunInput=()=>JSON.stringify({...JSON.parse(goalSnapshot),task:{id:'task',version:3,goal:unlistedGoal}})
const explicitUnlistedSubmission=()=>{
 const raw=structuredClone(omittedCoverageSubmission)
 return {...raw,issues:raw.issues.map(issue=>({...issue,coverage:{...issue.coverage,unlisted:'retain' as const}}))}
}

test('显式保留未列块：真实SDK将漏列5展开到完整元数据和R2，冷读仍核原生声明',async t=>{
 const r1=explicitUnlistedSubmission(),expected=omittedCoverageDraft.replace(omittedCoverageDraft.slice(splitReviewBlocks(omittedCoverageDraft)[5]!.start,splitReviewBlocks(omittedCoverageDraft)[5]!.end),r1.issues[0]!.edits[0]!.after)
 assert.equal(splitReviewBlocks(omittedCoverageDraft).length,11)
 const f=await fixture(t,'MiniMax-M3',[text(omittedCoverageDraft),submit(r1),submit(verify(['r1:u1:i1'],[[5,6,7,8,9,10]]))])
 await f.ports.send({...f.run,inputText:unlistedRunInput()},f.signal,f.target);await f.agent.whenIdle()
 assert.deepEqual(ends(f.events()),['completed'])
 assert.equal(f.adapter.requests.length,3,'仍只起草/R1/R2，不增加修复请求')
 assert.equal(readTaskRunGroupResult(structuredClone(f.events()),'rpc'),expected,'冷读从原生显式声明重算，不能仅信绿色元数据')
 const delivered=f.events().find(event=>event.type==='user/message'&&Reflect.get(event.data.source,'summary')==='复核后交付');assert.ok(delivered?.type==='user/message')
 const rounds=Reflect.get(delivered.data.source,'rounds') as {units:{issues?:{coverage:{change:number[];retain:number[];unrelated:number[];unknown:number[]};affectedBlockIds:number[]}[];changeChecks?:{reviewedBlockIds:number[]}[]}[]}[]
 const issue=rounds[0]!.units[0]!.issues![0]!
 assert.deepEqual(issue.coverage,{change:[6],retain:[7,8,9,10,5],unrelated:[1,2,3,4,11],unknown:[]})
 assert.deepEqual(issue.affectedBlockIds,[6,7,8,9,10,5])
 assert.deepEqual(rounds[1]!.units[0]!.changeChecks![0]!.reviewedBlockIds,[5,6,7,8,9,10])
 const r2=f.adapter.requests[2]!,prompt=JSON.stringify(r2.messages)
 assert.ok(prompt.includes('宿主当前依赖块核对表'))
 assert.ok(prompt.includes('[5,6,7,8,9,10]'),'默认retain块5实际进入R2要求，retain不是通过')
 const calls=f.events().filter(event=>event.type==='tool/call');assert.equal(calls.length,2)
 assert.deepEqual(typeof calls[0]!.data.arguments==='string'?JSON.parse(calls[0]!.data.arguments):calls[0]!.data.arguments,r1,'原native wire不被宿主补写编号')
 const schema=JSON.stringify(f.adapter.requests[1]!.tools)
 assert.ok(schema.includes('unlisted')&&schema.includes('retain'),'真实请求schema提供可选显式声明')
 for(const mutation of ['remove-native-declaration','remove-r2-block','unknown-r2'] as const){
  const events=structuredClone(f.events())
  if(mutation==='remove-native-declaration'){
   const call=events.find(event=>event.type==='tool/call');assert.ok(call?.type==='tool/call')
   const args=structuredClone(typeof call.data.arguments==='string'?JSON.parse(call.data.arguments):call.data.arguments) as typeof r1
   Reflect.deleteProperty(args.issues[0]!.coverage,'unlisted')
   const changed=typeof call.data.arguments==='string'?JSON.stringify(args):args;Reflect.set(call.data,'arguments',changed)
   const message=events.find(event=>event.type==='assistant/message'&&event.data.turn===call.data.turn&&event.data.step===call.data.step);assert.ok(message?.type==='assistant/message')
   const native=message.data.message.content.find(part=>part.type==='tool-call');assert.ok(native?.type==='tool-call');Reflect.set(native,'arguments',structuredClone(changed))
  }else{
   const delivery=events.find(event=>event.seq===delivered.seq);assert.ok(delivery?.type==='user/message')
   const changed=Reflect.get(delivery.data.source,'rounds') as typeof rounds
   if(mutation==='remove-r2-block')changed[1]!.units[0]!.changeChecks![0]!.reviewedBlockIds=[6,7,8,9,10]
   else Reflect.set(changed[1]!.units[0]!.changeChecks![0]!,'status','unknown')
  }
  assert.equal(readTaskRunGroupResult(events,'rpc'),undefined,mutation)
 }
})

test('显式保留未列块：R2实际少核默认retain块或unknown不得交付',async t=>{
 for(const mode of ['missing','unknown'] as const)await t.test(mode,async sub=>{
  const acceptance=verify(['r1:u1:i1'],[[5,6,7,8,9,10]])
  if(mode==='missing')acceptance.changeChecks[0]!.reviewedBlockIds=[6,7,8,9,10]
  else acceptance.changeChecks[0]!.status='unknown'
  // 同一不合格验收连续两次，耗尽整租约唯一纠正名额。
  const f=await fixture(sub,'MiniMax-M3',[text(omittedCoverageDraft),submit(explicitUnlistedSubmission()),submit(acceptance),submit(acceptance)])
  await f.ports.send({...f.run,inputText:unlistedRunInput()},f.signal,f.target);await f.agent.whenIdle()
  assert.deepEqual(ends(f.events()),['error']);assert.equal(f.adapter.requests.length,4,'应到真正R2后拒绝（含一次同轮纠正），不能由R1提前失败冒负例通过')
  assert.deepEqual(f.events().flatMap(event=>event.type==='tool/result'?[event.data.message.isError]:[]),[false,true,true],'R1成功，R2两次验收都被拒')
  assert.equal(readTaskRunGroupResult(f.events(),'rpc'),undefined)
 })
})

test('显式保留未列块：原未声明的漏块回执仍在R1失败，唯一纠正名额用尽后不重写旧红',async t=>{
 const f=await fixture(t,'MiniMax-M3',[text(omittedCoverageDraft),submit(omittedCoverageSubmission),submit(omittedCoverageSubmission),submit(verify())])
 await f.ports.send({...f.run,inputText:unlistedRunInput()},f.signal,f.target);await f.agent.whenIdle()
 assert.deepEqual(ends(f.events()),['error']);assert.equal(f.adapter.requests.length,3,'同一漏块回执纠正一次仍失败即收错，不进入R2');assert.equal(readTaskRunGroupResult(f.events(),'rpc'),undefined)
 const results=f.events().filter(event=>event.type==='tool/result');assert.equal(results.length,2)
 for(const result of results){assert.ok(result.type==='tool/result');assert.ok(result.data.message.isError);assert.match(JSON.stringify(result.data.message.content),/coverage/)}
})

// 278实次42块分区的通用形状：四集合已完整，只在旧冗余affected漏了显式retain。
const scopeCoverage={"change": [24], "retain": [3, 4, 7, 9, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42], "unrelated": [1, 2, 5, 6, 8, 10], "unknown": []}
const scopeDraft=Array.from({length:42},(_,index)=>`资料第 ${index+1} 段。`).join('\n\n')
const scopeRelated=[...scopeCoverage.change,...scopeCoverage.retain].sort((a,b)=>a-b)
const legacyScopeIssue=()=>({problem:'修改结论时须同时核对其相关保留段，保留不表示事实通过。',basis:[goalBasis('资料：1 家已付款。')],affectedBlockIds:[24],coverage:structuredClone(scopeCoverage),edits:[{blockId:24,after:'资料第 24 段：仅按原输入陈述。'}]})
// 当前 coverage 简写按模型可见 schema 必须显式写 unlisted:"retain"；四集合已完整时不展开额外块。
const scopedSubmission=()=>{const {affectedBlockIds:_redundant,...issue}=legacyScopeIssue();return {phase:'revise',issues:[{...issue,affectedScope:'coverage' as const,coverage:{...issue.coverage,unlisted:'retain' as const}}]}}

test('coverage作用域：真实SDK从完整42块分区派生相关块，原wire与冷读精确绑定',async t=>{
 const r1=scopedSubmission(),blocks=splitReviewBlocks(scopeDraft),expected=scopeDraft.slice(0,blocks[23]!.start)+r1.issues[0]!.edits[0]!.after+scopeDraft.slice(blocks[23]!.end)
 assert.equal(blocks.length,42);assert.equal(scopeRelated.length,36)
 const f=await fixture(t,'MiniMax-M3',[text(scopeDraft),submit(r1),submit(verify(['r1:u1:i1'],[scopeRelated]))])
 await f.ports.send(f.run,f.signal,f.target);await f.agent.whenIdle()
 assert.deepEqual(ends(f.events()),['completed']);assert.equal(f.adapter.requests.length,3)
 assert.equal(readTaskRunGroupResult(structuredClone(f.events()),'rpc'),expected)
 const delivery=f.events().find(event=>event.type==='user/message'&&Reflect.get(event.data.source,'summary')==='复核后交付');assert.ok(delivery?.type==='user/message')
 const rounds=Reflect.get(delivery.data.source,'rounds') as {units:{issues?:{affectedBlockIds:number[];coverage:typeof scopeCoverage}[];changeChecks?:{reviewedBlockIds:number[]}[]}[]}[]
 assert.deepEqual(rounds[0]!.units[0]!.issues![0]!.affectedBlockIds,[...scopeCoverage.change,...scopeCoverage.retain])
 assert.deepEqual(rounds[0]!.units[0]!.issues![0]!.coverage,scopeCoverage)
 assert.deepEqual(rounds[1]!.units[0]!.changeChecks![0]!.reviewedBlockIds,scopeRelated)
 const calls=f.events().filter(event=>event.type==='tool/call');const native=calls[0]!.data.arguments
 assert.deepEqual(typeof native==='string'?JSON.parse(native):native,r1,'宿主不改原scope wire为伪造的完整IDs')
 const tool=f.adapter.requests[1]!.tools?.find(tool=>tool.name===deliveryReviewToolName);assert.ok(tool)
 const schema=tool.parameters as {properties?:{issues?:{items?:{oneOf?:unknown;required?:string[];properties?:Record<string,unknown>;additionalProperties?:boolean}}}}
 const item=schema.properties?.issues?.items;assert.ok(item)
 assert.deepEqual(Object.keys(schema.properties??{}),['phase','issues'],'模型只看到当前修订阶段的字段')
 assert.equal(item.oneOf,undefined);assert.deepEqual(Object.keys(item.properties??{}).filter(key=>key==='affectedScope'||key==='affectedBlockIds'),['affectedScope'])
 assert.ok(item.required?.includes('affectedScope'));assert.equal(item.additionalProperties,false)
 assert.deepEqual(Object.keys(f.adapter.requests[2]!.tools![0]!.parameters.properties??{}),['phase','verdict','checks','changeChecks','findings'],'R2切到验收字段，不再展示编辑形状')
 const cold=structuredClone(f.events()),call=cold.find(event=>event.type==='tool/call');assert.ok(call?.type==='tool/call')
 const old={phase:'revise',issues:[legacyScopeIssue()]},changed=typeof call.data.arguments==='string'?JSON.stringify(old):old
 Reflect.set(call.data,'arguments',changed)
 const assistant=cold.find(event=>event.type==='assistant/message'&&event.data.step===call.data.step&&event.data.turn===call.data.turn);assert.ok(assistant?.type==='assistant/message')
 const part=assistant.data.message.content.find(part=>part.type==='tool-call');assert.ok(part?.type==='tool-call');Reflect.set(part,'arguments',structuredClone(changed))
 assert.equal(readTaskRunGroupResult(cold,'rpc'),undefined,'冷读不能只凭canonical元数据替原无声明错误补来源')
})

test('coverage作用域：R2漏掉显式retain或未知仍在真实第三请求拒绝',async t=>{
 for(const mode of ['missing-retain','unknown'] as const)await t.test(mode,async sub=>{
  const acceptance=verify(['r1:u1:i1'],[scopeRelated])
  if(mode==='missing-retain')acceptance.changeChecks[0]!.reviewedBlockIds=scopeRelated.filter(id=>id!==3)
  else acceptance.changeChecks[0]!.status='unknown'
  // 同一不合格验收连续两次，耗尽整租约唯一纠正名额；R1 须先成功，不能由 R1 提前失败冒负例通过。
  const f=await fixture(sub,'MiniMax-M3',[text(scopeDraft),submit(scopedSubmission()),submit(acceptance),submit(acceptance)])
  await f.ports.send(f.run,f.signal,f.target);await f.agent.whenIdle()
  assert.deepEqual(ends(f.events()),['error']);assert.equal(f.adapter.requests.length,4);assert.equal(readTaskRunGroupResult(f.events(),'rpc'),undefined)
  assert.deepEqual(f.events().flatMap(event=>event.type==='tool/result'?[event.data.message.isError]:[]),[false,true,true])
 })
})

test('coverage作用域：原42块完整coverage但IDs漏retain无显式声明仍严格拒绝，唯一纠正名额用尽后收错',async t=>{
 const f=await fixture(t,'MiniMax-M3',[text(scopeDraft),submit({phase:'revise',issues:[legacyScopeIssue()]}),submit({phase:'revise',issues:[legacyScopeIssue()]}),submit(verify())])
 await f.ports.send(f.run,f.signal,f.target);await f.agent.whenIdle()
 assert.deepEqual(ends(f.events()),['error']);assert.equal(f.adapter.requests.length,3);assert.deepEqual(f.events().flatMap(event=>event.type==='tool/result'?[event.data.message.isError]:[]),[true,true]);assert.equal(readTaskRunGroupResult(f.events(),'rpc'),undefined)
})

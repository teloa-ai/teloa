import test,{type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import {Context} from '@deepseek-ai/cordis'
import {AgentRegistry,type Agent} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {LlmAdapter,LlmRuntime,ToolCallId,createUserMessage,type GenerateOptions,type StreamChunk,type UserMessage} from '@deepseek-ai/dsh-llm'
import {SessionId,SessionStore,type SessionEvent} from '@deepseek-ai/dsh-session'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {applyDeliveryPlan,applyPlanEdits,revisionBlockMap,deliveryReviewSource,deliveryReviewToolName,draftSha256,leaseTaskDeliveryReview,readDeliveryPlan,reviewBlockLabel,reviewBlockTag,splitReviewBlocks,splitReviewUnits,type DeliveryReviewTrace,type ReviewMaterial} from '../src/task-delivery-review.ts'
import {readTaskRunGroupResult} from '../src/task-run-group-result.ts'
import {readSessionEvents} from '../src/session-events.ts'
import {createReviewSourceCatalog} from '../src/task-delivery-review-protocol.ts'

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
/** 纯文本回复；传入回执参数时改为原生回执调用（以 tool-calls 收尾），截断时则只留被截断的文字（没有完整调用）。 */
const text=(value:string|Submission,reason:'stop'|'max-tokens'='stop'):Reply=>typeof value!=='string'
 ?reason==='stop'?[{type:'block-start',index:0,blockType:'tool-call'},{type:'block-end',index:0,block:{type:'tool-call',id:'review-call-'+(++callSerial),name:deliveryReviewToolName,arguments:value}},{type:'finish',reason:{kind:'tool-calls'}}] as unknown as Reply:text('（复核回执写到一半）',reason)
 :[{type:'block-start',index:0,blockType:'text'},{type:'text-delta',index:0,text:value},{type:'block-end',index:0,block:{type:'text',text:value}},{type:'finish',reason:{kind:reason}}]
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
const goal='资料：12 家试用店。'
const material:ReviewMaterial={goal,inputs:{knowledge:0,group:false,context:false},methods:[],catalog:createReviewSourceCatalog([{id:'goal',kind:'goal',title:'原目标',text:goal,origin:{field:'inputText',pointer:'/task/goal'}}])}
const revise=(edits:Edit[]=[],blockCount=1):Revision=>({phase:'revise',issues:edits.length?[{problem:'本单元结论须与来源一致。',basis:[passageBasis(material.catalog,'goal',goal)],affectedBlockIds:[...new Set(edits.map(edit=>edit.blockId))],coverage:coverageFor(blockCount,edits.map(edit=>edit.blockId)),edits}]:[]})
async function runtime(t:TestContext,replies:Reply[],publish?:(agent:Agent,message:UserMessage,count:number)=>Promise<void>){
 const ctx=new Context();t.after(()=>ctx.fiber.dispose())
 for(const plugin of [LlmRuntime,SessionStore,SessionProjectionRegistry,SystemPrompt,ToolRuntime,AgentRegistry])await ctx.plugin(plugin)
 await ctx.plugin(AgentLoop,{agents:[]})
 const adapter=new ScriptAdapter(replies);ctx.llm.registerAdapter(['script'],adapter)
 const {agent}=await ctx.agents.create({sessionId:SessionId('units-'+t.name),agentOptions:{provider:'script',model:'model'}})
 const traces:DeliveryReviewTrace[]=[]
 let published=0
 leaseTaskDeliveryReview(agent,{runId:'run',requestId:'rpc',material,trace:entry=>{traces.push(entry)},publish:async message=>{published++;if(publish)await publish(agent,message,published);else agent.inject(message)}})
 const send=async()=>{agent.followup(createUserMessage({source:{kind:'user',rpcId:'rpc'},content:[{type:'text',text:'任务'}]}));await agent.whenIdle()}
 return {agent,adapter,traces,send,events:()=>readSessionEvents(agent.session) as readonly SessionEvent[]}
}
const textOf=(message:GenerateOptions['messages'][number])=>message.content.flatMap(block=>block.type==='text'?[block.text]:[]).join('\n')
const ends=(events:readonly SessionEvent[])=>events.flatMap(event=>event.type==='turn/end'?[event.data.reason.kind]:[])
const delivered=(events:readonly SessionEvent[])=>events.filter((event):event is Extract<SessionEvent,{type:'user/message'}>=>event.type==='user/message'&&event.surfaceOp==='append'&&event.data.source.kind===deliveryReviewSource&&Reflect.get(event.data.source,'summary')==='复核后交付')
/** 旧「原文 → 改为」锚点计划（legacy 解析辅助的测试用）。 */
const anchorPlanOf=(snapshot:string,edits:readonly (readonly [string,string])[])=>'草稿 SHA-256：'+draftSha256(snapshot)+'\n'+(edits.length?edits.map(([before,after])=>'<<<原文>>>\n'+before+'\n<<<改为>>>\n'+(after?after+'\n':'')+'<<<结束>>>').join('\n'):'无需修改')
/**
 * 块编号回执：把「原文片段 → 改为」落到包含它的宿主块上，同块多处合并为一项整块新内容；与先前完全相同的片段编辑再写一项
 * 同块同内容的重复项；片段不在任何单个块内时写一个不存在的编号。无编辑时 edits 为空数组。
 */
const planOf=(snapshot:string,edits:readonly (readonly [string,string])[]):Submission=>{
 if(!edits.length)return revise()
 const blocks=splitReviewBlocks(snapshot),tag=reviewBlockTag(snapshot),contents=new Map<number,string>(),order:number[]=[],seen=new Set<string>()
 for(const [before,after] of edits){
  const at=snapshot.indexOf(before),position=at<0?-1:blocks.findIndex(block=>at>=block.start&&at+before.length<=block.end),target=position<0?blocks.length:position
  const key=before+'\u0000'+after
  if(seen.has(key)){order.push(target);continue}
  seen.add(key)
  if(!contents.has(target))order.push(target)
  contents.set(target,position<0?'x':(contents.get(target)??snapshot.slice(blocks[target]!.start,blocks[target]!.end)).replace(before,after))
 }
 return revise(order.map(position=>({blockId:position+1,after:contents.get(position)??''})),blocks.length)
}
/** 宿主给一个单元标注的正文：本单元每个块前一行块标签。 */
const labelledUnit=(snapshot:string,unit:{start:number;end:number})=>{const tag=reviewBlockTag(snapshot);return splitReviewBlocks(snapshot).flatMap((block,position)=>block.start>=unit.start&&block.start<unit.end?[reviewBlockLabel(tag,position+1)+'\n'+snapshot.slice(block.start,block.end)]:[]).join('\n\n')}
/** 三节、每节约 1260 字的长正文：每句因节号与句号唯一，标题行为切分点。 */
const section=(n:number)=>`## 第${n}节\n\n`+Array.from({length:140},(_,j)=>`第${n}节第${j}句内容。`).join('')+'\n'
const longDraft=[section(1),section(2),section(3)].join('\n')

test('复核单元确定性划分：只在代码块外的标题行或段落起点切分，表格与代码块不被劈开，单元首尾相接、拼接逐字节等于原文，最多 4 个',()=>{
 const join=(value:string)=>splitReviewUnits(value).map(unit=>value.slice(unit.start,unit.end)).join('')
 assert.deepEqual(splitReviewUnits('短正文，一段。'),[{start:0,end:7}],'短正文只有一个单元')
 const units=splitReviewUnits(longDraft)
 assert.equal(units.length,3);assert.equal(join(longDraft),longDraft,'拼接逐字节等于原文')
 for(const [index,unit] of units.entries()){assert.equal(unit.start,index===0?0:units[index-1]!.end,'首尾相接');assert.ok(index===0||longDraft.slice(unit.start).startsWith('## '),'在标题行起点切分')}
 assert.deepEqual(splitReviewUnits(longDraft),units,'同一输入划分相同')
 const many=Array.from({length:9},(_,index)=>section(index+1)).join('\n')
 assert.equal(splitReviewUnits(many).length,4,'最多 4 个单元');assert.equal(join(many),many)
 const fenced=section(1)+'\n```\n# 不是标题\n\n仍在代码块里\n```\n'+section(2)
 const fencedUnits=splitReviewUnits(fenced)
 assert.equal(join(fenced),fenced)
 for(const unit of fencedUnits){const body=fenced.slice(unit.start,unit.end);assert.equal((body.match(/```/g)??[]).length%2,0,'代码块不被劈开')}
 const table='| 档 | 条件 |\n|---|---|\n'+Array.from({length:80},(_,index)=>`| 行${index} | 条件${index} |`).join('\n')+'\n'
 const plain=Array.from({length:80},(_,index)=>`段落${index}：`+'内容'.repeat(20)).join('\n\n')+'\n\n'+table
 const plainUnits=splitReviewUnits(plain)
 assert.equal(join(plain),plain)
 assert.ok(plainUnits.length>1,'无标题时按段落起点切分')
 assert.ok(plainUnits.some(unit=>plain.slice(unit.start,unit.end).includes(table)),'表格整体落在同一单元')
})

test('多单元复核：每轮每个单元一次调用，宿主租约把各单元计划绑定到同一完整快照（摘要由宿主写入回执结果）、只改本单元；全部单元通过后原子应用；第 2 轮按新快照重新划分全部确认才交付；调用数为 1+两轮单元数',async t=>{
 const units=splitReviewUnits(longDraft)
 assert.equal(units.length,3)
 // 宿主按任务结果同一规范（去首尾空白）保存一轮应用后的快照，第 2 轮绑定的就是它。
 const after=longDraft.replace('第1节第3句内容。','第1节第3句已核对。').replace('第3节第7句内容。','第3节第7句已核对。').trim()
 const f=await runtime(t,[text(longDraft),
  text(planOf(longDraft,[['第1节第3句内容。','第1节第3句已核对。']])),text(planOf(longDraft,[])),text(planOf(longDraft,[['第3节第7句内容。','第3节第7句已核对。']])),
  text(verify(['r1:u1:i1','r1:u3:i1'],[[2],[6]])),text(verify()),text(verify()),text('多余请求不应出现')])
 await f.send()
 assert.equal(f.adapter.requests.length,1+3+3,'1 次草稿 + 两轮各 3 个单元')
 assert.deepEqual(ends(f.events()),['completed'])
 assert.equal(readTaskRunGroupResult(f.events(),'rpc'),after,'交付是两处单元编辑原子应用后、经第 2 轮全部单元确认的整稿')
 const r2=f.adapter.requests[4]!,firstRoundCalls=f.events().filter(event=>event.type==='tool/call').slice(0,3)
 assert.equal(r2.messages.some(message=>message.role==='assistant'||message.role==='tool'),false,'R2 首单元不带 R1 任何单元的计划或回执')
 for(const event of firstRoundCalls)if(event.type==='tool/call')assert.ok(!JSON.stringify(r2).includes(event.data.callId),'实际 provider options（含 toolHistory）不携带旧调用身份')
 assert.equal(r2.messages.filter(message=>message.role==='user'&&textOf(message).includes('交付复核（宿主固定步骤')).length,1,'R1 所有旧单元要求均退出视图，只留本次要求')
 const review=f.adapter.requests.slice(1).map(request=>textOf(request.messages.filter(message=>message.role==='user').at(-1)!))
 for(const [index,prompt] of review.entries()){
  const round=index<3?longDraft:after,unit=index%3
  assert.ok(prompt.includes(`第 ${unit+1}/3 单元`),'标明单元序号')
  assert.ok(prompt.includes('<<<复核单元开始>>>\n'+labelledUnit(round,splitReviewUnits(round)[unit]!)+'\n<<<复核单元结束>>>'),'附本单元带宿主块编号的完整块')
  assert.ok(!prompt.includes(draftSha256(round)),'复核要求不给模型待抄的快照摘要')
 }
 const source=delivered(f.events())[0]!.data.source
 const rounds=Reflect.get(source,'rounds') as {round:number;edits:number;units:{unit:number;start:number;end:number;edits:number}[]}[]
 assert.deepEqual(rounds.map(entry=>[entry.round,entry.edits,entry.units.map(unit=>[unit.unit,unit.start,unit.end,unit.edits])]),[[1,2,units.map((unit,index)=>[index,unit.start,unit.end,index===1?0:1])],[2,0,splitReviewUnits(after).map((unit,index)=>[index,unit.start,unit.end,0])]])
 assert.equal(delivered(f.events())[0]!.sourceEventSeqs?.length,1+6,'来源指向草稿与 6 份单元回执结果')
 assert.deepEqual(f.traces.filter(entry=>entry.state==='planned').map(entry=>[entry.round,entry.unit,entry.edits]),[[1,0,1],[1,1,0],[1,2,1],[2,0,0],[2,1,0],[2,2,0]])
 // 每份回执结果写宿主绑定的轮次、单元与该轮完整快照摘要；同一轮各单元摘要相同，就是该轮记录的输入摘要。
 const bound=f.events().flatMap(event=>event.type==='tool/result'?[JSON.stringify(event.data.message)]:[])
 assert.equal(bound.length,6)
 bound.forEach((body,index)=>{const round=index<3?1:2;assert.ok(body.includes(`第 ${round} 轮第 ${index%3+1} 单元`)&&body.includes(draftSha256(round===1?longDraft:after)),'回执结果写宿主绑定的轮次、单元与快照摘要')})
 assert.deepEqual(f.traces.filter(entry=>entry.state==='planned').map(entry=>entry.inputSha256),[...Array(3).fill(draftSha256(longDraft)),...Array(3).fill(draftSha256(after))])
 assert.deepEqual(rounds.map(entry=>Reflect.get(entry,'inputSha256')),[draftSha256(longDraft),draftSha256(after)],'轮次记录的输入摘要与回执结果一致')
})

test('多单元失败面：跨单元编辑、某单元计划非法（整轮不部分应用）、某单元截断、第 2 轮仍需修改、单元间取消（共享时限）都不交付；唯一纠正名额用尽后不再追加调用',async t=>{
 const edited=planOf(longDraft,[['第1节第3句内容。','第1节第3句已核对。']])
 // 同一类非法回执连续两次：第一次用掉整租约唯一纠正名额，第二次按原原因收错。
 const crossUnit=planOf(longDraft,[['第2节第5句内容。','x']]),unknownBlock=planOf(longDraft,[['不存在的句子','x']])
 for(const [label,replies,requests,reason,correction] of [
  ['跨单元编辑',[text(longDraft),text(crossUnit),text(crossUnit)],3,'rewrite-plan:edit-range',undefined],
  ['后一单元计划非法时前一单元的编辑也不应用',[text(longDraft),text(edited),text(unknownBlock),text(unknownBlock)],4,'rewrite-plan:affected-blocks',undefined],
  // 长度截断不给补交：原生循环把 max-tokens 记为整轮收尾原因，仍立即收错。
  ['单元截断',[text(longDraft),text(edited),text(planOf(longDraft,[]),'max-tokens')],3,'rewrite-finish:max-tokens',undefined],
 ] as const)await t.test(label,async sub=>{
  const f=await runtime(sub,[...replies,text('不应出现')])
  await f.send()
  assert.equal(f.adapter.requests.length,requests,'纠正名额用尽后不再追加调用')
  assert.deepEqual(ends(f.events()),['error'])
  assert.equal(f.traces.at(-1)!.reason,reason)
  assert.deepEqual(f.traces.filter(entry=>entry.state==='requested'&&entry.reason?.startsWith('correction:')).map(entry=>entry.reason),correction?[correction]:[],'语义拒绝沿错误回执续步不新增输入，截断不发补交提醒')
  assert.ok(!f.traces.some(entry=>entry.state==='applied'),'整轮未原子应用')
  assert.equal(delivered(f.events()).length,0);assert.equal(readTaskRunGroupResult(f.events(),'rpc'),undefined,'草稿与部分编辑都不成为交付')
 })
 await t.test('第 2 轮某单元仍需修改',async sub=>{
  const after=longDraft.replace('第1节第3句内容。','第1节第3句已核对。').trim()
  const f=await runtime(sub,[text(longDraft),text(edited),text(planOf(longDraft,[])),text(planOf(longDraft,[])),text(verify(['r1:u1:i1'],[[2]])),text({...verify(),verdict:'reject',findings:[{problem:'本单元仍有无据结论。',basis:[passageBasis(material.catalog,'goal',goal)],blockIds:[4]}]}),text('R3 只写说明不交回执'),text('补交提醒后仍不交回执'),text('不应出现')])
  await f.send()
  assert.equal(f.adapter.requests.length,8,'R2 有据拒绝后在独立复核预算内进入 R3，不进入 R2 下一单元')
  assert.deepEqual(f.traces.filter(entry=>entry.state==='requested').map(entry=>[entry.round,entry.unit,entry.reason??null]),[[1,0,null],[1,1,null],[1,2,null],[2,0,null],[2,1,null],[3,0,null],[3,0,'correction:plan:missing-submission']])
  assert.ok(!f.traces.some(entry=>entry.reason==='review-repair-budget'),'复核预算与起草步数分开计')
  assert.equal(f.traces.at(-1)!.reason,'rewrite-r3-plan:missing-submission','R3 补交后仍缺交即收错')
  assert.equal(readTaskRunGroupResult(f.events(),'rpc'),undefined)
 })
 await t.test('单元之间取消（共享任务时限）',async sub=>{
  const f=await runtime(sub,[text(longDraft),text(edited),text('不应出现')],async(agent,message,count)=>{if(count===2){agent.cancel({kind:'hook',reason:'任务时限已到'});await Promise.resolve();return}agent.inject(message)})
  await f.send()
  assert.equal(f.adapter.requests.length,2,'取消后不再调用模型')
  assert.deepEqual(ends(f.events()),['aborted'])
  assert.equal(readTaskRunGroupResult(f.events(),'rpc'),undefined)
 })
})

test('复核单元不切开代码围栏：围栏按开启字符与长度配对，只有同字符、长度不小于开启、尾部只有空白的行才关闭；反引号信息串不能含反引号',()=>{
 const filler=(tag:string)=>Array.from({length:140},(_,j)=>`${tag}第${j}行。`).join('')
 /** 两节 + 围栏 + 一节：围栏内含一行看似闭合的围栏、一个 # 行和空行段落；错误配对会把围栏内的 # 行当切点、吞掉后一节标题，并在围栏内切开。 */
 const build=(fence:string)=>section(1)+'\n'+section(2)+'\n'+fence+'\n'+section(3)
 const assertNoCutInside=(label:string,fence:string)=>{
  const text=build(fence),start=text.indexOf(fence),end=start+fence.length,units=splitReviewUnits(text)
  assert.equal(units.map(unit=>text.slice(unit.start,unit.end)).join(''),text,label+'：拼接逐字节等于原文')
  assert.ok(units.length<=4,label)
  for(const unit of units.slice(1))assert.ok(unit.start<=start||unit.start>=end,`${label}：切点 ${unit.start} 落在围栏 [${start},${end}) 内`)
  return units
 }
 // 独立审查 M1 的 A/B/C：不同字符或较短的同字符行不能关闭围栏。
 assertNoCutInside('A 三反引号围栏内的 ~~~','```text\n~~~\n# 仍在围栏内的注释A\n\n'+filler('A')+'\n```\n')
 assertNoCutInside('B 四反引号围栏内单独一行 ```','````markdown\n```\n# 仍在围栏内的注释B\n\n'+filler('B')+'\n````\n')
 assertNoCutInside('C ~~~ 围栏内的 ```','~~~sh\n```\n# 仍在围栏内的注释C\n\n'+filler('C')+'\n~~~\n')
 // 尾部带其他文字的同字符行不是闭合行。
 assertNoCutInside('D 闭合行尾部不能有文字','```\n``` 不是闭合\n# 仍在围栏内的注释D\n\n'+filler('D')+'\n```\n')
 // 对照：普通围栏、四反引号内成对的 ```、表格。
 assertNoCutInside('普通围栏','```\n# 普通围栏内的注释\n\n'+filler('E')+'\n```\n')
 assertNoCutInside('嵌套成对','````markdown\n```js\n# 嵌套内注释\n```\n\n'+filler('F')+'\n````\n')
 const table='| 档 | 条件 |\n|---|---|\n'+Array.from({length:80},(_,index)=>`| 行${index} | 条件${index} |`).join('\n')+'\n'
 const tableUnits=splitReviewUnits(section(1)+'\n'+table+'\n'+section(2))
 const tableText=section(1)+'\n'+table+'\n'+section(2),tableStart=tableText.indexOf(table)
 for(const unit of tableUnits.slice(1))assert.ok(unit.start<=tableStart||unit.start>=tableStart+table.length,'表格不被切开')
 // 围栏正确闭合后，后面的标题仍是切点（不会把整篇当成围栏）。
 const closed=assertNoCutInside('闭合后恢复','```\n代码\n```\n')
 assert.ok(closed.length>1,'围栏闭合后的标题仍可切分')
 // 反引号信息串含反引号的行不开启围栏：其后的标题照常是切点。
 const notFence='``` a`b\n'
 const notFenceText=section(1)+'\n'+notFence+section(2)+'\n'+section(3)
 assert.ok(splitReviewUnits(notFenceText).some(unit=>unit.start===notFenceText.indexOf('## 第2节')),'信息串含反引号的行不是围栏开启行')
})

test('legacy 锚点计划中逐字重复的组：同一原文范围且改后文字逐字相同才折叠为一组并按原始序号记录；同范围不同改法、只差空白、包含或相交、摘要错都仍整份拒绝',()=>{
 const draft='一、已知：8 家说省时。\n二、分级：付款为最高级。\n三、说明：未改动。'
 const edit=['付款为最高级','付款按定义有条件分级'] as const
 assert.deepEqual(readDeliveryPlan(anchorPlanOf(draft,[edit,['三、说明：未改动。','三、说明：已改。'],edit]),draft),{edits:[{start:draft.indexOf(edit[0]),end:draft.indexOf(edit[0])+edit[0].length,after:edit[1],index:0},{start:draft.indexOf('三、'),end:draft.length,after:'三、说明：已改。',index:1}],duplicates:[{index:2,of:0}]},'保留组沿用原始序号，重复组记录它与哪一组相同')
 assert.deepEqual(applyDeliveryPlan(anchorPlanOf(draft,[edit,edit]),draft),{text:'一、已知：8 家说省时。\n二、分级：付款按定义有条件分级。\n三、说明：未改动。',edits:1},'只应用一次，编辑数是唯一应用数')
 assert.deepEqual(applyDeliveryPlan(anchorPlanOf(draft,[['\n三、说明：未改动。',''],['\n三、说明：未改动。','']]),draft),{text:'一、已知：8 家说省时。\n二、分级：付款为最高级。',edits:1},'重复的删除组同样折叠')
 for(const [plan,reason] of [
  [anchorPlanOf(draft,[edit,['付款为最高级','付款有条件分级']]),'overlap:1'],
  [anchorPlanOf(draft,[edit,['付款为最高级','付款按定义有条件分级 ']]),'overlap:1'],
  [anchorPlanOf(draft,[edit,['最高级','付款按定义有条件分级']]),'overlap:1'],
  // 包含：外层组起点更前，按位置排序后报告被覆盖的第 0 组。
  [anchorPlanOf(draft,[edit,['分级：付款为最高级。','x']]),'overlap:0'],
  [anchorPlanOf(draft,[edit,edit,['不存在的句子','x']]),'anchor-missing:2'],
  [anchorPlanOf('别的草稿',[edit,edit]),'hash'],
 ] as const)assert.deepEqual(applyDeliveryPlan(plan,draft),{reason},reason)
})

test('真实租约链：成组问题的多个修改先原子应用再验收；同块重复或越出本单元的修改拒绝，legacy折叠语义不用于新协议',async t=>{
 const units=splitReviewUnits(longDraft),first=['第1节第3句内容。','第1节第3句已核对。'] as const
 const applied=longDraft.replace(first[0],first[1]).replace('第1节第4句内容。','第1节第4句已核对。').replace('第3节第7句内容。','第3节第7句已核对。').trim()
 const f=await runtime(t,[text(longDraft),
  text(planOf(longDraft,[first,['第1节第4句内容。','第1节第4句已核对。']])),text(planOf(longDraft,[])),text(planOf(longDraft,[['第3节第7句内容。','第3节第7句已核对。']])),
  text(verify(['r1:u1:i1','r1:u3:i1'],[[2],[6]])),text(verify()),text(verify()),text('多余请求不应出现')])
 await f.send()
 assert.equal(f.adapter.requests.length,1+3+3,'折叠后第 1 轮原子应用，进入第 2 轮')
 assert.deepEqual(ends(f.events()),['completed'])
 assert.equal(readTaskRunGroupResult(f.events(),'rpc'),applied,'重复组只应用一次')
 const rounds=Reflect.get(delivered(f.events())[0]!.data.source,'rounds') as {round:number;edits:number;units:{unit:number;edits:number;duplicates?:unknown}[]}[]
 assert.deepEqual(rounds[0]!.units.map(unit=>[unit.unit,unit.edits,unit.duplicates??null]),[[0,1,null],[1,0,null],[2,1,null]],'同一段落的两处纠正合并为一个完整块，单元编辑数仅计实际应用的块')
 assert.equal(rounds[0]!.edits,rounds[0]!.units.reduce((total,unit)=>total+unit.edits,0),'轮次编辑数等于各单元唯一应用数之和')
 assert.equal(rounds[0]!.edits,2)
 assert.deepEqual(f.traces.filter(entry=>entry.round===1&&(entry.state==='planned'||entry.state==='applied')).map(entry=>[entry.state,entry.unit??null,entry.edits]),[['planned',0,1],['planned',1,0],['planned',2,1],['applied',null,2]])
 assert.equal(units.length,3)
 await t.test('同块重复修订拒绝',async sub=>{
  const g=await runtime(sub,[text(longDraft),text(planOf(longDraft,[first,first])),text(planOf(longDraft,[first,first])),text('不应出现')])
  await g.send();assert.equal(g.adapter.requests.length,3,'唯一纠正名额用尽后仍重复即收错');assert.equal(g.traces.at(-1)!.reason,'rewrite-plan:block-conflict');assert.equal(readTaskRunGroupResult(g.events(),'rpc'),undefined)
 })
 await t.test('重复组越出本单元',async sub=>{
  const outside=['第2节第5句内容。','x'] as const
  const g=await runtime(sub,[text(longDraft),text(planOf(longDraft,[first,outside,outside])),text(planOf(longDraft,[first,outside,outside])),text('不应出现')])
  await g.send()
  assert.equal(g.adapter.requests.length,3,'唯一纠正名额用尽后仍越界即收错')
  assert.equal(g.traces.at(-1)!.reason,'rewrite-plan:edit-range')
  assert.equal(readTaskRunGroupResult(g.events(),'rpc'),undefined,'不部分应用、不回退草稿')
 })
})

test('常规长度关联交付由同一回执原子修正前后段，完整第二轮确认后才交付',async t=>{
 const draft=['## 已知与判定','样本：同一批登记对象。',('仅作为交付正文的中性背景。').repeat(100),'## 执行与结论','结论：另一批对象也已通过。'].join('\n\n')
 const revised=draft.replace('样本：同一批登记对象。','样本：只核对同一批登记对象。').replace('结论：另一批对象也已通过。','结论：只据这批登记对象的实际结果判定。')
 assert.ok(draft.length>1200&&Buffer.byteLength(draft,'utf8')<8192)
 const f=await runtime(t,[text(draft),text(planOf(draft,[['样本：同一批登记对象。','样本：只核对同一批登记对象。'],['结论：另一批对象也已通过。','结论：只据这批登记对象的实际结果判定。']])),text(verify(['r1:u1:i1'],[[2,5]])),text('不应追加请求')])
 await f.send()
 assert.deepEqual(ends(f.events()),['completed'])
 assert.equal(f.adapter.requests.length,3,'一份草稿、一次整稿关联纠正、一次全稿确认')
 assert.equal(readTaskRunGroupResult(f.events(),'rpc'),revised)
 const rounds=Reflect.get(delivered(f.events())[0]!.data.source,'rounds') as {round:number;edits:number;units:unknown[]}[]
 assert.deepEqual(rounds.map(round=>[round.round,round.edits,round.units.length]),[[1,2,1],[2,0,1]])
})

test('整稿单元同时受字符和UTF-8字节界限约束，超过任一界限仍完整分单元',()=>{
 const withLength=(n:number,char:string)=>'## 前段\n\n'+char.repeat(Math.floor(n/2))+'\n\n## 后段\n\n'+char.repeat(Math.ceil(n/2))
 const frame=withLength(0,'a').length,ascii=withLength(6000-frame,'a'),dense=withLength(3000,'字'),long=withLength(6001-frame,'a')
 assert.equal(ascii.length,6000);assert.equal(long.length,6001)
 assert.deepEqual(splitReviewUnits(ascii),[{start:0,end:ascii.length}],'字符与字节均在界内时整稿复核')
 const prefix=withLength(0,'字'),atBytes=withLength(Math.floor((8192-Buffer.byteLength(prefix,'utf8'))/3),'字')
 const exactBytes=atBytes+'a'.repeat(8192-Buffer.byteLength(atBytes,'utf8'))
 assert.equal(Buffer.byteLength(exactBytes,'utf8'),8192);assert.ok(exactBytes.length<6000)
 assert.deepEqual(splitReviewUnits(exactBytes),[{start:0,end:exactBytes.length}],'字节上界包含边界值')
 for(const value of [dense,long,exactBytes+'a']){
  const units=splitReviewUnits(value)
  assert.ok(units.length>1&&units.length<=4,'超字节或字符上限后保留有界长稿路径')
  assert.equal(units.map(unit=>value.slice(unit.start,unit.end)).join(''),value)
 }
})


test('真实 Loop 最大单元边界：R1 零编辑的四单元仍逐一进入R2，最多1+4+4次请求，验收不产生替换',async t=>{
 const draft=Array.from({length:9},(_,index)=>section(index+1)).join('\n')
 assert.equal(splitReviewUnits(draft).length,4)
 const f=await runtime(t,[text(draft),...Array.from({length:4},()=>text(revise())),...Array.from({length:4},()=>text(verify())),text('不应出现')])
 await f.send()
 assert.deepEqual(ends(f.events()),['completed'])
 assert.equal(f.adapter.requests.length,9,'只用草稿和两轮各四个单元，不额外请求修复')
 assert.equal(readTaskRunGroupResult(f.events(),'rpc'),draft.trim())
 assert.deepEqual(f.traces.filter(entry=>entry.state==='requested').map(entry=>[entry.round,entry.unit]),[[1,0],[1,1],[1,2],[1,3],[2,0],[2,1],[2,2],[2,3]])
 const submissions=f.events().flatMap(event=>event.type==='assistant/message'?event.data.message.content.flatMap(block=>block.type==='tool-call'?[receiptArgs(block.arguments)]:[]):[])
 assert.deepEqual(submissions.map(args=>args.phase),['revise','revise','revise','revise','verify','verify','verify','verify'])
 assert.ok(submissions.slice(4).every(args=>!('after'in args)&&!('edits'in args)))
})

test('候选：需改块未实际修改或逐字原样替换时整轮失败，不部分应用且不增加R2请求',async t=>{
 for(const noop of [false,true])await t.test(noop?'原样替换':'漏改依赖',async sub=>{
  const draft='甲摘要。\n\n乙分析。\n\n丙结论。'
  const first={phase:'revise',issues:[{problem:'摘要与结论须同步。',basis:[passageBasis(material.catalog,'goal',goal)],affectedBlockIds:[1,3],coverage:{change:[1,3],retain:[],unrelated:[2],unknown:[]},edits:[{blockId:1,after:'甲修订。'},...noop?[{blockId:3,after:'丙结论。'}]:[]]}]}
  const f=await runtime(sub,[text(draft),text(first as unknown as Submission),text(verify(['r1:u1:i1']))]);await f.send()
  assert.equal(f.adapter.requests.length,2)
  assert.ok(f.traces.some(x=>x.reason==='rewrite-plan:coverage-open:3'))
  assert.ok(!f.traces.some(x=>x.state==='applied'))
  assert.equal(readTaskRunGroupResult(f.events(),'rpc'),undefined)
 })
})
test('候选：编辑重分块后按宿主旧新映射核验依赖，旧编号不能蒙混且正确映射可正式读取',async t=>{
 for(const stale of [true,false])await t.test(stale?'错误旧编号':'准确新编号',async sub=>{
  const draft='甲摘要。\n\n乙分析。\n\n丙结论。'
  const first={phase:'revise',issues:[{problem:'摘要修订影响结论核对。',basis:[passageBasis(material.catalog,'goal',goal)],affectedBlockIds:[1,3],coverage:{change:[1],retain:[3],unrelated:[2],unknown:[]},edits:[{blockId:1,after:'甲修订。\n\n新增说明。'}]}]}
  const accepted={...verify(['r1:u1:i1']),changeChecks:[{issueId:'r1:u1:i1',status:'verified',reviewedBlockIds:stale?[1,3]:[1,2,4]}]}
  // 错误旧编号连续提交两次以耗尽唯一纠正名额；准确新编号一次通过，不消费第二份。
  const f=await runtime(sub,[text(draft),text(first as unknown as Submission),text(accepted as unknown as Submission),text(accepted as unknown as Submission)]);await f.send()
  assert.equal(f.adapter.requests.length,stale?4:3)
  const expected='甲修订。\n\n新增说明。\n\n乙分析。\n\n丙结论。'
  assert.equal(readTaskRunGroupResult(f.events(),'rpc'),stale?undefined:expected)
  if(stale)assert.ok(f.traces.some(x=>x.reason==='rewrite-r2-plan:change-blocks'))
  else{
   const messages=f.adapter.requests[2]!.messages.map(textOf).join('\n');assert.ok(messages.includes('"oldBlockId":3,"newBlockIds":[4]'))
   assert.ok(f.adapter.requests[1]!.messages.map(textOf).join('\n').includes('"preview":"丙结论。"'),'R1全稿稳定索引包含单元外可辨认正文预览，不要求模型数偏移')
   const copy=structuredClone(f.events());const entry=copy.find(e=>e.type==='user/message'&&Reflect.get(e.data.source,'summary')==='复核后交付');assert.ok(entry&&entry.type==='user/message')
   const source=entry.data.source as unknown as {rounds:{blockMap?:unknown}[]};delete source.rounds[0]!.blockMap
   assert.equal(readTaskRunGroupResult(copy,'rpc'),undefined,'v3冷读缺映射不能仅凭accepted放行')
  }
 })
})
test('候选：v1与v2已验收持久历史仍可冷读，未知检查仍拒绝',async t=>{
 const draft='旧稿正文。';const f=await runtime(t,[text(draft),text(revise()),text(verify())]);await f.send()
 assert.equal(readTaskRunGroupResult(f.events(),'rpc'),draft)
 for(const protocol of ['revise-verify/v1','revise-verify/v2']){
  const events=JSON.parse(JSON.stringify(f.events())) as SessionEvent[]
  const saved=events.find(e=>e.type==='user/message'&&Reflect.get(e.data.source,'summary')==='复核后交付');assert.ok(saved&&saved.type==='user/message')
  const source=saved.data.source as unknown as {protocol:string;rounds:{protocol:string;blockMap?:unknown;units:{protocol:string;checks?:{status:string}[]}[]}[]}
  source.protocol=protocol;for(const round of source.rounds){round.protocol=protocol;delete round.blockMap;for(const unit of round.units)unit.protocol=protocol}
  assert.equal(readTaskRunGroupResult(events,'rpc'),draft,protocol)
  source.rounds[1]!.units[0]!.checks![0]!.status='unknown';assert.equal(readTaskRunGroupResult(events,'rpc'),undefined)
 }
})

test('候选：跨原单元的需改依赖全部实际闭合后才应用一次，保两轮三单元与九请求上限',async t=>{
 const draft=longDraft.trim(),blocks=splitReviewBlocks(draft)
 assert.equal(blocks.length,6);assert.equal(splitReviewUnits(draft).length,3)
 const issue=(blockId:number,after:string)=>({phase:'revise',issues:[{problem:'摘要与结论的同一口径须同步。',basis:[passageBasis(material.catalog,'goal',goal)],affectedBlockIds:[2,4,6],coverage:{change:[2,6],retain:[4],unrelated:[1,3,5],unknown:[]},edits:[{blockId,after}]}]})
 const a=draft.slice(blocks[1]!.start,blocks[1]!.end).replace('第1节第3句内容。','第1节第3句已核对。')
 const b=draft.slice(blocks[5]!.start,blocks[5]!.end).replace('第3节第7句内容。','第3节第7句已核对。')
 const accepted={...verify(['r1:u1:i1','r1:u3:i1'],[[2],[6]]),changeChecks:['r1:u1:i1','r1:u3:i1'].map(issueId=>({issueId,status:'verified',reviewedBlockIds:[2,4,6]}))}
 const f=await runtime(t,[text(draft),text(issue(2,a) as unknown as Submission),text(revise()),text(issue(6,b) as unknown as Submission),text(accepted as unknown as Submission),text(verify()),text(verify())]);await f.send()
 assert.equal(f.adapter.requests.length,7)
 assert.equal(f.traces.filter(row=>row.state==='applied').length,1)
 assert.equal(readTaskRunGroupResult(f.events(),'rpc'),draft.replace('第1节第3句内容。','第1节第3句已核对。').replace('第3节第7句内容。','第3节第7句已核对。'))
})

test('候选：删除旧块的映射为空且后续编号移动，未知覆盖仍不能应用或交付',async t=>{
 for(const unknown of [false,true])await t.test(unknown?'未知覆盖拒绝':'删除映射',async sub=>{
  const draft='甲摘要。\n\n乙分析。\n\n丙结论。'
  const issue={phase:'revise',issues:[{problem:'删除无依据摘要并核结论。',basis:[passageBasis(material.catalog,'goal',goal)],affectedBlockIds:[1,3],coverage:{change:[1],retain:unknown?[]:[3],unrelated:[2],unknown:unknown?[3]:[]},edits:[{blockId:1,after:''}]}]}
  const accepted={...verify(['r1:u1:i1']),changeChecks:[{issueId:'r1:u1:i1',status:'verified',reviewedBlockIds:[2]}]}
  const f=await runtime(sub,[text(draft),text(issue as unknown as Submission),text(accepted as unknown as Submission)]);await f.send()
  assert.equal(readTaskRunGroupResult(f.events(),'rpc'),unknown?undefined:'乙分析。\n\n丙结论。')
  assert.equal(f.adapter.requests.length,unknown?2:3)
  if(unknown)assert.ok(f.traces.some(row=>row.reason==='rewrite-plan:coverage-unknown'))
  else assert.ok(f.adapter.requests[2]!.messages.map(textOf).join('\n').includes('"oldBlockId":1,"newBlockIds":[]'))
 })
})

test('候选r2：retain可原样提交但不能借保留分区真实改字',async t=>{
 for(const changed of [false,true])await t.test(changed?'保留块真改拒绝':'原样保留可交付',async sub=>{
  const draft='甲摘要。\n\n乙结论。'
  const issue={phase:'revise',issues:[{problem:'原结论须核对而不改写。',basis:[passageBasis(material.catalog,'goal',goal)],affectedBlockIds:[2],coverage:{change:[],retain:[2],unrelated:[1],unknown:[]},edits:[{blockId:2,after:changed?'乙被改写。':'乙结论。'}]}]}
  const f=await runtime(sub,[text(draft),text(issue as unknown as Submission),text(verify(['r1:u1:i1'],[[2]]))]);await f.send()
  assert.equal(f.adapter.requests.length,changed?2:3)
  assert.equal(readTaskRunGroupResult(f.events(),'rpc'),changed?undefined:draft)
  if(changed)assert.ok(f.traces.some(row=>row.reason==='rewrite-plan:coverage-retain-change:2'))
  else assert.ok(f.traces.some(row=>row.state==='applied'&&row.edits===0))
 })
})

test('候选r2：删除块位于替换形成的跨块围栏内也不映射到新块',()=>{
 const before='甲正文。\n\n乙待删。\n\n丙正文。',blocks=splitReviewBlocks(before)
 const edits=[
  {start:blocks[0]!.start,end:blocks[0]!.end,after:'```text\n甲正文。',index:0},
  {start:blocks[1]!.start,end:blocks[1]!.end,after:'',index:1},
  {start:blocks[2]!.start,end:blocks[2]!.end,after:'丙正文。\n```',index:2},
 ]
 const applied=applyPlanEdits(before,edits);assert.ok(!('reason'in applied))
 const after=applied.text.trim();assert.equal(splitReviewBlocks(after).length,1)
 assert.deepEqual(revisionBlockMap(before,after,edits).rows.map(row=>row.newBlockIds),[[1],[],[1]])
})

test('候选r2：完整SDK持久记录冷读重算真实草稿与R1回执，损坏映射或脱离原调用不交付',async t=>{
 const draft='甲摘要。\n\n乙结论。'
 const issue={phase:'revise',issues:[{problem:'修正摘要并核原结论。',basis:[passageBasis(material.catalog,'goal',goal)],affectedBlockIds:[1,2],coverage:{change:[1],retain:[2],unrelated:[],unknown:[]},edits:[{blockId:1,after:'甲修订。'}]}]}
 const f=await runtime(t,[text(draft),text(issue as unknown as Submission),text(verify(['r1:u1:i1'],[[1,2]]))]);await f.send()
 const expected='甲修订。\n\n乙结论。'
 assert.equal(readTaskRunGroupResult(f.events(),'rpc'),expected,'真实SDK记录是正向历史，不能以缺draft的metadata夹具替代')
 type Source={draftMessageId:string;rounds:{blockMap?:{rows:{oldBlockId:number;newBlockIds:number[]}[]};units:{callId?:string;issues?:{edits:{after:string}[]}[];changeChecks?:{reviewedBlockIds:number[]}[]}[]}[]}
 const copy=()=>{const events=structuredClone(f.events());const event=events.find(e=>e.type==='user/message'&&Reflect.get(e.data.source,'summary')==='复核后交付');assert.ok(event&&event.type==='user/message');return {events,source:event.data.source as unknown as Source}}
 const empty=copy();empty.source.rounds[0]!.blockMap!.rows.forEach(row=>{row.newBlockIds=[]});empty.source.rounds[1]!.units[0]!.changeChecks![0]!.reviewedBlockIds=[]
 assert.equal(readTaskRunGroupResult(empty.events,'rpc'),undefined,'非空正文的全部空映射拒绝')
 const wrong=copy();wrong.source.rounds[0]!.blockMap!.rows[0]!.newBlockIds=[1,2];wrong.source.rounds[0]!.blockMap!.rows[1]!.newBlockIds=[2]
 assert.equal(readTaskRunGroupResult(wrong.events,'rpc'),undefined,'集合仍全覆盖且单调，但与真实编辑不符仍拒绝')
 const edit=copy();edit.source.rounds[0]!.units[0]!.issues![0]!.edits[0]!.after='伪造修订。'
 assert.equal(readTaskRunGroupResult(edit.events,'rpc'),undefined,'元数据不能替代正式R1工具参数')
 const missing=copy();missing.source.draftMessageId='不存在的草稿'
 assert.equal(readTaskRunGroupResult(missing.events,'rpc'),undefined,'必须读到冻结draft而非相信hash标签')
 const ack=copy();const call=ack.source.rounds[0]!.units[0]!.callId
 const result=ack.events.find(e=>e.type==='tool/result'&&e.data.message.toolCallId===call);assert.ok(result&&result.type==='tool/result')
 Reflect.set(result.data.message,'isError',true)
 assert.equal(readTaskRunGroupResult(ack.events,'rpc'),undefined,'失去原R1成功ACK不能冷读交付；保日志序号连续')
})

test('候选r3：R2冷读必须包含当前整稿全部单元，不能只存首单元accepted',async t=>{
 const count=splitReviewUnits(longDraft).length;assert.ok(count>1)
 const f=await runtime(t,[text(longDraft),...Array.from({length:count},()=>text(revise())),...Array.from({length:count},()=>text(verify()))]);await f.send()
 assert.equal(readTaskRunGroupResult(f.events(),'rpc'),longDraft.trim(),'完整原生验收是正向历史')
 const events=structuredClone(f.events()),entry=delivered(events)[0];assert.ok(entry)
 const source=entry.data.source as unknown as {rounds:{units:unknown[]}[]}
 assert.equal(source.rounds[1]!.units.length,count);source.rounds[1]!.units.splice(1)
 assert.equal(readTaskRunGroupResult(events,'rpc'),undefined)
})

test('候选r3：R2冷读逐个核原生成功ACK及真实verify参数，不用metadata冒验收',async t=>{
 const draft='甲摘要。\n\n乙结论。'
 const issue={phase:'revise',issues:[{problem:'修正摘要并核原结论。',basis:[passageBasis(material.catalog,'goal',goal)],affectedBlockIds:[1,2],coverage:{change:[1],retain:[2],unrelated:[],unknown:[]},edits:[{blockId:1,after:'甲修订。'}]}]}
 const f=await runtime(t,[text(draft),text(issue as unknown as Submission),text(verify(['r1:u1:i1'],[[1,2]]))]);await f.send()
 assert.equal(readTaskRunGroupResult(f.events(),'rpc'),'甲修订。\n\n乙结论。')
 const copy=()=>{const events=structuredClone(f.events()),entry=delivered(events)[0];assert.ok(entry);const source=entry.data.source as unknown as {rounds:{units:{callId:string;start:number;changeChecks:{status:string}[]}[]}[]};return {events,unit:source.rounds[1]!.units[0]!}}
 const ack=copy(),result=ack.events.find(event=>event.type==='tool/result'&&event.data.message.toolCallId===ack.unit.callId);assert.ok(result&&result.type==='tool/result');Reflect.set(result.data.message,'isError',true)
 assert.equal(readTaskRunGroupResult(ack.events,'rpc'),undefined,'R2真实失败ACK不能靠accepted标签放行')
 const range=copy();range.unit.start++
 assert.equal(readTaskRunGroupResult(range.events,'rpc'),undefined,'单元范围必须绑定当前整稿')
 const args=copy(),call=args.events.find(event=>event.type==='tool/call'&&event.data.callId===args.unit.callId);assert.ok(call&&call.type==='tool/call')
 const raw:unknown=call.data.arguments;assert.ok(raw!==null&&typeof raw==='object')
 Reflect.set(raw,'verdict','reject')
 assert.equal(readTaskRunGroupResult(args.events,'rpc'),undefined,'实际verify参数与元数据不符不能交付')
})

test('候选r3：真实SDK接收序列化R1与R2参数后可冷读，原始JSON损坏仍拒绝',async t=>{
 const draft='甲摘要。\n\n乙结论。'
 const issue:Revision={phase:'revise',issues:[{problem:'修正摘要并核原结论。',basis:[passageBasis(material.catalog,'goal',goal)],affectedBlockIds:[1,2],coverage:{change:[1],retain:[2],unrelated:[],unknown:[]},edits:[{blockId:1,after:'甲修订。'}]}]}
 const serialized=(args:Submission):Reply=>[{type:'block-start',index:0,blockType:'tool-call'},{type:'block-end',index:0,block:{type:'tool-call',id:ToolCallId('review-call-'+(++callSerial)),name:deliveryReviewToolName,arguments:JSON.stringify(args)}},{type:'finish',reason:{kind:'tool-calls'}}]
 const f=await runtime(t,[text(draft),serialized(issue),serialized(verify(['r1:u1:i1'],[[1,2]]))]);await f.send()
 assert.equal(f.adapter.requests.length,3);assert.deepEqual(ends(f.events()),['completed'])
 assert.equal(readTaskRunGroupResult(f.events(),'rpc'),'甲修订。\n\n乙结论。')
 const calls=f.events().filter((event):event is Extract<SessionEvent,{type:'tool/call'}>=>event.type==='tool/call')
 assert.equal(calls.length,2);assert.ok(calls.every(call=>typeof call.data.arguments==='string'),'正式SDK的raw wire在事件中逐字保存为JSON字符串')
 for(const original of calls){
  const events=structuredClone(f.events()),call=events.find(event=>event.seq===original.seq);assert.ok(call&&call.type==='tool/call')
  const message=events.find(event=>event.type==='assistant/message'&&event.data.turn===call.data.turn&&event.data.step===call.data.step);assert.ok(message&&message.type==='assistant/message')
  const block=message.data.message.content.find(block=>block.type==='tool-call');assert.ok(block&&block.type==='tool-call')
  Reflect.set(call.data,'arguments','{');Reflect.set(block,'arguments','{')
  assert.equal(readTaskRunGroupResult(events,'rpc'),undefined,'R1/R2坏JSON即使raw两端相同也不形成有效回执')
 }
})

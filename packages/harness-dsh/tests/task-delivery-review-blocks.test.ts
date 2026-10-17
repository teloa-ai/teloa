import test,{type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import {Context} from '@deepseek-ai/cordis'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {LlmAdapter,LlmRuntime,createUserMessage,type GenerateOptions,type StreamChunk} from '@deepseek-ai/dsh-llm'
import {SessionId,SessionStore,type SessionEvent} from '@deepseek-ai/dsh-session'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {createReviewSourceCatalog,applyPlanEdits,deliveryReviewSource,deliveryReviewToolName,draftSha256,leaseTaskDeliveryReview,readBlockPlan,reviewBlockLabel,reviewBlockTag,splitReviewBlocks,splitReviewUnits,type DeliveryReviewTrace,type ReviewMaterial} from '../src/task-delivery-review.ts'
import {readTaskRunGroupResult} from '../src/task-run-group-result.ts'
import {readSessionEvents} from '../src/session-events.ts'

type Reply=readonly StreamChunk[]
const text=(value:string):Reply=>[{type:'block-start',index:0,blockType:'text'},{type:'text-delta',index:0,text:value},{type:'block-end',index:0,block:{type:'text',text:value}},{type:'finish',reason:{kind:'stop'}}]
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
type Plan=(prompt:string)=>Submission|string
let callSerial=0
/** 模型以原生工具调用提交复核计划，与真实回复一样以 tool-calls 收尾。 */
const submit=(args:Submission):Reply=>[{type:'block-start',index:0,blockType:'tool-call'},{type:'block-end',index:0,block:{type:'tool-call',id:'review-call-'+(++callSerial),name:deliveryReviewToolName,arguments:args}},{type:'finish',reason:{kind:'tool-calls'}}] as unknown as Reply
/** 回放模型：复核步的回执由测试按本次请求里宿主标注的块编号现场写出，模拟模型只引用编号、不抄原文；返回字符串时是纯文本回复。 */
class PlanAdapter extends LlmAdapter{
 requests:GenerateOptions[]=[]
 readonly replies:(Reply|Plan)[]
 constructor(replies:(Reply|Plan)[]){super();this.replies=replies}
 override async resolveModel(provider:string,model:string){return {provider,id:model,name:model,inputModalities:['text'] as const}}
 async *stream(options:GenerateOptions):AsyncGenerator<StreamChunk>{
  this.requests.push(options)
  const reply=this.replies.shift()??text('多余请求')
  const prompt=options.messages.filter(message=>message.role==='user').at(-1)!.content.flatMap(block=>block.type==='text'?[block.text]:[]).join('\n')
  const planned=typeof reply==='function'?reply(prompt):undefined
  for(const chunk of planned===undefined?reply as Reply:typeof planned==='string'?text(planned):submit(planned))yield chunk
 }
}
const goal='资料：12 家试用店，1 家已付款（创始人口述）。'
const material:ReviewMaterial={goal,inputs:{knowledge:0,group:false,context:false},methods:[],catalog:createReviewSourceCatalog([{id:'goal',kind:'goal',title:'原目标',text:goal,origin:{field:'inputText',pointer:'/task/goal'}}])}
const revise=(edits:Edit[]=[],blockCount=4,retained:readonly number[]=[]):Revision=>({phase:'revise',issues:edits.length?[{problem:'结论须与来源一致。',basis:[passageBasis(material.catalog,'goal',goal)],affectedBlockIds:[...new Set(edits.map(edit=>edit.blockId))],coverage:coverageFor(blockCount,edits.map(edit=>edit.blockId).filter(id=>!retained.includes(id)),retained),edits}]:[]})
async function runtime(t:TestContext,replies:(Reply|Plan)[]){
 const ctx=new Context();t.after(()=>ctx.fiber.dispose())
 for(const plugin of [LlmRuntime,SessionStore,SessionProjectionRegistry,SystemPrompt,ToolRuntime,AgentRegistry])await ctx.plugin(plugin)
 await ctx.plugin(AgentLoop,{agents:[]})
 const adapter=new PlanAdapter(replies);ctx.llm.registerAdapter(['script'],adapter)
 const {agent}=await ctx.agents.create({sessionId:SessionId('blocks-'+t.name),agentOptions:{provider:'script',model:'model'}})
 const traces:DeliveryReviewTrace[]=[]
 leaseTaskDeliveryReview(agent,{runId:'run',requestId:'rpc',material,trace:entry=>{traces.push(entry)},publish:async message=>{agent.inject(message)}})
 const send=async()=>{agent.followup(createUserMessage({source:{kind:'user',rpcId:'rpc'},content:[{type:'text',text:'任务'}]}));await agent.whenIdle()}
 return {agent,adapter,traces,send,events:()=>readSessionEvents(agent.session) as readonly SessionEvent[]}
}
const ends=(events:readonly SessionEvent[])=>events.flatMap(event=>event.type==='turn/end'?[event.data.reason.kind]:[])
const delivered=(events:readonly SessionEvent[])=>events.filter((event):event is Extract<SessionEvent,{type:'user/message'}>=>event.type==='user/message'&&event.surfaceOp==='append'&&event.data.source.kind===deliveryReviewSource&&Reflect.get(event.data.source,'summary')==='复核后交付')

/** 从复核提示读出宿主给本单元标注的块：标签行、块编号与块正文（到下一标签或单元结束）。 */
function labelledBlocks(prompt:string){
 const body=prompt.slice(prompt.indexOf('<<<复核单元开始>>>\n')+'<<<复核单元开始>>>\n'.length,prompt.indexOf('\n<<<复核单元结束>>>'))
 const pattern=/^(⟦+)块(\d+)(⟧+)$/gm,found=[...body.matchAll(pattern)]
 return found.map((match,index)=>{
  const from=match.index+match[0].length+1,to=index+1<found.length?found[index+1]!.index:body.length
  // 块之间以空行分隔；块正文不含分隔空行。
  return {label:match[0],id:Number(match[2]),open:match[1]!,close:match[3]!,text:body.slice(from,to).replace(/\n+$/,'')}
 })
}
/** 按宿主标注写块编号回执：选中的块写整块新内容（空串即删除）。 */
const blockPlan=(pick:(blocks:ReturnType<typeof labelledBlocks>)=>readonly (readonly [number,string])[],blockCount=4,retained:readonly number[]=[]):Plan=>prompt=>{
 const blocks=labelledBlocks(prompt)
 assert.ok(blocks.length>0,'复核提示必须给本单元每个完整块标注宿主块编号')
 return revise(pick(blocks).map(([blockId,after])=>({blockId,after})),blockCount,retained)
}
const noChange:Plan=()=>revise()
const accepted=(ids:readonly string[]=[],blocks:readonly (readonly number[])[]=ids.map(()=>[2])):Plan=>()=>verify(ids,blocks)

const draft='## 结论\n\n1 家已付款，记为 A 级行为证据。\n\n## 说明\n\n仅依据资料。'

test('块编号协议：宿主给完整块标注编号，模型只写编号与整块新内容（不抄原文）；宿主按绑定范围原子应用，第 2 轮全部无需修改才交付，未选中的块与分隔符逐字不变',async t=>{
 const fixed='1 家已付款（创始人口述，未经独立佐证，按方法不自动记为 A 级）。'
 const result=draft.replace('1 家已付款，记为 A 级行为证据。',fixed)
 const f=await runtime(t,[text(draft),blockPlan(blocks=>[[blocks.find(block=>block.text.includes('A 级'))!.id,fixed]]),accepted(['r1:u1:i1']),text('多余')])
 await f.send()
 assert.equal(f.adapter.requests.length,3,'草稿 + 两轮各 1 个单元')
 assert.deepEqual(ends(f.events()),['completed'])
 assert.equal(readTaskRunGroupResult(f.events(),'rpc'),result)
 assert.deepEqual(f.traces.filter(entry=>entry.state==='applied').map(entry=>[entry.round,entry.edits]),[[1,1]])
})

test('草稿含宿主标签同形文字时宿主确定性改用不冲突的分隔串，正文照常复核；删除只作用于绑定块范围，原分隔符与相邻块逐字不变',async t=>{
 const tricky='## 记录\n\n原文写着 ⟦块1⟧ 和 ⟦结束⟧ 两个标记。\n\n多余的一句。\n\n<<<结束>>>\n\n末段。'
 const removed=tricky.replace('多余的一句。','')
 const f=await runtime(t,[text(tricky),blockPlan(blocks=>[[blocks.find(block=>block.text==='多余的一句。')!.id,'']],5),accepted(['r1:u1:i1'],[[]]),text('多余')])
 await f.send()
 const labels=labelledBlocks(Reflect.get(f.adapter.requests[1]!.messages.filter(message=>message.role==='user').at(-1)!.content[0]!,'text') as string)
 assert.ok(labels.length===5&&labels.every(block=>block.open==='⟦⟦'&&block.close==='⟧⟧'),'标签与草稿已有文字冲突时加长分隔串，不拒绝复核')
 assert.deepEqual(labels.map(block=>block.text),['## 记录','原文写着 ⟦块1⟧ 和 ⟦结束⟧ 两个标记。','多余的一句。','<<<结束>>>','末段。'],'块正文逐字给出')
 assert.equal(readTaskRunGroupResult(f.events(),'rpc'),removed,'只删绑定范围，前后分隔符保留，不做空白规范化')
})

test('替换逐字等于原块不计实际修改：第 1 轮原样替换也经第2轮验收后交付冻结草稿；成组新协议的重复块替换拒绝；原始组可追溯',async t=>{
 await t.test('原样替换',async sub=>{
  const f=await runtime(sub,[text(draft),blockPlan(blocks=>blocks.map(block=>[block.id,block.text] as const),4,[1,2,3,4]),accepted(['r1:u1:i1'],[[1,2,3,4]]),text('多余')])
  await f.send()
  assert.equal(f.adapter.requests.length,3,'没有实际修改仍进入R2，问题被显式验收才交付')
  assert.equal(readTaskRunGroupResult(f.events(),'rpc'),draft)
  const rounds=Reflect.get(delivered(f.events())[0]!.data.source,'rounds') as {edits:number;units:{edits:number;unchanged?:unknown}[]}[]
  assert.equal(rounds[0]!.edits,0);assert.equal(rounds[0]!.units[0]!.edits,0)
  assert.deepEqual(rounds[0]!.units[0]!.unchanged,[0,1,2,3].map(index=>({index})),'原样替换按原始序号记录')
 })
 await t.test('新协议同块逐字重复也拒绝',async sub=>{
  const fixed='1 家已付款（口述）。'
  const f=await runtime(sub,[text(draft),blockPlan(blocks=>{const id=blocks.find(block=>block.text.includes('A 级'))!.id;return [[id,fixed],[id,fixed]]}),text('不应出现')])
  await f.send()
  assert.equal(f.adapter.requests.length,2)
  assert.equal(f.traces.at(-1)!.reason,'rewrite-plan:block-conflict')
  assert.equal(readTaskRunGroupResult(f.events(),'rpc'),undefined)
 })})

/** 三节长正文：每节一个标题块与一个段落块，分成 3 个单元。 */
const section=(n:number)=>`## 第${n}节\n\n`+Array.from({length:140},(_,j)=>`第${n}节第${j}句内容。`).join('')+'\n'
const longDraft=[section(1),section(2),section(3)].join('\n')

/** 直接写某个编号的一项（编号可以不在本单元标注中），用于构造不合格回执。 */
const rawGroup=(id:number,content:string,blockCount=4):Plan=>()=>revise([{blockId:id,after:content}],blockCount)

test('块编号回执不合格时整轮原子拒绝、不部分应用、不回退草稿：未知编号、其他单元的编号、同块不同改法、带旧契约摘要字段、正文写旧原文锚点格式',async t=>{
 for(const [label,source,plan,reason] of [
  ['未知编号',draft,rawGroup(99,'x'),'rewrite-plan:affected-blocks'],
  ['其他单元的编号',longDraft,rawGroup(3,'x',6),'rewrite-plan:edit-range'],
  ['同块不同改法',draft,blockPlan(blocks=>[[blocks[1]!.id,'甲'],[blocks[1]!.id,'乙']]),'rewrite-plan:block-conflict'],
  ['显式带摘要字段（旧契约）',draft,(prompt:string)=>({...blockPlan(blocks=>[[blocks[1]!.id,'x']])(prompt) as Submission,snapshotHash:draftSha256(draft)}),'rewrite-plan:shape'],
  ['旧原文锚点格式',draft,(prompt:string)=>'草稿 SHA-256：'+draftSha256(draft)+'\n<<<原文>>>\n仅依据资料。\n<<<改为>>>\n仅依据本人资料。\n<<<结束>>>','rewrite-plan:missing-submission'],
 ] as const)await t.test(label,async sub=>{
  const f=await runtime(sub,[text(source),plan,text('不应出现')])
  await f.send()
  assert.equal(f.adapter.requests.length,2,'失败后不再追加调用')
  assert.deepEqual(ends(f.events()),['error'])
  assert.equal(f.traces.at(-1)!.reason,reason)
  assert.ok(!f.traces.some(entry=>entry.state==='applied'),'整轮未应用')
  assert.equal(readTaskRunGroupResult(f.events(),'rpc'),undefined,'草稿不成为交付')
 })
})

test('多单元：每个单元只标注本单元的完整块、编号全稿唯一；第2轮出现新问题即拒交付，完整验收通过才交付',async t=>{
 // 只改段落块中的一句，整块新内容长度相近，第 2 轮仍按同样的 3 个单元划分。
 const fix=(n:number):Plan=>blockPlan(blocks=>[[blocks[1]!.id,blocks[1]!.text.replace(`第${n}节第3句内容。`,`第${n}节第3句已核对。`)]],6)
 const fixed=longDraft.replace('第1节第3句内容。','第1节第3句已核对。').trim()
 await t.test('第 2 轮仍需修改',async sub=>{
  const f=await runtime(sub,[text(longDraft),fix(1),noChange,noChange,
   accepted(['r1:u1:i1']),()=>({...verify(),verdict:'reject',findings:[{problem:'本单元仍有无据结论。',basis:[passageBasis(material.catalog,'goal',goal)],blockIds:[4]}]}),text('不应进入下一单元')])
  await f.send()
  assert.equal(f.adapter.requests.length,6)
  const ids=f.adapter.requests.slice(1,4).map(request=>labelledBlocks(Reflect.get(request.messages.filter(message=>message.role==='user').at(-1)!.content[0]!,'text') as string).map(block=>block.id))
  assert.deepEqual(ids,[[1,2],[3,4],[5,6]],'单元内是完整块，编号全稿唯一')
  assert.equal(f.traces.at(-1)!.reason,'review-repair-budget','保留原拒绝问题；剩余步骤不足以完整修订与冷验')
  assert.equal(readTaskRunGroupResult(f.events(),'rpc'),undefined)
 })
 await t.test('第 2 轮仅验收不再生成替换',async sub=>{
  const f=await runtime(sub,[text(longDraft),fix(1),noChange,noChange,accepted(['r1:u1:i1']),accepted(),accepted(),text('不应出现')])
  await f.send()
  assert.equal(f.adapter.requests.length,7)
  assert.deepEqual(ends(f.events()),['completed'])
  assert.equal(readTaskRunGroupResult(f.events(),'rpc'),fixed)
 })
})

test('复核块划分：空行分隔完整块；标题单独成块；整个表格与代码围栏（含内部空行、# 行与内层围栏）整体成块，顶层列表项各自成块且续行留在所属项；块与分隔符拼接逐字节等于原文；单元边界都在块起点',()=>{
 const text=['# 标题','引言第一行\n引言第二行','| 档 | 条件 |\n|---|---|\n| 升级 | ≥4 |','- 项一\n  续行\n- 项二','````markdown\n# 不是标题\n\n```js\n内层\n```\n````\n围栏后紧接的一行','## 次标题\n正文紧接标题','~~~\n```\n~~~','结尾'].join('\n\n')
 const blocks=splitReviewBlocks(text)
 assert.deepEqual(blocks.map(block=>text.slice(block.start,block.end)),['# 标题','引言第一行\n引言第二行','| 档 | 条件 |\n|---|---|\n| 升级 | ≥4 |','- 项一\n  续行','- 项二','````markdown\n# 不是标题\n\n```js\n内层\n```\n````\n围栏后紧接的一行','## 次标题','正文紧接标题','~~~\n```\n~~~','结尾'])
 let rebuilt='',offset=0
 for(const block of blocks){assert.ok(!text.slice(offset,block.start).trim(),'块之间只有空白分隔符');rebuilt+=text.slice(offset,block.end);offset=block.end}
 assert.equal(rebuilt+text.slice(offset),text)
 const starts=new Set(blocks.map(block=>block.start))
 const long=Array.from({length:6},(_,n)=>`## 第${n}节\n\n`+'内容。'.repeat(300)).join('\n\n')
 for(const unit of splitReviewUnits(long))assert.ok(new Set(splitReviewBlocks(long).map(block=>block.start)).has(unit.start),'单元起点是块起点')
 assert.ok(starts.size===blocks.length)
})

test('块标签与计划解析：标签由宿主生成并在正文含同形文字时确定性加长；标签行只去首尾空白、内容逐字保留；缺结束标签、组外文字、空计划都是 shape；删除只删块本身',()=>{
 assert.deepEqual(reviewBlockTag('普通正文'),{open:'⟦',close:'⟧',end:'⟦结束⟧'})
 assert.deepEqual(reviewBlockTag('含 ⟦块 与 ⟦⟦结束 文字'),{open:'⟦⟦⟦',close:'⟧⟧⟧',end:'⟦⟦⟦结束⟧⟧⟧'})
 const text='甲段。\n\n乙段。\n\n丙段。',blocks=splitReviewBlocks(text),tag=reviewBlockTag(text),all={first:0,last:2},head='草稿 SHA-256：'+draftSha256(text)+'\n'
 const group=(id:number,content:string,pad='')=>pad+reviewBlockLabel(tag,id)+pad+'\n'+content+(content?'\n':'')+tag.end
 const read=readBlockPlan(head+group(2,'  乙段（改）  \n第二行'),text,blocks,tag,all)
 assert.deepEqual(read,{edits:[{start:text.indexOf('乙段。'),end:text.indexOf('乙段。')+3,after:'  乙段（改）  \n第二行',index:0}]},'内容逐字保留，不去空白')
 assert.deepEqual(readBlockPlan(head+group(2,'乙段（改）',' '),text,blocks,tag,all),{edits:[{start:text.indexOf('乙段。'),end:text.indexOf('乙段。')+3,after:'乙段（改）',index:0}]},'标签行首尾空白可去')
 const removed=readBlockPlan(head+group(2,''),text,blocks,tag,all)
 assert.ok(!('reason' in removed))
 assert.deepEqual(applyPlanEdits(text,removed.edits),{text:'甲段。\n\n\n\n丙段。',edits:1},'删除只删块本身，两侧分隔符保留')
 for(const plan of [head+reviewBlockLabel(tag,2)+'\n缺结束标签',head+group(2,'x')+'\n多余说明',head.trim(),head+'<<<原文>>>\n乙段。\n<<<改为>>>\nx\n<<<结束>>>',head+'⟦块2⟧\nx\n⟦结束⟧'.replace('⟦块','⟦⟦块')])
  assert.deepEqual(readBlockPlan(plan,text,blocks,tag,all),{reason:'shape'},plan)
 assert.deepEqual(readBlockPlan(head+group(0,'x'),text,blocks,tag,all),{reason:'block-unknown:0'})
 assert.deepEqual(readBlockPlan(head+group(1,'甲段。')+'\n'+group(1,'甲段。'),text,blocks,tag,all),{edits:[],duplicates:[{index:1,of:0}],unchanged:[{index:0}]},'原样替换的重复组同样折叠并保留原始序号')
 assert.deepEqual(readBlockPlan(head+group(3,'丙'),text,blocks,tag,{first:0,last:1}),{reason:'block-outside-unit:0'})
})

test('中间组缺结束标签：下一组的块标签不能被吞进上一组内容，整份计划判为 shape，不部分应用',()=>{
 const text='甲段。\n\n乙段。\n\n丙段。',blocks=splitReviewBlocks(text),tag=reviewBlockTag(text),all={first:0,last:2},head='草稿 SHA-256：'+draftSha256(text)+'\n'
 const missingFirstEnd=head+reviewBlockLabel(tag,1)+'\n甲段（改）\n'+reviewBlockLabel(tag,2)+'\n乙段（改）\n'+tag.end
 assert.deepEqual(readBlockPlan(missingFirstEnd,text,blocks,tag,all),{reason:'shape'},'漏写第 1 组结束标签')
 const missingMiddleEnd=head+reviewBlockLabel(tag,1)+'\n甲段（改）\n'+tag.end+'\n'+reviewBlockLabel(tag,2)+'\n乙段（改）\n'+reviewBlockLabel(tag,3)+'\n丙段（改）\n'+tag.end
 assert.deepEqual(readBlockPlan(missingMiddleEnd,text,blocks,tag,all),{reason:'shape'},'漏写中间组结束标签')
 assert.deepEqual(readBlockPlan(head+reviewBlockLabel(tag,1)+'\n  '+reviewBlockLabel(tag,2)+'  \n'+tag.end,text,blocks,tag,all),{reason:'shape'},'带首尾空白的标签行同样识别')
})

test('协议组边缘的整行空白不属于块：标签下与结束标签前的空行（含只有空白的行）不计入替换内容，原样替换记 unchanged；块内空行、行内空白、表格与围栏内容逐字保留',()=>{
 const fence='```js\n\nconst a=1  \n\n```'
 const text='甲段。\n\n| 档 | 条件 |\n|---|---|\n| 升级 | ≥4 |\n\n'+fence+'\n\n  缩进行  ',blocks=splitReviewBlocks(text),tag=reviewBlockTag(text),all={first:0,last:blocks.length-1},head='草稿 SHA-256：'+draftSha256(text)+'\n'
 const body=(id:number)=>text.slice(blocks[id-1]!.start,blocks[id-1]!.end)
 const padded=(id:number,content:string,lead:string,trail:string)=>reviewBlockLabel(tag,id)+'\n'+lead+content+'\n'+trail+tag.end
 // 每块都按原样写回，但标签下、结束标签前多出空行或只有空白的行。
 const plan=head+[padded(1,body(1),'\n',''),padded(2,body(2),'','\n'),padded(3,body(3),' \n','　\n\n'),padded(4,body(4),'\t\n','')].join('\n\n')
 assert.deepEqual(readBlockPlan(plan,text,blocks,tag,all),{edits:[],unchanged:[0,1,2,3].map(index=>({index}))},'边缘整行空白规范后与原块逐字相同，不计修改')
 // 真实修改：块内的空行与行内空白、围栏内空行逐字保留，只去掉组边缘的整行空白。
 const edit=readBlockPlan(head+padded(1,'甲段（改）  \n\n新增一段','\n','\n')+'\n'+padded(3,fence.replace('const a=1','const a=2'),'\n','\n'),text,blocks,tag,all)
 assert.deepEqual(edit,{edits:[{start:blocks[0]!.start,end:blocks[0]!.end,after:'甲段（改）  \n\n新增一段',index:0},{start:blocks[2]!.start,end:blocks[2]!.end,after:'```js\n\nconst a=2  \n\n```',index:1}]})
 assert.deepEqual(readBlockPlan(head+reviewBlockLabel(tag,2)+'\n\n \n'+tag.end,text,blocks,tag,all),{edits:[{start:blocks[1]!.start,end:blocks[1]!.end,after:'',index:0}]},'只有空白行的内容仍是删除整块')
})

test('复核提示只给块编号标签与块正文，不再附文本结束标签；块编号即回执 blockId',async t=>{
 const f=await runtime(t,[text(draft),noChange,accepted(),text('多余')])
 await f.send()
 const prompt=Reflect.get(f.adapter.requests[1]!.messages.filter(message=>message.role==='user').at(-1)!.content[0]!,'text') as string
 const blocks=labelledBlocks(prompt)
 assert.equal(blocks.length,4)
 assert.deepEqual(blocks.map(block=>block.id),[1,2,3,4])
 assert.ok(prompt.includes(blocks[0]!.label+'\n'+blocks[0]!.text+'\n\n'+blocks[1]!.label))
 assert.ok(!prompt.includes(blocks[0]!.open+'结束'+blocks[0]!.close),'不再叠加文本结束标签')
})

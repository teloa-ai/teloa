import test,{type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import {ToolCallId,type StreamChunk} from '@deepseek-ai/dsh-llm'
import {defineTool} from '@deepseek-ai/dsh-tools'
import {registerConversationResultPresentation} from '../src/conversation-result-presentation.ts'
import {resultPresentationGuide} from '../src/work-prompts/result-presentation.ts'
import {loopWorkFixture,loopText} from './fixtures/native-loop-work-admission.ts'

const toolName='teloa_work_status',summaryName='本次结果的名称与状态说明'
const call=(id:string):readonly StreamChunk[]=>[
 {type:'block-start',index:0,blockType:'tool-call'},
 {type:'tool-call-delta',index:0,id:ToolCallId(id),name:toolName,argumentsDelta:'{}'},
 {type:'block-end',index:0,block:{type:'tool-call',id:ToolCallId(id),name:toolName,arguments:'{}'}},
 {type:'finish',reason:{kind:'tool-calls'}},
]
const receipt=(state:'waiting'|'completed',version:number)=>({requestId:'fixed-request',title:'本轮核对工作',members:[{name:'本人核验员',status:'received',task:{id:'fixed-task',version,state},result:'原成果正文不复述'}]})
async function fixture(t:TestContext,mode:'tools'|'missing'|'complete'){
 const f=await loopWorkFixture(t,true),receipts=[receipt('waiting',3),receipt('completed',4)];let reads=0
 f.ctx.tools.register(defineTool({name:toolName,description:'Read original work status',parameters:{},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async()=>JSON.stringify(receipts[reads++])}))
 if(mode!=='missing')await f.ctx.plugin(await import('../src/work-behavior.ts'))
 if(mode==='complete')f.agent.ctx.systemPrompt.section({name:'fixture:complete',order:1,complete:true,interpolate:false,text:'Fixed complete persona without platform result rules.'})
 registerConversationResultPresentation(f.ctx,{owner:'owner',conversation:async sessionId=>({ownerId:'owner',sessionId,status:'ready'}),readTaskPolicy:async()=>null,isRoleConversation:async()=>false})
 f.adapter.scripts.push(call('status-first'),call('status-second'),loopText)
 await f.send('original-status-question')
 assert.equal(f.adapter.requests.length,3)
 const request=f.adapter.requests.at(-1)!,texts=request.messages.flatMap(message=>message.content.flatMap(block=>block.type==='text'?[block.text]:[])),notices=request.messages.filter(message=>{const source=message.source;return source?.kind==='plugin:teloa.work'&&'form'in source&&source.form==='notice'&&'summary'in source&&source.summary===summaryName})
 return {...f,request,texts,notices,receipts}
}

test('真实Loop的系统已含呈现规则时，多次成功回包只补动态状态，原回执与独立版本不变',async t=>{
 const f=await fixture(t,'tools'),text=f.texts.join('\n')
 assert.equal(text.split(resultPresentationGuide).length-1,1,'每次工具回包不能把系统整份规则再次送入历史')
 assert.equal(f.notices.length,2,'两个真实状态回包都保留各自动态状态')
 const notices=f.notices.map(message=>message.content.flatMap(block=>block.type==='text'?[block.text]:[]).join('\n'))
 assert.match(notices[0]!,/本人核验员：已收到回复；任务状态：待验收/)
 assert.match(notices[1]!,/本人核验员：已收到回复；任务状态：已验收完成/)
 for(const notice of notices){assert.doesNotMatch(notice,/fixed-request|fixed-task|原成果正文不复述/);assert.equal(notice.includes(resultPresentationGuide),false)}
 const toolBodies=f.agent.session.snapshotEvents().filter(event=>event.type==='tool/result').map(event=>event.data.message.content.flatMap(block=>block.type==='text'?[block.text]:[]).join('\n'))
 assert.deepEqual(toolBodies,f.receipts.map(value=>JSON.stringify(value)),'原工具回包的ID、版本及正文不得改写')
})

test('缺少tools规则或被complete persona替换时，实际Loop仍得到关键呈现与状态边界',async t=>{
 for(const mode of ['missing','complete'] as const){
  const f=await fixture(t,mode),notices=f.notices.map(message=>message.content.flatMap(block=>block.type==='text'?[block.text]:[]).join('\n')).join('\n')
  assert.match(notices,/Saving is not enabling, connecting, running or publishing/)
  assert.match(notices,/Task waiting means awaiting acceptance; member waiting only means no final reply yet/)
  assert.match(notices,/本轮核对工作/);assert.match(notices,/任务状态：待验收/);assert.match(notices,/任务状态：已验收完成/)
 }
})

test('真实Loop中系统已有规则的普通资源成功不追加空notice，也不唤醒额外轮次',async t=>{
 const f=await loopWorkFixture(t,true)
 f.ctx.tools.register(defineTool({name:toolName,description:'Read resource',parameters:{},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async()=>'{"title":"本人材料","version":7}'}))
 await f.ctx.plugin(await import('../src/work-behavior.ts'))
 registerConversationResultPresentation(f.ctx,{owner:'owner',conversation:async sessionId=>({ownerId:'owner',sessionId,status:'ready'}),readTaskPolicy:async()=>null,isRoleConversation:async()=>false})
 f.adapter.scripts.push(call('resource'),loopText);await f.send('resource-status')
 assert.equal(f.adapter.requests.length,2)
 assert.equal(f.agent.session.snapshotEvents().filter(event=>event.type==='user/message'&&event.data.source.kind==='plugin:teloa.work'&&event.data.source.form==='notice'&&event.data.source.summary===summaryName).length,0)
 assert.ok(f.adapter.requests[1]!.messages.some(message=>message.role==='tool'&&message.content.some(block=>block.type==='text'&&block.text==='{"title":"本人材料","version":7}')))
})

import assert from 'node:assert/strict'
import test from 'node:test'
import {ToolCallId} from '@deepseek-ai/dsh-llm'
import {defineTool} from '@deepseek-ai/dsh-tools'
import {nativeHotSubagentFixture,type ChildMode} from './fixtures/native-hot-subagent.ts'

const options={timeout:15000}
const modes:readonly ChildMode[]=['one-shot','continuable']

for(const mode of modes)test('真实 '+mode+' 子任务沿已受理根自然到期仍完成首次模型和父下一step',options,async t=>{
 const f=await nativeHotSubagentFixture(t,mode)
 f.setToolAction(async(_exec,start)=>{f.rights.valid=false;return start()})
 await f.send()
 assert.equal(f.counts.tools,1);assert.equal(f.counts.fresh,1,'仅父首次输入申请新工作许可')
 assert.equal(f.candidates.length,1);const child=f.candidates[0]!.agent
 assert.equal(f.candidates[0]!.kind,'initial');assert.equal(f.inserted(child).length,1)
 assert.equal(f.childRequests().length,1);assert.equal(f.adapter.parentCalls,2)
 assert.ok(f.counts.continuation>0);assert.ok(f.events(child).some(event=>event.type==='assistant/message'))
 const parentResult=f.events().find(event=>event.type==='tool/result');assert.ok(parentResult)
 assert.notEqual(parentResult.data.message.isError,true)
 f.assertChildResultInParent()
 const parentEnd=f.events().filter(event=>event.type==='turn/end').at(-1);assert.ok(parentEnd)
 assert.equal(parentEnd.data.reason.kind,'completed')
})

for(const mode of modes)test('显式无工具cause '+mode+' 首次child许可有效时真实受理并执行',options,async t=>{
 const f=await nativeHotSubagentFixture(t,mode)
 assert.equal(await f.start(),'done')
 assert.equal(f.counts.fresh,1);assert.equal(f.adapter.parentCalls,0)
 assert.equal(f.candidates.length,1);assert.equal(f.inserted(f.candidates[0]!.agent).length,1)
 assert.equal(f.childRequests().length,1)
})

for(const mode of modes)test('真实 '+mode+' 子任务自身工具和下一step沿父已受理根续作并传回结果',options,async t=>{
 const f=await nativeHotSubagentFixture(t,mode),callId=ToolCallId('child-tool-call');let calls=0
 f.ctx.tools.register(defineTool({name:'hot_child_tool',description:'子任务实际工具结果',parameters:{},
  output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},
  async execute(_args,exec){calls++;assert.equal(exec.agent,f.candidates[0]!.agent);return 'actual-child-tool-result'},
 }))
 f.adapter.childScripts.push([
  {type:'block-start',index:0,blockType:'tool-call'},
  {type:'tool-call-delta',index:0,id:callId,name:'hot_child_tool',argumentsDelta:'{}'},
  {type:'block-end',index:0,block:{type:'tool-call',id:callId,name:'hot_child_tool',arguments:'{}'}},
  {type:'finish',reason:{kind:'tool-calls'}},
 ])
 f.setToolAction(async(_exec,start)=>{f.rights.valid=false;return start()})
 await f.send()
 assert.equal(calls,1);assert.equal(f.childRequests().length,2);assert.equal(f.counts.fresh,1)
 assert.ok(f.childRequests()[1]!.messages.some(message=>message.role==='tool'&&message.toolCallId===callId&&JSON.stringify(message.content)===JSON.stringify([{type:'text',text:'actual-child-tool-result'}])))
 f.assertChildResultInParent()
})

for(const mode of modes)for(const phase of ['admission','prepare'] as const)test('真实 '+mode+' '+phase+'等待期间许可代次变化拒绝旧根',options,async t=>{
 const f=await nativeHotSubagentFixture(t,mode),gate=f.gate()
 if(phase==='admission')f.setAdmission(async(candidate,dispatch)=>{await gate.wait(candidate.signal);await f.defaultAdmission(candidate,dispatch)})
 else f.adapter.childPrepareGate=gate
 const running=f.send();await gate.entered
 const child=f.candidates[0]!.agent,accepted=phase==='prepare'?1:0
 assert.equal(f.inserted(child).length,accepted);assert.equal(f.childRequests().length,0)
 f.rights.generation++;gate.release();await running
 assert.equal(f.inserted(child).length,accepted);assert.equal(f.childRequests().length,0)
 assert.equal(f.adapter.parentCalls,1);assert.equal(f.counts.fresh,1,'旧根失效不能重申请新许可')
})

for(const mode of modes)for(const phase of ['admission','prepare'] as const)test('真实 '+mode+' '+phase+'等待期间父取消阻止子首次模型和父下一步',options,async t=>{
 const f=await nativeHotSubagentFixture(t,mode),gate=f.gate()
 if(phase==='admission')f.setAdmission(async(candidate,dispatch)=>{await gate.wait(candidate.signal);await f.defaultAdmission(candidate,dispatch)})
 else f.adapter.childPrepareGate=gate
 const running=f.send();await gate.entered
 const child=f.candidates[0]!.agent,accepted=phase==='prepare'?1:0
 f.parent.cancel({kind:'user'},{keepInbox:true});gate.release();await running
 assert.equal(f.inserted(child).length,accepted);assert.equal(f.childRequests().length,0)
 assert.equal(f.adapter.parentCalls,1);assert.equal(f.counts.fresh,1)
 const end=f.events().filter(event=>event.type==='turn/end').at(-1);assert.ok(end)
 assert.equal(end.data.reason.kind,'aborted')
})

for(const mode of modes)test('真实 '+mode+' 初次子任务许可等待撤销零输入和模型，不重申请fresh',options,async t=>{
 const f=await nativeHotSubagentFixture(t,mode),gate=f.gate()
 f.setAdmission(async(candidate,dispatch)=>{await gate.wait(candidate.signal);await f.defaultAdmission(candidate,dispatch)})
 const running=f.send();await gate.entered;assert.equal(f.candidates.length,1)
 const child=f.candidates[0]!.agent;assert.equal(f.inserted(child).length,0);assert.equal(f.childRequests().length,0)
 f.rights.revoked=true;gate.release();await running
 assert.equal(f.inserted(child).length,0);assert.equal(f.childRequests().length,0);assert.equal(f.counts.fresh,1)
 assert.equal(f.adapter.parentCalls,1)
})

for(const mode of modes)test('真实 '+mode+' 工具体结束后迟到initial拒绝，旧工具scope不能降级fresh',options,async t=>{
 const f=await nativeHotSubagentFixture(t,mode),gate=f.gate();let outcome:Promise<unknown>|undefined
 f.setToolAction(async(_exec,start)=>{
  // 在真实工具 async scope 中创建的延后调用；工具先正常返回，后来不能借继承的 ALS 值续作。
  outcome=(async()=>{await gate.wait();return start()})();outcome.catch(()=>{});f.detached.push(outcome)
 })
 await f.send();await gate.entered;assert.equal(f.adapter.parentCalls,2)
 const fresh=f.counts.fresh;gate.release();await assert.rejects(outcome!,{code:'teloa/forbidden'})
 assert.equal(f.counts.fresh,fresh);assert.equal(f.childRequests().length,0)
 assert.equal(f.candidates.length,1);assert.equal(f.inserted(f.candidates[0]!.agent).length,0)
})

for(const mode of modes)test('显式无工具cause '+mode+' 首次child仍核对新工作许可',options,async t=>{
 const f=await nativeHotSubagentFixture(t,mode);f.rights.valid=false
 await assert.rejects(f.start(),{code:'teloa/forbidden'})
 assert.equal(f.counts.fresh,1);assert.equal(f.childRequests().length,0);assert.equal(f.candidates.length,1)
 assert.equal(f.inserted(f.candidates[0]!.agent).length,0)
})

for(const mode of modes)test('真实 '+mode+' child已受理后prepare等待撤销，不派发首次模型也不续父step',options,async t=>{
 const f=await nativeHotSubagentFixture(t,mode),gate=f.gate();f.adapter.childPrepareGate=gate
 const running=f.send();await gate.entered
 assert.equal(f.candidates.length,1);const child=f.candidates[0]!.agent
 assert.equal(f.inserted(child).length,1);assert.equal(f.childRequests().length,0)
 f.rights.revoked=true;gate.release();await running
 assert.equal(f.inserted(child).length,1,'受理事实保留，不冒称回滚已受理输入')
 assert.equal(f.childRequests().length,0);assert.equal(f.adapter.parentCalls,1);assert.equal(f.counts.fresh,1)
 const childEnd=f.events(child).filter(event=>event.type==='turn/end').at(-1);assert.ok(childEnd)
 assert.notEqual(childEnd.data.reason.kind,'completed')
})

for(const mode of modes)test('真实 '+mode+' child已受理后工具体结束，自然到期仍沿固定根继续模型',options,async t=>{
 const f=await nativeHotSubagentFixture(t,mode),gate=f.gate();f.adapter.childPrepareGate=gate
 let outcome:Promise<unknown>|undefined
 f.setToolAction(async(_exec,start)=>{
  f.rights.valid=false;outcome=start();outcome.catch(()=>{});f.detached.push(outcome)
  // 首次 child 已在实际工具体内受理；只有已受理后的模型准备继续留在等待点。
  await gate.entered
 })
 await f.send();assert.equal(f.adapter.parentCalls,2);assert.equal(f.childRequests().length,0)
 const child=f.candidates[0]!.agent;assert.equal(f.inserted(child).length,1)
 gate.release();await outcome
 assert.equal(f.childRequests().length,1);assert.equal(f.counts.fresh,1)
 const childEnd=f.events(child).filter(event=>event.type==='turn/end').at(-1);assert.ok(childEnd)
 assert.equal(childEnd.data.reason.kind,'completed')
})

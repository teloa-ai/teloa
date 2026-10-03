import test from 'node:test'
import assert from 'node:assert/strict'
import {ToolCallId,createUserMessage,markAgentLoopRequest,type StreamChunk} from '@deepseek-ai/dsh-llm'
import type {StreamAdmissionRuntime} from './fixtures/native-hot-causality.ts'
import {drain,hotGate,nativeHotCausalityFixture,nativeHotLlmFixture,reconstructedRequest,textAnswer,toolAnswer} from './fixtures/native-hot-causality.ts'

// 真实官方 AgentLoop/Session/LlmRuntime/ToolRuntime；外部模型仅使用确定性 adapter。
const forbidden={code:'teloa/forbidden'}
const options={timeout:10000}

test('真实首次受理后自然到期，prepare 后首步及工具后下一模型 step 都继续，新 prompt 拒绝',options,async t=>{
 const f=await nativeHotCausalityFixture(t),gate=hotGate();t.after(gate.release)
 f.adapter.prepareGate=gate;f.adapter.scripts.push(toolAnswer,textAnswer)
 await f.send('accepted-before-expiry');await gate.entered
 assert.equal(f.adapter.requests.length,0)
 f.rights.valid=false;gate.release();await f.agent.whenIdle()
 assert.equal(f.adapter.requests.length,2)
 assert.equal(f.counters.tools,1)
 assert.equal(f.events().filter(event=>event.type==='step/start').length,2)
 assert.equal(f.events().filter(event=>event.type==='tool/result').length,1)
 assert.equal(f.events().filter(event=>event.type==='turn/end').at(-1)?.data.reason.kind,'completed')
 assert.ok(f.counters.continuationAssertions>0,'真正热路径调用续作断言')
 const before=f.agent.session.seq
 await assert.rejects(f.send('new-after-expiry'),forbidden)
 assert.equal(f.agent.session.seq,before)
 assert.equal(f.adapter.requests.length,2)
})

test('有效首步工具完成时自然到期，真实下一模型 step 仍继续',options,async t=>{
 const f=await nativeHotCausalityFixture(t)
 f.adapter.scripts.push(toolAnswer,textAnswer)
 f.setToolAction(async()=>{f.rights.valid=false})
 await f.send('expiry-between-steps');await f.agent.whenIdle()
 assert.equal(f.counters.tools,1);assert.equal(f.adapter.requests.length,2)
 assert.equal(f.events().filter(event=>event.type==='step/start').length,2)
 assert.ok(f.counters.continuationAssertions>0)
})

test('真实 prepare 等待期间撤销，恢复等待后零 adapter 调用',options,async t=>{
 const f=await nativeHotCausalityFixture(t),gate=hotGate();t.after(gate.release)
 f.adapter.prepareGate=gate;f.adapter.scripts.push(textAnswer)
 await f.send('revoke-in-prepare');await gate.entered
 f.rights.revoked=true;gate.release();await f.agent.whenIdle()
 assert.equal(f.adapter.prepares.length,1);assert.equal(f.adapter.requests.length,0)
 assert.equal(f.events().filter(event=>event.type==='assistant/message').length,0)
})

for(const prepend of [true,false])test(`真实 ${prepend?'外层 prepend':'后来内层普通'} stream middleware 等待后撤销，最终派发零 adapter`,options,async t=>{
 const f=await nativeHotCausalityFixture(t),gate=hotGate();t.after(gate.release)
 const stop=f.holdStream(gate,prepend);t.after(stop)
 f.adapter.scripts.push(textAnswer)
 await f.send(`revoke-in-stream-${prepend}`);await gate.entered
 assert.equal(f.adapter.requests.length,0)
 f.rights.revoked=true;gate.release();await f.agent.whenIdle()
 assert.equal(f.adapter.requests.length,0)
 assert.equal(f.events().filter(event=>event.type==='assistant/message').length,0)
})

test('裸 followup 即使使用普通 user/rpc 标记也没有最终票据，零受理和模型调用',options,async t=>{
 const f=await nativeHotCausalityFixture(t),before=f.agent.session.seq
 const message=createUserMessage({source:{kind:'user',rpcId:'forged-accepted'},content:[{type:'text',text:'没有最终受理票据'}]})
 assert.throws(()=>f.agent.followup(message),forbidden)
 await f.agent.whenIdle()
 assert.equal(f.agent.session.seq,before)
 assert.equal(f.agent.inbox.nextTurn.length,0);assert.equal(f.adapter.requests.length,0)
})

test('已结束 step 的真实请求重建及官方 initiator 归因均不能授权下一次模型调用',options,async t=>{
 const f=await nativeHotCausalityFixture(t);f.adapter.scripts.push(textAnswer)
 await f.send('completed-root');await f.agent.whenIdle()
 assert.equal(f.adapter.requests.length,1)
 const request=reconstructedRequest(f.agent,f.adapter.requests[0]!)
 f.adapter.scripts.push(textAnswer)
 await assert.rejects(f.ctx.agents.withInitiator(f.agent,()=>drain(f.ctx.llm.stream(request))),forbidden)
 assert.equal(f.adapter.requests.length,1)
})

test('另一个精确 Session 的伪造 request 标记和 initiator 不继承已受理根',options,async t=>{
 const f=await nativeHotCausalityFixture(t);f.adapter.scripts.push(textAnswer)
 await f.send('session-a-root');await f.agent.whenIdle()
 const baseline=f.adapter.requests[0]!
 const messages=f.other.session.deriveMessages();Object.freeze(messages)
 const request=markAgentLoopRequest(Object.freeze({...baseline,sessionId:f.other.id,messages,signal:new AbortController().signal}))
 f.adapter.scripts.push(textAnswer)
 await assert.rejects(f.ctx.agents.withInitiator(f.agent,()=>drain(f.ctx.llm.stream(request))),forbidden)
 assert.equal(f.adapter.requests.length,1)
})


function finalFailure(chunks:Awaited<ReturnType<typeof drain>>,code:string){
 const finish=chunks.at(-1);assert.equal(finish?.type,'finish')
 assert.ok(finish?.type==='finish'&&finish.reason.kind==='error')
 assert.equal(finish.reason.failure.code,code)
}

test('SDK 无 required/provider 时保持官方 Free 的普通及 Prepared model 路径',options,async t=>{
 const f=await nativeHotLlmFixture(t);f.adapter.scripts.push(textAnswer,textAnswer)
 const direct=await drain(f.llm.stream(f.request()))
 const prepared=await f.llm.prepareCall({provider:'hot-test',model:'hot-model'})
 const preparedChunks=await drain(prepared.stream(f.request()))
 assert.equal(direct.at(-1)?.type,'finish');assert.equal(preparedChunks.at(-1)?.type,'finish')
 assert.equal(f.adapter.requests.length,2)
})

test('SDK require 缺 policy 的普通及 Prepared 路径终止且零 adapter',options,async t=>{
 const f=await nativeHotLlmFixture(t);f.llm.requireStreamAdmission()
 const direct=await drain(f.llm.stream(f.request()))
 const prepared=await f.llm.prepareCall({provider:'hot-test',model:'hot-model'})
 const preparedChunks=await drain(prepared.stream(f.request()))
 finalFailure(direct,'STREAM_ADMISSION_UNAVAILABLE');finalFailure(preparedChunks,'STREAM_ADMISSION_UNAVAILABLE')
 assert.equal(f.adapter.requests.length,0)
})

test('SDK 异步 policy 拒绝且接住 Promise rejection，零 adapter',options,async t=>{
 const f=await nativeHotLlmFixture(t)
 f.llm.requireStreamAdmission();f.llm.installStreamAdmission(()=>Promise.reject(new Error('fixture-policy-rejected')))
 finalFailure(await drain(f.llm.stream(f.request())),'STREAM_ADMISSION_UNAVAILABLE')
 await new Promise<void>(done=>setImmediate(done))
 assert.equal(f.adapter.requests.length,0)
})

test('SDK 唯一 holder 在原 receiver 及 scoped receiver 都不可替换',options,async t=>{
 const f=await nativeHotLlmFixture(t);f.llm.requireStreamAdmission()
 const replacement=Object.freeze({require(){},install(){},assert(){}})
 const scoped=f.ctx.extend().llm as StreamAdmissionRuntime
 for(const receiver of [f.llm,scoped]){
  assert.equal(Reflect.set(receiver,'streamAdmission',replacement),false)
  assert.throws(()=>Object.defineProperty(receiver,'streamAdmission',{value:replacement}),TypeError)
  finalFailure(await drain(receiver.stream(f.request())),'STREAM_ADMISSION_UNAVAILABLE')
 }
 const policy=()=>{};f.llm.installStreamAdmission(policy)
 assert.throws(()=>f.llm.installStreamAdmission(()=>{}))
 assert.equal(f.adapter.requests.length,0)
})

for(const preparedPath of [false,true])test(`SDK ${preparedPath?'Prepared':'普通'} 最终派发在后来 middleware await 后重核，零 adapter`,options,async t=>{
 const f=await nativeHotLlmFixture(t),gate=hotGate();t.after(gate.release)
 let current=true,seen=0
 f.llm.requireStreamAdmission();f.llm.installStreamAdmission(()=>{seen++;if(!current)throw new Error('fixture-revoked')})
 f.ctx.on('llm/stream',async function*(request,next){await gate.wait(request.signal);yield* next()})
 const stream=preparedPath?(await f.llm.prepareCall({provider:'hot-test',model:'hot-model'})).stream(f.request()):f.llm.stream(f.request())
 const run=drain(stream);await gate.entered;current=false;gate.release()
 finalFailure(await run,'UNKNOWN')
 assert.ok(seen>0);assert.equal(f.adapter.requests.length,0)
})


test('SDK 已派发的首 chunk 不回滚，撤销在后续 iterator.next 前终止实际 adapter 迭代',options,async t=>{
 const f=await nativeHotLlmFixture(t);let current=true
 f.llm.requireStreamAdmission();f.llm.installStreamAdmission(()=>{if(!current)throw new Error('fixture-revoked')})
 f.adapter.scripts.push(textAnswer)
 const iterator=f.llm.stream(f.request())[Symbol.asyncIterator]()
 assert.equal((await iterator.next()).value?.type,'block-start')
 assert.equal(f.adapter.requests.length,1);assert.equal(f.adapter.yielded.length,1)
 current=false
 const rejected=await iterator.next();assert.equal(rejected.done,false)
 finalFailure([rejected.value!],'UNKNOWN')
 assert.equal(f.adapter.requests.length,1);assert.equal(f.adapter.yielded.length,1)
 assert.equal((await iterator.next()).done,true)
})


test('真实工具 deferContext 沿已受理根自然到期续作，经官方 next-step 消息进入下一模型',options,async t=>{
 const f=await nativeHotCausalityFixture(t)
 const context=createUserMessage({source:{kind:'user',rpcId:'context-from-real-tool'},content:[{type:'text',text:'tool-owned-context'}]})
 f.adapter.scripts.push(toolAnswer,textAnswer)
 f.setToolAction(async exec=>{f.rights.valid=false;exec.deferContext(context)})
 await f.send('accepted-tool-context');await f.agent.whenIdle()
 assert.equal(f.counters.tools,1);assert.equal(f.toolExecutions[0]?.agent,f.agent)
 assert.equal(f.adapter.requests.length,2)
 assert.equal(f.authorizations.length,1,'工具续作不重建新工作许可')
 const inserted=f.events().filter(event=>event.type==='agent/inbox/spliced').flatMap(event=>event.data.inserted)
 assert.equal(inserted.filter(message=>message.id===context.id).length,1)
 assert.ok(JSON.stringify(f.adapter.requests[1]!.messages).includes('tool-owned-context'))
 assert.equal(f.events().filter(event=>event.type==='turn/end').at(-1)?.data.reason.kind,'completed')
 assert.ok(f.counters.continuationAssertions>0)
})

test('真实工具 body 等待时撤销，deferContext 不获得新插入且没有第二模型调用',options,async t=>{
 const f=await nativeHotCausalityFixture(t),gate=hotGate();t.after(gate.release)
 const context=createUserMessage({source:{kind:'user',rpcId:'context-after-revocation'},content:[{type:'text',text:'revoked-tool-context'}]})
 f.adapter.scripts.push(toolAnswer,textAnswer)
 f.setToolAction(async exec=>{await gate.wait(exec.signal);exec.deferContext(context)})
 await f.send('revoke-real-tool-context');await gate.entered
 assert.equal(f.adapter.requests.length,1);assert.equal(f.counters.tools,1)
 f.rights.revoked=true;gate.release();await f.agent.whenIdle()
 const inserted=f.events().filter(event=>event.type==='agent/inbox/spliced').flatMap(event=>event.data.inserted)
 assert.equal(inserted.filter(message=>message.id===context.id).length,0)
 assert.equal(f.agent.inbox.nextStep.filter(message=>message.id===context.id).length,0)
 assert.equal(f.adapter.requests.length,1)
})

test('官方 initiator 加手造 callId 不构成真实 model tool-call 因果，零工具 body 和附加上下文',options,async t=>{
 const f=await nativeHotCausalityFixture(t),gate=hotGate();t.after(gate.release)
 const context=createUserMessage({source:{kind:'user',rpcId:'forged-tool-context'},content:[{type:'text',text:'forged-tool-context'}]})
 f.adapter.prepareGate=gate;f.adapter.scripts.push(textAnswer)
 f.setToolAction(async exec=>{exec.deferContext(context)})
 await f.send('root-before-forged-tool');await gate.entered
 const result=await f.ctx.agents.withInitiator(f.agent,()=>f.ctx.tools.execute({
  callId:ToolCallId('forged-call'),name:'hot_result',arguments:{},agent:f.agent,signal:new AbortController().signal,
 }))
 assert.equal(result.isError,true);assert.equal(f.counters.tools,0)
 gate.release();await f.agent.whenIdle()
 const inserted=f.events().filter(event=>event.type==='agent/inbox/spliced').flatMap(event=>event.data.inserted)
 assert.equal(inserted.filter(message=>message.id===context.id).length,0)
 assert.equal(f.adapter.requests.length,0)
})


test('P1 真实受理但尚未 Loop claim，公开 turn/claimed/prestep 和 initiator 不得伪造模型执行',options,async t=>{
 const f=await nativeHotCausalityFixture(t);f.adapter.scripts.push(textAnswer)
 await f.send('accepted-without-driver',f.agent,false)
 const exact=f.agent.inbox.nextTurn[0];assert.ok(exact)
 assert.equal(f.agent.inbox.remove(exact.id),true)
 const signal=new AbortController().signal,turn=42,step=1
 let rejected=false
 try{
  f.ctx.emit('session/event',f.agent.session,{type:'turn/start',seq:f.sessionPackage.SessionSeq(f.agent.session.seq-1),time:1,data:{turn}})
  f.ctx.emit('agent/inbox/claimed',{agent:f.agent,message:exact,turn})
  await f.ctx.waterfall('agent/pre-step',{agent:f.agent,messages:[exact],turn,step,signal},()=>Promise.resolve({kind:'enter' as const,messages:[exact]}))
  f.ctx.emit('session/event',f.agent.session,{type:'step/start',seq:f.sessionPackage.SessionSeq(f.agent.session.seq-1),time:1,data:{turn,step}})
  const messages=f.agent.session.deriveMessages();Object.freeze(messages)
  const request=markAgentLoopRequest(Object.freeze({provider:'hot-test',model:'hot-model',sessionId:f.agent.id,messages,signal}))
  const chunks=await f.ctx.agents.withInitiator(f.agent,()=>drain(f.ctx.llm.stream(request)))
  rejected=chunks.some(chunk=>chunk.type==='finish'&&chunk.reason.kind==='error')
 }catch{rejected=true}
 assert.equal(f.adapter.requests.length,0,'公开事件不能冒充真实 Loop phase')
 assert.equal(rejected,true)
})

test('P1 真 active step 内 marked request 克隆和 initiator 不得多派发一次 adapter',options,async t=>{
 const f=await nativeHotCausalityFixture(t);f.adapter.scripts.push(textAnswer,textAnswer)
 let attempted=false,rejected=false
 f.ctx.on('llm/stream',async function*(request,next){
  if(!attempted){
   attempted=true
   const clone=markAgentLoopRequest(Object.freeze({...request}))
   try{
    const chunks=await f.ctx.agents.withInitiator(f.agent,()=>drain(f.ctx.llm.stream(clone)))
    rejected=chunks.some(chunk=>chunk.type==='finish'&&chunk.reason.kind==='error')
   }catch{rejected=true}
  }
  yield* next()
 },{prepend:true})
 await f.send('exact-active-model');await f.agent.whenIdle()
 assert.equal(attempted,true)
 assert.equal(f.adapter.requests.length,1,'仅真实原模型 attempt 允许执行')
 assert.equal(rejected,true)
})

test('P1 后来 tools/execute middleware await 后撤销，在最终工具体入口零 body',options,async t=>{
 const f=await nativeHotCausalityFixture(t),gate=hotGate();t.after(gate.release)
 f.adapter.scripts.push(toolAnswer,textAnswer)
 f.ctx.on('tools/execute',async(exec,next)=>{await gate.wait(exec.signal);return next()})
 await f.send('revoke-before-final-tool-body');await gate.entered
 assert.equal(f.adapter.requests.length,1);assert.equal(f.counters.tools,0)
 f.rights.revoked=true;gate.release();await f.agent.whenIdle()
 assert.equal(f.counters.tools,0,'进入工具体前必须在下游 await 后再校验')
 assert.equal(f.adapter.requests.length,1)
})

function toolCall(id:string):readonly StreamChunk[]{
 return toolAnswer.map(chunk=>chunk.type==='tool-call-delta'?{...chunk,id:ToolCallId(id)}
  :chunk.type==='block-end'&&chunk.block.type==='tool-call'?{...chunk,block:{...chunk.block,id:ToolCallId(id)}}:chunk)
}

test('热修复：已登记工具清空 Agent 后撤销，最终工具体必须拒绝',options,async t=>{
 const f=await nativeHotCausalityFixture(t)
 f.adapter.scripts.push(toolAnswer,textAnswer)
 f.ctx.on('tools/execute',async(exec,next)=>{
  Reflect.deleteProperty(exec,'agent');f.rights.revoked=true
  return next()
 })
 await f.send('cleared-tool-agent');await f.agent.whenIdle()
 t.diagnostic(JSON.stringify({bodyCalls:f.counters.tools,modelCalls:f.adapter.requests.length}))
 assert.equal(f.rights.revoked,true)
 assert.equal(f.counters.tools,0,'不能按可变 exec.agent 跳过已登记 cause')
 assert.equal(f.adapter.requests.length,1)
})

test('热修复：token getter 在最终身份读取中撤销，零工具体',options,async t=>{
 const f=await nativeHotCausalityFixture(t);let reads=0
 f.adapter.scripts.push(toolAnswer,textAnswer)
 f.ctx.on('tools/execute',async(exec,next)=>{
  const token=exec.token
  Object.defineProperty(exec,'token',{configurable:true,get(){reads++;f.rights.revoked=true;return token}})
  return next()
 })
 await f.send('tool-identity-getter-revocation');await f.agent.whenIdle()
 t.diagnostic(JSON.stringify({identityReads:reads,bodyCalls:f.counters.tools}))
 assert.ok(reads>0);assert.equal(f.rights.revoked,true)
 assert.equal(f.counters.tools,0,'身份 getter 之后必须保留最终许可复核')
 assert.equal(f.adapter.requests.length,1)
})

test('热修复：自然到期后同一完整工具消息不能跨 call 再次受理',options,async t=>{
 const f=await nativeHotCausalityFixture(t)
 const context=createUserMessage({source:{kind:'tool',callId:ToolCallId('context-first')},content:[{type:'text',text:'仅首次受理'}]})
 f.adapter.scripts.push(toolCall('context-first'),toolCall('context-second'),textAnswer)
 f.setToolAction(async exec=>{f.rights.valid=false;exec.deferContext(context)})
 await f.send('cross-call-context-replay');await f.agent.whenIdle()
 const copies=f.events().filter(event=>event.type==='agent/inbox/spliced').flatMap(event=>event.data.inserted).filter(message=>message.id===context.id)
 t.diagnostic(JSON.stringify({acceptedCopies:copies.length,bodyCalls:f.counters.tools,modelCalls:f.adapter.requests.length,newAuthorizations:f.authorizations.length}))
 assert.equal(f.counters.tools,2);assert.equal(f.authorizations.length,1)
 assert.equal(copies.length,1,'已受理消息身份不能通过另一个真实 call 重放')
 assert.equal(f.adapter.requests.length,2)
})

test('热修复：同 Session 派生上下文保持原始根，续作断言线性增长',options,async t=>{
 const counts:number[]=[]
 for(const size of [5,10]){
  const f=await nativeHotCausalityFixture(t);let contexts=0
  f.adapter.scripts.push(...Array.from({length:size},(_,index)=>toolCall('flat-call-'+index)),textAnswer)
  f.setToolAction(async exec=>{
   f.rights.valid=false
   exec.deferContext(createUserMessage({source:{kind:'user',rpcId:'flat-context-'+ ++contexts},content:[{type:'text',text:'实际工具上下文 '+contexts}]}))
  })
  await f.send('flat-root-'+size);await f.agent.whenIdle()
  assert.equal(f.counters.tools,size);assert.equal(f.adapter.requests.length,size+1)
  assert.equal(f.authorizations.length,1)
  assert.equal(f.events().filter(event=>event.type==='turn/end').at(-1)?.data.reason.kind,'completed')
  counts.push(f.counters.continuationAssertions)
 }
 t.diagnostic(JSON.stringify({contexts:[5,10],continuationAssertions:counts}))
 assert.ok(counts[1]!<=counts[0]!*2.5,'派生消息不能递归复制之前的全部证明')
 assert.ok(counts[1]!<1000,'十个合法上下文不应触发成万次授权断言')
})

for(const mode of ['clear','replace'] as const)test('热边界：许可仍有效时工具 Agent '+mode+' 也不能替换原 cause',options,async t=>{
 const f=await nativeHotCausalityFixture(t);f.adapter.scripts.push(toolAnswer,textAnswer)
 f.ctx.on('tools/execute',async(exec,next)=>{
  if(mode==='clear')Reflect.deleteProperty(exec,'agent')
  else Reflect.set(exec,'agent',f.other)
  return next()
 })
 await f.send('tool-agent-'+mode);await f.agent.whenIdle()
 assert.equal(f.rights.revoked,false);assert.equal(f.counters.tools,0)
 assert.equal(f.adapter.requests.length,1)
})

test('热边界：最终许可回调更换刚捕获的 token，纯字段复核仍拒绝工具体',options,async t=>{
 const f=await nativeHotCausalityFixture(t);let changed=false
 f.adapter.scripts.push(toolAnswer,textAnswer)
 f.ctx.on('tools/execute',async(exec,next)=>{
  Object.defineProperty(f.rights,'revoked',{configurable:true,get(){changed=true;Reflect.set(exec,'token',Symbol('reentrant-token'));return false}})
  return next()
 })
 await f.send('permission-changes-identity');await f.agent.whenIdle()
 assert.equal(changed,true);assert.equal(f.counters.tools,0)
 assert.equal(f.adapter.requests.length,1)
})

test('热边界：同 Session 下一 turn 的克隆及改正文仍不能重放已受理上下文身份',options,async t=>{
 const f=await nativeHotCausalityFixture(t)
 const context=createUserMessage({source:{kind:'user',rpcId:'replay-across-turns'},content:[{type:'text',text:'首次内容'}]})
 f.setToolAction(async exec=>{exec.deferContext(context)})
 f.adapter.scripts.push(toolCall('first-turn'),textAnswer)
 await f.send('original-turn');await f.agent.whenIdle()
 const clone=structuredClone(context);clone.content=[{type:'text',text:'同 id 更改正文及来源'}];clone.source={kind:'user',rpcId:'changed-source'}
 f.setToolAction(async exec=>{f.rights.valid=false;exec.deferContext(clone)})
 f.adapter.scripts.push(toolCall('second-turn'),textAnswer)
 await f.send('next-turn');await f.agent.whenIdle()
 assert.equal(f.events().filter(event=>event.type==='agent/inbox/spliced').flatMap(event=>event.data.inserted).filter(message=>message.id===context.id).length,1)
 assert.equal(f.counters.tools,2);assert.equal(f.adapter.requests.length,3)
 assert.equal(f.authorizations.length,2)
})

for(const mode of ['revoked','generation','close','session'] as const)test('热边界：扁平化消息实际 claim 后 '+mode+' 仍阻止下一模型',options,async t=>{
 const f=await nativeHotCausalityFixture(t),gate=hotGate();t.after(gate.release)
 const context=createUserMessage({source:{kind:'user',rpcId:'claimed-flat-context'},content:[{type:'text',text:'已实际受理的派生输入'}]})
 f.adapter.scripts.push(toolAnswer,textAnswer)
 f.setToolAction(async exec=>{f.rights.valid=false;exec.deferContext(context)})
 f.ctx.on('agent/pre-step',async(position,next)=>{if(position.agent===f.agent&&position.step===2)await gate.wait(position.signal);return next()})
 await f.send('flat-context-'+mode);await gate.entered
 assert.equal(f.agent.inbox.nextStep.length,0,'真实 Loop 已 claim 派生输入')
 assert.equal(f.events().filter(event=>event.type==='agent/inbox/spliced').flatMap(event=>event.data.inserted).filter(message=>message.id===context.id).length,1)
 const session=f.agent.session
 if(mode==='close')f.work.close()
 else if(mode==='session')assert.equal(Reflect.set(f.agent,'session',f.other.session),true)
 else if(mode==='generation')f.rights.generation++
 else f.rights.revoked=true
 try{gate.release();await f.agent.whenIdle()}finally{if(mode==='session')Reflect.set(f.agent,'session',session)}
 assert.equal(f.adapter.requests.length,1);assert.equal(f.counters.tools,1)
 assert.equal(f.authorizations.length,1)
})

test('热边界：最终 Session 否决派生输入，不登记受理或消耗该消息身份',options,async t=>{
 const f=await nativeHotCausalityFixture(t)
 const context=createUserMessage({source:{kind:'user',rpcId:'vetoed-flat-context'},content:[{type:'text',text:'尚未受理'}]})
 const stop=f.ctx.on('internal/dispatch',(_mode,name,args)=>{
  if(name!=='session/event')return
  const event=args[1] as import('@deepseek-ai/dsh-session').SessionEvent
  if(event.type==='agent/inbox/spliced'&&event.data.inserted.some(message=>message.id===context.id))throw Error('final context veto')
 },{global:true})
 t.after(stop)
 f.adapter.scripts.push(toolAnswer,textAnswer)
 f.setToolAction(async exec=>{exec.deferContext(context)})
 await f.send('veto-context');await f.agent.whenIdle()
 assert.equal(f.events().filter(event=>event.type==='agent/inbox/spliced').flatMap(event=>event.data.inserted).filter(message=>message.id===context.id).length,0)
 assert.equal(f.adapter.requests.length,1)
 stop()
 // 失败的发布不能合成 proof；随后独立新许可和实际 append 才能受理同一消息。
 await f.work.withNewInput(f.agent,context,{producer:'prompt',identity:'admit-after-veto'},()=>f.agent.followup(context))
 await f.agent.whenIdle()
 assert.equal(f.adapter.requests.length,2);assert.equal(f.authorizations.length,2)
 assert.equal(f.events().filter(event=>event.type==='agent/inbox/spliced').flatMap(event=>event.data.inserted).filter(message=>message.id===context.id).length,1)
})

test('热边界：真实工具嵌套调用保留 SDK 原参数、parent token 与自然到期续作',options,async t=>{
 const f=await nativeHotCausalityFixture(t);let nested=false
 f.adapter.scripts.push(toolAnswer,textAnswer)
 f.setToolAction(async exec=>{
  if(exec.parent!==undefined){nested=true;return}
  f.rights.valid=false
  const result=await f.ctx.tools.execute({callId:ToolCallId('nested-hot-call'),rootCallId:exec.rootCallId,parent:exec.token,name:exec.name,arguments:{},agent:f.agent,signal:exec.signal})
  assert.equal(result.isError,false)
 })
 await f.send('nested-tool-proof');await f.agent.whenIdle()
 assert.equal(nested,true);assert.equal(f.counters.tools,2)
 assert.equal(f.adapter.requests.length,2);assert.equal(f.authorizations.length,1)
 assert.equal(f.events().filter(event=>event.type==='turn/end').at(-1)?.data.reason.kind,'completed')
})

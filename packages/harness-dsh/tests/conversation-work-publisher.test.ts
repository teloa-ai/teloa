import test,{type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import {Context} from '@deepseek-ai/cordis'
import {createHash} from 'node:crypto'
import {LlmRuntime,createUserMessage} from '@deepseek-ai/dsh-llm'
import {ToolRuntime,defineTool} from '@deepseek-ai/dsh-tools'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {Session,SessionStore,SessionId} from '@deepseek-ai/dsh-session'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {WorkError} from '@teloa/contract'
import {publishConversationWorkStatus} from '../src/conversation-work-publisher.ts'
import type {ConversationWorkStatus} from '../src/conversation-work-dispatch.ts'
import {readSessionEvents} from '../src/session-events.ts'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {LoopWorkAdapter,loopTool,loopText} from './fixtures/native-loop-work-admission.ts'
import {nativeProviderKernel} from './fixtures/native-input-provider.ts'
import {createNativeWorkInput} from '../src/native-work-input.ts'
import {WorkAccess} from '../../backend/src/work/work-access.ts'
const status:ConversationWorkStatus={requestId:'request',sessionId:'origin',kind:'task',title:'客户核对',scope:'sales',observedAt:'2026-09-29T00:00:00Z',stoppedAt:null,counts:{received:1,waiting:0,unavailable:0,failed:0,stopped:0},members:[{roleId:'role',name:'客户同事',scope:'sales',status:'received',result:'实际结果，待本人核对',task:{id:'task',title:'客户核对',scope:'sales',version:1,state:'ready',assigneeRoleId:'role'}}]}
async function fixture(){
 const ctx=new Context();await ctx.plugin(LlmRuntime);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 const {agent}=await ctx.agents.create({sessionId:SessionId('origin'),agentOptions:{provider:'test',model:'test'}})
 let afterResolve=async()=>{},flushOk=true,flushes=0
 const host={agents:ctx.agents,sessionController:{resolveAgent:async()=>{await afterResolve();return {agent}}},sessions:{get:ctx.sessions.get.bind(ctx.sessions),flush:async()=>{flushes++;return flushOk}}} as unknown as Context
 return {ctx,host,agent,resolve:(f:typeof afterResolve)=>afterResolve=f,flush:(ok:boolean)=>flushOk=ok,get flushes(){return flushes},messages:()=>agent.session.snapshotEvents().filter(e=>e.type==='user/message')}
}
test('resolveAgent等待期间撤销scope授权时不追加正文或flush',async t=>{
 const f=await fixture();t.after(()=>f.ctx.fiber.dispose());let allowed=true
 f.resolve(async()=>{allowed=false})
 await assert.rejects(publishConversationWorkStatus(f.host,status,async()=>{if(!allowed)throw new WorkError('teloa/forbidden','业务已撤权')}),{code:'teloa/forbidden'})
 assert.equal(f.messages().length,0);assert.equal(f.flushes,0)
})
test('resolveAgent等待期间交办锁失效，不得追加正文或flush',async t=>{
 const f=await fixture();t.after(()=>f.ctx.fiber.dispose());const lock=new AbortController()
 f.resolve(async()=>{lock.abort(new WorkError('teloa/storage-unavailable','交办锁已失效'))})
 await assert.rejects(publishConversationWorkStatus(f.host,status,async()=>{},lock.signal),{code:'teloa/storage-unavailable'})
 assert.equal(f.messages().length,0);assert.equal(f.flushes,0)
})
test('resolve后同一session已换Agent时不向旧实例追加或flush',async t=>{
 const f=await fixture();t.after(()=>f.ctx.fiber.dispose())
 Reflect.set(f.host,'agents',{get:()=>undefined})
 await assert.rejects(publishConversationWorkStatus(f.host,status,async()=>{}),{code:'teloa/session-unavailable'})
 assert.equal(f.messages().length,0);assert.equal(f.flushes,0)
})
test('原生notice回执幂等；flush失败不能冒充持久完成，重试不重复消息',async t=>{
 const f=await fixture();t.after(()=>f.ctx.fiber.dispose());f.flush(false)
 await assert.rejects(publishConversationWorkStatus(f.host,status,async()=>{}),{code:'teloa/session-unavailable'})
 assert.equal(f.messages().length,1);f.flush(true)
 await publishConversationWorkStatus(f.host,{...status,observedAt:'later'},async()=>{})
 assert.equal(f.messages().length,1);assert.equal(f.flushes,2)
 const text=JSON.stringify(f.messages()[0]);assert.match(text,/实际结果/);assert.match(text,/待本人核对/)
})
test('notice已持久化但通知标记丢失后，本人结项不应重复发布同一运行结果',async t=>{
 const f=await fixture();t.after(()=>f.ctx.fiber.dispose())
 const waiting:ConversationWorkStatus={...status,members:[{...status.members[0]!,task:{...status.members[0]!.task!,version:3,state:'waiting'}}]}
 await publishConversationWorkStatus(f.host,waiting,async()=>{})
 // 模拟 flush 成功、notified 写入前退出；重新读取时任务已由本人验收。
 const completed:ConversationWorkStatus={...waiting,observedAt:'later',members:[{...waiting.members[0]!,task:{...waiting.members[0]!.task!,version:4,state:'completed'}}]}
 await publishConversationWorkStatus(f.host,completed,async()=>{})
 assert.equal(f.messages().length,1,'本人验收只改变 Task，不产生第二份执行结果通知')
 assert.equal(f.flushes,2,'恢复仍需核实原 notice 持久化')
})
test('失败恢复后真正不同的结果仍发布，不按requestId吞掉新结果',async t=>{
 const f=await fixture();t.after(()=>f.ctx.fiber.dispose())
 const failed:ConversationWorkStatus={...status,counts:{...status.counts,received:0,failed:1},members:[{...status.members[0]!,status:'failed',result:'阶段结果',reason:'需要恢复'}]}
 await publishConversationWorkStatus(f.host,failed,async()=>{})
 await publishConversationWorkStatus(f.host,status,async()=>{})
 assert.equal(f.messages().length,2)
})
test('旧版status摘要回执在本人结项后仍与原通知正文去重',async t=>{
 const f=await fixture();t.after(()=>f.ctx.fiber.dispose())
 const {observedAt:_,...old}=status,receipt=createHash('sha256').update(JSON.stringify(old)).digest('hex')
 const text='客户核对：收到 1，等待 0，不可用 0，失败 0，已停止 0\n\n以下为本次真实执行结果；收到回复不等于业务已验收。\n\n### 客户同事\n已收到\n\n实际结果，待本人核对'
 f.agent.session.append('user/message',createUserMessage({source:{kind:'plugin:teloa.work',form:'notice',summary:'客户核对结果',requestId:status.requestId,receipt},content:[{type:'text',text}]}),{surfaceOp:'append'})
 await publishConversationWorkStatus(f.host,{...status,members:[{...status.members[0]!,task:{...status.members[0]!.task!,version:4,state:'completed'}}]},async()=>{})
 assert.equal(f.messages().length,1);assert.equal(f.flushes,1)
})
test('相同请求的真实结果正文发生变化时，不被旧notice吞掉',async t=>{
 const f=await fixture();t.after(()=>f.ctx.fiber.dispose())
 await publishConversationWorkStatus(f.host,status,async()=>{})
 await publishConversationWorkStatus(f.host,{...status,members:[{...status.members[0]!,result:'新的可核验结果'}]},async()=>{})
 assert.equal(f.messages().length,2)
})
test('官方Session从已保存事件重新恢复后，任务验收及原请求重试仍只有一条notice',async t=>{
 const f=await fixture();t.after(()=>f.ctx.fiber.dispose())
 await publishConversationWorkStatus(f.host,status,async()=>{})
 const restored=Session.create(SessionId('origin'),JSON.parse(JSON.stringify(readSessionEvents(f.agent.session))),f.agent.session.header)
 let flushes=0
 const agent={id:restored.id,session:restored,status:'idle'}
 const host={agents:{get:()=>agent},sessionController:{resolveAgent:async()=>({agent})},sessions:{get:()=>restored,flush:async()=>{flushes++;return true}}} as unknown as Context
 await publishConversationWorkStatus(host,{...status,members:[{...status.members[0]!,task:{...status.members[0]!.task!,version:4,state:'completed'}}]},async()=>{})
 assert.equal(readSessionEvents(restored).filter(event=>event.type==='user/message').length,1)
 assert.equal(flushes,1)
})
test('超限正文不因任务验收重复通知，也不把新正文被截短后的相同入口误当旧结果',async t=>{
 const f=await fixture();t.after(()=>f.ctx.fiber.dispose())
 const long:ConversationWorkStatus={...status,members:[{...status.members[0]!,result:'文'.repeat(50000)}]}
 await publishConversationWorkStatus(f.host,long,async()=>{})
 await publishConversationWorkStatus(f.host,{...long,members:[{...long.members[0]!,task:{...long.members[0]!.task!,version:4,state:'completed'}}]},async()=>{})
 assert.equal(f.messages().length,1)
 await publishConversationWorkStatus(f.host,{...long,members:[{...long.members[0]!,result:'字'.repeat(50000)}]},async()=>{})
 assert.equal(f.messages().length,2)
})
test('超限结果回流明确任务入口与保留说明，不无界塞入notice',async t=>{
 const f=await fixture();t.after(()=>f.ctx.fiber.dispose())
 await publishConversationWorkStatus(f.host,{...status,members:[{...status.members[0]!,result:'文'.repeat(50000)}]},async()=>{})
 const message=f.messages()[0]!,body=JSON.stringify(message.data.content)
 assert.ok(Buffer.byteLength(body)<131072);assert.match(body,/结果较长/);assert.match(body,/task/);assert.match(body,/待.*核对/)
})

async function nativeFixture(t:TestContext,root:string,resume=false){
 const {ctx,persistencePackage,loopPackage}=await nativeProviderKernel(t)
 await ctx.plugin(persistencePackage,{root,compression:'none'})
 const adapter=new LoopWorkAdapter();ctx.llm.registerAdapter(['loop-test'],adapter)
 const input=createNativeWorkInput(ctx,new WorkAccess());t.after(()=>input.close())
 await ctx.plugin(loopPackage.AgentLoop,{agents:[]})
 const options={agentOptions:{provider:'loop-test',model:'loop-model'}}
 const {agent}=resume?await ctx.agents.resume({...options,resumeSessionId:SessionId('origin')}):await ctx.agents.create({...options,sessionId:SessionId('origin')})
 const host={agents:ctx.agents,sessionController:{resolveAgent:async()=>({agent})},sessions:ctx.sessions} as unknown as Context
 return {ctx,agent,host,adapter,send:async(rpcId:string)=>{
  const message=createUserMessage({source:{kind:'user',rpcId},content:[{type:'text',text:'合成本人等待'}]})
  await input.withNewInput(agent,message,{producer:'prompt',identity:rpcId},()=>agent.followup(message))
 },notices:()=>readSessionEvents(agent.session).filter(event=>event.type==='user/message'&&event.data.source.kind==='plugin:teloa.work'&&event.data.source.requestId===status.requestId)}
}
function registerWait(ctx:Context){
 let entered!:()=>void,release!:()=>void
 const started=new Promise<void>(resolve=>entered=resolve),wait=new Promise<void>(resolve=>release=resolve)
 ctx.tools.register(defineTool({name:'loop_wait',description:'合成等待工具',parameters:{},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async(_args,exec)=>{
  entered()
  await Promise.race([wait,new Promise<never>((_resolve,reject)=>{exec.signal.addEventListener('abort',()=>reject(exec.signal.reason),{once:true})})])
  exec.signal.throwIfAborted();return '真实等待返回'
 }}))
 return {started,release,script:loopTool.map(chunk=>chunk.type==='tool-call-delta'?{...chunk,name:'loop_wait'}:chunk.type==='block-end'&&chunk.block.type==='tool-call'?{...chunk,block:{...chunk.block,name:'loop_wait'}}:chunk)}
}
test('正式native final guard下工具与pre-step等待期间只保留pending；闲置回流且每call仅一条真实结果', {timeout:10000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'teloa-work-notice-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const f=await nativeFixture(t,root),tool=registerWait(f.ctx)
 let entered!:()=>void,release!:()=>void
 const claimed=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>release=resolve)
 f.ctx.on('agent/pre-step',async({messages},next)=>{
  if(f.agent.session.snapshotEvents().some(event=>event.type==='tool/result')){entered();await gate}
  return next()
 })
 f.adapter.scripts.push(tool.script,loopText)
 await f.send('synthetic-owner-wait');await tool.started
 assert.equal(await publishConversationWorkStatus(f.host,status,async()=>{}),false)
 assert.equal(await publishConversationWorkStatus(f.host,status,async()=>{}),false)
 assert.equal(f.notices().length,0);assert.equal(f.agent.inbox.nextStep.length,0,'绝不借裸inject绕过final guard')
 tool.release();await claimed
 assert.equal(await publishConversationWorkStatus(f.host,status,async()=>{}),false)
 assert.equal(f.notices().length,0);assert.equal(f.agent.inbox.nextStep.length,0,'pre-step仍活动，不插入结果或输入')
 release();await f.agent.whenIdle()
 assert.equal(await publishConversationWorkStatus(f.host,status,async()=>{}),true)
 assert.equal(await publishConversationWorkStatus(f.host,status,async()=>{}),true)
 const events=readSessionEvents(f.agent.session),results=events.filter(event=>event.type==='tool/result')
 assert.equal(results.length,1);assert.equal(results[0]!.data.message.isError,false)
 assert.equal(f.notices().length,1);assert.ok(results[0]!.seq<f.notices()[0]!.seq)
 assert.equal(f.adapter.requests.length,2);assert.equal(events.filter(event=>event.type==='turn/start').length,1)
 const messages=f.adapter.requests[1]!.messages,pending=new Set<string>(),resultIds:string[]=[]
 for(const message of messages){
  if(message.role==='assistant'){for(const block of message.content)if(block.type==='tool-call')pending.add(block.id)}
  else if(message.role==='tool'){assert.ok(pending.delete(message.toolCallId),'仅真实调用能有一条返回');resultIds.push(message.toolCallId);assert.equal(message.isError,false)}
  else if(message.role==='user')assert.equal(pending.size,0,'notice必须排在完整tool-call/result之后，不触发缺结果补偿')
 }
 assert.equal(resultIds.length,1);assert.equal(new Set(resultIds).size,1);assert.equal(pending.size,0)
 assert.ok(!JSON.stringify(messages).includes(status.members[0]!.result!),'活动模型未消费异步notice')
 assert.ok(JSON.stringify(f.notices()).includes(status.members[0]!.result!))
 assert.ok(events.find(event=>event.type==='turn/end')!.seq<f.notices()[0]!.seq)
 const unadmitted=createUserMessage({source:{kind:'user'},content:[{type:'text',text:'未授权直接输入'}]})
 assert.throws(()=>f.agent.inject(unadmitted),{code:'teloa/forbidden'},'final guard继续拒绝无受理根的输入')
})
test('活动中不标回流完成；真实取消及持久会话恢复后结果仍完整且只追加一次', {timeout:10000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'teloa-work-notice-restore-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const first=await nativeFixture(t,root),tool=registerWait(first.ctx)
 first.adapter.scripts.push(tool.script)
 await first.send('synthetic-owner-cancel');await tool.started
 assert.equal(await publishConversationWorkStatus(first.host,status,async()=>{}),false)
 assert.equal(first.agent.inbox.nextStep.length,0)
 first.agent.cancel({kind:'user'});await first.agent.whenIdle()
 assert.equal(first.agent.inbox.nextStep.length,0);assert.equal(first.notices().length,0)
 assert.equal(await first.ctx.sessions.flush(first.agent.session),true)
 const history=JSON.parse(JSON.stringify(readSessionEvents(first.agent.session)))
 await first.ctx.fiber.dispose()
 const restored=await nativeFixture(t,root,true)
 assert.deepEqual(readSessionEvents(restored.agent.session).slice(0,history.length),history,'原工具调用、真实取消结果、队列历史均不改写')
 assert.equal(await publishConversationWorkStatus(restored.host,status,async()=>{}),true)
 assert.equal(await publishConversationWorkStatus(restored.host,status,async()=>{}),true)
 assert.equal(restored.notices().length,1);assert.equal(restored.adapter.requests.length,0,'恢复回流不自行唤醒模型')
 assert.ok(JSON.stringify(restored.notices()).includes(status.members[0]!.result!))
 assert.deepEqual(readSessionEvents(restored.agent.session).slice(0,history.length),history)
})
test('notice flush等待期间本人启动新轮次则保持pending；闲置后去重完成且不重派模型', {timeout:10000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'teloa-work-notice-flush-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const f=await nativeFixture(t,root),tool=registerWait(f.ctx),store=f.ctx.sessions
 f.adapter.scripts.push(tool.script,loopText)
 let started=false
 const host={agents:f.ctx.agents,sessionController:{resolveAgent:async()=>({agent:f.agent})},sessions:{get:store.get.bind(store),flush:async(session:Session)=>{
  const flushed=await store.flush(session)
  if(!started){started=true;await f.send('owner-during-notice-flush');await tool.started}
  return flushed
 }}} as unknown as Context
 assert.equal(await publishConversationWorkStatus(host,status,async()=>{}),false)
 assert.equal(f.notices().length,1,'notice已落盘，但await后须重新核对本人活动状态')
 assert.equal(await publishConversationWorkStatus(host,status,async()=>{}),false)
 tool.release();await f.agent.whenIdle()
 assert.equal(await publishConversationWorkStatus(host,status,async()=>{}),true)
 assert.equal(f.notices().length,1);assert.equal(f.adapter.requests.length,2)
})

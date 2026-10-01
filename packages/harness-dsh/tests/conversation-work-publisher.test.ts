import test from 'node:test'
import assert from 'node:assert/strict'
import {Context} from '@deepseek-ai/cordis'
import {createHash} from 'node:crypto'
import {LlmRuntime,createUserMessage} from '@deepseek-ai/dsh-llm'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {Session,SessionStore,SessionId} from '@deepseek-ai/dsh-session'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {WorkError} from '@teloa/contract'
import {publishConversationWorkStatus} from '../src/conversation-work-publisher.ts'
import type {ConversationWorkStatus} from '../src/conversation-work-dispatch.ts'
import {readSessionEvents} from '../src/session-events.ts'
const status:ConversationWorkStatus={requestId:'request',sessionId:'origin',kind:'task',title:'客户核对',scope:'sales',observedAt:'2026-09-29T00:00:00Z',stoppedAt:null,counts:{received:1,waiting:0,unavailable:0,failed:0,stopped:0},members:[{roleId:'role',name:'客户同事',scope:'sales',status:'received',result:'实际结果，待本人核对',task:{id:'task',title:'客户核对',scope:'sales',version:1,state:'ready',assigneeRoleId:'role'}}]}
async function fixture(){
 const ctx=new Context();await ctx.plugin(LlmRuntime);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 const {agent}=await ctx.agents.create({sessionId:SessionId('origin'),agentOptions:{provider:'test',model:'test'}})
 let afterResolve=async()=>{},flushOk=true,flushes=0
 const host={sessionController:{resolveAgent:async()=>{await afterResolve();return {agent}}},sessions:{flush:async()=>{flushes++;return flushOk}}} as unknown as Context
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
 const host={sessionController:{resolveAgent:async()=>({agent:{session:restored}})},sessions:{flush:async()=>{flushes++;return true}}} as unknown as Context
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

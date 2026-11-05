import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import {WorkError} from '@teloa/contract'
import {WorkAccess} from '@teloa/backend'
import {patchedSessionFixture} from './fixtures/native-final-session.ts'
import {createNativeWorkInput} from '../src/native-work-input.ts'
import {registerProjectRuntimeContext} from '../src/project-runtime-context.ts'
import {isGroupExecutionSession} from '../src/group-routing.ts'

test('独立群回复保留resident原生准入，不请求普通Conversation项目绑定并真实进入Inbox',async t=>{
 const f=await patchedSessionFixture(t),sessionId='group-reply-'+randomUUID()
 const {agent}=await f.ctx.agents.create({sessionId:f.sessionPackage.SessionId(sessionId),agentOptions:{provider:'test',model:'test'}})
 void agent.runMaintenance(signal=>new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true})))
 let residentChecks=0,ordinaryBindings=0,allowed=true
 f.ctx.provide('teloaResidentInputAdmission' as never,{acquire:async(input:{sessionId:string;message?:{id:string}})=>{residentChecks++;assert.equal(input.sessionId,sessionId);assert.ok(input.message?.id);if(!allowed)throw new WorkError('teloa/forbidden','群回复已撤权');return {assertCurrent(){if(!allowed)throw new WorkError('teloa/forbidden','群回复已撤权')}}}} as never)
 const project=registerProjectRuntimeContext(f.ctx,{owner:'owner',readBinding:async()=>null,prepare:async input=>{
  // 与正式宿主使用同一分类；群回复没有普通Conversation，不能回退创建它。
  if(isGroupExecutionSession(input.sessionId))return null
  ordinaryBindings++;throw new WorkError('teloa/not-bound','没有普通会话绑定')
 },assertCurrent:async()=>{},assertPreparedCurrentSync(){},recordUsed:async()=>{}})
 t.after(()=>project.close())
 const access=new WorkAccess();access.installPolicy(async()=>({assertCurrent(){}}));const native=createNativeWorkInput(f.ctx,access);t.after(()=>native.close())
 const message=createUserMessage({source:{kind:'user',rpcId:randomUUID()},content:[{type:'text',text:'全新合成群回复输入'}]})
 await native.withNewInput(agent,message,{producer:'prompt',identity:'group-reply'},()=>agent.inbox.append('next-turn',message))
 assert.equal(residentChecks,1);assert.equal(ordinaryBindings,0);assert.equal(agent.inbox.nextTurn[0]?.id,message.id)
 assert.ok(agent.session.snapshotEvents().some(event=>event.type==='agent/inbox/spliced'&&event.data.inserted.some(item=>item.id===message.id)))
 allowed=false
 const denied=createUserMessage({source:{kind:'user',rpcId:randomUUID()},content:[{type:'text',text:'撤权后不能进入Inbox'}]})
 await assert.rejects(()=>native.withNewInput(agent,denied,{producer:'prompt',identity:'group-reply'},()=>agent.inbox.append('next-turn',denied)),{code:'teloa/forbidden'})
 assert.equal(agent.inbox.nextTurn.length,1);assert.equal(ordinaryBindings,0)
 assert.equal(isGroupExecutionSession('ordinary-conversation'),false);assert.equal(isGroupExecutionSession('task-run-'+randomUUID()),false)
})

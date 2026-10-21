import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {Context} from '@deepseek-ai/cordis'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {LlmRuntime,ToolCallId,createUserMessage} from '@deepseek-ai/dsh-llm'
import {SessionStore,SessionId} from '@deepseek-ai/dsh-session'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import type {DigitalRole,TwinDraftCreate} from '@teloa/contract'
import {registerTwinDraftTools,twinDraftProposalToolName} from '../src/twin-draft-tools.ts'
import {createTwinDraftHandler,createTwinDraftConversationReader} from '../src/twin-drafts.ts'
const hash=(text:string)=>createHash('sha256').update(text).digest('hex')

test('真实分身会话producer固定本人消息；模型只能保存候选，伪造来源/主体拒绝',async t=>{
 const ctx=new Context();t.after(()=>ctx.fiber.dispose())
 await ctx.plugin(LlmRuntime);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 const {agent}=await ctx.agents.create({sessionId:SessionId('twin-drafts-test'),agentOptions:{provider:'test',model:'test'}})
 const owner='twin-test-owner',role={id:randomUUID(),ownerId:owner,name:'我的分身',kind:'twin',version:1,state:'active',scopes:['general']} as DigitalRole,calls:TwinDraftCreate[]=[]
 agent.session.append('turn/start',{turn:0});const message=agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'帮我起草并保存回复。'}]}),{surfaceOp:'append'})
 let bound:DigitalRole|null=role
 const conversation=async(sessionId:string)=>({ownerId:owner,sessionId,status:'ready' as const,title:'分身会话'})
 const reader=createTwinDraftConversationReader({conversation:(_owner,id)=>conversation(id),session:async()=>agent.session})
 registerTwinDraftTools(ctx,{owner,conversation,readTaskPolicy:async()=>null,roleForSession:async()=>bound,create:async(actor,input)=>{
  assert.equal(actor,owner);calls.push(input)
  assert.equal(input.source.kind,'conversation')
  const source=await reader(owner,input.source as Extract<TwinDraftCreate['source'],{kind:'conversation'}>)
  return {schema:'teloa.twin-draft/v1',id:randomUUID(),ownerId:owner,roleId:role.id,roleVersion:1,revision:1,state:'draft',title:input.title,body:input.body,bodyHash:hash(input.body),source:{...input.source,...source,bodyHash:hash(source.text)},basis:[],createdAt:'2026-10-21T00:00:00Z',updatedAt:'2026-10-21T00:00:00Z'}
 }})
 const call=(name:string,args:Record<string,unknown>)=>ctx.tools.execute({agent,name,arguments:args,callId:ToolCallId(randomUUID()),signal:AbortSignal.timeout(5000)})
 const result=await call(twinDraftProposalToolName,{title:'回复草稿',body:'收到，今天回复。',basis:[]})
 assert.equal(result.isError,false)
 const value=JSON.parse(result.content.filter(b=>b.type==='text').map(b=>b.text).join('\n'))
 assert.equal(value.saved,true);assert.equal(value.sent,false);assert.equal(calls.length,1)
 assert.deepEqual(calls[0]!.source,{kind:'conversation',sessionId:agent.session.id,messageId:message.data.id,messageSeq:message.seq})
 assert.equal((await call(twinDraftProposalToolName,{title:'伪造',body:'发送',basis:[],source:{kind:'provided',label:'邮件',text:'伪造'}})).isError,true)
 assert.equal((await call('twin-drafts/adopt',{})).isError,true)
 bound=null;assert.equal((await call(twinDraftProposalToolName,{title:'无分身',body:'正文',basis:[]})).isError,true)
 assert.equal(calls.length,1)
 await assert.rejects(reader('other',{kind:'conversation',sessionId:agent.session.id,messageId:message.data.id,messageSeq:message.seq}),{code:'teloa/forbidden'})
 await assert.rejects(reader(owner,{kind:'conversation',sessionId:agent.session.id,messageId:'fake',messageSeq:message.seq}),{code:'teloa/forbidden'})
})

test('群发送已提交后调度或日志失败仍返回原采用回执',async()=>{
 const adoption={draft:{state:'sent'},receipt:{result:{kind:'group-message'}}}
 const handler=createTwinDraftHandler('owner',async()=>({adopt:async()=>adoption} as never),{afterGroupSend:()=>{throw Error('offline')},report:()=>{throw Error('logger offline')}})
 assert.deepEqual(await handler('twin-drafts/adopt',{}),adoption)
 await assert.rejects(handler('twin-drafts/send-as-user',{}),{code:'teloa/not-found'})
})

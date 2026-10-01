import test from 'node:test'
import assert from 'node:assert/strict'
import {Context} from '@deepseek-ai/cordis'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {LlmRuntime,ToolCallId,createAssistantMessage,createUserMessage} from '@deepseek-ai/dsh-llm'
import {SessionStore,SessionId} from '@deepseek-ai/dsh-session'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {registerKnowledgeTools,type KnowledgeToolsPorts} from '../src/knowledge-tools.ts'
import type {ConversationKnowledgeCommand,KnowledgeSaveReceipt} from '@teloa/contract'

const owner='local:teloa-owner',requestId='11111111-1111-5111-a111-111111111111',knowledgeId='22222222-2222-4222-8222-222222222222',resourceId='33333333-3333-4333-8333-333333333333',hash='a'.repeat(64)
const receiptFor=(command:ConversationKnowledgeCommand):KnowledgeSaveReceipt=>({schema:'teloa.knowledge-save-receipt/v1',requestId:command.requestId,title:command.target.title,category:command.target.category,topics:[...command.target.topics],workspaceId:command.target.workspaceId,scopeIds:[...command.target.scopeIds],source:{sessionId:command.subject.sessionId,messageId:command.subject.messageId,seq:command.subject.seq,selectionHash:command.subject.selectionHash},status:'active',knowledge:{id:knowledgeId,version:1,contentHash:command.subject.selectionHash},resource:{id:resourceId,version:1}})
const statusReceipt=(id:string):KnowledgeSaveReceipt=>({schema:'teloa.knowledge-save-receipt/v1',requestId:id,title:'发布 SOP',category:'sop',topics:['发布'],workspaceId:'default',scopeIds:['general'],source:{sessionId:'knowledge-session',messageId:'answer',seq:1,selectionHash:hash},status:'active',knowledge:{id:knowledgeId,version:1,contentHash:hash},resource:{id:resourceId,version:1}})
async function setup(overrides:Partial<KnowledgeToolsPorts>={}){
 const ctx=new Context();await ctx.plugin(LlmRuntime);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 const {agent}=await ctx.agents.create({sessionId:SessionId('knowledge-session'),agentOptions:{provider:'test',model:'test'}})
 agent.session.append('turn/start',{turn:1})
 const answer=createAssistantMessage({source:{provider:'test',model:'test'},content:[{type:'text',text:'# 发布 SOP'}]});agent.session.append('assistant/message',{turn:1,step:1,message:answer,stream:[]},{surfaceOp:'append'})
 agent.session.append('turn/end',{turn:1,reason:{kind:'completed'}})
 agent.session.append('turn/start',{turn:2})
 const instruction=createUserMessage({source:{kind:'user',rpcId:'save-request'},content:[{type:'text',text:'把上一条保存为 SOP'}]});agent.session.append('user/message',instruction,{surfaceOp:'append'})
 const saves:unknown[]=[]
 const ports:KnowledgeToolsPorts={owner,conversation:async id=>({ownerId:owner,sessionId:id,status:'ready'}),readTaskPolicy:async()=>null,knowledge:{save:async(_actor,input)=>{saves.push(input);return receiptFor(input as ConversationKnowledgeCommand)},get:async()=>null},...overrides}
 registerKnowledgeTools(ctx,ports)
 const call=(name:string,args:Record<string,unknown>={})=>ctx.tools.execute({agent,name,arguments:args,callId:ToolCallId('call'),signal:AbortSignal.timeout(5000)})
 return {ctx,agent,answer,saves,call}
}
const json=(result:Awaited<ReturnType<Awaited<ReturnType<typeof setup>>['call']>>)=>JSON.parse(result.content.filter(item=>item.type==='text').map(item=>item.text).join('\n'))

test('候选只返回当前会话非继承完整纯文本的指针与短预览',async t=>{const env=await setup();t.after(()=>env.ctx.fiber.dispose());const result=await env.call('teloa_knowledge_candidates');assert.equal(result.isError,false);const value=json(result);assert.equal(value.items.length,1);assert.equal(value.items[0].messageId,env.answer.id);assert.equal(value.items[0].preview,'# 发布 SOP');assert.equal('markdown' in value.items[0],false)})
test('保存工具用可信日志正文和服务端固定归属生成稳定命令',async t=>{const env=await setup();t.after(()=>env.ctx.fiber.dispose());const candidate=json(await env.call('teloa_knowledge_candidates')).items[0],args={message:{messageId:candidate.messageId,seq:candidate.seq,selectionHash:candidate.selectionHash},title:'发布 SOP',category:'sop',topics:['发布']};assert.equal((await env.call('teloa_knowledge_save_message',args)).isError,false);assert.equal((await env.call('teloa_knowledge_save_message',args)).isError,false);assert.equal(env.saves.length,2);const commands=env.saves as any[];assert.equal(commands[0].requestId,commands[1].requestId);assert.equal(commands[0].subject.markdown,'# 发布 SOP');assert.deepEqual(commands[0].target,{workspaceId:'default',title:'发布 SOP',category:'sop',topics:['发布'],scopeIds:['general']})})
test('未知字段、伪造正文、子 Agent 和任务会话在前置与正文拒绝',async t=>{const env=await setup();t.after(()=>env.ctx.fiber.dispose());const candidate=json(await env.call('teloa_knowledge_candidates')).items[0];for(const args of [{message:candidate,title:'发布 SOP',category:'sop',topics:[],ownerId:owner},{message:{...candidate,selectionHash:'0'.repeat(64)},title:'发布 SOP',category:'sop',topics:[]}])assert.equal((await env.call('teloa_knowledge_save_message',args)).isError,true);assert.equal(env.saves.length,0);const task=await setup({readTaskPolicy:async()=>({allowedTools:[],nativeRequestId:'task'})});t.after(()=>task.ctx.fiber.dispose());assert.equal((await task.call('teloa_knowledge_candidates')).isError,true)})

test('保存工具拒绝属于其他请求、对象或目标的形状合法回执',async t=>{
 const changes=[
  (row:KnowledgeSaveReceipt)=>({...row,requestId}),
  (row:KnowledgeSaveReceipt)=>({...row,title:'另一份资料'}),
  (row:KnowledgeSaveReceipt)=>({...row,category:'policy' as const}),
  (row:KnowledgeSaveReceipt)=>({...row,topics:['其他']}),
  (row:KnowledgeSaveReceipt)=>({...row,source:{...row.source,messageId:'other'}}),
  (row:KnowledgeSaveReceipt)=>({...row,source:{...row.source,seq:999}}),
  (row:KnowledgeSaveReceipt)=>({...row,source:{...row.source,selectionHash:'0'.repeat(64)}}),
 ]
 for(const change of changes){
  const env=await setup({knowledge:{save:async(_actor,input)=>change(receiptFor(input as ConversationKnowledgeCommand)) as KnowledgeSaveReceipt,get:async()=>null}});t.after(()=>env.ctx.fiber.dispose())
  const candidate=json(await env.call('teloa_knowledge_candidates')).items[0]
  const result=await env.call('teloa_knowledge_save_message',{message:{messageId:candidate.messageId,seq:candidate.seq,selectionHash:candidate.selectionHash},title:'发布 SOP',category:'sop',topics:['发布']})
  assert.equal(result.isError,true)
 }
})

test('保存和状态工具拒绝含额外字段、损坏或请求身份不一致的回包',async t=>{
 const malformed=await setup({knowledge:{save:async(_actor,input)=>({...receiptFor(input as ConversationKnowledgeCommand),ownerId:'forged'}) as unknown as KnowledgeSaveReceipt,get:async()=>null}});t.after(()=>malformed.ctx.fiber.dispose())
 const candidate=json(await malformed.call('teloa_knowledge_candidates')).items[0]
 assert.equal((await malformed.call('teloa_knowledge_save_message',{message:{messageId:candidate.messageId,seq:candidate.seq,selectionHash:candidate.selectionHash},title:'发布 SOP',category:'sop',topics:['发布']})).isError,true)
 for(const {receipt,error} of [{receipt:statusReceipt(requestId),error:false},{receipt:{...statusReceipt(requestId),requestId:knowledgeId},error:true},{receipt:{...statusReceipt(requestId),extra:'forged'},error:true},{receipt:{status:'active'},error:true}]){
  const env=await setup({knowledge:{save:async(_actor,input)=>receiptFor(input as ConversationKnowledgeCommand),get:async()=>receipt as KnowledgeSaveReceipt}});t.after(()=>env.ctx.fiber.dispose())
  const result=await env.call('teloa_knowledge_status',{requestId})
  assert.equal(result.isError,error)
 }
})

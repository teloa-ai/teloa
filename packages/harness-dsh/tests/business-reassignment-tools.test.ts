import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {Context} from '@deepseek-ai/cordis'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {LlmRuntime,ToolCallId,createUserMessage} from '@deepseek-ai/dsh-llm'
import {SessionStore,SessionId} from '@deepseek-ai/dsh-session'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {WorkError,canonicalBusinessReassignmentSnapshot,type BusinessReassignmentSnapshot,type BusinessReassignmentInstruction} from '@teloa/contract'
import {registerBusinessReassignmentTools,businessReassignmentToolName,type BusinessReassignmentToolsPorts} from '../src/business-reassignment-tools.ts'
import {sourceInstruction} from '../src/conversation-work-instruction.ts'
const owner='owner',oldRequestId='11111111-1111-4111-8111-111111111111',oldRole='22222222-2222-4222-8222-222222222222',newRoleId='33333333-3333-4333-8333-333333333333'
const args={oldRequestId,newRoleId,expectedNewRoleVersion:2}
async function setup(origin?:'subagent'){
 const ctx=new Context();await ctx.plugin(LlmRuntime);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 const {agent}=await ctx.agents.create({sessionId:SessionId('new-daily'),...(origin?{meta:{origin,delegationDepth:1}}:{}),agentOptions:{provider:'test',model:'test'}})
 agent.session.append('turn/start',{turn:0} as never)
 agent.session.append('user/message',createUserMessage({source:{kind:'user',rpcId:'real-human-rpc'},content:[{type:'text',text:'请将原调查交给另一同事'}]}),{surfaceOp:'append'})
 const approvals:string[]=[],dispatched:BusinessReassignmentSnapshot[]=[];let approve=async()=>'allowed-once',mutation:Partial<BusinessReassignmentSnapshot>={}
 ctx.provide('approval',{request:async(input:{reason:string})=>{approvals.push(input.reason);return approve()}})
 const ports:BusinessReassignmentToolsPorts={owner,conversation:async id=>({ownerId:owner,sessionId:id,status:'ready'}),readTaskPolicy:async()=>null,isRoleConversation:async()=>false,isTaskConversation:async()=>false,isBuilder:async()=>false,isPendingDaily:async()=>false,
  prepare:async(input,revalidate)=>{await revalidate();const instruction=input.instruction;const body:Omit<BusinessReassignmentSnapshot,'snapshotHash'>={instruction,oldSessionId:'old-daily',scope:'SOC',oldContext:{version:3,roleId:oldRole},newContext:{version:4,roleId:null},oldTarget:{roleId:oldRole,roleVersion:1,name:'原调查员'},oldRoleCurrent:{version:2,state:'retired'},newTarget:{roleId:newRoleId,roleVersion:2,name:'另一同事'},responsibility:{version:3,roleId:oldRole},title:'原任务标题',goal:'原目标及验收标准',sourceText:'旧服务端原材料',reference:{scope:'SOC',type:'alert',id:'fixed-alert',version:2,snapshotHash:'a'.repeat(64)},...mutation};return {...body,snapshotHash:createHash('sha256').update(canonicalBusinessReassignmentSnapshot(body)).digest('hex')}},
  supersede:async(input,signal,revalidate)=>{await revalidate();signal.throwIfAborted();dispatched.push(input);return {oldRequestId,newRequestId:input.instruction.requestId}}
 }
 registerBusinessReassignmentTools(ctx,ports)
 const call=(input:Record<string,unknown>=args,id='call',signal=AbortSignal.timeout(5000))=>ctx.tools.execute({agent,name:businessReassignmentToolName,arguments:input,callId:ToolCallId(id),signal})
 return {ctx,agent,ports,approvals,dispatched,call,approve:(fn:typeof approve)=>approve=fn,mutate:(value:Partial<BusinessReassignmentSnapshot>)=>mutation=value}
}
test('真实本人rpc固定新request，同消息不同callId重试不重建且完整服务端材料进入批准',async t=>{
 const f=await setup();t.after(()=>f.ctx.fiber.dispose())
 assert.equal((await f.call(args,'a')).isError,false);assert.equal((await f.call(args,'b')).isError,false)
 assert.equal(f.dispatched.length,2);assert.equal(f.dispatched[0]!.instruction.requestId,f.dispatched[1]!.instruction.requestId)
 const fixed=f.dispatched[0]!,h=createHash('sha256').update(JSON.stringify(['teloa-work-instruction/v1',owner,'new-daily','real-human-rpc'])).digest('hex')
 assert.equal(fixed.instruction.requestId,`${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`)
 assert.equal(fixed.sourceText,'旧服务端原材料');assert.equal(fixed.instruction.sourceText,'请将原调查交给另一同事')
 for(const text of ['old-daily','new-daily','原调查员','另一同事','原任务标题','原目标及验收标准','fixed-alert','旧服务端原材料','responsibility','retired'])assert.ok(f.approvals[0]!.includes(text),text)
})
test('模型不能注入旧session或改写固定目标材料引用',async t=>{
 const f=await setup();t.after(()=>f.ctx.fiber.dispose())
 for(const key of ['oldSessionId','sessionId','requestId','messageId','goal','sourceText','reference','ownerId','scope'])assert.equal((await f.call({...args,[key]:'forged'})).isError,true,key)
 assert.equal(f.dispatched.length,0);assert.equal(f.approvals.length,0)
})
test('拒绝、下游cancel与信号取消均零改派副作用',async t=>{
 const f=await setup();t.after(()=>f.ctx.fiber.dispose())
 f.approve(async()=>'rejected');assert.equal((await f.call()).isError,true)
 f.approve(async()=>'allowed-once');const remove=f.ctx.on('tools/pre-execute',async()=>({kind:'cancel' as const}));await f.call();remove()
 const controller=new AbortController();controller.abort();await f.call(args,'aborted',controller.signal)
 assert.equal(f.dispatched.length,0)
})
test('审批后真实消息身份或快照字段任一变化均零改派',async t=>{
 for(const change of ['message','oldSessionId','oldContext','newContext','oldTarget','oldRoleCurrent','newTarget','responsibility','goal','reference']){
  const f=await setup();t.after(()=>f.ctx.fiber.dispose())
  f.approve(async()=>{
   if(change==='message'){f.agent.session.append('turn/start',{turn:1} as never);f.agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'新的本人指令'}]}),{surfaceOp:'append'})}
   else if(change==='oldSessionId')f.mutate({oldSessionId:'changed-daily'})
   else if(change==='oldContext'||change==='newContext')f.mutate({[change]:{version:5,roleId:null}})
   else if(change==='oldTarget')f.mutate({oldTarget:{roleId:oldRole,roleVersion:4,name:'原调查员'}})
   else if(change==='oldRoleCurrent')f.mutate({oldRoleCurrent:{version:3,state:'paused'}})
   else if(change==='newTarget')f.mutate({newTarget:{roleId:newRoleId,roleVersion:3,name:'另一同事'}})
   else if(change==='responsibility')f.mutate({responsibility:{version:4,roleId:null}})
   else if(change==='goal')f.mutate({goal:'改变目标'})
   else f.mutate({reference:{scope:'SOC',type:'alert',id:'fixed-alert',version:3,snapshotHash:'b'.repeat(64)}})
   return 'allowed-once'
  })
  assert.equal((await f.call()).isError,true,change);assert.equal(f.dispatched.length,0,change)
 }
})
test('普通身份防护保持：非本人、pending、builder、role、task及子级拒绝且不泄露旧材料',async t=>{
 const cases:Array<Partial<BusinessReassignmentToolsPorts>>=[{conversation:async id=>({ownerId:'other',sessionId:id,status:'ready'})},{conversation:async id=>({ownerId:owner,sessionId:id,status:'pending'})},{readTaskPolicy:async()=>({allowedTools:[]})},{isBuilder:async()=>true},{isPendingDaily:async()=>true},{isRoleConversation:async()=>true},{isTaskConversation:async()=>true},{prepare:async()=>{throw new WorkError('teloa/forbidden','当前无权改派。')}}]
 for(const overrides of cases){const f=await setup();t.after(()=>f.ctx.fiber.dispose());Object.assign(f.ports,overrides);const result=await f.call();assert.equal(result.isError,true);assert.ok(!JSON.stringify(result).includes('旧服务端原材料'));assert.equal(f.dispatched.length,0)}
 const child=await setup('subagent');t.after(()=>child.ctx.fiber.dispose());assert.equal((await child.call()).isError,true)
})
test('批准在dispatch等待期间失效仍不得继续，附件、替换消息和伪造消息源拒绝',async t=>{
 const f=await setup();t.after(()=>f.ctx.fiber.dispose())
 f.ports.supersede=async(_input,_signal,revalidate)=>{f.mutate({responsibility:{version:4,roleId:null}});await revalidate();throw new Error('不应到达')}
 assert.equal((await f.call()).isError,true);assert.equal(f.dispatched.length,0)
 for(const source of ['plugin:teloa.work','user']){
  const e=await setup();t.after(()=>e.ctx.fiber.dispose());e.agent.session.append('turn/start',{turn:1} as never)
  e.agent.session.append('user/message',createUserMessage({source:source==='user'?{kind:'user'}:{kind:'plugin:teloa.work',form:'notice',summary:'nonhuman'},content:[{type:'text',text:'改派'},...(source==='user'?[{type:'file',attachment:{id:'file'}} as never]:[])]}),{surfaceOp:'append'})
  assert.equal((await e.call()).isError,true);assert.equal(e.dispatched.length,0)
 }
})
test('共享sourceInstruction保留普通交办算法并精确读取messageId及seq',async t=>{
 const f=await setup();t.after(()=>f.ctx.fiber.dispose())
 const instruction=sourceInstruction(owner,{agent:f.agent})
 const event=f.agent.session.snapshotEvents().find(event=>event.type==='user/message')!
 assert.equal(instruction.messageSeq,event.seq);if(event.type==='user/message')assert.equal(instruction.messageId,event.data.id)
 f.agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[]}),{surfaceOp:{op:'replace',startSeq:event.seq,endSeq:event.seq},sourceEventSeqs:[event.seq]} as never)
 assert.throws(()=>sourceInstruction(owner,{agent:f.agent}),WorkError)
})

test('M1改派工具采用计划冻结名称且不暴露另一个别名',()=>{assert.equal(businessReassignmentToolName,'teloa_work_supersede')})

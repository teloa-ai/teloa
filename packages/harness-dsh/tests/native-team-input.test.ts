import test from 'node:test'
import assert from 'node:assert/strict'
import {TeamService} from '@deepseek-ai/dsh-experimental-agent-team'
import {defineTool,type ToolRunContext} from '@deepseek-ai/dsh-tools'
import {ToolCallId} from '@deepseek-ai/dsh-llm'
import {nativeHotSubagentFixture} from './fixtures/native-hot-subagent.ts'
import {until,deferred} from './fixtures/native-subagent-admission.ts'
import {patchedNativePackage} from './fixtures/native-patched-package.ts'
import {textAnswer} from './fixtures/native-hot-causality.ts'
import {inspect} from 'node:util'

/** 团队工具只在 Agent 内执行；官方 ToolRunContext.agent 可缺，先核对再使用。 */
const agentOf=(exec:Pick<ToolRunContext,'agent'>)=>{assert.ok(exec.agent,'团队工具须在 Agent 内执行。');return exec.agent}

for(const change of ['unchanged','expired','revoked'] as const)test('真实 Team 子成员工具上行沿原许可，状态 '+change,{timeout:10000},async t=>{
 const f=await nativeHotSubagentFixture(t)
 const team=await patchedNativePackage<{TeamService:typeof TeamService}>(t,{packageName:'@deepseek-ai/dsh-experimental-agent-team',compatBasename:'dsh-experimental-agent-team-0.2.1-rc.2-input-admission'})
 await f.ctx.plugin(team.namespace.TeamService,{maxMembers:4})
 const entered=deferred(),release=deferred()
 if(change!=='unchanged')f.setAdmission(async(candidate,dispatch)=>{
  if(candidate.kind==='live'){entered.resolve();await release.promise}
  await f.defaultAdmission(candidate,dispatch)
 })
 t.after(()=>release.resolve())
 f.adapter.childScripts.push([
  {type:'block-start',index:0,blockType:'tool-call'},
  {type:'tool-call-delta',index:0,id:ToolCallId('relay-call'),name:'relay_to_lead',argumentsDelta:'{}'},
  {type:'block-end',index:0,block:{type:'tool-call',id:ToolCallId('relay-call'),name:'relay_to_lead',arguments:'{}'}},
  {type:'finish',reason:{kind:'tool-calls'}},
 ])
 f.ctx.tools.register(defineTool({name:'relay_to_lead',description:'团队上行验收',parameters:{},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},async execute(_args,exec){
  await until(()=>f.ctx.agentTeams.tryMembership(agentOf(exec))!==undefined)
  const sent=await f.ctx.agentTeams.sendMessage(agentOf(exec),{target:'lead',content:[{type:'text',text:'TEAM_RELAY_OK'}],signal:exec.signal})
  return sent.messageId
 }}))
 f.setToolAction(async exec=>{
  await f.ctx.agentTeams.spawnTeammate(agentOf(exec),{name:'helper',description:'复核',prompt:[{type:'text',text:'汇报结果'}],context:'fresh',provider:'spawn',signal:exec.signal})
  return '已创建团队成员'
 })
 await f.send()
 if(change!=='unchanged'){
  await entered.promise
  if(change==='expired')f.rights.valid=false;else f.rights.revoked=true
  release.resolve()
 }
 const relays=()=>f.inserted(f.parent).filter(message=>message.source.kind==='agent-message'&&message.source.form==='relay')
 if(change==='revoked'){
  await until(()=>f.candidates.some(candidate=>candidate.kind==='live')&&f.events(f.candidates[0]!.agent).some(event=>event.type==='tool/result'))
  assert.equal(relays().length,0);assert.equal(f.counts.fresh,1);return
 }
 await until(()=>relays().length===1)
 assert.equal(f.counts.fresh,1)
 assert.ok(JSON.stringify(relays()[0]!.content).includes('TEAM_RELAY_OK'))
})

test('真实 Team 成员给已冷却的同伴发消息，在原子会话恢复且不新取许可',{timeout:10000},async t=>{
 const f=await nativeHotSubagentFixture(t,'continuable',true)
 const team=await patchedNativePackage<{TeamService:typeof TeamService}>(t,{packageName:'@deepseek-ai/dsh-experimental-agent-team',compatBasename:'dsh-experimental-agent-team-0.2.1-rc.2-input-admission'})
 await f.ctx.plugin(team.namespace.TeamService,{maxMembers:4})
 let receiverId=''
 const received:string[]=[]
 f.ctx.on('session/event',(session,event)=>{
  if(session.id===receiverId&&event.type==='agent/inbox/spliced')for(const message of event.data.inserted)if(message.source.kind==='agent-message'&&message.source.form==='relay')received.push(message.id)
 },{global:true})
 f.adapter.childScripts.push(textAnswer,[
  {type:'block-start',index:0,blockType:'tool-call'},
  {type:'tool-call-delta',index:0,id:ToolCallId('peer-call'),name:'relay_to_peer',argumentsDelta:'{}'},
  {type:'block-end',index:0,block:{type:'tool-call',id:ToolCallId('peer-call'),name:'relay_to_peer',arguments:'{}'}},
  {type:'finish',reason:{kind:'tool-calls'}},
 ])
 f.ctx.tools.register(defineTool({name:'relay_to_peer',description:'团队同伴冷恢复验收',parameters:{},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},async execute(_args,exec){
  await until(()=>f.ctx.agentTeams.tryMembership(agentOf(exec))!==undefined)
  try{return (await f.ctx.agentTeams.sendMessage(agentOf(exec),{target:'receiver',content:[{type:'text',text:'PEER_RELAY_OK'}],signal:exec.signal})).messageId}
  catch(error){t.diagnostic(inspect(error,{depth:8}));throw error}
 }}))
 f.setToolAction(async exec=>{
  const receiver=await f.ctx.agentTeams.spawnTeammate(agentOf(exec),{name:'receiver',description:'接收',prompt:[{type:'text',text:'待命'}],context:'fresh',provider:'spawn',signal:exec.signal})
  receiverId=receiver.member.id
  await until(()=>f.ctx.agents.get(receiver.member.id)===undefined)
  await f.ctx.agentTeams.spawnTeammate(agentOf(exec),{name:'sender',description:'发送',prompt:[{type:'text',text:'发给同伴'}],context:'fresh',provider:'spawn',signal:exec.signal})
  return '已创建成员'
 })
 await f.send()
 try{await until(()=>received.length===1)}catch(error){
  t.diagnostic(JSON.stringify(f.candidates.flatMap(candidate=>f.events(candidate.agent).filter(event=>event.type==='tool/result').map(event=>event.data.message))))
  throw error
 }
 assert.equal(f.counts.fresh,1)
 assert.equal(f.ctx.agentTeams.listMembers(f.parent).filter(row=>row.name==='receiver').length,1)
})

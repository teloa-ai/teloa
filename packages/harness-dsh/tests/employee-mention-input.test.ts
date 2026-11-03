import test from 'node:test'
import assert from 'node:assert/strict'
import type {Agent} from '@deepseek-ai/dsh-agent'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import {WorkError,encodeEmployeeMention} from '@teloa/contract'
import {createEmployeeMentionInputPreflight,prepareEmployeeMentionOwnerInput} from '../src/employee-mention-input.ts'
import type {EmployeeMentionSelection} from '../src/employee-mention-context.ts'
const marker=encodeEmployeeMention({roleId:'11111111-1111-4111-8111-111111111111',roleVersion:1})
const message=(text:string)=>createUserMessage({source:{kind:'user'},content:[{type:'text',text}]})
test('正常输入准入只核实际user引用；普通正文不切身份，多员工/旧版/缺服务在publisher前拒绝',async()=>{
 let reads=0,checks=0,stale=false,eligible=true
 const agent={session:{id:'parent',header:{origin:'main'}},ctx:{get:()=>undefined}} as unknown as Agent
 const preflight=createEmployeeMentionInputPreflight({applies:async()=>eligible,resolve:async()=>{reads++;return {assertCurrent:async()=>{checks++;if(stale)throw Error('version changed')}} as EmployeeMentionSelection}})
 await preflight.prepare(agent,message('普通问题 @名字只是正文'));assert.equal(reads,0)
 await preflight.prepare(agent,message(marker+' 合成问题'));assert.equal(reads,1);assert.equal(checks,1)
 await assert.rejects(()=>preflight.prepare(agent,message(marker+' '+marker.replace(':1]',':2]'))),/一位员工/);assert.equal(reads,1)
 stale=true;await assert.rejects(()=>preflight.prepare(agent,message(marker)),/version changed/)
 eligible=false;const previousReads=reads;await preflight.prepare(agent,message(marker));await preflight.prepare(agent,message('[teloa-employee:quoted-invalid]'));assert.equal(reads,previousReads,'固定Task/岗位中的原始引用不触发父会话改派解析')
 await assert.rejects(()=>prepareEmployeeMentionOwnerInput(agent,message(marker)),/服务正在准备/)
 await prepareEmployeeMentionOwnerInput(agent,message('没有引用的正常消息'))
})


test('正常Controller的固定任务输入保留父原指令引用并沿原许可准入，不重解释员工身份',async()=>{
 const {createNativeProducerAdmissions}=await import('../src/native-producer-admission.ts')
 let routed=0,published=0,checked=0
 const preflight=createEmployeeMentionInputPreflight({applies:async()=>false,resolve:async()=>{routed++;throw Error('不得更换固定Task员工')}})
 const agent={id:'task-session',session:{id:'task-session',header:{origin:'main'}},ctx:{get:()=>preflight}} as unknown as Agent
 const original=message('固定的本人原指令：'+marker+' 请独立核对')
 const admission=createNativeProducerAdmissions({withNewInput:async(actual,input,context,submit)=>{checked++;assert.equal(actual,agent);assert.equal(input,original);assert.equal(context.producer,'prompt');submit()}})
 await admission.controller({kind:'prompt',agent,message:original,requestId:'fixed-task-request',mode:'queue'},()=>{published++})
 assert.equal(routed,0);assert.equal(checked,1);assert.equal(published,1)
})


test('普通父会话的员工版本或离岗拒绝带可读传输错误，publisher与旧Task均不进入',async()=>{
 const {createNativeProducerAdmissions}=await import('../src/native-producer-admission.ts')
 const {RemoteError}=await import('@deepseek-ai/dsh-typert-protocol')
 for(const code of ['teloa/version-conflict','teloa/conflict'] as const){
  let accepted=0,published=0
  const preflight=createEmployeeMentionInputPreflight({applies:async()=>true,resolve:async()=>{throw new WorkError(code,'员工已变化，请重新选择。')}})
  const agent={id:'parent',session:{id:'parent',header:{origin:'main'}},ctx:{get:()=>preflight}} as unknown as Agent
  const admission=createNativeProducerAdmissions({withNewInput:async()=>{accepted++}})
  await assert.rejects(()=>admission.controller({kind:'prompt',agent,message:message(marker),requestId:'new-request',mode:'queue'},()=>{published++}),error=>error instanceof RemoteError&&error.code===code&&error.message.includes('重新选择'))
  assert.equal(accepted,0);assert.equal(published,0)
 }
})

import test from 'node:test'
import assert from 'node:assert/strict'
import {createUserMessage,ToolCallId} from '@deepseek-ai/dsh-llm'
import {defaultWorkBudgetPolicy} from '@teloa/backend'
import {registerConversationWorkTools,type ConversationWorkToolsPorts} from '../src/conversation-work-tools.ts'
import {loopWorkFixture} from './fixtures/native-loop-work-admission.ts'

async function fixture(t:Parameters<typeof loopWorkFixture>[0]){
 const f=await loopWorkFixture(t,true),sessionId=String(f.agent.session.id),dispatched:any[]=[],approvals:string[]=[]
 f.agent.session.append('turn/start',{turn:0} as never)
 f.agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'请创建独立工作，只分析本地材料。'}]}),{surfaceOp:'append'})
 let settings={sessionId,version:1,configured:true,policy:{...defaultWorkBudgetPolicy,maxTokens:null}},approve=async()=> 'allowed-once'
 f.ctx.provide('approval',{request:async(input:{reason:string})=>{approvals.push(input.reason);return approve()}})
 const ports:ConversationWorkToolsPorts={owner:'owner',conversation:async id=>({ownerId:'owner',sessionId:id,status:'ready'}),readTaskPolicy:async()=>null,isRoleConversation:async()=>false,context:async()=>null,freeze:async()=>null,roles:async()=>[],scopes:async()=>['general'],workBudgetSettings:async()=>structuredClone(settings),dispatch:async input=>{dispatched.push(input);return {accepted:true}},status:async()=>({}),stop:async()=>({}),facts:async()=>({}),data:async()=>({}),now:()=>new Date().toISOString()}
 registerConversationWorkTools(f.ctx,ports)
 const call=(args:Record<string,unknown>,id='page-budget')=>f.ctx.tools.execute({agent:f.agent,name:'teloa_work_dispatch',arguments:{title:'本地分析',goal:'只检查所给材料',scope:'general',executor:'general',...args},callId:ToolCallId(id),signal:AbortSignal.timeout(10000)})
 return {...f,sessionId,dispatched,approvals,call,settings:()=>settings,setSettings:(value:typeof settings)=>{settings=value},setApprove:(value:typeof approve)=>{approve=value}}
}

test('真实原生确认冻结页面完整额度，批准前不派发且不限不是模型暗中提额',async t=>{
 const f=await fixture(t)
 let release!:(value:string)=>void,asked!:()=>void
 const seen=new Promise<void>(resolve=>{asked=resolve})
 f.setApprove(()=>new Promise<string>(resolve=>{release=resolve;asked()}))
 const pending=f.call({});await seen
 assert.equal(f.dispatched.length,0)
 assert.match(f.approvals[0]!,/本人在会话页面保存/);assert.match(f.approvals[0]!,/token 上限：不限/)
 release('allowed-once')
 const result=await pending;assert.equal(result.isError,false)
 assert.equal(f.dispatched.length,1);assert.deepEqual(f.dispatched[0].workBudgetPolicy,f.settings().policy)
 assert.equal(f.dispatched[0].workTokenLimit,undefined)
})

test('等待审批期间页设版本改变，即使数值相同也拒绝旧卡且不派发',async t=>{
 const f=await fixture(t)
 let release!:(value:string)=>void,asked!:()=>void;const seen=new Promise<void>(resolve=>{asked=resolve})
 f.setApprove(()=>new Promise<string>(resolve=>{release=resolve;asked()}))
 const pending=f.call({});await seen
 f.setSettings({...f.settings(),version:2})
 release('allowed-once')
 const result=await pending;assert.equal(result.isError,true);assert.equal(f.dispatched.length,0)
})

test('模型给出与页面不同额度、页设跨会话、本人拒绝均不派发',async t=>{
 const f=await fixture(t)
 const conflict=await f.call({workTokenLimit:6_000_000})
 assert.equal(conflict.isError,true);assert.equal(f.approvals.length,0);assert.equal(f.dispatched.length,0)
 f.setSettings({...f.settings(),sessionId:'other-session'})
 const wrongSession=await f.call({},'wrong-session');assert.equal(wrongSession.isError,true);assert.equal(f.approvals.length,0)
 f.setSettings({...f.settings(),sessionId:f.sessionId,version:0})
 const wrongVersion=await f.call({},'wrong-version');assert.equal(wrongVersion.isError,true);assert.equal(f.approvals.length,0)
 f.setSettings({...f.settings(),sessionId:f.sessionId,version:1});f.setApprove(async()=> 'rejected')
 const denied=await f.call({},'rejected');assert.equal(denied.isError,true);assert.equal(f.dispatched.length,0)
})

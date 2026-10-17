import test from 'node:test'
import assert from 'node:assert/strict'
import {brandString} from '@deepseek-ai/dsh-brand'
import {SessionSeq,type SessionId,type TurnEndReason,type SessionEvent} from '@deepseek-ai/dsh-session/types'
import type {SessionEventLikeEntry} from '@deepseek-ai/dsh-api-session-controller/client'
import {createAssistantCompanionActivity} from '../src/client/assistant-companion-activity.ts'
function source<T>(value:T){const listeners=new Set<()=>void>();return {getSnapshot:()=>value,subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener)}},set:(next:T)=>{value=next;for(const listener of [...listeners])listener()},size:()=>listeners.size}}
const events:SessionEventLikeEntry[]=[
 {type:'event',event:{seq:SessionSeq(0),time:1,type:'turn/start',data:{turn:1}}},
 {type:'event',event:{seq:SessionSeq(1),time:2,type:'user/message',surfaceOp:'append',data:{id:brandString<Extract<SessionEvent,{type:'user/message'}>['data']['id']>('human'),role:'user',source:{kind:'user'},content:[{type:'text',text:'准备报告'}]}}},
]
const base={sessionId:brandString<SessionId>('assistant'),running:false,removed:false,openState:'open' as const,lastAgentError:null as string|null,promptError:null,awaitingFirstTurn:false,subagent:null}
async function fixture(){
 const state=source(base),eventSource=source({entries:[] as readonly SessionEventLikeEntry[]}),connection=source('connected'),list=source({phase:'ready',ids:['assistant','employee']}),bound={sessionId:brandString<SessionId>('assistant'),session:state,eventSource}
 let binding=bound,retained=0,released=0
 const sessions={list,binding:(id:SessionId)=>id==='assistant'?binding:undefined,retain:(_id:SessionId,_options:{source:'assistantCompanion'})=>{retained++;const current=binding;return {binding:current,ready:Promise.resolve(current),release:()=>{released++}}}}
 const activity=createAssistantCompanionActivity(),off=activity.attach({sessions,connection});activity.setSession('assistant');await new Promise(resolve=>setImmediate(resolve))
 const finish=(kind:'completed'|'aborted'|'error')=>{const reason:TurnEndReason=kind==='completed'?{kind}:kind==='aborted'?{kind,reason:{kind:'user'}}:{kind,error:{code:'UNKNOWN',message:'failed'}};eventSource.set({entries:[...events,{type:'event',event:{seq:SessionSeq(2),time:3,type:'turn/end',data:{turn:1,reason}}}]});state.set({...base,running:false})}
 return {activity,off,state,eventSource,connection,list,finish,setBinding:(next:typeof bound)=>binding=next,counts:()=>({retained,released})}
}
test('只观察已核验原助手会话，真实处理中读书，completed终态证据才庆祝',async()=>{
 const f=await fixture();f.eventSource.set({entries:events});f.state.set({...base,running:true});assert.equal(f.activity.getSnapshot().status,'processing');assert.equal(f.activity.getSnapshot().pose,'reading')
 f.finish('completed');assert.equal(f.activity.getSnapshot().status,'completed');assert.equal(f.activity.getSnapshot().pose,'celebrating')
 f.activity.setSession(undefined);assert.equal(f.activity.getSnapshot().pose,'standing');assert.equal(f.counts().released,1);f.off();assert.equal(f.state.size(),0)
})
test('停止、失败、运行状态关闭和其他会话忙碌均不能冒充完成',async()=>{
 for(const kind of ['aborted','error'] as const){const f=await fixture();f.eventSource.set({entries:events});f.state.set({...base,running:true});f.finish(kind);assert.equal(f.activity.getSnapshot().pose,'standing');assert.equal(f.activity.getSnapshot().status,kind==='aborted'?'stopped':'failed');f.off()}
 const f=await fixture();f.state.set({...base,awaitingFirstTurn:true});assert.equal(f.activity.getSnapshot().pose,'reading');f.state.set({...base,awaitingFirstTurn:true,lastAgentError:'failed'});assert.equal(f.activity.getSnapshot().status,'failed');f.state.set({...base,running:true});f.state.set(base);assert.equal(f.activity.getSnapshot().pose,'standing');f.list.set({phase:'ready',ids:['assistant','employee','other-running']});assert.equal(f.activity.getSnapshot().pose,'standing');f.off()
})
test('断线与绑定代际替换清除完成；冷恢复旧终态不重新庆祝，原新轮次可继续',async()=>{
 const f=await fixture();f.eventSource.set({entries:events});f.state.set({...base,running:true});f.finish('completed');assert.equal(f.activity.getSnapshot().pose,'celebrating');f.connection.set('disconnected');assert.equal(f.activity.getSnapshot().pose,'standing');assert.equal(f.activity.getSnapshot().status,'unknown')
 f.connection.set('connected');await new Promise(resolve=>setImmediate(resolve));assert.equal(f.activity.getSnapshot().pose,'standing')
 f.activity.setSession(undefined);f.activity.setSession('assistant');await new Promise(resolve=>setImmediate(resolve));assert.equal(f.activity.getSnapshot().pose,'standing')
 const replacementState=source(base),replacementEvents=source({entries:f.eventSource.getSnapshot().entries}),replacement={sessionId:base.sessionId,session:replacementState,eventSource:replacementEvents}
 f.setBinding(replacement);f.list.set({phase:'ready',ids:['assistant','employee']});assert.equal(f.activity.getSnapshot().pose,'standing');await new Promise(resolve=>setImmediate(resolve));assert.equal(f.activity.getSnapshot().pose,'standing');assert.equal(f.state.size(),0)
 replacementEvents.set({entries:[...events.map(entry=>entry.type==='event'?{...entry,event:{...entry.event,seq:SessionSeq(entry.event.seq+3)}}:entry)]});replacementState.set({...base,running:true});assert.equal(f.activity.getSnapshot().pose,'reading')
 replacementEvents.set({entries:[...replacementEvents.getSnapshot().entries,{type:'event',event:{seq:SessionSeq(5),time:6,type:'turn/end',data:{turn:1,reason:{kind:'completed'}}}}]});replacementState.set(base);assert.equal(f.activity.getSnapshot().pose,'celebrating')
 f.off();assert.equal(replacementState.size(),0);assert.equal(f.state.size(),0)
})

test('原会话身份被移除或读取未完成即失效，迟到ready不能恢复错误的状态',async()=>{
 const state=source(base),eventSource=source({entries:events as readonly SessionEventLikeEntry[]}),connection=source('connected'),list=source({phase:'ready',ids:['assistant']}),binding={sessionId:base.sessionId,session:state,eventSource}
 let resolve!:(value:typeof binding)=>void,released=0
 const sessions={list,binding:()=>binding,retain:()=>({binding,ready:new Promise<typeof binding>(done=>resolve=done),release:()=>{released++}})}
 const activity=createAssistantCompanionActivity(),off=activity.attach({sessions,connection});activity.setSession('assistant')
 assert.equal(activity.getSnapshot().status,'unknown');list.set({phase:'ready',ids:[]});resolve(binding);await new Promise(done=>setImmediate(done));assert.equal(activity.getSnapshot().status,'unknown');assert.equal(released,1)
 list.set({phase:'ready',ids:['assistant']});resolve(binding);await new Promise(done=>setImmediate(done));state.set({...base,running:true});assert.equal(activity.getSnapshot().pose,'reading')
 state.set({...base,removed:true});assert.equal(activity.getSnapshot().pose,'standing');assert.equal(activity.getSnapshot().status,'unknown')
 activity.invalidate();state.set({...base,running:true});assert.equal(activity.getSnapshot().status,'unknown');activity.setSession(undefined);assert.equal(activity.getSnapshot().status,'idle');off();assert.equal(state.size(),0)
})

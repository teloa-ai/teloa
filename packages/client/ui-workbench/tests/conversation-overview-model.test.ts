import test from 'node:test'
import assert from 'node:assert/strict'
import type {SessionBinding,SessionEventLikeEntry} from '@deepseek-ai/dsh-api-session-controller/client'
import {conversationOverviewRound,conversationOverviewRoundEntries,projectConversationOverviewSnapshot,createConversationOverviewModel,type ConversationOverviewInput,type ConversationOverviewJob} from '../src/client/conversation-overview-model.ts'

const event=(seq:number,type:string,data:unknown,time=seq*100)=>({type:'event',event:{seq,type,data,time,...(type==='user/message'?{surfaceOp:'append'}:{})}}) as SessionEventLikeEntry
const human=(seq:number,id:string)=>event(seq,'user/message',{id,role:'user',source:{kind:'user'},content:[{type:'text',text:id}]})
const session={running:false,removed:false,openState:'open' as const,lastAgentError:null,promptError:null,awaitingFirstTurn:false}
const input=(entries:readonly SessionEventLikeEntry[]=[],rest:Partial<ConversationOverviewInput>={}):ConversationOverviewInput=>({sessionId:'main',session,entries,...rest})
const job=(id:string,status:string,rest:Partial<ConversationOverviewJob>={}):ConversationOverviewJob=>({id,kind:'bash',label:id,owner:'main',status,startedAt:200,...rest})

test('空会话与未进入宿主的人类输入没有虚构轮次或步骤',()=>{
 const empty=projectConversationOverviewSnapshot(input())
 assert.equal(empty.status,'idle');assert.equal(empty.currentRound,undefined);assert.deepEqual(empty.progress,{current:[],earlier:[]})
 const starting=projectConversationOverviewSnapshot(input([event(1,'turn/start',{turn:1})],{session:{...session,running:true,awaitingFirstTurn:true}}))
 assert.equal(starting.status,'running');assert.equal(starting.currentRound,undefined)
 assert.deepEqual(conversationOverviewRoundEntries([event(1,'tool/call',{})],undefined),[])
})

test('当前用户工作轮次归并Goal续轮，临时chunk不进入资源事实',()=>{
 const entries=[event(1,'turn/start',{turn:1}),human(2,'request'),event(3,'tool/call',{}),event(4,'turn/end',{turn:1,reason:{kind:'completed'}}),event(5,'turn/start',{turn:2}),event(6,'user/message',{source:{kind:'goal'}}),{type:'transient',event:{seq:6.5,type:'assistant/live-chunk'}} as SessionEventLikeEntry,event(7,'turn/end',{turn:2,reason:{kind:'completed'}})]
 const round=conversationOverviewRound('main',entries)!
 assert.equal(round.turn,1);assert.deepEqual(round.turns,[1,2]);assert.equal(round.startSeq,1);assert.equal(round.userMessageSeq,2);assert.equal(round.endSeq,7);assert.equal(round.status,'completed')
 assert.deepEqual(conversationOverviewRoundEntries(entries,round).map(entry=>entry.event.seq),[1,2,3,4,5,6,7])
 assert.equal(conversationOverviewRound('main',entries.slice(0,5)),undefined,'新宿主轮次尚无已进入输入时不继承上一轮的使用范围')
})

test('同一宿主turn的第二条人类输入独立切界，压缩副本和fork继承不算当前输入',()=>{
 const replacement={...human(4,'copy'),event:{...human(4,'copy').event,surfaceOp:{op:'replace',startSeq:2,endSeq:2}}} as SessionEventLikeEntry
 const entries=[event(1,'turn/start',{turn:1}),human(2,'first'),event(3,'tool/call',{}),replacement,human(5,'second'),event(6,'tool/call',{})]
 const round=conversationOverviewRound('main',entries)!
 assert.equal(round.startSeq,5);assert.equal(round.userMessageId,'second');assert.deepEqual(conversationOverviewRoundEntries(entries,round).map(entry=>entry.event.seq),[5,6])
 assert.equal(conversationOverviewRound('child',[...entries,event(7,'session/end-seed',{inherited:true}),event(8,'turn/start',{turn:2})]),undefined)
})

test('宿主失败、取消、阻塞和未知终态分别投影，停止响应不是成功',()=>{
 for(const [kind,want] of [['completed','completed'],['aborted','stopped'],['error','failed'],['blocked','waiting'],['interrupted','unknown'],['max-tokens','failed'],['future-end','unknown']] as const){
  const value=projectConversationOverviewSnapshot(input([event(1,'turn/start',{turn:1}),human(2,'work'),event(3,'turn/end',{turn:1,reason:{kind}})]))
  assert.equal(value.status,want,kind)
 }
 const running=[event(1,'turn/start',{turn:1}),human(2,'work')]
 assert.equal(projectConversationOverviewSnapshot(input(running,{session:{...session,running:false}})).status,'unknown')
 assert.equal(projectConversationOverviewSnapshot(input(running,{session:{...session,running:true},pendingInteraction:true})).status,'waiting')
 assert.equal(projectConversationOverviewSnapshot(input(running,{session:{...session,running:true},stopping:true})).status,'stopping')
 assert.equal(projectConversationOverviewSnapshot(input([...running,event(3,'turn/end',{turn:1,reason:{kind:'aborted'}})],{stopping:true})).status,'stopped')
 assert.equal(projectConversationOverviewSnapshot(input(running,{session:{...session,running:true},connected:false})).status,'unknown')
})

test('只投影真实Todo和Goal，完成项收进较早步骤且不凭列表推算工作成功',()=>{
 const entries=[event(1,'turn/start',{turn:1}),human(2,'work'),event(3,'todo/write',{todos:[]})]
 const todos=[{content:'Read source',status:'completed'},{content:'Implement',status:'in_progress'},{content:'Verify',status:'pending'}]
 const goal={goal:{id:'goal',objective:'Ship',phase:'blocked',blockedReason:{code:'input',message:'Need input'}},roundsStarted:9}
 const value=projectConversationOverviewSnapshot(input(entries,{todos,goal,session:{...session,running:true}}))
 assert.deepEqual(value.progress.current.map(step=>[step.content,step.status]),[['Implement','running'],['Verify','pending']])
 assert.deepEqual(value.progress.earlier.map(step=>step.content),['Read source']);assert.equal(value.progress.goal?.blockedReason,'Need input');assert.equal(value.status,'waiting')
 assert.equal(projectConversationOverviewSnapshot(input(entries,{todos:[{content:'All done',status:'completed'}],session:{...session,running:true}})).status,'running')
})

test('后台工作严格限定会话，保留正在停止和真实终态，仅用稳定关联去重',()=>{
 const {owner:_owner,...unowned}=job('unowned','running')
 const jobs=[job('run','running'),job('stop','stopping'),job('done','completed'),job('killed','killed'),job('fail','failed'),job('future','future'),job('foreign','running',{owner:'other'}),unowned]
 const value=projectConversationOverviewSnapshot(input([],{jobs}))
 assert.deepEqual(value.running.map(work=>[work.jobId,work.status]),[['run','running'],['stop','stopping'],['future','unknown']])
 assert.deepEqual(value.ended.map(work=>[work.jobId,work.status]),[['done','completed'],['killed','stopped'],['fail','failed']])
 assert.equal(value.running[1]?.canStop,false)
 const linked=projectConversationOverviewSnapshot(input([],{jobs:[job('agent-job','running',{kind:'subagent'})],children:[{id:'child',mode:'one-shot',label:'same',createdAt:100,running:true}],workLinks:[{jobId:'agent-job',childSessionId:'child'}]}))
 assert.equal(linked.running.length,1);assert.equal(linked.running[0]?.childSessionId,'child');assert.equal(linked.running[0]?.jobId,'agent-job')
})

test('子助手inactive不推断成功，已持有子会话终态提供准确结束原因',()=>{
 const children=[{id:'cold',mode:'one-shot' as const,createdAt:100,running:false},{id:'done',mode:'continuable' as const,label:'done',createdAt:100,running:false,lastTurnCompleted:true},{id:'stopped',mode:'one-shot' as const,createdAt:100,running:false,entries:[event(1,'turn/start',{turn:1}),event(2,'turn/end',{turn:1,reason:{kind:'aborted'}})]}]
 const value=projectConversationOverviewSnapshot(input([],{children}))
 assert.deepEqual(value.running.map(work=>[work.childSessionId,work.status]),[['cold','unknown']])
 assert.deepEqual(value.ended.map(work=>[work.childSessionId,work.status]),[['done','completed'],['stopped','stopped']])
})

function source<T>(value:T){const listeners=new Set<()=>void>();return {getSnapshot:()=>value,subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener)}},set:(next:T)=>{value=next;for(const listener of listeners)listener()},size:()=>listeners.size}}
test('原生事实变化通知一次缓存快照，解除挂载后不消费旧绑定事件',()=>{
 const state=source(session),events=source({entries:[] as readonly SessionEventLikeEntry[]}),todos=source<unknown>(null),goal=source<unknown>(null),catalog=source<unknown>([])
 const binding={sessionId:'main',session:{...state,projections:{faceOf:(key:string)=>({todos,goal,subagentCatalog:catalog}[key]??source(undefined))}},eventSource:events} as unknown as SessionBinding
 const model=createConversationOverviewModel(binding),before=model.getSnapshot();let changes=0
 const off=model.subscribe(()=>{changes++}),detach=model.attach()
 assert.equal(model.getSnapshot(),model.getSnapshot())
 events.set({entries:[event(1,'turn/start',{turn:1}),human(2,'work')]});state.set({...session,running:true})
 assert.equal(model.getSnapshot().status,'running');assert.equal(model.getSnapshot().currentRound?.userMessageId,'work');assert.notEqual(model.getSnapshot(),before);assert.ok(changes>0)
 detach();const detached=model.getSnapshot(),count=changes
 events.set({entries:[]});assert.equal(model.getSnapshot(),detached);assert.equal(changes,count)
 assert.equal(state.size(),0);assert.equal(events.size(),0);assert.equal(todos.size(),0);off()
})

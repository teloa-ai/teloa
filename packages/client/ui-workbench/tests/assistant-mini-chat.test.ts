import test from 'node:test'
import assert from 'node:assert/strict'
import {brandString} from '@deepseek-ai/dsh-brand'
import {SessionSeq,type SessionId} from '@deepseek-ai/dsh-session/types'
import type {SessionEventLikeEntry,SessionSnapshot} from '@deepseek-ai/dsh-api-session-controller/client'
import {createAssistantMiniChat,projectAssistantMiniChatMessages,type AssistantMiniChatServices} from '../src/client/assistant-mini-chat.ts'

function source<T>(value:T){const listeners=new Set<()=>void>();return {getSnapshot:()=>value,subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener)}},set:(next:T)=>{value=next;for(const listener of [...listeners])listener()},size:()=>listeners.size}}
const tick=()=>new Promise(resolve=>setImmediate(resolve))
const sid=brandString<SessionId>('assistant')
const history=[
 {type:'event',event:{seq:SessionSeq(0),time:1,type:'turn/start',data:{turn:1}}},
 {type:'event',event:{seq:SessionSeq(1),time:2,type:'user/message',surfaceOp:'append',data:{id:'m-user',role:'user',source:{kind:'user',rpcId:'r-admitted'},content:[{type:'text',text:'准备周报'}]}}},
 {type:'event',event:{seq:SessionSeq(2),time:3,type:'assistant/message',surfaceOp:'append',data:{message:{id:'m-assistant',role:'assistant',content:[{type:'text',text:'**已整理**三项'}]},interrupted:false}}},
 {type:'event',event:{seq:SessionSeq(3),time:4,type:'user/message',surfaceOp:'append',data:{id:'m-goal',role:'user',source:{kind:'goal'},content:[{type:'text',text:'系统目标不进小窗'}]}}},
 {type:'transient',event:{type:'assistant/live-chunk',seq:4,time:5,data:{attemptId:'attempt',turn:2,step:1,chunk:{type:'text-delta',index:0,text:'正在'}}}},
 {type:'transient',event:{type:'assistant/live-chunk',seq:4,time:6,data:{attemptId:'attempt',turn:2,step:1,chunk:{type:'reasoning-delta',index:1,text:'内部推理不显示'}}}},
 {type:'transient',event:{type:'assistant/live-chunk',seq:4,time:7,data:{attemptId:'attempt',turn:2,step:1,chunk:{type:'text-delta',index:0,text:'回复'}}}},
] as unknown as SessionEventLikeEntry[]
const pending=(requestId:string,placement:'transcript'|'queued',text:string)=>({requestId,placement,time:1,text,attachments:[]}) as unknown as SessionSnapshot['pendingSubmissions'][number]

function fixture(options:{status?:string;sessionId?:string|undefined}={}){
 const identity=source<{status:string;sessionId?:string}>({status:options.status??'idle',...('sessionId' in options?options.sessionId===undefined?{}:{sessionId:options.sessionId}:{sessionId:'assistant'})})
 const state=source({sessionId:sid,pendingSubmissions:[] as ReturnType<typeof pending>[],running:false,removed:false,openState:'open' as string,loadingOlder:false,lastAgentError:null as string|null,subagent:null})
 const events=source({entries:[] as SessionEventLikeEntry[],hasMore:false}),queue=source({queue:[] as unknown[]}),block=source<{reason:string}|undefined>(undefined)
 const calls={begin:[] as unknown[],prompt:[] as unknown[][],abandon:0,cancel:0,retain:[] as string[],released:0,draft:[] as unknown[],nativeDraft:0}
 let prompt:()=>Promise<{ok:boolean}>=async()=>({ok:true}),draftResult:'applied'|'preserved'|'blocked'='applied'
 const session={getSnapshot:state.getSnapshot,subscribe:state.subscribe,beginSubmission(input:unknown){calls.begin.push(input);return {requestId:'req-'+calls.begin.length,abandon(){calls.abandon++}}},prompt(...args:unknown[]){calls.prompt.push(args);return prompt()},loadOlder:async()=>{},cancel(){calls.cancel++}}
 const binding={sessionId:sid,session,eventSource:events,ctx:{scope:'assistant'}}
 let current:typeof binding|undefined=binding
 const list=source({phase:'ready',ids:['assistant'] as string[]}),connection=source('connected'),status=source(new Map<SessionId,{pendingInteraction?:unknown}>())
 const gate=source<{sessionId:string|undefined;status:string;reason?:string}>({sessionId:undefined,status:'idle'}),selected:(string|undefined)[]=[]
 let decision:{status:string;reason?:string}={status:'ready'}
 const services={
  sessions:{list,binding:(id:SessionId)=>id===sid?current:undefined,retain:(id:SessionId,retain:{source:string})=>{calls.retain.push(retain.source+':'+id);const held=current!;return {binding:held,ready:Promise.resolve(held),release(){calls.released++}}}},
  connection,status,blocks:{storeFor:()=>block},
  capability:{getSnapshot:gate.getSnapshot,subscribe:gate.subscribe,select(id:string|undefined){selected.push(id);gate.set(id?{sessionId:id,...decision}:{sessionId:undefined,status:'idle'})}},
  input:{for(ctx:unknown){assert.equal(ctx,binding.ctx);return {state:queue,setDraft(){calls.nativeDraft++},submit(){calls.nativeDraft++}}},requestDraftInitialization(held:unknown,request:unknown){assert.equal(held,binding);calls.draft.push(request);return draftResult}},
 } as unknown as AssistantMiniChatServices
 const chat=createAssistantMiniChat(identity),off=chat.attach(services)
 return {chat,off,identity,state,events,queue,block,list,connection,status,gate,selected,calls,setDecision:(next:typeof decision)=>decision=next,setPrompt:(next:typeof prompt)=>prompt=next,setDraftResult:(next:typeof draftResult)=>draftResult=next,replace:(next:typeof binding|undefined)=>current=next}
}

test('原会话消息只取本人文字与助手回复，流式片段、本地回显和排队按原生顺序合成且去重',()=>{
 const rows=projectAssistantMiniChatMessages('assistant',history,[pending('r-admitted','transcript','已入列不重复'),pending('r-new','transcript','刚发送'),pending('r-queued','queued','稍后处理')],[{id:'q1',source:{kind:'user',rpcId:'r-queued-accepted'},content:[{type:'text',text:'宿主排队'}]},{id:'m-user',source:{kind:'user'},content:[{type:'text',text:'已成为历史'}]}] as Parameters<typeof projectAssistantMiniChatMessages>[3])
 assert.deepEqual(rows.map(row=>[row.role,row.text,row.state]),[
  ['user','准备周报','sent'],['assistant','**已整理**三项','sent'],['assistant','正在回复','streaming'],
  ['user','刚发送','sending'],['user','稍后处理','queued'],['user','宿主排队','queued'],
 ])
})

test('未打开不持有引用；打开后以小窗来源读取已核验原会话，不选中、不新建会话',async()=>{
 const f=fixture();assert.equal(f.chat.getSnapshot().phase,'closed');assert.deepEqual(f.calls.retain,[])
 f.events.set({entries:history,hasMore:true});f.chat.open();assert.equal(f.chat.getSnapshot().phase,'loading');await tick()
 assert.deepEqual(f.calls.retain,['assistantMiniChat:assistant'])
 const snapshot=f.chat.getSnapshot();assert.equal(snapshot.phase,'ready');assert.equal(snapshot.sessionId,'assistant');assert.equal(snapshot.hasMore,true)
 assert.deepEqual(snapshot.messages.map(row=>row.text),['准备周报','**已整理**三项','正在回复'])
 f.status.set(new Map([[sid,{pendingInteraction:{kind:'approval'}}]]));assert.equal(f.chat.getSnapshot().waiting,true)
 f.state.set({...f.state.getSnapshot(),running:true});assert.equal(f.chat.getSnapshot().running,true)
 f.off();assert.equal(f.calls.released,1);assert.equal(f.state.size(),0)
})

test('发送沿用原生 beginSubmission→prompt 同一请求号；成功才清空小窗草稿，不改原生输入、不停止工作',async()=>{
 const f=fixture();f.chat.open();await tick()
 f.chat.setDraft('  帮我列出今天待办 ');assert.equal(f.chat.getSnapshot().draft,'  帮我列出今天待办 ')
 let release!:(value:{ok:boolean})=>void;f.setPrompt(()=>new Promise(done=>release=done))
 const sent=f.chat.send();assert.equal(f.chat.getSnapshot().sending,true)
 f.chat.setDraft('发送中不可改');assert.equal(f.chat.getSnapshot().draft,'  帮我列出今天待办 ')
 assert.deepEqual(f.calls.begin,[{mode:'queue',text:'帮我列出今天待办',attachments:[]}])
 assert.deepEqual(f.calls.prompt,[[[{type:'text',text:'帮我列出今天待办'}],'queue',undefined,'req-1']])
 release({ok:true});assert.equal(await sent,true)
 assert.equal(f.chat.getSnapshot().draft,'');assert.equal(f.chat.getSnapshot().sending,false);assert.equal(f.chat.getSnapshot().sendFailed,false)
 assert.equal(f.calls.nativeDraft,0);assert.equal(f.calls.cancel,0);assert.deepEqual(f.calls.retain,['assistantMiniChat:assistant'])
 f.off()
})

test('宿主拒绝或抛错保留草稿并提示；原生输入阻断或空草稿不发送',async()=>{
 const f=fixture();f.chat.open();await tick();f.chat.setDraft('第一版')
 f.setPrompt(async()=>({ok:false}));assert.equal(await f.chat.send(),false)
 assert.equal(f.chat.getSnapshot().draft,'第一版');assert.equal(f.chat.getSnapshot().sendFailed,true)
 f.setPrompt(async()=>{throw Error('private transport detail')});assert.equal(await f.chat.send(),false);assert.equal(f.calls.abandon,1);assert.equal(f.chat.getSnapshot().draft,'第一版')
 f.block.set({reason:'原生能力暂不可用'});assert.equal(f.chat.getSnapshot().block,'原生能力暂不可用')
 const before=f.calls.begin.length;assert.equal(await f.chat.send(),false);assert.equal(f.calls.begin.length,before)
 f.block.set(undefined);f.chat.setDraft('   ');assert.equal(await f.chat.send(),false);assert.equal(f.calls.begin.length,before)
 f.off()
})

test('关闭只释放读取引用；发送中关闭等宿主回执后才释放；草稿跨开关保留',async()=>{
 const f=fixture();f.chat.open();await tick();f.chat.setDraft('稍后继续')
 f.chat.close();assert.equal(f.calls.released,1);assert.equal(f.chat.getSnapshot().phase,'closed');assert.equal(f.chat.getSnapshot().draft,'稍后继续')
 f.chat.open();await tick();assert.equal(f.chat.getSnapshot().phase,'ready');assert.equal(f.chat.getSnapshot().draft,'稍后继续')
 let release!:(value:{ok:boolean})=>void;f.setPrompt(()=>new Promise(done=>release=done))
 const sent=f.chat.send();f.chat.close();assert.equal(f.calls.released,1,'回执前不释放发送所用引用')
 release({ok:true});await sent;assert.equal(f.calls.released,2);assert.equal(f.calls.cancel,0)
 f.off()
})

test('身份未核验、尚无助手、断线、原会话移除与代际替换都给出准确状态且不跨会话带草稿',async()=>{
 const checking=fixture({status:'unknown',sessionId:undefined});checking.chat.open();assert.equal(checking.chat.getSnapshot().phase,'checking');assert.deepEqual(checking.calls.retain,[]);checking.off()
 const missing=fixture({status:'idle',sessionId:undefined});missing.chat.open();assert.equal(missing.chat.getSnapshot().phase,'missing');missing.chat.setDraft('无会话不留草稿');assert.equal(missing.chat.getSnapshot().draft,'');assert.equal(await missing.chat.send(),false);missing.off()
 const f=fixture();f.chat.open();await tick();f.chat.setDraft('原助手草稿')
 f.connection.set('disconnected');assert.equal(f.chat.getSnapshot().phase,'offline');assert.equal(f.chat.getSnapshot().draft,'原助手草稿');assert.equal(f.calls.released,1)
 f.connection.set('connected');await tick();assert.equal(f.chat.getSnapshot().phase,'ready')
 f.state.set({...f.state.getSnapshot(),removed:true});assert.equal(f.chat.getSnapshot().phase,'unavailable');f.state.set({...f.state.getSnapshot(),removed:false})
 f.list.set({phase:'ready',ids:[]});assert.equal(f.chat.getSnapshot().phase,'unavailable');f.list.set({phase:'ready',ids:['assistant']});await tick();assert.equal(f.chat.getSnapshot().phase,'ready')
 f.replace(undefined);f.list.set({phase:'ready',ids:['assistant']});assert.notEqual(f.chat.getSnapshot().phase,'ready')
 f.identity.set({status:'idle',sessionId:'other'});assert.equal(f.chat.getSnapshot().draft,'','切换到其他已核验会话不带入原草稿')
 f.identity.set({status:'idle',sessionId:'assistant'});assert.equal(f.chat.getSnapshot().draft,'原助手草稿')
 f.off()
})

test('打开完整会话的草稿交接只用原生 requestDraftInitialization，原生已有草稿时双方都保留',async()=>{
 const f=fixture();f.chat.open();await tick()
 assert.equal(f.chat.handoffDraft(),'empty');assert.deepEqual(f.calls.draft,[])
 f.chat.setDraft('交给完整会话');f.setDraftResult('preserved')
 assert.equal(f.chat.handoffDraft(),'preserved');assert.deepEqual(f.calls.draft,[{prompt:'交给完整会话'}]);assert.equal(f.chat.getSnapshot().draft,'交给完整会话')
 f.setDraftResult('applied');assert.equal(f.chat.handoffDraft(),'applied');assert.equal(f.chat.getSnapshot().draft,'')
 assert.equal(f.calls.nativeDraft,0)
 f.off()
})

test('原助手会话不在主视图时仍按同源会话能力分类核对：未出结论保持载入，核对中或被拒均不能发送',async()=>{
 const f=fixture();f.setDecision({status:'checking',reason:'正在核对可用能力'});f.chat.open();await tick()
 assert.deepEqual(f.selected,['assistant']);assert.equal(f.chat.getSnapshot().phase,'ready');assert.equal(f.chat.getSnapshot().block,'正在核对可用能力')
 f.chat.setDraft('需要员工协作');assert.equal(await f.chat.send(),false);assert.deepEqual(f.calls.begin,[])
 f.gate.set({sessionId:'other',status:'ready'});assert.equal(f.chat.getSnapshot().phase,'loading','分类结论不属于本会话时不可发送')
 f.gate.set({sessionId:'assistant',status:'ready',reason:'当前权益不包含员工协作'});assert.equal(f.chat.getSnapshot().block,'当前权益不包含员工协作');assert.equal(await f.chat.send(),false)
 f.block.set({reason:'原生输入阻断优先'});assert.equal(f.chat.getSnapshot().block,'原生输入阻断优先');f.block.set(undefined)
 f.gate.set({sessionId:'assistant',status:'ready'});assert.equal(f.chat.getSnapshot().block,undefined);assert.equal(await f.chat.send(),true);assert.equal(f.calls.begin.length,1)
 f.chat.close();assert.deepEqual(f.selected,['assistant',undefined],'关闭后不再持有能力核对')
 f.off()
})

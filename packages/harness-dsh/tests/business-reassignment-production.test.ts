import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {Context} from '@deepseek-ai/cordis'
import {LlmRuntime,ToolCallId} from '@deepseek-ai/dsh-llm'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {SessionStore,SessionId,Session} from '@deepseek-ai/dsh-session'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {publishConversationWorkStatus} from '../src/conversation-work-publisher.ts'
import {readSessionEvents} from '../src/session-events.ts'
import {NativeReassignmentAttestor,withNativeResourceInspection} from '../src/business-reassignment-native.ts'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import {WorkError,canonicalBusinessReassignmentSnapshot,type BusinessReassignmentSnapshot,type BusinessReassignmentInstruction,type BusinessReassignmentReceipt,type WorkTask} from '@teloa/contract'
import {workRequestChildId,type ConversationWorkRequest,type TaskRun} from '@teloa/backend'
import {reserveInputFromReassignment,type ReassignmentRunTargets} from '@teloa/backend'
import {BusinessReassignmentDispatch,type BusinessReassignmentDispatchPorts} from '../src/business-reassignment-dispatch.ts'
import {registerBusinessReassignmentTools,businessReassignmentToolName,type BusinessReassignmentToolsPorts} from '../src/business-reassignment-tools.ts'
import {sourceInstruction} from '../src/conversation-work-instruction.ts'
import {ConversationWorkDispatch,type ConversationWorkDispatchPorts} from '../src/conversation-work-dispatch.ts'
const owner='owner',oldRequestId='11111111-1111-4111-8111-111111111111',newRequestId='22222222-2222-4222-8222-222222222222',oldRole='33333333-3333-4333-8333-333333333333',newRole='44444444-4444-4444-8444-444444444444',oldTask='55555555-5555-4555-8555-555555555555',newTask='66666666-6666-4666-8666-666666666666',oldRun='77777777-7777-4777-8777-777777777777',newRun='88888888-8888-4888-8888-888888888888',date='2026-09-30T00:00:00.000Z'
function fixture(state:TaskRun['state']='prepared',sameDaily=false,instructionOverride?:BusinessReassignmentInstruction){
 const requestIdentity=instructionOverride?.requestId??'22222222-2222-4222-8222-222222222222'
 const newRequestId=requestIdentity
 const calls:string[]=[],body:Omit<BusinessReassignmentSnapshot,'snapshotHash'>={instruction:{requestId:newRequestId,sessionId:sameDaily?'old-daily':'new-daily',messageId:'new-human',messageSeq:7,sourceText:'本人新的改派要求',selection:{oldRequestId,newRoleId:newRole,expectedNewRoleVersion:2}},oldSessionId:'old-daily',scope:'SOC',oldContext:{version:1,roleId:sameDaily?null:oldRole},newContext:{version:sameDaily?1:2,roleId:null},oldTarget:{roleId:oldRole,roleVersion:1,name:'旧同事'},oldRoleCurrent:{version:2,state:'retired'},newTarget:{roleId:newRole,roleVersion:2,name:'新同事'},responsibility:{version:4,roleId:oldRole},title:'服务器原标题',goal:'服务器原目标',sourceText:'服务器原始资料',reference:{scope:'SOC',type:'alert',id:'alert-fixed',version:4,snapshotHash:'a'.repeat(64)}}
 if(instructionOverride)body.instruction=instructionOverride
 const snapshot={...body,snapshotHash:createHash('sha256').update(canonicalBusinessReassignmentSnapshot(body)).digest('hex')}
 const requests=new Map<string,ConversationWorkRequest>([[oldRequestId,{requestId:oldRequestId,sessionId:'old-daily',messageId:'old-human',messageSeq:2,kind:'task',scope:'SOC',title:body.title,goal:body.goal,sourceText:body.sourceText!,reference:body.reference!,targets:[{...body.oldTarget,scope:'SOC',unavailable:null}],failures:{},stoppedAt:null,createdAt:date}]])
 const tasks=new Map<string,WorkTask>(),runs=new Map<string,TaskRun>()
 const task=(id:string,roleId:string,roleVersion:number):WorkTask=>({id,ownerId:owner,version:1,state:'ready',title:body.title,goal:body.goal,scope:'SOC',groupId:null,skills:[],assigneeRoleId:roleId,assigneeRoleVersion:roleVersion,createdAt:date,updatedAt:date})
 tasks.set(oldTask,task(oldTask,oldRole,1));runs.set(oldRun,{id:oldRun,taskId:oldTask,taskVersion:1,roleId:oldRole,roleVersion:1,linkVersion:1,sessionId:'task-run-'+workRequestChildId(oldRequestId,'run',oldRole),nativeRequestId:oldRequestId,state,allowedTools:[],skills:[],knowledge:[],memory:[],inputText:'private old run body',evidence:null,stopRequestedAt:null,...(state==='configuration_failed'?{configurationError:{code:'teloa/model-unavailable',stage:'model-resolve' as const,message:'模型尚未准备；未claim未发送'}}:{}),createdAt:date})
 let receipt:BusinessReassignmentReceipt|null=null,loseCommitReply=false,crashBeforeDispatch=false,claimed=false,extraRead:((targets:ReassignmentRunTargets)=>void)|undefined
 const workPorts:ConversationWorkDispatchPorts={owner,requests:{
  reserve:async(_owner,input)=>{calls.push('reserve');assert.deepEqual(input,reserveInputFromReassignment(snapshot));const stored=requests.get(newRequestId);if(stored)return stored;throw new Error('commit必须先原子保存新reserve')},get:async(_owner,input)=>{const row=input as {requestId:string;sessionId:string};const value=requests.get(row.requestId);if(value?.sessionId!==row.sessionId)throw new WorkError('teloa/forbidden','原公开session归属拒绝');return value??null},list:async()=>[],stop:async(_owner,input)=>{calls.push('stop-intent');const row=input as {requestId:string;sessionId:string};const old=requests.get(row.requestId)!;if(row.sessionId!==old.sessionId)throw new WorkError('teloa/forbidden','原公开session归属拒绝');const changed={...old,stoppedAt:date};requests.set(row.requestId,changed);return changed},withDispatchLock:async(_owner,_id,op)=>{calls.push('dispatch-lock');return op(new AbortController().signal)},failure:async()=>{},pendingNotifications:async()=>[],notified:async()=>{}},
  tasks:{request:async()=>null,create:async()=>{throw new Error('不应走普通task创建')}},boundTasks:{request:async identity=>tasks.get(identity.requestId===oldRequestId?oldTask:newTask)??null,create:async identity=>{assert.equal(identity.requestId,newRequestId);calls.push('new-task');const value=task(newTask,newRole,2);tasks.set(newTask,value);return value}},link:async()=>{calls.push('link')},runs:async taskId=>[...runs.values()].filter(run=>run.taskId===taskId),run:async(endpoint,input)=>{
   const row=input as {runId?:string;taskId?:string},run=row.runId?runs.get(row.runId):undefined;calls.push(endpoint+'/'+(run?.taskId??row.taskId))
   if(endpoint==='task-runs/prepare'){const next:TaskRun={...runs.get(oldRun)!,id:newRun,taskId:newTask,roleId:newRole,roleVersion:2,sessionId:'task-run-'+workRequestChildId(newRequestId,'run',newRole),nativeRequestId:newRequestId,state:'prepared',evidence:null,stopRequestedAt:null};runs.set(newRun,next);return next}
   if(!run)throw new Error('缺少精确run')
   if(endpoint==='task-runs/start'){if(claimed)throw new Error('重复发送');claimed=true;const next={...run,state:'accepted'};runs.set(run.id,next);return next}
   if(endpoint==='task-runs/withdraw'){assert.equal(run.state,'prepared');const next={...run,state:'withdrawn'};runs.set(run.id,next);return next}
   if(endpoint==='task-runs/stop'){const next={...run,stopRequestedAt:date};runs.set(run.id,next);return next}
   if(endpoint==='task-runs/reconcile')return run
   throw new Error('不支持的endpoint')
  },result:async()=>undefined,publish:async()=>{},now:()=>date}
 const work=new ConversationWorkDispatch(workPorts)
 const attestor=new NativeReassignmentAttestor<null,TaskRun>({
  withRunTransaction:async(_owner,identity,operation)=>{const run=runs.get(identity.id);assert.ok(run);return operation(null,run)},
  readSettlement:async(_db,_owner,run)=>JSON.stringify(run),hashSettlement:value=>createHash('sha256').update(value).digest('hex'),
  readInspection:async identity=>({meta:{id:SessionId(identity.sessionId)},inheritedEventCount:0,events:[]}),recordProof:async()=>{assert.fail('本夹具没有原生证明正例；禁止造proof')},
 })
 const ports:BusinessReassignmentDispatchPorts={owner,reassignments:{prepare:async()=>snapshot,readReceiptForRequest:async(currentOwner,id)=>{assert.equal(currentOwner,owner);assert.equal(id,newRequestId);return receipt},readReassignmentRuns:async(_owner,input,revalidate)=>{await revalidate();assert.equal(input.oldRequestId,oldRequestId);calls.push('read-authorized');const targets:ReassignmentRunTargets={oldRequestId,oldSessionId:'old-daily',scope:'SOC',targets:[{roleId:oldRole,taskRequestId:workRequestChildId(oldRequestId,'task',oldRole),taskId:oldTask,runs:[...runs.values()].filter(run=>run.taskId===oldTask).map(({id,taskId,sessionId,nativeRequestId})=>({id,taskId,sessionId,nativeRequestId}))}]};extraRead?.(targets);return targets},commit:async(_owner,input,approved,revalidate)=>{
   await revalidate();assert.equal(approved.snapshotHash,snapshot.snapshotHash);calls.push('commit');if(input.instruction.requestId!==newRequestId)throw new WorkError('teloa/conflict','原根已有后继')
   if(!receipt){for(const run of runs.values())if(run.taskId===oldTask&&(!(['withdrawn','configuration_failed'].includes(run.state))||run.state==='configuration_failed'&&(!run.configurationError||run.evidence!==null)))throw new WorkError('teloa/conflict','真实proof未交付');const reserve=reserveInputFromReassignment(snapshot);requests.set(newRequestId,{...reserve,targets:[{...body.newTarget,scope:'SOC',unavailable:null}],failures:{},stoppedAt:null,createdAt:date});receipt={oldRequestId,newRequestId,oldSessionId:'old-daily',newSessionId:body.instruction.sessionId,scope:'SOC',snapshotHash:snapshot.snapshotHash,createdAt:date}}
   if(loseCommitReply){loseCommitReply=false;throw new WorkError('teloa/host-unavailable','已提交但回包丢失')}
   return receipt
  }},work,attestReassignmentRuns:async(currentOwner,targets,signal)=>{calls.push('attest');await attestor.attestReassignmentRuns(currentOwner,targets,signal)},dispatch:async(input,signal,revalidate)=>{if(crashBeforeDispatch){crashBeforeDispatch=false;throw new WorkError('teloa/host-unavailable','dispatch前崩溃')}return work.dispatch(input,signal,revalidate)}}
 const dispatcher=new BusinessReassignmentDispatch(ports)
 return {dispatcher,ports,work,workPorts,snapshot,calls,runs,tasks,requests,get receipt(){return receipt},loseReply:()=>loseCommitReply=true,crash:()=>crashBeforeDispatch=true,extraRead:(fn:(targets:ReassignmentRunTargets)=>void)=>extraRead=fn}
}
test('跨daily prepared经原withdraw，再commit并沿原唯一claim；材料来自共享mapper',async()=>{
 const f=fixture(),result=await f.dispatcher.supersede(f.snapshot,AbortSignal.timeout(5000),async()=>{})
 assert.equal(f.runs.get(oldRun)!.state,'withdrawn');assert.equal(result.reassignment?.oldRequestId,oldRequestId);assert.equal(result.requestId,newRequestId)
 assert.equal(f.calls.filter(call=>call==='new-task').length,1);assert.equal(f.calls.filter(call=>call==='task-runs/start/'+newTask).length,1)
 assert.ok(f.calls.indexOf('read-authorized')<f.calls.indexOf('stop-intent'));assert.ok(f.calls.indexOf('task-runs/withdraw/'+oldTask)<f.calls.indexOf('commit'));assert.ok(f.calls.indexOf('commit')<f.calls.indexOf('reserve'))
 assert.equal(f.requests.get(newRequestId)!.sourceText,'服务器原始资料');assert.equal(f.requests.get(newRequestId)!.goal,'服务器原目标');assert.equal(f.requests.get(newRequestId)!.reference!.version,4)
 assert.ok(!JSON.stringify(result).includes('private old run body'));assert.equal(result.counts.received,0)
})
test('已确定未发送configuration_failed可改派，unknown/active及缺真实proof的ended均拒绝',async()=>{
 for(const state of ['configuration_failed','unknown','active','ended'] as const){
  const f=fixture(state)
  if(state==='configuration_failed'){const result=await f.dispatcher.supersede(f.snapshot,AbortSignal.timeout(5000),async()=>{});assert.equal(result.requestId,newRequestId)}
  else{await assert.rejects(f.dispatcher.supersede(f.snapshot,AbortSignal.timeout(5000),async()=>{}),WorkError);assert.equal(f.requests.has(newRequestId),false);assert.equal(f.calls.includes('new-task'),false)}
 }
})
test('post-stop重验或commit失败保留旧停止，零后继且不恢复旧执行',async()=>{
 for(const stage of ['revalidate','commit']){const f=fixture();if(stage==='commit')f.ports.reassignments.commit=async()=>{throw new WorkError('teloa/conflict','负责人版本变更')};await assert.rejects(f.dispatcher.supersede(f.snapshot,AbortSignal.timeout(5000),async()=>{if(stage==='revalidate'&&f.calls.includes('stop-intent'))throw new WorkError('teloa/conflict','授权变化')}),WorkError);assert.equal(f.requests.get(oldRequestId)!.stoppedAt,date);assert.equal(f.requests.has(newRequestId),false);assert.equal(f.calls.some(call=>call.startsWith('task-runs/start')),false)}
})
test('commit丢回包或dispatch前崩溃，同消息重试继续同一后继Task/Run',async()=>{
 for(const stage of ['commit-reply','dispatch-crash']){const f=fixture();if(stage==='commit-reply')f.loseReply();else f.crash();await assert.rejects(f.dispatcher.supersede(f.snapshot,AbortSignal.timeout(5000),async()=>{}),WorkError);assert.ok(f.receipt);assert.equal(f.tasks.has(newTask),false);await f.dispatcher.supersede(f.snapshot,AbortSignal.timeout(5000),async()=>{});await f.dispatcher.supersede(f.snapshot,AbortSignal.timeout(5000),async()=>{});assert.equal(f.calls.filter(call=>call==='new-task').length,1);assert.equal(f.calls.filter(call=>call==='task-runs/start/'+newTask).length,1);assert.equal(f.tasks.get(newTask)!.state,'ready')}
})
test('窄旧停止只消费server授权tuple，全历史Run均收敛，公开stop仍拒绝跨session',async()=>{
 const f=fixture(),history={...f.runs.get(oldRun)!,id:'99999999-9999-4999-8999-999999999999',sessionId:'historical-own-run',nativeRequestId:'historical-rpc'};f.runs.set(history.id,history)
 await assert.rejects(f.work.stop('new-daily',oldRequestId,AbortSignal.timeout(5000)),WorkError)
 // memory request.stop 对session使用严格assert；外层get/public归属尚未改变。
 await f.dispatcher.supersede(f.snapshot,AbortSignal.timeout(5000),async()=>{})
 assert.equal(f.runs.get(history.id)!.state,'withdrawn');assert.equal(f.calls.filter(call=>call==='task-runs/withdraw/'+oldTask).length,2)
})
test('授权tuple与审批旧request/session/role/scope不一致时零停止',async()=>{
 for(const field of ['oldRequestId','oldSessionId','scope','roleId']){const f=fixture();f.extraRead(targets=>{if(field==='roleId')targets.targets[0]!.roleId=newRole;else if(field==='oldRequestId')targets.oldRequestId=newRequestId;else if(field==='oldSessionId')targets.oldSessionId='forged';else targets.scope='other'});await assert.rejects(f.dispatcher.supersede(f.snapshot,AbortSignal.timeout(5000),async()=>{}));assert.equal(f.calls.includes('stop-intent'),false)}
})

test('后继结果notice保留old/new/source固定关联，原生Session冷恢复不重复且未本人验收不completed',async t=>{
 const f=fixture(),status=await f.dispatcher.supersede(f.snapshot,AbortSignal.timeout(5000),async()=>{})
 const ctx=new Context();t.after(()=>ctx.fiber.dispose());await ctx.plugin(LlmRuntime);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 const {agent}=await ctx.agents.create({sessionId:SessionId(status.sessionId),agentOptions:{provider:'test',model:'test'}})
 let activeSession=agent.session
 ctx.provide('sessionController',{resolveAgent:async()=>({agent:{session:activeSession}})})
 const sessions:unknown=Reflect.get(ctx,'sessions')
 assert.ok(sessions instanceof SessionStore,'夹具必须使用实际官方 SessionStore 服务')
 t.mock.method(sessions,'flush',async()=>true)
 await publishConversationWorkStatus(ctx,status,async()=>{})
 const notice=readSessionEvents(agent.session).find(event=>event.type==='user/message')!
 assert.equal(notice.type,'user/message')
 if(notice.type==='user/message'){assert.deepEqual(Reflect.get(notice.data.source,'reassignment'),f.receipt);assert.deepEqual(Reflect.get(notice.data.source,'sourceReference'),f.snapshot.reference);assert.match(JSON.stringify(notice.data.content),/原交办/);assert.ok(JSON.stringify(notice.data.content).includes(oldRequestId))}
 const restored=Session.create(SessionId(status.sessionId),JSON.parse(JSON.stringify(readSessionEvents(agent.session))),agent.session.header)
 activeSession=restored
 await publishConversationWorkStatus(ctx,{...status,observedAt:date},async()=>{})
 assert.equal(readSessionEvents(restored).filter(event=>event.type==='user/message').length,1)
 assert.equal(f.tasks.get(newTask)!.state,'ready')
})
test('原dispatch冷读服务端后继receipt，保留关联；损坏receipt不能回流正文',async()=>{
 const f=fixture();await f.dispatcher.supersede(f.snapshot,AbortSignal.timeout(5000),async()=>{})
 f.workPorts.reassignment=async request=>request.requestId===newRequestId?f.receipt:null
 const status=await f.work.status(f.snapshot.instruction.sessionId,newRequestId)
 assert.deepEqual(status.reassignment,f.receipt);assert.deepEqual(status.sourceReference,f.snapshot.reference)
 f.workPorts.reassignment=async()=>({...f.receipt!,newSessionId:'forged'})
 await assert.rejects(f.work.status(f.snapshot.instruction.sessionId,newRequestId),WorkError)
})

test('实际Cordis live Agent即使有真实aborted日志仍受rc.1输入冻结缺口拒绝，零proof与后继',async t=>{
 const f=fixture('ended'),ctx=new Context();t.after(()=>ctx.fiber.dispose());await ctx.plugin(LlmRuntime);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 const run=f.runs.get(oldRun)!,{agent}=await ctx.agents.create({sessionId:SessionId(run.sessionId),agentOptions:{provider:'test',model:'test'}})
 agent.session.append('turn/start',{turn:0} as never)
 agent.session.append('user/message',createUserMessage({source:{kind:'user',rpcId:run.nativeRequestId},content:[{type:'text',text:'原交办'}]}),{surfaceOp:'append'})
 agent.session.append('turn/end',{turn:0,reason:{kind:'aborted',reason:{kind:'user'}}} as never)
 f.runs.set(oldRun,{...run,stopRequestedAt:date,evidence:{state:'ended',turn:0,messageSeq:1,endSeq:2,reason:'aborted'}})
 let proofs=0
 const attestor=new NativeReassignmentAttestor<null,TaskRun>({
  withRunTransaction:async(_owner,identity,operation)=>{const current=f.runs.get(identity.id);assert.ok(current);return operation(null,current)},readSettlement:async(_db,_owner,value)=>JSON.stringify(value),hashSettlement:value=>createHash('sha256').update(value).digest('hex'),
  readInspection:async()=>({meta:agent.session.header,inheritedEventCount:0,events:readSessionEvents(agent.session)}),
  withInspection:(identity,signal,work)=>withNativeResourceInspection(agent,{get:()=>agent.session,flush:async()=>true,inspect:async()=>({meta:agent.session.header,inheritedEventCount:0,events:readSessionEvents(agent.session)})},identity,undefined,'fixture-current',undefined,signal,work),
  recordProof:async()=>{proofs++},
 })
 f.ports.attestReassignmentRuns=(currentOwner,targets,signal)=>attestor.attestReassignmentRuns(currentOwner,targets,signal)
 await assert.rejects(f.dispatcher.supersede(f.snapshot,AbortSignal.timeout(5000),async()=>{}),error=>error instanceof WorkError&&error.message.includes('执行资源仍待核对')&&error.message.includes('未创建新的后继'))
 assert.equal(proofs,0);assert.equal(f.requests.has(newRequestId),false);assert.equal(f.calls.includes('new-task'),false)
})

test('同daily未锁定指定接手人的原会话可安全改派，跨daily不改旧会话锁定同事',async()=>{
 const same=fixture('prepared',true),cross=fixture('prepared')
 for(const f of [same,cross]){const approved=structuredClone(f.snapshot);await f.dispatcher.supersede(f.snapshot,AbortSignal.timeout(5000),async()=>{});assert.deepEqual(f.snapshot,approved);assert.equal(f.requests.get(newRequestId)!.sessionId,f.snapshot.instruction.sessionId)}
 assert.equal(same.snapshot.oldSessionId,same.snapshot.instruction.sessionId)
 assert.equal(cross.snapshot.oldContext.roleId,oldRole);assert.equal(cross.snapshot.newContext.roleId,null)
})

function barrier(){let entered!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>entered=resolve),waiting=new Promise<void>(resolve=>release=resolve);return {started,release,wait:async()=>{entered();await waiting}}}
async function approvedFixture(){
 const ctx=new Context();await ctx.plugin(LlmRuntime);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 const {agent}=await ctx.agents.create({sessionId:SessionId('new-daily'),agentOptions:{provider:'test',model:'test'}})
 agent.session.append('turn/start',{turn:0} as never);agent.session.append('user/message',createUserMessage({source:{kind:'user',rpcId:'approval-barrier-human'},content:[{type:'text',text:'请把原交办安全改派给另一同事'}]}),{surfaceOp:'append'})
 const selection={oldRequestId,newRoleId:newRole,expectedNewRoleVersion:2},actual=sourceInstruction(owner,{agent}),f=fixture('prepared',false,{...actual,sourceText:actual.sourceText!,selection})
 let oldAllowed=true,newAllowed=true;const approvals:string[]=[]
 ctx.provide('approval',{request:async(input:{reason:string})=>{approvals.push(input.reason);return 'allowed-once'}})
 const prepare:BusinessReassignmentToolsPorts['prepare']=async(input,revalidate)=>{await revalidate();if(!oldAllowed||!newAllowed)throw new WorkError('teloa/forbidden','双方日常授权已撤销');assert.deepEqual(input.instruction,f.snapshot.instruction);return f.snapshot}
 registerBusinessReassignmentTools(ctx,{owner,conversation:async id=>({ownerId:owner,sessionId:id,status:'ready'}),readTaskPolicy:async()=>null,isRoleConversation:async()=>false,isBuilder:async()=>false,isPendingDaily:async()=>false,isTaskConversation:async()=>false,prepare,supersede:(snapshot,signal,revalidate)=>f.dispatcher.supersede(snapshot,signal,revalidate)})
 return {...f,ctx,agent,approvals,call:()=>ctx.tools.execute({agent,name:businessReassignmentToolName,arguments:selection,callId:ToolCallId('barrier-call'),signal:AbortSignal.timeout(5000)}),revoke:(kind:string)=>{if(kind==='old-authority')oldAllowed=false;else if(kind==='new-authority')newAllowed=false;else{agent.session.append('turn/start',{turn:1} as never);agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'新的本人消息'}]}),{surfaceOp:'append'})}}}
}
test('I1真实批准后current/task/runs等待期间指令或双方授权撤回，首次停止前零副作用',{timeout:15000},async t=>{
 for(const boundary of ['current','task','runs'])for(const revoke of ['instruction','old-authority','new-authority']){
  const f=await approvedFixture();t.after(()=>f.ctx.fiber.dispose());const gate=barrier()
  if(boundary==='current'){const original=f.workPorts.requests.get;f.workPorts.requests.get=async(...args)=>{const value=await original(...args);await gate.wait();return value}}
  else if(boundary==='task'){const original=f.workPorts.boundTasks.request;f.workPorts.boundTasks.request=async identity=>{const value=await original(identity);await gate.wait();return value}}
  else{const original=f.workPorts.runs;f.workPorts.runs=async id=>{const value=await original(id);await gate.wait();return value}}
  const pending=f.call();await gate.started;f.revoke(revoke);gate.release();const result=await pending
  assert.equal(result.isError,true,boundary+revoke);assert.equal(f.approvals.length,1);assert.equal(f.requests.get(oldRequestId)!.stoppedAt,null,boundary+revoke);assert.equal(f.calls.includes('stop-intent'),false,boundary+revoke);assert.equal(f.runs.get(oldRun)!.state,'prepared');assert.equal(f.receipt,null)
 }
})
test('I1持久停止回包等待后撤权不再withdraw；首Run停止等待后不再停止第二Run',{timeout:15000},async t=>{
 for(const boundary of ['stop-intent','first-run'])for(const revoke of ['instruction','old-authority','new-authority']){
  const f=await approvedFixture();t.after(()=>f.ctx.fiber.dispose());const gate=barrier(),secondId='99999999-9999-4999-8999-999999999999'
  f.runs.set(secondId,{...f.runs.get(oldRun)!,id:secondId,sessionId:'historical-own-run',nativeRequestId:'second-rpc'})
  if(boundary==='stop-intent'){const original=f.workPorts.requests.stop;f.workPorts.requests.stop=async(...args)=>{const value=await original(...args);await gate.wait();return value}}
  else{const original=f.workPorts.run;let first=true;f.workPorts.run=async(...args)=>{const value=await original(...args);if(first&&args[0]==='task-runs/withdraw'){first=false;await gate.wait()}return value}}
  const pending=f.call();await gate.started;f.revoke(revoke);gate.release();const result=await pending
  assert.equal(result.isError,true);assert.equal(f.requests.get(oldRequestId)!.stoppedAt,date);assert.equal(f.runs.get(secondId)!.state,'prepared',boundary+revoke);assert.equal(f.calls.filter(call=>call==='task-runs/withdraw/'+oldTask).length,boundary==='stop-intent'?0:1,boundary+revoke);assert.equal(f.receipt,null)
  assert.match(JSON.stringify(result),/停止意图已保存/);assert.match(JSON.stringify(result),/执行资源仍待核对/)
 }
})
test('I2后停止validate/read/commit失败必须报告已保存停止及本次后继状态',async()=>{
 for(const stage of ['validate','read','commit']){
  const f=fixture()
  if(stage==='read'){const original=f.ports.reassignments.readReassignmentRuns;f.ports.reassignments.readReassignmentRuns=async(...args)=>{if(f.requests.get(oldRequestId)!.stoppedAt)throw new WorkError('teloa/forbidden','旧会话授权变化');return original(...args)}}
  if(stage==='commit')f.ports.reassignments.commit=async()=>{throw new WorkError('teloa/conflict','负责人版本变更')}
  await assert.rejects(f.dispatcher.supersede(f.snapshot,AbortSignal.timeout(5000),async()=>{if(stage==='validate'&&f.requests.get(oldRequestId)!.stoppedAt)throw new WorkError('teloa/conflict','批准变更')}),error=>error instanceof WorkError&&(/停止意图已保存|旧交办已停止/.test(error.message))&&error.message.includes('未创建'))
  assert.equal(f.requests.get(oldRequestId)!.stoppedAt,date);assert.equal(f.receipt,null);assert.equal(f.calls.includes('reserve'),false)
 }
})
test('I2停止回包丢失明确待核对，commit丢回包不能伪称零后继，dispatch失败保留已建身份',async()=>{
 for(const stage of ['stop-reply','commit-reply','dispatch-crash']){
  const f=fixture()
  if(stage==='stop-reply'){const original=f.workPorts.requests.stop;f.workPorts.requests.stop=async(...args)=>{await original(...args);throw new WorkError('teloa/host-unavailable','停止回包丢失')}}
  else if(stage==='commit-reply')f.loseReply();else f.crash()
  await assert.rejects(f.dispatcher.supersede(f.snapshot,AbortSignal.timeout(5000),async()=>{}),error=>{if(!(error instanceof WorkError))return false;if(stage==='stop-reply')return error.message.includes('停止状态待核对');if(stage==='commit-reply')return error.message.includes('后继提交待核对')&&!error.message.includes('未创建后继');return error.message.includes('后继已创建')&&error.message.includes(newRequestId)})
  assert.equal(f.calls.includes('reserve'),false);assert.equal(f.requests.get(oldRequestId)!.stoppedAt,date)
  if(stage==='stop-reply')assert.equal(f.receipt,null);else assert.ok(f.receipt)
 }
})
test('I2既有后继receipt读取等待后撤权仍准确保留已创建身份，不再stop或commit',async()=>{
 const f=fixture();f.loseReply();await assert.rejects(f.dispatcher.supersede(f.snapshot,AbortSignal.timeout(5000),async()=>{}),WorkError)
 let allowed=true;const original=f.ports.reassignments.readReceiptForRequest
 f.ports.reassignments.readReceiptForRequest=async(...args)=>{const saved=await original(...args);allowed=false;return saved}
 const stops=f.calls.filter(call=>call==='stop-intent').length,commits=f.calls.filter(call=>call==='commit').length
 await assert.rejects(f.dispatcher.supersede(f.snapshot,AbortSignal.timeout(5000),async()=>{if(!allowed)throw new WorkError('teloa/forbidden','恢复期间授权变化')}),error=>error instanceof WorkError&&error.message.includes('后继已创建')&&error.details?.reassignment!==undefined)
 assert.equal(f.calls.filter(call=>call==='stop-intent').length,stops);assert.equal(f.calls.filter(call=>call==='commit').length,commits);assert.equal(f.calls.includes('reserve'),false)
})
test('I1真实批准首个active Run停止等待后撤权，零reconcile且后续Run仍prepared',{timeout:15000},async t=>{
 for(const revoke of ['instruction','old-authority','new-authority']){
  const f=await approvedFixture();t.after(()=>f.ctx.fiber.dispose());const gate=barrier(),secondId='99999999-9999-4999-8999-999999999999'
  f.runs.set(oldRun,{...f.runs.get(oldRun)!,state:'active'})
  f.runs.set(secondId,{...f.runs.get(oldRun)!,state:'prepared',id:secondId,sessionId:'historical-own-run',nativeRequestId:'second-rpc'})
  const original=f.workPorts.run;f.workPorts.run=async(...args)=>{const value=await original(...args);if(args[0]==='task-runs/stop')await gate.wait();return value}
  const pending=f.call();await gate.started;f.revoke(revoke);gate.release();const result=await pending
  assert.equal(result.isError,true);assert.equal(f.runs.get(oldRun)!.stopRequestedAt,date);assert.equal(f.runs.get(secondId)!.state,'prepared');assert.equal(f.calls.filter(call=>call==='task-runs/reconcile/'+oldTask).length,0);assert.equal(f.receipt,null)
 }
})

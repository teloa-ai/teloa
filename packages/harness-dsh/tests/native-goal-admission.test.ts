import test from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {patchedNativePackage} from './fixtures/native-patched-package.ts'
import {patchedSessionFixture} from './fixtures/native-final-session.ts'
import {deferred,until} from './fixtures/native-schedule-admission.ts'
import {createNativeGoalAdmission} from '../src/native-goal-admission.ts'
import {createNativeWorkInput} from '../src/native-work-input.ts'
import {WorkAccess} from '../../backend/src/work/work-access.ts'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createTaskRunGoal} from '../src/task-run-goal.ts'

async function durableFixture(t:any){
 const f=await patchedSessionFixture(t),root=await mkdtemp(join(tmpdir(),'teloa-goal-durable-'))
 t.after(()=>rm(root,{recursive:true,force:true}))
 await f.ctx.plugin(f.persistencePackage.default,{root,compression:'none'})
 const {agent}=await f.ctx.agents.create({sessionId:f.sessionPackage.SessionId('durable-goal'),agentOptions:{provider:'test',model:'test'}})
 return {...f,agent}
}

const anchor=createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json'),official=createRequire(anchor)
async function driverFixture(t:any,options:any={}){
 const driver=(await patchedNativePackage<any>(t,{packageName:'@deepseek-ai/dsh-goal-round-driver',compatBasename:'dsh-goal-round-driver-0.2.1-alpha.1-input-admission',packageAnchor:anchor})).namespace
 const f=await patchedSessionFixture(t),goal=await import(pathToFileURL(official.resolve('@deepseek-ai/dsh-goal')).href)
 await f.ctx.plugin(goal.GoalService)
 // 挡在模型调用前，真实 Agent/Session/Inbox 仍运行；测试不伪称模型质量。
 const step=deferred();t.after(()=>step.resolve())
 f.ctx.on('agent/pre-step',async({signal})=>{await Promise.race([step.promise,new Promise<void>(resolve=>{if(signal.aborted)resolve();else signal.addEventListener('abort',()=>resolve(),{once:true})})]);return {kind:'reject'} as const})
 await f.ctx.plugin(driver,options)
 return {...f,driver,goals:Reflect.get(f.ctx,'goals') as any}
}

test('薄补口 required 缺 provider 零投递，恢复 Goal 保留官方 disarmed',async t=>{
 const f=await driverFixture(t,{requireInputAdmission:true})
 f.goals.create(f.agent,{objective:'长任务',maxGoalRounds:3})
 await until(()=>f.goals.get(f.agent)?.phase==='blocked')
 assert.equal(f.agent.inbox.nextTurn.length,0)
 assert.equal(f.agent.session.snapshotEvents().filter(event=>event.type==='agent/inbox/spliced'&&event.data.inserted.length).length,0)
 const ref=f.goals.get(f.agent);f.goals.resume(f.agent,{id:ref.id,revision:ref.revision});f.goals.disarm(f.agent)
 assert.equal(f.goals.get(f.agent).activation,'disarmed')
})

test('官方异步准入 await 后复核 exact Goal revision，迟到 dispatch 与重复调用均拒绝',async t=>{
 const entered=deferred<any>(),hold=deferred();let late:(()=>void)|undefined,calls=0
 const f=await driverFixture(t,{requireInputAdmission:true,admitInput:async(candidate:any,dispatch:()=>void)=>{if(calls++)throw Error('本测试拒绝后续新候选');late=dispatch;entered.resolve(candidate);await hold.promise;dispatch()}})
 const goal=f.goals.create(f.agent,{objective:'长任务'})
 const candidate=await entered.promise
 assert.equal(candidate.message.source.kind,'goal');assert.equal(candidate.round,1);assert.equal(f.agent.inbox.nextTurn.length,0)
 f.goals.edit(f.agent,{id:goal.id,revision:goal.revision},{objective:'本人已改变目标'})
 hold.resolve()
 await until(()=>f.goals.get(f.agent)?.phase==='blocked'||f.goals.get(f.agent)?.activation==='disarmed')
 assert.equal(f.agent.session.snapshotEvents().some(event=>event.type==='agent/inbox/spliced'&&event.data.inserted.some(message=>message.id===candidate.message.id)),false)
 assert.throws(()=>late!(),/stale/)
})

test('Goal 服务 lease 在最终 Session guard 内复核，撤销时零原生写；受理后 confirm 来自真实 Inbox seq',async t=>{
 const f=await durableFixture(t),access=new WorkAccess(),input=createNativeWorkInput(f.ctx,access)
 t.after(()=>input.close())
 const hold=deferred();t.after(()=>hold.resolve());f.ctx.on('agent/pre-step',async({signal})=>{await Promise.race([hold.promise,new Promise<void>(resolve=>{if(signal.aborted)resolve();else signal.addEventListener('abort',()=>resolve(),{once:true})})]);return {kind:'reject'} as const})
 const binding={ownerId:'owner',runId:'run',sessionId:f.agent.id,goalId:'goal',revision:1,hostGeneration:1,controlId:'control',controlGeneration:1}
 let valid=true,confirmed:number|undefined,unknown=0
 const ports={resolve:async()=>binding,reserve:async(a:any)=>({...a.binding,...a,state:'reserved',acceptedSeq:null}),acquire:async()=>({assertCurrent(){assert.ok(valid)}}),confirm:async(a:any)=>{confirmed=a.acceptedSeq;return a},unknown:async()=>{unknown++},assertCurrent(){assert.ok(valid)},assertContinuationCurrent(){assert.ok(valid)}} as any
 const admit=createNativeGoalAdmission(f.ctx,input,ports)
 const message=createUserMessage({content:[{type:'text',text:'继续长任务'}],source:{kind:'goal',goalId:'goal',revision:1,round:1} as any}),candidate={agent:f.agent,message,goal:{id:'goal',revision:1},round:1}
 const remove=f.ctx.on('session/event',()=>{}, {global:true})
 const invalidate=f.ctx.on('internal/dispatch',(mode,name,args)=>{if(mode==='emit'&&name==='session/event'&&(args[1] as any).type==='agent/inbox/spliced')valid=false},{global:true})
 await assert.rejects(admit(candidate,()=>f.agent.followup(message)))
 assert.equal(f.agent.inbox.nextTurn.length,0);assert.equal(confirmed,undefined);assert.equal(unknown,1)
 invalidate();remove();valid=true
 await admit(candidate,()=>f.agent.followup(message))
 assert.equal(typeof confirmed,'number')
 const accepted=f.agent.session.snapshotEvents()[confirmed!]
 assert.equal(accepted?.type,'agent/inbox/spliced')
})

test('真实持久 Inbox 已受理但 confirm 回包失败，可补确认原seq；矛盾票据不重发',async t=>{
 const f=await durableFixture(t),goal=await import(pathToFileURL(official.resolve('@deepseek-ai/dsh-goal')).href);await f.ctx.plugin(goal.GoalService)
 const hold=deferred();t.after(()=>hold.resolve());f.ctx.on('agent/pre-step',async({signal})=>{await Promise.race([hold.promise,new Promise<void>(resolve=>{if(signal.aborted)resolve();else signal.addEventListener('abort',()=>resolve(),{once:true})})]);return {kind:'reject'} as const})
 const goals=Reflect.get(f.ctx,'goals') as any,g=goals.create(f.agent,{objective:'对账原受理',maxGoalRounds:3}),run={id:'run',sessionId:f.agent.id,nativeRequestId:'initial'}
 const binding={ownerId:'owner',runId:run.id,sessionId:run.sessionId,goalId:g.id,revision:g.revision,hostGeneration:1,controlId:'control',controlGeneration:1}
 let receipt:any,confirmCalls=0
 const service:any={read:async()=>({binding,continuations:receipt?[receipt]:[]}),findRun:async()=>run,reserve:async(_owner:string,a:any)=>(receipt={...a.binding,round:a.round,messageId:a.messageId,nativeRequestId:a.nativeRequestId,payloadSha256:a.payloadSha256,state:'reserved',acceptedSeq:null}),acquire:async()=>({assertCurrent(){}}),confirm:async(_owner:string,a:any)=>{if(!confirmCalls++)throw Error('lost confirmation');receipt={...receipt,state:'accepted',acceptedSeq:a.acceptedSeq};return receipt},markUnknown:async()=>{receipt={...receipt,state:'unknown',acceptedSeq:null}},authorizeMutation:async()=>({assertCurrent(){}})}
 const input=createNativeWorkInput(f.ctx,new WorkAccess()),adapter=createTaskRunGoal(f.ctx,service,'owner',{nativeInput:input,hostGeneration:()=>1});t.after(()=>{adapter.close();input.close()})
 const message=createUserMessage({source:{kind:'goal',goalId:g.id,revision:g.revision,round:1} as any,content:[{type:'text',text:'只允许原请求一次'}]}),candidate={agent:f.agent,message,goal:{id:g.id,revision:g.revision},round:1}
 await assert.rejects(adapter.admit(candidate,()=>f.agent.followup(message)),/lost confirmation/);assert.equal(receipt.state,'unknown')
 const observed=await adapter.observation(run);assert.equal(observed!.continuations[0]!.state,'accepted');assert.equal(confirmCalls,2)
 assert.equal(f.agent.session.snapshotEvents().filter(event=>event.type==='agent/inbox/spliced'&&event.data.inserted.some(item=>item.id===message.id)).length,1)
 receipt={...receipt,state:'unknown',acceptedSeq:null,payloadSha256:'0'.repeat(64)};await assert.rejects(adapter.observation(run),{code:'teloa/storage-corrupt'});assert.equal(confirmCalls,2)
})

test('下一 Goal 轮先读取持久停滞，达到阈值官方 blocked/disarmed，零新票据和输入',async t=>{
 const f=await durableFixture(t),goal=await import(pathToFileURL(official.resolve('@deepseek-ai/dsh-goal')).href);await f.ctx.plugin(goal.GoalService)
 const hold=deferred();t.after(()=>hold.resolve());f.ctx.on('agent/pre-step',async({signal})=>{await Promise.race([hold.promise,new Promise<void>(resolve=>{if(signal.aborted)resolve();else signal.addEventListener('abort',()=>resolve(),{once:true})})]);return {kind:'reject'} as const})
 const goals=Reflect.get(f.ctx,'goals') as any,g=goals.create(f.agent,{objective:'重复复述不能算工作进展',maxGoalRounds:4}),run={id:'run',sessionId:f.agent.id,nativeRequestId:'initial'}
 let binding:any={ownerId:'owner',runId:run.id,sessionId:run.sessionId,goalId:g.id,revision:g.revision,hostGeneration:1,controlId:'control',controlGeneration:1},reserved=0,recorded=0
 const first=createUserMessage({source:{kind:'goal',goalId:g.id,revision:g.revision,round:1} as any,content:[{type:'text',text:'已受理第一轮'}]})
 // 本例只验证发布前的停滞端口；可信完成/资源证据由后端 PG 与原生观察测试分别覆盖。
 f.agent.session.append('turn/start',{turn:0} as never);f.agent.session.append('user/message',first,{surfaceOp:'append'});f.agent.session.append('turn/end',{turn:0,reason:{kind:'completed'}} as never)
 assert.equal(goals.get(f.agent).roundsStarted,1)
 const receipt={...binding,round:1,messageId:first.id,nativeRequestId:'first-round',payloadSha256:'a'.repeat(64),state:'accepted',acceptedSeq:1}
 const service:any={read:async()=>({binding,continuations:[receipt]}),findRun:async()=>run,updateRef:async(_owner:string,input:any)=>(binding={...binding,revision:input.revision}),reserve:async()=>{reserved++;throw Error('不能发布停滞续轮')},authorizeMutation:async()=>({assertCurrent(){}})}
 let state:any={runId:run.id,goalId:g.id,lastRound:0,roundsWithoutProgress:0,shouldWait:false,reason:null,evidence:[]}
 const input=createNativeWorkInput(f.ctx,new WorkAccess()),adapter=createTaskRunGoal(f.ctx,service,'owner',{nativeInput:input,hostGeneration:()=>1,requireStagnation:true,stagnation:{readStagnation:async()=>state,recordProgressRound:async(a:any)=>{recorded++;return state={...state,lastRound:a.round,roundsWithoutProgress:1,shouldWait:true,reason:'持续没有新资料，等待本人。'}}}} as any)
 t.after(()=>{adapter.close();input.close()})
 const message=createUserMessage({source:{kind:'goal',goalId:g.id,revision:g.revision,round:2} as any,content:[{type:'text',text:'不应发布第二轮'}]})
 await assert.rejects(adapter.admit({agent:f.agent,message,goal:{id:g.id,revision:g.revision},round:2},()=>f.agent.followup(message)),{code:'teloa/conflict'})
 assert.equal(recorded,1);assert.equal(reserved,0);assert.equal(goals.get(f.agent).phase,'blocked');assert.equal(goals.get(f.agent).activation,'disarmed')
 assert.equal(f.agent.session.snapshotEvents().some(event=>event.type==='agent/inbox/spliced'&&event.data.inserted.some(item=>item.id===message.id)),false)
})

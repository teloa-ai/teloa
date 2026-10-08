import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {LlmAdapter,ToolCallId,createUserMessage,type GenerateOptions,type StreamChunk} from '@deepseek-ai/dsh-llm'
import {SessionId} from '@deepseek-ai/dsh-session'
import {patchedSessionFixture} from './fixtures/native-final-session.ts'
import {patchedNativePackage} from './fixtures/native-patched-package.ts'
import {until,deferred} from './fixtures/native-schedule-admission.ts'
import {createNativeWorkInput} from '../src/native-work-input.ts'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createTaskRunGoal} from '../src/task-run-goal.ts'
import {registerTaskToolGuard} from '../src/task-tool-guard.ts'
import {observeTaskRun} from '../src/task-run-observation.ts'
import {readTaskRunGroupResult} from '../src/task-run-group-result.ts'
import {TaskRunGoalService,initializeTaskRunGoals} from '../../backend/src/work/task-run-goals.ts'
import {WorkAccess} from '../../backend/src/work/work-access.ts'
import {WorkLineageService} from '../../backend/src/work/work-lineage.ts'
import {createRunRoleSnapshot} from '../../backend/src/work/run-role-snapshot.ts'
import {setupRoleWork,roleFixture,insertRoleRun,identity} from '../../backend/tests/role-work-test-fixture.ts'
import {initializeWorkControl} from '../../backend/src/work/work-control.ts'
import {WorkBudgetService,initializeWorkBudgets} from '../../backend/src/work/work-budget.ts'

const anchor=createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json'),official=createRequire(anchor)
const toolNames=['get_goal','create_goal','update_goal']
function* tool(name:string,args:object,id:string):Generator<StreamChunk>{const argumentsText=JSON.stringify(args),callId=ToolCallId(id);yield {type:'block-start',index:0,blockType:'tool-call'};yield {type:'tool-call-delta',index:0,id:callId,name,argumentsDelta:argumentsText};yield {type:'block-end',index:0,block:{type:'tool-call',id:callId,name,arguments:argumentsText}};yield {type:'finish',reason:{kind:'tool-calls'}}}
function* text(value:string):Generator<StreamChunk>{yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text:value};yield {type:'block-end',index:0,block:{type:'text',text:value}};yield {type:'finish',reason:{kind:'stop'}}}

test('真实 PG 票据 + 官方工具/Goal Driver/Loop 连续两轮，首轮不结项、最终回传最后有效轮',{timeout:20000},async t=>{
 const db=await setupRoleWork();t.after(()=>db.close())
 const f=await patchedSessionFixture(t),goalModule=await import(pathToFileURL(official.resolve('@deepseek-ai/dsh-goal')).href),goalTools=await import(pathToFileURL(official.resolve('@deepseek-ai/dsh-tool-goal')).href)
 const root=await mkdtemp(join(tmpdir(),'teloa-goal-loop-durable-'));t.after(()=>rm(root,{recursive:true,force:true}));await f.ctx.plugin(f.persistencePackage.default,{root,compression:'none'})
 await f.ctx.plugin(goalModule.GoalService);await f.ctx.plugin(goalTools,{})
 const {agent}=await f.ctx.agents.create({sessionId:SessionId(randomUUID()),agentOptions:{provider:'test',model:'test'}}),goals=Reflect.get(f.ctx,'goals') as any
 const {owner,role,taskId,authorization}=await roleFixture(db.pool,'employee'),runId=await insertRoleRun(db.pool,owner,role.id,taskId),requestId=randomUUID()
 const client=await db.pool.connect();let lineage
 try{await client.query('begin');lineage=await new WorkLineageService(db.pool,identity).bindTask(client,owner,{taskId,source:{kind:'owner-task',taskId}});await client.query('commit')}finally{client.release()}
 await db.pool.query('update teloa_task_runs set session_id=$2,native_request_id=$3,input_text=$4,allowed_tools=$5 where id=$1',[runId,agent.id,requestId,JSON.stringify({schema:'teloa.task-run-input/v2',task:{id:taskId,version:1,title:'版本小结',goal:'核对材料',scope:'general'},role:createRunRoleSnapshot(role,authorization),lineage}),JSON.stringify(toolNames)])
 await initializeTaskRunGoals(db.pool)
 await initializeWorkControl(db.pool);await initializeWorkBudgets(db.pool)
 const budgets=new WorkBudgetService(db.pool,identity)
 const charged=new Set<string>(),confirmHold=deferred(),confirmEntered=deferred();let checkBeforeModel=false
 const service=new TaskRunGoalService(db.pool,identity,{hostGeneration:()=>1,inspectGoal:async()=>{const g=goals.get(agent);return g?{goalId:g.id,revision:g.revision,phase:g.phase,activation:g.activation,roundsStarted:g.roundsStarted,maxGoalRounds:g.maxGoalRounds}:null},admitRound:async(client,owner,{binding,round})=>{const modelRequestId=[binding.runId,binding.goalId,binding.revision,round].join(':');charged.add(modelRequestId);const r=await budgets.reserveInTransaction(client,owner,{budgetAccountId:lineage!.budgetAccountId,controlGeneration:binding.controlGeneration,modelRequestId,kind:'goal',tokens:0,rounds:1});return budgets.lease(owner,r)}})
 const wrapped=Object.create(service) as TaskRunGoalService
 wrapped.confirm=async(owner,input:any)=>{confirmEntered.resolve();await confirmHold.promise;return service.confirm(owner,input)}
 const input=createNativeWorkInput(f.ctx,new WorkAccess()),adapter=createTaskRunGoal(f.ctx,wrapped,owner,{nativeInput:input,hostGeneration:()=>1,foldGoal:goalModule.foldGoal})
 t.after(()=>{confirmHold.resolve();adapter.close();input.close()})
 registerTaskToolGuard(f.ctx,async id=>id===agent.id?{allowedTools:toolNames,nativeRequestId:requestId}:null,[],undefined,undefined,undefined,undefined,undefined,undefined,undefined,adapter.observationForSession)
 const driver=(await patchedNativePackage<any>(t,{packageName:'@deepseek-ai/dsh-goal-round-driver',compatBasename:'dsh-goal-round-driver-0.2.1-alpha.1-input-admission',packageAnchor:anchor})).namespace
 await f.ctx.plugin(driver,{requireInputAdmission:true,admitInput:adapter.admit})
 let calls=0,created=false,completed=false
 class Model extends LlmAdapter{
  override async resolveModel(provider:string,model:string){return {provider,id:model,name:model}}
  async *stream(_options:GenerateOptions):AsyncIterable<StreamChunk>{
   calls++;const goal=goals.get(agent)
   if(!created){created=true;yield* tool('create_goal',{objective:'核对长期目标',max_goal_rounds:3},'create-goal');return}
   if(goal?.roundsStarted===2&&!completed){completed=true;yield* tool('update_goal',{goal_id:goal.id,revision:goal.revision,action:'complete'},'complete-goal');return}
   if(goal?.roundsStarted>0){const state=await service.read(owner,{runId});assert.equal(state.continuations.filter(r=>r.state==='accepted').length,goal.roundsStarted);checkBeforeModel=true}
   yield* text(goal?.phase==='complete'?'最终经过核对的成果':goal?.roundsStarted===1?'继续取得材料':'首轮计划')
  }
 }
 f.ctx.llm.registerAdapter(['test'],new Model())
 const first=createUserMessage({source:{kind:'user',rpcId:requestId},content:[{type:'text',text:'完成这项长期目标'}]})
 await input.withNewInput(agent,first,{producer:'task-run',identity:runId},()=>agent.followup(first))
 await confirmEntered.promise
 const run={id:runId,sessionId:agent.id,nativeRequestId:requestId}
 const firstEvents=agent.session.snapshotEvents(),context=await adapter.observation(run,firstEvents)
 assert.equal(observeTaskRun(firstEvents,requestId,undefined,context).state,'active')
 assert.equal(calls,2,'未确认续轮不能开始下一次模型请求')
 confirmHold.resolve()
 await until(async()=>{const g=goals.get(agent);return g?.phase==='complete'&&agent.status==='idle'&&(await service.read(owner,{runId})).binding?.revision===g.revision})
 const stored=await service.read(owner,{runId}),events=agent.session.snapshotEvents(),final=await adapter.observation(run,events)
 assert.equal(stored.continuations.length,2);assert.ok(stored.continuations.every(r=>r.state==='accepted'));assert.equal(charged.size,2);assert.equal(checkBeforeModel,true)
 assert.equal((await budgets.read(owner,{budgetAccountId:lineage!.budgetAccountId})).usedRounds,2,'持久续轮额度按受理轮次计一次')
 assert.equal(observeTaskRun(events,requestId,undefined,final).state,'ended')
 assert.equal(readTaskRunGroupResult(events,requestId,undefined,final),'最终经过核对的成果')
 assert.equal(goals.get(agent).activation,'disarmed')
 assert.equal(await f.ctx.sessions.flush(agent.session),true)
 const durable=await f.ctx.sessionPersistence.open(agent.id,'read')
 try{const saved=await durable.read();for(const receipt of stored.continuations)assert.equal(saved.events[receipt.acceptedSeq!]?.type,'agent/inbox/spliced')}finally{await durable.close()}
})

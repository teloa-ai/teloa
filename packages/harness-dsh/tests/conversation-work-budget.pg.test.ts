import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {LlmAdapter,ToolCallId,createUserMessage,type GenerateOptions,type StreamChunk} from '@deepseek-ai/dsh-llm'
import {SessionId} from '@deepseek-ai/dsh-session'
import type {TaskRun} from '@teloa/backend'
import {setupRoleWork,identity,ownerAuthority} from '../../backend/tests/role-work-test-fixture.ts'
import {TaskService} from '../../backend/src/work/tasks.ts'
import {TaskRunService} from '../../backend/src/work/task-runs.ts'
import {ObjectConversationService} from '../../backend/src/work/object-conversations.ts'
import {ConversationWorkService,initializeConversationWork} from '../../backend/src/work/conversation-work.ts'
import {WorkBudgetService,initializeWorkBudgets} from '../../backend/src/work/work-budget.ts'
import {WorkControlService,initializeWorkControl} from '../../backend/src/work/work-control.ts'
import {initializeWorkRetries} from '../../backend/src/work/work-retries.ts'
import {WorkAccess} from '../../backend/src/work/work-access.ts'
import {registerConversationWorkTools,type ConversationWorkToolsPorts} from '../src/conversation-work-tools.ts'
import {createNativeWorkInput} from '../src/native-work-input.ts'
import {installResidentModelBudget} from '../src/resident-model-budget.ts'
import {readSessionEvents} from '../src/session-events.ts'
import {patchedSessionFixture} from './fixtures/native-final-session.ts'
import {loopWorkFixture} from './fixtures/native-loop-work-admission.ts'
import {until,deferred} from './fixtures/native-schedule-admission.ts'

for(const workTokenLimit of [undefined,6_000_000])test('原生交办'+(workTokenLimit?'明确6M':'省略仍2M')+'：批准前零Task/Run/预算，首次真实流先采用已批准额度',{timeout:60000},async t=>{
 const db=await setupRoleWork();t.after(db.close)
 await initializeConversationWork(db.pool);await initializeWorkControl(db.pool);await initializeWorkBudgets(db.pool);await initializeWorkRetries(db.pool)
 const f=await patchedSessionFixture(t),native=await loopWorkFixture(t,true),owner=randomUUID(),source=native.agent
 const {agent:worker}=await f.ctx.agents.create({sessionId:SessionId(randomUUID()),agentOptions:{provider:'new-work-budget',model:'synthetic',maxTokens:3_000_000}})
 source.session.append('turn/start',{turn:0} as never)
 source.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:workTokenLimit?'请交办通用核对，本次工作token上限600万；这是新的独立轮次。':'请交办通用核对，维持默认额度。'}]}),{surfaceOp:'append'})
 let approve=async()=> 'rejected',physicalRequests=0,run:TaskRun|undefined
 const reasons:string[]=[]
 native.ctx.provide('approval',{request:async(input:{reason:string})=>{reasons.push(input.reason);return approve()}})
 const requests=new ConversationWorkService(db.pool,identity.now,async()=>({ownerId:owner,sessionId:source.id,status:'ready',submitted:true})),tasks=new TaskService(db.pool,identity)
 const conversationId=randomUUID(),inspect=async()=>({id:conversationId,ownerId:owner,sessionId:worker.id,status:'ready'})
 const runs=new TaskRunService(db.pool,identity,inspect),budgets=new WorkBudgetService(db.pool,identity,ownerAuthority),controls=new WorkControlService(db.pool,identity),input=createNativeWorkInput(f.ctx,new WorkAccess())
 const close=installResidentModelBudget(f.ctx,{owner,pool:db.pool,identity,runs:async()=>runs,controls,budgets,resolveRun:async id=>run&&id===worker.id?runs.get(owner,{runId:run.id}):null,nativeInput:input,report:()=>{}})
 t.after(()=>{close();input.close()})
 class Model extends LlmAdapter{
  override async resolveModel(provider:string,model:string){return {provider,id:model,name:model}}
  async *stream(_options:GenerateOptions):AsyncIterable<StreamChunk>{
   physicalRequests++
   yield {type:'block-start',index:0,blockType:'text'}
   yield {type:'text-delta',index:0,text:'合成核对完成'}
   yield {type:'block-end',index:0,block:{type:'text',text:'合成核对完成'}}
   yield {type:'usage',usage:{inputTokens:7,outputTokens:3,totalTokens:10}}
   yield {type:'finish',reason:{kind:'stop'}}
  }
 }
 f.ctx.llm.registerAdapter(['new-work-budget'],new Model())
 const ports:ConversationWorkToolsPorts={owner,conversation:async id=>({ownerId:owner,sessionId:id,status:'ready'}),readTaskPolicy:async()=>null,isRoleConversation:async()=>false,context:async()=>null,freeze:async()=>null,scopes:async()=>['general'],roles:async()=>[],status:async()=>({}),stop:async()=>({}),facts:async()=>({}),data:async()=>({}),now:identity.now,
  dispatch:async(value,_signal,revalidate)=>{
   await revalidate?.();await requests.reserve(owner,value)
   const task=await tasks.createForConversation(owner,{sessionId:value.sessionId,requestId:value.requestId,executor:'general'})
   // 正规创建/绑定/准备；不在批准后调用 configure，也不写运行时业务数据。
   await new ObjectConversationService(db.pool,inspect,identity.now).change(owner,{requestId:randomUUID(),kind:'task',objectId:task.id,expectedObjectVersion:1,sessionId:worker.id,expectedLinkVersion:0,action:'link'})
   run=await runs.prepareOwner(owner,{requestId:randomUUID(),taskId:task.id,expectedTaskVersion:1,executor:task.executor,sessionId:worker.id,expectedLinkVersion:1},{agentPresetId:'default-agent'})
   assert.ok(run.lineage)
   assert.equal((await budgets.read(owner,{budgetAccountId:run.lineage.budgetAccountId})).policy.maxTokens,workTokenLimit??2_000_000,'prepare之前已经落定初始上限')
   await runs.claim(owner,{runId:run.id})
   const message=createUserMessage({source:{kind:'user',rpcId:randomUUID()},content:[{type:'text',text:run.inputText}]})
   await input.withNewInput(worker,message,{producer:'task-run',identity:run.id},()=>worker.followup(message))
   await until(()=>worker.status==='idle'&&worker.inbox.nextTurn.length===0)
   return {taskId:task.id,runId:run.id}
  },
 }
 registerConversationWorkTools(native.ctx,ports)
 const args={scope:'general',title:'合成预算验收',goal:'只核对本测试中的合成资料',executor:'general',...(workTokenLimit===undefined?{}:{workTokenLimit})}
 const call=()=>native.ctx.tools.execute({agent:source,name:'teloa_work_dispatch',arguments:args,callId:ToolCallId(randomUUID()),signal:AbortSignal.timeout(15000)})
 const empty=async()=>{for(const table of ['teloa_tasks','teloa_task_runs','teloa_work_budget_accounts','teloa_conversation_work_requests'])assert.equal((await db.pool.query('select count(*)::int n from '+table+' where owner_id=$1',[owner])).rows[0].n,0,table)}
 const rejected=await call();assert.equal(rejected.isError,true);assert.equal(reasons.length,1,JSON.stringify(rejected));await empty()
 approve=async()=> 'cancelled';assert.equal((await call()).isError,true);assert.equal(reasons.length,2);await empty()
 const entered=deferred(),release=deferred();approve=async()=>{entered.resolve();await release.promise;return 'allowed-once'}
 const pending=call();await entered.promise;await empty();assert.equal(physicalRequests,0)
 assert.match(reasons.at(-1)!,workTokenLimit?/6,000,000/:/2,000,000/);assert.match(reasons.at(-1)!,/本人累计总额度仍然约束/)
 release.resolve();const approved=await pending;assert.equal(approved.isError,false,JSON.stringify(approved))
 assert.ok(run?.lineage)
 const state=await budgets.read(owner,{budgetAccountId:run.lineage.budgetAccountId})
 assert.equal(state.version,1,'初始额度没有额外配置版本或改变活动lease')
 assert.equal((await budgets.readOwner(owner)).policy.maxTokens,8_000_000)
 const reservations=(await db.pool.query('select reserved_tokens,state from teloa_work_budget_reservations where owner_id=$1',[owner])).rows
 if(workTokenLimit){assert.equal(physicalRequests,1);assert.equal(reservations.length,1);assert.ok(reservations[0].reserved_tokens>2_000_000&&reservations[0].reserved_tokens<6_000_000);assert.equal(state.usedTokens,10)}
 else{assert.equal(physicalRequests,0);assert.deepEqual(reservations,[]);const end=[...readSessionEvents(worker.session)].reverse().find(event=>event.type==='turn/end');assert.equal(end?.type==='turn/end'&&end.data.reason.kind==='error'?end.data.reason.error.code:null,'teloa/budget-exhausted/tokens/work')}
})

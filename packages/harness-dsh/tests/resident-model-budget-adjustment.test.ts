import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {LlmAdapter,createUserMessage,type GenerateOptions,type StreamChunk} from '@deepseek-ai/dsh-llm'
import {SessionId} from '@deepseek-ai/dsh-session'
import {setupRoleWork,roleFixture,identity,ownerAuthority} from '../../backend/tests/role-work-test-fixture.ts'
import {TaskService} from '../../backend/src/work/tasks.ts'
import {TaskRunService} from '../../backend/src/work/task-runs.ts'
import {ObjectConversationService} from '../../backend/src/work/object-conversations.ts'
import {RoleLifecycleService,initializeRoleLifecycle} from '../../backend/src/work/role-lifecycle.ts'
import {WorkAccess} from '../../backend/src/work/work-access.ts'
import {WorkBudgetService,initializeWorkBudgets,defaultWorkBudgetPolicy} from '../../backend/src/work/work-budget.ts'
import {WorkControlService,initializeWorkControl} from '../../backend/src/work/work-control.ts'
import {initializeWorkRetries} from '../../backend/src/work/work-retries.ts'
import {createNativeWorkInput} from '../src/native-work-input.ts'
import {installResidentModelBudget} from '../src/resident-model-budget.ts'
import {readSessionEvents} from '../src/session-events.ts'
import {patchedSessionFixture} from './fixtures/native-final-session.ts'
import {deferred,until} from './fixtures/native-schedule-admission.ts'

let db:Awaited<ReturnType<typeof setupRoleWork>>
before(async()=>{db=await setupRoleWork();await initializeWorkControl(db.pool);await initializeWorkBudgets(db.pool);await initializeWorkRetries(db.pool);await initializeRoleLifecycle(db.pool)})
after(async()=>{await db?.close()})
const unlimited={...defaultWorkBudgetPolicy,maxTokens:null,maxGoalRounds:null,maxConcurrent:null,maxElapsedMs:null}
for(const action of ['raise','work-lower','owner-lower','mixed-lower','stop','restart','role-revoke','overspend'] as const)test('真实原生模型流中调整 '+action+'：纯放宽继续原调用，收紧/停止/撤权/超耗保持保护',{timeout:30000},async t=>{
 const f=await patchedSessionFixture(t),{owner,role}=await roleFixture(db.pool,'employee')
 await db.pool.query("update teloa_roles set state='active' where id=$1",[role.id])
 const task=await new TaskService(db.pool,identity).create(owner,{requestId:randomUUID(),fields:{title:'流中额度合成验收',goal:'仅处理测试合成资料',scope:'general'},assignee:{roleId:role.id,expectedVersion:role.version}})
 const {agent}=await f.ctx.agents.create({sessionId:SessionId(randomUUID()),agentOptions:{provider:'adjustment-test',model:'finite-output',maxTokens:32}}),conversationId=randomUUID(),inspect=async()=>({id:conversationId,ownerId:owner,sessionId:agent.id,status:'ready'})
 await new ObjectConversationService(db.pool,inspect,identity.now).change(owner,{requestId:randomUUID(),kind:'task',objectId:task.id,expectedObjectVersion:1,sessionId:agent.id,expectedLinkVersion:0,action:'link'})
 const runs=new TaskRunService(db.pool,identity,inspect),run=await runs.prepare(owner,{requestId:randomUUID(),taskId:task.id,expectedTaskVersion:1,roleId:role.id,expectedRoleVersion:role.version,sessionId:agent.id,expectedLinkVersion:1},undefined,undefined,undefined,async()=> 'default-agent')
 await runs.claim(owner,{runId:run.id});assert.ok(run.lineage)
 let generation=1,physicalRequests=0
 const budgets=new WorkBudgetService(db.pool,identity,ownerAuthority),controls=new WorkControlService(db.pool,identity,{ownerAuthority,hostGeneration:()=>generation}),input=createNativeWorkInput(f.ctx,new WorkAccess()),entered=deferred(),release=deferred()
 const close=installResidentModelBudget(f.ctx,{owner,pool:db.pool,identity,runs:async()=>runs,controls,budgets,resolveRun:async session=>session===agent.id?runs.get(owner,{runId:run.id}):null,nativeInput:input,report:()=>{}})
 t.after(()=>{release.resolve();close();input.close()})
 class Model extends LlmAdapter{
  override async resolveModel(provider:string,model:string){return {provider,id:model,name:model}}
  async *stream(_options:GenerateOptions):AsyncIterable<StreamChunk>{
   physicalRequests++;yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text:'前段'}
   entered.resolve();await release.promise
   yield {type:'text-delta',index:0,text:'后段'};yield {type:'block-end',index:0,block:{type:'text',text:'前段后段'}}
   yield {type:'usage',usage:{inputTokens:7,outputTokens:3,totalTokens:10}};yield {type:'finish',reason:{kind:'stop'}}
  }
 }
 f.ctx.llm.registerAdapter(['adjustment-test'],new Model())
 const message=createUserMessage({source:{kind:'user',rpcId:randomUUID()},content:[{type:'text',text:run.inputText}]})
 await input.withNewInput(agent,message,{producer:'task-run',identity:run.id},()=>agent.followup(message));await entered.promise
 const active=(await db.pool.query("select id,model_request_id,reserved_tokens,state from teloa_work_budget_reservations where owner_id=$1",[owner])).rows;assert.equal(active.length,1);assert.equal(active[0].state,'unknown');assert.equal(physicalRequests,1)
 const configure=async(target:'work'|'owner',policy:typeof defaultWorkBudgetPolicy)=>target==='work'?budgets.configure(owner,{requestId:randomUUID(),budgetAccountId:run.lineage!.budgetAccountId,expectedVersion:(await budgets.read(owner,{budgetAccountId:run.lineage!.budgetAccountId})).version,policy}):budgets.configureOwner(owner,{requestId:randomUUID(),expectedVersion:(await budgets.readOwner(owner)).version,policy})
 // 先从页面同一后端入口提额，保持正在派发的原生请求与预留。
 await configure('work',{...defaultWorkBudgetPolicy,maxTokens:6_000_000});await configure('owner',{...defaultWorkBudgetPolicy,maxTokens:12_000_000,maxConcurrent:8})
 await configure('work',unlimited);await configure('owner',unlimited);await configure('work',unlimited)
 assert.deepEqual((await db.pool.query('select id,model_request_id,reserved_tokens,state from teloa_work_budget_reservations where owner_id=$1',[owner])).rows,active,'提额不改原预留或制造新的模型调用')
 if(action==='work-lower')await configure('work',{...unlimited,maxTokens:1})
 else if(action==='owner-lower')await configure('owner',{...unlimited,maxTokens:1})
 else if(action==='mixed-lower')await configure('work',{...unlimited,maxRetries:2})
 else if(action==='stop'){const control=await controls.get(owner,{controlId:run.lineage.roundControlId});await controls.change(owner,{requestId:randomUUID(),controlId:control.id,expectedVersion:control.version,action:'stop',scope:'round',roundControlId:null})}
 else if(action==='restart'){generation=2;await controls.disarmForRestart(owner,{hostGeneration:generation})}
 else if(action==='role-revoke')await new RoleLifecycleService(db.pool,identity).change(owner,{roleId:role.id,expectedVersion:role.version,action:'pause',reason:'本人撤回本次岗位执行'})
 else if(action==='overspend'){const peer=await budgets.reserve(owner,{budgetAccountId:run.lineage.budgetAccountId,controlGeneration:1,modelRequestId:randomUUID(),kind:'goal',tokens:1,rounds:0});await budgets.markDispatched(owner,{reservationId:peer.id});await budgets.settle(owner,{reservationId:peer.id,modelRequestId:peer.modelRequestId,providerRequestId:null,tokens:2,moneyMinorUnits:null,currency:null,receiptId:randomUUID()})}
 release.resolve();await until(()=>agent.status==='idle'&&agent.inbox.nextTurn.length===0)
 const events=readSessionEvents(agent.session),end=[...events].reverse().find(event=>event.type==='turn/end'),text=events.filter(event=>event.type==='assistant/message').flatMap(event=>event.type==='assistant/message'?event.data.message.content.filter(block=>block.type==='text').map(block=>block.text):[]).join('')
 assert.equal(physicalRequests,1,'同Run/session不得为了预算调整重发模型调用')
 assert.equal((await db.pool.query('select count(*)::int n from teloa_task_runs where owner_id=$1',[owner])).rows[0].n,1)
 assert.equal((await runs.get(owner,{runId:run.id})).sessionId,agent.id)
 if(action==='raise'){
  assert.equal(end?.type==='turn/end'?end.data.reason.kind:null,'completed');assert.match(text,/前段后段/)
  assert.equal((await budgets.read(owner,{budgetAccountId:run.lineage.budgetAccountId})).usedTokens,10)
  assert.equal((await budgets.readOwner(owner)).usedTokens,10)
  assert.equal((await db.pool.query('select count(*)::int n from teloa_work_retry_claims where owner_id=$1',[owner])).rows[0].n,1)
 }else{assert.equal(end?.type==='turn/end'?end.data.reason.kind:null,'error');assert.doesNotMatch(text,/后段/)}
})

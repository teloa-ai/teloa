import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {LlmAdapter,createUserMessage,type GenerateOptions,type StreamChunk} from '@deepseek-ai/dsh-llm'
import {SessionId} from '@deepseek-ai/dsh-session'
import {patchedSessionFixture} from './fixtures/native-final-session.ts'
import {until} from './fixtures/native-schedule-admission.ts'
import {setupRoleWork,roleFixture,identity,ownerAuthority} from '../../backend/tests/role-work-test-fixture.ts'
import {ObjectConversationService} from '../../backend/src/work/object-conversations.ts'
import {TaskRunService} from '../../backend/src/work/task-runs.ts'
import {TaskService} from '../../backend/src/work/tasks.ts'
import {WorkAccess} from '../../backend/src/work/work-access.ts'
import {WorkControlService,initializeWorkControl} from '../../backend/src/work/work-control.ts'
import {WorkBudgetService,initializeWorkBudgets,defaultWorkBudgetPolicy} from '../../backend/src/work/work-budget.ts'
import {initializeWorkRetries} from '../../backend/src/work/work-retries.ts'
import {createNativeWorkInput} from '../src/native-work-input.ts'
import {installResidentModelBudget} from '../src/resident-model-budget.ts'

test('真实原生模型流按实际用量结算；累计额度耗尽在下次请求前拒绝',{timeout:30000},async t=>{
 const db=await setupRoleWork();t.after(db.close)
 await initializeWorkControl(db.pool);await initializeWorkBudgets(db.pool);await initializeWorkRetries(db.pool)
 const f=await patchedSessionFixture(t),{agent}=await f.ctx.agents.create({sessionId:SessionId(randomUUID()),agentOptions:{provider:'budget',model:'finite',maxTokens:32}})
 const {owner,role}=await roleFixture(db.pool,'employee')
 await db.pool.query("update teloa_roles set state='active' where id=$1",[role.id])
 const task=await new TaskService(db.pool,identity).create(owner,{requestId:randomUUID(),fields:{title:'用量核对',goal:'核对资料',scope:'general'},assignee:{roleId:role.id,expectedVersion:role.version}}),taskId=task.id
 const conversationId=randomUUID(),inspect=async()=>({id:conversationId,ownerId:owner,sessionId:agent.id,status:'ready'})
 await new ObjectConversationService(db.pool,inspect,identity.now).change(owner,{requestId:randomUUID(),kind:'task',objectId:taskId,expectedObjectVersion:1,sessionId:agent.id,expectedLinkVersion:0,action:'link'})
 const runs=new TaskRunService(db.pool,identity,inspect),run=await runs.prepare(owner,{requestId:randomUUID(),taskId,expectedTaskVersion:1,roleId:role.id,expectedRoleVersion:role.version,sessionId:agent.id,expectedLinkVersion:1},undefined,undefined,undefined,async()=> 'default-agent')
 await runs.claim(owner,{runId:run.id})
 assert.ok(run.lineage)
 const controls=new WorkControlService(db.pool,identity),budgets=new WorkBudgetService(db.pool,identity,ownerAuthority),input=createNativeWorkInput(f.ctx,new WorkAccess())
 const reports:string[]=[],close=installResidentModelBudget(f.ctx,{owner,pool:db.pool,identity,runs:async()=>runs,controls,budgets,resolveRun:async id=>id===agent.id?await runs.get(owner,{runId:run.id}):null,nativeInput:input,report:code=>reports.push(code)})
 t.after(()=>{close();input.close()})
 let physicalRequests=0,missingUsage=false
 class Model extends LlmAdapter{
  override async resolveModel(provider:string,model:string){return {provider,id:model,name:model}}
  async *stream(_options:GenerateOptions):AsyncIterable<StreamChunk>{
   physicalRequests++
   yield {type:'block-start',index:0,blockType:'text'}
   yield {type:'text-delta',index:0,text:'核对完成'}
   yield {type:'block-end',index:0,block:{type:'text',text:'核对完成'}}
   if(!missingUsage)yield {type:'usage',usage:{inputTokens:7,outputTokens:3,cacheReadTokens:7,totalTokens:17}}
   yield {type:'finish',reason:{kind:'stop'}}
  }
 }
 f.ctx.llm.registerAdapter(['budget'],new Model())
 async function send(text:string){
  const message=createUserMessage({source:{kind:'user',rpcId:randomUUID()},content:[{type:'text',text}]})
  await input.withNewInput(agent,message,{producer:'task-run',identity:run.id},()=>agent.followup(message))
  await until(()=>agent.status==='idle'&&agent.inbox.nextTurn.length===0)
 }
 await send(run.inputText)
 assert.equal(physicalRequests,1)
 const first=await budgets.read(owner,{budgetAccountId:run.lineage.budgetAccountId})
 assert.equal(first.usedTokens,17);assert.equal(first.concurrent,0)
 const receipts=(await db.pool.query('select state,actual_tokens,provider,provider_request_id from teloa_work_budget_reservations where owner_id=$1',[owner])).rows
 assert.deepEqual(receipts,[{state:'settled',actual_tokens:17,provider:'budget',provider_request_id:null}])
 await budgets.configure(owner,{requestId:randomUUID(),budgetAccountId:run.lineage.budgetAccountId,expectedVersion:first.version,policy:{...defaultWorkBudgetPolicy,maxTokens:17}})
 await send('在同一任务中继续')
 assert.equal(physicalRequests,1,'累计额度不足不能先发模型请求再补计数')
 assert.equal((await budgets.read(owner,{budgetAccountId:run.lineage.budgetAccountId})).usedTokens,17)
 assert.equal((await db.pool.query('select count(*)::int count from teloa_work_retries where owner_id=$1',[owner])).rows[0].count,2)
 const limited=await budgets.read(owner,{budgetAccountId:run.lineage.budgetAccountId})
 await budgets.configure(owner,{requestId:randomUUID(),budgetAccountId:run.lineage.budgetAccountId,expectedVersion:limited.version,policy:{...defaultWorkBudgetPolicy,maxConcurrent:1}})
 missingUsage=true
 await send('核对没有用量回包的情况')
 assert.equal(physicalRequests,2)
 const unknown=await budgets.read(owner,{budgetAccountId:run.lineage.budgetAccountId})
 assert.equal(unknown.concurrent,1);assert.ok(unknown.usedTokens>17,'用量未知保留原预留，不虚构零费用')
 await send('原回执未知时继续')
 assert.equal(physicalRequests,2,'结果未知的预留没有核对前不能通过并发上限再派发')
 const before=(await budgets.readOwner(owner)).usedTokens,tasksBefore=(await db.pool.query('select count(*)::int count from teloa_tasks where owner_id=$1',[owner])).rows[0].count
 const {agent:routingAgent}=await f.ctx.agents.create({sessionId:SessionId(randomUUID()),agentOptions:{provider:'budget',model:'finite',maxTokens:32}})
 const routingClose=installResidentModelBudget(f.ctx,{owner,pool:db.pool,identity,runs:async()=>runs,controls,budgets,resolveRun:async()=>null,resolveRouting:async id=>id===routingAgent.id?{budgetAccountId:null,controlGeneration:1,operationId:'persisted-owner-message',lease:{assertCurrent(){}}}:null,nativeInput:input,report:code=>reports.push(code)})
 t.after(routingClose);missingUsage=false
 const routeMessage=createUserMessage({source:{kind:'user',rpcId:randomUUID()},content:[{type:'text',text:'选择已授权同事'}]})
 await input.withNewInput(routingAgent,routeMessage,{producer:'prompt',identity:'persisted-owner-message'},()=>routingAgent.followup(routeMessage))
 await until(()=>routingAgent.status==='idle'&&routingAgent.inbox.nextTurn.length===0)
 assert.equal(physicalRequests,3);assert.equal((await budgets.readOwner(owner)).usedTokens,before+17)
 assert.equal((await db.pool.query('select count(*)::int count from teloa_tasks where owner_id=$1',[owner])).rows[0].count,tasksBefore,'本人路由额度不制造业务任务')
 assert.equal((await db.pool.query("select count(*)::int count from teloa_work_budget_reservations where owner_id=$1 and kind='routing' and state='settled'",[owner])).rows[0].count,1)
})

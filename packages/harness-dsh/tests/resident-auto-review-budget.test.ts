import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {ToolCallId,type StreamChunk} from '@deepseek-ai/dsh-llm'
import {setupRoleWork,roleFixture,identity,ownerAuthority} from '../../backend/tests/role-work-test-fixture.ts'
import {ObjectConversationService} from '../../backend/src/work/object-conversations.ts'
import {TaskRunService} from '../../backend/src/work/task-runs.ts'
import {TaskService} from '../../backend/src/work/tasks.ts'
import {WorkControlService,initializeWorkControl} from '../../backend/src/work/work-control.ts'
import {WorkBudgetService,initializeWorkBudgets,defaultWorkBudgetPolicy} from '../../backend/src/work/work-budget.ts'
import {WorkRetryService,initializeWorkRetries} from '../../backend/src/work/work-retries.ts'
import {installResidentModelBudget} from '../src/resident-model-budget.ts'
import {autoReviewCausalityFixture,isReviewRequest} from './fixtures/native-auto-review-causality.ts'

const usage:StreamChunk={type:'usage',usage:{inputTokens:7,outputTokens:3,totalTokens:10}}
const text=(value:string):readonly StreamChunk[]=>[{type:'block-start',index:0,blockType:'text'},{type:'text-delta',index:0,text:value},{type:'block-end',index:0,block:{type:'text',text:value}},usage,{type:'finish',reason:{kind:'stop'}}]
const calls:readonly StreamChunk[]=[...['first-query','second-query'].flatMap((id,index):StreamChunk[]=>[
 {type:'block-start',index,blockType:'tool-call'},
 {type:'tool-call-delta',index,id:ToolCallId(id),name:'hot_result',argumentsDelta:'{}'},
 {type:'block-end',index,block:{type:'tool-call',id:ToolCallId(id),name:'hot_result',arguments:'{}'}},
]),usage,{type:'finish',reason:{kind:'tool-calls'}}]

for(const exhausted of [false,true])test(`真实PG审核预算：${exhausted?'额度不足阻止审核派发和工具':'同一步两次审核独立记账且已结算操作不重放'}`,{timeout:60000},async t=>{
 const db=await setupRoleWork();t.after(db.close)
 await initializeWorkControl(db.pool);await initializeWorkBudgets(db.pool);await initializeWorkRetries(db.pool)
 const f=await autoReviewCausalityFixture(t),{agent}=f,{owner,role}=await roleFixture(db.pool,'employee')
 await db.pool.query("update teloa_roles set state='active' where id=$1",[role.id])
 const task=await new TaskService(db.pool,identity).create(owner,{requestId:randomUUID(),fields:{title:'审核额度验收',goal:'完成本机确定性工具调用',scope:'general'},assignee:{roleId:role.id,expectedVersion:role.version}})
 const conversationId=randomUUID(),inspect=async()=>({id:conversationId,ownerId:owner,sessionId:agent.id,status:'ready'})
 await new ObjectConversationService(db.pool,inspect,identity.now).change(owner,{requestId:randomUUID(),kind:'task',objectId:task.id,expectedObjectVersion:1,sessionId:agent.id,expectedLinkVersion:0,action:'link'})
 const runs=new TaskRunService(db.pool,identity,inspect),run=await runs.prepare(owner,{requestId:randomUUID(),taskId:task.id,expectedTaskVersion:1,roleId:role.id,expectedRoleVersion:role.version,sessionId:agent.id,expectedLinkVersion:1},undefined,undefined,undefined,async()=> 'default-agent')
 await runs.claim(owner,{runId:run.id})
 const controls=new WorkControlService(db.pool,identity),budgets=new WorkBudgetService(db.pool,identity,ownerAuthority)
 const close=installResidentModelBudget(f.ctx,{owner,pool:db.pool,identity,runs:async()=>runs,controls,budgets,resolveRun:async id=>id===agent.id?await runs.get(owner,{runId:run.id}):null,nativeInput:f.work,report:()=>{}});t.after(close)
 if(exhausted)f.ctx.on('llm/stream',async function*(request,next){
  if(isReviewRequest(request)){
   const current=await budgets.readOwner(owner)
   await budgets.configureOwner(owner,{requestId:randomUUID(),expectedVersion:current.version,policy:{...defaultWorkBudgetPolicy,maxTokens:1}})
  }
  yield* next()
 },{prepend:true})
 f.adapter.scripts.push(calls,text('{"risk":"low","decision":"allow"}'),text('{"risk":"low","decision":"allow"}'),text('完成'))
 await f.send(run.nativeRequestId);await agent.whenIdle()
 const reviews=f.adapter.requests.filter(isReviewRequest)
 if(exhausted){assert.equal(reviews.length,0);assert.equal(f.counters.tools,0);return}
 assert.equal(reviews.length,2);assert.equal(f.counters.tools,2)
 const rows=(await db.pool.query('select operation_id,attempts,completed from teloa_work_retries where owner_id=$1',[owner])).rows
 assert.equal(rows.length,4,'两次主请求及同一步两个工具的审核请求各自登记')
 assert.equal(new Set(rows.map(row=>row.operation_id)).size,4)
 assert.ok(rows.every(row=>row.attempts===1&&row.completed===true))
 assert.equal((await db.pool.query("select count(*)::int count from teloa_work_budget_reservations where owner_id=$1 and kind='retry' and state='settled'",[owner])).rows[0].count,4)
 const retries=new WorkRetryService(db.pool,identity,{controls})
 for(const row of rows)assert.equal((await retries.claim(owner,{operationId:row.operation_id,requestId:randomUUID(),expectedGeneration:1})).dispatch,false)
 assert.equal(f.adapter.requests.length,4)
})

import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import type {WorkBudgetPolicy} from '@teloa/contract'
import {Pool,stopTestContainer} from './postgres-test-lifecycle.ts'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {RoleService,initializeRoles} from '../src/work/roles.ts'
import {TaskService,initializeTasks} from '../src/work/tasks.ts'
import {ConversationWorkService,initializeConversationWork,workRequestChildId} from '../src/work/conversation-work.ts'
import {BusinessDataService,initializeBusinessData} from '../src/work/business-data.ts'
import {BusinessTaskService,initializeBusinessTasks} from '../src/work/business-tasks.ts'
import {WorkBudgetService,initializeWorkBudgets,defaultWorkBudgetPolicy} from '../src/work/work-budget.ts'
import {WorkLineageService} from '../src/work/work-lineage.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'
let container:StartedPostgreSqlContainer,pool:Pool,locks:Pool
const identity={id:randomUUID,now:()=>new Date().toISOString()}
before(async()=>{container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri(),max:1,connectionTimeoutMillis:1000,statement_timeout:4000});locks=new Pool({connectionString:container.getConnectionUri(),max:1});await initializeRoles(pool);await initializeTasks(pool);await initializeConversationWork(pool);await initializeBusinessData(pool);await initializeBusinessTasks(pool);await initializeWorkBudgets(pool)})
after(async()=>{await locks?.end();await pool?.end();await stopTestContainer(container)})
async function fixture(object=false,workTokenLimit?:number|null,reserve=true,workBudgetPolicy?:WorkBudgetPolicy){
 const owner=randomUUID(),sessionId='origin-'+randomUUID(),role=await new RoleService(pool,identity).create(owner,{requestId:randomUUID(),fields:{name:'固定同事',kind:'employee',scopes:['SOC'],duty:'调查',dataScope:'资料',executionScope:'只读',skills:[],knowledge:[],responsibility:testRoleResponsibility}})
 const sourceText='原始指令：保留  空格与\n换行',request={requestId:randomUUID(),sessionId,messageId:'original',messageSeq:1,kind:'task' as const,...(workTokenLimit===undefined?{}:{workTokenLimit}),...(workBudgetPolicy===undefined?{}:{workBudgetPolicy}),scope:'SOC',title:'固定目标',goal:'检查业务原件',sourceText,roleId:role.id,expectedRoleVersion:role.version}
 let reference:undefined|{scope:string;type:string;id:string;version:number;snapshotHash:string}
 if(object){const snapshot={scope:'SOC',type:'alert',id:'object',version:1,title:'固定记录',source:'fixture',observedAt:identity.now(),receivedAt:identity.now(),quality:'complete' as const,summary:'原摘要',fields:[]},page=await new BusinessDataService(pool,{id:'test',scopes:['SOC'],query:async()=>({schema:'teloa.data-source-page/v1',sourceId:'test',scope:'SOC',capturedAt:identity.now(),items:[snapshot]})}).query({ownerId:owner,scopeIds:['SOC']},{scope:'SOC',limit:10}),item=page.items[0]!;reference={scope:item.scope,type:item.type,id:item.id,version:item.version,snapshotHash:item.snapshotHash}}
 const service=new ConversationWorkService(pool,identity.now,async()=>({ownerId:owner,sessionId,status:'ready',submitted:false}),undefined,undefined,locks)
 if(reserve)await service.reserve(owner,{...request,...(reference?{reference}:{})})
 const tasks=new TaskService(pool,identity),business=new BusinessTaskService(pool,identity,tasks),parent={sessionId,requestId:request.requestId,roleId:role.id},child=workRequestChildId(request.requestId,'task',role.id),goal=request.goal+'\n\n本人原指令（保留原始引用，不改变员工权限）：\n'+sourceText,input={requestId:child,fields:{title:request.title,goal,scope:'SOC'},assignee:{roleId:role.id,expectedVersion:role.version}},actor={ownerId:owner,scopeIds:['SOC']}
 return {owner,service,tasks,business,parent,request,role,child,goal,input,reference,actor}
}

test('R3 固定父身份从原spec创建，普通同字节create/request在无任务和有回执时均拒绝；max1',async()=>{
 const f=await fixture()
 for(const saved of [false,true]){
  if(saved)await f.tasks.createForConversation(f.owner,f.parent)
  await assert.rejects(f.tasks.create(f.owner,f.input),{code:'teloa/conflict'})
  await assert.rejects(f.tasks.request(f.owner,{requestId:f.child}),{code:'teloa/conflict'})
 }
 const task=await f.tasks.requestForConversation(f.owner,f.parent)
 assert.ok(task);assert.equal(task.goal,f.goal);assert.equal(task.title,f.request.title);assert.equal(task.assigneeRoleId,f.role.id)
 assert.equal((await pool.query('select count(*)::int n from teloa_tasks where owner_id=$1',[f.owner])).rows[0].n,1)
 const edited=await f.tasks.edit(f.owner,{taskId:task.id,expectedVersion:1,fields:{title:'本人修订后的标题',goal:'本人修订目标'}})
 assert.deepEqual(await f.tasks.requestForConversation(f.owner,f.parent),edited,'核原request_spec，不能把合法当前编辑当原指纹漂移')
 await f.service.stop(f.owner,{sessionId:f.parent.sessionId,requestId:f.parent.requestId})
 assert.deepEqual(await f.tasks.createForConversation(f.owner,f.parent),edited,'成功回执优先于stopped')
 assert.ok((await f.tasks.list(f.owner,{})).some(item=>item.id===task.id),'按task.id/目录的本人读取保持')
 assert.equal(pool.waitingCount,0)
})

test('R3 内部父身份拒绝错本人/会话/同事/未知字段，原任务指纹不同不充当成功',async()=>{
 const f=await fixture()
 await assert.rejects(f.tasks.createForConversation(randomUUID(),f.parent),{code:'teloa/conflict'})
 await assert.rejects(f.tasks.createForConversation(f.owner,{...f.parent,sessionId:'other'}),{code:'teloa/forbidden'})
 await assert.rejects(f.tasks.createForConversation(f.owner,{...f.parent,roleId:randomUUID()}),{code:'teloa/conflict'})
 await assert.rejects(f.tasks.createForConversation(f.owner,{...f.parent,fields:f.input.fields}),{code:'teloa/invalid-input'})
 const task=await f.tasks.createForConversation(f.owner,f.parent),original=(await pool.query('select request_spec from teloa_tasks where id=$1',[task.id])).rows[0].request_spec
 await pool.query('update teloa_tasks set request_spec=jsonb_set(request_spec,\'{fields,goal}\',\'"另一请求"\') where id=$1',[task.id])
 try{await assert.rejects(f.tasks.requestForConversation(f.owner,f.parent),{code:'teloa/conflict'});await assert.rejects(f.tasks.createForConversation(f.owner,f.parent),{code:'teloa/conflict'})}finally{await pool.query('update teloa_tasks set request_spec=$2 where id=$1',[task.id,original])}
 assert.equal(pool.waitingCount,0)
})

test('R3 对象交办复用真实固定快照与来源，同请求恢复；普通来源入口和非对象内部口不能冒用',async()=>{
 const f=await fixture(true),input={requestId:f.child,reference:f.reference,title:f.request.title,goal:f.goal,assignee:f.input.assignee}
 assert.equal(await f.business.requestForConversation(f.actor,f.parent),null)
 await assert.rejects(f.tasks.createForConversation(f.owner,f.parent),{code:'teloa/conflict'})
 await assert.rejects(f.tasks.requestForConversation(f.owner,f.parent),{code:'teloa/conflict'})
 await assert.rejects(f.business.create(f.actor,input),{code:'teloa/conflict'})
 const created=await f.business.createForConversation(f.actor,f.parent)
 assert.deepEqual(created.source.reference,f.reference);assert.equal(created.task.goal,f.goal)
 assert.deepEqual(await f.business.requestForConversation(f.actor,f.parent),created.task)
 await assert.rejects(f.business.create(f.actor,input),{code:'teloa/conflict'})
 await assert.rejects(f.business.requestForConversation({...f.actor,scopeIds:['AppSec']},f.parent),{code:'teloa/forbidden'})
 await f.service.stop(f.owner,{sessionId:f.parent.sessionId,requestId:f.parent.requestId})
 assert.deepEqual(await f.business.createForConversation(f.actor,f.parent),created)
 const original=(await pool.query('select request_spec from teloa_business_task_sources where task_id=$1',[created.task.id])).rows[0].request_spec
 await pool.query('update teloa_business_task_sources set request_spec=jsonb_set(request_spec,\'{reference,id}\',\'"other"\') where task_id=$1',[created.task.id])
 try{await assert.rejects(f.business.requestForConversation(f.actor,f.parent),{code:'teloa/conflict'});await assert.rejects(f.business.createForConversation(f.actor,f.parent),{code:'teloa/conflict'})}finally{await pool.query('update teloa_business_task_sources set request_spec=$2 where task_id=$1',[created.task.id,original])}
 assert.equal((await pool.query('select count(*)::int n from teloa_business_task_sources where owner_id=$1',[f.owner])).rows[0].n,1)
 assert.equal(pool.waitingCount,0)
})

for(const object of [false,true])test('R3 '+(object?'对象':'普通')+'内部创建真实提交后失回包，父身份读取与重试找回唯一Task',async()=>{
 const f=await fixture(object,6_000_000)
 let lose=true
 const transport={connect:async()=>{const db=await pool.connect();return {query:async(sql:string,values?:unknown[])=>{const result=await db.query(sql,values);if(sql==='commit'&&lose){lose=false;throw Error('controlled lost response after commit')}return result},release:()=>db.release()}}} as unknown as Pool
 const tasks=new TaskService(transport,identity),business=new BusinessTaskService(transport,identity,tasks)
 await assert.rejects(object?business.createForConversation(f.actor,f.parent):tasks.createForConversation(f.owner,f.parent),/controlled lost response/)
 const receipt=object?await f.business.requestForConversation(f.actor,f.parent):await f.tasks.requestForConversation(f.owner,f.parent)
 assert.ok(receipt)
 const retry=object?(await f.business.createForConversation(f.actor,f.parent)).task:await f.tasks.createForConversation(f.owner,f.parent)
 assert.deepEqual(retry,receipt)
 const lineage=await new WorkLineageService(pool,identity).read(f.owner,{taskId:retry.id});assert.ok(lineage)
 assert.equal((await new WorkBudgetService(pool,identity).read(f.owner,{budgetAccountId:lineage.budgetAccountId})).policy.maxTokens,6_000_000)
 assert.equal((await pool.query('select count(*)::int n from teloa_work_budget_accounts where owner_id=$1',[f.owner])).rows[0].n,1)
 assert.equal((await pool.query('select count(*)::int n from teloa_tasks where owner_id=$1',[f.owner])).rows[0].n,1)
 assert.equal((await pool.query('select count(*)::int n from teloa_business_task_sources where owner_id=$1',[f.owner])).rows[0].n,object?1:0)
 assert.equal(pool.waitingCount,0)
})


for(const object of [false,true])test('批准的'+(object?'固定对象':'员工')+'交办在新Task同事务落定6M；首预留已采用新上限，旧默认仍2M',async()=>{
 const f=await fixture(object,6_000_000),budgets=new WorkBudgetService(pool,identity),lineages=new WorkLineageService(pool,identity)
 assert.equal((await pool.query('select count(*)::int n from teloa_work_budget_accounts where owner_id=$1',[f.owner])).rows[0].n,0,'只预约父请求尚未创建工作账户')
 const task=object?(await f.business.createForConversation(f.actor,f.parent)).task:await f.tasks.createForConversation(f.owner,f.parent),lineage=await lineages.read(f.owner,{taskId:task.id})
 assert.ok(lineage)
 const state=await budgets.read(f.owner,{budgetAccountId:lineage.budgetAccountId})
 assert.deepEqual(state.policy,{...defaultWorkBudgetPolicy,maxTokens:6_000_000});assert.equal(state.version,1)
 const reserved=await budgets.reserve(f.owner,{budgetAccountId:lineage.budgetAccountId,controlGeneration:1,modelRequestId:randomUUID(),kind:'goal',tokens:3_000_000,rounds:0})
 await budgets.releaseUnaccepted(f.owner,{reservationId:reserved.id})
 assert.equal((await budgets.readOwner(f.owner)).policy.maxTokens,8_000_000,'本人总额不随单工作提额')
 const ordinary=await fixture(),normal=await ordinary.tasks.createForConversation(ordinary.owner,ordinary.parent),baseline=await lineages.read(ordinary.owner,{taskId:normal.id});assert.ok(baseline)
 assert.deepEqual((await budgets.read(ordinary.owner,{budgetAccountId:baseline.budgetAccountId})).policy,defaultWorkBudgetPolicy)
 await assert.rejects(budgets.reserve(ordinary.owner,{budgetAccountId:baseline.budgetAccountId,controlGeneration:1,modelRequestId:randomUUID(),kind:'goal',tokens:3_000_000,rounds:0}),{code:'teloa/budget-exhausted',details:{reason:'tokens',scope:'work'}})
 await assert.rejects(f.tasks.create(f.owner,{...f.input,workTokenLimit:6_000_000}),{code:'teloa/invalid-input'})
 await assert.rejects(f.tasks.createForConversation(f.owner,{...f.parent,workTokenLimit:7_000_000}),{code:'teloa/invalid-input'})
})

test('6M父请求幂等绑定额度，重放不重建/不重置后续3M和累计用量；同对象新请求独立账户仍共享8M',async()=>{
 const f=await fixture(true,6_000_000),input={...f.request,reference:f.reference},budgets=new WorkBudgetService(pool,identity,{authorize:async()=>({assertCurrent(){}})}),lineages=new WorkLineageService(pool,identity)
 const [a,b]=await Promise.all([f.business.createForConversation(f.actor,f.parent),f.business.createForConversation(f.actor,f.parent)])
 assert.deepEqual(a,b);const lineage=await lineages.read(f.owner,{taskId:a.task.id});assert.ok(lineage)
 for(const workTokenLimit of [7_000_000,undefined])await assert.rejects(f.service.reserve(f.owner,{...input,workTokenLimit}),{code:'teloa/conflict'})
 const reserve=await budgets.reserve(f.owner,{budgetAccountId:lineage.budgetAccountId,controlGeneration:1,modelRequestId:randomUUID(),kind:'goal',tokens:740_458,rounds:0})
 await budgets.markDispatched(f.owner,{reservationId:reserve.id});await budgets.settle(f.owner,{reservationId:reserve.id,modelRequestId:reserve.modelRequestId,providerRequestId:null,tokens:740_458,moneyMinorUnits:null,currency:null,receiptId:randomUUID()})
 await budgets.configure(f.owner,{requestId:randomUUID(),budgetAccountId:lineage.budgetAccountId,expectedVersion:1,policy:{...defaultWorkBudgetPolicy,maxTokens:3_000_000}})
 assert.equal((await f.service.reserve(f.owner,input)).workTokenLimit,6_000_000)
 assert.deepEqual((await f.business.createForConversation(f.actor,f.parent)).task,a.task)
 const after=await budgets.read(f.owner,{budgetAccountId:lineage.budgetAccountId});assert.equal(after.policy.maxTokens,3_000_000);assert.equal(after.version,2);assert.equal(after.usedTokens,740_458)
 const next={...input,requestId:randomUUID(),messageId:'new-independent-round',messageSeq:2};await f.service.reserve(f.owner,next)
 const task=(await f.business.createForConversation(f.actor,{...f.parent,requestId:next.requestId})).task,second=await lineages.read(f.owner,{taskId:task.id});assert.ok(second);assert.notEqual(second.budgetAccountId,lineage.budgetAccountId)
 assert.equal((await budgets.read(f.owner,{budgetAccountId:second.budgetAccountId})).policy.maxTokens,6_000_000)
 const reserved=await budgets.reserve(f.owner,{budgetAccountId:second.budgetAccountId,controlGeneration:1,modelRequestId:randomUUID(),kind:'goal',tokens:6_000_000,rounds:0})
 await assert.rejects(budgets.reserveOwnerRouting(f.owner,{modelRequestId:randomUUID(),tokens:1_300_000}),{code:'teloa/budget-exhausted',details:{reason:'tokens',scope:'owner'}})
 await budgets.releaseUnaccepted(f.owner,{reservationId:reserved.id})
 assert.equal((await budgets.readOwner(f.owner)).usedTokens,740_458)
 assert.equal((await pool.query('select count(*)::int n from teloa_work_budget_accounts where owner_id=$1',[f.owner])).rows[0].n,2)
})

test('初始6M预算与新Task创建失败一起回滚；非法额度与汇报注入在任何写入前拒绝',async()=>{
 const f=await fixture(false,6_000_000);let ids=0
 const broken=new TaskService(pool,{...identity,id:()=>{if(++ids===3)throw Error('controlled failure after budget insert');return randomUUID()}})
 await assert.rejects(broken.createForConversation(f.owner,f.parent),/controlled failure after budget insert/)
 for(const table of ['teloa_tasks','teloa_work_budget_accounts','teloa_work_controls'])assert.equal((await pool.query('select count(*)::int n from '+table+' where owner_id=$1',[f.owner])).rows[0].n,0,table)
 for(const workTokenLimit of [0,-1,1.5,Number.MAX_SAFE_INTEGER+1,'6000000'])await assert.rejects(f.service.reserve(f.owner,{...f.request,requestId:randomUUID(),workTokenLimit}),{code:'teloa/invalid-input'})
 await assert.rejects(f.service.reserve(f.owner,{...f.request,requestId:randomUUID(),kind:'report',roleId:undefined,expectedRoleVersion:undefined}),{code:'teloa/invalid-input'})
 assert.equal((await pool.query('select count(*)::int n from teloa_conversation_work_requests where owner_id=$1',[f.owner])).rows[0].n,1)
 await f.tasks.createForConversation(f.owner,f.parent)
})


test('并发同父请求不同额度只允许一份原批准意图，失败方不能覆盖成功方初始账户',async()=>{
 const f=await fixture(false,undefined,false),concurrent=new Pool({connectionString:container.getConnectionUri(),max:3,statement_timeout:4000})
 try{
  const service=new ConversationWorkService(concurrent,identity.now,async()=>({ownerId:f.owner,sessionId:f.parent.sessionId,status:'ready',submitted:true}),undefined,undefined,locks)
  const results=await Promise.allSettled([6_000_000,7_000_000].map(workTokenLimit=>service.reserve(f.owner,{...f.request,workTokenLimit})))
  const succeeded=results.filter((result):result is PromiseFulfilledResult<Awaited<ReturnType<typeof service.reserve>>>=>result.status==='fulfilled'),failed=results.filter((result):result is PromiseRejectedResult=>result.status==='rejected')
  assert.equal(succeeded.length,1);assert.equal(failed.length,1);assert.equal(failed[0]!.reason.code,'teloa/conflict')
  const accepted=succeeded[0]!.value.workTokenLimit;assert.ok(accepted)
  const task=await f.tasks.createForConversation(f.owner,f.parent),lineage=await new WorkLineageService(pool,identity).read(f.owner,{taskId:task.id});assert.ok(lineage)
  assert.equal((await new WorkBudgetService(pool,identity).read(f.owner,{budgetAccountId:lineage.budgetAccountId})).policy.maxTokens,accepted)
  assert.equal((await pool.query('select count(*)::int n from teloa_work_budget_accounts where owner_id=$1',[f.owner])).rows[0].n,1)
 }finally{await concurrent.end()}
})


for(const object of [false,true])test('完整'+(object?'固定对象':'员工')+'新工作额度或显式token不限从父spec原子创建，互斥/变参拒绝且本人有限总额仍适用',async()=>{
 const policies:WorkBudgetPolicy[]=[{maxTokens:6_000_000,maxGoalRounds:12,maxConcurrent:2,maxElapsedMs:120_000,maxRetries:0,stagnationRounds:4,money:null},{...defaultWorkBudgetPolicy,maxTokens:null,maxGoalRounds:null,maxConcurrent:null,maxElapsedMs:null}]
 for(const policy of policies){
  const f=await fixture(object,undefined,true,policy),input={...f.request,...(f.reference?{reference:f.reference}:{})}
  assert.deepEqual((await f.service.reserve(f.owner,input)).workBudgetPolicy,policy)
  await assert.rejects(f.service.reserve(f.owner,{...input,workTokenLimit:null}),{code:'teloa/invalid-input'})
  await assert.rejects(f.service.reserve(f.owner,{...input,workBudgetPolicy:{...policy,maxRetries:policy.maxRetries+1}}),{code:'teloa/conflict'})
  const task=object?(await f.business.createForConversation(f.actor,f.parent)).task:await f.tasks.createForConversation(f.owner,f.parent),lineage=await new WorkLineageService(pool,identity).read(f.owner,{taskId:task.id});assert.ok(lineage)
  const budgets=new WorkBudgetService(pool,identity);assert.deepEqual((await budgets.read(f.owner,{budgetAccountId:lineage.budgetAccountId})).policy,policy)
  await assert.rejects(budgets.reserve(f.owner,{budgetAccountId:lineage.budgetAccountId,controlGeneration:1,modelRequestId:randomUUID(),kind:'goal',tokens:9_000_000,rounds:0}),{code:'teloa/budget-exhausted'})
 }
 const f=await fixture(object,null),task=object?(await f.business.createForConversation(f.actor,f.parent)).task:await f.tasks.createForConversation(f.owner,f.parent),lineage=await new WorkLineageService(pool,identity).read(f.owner,{taskId:task.id});assert.ok(lineage)
 assert.deepEqual((await new WorkBudgetService(pool,identity).read(f.owner,{budgetAccountId:lineage.budgetAccountId})).policy,{...defaultWorkBudgetPolicy,maxTokens:null})
 assert.equal((await f.service.get(f.owner,{sessionId:f.parent.sessionId,requestId:f.request.requestId}))!.workTokenLimit,null)
})

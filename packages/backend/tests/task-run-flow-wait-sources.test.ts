import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {ReferenceCatalog} from '@teloa/mcp-reference/catalog'
import {database,fixture,identity,command,decision} from './security-action-fixture.ts'
import {ownerAuthority} from './role-work-test-fixture.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'
import {ResourceService} from '../src/capabilities/resources.ts'
import {initializeResources} from '../src/capabilities/schema.ts'
import {RoleService} from '../src/work/roles.ts'
import {BusinessTaskService} from '../src/work/business-tasks.ts'
import {initializePlans} from '../src/work/plans.ts'
import {initializeObjectConversations,ObjectConversationService} from '../src/work/object-conversations.ts'
import {initializeTaskRuns,TaskRunService} from '../src/work/task-runs.ts'
import {TaskRunFlowService,type TaskRunFlowPorts} from '../src/work/task-run-flows.ts'
import {WorkControlService,initializeWorkControl} from '../src/work/work-control.ts'
import {WorkBudgetService,initializeWorkBudgets} from '../src/work/work-budget.ts'
import {combineWorkAccessLeases} from '../src/work/work-access.ts'

let db:Awaited<ReturnType<typeof database>>,folder:string,catalog:ReferenceCatalog
const body='只供真实 Run 固定输入使用的合成材料正文，不应出现在等待来源目录。'
before(async()=>{
 db=await database()
 for(const init of [initializeResources,initializeObjectConversations,initializeTaskRuns,initializeWorkControl,initializeWorkBudgets,initializePlans])await init(db.pool)
 folder=await mkdtemp(join(tmpdir(),'teloa-flow-sources-'));await writeFile(join(folder,'note.md'),body)
 catalog=new ReferenceCatalog(folder,[{id:'flow-note',title:'等待来源合成材料',file:'note.md'}])
},{timeout:180000})
after(async()=>{await db?.close();if(folder)await rm(folder,{recursive:true,force:true})})

async function runFixture(){
 const f=await fixture(db.pool),owner=f.principal.ownerId,resources=new ResourceService(db.pool,catalog,identity)
 const material=async(ownerId:string,scope:string,title:string)=>{
  const actor={ownerId,kind:'human' as const,scopeIds:[scope]},source=(await catalog.list()).references[0]!
  const draft=await resources.create(actor,{requestId:randomUUID(),title,sourceId:source.id,sourceVersion:source.version,scopeIds:[scope]})
  return resources.apply(actor,{draftId:draft.id,expectedVersion:1})
 }
 const selected=await material(owner,'SOC','原 Run 已选资料')
 const role=await new RoleService(db.pool,identity).create(owner,{requestId:randomUUID(),fields:{name:'等待核对员工',kind:'employee',scopes:['SOC'],duty:'核对原事件',dataScope:'本人已选资料',executionScope:'原有授权内核对',skills:[],knowledge:[selected.id],responsibility:testRoleResponsibility,runtimeConfig:{agentPresetId:'worker'}}})
 // 沿用 checkpoint 夹具的初始在岗/分配设置；后续 Run、审批、Flow 和资源均走真实服务。
 await db.pool.query("update teloa_roles set state='active' where id=$1",[role.id])
 await db.pool.query("update teloa_tasks set state='ready',assignee_role_id=$3,assignee_role_version=1 where owner_id=$1 and id=$2",[owner,f.task.id,role.id])
 const sessionId=randomUUID(),conversationId=randomUUID(),inspect=async()=>({id:conversationId,sessionId,ownerId:owner,status:'ready'})
 await new ObjectConversationService(db.pool,inspect,identity.now).change(owner,{requestId:randomUUID(),kind:'task',objectId:f.task.id,expectedObjectVersion:1,sessionId,expectedLinkVersion:0,action:'link'})
 const runs=new TaskRunService(db.pool,identity,inspect)
 const run=await runs.prepare(owner,{requestId:randomUUID(),taskId:f.task.id,expectedTaskVersion:1,roleId:role.id,expectedRoleVersion:1,sessionId,expectedLinkVersion:1},undefined,(_target,current,client)=>resources.executionKnowledgeInTransaction(client,{ownerId:owner,kind:'human',scopeIds:['SOC']},['SOC'],current.knowledge))
 await runs.claim(owner,{runId:run.id});await runs.record(owner,{runId:run.id,sessionId,nativeRequestId:run.nativeRequestId,evidence:{state:'accepted'}})
 const controls=new WorkControlService(db.pool,identity),budgets=new WorkBudgetService(db.pool,identity),calls={admit:0,confirm:0,verify:0}
 const ports:TaskRunFlowPorts={
  authority:{authorize:async()=>{calls.confirm++;return ownerAuthority.authorize()}},
  admit:async(client,value,runId)=>{
   calls.admit++
   return combineWorkAccessLeases([await runs.executionAdmissionInTransaction(client,value,runId),(await controls.acquireForRun(value,{runId,mode:'new-input'},client)).lease,await budgets.admissionInTransaction(client,value,run.lineage!.budgetAccountId)])
  },
  verifiedSource:async()=>{calls.verify++;throw Error('目录查询和来源绑定不能制造或消费执行事件')},
 }
 const flows=new TaskRunFlowService(db.pool,identity,ports)
 const propose=async(title:string,taskId:string=f.task.id)=>{
  const task=(await f.tasks.list(owner,{})).find(task=>task.id===taskId)
  assert.ok(task,'测试操作必须来自本人已存在的任务')
  return f.actions.propose(f.principal,{...f.proposal,requestId:randomUUID(),taskId,expectedTaskVersion:task.version,title})
 }
 const pending=async(title:string)=>f.actions.submit(f.principal,command(await propose(title)))
 const definition=(sourceId:string,kind:'approval-result'|'material-version'='approval-result')=>({requestId:randomUUID(),runId:run.id,definitionVersion:1,steps:[
  {id:'wait',title:'核对所选来源',kind:kind==='approval-result'?'human_checkpoint':'wait_external',dependsOn:[],inputSummary:'只等本次原来源的真实回执'},
  {id:'after',title:'来源就绪后核对',kind:'work',dependsOn:['wait'],inputSummary:'在原有授权范围内继续'},
 ],waitBindings:[{stepId:'wait',sourceKind:kind,sourceId}]})
 const writes=async()=>(await db.pool.query(`select
  (select count(*)::int from teloa_task_run_flows where owner_id=$1) flows,
  (select count(*)::int from teloa_task_run_flow_waits where owner_id=$1) waits,
  (select count(*)::int from teloa_task_run_flow_receipts where owner_id=$1) receipts,
  (select count(*)::int from teloa_security_approvals where owner_id=$1) approvals,
  (select count(*)::int from teloa_security_action_requests where owner_id=$1) action_requests`,[owner])).rows[0]
 return {...f,owner,resources,material,selected,role,run,runs,flows,ports,calls,propose,pending,definition,writes}
}

test('真实 PG：等待目录仅含原 Run 资料与本人同任务候选，查询不确认、不绑定、不消费事件',async()=>{
 const f=await runFixture(),unselected=await f.material(f.owner,'SOC','未选入本 Run 的本人资料'),outside=await f.material(f.owner,'AppSec','另一业务资料')
 const proposed=await f.propose('尚待提交的原任务操作'),pending=await f.pending('尚待本人批准的原任务操作'),approved=await f.pending('已批准的原任务操作')
 await f.approvals.decide(f.principal,decision(approved))
 const rejected=await f.pending('本人已拒绝的操作');await f.approvals.decide(f.principal,{...decision(rejected),decision:'rejected',impactConfirmed:false})
 const withdrawn=await f.pending('本人已撤回的操作');await f.actions.withdrawSubmission(f.principal,command(withdrawn))
 const otherTask=(await new BusinessTaskService(db.pool,identity,f.tasks).create(f.principal,{requestId:randomUUID(),reference:f.source.reference,goal:'另一项独立核对任务'})).task
 const otherAction=await f.propose('同本人但另一个任务的私有操作',otherTask.id)
 const foreign=await fixture(db.pool),foreignAction=await foreign.actions.propose(foreign.principal,foreign.proposal)
 const before=await f.writes(),calls={...f.calls},run=await f.runs.get(f.owner,{runId:f.run.id})
 const directory=await f.flows.waitSources(f.owner,{runId:f.run.id})
 assert.deepEqual(directory.materials,[{id:f.selected.id,title:f.selected.title}])
 assert.deepEqual(directory.approvals.map(row=>row.id).sort(),[proposed.id,pending.id,approved.id].sort())
 assert.deepEqual(directory.bindings,[])
 for(const row of directory.approvals)assert.deepEqual(Object.keys(row).sort(),['id','title'])
 const serialized=JSON.stringify(directory)
 for(const hidden of [body,unselected.id,outside.id,rejected.id,withdrawn.id,otherAction.id,foreignAction.id])assert.ok(!serialized.includes(hidden))
 const again=await f.flows.waitSources(f.owner,{runId:f.run.id})
 assert.deepEqual(again.materials,directory.materials);assert.deepEqual(again.bindings,directory.bindings)
 assert.deepEqual(again.approvals.map(row=>row.id).sort(),directory.approvals.map(row=>row.id).sort())
 assert.deepEqual(await f.writes(),before);assert.deepEqual(f.calls,calls)
 assert.deepEqual(await f.runs.get(f.owner,{runId:f.run.id}),run,'查询不扩大原 Run 的工具、资料或执行状态')
 await assert.rejects(f.flows.waitSources(foreign.principal.ownerId,{runId:f.run.id}),{code:'teloa/forbidden'})
 await assert.rejects(f.flows.waitSources(f.owner,{runId:randomUUID()}),{code:'teloa/forbidden'})
 for(const input of [{runId:f.run.id,ownerId:foreign.principal.ownerId},{runId:f.run.id,cursor:'unadvertised'},{runId:f.run.id,limit:1},{runId:'bad-id'}])await assert.rejects(f.flows.waitSources(f.owner,input),{code:'teloa/invalid-input'})
 assert.deepEqual(await f.writes(),before);assert.deepEqual(f.calls,calls)
})

test('真实 PG：候选不是批准凭据，过期批准及其他任务/他人的来源不能创建 Flow',async t=>{
 const f=await runFixture(),pending=await f.pending('固定有效期的批准'),approval=await f.approvals.decide(f.principal,decision(pending))
 const late=new TaskRunFlowService(db.pool,{id:randomUUID,now:()=> '2026-09-13T01:16:00.000Z'},f.ports)
 const before=await f.writes(),calls={...f.calls},directory=await late.waitSources(f.owner,{runId:f.run.id})
 t.diagnostic(JSON.stringify({expiredApprovalStillListed:directory.approvals.some(row=>row.id===pending.id),directoryIsNotExecutionAuthority:true}))
 assert.deepEqual(await f.writes(),before);assert.deepEqual(f.calls,calls)
 await assert.rejects(late.createConfirmed(f.owner,f.definition(pending.id)),{code:'teloa/forbidden'})
 assert.deepEqual(await f.writes(),before);assert.equal(await f.flows.get(f.owner,{runId:f.run.id}),null)
 const otherTask=(await new BusinessTaskService(db.pool,identity,f.tasks).create(f.principal,{requestId:randomUUID(),reference:f.source.reference,goal:'另一项审批来源'})).task
 const other=await f.propose('其他任务的操作',otherTask.id),foreign=await fixture(db.pool),foreignAction=await foreign.actions.propose(foreign.principal,foreign.proposal)
 const unchanged=await f.writes()
 for(const sourceId of [other.id,foreignAction.id])await assert.rejects(f.flows.createConfirmed(f.owner,f.definition(sourceId)),{code:'teloa/forbidden'})
 assert.deepEqual(await f.writes(),unchanged)
 const valid=await f.flows.createConfirmed(f.owner,f.definition(pending.id))
 assert.equal(valid.state,'active');assert.equal(valid.steps[0]?.state,'ready','选择有效批准只绑定等待来源，不冒充步骤已经完成')
 assert.deepEqual((await f.flows.waitSources(f.owner,{runId:f.run.id})).bindings,[{stepId:'wait',version:1,sourceKind:'approval-result',sourceId:pending.id}])
 const stored=(await db.pool.query('select record_digest,expires_at from teloa_security_approvals where id=$1',[approval.id])).rows[0]
 assert.equal(stored.expires_at.toISOString(),'2026-09-13T01:15:00.000Z','选择或查询不延长批准有效期')
 assert.equal((await f.writes()).approvals,unchanged.approvals);assert.equal(f.calls.verify,0)
})

test('真实 PG：材料只能来自 Run 已固定选择，越界和撤回后不能借候选目录恢复授权',async t=>{
 const f=await runFixture(),unselected=await f.material(f.owner,'SOC','本人未授权给本 Run 的资料'),outside=await f.material(f.owner,'AppSec','其他业务资料'),foreign=await f.material(randomUUID(),'SOC','他人资料')
 const before=await f.writes()
 for(const sourceId of [unselected.id,outside.id,foreign.id])await assert.rejects(f.flows.createConfirmed(f.owner,f.definition(sourceId,'material-version')),{code:'teloa/forbidden'})
 assert.deepEqual(await f.writes(),before);assert.equal(await f.flows.get(f.owner,{runId:f.run.id}),null)
 const actor={ownerId:f.owner,kind:'human' as const,scopeIds:['SOC']}
 await f.resources.withdraw(actor,{resourceId:f.selected.id,expectedVersion:f.selected.version})
 const calls={...f.calls},directory=await f.flows.waitSources(f.owner,{runId:f.run.id})
 t.diagnostic(JSON.stringify({withdrawnMaterialStillListed:directory.materials.some((row:{id:string})=>row.id===f.selected.id),frozenDirectoryIsNotNewGrant:true}))
 assert.deepEqual(f.calls,calls);assert.deepEqual(await f.writes(),before)
 await assert.rejects(f.flows.createConfirmed(f.owner,f.definition(f.selected.id,'material-version')),{code:'teloa/forbidden'})
 assert.deepEqual(await f.writes(),before);assert.equal(await f.flows.get(f.owner,{runId:f.run.id}),null)
 assert.equal((await f.resources.getResource(actor,{resourceId:f.selected.id})).status,'withdrawn')
})

test('真实 PG：等待来源重绑只显示每一步最新版本，查询不推进等待或接受旧绑定版本',async()=>{
 const f=await runFixture(),first=await f.pending('第一次等待的原操作'),flow=await f.flows.createConfirmed(f.owner,f.definition(first.id))
 await f.flows.transition(f.owner,{requestId:randomUUID(),flowId:flow.flowId,stepId:'wait',action:'start',expectedAttempts:0})
 await f.flows.transition(f.owner,{requestId:randomUUID(),flowId:flow.flowId,stepId:'wait',action:'wait',expectedAttempts:1,waitReason:'等待本人核对原操作'})
 const next=await f.pending('本人重新选择的原操作'),rebind={requestId:randomUUID(),runId:f.run.id,flowId:flow.flowId,stepId:'wait',expectedAttempts:1,expectedBindingVersion:1,sourceKind:'approval-result',sourceId:next.id}
 await f.flows.rebindWaitConfirmed(f.owner,rebind)
 const before=await f.writes(),calls={...f.calls},fixed=await f.flows.get(f.owner,{runId:f.run.id})
 assert.deepEqual((await f.flows.waitSources(f.owner,{runId:f.run.id})).bindings,[{stepId:'wait',version:2,sourceKind:'approval-result',sourceId:next.id}])
 assert.deepEqual(await f.flows.get(f.owner,{runId:f.run.id}),fixed);assert.equal(fixed?.steps[0]?.state,'waiting')
 assert.deepEqual(await f.writes(),before);assert.deepEqual(f.calls,calls)
 await assert.rejects(f.flows.rebindWaitConfirmed(f.owner,{...rebind,requestId:randomUUID(),sourceId:first.id}),{code:'teloa/version-conflict'})
 assert.deepEqual(await f.writes(),before)
 assert.deepEqual((await f.flows.waitSources(f.owner,{runId:f.run.id})).bindings,[{stepId:'wait',version:2,sourceKind:'approval-result',sourceId:next.id}])
})

import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {database,fixture,identity,command,decision} from './security-action-fixture.ts'
import {ownerAuthority} from './role-work-test-fixture.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'
import {RoleService} from '../src/work/roles.ts'
import {initializePlans} from '../src/work/plans.ts'
import {initializeObjectConversations,ObjectConversationService} from '../src/work/object-conversations.ts'
import {initializeTaskRuns,TaskRunService} from '../src/work/task-runs.ts'
import {TaskRunFlowService} from '../src/work/task-run-flows.ts'
import {WorkControlService,initializeWorkControl} from '../src/work/work-control.ts'
import {WorkBudgetService,initializeWorkBudgets} from '../src/work/work-budget.ts'
import {WorkEventService,initializeWorkEvents} from '../src/work/work-events.ts'
import {combineWorkAccessLeases} from '../src/work/work-access.ts'
import {TaskRunFlowDriver} from '../../harness-dsh/src/task-run-flow-driver.ts'
let db:Awaited<ReturnType<typeof database>>
before(async()=>{db=await database();await initializeObjectConversations(db.pool);await initializeTaskRuns(db.pool);await initializeWorkControl(db.pool);await initializeWorkBudgets(db.pool);await initializePlans(db.pool);await initializeWorkEvents(db.pool)},{timeout:180000})
after(async()=>{await db?.close()})
test('真实审批 checkpoint 固定原操作和世代；旧许可拒绝，明确重新绑定后仅新收据推进',async()=>{
 const f=await fixture(db.pool),owner=f.principal.ownerId,roles=new RoleService(db.pool,identity),role=await roles.create(owner,{requestId:randomUUID(),fields:{name:'事件核对同事',kind:'employee',scopes:['SOC'],duty:'核对原事件',dataScope:'本人事件',executionScope:'已有授权',skills:[],knowledge:[],responsibility:testRoleResponsibility,runtimeConfig:{agentPresetId:'worker'}}})
 // 隔离夹具的负责人绑定；随后所有 Run、Flow、审批、事件和预算都调用真实服务。
 await db.pool.query("update teloa_roles set state='active' where id=$1",[role.id]);await db.pool.query("update teloa_tasks set state='ready',assignee_role_id=$3,assignee_role_version=1 where owner_id=$1 and id=$2",[owner,f.task.id,role.id])
 const sessionId=randomUUID(),conversationId=randomUUID(),inspect=async()=>({id:conversationId,sessionId,ownerId:owner,status:'ready'})
 await new ObjectConversationService(db.pool,inspect,identity.now).change(owner,{requestId:randomUUID(),kind:'task',objectId:f.task.id,expectedObjectVersion:1,sessionId,expectedLinkVersion:0,action:'link'})
 const runs=new TaskRunService(db.pool,identity,inspect),run=await runs.prepare(owner,{requestId:randomUUID(),taskId:f.task.id,expectedTaskVersion:1,roleId:role.id,expectedRoleVersion:1,sessionId,expectedLinkVersion:1})
 await runs.claim(owner,{runId:run.id});await runs.record(owner,{runId:run.id,sessionId,nativeRequestId:run.nativeRequestId,evidence:{state:'accepted'}})
 let now=identity.now(),blocked=false;const clock={id:randomUUID,now:()=>now},controls=new WorkControlService(db.pool,clock),budgets=new WorkBudgetService(db.pool,clock),events=new WorkEventService(db.pool,clock,{material:async()=>{throw Error('本用例没有资料来源')},approval:async(client,_owner,actionId,expectedActionVersion)=>{await f.approvals.readForExecution(client,f.principal,{actionId,expectedActionVersion})}})
 const flows=new TaskRunFlowService(db.pool,clock,{authority:ownerAuthority,admit:async(client,value,runId)=>{assert.equal(blocked,false,'已提交回执不得重新授予');const role=await runs.executionAdmissionInTransaction(client,value,runId),control=await controls.acquireForRun(value,{runId,mode:'new-input'},client),budget=await budgets.admissionInTransaction(client,value,run.lineage!.budgetAccountId);return combineWorkAccessLeases([role,control.lease,budget])},verifiedSource:(client,value,eventId)=>events.verifiedSourceInTransaction(client,value,eventId)})
 const pending=await f.actions.submit(f.principal,command(await f.actions.propose(f.principal,{...f.proposal,expectedTaskVersion:2}))),create={requestId:randomUUID(),runId:run.id,definitionVersion:1,steps:[{id:'review',title:'本人核对原操作',kind:'human_checkpoint',dependsOn:[],inputSummary:'核对本轮真实审批'},{id:'after',title:'审批后核对',kind:'work',dependsOn:['review'],inputSummary:'只核对已审批原件'}],waitBindings:[{stepId:'review',sourceKind:'approval-result',sourceId:pending.id}]},flow=await flows.createConfirmed(owner,create)
 await flows.transition(owner,{requestId:randomUUID(),flowId:flow.flowId,stepId:'review',action:'start',expectedAttempts:0});await flows.transition(owner,{requestId:randomUUID(),flowId:flow.flowId,stepId:'review',action:'wait',expectedAttempts:1,waitReason:'等本人审批'})
 const wait={runId:run.id,flowId:flow.flowId,stepId:'review',expectedAttempts:1};assert.equal(await flows.readWait(owner,wait),null)
 await assert.rejects(flows.transition(owner,{requestId:randomUUID(),flowId:flow.flowId,stepId:'review',expectedAttempts:1,action:'resume'}),{code:'teloa/forbidden'});await assert.rejects(flows.transition(owner,{requestId:randomUUID(),flowId:flow.flowId,stepId:'review',expectedAttempts:1,action:'succeed',outputSummary:'模型称已核对'}),{code:'teloa/forbidden'})
 const approval=await f.approvals.decide(f.principal,decision(pending));const append=async(actionId:string,approvalId:string)=>{const client=await db.pool.connect();try{await client.query('begin');const result=await events.appendSource(client,{kind:'approval-result',sourceId:actionId,receiptId:approvalId});await client.query('commit');return result}finally{client.release()}}
 const event=await append(pending.id,approval.id);assert.equal((await flows.readWait(owner,wait))?.eventId,event.id)
 now='2026-09-13T01:01:00.000Z';await db.pool.query('update teloa_work_controls set generation=generation+1,version=version+1 where owner_id=$1 and id=$2',[owner,run.lineage!.roundControlId]);assert.equal(await flows.readWait(owner,wait),null)
 const fresh=await f.actions.submit(f.principal,command(await f.actions.propose(f.principal,{...f.proposal,requestId:randomUUID(),expectedTaskVersion:2})))
 const rebind={requestId:randomUUID(),...wait,expectedBindingVersion:1,sourceKind:'approval-result',sourceId:fresh.id};await flows.rebindWaitConfirmed(owner,rebind);assert.deepEqual(await flows.rebindWaitConfirmed(owner,rebind),await flows.get(owner,{runId:run.id}));assert.equal(await flows.readWait(owner,wait),null)
 const approved=await f.approvals.decide(f.principal,decision(fresh)),newEvent=await append(fresh.id,approved.id);assert.equal((await flows.readWait(owner,wait))?.eventId,newEvent.id)
 let modelStarts=0;const driver=new TaskRunFlowDriver(flows,{admit:async()=>{const client=await db.pool.connect();try{await client.query('begin');const lease=await flows.ports!.admit(client,owner,run.id);lease.assertCurrent();await client.query('commit')}finally{client.release()}},start:async()=>{modelStarts++},read:async()=>({state:'unknown',summary:null})}),result=(await driver.tick(owner,run.id,new AbortController().signal))!;assert.equal(modelStarts,0,'等待核验不请求模型');assert.equal(result.steps[0]!.state,'succeeded');assert.equal(result.steps[0]!.outputSummary,'原操作的本人审批已核验')
 const proof=(await db.pool.query("select request_spec from teloa_task_run_flow_receipts where owner_id=$1 and flow_id=$2 and request_spec->>'action'='succeed'",[owner,flow.flowId])).rows[0].request_spec,complete={requestId:proof.requestId,flowId:flow.flowId,stepId:'review',expectedAttempts:1,eventId:newEvent.id}
 blocked=true;assert.deepEqual(await flows.completeWait(owner,complete),result);assert.deepEqual(await flows.createConfirmed(owner,create),result);await assert.rejects(flows.completeWait(owner,{...complete,eventId:event.id}),{code:'teloa/conflict'})
 blocked=false;now='2026-09-13T02:00:00.000Z';const client=await db.pool.connect();try{await assert.rejects(events.verifiedSourceInTransaction(client,owner,newEvent.id),{code:'teloa/forbidden'})}finally{client.release()}
})

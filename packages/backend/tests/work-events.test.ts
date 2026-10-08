import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {ReferenceCatalog} from '@teloa/mcp-reference/catalog'
import {setupRoleWork,identity,ownerAuthority} from './role-work-test-fixture.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'
import {ResourceService} from '../src/capabilities/resources.ts'
import {RoleService} from '../src/work/roles.ts'
import {RoleLifecycleService,initializeRoleLifecycle} from '../src/work/role-lifecycle.ts'
import {RoleToolGrantService,initializeRoleToolGrants} from '../src/work/role-tool-grants.ts'
import {RoleDelegationService,initializeRoleDelegations} from '../src/work/role-delegations.ts'
import {initializeTwinExecutionConsents} from '../src/work/twin-execution-consents.ts'
import {PlanService,initializePlans} from '../src/work/plans.ts'
import {PlanOccurrenceService,initializePlanOccurrences} from '../src/work/plan-occurrences.ts'
import {initializeWorkBudgets,WorkBudgetService} from '../src/work/work-budget.ts'
import {initializeWorkControl} from '../src/work/work-control.ts'
import {WorkEventService,initializeWorkEvents} from '../src/work/work-events.ts'
import {WorkProgressService,initializeWorkProgress} from '../src/work/work-progress.ts'
import {collectLocalMaterialEvents} from '../../harness-dsh/src/local-material-events.ts'
import {TaskService} from '../src/work/tasks.ts'
import {TaskRunService} from '../src/work/task-runs.ts'
import {TaskRunFlowService} from '../src/work/task-run-flows.ts'
import {ObjectConversationService} from '../src/work/object-conversations.ts'
import {WorkControlService} from '../src/work/work-control.ts'
let env:Awaited<ReturnType<typeof setupRoleWork>>,dir:string
before(async()=>{env=await setupRoleWork();dir=await mkdtemp(join(tmpdir(),'teloa-events-'));await initializeRoleLifecycle(env.pool);await initializeRoleToolGrants(env.pool);await initializeRoleDelegations(env.pool);await initializeTwinExecutionConsents(env.pool);await initializePlans(env.pool);await initializePlanOccurrences(env.pool);await initializeWorkBudgets(env.pool);await initializeWorkEvents(env.pool);await initializeWorkProgress(env.pool)},{timeout:180000})
after(async()=>{await env?.close();if(dir)await rm(dir,{recursive:true,force:true})})
async function fixture(schedule=false){
 const owner=randomUUID(),folder=join(dir,owner);await import('node:fs/promises').then(fs=>fs.mkdir(folder));await writeFile(join(folder,'note.md'),'# 本机材料\n第一版有效原件。')
 const catalog=new ReferenceCatalog(folder,[{id:"note",title:"本机材料",file:"note.md"}]),source=(await catalog.list()).references[0]!,actor={ownerId:owner,kind:'human' as const,scopeIds:['general']},resources=new ResourceService(env.pool,catalog,identity),draft=await resources.create(actor,{requestId:randomUUID(),title:'本机材料',sourceId:source.id,sourceVersion:source.version,scopeIds:['general']}),resource=await resources.apply(actor,{draftId:draft.id,expectedVersion:1})
 const roles=new RoleService(env.pool,identity);let role=await roles.create(owner,{requestId:randomUUID(),fields:{name:'材料同事',kind:'employee',scopes:['general'],duty:'版本小结',dataScope:'当前原件',executionScope:'只读',skills:[],knowledge:[resource.id],responsibility:testRoleResponsibility,runtimeConfig:{agentPresetId:'worker'}}})
 const lifecycle=new RoleLifecycleService(env.pool,identity);role=(await lifecycle.change(owner,{roleId:role.id,expectedVersion:role.version,action:'pause',reason:'配置授权工具'})).role
 const tools=new RoleToolGrantService(env.pool,identity.now,async(_db,_owner,_role,rules)=>{assert.deepEqual(rules.map(r=>r.name),['read_reference'])});const grant=await tools.change(owner,{roleId:role.id,expectedRoleVersion:role.version,action:'save',rules:[{name:'read_reference',allowed:[{id:source.id,version:source.version}]}]})
 role=(await lifecycle.change(owner,{roleId:role.id,expectedVersion:grant.roleVersion,action:'resume',reason:'工具已确认'})).role
 const delegation=await new RoleDelegationService(env.pool,identity,ownerAuthority).change(owner,{requestId:randomUUID(),roleId:role.id,expectedRoleVersion:role.version,expectedVersion:null,action:'save',fields:{scope:'general',allowedTools:['read_reference'],knowledgeIds:[resource.id],memoryViewId:null,groupIds:[],safeRecovery:false}})
 let now='2026-10-09T00:00:00.000Z';const clock={id:randomUUID,now:()=>now},plans=new PlanService(env.pool,clock,undefined,ownerAuthority),fields={title:'本机资料版本跟进',goal:'核对版本',scope:'general',roleId:role.id,expectedRoleVersion:role.version,dataScope:'当前本机原件',delivery:'版本小结',notificationPolicy:'attention',trigger:{kind:'schedule',cadence:'daily',weekday:1,time:'09:00',timezone:'Asia/Singapore'}}
 const old=await plans.create(owner,{requestId:randomUUID(),fields,source:{kind:'manual'}}),configuration={completion:{kind:'manual'},triggers:schedule?[{kind:'schedule',schedule:fields.trigger}]:[{kind:'local-event',eventKind:'material-version',sourceId:resource.id,coalesce:'latest'}],budget:{maxGoalRounds:32,maxTokens:2000,maxElapsedMs:600000,maxConcurrent:1,maxRetries:3,stagnationRounds:3,money:null},overlap:'forbid',missed:'coalesce',safeRecovery:false}
 const command={requestId:randomUUID(),planId:old.id,expectedVersion:old.version,expectedConfigVersion:old.configVersion,configuration},configured=await plans.configureWorkConfirmed(owner,command),plan=await plans.changeConfirmed(owner,{requestId:randomUUID(),planId:configured.id,expectedVersion:configured.version,action:'enable'})
 const events=new WorkEventService(env.pool,clock,{material:async(db,owner,resourceId)=>{const [value]=await resources.executionKnowledgeInTransaction(db,{ownerId:owner,kind:'human',scopeIds:['general']},['general'],[resourceId]);assert.ok(value);return {sourceVersion:value.sourceVersion,contentSha256:createHash('sha256').update(value.text).digest('hex')}}}),occurrences=new PlanOccurrenceService(env.pool,clock)
 return {owner,folder,actor,resources,role,delegation,plans,old,command,configuration,plan,configured,events,occurrences,setNow:(value:string)=>{now=value},collect:()=>collectLocalMaterialEvents(env.pool,owner,resources,events,async()=>actor,new AbortController().signal)}
}
test('真实本机来源派生事件，重复去重；暂停本轮保留最新输入且第二轮复用原Task领取谱系',async()=>{
 const f=await fixture();assert.equal(f.old.workDefinition,undefined);assert.equal(f.configured.state,'paused');assert.equal((await env.pool.query('select count(*)::int n from teloa_tasks where owner_id=$1',[f.owner])).rows[0].n,0)
 await f.collect();await f.collect();let pending=await f.events.pending(f.owner);assert.equal(pending.length,1);const first=await f.events.claim(f.owner,{planId:f.plan.id,definitionVersion:f.plan.configVersion,eventId:pending[0]!.event.id,controlGeneration:1});assert.ok(first?.workDefinition)
 const task=await f.occurrences.dispatchTask(f.owner,{claimId:first.id,taskRequestId:first.taskRequestId,now:'2026-10-09T00:00:01.000Z'})
 await env.pool.query("update teloa_work_controls set state='paused' where owner_id=$1 and root_task_id=$2",[f.owner,task.task.id])
 await writeFile(join(f.folder,'note.md'),'# 本机材料\n第二版有效原件。');f.setNow('2026-10-09T00:01:00.000Z');await f.collect()
 await writeFile(join(f.folder,'note.md'),'# 本机材料\n第三版有效原件。');f.setNow('2026-10-09T00:02:00.000Z');await f.collect();pending=await f.events.pending(f.owner);assert.equal(pending.length,1)
 assert.equal(await f.events.claim(f.owner,{planId:f.plan.id,definitionVersion:f.plan.configVersion,eventId:pending[0]!.event.id,controlGeneration:1}),null)
 assert.equal((await env.pool.query("select count(*)::int n from teloa_plan_work_events where owner_id=$1 and state='superseded'",[f.owner])).rows[0].n,1)
 await env.pool.query("update teloa_tasks set state='cancelled',version=version+1 where owner_id=$1 and id=$2",[f.owner,task.task.id])
 const second=await f.events.claim(f.owner,{planId:f.plan.id,definitionVersion:f.plan.configVersion,eventId:pending[0]!.event.id,controlGeneration:1});assert.ok(second);const next=await f.occurrences.dispatchTask(f.owner,{claimId:second.id,taskRequestId:second.taskRequestId,now:'2026-10-09T00:02:01.000Z'});assert.notEqual(next.task.id,task.task.id)
 assert.equal((await f.events.claim(f.owner,{planId:f.plan.id,definitionVersion:f.plan.configVersion,eventId:pending[0]!.event.id,controlGeneration:1}))?.id,second.id)
 const lineage=(await env.pool.query('select lineage from teloa_task_work_lineage where owner_id=$1 and task_id=$2',[f.owner,next.task.id])).rows[0].lineage;assert.equal(lineage.definition.planId,f.plan.id);assert.equal(lineage.budgetAccountId,f.plan.workDefinition!.budgetAccountId)
})
test('跨本人/旧定义/旧控制/资料撤回拒绝；未知配置恢复只读原回执且不续授',async()=>{
 const f=await fixture();await f.collect();const event=(await f.events.pending(f.owner))[0]!,input={planId:f.plan.id,definitionVersion:f.plan.configVersion,eventId:event.event.id,controlGeneration:1}
 await assert.rejects(f.events.claim('other',input),{code:'teloa/forbidden'});await assert.rejects(f.events.claim(f.owner,{...input,definitionVersion:1}),{code:'teloa/version-conflict'});await assert.rejects(f.events.claim(f.owner,{...input,controlGeneration:2}),{code:'teloa/version-conflict'})
 await env.pool.query("update teloa_work_controls set state='paused',generation=generation+1 where owner_id=$1 and id=$2",[f.owner,f.plan.workDefinition!.definitionControlId]);assert.deepEqual(await f.events.pending(f.owner),[])
 const recovered=await new PlanService(env.pool,identity,undefined,ownerAuthority).configureWorkConfirmed(f.owner,f.command);assert.equal(recovered.version,f.configured.version);assert.equal(recovered.state,'paused')
 const api=new WorkProgressService(env.pool,identity);await assert.rejects(api.change(f.owner,{requestId:randomUUID(),rootTaskId:randomUUID(),expectedVersion:0,progress:{stage:'已完成',completedStepIds:[randomUUID()],nextStep:null,wait:null,artifactIds:[],pendingActionIds:[]}}),{code:'teloa/forbidden'})
})
test('实际长期定义修改保留同累计预算，新控制第二周期仍可预留且不归零',async()=>{
 await initializeWorkControl(env.pool);const f=await fixture();await f.collect();const event=(await f.events.pending(f.owner))[0]!,claim=await f.events.claim(f.owner,{planId:f.plan.id,definitionVersion:f.plan.configVersion,eventId:event.event.id,controlGeneration:1});assert.ok(claim)
 const first=await f.occurrences.dispatchTask(f.owner,{claimId:claim.id,taskRequestId:claim.taskRequestId,now:'2026-10-09T00:00:01.000Z'}),budgets=new WorkBudgetService(env.pool,identity),budgetAccountId=f.plan.workDefinition!.budgetAccountId,reservation=await budgets.reserve(f.owner,{budgetAccountId,controlGeneration:1,modelRequestId:'first:'+first.task.id,kind:'team',tokens:100,rounds:1})
 await budgets.settle(f.owner,{reservationId:reservation.id,modelRequestId:reservation.modelRequestId,provider:'actual-fixture',providerRequestId:'operation-one',tokens:80,moneyMinorUnits:null,currency:null,receiptId:'first-receipt:'+first.task.id});await env.pool.query("update teloa_tasks set state='completed',version=version+1 where id=$1",[first.task.id])
 const paused=await f.plans.change(f.owner,{requestId:randomUUID(),planId:f.plan.id,expectedVersion:f.plan.version,action:'pause'}),fields={title:'第二版材料跟进',goal:'核对实际新版本',dataScope:'当前委托原件',delivery:'本轮版本小结'},changed=await f.plans.configureWorkConfirmed(f.owner,{requestId:randomUUID(),planId:f.plan.id,expectedVersion:paused.version,expectedConfigVersion:paused.configVersion,configuration:f.configuration,fields});assert.equal(changed.workDefinition!.budgetAccountId,budgetAccountId);assert.equal(changed.title,fields.title);assert.notEqual(changed.workDefinition!.definitionControlId,f.plan.workDefinition!.definitionControlId)
 const enabled=await f.plans.changeConfirmed(f.owner,{requestId:randomUUID(),planId:changed.id,expectedVersion:changed.version,action:'enable'});await writeFile(join(f.folder,'note.md'),'真实第二定义新材料。');f.setNow('2026-10-09T00:01:00.000Z');await f.collect();const nextEvent=(await f.events.pending(f.owner))[0]!,nextClaim=await f.events.claim(f.owner,{planId:enabled.id,definitionVersion:enabled.configVersion,eventId:nextEvent.event.id,controlGeneration:1});assert.ok(nextClaim);const second=await f.occurrences.dispatchTask(f.owner,{claimId:nextClaim.id,taskRequestId:nextClaim.taskRequestId,now:'2026-10-09T00:01:01.000Z'})
 await budgets.reserve(f.owner,{budgetAccountId,controlGeneration:1,modelRequestId:'second:'+second.task.id,kind:'team',tokens:100,rounds:1});const usage=await budgets.read(f.owner,{budgetAccountId});assert.equal(usage.usedTokens,180);assert.equal(usage.usedRounds,2);assert.equal(second.task.goal,fields.goal)
})
test('独立 Task Flow 资料等待没有 Plan 监听时仍由真实本机事件唤醒，闲置不调用模型',async()=>{
 await initializeWorkControl(env.pool);const f=await fixture(),archived=await f.plans.change(f.owner,{requestId:randomUUID(),planId:f.plan.id,expectedVersion:f.plan.version,action:'archive',note:'仅核验独立 Flow 来源，不使用计划监听'});assert.equal(archived.state,'archived')
 const task=await new TaskService(env.pool,identity).create(f.owner,{requestId:randomUUID(),fields:{title:'独立材料等待',goal:'核对下个版本',scope:'general'},assignee:{roleId:f.role.id,expectedVersion:f.role.version}}),sessionId=randomUUID(),conversationId=randomUUID(),inspect=async()=>({id:conversationId,sessionId,ownerId:f.owner,status:'ready'})
 await new ObjectConversationService(env.pool,inspect,identity.now).change(f.owner,{requestId:randomUUID(),kind:'task',objectId:task.id,expectedObjectVersion:1,sessionId,expectedLinkVersion:0,action:'link'})
 const runs=new TaskRunService(env.pool,identity,inspect),run=await runs.prepare(f.owner,{requestId:randomUUID(),taskId:task.id,expectedTaskVersion:1,roleId:f.role.id,expectedRoleVersion:f.role.version,sessionId,expectedLinkVersion:1},undefined,async(_target,_role,db)=>f.resources.executionKnowledgeInTransaction(db,f.actor,['general'],f.role.knowledge));await runs.claim(f.owner,{runId:run.id});await runs.record(f.owner,{runId:run.id,sessionId,nativeRequestId:run.nativeRequestId,evidence:{state:'accepted'}})
 const controls=new WorkControlService(env.pool,identity),flows=new TaskRunFlowService(env.pool,identity,{authority:ownerAuthority,admit:(db,owner,id)=>runs.executionAdmissionInTransaction(db,owner,id),verifiedSource:(db,owner,id)=>f.events.verifiedSourceInTransaction(db,owner,id)}),flow=await flows.createConfirmed(f.owner,{requestId:randomUUID(),runId:run.id,definitionVersion:1,steps:[{id:'wait',title:'等实际版本',kind:'wait_external',dependsOn:[],inputSummary:'只有新原件才推进'},{id:'work',title:'核对新版',kind:'work',dependsOn:['wait'],inputSummary:'核对原件'}],waitBindings:[{stepId:'wait',sourceKind:'material-version',sourceId:f.role.knowledge[0]}]})
 await flows.transition(f.owner,{requestId:randomUUID(),flowId:flow.flowId,stepId:'wait',expectedAttempts:0,action:'start'});await flows.transition(f.owner,{requestId:randomUUID(),flowId:flow.flowId,stepId:'wait',expectedAttempts:1,action:'wait',waitReason:'等待新原件'})
 const collect=()=>collectLocalMaterialEvents(env.pool,f.owner,f.resources,f.events,async()=>f.actor,new AbortController().signal,{runs:async()=>runs,controls}),wait={runId:run.id,flowId:flow.flowId,stepId:'wait',expectedAttempts:1};await collect();assert.equal(await flows.readWait(f.owner,wait),null);assert.deepEqual(await f.events.pending(f.owner),[])
 await writeFile(join(f.folder,'note.md'),'独立工作的新原件。');f.setNow(new Date(Date.now()+1000).toISOString());await collect();const receipt=await flows.readWait(f.owner,wait);assert.ok(receipt);await collect();assert.equal((await flows.readWait(f.owner,wait))!.eventId,receipt.eventId);assert.equal((await env.pool.query('select count(*)::int n from teloa_work_events where owner_id=$1',[f.owner])).rows[0].n,2)
})
test('真实时间游标重启保留，错过多个周期合并一轮并保存遗漏',async()=>{
 const f=await fixture(true);await f.occurrences.recover(f.owner,{planId:f.plan.id,now:'2026-10-09T00:00:00.000Z'});const recovered=await f.occurrences.recover(f.owner,{planId:f.plan.id,now:'2026-10-12T00:00:00.000Z'});assert.equal(recovered.nextAt,'2026-10-09T01:00:00.000Z')
 const claimed=await f.occurrences.claim(f.owner,{planId:f.plan.id,now:'2026-10-12T01:00:00.000Z'});assert.ok(claimed.occurrence);assert.equal(claimed.occurrence.scheduledAt,'2026-10-12T01:00:00.000Z');assert.equal((await env.pool.query('select omitted_count from teloa_plan_schedule_coalesces where owner_id=$1',[f.owner])).rows[0].omitted_count,3)
 const task=await f.occurrences.dispatchTask(f.owner,{claimId:claimed.occurrence.id,taskRequestId:claimed.occurrence.taskRequestId,now:'2026-10-12T01:00:01.000Z'}),progress=new WorkProgressService(env.pool,identity),input={requestId:randomUUID(),rootTaskId:task.task.id,expectedVersion:0,progress:{stage:'核对来源',completedStepIds:[],nextStep:'等待资料',wait:{kind:'event',reason:'等新版本',nextAt:null},artifactIds:[],pendingActionIds:[]}}
 const saved=await progress.change(f.owner,input);assert.deepEqual(await progress.change(f.owner,input),saved);assert.equal((await progress.get(f.owner,{rootTaskId:task.task.id}))?.wait?.kind,'event');await assert.rejects(progress.change(f.owner,{...input,requestId:randomUUID(),expectedVersion:1,progress:{...input.progress,completedStepIds:[randomUUID()]}}),{code:'teloa/forbidden'})
})

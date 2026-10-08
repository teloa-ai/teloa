import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {setupRoleWork,identity,loadRoleWorkModule} from './role-work-test-fixture.ts'
import {RoleService} from '../src/work/roles.ts'
import {CollaborationService} from '../src/work/collaboration.ts'
import {GroupAgentGrantService} from '../src/work/group-agent-grants.ts'
import {GroupRoutingDecisionService,initializeGroupRoutingDecisions} from '../src/work/group-routing-decisions.ts'
import {GroupTaskService,initializeGroupTasks,readGroupTaskSource} from '../src/work/group-tasks.ts'
import {TaskService} from '../src/work/tasks.ts'
import {ObjectConversationService} from '../src/work/object-conversations.ts'
import {TaskRunService} from '../src/work/task-runs.ts'
import {readRunGroupContext} from '../src/work/task-run-group-context.ts'
import {GroupRunMessageService} from '../src/work/group-run-messages.ts'
import {WorkLineageService} from '../src/work/work-lineage.ts'
import {groupTaskSourceDigest} from '../src/work/group-task-source-digest.ts'
import {PlanService} from '../src/work/plans.ts'
import {PlanOccurrenceService,initializePlanOccurrences} from '../src/work/plan-occurrences.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'
import {RoleWorkEligibilityService} from '../src/work/role-work-eligibility.ts'
let f:Awaited<ReturnType<typeof setupRoleWork>>,module:Record<string,any>
before(async()=>{f=await setupRoleWork();await initializeGroupTasks(f.pool);await initializeGroupRoutingDecisions(f.pool);await initializePlanOccurrences(f.pool);module=await loadRoleWorkModule('group-routing-outbox');if(module.initializeGroupRoutingOutbox)await module.initializeGroupRoutingOutbox(f.pool)})
after(async()=>{await f?.close()})
async function fixture(){
 const owner=randomUUID(),roles=new RoleService(f.pool,identity),groups=new CollaborationService(f.pool,identity),grants=new GroupAgentGrantService(f.pool,identity.now),recipients=[]
 for(const name of ['甲同事','乙同事']){const role=await roles.create(owner,{requestId:randomUUID(),fields:{name,kind:'employee',scopes:['general'],duty:'研判',dataScope:'授权资料',executionScope:'只读',skills:[],knowledge:[],responsibility:testRoleResponsibility,runtimeConfig:{agentPresetId:'standard'}}});await f.pool.query("update teloa_roles set state='active',version=2 where id=$1",[role.id]);recipients.push({...role,state:'active' as const,version:2})}
 const group=await groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:{name:'可靠协作',scope:'general',announcement:'',rules:{historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true},memberRoleIds:recipients.map(r=>r.id)}})
 for(const role of recipients)await grants.change(owner,{requestId:randomUUID(),groupId:group.id,roleId:role.id,expectedGroupVersion:group.version,expectedRoleVersion:2,action:'save',resources:[],canPost:true,canAutoRun:true})
 const message=await groups.send(owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:group.version,text:'请两位分别核对。',references:[],mentions:[]})
 const decision={kind:'routed' as const,respond:recipients.map(r=>r.id),reactions:[],hops:0,candidateIds:recipients.map(r=>r.id),truncatedCandidates:false,stopMessageId:null,at:identity.now()},decisions=new GroupRoutingDecisionService(f.pool,identity)
 assert.equal(typeof module.GroupRoutingOutboxService,'function','必须存在持久逐接收者投递服务')
 const outbox=new module.GroupRoutingOutboxService(f.pool,identity)
 const record=()=>decisions.withTopicLock(owner,group.id,message.id,async db=>{await decisions.record(db,owner,{groupId:group.id,messageId:message.id,decision});return outbox.recordRecipients(db,owner,{groupId:group.id,messageId:message.id,decision,decisionVersion:1})})
 return {owner,recipients,group,message,decision,decisions,outbox,record,groups,grants}
}
async function prepared(x:Awaited<ReturnType<typeof fixture>>,item:any){
 const task=(await new GroupTaskService(f.pool,identity,new TaskService(f.pool,identity)).create(x.owner,await x.outbox.taskInput(x.owner,{itemId:item.id}))).task
 const sessionId=randomUUID(),conversationId=randomUUID(),inspect=async()=>({id:conversationId,ownerId:x.owner,sessionId,status:'ready'})
 await new ObjectConversationService(f.pool,inspect,identity.now).change(x.owner,{requestId:randomUUID(),kind:'task',objectId:task.id,expectedObjectVersion:1,sessionId,expectedLinkVersion:0,action:'link'})
 const runs=new TaskRunService(f.pool,identity,inspect,{allowedTools:[],groupContext:(db,owner,task,role)=>readRunGroupContext(db,owner,task,role,undefined,f.pool)})
 const run=await runs.prepare(x.owner,{requestId:item.requestId,taskId:task.id,expectedTaskVersion:1,roleId:item.roleId,expectedRoleVersion:item.roleVersion,sessionId,expectedLinkVersion:1})
 return {task,run,runs}
}
test('可信群路由只为同版本已完成源Task核当前授权；普通执行和撤权后的接力仍拒绝',async()=>{
 const x=await fixture(),[item]=await x.record(),p=await prepared(x,item),eligibility=new RoleWorkEligibilityService(f.pool)
 await p.runs.claim(x.owner,{runId:p.run.id});await p.runs.record(x.owner,{runId:p.run.id,sessionId:p.run.sessionId,nativeRequestId:p.run.nativeRequestId,evidence:{state:'ended',turn:0,messageSeq:1,endSeq:2,reason:'completed'}})
 const message=await new GroupRunMessageService(f.pool,identity,undefined,undefined,x.outbox).post(x.owner,{requestId:randomUUID(),runId:p.run.id,text:'请另一位核对这个结果'})
 await f.pool.query("update teloa_tasks set state='completed',version=version+1 where owner_id=$1 and id=$2",[x.owner,p.task.id])
 assert.equal(typeof eligibility.authorizeGroupRoutingSource,'function','完成源Task的路由应有仅可信消息可用的后台资格口')
 const input={groupId:x.group.id,messageId:message.id},admission=await eligibility.authorizeGroupRoutingSource(x.owner,input)
 assert.equal(admission.role.id,p.run.roleId);assert.deepEqual(admission.limits.knowledgeIds,[]);admission.assertCurrent()
 await assert.rejects(eligibility.authorize(x.owner,{roleId:p.run.roleId,expectedRoleVersion:p.run.roleVersion,scope:'general',inputSchema:'teloa.task-run-input/v2',authorization:p.run.roleSnapshot!.authorization,groupId:x.group.id}),{code:'teloa/conflict'})
 await assert.rejects(p.runs.executionAdmission(x.owner,p.run.id),{code:'teloa/forbidden'})
 await assert.rejects(eligibility.authorizeGroupRoutingSource(randomUUID(),input),{code:'teloa/forbidden'})
 await assert.rejects(eligibility.authorizeGroupRoutingSource(x.owner,{...input,allowEnded:true} as any),{code:'teloa/invalid-input'})
 await f.pool.query("update teloa_tasks set state='cancelled' where owner_id=$1 and id=$2",[x.owner,p.task.id]);await assert.rejects(eligibility.authorizeGroupRoutingSource(x.owner,input),{code:'teloa/conflict'})
 await f.pool.query("update teloa_tasks set state='completed',content_version=content_version+1 where owner_id=$1 and id=$2",[x.owner,p.task.id]);await assert.rejects(eligibility.authorizeGroupRoutingSource(x.owner,input),{code:'teloa/version-conflict'})
 await f.pool.query('update teloa_tasks set content_version=content_version-1 where owner_id=$1 and id=$2',[x.owner,p.task.id])
 await x.grants.change(x.owner,{requestId:randomUUID(),groupId:x.group.id,roleId:p.run.roleId,expectedGroupVersion:x.group.version,expectedRoleVersion:p.run.roleVersion,action:'revoke',resources:[],canPost:false,canAutoRun:false})
 assert.throws(admission.assertCurrent,{code:'teloa/forbidden'});await assert.rejects(eligibility.authorizeGroupRoutingSource(x.owner,input),{code:'teloa/forbidden'})
})
test('决策与二人待办原子提交；同决策重入复用稳定请求，不重复收件人',async()=>{
 const x=await fixture(),items=await x.record(),again=await x.record()
 assert.equal(items.length,2);assert.deepEqual(again.map((i:any)=>i.requestId),items.map((i:any)=>i.requestId));assert.equal(new Set(items.map((i:any)=>i.requestId)).size,2)
 assert.ok(items.every((i:any)=>i.state==='pending'&&i.roleVersion===2&&i.lineage===null))
 assert.equal((await x.outbox.list(x.owner,{groupId:x.group.id,messageIds:[x.message.id]})).length,2)
 await assert.rejects(x.outbox.list(randomUUID(),{groupId:x.group.id,messageIds:[x.message.id]}),{code:'teloa/forbidden'})
 const other=await fixture()
 await assert.rejects(other.decisions.withTopicLock(other.owner,other.group.id,other.message.id,async db=>{await other.decisions.record(db,other.owner,{groupId:other.group.id,messageId:other.message.id,decision:other.decision});await other.outbox.recordRecipients(db,other.owner,{groupId:other.group.id,messageId:other.message.id,decision:other.decision,decisionVersion:1});throw Error('before commit')}),/before commit/)
 assert.equal((await f.pool.query('select count(*)::int as n from teloa_group_routing_outbox where owner_id=$1',[other.owner])).rows[0].n,0)
 assert.equal(await other.decisions.withTopicLock(other.owner,other.group.id,other.message.id,db=>other.decisions.claimed(db,other.owner,other.message.id)),false)
})
test('双worker CAS只有一个租约；过期可恢复，旧世代不能回写；跨owner不可领取',async()=>{
 const x=await fixture(),[item]=await x.record(),claimed=await Promise.all([x.outbox.claim(x.owner,{itemId:item.id,expectedLeaseGeneration:0}),x.outbox.claim(x.owner,{itemId:item.id,expectedLeaseGeneration:0})])
 assert.equal(claimed.filter(Boolean).length,1)
 assert.equal(await x.outbox.claim(randomUUID(),{itemId:item.id,expectedLeaseGeneration:0}),null)
 await f.pool.query("update teloa_group_routing_outbox set next_attempt_at=now()-interval '1 second' where id=$1",[item.id])
 const recovered=await x.outbox.claim(x.owner,{itemId:item.id,expectedLeaseGeneration:1});assert.equal(recovered.leaseGeneration,2)
 await assert.rejects(x.outbox.settle(x.owner,{itemId:item.id,leaseGeneration:1,taskId:null,runId:null,state:'unknown',reason:'lost'}),{code:'teloa/version-conflict'})
})
test('决策须真实持久且属于本人；伪造额外接收者不得产生待办',async()=>{
 const x=await fixture(),db=await f.pool.connect()
 try{await db.query('begin');await assert.rejects(x.outbox.recordRecipients(db,x.owner,{groupId:x.group.id,messageId:x.message.id,decision:x.decision,decisionVersion:1}),{code:'teloa/forbidden'});await db.query('rollback')}finally{db.release()}
 await x.record()
 await assert.rejects(x.decisions.withTopicLock(x.owner,x.group.id,x.message.id,db=>x.outbox.recordRecipients(db,x.owner,{groupId:x.group.id,messageId:x.message.id,decision:{...x.decision,respond:[randomUUID()]},decisionVersion:1})),{code:'teloa/conflict'})
 const legacy=await fixture();await legacy.decisions.withTopicLock(legacy.owner,legacy.group.id,legacy.message.id,db=>legacy.decisions.record(db,legacy.owner,{groupId:legacy.group.id,messageId:legacy.message.id,decision:legacy.decision}))
 await assert.rejects(legacy.decisions.withTopicLock(legacy.owner,legacy.group.id,legacy.message.id,db=>legacy.outbox.recordRecipients(db,legacy.owner,{groupId:legacy.group.id,messageId:legacy.message.id,decision:legacy.decision,decisionVersion:1})),{code:'teloa/forbidden'})
})
test('真实Task/Run回执绑定原请求；提交未知保留身份，不接受虚构成功回执',async()=>{
 const x=await fixture(),[item]=await x.record(),claimed=await x.outbox.claim(x.owner,{itemId:item.id,expectedLeaseGeneration:0}),p=await prepared(x,item)
 assert.deepEqual(await x.outbox.receipt(x.owner,{itemId:item.id}),{taskId:p.task.id,runId:p.run.id,state:'prepared'})
 await assert.rejects(x.outbox.settle(x.owner,{itemId:item.id,leaseGeneration:claimed.leaseGeneration,taskId:p.task.id,runId:p.run.id,state:'settled',reason:null}),{code:'teloa/storage-corrupt'})
 await x.outbox.reserveSubmission(x.owner,{itemId:item.id,leaseGeneration:claimed.leaseGeneration,taskId:p.task.id,runId:p.run.id})
 await p.runs.claim(x.owner,{runId:p.run.id})
 const unknown=await x.outbox.settle(x.owner,{itemId:item.id,leaseGeneration:claimed.leaseGeneration,taskId:p.task.id,runId:p.run.id,state:'unknown',reason:'teloa/execution-pending'})
 assert.equal(unknown.runId,p.run.id);assert.equal(unknown.state,'unknown')
 await assert.rejects(x.outbox.receipt(randomUUID(),{itemId:item.id}),{code:'teloa/forbidden'})
})
test('当前grant或父控制漂移阻止新派工，已提交回执仍可核对',async()=>{
 const x=await fixture(),[item]=await x.record(),claimed=await x.outbox.claim(x.owner,{itemId:item.id,expectedLeaseGeneration:0})
 await x.grants.change(x.owner,{requestId:randomUUID(),groupId:x.group.id,roleId:item.roleId,expectedGroupVersion:x.group.version,expectedRoleVersion:item.roleVersion,action:'revoke',resources:[],canPost:false,canAutoRun:false})
 await assert.rejects(x.outbox.assertDispatch(x.owner,{itemId:item.id,leaseGeneration:claimed.leaseGeneration}),{code:'teloa/forbidden'})
})
test('真实v2回复、冻结作者及唤醒同事务；恢复派工继承原Run谱系，旧消息不补猜',async()=>{
 const x=await fixture(),[first]=await x.record(),p=await prepared(x,first)
 await p.runs.claim(x.owner,{runId:p.run.id});await p.runs.record(x.owner,{runId:p.run.id,sessionId:p.run.sessionId,nativeRequestId:p.run.nativeRequestId,evidence:{state:'ended',turn:0,messageSeq:1,endSeq:2,reason:'completed'}})
 const publisher=new GroupRunMessageService(f.pool,identity,undefined,undefined,x.outbox),request={requestId:randomUUID(),runId:p.run.id,text:'真实运行结果'}
 const rollbackRequest={...request,requestId:randomUUID()},failing=new GroupRunMessageService(f.pool,identity,undefined,undefined,{recordWake:x.outbox.recordWake.bind(x.outbox),recordRunMessage:async(db,owner,input)=>{await x.outbox.recordRunMessage(db,owner,input);throw Error('wake commit failed')}})
 await assert.rejects(failing.post(x.owner,rollbackRequest),/wake commit failed/)
 assert.equal((await f.pool.query('select count(*)::int n from teloa_group_messages where owner_id=$1 and request_id=$2',[x.owner,rollbackRequest.requestId])).rows[0].n,0)
 assert.equal((await f.pool.query('select count(*)::int n from teloa_group_run_sources where owner_id=$1',[x.owner])).rows[0].n,0)
 assert.equal((await f.pool.query('select count(*)::int n from teloa_group_routing_wakes where owner_id=$1',[x.owner])).rows[0].n,0)
 const message=await publisher.post(x.owner,request),source=await module.readTrustedGroupMessageRunSource(f.pool,x.owner,{groupId:x.group.id,messageId:message.id},f.pool)
 assert.equal(source.roleName,x.recipients.find(r=>r.id===first.roleId)!.name);assert.equal(source.roleKind,'employee');assert.deepEqual(source.lineage,p.run.lineage)
 const wake=await x.outbox.claimWake(x.owner);assert.equal(wake.messageId,message.id)
 await x.outbox.settleWake(x.owner,{messageId:wake.messageId,leaseGeneration:wake.leaseGeneration,settled:false})
 await f.pool.query("update teloa_group_routing_wakes set next_attempt_at=now()-interval '1 second' where owner_id=$1 and message_id=$2",[x.owner,message.id])
 const resumedWake=await x.outbox.claimWake(x.owner);assert.equal(resumedWake.messageId,message.id);assert.equal(resumedWake.leaseGeneration,wake.leaseGeneration+1)
 await assert.rejects(x.outbox.settleWake(x.owner,{messageId:message.id,leaseGeneration:wake.leaseGeneration,settled:true}),{code:'teloa/version-conflict'})
 await x.outbox.settleWake(x.owner,{messageId:message.id,leaseGeneration:resumedWake.leaseGeneration,settled:true})
 const decision={...x.decision,respond:[x.recipients.find(role=>role.id!==first.roleId)!.id]}
 const items=await x.decisions.withTopicLock(x.owner,x.group.id,x.message.id,async db=>{await x.decisions.record(db,x.owner,{groupId:x.group.id,messageId:message.id,decision});return x.outbox.recordRecipients(db,x.owner,{groupId:x.group.id,messageId:message.id,decision,decisionVersion:1})})
 const child=await prepared(x,items[0]),inherited={...p.run.lineage,parentRunId:p.run.id}
 assert.deepEqual(items[0].lineage,inherited);assert.deepEqual(child.run.lineage,inherited)
 assert.deepEqual(await new WorkLineageService(f.pool,identity).read(x.owner,{taskId:child.task.id}),inherited)
 await assert.rejects(module.readTrustedGroupMessageRunSource(f.pool,randomUUID(),{groupId:x.group.id,messageId:message.id},f.pool),{code:'teloa/forbidden'})
 // 已落库回复重放只复用同一消息；唤醒领取失败不会靠再次发言恢复。
 assert.equal((await publisher.post(x.owner,request)).id,message.id)
 assert.equal(await x.outbox.claimWake(x.owner),null)
 assert.equal((await f.pool.query('select count(*)::int n from teloa_group_messages where owner_id=$1 and request_id=$2',[x.owner,request.requestId])).rows[0].n,1)
 const legacy=await new GroupRunMessageService(f.pool,identity).post(x.owner,{requestId:randomUUID(),runId:p.run.id,text:'旧宿主未写来源'})
 assert.equal(await module.readTrustedGroupMessageWorkSource(f.pool,x.owner,{groupId:x.group.id,messageId:legacy.id},f.pool),null)
 await f.pool.query("update teloa_roles set definition=jsonb_set(definition,'{name}','\"已改岗位名\"'::jsonb),version=version+1 where owner_id=$1 and id=$2",[x.owner,p.run.roleId])
 assert.equal((await module.readTrustedGroupMessageRunSource(f.pool,x.owner,{groupId:x.group.id,messageId:message.id},f.pool)).roleName,source.roleName)
 await publisher.post(x.owner,{requestId:(await f.pool.query('select request_id from teloa_group_messages where id=$1',[legacy.id])).rows[0].request_id,runId:p.run.id,text:'旧宿主未写来源'})
 assert.equal(await module.readTrustedGroupMessageWorkSource(f.pool,x.owner,{groupId:x.group.id,messageId:legacy.id},f.pool),null)
 await f.pool.query("update teloa_work_controls set state='paused',generation=generation+1 where owner_id=$1 and id=$2",[x.owner,p.run.lineage!.roundControlId])
 const item=items[0],lease=await x.outbox.claim(x.owner,{itemId:item.id,expectedLeaseGeneration:0})
 await assert.rejects(x.outbox.assertDispatch(x.owner,{itemId:item.id,leaseGeneration:lease.leaseGeneration}),{code:'teloa/forbidden'})
})
test('真实计划领取的Run在可信宿主已绑定群目标时，回复与派生Run共享原定义、轮次和预算账户',async()=>{
 const x=await fixture(),[first]=await x.record(),template=await prepared(x,first),role=x.recipients.find(r=>r.id===first.roleId)!,plans=new PlanService(f.pool,identity),created=await plans.create(x.owner,{requestId:randomUUID(),fields:{title:'每轮核对',goal:'核对材料',scope:'general',dataScope:'授权群资料',delivery:'核对结果',roleId:role.id,expectedRoleVersion:2,notificationPolicy:'attention',trigger:{kind:'schedule',cadence:'daily',weekday:1,time:'09:00',timezone:'Asia/Singapore'}},source:{kind:'manual'}}),plan=await plans.change(x.owner,{planId:created.id,requestId:randomUUID(),expectedVersion:created.version,action:'enable'})
 const occurrence=(await new PlanOccurrenceService(f.pool,identity).trigger(x.owner,{planId:plan.id,requestId:randomUUID(),expectedVersion:plan.version,expectedConfigVersion:plan.configVersion,now:identity.now()})).occurrence,db=await f.pool.connect()
 let taskId:string
 try{
  await db.query('begin')
  const task=await new TaskService(f.pool,identity).createInTransaction(db,x.owner,{...occurrence.taskRequest,fields:{...occurrence.taskRequest.fields,groupId:x.group.id}},{kind:'plan-occurrence',claimId:occurrence.id});taskId=task.id
  // 这里只验证已授权宿主群目标的协议，不冒充普通Plan界面已有群目标配置。
  const raw=(await db.query('select * from teloa_group_task_sources where owner_id=$1 and task_id=$2',[x.owner,template.task.id])).rows[0],source={...readGroupTaskSource(raw),taskId,createdAt:identity.now()}
  await db.query('insert into teloa_group_task_sources(task_id,owner_id,request_id,request_spec,group_id,group_version,message_id,root_id,source_snapshot,snapshot_digest,created_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[taskId,x.owner,occurrence.taskRequestId,raw.request_spec,source.groupId,source.groupVersion,source.messageId,source.rootId,JSON.stringify(source),groupTaskSourceDigest(source),source.createdAt])
  await db.query('commit')
 }catch(error){await db.query('rollback');throw error}finally{db.release()}
 const sessionId=randomUUID(),conversationId=randomUUID(),inspect=async()=>({id:conversationId,ownerId:x.owner,sessionId,status:'ready'}),runs=new TaskRunService(f.pool,identity,inspect,{allowedTools:[],groupContext:(db,owner,task,role)=>readRunGroupContext(db,owner,task,role,undefined,f.pool)})
 await new ObjectConversationService(f.pool,inspect,identity.now).change(x.owner,{requestId:randomUUID(),kind:'task',objectId:taskId,expectedObjectVersion:1,sessionId,expectedLinkVersion:0,action:'link'})
 const run=await runs.prepare(x.owner,{requestId:randomUUID(),taskId,expectedTaskVersion:1,roleId:role.id,expectedRoleVersion:2,sessionId,expectedLinkVersion:1})
 await runs.claim(x.owner,{runId:run.id});await runs.record(x.owner,{runId:run.id,sessionId,nativeRequestId:run.nativeRequestId,evidence:{state:'ended',turn:0,messageSeq:1,endSeq:2,reason:'completed'}})
 const message=await new GroupRunMessageService(f.pool,identity,undefined,undefined,x.outbox).post(x.owner,{requestId:randomUUID(),runId:run.id,text:'计划本轮已核对'}),decision={...x.decision,respond:[x.recipients.find(r=>r.id!==role.id)!.id]}
 const items=await x.decisions.withTopicLock(x.owner,x.group.id,x.message.id,async db=>{await x.decisions.record(db,x.owner,{groupId:x.group.id,messageId:message.id,decision});return x.outbox.recordRecipients(db,x.owner,{groupId:x.group.id,messageId:message.id,decision,decisionVersion:1})}),child=await prepared(x,items[0])
 assert.equal(run.lineage!.definition!.planId,plan.id);assert.equal(run.lineage!.definition!.occurrenceId,occurrence.occurrenceId)
 assert.deepEqual(child.run.lineage,{...run.lineage,parentRunId:run.id});assert.equal(child.run.lineage!.budgetAccountId,run.lineage!.budgetAccountId);assert.equal(child.run.lineage!.definitionControlId,run.lineage!.definitionControlId);assert.equal(child.run.lineage!.roundControlId,run.lineage!.roundControlId)
})

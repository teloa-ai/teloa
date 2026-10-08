import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {setupRoleWork,roleFixture,identity,ownerAuthority,delegationFields} from './role-work-test-fixture.ts'
import {RoleToolGrantService,initializeRoleToolGrants} from '../src/work/role-tool-grants.ts'
import {RoleDelegationService} from '../src/work/role-delegations.ts'
import {TwinExecutionConsentService} from '../src/work/twin-execution-consents.ts'
import {RoleWorkEligibilityService} from '../src/work/role-work-eligibility.ts'
import {RoleService} from '../src/work/roles.ts'
import {PlanService} from '../src/work/plans.ts'
import {PlanOccurrenceService,initializePlanOccurrences} from '../src/work/plan-occurrences.ts'
import {WorkLineageService} from '../src/work/work-lineage.ts'
import {ConversationWorkService,initializeConversationWork} from '../src/work/conversation-work.ts'
import {CollaborationService} from '../src/work/collaboration.ts'
import {GroupAgentGrantService} from '../src/work/group-agent-grants.ts'
import {GroupTaskService,initializeGroupTasks} from '../src/work/group-tasks.ts'
import {TaskService} from '../src/work/tasks.ts'

let env:Awaited<ReturnType<typeof setupRoleWork>>
before(async()=>{env=await setupRoleWork();await initializeRoleToolGrants(env.pool);await initializePlanOccurrences(env.pool);await initializeConversationWork(env.pool);await initializeGroupTasks(env.pool)})
after(async()=>{await env?.close()})
const schedule={kind:'schedule' as const,cadence:'daily' as const,weekday:1,time:'09:00',timezone:'Asia/Singapore' as const}
async function configuredTwin(){
 const f=await roleFixture(env.pool)
 await new RoleToolGrantService(env.pool,identity.now,async()=>{}).change(f.owner,{roleId:f.role.id,expectedRoleVersion:1,action:'save',rules:[{name:'read_reference',allowed:[{id:'one',version:'v1'}]}]})
 return {...f,role:(await new RoleService(env.pool,identity).get(f.owner,f.role.id))!}
}
async function delegate(f:Awaited<ReturnType<typeof configuredTwin>>,groupIds:string[]=[]){
 return new RoleDelegationService(env.pool,identity,ownerAuthority).change(f.owner,{requestId:randomUUID(),roleId:f.role.id,expectedRoleVersion:f.role.version,expectedVersion:null,action:'save',fields:{...delegationFields,allowedTools:['read_reference'],groupIds}})
}
const authorization=(d:{id:string;version:number})=>({kind:'delegation' as const,delegationId:d.id,delegationVersion:d.version})
const confirm=(f:Awaited<ReturnType<typeof configuredTwin>>,d:{id:string;version:number})=>new TwinExecutionConsentService(env.pool,identity,ownerAuthority).confirm(f.owner,{requestId:randomUUID(),roleId:f.role.id,expectedRoleVersion:f.role.version,authorization:authorization(d)})

test('分身持续计划须已有委托及本人确认；实际领取生成Task原子固定授权和计划谱系，撤销后历史仍可读',async()=>{
 const f=await configuredTwin(),clock={id:randomUUID,now:()=>'2026-10-09T00:00:00.000Z'},plans=new PlanService(env.pool,clock)
 const input={requestId:randomUUID(),source:{kind:'manual'},fields:{title:'每天核验',goal:'核验本轮资料',scope:'general',dataScope:'明确授权原件',delivery:'版本小结',roleId:f.role.id,expectedRoleVersion:f.role.version,trigger:schedule,notificationPolicy:'attention'}}
 await assert.rejects(plans.create(f.owner,input),{code:'teloa/forbidden'})
 const d=await delegate(f);await assert.rejects(plans.create(f.owner,input),{code:'teloa/forbidden'})
 const consent=await confirm(f,d),created=await plans.create(f.owner,input)
 const active=await plans.change(f.owner,{requestId:randomUUID(),planId:created.id,expectedVersion:1,action:'enable'})
 const occurrences=new PlanOccurrenceService(env.pool,{id:randomUUID}),claimed=(await occurrences.claim(f.owner,{planId:active.id,now:'2026-10-09T01:00:00.000Z'})).occurrence!
 const dispatched=await occurrences.dispatchTask(f.owner,{claimId:claimed.id,taskRequestId:claimed.taskRequestId,now:'2026-10-09T01:00:01.000Z'})
 const row=(await env.pool.query('select request_id,content_version,execution_authorization from teloa_tasks where id=$1',[dispatched.task.id])).rows[0]
 assert.equal(row.request_id,claimed.taskRequestId);assert.equal(row.content_version,1);assert.deepEqual(row.execution_authorization,authorization(d))
 const lineage=await new WorkLineageService(env.pool,identity).read(f.owner,{taskId:dispatched.task.id})
 assert.deepEqual(lineage?.definition,{planId:active.id,definitionVersion:active.configVersion,occurrenceId:claimed.occurrenceId})
 assert.equal(lineage?.rootTaskId,dispatched.task.id)
 await new TwinExecutionConsentService(env.pool,identity).revoke(f.owner,{requestId:randomUUID(),consentId:consent.id,expectedVersion:1})
 await assert.rejects(occurrences.claim(f.owner,{planId:active.id,now:'2026-10-10T01:00:00.000Z'}),{code:'teloa/forbidden'})
 assert.equal((await occurrences.dispatchTask(f.owner,{claimId:claimed.id,taskRequestId:claimed.taskRequestId,now:'2026-10-10T01:00:01.000Z'})).task.id,dispatched.task.id)
 assert.equal((await plans.create(f.owner,input)).id,created.id)
 assert.equal((await plans.change(f.owner,{requestId:randomUUID(),planId:created.id,expectedVersion:active.version,action:'pause'})).state,'paused')
})

test('会话上下文和明确交办只消费本人已有分身委托；撤销不改旧交办但阻断下一条',async()=>{
 const f=await configuredTwin(),sessionId='work-'+randomUUID(),service=new ConversationWorkService(env.pool,identity.now,async(owner,id)=>({ownerId:owner,sessionId:id,status:'ready',submitted:false}))
 const context={requestId:randomUUID(),sessionId,scopeId:'general',roleId:f.role.id,expectedVersion:0}
 const input={requestId:randomUUID(),sessionId,messageId:'message-1',messageSeq:1,kind:'task',scope:'general',title:'核验原件',goal:'仅核验授权原件',roleId:f.role.id,expectedRoleVersion:f.role.version}
 await assert.rejects(service.setContext(f.owner,context),{code:'teloa/forbidden'})
 await assert.rejects(service.reserve(f.owner,input),{code:'teloa/forbidden'})
 const d=await delegate(f);await assert.rejects(service.reserve(f.owner,input),{code:'teloa/forbidden'})
 const consent=await confirm(f,d)
 assert.equal((await service.setContext(f.owner,context)).roleId,f.role.id)
 const saved=await service.reserve(f.owner,input);assert.equal(saved.targets[0]?.roleId,f.role.id)
 await new TwinExecutionConsentService(env.pool,identity).revoke(f.owner,{requestId:randomUUID(),consentId:consent.id,expectedVersion:1})
 assert.deepEqual(await service.reserve(f.owner,input),saved)
 await assert.rejects(service.reserve(f.owner,{...input,requestId:randomUUID(),messageId:'message-2'}),{code:'teloa/forbidden'})
})

test('群派给分身固定群范围并验证原件授权；canAutoRun及委托均不能借出群外权限',async()=>{
 const f=await configuredTwin(),groups=new CollaborationService(env.pool,identity),grants=new GroupAgentGrantService(env.pool,identity.now)
 const group=await groups.create(f.owner,{requestId:randomUUID(),expectedVersion:0,fields:{name:'资料核验',scope:'general',announcement:'固定原件',rules:{historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true},memberRoleIds:[f.role.id]}})
 const resource=await groups.saveResource(f.owner,{requestId:randomUUID(),groupId:group.id,resourceId:randomUUID(),expectedVersion:0,title:'已固定原件',markdown:'核验原件版本一'})
 const message=await groups.send(f.owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:group.version,text:'核验资料',references:[{kind:'group-resource',id:resource.id,version:resource.version}]})
 const service=new GroupTaskService(env.pool,identity,new TaskService(env.pool,identity)),input={requestId:randomUUID(),groupId:group.id,messageId:message.id,expectedGroupVersion:group.version,goal:'核验原件',assignee:{roleId:f.role.id,expectedVersion:f.role.version},trigger:'mention'}
 const grant={requestId:randomUUID(),groupId:group.id,roleId:f.role.id,expectedGroupVersion:group.version,expectedRoleVersion:f.role.version,action:'save',resources:[],canPost:true,canAutoRun:false}
 await grants.change(f.owner,grant)
 const d=await delegate(f,[group.id]);await confirm(f,d)
 await assert.rejects(service.create(f.owner,input),{code:'teloa/forbidden'})
 await grants.change(f.owner,{...grant,requestId:randomUUID(),canAutoRun:true})
 await assert.rejects(service.create(f.owner,input),{code:'teloa/forbidden'})
 await grants.change(f.owner,{...grant,requestId:randomUUID(),canAutoRun:true,resources:[{kind:'group-resource',id:resource.id,version:resource.version}]})
 const saved=await service.create(f.owner,input);assert.equal(saved.task.groupId,group.id);assert.equal(saved.task.assigneeRoleId,f.role.id)
 assert.deepEqual((await env.pool.query('select execution_authorization from teloa_tasks where id=$1',[saved.task.id])).rows[0].execution_authorization,authorization(d))
 // 模拟旧定义缺 groupId：固定来源仍必须收窄到群，不能按私人任务取得记忆或知识。
 await env.pool.query("update teloa_tasks set definition=jsonb_set(definition,'{groupId}','null') where id=$1",[saved.task.id])
 const eligibility=new RoleWorkEligibilityService(env.pool),taskInput={roleId:f.role.id,expectedRoleVersion:f.role.version,scope:'general',inputSchema:'teloa.task-run-input/v2' as const,authorization:{kind:'task' as const,taskId:saved.task.id,taskContentVersion:1},groupId:null}
 await assert.rejects(eligibility.authorize(f.owner,taskInput),{code:'teloa/forbidden'})
 await new TwinExecutionConsentService(env.pool,identity,ownerAuthority).confirm(f.owner,{requestId:randomUUID(),roleId:f.role.id,expectedRoleVersion:f.role.version,authorization:taskInput.authorization})
 const admitted=await eligibility.authorize(f.owner,{...taskInput,groupId:group.id});assert.deepEqual(admitted.limits.knowledgeIds,[])
 await assert.rejects(eligibility.authorize(f.owner,{...taskInput,groupId:randomUUID()}),{code:'teloa/forbidden'})
 await env.pool.query("update teloa_tasks set definition=jsonb_set(definition,'{groupId}',to_jsonb($2::text)) where id=$1",[saved.task.id,randomUUID()])
 await assert.rejects(eligibility.authorize(f.owner,{...taskInput,groupId:group.id}),{code:'teloa/storage-corrupt'})
 await env.pool.query("update teloa_tasks set definition=jsonb_set(definition,'{groupId}','null') where id=$1",[saved.task.id])
 await grants.change(f.owner,{...grant,requestId:randomUUID()})
 assert.equal((await service.create(f.owner,input)).task.id,saved.task.id)
 await assert.rejects(service.create(f.owner,{...input,requestId:randomUUID()}),{code:'teloa/forbidden'})
})

test('员工手动群任务沿本人准入；mention来源保存在服务端且关闭自动执行后不能借手动入口运行',async()=>{
 const f=await roleFixture(env.pool,'employee'),groups=new CollaborationService(env.pool,identity),grants=new GroupAgentGrantService(env.pool,identity.now)
 const group=await groups.create(f.owner,{requestId:randomUUID(),expectedVersion:0,fields:{name:'本人群任务',scope:'general',announcement:'手动与自动授权独立',rules:{historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true},memberRoleIds:[f.role.id]}})
 const message=await groups.send(f.owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:group.version,text:'核验当前资料'})
 const service=new GroupTaskService(env.pool,identity,new TaskService(env.pool,identity)),input={requestId:randomUUID(),groupId:group.id,messageId:message.id,expectedGroupVersion:group.version,goal:'核验资料',assignee:{roleId:f.role.id,expectedVersion:f.role.version}}
 const automatic=await service.create(f.owner,{...input,trigger:'mention'})
 await grants.change(f.owner,{requestId:randomUUID(),groupId:group.id,roleId:f.role.id,expectedGroupVersion:group.version,expectedRoleVersion:f.role.version,action:'save',resources:[],canPost:true,canAutoRun:false})
 const manual=await service.create(f.owner,{...input,requestId:randomUUID()})
 const eligibility=new RoleWorkEligibilityService(env.pool),authorize=(taskId:string)=>eligibility.authorize(f.owner,{roleId:f.role.id,expectedRoleVersion:f.role.version,scope:'general',inputSchema:'teloa.task-run-input/v2',authorization:{kind:'task',taskId,taskContentVersion:1},groupId:group.id})
 await assert.rejects(authorize(automatic.task.id),{code:'teloa/forbidden'})
 assert.equal((await authorize(manual.task.id)).snapshot.id,f.role.id)
 await assert.rejects(eligibility.authorize(f.owner,{roleId:f.role.id,expectedRoleVersion:f.role.version,scope:'general',inputSchema:'teloa.task-run-input/v2',authorization:{kind:'task',taskId:automatic.task.id,taskContentVersion:1},groupId:group.id,trigger:'manual'} as never),{code:'teloa/invalid-input'})
})

test('执行配置资格保留员工暂停边界；分身停用委托后编辑定义保持active且旧版本许可失效',async()=>{
 const employee=await roleFixture(env.pool,'employee'),get=new RoleDelegationService(env.pool,identity)
 assert.equal((await get.get(employee.owner,{roleId:employee.role.id})).canEditExecution,false)
 await env.pool.query("update teloa_roles set state='paused' where id=$1",[employee.role.id])
 assert.equal((await get.get(employee.owner,{roleId:employee.role.id})).canEditExecution,true)
 const f=await configuredTwin();assert.equal((await get.get(f.owner,{roleId:f.role.id})).canEditExecution,true)
 const d=await delegate(f);await confirm(f,d)
 const admission=await new RoleWorkEligibilityService(env.pool).authorize(f.owner,{roleId:f.role.id,expectedRoleVersion:f.role.version,scope:'general',inputSchema:'teloa.task-run-input/v2',authorization:authorization(d),groupId:null})
 const {id,ownerId,version,state,createdAt,updatedAt,...fields}=f.role,roles=new RoleService(env.pool,identity),input={roleId:id,expectedVersion:version,fields:{...fields,duty:'完整定义更新'}}
 await assert.rejects(roles.edit(f.owner,input),{code:'teloa/conflict'})
 await new RoleDelegationService(env.pool,identity).change(f.owner,{requestId:randomUUID(),roleId:id,expectedRoleVersion:version,expectedVersion:d.version,action:'pause'})
 const updated=await roles.edit(f.owner,input);assert.equal(updated.state,'active');assert.equal(updated.version,version+1)
 assert.throws(admission.assertCurrent,{code:'teloa/forbidden'})
 const historical=await get.get(f.owner,{roleId:id});assert.equal(historical.consents.length,1);assert.equal(historical.delegations.length,1);assert.equal(historical.canEditExecution,true)
 await assert.rejects(new RoleWorkEligibilityService(env.pool).authorize(f.owner,{roleId:id,expectedRoleVersion:updated.version,scope:'general',inputSchema:'teloa.task-run-input/v2',authorization:authorization(d),groupId:null}),{code:'teloa/version-conflict'})
})

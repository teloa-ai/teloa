import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {setupRoleWork,roleFixture,insertRoleRun,identity,ownerAuthority,delegationFields} from './role-work-test-fixture.ts'
import {RoleToolGrantService,initializeRoleToolGrants} from '../src/work/role-tool-grants.ts'
import {RoleDelegationService,initializeRoleDelegations} from '../src/work/role-delegations.ts'
import {TwinExecutionConsentService,roleWorkEpoch} from '../src/work/twin-execution-consents.ts'
import {GroupAgentGrantService} from '../src/work/group-agent-grants.ts'
import {CollaborationService} from '../src/work/collaboration.ts'
import {HandoffService,initializeHandoffs} from '../src/work/handoffs.ts'
import {initializeRoleLifecycle,RoleLifecycleService} from '../src/work/role-lifecycle.ts'
import {initializeTaskRunSubagents} from '../src/work/task-run-subagents.ts'
import {initializeTaskRunRuntimeLinks} from '../src/work/task-run-runtime-links.ts'
import {initializeTaskRunFlows} from '../src/work/task-run-flows.ts'
import {authorizeRoleTaskAssignment} from '../src/work/role-task-authorization.ts'

let env:Awaited<ReturnType<typeof setupRoleWork>>
before(async()=>{env=await setupRoleWork();await initializeRoleToolGrants(env.pool);await initializeRoleDelegations(env.pool);await initializeRoleLifecycle(env.pool);await initializeHandoffs(env.pool);await initializeTaskRunSubagents(env.pool);await initializeTaskRunRuntimeLinks(env.pool);await initializeTaskRunFlows(env.pool)})
after(async()=>{await env?.close()})
const rules=[{name:'read_reference',allowed:[{id:'one',version:'v1'}]}]
const tools=()=>new RoleToolGrantService(env.pool,identity.now,async()=>{})
async function configuredTwin(){const f=await roleFixture(env.pool);await tools().change(f.owner,{roleId:f.role.id,expectedRoleVersion:1,action:'save',rules});return {...f,role:{...f.role,version:2}}}
async function delegate(f:Awaited<ReturnType<typeof configuredTwin>>,groupIds:string[]=[]){return new RoleDelegationService(env.pool,identity,ownerAuthority).change(f.owner,{requestId:randomUUID(),roleId:f.role.id,expectedRoleVersion:f.role.version,expectedVersion:null,action:'save',fields:{...delegationFields,allowedTools:['read_reference'],groupIds}})}
const authorize=(saved:{id:string;version:number})=>({kind:'delegation' as const,delegationId:saved.id,delegationVersion:saved.version})

test('Twin保持active配置工具；活跃委托、未收口及未知执行阻止配置，改工具只封旧许可',async()=>{
 const f=await configuredTwin(),delegations=new RoleDelegationService(env.pool,identity,ownerAuthority)
 assert.equal((await env.pool.query('select state from teloa_roles where id=$1',[f.role.id])).rows[0].state,'active')
 const saved=await delegate(f),command={roleId:f.role.id,expectedRoleVersion:2,action:'save',rules}
 await assert.rejects(tools().change(f.owner,command),{code:'teloa/conflict'})
 await delegations.change(f.owner,{requestId:randomUUID(),roleId:f.role.id,expectedRoleVersion:2,expectedVersion:saved.version,action:'pause'})
 const run=await insertRoleRun(env.pool,f.owner,f.role.id,f.taskId,'accepted')
 await assert.rejects(tools().change(f.owner,command),{code:'teloa/conflict'})
 await env.pool.query("update teloa_task_runs set state='ended',evidence=null where id=$1",[run])
 await assert.rejects(tools().change(f.owner,command),{code:'teloa/conflict'})
 await env.pool.query("update teloa_task_runs set evidence=$2 where id=$1",[run,JSON.stringify({state:'ended',turn:0,messageSeq:1,endSeq:2,reason:'completed'})])
 const epoch=roleWorkEpoch(f.owner,f.role.id),configured=await tools().change(f.owner,command)
 assert.equal(configured.roleVersion,3);assert.ok(roleWorkEpoch(f.owner,f.role.id)>epoch)
 assert.equal((await env.pool.query('select count(*)::int n from teloa_twin_execution_consents where owner_id=$1',[f.owner])).rows[0].n,0)
 await assert.rejects(new RoleLifecycleService(env.pool,identity).change(f.owner,{roleId:f.role.id,expectedVersion:3,action:'pause',reason:'不能代替停用委托'}),{code:'teloa/conflict'})
})

test('Twin群默认不自动Run；首次显式群范围→本人委托→本人确认→开启Run闭环，续签不造许可',async()=>{
 const f=await configuredTwin(),groups=new CollaborationService(env.pool,identity),grants=new GroupAgentGrantService(env.pool,identity.now)
 const group=await groups.create(f.owner,{requestId:randomUUID(),expectedVersion:0,fields:{name:'核验群',scope:'general',announcement:'明确范围',rules:{historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true},memberRoleIds:[f.role.id]}})
 const initial=await grants.get(f.owner,{groupId:group.id,roleId:f.role.id});assert.equal(initial.grant?.canAutoRun,false)
 const base={groupId:group.id,roleId:f.role.id,expectedGroupVersion:group.version,expectedRoleVersion:2,resources:[],canPost:true}
 await assert.rejects(grants.change(f.owner,{...base,requestId:randomUUID(),action:'save',canAutoRun:true}),{code:'teloa/forbidden'})
 await grants.change(f.owner,{...base,requestId:randomUUID(),action:'save',canAutoRun:false})
 const saved=await delegate(f,[group.id])
 await assert.rejects(grants.change(f.owner,{...base,requestId:randomUUID(),action:'save',canAutoRun:true}),{code:'teloa/forbidden'})
 const consent=await new TwinExecutionConsentService(env.pool,identity,ownerAuthority).confirm(f.owner,{requestId:randomUUID(),roleId:f.role.id,expectedRoleVersion:2,authorization:authorize(saved)})
 await grants.change(f.owner,{...base,requestId:randomUUID(),action:'save',canAutoRun:true})
 const updated=await groups.change(f.owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:1,fields:{name:'核验群更新',announcement:group.announcement,rules:group.rules,memberRoleIds:[f.role.id],pinned:false,archived:false}})
 assert.equal((await grants.get(f.owner,{groupId:group.id,roleId:f.role.id})).grant?.canAutoRun,true)
 await new TwinExecutionConsentService(env.pool,identity).revoke(f.owner,{requestId:randomUUID(),consentId:consent.id,expectedVersion:1})
 assert.equal((await grants.get(f.owner,{groupId:group.id,roleId:f.role.id})).status,'invalidated')
 await groups.change(f.owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:updated.version,fields:{name:'撤销后更新',announcement:group.announcement,rules:group.rules,memberRoleIds:[f.role.id],pinned:false,archived:false}})
 assert.equal((await grants.get(f.owner,{groupId:group.id,roleId:f.role.id})).grant?.canAutoRun,false)
 assert.equal((await env.pool.query("select count(*)::int n from teloa_twin_execution_consents where owner_id=$1 and state='active'",[f.owner])).rows[0].n,0)
})

test('委托空工具、旧回执与不完整职责不能接新工作；同意另一范围不能借用于当前任务',async()=>{
 const f=await configuredTwin(),db=await env.pool.connect()
 try{
  const saved=await delegate(f)
  const consent=await new TwinExecutionConsentService(env.pool,identity,ownerAuthority).confirm(f.owner,{requestId:randomUUID(),roleId:f.role.id,expectedRoleVersion:2,authorization:authorize(saved)})
  const check=async(role=f.role,scope='general')=>{try{await db.query('begin');await db.query('select id from teloa_roles where owner_id=$1 and id=$2 for update',[f.owner,f.role.id]);return await authorizeRoleTaskAssignment(db,env.pool,f.owner,role,scope)}finally{await db.query('rollback')}}
  await assert.rejects(check(f.role,'research'),{code:'teloa/conflict'})
  await env.pool.query("update teloa_role_work_delegations set fields=jsonb_set(fields,'{allowedTools}','[]') where id=$1",[saved.id])
  await assert.rejects(check(),{code:'teloa/forbidden'})
  await env.pool.query("update teloa_role_work_delegations set fields=jsonb_set(fields,'{allowedTools}','[\"read_reference\"]'),version=version+1 where id=$1",[saved.id])
  await assert.rejects(check(),{code:'teloa/forbidden'})
  assert.equal(consent.state,'active')
  const {responsibility,...incomplete}=f.role
  await assert.rejects(check(incomplete),{code:'teloa/conflict'})
 }finally{await db.query('rollback');db.release()}
})

test('群编辑与成员群授权同时写入遵循role→group，不死锁且不会续出Twin执行许可',{timeout:12000},async()=>{
 const f=await configuredTwin(),groups=new CollaborationService(env.pool,identity),grants=new GroupAgentGrantService(env.pool,identity.now)
 const group=await groups.create(f.owner,{requestId:randomUUID(),expectedVersion:0,fields:{name:'并发群',scope:'general',announcement:'核验锁序',rules:{historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true},memberRoleIds:[f.role.id]}})
 const results=await Promise.allSettled([
  groups.change(f.owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:1,fields:{name:'群设置变化',announcement:group.announcement,rules:group.rules,memberRoleIds:[f.role.id],pinned:false,archived:false}}),
  grants.change(f.owner,{requestId:randomUUID(),groupId:group.id,roleId:f.role.id,expectedGroupVersion:1,expectedRoleVersion:2,action:'save',resources:[],canPost:true,canAutoRun:false}),
 ])
 assert.equal(results[0].status,'fulfilled')
 if(results[1].status==='rejected')assert.equal(results[1].reason.code,'teloa/version-conflict')
 assert.equal((await grants.get(f.owner,{groupId:group.id,roleId:f.role.id})).grant?.canAutoRun,false)
 assert.equal((await env.pool.query('select count(*)::int n from teloa_twin_execution_consents where owner_id=$1',[f.owner])).rows[0].n,0)
})

test('改派Twin仅接受现有本人委托，内容版本变更而self清除旧授权',async()=>{
 const f=await configuredTwin(),source=await roleFixture(env.pool,'employee'),service=new HandoffService(env.pool,identity)
 await env.pool.query('update teloa_tasks set owner_id=$2,assignee_role_id=null,assignee_role_version=null where id=$1',[source.taskId,f.owner])
 const target={kind:'role' as const,roleId:f.role.id,expectedRoleVersion:2},request={requestId:randomUUID(),taskId:source.taskId,expectedTaskVersion:1,target,note:'明确改派'}
 await assert.rejects(service.change(f.owner,request),{code:'teloa/forbidden'})
 const saved=await delegate(f)
 await assert.rejects(service.change(f.owner,request),{code:'teloa/forbidden'})
 await new TwinExecutionConsentService(env.pool,identity,ownerAuthority).confirm(f.owner,{requestId:randomUUID(),roleId:f.role.id,expectedRoleVersion:2,authorization:authorize(saved)})
 const changed=await service.change(f.owner,request);assert.equal(changed.task.assigneeRoleId,f.role.id);assert.equal(changed.task.contentVersion,2)
 assert.deepEqual((await env.pool.query('select execution_authorization from teloa_tasks where id=$1',[source.taskId])).rows[0].execution_authorization,authorize(saved))
 const self=await service.change(f.owner,{requestId:randomUUID(),taskId:source.taskId,expectedTaskVersion:2,target:{kind:'self'},note:'本人接管'})
 assert.equal(self.task.assigneeRoleId,null);assert.equal(self.task.contentVersion,3);assert.equal((await env.pool.query('select execution_authorization from teloa_tasks where id=$1',[source.taskId])).rows[0].execution_authorization,null)
})

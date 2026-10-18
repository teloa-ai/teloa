import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {Pool,stopTestContainer} from './postgres-test-lifecycle.ts'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {initializeTeloaDatabase} from '../src/work/initialize-database.ts'
import {CollaborationService} from '../src/work/collaboration.ts'
import {GroupAgentGrantService} from '../src/work/group-agent-grants.ts'
import {GroupTaskService} from '../src/work/group-tasks.ts'
import {TaskService} from '../src/work/tasks.ts'
import {RoleService} from '../src/work/roles.ts'
import {readGroupTaskBusinessGrant} from '../src/work/group-task-business-grant.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'
import {BusinessTaskService} from '../src/work/business-tasks.ts'
import {businessObjectSnapshotHash} from '../src/work/business-data.ts'
import {readRunGroupContext} from '../src/work/task-run-group-context.ts'
import {RoleWorkEligibilityService} from '../src/work/role-work-eligibility.ts'

let container:StartedPostgreSqlContainer,pool:Pool,tick=0
const identity={id:randomUUID,now:()=>new Date(Date.parse('2026-10-14T09:00:00.000Z')+(tick++)*1000).toISOString()}
const rules={historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true}
before(async()=>{container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()});await initializeTeloaDatabase(pool)},{timeout:120000})
after(async()=>{await pool?.end();await stopTestContainer(container)})

/** 业务群里经路由派出的群任务，加一条已被原生受理的 Run（task_state_version 为开始运行后的任务版本）。 */
async function fixture(scope='SOC',executionMode:'work'|'reply'='work',groupScope=scope){
 const owner='business-grant-test:'+randomUUID(),roles=new RoleService(pool,identity),groups=new CollaborationService(pool,identity),grants=new GroupAgentGrantService(pool,identity.now)
 const role=await roles.create(owner,{requestId:randomUUID(),fields:{name:'记录员',kind:'employee',scopes:[scope],duty:'维护客户记录',dataScope:'本群消息',executionScope:'准备记录修改',skills:[],knowledge:[],responsibility:testRoleResponsibility}})
 const group=await groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:{name:'客户群',scope:groupScope,announcement:'',rules,memberRoleIds:[role.id]}})
 await grants.change(owner,{requestId:randomUUID(),groupId:group.id,roleId:role.id,expectedGroupVersion:group.version,expectedRoleVersion:role.version,action:'save',resources:[],canPost:true,canAutoRun:true})
 const asked=await groups.send(owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:group.version,text:'新增一条客户记录。'})
 const service=new GroupTaskService(pool,identity,new TaskService(pool,identity)),request={requestId:randomUUID(),groupId:group.id,messageId:asked.id,expectedGroupVersion:group.version,goal:'新增客户记录',assignee:{roleId:role.id,expectedVersion:role.version},trigger:'routed',executionMode,routingAttemptVersion:1,...(groupScope!==scope?{businessTarget:{scope}}:{})}
 const {task,source}=await service.create(owner,request)
 const running=(await pool.query("update teloa_tasks set state='running',version=version+1 where owner_id=$1 and id=$2 returning version",[owner,task.id])).rows[0].version
 const sessionId=randomUUID(),runId=randomUUID()
 await pool.query(`insert into teloa_task_runs(id,owner_id,request_id,request_spec,task_id,role_id,task_version,role_version,link_version,session_id,native_request_id,state,input_text,created_at,task_state_version)
  values($1,$2,$3,'{}',$4,$5,$6,$7,1,$8,$9,'active','{}',now(),$10)`,[runId,owner,randomUUID(),task.id,role.id,running-1,role.version,sessionId,randomUUID(),running])
 const control=async(state:string)=>pool.query('update teloa_work_controls set state=$3 where owner_id=$1 and id=(select round_control_id from teloa_task_work_lineage where owner_id=$1 and task_id=$2)',[owner,task.id,state])
 return {owner,group,role,task,source,service,request,sessionId,runId,grants,control,read:()=>readGroupTaskBusinessGrant(pool,owner,sessionId)}
}

test('通用协作群的明确工作固定原业务，重试不重复建任务，也不能改目标业务或扩大整群范围',async()=>{
 const f=await fixture('SOC','work','general'),grant=await f.read()
 assert.equal(f.group.scope,'general');assert.equal(f.task.scope,'SOC');assert.equal(grant.scope,'SOC')
 assert.equal(f.source.schema,'teloa.group-task-source/v2');assert.deepEqual('businessTarget'in f.source?f.source.businessTarget:undefined,{scope:'SOC'})
 assert.equal((await f.service.create(f.owner,f.request)).task.id,f.task.id)
 await assert.rejects(f.service.create(f.owner,{...f.request,businessTarget:{scope:'AppSec'}}),{code:'teloa/conflict'})
 await assert.rejects(f.service.create(f.owner,{...f.request,requestId:randomUUID(),businessTarget:{scope:'AppSec'}}),{code:'teloa/forbidden'})
 await pool.query("update teloa_tasks set definition=jsonb_set(definition,'{scope}','\"AppSec\"') where id=$1",[f.task.id])
 await assert.rejects(f.read(),{code:'teloa/forbidden'},'任务定义不能迁移离开固定业务')
})

test('本人从通用群创建业务工作，原对象沿现有固定快照注入，主群/话题与幂等不改',async()=>{
 const f=await fixture('SOC','work','general'),tasks=new TaskService(pool,identity),objects=new BusinessTaskService(pool,identity,tasks)
 const snapshot={scope:'SOC',type:'alert',id:'original-alert',version:2,title:'原告警',source:'本地记录',observedAt:identity.now(),receivedAt:identity.now(),quality:'complete' as const,summary:'原业务证据',fields:[{label:'状态',value:'待核对'}]},snapshotHash=businessObjectSnapshotHash(snapshot)
 await pool.query('insert into teloa_business_object_snapshots(owner_id,scope_id,object_type,object_id,object_version,snapshot_hash,snapshot,source_id,first_seen_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9)',[f.owner,'SOC','alert',snapshot.id,2,snapshotHash,JSON.stringify(snapshot),'original-source',identity.now()])
 const reference={scope:'SOC',type:'alert',id:snapshot.id,version:2,snapshotHash},request={requestId:randomUUID(),groupId:f.group.id,messageId:f.source.messageId,expectedGroupVersion:f.group.version,goal:'核对原告警并维护其原业务记录。',assignee:{roleId:f.role.id,expectedVersion:f.role.version},businessTarget:{scope:'SOC',object:reference}}
 const created=await f.service.create(f.owner,request)
 assert.equal(created.source.trigger,'manual');assert.equal(created.source.schema,'teloa.group-task-source/v2');assert.equal(created.task.scope,'SOC')
 assert.equal(created.source.rootId,f.source.rootId)
 const db=await pool.connect()
 try{
  const context=await objects.contextInTransaction(db,{ownerId:f.owner,scopeIds:['SOC']},{taskId:created.task.id})
  assert.equal(context?.source.sourceId,'original-source');assert.deepEqual(context?.source.reference,reference);assert.equal(context?.object.summary,'原业务证据')
  const groupContext=await readRunGroupContext(db,f.owner,created.task,f.role,undefined,pool)
  assert.equal(groupContext?.groupId,f.group.id);assert.equal(groupContext?.source.messageId,f.source.messageId)
 }finally{db.release()}
 assert.equal((await f.service.create(f.owner,request)).task.id,created.task.id)
 await assert.rejects(f.service.create(f.owner,{...request,requestId:randomUUID(),businessTarget:{scope:'SOC',object:{...reference,snapshotHash:'f'.repeat(64)}}}),{code:'teloa/version-conflict'})
 const admission=await new RoleWorkEligibilityService(pool).authorize(f.owner,{roleId:f.role.id,expectedRoleVersion:f.role.version,scope:'SOC',inputSchema:'teloa.task-run-input/v2',authorization:{kind:'task',taskId:created.task.id,taskContentVersion:1},groupId:f.group.id})
 admission.assertCurrent()
 await assert.rejects(new RoleWorkEligibilityService(pool).authorize(f.owner,{roleId:f.role.id,expectedRoleVersion:f.role.version,scope:'AppSec',inputSchema:'teloa.task-run-input/v2',authorization:{kind:'task',taskId:created.task.id,taskContentVersion:1},groupId:f.group.id}),{code:'teloa/forbidden'})
})

test('群明确工作的业务修改授权：宿主事实齐全时给出固定指纹；停止、暂停、来源摘要变化与非本工作会话均拒绝',async()=>{
 const f=await fixture(),grant=await f.read()
 assert.deepEqual({scope:grant.scope,taskId:grant.taskId,runId:grant.runId,groupId:grant.groupId,roleId:grant.roleId},{scope:'SOC',taskId:f.task.id,runId:f.runId,groupId:f.group.id,roleId:f.role.id})
 assert.equal((await f.read()).fingerprint,grant.fingerprint,'同一事实同一指纹')
 await assert.rejects(readGroupTaskBusinessGrant(pool,f.owner,randomUUID()),{code:'teloa/forbidden'},'不是这项工作的会话')
 await assert.rejects(readGroupTaskBusinessGrant(pool,'other-owner',f.sessionId),{code:'teloa/forbidden'},'别人的工作')
 await f.control('paused');await assert.rejects(f.read(),{code:'teloa/forbidden'},'原工作暂停');await f.control('active')
 await pool.query('update teloa_task_runs set stop_requested_at=now() where id=$1',[f.runId]);await assert.rejects(f.read(),{code:'teloa/forbidden'},'原 Run 已要求停止')
 await pool.query('update teloa_task_runs set stop_requested_at=null where id=$1',[f.runId]);assert.equal((await f.read()).fingerprint,grant.fingerprint)
 await pool.query("update teloa_group_task_sources set source_snapshot=jsonb_set(source_snapshot,'{messageText}','\"改过的原文\"') where task_id=$1",[f.task.id])
 await assert.rejects(f.read(),{code:'teloa/forbidden'},'来源摘要变化')
})

test('交流回应、非业务群、撤权与原工作已变化均拒绝',async()=>{
 await assert.rejects((await fixture('SOC','reply')).read(),{code:'teloa/forbidden'},'reply 不能修改业务记录')
 await assert.rejects((await fixture('general')).read(),{code:'teloa/forbidden'},'非业务群')
 const revoked=await fixture()
 await revoked.grants.change(revoked.owner,{requestId:randomUUID(),groupId:revoked.group.id,roleId:revoked.role.id,expectedGroupVersion:revoked.group.version,expectedRoleVersion:revoked.role.version,action:'revoke',resources:[],canPost:false,canAutoRun:false})
 await assert.rejects(revoked.read(),{code:'teloa/forbidden'},'撤权')
 const changed=await fixture()
 await pool.query('update teloa_tasks set version=version+1 where id=$1',[changed.task.id])
 await assert.rejects(changed.read(),{code:'teloa/forbidden'},'原工作版本已变化')
})

test('采用事务内复用执行准入：同一连接先取准入再读宿主事实；准入拒绝（岗位暂停、撤工具或撤委托）即不能采用',async()=>{
 const f=await fixture(),db=await pool.connect()
 try{
  await db.query('begin')
  const seen:unknown[]=[]
  const grant=await readGroupTaskBusinessGrant(db,f.owner,f.sessionId,async runId=>{seen.push(runId);return {assertCurrent:()=>{seen.push('checked')}}})
  assert.deepEqual(seen,[f.runId,'checked']);assert.equal(grant.runId,f.runId)
  await assert.rejects(readGroupTaskBusinessGrant(db,f.owner,f.sessionId,async()=>{throw Object.assign(new Error('员工已暂停'),{code:'teloa/forbidden'})}),{code:'teloa/forbidden'})
  await db.query('rollback')
 }finally{db.release()}
})

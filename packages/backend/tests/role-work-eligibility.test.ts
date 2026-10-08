import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {setupRoleWork,loadRoleWorkModule,roleFixture,identity,ownerAuthority,delegationFields} from './role-work-test-fixture.ts'
import {CollaborationService} from '../src/work/collaboration.ts'
import {GroupAgentGrantService} from '../src/work/group-agent-grants.ts'
import {RoleToolGrantService,initializeRoleToolGrants} from '../src/work/role-tool-grants.ts'
let env:Awaited<ReturnType<typeof setupRoleWork>>,api:Record<string,any>,consentApi:Record<string,any>,delegationApi:Record<string,any>
before(async()=>{env=await setupRoleWork();api=await loadRoleWorkModule('role-work-eligibility');consentApi=await loadRoleWorkModule('twin-execution-consents');delegationApi=await loadRoleWorkModule('role-delegations');if(consentApi.initializeTwinExecutionConsents)await consentApi.initializeTwinExecutionConsents(env.pool);if(delegationApi.initializeRoleDelegations)await delegationApi.initializeRoleDelegations(env.pool)})
after(async()=>{await env?.close()})
const service=()=>{assert.equal(typeof api.RoleWorkEligibilityService,'function','需要统一服务端运行资格闸');return new api.RoleWorkEligibilityService(env.pool)}
test('默认分身无本人回执拒绝，新Run快照固定完整职责；状态版本不影响内容许可',async()=>{
 const {owner,role,taskId,authorization}=await roleFixture(env.pool),eligibility=service(),input={roleId:role.id,expectedRoleVersion:1,scope:'general',inputSchema:'teloa.task-run-input/v2',authorization,groupId:null}
 await assert.rejects(eligibility.authorize(owner,input),{code:'teloa/forbidden'})
 const consents=new consentApi.TwinExecutionConsentService(env.pool,identity,ownerAuthority)
 const consent=await consents.confirm(owner,{requestId:randomUUID(),roleId:role.id,expectedRoleVersion:1,authorization})
 await env.pool.query("update teloa_tasks set version=version+1,state='running' where id=$1",[taskId])
 const result=await eligibility.authorize(owner,input);assert.equal(result.snapshot.kind,'twin');assert.deepEqual(result.snapshot.responsibility,role.responsibility);assert.deepEqual(result.snapshot.twinConsent,{id:consent.id,version:1});result.assertCurrent()
 await consents.revoke(owner,{requestId:randomUUID(),consentId:consent.id,expectedVersion:1})
 assert.throws(result.assertCurrent)
 await assert.rejects(eligibility.authorize(owner,input),{code:'teloa/forbidden'})
})
test('未知schema/归属/内容版本/缺职责均拒绝；employee沿本人Task授权运行',async()=>{
 const {owner,role,taskId,authorization}=await roleFixture(env.pool,'employee'),eligibility=service(),input={roleId:role.id,expectedRoleVersion:1,scope:'general',inputSchema:'teloa.task-run-input/v2',authorization,groupId:null}
 const result=await eligibility.authorize(owner,input);assert.equal(result.snapshot.twinConsent,null)
 await assert.rejects(eligibility.authorize('other',input),{code:'teloa/forbidden'})
 await assert.rejects(eligibility.authorize(owner,{...input,inputSchema:'v1'}),{code:'teloa/invalid-input'})
 await assert.rejects(eligibility.authorize(owner,{...input,controlGeneration:1}),{code:'teloa/invalid-input'})
 await env.pool.query('update teloa_tasks set content_version=2 where id=$1',[taskId])
 await assert.rejects(eligibility.authorize(owner,input),{code:'teloa/version-conflict'})
 await env.pool.query('update teloa_tasks set content_version=1 where id=$1',[taskId])
 await env.pool.query("update teloa_roles set definition=definition-'responsibility' where id=$1",[role.id])
 await assert.rejects(eligibility.authorize(owner,input),{code:'teloa/conflict'})
})
test('同角色双Task持有共享角色锁后并发核资格，不升级为独占锁死锁',async()=>{
 const {owner,role,taskId}=await roleFixture(env.pool,'employee'),eligibility=service(),secondTaskId=randomUUID()
 await env.pool.query(`insert into teloa_tasks(id,owner_id,request_id,request_spec,definition,version,content_version,state,assignee_role_id,assignee_role_version,created_at,updated_at)
  select $1,owner_id,$2,'{}',definition,1,1,'ready',assignee_role_id,assignee_role_version,now(),now() from teloa_tasks where id=$3`,[secondTaskId,randomUUID(),taskId])
 const clients=await Promise.all([env.pool.connect(),env.pool.connect()]),taskIds=[taskId,secondTaskId]
 try{
  await Promise.all(clients.map(async(db,index)=>{await db.query('begin');await db.query('select id from teloa_roles where owner_id=$1 and id=$2 for share',[owner,role.id]);await db.query('select id from teloa_tasks where owner_id=$1 and id=$2 for update',[owner,taskIds[index]])}))
  const admissions=await Promise.all(clients.map(async(db,index)=>{
   try{const result=await eligibility.authorize(owner,{roleId:role.id,expectedRoleVersion:1,scope:'general',inputSchema:'teloa.task-run-input/v2',authorization:{kind:'task',taskId:taskIds[index],taskContentVersion:1},groupId:null},db);await db.query('commit');return result}
   catch(error){await db.query('rollback');throw error}
  }))
  assert.deepEqual(admissions.map(result=>result.snapshot.id),[role.id,role.id])
 }finally{await Promise.all(clients.map(async db=>{await db.query('rollback');db.release()}))}
})
test('长期委托限制实际范围和资源，旧角色版本/旧委托回执不自动续签',async()=>{
 const {owner,role}=await roleFixture(env.pool),eligibility=service(),delegations=new delegationApi.RoleDelegationService(env.pool,identity,ownerAuthority)
 const saved=await delegations.change(owner,{requestId:randomUUID(),roleId:role.id,expectedRoleVersion:1,expectedVersion:null,action:'save',fields:delegationFields})
 const authorization={kind:'delegation',delegationId:saved.id,delegationVersion:saved.version},input={roleId:role.id,expectedRoleVersion:1,scope:'general',inputSchema:'teloa.task-run-input/v2',authorization,groupId:null}
 await new consentApi.TwinExecutionConsentService(env.pool,identity,ownerAuthority).confirm(owner,{requestId:randomUUID(),roleId:role.id,expectedRoleVersion:1,authorization})
 const result=await eligibility.authorize(owner,input);assert.deepEqual(result.limits.allowedTools,[]);assert.deepEqual(result.limits.knowledgeIds,[])
 await assert.rejects(eligibility.authorize(owner,{...input,scope:'research'}),{code:'teloa/forbidden'})
 await delegations.change(owner,{requestId:randomUUID(),roleId:role.id,expectedRoleVersion:1,expectedVersion:saved.version,action:'pause'})
 assert.throws(result.assertCurrent)
 await assert.rejects(eligibility.authorize(owner,input),{code:'teloa/version-conflict'})
 await env.pool.query('update teloa_roles set version=2 where id=$1',[role.id])
 await assert.rejects(eligibility.authorize(owner,{...input,expectedRoleVersion:2}),{code:'teloa/version-conflict'})
})
test('群canAutoRun不能代替分身本人回执；群知识隔离且撤回原件立即封新准入',async()=>{
 const {owner,role,taskId,authorization}=await roleFixture(env.pool),eligibility=service(),groups=new CollaborationService(env.pool,identity)
 const group=await groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:{name:'研究群',scope:'general',announcement:'核验材料',rules:{historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true},memberRoleIds:[role.id]}})
 const resource=await groups.saveResource(owner,{requestId:randomUUID(),groupId:group.id,resourceId:randomUUID(),expectedVersion:0,title:'共享资料',markdown:'本群允许读取的版本。'})
 // 固定持久群回执，避免以另一入口对分身的旧准入判据替代本模块测试。
 await env.pool.query(`insert into teloa_group_agent_grants(group_id,owner_id,role_id,grant_version,group_version,role_version,state,resources,can_post,can_auto_run,request_id,request_spec,created_at)
 values($1,$2,$3,(select coalesce(max(grant_version),0)+1 from teloa_group_agent_grants where group_id=$1 and role_id=$3),$4,1,'active',$5,true,true,$6,'{}',now())`,[group.id,owner,role.id,group.version,JSON.stringify([{kind:'group-resource',id:resource.id,version:1}]),randomUUID()])
 await env.pool.query("update teloa_tasks set definition=definition||jsonb_build_object('groupId',$2::text) where id=$1",[taskId,group.id])
 await env.pool.query("update teloa_roles set definition=definition||jsonb_build_object('knowledge',jsonb_build_array($2::text)) where id=$1",[role.id,randomUUID()])
 const input={roleId:role.id,expectedRoleVersion:1,scope:'general',inputSchema:'teloa.task-run-input/v2',authorization,groupId:group.id}
 await assert.rejects(eligibility.authorize(owner,input),{code:'teloa/forbidden'})
 await new consentApi.TwinExecutionConsentService(env.pool,identity,ownerAuthority).confirm(owner,{requestId:randomUUID(),roleId:role.id,expectedRoleVersion:1,authorization})
 const admitted=await eligibility.authorize(owner,input);assert.deepEqual(admitted.limits.knowledgeIds,[])
 await env.pool.query('update teloa_group_resources set withdrawn_at=now() where id=$1',[resource.id])
 await assert.rejects(eligibility.authorize(owner,input),{code:'teloa/forbidden'})
})
test('首次群分身从仅发言授权保存委托并由本人确认，再单独打开群自动执行',async()=>{
 const f=await roleFixture(env.pool),{owner}=f,eligibility=service(),groups=new CollaborationService(env.pool,identity),grants=new GroupAgentGrantService(env.pool,identity.now)
 await initializeRoleToolGrants(env.pool)
 await new RoleToolGrantService(env.pool,identity.now,async()=>{}).change(owner,{roleId:f.role.id,expectedRoleVersion:1,action:'save',rules:[{name:'read_reference',allowed:[{id:'one',version:'v1'}]}]})
 const role={...f.role,version:2}
 const group=await groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:{name:'分身委托群',scope:'general',announcement:'本人复核',rules:{historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true},memberRoleIds:[role.id]}})
 const base={groupId:group.id,roleId:role.id,expectedGroupVersion:group.version,expectedRoleVersion:role.version,action:'save',resources:[],canPost:true}
 await env.pool.query(`insert into teloa_group_agent_grants(group_id,owner_id,role_id,grant_version,group_version,role_version,state,resources,can_post,can_auto_run,request_id,request_spec,created_at)
 values($1,$2,$3,(select coalesce(max(grant_version),0)+1 from teloa_group_agent_grants where group_id=$1 and role_id=$3),$4,$6,'active','[]',true,false,$5,'{}',now())`,[group.id,owner,role.id,group.version,randomUUID(),role.version])
 const saved=await new delegationApi.RoleDelegationService(env.pool,identity,ownerAuthority).change(owner,{requestId:randomUUID(),roleId:role.id,expectedRoleVersion:role.version,expectedVersion:null,action:'save',fields:{...delegationFields,allowedTools:['read_reference'],groupIds:[group.id]}})
 const authorization={kind:'delegation',delegationId:saved.id,delegationVersion:saved.version},input={roleId:role.id,expectedRoleVersion:role.version,scope:'general',inputSchema:'teloa.task-run-input/v2',authorization,groupId:group.id}
 await new consentApi.TwinExecutionConsentService(env.pool,identity,ownerAuthority).confirm(owner,{requestId:randomUUID(),roleId:role.id,expectedRoleVersion:role.version,authorization})
 await assert.rejects(eligibility.authorize(owner,input),{code:'teloa/forbidden'})
 await grants.change(owner,{...base,requestId:randomUUID(),canAutoRun:true})
 const admitted=await eligibility.authorize(owner,input);assert.deepEqual(admitted.limits.groupIds,[group.id])
})
test('同一职责可包含本人知识与群协作，但真实群目标始终排除私人知识',async()=>{
 const f=await roleFixture(env.pool),{owner}=f,eligibility=service(),groups=new CollaborationService(env.pool,identity),grants=new GroupAgentGrantService(env.pool,identity.now),resourceId=randomUUID()
 await initializeRoleToolGrants(env.pool)
 await new RoleToolGrantService(env.pool,identity.now,async()=>{}).change(owner,{roleId:f.role.id,expectedRoleVersion:f.role.version,action:'save',rules:[{name:'read_reference',anyArguments:true,allowed:[]}]})
 const role={...f.role,version:f.role.version+1}
 await env.pool.query("insert into teloa_resources(id,owner_id,revision,status,spec,created_at,updated_at) values($1,$2,1,'active',$3,now(),now())",[resourceId,owner,JSON.stringify({title:'本人资料',sourceId:'private-material',sourceVersion:'a'.repeat(64),scopeIds:['general']})])
 await env.pool.query("update teloa_roles set definition=definition||jsonb_build_object('knowledge',jsonb_build_array($2::text)) where id=$1",[role.id,resourceId])
 const group=await groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:{name:'职责协作群',scope:'general',announcement:'只共享群资料',rules:{historyVisibleToNewMembers:true,draftsVisibleInGroup:false,mentionAllAllowed:true},memberRoleIds:[role.id]}})
 const base={groupId:group.id,roleId:role.id,expectedGroupVersion:group.version,expectedRoleVersion:role.version,action:'save',resources:[],canPost:true}
 await grants.change(owner,{...base,requestId:randomUUID(),canAutoRun:false})
 const saved=await new delegationApi.RoleDelegationService(env.pool,identity,ownerAuthority).change(owner,{requestId:randomUUID(),roleId:role.id,expectedRoleVersion:role.version,expectedVersion:null,action:'save',fields:{...delegationFields,allowedTools:['read_reference'],knowledgeIds:[resourceId],groupIds:[group.id]}})
 const authorization={kind:'delegation',delegationId:saved.id,delegationVersion:saved.version},input={roleId:role.id,expectedRoleVersion:role.version,scope:'general',inputSchema:'teloa.task-run-input/v2',authorization,groupId:null}
 await new consentApi.TwinExecutionConsentService(env.pool,identity,ownerAuthority).confirm(owner,{requestId:randomUUID(),roleId:role.id,expectedRoleVersion:role.version,authorization})
 await grants.change(owner,{...base,requestId:randomUUID(),canAutoRun:true})
 assert.deepEqual((await eligibility.authorize(owner,input)).limits.knowledgeIds,[resourceId])
 assert.deepEqual((await eligibility.authorize(owner,{...input,groupId:group.id})).limits.knowledgeIds,[])
 await assert.rejects(eligibility.authorize(owner,{...input,groupId:randomUUID()}),{code:'teloa/forbidden'})
 await assert.rejects(eligibility.authorize('other',input),{code:'teloa/forbidden'})
})

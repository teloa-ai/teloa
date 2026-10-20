import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID,createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {Pool} from './postgres-test-lifecycle.ts'
import { PostgreSqlContainer,type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { RoleService,initializeRoles } from '../src/work/roles.ts'
import {initializeCollaboration} from '../src/work/collaboration.ts'
import {initializeGroupAgentGrants} from '../src/work/group-agent-grants.ts'
import {initializeTasks} from '../src/work/tasks.ts'
import {initializeTaskRuns} from '../src/work/task-runs.ts'
import {initializePlans} from '../src/work/plans.ts'
import {initializePlanOccurrences} from '../src/work/plan-occurrences.ts'
import {insertRoleRun} from './role-work-test-fixture.ts'
let container:StartedPostgreSqlContainer,pool:Pool
// 改岗位定义与恢复在岗都会在同一笔事务里按新岗位版本续签群授权（`collaboration.ts` 的 `renewRoleGrants`），
// 所以这套用例也要把群协作与群授权两张表建起来——否则岗位写口会因为表不存在整笔回滚。
before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start()
 pool=new Pool({connectionString:container.getConnectionUri()});await initializeRoles(pool);await initializeCollaboration(pool);await initializeGroupAgentGrants(pool)
 await initializeTasks(pool);await initializeTaskRuns(pool);await initializePlans(pool);await initializePlanOccurrences(pool)
})
after(async()=>{await pool?.end();await container?.stop()})
const responsibility={triggers:['收到需要核对的线索'],autonomousActions:['整理证据并给出建议'],confirmationPoints:['采取外部动作前交回本人'],escalationRules:['证据冲突时说明阻塞'],deliveryChecks:['结论包含来源和置信度']}
const legacyFields={name:'调查岗',kind:'employee',scopes:['SOC'],duty:'查证据',dataScope:'已提供资料',executionScope:'只读调查',skills:['证据核验'],knowledge:['调查手册']}
const fields={...legacyFields,responsibility}
const configuredFields={...fields,responsibility,runtimeConfig:{agentPresetId:'security-analyst'}}
const fixture=()=>({owner:randomUUID(),service:new RoleService(pool,{id:randomUUID,now:()=>new Date().toISOString()})})
async function insertLegacyRole(owner:string){
 const id=randomUUID(),requestId=randomUUID(),now=new Date()
 await pool.query("insert into teloa_roles(id,owner_id,request_id,request_spec,definition,version,state,created_at,updated_at) values($1,$2,$3,$4,$4,1,'paused',$5,$5)",[id,owner,requestId,JSON.stringify(legacyFields),now])
 return {id,requestId}
}
/** 完整配置编辑仍需暂停；本夹具不动版本以保持版本断言语义。 */
async function createPausedRole(service:RoleService,owner:string,input:{requestId:string;fields:unknown}){
 const role=await service.create(owner,input);await pool.query("update teloa_roles set state='paused' where id=$1",[role.id])
 return {...role,state:'paused' as const}
}
test('同请求并发创建只保留一个岗位；重新构造服务恢复数据',async()=>{
 const {owner,service}=fixture(),input={requestId:randomUUID(),fields}
 const [a,b]=await Promise.all([service.create(owner,input),service.create(owner,input)])
 assert.equal(a.id,b.id);assert.equal(a.state,'active');assert.equal(a.version,1)
 const restored=await new RoleService(pool,{id:randomUUID,now:()=>new Date().toISOString()}).list(owner,{})
 assert.deepEqual(restored,[a]);assert.equal((await service.list('other',{})).length,0)
 await assert.rejects(service.create(owner,{...input,fields:{...fields,name:'另一个岗位'}}),{code:'teloa/conflict'})
})
test('个人空间默认分身首次创建后稳定复用，不经招聘请求重复产生',async()=>{
 const {owner,service}=fixture()
 const [first,second]=await Promise.all([service.ensurePersonalTwin(owner),service.ensurePersonalTwin(owner)])
 assert.equal(first.id,second.id)
 assert.equal(first.kind,'twin')
 assert.equal(first.state,'active')
 assert.equal(first.name,'我的分身')
 assert.deepEqual(first.knowledge,[],'默认分身不能用说明文字伪装成已授权资料')
 assert.deepEqual((await service.list(owner,{})).map(role=>role.id),[first.id])
})
test('旧数据已有分身时默认分身复用旧记录，不新增第二个身份',async()=>{
 const {owner,service}=fixture(),legacy=await service.create(owner,{requestId:randomUUID(),fields:{...fields,name:'旧分身',kind:'twin'}})
 assert.equal((await service.ensurePersonalTwin(owner)).id,legacy.id)
 assert.equal((await service.list(owner,{})).length,1)
})
test('结构化职责与运行配置经过规范化后随岗位持久化',async()=>{
 const {owner,service}=fixture(),role=await service.create(owner,{requestId:randomUUID(),fields:{...configuredFields,responsibility:{...responsibility,triggers:['  收到需要核对的线索  ']}}})
 assert.deepEqual(role.responsibility,{...responsibility,triggers:['收到需要核对的线索']})
 assert.deepEqual(role.runtimeConfig,{agentPresetId:'security-analyst'})
 assert.deepEqual((await service.list(owner,{}))[0],role)
})
test('员工小松鼠头像随创建、恢复读取及编辑回执持久化',async()=>{
 const {owner,service}=fixture(),created=await service.create(owner,{requestId:randomUUID(),fields:{...fields,avatarKey:'researcher'}})
 assert.equal(created.avatarKey,'researcher')
 assert.equal((await service.list(owner,{}))[0]?.avatarKey,'researcher')
 await pool.query("update teloa_roles set state='paused' where id=$1",[created.id])
 const input={roleId:created.id,expectedVersion:1,expectedProfile:{name:fields.name,avatarKey:'researcher'},fields:{...fields,avatarKey:'developer'}}
 const edited=await service.edit(owner,input)
 assert.equal(edited.avatarKey,'developer')
 assert.deepEqual(await service.edit(owner,input),edited)
 assert.equal((await service.list(owner,{}))[0]?.avatarKey,'developer')
})
test('自由组合头像随创建、编辑与身份修改原样持久化，旧预设基线可改为组合',async()=>{
 const {owner,service}=fixture(),created=await service.create(owner,{requestId:randomUUID(),fields:{...fields,avatarKey:'bot:ghost:amber'}})
 assert.equal(created.avatarKey,'bot:ghost:amber')
 assert.equal((await service.list(owner,{}))[0]?.avatarKey,'bot:ghost:amber')
 const profiled=await service.updateProfile(owner,{roleId:created.id,expectedVersion:created.version,expectedProfile:{name:fields.name,avatarKey:'bot:ghost:amber'},profile:{name:fields.name,avatarKey:'researcher'}})
 assert.equal(profiled.avatarKey,'researcher')
 await pool.query("update teloa_roles set state='paused' where id=$1",[created.id])
 const edited=await service.edit(owner,{roleId:created.id,expectedVersion:profiled.version,expectedProfile:{name:fields.name,avatarKey:'researcher'},fields:{...fields,avatarKey:'bot:capsule:plum'}})
 assert.equal(edited.avatarKey,'bot:capsule:plum')
 assert.deepEqual(await service.get(owner,created.id),edited)
 await assert.rejects(service.create(owner,{requestId:randomUUID(),fields:{...fields,avatarKey:'bot:circle:ink'}}),{code:'teloa/invalid-input'})
})
test('在岗员工可以保存姓名头像职责简介，但不能顺带变更执行范围或模型',async()=>{
 const {owner,service}=fixture(),role=await service.create(owner,{requestId:randomUUID(),fields:configuredFields})
 const input={roleId:role.id,expectedVersion:role.version,expectedProfile:{name:role.name},fields:{...configuredFields,name:'小研',avatarKey:'researcher',duty:'核实信号并整理证据'}}
 const edited=await service.edit(owner,input)
 assert.equal(edited.state,'active');assert.equal(edited.name,'小研');assert.equal(edited.avatarKey,'researcher');assert.equal(edited.version,2)
 assert.deepEqual(await service.edit(owner,input),edited)
 for(const patch of [{executionScope:'允许处置'},{scopes:['sales']},{runtimeConfig:{agentPresetId:'different'}}])await assert.rejects(service.edit(owner,{roleId:role.id,expectedVersion:2,fields:{...input.fields,...patch}}),{code:'teloa/conflict'})
 await assert.rejects(service.edit(owner,{...input,fields:{...input.fields,name:'覆盖旧版本'}}),{code:'teloa/version-conflict'})
 assert.deepEqual((await service.list(owner,{}))[0],edited)
})
async function assignedTask(owner:string,roleId:string,state='ready'){
 const id=randomUUID()
 await pool.query('insert into teloa_tasks(id,owner_id,request_id,request_spec,definition,version,state,assignee_role_id,assignee_role_version,created_at,updated_at) values($1,$2,$3,\'{}\',$4,1,$5,$6,1,now(),now())',[id,owner,randomUUID(),JSON.stringify({title:'编辑期间保留的工作',goal:'核对事实',scope:'SOC',groupId:null,skills:[]}),state,roleId])
 return id
}
function lightEdit(roleId:string){return {roleId,expectedVersion:1,expectedProfile:{name:configuredFields.name},fields:{...configuredFields,name:'新名字',duty:'新简介'}}}
async function rejectBusyEdit(service:RoleService,owner:string,roleId:string){
 await assert.rejects(service.edit(owner,lightEdit(roleId)),error=>{assert.equal((error as {code:string}).code,'teloa/conflict');assert.deepEqual((error as {details:unknown}).details,{reason:'role-work-outstanding'});assert.match((error as Error).message,/完成或取消/);return true})
 assert.equal((await service.get(owner,roleId))!.version,1)
 assert.equal((await pool.query('select count(*)::int n from teloa_role_edits where role_id=$1',[roleId])).rows[0].n,0)
}
test('轻量编辑拒绝未完成任务，保留员工版本和任务；任务取消后可保存',async()=>{
 for(const state of ['ready','running','paused','waiting','blocked']){
  const {owner,service}=fixture(),role=await service.create(owner,{requestId:randomUUID(),fields:configuredFields}),taskId=await assignedTask(owner,role.id,state)
  await rejectBusyEdit(service,owner,role.id)
  assert.equal((await pool.query('select state,assignee_role_version from teloa_tasks where id=$1',[taskId])).rows[0].state,state)
  await pool.query("update teloa_tasks set state='cancelled' where id=$1",[taskId])
  assert.equal((await service.edit(owner,lightEdit(role.id))).state,'active')
 }
})
test('任务已结束但Run未收口仍拒绝轻量编辑，不自动停止Run',async()=>{
 for(const state of ['prepared','submitting','accepted','active','ended']){
  const {owner,service}=fixture(),role=await service.create(owner,{requestId:randomUUID(),fields:configuredFields}),taskId=await assignedTask(owner,role.id,'completed')
  const runId=await insertRoleRun(pool,owner,role.id,taskId,state)
  if(state==='ended')await pool.query('update teloa_task_runs set evidence=null where id=$1',[runId])
  await rejectBusyEdit(service,owner,role.id)
  assert.equal((await pool.query('select state,stop_requested_at from teloa_task_runs where id=$1',[runId])).rows[0].stop_requested_at,null)
  await pool.query("update teloa_task_runs set state='withdrawn',evidence=null where id=$1",[runId])
  assert.equal((await service.edit(owner,lightEdit(role.id))).version,2)
 }
})
test('主Run已结束但子工作尚未收口仍拒绝编辑，子工作结束后保存',async()=>{
 const {owner,service}=fixture(),role=await service.create(owner,{requestId:randomUUID(),fields:configuredFields}),taskId=await assignedTask(owner,role.id,'completed')
 const runId=await insertRoleRun(pool,owner,role.id,taskId,'ended'),reservationId=randomUUID()
 await pool.query("insert into teloa_task_run_subagents(owner_id,run_id,reservation_id,state,created_at) values($1,$2,$3,'reserved',now())",[owner,runId,reservationId])
 await rejectBusyEdit(service,owner,role.id)
 assert.equal((await pool.query('select state from teloa_task_run_subagents where owner_id=$1 and reservation_id=$2',[owner,reservationId])).rows[0].state,'reserved')
 await pool.query("update teloa_task_run_subagents set state='abandoned',ended_at=now(),stop_reason='cancelled' where owner_id=$1 and reservation_id=$2",[owner,reservationId])
 assert.equal((await service.edit(owner,lightEdit(role.id))).version,2)
})
async function linkedPlan(owner:string,roleId:string,kind:'manual'|'system-digest'){
 const id=randomUUID(),source=kind==='manual'?{kind}:{kind,roleId}
 const definition={title:'验收计划',goal:'只读小结',scope:'SOC',dataScope:'已有证据',delivery:'小结',roleId,trigger:{kind:'schedule',cadence:'daily',weekday:1,time:'23:30',timezone:'Asia/Singapore'},notificationPolicy:'silent'}
 await pool.query("insert into teloa_plans(id,owner_id,request_id,request_spec,definition,source,notification_policy,role_id,role_version,scope,version,config_version,state,created_at,updated_at) values($1,$2,$3,$4,$5,$6,'silent',$7,1,'SOC',1,1,'active',now(),now())",[id,owner,randomUUID(),JSON.stringify({fields:{...definition,expectedRoleVersion:1},source}),JSON.stringify(definition),JSON.stringify(source),roleId])
 return id
}
test('未来Auto Dream可跟随轻量编辑，已领取未派发轮次必须先处理；固定岗位版本的活动计划拒绝编辑',async()=>{
 const {owner,service}=fixture(),role=await service.create(owner,{requestId:randomUUID(),fields:configuredFields}),planId=await linkedPlan(owner,role.id,'system-digest')
 const claimId=randomUUID()
 const stored=(await pool.query('select definition,source from teloa_plans where id=$1',[planId])).rows[0],snapshot={fields:stored.definition,source:stored.source,roleVersion:1},snapshotText=JSON.stringify(snapshot)
 await pool.query("insert into teloa_plan_occurrences(id,owner_id,plan_id,plan_version,config_version,occurrence_id,scheduled_at,claimed_at,task_request_id,snapshot,snapshot_hash) values($1,$2,$3,1,1,'2026-10-11',now(),now(),$4,$5,$6)",[claimId,owner,planId,randomUUID(),snapshotText,createHash('sha256').update(snapshotText).digest('hex')])
 await rejectBusyEdit(service,owner,role.id)
 await pool.query("update teloa_plans set state='paused',version=version+1 where id=$1",[planId])
 const edited=await service.edit(owner,lightEdit(role.id));assert.equal(edited.version,2)
 const idle=fixture(),idleRole=await idle.service.create(idle.owner,{requestId:randomUUID(),fields:configuredFields})
 await linkedPlan(idle.owner,idleRole.id,'system-digest')
 assert.equal((await idle.service.edit(idle.owner,lightEdit(idleRole.id))).state,'active')
 const fixed=fixture(),fixedRole=await fixed.service.create(fixed.owner,{requestId:randomUUID(),fields:configuredFields})
 const fixedPlan=await linkedPlan(fixed.owner,fixedRole.id,'manual');await rejectBusyEdit(fixed.service,fixed.owner,fixedRole.id)
 assert.equal((await pool.query('select state,role_version from teloa_plans where id=$1',[fixedPlan])).rows[0].state,'active')
})
test('活动执行委托不因轻量编辑失效，先暂停委托后才保存',async()=>{
 const {owner,service}=fixture(),role=await service.create(owner,{requestId:randomUUID(),fields:configuredFields})
 const id=randomUUID()
 await pool.query("insert into teloa_role_work_delegations(id,owner_id,role_id,role_version,version,state,fields,created_at,updated_at) values($1,$2,$3,1,1,'active',$4,now(),now())",[id,owner,role.id,JSON.stringify({scope:'SOC',allowedTools:[],knowledgeIds:[],memoryViewId:null,groupIds:[],safeRecovery:false})])
 await rejectBusyEdit(service,owner,role.id)
 assert.equal((await pool.query('select state from teloa_role_work_delegations where id=$1',[id])).rows[0].state,'active')
 await pool.query("update teloa_role_work_delegations set state='paused' where id=$1",[id])
 assert.equal((await service.edit(owner,lightEdit(role.id))).version,2)
})
test('新建岗位必须提交完整职责，但运行配置可以保持未固定',async()=>{
 const {owner,service}=fixture()
 await assert.rejects(service.create(owner,{requestId:randomUUID(),fields:legacyFields}),{code:'teloa/invalid-input'})
 const role=await service.create(owner,{requestId:randomUUID(),fields})
 assert.deepEqual(role.responsibility,responsibility)
 assert.equal(Object.hasOwn(role,'runtimeConfig'),false)
})
test('旧岗位缺少结构化职责与运行配置时保持可读且不伪造默认值',async()=>{
 const {owner,service}=fixture();await insertLegacyRole(owner);const [role]=await service.list(owner,{})
 assert.ok(role)
 assert.equal(Object.hasOwn(role,'responsibility'),false)
 assert.equal(Object.hasOwn(role,'runtimeConfig'),false)
})
test('只读恢复接口可以按历史定义找回旧岗位',async()=>{
 const {owner,service}=fixture(),legacy=await insertLegacyRole(owner)
 const role=await service.findByRequest(owner,{requestId:legacy.requestId,expectedFields:legacyFields})
 assert.equal(role?.id,legacy.id)
 assert.equal(Object.hasOwn(role!,'responsibility'),false)
})
test('旧创建请求可按原内容找回；不存在的旧请求仍拒绝新写入，且同身份改内容冲突',async()=>{
 const {owner,service}=fixture(),legacy=await insertLegacyRole(owner)
 const recovered=await service.create(owner,{requestId:legacy.requestId,fields:legacyFields})
 assert.equal(recovered.id,legacy.id)
 await assert.rejects(service.create(owner,{requestId:legacy.requestId,fields:{...legacyFields,name:'不同岗位'}}),{code:'teloa/conflict'})
 const missingRequest=randomUUID()
 await assert.rejects(service.create(owner,{requestId:missingRequest,fields:legacyFields}),{code:'teloa/invalid-input'})
 assert.equal((await pool.query('select count(*)::int n from teloa_roles where owner_id=$1 and request_id=$2',[owner,missingRequest])).rows[0].n,0)
})
test('旧岗位再次编辑可保存完整结构且重试读取固定编辑回执',async()=>{
 const {owner,service}=fixture(),legacy=await insertLegacyRole(owner),input={roleId:legacy.id,expectedVersion:1,fields:configuredFields},edited=await service.edit(owner,input)
 assert.equal(edited.version,2)
 assert.deepEqual(edited.responsibility,responsibility)
 assert.deepEqual(edited.runtimeConfig,{agentPresetId:'security-analyst'})
 assert.deepEqual(await service.edit(owner,input),edited)
})
test('再次编辑必须提交完整职责，不能把岗位改回旧结构',async()=>{
 const {owner,service}=fixture(),role=await service.create(owner,{requestId:randomUUID(),fields:configuredFields})
 await assert.rejects(service.edit(owner,{roleId:role.id,expectedVersion:role.version,fields:legacyFields}),{code:'teloa/invalid-input'})
 assert.deepEqual((await service.list(owner,{}))[0],role)
})
test('职责与运行配置严格拒绝未知键、空白项、过长文本和非法 preset id',async()=>{
 const {owner,service}=fixture(),invalidFields=[
  {...configuredFields,responsibility:{...responsibility,other:[]}},
  {...configuredFields,responsibility:{...responsibility,triggers:['   ']}},
  {...configuredFields,responsibility:{...responsibility,triggers:['x'.repeat(1001)]}},
  {...configuredFields,runtimeConfig:{agentPresetId:'../escape'}},
  {...configuredFields,runtimeConfig:{agentPresetId:'Uppercase'}},
  {...configuredFields,runtimeConfig:{agentPresetId:'a'.repeat(121)}},
  {...configuredFields,runtimeConfig:{agentPresetId:'security-analyst',credentials:'secret'}},
 ]
 for(const candidate of invalidFields)await assert.rejects(service.create(owner,{requestId:randomUUID(),fields:candidate}),{code:'teloa/invalid-input'})
 assert.deepEqual(await service.list(owner,{}),[])
})
test('同一创建请求不能借结构化职责或运行配置变化取得旧结果',async()=>{
 const {owner,service}=fixture(),requestId=randomUUID()
 await service.create(owner,{requestId,fields:configuredFields})
 await assert.rejects(service.create(owner,{requestId,fields:{...configuredFields,responsibility:{...responsibility,deliveryChecks:['不同验收要求']}}}),{code:'teloa/conflict'})
 await assert.rejects(service.create(owner,{requestId,fields:{...configuredFields,runtimeConfig:{agentPresetId:'another-preset'}}}),{code:'teloa/conflict'})
})
test('并发编辑只有一个旧版本可以成功；创建重试不覆盖新版本',async()=>{
 const {owner,service}=fixture(),input={requestId:randomUUID(),fields},a=await createPausedRole(service,owner,input)
 const outcomes=await Promise.allSettled(['甲','乙'].map(name=>service.edit(owner,{roleId:a.id,expectedVersion:1,expectedProfile:{name:a.name},fields:{...fields,name}})))
 assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1)
 assert.equal((outcomes.find(r=>r.status==='rejected') as PromiseRejectedResult).reason.code,'teloa/version-conflict')
 const retry=await service.create(owner,input);assert.equal(retry.id,a.id);assert.equal(retry.version,2)
 await assert.rejects(service.edit('other',{roleId:a.id,expectedVersion:2,fields}),{code:'teloa/forbidden'})
})
test('输入白名单阻止伪造身份、状态、版本及非法字段；错误不产生岗位',async()=>{
 const {owner,service}=fixture()
 for(const input of [{requestId:randomUUID(),fields,ownerId:'other'},{requestId:randomUUID(),fields:{...fields,state:'active'}},{requestId:randomUUID(),fields:{...fields,kind:'admin'}},{requestId:randomUUID(),fields:{...fields,scopes:[]}},{requestId:randomUUID(),fields:{...fields,skills:[{}]}}])await assert.rejects(service.create(owner,input),{code:'teloa/invalid-input'})
 assert.deepEqual(await service.list(owner,{}),[])
})
test('损坏存储显式拒绝，不隐藏岗位',async()=>{
 const {owner,service}=fixture(),role=await service.create(owner,{requestId:randomUUID(),fields})
 await pool.query("update teloa_roles set definition=jsonb_set(definition,'{kind}','\"unknown\"') where id=$1",[role.id])
 await assert.rejects(service.list(owner,{}),{code:'teloa/storage-corrupt'})
})
test('损坏的结构化职责或运行配置数据库行显式拒绝',async()=>{
 for(const broken of [{runtimeConfig:{agentPresetId:'../escape'}},{responsibility:{...responsibility,triggers:['']}}]){
  const {owner,service}=fixture(),role=await service.create(owner,{requestId:randomUUID(),fields:configuredFields})
  await pool.query('update teloa_roles set definition=definition || $2::jsonb where id=$1',[role.id,JSON.stringify(broken)])
  await assert.rejects(service.list(owner,{}),{code:'teloa/storage-corrupt'})
 }
})
test('写入失败回滚，不留下可被重试误认为成功的岗位',async()=>{
 const {owner,service}=fixture(),input={requestId:randomUUID(),fields}
 const broken=new RoleService(pool,{id:randomUUID,now:()=> 'invalid-time'})
 await assert.rejects(broken.create(owner,input))
 assert.deepEqual(await service.list(owner,{}),[])
 const recovered=await service.create(owner,input);assert.equal(recovered.version,1)
})
test('已退役岗位及身份类型不能借编辑复活；初始化不清空已有岗位',async()=>{
 const {owner,service}=fixture(),role=await createPausedRole(service,owner,{requestId:randomUUID(),fields})
 await assert.rejects(service.edit(owner,{roleId:role.id,expectedVersion:1,fields:{...fields,kind:'twin'}}),{code:'teloa/conflict'})
 await pool.query("update teloa_roles set state='retired' where id=$1",[role.id])
 await assert.rejects(service.edit(owner,{roleId:role.id,expectedVersion:1,fields}),{code:'teloa/conflict'})
 await initializeRoles(pool);assert.equal((await service.list(owner,{}))[0]?.state,'retired')
})
test('同版本相同编辑并发或回包丢失重试返回固定回执，不重复递增',async()=>{
 const {owner,service}=fixture(),role=await createPausedRole(service,owner,{requestId:randomUUID(),fields}),input={roleId:role.id,expectedVersion:1,expectedProfile:{name:role.name},fields:{...fields,name:'修改一'}}
 const [a,b]=await Promise.all([service.edit(owner,input),service.edit(owner,input)]);assert.deepEqual(a,b);assert.equal(a.version,2)
 await service.edit(owner,{roleId:role.id,expectedVersion:2,expectedProfile:{name:'修改一'},fields:{...fields,name:'修改二'}})
 assert.deepEqual(await service.edit(owner,input),a);assert.equal((await service.list(owner,{}))[0]?.version,3)
 await assert.rejects(service.edit(owner,{...input,fields:{...fields,name:'换内容'}}),{code:'teloa/version-conflict'})
 await assert.rejects(service.edit('other',input),{code:'teloa/forbidden'})
})
test('编辑回执保存失败必须回滚岗位，回执内容损坏不能成功返回',async()=>{
 const {owner,service}=fixture(),role=await createPausedRole(service,owner,{requestId:randomUUID(),fields}),input={roleId:role.id,expectedVersion:1,expectedProfile:{name:role.name},fields:{...fields,name:'修改'}}
 await pool.query(`create function reject_test_role_receipt() returns trigger language plpgsql as $$ begin if new.role_id='${role.id}'::uuid then raise exception 'receipt unavailable'; end if; return new; end $$; create trigger reject_test_role_receipt before insert on teloa_role_edits for each row execute function reject_test_role_receipt()`)
 try{await assert.rejects(service.edit(owner,input),/receipt unavailable/);assert.equal((await service.list(owner,{}))[0]?.version,1)}finally{await pool.query('drop trigger reject_test_role_receipt on teloa_role_edits; drop function reject_test_role_receipt()')}
 await service.edit(owner,input)
 await pool.query("update teloa_role_edits set result=jsonb_set(result,'{version}','99') where role_id=$1",[role.id])
 await assert.rejects(service.edit(owner,input),{code:'teloa/storage-corrupt'})
})

test('工作中的员工修改姓名头像保持执行版本、待开始任务和运行快照，职责修改仍需收口',async()=>{
 const {owner,service}=fixture(),role=await service.create(owner,{requestId:randomUUID(),fields:configuredFields}),taskId=await assignedTask(owner,role.id)
 const request={roleId:role.id,expectedVersion:role.version,expectedProfile:{name:role.name},profile:{name:'  小研的新名字  ',avatarKey:'researcher'}}
 const saved=await service.updateProfile(owner,request)
 assert.equal(saved.name,'小研的新名字');assert.equal(saved.avatarKey,'researcher');assert.equal(saved.version,role.version)
 assert.deepEqual(saved.responsibility,role.responsibility);assert.deepEqual(saved.runtimeConfig,role.runtimeConfig)
 assert.deepEqual(await service.updateProfile(owner,request),saved,'同一保存重试返回原身份')
 assert.equal((await pool.query('select assignee_role_version,state from teloa_tasks where id=$1',[taskId])).rows[0].assignee_role_version,1)
 assert.deepEqual(await service.get(owner,role.id),saved)
 await assert.rejects(service.edit(owner,{roleId:role.id,expectedVersion:1,fields:{...configuredFields,name:saved.name,avatarKey:saved.avatarKey,duty:'新的执行职责'}}),error=>(error as {details:{reason:string}}).details?.reason==='role-work-outstanding')
 await assert.rejects(service.updateProfile(owner,{...request,profile:{name:'覆盖他人修改'}}),{code:'teloa/version-conflict'})
 await assert.rejects(service.updateProfile('other',request),{code:'teloa/forbidden'})
 await assert.rejects(service.updateProfile(owner,{...request,profile:{name:'越界',executionScope:'允许处置'}}),{code:'teloa/invalid-input'})
 await assert.rejects(service.updateProfile(owner,{...request,expectedVersion:2}),{code:'teloa/version-conflict'})
 const runId=await insertRoleRun(pool,owner,role.id,taskId,'accepted')
 const working=await service.updateProfile(owner,{...request,expectedProfile:{name:saved.name,avatarKey:saved.avatarKey},profile:{name:'运行期间改名',avatarKey:'developer'}})
 assert.equal(working.version,1)
 assert.equal((await pool.query('select role_version,state from teloa_task_runs where id=$1',[runId])).rows[0].role_version,1)
 assert.equal((await pool.query('select role_version,state from teloa_task_runs where id=$1',[runId])).rows[0].state,'accepted')
})

test('身份资料并发保存只接受一份修改，退役身份和非法头像不能保存',async()=>{
 const {owner,service}=fixture(),role=await service.create(owner,{requestId:randomUUID(),fields:configuredFields})
 const base={roleId:role.id,expectedVersion:1,expectedProfile:{name:role.name}}
 const results=await Promise.allSettled(['名字甲','名字乙'].map(name=>service.updateProfile(owner,{...base,profile:{name}})))
 assert.equal(results.filter(result=>result.status==='fulfilled').length,1)
 assert.equal(results.filter(result=>result.status==='rejected'&&result.reason.code==='teloa/version-conflict').length,1)
 const saved=(await service.get(owner,role.id))!;assert.equal(saved.version,1)
 await assert.rejects(service.updateProfile(owner,{...base,profile:{name:'非法头像',avatarKey:'https://example.org/avatar.png'}}),{code:'teloa/invalid-input'})
 await pool.query("update teloa_roles set state='retired' where id=$1",[role.id])
 await assert.rejects(service.updateProfile(owner,{...base,expectedProfile:{name:saved.name},profile:{name:'退役改名'}}),{code:'teloa/conflict'})
})

test('身份资料独立更新后旧完整编辑拒绝覆盖新身份，刷新后的职责保存可成功',async()=>{
 const {owner,service}=fixture(),role=await service.create(owner,{requestId:randomUUID(),fields:configuredFields})
 const stale={roleId:role.id,expectedVersion:1,expectedProfile:{name:role.name},fields:{...configuredFields,duty:'新职责'}}
 const renamed=await service.updateProfile(owner,{roleId:role.id,expectedVersion:1,expectedProfile:{name:role.name},profile:{name:'新的身份名',avatarKey:'researcher'}})
 await assert.rejects(service.edit(owner,stale),{code:'teloa/version-conflict'})
 await assert.rejects(service.edit(owner,{roleId:role.id,expectedVersion:1,fields:stale.fields}),{code:'teloa/version-conflict'})
 assert.deepEqual(await service.get(owner,role.id),renamed)
 const saved=await service.edit(owner,{...stale,expectedProfile:{name:renamed.name,avatarKey:renamed.avatarKey},fields:{...stale.fields,name:renamed.name,avatarKey:renamed.avatarKey}})
 assert.equal(saved.name,renamed.name);assert.equal(saved.duty,'新职责');assert.equal(saved.version,2)
})

import test,{after,before} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import type {Pool as PoolType} from 'pg'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {BusinessScopeService,BusinessSpaceService,CollaborationService,IndustryLoadService,PlanService,RoleService,TaskService,initializeCollaboration,initializeIndustryLoads,initializePlans,initializeRoles,initializeTasks,type IndustryLoadSource} from '../src/index.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'
const openGroupRules={historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true}

let container:StartedPostgreSqlContainer,pool:PoolType
before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start()
 pool=new Pool({connectionString:container.getConnectionUri()})
 // 标签表随空间表一并由加载初始化建出；任务、计划与群三张写入表也要在场，校验与计数才有真实依据。
 await initializeRoles(pool);await initializeIndustryLoads(pool);await initializeTasks(pool);await initializePlans(pool);await initializeCollaboration(pool)
},{timeout:120000})
after(async()=>{await pool?.end();await container?.stop()})

const identity={id:randomUUID,now:()=>new Date().toISOString()}
const spaces=()=>new BusinessSpaceService(pool,identity)
const scopes=()=>new BusinessScopeService(pool)
const labels=async(ownerId:string)=>Object.fromEntries((await scopes().list(ownerId)).map(item=>[item.scope,item]))
/** 引导本人空间（顺带登记内置范围），返回空间身份供 `ensure` 使用。 */
const personal=async(ownerId:string)=>(await spaces().ensurePersonal(ownerId)).id
/** 个人版只能加载到本人空间，因此引导之后的加载目标一律按当前空间版本提交。 */
const intoPersonal=async(ownerId:string)=>{const current=await spaces().current(ownerId);return {kind:'existing' as const,spaceId:current.id,expectedVersion:current.version}}

const contentHash='a'.repeat(64)
const snapshot={templateId:'finance',templateVersion:'1.0.0',title:'财务风控工作',domain:'finance',scope:'finance-ops',description:'财务风控行业模板',resources:[{localId:'work',kind:'work-template' as const,title:'对账核对',version:'1.0.0',required:true,available:true}],relations:[],entrypoints:['work']}
const source:IndustryLoadSource={read:async()=>structuredClone(snapshot)}
const loads=()=>new IndustryLoadService(pool,identity,source)
const role=async(ownerId:string,scope:string)=>{
 const created=await new RoleService(pool,identity).create(ownerId,{requestId:randomUUID(),fields:{name:'核对岗',kind:'employee',scopes:[scope],duty:'核对',dataScope:'已授权资料',executionScope:'只读整理',skills:[],knowledge:[],responsibility:testRoleResponsibility}})
 await pool.query("update teloa_roles set state='active' where id=$1",[created.id])
 return created
}
const planFields=(roleId:string,scope:string)=>({title:'每日核对',goal:'核对新增资料并形成结论。',scope,dataScope:'已授权资料。',delivery:'变化与待核对项。',roleId,expectedRoleVersion:1,trigger:{kind:'schedule' as const,cadence:'daily' as const,weekday:1,time:'09:00',timezone:'Asia/Singapore' as const},notificationPolicy:'attention' as const})
const counts=async(ownerId:string)=>({
 tasks:(await pool.query('select count(*)::int n from teloa_tasks where owner_id=$1',[ownerId])).rows[0].n as number,
 plans:(await pool.query('select count(*)::int n from teloa_plans where owner_id=$1',[ownerId])).rows[0].n as number,
 groups:(await pool.query('select count(*)::int n from teloa_groups where owner_id=$1',[ownerId])).rows[0].n as number,
})

test('登记幂等：重复登记不改已有标签的来源与标题',async()=>{
 const ownerId='local:scope-ensure',spaceId=await personal(ownerId)
 await BusinessScopeService.ensure(pool,ownerId,{scope:'finance-ops',title:'财务风控',kind:'domain',spaceId})
 await BusinessScopeService.ensure(pool,ownerId,{scope:'finance-ops',title:'改成别的标题',kind:'legacy',spaceId})
 const found=(await labels(ownerId))['finance-ops']
 assert.equal(found?.title,'财务风控');assert.equal(found?.kind,'domain')
 assert.equal((await pool.query('select count(*)::int n from teloa_business_scopes where owner_id=$1',[ownerId])).rows[0].n,4)
 for(const bad of [{scope:'',title:'空标签',kind:'domain' as const,spaceId},{scope:'x'.repeat(81),title:'过长',kind:'domain' as const,spaceId},{scope:'ok',title:'  ',kind:'domain' as const,spaceId},{scope:'ok',title:'坏来源',kind:'unknown' as unknown as 'domain',spaceId},{scope:'ok',title:'坏空间',kind:'domain' as const,spaceId:'not-a-uuid'}])
  await assert.rejects(BusinessScopeService.ensure(pool,ownerId,bad),{code:'teloa/invalid-input'})
 assert.equal((await pool.query('select count(*)::int n from teloa_business_scopes where owner_id=$1',[ownerId])).rows[0].n,4)
})

test('引导本人空间即登记三个内置范围，库里没有 Design 存量时不补历史标签',async()=>{
 const ownerId='local:scope-builtin'
 await personal(ownerId)
 const found=await labels(ownerId)
 assert.deepEqual(Object.keys(found).sort(),['AppSec','SOC','general'])
 assert.deepEqual(Object.values(found).map(item=>item.kind),['builtin','builtin','builtin'])
 assert.equal(found.general?.title,'通用工作');assert.equal(found.SOC?.title,'安全运营');assert.equal(found.AppSec?.title,'应用安全')
 // 重跑幂等：不新增行，也不改已有行。
 await spaces().ensurePersonal(ownerId)
 assert.deepEqual(await labels(ownerId),found)
})

test('库里存在 Design 存量任务时补登历史标签，允许继续写入但不作为内置范围',async()=>{
 const ownerId='local:scope-legacy'
 // 存量行绕开写入校验直接落库，模拟本次改造之前留下的 `Design` 取值。
 await pool.query("insert into teloa_tasks(id,owner_id,request_id,request_spec,definition,version,state,created_at,updated_at) values($1,$2,$3,'{}','{\"title\":\"旧稿\",\"goal\":\"设计稿核对\",\"scope\":\"Design\"}',1,'ready',now(),now())",[randomUUID(),ownerId,randomUUID()])
 await personal(ownerId)
 const found=await labels(ownerId)
 assert.equal(found.Design?.kind,'legacy');assert.equal(found.Design?.title,'设计（历史）')
 assert.equal(await BusinessScopeService.registered(pool,ownerId,'Design'),true)
 const task=await new TaskService(pool,identity).create(ownerId,{requestId:randomUUID(),fields:{title:'继续核对',goal:'沿用历史范围',scope:'Design'}})
 assert.equal(task.scope,'Design')
})

test('内置取值无行也算已登记，未登记取值为假',async()=>{
 const ownerId='local:scope-registered'
 assert.equal((await pool.query('select count(*)::int n from teloa_business_scopes where owner_id=$1',[ownerId])).rows[0].n,0)
 for(const scope of ['general','SOC','AppSec'])assert.equal(await BusinessScopeService.registered(pool,ownerId,scope),true)
 for(const scope of ['Finance','Design','finance-ops'])assert.equal(await BusinessScopeService.registered(pool,ownerId,scope),false)
 assert.equal(await BusinessScopeService.registered(pool,ownerId,'x'.repeat(81)),false)
 await assert.rejects(BusinessScopeService.registered(pool,'   ','general'),{code:'teloa/forbidden'})
})

test('标签目录汇总加载、在效加载、任务与群数量',async()=>{
 const ownerId='local:scope-list'
 await personal(ownerId)
 const first=await loads().create(ownerId,{requestId:randomUUID(),contentId:randomUUID(),contentHash,target:await intoPersonal(ownerId)})
 const second=await loads().create(ownerId,{requestId:randomUUID(),contentId:randomUUID(),contentHash:'b'.repeat(64),target:{kind:'existing',spaceId:first.space.id,expectedVersion:first.space.version}})
 await pool.query("update teloa_industry_loads set status='unloaded',unloaded_at=now() where id=$1",[second.id])
 const tasks=new TaskService(pool,identity)
 await tasks.create(ownerId,{requestId:randomUUID(),fields:{title:'对账',goal:'核对流水',scope:'finance-ops'}})
 await tasks.create(ownerId,{requestId:randomUUID(),fields:{title:'通用事项',goal:'随手记',scope:'general'}})
 await new CollaborationService(pool,identity).create(ownerId,{requestId:randomUUID(),expectedVersion:0,fields:{name:'对账协作',scope:'finance-ops',announcement:'围绕流水协作。',rules:openGroupRules,memberRoleIds:[]}})
 const found=await labels(ownerId)
 assert.deepEqual({...found['finance-ops']},{scope:'finance-ops',title:'财务风控工作',kind:'domain',loads:2,activeLoads:1,tasks:1,groups:1})
 assert.deepEqual({...found.general},{scope:'general',title:'通用工作',kind:'builtin',loads:0,activeLoads:0,tasks:1,groups:0})
})

test('任务创建与编辑拒绝未登记业务范围，且一行都不写',async()=>{
 const ownerId='local:scope-task',spaceId=await personal(ownerId),tasks=new TaskService(pool,identity)
 const before=await counts(ownerId)
 await assert.rejects(tasks.create(ownerId,{requestId:randomUUID(),fields:{title:'越权',goal:'未登记范围',scope:'Finance'}}),{code:'teloa/invalid-input',message:'业务范围未登记。'})
 assert.deepEqual(await counts(ownerId),before)
 // 编辑沿用任务原有范围：先在登记期间建任务，再撤掉标签，编辑即被同一判据拒绝。
 await BusinessScopeService.ensure(pool,ownerId,{scope:'Finance',title:'财务',kind:'domain',spaceId})
 const task=await tasks.create(ownerId,{requestId:randomUUID(),fields:{title:'可建',goal:'范围已登记',scope:'Finance'}})
 await pool.query('delete from teloa_business_scopes where owner_id=$1 and scope=$2',[ownerId,'Finance'])
 await assert.rejects(tasks.edit(ownerId,{taskId:task.id,expectedVersion:1,fields:{title:'改标题',goal:'改目标'}}),{code:'teloa/invalid-input',message:'业务范围未登记。'})
 assert.equal((await tasks.list(ownerId,{}))[0]!.version,1)
})

test('计划创建拒绝未登记业务范围，且一行都不写',async()=>{
 const ownerId='local:scope-plan',spaceId=await personal(ownerId),plans=new PlanService(pool,identity)
 const assignee=await role(ownerId,'Finance'),before=await counts(ownerId)
 await assert.rejects(plans.create(ownerId,{requestId:randomUUID(),fields:planFields(assignee.id,'Finance'),source:{kind:'manual'}}),{code:'teloa/invalid-input',message:'业务范围未登记。'})
 assert.deepEqual(await counts(ownerId),before)
 await BusinessScopeService.ensure(pool,ownerId,{scope:'Finance',title:'财务',kind:'domain',spaceId})
 const plan=await plans.create(ownerId,{requestId:randomUUID(),fields:planFields(assignee.id,'Finance'),source:{kind:'manual'}})
 assert.equal(plan.scope,'Finance')
})

test('协作群创建拒绝未登记业务范围，且一行都不写',async()=>{
 const ownerId='local:scope-group',spaceId=await personal(ownerId),groups=new CollaborationService(pool,identity)
 const fields=(scope:string)=>({name:'协作群',scope,announcement:'围绕固定证据协作。',rules:openGroupRules,memberRoleIds:[]})
 const before=await counts(ownerId)
 await assert.rejects(groups.create(ownerId,{requestId:randomUUID(),expectedVersion:0,fields:fields('Finance')}),{code:'teloa/invalid-input',message:'业务范围未登记。'})
 assert.deepEqual(await counts(ownerId),before)
 await BusinessScopeService.ensure(pool,ownerId,{scope:'Finance',title:'财务',kind:'domain',spaceId})
 assert.equal((await groups.create(ownerId,{requestId:randomUUID(),expectedVersion:0,fields:fields('Finance')})).scope,'Finance')
})

test('加载成功即登记 scope 标签，加载回包的业务范围就是 scope',async()=>{
 const ownerId='local:scope-load'
 await personal(ownerId)
 const load=await loads().create(ownerId,{requestId:randomUUID(),contentId:randomUUID(),contentHash,target:await intoPersonal(ownerId)})
 assert.equal(load.space.scope,'finance-ops')
 assert.equal((await loads().get(ownerId,{loadId:load.id})).space.scope,'finance-ops')
 const found=(await labels(ownerId))['finance-ops']
 assert.equal(found?.kind,'domain');assert.equal(found?.title,'财务风控工作')
 // 登记之后这个范围就能承接任务与计划：这正是"加载完即可在该范围里工作"的含义。
 assert.equal((await new TaskService(pool,identity).create(ownerId,{requestId:randomUUID(),fields:{title:'对账',goal:'核对流水',scope:load.space.scope}})).scope,'finance-ops')
})

test('内置范围恒排在目录最前，且按 general、SOC、AppSec 的声明次序',async()=>{
 const ownerId='local:scope-order',spaceId=await personal(ownerId)
 // 把内置行删掉再登记一个 domain 标签，随后重新引导：内置行的登记时刻晚于 domain，仍必须排在最前。
 await pool.query('delete from teloa_business_scopes where owner_id=$1',[ownerId])
 await BusinessScopeService.ensure(pool,ownerId,{scope:'finance-ops',title:'财务风控',kind:'domain',spaceId})
 await spaces().ensurePersonal(ownerId)
 assert.deepEqual((await scopes().list(ownerId)).map(item=>item.scope),['general','SOC','AppSec','finance-ops'])
})

test('行业模板的 scope 必须能当业务身份用，不合规即拒绝加载且一行都不写',async()=>{
 const ownerId='local:scope-domain'
 await personal(ownerId)
 // 中文、含空格、超过 64 位都不能当业务身份用，加载在进入写事务之前就被拒。
 for(const scope of ['安全运营','with space','x'.repeat(65),'finance.ops']){
  const bad=new IndustryLoadService(pool,identity,{read:async()=>({...structuredClone(snapshot),scope})})
  await assert.rejects(bad.create(ownerId,{requestId:randomUUID(),contentId:randomUUID(),contentHash,target:await intoPersonal(ownerId)}),{code:'teloa/invalid-input',message:'行业模板的业务范围只能是 1–64 位字母、数字、下划线或连字符。'})
 }
 assert.equal((await pool.query('select count(*)::int n from teloa_industry_loads where owner_id=$1',[ownerId])).rows[0].n,0)
 assert.deepEqual(Object.keys(await labels(ownerId)).sort(),['AppSec','SOC','general'])
 // 示例模板的取值（安全运营 `SOC`、通用研究 `general`）与 64 位上限都放行。
 for(const [index,scope] of ['SOC','general','x'.repeat(64)].entries()){
  const good=new IndustryLoadService(pool,identity,{read:async()=>({...structuredClone(snapshot),scope})})
  const load=await good.create(ownerId,{requestId:randomUUID(),contentId:randomUUID(),contentHash:String(index).repeat(64),target:await intoPersonal(ownerId)})
  assert.equal(load.space.scope,scope)
  assert.equal((await labels(ownerId))[scope]?.scope,scope)
 }
})

test('任务编辑的范围判据排在版本与状态判据之后',async()=>{
 const ownerId='local:scope-edit-order',spaceId=await personal(ownerId),tasks=new TaskService(pool,identity)
 await BusinessScopeService.ensure(pool,ownerId,{scope:'Finance',title:'财务',kind:'domain',spaceId})
 const stale=await tasks.create(ownerId,{requestId:randomUUID(),fields:{title:'旧版本',goal:'核对',scope:'Finance'}})
 const finished=await tasks.create(ownerId,{requestId:randomUUID(),fields:{title:'已结束',goal:'核对',scope:'Finance'}})
 await pool.query("update teloa_tasks set state='completed' where id=$1",[finished.id])
 await pool.query('delete from teloa_business_scopes where owner_id=$1 and scope=$2',[ownerId,'Finance'])
 // 范围已不再登记，但版本落后与任务已结束仍先报原来的错，判据顺序不被抢占。
 await assert.rejects(tasks.edit(ownerId,{taskId:stale.id,expectedVersion:2,fields:{title:'新标题',goal:'新目标'}}),{code:'teloa/version-conflict'})
 await assert.rejects(tasks.edit(ownerId,{taskId:finished.id,expectedVersion:1,fields:{title:'新标题',goal:'新目标'}}),{code:'teloa/conflict'})
 await assert.rejects(tasks.edit(ownerId,{taskId:stale.id,expectedVersion:1,fields:{title:'新标题',goal:'新目标'}}),{code:'teloa/invalid-input',message:'业务范围未登记。'})
 assert.equal((await tasks.list(ownerId,{})).every(task=>task.version===1),true)
})

test('业务范围只在当前模板数据源称呼唯一时回传专属名词',async()=>{
 const ownerId='local:scope-source-noun'
 await personal(ownerId)
 const named={...structuredClone(snapshot),domain:'security',scope:'SOC',resources:[{localId:'alert-source',kind:'data-source' as const,title:'告警接入',version:'1.0.0',required:true,available:true,sourceNoun:'告警源'}],entrypoints:['alert-source']}
 const first=new IndustryLoadService(pool,identity,{read:async()=>structuredClone(named)})
 await first.create(ownerId,{requestId:randomUUID(),contentId:randomUUID(),contentHash,target:await intoPersonal(ownerId)})
 assert.equal((await labels(ownerId)).SOC?.sourceNoun,'告警源')
 // 同一业务里混入另一种称呼时，不任选一条冒充整门业务，首页应退回通用名词。
 const different={...structuredClone(named),resources:[{...named.resources[0]!,sourceNoun:'终端记录'}]}
 const second=new IndustryLoadService(pool,identity,{read:async()=>structuredClone(different)})
 const later=await second.create(ownerId,{requestId:randomUUID(),contentId:randomUUID(),contentHash:'c'.repeat(64),target:await intoPersonal(ownerId)})
 assert.equal(Object.hasOwn((await labels(ownerId)).SOC!,'sourceNoun'),false)
 // 当前有效加载优先于历史加载；卸载异名加载后，原有的唯一称呼恢复。
 await pool.query("update teloa_industry_loads set status='unloaded',unloaded_at=now() where id=$1",[later.id])
 assert.equal((await labels(ownerId)).SOC?.sourceNoun,'告警源')
})

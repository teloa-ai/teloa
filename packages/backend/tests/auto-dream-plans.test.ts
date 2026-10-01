import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool,type PoolClient} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {RoleService,initializeRoles} from '../src/work/roles.ts'
import {TaskService,initializeTasks} from '../src/work/tasks.ts'
import {RoleLifecycleService,initializeRoleLifecycle} from '../src/work/role-lifecycle.ts'
import {PlanService,initializePlans} from '../src/work/plans.ts'
import {PlanOccurrenceService,initializePlanOccurrences} from '../src/work/plan-occurrences.ts'
import {BusinessSpaceService,initializeBusinessSpaces} from '../src/work/business-spaces.ts'
import {BusinessScopeService,initializeBusinessScopes} from '../src/work/business-scopes.ts'
import {AUTO_DREAM_DEFAULT_TRIGGER,AUTO_DREAM_PLAN_TITLE,ensureAutoDreamPlan,pauseAutoDreamPlan,readAutoDreamSetting} from '../src/work/auto-dream-plans.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'
import {initializeCollaboration} from '../src/work/collaboration.ts'
import {initializeGroupAgentGrants} from '../src/work/group-agent-grants.ts'

let container:StartedPostgreSqlContainer,pool:Pool
const identity={id:randomUUID,now:()=>new Date().toISOString()}
before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock');process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()})
 await initializeRoles(pool);await initializeCollaboration(pool);await initializeGroupAgentGrants(pool);await initializeTasks(pool);await initializeRoleLifecycle(pool);await initializePlans(pool)
 // 标签表在场，未登记范围的判据才真实生效（缺表时 `registered` 整体放行）。
 await initializeBusinessSpaces(pool);await initializeBusinessScopes(pool);await initializePlanOccurrences(pool)
})
after(async()=>{await pool?.end();await container?.stop()})
const inTransaction=async<T>(run:(client:PoolClient)=>Promise<T>):Promise<T>=>{
 const client=await pool.connect()
 try{await client.query('begin');const value=await run(client);await client.query('commit');return value}
 catch(error){await client.query('rollback');throw error}
 finally{client.release()}
}

const services=()=>{const plans=new PlanService(pool,identity),ports={plans};return {plans,roles:new RoleService(pool,identity,ports),lifecycle:new RoleLifecycleService(pool,identity,ports)}}
const employee=(scopes:string[])=>({name:'调查岗',kind:'employee' as const,scopes,duty:'调查',dataScope:'资料',executionScope:'仅声明',skills:[],knowledge:[],responsibility:testRoleResponsibility})
const command=(roleId:string,expectedVersion:number,action:string)=>({roleId,expectedVersion,action,reason:'本人调整职责安排'})
const systemPlans=async(owner:string)=>(await new PlanService(pool,identity).list(owner,{})).filter(plan=>plan.source.kind==='system-digest')

test('新同事在岗即带一条启用的 Auto Dream 每日小结计划，范围取升序第一个',async()=>{
 const owner=randomUUID(),{roles}=services()
 const role=await roles.create(owner,{requestId:randomUUID(),fields:employee(['general','SOC'])})
 const plans=await systemPlans(owner)
 assert.equal(plans.length,1)
 const plan=plans[0]!
 assert.deepEqual(plan.source,{kind:'system-digest',roleId:role.id})
 assert.equal(plan.state,'active')
 assert.equal(plan.title,'Auto Dream · 每日小结')
 assert.equal(plan.title,AUTO_DREAM_PLAN_TITLE)
 assert.deepEqual(plan.trigger,{kind:'schedule',cadence:'daily',weekday:1,time:'23:30',timezone:'Asia/Singapore'})
 assert.deepEqual(plan.trigger,AUTO_DREAM_DEFAULT_TRIGGER)
 assert.equal(plan.notificationPolicy,'silent')
 assert.equal(plan.scope,'SOC')
 assert.equal(plan.roleId,role.id)
})

test('分身不产生系统计划，零系统计划时设置读不出来',async()=>{
 const owner=randomUUID(),{roles}=services()
 assert.equal(await readAutoDreamSetting(pool,owner),undefined)
 await roles.create(owner,{requestId:randomUUID(),fields:{...employee(['general']),name:'我的分身',kind:'twin'}})
 assert.equal((await systemPlans(owner)).length,0)
 assert.equal(await readAutoDreamSetting(pool,owner),undefined)
})

test('系统计划随岗位暂停、复岗与退役同步，反复切换仍只有一条',async()=>{
 const owner=randomUUID(),{roles,lifecycle}=services()
 const role=await roles.create(owner,{requestId:randomUUID(),fields:employee(['SOC'])})
 const state=async()=>{const plans=await systemPlans(owner);assert.equal(plans.length,1);return plans[0]!.state}
 assert.equal(await state(),'active')
 await lifecycle.change(owner,command(role.id,1,'pause'));assert.equal(await state(),'paused')
 await lifecycle.change(owner,command(role.id,2,'resume'));assert.equal(await state(),'active')
 await lifecycle.change(owner,command(role.id,3,'pause'));assert.equal(await state(),'paused')
 await lifecycle.change(owner,command(role.id,4,'resume'));assert.equal(await state(),'active')
 await lifecycle.change(owner,command(role.id,5,'retire'));assert.equal(await state(),'paused')
 // 随退役 paused 的计划不算「本人关掉了小结」：在岗同事归零时设置回落成默认开启。
 assert.equal((await readAutoDreamSetting(pool,owner))?.enabled,true)
})

test('本人关掉小结后新同事跟随设置，只建不启用',async()=>{
 const owner=randomUUID(),{roles,plans}=services()
 const first=await roles.create(owner,{requestId:randomUUID(),fields:employee(['SOC'])})
 const current=(await systemPlans(owner))[0]!
 await plans.change(owner,{planId:current.id,requestId:randomUUID(),expectedVersion:current.version,action:'pause'})
 assert.deepEqual(await readAutoDreamSetting(pool,owner),{enabled:false,trigger:AUTO_DREAM_DEFAULT_TRIGGER})
 const second=await roles.create(owner,{requestId:randomUUID(),fields:{...employee(['SOC']),name:'核对岗'}})
 const all=await systemPlans(owner)
 assert.equal(all.length,2)
 assert.equal(all.find(plan=>plan.roleId===first.id)?.state,'paused')
 assert.equal(all.find(plan=>plan.roleId===second.id)?.state,'paused')
})

test('未接线端口的岗位与生命周期服务照旧工作，不碰系统计划',async()=>{
 const owner=randomUUID()
 const role=await new RoleService(pool,identity).create(owner,{requestId:randomUUID(),fields:employee(['SOC'])})
 assert.equal(role.state,'active')
 assert.equal((await systemPlans(owner)).length,0)
 await new TaskService(pool,identity).create(owner,{requestId:randomUUID(),fields:{title:'调查',goal:'核对来源',scope:'SOC'},assignee:{roleId:role.id,expectedVersion:1}})
 // 生命周期服务同样：接线的建出计划，未接线的那个暂停岗位时不动它。
 const wired=randomUUID(),{roles}=services(),other=await roles.create(wired,{requestId:randomUUID(),fields:employee(['SOC'])})
 await new RoleLifecycleService(pool,identity).change(wired,command(other.id,1,'pause'))
 assert.equal((await systemPlans(wired))[0]?.state,'active')
})

test('岗位暂停期间收窄范围，复岗照常成功而小结留在暂停',async()=>{
 const owner=randomUUID(),{roles,lifecycle}=services()
 const role=await roles.create(owner,{requestId:randomUUID(),fields:employee(['SOC','general'])})
 assert.equal((await systemPlans(owner))[0]?.scope,'SOC')
 await lifecycle.change(owner,command(role.id,1,'pause'))
 await roles.edit(owner,{roleId:role.id,expectedVersion:2,fields:employee(['general'])})
 const resumed=await lifecycle.change(owner,command(role.id,3,'resume'))
 assert.equal(resumed.role.state,'active')
 const plans=await systemPlans(owner)
 assert.equal(plans.length,1);assert.equal(plans[0]?.state,'paused');assert.equal(plans[0]?.scope,'SOC')
})

test('退役同事的系统计划不能手工重新启用',async()=>{
 const owner=randomUUID(),{roles,lifecycle,plans}=services()
 const role=await roles.create(owner,{requestId:randomUUID(),fields:employee(['SOC'])})
 await lifecycle.change(owner,command(role.id,1,'retire'))
 const plan=(await systemPlans(owner))[0]!
 assert.equal(plan.state,'paused')
 await assert.rejects(plans.change(owner,{planId:plan.id,requestId:randomUUID(),expectedVersion:plan.version,action:'enable'}),{code:'teloa/conflict'})
})

test('唯一同事退役后再招新人，小结仍按默认开启',async()=>{
 const owner=randomUUID(),{roles,lifecycle}=services()
 const first=await roles.create(owner,{requestId:randomUUID(),fields:employee(['SOC'])})
 await lifecycle.change(owner,command(first.id,1,'retire'))
 // 随退役 paused 的那条记的是岗位状态，不是本人的开关意图。
 assert.equal((await readAutoDreamSetting(pool,owner))?.enabled,true)
 const second=await roles.create(owner,{requestId:randomUUID(),fields:{...employee(['SOC']),name:'核对岗'}})
 assert.equal((await systemPlans(owner)).find(plan=>plan.roleId===second.id)?.state,'active')
})

test('未登记的业务范围不拖垮招聘：取升序第一个已登记的范围',async()=>{
 const owner=randomUUID(),{roles}=services()
 const space=await inTransaction(client=>new BusinessSpaceService(pool,identity).ensurePersonalInTransaction(client,owner))
 // 升序第一个未登记、第二个是内置范围：计划落在第二个上。
 const mixed=await roles.create(owner,{requestId:randomUUID(),fields:employee(['AAA-unregistered','SOC'])})
 assert.equal((await systemPlans(owner)).find(plan=>plan.roleId===mixed.id)?.scope,'SOC')
 // 已登记的自定义范围同样算数。
 await BusinessScopeService.ensure(pool,owner,{scope:'AAA-finance',title:'财务风控',kind:'domain',spaceId:space.id})
 const custom=await roles.create(owner,{requestId:randomUUID(),fields:{...employee(['AAA-finance','SOC']),name:'财务岗'}})
 assert.equal((await systemPlans(owner)).find(plan=>plan.roleId===custom.id)?.scope,'AAA-finance')
 // 一个都没登记：岗位照常招聘成功，只是不带小结。
 const none=await roles.create(owner,{requestId:randomUUID(),fields:{...employee(['ZZZ-unknown-a','ZZZ-unknown-b']),name:'待登记岗'}})
 assert.equal(none.state,'active')
 assert.equal((await systemPlans(owner)).find(plan=>plan.roleId===none.id),undefined)
})

test('复岗后系统计划仍能领到日程，同一次岗位版本变化仍挡住人类计划',async()=>{
 const owner=randomUUID(),{roles,lifecycle,plans}=services()
 const role=await roles.create(owner,{requestId:randomUUID(),fields:employee(['SOC'])})
 // 人类自建的普通计划与系统计划并排，经历同一次暂停/复岗（岗位版本 1→3）。
 const manual=await plans.create(owner,{requestId:randomUUID(),fields:{title:'每日资料核对',goal:'核对新增资料并形成明确结论。',scope:'SOC',dataScope:'已授权资料。',delivery:'变化与待核对项。',roleId:role.id,expectedRoleVersion:1,trigger:{kind:'schedule',cadence:'daily',weekday:1,time:'09:00',timezone:'Asia/Singapore'},notificationPolicy:'attention'},source:{kind:'manual'}})
 const enabled=await plans.change(owner,{planId:manual.id,requestId:randomUUID(),expectedVersion:manual.version,action:'enable'})
 await lifecycle.change(owner,command(role.id,1,'pause'))
 const resumed=await lifecycle.change(owner,command(role.id,2,'resume'))
 assert.equal(resumed.role.version,3)
 const system=(await systemPlans(owner))[0]!
 assert.equal(system.state,'active');assert.equal(system.roleVersion,1)
 const occurrences=new PlanOccurrenceService(pool,identity),now='2030-01-01T00:00:00.000Z'
 // 系统计划的 role_version 恒为创建时的 1，但它随岗位生命周期走，领取不该被岗位版本挡住。
 const claimed=await occurrences.claim(owner,{planId:system.id,now})
 assert.ok(claimed.occurrence);assert.equal(claimed.dispatch,true)
 assert.equal(claimed.occurrence.roleVersion,resumed.role.version)
 const dispatch={claimId:claimed.occurrence.id,taskRequestId:claimed.occurrence.taskRequestId,now}
 const dispatched=await occurrences.dispatchTask(owner,dispatch)
 assert.equal(dispatched.task.assigneeRoleId,role.id)
 assert.equal(dispatched.task.assigneeRoleVersion,resumed.role.version)
 assert.equal((await occurrences.dispatchTask(owner,dispatch)).task.id,dispatched.task.id)
 // 人类计划的判据一字未放宽。
 await assert.rejects(occurrences.claim(owner,{planId:enabled.id,now}),{code:'teloa/version-conflict'})
})

test('系统计划领取后岗位再次变化，旧领取不得改绑新版本派发',async()=>{
 const owner=randomUUID(),{roles,lifecycle}=services()
 const role=await roles.create(owner,{requestId:randomUUID(),fields:employee(['SOC'])})
 const plan=(await systemPlans(owner))[0]!,occurrences=new PlanOccurrenceService(pool,identity),now='2030-01-01T00:00:00.000Z'
 const {occurrence}=await occurrences.claim(owner,{planId:plan.id,now})
 assert.ok(occurrence)
 await lifecycle.change(owner,command(role.id,1,'pause'))
 await lifecycle.change(owner,command(role.id,2,'resume'))
 await assert.rejects(occurrences.dispatchTask(owner,{claimId:occurrence.id,taskRequestId:occurrence.taskRequestId,now}),{code:'teloa/version-conflict'})
 assert.equal((await new TaskService(pool,identity).list(owner,{})).length,0)
})

test('零业务范围与零计划的直呼路径都返回 undefined，不报错',async()=>{
 const owner=randomUUID(),ports={plans:new PlanService(pool,identity)}
 const role=await new RoleService(pool,identity).create(owner,{requestId:randomUUID(),fields:employee(['SOC'])})
 assert.equal(await inTransaction(client=>ensureAutoDreamPlan(client,ports,owner,{...role,scopes:[]})),undefined)
 assert.equal(await inTransaction(client=>pauseAutoDreamPlan(client,ports,owner,role.id)),undefined)
 assert.equal((await systemPlans(owner)).length,0)
})

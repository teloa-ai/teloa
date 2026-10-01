import test,{after,before} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {mkdtemp,rm,writeFile} from 'node:fs/promises'
import {homedir,tmpdir} from 'node:os'
import {join} from 'node:path'
import {Context} from '@deepseek-ai/cordis'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {LlmRuntime,ToolCallId} from '@deepseek-ai/dsh-llm'
import {SessionStore,SessionId} from '@deepseek-ai/dsh-session'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {openResourceDatabase,initializeRoles,initializePlans,RoleService,PlanService,TaskRunService} from '@teloa/backend'
import {testRoleResponsibility} from './role-test-fixture.ts'
import {createPlanHandler} from '../src/plans.ts'
import {registerPlanTools} from '../src/plan-tools.ts'

let container:StartedPostgreSqlContainer,pool:TaskRunService['pool'],temporary:string
before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock');process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73').withDatabase('teloa').start()
 temporary=await mkdtemp(join(tmpdir(),'teloa-plan-tools-'));const config=join(temporary,'database.json')
 await writeFile(config,JSON.stringify({connectionString:container.getConnectionUri()}),{mode:0o600})
 pool=(await openResourceDatabase(config,{id:randomUUID,now:()=>new Date().toISOString()})).pool
 await initializeRoles(pool);await initializePlans(pool)
},{timeout:180_000})
after(async()=>{await pool?.end();await container?.stop();if(temporary)await rm(temporary,{recursive:true,force:true})})

test('真实 PostgreSQL 目录与计划写入保持本人、幂等回执、默认暂停和版本冲突',{timeout:30000},async t=>{
 const owner=randomUUID(),now='2026-09-12T00:00:00.000Z',identity={id:randomUUID,now:()=>now}
 const roles=new RoleService(pool,identity),role=await roles.create(owner,{requestId:randomUUID(),fields:{name:'SOC 核对岗',kind:'employee',scopes:['SOC'],duty:'核对告警',dataScope:'已授权安全资料',executionScope:'只读核对',skills:[],knowledge:[],responsibility:testRoleResponsibility,runtimeConfig:{agentPresetId:'security-analyst'}}})
 await pool.query("update teloa_roles set state='active' where id=$1",[role.id])
 const plans=new PlanService(pool,identity),planHandler=createPlanHandler(owner,async()=>plans)
 const ctx=new Context();t.after(()=>ctx.fiber.dispose())
 await ctx.plugin(LlmRuntime);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 const {agent}=await ctx.agents.create({sessionId:SessionId('plan-tools-pg'),agentOptions:{provider:'test',model:'test'}})
 registerPlanTools(ctx,{owner,conversation:async sessionId=>({ownerId:owner,sessionId,status:'ready'}),readTaskPolicy:async()=>null,planHandler,scheduleHandler:async()=>{throw Error('本用例不读取历史')},roles,now:()=>now,timezone:()=> 'Asia/Singapore'})
 const call=(name:string,args:Record<string,unknown>,callId:string)=>ctx.tools.execute({agent,name,arguments:args,callId:ToolCallId(callId),signal:AbortSignal.timeout(5000)})
 const parse=(result:Awaited<ReturnType<typeof call>>)=>JSON.parse(result.content.filter(item=>item.type==='text').map(item=>item.text).join('\n'))
 const directory=parse(await call('teloa_plans_directory',{},'directory'))
 assert.deepEqual(directory.roles,[{id:role.id,version:1,name:'SOC 核对岗',scopes:['SOC']}])
 const input={title:'每日告警核对',goal:'核对新增告警。',scope:'SOC',dataScope:'已授权安全资料。',delivery:'变化与待核对项。',notificationPolicy:'attention',roleId:role.id,expectedRoleVersion:1,cadence:'daily',weekday:1,time:'09:30',timezone:'Asia/Singapore'}
 const first=parse(await call('teloa_plans_create',input,'same-create')),replayed=parse(await call('teloa_plans_create',input,'same-create'))
 assert.equal(first.requestId,replayed.requestId);assert.equal(first.plan.id,replayed.plan.id);assert.equal(first.plan.state,'paused')
 const conflictingCreate=await call('teloa_plans_create',{...input,title:'另一项计划'},'same-create')
 assert.equal(conflictingCreate.isError,true);assert.ok(JSON.stringify(conflictingCreate).includes('同一请求不能创建不同的持续计划'))
 assert.equal((await pool.query('select count(*)::int count from teloa_plans where owner_id=$1',[owner])).rows[0].count,1)
 const active=await plans.change(owner,{planId:first.plan.id,requestId:randomUUID(),expectedVersion:1,action:'enable'})
 const paused=parse(await call('teloa_plans_change',{planId:active.id,expectedVersion:active.version,action:'pause'},'same-change'))
 const pauseReplay=parse(await call('teloa_plans_change',{planId:active.id,expectedVersion:active.version,action:'pause'},'same-change'))
 assert.equal(paused.requestId,pauseReplay.requestId);assert.equal(paused.plan.version,3);assert.equal(pauseReplay.plan.version,3)
 const conflictingReplay=await call('teloa_plans_change',{planId:active.id,expectedVersion:3,action:'pause'},'same-change')
 assert.equal(conflictingReplay.isError,true);assert.ok(JSON.stringify(conflictingReplay).includes('原请求已记录其他计划操作'))
 const staleVersion=await call('teloa_plans_change',{planId:active.id,expectedVersion:2,action:'pause'},'new-stale-change')
 assert.equal(staleVersion.isError,true);assert.ok(JSON.stringify(staleVersion).includes('版本已变化'))
 const current=await plans.get(owner,{planId:active.id});assert.equal(current.state,'paused');assert.equal(current.version,3)
})

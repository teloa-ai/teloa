import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {Pool} from '../../backend/tests/postgres-test-lifecycle.ts'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {Context} from '@deepseek-ai/cordis'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {LlmRuntime,ToolCallId,createUserMessage} from '@deepseek-ai/dsh-llm'
import {SessionStore,SessionId} from '@deepseek-ai/dsh-session'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {RoleService,initializeRoles} from '../../backend/src/work/roles.ts'
import {RoleLifecycleService,initializeRoleLifecycle} from '../../backend/src/work/role-lifecycle.ts'
import {initializeCollaboration} from '../../backend/src/work/collaboration.ts'
import {initializeGroupAgentGrants} from '../../backend/src/work/group-agent-grants.ts'
import {initializeTasks} from '../../backend/src/work/tasks.ts'
import {createRoleHandler} from '../src/roles.ts'
import {registerEmployeeTools,type EmployeeToolsPorts} from '../src/employee-tools.ts'

let container:StartedPostgreSqlContainer,pool:RoleService['pool']
before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start()
 pool=new Pool({connectionString:container.getConnectionUri()})
 await initializeRoles(pool);await initializeCollaboration(pool);await initializeGroupAgentGrants(pool);await initializeTasks(pool);await initializeRoleLifecycle(pool)
})
after(async()=>{await pool?.end();await container?.stop()})
const fields={name:'小研',avatarKey:'researcher',scopes:['general'],duty:'核对来源并整理结论',dataScope:'本人明确提供的资料',executionScope:'只整理资料并给出建议',skills:[],knowledge:[],responsibility:{triggers:['收到本人资料'],autonomousActions:['核对事实'],confirmationPoints:['外发前交回本人'],escalationRules:['证据不足时说明阻塞'],deliveryChecks:['结论包含来源']}}

async function setup(options:{instruction?:boolean;subagent?:boolean;ports?:Partial<EmployeeToolsPorts>}={}){
 const owner='test:'+randomUUID(),identity={id:()=>randomUUID(),now:()=>new Date().toISOString()},roles=new RoleService(pool,identity),lifecycle=new RoleLifecycleService(pool,identity)
 const ctx=new Context()
 await ctx.plugin(LlmRuntime);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 const {agent}=await ctx.agents.create({sessionId:SessionId('employee-'+randomUUID()),...(options.subagent?{meta:{origin:'subagent' as const,delegationDepth:1}}:{}),agentOptions:{provider:'test',model:'test'}})
 const turn=(source:{kind:'user'}={kind:'user'})=>{agent.session.append('turn/start',{turn:0} as never);agent.session.append('user/message',createUserMessage({source,content:[{type:'text',text:'创建研究员工并按我的要求调整'}]}),{surfaceOp:'append'})}
 if(options.instruction!==false)turn()
 const checked:string[][]=[]
 const ports:EmployeeToolsPorts={owner,conversation:async sessionId=>({ownerId:owner,sessionId,status:'ready'}),readTaskPolicy:async()=>null,roleHandler:createRoleHandler(owner,async()=>roles,async ids=>{checked.push(ids);if(ids.includes('too-large'))throw Object.assign(Error('仅可使用本地检索'),{code:'teloa/invalid-input'})}),lifecycle:payload=>lifecycle.change(owner,payload),...options.ports}
 registerEmployeeTools(ctx,ports)
 let seq=0
 const call=(name:string,args:Record<string,unknown>={},callId?:string)=>ctx.tools.execute({agent,name,arguments:args,callId:ToolCallId(callId??'employee-'+ ++seq),signal:AbortSignal.timeout(5000)})
 return {ctx,agent,owner,roles,checked,turn,call}
}
const value=(result:Awaited<ReturnType<Awaited<ReturnType<typeof setup>>['call']>>)=>JSON.parse(result.content.filter(item=>item.type==='text').map(item=>item.text).join('\n'))

test('真实创建幂等并返回完整员工回执；同轮不同调用产生不同员工，auto不固定模型',async t=>{
 const f=await setup();t.after(()=>f.ctx.fiber.dispose())
 const input={...fields,runtimeConfig:{model:'auto'}}
 const a=await f.call('teloa_employees_create',input,'create-1'),retry=await f.call('teloa_employees_create',input,'create-1'),b=await f.call('teloa_employees_create',{...input,name:'小查'},'create-2')
 assert.equal(a.isError,false);assert.equal(retry.isError,false);assert.equal(b.isError,false)
 assert.deepEqual(value(a),value(retry));assert.equal(value(a).role.name,'小研');assert.equal(value(a).role.version,1);assert.equal(value(a).role.avatarKey,'researcher');assert.equal(value(a).role.runtimeConfig,undefined)
 assert.notEqual(value(a).role.id,value(b).role.id);assert.notEqual(value(a).requestId,value(b).requestId)
 assert.equal((await f.roles.list(f.owner,{})).length,2)
 assert.equal((await f.call('teloa_employees_create',{...input,name:'伪重试'},'create-1')).isError,true)
})

test('模型工具可写自由组合头像并原样作为资料基线传回；墨黑与未知形状在写入前拒绝',async t=>{
 const f=await setup();t.after(()=>f.ctx.fiber.dispose())
 const created=value(await f.call('teloa_employees_create',{...fields,avatarKey:'bot:ghost:amber'})).role
 assert.equal(created.avatarKey,'bot:ghost:amber')
 const read=value(await f.call('teloa_employees_get',{roleId:created.id})).role
 const updated=await f.call('teloa_employees_profile',{roleId:created.id,expectedVersion:read.version,expectedProfile:{name:read.name,avatarKey:read.avatarKey},profile:{name:read.name,avatarKey:'bot:capsule:plum'}})
 assert.equal(updated.isError,false);assert.equal(value(updated).role.avatarKey,'bot:capsule:plum')
 for(const avatarKey of ['bot:circle:ink','bot:star:teal'])assert.equal((await f.call('teloa_employees_create',{...fields,avatarKey})).isError,true,avatarKey)
 assert.equal((await f.roles.list(f.owner,{})).length,1)
})

test('目录详情隔离本人且排除分身；伪造主体、凭据及无效头像在写入前拒绝',async t=>{
 const f=await setup();t.after(()=>f.ctx.fiber.dispose())
 await f.roles.ensurePersonalTwin(f.owner)
 const created=value(await f.call('teloa_employees_create',fields)).role
 assert.deepEqual(value(await f.call('teloa_employees_directory')).roles.map((role:{id:string})=>role.id),[created.id])
 assert.equal(value(await f.call('teloa_employees_get',{roleId:created.id})).role.id,created.id)
 for(const patch of [{ownerId:'other'},{kind:'twin'},{avatarKey:'https://external/avatar'},{runtimeConfig:{model:{provider:'test',model:'test',apiKey:'secret'}}}])assert.equal((await f.call('teloa_employees_create',{...fields,...patch})).isError,true)
 assert.equal((await f.roles.list(f.owner,{})).length,2)
 const twin=(await f.roles.list(f.owner,{})).find(role=>role.kind==='twin')!
 assert.equal((await f.call('teloa_employees_get',{roleId:twin.id})).isError,true)
 assert.equal((await f.call('teloa_employees_get',{roleId:randomUUID()})).isError,true)
})

test('本人普通会话与活跃原生指令是写入前提；拒绝历史任务、子Agent和被替换指令',async t=>{
 const cold=await setup({instruction:false});t.after(()=>cold.ctx.fiber.dispose())
 assert.equal((await cold.call('teloa_employees_create',fields)).isError,true);assert.equal((await cold.roles.list(cold.owner,{})).length,0)
 const child=await setup({subagent:true});t.after(()=>child.ctx.fiber.dispose())
 assert.equal((await child.call('teloa_employees_create',fields)).isError,true)
 for(const ports of [{conversation:async sessionId=>({ownerId:'other',sessionId,status:'ready' as const})},{readTaskPolicy:async()=>({allowedTools:[],nativeRequestId:'old-task'})}] satisfies Partial<EmployeeToolsPorts>[]){
  const f=await setup({ports});t.after(()=>f.ctx.fiber.dispose());assert.equal((await f.call('teloa_employees_create',fields)).isError,true);assert.equal((await f.roles.list(f.owner,{})).length,0)
 }
 const replaced=await setup();t.after(()=>replaced.ctx.fiber.dispose())
 replaced.agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'替换'}]}),{surfaceOp:{op:'replace',startSeq:1,endSeq:1},sourceEventSeqs:[1]} as never)
 assert.equal((await replaced.call('teloa_employees_create',fields)).isError,true)
})

test('头像资料保留岗位版本并核验资料基线；职责保存遵守暂停要求和真实版本回执',async t=>{
 const f=await setup();t.after(()=>f.ctx.fiber.dispose())
 const created=value(await f.call('teloa_employees_create',fields)).role
 const profile={roleId:created.id,expectedVersion:1,expectedProfile:{name:'小研',avatarKey:'researcher'},profile:{name:'小松',avatarKey:'developer'}}
 const updated=await f.call('teloa_employees_profile',profile)
 assert.equal(updated.isError,false);assert.equal(value(updated).role.version,1);assert.equal(value(updated).role.avatarKey,'developer')
 assert.equal((await f.call('teloa_employees_profile',{...profile,profile:{name:'旧基线覆盖',avatarKey:'sales'}})).isError,true)
 const edit={...fields,name:'小松',avatarKey:'developer',roleId:created.id,expectedVersion:1,expectedProfile:profile.profile,executionScope:'整理后对外发送'}
 assert.equal((await f.call('teloa_employees_update',edit)).isError,true)
 const paused=value(await f.call('teloa_employees_lifecycle',{roleId:created.id,expectedVersion:1,action:'pause',reason:'先调整职责'}))
 assert.equal(paused.role.state,'paused');assert.equal(paused.role.version,2)
 const changed=await f.call('teloa_employees_update',{...edit,expectedVersion:2})
 assert.equal(changed.isError,false);assert.equal(value(changed).role.version,3)
 assert.equal((await f.call('teloa_employees_update',{...edit,expectedVersion:2})).isError,false)
 assert.equal((await f.call('teloa_employees_update',{...edit,expectedVersion:2,duty:'不同重试'})).isError,true)
 assert.equal((await f.call('teloa_employees_profile',{...profile,expectedVersion:1})).isError,true)
})

test('暂停恢复退役复用真实生命周期，保留回执并拒绝无效版本和分身变更',async t=>{
 const f=await setup();t.after(()=>f.ctx.fiber.dispose());const role=value(await f.call('teloa_employees_create',fields)).role
 const pause={roleId:role.id,expectedVersion:1,action:'pause',reason:'暂缓工作'}
 assert.equal(value(await f.call('teloa_employees_lifecycle',pause)).appliedVersion,2)
 assert.equal(value(await f.call('teloa_employees_lifecycle',pause)).appliedVersion,2)
 assert.equal((await f.call('teloa_employees_lifecycle',{...pause,action:'resume'})).isError,true)
 assert.equal(value(await f.call('teloa_employees_lifecycle',{...pause,expectedVersion:2,action:'resume'})).role.state,'active')
 const taskId=randomUUID()
 await pool.query('insert into teloa_tasks(id,owner_id,request_id,request_spec,definition,version,state,assignee_role_id,assignee_role_version,created_at,updated_at) values($1,$2,$3,\'{}\',$4,1,\'ready\',$5,3,now(),now())',[taskId,f.owner,randomUUID(),JSON.stringify({title:'待交接工作',goal:'核对资料',scope:'general',groupId:null,skills:[]}),role.id])
 const retired=value(await f.call('teloa_employees_lifecycle',{...pause,expectedVersion:3,action:'retire'}))
 assert.equal(retired.role.state,'retired');assert.deepEqual(retired.handoffTaskIds,[taskId])
 assert.equal((await pool.query('select state from teloa_tasks where id=$1',[taskId])).rows[0].state,'ready')
 const twin=await f.roles.ensurePersonalTwin(f.owner)
 assert.equal((await f.call('teloa_employees_lifecycle',{...pause,roleId:twin.id})).isError,true)
})

test('保留原生allow/ask/deny；批准后重新核对身份，宿主错误不泄露凭据',async t=>{
 const allowed=await setup();t.after(()=>allowed.ctx.fiber.dispose());assert.equal((await allowed.call('teloa_employees_create',fields)).isError,false)
 for(const kind of ['ask','deny'] as const){const f=await setup();t.after(()=>f.ctx.fiber.dispose());f.ctx.on('tools/pre-execute',async()=>({kind,reason:'原生审核结果'}));assert.equal((await f.call('teloa_employees_create',fields)).isError,true);assert.equal((await f.roles.list(f.owner,{})).length,0)}
 const approved=await setup();t.after(()=>approved.ctx.fiber.dispose())
 approved.ctx.on('tools/pre-execute',async()=>({kind:'ask',reason:'原生高风险审核'}))
 approved.ctx.provide('approval',{request:async()=> 'allowed-once'})
 assert.equal((await approved.call('teloa_employees_create',fields)).isError,false)
 let ready=true,changedOwner=''
 const changed=await setup({ports:{conversation:async sessionId=>({ownerId:changedOwner,sessionId,status:ready?'ready':'pending'})}});changedOwner=changed.owner;t.after(()=>changed.ctx.fiber.dispose())
 changed.ctx.on('tools/pre-execute',async()=>({kind:'ask',reason:'确认高风险权限'}));changed.ctx.provide('approval',{request:async()=>{ready=false;return 'allowed-once'}})
 assert.equal((await changed.call('teloa_employees_create',fields)).isError,true);assert.equal((await changed.roles.list(changed.owner,{})).length,0)
 const broken=await setup({ports:{roleHandler:async()=>{throw Error('postgres password=secret')}}});t.after(()=>broken.ctx.fiber.dispose())
 const result=await broken.call('teloa_employees_directory');assert.equal(result.isError,true);assert.ok(!JSON.stringify(result).includes('password=secret'))
})

test('宿主目录或写入回执出现跨本人对象时不向会话返回原记录',async t=>{
 const timestamp='2026-10-11T00:00:00.000Z',forged={...fields,kind:'employee',id:randomUUID(),ownerId:'other',version:1,state:'active',createdAt:timestamp,updatedAt:timestamp,name:'private-person'}
 for(const listing of [true,false]){
  const f=await setup({ports:{roleHandler:async()=>listing?[forged]:forged}});t.after(()=>f.ctx.fiber.dispose())
  const result=await f.call(listing?'teloa_employees_directory':'teloa_employees_create',listing?{}:fields)
  assert.equal(result.isError,true);assert.ok(!JSON.stringify(result).includes('private-person'))
 }
})

test('原生审批期间开始新指令后拒绝执行旧工具参数，不用新指令为旧操作补授权',async t=>{
 const f=await setup();t.after(()=>f.ctx.fiber.dispose())
 f.ctx.on('tools/pre-execute',async()=>({kind:'ask',reason:'核验执行范围'}))
 f.ctx.provide('approval',{request:async()=>{f.turn();return 'allowed-once'}})
 assert.equal((await f.call('teloa_employees_create',fields)).isError,true)
 assert.equal((await f.roles.list(f.owner,{})).length,0)
})

test('既有知识体积预检继续阻止创建，自动模型不移除显式preset或备用模型',async t=>{
 const f=await setup();t.after(()=>f.ctx.fiber.dispose())
 assert.equal((await f.call('teloa_employees_create',{...fields,knowledge:['too-large']})).isError,true);assert.equal((await f.roles.list(f.owner,{})).length,0)
 assert.deepEqual(f.checked,[['too-large']])
 const created=value(await f.call('teloa_employees_create',{...fields,runtimeConfig:{agentPresetId:'researcher',model:'auto',fallbackModel:{provider:'test',model:'fallback'}}})).role
 assert.deepEqual(created.runtimeConfig,{agentPresetId:'researcher',fallbackModel:{provider:'test',model:'fallback'}})
})

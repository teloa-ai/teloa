import test,{after,before} from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {mkdtemp,rm,writeFile} from 'node:fs/promises'
import {homedir,tmpdir} from 'node:os'
import {join} from 'node:path'
import {Context} from '@deepseek-ai/cordis'
import {ToolRuntime,defineTool} from '@deepseek-ai/dsh-tools'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {LlmRuntime,ToolCallId,createUserMessage} from '@deepseek-ai/dsh-llm'
import {brandString} from '@deepseek-ai/dsh-brand'
import type {SessionRequestId} from '@deepseek-ai/dsh-api-session-controller'
import {SessionStore,SessionId} from '@deepseek-ai/dsh-session'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {openResourceDatabase,initializeCollaboration,initializeGroupAgentGrants,initializeRoles,initializeTasks,initializeObjectConversations,initializeTaskRuns,initializeRoleToolGrants,RoleService,TaskService,ObjectConversationService,TaskRunService,RoleToolGrantService} from '@teloa/backend'
import {testRoleResponsibility} from './role-test-fixture.ts'
import {referenceReadTool,referenceServerName,referenceToolRules,validateReferenceToolRules} from '../src/role-tool-grants.ts'
import {registerTaskToolGuard} from '../src/task-tool-guard.ts'

let container:StartedPostgreSqlContainer,pool:TaskRunService['pool'],temporary:string
const identity={id:randomUUID,now:()=>new Date().toISOString()}
before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock');process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73').withDatabase('teloa').start()
 temporary=await mkdtemp(join(tmpdir(),'teloa-mcp-resource-grant-'));const config=join(temporary,'database.json')
 await writeFile(config,JSON.stringify({connectionString:container.getConnectionUri()}),{mode:0o600})
 pool=(await openResourceDatabase(config,identity)).pool
 await initializeRoles(pool);await initializeCollaboration(pool);await initializeGroupAgentGrants(pool);await initializeTasks(pool);await initializeObjectConversations(pool);await initializeTaskRuns(pool);await initializeRoleToolGrants(pool)
},{timeout:120000})
after(async()=>{await pool?.end();await container?.stop();if(temporary)await rm(temporary,{recursive:true,force:true})})

const text='公共参考正文'
/** 岗位声明的公共资料快照；sourceVersion 必须是正文摘要，否则执行快照读取会判定损坏。 */
const knowledgeItem=(id:string)=>({id,version:1,title:'公共依据',sourceId:'public-'+id,sourceVersion:createHash('sha256').update(text).digest('hex'),scopeIds:['general'],text})

/** 建一个已声明公共资料、处于暂停态的雇员岗位，并关联任务会话，供真实 prepare 使用。 */
async function fixture(){
 const owner=randomUUID(),knowledgeId=randomUUID(),knowledge=[knowledgeItem(knowledgeId)]
 const role=await new RoleService(pool,identity).create(owner,{requestId:randomUUID(),fields:{name:'资料岗',kind:'employee',scopes:['general'],duty:'读取公共资料',dataScope:'已授权公共资料',executionScope:'只读',skills:[],knowledge:[knowledgeId],responsibility:testRoleResponsibility,runtimeConfig:{agentPresetId:'security-analyst'}}})
 // 工具授权只对暂停岗位开放；创建后直接在岗，夹具把状态摆回暂停且不动版本。
 await pool.query("update teloa_roles set state='paused' where id=$1",[role.id])
 return {owner,role,knowledge,knowledgeId}
}
/** 生产装配同款：候选表由岗位执行资料算出，保存与执行前复核都用同一个真实校验函数。 */
const grantPolicy=(knowledge:ReturnType<typeof knowledgeItem>[])=>({
 validate:(rules:Parameters<typeof validateReferenceToolRules>[0])=>validateReferenceToolRules(rules,referenceToolRules(knowledge)),
 recheck:async()=>{},
})

test('岗位显式授权后 MCP 列举工具经真实 prepare 与守卫放行，读取工具与未授权岗位仍拒绝',{timeout:60000},async t=>{
 const {owner,role,knowledge,knowledgeId}=await fixture()
 const policy=grantPolicy(knowledge)
 const grants=new RoleToolGrantService(pool,identity.now,async(_db,_owner,_role,rules)=>policy.validate(rules))

 // 1) 保存授权：真实 change 走生产校验，读取正文与列举资源工具都能进规则表。
 const rules=[{name:referenceReadTool,allowed:[{id:'public-'+knowledgeId,version:knowledgeItem(knowledgeId).sourceVersion}]},{name:'list_mcp_resources',allowed:[{server:referenceServerName}]}]
 const saved=await grants.change(owner,{roleId:role.id,expectedRoleVersion:1,action:'save',rules})
 assert.equal(saved.state,'active');assert.equal(saved.roleVersion,2)
 // 读取类资源工具没有候选参数，真实保存链路直接拒绝。
 await assert.rejects(grants.change(owner,{roleId:role.id,expectedRoleVersion:2,action:'save',rules:[{name:'read_mcp_resource',allowed:[{server:referenceServerName,uri:'file:///any'}]}]}),{code:'teloa/forbidden'})

 // 2) 真实 prepare：allowedTools 由授权规则名推导，确实含 MCP 列举工具。
 await pool.query("update teloa_roles set state='active' where id=$1",[role.id])
 const task=await new TaskService(pool,identity).create(owner,{requestId:randomUUID(),fields:{title:'读资料',goal:'核对公共资料',scope:'general'},assignee:{roleId:role.id,expectedVersion:2}})
 const sessionId=randomUUID(),conversationId=randomUUID()
 const inspect=async()=>({id:conversationId,sessionId,ownerId:owner,status:'ready'})
 await new ObjectConversationService(pool,inspect,identity.now).change(owner,{requestId:randomUUID(),kind:'task',objectId:task.id,expectedObjectVersion:1,sessionId,expectedLinkVersion:0,action:'link'})
 const runs=new TaskRunService(pool,identity,inspect,{allowedTools:[],roleGrants:policy})
 const run=await runs.prepare(owner,{requestId:randomUUID(),taskId:task.id,expectedTaskVersion:1,roleId:role.id,expectedRoleVersion:2,sessionId,expectedLinkVersion:1},undefined,async()=>knowledge,undefined,async()=>'security-analyst')
 assert.deepEqual(run.allowedTools,[referenceReadTool,'list_mcp_resources'])
 assert.deepEqual(run.argumentRules,rules)
 await runs.claim(owner,{runId:run.id})

 // 3) 真实 ToolRuntime + 真实 toolPolicy：授权的列举工具放行，其余仍被守卫拦下。
 const ctx=new Context();t.after(()=>ctx.fiber.dispose())
 await ctx.plugin(LlmRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 const {agent}=await ctx.agents.create({sessionId:SessionId(sessionId),agentOptions:{provider:'test',model:'test'}})
 let bodies=0
 for(const name of ['list_mcp_resources','list_mcp_resource_templates','read_mcp_resource'])ctx.tools.register(defineTool({name,description:name,parameters:{},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async()=>{bodies++;return 'executed'}}))
 registerTaskToolGuard(ctx,async(id,signal)=>{signal.throwIfAborted();return runs.toolPolicy(owner,{sessionId:id})})
 // 守卫还要核对本轮属于该 Run 的原生请求，按真实事件序补上获准轮次。
 agent.session.append('turn/start',{turn:0})
 agent.session.append('user/message',createUserMessage({content:[],source:{kind:'user',rpcId:brandString<SessionRequestId>(run.nativeRequestId)}}),{surfaceOp:'append'})
 let seq=0
 const call=(name:string,args:Record<string,unknown>)=>ctx.tools.execute({agent,name,arguments:args,callId:ToolCallId('grant-'+ ++seq),signal:AbortSignal.timeout(10000)})
 assert.equal((await call('list_mcp_resources',{server:referenceServerName})).isError,false);assert.equal(bodies,1)
 // 换 server、带游标翻页、未授权的同族工具、读取工具，四种都不在精确参数授权内。
 assert.equal((await call('list_mcp_resources',{server:'other'})).isError,true)
 assert.equal((await call('list_mcp_resources',{server:referenceServerName,cursor:'next'})).isError,true)
 assert.equal((await call('list_mcp_resource_templates',{server:referenceServerName})).isError,true)
 assert.equal((await call('read_mcp_resource',{server:referenceServerName,uri:'file:///any'})).isError,true)
 assert.equal(bodies,1)

 // 4) 撤销授权后，同一会话的列举工具立即回到拒绝。
 await grants.change(owner,{roleId:role.id,expectedRoleVersion:(await new RoleService(pool,identity).list(owner,{})).find(item=>item.id===role.id)!.version,action:'revoke',rules:[]})
 assert.equal((await call('list_mcp_resources',{server:referenceServerName})).isError,true);assert.equal(bodies,1)
},)

test('未授权岗位的执行会话拿不到 MCP 资源工具',{timeout:60000},async t=>{
 const {owner,role,knowledge}=await fixture()
 await pool.query("update teloa_roles set state='active' where id=$1",[role.id])
 const task=await new TaskService(pool,identity).create(owner,{requestId:randomUUID(),fields:{title:'读资料',goal:'核对公共资料',scope:'general'},assignee:{roleId:role.id,expectedVersion:1}})
 const sessionId=randomUUID(),conversationId=randomUUID()
 const inspect=async()=>({id:conversationId,sessionId,ownerId:owner,status:'ready'})
 await new ObjectConversationService(pool,inspect,identity.now).change(owner,{requestId:randomUUID(),kind:'task',objectId:task.id,expectedObjectVersion:1,sessionId,expectedLinkVersion:0,action:'link'})
 const runs=new TaskRunService(pool,identity,inspect,{allowedTools:[],roleGrants:grantPolicy(knowledge)})
 const run=await runs.prepare(owner,{requestId:randomUUID(),taskId:task.id,expectedTaskVersion:1,roleId:role.id,expectedRoleVersion:1,sessionId,expectedLinkVersion:1},undefined,async()=>knowledge,undefined,async()=>'security-analyst')
 // 岗位从未保存授权，规则表为空，allowedTools 也就为空。
 assert.deepEqual(run.allowedTools,[])
 await runs.claim(owner,{runId:run.id})
 const ctx=new Context();t.after(()=>ctx.fiber.dispose())
 await ctx.plugin(LlmRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 const {agent}=await ctx.agents.create({sessionId:SessionId(sessionId),agentOptions:{provider:'test',model:'test'}})
 let bodies=0
 for(const name of ['list_mcp_resources','list_mcp_resource_templates','read_mcp_resource'])ctx.tools.register(defineTool({name,description:name,parameters:{},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async()=>{bodies++;return 'executed'}}))
 registerTaskToolGuard(ctx,async(id,signal)=>{signal.throwIfAborted();return runs.toolPolicy(owner,{sessionId:id})})
 let seq=0
 for(const name of ['list_mcp_resources','list_mcp_resource_templates','read_mcp_resource'])assert.equal((await ctx.tools.execute({agent,name,arguments:{server:referenceServerName},callId:ToolCallId('deny-'+ ++seq),signal:AbortSignal.timeout(10000)})).isError,true)
 assert.equal(bodies,0)
})

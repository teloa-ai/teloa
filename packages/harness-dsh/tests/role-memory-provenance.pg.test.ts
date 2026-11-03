import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {Context} from '@deepseek-ai/cordis'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {LlmRuntime,ToolCallId,createUserMessage} from '@deepseek-ai/dsh-llm'
import {SessionStore,SessionId} from '@deepseek-ai/dsh-session'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {setupRoleWork,roleFixture,identity} from '../../backend/tests/role-work-test-fixture.ts'
import {initializeTeloaDatabase} from '../../backend/src/work/initialize-database.ts'
import {TaskRunService} from '../../backend/src/work/task-runs.ts'
import {WorkLineageService} from '../../backend/src/work/work-lineage.ts'
import {ObjectConversationService} from '../../backend/src/work/object-conversations.ts'
import {RoleMemoryService} from '../../backend/src/work/role-memory.ts'
import {registerRoleMemoryTools,roleMemoryProposalToolName} from '../src/role-memory.ts'
import {registerTaskToolGuard} from '../src/task-tool-guard.ts'

test('真实PG与ToolRuntime：任务开始/结束递增状态版本，本轮经验仍固定到获准Run并经历确认与撤回',{timeout:60000},async t=>{
 const f=await setupRoleWork(),ctx=new Context();t.after(async()=>{await ctx.fiber.dispose();await f.close()})
 await initializeTeloaDatabase(f.pool)
 const {owner,role,taskId}=await roleFixture(f.pool,'employee'),sessionId=SessionId('memory-source-'+randomUUID())
 await f.pool.query("update teloa_roles set state='active' where id=$1",[role.id])
 const db=await f.pool.connect()
 try{await db.query('begin');await new WorkLineageService(f.pool,identity).bindTask(db,owner,{taskId,source:{kind:'owner-task',taskId}});await db.query('commit')}finally{db.release()}
 const conversationId=randomUUID(),inspect=async()=>({id:conversationId,ownerId:owner,sessionId,status:'ready'})
 const links=new ObjectConversationService(f.pool,inspect,identity.now),link=await links.change(owner,{requestId:randomUUID(),kind:'task',objectId:taskId,expectedObjectVersion:1,sessionId,expectedLinkVersion:0,action:'link'})
 const runs=new TaskRunService(f.pool,identity,inspect),memory=new RoleMemoryService(f.pool,identity)
 const run=await runs.prepare(owner,{requestId:randomUUID(),taskId,expectedTaskVersion:1,roleId:role.id,expectedRoleVersion:role.version,sessionId,expectedLinkVersion:link.version},undefined,undefined,undefined,async()=> 'ptc')
 assert.equal((await runs.claim(owner,{runId:run.id})).dispatch,true)
 await runs.record(owner,{runId:run.id,sessionId,nativeRequestId:run.nativeRequestId,evidence:{state:'active',turn:0,messageSeq:1}})
 assert.equal((await f.pool.query('select version from teloa_tasks where id=$1',[taskId])).rows[0].version,2)
 assert.equal(JSON.parse(run.inputText).task.version,1,'固定执行输入不随任务状态改写')
 for(const plugin of [LlmRuntime,SystemPrompt,ToolRuntime,SessionStore,SessionProjectionRegistry,AgentRegistry])await ctx.plugin(plugin)
 await ctx.plugin(AgentLoop,{agents:[]})
 const {agent}=await ctx.agents.create({sessionId,agentOptions:{provider:'fixture',model:'fixture'}})
 agent.session.append('turn/start',{turn:0});agent.session.append('user/message',createUserMessage({source:{kind:'user',rpcId:run.nativeRequestId},content:[]}),{surfaceOp:'append'})
 registerRoleMemoryTools(ctx,{owner,run:async id=>{
  if(id!==sessionId)return null
  const current=await runs.get(owner,{runId:run.id});assert.ok(current.roleId);assert.ok(current.roleVersion)
  return {...current,roleId:current.roleId,roleVersion:current.roleVersion}
 },scope:id=>runs.executionScope(owner,{runId:id}),create:(actor,input)=>memory.create(actor,input)})
 registerTaskToolGuard(ctx,id=>runs.toolPolicy(owner,{sessionId:id}),[roleMemoryProposalToolName])
 const args={title:'保留修订和退款规则',markdown:'按订单号取最新修订，退款从销售额扣减。'}
 const call=(callId:string,source?:unknown)=>ctx.tools.execute({agent,name:roleMemoryProposalToolName,arguments:{...args,...(source===undefined?{}:{source})},callId:ToolCallId(callId),signal:AbortSignal.timeout(5000)})
 const stale=await call('stale-task-source',{kind:'task',id:taskId,version:run.taskVersion})
 assert.equal(stale.isError,true);assert.match(JSON.stringify(stale.content),/任务来源版本已变化/)
 const human={ownerId:owner,kind:'human' as const};assert.deepEqual(await memory.list(human,{roleId:role.id}),[])
 const result=await call('current-run-source')
 assert.equal(result.isError,false,JSON.stringify(result.content))
 const candidate=(await memory.list(human,{roleId:role.id}))[0]!
 assert.equal(candidate.state,'candidate');assert.deepEqual(candidate.source,{kind:'run',id:run.id,version:1})
 assert.deepEqual(await memory.confirmedForRun(f.pool,owner,'general',role),[],'候选不注入下一任务')
 const replay=await call('current-run-source');assert.equal(replay.isError,false,JSON.stringify(replay.content));assert.equal((await memory.list(human,{roleId:role.id})).length,1,'同一真实工具调用回执幂等')
 await runs.record(owner,{runId:run.id,sessionId,nativeRequestId:run.nativeRequestId,evidence:{state:'ended',turn:0,messageSeq:1,endSeq:2,reason:'completed'}})
 assert.equal((await f.pool.query('select version from teloa_tasks where id=$1',[taskId])).rows[0].version,3)
 assert.equal((await call('after-run-ended')).isError,true,'结束运行不得再写候选')
 const confirmed=await memory.confirm(human,{requestId:randomUUID(),memoryId:candidate.id,expectedStateVersion:candidate.stateVersion})
 const cold=new RoleMemoryService(f.pool,identity)
 assert.equal((await cold.list(human,{roleId:role.id}))[0]!.sourceAvailable,true)
 assert.deepEqual((await cold.confirmedForRun(f.pool,owner,'general',role)).map(x=>x.id),[candidate.id])
 assert.deepEqual(await cold.confirmedForRun(f.pool,owner,'research',role),[],'同一员工获准的另一业务范围不能读取本条经验')
 await assert.rejects(cold.confirmedForRun(f.pool,owner,'SOC',role),{code:'teloa/forbidden'},'未授予员工的业务范围直接拒绝')
 await cold.withdraw(human,{requestId:randomUUID(),memoryId:candidate.id,expectedStateVersion:confirmed.stateVersion})
 assert.deepEqual(await new RoleMemoryService(f.pool,identity).confirmedForRun(f.pool,owner,'general',role),[])
 assert.equal((await f.pool.query('select count(*) from teloa_role_memories where owner_id=$1',[owner])).rows[0].count,'1')
})

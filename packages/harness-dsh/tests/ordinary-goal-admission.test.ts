import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {LlmAdapter,ToolCallId,createUserMessage,type GenerateOptions,type StreamChunk} from '@deepseek-ai/dsh-llm'
import {SessionId} from '@deepseek-ai/dsh-session'
import {patchedSessionFixture} from './fixtures/native-final-session.ts'
import {patchedNativePackage} from './fixtures/native-patched-package.ts'
import {until} from './fixtures/native-schedule-admission.ts'
import {createTaskRunGoal} from '../src/task-run-goal.ts'
import {createNativeWorkInput} from '../src/native-work-input.ts'
import {createNativeSessionCapabilities} from '../src/native-session-capabilities.ts'
import {WorkAccess} from '../../backend/src/work/work-access.ts'
import {TaskRunGoalService,initializeTaskRunGoals} from '../../backend/src/work/task-run-goals.ts'
import {FileConversationRepository} from '../../backend/src/work/conversations.ts'
import {ObjectConversationService} from '../../backend/src/work/object-conversations.ts'
import {initializeConversationWork} from '../../backend/src/work/conversation-work.ts'
import {initializeTaskRunRuntimeLinks} from '../../backend/src/work/task-run-runtime-links.ts'
import {setupRoleWork,identity} from '../../backend/tests/role-work-test-fixture.ts'

const anchor=createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json'),official=createRequire(anchor)
function* call(name:string,args:object):Generator<StreamChunk>{const argumentsText=JSON.stringify(args),id=ToolCallId(randomUUID());yield {type:'block-start',index:0,blockType:'tool-call'};yield {type:'tool-call-delta',index:0,id,name,argumentsDelta:argumentsText};yield {type:'block-end',index:0,block:{type:'tool-call',id,name,arguments:argumentsText}};yield {type:'finish',reason:{kind:'tool-calls'}}}

test('真实本人默认会话在官方 Goal 变更体前拒绝未支持能力，只读保留且不创建 Goal 或 Run',{timeout:30000},async t=>{
 const db=await setupRoleWork();t.after(()=>db.close())
 await initializeConversationWork(db.pool);await initializeTaskRunRuntimeLinks(db.pool);await initializeTaskRunGoals(db.pool)
 const f=await patchedSessionFixture(t),goalModule=await import(pathToFileURL(official.resolve('@deepseek-ai/dsh-goal')).href),goalTools=await import(pathToFileURL(official.resolve('@deepseek-ai/dsh-tool-goal')).href)
 const root=await mkdtemp(join(tmpdir(),'teloa-ordinary-goal-'));t.after(()=>rm(root,{recursive:true,force:true}));await f.ctx.plugin(f.persistencePackage.default,{root:join(root,'history'),compression:'none'})
 await f.ctx.plugin(goalModule.GoalService);await f.ctx.plugin(goalTools,{})
 const {agent}=await f.ctx.agents.create({sessionId:SessionId('ordinary-'+randomUUID()),agentOptions:{provider:'test',model:'test',maxTokens:128}}),owner=randomUUID(),goals=f.ctx.goals,repository=new FileConversationRepository(join(root,'conversations.json'))
 const row={id:randomUUID(),sessionId:agent.id,requestedSessionId:agent.id,ownerId:owner,title:'本人默认会话',scopeIds:['general'] as ['general'],version:1 as const,status:'ready' as const,createdAt:new Date().toISOString()};await repository.write([row])
 const links=new ObjectConversationService(db.pool,async()=>row,identity.now),access=new WorkAccess();access.requirePolicy();access.requireSessionCapabilities();access.installPolicy(async()=>({assertCurrent(){}}));access.installSessionCapabilities(createNativeSessionCapabilities(f.ctx,{owner,conversations:{repository},links,pool:db.pool,isRoutingSession:()=>false}))
 const input=createNativeWorkInput(f.ctx,access),service=new TaskRunGoalService(db.pool,identity,{hostGeneration:()=>1,inspectGoal:async()=>null,admitRound:async()=>{throw Error('普通会话不能借 Task Goal 票据')}})
 const adapter=createTaskRunGoal(f.ctx,service,owner,{nativeInput:input,hostGeneration:()=>1,foldGoal:goalModule.foldGoal});t.after(()=>{adapter.close();input.close()})
 const driver=(await patchedNativePackage<any>(t,{packageName:'@deepseek-ai/dsh-goal-round-driver',compatBasename:'dsh-goal-round-driver-0.2.1-alpha.1-input-admission',packageAnchor:anchor})).namespace;await f.ctx.plugin(driver,{requireInputAdmission:true,admitInput:adapter.admit})
 let requests=0
 class Model extends LlmAdapter{override async resolveModel(provider:string,model:string){return {provider,id:model,name:model}}async *stream(_options:GenerateOptions):AsyncIterable<StreamChunk>{requests++;if(requests===1){yield* call('create_goal',{objective:'核对本人目标',max_goal_rounds:2});return}if(requests===2){yield* call('update_goal',{goal_id:'unmanaged-goal',revision:1,action:'resume'});return}if(requests===3){yield* call('get_goal',{});return}yield {type:'finish',reason:{kind:'stop'}}}}
 f.ctx.llm.registerAdapter(['test'],new Model())
 const first=createUserMessage({source:{kind:'user',rpcId:randomUUID()},content:[{type:'text',text:'本人明确创建并执行一个 Goal'}]});await input.withNewInput(agent,first,{producer:'prompt',identity:'owner-prompt'},()=>agent.followup(first))
 await until(()=>agent.status==='idle'&&requests>=4)
 assert.equal(goals.get(agent),undefined,'未支持的普通自动 Goal 必须在变更体前拒绝，不能先创建再卡续轮')
 const events=agent.session.snapshotEvents(),accepted=events.filter(e=>e.type==='agent/inbox/spliced'&&e.data.inserted.some(m=>m.source.kind==='goal'))
 assert.equal(accepted.length,0);assert.equal(events.some(e=>e.type==='goal/change'),false);assert.equal((await db.pool.query('select 1 from teloa_task_runs where session_id=$1',[agent.id])).rowCount,0)
 const results=events.filter(e=>e.type==='tool/result');assert.equal(results.length,3)
 assert.match(JSON.stringify(results[0]),/请从任务入口开始/);assert.match(JSON.stringify(results[1]),/请从任务入口开始/)
 assert.equal(results[0]!.data.message.isError,true);assert.equal(results[1]!.data.message.isError,true);assert.equal(results[2]!.data.message.isError,false)
})

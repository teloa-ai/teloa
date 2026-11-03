import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {Context} from '@deepseek-ai/cordis'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {LlmRuntime,ToolCallId,createUserMessage} from '@deepseek-ai/dsh-llm'
import {SessionStore,SessionId} from '@deepseek-ai/dsh-session'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {setupRoleWork,identity,ownerAuthority} from '../../backend/tests/role-work-test-fixture.ts'
import {initializeTeloaDatabase} from '../../backend/src/work/initialize-database.ts'
import {RoleService} from '../../backend/src/work/roles.ts'
import {TaskService} from '../../backend/src/work/tasks.ts'
import {TaskRunService,type TaskRun,type TaskExecutionScope} from '../../backend/src/work/task-runs.ts'
import {ObjectConversationService} from '../../backend/src/work/object-conversations.ts'
import {CollaborationService} from '../../backend/src/work/collaboration.ts'
import {GroupAgentGrantService} from '../../backend/src/work/group-agent-grants.ts'
import {GroupTaskService} from '../../backend/src/work/group-tasks.ts'
import {GroupRunMessageService} from '../../backend/src/work/group-run-messages.ts'
import {RoleToolGrantService} from '../../backend/src/work/role-tool-grants.ts'
import {RoleDelegationService} from '../../backend/src/work/role-delegations.ts'
import {TwinExecutionConsentService} from '../../backend/src/work/twin-execution-consents.ts'
import {readRunGroupContext} from '../../backend/src/work/task-run-group-context.ts'
import {GroupRoutingOutboxService} from '../../backend/src/work/group-routing-outbox.ts'
import {RoleMemoryService} from '../../backend/src/work/role-memory.ts'
import {registerRoleMemoryTools,roleMemoryProposalToolName,roleMemoryRunTarget,createRoleMemoryHandler} from '../src/role-memory.ts'
import {registerTaskToolGuard} from '../src/task-tool-guard.ts'

// 真实 PG + 正式 prepare/ToolRuntime 链；工具参数为受控声明，不冒充模型语义质量或安装候选验收。
let f:Awaited<ReturnType<typeof setupRoleWork>>
before(async()=>{f=await setupRoleWork();await initializeTeloaDatabase(f.pool)},{timeout:120000})
after(async()=>{await f?.close()})
const goal='以后评审先写结论并列证据。本任务例外，只用紧凑表格。以后改为先列证据。'
const hash=(text:string)=>createHash('sha256').update(text).digest('hex')

async function world(t:{after:(fn:()=>Promise<unknown>)=>unknown}){
 const owner=randomUUID(),role=await new RoleService(f.pool,identity).ensurePersonalTwin(owner),tasks=new TaskService(f.pool,identity,ownerAuthority),memory=new RoleMemoryService(f.pool,identity)
 const ctx=new Context();t.after(()=>ctx.fiber.dispose())
 for(const plugin of [LlmRuntime,SystemPrompt,ToolRuntime,SessionStore,SessionProjectionRegistry,AgentRegistry])await ctx.plugin(plugin)
 await ctx.plugin(AgentLoop,{agents:[]})
 const sessions=new Map<string,{id:string;sessionId:string;ownerId:string;status:string}>(),byTask=new Map<string,string>(),observed:TaskExecutionScope[]=[]
 const inspect=async(_owner:string,id:string)=>{const session=sessions.get(id);if(!session)throw Error('未知测试会话');return session}
 const runs=new TaskRunService(f.pool,identity,inspect,{allowedTools:[],groupContext:(db,who,task,current,refs,selection)=>readRunGroupContext(db,who,task,current,undefined,f.pool,refs,selection),roleMemory:(db,who,target,current,ids)=>{observed.push(target);return memory.confirmedForRun(db,who,roleMemoryRunTarget(target,current),current,undefined,ids)}})
 const createTask=(groupId?:string)=>tasks.createConfirmed(owner,{requestId:randomUUID(),fields:{title:'本人偏好联测',goal,scope:'general',...(groupId?{groupId}:{})},assignee:{roleId:role.id,expectedVersion:role.version}})
 async function prepare(taskId:string){
  const task=(await tasks.list(owner,{})).find(task=>task.id===taskId)!;let sessionId=byTask.get(taskId)
  if(!sessionId){sessionId=randomUUID();byTask.set(taskId,sessionId);sessions.set(sessionId,{id:randomUUID(),sessionId,ownerId:owner,status:'ready'});await new ObjectConversationService(f.pool,inspect,identity.now).change(owner,{requestId:randomUUID(),kind:'task',objectId:task.id,expectedObjectVersion:task.version,sessionId,expectedLinkVersion:0,action:'link'})}
  return runs.prepare(owner,{requestId:randomUUID(),taskId,expectedTaskVersion:task.version,roleId:role.id,expectedRoleVersion:role.version,sessionId,expectedLinkVersion:1},async()=>role.skills.map(name=>({name,provider:'test-contract',source:'fixture',description:name,content:name,sha256:hash(name)})),undefined,undefined,async()=> 'default-agent')
 }
 registerRoleMemoryTools(ctx,{owner,run:async sessionId=>{
  const row=(await f.pool.query('select id from teloa_task_runs where owner_id=$1 and session_id=$2 order by created_at desc,id desc limit 1',[owner,sessionId])).rows[0]
  if(!row)return null
  const run=await runs.get(owner,{runId:row.id});assert.ok(run.roleId);assert.ok(run.roleVersion);return {...run,roleId:run.roleId,roleVersion:run.roleVersion}
 },scope:id=>runs.executionScope(owner,{runId:id}),create:(actor,input)=>memory.create(actor,input)})
 registerTaskToolGuard(ctx,id=>runs.toolPolicy(owner,{sessionId:id}),[roleMemoryProposalToolName])
 const human={ownerId:owner,kind:'human' as const},confirm=(m:{id:string;stateVersion:number})=>memory.confirm(human,{requestId:randomUUID(),memoryId:m.id,expectedStateVersion:m.stateVersion})
 async function activate(run:TaskRun){
  assert.equal((await runs.claim(owner,{runId:run.id})).dispatch,true)
  await runs.record(owner,{runId:run.id,sessionId:run.sessionId,nativeRequestId:run.nativeRequestId,evidence:{state:'active',turn:0,messageSeq:1}})
  const {agent}=await ctx.agents.create({sessionId:SessionId(run.sessionId),agentOptions:{provider:'fixture',model:'fixture'}})
  agent.session.append('turn/start',{turn:0});agent.session.append('user/message',createUserMessage({source:{kind:'user',rpcId:run.nativeRequestId},content:[]}),{surfaceOp:'append'})
  return (kind:string,quote:string,against?:unknown)=>ctx.tools.execute({agent,name:roleMemoryProposalToolName,arguments:{title:kind==='preference'?'评审默认':kind==='correction'?'修正评审默认':'本次评审例外',markdown:quote,preference:{kind,basis:{kind:'owner-input',quote},...(against?{against}:{})}},callId:ToolCallId(randomUUID()),signal:AbortSignal.timeout(5000)})
 }
 const finish=(run:TaskRun)=>runs.record(owner,{runId:run.id,sessionId:run.sessionId,nativeRequestId:run.nativeRequestId,evidence:{state:'ended',turn:0,messageSeq:1,endSeq:2,reason:'aborted'}})
 async function candidate(result:{isError?:boolean;content:any}){assert.equal(result.isError,false,JSON.stringify(result.content));const receipt=JSON.parse(result.content.find((c:any)=>c.type==='text').text);const list=await memory.list(human,{roleId:role.id});const saved=list.find(m=>m.id===receipt.memory.id);assert.ok(saved);return saved}
 return {owner,role,tasks,memory,runs,observed,createTask,prepare,activate,finish,human,confirm,candidate}
}
const against=(m:{id:string;content:{version:number;contentHash:string}})=>({memoryId:m.id,version:m.content.version,contentHash:m.content.contentHash})
async function authorizedGroup(x:Awaited<ReturnType<typeof world>>,name:string){
 await new RoleToolGrantService(f.pool,identity.now,async()=>{}).change(x.owner,{roleId:x.role.id,expectedRoleVersion:x.role.version,action:'save',rules:[{name:'read_reference',allowed:[{id:'test-reference',version:'v1'}]}]})
 Object.assign(x.role,(await new RoleService(f.pool,identity).list(x.owner,{})).find(r=>r.id===x.role.id)!)
 const groups=new CollaborationService(f.pool,identity),group=await groups.create(x.owner,{requestId:randomUUID(),expectedVersion:0,fields:{name,scope:'general',announcement:'',rules:{historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true},memberRoleIds:[x.role.id]}})
 const delegation=await new RoleDelegationService(f.pool,identity,ownerAuthority).change(x.owner,{requestId:randomUUID(),roleId:x.role.id,expectedRoleVersion:x.role.version,expectedVersion:null,action:'save',fields:{scope:'general',allowedTools:['read_reference'],knowledgeIds:[],memoryViewId:null,groupIds:[group.id],safeRecovery:false}})
 await new TwinExecutionConsentService(f.pool,identity,ownerAuthority).confirm(x.owner,{requestId:randomUUID(),roleId:x.role.id,expectedRoleVersion:x.role.version,authorization:{kind:'delegation',delegationId:delegation.id,delegationVersion:delegation.version}})
 await new GroupAgentGrantService(f.pool,identity.now).change(x.owner,{requestId:randomUUID(),groupId:group.id,roleId:x.role.id,expectedGroupVersion:group.version,expectedRoleVersion:x.role.version,action:'save',resources:[],canPost:true,canAutoRun:true})
 return {groups,group}
}

test('正常 prepare→可信工具提议→本人确认→新 prepare 消费：本次反例只进入原 Task，撤回不复活默认',{timeout:60000},async t=>{
 const x=await world(t),task=await x.createTask(),source=await x.prepare(task.id),call=await x.activate(source)
 const p=await x.confirm(await x.candidate(await call('preference','以后评审先写结论并列证据。')))
 const once=await x.confirm(await x.candidate(await call('counterexample','本任务例外，只用紧凑表格。',against(p))))
 assert.deepEqual(source.memory,[],'新候选不会偷加进已冻结 Run')
 await x.finish(source)
 const own=await x.prepare(task.id),body=JSON.parse(own.inputText)
 assert.deepEqual(own.memory.map(m=>m.id),[once.id]);assert.deepEqual(body.memory.contents,own.memory)
 assert.equal(body.memory.contents[0].preference.taskId,task.id,'一次性 Task 来自真实 Run，不要求模型输入')
 assert.ok(x.observed.some(target=>target.taskId===task.id&&target.groupId===null))
 await x.runs.withdraw(x.owner,{runId:own.id})
 const other=await x.createTask(),next=await x.prepare(other.id);assert.deepEqual(next.memory.map(m=>m.id),[p.id]);await x.runs.withdraw(x.owner,{runId:next.id})
 await x.memory.withdraw(x.human,{requestId:randomUUID(),memoryId:once.id,expectedStateVersion:once.stateVersion})
 const after=await x.prepare(task.id);assert.deepEqual(after.memory,[]);assert.equal(JSON.parse(after.inputText).memory,undefined)
 await x.runs.withdraw(x.owner,{runId:after.id})
 assert.equal((await x.memory.readVersion(x.human,{roleId:x.role.id,memoryId:p.id,version:1})).content.contentHash,p.content.contentHash)
})

test('正常 Run 的明确更正进入下一任务；本人改版阻止旧关系确认，撤回更正不复活旧版',{timeout:60000},async t=>{
 const x=await world(t),task=await x.createTask(),source=await x.prepare(task.id),call=await x.activate(source)
 const p=await x.confirm(await x.candidate(await call('preference','以后评审先写结论并列证据。')))
 const c=await x.candidate(await call('correction','以后改为先列证据。',against(p)))
 await x.memory.edit(x.human,{requestId:randomUUID(),roleId:x.role.id,memoryId:p.id,expectedContentVersion:p.content.version,expectedContentHash:p.content.contentHash,expectedStateVersion:p.stateVersion,title:p.title,markdown:'本人新的明确默认。'})
 await assert.rejects(x.confirm(c),{code:'teloa/version-conflict'})
 const revised=(await x.memory.list(x.human,{roleId:x.role.id})).find(m=>m.id===p.id)!
 assert.equal((await call('correction','以后改为先列证据。',against(revised))).isError,true,'后来本人编辑的版本必须先进入新 Run，不能从后台补给模型')
 await x.finish(source)
 const reviewTask=await x.createTask(),review=await x.prepare(reviewTask.id),reviewCall=await x.activate(review)
 assert.deepEqual(review.memory.map(m=>m.id),[revised.id]);assert.equal(review.memory[0]?.version,revised.content.version)
 const current=await x.confirm(await x.candidate(await reviewCall('correction','以后改为先列证据。',against(revised))))
 await x.finish(review)
 const other=await x.createTask(),next=await x.prepare(other.id);assert.deepEqual(next.memory.map(m=>m.id),[current.id]);assert.deepEqual(JSON.parse(next.inputText).memory.contents,next.memory)
 await x.runs.withdraw(x.owner,{runId:next.id})
 await x.memory.withdraw(x.human,{requestId:randomUUID(),memoryId:current.id,expectedStateVersion:current.stateVersion})
 const after=await x.prepare(other.id);assert.deepEqual(after.memory,[]);await x.runs.withdraw(x.owner,{runId:after.id})
})

test('正常关联群 Task 的 prepare 保留 Task ID，并守住未共享私有偏好的边界',{timeout:60000},async t=>{
 const x=await world(t),{group}=await authorizedGroup(x,'本人联测群')
 const task=await x.createTask(group.id),run=await x.prepare(task.id),call=await x.activate(run)
 assert.ok(x.observed.some(target=>target.taskId===task.id&&target.groupId===group.id));assert.deepEqual(run.memory,[])
 const candidate=await x.candidate(await call('one-off','本任务例外，只用紧凑表格。'));const confirmed=await x.confirm(candidate)
 await x.finish(run)
 const again=await x.prepare(task.id);assert.deepEqual(again.memory,[],'未共享的群 Run 不因 Task 相同读取私有偏好')
 await x.runs.withdraw(x.owner,{runId:again.id})
 assert.equal(confirmed.visibility.kind,'private')
})

test('正常本人 RPC 保存含协议示例的 JSON 文档，创建与编辑正文均保持逐字原样',{timeout:60000},async t=>{
 const x=await world(t),handle=createRoleMemoryHandler(x.owner,async()=>x.memory),markdown=JSON.stringify({schema:'teloa.preference-candidate/v1',kind:'one-off',markdown:'这是用户在记忆里保存的 JSON 文档示例'})
 const m=await handle('role-memory/create',{requestId:randomUUID(),roleId:x.role.id,expectedRoleVersion:x.role.version,title:'原用户文档',markdown,source:{kind:'self-feedback',id:randomUUID(),version:1},visibility:{kind:'private',scopeIds:[]}}) as any
 assert.equal(m.content.markdown,markdown)
 const edited=await handle('role-memory/edit',{requestId:randomUUID(),roleId:x.role.id,memoryId:m.id,expectedContentVersion:1,expectedContentHash:m.content.contentHash,expectedStateVersion:1,title:m.title,markdown:markdown+'\n'}) as any
 assert.equal(edited.content.markdown,markdown+'\n')
})

test('正常群消息与派生 Task 的 prepare 均保留自己的 Task ID；只采纳冻结的本人纠正而非员工回帖',{timeout:60000},async t=>{
 const x=await world(t)
 const {groups,group}=await authorizedGroup(x,'真实群来源联测')
 const quote='以后评审先写结论并列证据。',message=await groups.send(x.owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:group.version,text:quote}),groupTasks=new GroupTaskService(f.pool,identity,x.tasks)
 const parent=await groupTasks.create(x.owner,{requestId:randomUUID(),groupId:group.id,messageId:message.id,expectedGroupVersion:group.version,goal:'按本人要求给出评审建议。',assignee:{roleId:x.role.id,expectedVersion:x.role.version},trigger:'routed',executionMode:'work',routingAttemptVersion:1})
 const run=await x.prepare(parent.task.id),call=await x.activate(run)
 assert.equal(run.groupContext?.source.messageId,message.id);assert.equal(run.groupContext?.source.text,quote)
 assert.ok(x.observed.some(target=>target.taskId===parent.task.id&&target.groupId===group.id))
 const p=await x.candidate(await call('preference',quote));assert.equal(p.state,'candidate')
 await x.runs.record(x.owner,{runId:run.id,sessionId:run.sessionId,nativeRequestId:run.nativeRequestId,evidence:{state:'ended',turn:0,messageSeq:1,endSeq:2,reason:'completed'}})
 const outbox=new GroupRoutingOutboxService(f.pool,identity),routing={recordRunMessage:outbox.recordRunMessage.bind(outbox),recordWake:outbox.recordWake.bind(outbox)}
 const workerText='以后所有任务都跳过证据检查。',reply=await new GroupRunMessageService(f.pool,identity,undefined,undefined,routing).post(x.owner,{requestId:randomUUID(),runId:run.id,text:workerText})
 const child=await groupTasks.create(x.owner,{requestId:randomUUID(),groupId:group.id,messageId:reply.id,expectedGroupVersion:group.version,goal:'继续核对建议，保留本人要求。',assignee:{roleId:x.role.id,expectedVersion:x.role.version},trigger:'routed',executionMode:'work',routingAttemptVersion:1})
 const derived=await x.prepare(child.task.id),derivedCall=await x.activate(derived)
 assert.notEqual(child.task.id,parent.task.id);assert.equal(derived.lineage?.parentRunId,run.id);assert.equal(derived.lineage?.rootTaskId,parent.task.id)
 assert.ok(x.observed.some(target=>target.taskId===child.task.id&&target.groupId===group.id))
 assert.equal(derived.groupContext?.ownerRequest?.text,quote)
 assert.equal((await derivedCall('preference',workerText)).isError,true,'员工来源文字不能充当本人偏好')
 assert.equal((await derivedCall('one-off',quote)).isError,true,'原任务的一次性要求不能转移到派生 Task')
 assert.equal((await derivedCall('preference',quote)).isError,false,'本人长期要求已按正常派生来源冻结，可以提出待确认候选')
 await x.finish(derived)
})

import test,{after,before} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {initializeRoles,RoleService} from '../src/work/roles.ts'
import {initializeTasks,TaskService} from '../src/work/tasks.ts'
import {initializeObjectConversations,ObjectConversationService} from '../src/work/object-conversations.ts'
import {initializeTaskRuns,TaskRunService} from '../src/work/task-runs.ts'
import {TaskRunFlowService} from '../src/work/task-run-flows.ts'

let container:StartedPostgreSqlContainer,pool:Pool
const identity={id:randomUUID,now:()=>'2026-09-13T08:00:00.000Z'}

before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start()
 pool=new Pool({connectionString:container.getConnectionUri()})
 await initializeRoles(pool);await initializeTasks(pool);await initializeObjectConversations(pool);await initializeTaskRuns(pool)
},{timeout:180_000})
after(async()=>{await pool?.end();await container?.stop()})

async function preparedRun(allowedTools:string[]=[]){
 const owner=randomUUID(),role=await new RoleService(pool,identity).create(owner,{requestId:randomUUID(),fields:{name:'复杂工作岗',kind:'employee',scopes:['general'],duty:'核对复杂工作',dataScope:'固定资料',executionScope:'只在已有授权内执行',skills:[],knowledge:[],responsibility:{triggers:[],autonomousActions:[],confirmationPoints:[],escalationRules:[],deliveryChecks:[]},runtimeConfig:{agentPresetId:'complex-worker'}}})
 await pool.query("update teloa_roles set state='active',version=2 where id=$1",[role.id])
 const task=await new TaskService(pool,identity).create(owner,{requestId:randomUUID(),fields:{title:'复杂核对',goal:'等待两路资料后形成结论',scope:'general'},assignee:{roleId:role.id,expectedVersion:2}}),sessionId=randomUUID(),conversationId=randomUUID()
 const inspect=async()=>({id:conversationId,sessionId,ownerId:owner,status:'ready'})
 await new ObjectConversationService(pool,inspect,identity.now).change(owner,{requestId:randomUUID(),kind:'task',objectId:task.id,expectedObjectVersion:1,sessionId,expectedLinkVersion:0,action:'link'})
 const runs=new TaskRunService(pool,identity,inspect,{allowedTools}),run=await runs.prepare(owner,{requestId:randomUUID(),taskId:task.id,expectedTaskVersion:1,roleId:role.id,expectedRoleVersion:2,sessionId,expectedLinkVersion:1})
 return {owner,run,runs}
}

test('普通 Run 不生成空 Flow，也不返回 Flow 引用',async()=>{
 const fixture=await preparedRun(),flows=new TaskRunFlowService(pool,identity)
 assert.equal(await flows.get(fixture.owner,{runId:fixture.run.id}),null)
 assert.equal('flowId' in await fixture.runs.get(fixture.owner,{runId:fixture.run.id}),false)
})

test('包含外部等待的复杂执行创建固定 Flow，并由 Run 读回唯一引用',async()=>{
 const fixture=await preparedRun(),flows=new TaskRunFlowService(pool,identity),requestId=randomUUID()
 const created=await flows.create(fixture.owner,{requestId,runId:fixture.run.id,definitionVersion:3,steps:[
  {id:'collect',title:'收集本地资料',kind:'work',dependsOn:[],inputSummary:'读取本轮固定资料'},
  {id:'external',title:'等待外部回执',kind:'wait_external',dependsOn:['collect'],inputSummary:'等待已发起请求的回执'},
  {id:'conclude',title:'汇总结论',kind:'work',dependsOn:['external'],inputSummary:'汇总已核对资料'},
 ]})
 assert.equal(created.runId,fixture.run.id);assert.equal(created.definitionVersion,3);assert.equal(created.state,'active')
 assert.deepEqual(created.steps.map((step:{id:string;state:string;attempts:number})=>[step.id,step.state,step.attempts]),[['collect','ready',0],['external','blocked',0],['conclude','blocked',0]])
 assert.deepEqual(await flows.get(fixture.owner,{runId:fixture.run.id}),created)
 assert.equal((await fixture.runs.get(fixture.owner,{runId:fixture.run.id})).flowId,created.flowId)
})

test('普通顺序步骤、跨 Flow 依赖与依赖环都不能创建内部 Flow',async()=>{
 const fixture=await preparedRun(),flows=new TaskRunFlowService(pool,identity)
 await assert.rejects(flows.create(fixture.owner,{requestId:randomUUID(),runId:fixture.run.id,definitionVersion:1,steps:[
  {id:'first',title:'第一步',kind:'work',dependsOn:[],inputSummary:'固定输入'},
  {id:'second',title:'第二步',kind:'work',dependsOn:['first'],inputSummary:'第一步输出'},
 ]}),{code:'teloa/flow-not-required'})
 await assert.rejects(flows.create(fixture.owner,{requestId:randomUUID(),runId:fixture.run.id,definitionVersion:1,steps:[
  {id:'local',title:'本地步骤',kind:'work',dependsOn:['step-from-another-run'],inputSummary:'固定输入'},
  {id:'checkpoint',title:'本人核对',kind:'human_checkpoint',dependsOn:['local'],inputSummary:'核对结果'},
 ]}),{code:'teloa/invalid-input'})
 await assert.rejects(flows.create(fixture.owner,{requestId:randomUUID(),runId:fixture.run.id,definitionVersion:1,steps:[
  {id:'left',title:'左侧',kind:'work',dependsOn:['right'],inputSummary:'固定输入'},
  {id:'right',title:'右侧',kind:'wait_external',dependsOn:['left'],inputSummary:'等待回执'},
 ]}),{code:'teloa/invalid-input'})
 assert.equal(await flows.get(fixture.owner,{runId:fixture.run.id}),null)
})

test('临时子 Agent 步骤只能收窄父 Run 的运行配置、会话与授权范围',async()=>{
 const fixture=await preparedRun(['read_data']),flows=new TaskRunFlowService(pool,identity)
 const execution={kind:'subagent',parentSessionId:fixture.run.sessionId,agentPresetId:'complex-worker',allowedTools:['read_data'],knowledgeIds:[],skillNames:[]}
 const declaration=(value:Record<string,unknown>)=>({requestId:randomUUID(),runId:fixture.run.id,definitionVersion:1,steps:[
  {id:'left',title:'并行读取',kind:'work',dependsOn:[],inputSummary:'读取固定资料',execution:{...execution,...value}},
  {id:'right',title:'并行核对',kind:'work',dependsOn:[],inputSummary:'独立核对'},
 ]})
 for(const expanded of [
  {allowedTools:['read_data','write_data']},
  {agentPresetId:'another-preset'},
  {parentSessionId:'another-session'},
  {knowledgeIds:[randomUUID()]},
  {skillNames:['undeclared-skill']},
 ])await assert.rejects(flows.create(fixture.owner,declaration(expanded)),{code:'teloa/forbidden'})
 const created=await flows.create(fixture.owner,declaration({}))
 assert.deepEqual(created.steps[0]!.execution,execution)
})

test('服务端步骤状态机支持并行汇合、等待恢复和补偿，重复回执不增加尝试次数',async()=>{
 const fixture=await preparedRun(),flows=new TaskRunFlowService(pool,identity)
 const created=await flows.create(fixture.owner,{requestId:randomUUID(),runId:fixture.run.id,definitionVersion:7,steps:[
  {id:'split',title:'准备输入',kind:'work',dependsOn:[],inputSummary:'准备固定输入'},
  {id:'analyze',title:'并行分析',kind:'work',dependsOn:['split'],inputSummary:'分析本地输入'},
  {id:'external',title:'等待外部回执',kind:'wait_external',dependsOn:['split'],inputSummary:'等待外部系统'},
  {id:'join',title:'汇合结论',kind:'work',dependsOn:['analyze','external'],inputSummary:'合并两路结果'},
  {id:'change',title:'执行可补偿动作',kind:'work',dependsOn:['join'],inputSummary:'执行已授权动作'},
  {id:'undo',title:'补偿动作',kind:'compensation',dependsOn:['join'],compensates:'change',inputSummary:'恢复动作前状态'},
 ]})
 const change=async(stepId:string,action:string,expectedAttempts:number,extra:Record<string,unknown>={})=>flows.transition(fixture.owner,{requestId:randomUUID(),flowId:created.flowId,stepId,action,expectedAttempts,...extra})
 await change('split','start',0);let current=await change('split','succeed',1,{outputSummary:'输入已固定'})
 assert.deepEqual(current.steps.filter((step:{state:string})=>step.state==='ready').map((step:{id:string})=>step.id),['analyze','external'])
 await change('analyze','start',0);current=await change('analyze','succeed',1,{outputSummary:'本地分析完成'})
 assert.equal(current.steps.find((step:{id:string})=>step.id==='join')!.state,'blocked')
 await change('external','start',0)
 const waitRequest=randomUUID(),waitInput={requestId:waitRequest,flowId:created.flowId,stepId:'external',action:'wait',expectedAttempts:1,waitReason:'等待工单系统回执'}
 const waiting=await flows.transition(fixture.owner,waitInput),replayed=await flows.transition(fixture.owner,waitInput)
 assert.deepEqual(replayed,waiting);assert.equal(waiting.state,'waiting');assert.equal(waiting.steps.find((step:{id:string})=>step.id==='external')!.waitReason,'等待工单系统回执')
 current=await change('external','resume',1);assert.equal(current.steps.find((step:{id:string})=>step.id==='external')!.attempts,1)
 current=await change('external','succeed',1,{outputSummary:'外部回执已核对'});assert.equal(current.steps.find((step:{id:string})=>step.id==='join')!.state,'ready')
 await change('join','start',0);await change('join','succeed',1,{outputSummary:'两路结果一致'})
 await change('change','start',0);current=await change('change','fail',1,{outputSummary:'下游拒绝动作'})
 assert.equal(current.steps.find((step:{id:string})=>step.id==='undo')!.state,'ready')
 const compensationRequest=randomUUID(),compensationInput={requestId:compensationRequest,flowId:created.flowId,stepId:'undo',action:'start',expectedAttempts:0}
 const compensating=await flows.transition(fixture.owner,compensationInput)
 assert.deepEqual(await flows.transition(fixture.owner,compensationInput),compensating)
 assert.equal((await flows.get(fixture.owner,{runId:fixture.run.id}))!.steps.find((step:{id:string})=>step.id==='undo')!.attempts,1)
 current=await change('undo','succeed',1,{outputSummary:'原状态已恢复'})
 assert.equal(current.steps.find((step:{id:string})=>step.id==='undo')!.state,'compensated');assert.equal(current.state,'compensated')
})

test('失败步骤的链式普通后继全部取消，补偿完成后 Flow 收敛',async()=>{
 const fixture=await preparedRun(),flows=new TaskRunFlowService(pool,identity)
 const created=await flows.create(fixture.owner,{requestId:randomUUID(),runId:fixture.run.id,definitionVersion:1,steps:[
  {id:'tail',title:'形成交付',kind:'work',dependsOn:['middle'],inputSummary:'使用变更结果'},
  {id:'middle',title:'核对变更',kind:'work',dependsOn:['change'],inputSummary:'核对变更状态'},
  {id:'change',title:'执行变更',kind:'work',dependsOn:[],inputSummary:'执行已授权变更'},
  {id:'undo',title:'撤销变更',kind:'compensation',dependsOn:[],compensates:'change',inputSummary:'恢复变更前状态'},
 ]})
 const change=(stepId:string,action:string,expectedAttempts:number,outputSummary?:string)=>flows.transition(fixture.owner,{requestId:randomUUID(),flowId:created.flowId,stepId,action,expectedAttempts,...(outputSummary?{outputSummary}:{})})
 await change('change','start',0)
 const failed=await change('change','fail',1,'外部系统拒绝变更')
 assert.deepEqual(failed.steps.filter(step=>['middle','tail'].includes(step.id)).map(step=>[step.id,step.state]),[['tail','cancelled'],['middle','cancelled']])
 assert.equal(failed.steps.find(step=>step.id==='undo')!.state,'ready')
 await change('undo','start',0)
 const compensated=await change('undo','succeed',1,'原状态已恢复')
 assert.equal(compensated.state,'compensated')
})

test('步骤推进锁定父 Run，并拒绝终态 Run 与断裂的反向 Flow 引用',async()=>{
 const fixture=await preparedRun(),flows=new TaskRunFlowService(pool,identity)
 const created=await flows.create(fixture.owner,{requestId:randomUUID(),runId:fixture.run.id,definitionVersion:1,steps:[
  {id:'work',title:'执行工作',kind:'work',dependsOn:[],inputSummary:'固定输入'},
  {id:'review',title:'本人核对',kind:'human_checkpoint',dependsOn:['work'],inputSummary:'核对工作结果'},
 ]})
 const transition={requestId:randomUUID(),flowId:created.flowId,stepId:'work',action:'start',expectedAttempts:0}
 const blocker=await pool.connect();let committed=false
 try{
  await blocker.query('begin');await blocker.query('select id from teloa_task_runs where id=$1 for update',[fixture.run.id])
  const pending=flows.transition(fixture.owner,transition).then(value=>({kind:'value' as const,value}),error=>({kind:'error' as const,error}))
  const race=await Promise.race([pending,new Promise<'pending'>(resolve=>setTimeout(()=>resolve('pending'),50))])
  assert.equal(race,'pending','步骤推进没有等待父 Run 行锁')
  await blocker.query("update teloa_task_runs set state='ended' where id=$1",[fixture.run.id]);await blocker.query('commit');committed=true
  const outcome=await pending
  assert.equal(outcome.kind,'error');assert.equal((outcome as {error:{code?:string}}).error.code,'teloa/conflict')
 }finally{if(!committed)await blocker.query('rollback');blocker.release()}

 for(const terminal of ['withdrawn','configuration_failed'] as const){
  const item=await preparedRun(),flow=await flows.create(item.owner,{requestId:randomUUID(),runId:item.run.id,definitionVersion:1,steps:[
   {id:'work',title:'执行工作',kind:'work',dependsOn:[],inputSummary:'固定输入'},
   {id:'review',title:'本人核对',kind:'human_checkpoint',dependsOn:['work'],inputSummary:'核对工作结果'},
  ]})
  await pool.query(`update teloa_task_runs set state=$2,configuration_error=case when $2='configuration_failed' then '{"code":"teloa/preset-unavailable","stage":"preset-resolve","message":"配置失败"}'::jsonb else null end where id=$1`,[item.run.id,terminal])
  await assert.rejects(flows.transition(item.owner,{requestId:randomUUID(),flowId:flow.flowId,stepId:'work',action:'start',expectedAttempts:0}),{code:'teloa/conflict'})
 }

 const broken=await preparedRun(),brokenFlow=await flows.create(broken.owner,{requestId:randomUUID(),runId:broken.run.id,definitionVersion:1,steps:[
  {id:'work',title:'执行工作',kind:'work',dependsOn:[],inputSummary:'固定输入'},
  {id:'review',title:'本人核对',kind:'human_checkpoint',dependsOn:['work'],inputSummary:'核对工作结果'},
 ]})
 await pool.query('update teloa_task_runs set flow_id=null where id=$1',[broken.run.id])
 await assert.rejects(flows.transition(broken.owner,{requestId:randomUUID(),flowId:brokenFlow.flowId,stepId:'work',action:'start',expectedAttempts:0}),{code:'teloa/storage-corrupt'})
})

test('首次响应丢失后父 Run 已结束，精确步骤回执仍可幂等重放',async()=>{
 const fixture=await preparedRun(),flows=new TaskRunFlowService(pool,identity)
 const created=await flows.create(fixture.owner,{requestId:randomUUID(),runId:fixture.run.id,definitionVersion:1,steps:[
  {id:'work',title:'执行工作',kind:'work',dependsOn:[],inputSummary:'固定输入'},
  {id:'review',title:'本人核对',kind:'human_checkpoint',dependsOn:['work'],inputSummary:'核对工作结果'},
 ]})
 const request={requestId:randomUUID(),flowId:created.flowId,stepId:'work',action:'start',expectedAttempts:0}
 const first=await flows.transition(fixture.owner,request)
 await assert.rejects(flows.transition(fixture.owner,{...request,stepId:'review'}),{code:'teloa/conflict'})
 await pool.query("update teloa_task_runs set state='ended' where id=$1",[fixture.run.id])
 assert.deepEqual(await flows.transition(fixture.owner,request),first)
})

test('读回拒绝聚合状态、尝试次数或时间关系损坏的 Flow',async()=>{
 const fixture=await preparedRun(),flows=new TaskRunFlowService(pool,identity)
 const created=await flows.create(fixture.owner,{requestId:randomUUID(),runId:fixture.run.id,definitionVersion:1,steps:[
  {id:'work',title:'执行工作',kind:'work',dependsOn:[],inputSummary:'固定输入'},
  {id:'external',title:'等待外部回执',kind:'wait_external',dependsOn:['work'],inputSummary:'等待回执'},
 ]})
 const stored=(await pool.query('select state,steps,updated_at from teloa_task_run_flows where flow_id=$1',[created.flowId])).rows[0]
 const restore=()=>pool.query('update teloa_task_run_flows set state=$2,steps=$3,updated_at=$4 where flow_id=$1',[created.flowId,stored.state,JSON.stringify(stored.steps),stored.updated_at])
 const corruptions=[
  ()=>pool.query("update teloa_task_run_flows set state='completed' where flow_id=$1",[created.flowId]),
  ()=>pool.query("update teloa_task_run_flows set steps=jsonb_set(steps,'{0,attempts}','1'::jsonb) where flow_id=$1",[created.flowId]),
  ()=>pool.query("update teloa_task_run_flows set steps=jsonb_set(steps,'{0,completedAt}',to_jsonb($2::text)) where flow_id=$1",[created.flowId,identity.now()]),
  ()=>pool.query("update teloa_task_run_flows set updated_at=created_at-interval '1 second' where flow_id=$1",[created.flowId]),
  ()=>{
   const steps=structuredClone(stored.steps);Object.assign(steps[0],{state:'running',attempts:1,startedAt:identity.now()});Object.assign(steps[1],{state:'ready'})
   return pool.query("update teloa_task_run_flows set state='active',steps=$2 where flow_id=$1",[created.flowId,JSON.stringify(steps)])
  },
  ()=>{
   const steps=structuredClone(stored.steps);Object.assign(steps[0],{state:'cancelled',completedAt:identity.now()});Object.assign(steps[1],{state:'succeeded',attempts:1,startedAt:identity.now(),completedAt:identity.now(),outputSummary:'伪造完成'})
   return pool.query("update teloa_task_run_flows set state='completed',steps=$2 where flow_id=$1",[created.flowId,JSON.stringify(steps)])
  },
 ]
 for(const damage of corruptions){await damage();await assert.rejects(flows.get(fixture.owner,{runId:fixture.run.id}),{code:'teloa/storage-corrupt'});await restore()}
 await assert.rejects(flows.transition(fixture.owner,{requestId:randomUUID(),flowId:created.flowId,stepId:'not-fixed',action:'start',expectedAttempts:0}),{code:'teloa/invalid-input'})
})

test('读回拒绝与目标成败因果不一致的补偿步骤状态',async()=>{
 const fixture=await preparedRun(),flows=new TaskRunFlowService(pool,identity)
 const created=await flows.create(fixture.owner,{requestId:randomUUID(),runId:fixture.run.id,definitionVersion:1,steps:[
  {id:'change',title:'执行变更',kind:'work',dependsOn:[],inputSummary:'固定变更'},
  {id:'undo',title:'撤销变更',kind:'compensation',dependsOn:[],compensates:'change',inputSummary:'恢复原状态'},
 ]})
 const stored=(await pool.query('select state,steps from teloa_task_run_flows where flow_id=$1',[created.flowId])).rows[0],restore=()=>pool.query('update teloa_task_run_flows set state=$2,steps=$3 where flow_id=$1',[created.flowId,stored.state,JSON.stringify(stored.steps)])
 const impossible=[
  ()=>{const steps=structuredClone(stored.steps);Object.assign(steps[1],{state:'ready'});return {state:'active',steps}},
  ()=>{const steps=structuredClone(stored.steps);Object.assign(steps[0],{state:'succeeded',attempts:1,startedAt:identity.now(),completedAt:identity.now(),outputSummary:'变更完成'});Object.assign(steps[1],{state:'compensated',attempts:1,startedAt:identity.now(),completedAt:identity.now(),outputSummary:'伪造补偿'});return {state:'completed',steps}},
 ]
 for(const forge of impossible){const value=forge();await pool.query('update teloa_task_run_flows set state=$2,steps=$3 where flow_id=$1',[created.flowId,value.state,JSON.stringify(value.steps)]);await assert.rejects(flows.get(fixture.owner,{runId:fixture.run.id}),{code:'teloa/storage-corrupt'});await restore()}
})

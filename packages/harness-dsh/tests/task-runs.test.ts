import test from 'node:test'
import assert from 'node:assert/strict'
import {WorkError,type DigitalRole,type TaskRunModelPolicy} from '@teloa/contract'
import type {TaskExecutionScope,TaskRunService,TaskRunSkillDatabase} from '@teloa/backend'
import {TaskRunPresetError} from '@teloa/backend'
import {createTaskRunHandler} from '../src/task-runs.ts'
const ordinary=(service:TaskRunService)=>Object.assign(service,{conversationParent:async()=>null})

test('公开一键与完整准备不能为已持久父交办预约会话或建立 Run',async()=>{
 const taskId='22345678-1234-4234-8234-123456789012',identity={sessionId:'work-one',requestId:'12345678-1234-4234-8234-123456789012',roleId:'32345678-1234-4234-8234-123456789012'},calls:string[]=[]
 const service={conversationParent:async()=>identity,prepare:async()=>{calls.push('prepare');return {state:'prepared'}}} as unknown as TaskRunService
 const handler=createTaskRunHandler('owner',async()=>service,{check:async()=>{},send:async()=>{},stop:async()=>{},events:async()=>[]},undefined,{conversations:{runReservation:async()=>{calls.push('reservation');return null},createRun:async()=>{calls.push('create');throw Error('不应创建运行会话')},failRunReservation:async()=>false},links:{change:async()=>{calls.push('link');throw Error('不应关联运行会话')}}})
 await assert.rejects(handler('task-runs/prepare',{requestId:'42345678-1234-4234-8234-123456789012',taskId,expectedTaskVersion:1},new AbortController().signal),{code:'teloa/conflict'})
 await assert.rejects(handler('task-runs/prepare',{requestId:'42345678-1234-4234-8234-123456789012',taskId,expectedTaskVersion:1,roleId:identity.roleId,expectedRoleVersion:1,sessionId:'run',expectedLinkVersion:1},new AbortController().signal),{code:'teloa/conflict'})
 await assert.rejects(handler('task-runs/prepare',{requestId:'42345678-1234-4234-8234-123456789012',taskId,expectedTaskVersion:1,parentIdentity:identity},new AbortController().signal),{code:'teloa/invalid-input'})
 assert.deepEqual(calls,[])
})

test('公开启动不能领取已持久父交办 Run 或调用原生发送',async()=>{
 const runId='42345678-1234-4234-8234-123456789012',identity={sessionId:'work-one',requestId:'12345678-1234-4234-8234-123456789012',roleId:'32345678-1234-4234-8234-123456789012'},calls:string[]=[]
 const run={id:runId,sessionId:'task-run-one',nativeRequestId:runId,state:'prepared'}
 const service={conversationParent:async()=>identity,get:async()=>run,executionScope:async()=>({taskId:'task',taskVersion:1,sessionId:'task-run-one',linkVersion:1,scope:'SOC'}),claim:async()=>{calls.push('claim');return {run,dispatch:true}}} as unknown as TaskRunService
 const handler=createTaskRunHandler('owner',async()=>service,{check:async()=>{},send:async()=>{calls.push('send')},stop:async()=>{},events:async()=>[]})
 await assert.rejects(handler('task-runs/start',{runId},new AbortController().signal),{code:'teloa/conflict'})
 assert.deepEqual(calls,[])
})
test('仅宿主传入固定父身份可继续原 prepare→claim→send 路径',async()=>{
 const taskId='22345678-1234-4234-8234-123456789012',runId='42345678-1234-4234-8234-123456789012',identity={sessionId:'work-one',requestId:'12345678-1234-4234-8234-123456789012',roleId:'32345678-1234-4234-8234-123456789012'},calls:string[]=[]
 const run={id:runId,taskId,sessionId:'task-run-one',nativeRequestId:runId,state:'prepared'},target={taskId,taskVersion:1,sessionId:run.sessionId,linkVersion:1,scope:'SOC'}
 const service={conversationParent:async()=>identity,prepare:async()=>{calls.push('prepare');return run},get:async()=>run,executionScope:async()=>target,claim:async()=>{calls.push('claim');return {run,dispatch:true,target}},record:async()=>({...run,state:'accepted'})} as unknown as TaskRunService
 const handler=createTaskRunHandler('owner',async()=>service,{check:async()=>{},send:async()=>{calls.push('send')},stop:async()=>{},events:async()=>[]}),signal=new AbortController().signal
 const input={requestId:runId,taskId,expectedTaskVersion:1,roleId:identity.roleId,expectedRoleVersion:1,sessionId:run.sessionId,expectedLinkVersion:1}
 await assert.rejects(handler('task-runs/prepare',input,signal,{...identity,requestId:'99999999-9999-4999-8999-999999999999'}),{code:'teloa/conflict'})
 assert.deepEqual(calls,[])
 await handler('task-runs/prepare',input,signal,identity)
 await handler('task-runs/start',{runId},signal,identity)
 assert.deepEqual(calls,['prepare','claim','send'])
})

test('执行 RPC 使用宿主身份，拒绝客户端写状态或权限及未知入口',async()=>{
 let opened=0
 const service={list:async(owner:string,payload:unknown)=>{assert.equal(owner,'local-owner');assert.deepEqual(payload,{taskId:'task'});return []}} as unknown as TaskRunService
 const handler=createTaskRunHandler('local-owner',async()=>{opened++;return service},{check:async()=>{},send:async()=>{},stop:async()=>{},events:async()=>[]}),signal=new AbortController().signal
 await assert.rejects(handler('task-runs/record',{runId:'run',evidence:{state:'ended'}},signal),{code:'teloa/not-found'})
 for(const endpoint of ['task-runs/list','task-runs/prepare','task-runs/start','task-runs/reconcile'])await assert.rejects(handler(endpoint,{ownerId:'forged',allowedTools:['write_action']},signal),{code:'teloa/invalid-input'})
 assert.equal(opened,0)
 assert.deepEqual(await handler('task-runs/list',{taskId:'task'},signal),[])
})

test('Run 回包一次读取登记；令牌估算只读附带，无子级时保持缺省',async()=>{
 const first={id:'11111111-1111-4111-8111-111111111111',sessionId:'run-one'},second={id:'22222222-2222-4222-8222-222222222222',sessionId:'run-two'}
 const service={list:async()=>[first,second]} as unknown as TaskRunService,calls:string[][]=[]
 const registered={runId:first.id,reservationId:'call:one',state:'ended' as const,createdAt:'2026-09-17T00:00:00.000Z',endedAt:'2026-09-17T00:01:00.000Z',startedAt:'2026-09-17T00:00:00.000Z',childSessionId:'child_one',depth:1,stopReason:'completed'}
 const handler=createTaskRunHandler('local-owner',async()=>ordinary(service),{check:async()=>{},send:async()=>{},stop:async()=>{},events:async()=>[]},undefined,undefined,{listMany:async(owner,ids)=>{assert.equal(owner,'local-owner');calls.push([...ids]);return new Map([[first.id,[registered]]])}},{estimate:async sessionId=>sessionId==='run-one'?111:222})
 assert.deepEqual(await handler('task-runs/list',{taskId:'task'},new AbortController().signal),[{...first,subagents:[registered],contextTokenEstimate:111},{...second,contextTokenEstimate:222}])
 assert.deepEqual(calls,[[first.id,second.id]])
})

test('卡住子任务只能经显式恢复入口按父 Run 和预留身份收口，再读取真实运行快照',async()=>{
 const run={id:'11111111-1111-4111-8111-111111111111',sessionId:'run-one'},reservationId='call:one',recovered={runId:run.id,reservationId,state:'abandoned' as const,createdAt:'2026-09-17T00:00:00.000Z',endedAt:'2026-09-17T00:01:00.000Z',stopReason:'manual-recovery'},calls:unknown[]=[]
 const service={get:async(owner:string,payload:unknown)=>{assert.equal(owner,'local-owner');assert.deepEqual(payload,{runId:run.id});return run}} as unknown as TaskRunService
 const handler=createTaskRunHandler('local-owner',async()=>ordinary(service),{check:async()=>{},send:async()=>{},stop:async()=>{},events:async()=>[]},undefined,undefined,{recover:async(owner,input)=>{assert.equal(owner,'local-owner');assert.deepEqual(input,{runId:run.id,reservationId});calls.push(input);return recovered},listMany:async(_owner,ids)=>new Map([[ids[0]!, [recovered]]])})
 assert.deepEqual(await handler('task-runs/subagents/recover',{runId:run.id,reservationId},new AbortController().signal),{...run,subagents:[recovered]})
 assert.deepEqual(calls,[{runId:run.id,reservationId}])
 await assert.rejects(createTaskRunHandler('local-owner',async()=>ordinary(service),{check:async()=>{},send:async()=>{},stop:async()=>{},events:async()=>[]})('task-runs/subagents/recover',{runId:run.id,reservationId},new AbortController().signal),{code:'teloa/unavailable'})
})

test('准备执行以服务端任务关联读取知识，Skill 复验沿用 prepare 的同一数据库连接',async()=>{
 const target:TaskExecutionScope={taskId:'task',taskVersion:3,sessionId:'session',linkVersion:2,scope:'SOC'}
 const role={skills:[],knowledge:['knowledge']} as unknown as DigitalRole
 const knowledge=[{id:'knowledge'}] as never
 const checks:unknown[]=[],loads:unknown[]=[],database={query:async()=>({rows:[]})} as unknown as TaskRunSkillDatabase
 const service={prepare:async(_owner:string,_payload:unknown,checkSession:unknown,loadKnowledge:unknown)=>{
  await (checkSession as (sessionId:string,role:DigitalRole,db:TaskRunSkillDatabase)=>Promise<void>)('session',role,database)
  await (loadKnowledge as (target:TaskExecutionScope,role:DigitalRole)=>Promise<unknown>)(target,role)
  return {state:'prepared'}
 }} as unknown as TaskRunService
 const skillLoads:unknown[]=[]
 const handler=createTaskRunHandler('local-owner',async()=>ordinary(service),{check:async(...args)=>{checks.push(args[2])},loadSkills:async(...args)=>{skillLoads.push(args[3]);return []},loadKnowledge:async(...args)=>{loads.push([args[0],args[1]]);return knowledge},send:async()=>{},stop:async()=>{},events:async()=>[]})
 await handler('task-runs/prepare',{requestId:'request',taskId:'task',expectedTaskVersion:3,roleId:'role',expectedRoleVersion:2,sessionId:'session',expectedLinkVersion:2},new AbortController().signal)
 assert.deepEqual(checks,[undefined])
 assert.deepEqual(skillLoads,[database])
 assert.deepEqual(loads,[[target,['knowledge']]])
})

test('准备执行把岗位自身范围一并交给知识读口，通用范围任务据此读岗位声明的资料',async()=>{
 const target:TaskExecutionScope={taskId:'task',taskVersion:3,sessionId:'session',linkVersion:2,scope:'general'}
 const role={skills:[],knowledge:['knowledge'],scopes:['SOC']} as unknown as DigitalRole
 const loads:unknown[]=[]
 const service={prepare:async(_owner:string,_payload:unknown,_checkSession:unknown,loadKnowledge:unknown)=>{
  await (loadKnowledge as (target:TaskExecutionScope,role:DigitalRole)=>Promise<unknown>)(target,role)
  return {state:'prepared'}
 }} as unknown as TaskRunService
 const handler=createTaskRunHandler('local-owner',async()=>ordinary(service),{check:async()=>{},loadSkills:async()=>[],loadKnowledge:async(...args)=>{loads.push([args[0],args[1],args[3]]);return []},send:async()=>{},stop:async()=>{},events:async()=>[]})
 await handler('task-runs/prepare',{requestId:'request',taskId:'task',expectedTaskVersion:3,roleId:'role',expectedRoleVersion:2,sessionId:'session',expectedLinkVersion:2},new AbortController().signal)
 assert.deepEqual(loads,[[target,['knowledge'],['SOC']]])
})

test('准备执行先用岗位固定 preset 创建并核对运行专用会话',async()=>{
 const primary={provider:'ollama',model:'small'},fallback={provider:'remote',model:'large'}
 const role={skills:[],knowledge:[],runtimeConfig:{agentPresetId:'security-analyst',model:primary,fallbackModel:fallback}} as unknown as DigitalRole
 const database={query:async()=>({rows:[]})} as unknown as TaskRunSkillDatabase,calls:string[]=[]
 const service={prepare:async(_owner:string,_payload:unknown,checkSession:unknown,_loadRoleKnowledge:unknown,_loadTaskKnowledge:unknown,verifyRuntime:unknown,verifyModels:unknown)=>{
  await (verifyRuntime as (sessionId:string,agentPresetId:string)=>Promise<void>)('run-session',role.runtimeConfig!.agentPresetId!)
  assert.deepEqual(await (verifyModels as (role:DigitalRole)=>Promise<TaskRunModelPolicy>)(role),{primary,fallback})
  await (checkSession as (sessionId:string,role:DigitalRole,db:TaskRunSkillDatabase)=>Promise<void>)('run-session',role,database)
  return {state:'prepared'}
 }} as unknown as TaskRunService
 const signal=new AbortController().signal
 const handler=createTaskRunHandler('local-owner',async()=>ordinary(service),{prepareModels:async(runtime,actualSignal)=>{assert.equal(actualSignal,signal);assert.deepEqual(runtime,role.runtimeConfig);calls.push('model');return {primary,fallback}},prepareSession:async(sessionId,agentPresetId,actualSignal)=>{assert.equal(actualSignal,signal);calls.push('preset:'+sessionId+':'+agentPresetId);return agentPresetId!},check:async()=>{calls.push('check')},loadSkills:async()=>[],send:async()=>{},stop:async()=>{},events:async()=>[]})
 assert.deepEqual(await handler('task-runs/prepare',{requestId:'request',taskId:'task',expectedTaskVersion:3,roleId:'role',expectedRoleVersion:2,sessionId:'run-session',expectedLinkVersion:2},signal),{state:'prepared'})
 assert.deepEqual(calls,['preset:run-session:security-analyst','model','check'])
})

test('准备执行把任务补充知识与岗位知识分开加载并沿用同一数据库连接',async()=>{
 const target:TaskExecutionScope={taskId:'task',taskVersion:3,sessionId:'session',linkVersion:2,scope:'SOC'}
 const role={skills:[],knowledge:['role-knowledge']} as unknown as DigitalRole
 const database={query:async()=>({rows:[]})} as unknown as TaskRunSkillDatabase
 const roleKnowledge=[{id:'role-knowledge'}] as never,taskKnowledge=[{id:'task-knowledge'}] as never
 const service={prepare:async(_owner:string,_payload:unknown,checkSession:unknown,loadRoleKnowledge:unknown,loadTaskKnowledge:unknown)=>{
  await (checkSession as (sessionId:string,role:DigitalRole,db:TaskRunSkillDatabase)=>Promise<void>)('session',role,database)
  assert.deepEqual(await (loadRoleKnowledge as (target:TaskExecutionScope,role:DigitalRole)=>Promise<unknown>)(target,role),roleKnowledge)
  assert.deepEqual(await (loadTaskKnowledge as (target:TaskExecutionScope,role:DigitalRole,db:TaskRunSkillDatabase)=>Promise<unknown>)(target,role,database),taskKnowledge)
  return {state:'prepared'}
 }} as unknown as TaskRunService
 const taskLoads:unknown[]=[]
 const handler=createTaskRunHandler('local-owner',async()=>ordinary(service),{check:async()=>{},loadSkills:async()=>[],loadKnowledge:async()=>roleKnowledge,send:async()=>{},stop:async()=>{},events:async()=>[]},async(...args)=>{taskLoads.push(args);return taskKnowledge})
 const signal=new AbortController().signal
 await handler('task-runs/prepare',{requestId:'request',taskId:'task',expectedTaskVersion:3,roleId:'role',expectedRoleVersion:2,sessionId:'session',expectedLinkVersion:2},signal)
 assert.deepEqual(taskLoads,[[target,role,database,signal]])
})

test('一键准备从任务负责人读取 preset，创建并关联运行专用会话后固定 Run',async()=>{
 const requestId='12345678-1234-4234-8234-123456789012',taskId='22345678-1234-4234-8234-123456789012',roleId='32345678-1234-4234-8234-123456789012',sessionId='task-run-'+requestId,calls:string[]=[]
 const primary={provider:'ollama',model:'small'},role={runtimeConfig:{model:primary}} as DigitalRole
 const service={
  request:async()=>null,
  preparationTarget:async()=>({taskId,taskVersion:3,title:'核对告警',roleId,roleVersion:5,agentPresetId:'security-analyst'}),
  prepare:async(_owner:string,payload:unknown,_check:unknown,_roleKnowledge:unknown,_taskKnowledge:unknown,verifyRuntime:unknown,verifyModels:unknown)=>{assert.deepEqual(payload,{requestId,taskId,expectedTaskVersion:3,roleId,expectedRoleVersion:5,sessionId,expectedLinkVersion:1});assert.equal(await (verifyRuntime as (sessionId:string)=>Promise<string>)(sessionId),'security-analyst');assert.deepEqual(await (verifyModels as (role:DigitalRole)=>Promise<TaskRunModelPolicy>)(role),{primary});return {state:'prepared',sessionId,agentPresetId:'security-analyst'}},
 } as unknown as TaskRunService
 const signal=new AbortController().signal
 const handler=createTaskRunHandler('local-owner',async()=>ordinary(service),{prepareModels:async(runtime,actualSignal)=>{assert.equal(actualSignal,signal);assert.deepEqual(runtime,role.runtimeConfig);calls.push('model');return {primary}},resolvePreset:async declared=>{calls.push('resolve:'+declared);return 'security-analyst'},prepareSession:async(id,preset)=>{calls.push('verify:'+id+':'+preset);return preset!},check:async()=>{},send:async()=>{},stop:async()=>{},events:async()=>[]},undefined,{
  conversations:{runReservation:async()=>null,failRunReservation:async()=>false,createRun:async(_owner,_input,options)=>{calls.push('create:'+options.sessionId+':'+options.agentPresetId);return {id:'conversation',ownerId:'local-owner',title:'核对告警',scopeIds:['general'],version:1,status:'ready',requestedSessionId:options.sessionId,sessionId:options.sessionId,createdAt:'2026-09-13T00:00:00.000Z',requestId,purpose:'task-run',run:{taskId,taskVersion:3,roleId,roleVersion:5,agentPresetId:options.agentPresetId}}}},
  links:{change:async()=>{calls.push('link');return {kind:'task',objectId:taskId,objectVersion:3,conversationId:'conversation',sessionId,version:1,active:true,updatedAt:'2026-09-13T00:00:00.000Z',scopeId:null}}},
 })
 assert.deepEqual(await handler('task-runs/prepare',{requestId,taskId,expectedTaskVersion:3},signal),{state:'prepared',sessionId,agentPresetId:'security-analyst'})
 assert.deepEqual(calls,['resolve:security-analyst','create:'+sessionId+':security-analyst','link','model'])
})

test('一键准备拒绝运行会话回执中被替换的服务端预约快照',async()=>{
 const requestId='12345678-1234-4234-8234-123456789012',taskId='22345678-1234-4234-8234-123456789012',roleId='32345678-1234-4234-8234-123456789012',sessionId='task-run-'+requestId
 const service={request:async()=>null,preparationTarget:async()=>({taskId,taskVersion:3,title:'核对告警',roleId,roleVersion:5,agentPresetId:'security-analyst'})} as unknown as TaskRunService
 const handler=createTaskRunHandler('local-owner',async()=>ordinary(service),{resolvePreset:async()=> 'security-analyst',check:async()=>{},send:async()=>{},stop:async()=>{},events:async()=>[]},undefined,{
  conversations:{runReservation:async()=>null,failRunReservation:async()=>false,createRun:async()=>({id:'conversation',ownerId:'local-owner',title:'核对告警',scopeIds:['general'],version:1,status:'ready',requestedSessionId:sessionId,sessionId,createdAt:'2026-09-13T00:00:00.000Z',requestId,purpose:'task-run',run:{taskId,taskVersion:3,roleId,roleVersion:6,agentPresetId:'other-preset'}})},
  links:{change:async()=>{throw Error('不应关联被替换的预约')}},
 })
 await assert.rejects(handler('task-runs/prepare',{requestId,taskId,expectedTaskVersion:3},new AbortController().signal),{code:'teloa/storage-corrupt'})
})

test('一键准备 preset 解析失败直接保留配置失败 Run，不创建会话或发送',async()=>{
 const requestId='12345678-1234-4234-8234-123456789012',taskId='22345678-1234-4234-8234-123456789012',roleId='32345678-1234-4234-8234-123456789012',failure={state:'configuration_failed'},calls:string[]=[]
 const service={request:async()=>null,preparationTarget:async()=>({taskId,taskVersion:3,title:'核对告警',roleId,roleVersion:5,agentPresetId:'missing-preset'}),failPreparation:async(_owner:string,payload:unknown,error:unknown)=>{calls.push('failed');assert.deepEqual(payload,{requestId,taskId,expectedTaskVersion:3,roleId,expectedRoleVersion:5,sessionId:'task-run-'+requestId});assert.ok(error instanceof Error);return failure}} as unknown as TaskRunService
 const handler=createTaskRunHandler('local-owner',async()=>ordinary(service),{resolvePreset:async()=>{throw Error('missing')},check:async()=>{},send:async()=>{},stop:async()=>{},events:async()=>[]},undefined,{conversations:{runReservation:async()=>null,failRunReservation:async()=>false,createRun:async()=>{calls.push('create');throw Error()}},links:{change:async()=>{calls.push('link');throw Error()}}})
 assert.equal(await handler('task-runs/prepare',{requestId,taskId,expectedTaskVersion:3},new AbortController().signal),failure)
 assert.deepEqual(calls,['failed'])
})

test('一键创建运行会话失败后先固定终态 Run 再释放 pending 预约，精确重放不重启 Agent',async()=>{
 const requestId='12345678-1234-4234-8234-123456789012',taskId='22345678-1234-4234-8234-123456789012',roleId='32345678-1234-4234-8234-123456789012',sessionId='task-run-'+requestId,calls:string[]=[]
 const failure={id:'failed-run',requestId,taskId,roleId,sessionId,state:'configuration_failed'}
 let previous:null|typeof failure=null
 const service={request:async()=>previous,preparationTarget:async()=>({taskId,taskVersion:3,title:'核对告警',roleId,roleVersion:5,agentPresetId:'security-analyst'}),failPreparation:async()=>{calls.push('failed');previous=failure;return failure}} as unknown as TaskRunService
 const handler=createTaskRunHandler('local-owner',async()=>ordinary(service),{resolvePreset:async()=>{calls.push('resolve');return 'security-analyst'},check:async()=>{},send:async()=>{calls.push('send')},stop:async()=>{},events:async()=>[]},undefined,{
  conversations:{runReservation:async()=>null,createRun:async()=>{calls.push('create');throw new TaskRunPresetError('teloa/preset-unavailable','session-receipt','回执不一致')},failRunReservation:async()=>{calls.push('release');return true}},
  links:{change:async()=>{calls.push('link');throw Error()}},
 })
 const signal=new AbortController().signal,input={requestId,taskId,expectedTaskVersion:3}
 assert.equal(await handler('task-runs/prepare',input,signal),failure)
 assert.equal(await handler('task-runs/prepare',input,signal),failure)
 assert.deepEqual(calls,['resolve','create','failed','release','release'])
})

test('已有会话预约但任务固定岗位过期时，重放不再创建会话、关联或 Run',async()=>{
 const requestId='12345678-1234-4234-8234-123456789012',taskId='22345678-1234-4234-8234-123456789012',roleId='32345678-1234-4234-8234-123456789012',sessionId='task-run-'+requestId,calls:string[]=[]
 const reservation={id:'conversation',ownerId:'local-owner',title:'首次标题',scopeIds:['general'] as ['general'],version:1 as const,status:'pending' as const,requestedSessionId:sessionId,sessionId,createdAt:'2026-09-13T00:00:00.000Z',requestId,purpose:'task-run' as const,run:{taskId,taskVersion:3,roleId,roleVersion:5,agentPresetId:'fixed-preset'}}
 const service={request:async()=>null,preparationTarget:async()=>{calls.push('preflight');throw new WorkError('teloa/version-conflict','任务固定的数字员工版本已变化。')},prepare:async()=>{calls.push('run');return {state:'prepared'}}} as unknown as TaskRunService
 const handler=createTaskRunHandler('local-owner',async()=>ordinary(service),{resolvePreset:async()=>{calls.push('resolve');return 'other'},check:async()=>{},send:async()=>{},stop:async()=>{},events:async()=>[]},undefined,{
  conversations:{runReservation:async()=>reservation,failRunReservation:async()=>false,createRun:async()=>{calls.push('create');return reservation}},
  links:{change:async()=>{calls.push('link');throw Error('不应关联')}},
 })
 await assert.rejects(handler('task-runs/prepare',{requestId,taskId,expectedTaskVersion:3},new AbortController().signal),{code:'teloa/version-conflict'})
 assert.deepEqual(calls,['preflight'])
})

test('一键准备重放先复核当前任务仍固定原岗位，不重新解析 preset',async()=>{
 const requestId='12345678-1234-4234-8234-123456789012',taskId='22345678-1234-4234-8234-123456789012',roleId='32345678-1234-4234-8234-123456789012',sessionId='task-run-'+requestId,calls:string[]=[]
 const reservation={id:'conversation',ownerId:'local-owner',title:'首次标题',scopeIds:['general'] as ['general'],version:1 as const,status:'ready' as const,requestedSessionId:sessionId,sessionId,createdAt:'2026-09-13T00:00:00.000Z',requestId,purpose:'task-run' as const,run:{taskId,taskVersion:3,roleId,roleVersion:5,agentPresetId:'fixed-preset'}}
 const service={request:async()=>null,preparationTarget:async()=>{calls.push('preflight');return {taskId,taskVersion:3,title:'首次标题',roleId,roleVersion:5,agentPresetId:'fixed-preset'}},prepare:async()=>({state:'prepared',sessionId,agentPresetId:'fixed-preset'})} as unknown as TaskRunService
 const handler=createTaskRunHandler('local-owner',async()=>ordinary(service),{resolvePreset:async()=>{calls.push('resolve');throw Error('不应重新解析')},check:async()=>{},send:async()=>{},stop:async()=>{},events:async()=>[]},undefined,{
  conversations:{runReservation:async()=>reservation,failRunReservation:async()=>false,createRun:async(_owner,_input,run)=>{calls.push('create:'+run.roleVersion+':'+run.agentPresetId);return reservation}},
  links:{change:async()=>({kind:'task',objectId:taskId,objectVersion:3,conversationId:'conversation',sessionId,version:1,active:true,updatedAt:'2026-09-13T00:00:00.000Z',scopeId:null})},
 })
 assert.equal((await handler('task-runs/prepare',{requestId,taskId,expectedTaskVersion:3},new AbortController().signal) as {agentPresetId:string}).agentPresetId,'fixed-preset')
 assert.deepEqual(calls,['preflight','create:5:fixed-preset'])
})

test('模型观察只在归属校验后附带；观察失败不能让已完成的撤销看起来失败',async()=>{
 const run={id:'one',sessionId:'session',modelPolicy:{primary:{provider:'local',model:'small'}}},calls:string[]=[]
 let allowed=false
 const service={list:async()=>{if(!allowed)throw new WorkError('teloa/not-found','不存在');return [run]},withdraw:async()=>{calls.push('withdraw');return {...run,state:'withdrawn'}}} as unknown as TaskRunService
 const handler=createTaskRunHandler('owner',async()=>service,{check:async()=>{},send:async()=>{},stop:async()=>{},events:async()=>[]},undefined,undefined,undefined,undefined,undefined,{read:async value=>{calls.push(value.id);throw Error('private detail')}})
 await assert.rejects(handler('task-runs/list',{taskId:'task'},new AbortController().signal));assert.deepEqual(calls,[])
 allowed=true
 assert.deepEqual(await handler('task-runs/withdraw',{runId:'one'},new AbortController().signal),{...run,state:'withdrawn',modelStatus:{state:'unavailable'}})
 assert.deepEqual(calls,['withdraw','one'])
})

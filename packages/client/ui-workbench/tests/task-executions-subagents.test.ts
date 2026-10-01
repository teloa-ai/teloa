import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {createTaskRunApi,type TaskRunSubagentView} from '../src/client/task-run-api.ts'
import {taskRunSubagentPresentation} from '../src/client/task-run-subagent-presentation.ts'

const runId='11111111-1111-4111-8111-111111111111',taskId='22222222-2222-4222-8222-222222222222',roleId='33333333-3333-4333-8333-333333333333'
const row={id:runId,taskId,roleId,taskVersion:1,roleVersion:2,linkVersion:1,sessionId:'task-run-main',nativeRequestId:runId,state:'ended',evidence:{state:'ended',turn:0,messageSeq:1,endSeq:2,reason:'completed'},allowedTools:[],memory:[],contextTokenEstimate:123, inputText:JSON.stringify({task:{id:taskId,version:1,title:'调查',goal:'核对证据',scope:'general'},role:{id:roleId,version:2,name:'调查岗',duty:'调查',dataScope:'只读',executionScope:'代拟'}}),createdAt:'2026-09-17T10:00:00.000Z'}
const started:TaskRunSubagentView={state:'started',createdAt:'2026-09-17T10:01:00.000Z',recoveryId:'call:one',childSessionId:'child-one',depth:1,startedAt:'2026-09-17T10:02:00.000Z'}
const ended:TaskRunSubagentView={state:'ended',createdAt:'2026-09-17T10:03:00.000Z',childSessionId:'child-two',depth:1,startedAt:'2026-09-17T10:04:00.000Z',endedAt:'2026-09-17T10:05:00.000Z',stopReason:'completed',tokenEstimate:321}
const reserved:TaskRunSubagentView={state:'reserved',createdAt:'2026-09-17T10:00:00.000Z',recoveryId:'call:reserved'}
const wire=(value:TaskRunSubagentView)=>{const {recoveryId,...rest}=value;return {...rest,...(recoveryId===undefined?{}:{reservationId:recoveryId})}}

test('Run 回包严格读取子任务明细，旧宿主缺省该位仍可读',async()=>{
 const legacy=(await createTaskRunApi(async()=>[row]).list(taskId))[0]!
 assert.equal(legacy.subagents,undefined)
 const saved=(await createTaskRunApi(async()=>[{...row,subagents:[wire(started),wire(ended)]}]).list(taskId))[0]!
 assert.equal(saved.contextTokenEstimate,123)
 assert.deepEqual(saved.subagents,[started,ended])
 for(const subagents of [[],[{...started,state:'invalid'}],[{...started,endedAt:'2026-09-17T10:03:00.000Z'}],[{...started,tokenEstimate:1}],[{...ended,stopReason:''}],[{...ended,tokenEstimate:-1}],[ended,{...ended,childSessionId:'child-two'}]])await assert.rejects(createTaskRunApi(async()=>[{...row,subagents}]).list(taskId))
})

test('原生 Team 完成回包保留服务端子任务 runId 并核对归属，列表和状态核对都可读取',async()=>{
 const names=['spawn_teammate','send_message','list_agents','wait_agent','interrupt_agent','team_task_create','team_task_list','team_task_get','team_task_update']
 const argumentRules=names.map(name=>({name,allowed:[],anyArguments:true as const}))
 const completed={...row,allowedTools:names,argumentRules,subagents:[{runId,...wire(ended)}]}
 const api=createTaskRunApi(async method=>method==='task-runs/list'?[completed]:completed)
 const saved=(await api.list(taskId))[0]!
 assert.equal(saved.state,'ended');assert.equal(saved.reason,'completed')
 assert.deepEqual(saved.toolRules,argumentRules)
 assert.deepEqual(saved.subagents,[ended])
 assert.deepEqual(await api.reconcile(saved),saved)
 for(const invalidRunId of [taskId,'invalid',null])await assert.rejects(createTaskRunApi(async()=>[{...completed,subagents:[{...wire(ended),runId:invalidRunId}]}]).list(taskId))
})

test('执行明细只给本人显示编号、时间与结局，不展示内部子会话标识',async()=>{
 const view=taskRunSubagentPresentation([started,ended])
 assert.deepEqual(view,[
  {number:1,stateKey:'subagent.run.state.started',createdAt:started.createdAt,recoveryId:'call:one',startedAt:started.startedAt},
  {number:2,stateKey:'subagent.run.state.ended',outcomeKey:'subagent.run.outcome.completed',createdAt:ended.createdAt,startedAt:ended.startedAt,endedAt:ended.endedAt,tokenEstimate:321},
 ])
 const source=await readFile(new URL('../src/client/TaskExecutions.tsx',import.meta.url),'utf8')
 assert.match(source,/taskRunSubagentPresentation\(row\.subagents\)/)
 assert.match(source,/subagent\.run\.title/)
 assert.match(source,/subagent\.run\.tokenEstimate/)
 assert.match(source,/subagent\.run\.recovery\.action/)
 assert.match(source,/recoverSubagent/)
 assert.doesNotMatch(source,/childSessionId/)
})

test('显式恢复只提交父 Run 和回收身份，并要求回包将同一子任务保守中止',async()=>{
 const recovered={state:'abandoned' as const,createdAt:reserved.createdAt,recoveryId:'call:reserved',endedAt:'2026-09-17T10:06:00.000Z',stopReason:'manual-recovery'}
 const saved=(await createTaskRunApi(async()=>[{...row,subagents:[wire(reserved)]}]).list(taskId))[0]!
 const api=createTaskRunApi(async(method,payload)=>{assert.equal(method,'task-runs/subagents/recover');assert.deepEqual(payload,{runId,reservationId:'call:reserved'});return {...row,subagents:[wire(recovered)]}})
 assert.deepEqual((await api.recoverSubagent(saved,saved.subagents![0]!)).subagents,[recovered])
 const {recoveryId:_recoveryId,...withoutRecovery}=reserved
 await assert.rejects(api.recoverSubagent(saved,withoutRecovery))
 await assert.rejects(api.recoverSubagent(saved,started))
 await assert.rejects(createTaskRunApi(async()=>({...row,subagents:[wire(reserved)]})).recoverSubagent(saved,saved.subagents![0]!))
})

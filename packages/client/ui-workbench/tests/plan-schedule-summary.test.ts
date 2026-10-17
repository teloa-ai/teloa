import test from 'node:test'
import assert from 'node:assert/strict'
import {readPlanScheduleSummary} from '../src/client/plan-schedule-summary.ts'

const planId='8ddfd681-086b-4bb5-b9b2-3aca4b7b8612'
const occurrenceId='bb77082a-7cdd-48ad-b52e-6896575c59ad'
const taskId='d3b63b68-e8a2-4ef5-ae25-d4abf9cb260c'
const taskRequestId='9ce2aa39-59c5-4bf6-9d58-f8fe308d27ac'
const at='2026-09-13T01:00:00.000Z'
const occurrence={id:occurrenceId,ownerId:'local:teloa-owner',planId,planVersion:3,configVersion:1,occurrenceId:'2026-09-13T09:00[Asia/Singapore]',scheduledAt:at,claimedAt:'2026-09-13T01:00:01.000Z',taskRequestId,fields:{title:'每日核对',goal:'核对资料',scope:'SOC',dataScope:'已授权资料',delivery:'摘要',notificationPolicy:'attention',roleId:'4f23edeb-d497-405a-8606-c1a8666fb3ef',trigger:{kind:'schedule',cadence:'daily',weekday:1,time:'09:00',timezone:'Asia/Singapore'}},source:{kind:'manual'},roleVersion:2,taskRequest:{requestId:taskRequestId,fields:{title:'每日核对',goal:'核对资料',scope:'SOC'},assignee:{roleId:'4f23edeb-d497-405a-8606-c1a8666fb3ef',expectedVersion:2}}}

test('业务事件领取摘要保留固定事件并核owner、范围、触发来源及定义',()=>{
 const event={event:{schema:'teloa.work-event/v2',id:occurrenceId,ownerId:occurrence.ownerId,sourceEventId:'business:fixed',kind:'business-object-version',sourceRef:{kind:'business-object',scope:'SOC',type:'lead',id:'lead-1'},sourceVersion:'2',basisHash:'a'.repeat(64),createdAt:at},controlGeneration:1,data:{object:{title:'线索甲',version:2}}}
 const completionPolicy={kind:'manual'},workDefinition={schema:'teloa.plan-work/v3',definitionVersion:1,definitionControlId:planId,budgetAccountId:taskId,authorization:{kind:'delegation',delegationId:occurrenceId,delegationVersion:1},completion:completionPolicy,triggers:[{kind:'local-event',eventKind:'business-object-version',sourceRef:event.event.sourceRef,coalesce:'latest'}],budget:{maxGoalRounds:32,maxTokens:2000000,maxElapsedMs:21600000,maxConcurrent:1,maxRetries:3,stagnationRounds:3,money:null},overlap:'forbid',missed:'coalesce',safeRecovery:false}
 const fixed={...occurrence,event,workDefinition,occurrenceId:'event:'+occurrenceId,fields:{...occurrence.fields,completionPolicy},taskRequest:{...occurrence.taskRequest,fields:{...occurrence.taskRequest.fields,completionPolicy}}}
 const value={available:true,overview:{planId,planVersion:3,state:'paused',nextAt:null,latest:{occurrence:fixed,task:{id:taskId,state:'waiting'}},latestSkip:null},health:null}
 assert.deepEqual(readPlanScheduleSummary(value,planId),value)
 for(const invalid of [
  {...fixed,event:{...event,event:{...event.event,ownerId:'other'}}},
  {...fixed,event:{...event,event:{...event.event,sourceRef:{...event.event.sourceRef,scope:'general'}}}},
  {...fixed,event:{...event,event:{...event.event,id:taskId}}},
  {...fixed,event:{...event,extra:true}},
  {...fixed,workDefinition:undefined},
 ])assert.throws(()=>readPlanScheduleSummary({...value,overview:{...value.overview,latest:{occurrence:invalid,task:null}}},planId),/调度摘要/)
})

test('本人计划调度保留原owner授权且没有员工assignee，身份或授权错配拒绝',()=>{
 const executor={kind:'owner',grantId:planId,grantVersion:1},completionPolicy={kind:'manual'}
 const workDefinition={schema:'teloa.plan-work/v3',definitionVersion:1,definitionControlId:occurrenceId,budgetAccountId:taskRequestId,authorization:executor,completion:completionPolicy,triggers:[{kind:'schedule',schedule:occurrence.fields.trigger}],budget:{maxGoalRounds:9,maxTokens:65536,maxElapsedMs:300000,maxConcurrent:1,maxRetries:1,stagnationRounds:3,money:null},overlap:'forbid',missed:'coalesce',safeRecovery:false}
 const fixed={...occurrence,fields:{...occurrence.fields,roleId:null,scope:'general',executor:{kind:'owner'},completionPolicy},roleVersion:null,source:{kind:'method-reuse',artifactId:occurrenceId,version:1,basisHash:'a'.repeat(64),taskId},workDefinition,taskRequest:{requestId:taskRequestId,fields:{...occurrence.taskRequest.fields,scope:'general',completionPolicy}}}
 const value={available:true,overview:{planId,planVersion:3,state:'active',nextAt:null,latest:{occurrence:fixed,task:{id:taskId,state:'waiting'}},latestSkip:null},health:null}
 assert.deepEqual(readPlanScheduleSummary(value,planId),value)
 for(const changed of [
  {...fixed,roleVersion:1}, {...fixed,fields:{...fixed.fields,executor:undefined}},
  {...fixed,source:{kind:'manual'}}, {...fixed,taskRequest:{...fixed.taskRequest,assignee:occurrence.taskRequest.assignee}},
  {...fixed,workDefinition:{...workDefinition,authorization:{...executor,grantId:taskId}}},
  {...fixed,workDefinition:undefined},
 ])assert.throws(()=>readPlanScheduleSummary({...value,overview:{...value.overview,latest:{occurrence:changed,task:null}}},planId),/调度摘要/)
})

test('读取可用调度的真实下次时间、最近领取、任务和健康状态',()=>{
 const value={available:true,overview:{planId,planVersion:3,state:'active',nextAt:'2026-09-14T01:00:00.000Z',latest:{occurrence,task:{id:taskId,state:'running'}},latestSkip:{planId,planVersion:3,configVersion:1,occurrenceId:'2026-09-14T09:00[Asia/Singapore]',scheduledAt:'2026-09-14T01:00:00.000Z',skippedAt:'2026-09-14T01:00:02.000Z',reason:'previous-task-unfinished',blockingClaimId:occurrenceId,taskId}},health:{health:'healthy',failureCode:null,lastAttemptAt:'2026-09-13T01:01:00.000Z',lastSuccessAt:'2026-09-13T01:01:00.000Z'}}
 assert.deepEqual(readPlanScheduleSummary(value,planId),value)
})

test('可信长期事件摘要保留完成策略与冻结定义，旧日程不新增字段',()=>{
 const completionPolicy={kind:'verified' as const,verifier:'material-version-summary' as const,verifierVersion:1,authorizationVersion:1},workDefinition={schema:'teloa.plan-work/v2',definitionVersion:2,definitionControlId:planId,budgetAccountId:taskId,authorization:{kind:'delegation',delegationId:occurrenceId,delegationVersion:1},completion:completionPolicy,triggers:[{kind:'local-event',eventKind:'material-version',sourceId:taskRequestId,coalesce:'latest'}],budget:{maxGoalRounds:32,maxTokens:2000000,maxElapsedMs:21600000,maxConcurrent:1,maxRetries:3,stagnationRounds:3,money:null},overlap:'forbid',missed:'coalesce',safeRecovery:false}
 const event={...occurrence,configVersion:2,occurrenceId:'event:'+occurrenceId,workDefinition,fields:{...occurrence.fields,completionPolicy},taskRequest:{...occurrence.taskRequest,fields:{...occurrence.taskRequest.fields,completionPolicy}}}
 const value={available:true,overview:{planId,planVersion:3,state:'active',nextAt:null,latest:{occurrence:event,task:{id:taskId,state:'waiting'}},latestSkip:null},health:null}
 assert.deepEqual(readPlanScheduleSummary(value,planId),value)
 assert.throws(()=>readPlanScheduleSummary({...value,overview:{...value.overview,latest:{occurrence:{...event,workDefinition:{...workDefinition,definitionVersion:1}},task:null}}},planId),/调度摘要/)
 assert.throws(()=>readPlanScheduleSummary({...value,overview:{...value.overview,latest:{occurrence:{...event,taskRequest:occurrence.taskRequest},task:null}}},planId),/调度摘要/)
})

test('未装配宿主不携带伪造摘要或日期，已装配但未记录可显式为空',()=>{
 assert.deepEqual(readPlanScheduleSummary({available:false,overview:null,health:null},planId),{available:false,overview:null,health:null})
 assert.deepEqual(readPlanScheduleSummary({available:true,overview:null,health:null},planId),{available:true,overview:null,health:null})
})

test('会话来源计划运行后仍能读取调度摘要，来源拒绝损坏身份和未知字段',()=>{
 const value={available:true,overview:{planId,planVersion:3,state:'active',nextAt:null,latest:{occurrence:{...occurrence,source:{kind:'manual',sessionId:'ordinary-session'}},task:null},latestSkip:null},health:null}
 assert.deepEqual(readPlanScheduleSummary(value,planId),value)
 for(const source of [{kind:'manual',sessionId:''},{kind:'manual',sessionId:'../private'},{kind:'manual',sessionId:'ordinary-session',ownerId:'another'}])
  assert.throws(()=>readPlanScheduleSummary({...value,overview:{...value.overview,latest:{occurrence:{...occurrence,source},task:null}}},planId),/调度摘要/)
})

test('拒绝跨计划、非法状态组合、伪健康码和损坏的任务关联',()=>{
 const base={available:true,overview:{planId,planVersion:3,state:'active',nextAt:null,latest:null,latestSkip:null},health:null}
 for(const value of [
  {...base,overview:{...base.overview,planId:'0e415961-d4b0-4ef4-a6d8-7b1e58689ca5'}},
  {...base,overview:{...base.overview,state:'paused',nextAt:'2026-09-14T01:00:00.000Z'}},
  {...base,health:{health:'healthy',failureCode:'teloa/should-be-null',lastAttemptAt:at,lastSuccessAt:at}},
  {...base,health:{health:'failing',failureCode:'database password=secret',lastAttemptAt:at,lastSuccessAt:null}},
  {available:false,overview:base.overview,health:null},
  {...base,overview:{...base.overview,latest:{occurrence,task:{id:taskId,state:'invented'}}}},
  {...base,overview:{...base.overview,latest:{occurrence:{...occurrence,planId:'0e415961-d4b0-4ef4-a6d8-7b1e58689ca5'},task:null}}},
  {...base,overview:{...base.overview,latest:{occurrence:{...occurrence,source:{kind:'market-content',contentId:planId,contentHash:'a'.repeat(65),resourceId:'work',resourceVersion:'1.0.0'}},task:null}}},
 ])assert.throws(()=>readPlanScheduleSummary(value,planId),/调度摘要/)
})

test('跳过原因与任务身份必须成对，响应拒绝未知字段',()=>{
 const skip={planId,planVersion:3,configVersion:1,occurrenceId:'2026-09-14T09:00[Asia/Singapore]',scheduledAt:'2026-09-14T01:00:00.000Z',skippedAt:'2026-09-14T01:00:02.000Z',reason:'previous-pending',blockingClaimId:occurrenceId,taskId:null}
 const base={available:true,overview:{planId,planVersion:3,state:'active',nextAt:null,latest:null,latestSkip:skip},health:null}
 assert.deepEqual(readPlanScheduleSummary(base,planId),base)
 assert.throws(()=>readPlanScheduleSummary({...base,overview:{...base.overview,latestSkip:{...skip,taskId}}},planId),/调度摘要/)
 assert.throws(()=>readPlanScheduleSummary({...base,forged:true},planId),/调度摘要/)
})

test('Auto Dream 的 system-digest 来源与 plan-api 同口径：两键且 roleId 为 uuid',()=>{
 const roleId='4f23edeb-d497-405a-8606-c1a8666fb3ef'
 const digest={...occurrence,source:{kind:'system-digest',roleId}}
 const value={available:true,overview:{planId,planVersion:3,state:'active',nextAt:null,latest:{occurrence:digest,task:null},latestSkip:null},health:null}
 assert.deepEqual(readPlanScheduleSummary(value,planId),value)
 for(const source of [{kind:'system-digest'},{kind:'system-digest',roleId:'not-a-uuid'},{kind:'system-digest',roleId,contentId:planId}])
  assert.throws(()=>readPlanScheduleSummary({...value,overview:{...value.overview,latest:{occurrence:{...occurrence,source},task:null}}},planId),/调度摘要/)
})


test('调度摘要保留固定汇报群与发生实例的同一任务目标，拒绝错配目标',()=>{
 const groupId='55555555-5555-4555-8555-555555555555',reportGroup={groupId,groupVersion:2,grantVersion:3}
 const fixed={...occurrence,reportGroup,fields:{...occurrence.fields,groupId},taskRequest:{...occurrence.taskRequest,fields:{...occurrence.taskRequest.fields,groupId}}}
 const value={available:true,overview:{planId,planVersion:3,state:'active',nextAt:null,latest:{occurrence:fixed,task:null},latestSkip:null},health:null}
 assert.deepEqual(readPlanScheduleSummary(value,planId),value)
 assert.throws(()=>readPlanScheduleSummary({...value,overview:{...value.overview,latest:{occurrence:{...fixed,reportGroup:{...reportGroup,groupId:taskId}},task:null}}},planId),/调度摘要/)
})

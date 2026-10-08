import test from 'node:test'
import assert from 'node:assert/strict'
const id='12345678-1234-4234-8234-123456789abc'
test('长期定义严格读真实委托，事件不能冒充时间触发或缺省自动恢复',async()=>{
 const api=await import('../src/plan-work.ts').catch(()=>null);assert.ok(api,'长期定义契约尚未实现')
 const value={schema:'teloa.plan-work/v2',definitionVersion:2,definitionControlId:id,budgetAccountId:id,completion:{kind:'manual'},authorization:{kind:'delegation',delegationId:id,delegationVersion:1},triggers:[{kind:'local-event',eventKind:'material-version',sourceId:id,coalesce:'latest'}],budget:{maxGoalRounds:32,maxTokens:2000,maxElapsedMs:60000,maxConcurrent:1,maxRetries:3,stagnationRounds:3,money:null},overlap:'forbid',missed:'coalesce',safeRecovery:false}
 assert.deepEqual(api.readPlanWorkDefinition(value),value)
 assert.throws(()=>api.readPlanWorkDefinition({...value,authorization:{kind:'task',taskId:id,taskContentVersion:1}}))
 assert.throws(()=>api.readPlanWorkDefinition({...value,ownerId:'model'}))
 assert.throws(()=>api.readPlanWorkDefinition({...value,triggers:[{kind:'local-event',eventKind:'webhook',sourceId:id,coalesce:'latest'}]}))
})
test('可信事件和进展严格保留身份、版本及等待，拒绝未知来源和虚构完成字段',async()=>{
 const events=await import('../src/work-events.ts').catch(()=>null),progress=await import('../src/work-progress.ts').catch(()=>null);assert.ok(events&&progress,'事件及进展契约尚未实现')
 const event={schema:'teloa.work-event/v1',id,ownerId:'owner',sourceEventId:'resource:'+id+':v2',kind:'material-version',sourceId:id,sourceVersion:'2',createdAt:'2026-10-09T00:00:00.000Z'}
 assert.deepEqual(events.readWorkEvent(event),event);assert.throws(()=>events.readWorkEvent({...event,kind:'model-completed'}))
 const row={rootTaskId:id,version:1,stage:'等待资料',completedStepIds:[],nextStep:'核对新版本',wait:{kind:'event',reason:'等待资料变化',nextAt:null},artifactIds:[],pendingActionIds:[],updatedAt:event.createdAt}
 assert.deepEqual(progress.readWorkProgress(row),row);assert.throws(()=>progress.readWorkProgress({...row,percent:100}))
})

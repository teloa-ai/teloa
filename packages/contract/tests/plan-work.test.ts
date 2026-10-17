import test from 'node:test'
import assert from 'node:assert/strict'
const id='12345678-1234-4234-8234-123456789abc'
test('本人计划草稿显式区分无员工身份，旧员工草稿可选字段省略且规范化不混入Task技能字段',async()=>{
 const {readOwnerPlanFields,readRolePlanDraftFields,readPlanWorkDefinition}=await import('../src/plan-work.ts')
 const fields={title:'本人核对',goal:'核对原已授权资料',scope:'general',dataScope:'已选资料',delivery:'核对结论',trigger:{kind:'schedule',cadence:'daily',weekday:1,time:'09:00',timezone:'Asia/Singapore'},notificationPolicy:'attention'}
 assert.deepEqual(readOwnerPlanFields({...fields,roleId:null,executor:{kind:'owner'}}),{...fields,roleId:null,executor:{kind:'owner'}})
 assert.deepEqual(readRolePlanDraftFields({...fields,roleId:id,expectedRoleVersion:2}),{...fields,roleId:id,expectedRoleVersion:2})
 for(const patch of [{scope:'SOC'},{groupId:id},{roleId:id},{executor:{kind:'role'}},{approved:true}])assert.throws(()=>readOwnerPlanFields({...fields,roleId:null,executor:{kind:'owner'},...patch}))
 const owner={schema:'teloa.plan-work/v3',definitionVersion:2,definitionControlId:id,budgetAccountId:id,authorization:{kind:'owner',grantId:id,grantVersion:2},completion:{kind:'manual'},triggers:[{kind:'schedule',schedule:fields.trigger}],budget:{maxGoalRounds:4,maxTokens:10000,maxElapsedMs:600000,maxConcurrent:1,maxRetries:1,stagnationRounds:2,money:null},overlap:'forbid',missed:'coalesce',safeRecovery:false}
 assert.deepEqual(readPlanWorkDefinition(owner),owner)
 for(const patch of [{schema:'teloa.plan-work/v2'},{authorization:{...owner.authorization,grantVersion:1}},{triggers:[{kind:'local-event',eventKind:'material-version',sourceId:id,coalesce:'latest'}]}])assert.throws(()=>readPlanWorkDefinition({...owner,...patch}))
})
test('业务复合来源仅进入v2事件与v3计划，旧UUID记录逐字兼容',async()=>{
 const events=await import('../src/work-events.ts'),plans=await import('../src/plan-work.ts')
 const sourceRef={kind:'business-object',scope:'SOC',type:'lead-record',id:'lead-cn-001'},event={schema:'teloa.work-event/v2',id,ownerId:'owner',sourceEventId:'business:'+ 'a'.repeat(64),kind:'business-object-version',sourceRef,sourceVersion:'3',basisHash:'b'.repeat(64),createdAt:'2026-10-17T00:00:00.000Z'}
 assert.deepEqual(events.readWorkEvent(event),event)
 assert.throws(()=>events.readWorkEvent({...event,sourceId:id}))
 assert.throws(()=>events.readWorkEvent({...event,schema:'teloa.work-event/v1'}))
 const value={schema:'teloa.plan-work/v3',definitionVersion:2,definitionControlId:id,budgetAccountId:id,completion:{kind:'manual'},authorization:{kind:'delegation',delegationId:id,delegationVersion:1},triggers:[{kind:'local-event',eventKind:'business-object-version',sourceRef,coalesce:'latest'}],budget:{maxGoalRounds:32,maxTokens:2000,maxElapsedMs:60000,maxConcurrent:1,maxRetries:3,stagnationRounds:3,money:null},overlap:'forbid',missed:'coalesce',safeRecovery:false}
 assert.deepEqual(plans.readPlanWorkDefinition(value),value)
 assert.throws(()=>plans.readPlanWorkDefinition({...value,schema:'teloa.plan-work/v2'}))
 assert.throws(()=>plans.readPlanWorkDefinition({...value,triggers:[{...value.triggers[0],sourceId:id}]}))
})
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

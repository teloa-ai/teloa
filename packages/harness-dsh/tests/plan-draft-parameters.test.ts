import test from 'node:test'
import assert from 'node:assert/strict'
import {defineTool,validateJsonSchemaValue} from '@deepseek-ai/dsh-tools'
import {readPageCreatePlanDraft,type PageCreatePlanDraft} from '@teloa/contract'
import {methodPlanDraftExample,configurePlanDraftExample} from '../src/plan-draft-guide.ts'
import {planDraftBody,planDraftArgumentErrors,planDraftParameters} from '../src/plan-draft-parameters.ts'

const ownerExample=structuredClone(methodPlanDraftExample)
assert.ok('definition'in ownerExample)
const tool=defineTool({name:'plan-shape-check',description:'只核参数。',parameters:{plan:{...planDraftParameters,required:true}},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async()=>''})
const roleId='20000000-0000-4000-8000-000000000001'
const role={...structuredClone(ownerExample),definition:{title:'客户资料摘要',goal:'整理已授权资料',scope:'support',dataScope:'本人已提供的资料',delivery:'摘要及未知事项',trigger:{kind:'schedule',cadence:'weekly',weekday:2,time:'10:00',timezone:'UTC'},notificationPolicy:'attention',roleId,expectedRoleVersion:3},work:{...structuredClone(ownerExample.work),triggers:[{kind:'local-event',eventKind:'material-version',sourceId:roleId,coalesce:'latest'},{kind:'local-event',eventKind:'business-object-version',sourceRef:{kind:'business-object',scope:'support',type:'ticket',id:'case-1'},coalesce:'none'},{kind:'local-event',eventKind:'business-sync-result',sourceRef:{kind:'business-sync',scope:'support',mappingId:'inbox'},coalesce:'latest'}]}}

test('计划示例经真实 defineTool JSON Schema 与原 reader，覆盖本人/员工/configure-work',()=>{
 for(const plan of [ownerExample,role,configurePlanDraftExample]){
  const before=JSON.stringify(plan)
  assert.deepEqual(validateJsonSchemaValue(tool.parameters,{plan}),[])
  assert.deepEqual(planDraftArgumentErrors(plan),[])
  assert.doesNotThrow(()=>planDraftBody(plan))
  assert.doesNotThrow(()=>readPageCreatePlanDraft(plan))
  assert.equal(JSON.stringify(plan),before)
 }
})

test('完成策略的 manual 与两种 verified 均保留，数组与费用上限类型完整',()=>{
 for(const verifier of ['system-digest','material-version-summary'] as const){
  const plan:PageCreatePlanDraft=structuredClone(ownerExample)
  plan.work.completion={kind:'verified',verifier,verifierVersion:2,authorizationVersion:1}
  plan.work.budget.money={currency:'SGD',maxMinorUnits:200}
  assert.deepEqual(validateJsonSchemaValue(tool.parameters,{plan}),[])
  assert.doesNotThrow(()=>planDraftBody(plan))
 }
 assert.doesNotThrow(()=>planDraftBody(ownerExample))
})

test('未知字段、数组项、时区、星期及配置版本从 SDK 拒绝，叶路径定位原错误',()=>{
 const cases:Array<[unknown,string]>=[
  [{...ownerExample,ownerId:'foreign'},'plan.ownerId'],
  [{...ownerExample,work:{...ownerExample.work,triggers:{}}},'plan.work.triggers'],
  [{...ownerExample,work:{...ownerExample.work,triggers:[{kind:'schedule',schedule:{...ownerExample.definition.trigger,timezone:'America/New_York'}}]}},'plan.work.triggers[0].schedule.timezone'],
  [{...ownerExample,definition:{...ownerExample.definition,trigger:{...ownerExample.definition.trigger,weekday:0}}},'plan.definition.trigger.weekday'],
  [{...configurePlanDraftExample,expectedConfigVersion:'1'},'plan.expectedConfigVersion'],
  [{...configurePlanDraftExample,fields:{title:'摘要',goal:'按原方法整理',dataScope:'原范围',delivery:'完整摘要',scope:'other'}},'plan.fields.scope'],
 ]
 for(const [plan,path]of cases){
  assert.ok(validateJsonSchemaValue(tool.parameters,{plan}).length>0)
  assert.ok(planDraftArgumentErrors(plan).some(issue=>issue.includes(path)),path)
  assert.throws(()=>planDraftBody(plan),error=>error instanceof Error&&error.message.includes(path))
 }
})

test('SDK 不支持的值域与本人执行边界仍由原 reader 拒绝，不修改输入',()=>{
 for(const plan of [
  {...ownerExample,work:{...ownerExample.work,triggers:[]}},
  {...ownerExample,definition:{...ownerExample.definition,trigger:{...ownerExample.definition.trigger,time:'25:00'}}},
  {...ownerExample,work:{...ownerExample.work,triggers:role.work.triggers}},
 ]){
  const before=JSON.stringify(plan)
  assert.throws(()=>planDraftBody(plan))
  assert.equal(JSON.stringify(plan),before)
 }
})

test('本人计划模型 schema 不提供群、业务范围或本地事件授权分支',()=>{
 for(const plan of [
  {...ownerExample,definition:{...ownerExample.definition,scope:'support'}},
  {...ownerExample,definition:{...ownerExample.definition,groupId:roleId}},
  {...ownerExample,work:{...ownerExample.work,triggers:role.work.triggers}},
 ])assert.ok(validateJsonSchemaValue(tool.parameters,{plan}).length>0)
})

test('SDK形状通过后的六项预算值域按原契约报精确叶路径，三类计划均不改输入',()=>{
 for(const original of [ownerExample,role,configurePlanDraftExample])for(const key of ['maxGoalRounds','maxTokens','maxElapsedMs','maxConcurrent','maxRetries','stagnationRounds'])for(const value of (key==='maxRetries'?[-1,Number.MAX_SAFE_INTEGER+1]:[0,-1,Number.MAX_SAFE_INTEGER+1])){
  const plan=structuredClone(original);Reflect.set(plan.work.budget,key,value)
  const before=JSON.stringify(plan),path='plan.work.budget.'+key
  assert.deepEqual(validateJsonSchemaValue(tool.parameters,{plan}),[],'SDK本身没有正数范围检查')
  assert.deepEqual(planDraftArgumentErrors(plan),[path+' must be a safe integer with minimum '+(key==='maxRetries'?0:1)])
  assert.throws(()=>planDraftBody(plan),error=>error instanceof Error&&error.message.includes(path)&&error.message.includes('minimum '+(key==='maxRetries'?0:1)))
  assert.equal(JSON.stringify(plan),before,'不得自动0→1或修改原额度')
 }
})

test('零重试在本人、员工及配置草稿中合法保留，不把0补为1',()=>{
 for(const original of [ownerExample,role,configurePlanDraftExample]){
  const plan=structuredClone(original);plan.work.budget.maxRetries=0
  const before=JSON.stringify(plan)
  assert.deepEqual(validateJsonSchemaValue(tool.parameters,{plan}),[])
  assert.deepEqual(planDraftArgumentErrors(plan),[])
  assert.equal(planDraftBody(plan).work.budget.maxRetries,0)
  assert.equal(JSON.stringify(plan),before)
 }
})

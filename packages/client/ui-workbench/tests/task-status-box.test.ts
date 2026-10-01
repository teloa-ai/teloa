import assert from 'node:assert/strict'
import test from 'node:test'
import {taskStatusBox} from '../src/client/task-status-box.ts'
import type {TaskStatusInput} from '../src/client/task-status-box.ts'
import {describeTaskProgress} from '../src/client/task-detail-presentation.ts'
import {TASK_DETAIL_MESSAGE_ROWS} from '../src/client/i18n/locales/task-details.ts'
import type {TeloaTranslate} from '../src/client/i18n/index.ts'

// 本任务只产出映射数据；11 个 task.status.* 新键里 9 个已被 task-status-box.ts 引用，
// `task.status.aria` 与 `task.status.hint` 要到 T5 把 TaskDetail 接上才有界面引用，在那之前
// tests/i18n-orphan-keys.test.ts 会红这 2 条——预期之内，见 design specification 功能验证，不加豁免。

const t=((key:string,params?:Readonly<Record<string,string|number>>)=>key+(params?JSON.stringify(params):'')) as TeloaTranslate
const base:TaskStatusInput={state:'ready',needs:[],attention:undefined,assigned:true,ownerName:'调研员',runCount:0,completion:null,t}
const box=(patch:Partial<TaskStatusInput>)=>taskStatusBox({...base,...patch})
const title=(input:Partial<TaskStatusInput>)=>describeTaskProgress(input.state??base.state,input.needs??base.needs,t).title

test('1 审批／待执行需求：去审批 → approval 锚点',()=>{
 for(const needs of [['approval'],['execution'],['approval','handoff']] as const){
  const model=box({state:'waiting',needs})
  assert.equal(model.tone,'warn');assert.equal(model.sentence,title({state:'waiting',needs}));assert.equal(model.reasonKey,undefined)
  assert.equal(model.primary?.label,'task.status.action.approve');assert.deepEqual(model.primary?.action,{kind:'anchor',anchor:'approval'});assert.equal(model.secondary,undefined)
 }
})
test('2 接任需求：指派负责人 → handoff 锚点',()=>{
 const model=box({state:'waiting',needs:['handoff']})
 assert.equal(model.tone,'warn');assert.equal(model.sentence,title({state:'waiting',needs:['handoff']}))
 assert.equal(model.primary?.label,'task.status.action.assign');assert.deepEqual(model.primary?.action,{kind:'anchor',anchor:'handoff'})
})
test('3 执行失败／运行配置失败：重新准备 → run 锚点 prepare 焦点，reasonKey 随原因',()=>{
 const failed=box({state:'blocked',attention:{kind:'error',reason:'execution-failed'}})
 assert.equal(failed.tone,'warn');assert.equal(failed.sentence,title({state:'blocked'}));assert.equal(failed.reasonKey,'task.attention.reason.executionFailed')
 assert.equal(failed.primary?.label,'task.status.action.rePrepare');assert.deepEqual(failed.primary?.action,{kind:'anchor',anchor:'run',focus:'prepare'})
 const configuration=box({state:'ready',attention:{kind:'error',reason:'execution-configuration-failed'}})
 assert.equal(configuration.reasonKey,'task.attention.reason.executionConfigurationFailed');assert.equal(configuration.primary?.label,'task.status.action.rePrepare')
 assert.equal(configuration.tone,'warn',"关注优先于状态：ready 且配置失败仍走第 3 行")
})
test('4 执行结束／核对需求：核对结果 → completion，副按钮查看运行 → run',()=>{
 const completed=box({state:'waiting',attention:{kind:'review',reason:'execution-completed'}})
 assert.equal(completed.tone,'warn');assert.equal(completed.sentence,title({state:'waiting'}));assert.equal(completed.reasonKey,'task.attention.reason.executionCompleted')
 assert.equal(completed.primary?.label,'task.status.action.review');assert.deepEqual(completed.primary?.action,{kind:'anchor',anchor:'completion'})
 assert.equal(completed.secondary?.label,'task.status.action.viewRun');assert.deepEqual(completed.secondary?.action,{kind:'anchor',anchor:'run'})
 const review=box({state:'waiting',needs:['review']})
 assert.equal(review.reasonKey,undefined);assert.equal(review.primary?.label,'task.status.action.review');assert.equal(review.secondary?.label,'task.status.action.viewRun')
})
test('5 任务等待关注：查看运行 → run',()=>{
 const model=box({state:'waiting',attention:{kind:'review',reason:'task-waiting'}})
 assert.equal(model.tone,'warn');assert.equal(model.sentence,title({state:'waiting'}));assert.equal(model.reasonKey,'task.attention.reason.taskWaiting')
 assert.equal(model.primary?.label,'task.status.action.viewRun');assert.deepEqual(model.primary?.action,{kind:'anchor',anchor:'run'});assert.equal(model.secondary,undefined)
})
test('6 沙盒需求（材料／连接／错误／派发）：去处理 → attention 锚点',()=>{
 for(const need of ['materials','connection','error','dispatch'] as const){
  const model=box({state:'waiting',needs:[need]})
  assert.equal(model.tone,'warn');assert.equal(model.sentence,title({state:'waiting',needs:[need]}))
  assert.equal(model.primary?.label,'attention.action.go');assert.deepEqual(model.primary?.action,{kind:'anchor',anchor:'attention'})
 }
})
test('7 受阻：处理阻塞 → run，reasonKey 只在 task-blocked 时给',()=>{
 const withReason=box({state:'blocked',attention:{kind:'error',reason:'task-blocked'}})
 assert.equal(withReason.tone,'warn');assert.equal(withReason.sentence,title({state:'blocked'}));assert.equal(withReason.reasonKey,'task.attention.reason.taskBlocked')
 assert.equal(withReason.primary?.label,'task.status.action.handleBlock');assert.deepEqual(withReason.primary?.action,{kind:'anchor',anchor:'run'})
 const sandbox=box({state:'blocked',attention:undefined})
 assert.equal(sandbox.reasonKey,undefined);assert.equal(sandbox.primary?.label,'task.status.action.handleBlock')
})
test('8 待开始且无负责人：还没有负责人 → owner 锚点',()=>{
 const model=box({state:'ready',assigned:false})
 assert.equal(model.tone,'info');assert.equal(model.sentence,'task.status.unassigned');assert.equal(model.reasonKey,undefined)
 assert.equal(model.primary?.label,'task.status.action.assign');assert.deepEqual(model.primary?.action,{kind:'anchor',anchor:'owner'})
})
test('9 待开始且有负责人：准备执行 → run 锚点 prepare 焦点',()=>{
 const model=box({state:'ready',assigned:true})
 assert.equal(model.tone,'info');assert.equal(model.sentence,title({state:'ready'}))
 assert.equal(model.primary?.label,'taskExecution.prepare');assert.deepEqual(model.primary?.action,{kind:'anchor',anchor:'run',focus:'prepare'})
})
test('10 运行中：轮次句子、查看运行主按钮、暂停副按钮',()=>{
 const counted=box({state:'running',runCount:3,ownerName:'调研员'})
 assert.equal(counted.tone,'info');assert.ok(counted.sentence.startsWith('task.status.running'));assert.ok(counted.sentence.includes('"count":3'));assert.ok(counted.sentence.includes('"owner":"调研员"'))
 assert.equal(counted.primary?.label,'task.status.action.viewRun');assert.deepEqual(counted.primary?.action,{kind:'anchor',anchor:'run'})
 assert.equal(counted.secondary?.label,'task.detail.action.pause{"demo":""}');assert.deepEqual(counted.secondary?.action,{kind:'progress',action:'pause'})
 const fresh=box({state:'running',runCount:0})
 assert.equal(fresh.sentence,title({state:'running'}))
})
test('11 已暂停：继续任务 → progress resume',()=>{
 const model=box({state:'paused'})
 assert.equal(model.tone,'muted');assert.equal(model.sentence,title({state:'paused'}))
 assert.equal(model.primary?.label,'task.detail.action.resume{"demo":""}');assert.deepEqual(model.primary?.action,{kind:'progress',action:'resume'});assert.equal(model.secondary,undefined)
})
test('12 已结项：固定成果版本句子、查看成果 → open-artifact',()=>{
 const pinned=box({state:'completed',completion:{artifactVersion:2}})
 assert.equal(pinned.tone,'good');assert.ok(pinned.sentence.startsWith('task.status.completed'));assert.ok(pinned.sentence.includes('"version":2'))
 assert.equal(pinned.primary?.label,'taskCompletion.view');assert.deepEqual(pinned.primary?.action,{kind:'open-artifact'})
 const bare=box({state:'completed',completion:null})
 assert.equal(bare.sentence,title({state:'completed'}));assert.equal(bare.primary?.label,'taskCompletion.view')
})
test('13 已取消：无按钮',()=>{
 const model=box({state:'cancelled'})
 assert.equal(model.tone,'muted');assert.equal(model.sentence,title({state:'cancelled'}));assert.equal(model.primary,undefined);assert.equal(model.secondary,undefined)
})
test('14 其它（等待且无关注）：查看运行 → run',()=>{
 const model=box({state:'waiting',attention:null})
 assert.equal(model.tone,'info');assert.equal(model.sentence,title({state:'waiting'}));assert.equal(model.reasonKey,undefined)
 assert.equal(model.primary?.label,'task.status.action.viewRun');assert.deepEqual(model.primary?.action,{kind:'anchor',anchor:'run'})
})
test('hint 恒为 describeTaskProgress 的 description',()=>{
 for(const patch of [{state:'ready'},{state:'running'},{state:'waiting',needs:['approval']},{state:'blocked',attention:{kind:'error',reason:'execution-failed'}},{state:'completed',completion:{artifactVersion:1}}] as const){
  assert.equal(box(patch).hint,describeTaskProgress(patch.state,'needs' in patch?patch.needs:[],t).description)
 }
})
test('11 个 task.status.* 新键各恰一行、11 列、zh-CN 无禁词',()=>{
 const keys=['task.status.aria','task.status.unassigned','task.status.running','task.status.completed','task.status.action.assign','task.status.action.approve','task.status.action.review','task.status.action.viewRun','task.status.action.rePrepare','task.status.action.handleBlock','task.status.hint']
 const forbidden=/工作空间|单空间|实例|投影|尚未加载|内容待读取|\d+\s*项资源|人类/
 for(const key of keys){
  const rows=TASK_DETAIL_MESSAGE_ROWS.filter(row=>row[0]===key)
  assert.equal(rows.length,1,key)
  assert.equal(rows[0]!.length,11,key)
  assert.doesNotMatch(rows[0]![1],forbidden,key)
  for(const cell of rows[0]!)assert.ok(cell.length>0,key)
 }
 assert.equal(TASK_DETAIL_MESSAGE_ROWS.filter(row=>row[0].startsWith('task.status.')).length,11)
})

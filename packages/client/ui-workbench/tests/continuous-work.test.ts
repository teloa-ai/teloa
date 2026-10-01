import test from 'node:test'
import assert from 'node:assert/strict'
import { emptyTaskPreview } from '../src/client/task-preview.ts'
import { withRoleExamples } from '../src/client/role-preview.ts'
import { changeTeamPreview } from '../src/client/team-preview.ts'
import { changeContinuousWork, withContinuousExamples } from '../src/client/continuous-work.ts'
import { planBlock, continuousAttention, visiblePlanRuns } from '../src/client/continuous-preview.ts'
const now='2026-09-11T04:30:00Z'
const base=()=>withContinuousExamples({...emptyTaskPreview(),roles:withRoleExamples([],now)},now)
const planId='plan-soc-daily'
const command=(state:ReturnType<typeof base>,operation:Record<string,unknown>)=>changeContinuousWork(state,{now,...operation} as Parameters<typeof changeContinuousWork>[1])
const enable=(state:ReturnType<typeof base>)=>command(state,{type:'enabled',planId,expectedRevision:state.continuous.plans.find(plan=>plan.id===planId)!.revision,enabled:true})
const fire=(state:ReturnType<typeof base>,id='run-1',occurrenceId='tick-1')=>command(state,{type:'trigger',planId,id,occurrenceId,input:'告警资料快照 v1'})

test('已保存计划不把页面内演示执行冒充真实历史，演示计划仍显示自身执行',()=>{
  const state=fire(enable(base()))
  assert.deepEqual(visiblePlanRuns(state.continuous.runs,planId,true),[])
  assert.deepEqual(visiblePlanRuns(state.continuous.runs,planId,false).map(run=>run.id),['run-1'])
  assert.deepEqual(visiblePlanRuns([...state.continuous.runs,{...state.continuous.runs[0]!,id:'other-run',planId:'other-plan'}],planId,false).map(run=>run.id),['run-1'])
})

test('稳定触发合并原执行，冲突输入拒绝；计划暂停不覆盖在途配置',()=>{
  let state=enable(base());state=fire(state)
  assert.equal(fire(state,'run-duplicate').continuous.runs.length,1)
  assert.throws(()=>command(state,{type:'trigger',planId,id:'bad',occurrenceId:'tick-1',input:'另一份输入'}),/输入/)
  const snapshot=structuredClone(state.continuous.runs[0]!.snapshot)
  state=command(state,{type:'enabled',planId,expectedRevision:state.continuous.plans.find(plan=>plan.id===planId)!.revision,enabled:false})
  assert.throws(()=>fire(state,'run-2','tick-2'),/暂停/)
  state=command(state,{type:'finish',runId:'run-1',expectedRevision:1,outcome:'completed',result:'已核对',output:'有来源的工作稿'})
  assert.deepEqual(state.continuous.runs[0]!.snapshot,snapshot)
  assert.equal(state.continuous.runs[0]!.state,'completed')
})
test('岗位暂停阻断新触发，退役停发并交接，旧执行仍保留原作者',()=>{
  let state=fire(enable(base()))
  const role=state.roles.find(role=>role.id==='investigator')!
  state=changeTeamPreview(state,{type:'lifecycle',roleId:role.id,expectedVersion:role.version,action:'pause',reason:'暂停新工作',now})
  assert.match(planBlock(state.continuous.plans.find(plan=>plan.id===planId)!,state.roles),/暂停/)
  state=changeTeamPreview(state,{type:'lifecycle',roleId:role.id,expectedVersion:state.roles.find(item=>item.id===role.id)!.version,action:'retire',reason:'安排接续',now})
  assert.equal(state.continuous.plans.find(plan=>plan.id===planId)!.enabled,false)
  assert.equal(continuousAttention(state.continuous).filter(item=>item.kind==='handoff').length,1)
  state=command(state,{type:'handoff',planId,expectedRevision:state.continuous.plans.find(plan=>plan.id===planId)!.revision,roleId:'reviewer',note:'保留原执行'})
  const plan=state.continuous.plans.find(plan=>plan.id===planId)!
  assert.equal(plan.enabled,false);assert.equal(plan.version,2)
  state=command(state,{type:'finish',runId:'run-1',expectedRevision:1,outcome:'completed',result:'原执行收尾',output:'原作者工作稿'})
  assert.equal(state.continuous.runs[0]!.actor.id,'investigator')
  assert.equal(state.continuous.runs[0]!.snapshot.version,1)
})
test('重试保留失败与原输入，失败链只回流最新一次；重复重试复用原子执行',()=>{
  let state=fire(enable(base()))
  state=command(state,{type:'finish',runId:'run-1',expectedRevision:1,outcome:'failed',result:'资料缺失',output:''})
  assert.equal(continuousAttention(state.continuous).filter(item=>item.kind==='error').length,1)
  state=command(state,{type:'retry',runId:'run-1',id:'retry-1'})
  assert.equal(command(state,{type:'retry',runId:'run-1',id:'retry-duplicate'}).continuous.runs.length,2)
  assert.equal(state.continuous.runs[1]!.input,'告警资料快照 v1')
  assert.equal(state.continuous.runs[1]!.retryOf,'run-1')
  state=command(state,{type:'finish',runId:'retry-1',expectedRevision:1,outcome:'completed',result:'核对已补资料后完成',output:'结果工作稿'})
  assert.equal(state.continuous.runs[0]!.state,'failed')
  assert.deepEqual(continuousAttention(state.continuous),[])
})
test('配置修改形成新版本且暂停，旧执行不能悄悄切换到新目标重试',()=>{
  let state=fire(enable(base()))
  state=command(state,{type:'finish',runId:'run-1',expectedRevision:1,outcome:'failed',result:'缺少依据',output:''})
  const plan=state.continuous.plans.find(plan=>plan.id===planId)!
  state=command(state,{type:'save',id:plan.id,expectedRevision:plan.revision,fields:{...plan.fields,goal:'新的工作目标'}})
  assert.equal(state.continuous.plans.find(plan=>plan.id===planId)!.version,2)
  assert.equal(state.continuous.runs[0]!.snapshot.fields.goal,plan.fields.goal)
  state=enable(state)
  assert.throws(()=>command(state,{type:'retry',runId:'run-1',id:'retry-1'}),/版本/)
  state=command(state,{type:'resolve',runId:'run-1',expectedRevision:2,note:'新目标另行触发，不再重试旧输入'})
  assert.deepEqual(continuousAttention(state.continuous),[])
})
test('触发配置校验、修订冲突和不具备资格的岗位不能绕过',()=>{
  let state=base(),plan=state.continuous.plans.find(plan=>plan.id===planId)!
  assert.throws(()=>command(state,{type:'save',id:plan.id,expectedRevision:99,fields:plan.fields}),/修订/)
  assert.throws(()=>command(state,{type:'save',id:'bad',fields:{...plan.fields,trigger:{kind:'schedule',cadence:'daily',weekday:1,time:'27:01',timezone:'UTC'}}}),/日程/)
  assert.throws(()=>command(state,{type:'save',id:'bad',fields:{...plan.fields,trigger:{kind:'event',source:'',event:'更新'}}}),/来源/)
  assert.throws(()=>command(state,{type:'save',id:'bad',fields:{...plan.fields,roleId:'twin'}}),/员工/)
  assert.throws(()=>command(state,{type:'save',id:'bad',fields:{...plan.fields,roleId:'researcher'}}),/员工/)
})
test('主动交办结果才创建同一普通任务，保留计划与执行来源',()=>{
  let state=fire(enable(base()))
  state=command(state,{type:'finish',runId:'run-1',expectedRevision:1,outcome:'completed',result:'需要进一步核对',output:'事实与来源'})
  assert.equal(state.tasks.length,0)
  state=command(state,{type:'follow',runId:'run-1',id:'follow-1'})
  assert.equal(command(state,{type:'follow',runId:'run-1',id:'follow-duplicate'}).tasks.length,1)
  assert.equal(state.tasks[0]!.planSource?.runId,'run-1')
  assert.equal(state.continuous.runs[0]!.taskId,'follow-1')
})
test('长工作稿留在原执行，跟进目标不复制全文也不超过普通任务限制',()=>{
  let state=fire(enable(base()))
  state=command(state,{type:'finish',runId:'run-1',expectedRevision:1,outcome:'completed',result:'核对来源',output:'稿'.repeat(15000)})
  state=command(state,{type:'follow',runId:'run-1',id:'follow-long'})
  assert.equal(state.tasks[0]!.goal,'核对来源')
  assert.equal(state.continuous.runs[0]!.output.length,15000)
})
test('归档停发但保留失败待办与在途执行，明确结束接续才移出待办',()=>{
  let state=fire(enable(base()))
  state=command(state,{type:'archive',planId,expectedRevision:2,note:'停止后续工作'})
  assert.throws(()=>fire(state,'run-2','tick-2'),/归档/)
  state=command(state,{type:'finish',runId:'run-1',expectedRevision:1,outcome:'failed',result:'尚待说明',output:''})
  assert.equal(continuousAttention(state.continuous).length,1)
  assert.throws(()=>command(state,{type:'retry',runId:'run-1',id:'retry-1'}),/归档/)
  state=command(state,{type:'resolve',runId:'run-1',expectedRevision:2,note:'停止接续，保留失败事实'})
  assert.equal(state.continuous.runs[0]!.state,'failed');assert.deepEqual(continuousAttention(state.continuous),[])
})
test('岗位恢复不复活手动暂停计划，业务缩减不能遗漏仍所属的计划',()=>{
  let state=base(),role=state.roles.find(role=>role.id==='investigator')!
  state=changeTeamPreview(state,{type:'lifecycle',roleId:role.id,expectedVersion:role.version,action:'pause',reason:'暂停',now})
  role=state.roles.find(role=>role.id==='investigator')!
  state=changeTeamPreview(state,{type:'lifecycle',roleId:role.id,expectedVersion:role.version,action:'resume',reason:'恢复',now})
  assert.equal(state.continuous.plans[0]!.enabled,false)
  role=state.roles.find(role=>role.id==='investigator')!
  assert.throws(()=>changeTeamPreview(state,{...role,type:'edit',roleId:role.id,expectedVersion:role.version,scopes:['general'],now}),/计划/)
})
test('编号碰撞、完成修订冲突、结束失败链父项不能改写已有事实',()=>{
  let state=fire(enable(base()))
  assert.throws(()=>fire(state,'run-1','another-tick'),/编号/)
  assert.throws(()=>command(state,{type:'finish',runId:'run-1',expectedRevision:99,outcome:'completed',result:'覆盖',output:''}),/修订/)
  state=command(state,{type:'finish',runId:'run-1',expectedRevision:1,outcome:'failed',result:'失败',output:''})
  state=command(state,{type:'retry',runId:'run-1',id:'retry-1'})
  assert.throws(()=>command(state,{type:'resolve',runId:'run-1',expectedRevision:2,note:'结束父项'}),/接续/)
  state=command(state,{type:'finish',runId:'retry-1',expectedRevision:1,outcome:'failed',result:'仍失败',output:''})
  assert.deepEqual(continuousAttention(state.continuous).map(item=>item.id),['retry-1'])
})

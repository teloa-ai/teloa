import test from 'node:test'
import assert from 'node:assert/strict'
import { emptyTaskPreview } from '../src/client/task-preview.ts'
import { changeTeamPreview } from '../src/client/team-preview.ts'
import { changeBusinessWork, withBusinessExamples } from '../src/client/business-work-preview.ts'
import { queryObjects, objectKey, operationStates, businessAttention } from '../src/client/business-preview.ts'

const now='2026-09-11T02:00:00Z'
const example=()=>withBusinessExamples(emptyTaskPreview(),now)
const op=(state:ReturnType<typeof example>,id='op-contain')=>state.business.operations.find(item=>item.id===id)!
const run=(state:ReturnType<typeof example>,id='run-investigate')=>state.business.runs.find(item=>item.id===id)!

test('分析批次与低风险自动操作独立存在；重复加载示例不覆盖状态',()=>{
  const state=example()
  assert.equal(state.tasks.length,0)
  assert.equal(run(state,'run-normal').findings,0)
  assert.equal(op(state,'op-auto').approval,undefined)
  assert.ok(op(state,'op-auto').policy?.source)
  assert.equal(operationStates[op(state,'op-auto').state],'task.detail.operation.verified')
  assert.deepEqual(withBusinessExamples(state,now),state)
})

test('对象身份同时含业务、类型、编号与版本；查询按来源、时间、质量取交集',()=>{
  const state=example(),object=state.business.objects.find(item=>item.scope==='SOC')!
  assert.notEqual(objectKey(object),objectKey({...object,scope:'Design'}))
  assert.notEqual(objectKey(object),objectKey({...object,version:2}))
  const rows=queryObjects(state.business.objects,{scope:'SOC',text:'prod',source:'EDR',quality:'complete',period:'30m'},now)
  assert.ok(rows.length)
  assert.ok(rows.every(item=>item.source==='EDR'&&item.quality==='complete'&&item.scope==='SOC'&&item.title.includes('prod')))
  assert.equal(queryObjects(state.business.objects,{scope:'SOC',text:'missing',source:'all',quality:'all',period:'all'},now).length,0)
  assert.equal(queryObjects(state.business.objects,{scope:'SOC',text:'',source:'CMDB',quality:'complete',period:'30m'},now).length,0)
})

test('一对象可交办多个任务；保存固定引用，不能按同名或相同编号跨业务匹配',()=>{
  let state=example();const object=state.business.objects.find(item=>item.scope==='SOC')!
  const command={type:'object-task' as const,ref:object,assigneeId:'investigator',title:'调查',goal:'核实来源',now}
  state=changeBusinessWork(state,{...command,id:'task-a'})
  state=changeBusinessWork(state,{...command,id:'task-b'})
  assert.equal(state.tasks.length,2)
  assert.deepEqual(state.tasks[0]?.objectRefs,[{scope:object.scope,type:object.type,id:object.id,version:object.version,title:object.title}])
  assert.throws(()=>changeBusinessWork(state,{...command,id:'task-c',ref:{...object,scope:'Design'}}),/不存在|版本/)
  assert.throws(()=>changeBusinessWork(state,{...command,id:'task-c',ref:{...object,version:99}}),/版本/)
})

test('同一分析只交办一次；暂停岗位不暂停系统流程，但拒绝新交办',()=>{
  let state=example()
  state=changeTeamPreview(state,{type:'lifecycle',roleId:'investigator',expectedVersion:1,action:'pause',reason:'演示暂停',now})
  assert.equal(state.business.flows[0]?.paused,false)
  const command={type:'dispatch-run' as const,runId:'run-investigate',id:'task-1',assigneeId:'investigator',now}
  assert.throws(()=>changeBusinessWork(state,command),/在岗/)
  state=changeBusinessWork(state,{...command,assigneeId:'reviewer'})
  state=changeBusinessWork(state,{...command,id:'task-2'})
  assert.equal(state.tasks.length,1)
  assert.equal(run(state).taskId,'task-1')
  assert.deepEqual(state.tasks[0]?.objectRefs,run(state).inputs)
  assert.throws(()=>changeBusinessWork(example(),{...command,runId:'run-normal'}),/线索/)
})

test('系统流程暂停阻止新批次，重复触发保留同一批次；迟到输入仅供追溯',()=>{
  let state=example();const command={type:'batch' as const,flowId:'soc-triage',batchId:'batch-3',id:'run-3',now}
  state=changeBusinessWork(state,command)
  assert.equal(changeBusinessWork(state,{...command,id:'different'}).business.runs.length,state.business.runs.length)
  state=changeBusinessWork(state,{type:'flow',flowId:'soc-triage',paused:true,now})
  assert.throws(()=>changeBusinessWork(state,{...command,batchId:'batch-4'}),/暂停/)
  const old=run(state).inputs[0]!
  state=changeBusinessWork(state,{type:'refresh-object',ref:old,now})
  assert.equal(run(state).state,'stale')
  assert.equal(run(state).inputs[0]?.version,1)
  assert.equal(state.business.objects.find(item=>item.id===old.id)?.version,2)
  assert.throws(()=>changeBusinessWork(state,{type:'dispatch-run',runId:'run-investigate',id:'late',assigneeId:'reviewer',now}),/过时/)
})

test('执行审批与任务审批复用固定快照：批准不是受理，过期和改版不能执行',()=>{
  let state=example();const before=op(state),approval=before.approval!
  state=changeBusinessWork(state,{type:'decide-operation',operationId:before.id,approvalId:approval.id,expectedVersion:approval.version,decision:'approved',note:'仅允许固定两台目标。',now})
  assert.equal(op(state).state,'approved')
  assert.ok(op(state).targets.every(target=>target.attempts.length===0))
  assert.deepEqual(op(state).approval?.snapshot,approval.snapshot)
  assert.throws(()=>changeBusinessWork(state,{type:'execute',operationId:before.id,expectedVersion:op(state).version,now:'2026-09-13T02:00:00Z'}),/过期/)
  state=changeBusinessWork(state,{type:'refresh-object',ref:before.inputs[0]!,now})
  assert.equal(op(state).state,'stale')
  assert.deepEqual(op(state).approval?.snapshot,approval.snapshot)
  assert.throws(()=>changeBusinessWork(state,{type:'execute',operationId:before.id,expectedVersion:op(state).version,now}),/依据|状态/)
})

test('未知效果只能核对原操作；部分成功仅重试明确未应用目标，并保留原尝试',()=>{
  let state=example(),before=op(state,'op-unknown')
  assert.throws(()=>changeBusinessWork(state,{type:'execute',operationId:before.id,expectedVersion:before.version,now}),/未知/)
  state=changeBusinessWork(state,{type:'reconcile',operationId:before.id,expectedVersion:before.version,now})
  const partial=op(state,before.id)
  assert.equal(partial.state,'partial')
  assert.deepEqual(partial.targets.map(item=>item.attempts.length),[1,1])
  assert.equal(partial.targets[1]?.state,'failed')
  state=changeBusinessWork(state,{type:'execute',operationId:before.id,expectedVersion:partial.version,now})
  const retry=op(state,before.id)
  assert.deepEqual(retry.targets.map(item=>item.attempts.length),[1,2])
  assert.deepEqual(retry.targets[0],partial.targets[0])
  assert.deepEqual(retry.targets[1]?.attempts[0],partial.targets[1]?.attempts[0])
  assert.throws(()=>changeBusinessWork(state,{type:'execute',operationId:before.id,expectedVersion:partial.version,now}),/版本/)
  state=changeBusinessWork(state,{type:'receipt',operationId:before.id,expectedVersion:retry.version,unknown:false,now})
  assert.equal(op(state,before.id).state,'verified')
  assert.equal(op(state,before.id).id,before.id)
})

test('需要你投影业务原对象：待审批、待交办、未知及失败，不伪造任务',()=>{
  const state=example(),rows=businessAttention(state.business)
  assert.equal(state.tasks.length,0)
  assert.ok(rows.some(row=>row.target.id==='run-investigate'&&row.kind==='dispatch'))
  assert.ok(rows.some(row=>row.target.id==='op-contain'&&row.kind==='approval'))
  assert.ok(rows.some(row=>row.target.id==='op-unknown'&&row.kind==='error'))
  assert.ok(!rows.some(row=>row.target.id==='run-normal'||row.target.id==='op-auto'))
})

test('跨行业提议沿用公共审批：低风险文字不授予自动执行，任务关联校验实际输入',()=>{
  let state=example();const ref=state.business.objects.find(item=>item.type==='design')!
  state=changeBusinessWork(state,{type:'propose-operation',id:'design-publish',refs:[ref],title:'发布设计稿',goal:'发布已核对稿件',parameters:'仅发布到预览区',targets:['preview'],risk:'低风险',now})
  assert.equal(op(state,'design-publish').state,'pending')
  assert.ok(op(state,'design-publish').approval)
  assert.equal(op(state,'design-publish').policy,undefined)
  assert.throws(()=>changeBusinessWork(state,{type:'execute',operationId:'design-publish',expectedVersion:1,now}),/状态/)
  state=changeBusinessWork(state,{type:'object-task',ref,id:'design-task',title:'核对设计授权',goal:'补充授权',assigneeId:'designer',now})
  state=changeBusinessWork(state,{type:'link-operation',operationId:'design-publish',expectedVersion:1,taskId:'design-task',now})
  assert.equal(op(state,'design-publish').taskId,'design-task')
  assert.throws(()=>changeBusinessWork(state,{type:'link-operation',operationId:'op-contain',expectedVersion:1,taskId:'design-task',now}),/相同版本/)
})

test('数据更新后禁止未知操作重试，仍允许查询原回执；历史输入和成功目标不被覆盖',()=>{
  let state=example();const before=op(state,'op-unknown')
  state=changeBusinessWork(state,{type:'refresh-object',ref:before.inputs[0]!,now})
  state=changeBusinessWork(state,{type:'reconcile',operationId:before.id,expectedVersion:before.version,now})
  assert.equal(op(state,before.id).state,'partial')
  assert.throws(()=>changeBusinessWork(state,{type:'execute',operationId:before.id,expectedVersion:op(state,before.id).version,now}),/依据已变化/)
  assert.deepEqual(op(state,before.id).inputs,before.inputs)
  assert.equal(op(state,before.id).targets[0]?.state,'verified')
})

test('业务操作新写入的固定历史与回执保存语义词条，用户内容只作为参数保留',()=>{
  let state=example();const ref=state.business.objects.find(item=>item.type==='design')!
  state=changeBusinessWork(state,{type:'propose-operation',id:'localized-op',refs:[ref],title:'发布设计稿',goal:'发布已核对稿件',parameters:'仅发布到预览区',targets:['preview'],risk:'低风险',now})
  assert.deepEqual(op(state,'localized-op').history.at(-1)?.message,{key:'business.work.history.proposed'})
  const approval=op(state,'localized-op').approval!
  state=changeBusinessWork(state,{type:'decide-operation',operationId:'localized-op',approvalId:approval.id,expectedVersion:approval.version,decision:'approved',note:'保留原始说明',now})
  assert.deepEqual(op(state,'localized-op').history.at(-1)?.message,{key:'business.work.history.approved',params:{note:'保留原始说明'}})
  state=changeBusinessWork(state,{type:'execute',operationId:'localized-op',expectedVersion:op(state,'localized-op').version,now})
  assert.deepEqual(op(state,'localized-op').history.at(-1)?.message,{key:'business.work.history.execute'})
  assert.deepEqual(op(state,'localized-op').targets[0]?.attempts[0]?.receipts[0]?.message,{key:'business.work.receipt.accepted'})
  state=changeBusinessWork(state,{type:'receipt',operationId:'localized-op',expectedVersion:op(state,'localized-op').version,unknown:false,now})
  assert.deepEqual(op(state,'localized-op').history.at(-1)?.message,{key:'business.work.history.receipt'})
  assert.deepEqual(op(state,'localized-op').targets[0]?.attempts[0]?.receipts.at(-1)?.message,{key:'business.work.receipt.verified'})
})

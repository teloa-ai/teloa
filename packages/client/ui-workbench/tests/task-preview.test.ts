import test from 'node:test'
import assert from 'node:assert/strict'
import { changeTaskPreview, emptyTaskPreview, withTaskExamples } from '../src/client/task-preview.ts'

const now='2026-09-11T01:00:00Z'
const examples=()=>withTaskExamples(emptyTaskPreview(),now)
const rejectsWith=(code:string)=>(error:unknown)=>{
  assert.equal((error as {code?:string}).code,code)
  return true
}

test('审批决定固定提交快照，批准不会宣称执行成功或完成任务',()=>{
  const state=examples(),approval=state.approvals[0]!
  const next=changeTaskPreview(state,{type:'decide',approvalId:approval.id,expectedVersion:1,decision:'approved',note:'核对当前对象与影响范围，同意。',now})
  assert.equal(next.approvals[0]?.status,'approved')
  assert.equal(next.approvals[0]?.decision?.actorId,'self')
  assert.equal(next.tasks.find(task=>task.id===approval.taskId)?.execution,'not_started')
  assert.notEqual(next.tasks.find(task=>task.id===approval.taskId)?.state,'completed')
  assert.deepEqual(next.approvals[0]?.snapshot,approval.snapshot)
  assert.equal(state.approvals[0]?.status,'pending')
  assert.throws(()=>changeTaskPreview(next,{type:'decide',approvalId:approval.id,expectedVersion:2,decision:'rejected',note:'覆盖',now}),rejectsWith('teloa/conflict'))
})

test('改动待审任务使旧审批失效，重新提交保留旧版而不修改快照',()=>{
  const before=examples(),approval=before.approvals[0]!
  const changed=changeTaskPreview(before,{type:'edit',taskId:approval.taskId,title:'只调查，不隔离',goal:'核实证据，不执行隔离。',now})
  assert.equal(changed.approvals[0]?.status,'stale')
  assert.equal(changed.approvals[0]?.snapshot.title,approval.snapshot.title)
  assert.throws(()=>changeTaskPreview(changed,{type:'decide',approvalId:approval.id,expectedVersion:2,decision:'approved',note:'同意',now}),rejectsWith('teloa/version-conflict'))
  const resubmitted=changeTaskPreview(changed,{type:'submit',taskId:approval.taskId,id:'approval-v2',now})
  assert.equal(resubmitted.approvals.length,before.approvals.length+1)
  assert.equal(resubmitted.approvals.at(-1)?.snapshot.subjectVersion,2)
  assert.equal(resubmitted.approvals.at(-1)?.snapshot.goal,'核实证据，不执行隔离。')
  assert.equal(resubmitted.approvals[0]?.snapshot.goal,approval.snapshot.goal)
})

test('过期审批及错误版本不能批准，空意见不能形成决定',()=>{
  const state=examples(),approval=state.approvals[0]!
  assert.throws(()=>changeTaskPreview(state,{type:'decide',approvalId:approval.id,expectedVersion:99,decision:'approved',note:'同意',now}),rejectsWith('teloa/version-conflict'))
  assert.throws(()=>changeTaskPreview(state,{type:'decide',approvalId:approval.id,expectedVersion:1,decision:'approved',note:'同意',now:'2026-09-13T00:00:00Z'}),rejectsWith('teloa/conflict'))
  assert.throws(()=>changeTaskPreview(state,{type:'decide',approvalId:approval.id,expectedVersion:1,decision:'approved',note:'  ',now}),rejectsWith('teloa/invalid-input'))
})

test('补资料先待核验，不通过保留缺口，通过才恢复同一任务',()=>{
  let state=examples()
  state=changeTaskPreview(state,{type:'supplement',taskId:'preview-material',id:'s1',source:'CMDB 记录 v3',note:'负责人为当班运维。',now})
  assert.equal(state.tasks.find(task=>task.id==='preview-material')?.need,'materials')
  assert.equal(state.tasks.find(task=>task.id==='preview-material')?.supplements[0]?.status,'pending')
  state=changeTaskPreview(state,{type:'verify',taskId:'preview-material',supplementId:'s1',accepted:false,now})
  assert.equal(state.tasks.find(task=>task.id==='preview-material')?.need,'materials')
  state=changeTaskPreview(state,{type:'supplement',taskId:'preview-material',id:'s2',source:'资产登记 v4',note:'已核实责任人与资产等级。',now})
  state=changeTaskPreview(state,{type:'verify',taskId:'preview-material',supplementId:'s2',accepted:true,now})
  assert.equal(state.tasks.find(task=>task.id==='preview-material')?.need,null)
  assert.equal(state.tasks.find(task=>task.id==='preview-material')?.state,'ready')
  assert.equal(state.tasks.find(task=>task.id==='preview-material')?.supplements.length,2)
})

test('异常重试失败留在需要你，交接保留原作者与所有历史',()=>{
  let state=examples()
  assert.throws(()=>changeTaskPreview(state,{type:'progress',taskId:'preview-handoff',action:'start',now}),/交接/)
  state=changeTaskPreview(state,{type:'retry',taskId:'preview-error',succeeded:false,now})
  assert.equal(state.tasks.find(task=>task.id==='preview-error')?.need,'error')
  state=changeTaskPreview(state,{type:'retry',taskId:'preview-error',succeeded:true,now})
  assert.equal(state.tasks.find(task=>task.id==='preview-error')?.state,'ready')
  const original=state.tasks.find(task=>task.id==='preview-handoff')!
  state=changeTaskPreview(state,{type:'handoff',taskId:original.id,assigneeId:'researcher',note:'保留原目标并接续。',now})
  const after=state.tasks.find(task=>task.id===original.id)!
  assert.equal(after.authorId,original.authorId)
  assert.equal(after.assigneeId,'researcher')
  assert.equal(after.need,null)
  assert.deepEqual(after.history.slice(0,-1),original.history)
  assert.throws(()=>changeTaskPreview(state,{type:'handoff',taskId:original.id,assigneeId:'twin',note:'分身接管执行',now}),/交接|代拟/)
})

test('完成必须有结果，取消不能被继续，审批任务不能用普通推进绕过决定',()=>{
  let state=examples()
  assert.throws(()=>changeTaskPreview(state,{type:'progress',taskId:'preview-review',action:'start',now}),/审批/)
  state=changeTaskPreview(state,{type:'create',id:'ordinary',title:'研究对比',goal:'核对来源',scope:'general',now})
  state=changeTaskPreview(state,{type:'progress',taskId:'ordinary',action:'start',now})
  assert.throws(()=>changeTaskPreview(state,{type:'progress',taskId:'ordinary',action:'complete',now}),/结果/)
  state=changeTaskPreview(state,{type:'progress',taskId:'ordinary',action:'complete',result:'已核对两份来源并记录差异。',now})
  assert.equal(state.tasks.find(task=>task.id==='ordinary')?.result,'已核对两份来源并记录差异。')
  assert.throws(()=>changeTaskPreview(state,{type:'progress',taskId:'ordinary',action:'resume',now}),/状态/)
})

test('已批准版本不能再次发起同一审批；编辑后才提交新版本',()=>{
  const before=examples(),approval=before.approvals[0]!
  let state=changeTaskPreview(before,{type:'decide',approvalId:approval.id,expectedVersion:1,decision:'approved',note:'核对后同意。',now})
  assert.throws(()=>changeTaskPreview(state,{type:'submit',taskId:approval.taskId,id:'again',now}),/批准/)
  state=changeTaskPreview(state,{type:'edit',taskId:approval.taskId,title:'核对另一项建议',goal:'更新调查范围。',now})
  state=changeTaskPreview(state,{type:'submit',taskId:approval.taskId,id:'new-version',now})
  assert.equal(state.approvals[0]?.status,'approved')
  assert.equal(state.approvals.at(-1)?.snapshot.subjectVersion,2)
})

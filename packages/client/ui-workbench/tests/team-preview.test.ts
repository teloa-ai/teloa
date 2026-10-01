import test from 'node:test'
import assert from 'node:assert/strict'
import { changeTeamPreview } from '../src/client/team-preview.ts'
import { changeTaskPreview, emptyTaskPreview, taskNeeds, withTaskExamples } from '../src/client/task-preview.ts'
import { canReceiveTask, withRoleExamples } from '../src/client/role-preview.ts'

const now='2026-09-11T02:00:00Z'
const initial=()=>withTaskExamples(emptyTaskPreview(),now)

test('分身稿保存必须携带原岗位版本，不能省略基线覆盖已有稿',()=>{
  const state=initial()
  const unsafe={type:'draft',roleId:'twin',body:'缺少编辑基线的稿件',now} as Parameters<typeof changeTeamPreview>[1]
  assert.throws(()=>changeTeamPreview(state,unsafe),/版本/)
})

test('分身配置或工作稿更新后，旧编辑基线不能再次保存',()=>{
  const command={type:'draft' as const,roleId:'twin',expectedVersion:1,body:'首次保存的分身工作稿',now}
  const saved=changeTeamPreview(initial(),command)
  assert.throws(()=>changeTeamPreview(saved,{...command,body:'从旧编辑覆盖的新稿'}),/版本/)
  assert.equal(saved.roles.find(role=>role.id==='twin')?.draft?.body,command.body)
})

test('暂停拦截新交办及接续，不把运行中任务或已开始外部操作宣称取消',()=>{
  let state=initial()
  state=changeTeamPreview(state,{type:'assign',roleId:'researcher',id:'work-1',title:'核对资料',goal:'核对来源版本',scope:'general',now})
  state=changeTaskPreview(state,{type:'progress',taskId:'work-1',action:'start',now})
  state=changeTeamPreview(state,{type:'lifecycle',roleId:'researcher',expectedVersion:1,action:'pause',reason:'暂停接收新工作',now})
  assert.equal(state.tasks.find(task=>task.id==='work-1')?.state,'running')
  assert.throws(()=>changeTeamPreview(state,{type:'assign',roleId:'researcher',id:'work-2',title:'新工作',goal:'新目标',scope:'general',now}),/在岗|暂停/)
  state=changeTaskPreview(state,{type:'progress',taskId:'work-1',action:'complete',result:'原有任务已收尾。',now})
  assert.equal(state.tasks.find(task=>task.id==='work-1')?.state,'completed')
  state=changeTeamPreview(state,{type:'lifecycle',roleId:'researcher',expectedVersion:2,action:'resume',reason:'恢复新交办',now})
  assert.equal(state.roles.find(role=>role.id==='researcher')?.state,'active')
})

test('退役同时保留审批与交接，完成交接不能批准或覆盖原提议',()=>{
  const before=initial(),approval=before.approvals[0]!
  let state=changeTeamPreview(before,{type:'lifecycle',roleId:'investigator',expectedVersion:1,action:'retire',reason:'调整岗位编制',now})
  const task=state.tasks.find(task=>task.id==='preview-review')!
  assert.deepEqual(taskNeeds(task),['approval','handoff'])
  assert.deepEqual(state.approvals,before.approvals)
  state=changeTaskPreview(state,{type:'handoff',taskId:task.id,assigneeId:'reviewer',note:'沿用原依据与提交版本。',now})
  const after=state.tasks.find(item=>item.id===task.id)!
  assert.equal(after.authorId,'investigator')
  assert.equal(after.assigneeId,'reviewer')
  assert.deepEqual(taskNeeds(after),['approval'])
  assert.deepEqual(state.approvals[0]?.snapshot,approval.snapshot)
  assert.equal(state.approvals[0]?.status,'pending')
  assert.throws(()=>changeTeamPreview(state,{type:'lifecycle',roleId:'investigator',expectedVersion:2,action:'resume',reason:'复用退役身份',now}),/退役/)
})

test('先审批再交接同样保留交接，退役不能批量迁移已完成任务或改写作者',()=>{
  let state=initial()
  state=changeTeamPreview(state,{type:'assign',roleId:'investigator',id:'closed',title:'完成调查',goal:'核对日志',scope:'SOC',now})
  state=changeTaskPreview(state,{type:'progress',taskId:'closed',action:'start',now})
  state=changeTaskPreview(state,{type:'progress',taskId:'closed',action:'complete',result:'日志已核对。',now})
  const closed=state.tasks.find(task=>task.id==='closed')!
  state=changeTeamPreview(state,{type:'lifecycle',roleId:'investigator',expectedVersion:1,action:'retire',reason:'调整岗位',now})
  state=changeTaskPreview(state,{type:'decide',approvalId:'preview-approval',expectedVersion:1,decision:'approved',note:'核对当前提议后同意。',now})
  assert.deepEqual(taskNeeds(state.tasks.find(task=>task.id==='preview-review')!),['handoff'])
  assert.equal(state.tasks.find(task=>task.id==='preview-review')?.state,'waiting')
  assert.deepEqual(state.tasks.find(task=>task.id==='closed'),closed)
})

test('交接再次校验在岗、同业务和岗位身份，不允许分身或过期生命周期操作',()=>{
  let state=initial()
  state=changeTeamPreview(state,{type:'lifecycle',roleId:'investigator',expectedVersion:1,action:'retire',reason:'调整岗位',now})
  for(const assigneeId of ['researcher','investigator','twin','self'])assert.throws(()=>changeTaskPreview(state,{type:'handoff',taskId:'preview-review',assigneeId,note:'接续',now}),/在岗|业务|分身|岗位/)
  state=changeTeamPreview(state,{type:'lifecycle',roleId:'reviewer',expectedVersion:1,action:'pause',reason:'暂停交办',now})
  assert.throws(()=>changeTaskPreview(state,{type:'handoff',taskId:'preview-review',assigneeId:'reviewer',note:'接续',now}),/在岗|暂停/)
  assert.throws(()=>changeTeamPreview(state,{type:'lifecycle',roleId:'reviewer',expectedVersion:1,action:'resume',reason:'旧页面恢复',now}),/版本/)
  assert.equal(canReceiveTask(state.roles.find(role=>role.id==='reviewer'),'SOC'),false)
})

test('交接期间补齐资料仍需安排接续，不能清掉另一项待办',()=>{
  let state=changeTeamPreview(initial(),{type:'lifecycle',roleId:'investigator',expectedVersion:1,action:'retire',reason:'调整岗位',now})
  state=changeTaskPreview(state,{type:'supplement',taskId:'preview-material',id:'source-1',source:'CMDB v4',note:'补齐资产责任人',now})
  state=changeTaskPreview(state,{type:'verify',taskId:'preview-material',supplementId:'source-1',accepted:true,now})
  assert.deepEqual(taskNeeds(state.tasks.find(task=>task.id==='preview-material')!),['handoff'])
  assert.throws(()=>changeTaskPreview(state,{type:'progress',taskId:'preview-material',action:'start',now}),/交接/)
})

test('记忆确认保持来源和私人范围，撤回保留历史；分身草案不能改变审批与任务',()=>{
  let state=initial(),tasks=state.tasks,approvals=state.approvals
  state=changeTeamPreview(state,{type:'memory-add',roleId:'twin',id:'m1',title:'交班偏好',text:'先列需要本人判断的事项。',source:'本人交班反馈 v1',now})
  state=changeTeamPreview(state,{type:'memory-decide',roleId:'twin',memoryId:'m1',expectedVersion:1,action:'confirm',now})
  let memory=state.roles.find(role=>role.id==='twin')!.memories.find(item=>item.id==='m1')!
  assert.equal(memory.scope,'private');assert.equal(memory.source,'本人交班反馈 v1');assert.equal(memory.status,'confirmed')
  state=changeTeamPreview(state,{type:'memory-decide',roleId:'twin',memoryId:'m1',expectedVersion:2,action:'withdraw',now})
  memory=state.roles.find(role=>role.id==='twin')!.memories.find(item=>item.id==='m1')!
  assert.equal(memory.text,'先列需要本人判断的事项。');assert.equal(memory.status,'withdrawn')
  state=changeTeamPreview(state,{type:'draft',roleId:'twin',expectedVersion:state.roles.find(role=>role.id==='twin')!.version,body:'代拟交班内容，仍由本人判断后使用。',now})
  assert.deepEqual(state.tasks,tasks);assert.deepEqual(state.approvals,approvals)
  assert.equal(state.roles.find(role=>role.id==='twin')?.draft?.editorId,'self')
  assert.throws(()=>changeTeamPreview(state,{type:'assign',roleId:'twin',id:'fake',title:'代批',goal:'替本人批准',scope:'general',now}),/分身|岗位/)
})

test('编辑岗位不能删掉未完成任务所需范围，重新加载示例不能复活退役岗位',()=>{
  let state=initial(),role=state.roles.find(role=>role.id==='investigator')!
  assert.throws(()=>changeTeamPreview(state,{type:'edit',roleId:role.id,expectedVersion:1,name:role.name,duty:role.duty,scopes:['general'],dataScope:role.dataScope,executionScope:role.executionScope,skills:role.skills,knowledge:role.knowledge,now}),/未完成|业务/)
  state=changeTeamPreview(state,{type:'lifecycle',roleId:role.id,expectedVersion:1,action:'retire',reason:'退役',now})
  assert.equal(withRoleExamples(state.roles,now).find(item=>item.id===role.id)?.state,'retired')
})

test('岗位编号归一化后仍拒绝本人身份和重名身份，不能产生重复成员',()=>{
  const state=initial(),role=state.roles.find(item=>item.id==='researcher')!
  const fields={name:role.name,kind:role.kind,scopes:role.scopes,duty:role.duty,dataScope:role.dataScope,executionScope:role.executionScope,skills:role.skills,knowledge:role.knowledge}
  for(const id of [' self ',' researcher '])assert.throws(()=>changeTeamPreview(state,{type:'create',id,fields,now}),/身份/)
})

// 2026-09-21 用户裁定：canReceiveTask 与契约 roleSupportsScope 同口径——通用工作（general）对所有在岗正式同事开放，业务范围仍按岗位声明严格过滤。
test('canReceiveTask 按契约同口径：通用工作对任意在岗同事开放，业务范围仍要求岗位声明包含该范围',()=>{
  const state=initial()
  const investigator=state.roles.find(role=>role.id==='investigator')! // scopes:['SOC']
  assert.equal(canReceiveTask(investigator,'general'),true)
  assert.equal(canReceiveTask(investigator,'AppSec'),false)
})

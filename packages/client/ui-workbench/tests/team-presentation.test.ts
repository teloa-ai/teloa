import test from 'node:test'
import assert from 'node:assert/strict'
import { roleLifecyclePath, roleMemoryPath, roleSkillNotice, roleWorkPath } from '../src/client/team-presentation.ts'
const copy:Record<string,string>={
  'team.presentation.memory.candidate.label':'Awaiting your review',
  'team.presentation.memory.candidate.summary':"The source is recorded. Review it before adding it to the employee scope.",
  'team.presentation.memory.candidate.next':'Review candidate content',
  'team.presentation.lifecycle.paused.label':'Paused for new work',
  'team.presentation.lifecycle.paused.summary':'New assignments and follow-up triggers are paused. Work already started can finish; external actions require separate review.',
  'team.presentation.lifecycle.paused.next':'Review work in progress',
  'team.presentation.work.persistent':'Assignment saved and awaiting runtime integration. Assigning work does not start an Agent.',
  'team.presentation.skillNotice':'A Skill is a reusable method, not a required route for every task. Without a suitable Skill, the Harness can solve the problem within its sandbox and existing permissions. It asks for help or delegates only when material, credentials, external access, or a risk boundary is missing.',
}
const en=(key:string)=>copy[key]??key





test('岗位记忆按来源、核对和使用状态表达，不把页面候选记忆说成已经写入 Agent',()=>{
  assert.deepEqual(roleMemoryPath('candidate'),{
    label:'待本人核对',
    summary:"来源已记录，核对后才可进入员工范围。",
    next:'核对候选内容',
  })
  assert.deepEqual(roleMemoryPath('confirmed'),{
    label:'已核对',
    summary:'来源与范围相容时，只进入新 Run 的锁定输入，不授予资料或执行权限。',
    next:'查看适用范围',
  })
  assert.equal(roleMemoryPath('withdrawn').summary,"已撤回，不再作为员工参考；历史与来源保留。")
})

test('岗位生命周期路径区分暂停、退役与在途工作，不把停止接单说成停止外部操作',()=>{
  assert.deepEqual(roleLifecyclePath('paused'),{
    label:'暂停接收新工作',
    summary:'不再接收新交办与后续触发；已开始工作可收尾，外部操作需单独核对。',
    next:'核对已在途工作',
  })
  assert.equal(roleLifecyclePath('retired').next,'安排未完成工作交接')
})

test('岗位工作路径与 Skill 文案把自主解决和权限申请分开',()=>{
  assert.equal(roleWorkPath(true),'已保存交办，等待执行接入；交办本身不启动 Agent。')
  assert.match(roleWorkPath(false),/页面示例/)
  assert.match(roleSkillNotice(),/不是执行任务的必经路由/)
  assert.match(roleSkillNotice(),/沙箱和既有权限/)
  assert.match(roleSkillNotice(),/缺少资料、密钥、外部权限或越过风险边界/)
})

test('岗位说明、生命周期和记忆路径随当前语言变化',()=>{
  assert.deepEqual(roleMemoryPath('candidate',en),{
    label:'Awaiting your review',
    summary:"The source is recorded. Review it before adding it to the employee scope.",
    next:'Review candidate content',
  })
  assert.deepEqual(roleLifecyclePath('paused',en),{
    label:'Paused for new work',
    summary:'New assignments and follow-up triggers are paused. Work already started can finish; external actions require separate review.',
    next:'Review work in progress',
  })
  assert.equal(roleWorkPath(true,en),'Assignment saved and awaiting runtime integration. Assigning work does not start an Agent.')
  assert.match(roleSkillNotice(en),/^A Skill is a reusable method/)
})

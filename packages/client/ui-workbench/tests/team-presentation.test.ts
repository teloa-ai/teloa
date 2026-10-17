import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { roleFieldText, roleLifecyclePath, roleMemoryPath, roleMemorySourceTitle, roleSkillNotice, roleWorkPath } from '../src/client/team-presentation.ts'
// 与 i18n-messages.test.ts 相同：直接读当前源码词表，避免旧构建产物掩盖本轮词条。
registerHooks({resolve(specifier,context,next){
  if(specifier.endsWith('.js')&&specifier.startsWith('.')&&context.parentURL?.includes('/ui-workbench/src/client/i18n/')){
    const source=new URL(specifier.slice(0,-3)+'.ts',context.parentURL)
    if(existsSync(source))return next(source.href,context)
  }
  return next(specifier,context)
}})
const {translateMessage}=await import('../src/client/i18n/messages.ts')
const copy:Record<string,string>={
  'team.presentation.memory.candidate.label':'Awaiting your review',
  'team.presentation.memory.candidate.summary':"The source is recorded. Review it before adding it to the employee scope.",
  'team.presentation.memory.candidate.next':'Review candidate content',
  'team.presentation.lifecycle.paused.label':'Paused for new work',
  'team.presentation.lifecycle.paused.summary':'New assignments and follow-up triggers are paused. Work already started can finish; external actions require separate review.',
  'team.presentation.lifecycle.paused.next':'Review work in progress',
  'team.presentation.work.persistent':'After saving, open the task to review its goal and evidence, then start execution.',
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
  assert.equal(roleWorkPath(true),'保存后前往任务页，核对目标与依据并开始执行。')
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
  assert.equal(roleWorkPath(true,en),'After saving, open the task to review its goal and evidence, then start execution.')
  assert.match(roleSkillNotice(en),/^A Skill is a reusable method/)
})

test('分身字段仍等于服务端内置中文原文时按当前语言显示，本人改过或员工同文时原样显示',()=>{
  const tEn=((key:string)=>translateMessage('en',key as never)) as never
  const twin={kind:'twin',duty:'按本人确认的偏好整理资料、代拟回复和判断建议。正式批准由本人完成。',dataScope:'本人可见且明确提供的资料；私人偏好不自动共享。',executionScope:'仅代拟；不能代批、冒充本人或直接外发。'}
  assert.equal(roleFieldText(twin,'duty',tEn),'Organizes materials, drafts replies, and suggests judgments based on preferences you confirm. Formal approval stays with you.')
  assert.equal(roleFieldText(twin,'dataScope',tEn),'Materials you can see and explicitly provide; private preferences are not shared automatically.')
  assert.equal(roleFieldText(twin,'executionScope',tEn),'Drafting only; it cannot approve for you, impersonate you, or send anything externally.')
  assert.equal(roleFieldText({...twin,duty:'只整理我的周报。'},'duty',tEn),'只整理我的周报。')
  assert.equal(roleFieldText({...twin,kind:'employee'},'duty',tEn),twin.duty)
  assert.equal(roleFieldText(twin,'duty',((key:string)=>translateMessage('zh-Hant',key as never)) as never),'依本人確認的偏好整理資料、代擬回覆和判斷建議。正式批准由本人完成。')
  assert.equal(roleFieldText(twin,'duty',((key:string)=>translateMessage('ja',key as never)) as never),'Organizes materials, drafts replies, and suggests judgments based on preferences you confirm. Formal approval stays with you.')
})

test('本人反馈来源按来源类别显示当前语言，其他来源保留服务端标题',()=>{
  const tEn=((key:string)=>translateMessage('en',key as never)) as never
  assert.equal(roleMemorySourceTitle({source:{kind:'self-feedback'},sourceTitle:'本人反馈'},tEn),'Personal feedback')
  assert.equal(roleMemorySourceTitle({source:{kind:'task'},sourceTitle:'整理周报'},tEn),'整理周报')
})

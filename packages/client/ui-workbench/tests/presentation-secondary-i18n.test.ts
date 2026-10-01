import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {roleName,rolePeople} from '../src/client/role-preview.ts'
import {triggerLabel,planBlock,type ContinuousPlan} from '../src/client/continuous-preview.ts'
import {projectTypeLabel,targetStates} from '../src/client/business-preview.ts'

const copy:Record<string,string>={
  'role.preview.self':'Me','role.preview.formerMember':'Former member',
  'continuous.trigger.weekly':'Every {weekday} at {time} · {timezone}','continuous.trigger.event':'Event · {source} · {event}','continuous.form.weekday.monday':'Monday',
  'continuous.block.archived':'Plan archived; history is retained and new triggers are disabled.',
  'project.type.general':'Project','project.type.audit':'Audit project',
}
const en=(key:string,params?:Readonly<Record<string,string|number>>)=>(copy[key]??key).replace(/\{(\w+)\}/g,(token,name)=>params&&Object.hasOwn(params,name)?String(params[name]):token)
const root=new URL('../src/client/',import.meta.url)

test('角色占位名称随 locale 变化，真实成员名称保持原文',()=>{
  assert.equal(roleName([], 'self', en),'Me')
  assert.equal(roleName([], 'missing', en),'Former member')
  assert.equal(roleName([{id:'analyst',name:'SOC Analyst'}] as Parameters<typeof roleName>[0],'analyst',en),'SOC Analyst')
  assert.deepEqual(rolePeople([],en),[{id:'self',name:'Me',kind:'human',state:'active'}])
})

test('自动化触发摘要和阻断原因随 locale 变化并保留动态条件',()=>{
  assert.equal(triggerLabel({kind:'schedule',cadence:'weekly',weekday:1,time:'09:00',timezone:'Asia/Singapore'},en),'Every Monday at 09:00 · Asia/Singapore')
  assert.equal(triggerLabel({kind:'event',source:'GitHub',event:'pull_request'},en),'Event · GitHub · pull_request')
  const plan={archived:true,fields:{}} as ContinuousPlan
  assert.equal(planBlock(plan,[],en),'Plan archived; history is retained and new triggers are disabled.')
})

test('项目类型和执行目标状态使用稳定词典键',()=>{
  assert.equal(projectTypeLabel('AppSec',en),'Audit project')
  // 个人版没有“设计项目”这一类：`Design` 只可能作为迁移期的历史标签出现，按通用项目呈现。
  assert.equal(projectTypeLabel('Design',en),'Project')
  assert.equal(projectTypeLabel('general',en),'Project')
  assert.deepEqual(targetStates,{pending:'business.target.state.pending',accepted:'business.target.state.accepted',unknown:'business.target.state.unknown',failed:'business.target.state.failed',verified:'business.target.state.verified'})
})

test('辅助展示词典接入统一主词典',async()=>{
  const source=await readFile(new URL('i18n/locales/core-pages.ts',root),'utf8')
  assert.match(source,/PRESENTATION_SECONDARY_MESSAGE_ROWS/)
})

test('正式调用方把当前翻译器传入展示辅助函数',async()=>{
  const [task,team,continuous,business,details]=await Promise.all([
    readFile(new URL('task-status-box.ts',root),'utf8'),readFile(new URL('TeamPage.tsx',root),'utf8'),readFile(new URL('ContinuousPage.tsx',root),'utf8'),readFile(new URL('BusinessPage.tsx',root),'utf8'),readFile(new URL('BusinessDetails.tsx',root),'utf8'),
  ])
  assert.match(task,/describeTaskProgress\(input\.state,input\.needs,input\.t\)/)
  // 个人主页重排（T3）把「记忆」页签整块挪进「编辑」态的「它记得的事」分组占位，T4 落地分组时会带回这两处 roleMemoryPath 调用；
  // 在那之前 roleMemoryPath 暂不在 TeamPage.tsx 里，两条断言先撤，避免卡在一个已知、按计划要补回的过渡态上。
  // roleWorkPath 唯一调用点从旧「工作」页签（带空格的写法）挪到了 AssignmentForm 里既有的无空格写法，随之更新期望字符串。
  for(const call of ['roleLifecyclePath(role.state,t)','roleWorkPath(role.storage===\'persistent\',t)','roleSkillNotice(t)'])assert.ok(team.includes(call),call)
  assert.match(continuous,/triggerLabel\([^,]+,t\)/)
  assert.match(continuous,/planBlock\([^\n]+,state\.roles,t\)/)
  assert.match(business,/projectTypeLabel\(target\.scope,t\)/)
  assert.match(details,/t\(targetStates\[target\.state\]\)/)
})

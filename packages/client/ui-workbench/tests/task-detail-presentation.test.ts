import test from 'node:test'
import assert from 'node:assert/strict'
import {describeTaskProgress,shouldShowHandoffForm,taskDetailReadingOrder} from '../src/client/task-detail-presentation.ts'
const copy:Record<string,string>={
  'task.progress.need.approval.title':'Awaiting your approval decision',
  'task.progress.need.approval.description':'The task and submitted version are preserved. Review the goal, evidence, and impact before approving, rejecting, or requesting changes.',
  'task.progress.multiple.title':'{count} pending items need attention',
  'task.progress.multiple.description':'{items} remain separate. Completing one does not clear the other; handle each item below.',
  'attention.approval':'Approval','attention.handoff':'Handoff',
  'task.progress.state.running.title':'Task in progress',
  'task.progress.state.running.description':'Continue in the linked conversation and save the output. Review the actual delivery before completing the task.',
}
const en=(key:string,params?:Readonly<Record<string,string|number>>)=>(copy[key]??key).replace(/\{(\w+)\}/g,(token,name)=>params&&Object.hasOwn(params,name)?String(params[name]):token)

test('任务详情固定按概要、进展、过程、结果和管理的顺序组织',()=>{
  assert.deepEqual(taskDetailReadingOrder,['summary','progress','work','results','management'])
})

test('当前进展把真实待办翻译成用户能执行的下一步',()=>{
  assert.deepEqual(describeTaskProgress('waiting',['approval']),{
    title:'等待你的审批决定',
    description:'任务和提交版本已经保留。核对目标、依据与影响后，再决定批准、驳回或要求修改。',
  })
  assert.deepEqual(describeTaskProgress('waiting',['approval','handoff']),{
    title:'有 2 项待办需要处理',
    description:'审批和交接分别保留，完成其中一项不会清除另一项。请按下方提示逐项处理。',
  })
  assert.deepEqual(describeTaskProgress('running',[]),{
    title:'任务正在推进',
    description:'在关联会话中继续工作并保存成果；完成任务前仍要核对实际交付。',
  })
})

test('任务进展固定文案随当前语言变化，待办类型保留语义',()=>{
  assert.deepEqual(describeTaskProgress('waiting',['approval'],en),{
    title:'Awaiting your approval decision',
    description:'The task and submitted version are preserved. Review the goal, evidence, and impact before approving, rejecting, or requesting changes.',
  })
  assert.deepEqual(describeTaskProgress('waiting',['approval','handoff'],en),{
    title:'2 pending items need attention',
    description:'Approval / Handoff remain separate. Completing one does not clear the other; handle each item below.',
  })
  assert.deepEqual(describeTaskProgress('running',[],en),{
    title:'Task in progress',
    description:'Continue in the linked conversation and save the output. Review the actual delivery before completing the task.',
  })
})

test('接任表单只在真实待交接且用户主动展开后出现',()=>{
  assert.equal(shouldShowHandoffForm(false,false),false)
  assert.equal(shouldShowHandoffForm(false,true),false)
  assert.equal(shouldShowHandoffForm(true,false),false)
  assert.equal(shouldShowHandoffForm(true,true),true)
})

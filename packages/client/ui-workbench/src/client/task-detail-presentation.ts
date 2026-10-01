import type {AttentionKind} from './task-preview.js'
import type {TeloaTranslate} from './i18n/index.js'

export const taskDetailReadingOrder=['summary','progress','work','results','management'] as const

const needLabels:Record<AttentionKind,string>={
  approval:'审批',
  materials:'资料补充',
  connection:'待连接',
  error:'异常处理',
  review:'结果核对',
  handoff:'交接',
  dispatch:'工作交办',
  execution:'待执行',
}

const singleNeed:Record<AttentionKind,{title:string;description:string}>={
  approval:{title:'等待你的审批决定',description:'任务和提交版本已经保留。核对目标、依据与影响后，再决定批准、驳回或要求修改。'},
  materials:{title:'需要补充依据',description:'当前资料不足以继续判断。补充可核验的来源和说明后，再继续这项任务。'},
  connection:{title:'待连接执行面',description:'执行器尚未连接。连接并核对执行面后，再执行已批准动作。'},
  error:{title:'需要处理执行异常',description:'先核对连接或执行记录，再决定是否重试；不要把未知结果当作失败。'},
  review:{title:'等待你核对本轮结果',description:'本轮执行已经结束。请查看会话、工作成果和执行记录，再确认是否可以结项。'},
  handoff:{title:'需要安排接任员工',description:'原目标、作者和历史已经保留。选择符合当前业务范围的在岗员工后，任务才可继续。'},
  execution:{title:'待执行',description:'执行已批准动作'},
  dispatch:{title:'需要安排后续负责人',description:'当前工作尚未交办。选择合适的负责人并核对范围后，再开始后续推进。'},
}

const stateCopy={
  ready:{title:'可以开始推进',description:'目标和负责人已经确定。可以关联会话补充上下文，或开始这项任务。'},
  running:{title:'任务正在推进',description:'在关联会话中继续工作并保存成果；完成任务前仍要核对实际交付。'},
  paused:{title:'任务已暂停',description:'现有记录和成果继续保留。确认负责人和上下文后，可继续推进或取消任务。'},
  waiting:{title:'当前状态等待核对',description:'任务处于等待状态，但没有可确认的待办类型。刷新任务后再决定下一步。'},
  blocked:{title:'任务当前受阻',description:'阻塞原因尚未形成可处理待办。查看执行记录和工作会话，核对真实状态后再继续。'},
  completed:{title:'任务已完成',description:'结果和定稿的交付已经保留。可以继续审阅工作成果、执行效果和历史记录。'},
  cancelled:{title:'任务已取消',description:'任务不会继续推进，已有历史和在途外部操作记录仍需分别核对。'},
} as const

const key=(value:string)=>value as Parameters<TeloaTranslate>[0]

export function describeTaskProgress(state:keyof typeof stateCopy,needs:readonly AttentionKind[],t?:TeloaTranslate):{title:string;description:string}{
  const unique=[...new Set(needs)]
  if(unique.length===1){
    const need=unique[0]!
    if(need==='execution')return t?{title:t('plan.run.prepared'),description:t('security.attention.execution-required')}:singleNeed.execution
    return t?{title:t(key(`task.progress.need.${need}.title`)),description:t(key(`task.progress.need.${need}.description`))}:singleNeed[need]
  }
  if(unique.length>1)return {
    title:t?t('task.progress.multiple.title',{count:unique.length}):`有 ${unique.length} 项待办需要处理`,
    description:t?t('task.progress.multiple.description',{items:unique.map(need=>t(need==='execution'?'plan.run.prepared':key(`attention.${need}`))).join(' / ')}):`${unique.map(need=>needLabels[need]).join('和')}分别保留，完成其中一项不会清除另一项。请按下方提示逐项处理。`,
  }
  return t?{title:t(key(`task.progress.state.${state}.title`)),description:t(key(`task.progress.state.${state}.description`))}:stateCopy[state]
}

export function shouldShowHandoffForm(hasPendingHandoff:boolean,expanded:boolean):boolean{
  return hasPendingHandoff&&expanded
}

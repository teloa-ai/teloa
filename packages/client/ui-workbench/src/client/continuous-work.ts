import { businessScopeNames } from './business-directory.ts'
import { createArtifact } from './artifact-preview.ts'
import { runArtifactSource } from './artifact-source.ts'
import { verifyPlanTemplate } from './plan-template.ts'
import type { MarketState } from './market-preview.ts'
import { changeTaskPreview, type TaskPreview } from './task-preview.ts'
import { canReceiveTask, withRoleExamples } from './role-preview.ts'
import { continuousText as text, planBlock, validatePlanFields, type ContinuousChange, type ContinuousPlan, type PlanFields, type PlanRun } from './continuous-preview.ts'

// 页面内共享状态；真实触发、调度、身份与幂等存储在后端阶段接入。
export function changeContinuousWork(state:TaskPreview,change:ContinuousChange,market?:MarketState):TaskPreview{
  if(!Number.isFinite(Date.parse(change.now)))throw Error('时间无效。')
  const value=state.continuous
  const putPlan=(plan:ContinuousPlan)=>({...state,continuous:{...value,plans:value.plans.some(item=>item.id===plan.id)?value.plans.map(item=>item.id===plan.id?plan:item):[...value.plans,plan]}})
  const putRun=(run:PlanRun)=>({...state,continuous:{...value,runs:value.runs.map(item=>item.id===run.id?run:item)}})
  const addRun=(run:PlanRun)=>{text(run.id,'执行编号',240);if(value.runs.some(item=>item.id===run.id))throw Error('执行编号冲突。');return {...state,continuous:{...value,runs:[...value.runs,run]}}}
  if(change.type==='save'){
    const id=text(change.id,'计划编号',240),plan=value.plans.find(item=>item.id===id)
    if(plan&&(plan.revision!==change.expectedRevision||plan.archived||plan.handoff))throw Error('计划修订已变化、已归档或等待交接，请先核对。')
    if(!plan&&change.expectedRevision!==undefined)throw Error('原计划不存在，不能覆盖此修订。')
    if(plan&&change.template&&JSON.stringify(plan.template)!==JSON.stringify(change.template))throw Error('已有计划的模板来源不可替换，请另建计划。')
    const template=plan?.template||(!plan&&change.template?verifyPlanTemplate(change.template,market,state.industryLoads):undefined)
    if(template&&(template.industry||template.scope!=='general')&&template.scope!==change.fields.scope)throw Error('行业模板须保留所属业务，请选择相应业务员工。')
    const fields=validatePlanFields(change.fields,state.roles,businessScopeNames(state.business.spaces))
    if(plan&&fields.roleId!==plan.fields.roleId)throw Error('负责员工变更请通过交接入口，保留接续说明。')
    return putPlan({id,fields,...(template?{template:structuredClone(template)}:{}),version:(plan?.version||0)+1,revision:(plan?.revision||0)+1,enabled:false,archived:false,history:[...(plan?.history||[]),{text:plan?'保存新配置版本，暂停等待核对。':'创建计划，暂停等待核对。',at:change.now}]})
  }
  if('planId' in change){
    const plan=value.plans.find(item=>item.id===change.planId)
    if(!plan)throw Error('计划不存在。')
    if(change.type==='trigger'){
      const input=text(change.input,'本次输入'),occurrenceId=text(change.occurrenceId,'触发标识',240)
      const previous=value.runs.find(run=>run.planId===plan.id&&run.occurrenceId===occurrenceId&&!run.retryOf)
      if(previous){if(previous.input!==input)throw Error('同一触发标识的输入不一致，请核对原执行。');return state}
      const block=planBlock(plan,state.roles);if(block)throw Error(block)
      const role=state.roles.find(role=>role.id===plan.fields.roleId)!
      return addRun({id:change.id,planId:plan.id,occurrenceId,revision:1,snapshot:{version:plan.version,fields:structuredClone(plan.fields),...(plan.template?{template:structuredClone(plan.template)}:{})},actor:{id:role.id,name:role.name},input,state:'running',result:'',output:'',createdAt:change.now})
    }
    if(plan.revision!==change.expectedRevision)throw Error('计划修订已变化，请重新核对。')
    if(plan.archived)throw Error('计划已归档，历史保留。')
    let next=plan,log=''
    if(change.type==='enabled'){
      if(change.enabled){const block=planBlock({...plan,enabled:true},state.roles);if(block)throw Error(block)}
      if(plan.enabled===change.enabled)return state
      next={...plan,enabled:change.enabled};log=change.enabled?'恢复后续触发；不补跑历史触发。':'暂停后续触发；在途执行仍可收尾。'
    }else if(change.type==='archive'){
      next={...plan,archived:true,enabled:false};log='归档计划，保留执行历史：'+text(change.note,'归档说明')
    }else{
      if(!canReceiveTask(state.roles.find(role=>role.id===change.roleId),plan.fields.scope)||change.roleId===plan.fields.roleId)throw Error('请选择另一位同业务在岗的员工。')
      const {handoff,...remaining}=plan
      next={...remaining,version:plan.version+1,enabled:false,fields:{...plan.fields,roleId:change.roleId}}
      log='交接负责员工，形成新版本并暂停：'+text(change.note,'交接说明')
    }
    return putPlan({...next,revision:plan.revision+1,history:[...plan.history,{text:log,at:change.now}]})
  }
  const run=value.runs.find(item=>item.id===change.runId)
  if(!run)throw Error('执行不存在。')
  if(change.type==='finish'&&run.state===change.outcome&&run.result===change.result.trim()&&run.output===change.output.trim()&&run.revision===change.expectedRevision+1)return state
  if('expectedRevision' in change&&run.revision!==change.expectedRevision)throw Error('执行修订已变化，请重新核对。')
  if(change.type==='finish'){
    if(run.state!=='running')throw Error('本次执行已收尾，不能覆盖原结果。')
    if(!['completed','failed'].includes(change.outcome)||change.output.length>16000)throw Error('执行结果无效或工作成果过长。')
    const next:PlanRun={...run,revision:run.revision+1,state:change.outcome,result:text(change.result,'结果说明'),output:change.output.trim(),finishedAt:change.now}
    if(next.state==='failed')return putRun(next)
    const artifact=createArtifact({id:'run-result:'+run.id,source:runArtifactSource(next),title:run.snapshot.fields.title,sections:[{id:'result',title:'结果说明',text:next.result},...(next.output?[{id:'output',title:'工作成果',text:next.output}]:[])],note:'记录本次执行完成结果',primary:true,now:change.now})
    if(state.artifacts.some(item=>item.id===artifact.id))throw Error('产物编号冲突，执行未收尾。')
    return {...putRun({...next,artifact:{id:artifact.id,version:1}}),artifacts:[...state.artifacts,artifact]}
  }
  const child=value.runs.find(item=>item.retryOf===run.id)
  if(change.type==='retry'){
    if(child)return state
    if(run.state!=='failed'||run.resolution)throw Error('只有尚未接续的失败执行可以重试。')
    const plan=value.plans.find(item=>item.id===run.planId)
    if(!plan||plan.version!==run.snapshot.version)throw Error('计划版本已变化，请明确结束旧失败接续，再按新目标触发。')
    const block=planBlock(plan,state.roles);if(block)throw Error(block)
    const role=state.roles.find(role=>role.id===plan.fields.roleId)!
    return addRun({id:change.id,planId:run.planId,occurrenceId:run.occurrenceId,revision:1,snapshot:structuredClone(run.snapshot),actor:{id:role.id,name:role.name},input:run.input,state:'running',result:'',output:'',createdAt:change.now,retryOf:run.id})
  }
  if(change.type==='resolve'){
    if(run.state!=='failed'||run.resolution||child)throw Error('只有尚未接续的失败执行可以结束接续。')
    return putRun({...run,revision:run.revision+1,resolution:{note:text(change.note,'结束接续说明'),at:change.now}})
  }
  if(run.taskId)return state
  if(run.state!=='completed')throw Error('请先完成本次执行，再交办结果。')
  const created=changeTaskPreview(state,{type:'create',id:change.id,title:'跟进：'+run.snapshot.fields.title.slice(0,110),goal:run.result,scope:run.snapshot.fields.scope,now:change.now})
  return {...created,tasks:created.tasks.map(task=>task.id===change.id?{...task,planSource:{planId:run.planId,runId:run.id,planVersion:run.snapshot.version,title:run.snapshot.fields.title}}:task),continuous:{...value,runs:value.runs.map(item=>item.id===run.id?{...run,revision:run.revision+1,taskId:change.id}:item)}}
}

export function withContinuousExamples(state:TaskPreview,now:string):TaskPreview{
  if(state.continuous.loaded)return state
  let next={...state,roles:withRoleExamples(state.roles,now)}
  const samples:{id:string;fields:PlanFields}[]=[
    {id:'plan-soc-daily',fields:{title:'每日告警核对',scope:'SOC',goal:'核对新告警的事实与来源，只将需要跟进的问题交办。',dataScope:'SOC 已授权告警与资产记录；当前使用演示输入。',delivery:'事实、来源与待核对项；不自动隔离资产。',roleId:'investigator',trigger:{kind:'schedule',cadence:'daily',weekday:1,time:'09:00',timezone:'Asia/Singapore'},notificationPolicy:'attention'}},
    {id:'plan-general-event',fields:{title:'公共资料更新检查',scope:'general',goal:'公共资料更新后，整理变化及对当前工作的影响。',dataScope:'本人指定的公共参考资料。',delivery:'变化摘要与可追溯来源。',roleId:'researcher',trigger:{kind:'event',source:'公共资料目录',event:'资料版本更新'},notificationPolicy:'attention'}},
  ]
  for(const sample of samples)if(!next.continuous.plans.some(plan=>plan.id===sample.id)&&canReceiveTask(next.roles.find(role=>role.id===sample.fields.roleId),sample.fields.scope))next=changeContinuousWork(next,{type:'save',...sample,now})
  return {...next,continuous:{...next.continuous,loaded:true}}
}

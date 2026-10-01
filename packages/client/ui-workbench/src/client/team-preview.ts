import { businessScopeNames } from './business-directory.ts'
import { changeTaskPreview, type TaskPreview } from './task-preview.ts'
import { canReceiveTask, type PreviewRole, type RoleFields, type TeamChange } from './role-preview.ts'
import { retireRolePlans } from './continuous-preview.ts'
import { roleSupportsScope,readRoleRuntimeConfig } from '@teloa/contract'

const text=(value:string,label:string,max=4000)=>{const result=value.trim();if(!result||result.length>max)throw Error(label+'不能为空且不能超过 '+max+' 字。');return result}
function fields(value:RoleFields,scopes:Readonly<Record<string,string>>):RoleFields{
  if(!['employee','twin'].includes(value.kind)||!value.scopes.length||value.scopes.some(scope=>!Object.hasOwn(scopes,scope)))throw Error('员工身份或业务范围无效。')
  const list=(items:string[])=>{if(items.length>30)throw Error('能力条目不能超过 30 项。');return [...new Set(items.map(item=>text(item,'能力名称',120)))]}
  const responsibility=value.responsibility===undefined?undefined:{
    triggers:list(value.responsibility.triggers),autonomousActions:list(value.responsibility.autonomousActions),confirmationPoints:list(value.responsibility.confirmationPoints),escalationRules:list(value.responsibility.escalationRules),deliveryChecks:list(value.responsibility.deliveryChecks),
  }
  const runtimeConfig=value.runtimeConfig===undefined?undefined:readRoleRuntimeConfig(value.runtimeConfig)
  return {name:text(value.name,'员工名称',80),kind:value.kind,scopes:[...new Set(value.scopes)],duty:text(value.duty,'职责'),dataScope:text(value.dataScope,'数据范围'),executionScope:text(value.executionScope,'执行范围'),skills:list(value.skills),knowledge:list(value.knowledge),...(responsibility===undefined?{}:{responsibility}),...(runtimeConfig===undefined?{}:{runtimeConfig})}
}

// 与任务共享一次状态更新，避免退役后任务仍可交办，或交接清掉独立审批。
export function changeTeamPreview(state:TaskPreview,change:TeamChange):TaskPreview{
  if(!Number.isFinite(Date.parse(change.now)))throw Error('时间无效。')
  if(change.type==='create'){
    const id=text(change.id,'员工编号')
    if(id==='self'||state.roles.some(role=>role.id===id))throw Error('员工身份已存在。')
    const role:PreviewRole={id,...fields(change.fields,businessScopeNames(state.business.spaces)),state:'active',version:1,memories:[],history:[{text:'创建演示同事，列出的能力尚未实际绑定。',actorId:'self',at:change.now}]}
    return {...state,roles:[...state.roles,role]}
  }
  const role=state.roles.find(item=>item.id===change.roleId)
  if(!role)throw Error('员工不存在。')
  if((change.type==='draft'||'expectedVersion' in change)&&change.type!=='memory-decide'&&change.expectedVersion!==role.version)throw Error('员工版本已变化，请重新核对。')
  if(role.state==='retired')throw Error('员工已退役；历史保留，重新启用须创建新身份。')
  let next=role,tasks=state.tasks,continuous=state.continuous
  let log=''
  if(change.type==='edit'){
    const value=fields({...change,kind:role.kind},businessScopeNames(state.business.spaces))
    if(tasks.some(task=>task.assigneeId===role.id&&!['completed','cancelled'].includes(task.state)&&!roleSupportsScope(value.scopes,task.scope)))throw Error('未完成任务仍依赖原业务范围，请先安排交接。')
    if(continuous.plans.some(plan=>plan.fields.roleId===role.id&&!plan.archived&&!roleSupportsScope(value.scopes,plan.fields.scope)))throw Error('未归档计划仍依赖原业务范围，请先安排交接。')
    next={...role,...value};log='更新职责与能力说明；未安装技能或修改原生连接。'
  }else if(change.type==='lifecycle'){
    const reason=text(change.reason,'原因')
    if(change.action==='pause'&&role.state!=='active'||change.action==='resume'&&role.state!=='paused')throw Error('当前员工状态不能执行此操作。')
    next={...role,state:change.action==='pause'?'paused':change.action==='resume'?'active':'retired',...(change.action==='retire'?{retirementReason:reason}:{})}
    log=({pause:'暂停新任务',resume:'恢复新任务',retire:'退役员工'})[change.action]+'：'+reason
    if(change.action==='retire')tasks=tasks.map(task=>task.assigneeId===role.id&&!['completed','cancelled'].includes(task.state)?{...task,handoff:{fromId:role.id,reason,at:change.now},state:'waiting',updatedAt:change.now,history:[...task.history,{text:'同事 '+role.name+' 退役，等待本人安排接续；原审批与资料缺口保留。',actorId:'self',at:change.now}]}:task)
    if(change.action==='retire')continuous=retireRolePlans(continuous,role.id,reason,change.now)
  }else if(change.type==='assign'){
    if(!canReceiveTask(role,change.scope))throw Error('仅在岗且支持当前业务的员工可以接收新工作；分身先代拟。')
    const created=changeTaskPreview(state,{type:'create',id:change.id,title:change.title,goal:change.goal,scope:change.scope,now:change.now})
    return {...created,tasks:created.tasks.map(task=>task.id===change.id?{...task,assigneeId:role.id,assigneeHistory:[...task.assigneeHistory,role.id],history:[...task.history,{text:'交办给 '+role.name+'（演示）',actorId:'self',at:change.now}]}:task)}
  }else if(change.type==='memory-add'){
    if(role.memories.some(item=>item.id===change.id))throw Error('记忆编号冲突。')
    next={...role,memories:[...role.memories,{id:text(change.id,'记忆编号'),title:text(change.title,'记忆名称',120),text:text(change.text,'内容'),source:text(change.source,'来源'),scope:role.kind==='twin'?'private':'role',status:'candidate',version:1,createdAt:change.now,updatedAt:change.now}]};log='添加有来源的候选记忆，等待本人确认。'
  }else if(change.type==='memory-decide'){
    const memory=role.memories.find(item=>item.id===change.memoryId)
    if(!memory||memory.version!==change.expectedVersion)throw Error('记忆不存在或版本已变化。')
    if(change.action==='confirm'&&memory.status!=='candidate'||change.action==='withdraw'&&memory.status==='withdrawn')throw Error('当前记忆状态不能执行此操作。')
    next={...role,memories:role.memories.map(item=>item.id===memory.id?{...item,status:change.action==='confirm'?'confirmed':'withdrawn',version:item.version+1,updatedAt:change.now}:item)}
    log=(change.action==='confirm'?'确认':'撤回')+'记忆「'+memory.title+'」，保留来源和原可见范围。'
  }else if(change.type==='draft'){
    if(role.kind!=='twin')throw Error('此入口仅用于分身代拟稿。')
    next={...role,draft:{body:text(change.body,'代拟稿',8000),version:(role.draft?.version||0)+1,editorId:'self',updatedAt:change.now}};log='本人保存代拟草稿；未发送、未代批。'
  }
  next={...next,version:role.version+1,history:[...role.history,{text:log,actorId:'self',at:change.now}]}
  return {...state,tasks,continuous,roles:state.roles.map(item=>item.id===role.id?next:item)}
}

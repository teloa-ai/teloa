import type { PreviewRole } from './role-preview.js'

export type RoleConfigurationRelation={label:string;detail:string;note:string}
type RelationMessageKey=
 |'roleRelation.label.scope'|'roleRelation.label.knowledge'|'roleRelation.label.capabilities'|'roleRelation.label.work'|'roleRelation.label.authorization'
 |'roleRelation.scope'|'roleRelation.scopePending'|'roleRelation.duty'|'roleRelation.dutyPending'|'roleRelation.structured'|'roleRelation.structuredPending'|'roleRelation.groups'|'roleRelation.groupsNone'|'roleRelation.note.scope'
 |'roleRelation.knowledge'|'roleRelation.knowledgeNone'|'roleRelation.dataScope'|'roleRelation.pending'|'roleRelation.note.knowledge'
 |'roleRelation.skills'|'roleRelation.skillsNone'|'roleRelation.bindingsPending'|'roleRelation.bindings'|'roleRelation.bindingsNone'|'roleRelation.runtime'|'roleRelation.note.capabilities'
 |'roleRelation.tasks'|'roleRelation.automations'|'roleRelation.loaded'|'roleRelation.notLoaded'|'roleRelation.note.work'
 |'roleRelation.state.active'|'roleRelation.state.paused'|'roleRelation.state.retired'|'roleRelation.approvals'|'roleRelation.approvalsNone'|'roleRelation.note.authorization'

type RelatedTask={id:string;storage?:'persistent';assigneeId:string;authorId?:string;assigneeHistory?:readonly string[]}
type RelatedPlan={fields:{roleId:string};enabled:boolean;archived:boolean}
type RelatedApproval={taskId:string;status:string}
type RelatedGroup={memberIds:readonly string[]}
type RelatedBinding={target:{kind:string;id:string};activeVersion:number|null;disabled:boolean;removed:boolean}

type Input={
 role:PreviewRole
 scopeLabel:string
 state:{tasks:readonly RelatedTask[];continuous:{plans:readonly RelatedPlan[];loaded:boolean};approvals:readonly RelatedApproval[]}
 collaboration:{groups:readonly RelatedGroup[]}
 capabilities?:{bindings:readonly RelatedBinding[]}|undefined
 runtimeLabel:string
 t:(key:RelationMessageKey,params?:Readonly<Record<string,string|number>>)=>string
}

/** 只汇总页面已持有的关系；配置声明从不等同于运行时已可用。 */
export function roleConfigurationRelations({role,scopeLabel,state,collaboration,capabilities,runtimeLabel,t}:Input):RoleConfigurationRelation[]{
 const relatedTasks=state.tasks.filter(task=>task.assigneeId===role.id||task.authorId===role.id||task.assigneeHistory?.includes(role.id))
 const savedTasks=relatedTasks.filter(task=>task.storage==='persistent').length
 const relatedPlans=state.continuous.plans.filter(plan=>plan.fields.roleId===role.id&&!plan.archived)
 const relatedApprovals=state.approvals.filter(approval=>relatedTasks.some(task=>task.id===approval.taskId))
 const pendingApprovals=relatedApprovals.filter(approval=>approval.status==='pending').length
 const groups=collaboration.groups.filter(group=>group.memberIds.includes(role.id))
 const bindings=capabilities?.bindings.filter(binding=>binding.target.kind==='role'&&binding.target.id===role.id&&!binding.removed)
 const activeBindings=bindings?.filter(binding=>binding.activeVersion!==null&&!binding.disabled).length??0
 const structured=role.responsibility?5:0
 return [
  {label:t('roleRelation.label.scope'),detail:[t('roleRelation.scope',{scope:scopeLabel||t('roleRelation.scopePending')}),t('roleRelation.duty',{duty:role.duty||t('roleRelation.dutyPending')}),structured?t('roleRelation.structured',{count:structured}):t('roleRelation.structuredPending'),groups.length?t('roleRelation.groups',{count:groups.length}):t('roleRelation.groupsNone')].join(' · '),note:t('roleRelation.note.scope')},
  {label:t('roleRelation.label.knowledge'),detail:[role.knowledge.length?t('roleRelation.knowledge',{count:role.knowledge.length}):t('roleRelation.knowledgeNone'),t('roleRelation.dataScope',{scope:role.dataScope||t('roleRelation.pending')})].join(' · '),note:t('roleRelation.note.knowledge')},
  {label:t('roleRelation.label.capabilities'),detail:[role.skills.length?t('roleRelation.skills',{count:role.skills.length}):t('roleRelation.skillsNone'),bindings===undefined?t('roleRelation.bindingsPending'):bindings.length?t('roleRelation.bindings',{count:bindings.length,active:activeBindings}):t('roleRelation.bindingsNone'),t('roleRelation.runtime',{runtime:runtimeLabel})].join(' · '),note:t('roleRelation.note.capabilities')},
  {label:t('roleRelation.label.work'),detail:[t('roleRelation.tasks',{count:relatedTasks.length,saved:savedTasks}),t('roleRelation.automations',{count:relatedPlans.length}),t(state.continuous.loaded?'roleRelation.loaded':'roleRelation.notLoaded')].join(' · '),note:t('roleRelation.note.work')},
  {label:t('roleRelation.label.authorization'),detail:[t(role.state==='active'?'roleRelation.state.active':role.state==='paused'?'roleRelation.state.paused':'roleRelation.state.retired'),relatedApprovals.length?t('roleRelation.approvals',{count:relatedApprovals.length,pending:pendingApprovals}):t('roleRelation.approvalsNone')].join(' · '),note:t('roleRelation.note.authorization')},
 ]
}

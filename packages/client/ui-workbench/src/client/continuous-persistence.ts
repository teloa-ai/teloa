import { readScheduleTrigger } from '@teloa/contract'
import type { PlanCreateFields, PlanSource, PlanUpdateFields, SavedPlan } from './plan-api.ts'
import { isPlanNotificationPolicy, type PlanFields } from './continuous-preview.ts'
import type { PlanTemplate } from './plan-template.ts'
import { canReceiveTask, type PreviewRole } from './role-preview.ts'
import type {PlanApi,PlanAction} from './plan-api.ts'
import type {WorkControlApi} from './work-control-api.ts'

/** 定义暂停/结束先通知真实执行收尾；恢复必须由候选核验协调器批准，再启用计划。 */
export async function persistentPlanAction(api:PlanApi,controls:WorkControlApi|undefined,plan:SavedPlan,action:PlanAction,note?:string):Promise<SavedPlan>{
 if(!plan.workDefinition)return action==='enable'&&plan.completionPolicy?.kind==='verified'?api.changeConfirmed(plan.id,plan.version,action,note):api.change(plan.id,plan.version,action,note)
 if(!controls)throw Error('长期工作控制服务尚未接入。')
 let control=await controls.get(plan.workDefinition.definitionControlId)
 if(control.ownerId!==plan.ownerId||control.scope!=='definition')throw Error('长期定义控制不属于当前计划。')
 if(action==='enable'){
  if(control.state==='paused'){const candidates=await controls.inspect(control.id);control=await controls.resume(control,candidates.map(v=>v.runId))}
  if(control.state!=='active')throw Error('当前长期工作仍在收尾或已结束，不能启动。')
  return api.changeConfirmed(plan.id,plan.version,action,note)
 }
 if(action==='pause'&&control.state==='active')await controls.change(control,'pause')
 if(action==='archive'&&control.state!=='stopped'&&control.state!=='stopping')await controls.change(control,'stop')
 return api.change(plan.id,plan.version,action,note)
}

const uuid=(value:string)=>/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
const hash=(value:string|null):value is string=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value)

export function persistentPlanCreation(fields:PlanFields,template:PlanTemplate|undefined,roles:readonly PreviewRole[],templateSource?:PlanSource):{fields:PlanCreateFields;source:PlanSource}{
 if(fields.trigger.kind==='event')throw Error('业务事件触发尚未接入真实计划服务，计划未保存。')
 if(!isPlanNotificationPolicy(fields.notificationPolicy))throw Error('请本人核对并选择通知策略，计划未保存。')
 const role=roles.find(candidate=>candidate.id===fields.roleId)
 if(role?.storage!=='persistent'||!canReceiveTask(role,fields.scope))throw Error('请选择同业务在岗且已保存的员工。')
 let source:PlanSource={kind:'manual'}
 if(template){
  if(template.example||!hash(template.hash)||templateSource?.kind!=='market-content'||!uuid(templateSource.contentId))throw Error('市场模板没有真实固定内容来源，不能保存为真实计划。请返回市场重新核对。')
  const resourceId=template.industry?.localId??template.templateId
  if(templateSource.contentHash!==template.hash||templateSource.resourceId!==resourceId||templateSource.resourceVersion!==(template.industry?.version??template.version))throw Error('市场模板真实来源与当前模板不一致，请返回市场重新核对。')
  source={...templateSource}
 }else if(templateSource){
  throw Error('计划来源缺少对应市场模板。')
 }
 return {fields:{...fields,notificationPolicy:fields.notificationPolicy,trigger:readScheduleTrigger(fields.trigger),expectedRoleVersion:role.version},source}
}


/** 已保存计划的更新不会改变岗位、业务范围或市场来源；这些身份由创建时固定。 */
export function persistentPlanUpdate(fields:PlanFields,plan:SavedPlan):PlanUpdateFields{
 if(fields.scope!==plan.scope||fields.roleId!==plan.roleId)throw Error('已保存计划不能在编辑时更换业务范围或负责员工。')
 if(fields.trigger.kind==='event')throw Error('业务事件触发尚未接入真实计划服务，计划未保存。')
 if(!isPlanNotificationPolicy(fields.notificationPolicy))throw Error('请本人核对并选择通知策略，计划未保存。')
 return {title:fields.title.trim(),goal:fields.goal.trim(),dataScope:fields.dataScope.trim(),delivery:fields.delivery.trim(),trigger:readScheduleTrigger(fields.trigger),notificationPolicy:fields.notificationPolicy,...(fields.completionPolicy?{completionPolicy:fields.completionPolicy}:{})}
}

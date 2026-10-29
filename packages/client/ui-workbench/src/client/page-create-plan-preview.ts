import {readPageCreatePlanDraft,type PageCreateDraftPreview,type PlanWorkTrigger} from '@teloa/contract'
import {triggerLabel} from './continuous-preview.ts'
import type {TeloaTranslate} from './i18n/index.js'

const eventKeys={
 'material-version':'create.plan.preview.event.material',
 'group-message':'create.plan.preview.event.group',
 'child-completed':'create.plan.preview.event.child',
 'approval-result':'create.plan.preview.event.approval',
 'business-object-version':'create.plan.preview.event.record',
 'business-sync-result':'create.plan.preview.event.sync',
} as const
const knownConsequences=new Set(['plan-save-paused','plan-create-and-enable','plan-execution-authorization'])
export const isPlanPreviewConsequence=(id:string):boolean=>knownConsequences.has(id)

function triggerText(trigger:PlanWorkTrigger,t:TeloaTranslate):string{
 if(trigger.kind==='schedule')return triggerLabel(trigger.schedule,t)
 return t(eventKeys[trigger.eventKind])+' · '+t(trigger.coalesce==='latest'?'create.plan.preview.latest':'create.plan.preview.each')
}

/** 只投影正式正文；字段路径、来源摘要与运行身份继续留在原契约，不成为用户表单。 */
export function createPlanPreview(preview:PageCreateDraftPreview,t:TeloaTranslate){
 if(preview.draft.entity!=='plan')throw Error('需要正式计划草案。')
 const body=readPageCreatePlanDraft(JSON.parse(preview.draft.body)),configuration='kind' in body
 const fields='kind'in body?body.fields:body.definition,work=body.work,budget=work.budget
 const owner='kind'in body?false:'executor'in body.definition
 const duration=budget.maxElapsedMs===null?t('planWork.budget.unlimited'):t(budget.maxElapsedMs%60000===0?'create.plan.preview.minutes':'create.plan.preview.seconds',{value:budget.maxElapsedMs%60000===0?budget.maxElapsedMs/60000:budget.maxElapsedMs/1000})
 const money=budget.money===null?t('create.plan.preview.moneyNone'):t('create.plan.preview.money',{currency:budget.money.currency,units:budget.money.maxMinorUnits})
 const completion=t(work.completion.kind==='manual'?'create.plan.preview.manual':work.completion.verifier==='system-digest'?'create.plan.preview.digest':'create.plan.preview.materialCheck')
 const notification='kind'in body?undefined:body.definition.notificationPolicy
 const group=fields&&Object.hasOwn(fields,'groupId')?fields.groupId? t('create.plan.preview.group'):t('create.plan.preview.noGroup'):configuration?t('create.plan.preview.inheritDestination'):t('create.plan.preview.noGroup')
 const scope='kind'in body?t('create.plan.preview.inheritScope'):body.definition.scope==='general'?t('create.plan.preview.general'):body.definition.scope
 const references:Array<{path:string;value:string}>=[]
 if('kind'in body){
  references.push({path:t('create.plan.preview.planReference'),value:body.planId},{path:t('create.plan.preview.versionReference'),value:t('create.plan.preview.planVersions',{version:body.expectedVersion,configVersion:body.expectedConfigVersion})})
 }else{
  references.push({path:t('continuous.form.scope'),value:scope})
  if('expectedRoleVersion'in body.definition)references.push({path:t('create.plan.preview.roleReference'),value:body.definition.roleId+' · '+t('create.plan.preview.roleVersion',{version:body.definition.expectedRoleVersion})})
  references.push({path:t('create.plan.preview.methodReference'),value:body.source.artifactId+' · '+t('create.plan.preview.methodVersion',{version:body.source.version})},{path:t('create.plan.preview.basisReference'),value:body.source.basisHash})
  if(body.source.taskId)references.push({path:t('create.plan.preview.taskReference'),value:body.source.taskId})
 }
 if(fields?.groupId)references.push({path:t('create.plan.preview.groupReference'),value:fields.groupId})
 work.triggers.forEach((trigger,index)=>{
  if(trigger.kind==='local-event')references.push({path:t('create.plan.preview.eventReference',{index:index+1}),value:triggerText(trigger,t)+'\n'+('sourceId'in trigger?trigger.sourceId:JSON.stringify(trigger.sourceRef,null,2))})
 })

 return {
  references,
  fields:[
   {path:t('continuous.detail.goal'),value:fields?.goal??t('create.plan.preview.inheritGoal')},
   {path:t('create.plan.preview.executor'),value:t(configuration?'create.plan.preview.inheritExecutor':owner?'create.plan.preview.owner':'create.plan.preview.role')+' · '+scope},
   {path:t('continuous.detail.dataScope'),value:fields?.dataScope??t('create.plan.preview.inheritData')},
   {path:t('continuous.detail.delivery'),value:(fields?.delivery??t('create.plan.preview.inheritDelivery'))+'\n'+group},
   {path:t('continuous.detail.trigger'),value:work.triggers.map(trigger=>triggerText(trigger,t)).join('\n')},
   {path:t('create.plan.preview.budget'),value:t('create.plan.preview.limits',{tokens:budget.maxTokens??t('planWork.budget.unlimited'),rounds:budget.maxGoalRounds??t('planWork.budget.unlimited'),duration,concurrent:budget.maxConcurrent??t('planWork.budget.unlimited'),retries:budget.maxRetries,stagnation:budget.stagnationRounds})+'\n'+money},
   {path:t('create.plan.preview.handling'),value:[completion,t(work.overlap==='forbid'?'create.plan.preview.noOverlap':'create.plan.preview.independent'),t('create.plan.preview.missed'),t(work.safeRecovery?'create.plan.preview.safeRecovery':'create.plan.preview.manualRecovery')].join('；')},
   {path:t('continuous.form.notificationPolicy'),value:notification?t(`continuous.form.notification.${notification}`):t('create.plan.preview.inheritNotification')},
  ],
  consequences:[
   t(body.intent==='create-and-enable'?'create.plan.preview.enable':configuration?'create.plan.preview.configure':'create.plan.preview.save'),
   t(configuration?'create.plan.preview.configureAuthority':owner?'create.plan.preview.ownerAuthority':'create.plan.preview.roleAuthority'),
   t('create.plan.preview.cumulative'),
  ],
 }
}

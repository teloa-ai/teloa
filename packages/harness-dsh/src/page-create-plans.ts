import {createHash} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import {WorkError,taskInput,readPageCreatePlanDraft,type PageCreateDraft} from '@teloa/contract'
import type {MethodReuseDraftAuthority,PlanService,PersistentPlan} from '@teloa/backend'

/** 只在认证的本人浏览器 RPC 中装配；不加入模型工具或通用端点目录。 */
export const confirmedPlanDraftEndpoints=['page-create-plans/confirm'] as const
type Operations=Pick<PlanService,'get'|'createOwnerConfirmed'|'createConfirmed'|'configureWorkConfirmed'|'changeConfirmed'>
type Ports={
 draft:(draftId:string,signal?:AbortSignal)=>Promise<PageCreateDraft>
 method:(draft:PageCreateDraft,signal?:AbortSignal)=>Promise<MethodReuseDraftAuthority|null>
 plans:()=>Promise<Operations>
 /** 回读原 Plan 表/原变更回执，不以任意 appliedRef 冒充本草案的执行结果。 */
 operationPlanId:(requestId:string,phase:'create'|'configure'|'enable',signal?:AbortSignal)=>Promise<string|null>
}
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v)
export function planDraftRequestId(draft:Pick<PageCreateDraft,'id'|'bodyHash'>,phase:string):string{
 const h=createHash('sha256').update(JSON.stringify(['teloa-plan-draft/v1',draft.id,draft.bodyHash,phase])).digest('hex')
 return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`
}
export function createConfirmedPlanDraftHandler(owner:string,ports:Ports){
 return async(endpoint:string,payload:unknown,signal?:AbortSignal)=>{
  if(!(confirmedPlanDraftEndpoints as readonly string[]).includes(endpoint))throw new WorkError('teloa/not-found','未提供此计划草案确认入口。')
  const input=taskInput(payload,['draftId','expectedBodyHash'])
  if(!uuid(input.draftId)||typeof input.expectedBodyHash!=='string'||!/^[a-f0-9]{64}$/.test(input.expectedBodyHash))throw new WorkError('teloa/invalid-input','计划草案确认格式不正确。')
  signal?.throwIfAborted()
  const draft=await ports.draft(input.draftId,signal)
  if(draft.ownerId!==owner||draft.id!==input.draftId||draft.entity!=='plan'||draft.status==='discarded'||draft.bodyHash!==input.expectedBodyHash)throw new WorkError('teloa/version-conflict','计划草案已变化，请重新预览。')
  const body=readPageCreatePlanDraft(JSON.parse(draft.body)),method=await ports.method(draft,signal),plans=await ports.plans()
  signal?.throwIfAborted()
  let plan:PersistentPlan
  if(draft.status==='applied'){
   if(!draft.appliedRef||!uuid(draft.appliedRef))throw new WorkError('teloa/storage-corrupt','计划草案缺少原采用回执。')
   const phases:Array<'create'|'configure'|'enable'>='kind'in body?['configure']:['create',...('executor'in body.definition?[]:['configure'] as const)]
   if(body.intent==='create-and-enable'&&('kind'in body||!('executor'in body.definition)))phases.push('enable')
   for(const phase of phases){
    if(await ports.operationPlanId(planDraftRequestId(draft,phase),phase,signal)!==draft.appliedRef)throw new WorkError('teloa/storage-corrupt','草案采用记录与原计划请求不一致，请核对原计划。')
   }
   plan=await plans.get(owner,{planId:draft.appliedRef})
  }else if('kind'in body){
   plan=await plans.configureWorkConfirmed(owner,{planId:body.planId,requestId:planDraftRequestId(draft,'configure'),expectedVersion:body.expectedVersion,expectedConfigVersion:body.expectedConfigVersion,configuration:body.work,...(body.fields?{fields:body.fields}:{})})
   if(body.intent==='create-and-enable')plan=await plans.changeConfirmed(owner,{planId:plan.id,requestId:planDraftRequestId(draft,'enable'),expectedVersion:body.expectedVersion+1,action:'enable'})
  }else{
   if(!method||method.target!=='plan'||!isDeepStrictEqual(method.source,body.source)||method.intent!==body.intent)throw new WorkError('teloa/forbidden','请从本人已认可的固定成果准备此计划，并确认执行范围。')
   const source={kind:'method-reuse' as const,...method.source,...(method.acceptedSource?{acceptedSource:method.acceptedSource}:{})}
   if('executor'in body.definition){
    plan=await plans.createOwnerConfirmed(owner,{requestId:planDraftRequestId(draft,'create'),fields:body.definition,source,configuration:body.work,intent:body.intent})
   }else{
    plan=await plans.createConfirmed(owner,{requestId:planDraftRequestId(draft,'create'),fields:body.definition,source})
    // 新计划的原初始版本固定为1。恢复不借后来当前版本重新拼另一份配置请求。
    plan=await plans.configureWorkConfirmed(owner,{planId:plan.id,requestId:planDraftRequestId(draft,'configure'),expectedVersion:1,expectedConfigVersion:1,configuration:body.work})
    if(body.intent==='create-and-enable')plan=await plans.changeConfirmed(owner,{planId:plan.id,requestId:planDraftRequestId(draft,'enable'),expectedVersion:2,action:'enable'})
   }
  }
  signal?.throwIfAborted()
  if(plan.ownerId!==owner||!uuid(plan.id)||'kind'in body&&plan.id!==body.planId||!Number.isSafeInteger(plan.version)||plan.version<1||!Number.isSafeInteger(plan.configVersion)||plan.configVersion<1)throw new WorkError('teloa/invalid-host-response','计划保存回执与原草案不一致。')
  const current=await ports.draft(draft.id,signal)
  if(current.ownerId!==owner||current.bodyHash!==draft.bodyHash||current.body!==draft.body||current.status==='discarded')throw new WorkError('teloa/version-conflict','计划原操作已返回回执，但草案已变化；请核对原计划。')
  return {schema:'teloa.plan-draft-confirmation/v1' as const,draftId:draft.id,bodyHash:draft.bodyHash,planId:plan.id,state:plan.state,version:plan.version,configVersion:plan.configVersion}
 }
}

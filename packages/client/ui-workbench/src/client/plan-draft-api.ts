import type {PageCreateDraft,PageCreateDraftPreview} from '@teloa/contract'
import {readPageCreatePlanDraft} from '@teloa/contract'
import type {MessageKey} from './i18n/messages.js'

type Call=(endpoint:string,payload:unknown,signal?:AbortSignal)=>Promise<unknown>
export type PlanDraftConfirmation={schema:'teloa.plan-draft-confirmation/v1';draftId:string;bodyHash:string;planId:string;state:'paused'|'active'|'archived';version:number;configVersion:number}
type ConfirmationInput={draftId:string;expectedBodyHash:string}
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
const hash=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value)
const invalid=()=>Object.assign(Error('计划草案确认回包不完整。'),{code:'teloa/invalid-host-response'})

/** 标签取正式预览正文的真实采用意图，不从标题、助手说明或宿主默认推断启用。 */
export function planDraftConfirmLabel(preview:PageCreateDraftPreview):MessageKey{
 if(preview.draft.entity!=='plan')throw invalid()
 const body=readPageCreatePlanDraft(JSON.parse(preview.draft.body))
 return body.intent==='create-and-enable'?'create.plan.saveEnable':'kind' in body?'create.plan.saveConfiguration':'create.plan.save'
}

export function createPlanDraftApi(call:Call){
 const listeners=new Set<(draft:PageCreateDraft)=>void>()
 return {
  async confirm(input:ConfirmationInput,signal?:AbortSignal):Promise<PlanDraftConfirmation>{
   if(!uuid(input.draftId)||!hash(input.expectedBodyHash)||Object.keys(input).some(key=>key!=='draftId'&&key!=='expectedBodyHash'))throw Object.assign(Error('需要原计划草案和固定摘要。'),{code:'teloa/invalid-input'})
   const value=await call('page-create-plans/confirm',{draftId:input.draftId,expectedBodyHash:input.expectedBodyHash},signal)
   if(!value||typeof value!=='object'||Array.isArray(value))throw invalid()
   const row=value as Record<string,unknown>,keys=['schema','draftId','bodyHash','planId','state','version','configVersion']
   if(Object.keys(row).length!==keys.length||keys.some(key=>!Object.hasOwn(row,key))||row.schema!=='teloa.plan-draft-confirmation/v1'||row.draftId!==input.draftId||row.bodyHash!==input.expectedBodyHash||!uuid(row.planId)||typeof row.state!=='string'||!['paused','active','archived'].includes(row.state)||!Number.isSafeInteger(row.version)||Number(row.version)<1||!Number.isSafeInteger(row.configVersion)||Number(row.configVersion)<1)throw invalid()
   return {schema:'teloa.plan-draft-confirmation/v1',draftId:input.draftId,bodyHash:input.expectedBodyHash,planId:row.planId,state:row.state as PlanDraftConfirmation['state'],version:Number(row.version),configVersion:Number(row.configVersion)}
  },
  /** 会话卡只请求打开原对象；Frame 回读本人来源后才显示确认。无持久队列，也不提交。 */
  openDraft(draft:PageCreateDraft):void{for(const listener of listeners)listener(draft)},
  onOpen(listener:(draft:PageCreateDraft)=>void):()=>void{listeners.add(listener);return()=>{listeners.delete(listener)}},
 }
}
export type PlanDraftApi=ReturnType<typeof createPlanDraftApi>

import {WorkError,taskInput,type PageCreateEntity} from '@teloa/contract'
import type {PageCreateDraftService,PageCreatePreviewService} from '@teloa/backend'

export const pageCreateDraftEndpoints=['page-create-drafts/directory','page-create-drafts/preview','page-create-drafts/settle'] as const

type Services={drafts:Pick<PageCreateDraftService,'directory'|'settle'>;preview:Pick<PageCreatePreviewService,'preview'>}
const entities=['business-definition','business-domain','role','skill','connector','extension'] as const
const entity=(value:unknown):value is PageCreateEntity=>(entities as readonly string[]).includes(value as string)
const text=(value:unknown,max:number):value is string=>typeof value==='string'&&!!value.trim()&&value===value.trim()&&value.length<=max&&!/[\x00-\x1f\x7f]/.test(value)
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
const hash=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)
const bad=(message:string)=>new WorkError('teloa/invalid-input',message)

/**
 * 页内新建的浏览器 RPC 只暴露目录、预览和落定：没有草案写入口。
 * 草案只能由受会话授权约束的模型工具写入，实体仍要由各页面既有写路径落地。
 */
export function createPageCreateDraftHandler(owner:string,scopeIds:()=>Promise<readonly string[]>,get:()=>Promise<Services>){
 return async(endpoint:string,payload:unknown,signal?:AbortSignal):Promise<unknown>=>{
  if(!(pageCreateDraftEndpoints as readonly string[]).includes(endpoint))throw new WorkError('teloa/not-found','未提供此页内新建接口。')
  const scopes=[...(await scopeIds()).filter(scope=>scope!=='general')]
  const actor={ownerId:owner,scopeIds:scopes}
  if(endpoint==='page-create-drafts/directory'){
   const row=taskInput(payload,['entity','scope'])
   if(!entity(row.entity)||row.scope!==undefined&&!text(row.scope,120))throw bad('新建草案目录请求格式不正确。')
   return (await get()).drafts.directory(actor,{entity:row.entity,...(row.scope===undefined?{}:{scope:row.scope})},signal)
  }
  if(endpoint==='page-create-drafts/preview'){
   const row=taskInput(payload,['draftId'])
   if(!uuid(row.draftId))throw bad('新建草案预览请求格式不正确。')
   return (await get()).preview.preview(actor,{draftId:row.draftId.toLowerCase()},signal)
  }
  const row=taskInput(payload,['requestId','draftId','expectedBodyHash','outcome','appliedRef'])
  if(!uuid(row.requestId)||!uuid(row.draftId)||!hash(row.expectedBodyHash)||(row.outcome!=='applied'&&row.outcome!=='discarded')||row.appliedRef!==undefined&&!text(row.appliedRef,200))throw bad('新建草案落定请求格式不正确。')
  return (await get()).drafts.settle(actor,{requestId:row.requestId.toLowerCase(),draftId:row.draftId.toLowerCase(),expectedBodyHash:row.expectedBodyHash,outcome:row.outcome,...(row.appliedRef===undefined?{}:{appliedRef:row.appliedRef})},signal)
 }
}

import {businessObjectReference,type BusinessObjectReference,WorkError,readBusinessConfigurationPage,type BusinessConfigurationCurrentResponseVersioned as BusinessConfigurationCurrentResponse,type BusinessConfigurationPageProjectionVersioned as BusinessConfigurationPageProjection,type BusinessTimeRange} from '@teloa/contract'
import type {BusinessBuilderApi} from './business-builder-api.js'
/** 只保存当前本人/宿主中每个业务的真实页面ID，不保存配置正文或结果。 */
export type BusinessConfigurationSelection={get:(scope:string)=>string|undefined;set:(scope:string,pageId:string)=>void}
export type BusinessConfigurationSurfaceState={status:'loading'|'legacy'|'ready'|'failed';current:BusinessConfigurationCurrentResponse|null;selectedId:string|null;pageStatus:'idle'|'loading'|'ready'|'failed';page:BusinessConfigurationPageProjection|null;error:unknown|null}
const initial=():BusinessConfigurationSurfaceState=>({status:'loading',current:null,selectedId:null,pageStatus:'idle',page:null,error:null})
const invalid=()=>new WorkError('teloa/invalid-host-response','正式业务页面与当前配置不一致。')
const referenceUnavailable=()=>new WorkError('teloa/source-unavailable','关联记录没有正式记录页。',{kind:'record-page-unavailable'})
export const businessReferencePageUnavailable=(error:unknown)=>error instanceof WorkError&&error.details?.kind==='record-page-unavailable'
/** 正式配置只读容器；每个scope及认证API/记录flow生命周期使用独立实例。 */
export class BusinessConfigurationSurfaceController{
 private state=initial()
 private readonly listeners=new Set<()=>void>()
 private pending:AbortController|undefined
 private preferredId:string|undefined
 private readonly api:Pick<BusinessBuilderApi,'current'|'page'>
 readonly scope:string
 private readonly reference:BusinessObjectReference|undefined
 private readonly selection:BusinessConfigurationSelection|undefined
 constructor(api:Pick<BusinessBuilderApi,'current'|'page'>,scope:string,selection?:BusinessConfigurationSelection,reference?:BusinessObjectReference){this.api=api;this.scope=scope;this.selection=selection;this.reference=reference}
 getSnapshot=()=>this.state
 subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener)}}
 private publish(patch:Partial<BusinessConfigurationSurfaceState>){this.state={...this.state,...patch};for(const listener of this.listeners)listener()}
 dispose(){this.pending?.abort()}
 private begin(){this.pending?.abort();const request=new AbortController();this.pending=request;return request.signal}
 async load():Promise<void>{
  const signal=this.begin();this.publish(initial())
  try{
   const reference=this.reference===undefined?undefined:businessObjectReference(this.reference)
   if(reference&&reference.scope!==this.scope)throw invalid()
   const current=await this.api.current({scope:this.scope},signal)
   if(signal.aborted)return
   if(current===null){if(reference)throw referenceUnavailable();this.publish({status:'legacy'});return}
   if(current.scope!==this.scope)throw invalid()
   let remembered=this.preferredId
   try{remembered=this.selection?.get(this.scope)??remembered}catch{/* 选择偏好不可用时仍按正式首页打开。 */}
   const candidates=reference?current.manifest.pages.filter(page=>page.kind==='records'&&page.objectType===reference.type):current.manifest.pages
   const selectedId=candidates.find(page=>page.id===remembered)?.id??(reference?candidates[0]?.id:current.manifest.homePageId)
   if(!selectedId)throw reference?referenceUnavailable():invalid()
   this.preferredId=selectedId
   this.publish({status:'ready',current,selectedId,pageStatus:'loading'})
   await this.readPage(current,selectedId,signal)
  }catch(error){if(!signal.aborted)this.publish({...initial(),status:'failed',error})}
 }
 async select(pageId:string,timeRange?:BusinessTimeRange):Promise<void>{
  const current=this.state.current
  if(this.state.status!=='ready'||!current||!current.manifest.pages.some(page=>page.id===pageId))throw new WorkError('teloa/invalid-input','此页面不属于当前业务配置。')
  this.preferredId=pageId
  const signal=this.begin();this.publish({selectedId:pageId,page:null,pageStatus:'loading',error:null})
  await this.readPage(current,pageId,signal,timeRange)
 }
 private async readPage(current:BusinessConfigurationCurrentResponse,pageId:string,signal:AbortSignal,timeRange?:BusinessTimeRange):Promise<void>{
  try{
   const page=await this.api.page({scope:this.scope,pageId,...(timeRange===undefined?{}:{timeRange})},signal)
   if(signal.aborted)return
   const definition=current.manifest.pages.find(page=>page.id===pageId)
   if(page.mode!=='saved'||page.scope!==this.scope||page.configurationVersion!==current.version||page.configurationHash!==current.hash||JSON.stringify(readBusinessConfigurationPage(page.page.definition))!==JSON.stringify(definition))throw invalid()
   try{this.selection?.set(this.scope,pageId)}catch{/* 页面偏好保存失败不影响已核验的正式页面。 */}
   this.publish({page,pageStatus:'ready',error:null})
  }catch(error){if(!signal.aborted)this.publish({page:null,pageStatus:'failed',error})}
 }
}

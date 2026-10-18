import {businessObjectReference,type BusinessObjectReference,WorkError,readBusinessConfigurationPage,type BusinessConfigurationCurrentResponseVersioned as BusinessConfigurationCurrentResponse,type BusinessConfigurationPageProjectionVersioned as BusinessConfigurationPageProjection,type BusinessTimeRange} from '@teloa/contract'
import type {BusinessBuilderApi} from './business-builder-api.js'
export type BusinessConfigurationPageKind=BusinessConfigurationCurrentResponse['manifest']['pages'][number]['kind']
/** 只保存当前本人/宿主中每个业务的真实页面ID，不保存配置正文或结果；按页面种类分开记忆，切换页签不互相覆盖。 */
export type BusinessConfigurationSelection={get:(scope:string,kind?:BusinessConfigurationPageKind)=>string|undefined;set:(scope:string,pageId:string,kind?:BusinessConfigurationPageKind)=>void}
export type BusinessConfigurationSurfaceState={status:'loading'|'legacy'|'ready'|'failed';current:BusinessConfigurationCurrentResponse|null;selectedId:string|null;pageStatus:'idle'|'loading'|'ready'|'failed';page:BusinessConfigurationPageProjection|null;error:unknown|null}
const initial=():BusinessConfigurationSurfaceState=>({status:'loading',current:null,selectedId:null,pageStatus:'idle',page:null,error:null})
const invalid=()=>new WorkError('teloa/invalid-host-response','正式业务页面与当前配置不一致。')
const referenceUnavailable=()=>new WorkError('teloa/source-unavailable','关联记录没有正式记录页。',{kind:'record-page-unavailable'})
export const businessReferencePageUnavailable=(error:unknown)=>error instanceof WorkError&&error.details?.kind==='record-page-unavailable'
/** 读取正式配置的一页并核对它属于这份 current（版本、摘要与页面声明一致）；完整页与业务总览摘要共用。 */
export async function readBusinessConfigurationSavedPage(api:Pick<BusinessBuilderApi,'page'>,scope:string,current:BusinessConfigurationCurrentResponse,pageId:string,signal:AbortSignal,timeRange?:BusinessTimeRange):Promise<BusinessConfigurationPageProjection>{
 const page=await api.page({scope,pageId,...(timeRange===undefined?{}:{timeRange})},signal)
 const definition=current.manifest.pages.find(page=>page.id===pageId)
 if(page.mode!=='saved'||page.scope!==scope||page.configurationVersion!==current.version||page.configurationHash!==current.hash||JSON.stringify(readBusinessConfigurationPage(page.page.definition))!==JSON.stringify(definition))throw invalid()
 return page
}
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
 private readonly kind:BusinessConfigurationPageKind|undefined
 /** kind 限定本容器只列一种页面（业务内容=records、统计看板=dashboard）；不传则列出全部页面。 */
 constructor(api:Pick<BusinessBuilderApi,'current'|'page'>,scope:string,selection?:BusinessConfigurationSelection,reference?:BusinessObjectReference,kind?:BusinessConfigurationPageKind){this.api=api;this.scope=scope;this.selection=selection;this.reference=reference;this.kind=kind}
 /** 当前容器可列出的页面：按 kind 过滤正式配置页面，保持配置声明顺序。 */
 pages(current:BusinessConfigurationCurrentResponse){return current.manifest.pages.filter(page=>this.kind===undefined||page.kind===this.kind)}
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
   try{remembered=this.selection?.get(this.scope,this.kind)??remembered}catch{/* 选择偏好不可用时仍按正式首页打开。 */}
   const pages=this.pages(current),candidates=reference?pages.filter(page=>page.kind==='records'&&page.objectType===reference.type):pages
   const selectedId=candidates.find(page=>page.id===remembered)?.id??(reference?candidates[0]?.id:candidates.find(page=>page.id===current.manifest.homePageId)?.id??candidates[0]?.id)
   // 限定种类而本业务没有这类页面：如实显示空态，不改选其它种类的页面。
   if(!selectedId&&!reference&&this.kind!==undefined){this.publish({status:'ready',current,selectedId:null,pageStatus:'idle'});return}
   if(!selectedId)throw reference?referenceUnavailable():invalid()
   this.preferredId=selectedId
   this.publish({status:'ready',current,selectedId,pageStatus:'loading'})
   await this.readPage(current,selectedId,signal)
  }catch(error){if(!signal.aborted)this.publish({...initial(),status:'failed',error})}
 }
 async select(pageId:string,timeRange?:BusinessTimeRange):Promise<void>{
  const current=this.state.current
  if(this.state.status!=='ready'||!current||!this.pages(current).some(page=>page.id===pageId))throw new WorkError('teloa/invalid-input','此页面不属于当前业务配置。')
  this.preferredId=pageId
  const signal=this.begin();this.publish({selectedId:pageId,page:null,pageStatus:'loading',error:null})
  await this.readPage(current,pageId,signal,timeRange)
 }
 private async readPage(current:BusinessConfigurationCurrentResponse,pageId:string,signal:AbortSignal,timeRange?:BusinessTimeRange):Promise<void>{
  try{
   const page=await readBusinessConfigurationSavedPage(this.api,this.scope,current,pageId,signal,timeRange)
   if(signal.aborted)return
   try{this.selection?.set(this.scope,pageId,this.kind)}catch{/* 页面偏好保存失败不影响已核验的正式页面。 */}
   this.publish({page,pageStatus:'ready',error:null})
  }catch(error){if(!signal.aborted)this.publish({page:null,pageStatus:'failed',error})}
 }
}

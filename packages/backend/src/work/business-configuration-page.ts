import type {Pool,PoolClient} from 'pg'
import {WorkError,taskInput,businessTimeRanges,businessConfigurationFormatV2,readBusinessBuilderRequest,readBusinessConfigurationPageProjectionVersioned,type BusinessConfigurationPage,type BusinessConfigurationPageProjectionVersioned,type BusinessTimeRange,type BusinessObjectTypeDefinition,type BusinessViewWidgetResultV2} from '@teloa/contract'
import type {BusinessConfigurationActor,BusinessConfigurationDraftService} from './business-configuration-drafts.ts'
import type {BusinessConfigurationStore} from './business-configuration-store.ts'
import type {BusinessDefinitionSourceReader,BusinessDefinitionBundle,BusinessDefinitionBundleVersioned} from './business-definition-source.ts'
import type {BusinessSqlExecutor} from './business-sql-executor.ts'
import {BusinessLedgerService} from './business-view-compute.ts'
import {BusinessWidgetService,businessWidgetDefinitionHash} from './business-widgets.ts'
import {BusinessViewV2Computer} from './business-view-compute-v2.ts'
type Dependencies={drafts:Pick<BusinessConfigurationDraftService,'draftInTransaction'>;store:Pick<BusinessConfigurationStore,'currentInTransaction'>;definitions:Pick<BusinessDefinitionSourceReader,'forScope'|'forConfigurationCandidate'>&Partial<Pick<BusinessDefinitionSourceReader,'forScopeVersioned'|'forConfigurationCandidateVersioned'>>;executor:Pick<BusinessSqlExecutor,'schema'|'execute'>}
const forbidden=()=>new WorkError('teloa/forbidden','当前主体未获准访问此业务页面。')
const conflict=()=>new WorkError('teloa/version-conflict','业务配置草案已变化，请重新读取。')
/** 只投影持久草案或正式配置。组件复用既有计算器，绝不写结果或拉取来源。 */
export class BusinessConfigurationPageService{
 private readonly pool:Pool
 private readonly identity:{now:()=>string}
 private readonly dependencies:Dependencies
 constructor(pool:Pool,identity:{now:()=>string},dependencies:Dependencies){this.pool=pool;this.identity=identity;this.dependencies=dependencies}
 private async transaction<T>(work:(db:PoolClient)=>Promise<T>,signal?:AbortSignal):Promise<T>{
  signal?.throwIfAborted();const db=await this.pool.connect()
  try{await db.query('begin isolation level repeatable read read only');const result=await work(db);signal?.throwIfAborted();await db.query('commit');return result}
  catch(error){await db.query('rollback').catch(()=>{});throw error}finally{db.release()}
 }
 async preview(actor:BusinessConfigurationActor,input:unknown,signal?:AbortSignal):Promise<BusinessConfigurationPageProjectionVersioned>{
  const r=taskInput(input,['draftId','expectedRevision','pageId','timeRange'])
  if(typeof r.draftId!=='string'||!Number.isSafeInteger(r.expectedRevision)||Number(r.expectedRevision)<1||typeof r.pageId!=='string'||!r.pageId||r.timeRange!==undefined&&!businessTimeRanges.includes(r.timeRange as BusinessTimeRange))throw new WorkError('teloa/invalid-input','业务页面预览请求格式不正确。')
  return this.transaction(async db=>{
   const draft=await this.dependencies.drafts.draftInTransaction(db,actor,r.draftId as string)
   if(draft.status!=='draft'||draft.revision!==r.expectedRevision)throw conflict()
   const current=await this.dependencies.store.currentInTransaction(db,actor.ownerId,draft.scope)
   if(draft.baseVersion!==(current?.version??0))throw conflict()
   const versioned=draft.candidate.format===businessConfigurationFormatV2,reader=this.dependencies.definitions
   if(versioned&&!reader.forConfigurationCandidateVersioned)throw new WorkError('teloa/dependency-unavailable','富字段页面读取尚未接入。')
   const bundles=versioned?await reader.forConfigurationCandidateVersioned!(db,actor.ownerId,draft.candidate):await reader.forConfigurationCandidate(db,actor.ownerId,draft.candidate)
   const page=await this.project(db,actor.ownerId,draft.scope,draft.candidate.pages,bundles,r.pageId as string,r.timeRange as BusinessTimeRange|undefined,versioned,signal)
   return readBusinessConfigurationPageProjectionVersioned({...(versioned?{format:'teloa.business-configuration-page/v2'}:{}),mode:'preview',scope:draft.scope,draftId:draft.id,revision:draft.revision,configurationHash:draft.hash,page})
  },signal)
 }
 async read(actor:BusinessConfigurationActor,input:unknown,signal?:AbortSignal):Promise<BusinessConfigurationPageProjectionVersioned>{
  const r=readBusinessBuilderRequest('business-configuration/page',input)
  if(typeof r.scope!=='string'||!actor?.ownerId||!actor.scopeIds?.includes(r.scope))throw forbidden()
  const scope=r.scope
  return this.transaction(async db=>{
   const current=await this.dependencies.store.currentInTransaction(db,actor.ownerId,scope)
   if(!current)throw new WorkError('teloa/not-found','此业务尚无已保存的配置页面。')
   const versioned=current.manifest.format===businessConfigurationFormatV2,reader=this.dependencies.definitions
   if(versioned&&!reader.forScopeVersioned)throw new WorkError('teloa/dependency-unavailable','富字段页面读取尚未接入。')
   const bundles=versioned?await reader.forScopeVersioned!(db,actor.ownerId,scope):await reader.forScope(db,actor.ownerId,scope)
   const page=await this.project(db,actor.ownerId,scope,current.manifest.pages,bundles,r.pageId as string,r.timeRange as BusinessTimeRange|undefined,versioned,signal)
   return readBusinessConfigurationPageProjectionVersioned({...(versioned?{format:'teloa.business-configuration-page/v2'}:{}),mode:'saved',scope,configurationVersion:current.version,configurationHash:current.hash,page})
  },signal)
 }
 private async project(db:PoolClient,ownerId:string,scope:string,pages:BusinessConfigurationPage[],bundles:BusinessDefinitionBundleVersioned[],pageId:string,requestedRange:BusinessTimeRange|undefined,versioned:boolean,signal?:AbortSignal):Promise<BusinessConfigurationPageProjectionVersioned['page']>{
  signal?.throwIfAborted()
  const definition=pages.find(page=>page.id===pageId)
  if(!definition)throw new WorkError('teloa/not-found','此业务配置没有该页面。')
  const types=bundles.flatMap(b=>b.objectTypes.map(r=>r.definition))
  if(definition.kind==='records'){
   if(requestedRange!==undefined)throw new WorkError('teloa/invalid-input','记录页面不接受看板时间范围。')
   const objectType=types.find(d=>d.id===definition.objectType)!
   if(objectType.format==='teloa.business-object-type/v2')return {kind:'records',definition,objectType,emptyState:'no-records'}
   return {kind:'records',definition,objectType,emptyState:'no-records'}
  }
  const dashboard=bundles.flatMap(b=>b.dashboards).find(r=>r.definition.id===definition.dashboardId)!.definition
  const timeRange=requestedRange??dashboard.filters?.timeRange.default??'all'
  if(dashboard.filters?!dashboard.filters.timeRange.options.includes(timeRange):timeRange!=='all')throw new WorkError('teloa/invalid-input','此看板未提供该时间范围。')
  const allWidgets=bundles.flatMap(b=>b.widgets),views=bundles.flatMap(b=>b.views)
  const widgets=dashboard.widgets.map(id=>allWidgets.find(r=>r.definition.id===id)!.definition)
  if(versioned){
   const computedAt=this.identity.now(),computer=new BusinessViewV2Computer({now:()=>computedAt}),results:BusinessViewWidgetResultV2[]=[]
   const objectTypes=bundles.flatMap(bundle=>bundle.objectTypes)
   for(const widget of widgets){
    if(widget.kind!=='view-ref'||!widget.viewRef)throw new WorkError('teloa/dependency-unavailable','富字段配置看板当前仅支持视图组件。')
    const record=views.find(view=>view.definition.id===widget.viewRef)
    const objectType=objectTypes.find(type=>type.definition.id===record?.definition.objectType)
    if(!record||!objectType)throw new WorkError('teloa/source-unavailable','业务看板引用的视图或对象类型不在同一配置内。')
    const view=await computer.computeInTransaction(db,{ownerId,scopeIds:[scope]},{scope,objectType,view:record,objectTypes},signal)
    results.push({format:'teloa.business-view-widget-result/v2',widgetId:widget.id,definitionHash:businessWidgetDefinitionHash(widget),computedAt,view:{...view,rows:view.rows.slice(0,50),...(view.objects?{objects:view.objects.slice(0,50)}:{})},stale:false})
   }
   const viewRefs=[...new Set(widgets.map(widget=>widget.viewRef!))].map(id=>{
    const view=views.find(record=>record.definition.id===id)!.definition
    return {view,objectType:types.find(type=>type.id===view.objectType)!}
   })
   return {kind:'dashboard',definition,dashboard,widgets,results,viewRefs,timeRange}
  }
  if(types.some(type=>type.format!=='teloa.business-object-type/v1'))throw new WorkError('teloa/dependency-unavailable','业务看板格式与对象类型版本不一致。')
  const objectTypes=types as BusinessObjectTypeDefinition[]
  // 只在本请求里给已验证 bundle；view-ref 的 ledger 不得绕回正式 reader。
  const ledger=new BusinessLedgerService(this.pool,this.identity,{forScope:async(_db,owner,target)=>{
   if(owner!==ownerId||target!==scope)throw forbidden()
   return bundles as BusinessDefinitionBundle[]
  }})
  const computer=new BusinessWidgetService(this.pool,this.identity,this.dependencies.executor,ledger)
  const legacyViews=(bundles as BusinessDefinitionBundle[]).flatMap(bundle=>bundle.views)
  const ctx={ownerId,scope,objectTypes,views:legacyViews,now:this.identity.now(),db},results=[]
  for(const widget of widgets){
   signal?.throwIfAborted()
   // SQL 使用独立只读执行器连接；不宣称与 view-ref 共用同一 MVCC 时刻。
   const {throttled:_,...result}=await computer.compute(ctx,widget,50,signal,timeRange)
   results.push(result)
  }
  const viewRefs=[...new Set(widgets.flatMap(w=>w.viewRef?[w.viewRef]:[]))].map(id=>{
   const view=legacyViews.find(v=>v.definition.id===id)!.definition
   return {view,objectType:objectTypes.find(t=>t.id===view.objectType)!}
  })
  return {kind:'dashboard',definition,dashboard,widgets,results,viewRefs,timeRange}
 }
}

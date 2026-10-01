import {
 businessCustomizationLimits,businessDefinitionKinds,isBusinessScopeKey,businessFieldTypes,businessViewCharts,businessViewKinds,readBusinessDefinitionBody,readBusinessObjectTypeDefinition,readBusinessWidgetResult,
 type BusinessCustomizationDirectory,type BusinessDashboardLayoutItem,type BusinessCustomizationEntry,type BusinessDefinitionDraft,type BusinessDefinitionKind,type BusinessDefinitionPreview,type BusinessLocalDefinitionVersion,type BusinessSourceMappingDefinition,
} from '@teloa/contract'

type Call=(method:string,payload:unknown,signal?:AbortSignal)=>Promise<unknown>
type RecordValue=Record<string,unknown>

function invalid():Error{return Object.assign(Error('业务定制回包格式不正确。'),{code:'teloa/invalid-host-response'})}
function record(value:unknown):RecordValue{if(typeof value!=='object'||value===null||Array.isArray(value))throw invalid();return value as RecordValue}
function exact(value:unknown,keys:readonly string[]):RecordValue{const row=record(value);if(Object.keys(row).length!==keys.length||keys.some(key=>!Object.hasOwn(row,key)))throw invalid();return row}
function text(value:unknown,max=240,empty=false):value is string{return typeof value==='string'&&value.trim()===value&&(empty||value.length>0)&&value.length<=max&&!/[\x00-\x1f\x7f]/.test(value)}
function stamp(value:unknown):value is string{return typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value}
function hash(value:unknown):value is string{return typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)}
function receipt(value:unknown):value is string{return hash(value)}
function scope(value:unknown):value is string{return isBusinessScopeKey(value)&&value!=='general'}
function integer(value:unknown):value is number{return typeof value==='number'&&Number.isSafeInteger(value)&&value>=0}
function kind(value:unknown):value is BusinessDefinitionKind{return (businessDefinitionKinds as readonly string[]).includes(value as string)}
function localId(value:unknown):value is string{return typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9-]{0,119}$/.test(value)}
function uuid(value:unknown):value is string{return typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)}

function draft(value:unknown,expectedScope?:string):BusinessDefinitionDraft{
 const row=record(value),applied=row.status==='applied'
 const keys=['id','ownerId','requestId','scope','kind','localId','semver','definitionHash','body','status','createdAt','updatedAt',...(applied?['appliedVersion']:[])]
 if(Object.keys(row).length!==keys.length||keys.some(key=>!Object.hasOwn(row,key))||!uuid(row.id)||!text(row.ownerId,200)||!uuid(row.requestId)||!scope(row.scope)||expectedScope!==undefined&&row.scope!==expectedScope||!kind(row.kind)||!localId(row.localId)||!text(row.semver,80)||!hash(row.definitionHash)||!text(row.body,businessCustomizationLimits.bodyBytes)||!stamp(row.createdAt)||!stamp(row.updatedAt)||String(row.updatedAt)<String(row.createdAt)||(row.status!=='draft'&&row.status!=='applied')||(applied&&!integer(row.appliedVersion)))throw invalid()
 try{const body=readBusinessDefinitionBody(row.kind,JSON.parse(row.body));if(body.id!==row.localId||body.version!==row.semver||body.domain!==row.scope)throw invalid()}catch(error){if((error as {code?:string}).code==='teloa/invalid-host-response')throw error;throw invalid()}
 return row as BusinessDefinitionDraft
}
function version(value:unknown):BusinessLocalDefinitionVersion{
 const row=exact(value,['version','semver','definitionHash','bodyHash','createdAt','draftId'])
 if(!integer(row.version)||row.version<1||!text(row.semver,80)||!hash(row.definitionHash)||!hash(row.bodyHash)||!stamp(row.createdAt)||!uuid(row.draftId))throw invalid()
 return row as BusinessLocalDefinitionVersion
}
function entry(value:unknown,expectedScope:string):BusinessCustomizationEntry{
 const row=record(value),hasCurrent=Object.hasOwn(row,'current'),keys=['scope','kind','localId',...(hasCurrent?['current']:[]),'versions','template']
 if(Object.keys(row).length!==keys.length||keys.some(key=>!Object.hasOwn(row,key))||row.scope!==expectedScope||!kind(row.kind)||!localId(row.localId)||!Array.isArray(row.versions)||!row.versions.length||row.versions.length>businessCustomizationLimits.versionsPerDefinition)throw invalid()
 const versions=row.versions.map(version)
 if(versions.some((item,index)=>index>0&&item.version<=versions[index-1]!.version))throw invalid()
 const current=hasCurrent?version(row.current):undefined
 if(current&&!versions.some(item=>Object.keys(current).every(key=>item[key as keyof BusinessLocalDefinitionVersion]===current[key as keyof BusinessLocalDefinitionVersion])))throw invalid()
 const template=record(row.template)
 if(Object.keys(template).some(key=>key!=='available'&&key!=='version')||typeof template.available!=='boolean'||(template.version!==undefined&&!text(template.version,80))||(template.available!==Object.hasOwn(template,'version')))throw invalid()
 return {scope:expectedScope,kind:row.kind as BusinessDefinitionKind,localId:row.localId as string,...(current?{current}:{}),versions,template:template as BusinessCustomizationEntry['template']}
}
export function readBusinessCustomizationDirectory(value:unknown,expectedScope:string):BusinessCustomizationDirectory{
 const row=exact(value,['schema','scope','readAt','drafts','entries'])
 if(row.schema!=='teloa.business-customization/v1'||row.scope!==expectedScope||!stamp(row.readAt)||!Array.isArray(row.drafts)||row.drafts.length>businessCustomizationLimits.draftsPerScope||!Array.isArray(row.entries))throw invalid()
 const drafts=row.drafts.map(item=>draft(item,expectedScope)),entries=row.entries.map(item=>entry(item,expectedScope))
 if(new Set(drafts.map(item=>item.id)).size!==drafts.length||new Set(drafts.map(item=>item.requestId)).size!==drafts.length||new Set(entries.map(item=>item.kind+'/'+item.localId)).size!==entries.length)throw invalid()
 return {schema:'teloa.business-customization/v1',scope:expectedScope,readAt:row.readAt,drafts,entries}
}
/**
 * 试算会立刻交给 ObjectTypeBlock 渲染，所以即使它不会落库，也要把渲染会读取的每一位收住。
 * 清单 objects 在概览试算中不会渲染；摘要校验留给正式台账读取，避免重复另一套异步摘要实现。
 */
function trialBlock(value:unknown,scopeName:string,objectTypeId:string):BusinessDefinitionPreview['trial']{
 const raw=record(value),hasAction=Object.hasOwn(raw,'defaultAction'),hasProgress=Object.hasOwn(raw,'progress')
 const row=exact(raw,['objectType','objects','source','coverage','missingFields','views',...(hasProgress?['progress']:[]),...(hasAction?['defaultAction']:[])])
 const typeRow=exact(row.objectType,['source','definition']),source=exact(typeRow.source,['loadId','scope','localId','version','contentHash','fileHash','definitionHash','origin'])
 if(!text(source.loadId,200)||source.scope!==scopeName||!localId(source.localId)||!text(source.version,80)||!hash(source.contentHash)||!hash(source.fileHash)||!hash(source.definitionHash)||(source.origin!=='template'&&source.origin!=='local'))throw invalid()
 let definition
 try{definition=readBusinessObjectTypeDefinition(typeRow.definition)}catch{throw invalid()}
 if(definition.domain!==scopeName||definition.id!==objectTypeId||definition.id!==source.localId)throw invalid()
 if(!integer(row.objects)||!Array.isArray(row.missingFields)||row.missingFields.some(field=>!text(field,64)||!definition.fields.some(item=>item.name===field))||new Set(row.missingFields).size!==row.missingFields.length)throw invalid()
 const coverage=exact(row.coverage,['objects','latestReceivedAt','truncated'])
 if(coverage.objects!==row.objects||(coverage.latestReceivedAt!==null&&!stamp(coverage.latestReceivedAt))||typeof coverage.truncated!=='boolean')throw invalid()
 if(hasProgress!==(definition.progress!==undefined))throw invalid()
 if(hasProgress){
  const progress=exact(row.progress,['unfinished','waitingForYou','latestChangedAt'])
  if(!integer(progress.unfinished)||!integer(progress.waitingForYou)||progress.unfinished<0||progress.waitingForYou<0||progress.unfinished>coverage.objects||progress.waitingForYou>progress.unfinished||(progress.latestChangedAt!==null&&!stamp(progress.latestChangedAt))||(definition.progress!.changedAtField===undefined&&progress.latestChangedAt!==null))throw invalid()
 }
 const rawDataSource=record(row.source),sourceNoun=Object.hasOwn(rawDataSource,'sourceNoun'),dataSource=exact(rawDataSource,['sourceId','connected',...(sourceNoun?['sourceNoun']:[])])
 if(!text(dataSource.sourceId,120)||dataSource.sourceId!==definition.sourceId||typeof dataSource.connected!=='boolean'||(sourceNoun&&!text(dataSource.sourceNoun,12)))throw invalid()
 if(hasAction){const action=exact(row.defaultAction,['actionId','title','targetKind','available']);if(!localId(action.actionId)||!text(action.title,120)||(action.targetKind!=='work-template'&&action.targetKind!=='execution-tool')||typeof action.available!=='boolean')throw invalid()}
 if(!Array.isArray(row.views)||row.views.length>8)throw invalid()
 for(const item of row.views){
  const candidate=record(item),hasObjects=Object.hasOwn(candidate,'objects')
  const view=exact(candidate,['schema','viewId','viewVersion','definitionHash','origin','kind','chart','title','scope','objectType','computedAt','measures','rows','dimensionValues','coverage','missingFields',...(hasObjects?['objects']:[])])
  if(view.schema!=='teloa.business-view-result/v1'||!localId(view.viewId)||!text(view.viewVersion,80)||!hash(view.definitionHash)||(view.origin!=='template'&&view.origin!=='local')||!(businessViewKinds as readonly string[]).includes(String(view.kind))||!businessViewCharts[view.kind as keyof typeof businessViewCharts].includes(view.chart as never)||!text(view.title,120)||view.scope!==scopeName||view.objectType!==objectTypeId||!stamp(view.computedAt)||!Array.isArray(view.measures)||!view.measures.length||view.measures.length>4||!Array.isArray(view.rows)||!integer(view.dimensionValues)||view.dimensionValues<view.rows.length)throw invalid()
  if(hasObjects!==(view.kind==='list'))throw invalid()
  const viewCoverage=exact(view.coverage,['objects','latestReceivedAt','truncated'])
  if(viewCoverage.objects!==coverage.objects||viewCoverage.latestReceivedAt!==coverage.latestReceivedAt||viewCoverage.truncated!==coverage.truncated)throw invalid()
  if(!Array.isArray(view.missingFields)||view.missingFields.some(field=>!text(field,64))||new Set(view.missingFields).size!==view.missingFields.length)throw invalid()
  const measures=view.measures.map(measure=>{const itemRow=record(measure),hasFieldType=Object.hasOwn(itemRow,'fieldType'),clean=exact(itemRow,hasFieldType?['id','label','fieldType']:['id','label']);if(!text(clean.id,64)||!text(clean.label,80)||(hasFieldType&&!(businessFieldTypes as readonly string[]).includes(String(clean.fieldType))))throw invalid();return clean})
  if(new Set(measures.map(item=>item.id)).size!==measures.length)throw invalid()
  for(const line of view.rows){const rowValue=exact(line,['dimension','label','values']);if(typeof rowValue.dimension!=='string'||!text(rowValue.label,240,true)||!Array.isArray(rowValue.values)||rowValue.values.length!==measures.length||rowValue.values.some(number=>number!==null&&(typeof number!=='number'||!Number.isFinite(number))))throw invalid()}
 }
 return row as BusinessDefinitionPreview['trial']
}
/** 映射试拉（照宿主读取器）：条数与字段只含标识与取值文本，不带来源原文。 */
function mappingTrial(value:unknown):NonNullable<BusinessDefinitionPreview['mappingTrial']>{
 const row=exact(value,['fetched','objects'])
 if(!integer(row.fetched)||row.fetched>100||!Array.isArray(row.objects)||row.objects.length>row.fetched)throw invalid()
 const objects=row.objects.map(item=>{
  const object=exact(item,['objectId','fields'])
  if(!text(object.objectId,200)||!Array.isArray(object.fields)||object.fields.length>64)throw invalid()
  const fields=object.fields.map(entry=>{const field=exact(entry,['field','value']);if(typeof field.field!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/.test(field.field)||typeof field.value!=='string'||field.value.length>2000)throw invalid();return {field:field.field,value:field.value}})
  if(new Set(fields.map(field=>field.field)).size!==fields.length)throw invalid()
  return {objectId:object.objectId as string,fields}
 })
 return {fetched:row.fetched,objects}
}

/**
 * 试算键按草案种类互斥（与宿主 `business-definitions.ts` 的读取器同口径）：对象类型/视图/动作 `trial|trialUnavailable`，
 * 映射 `mappingTrial|trialUnavailable`，组件只 `widgetTrial`，看板只 `dashboardTrial`；组件与看板的 `impact.objectType` 恒为空串。
 */
function trialKeyOf(raw:RecordValue):'trial'|'trialUnavailable'|'widgetTrial'|'dashboardTrial'|'mappingTrial'{
 const kind=typeof raw.draft==='object'&&raw.draft!==null?(raw.draft as RecordValue).kind:undefined
 if(kind==='widget')return 'widgetTrial'
 if(kind==='dashboard')return 'dashboardTrial'
 if(kind==='source-mapping')return Object.hasOwn(raw,'mappingTrial')?'mappingTrial':'trialUnavailable'
 return Object.hasOwn(raw,'trial')?'trial':'trialUnavailable'
}

export function readBusinessDefinitionPreview(value:unknown):BusinessDefinitionPreview{
 const raw=record(value),trialKey=trialKeyOf(raw),hasTrial=trialKey==='trial'
 const row=exact(raw,['schema','draft','receipt','base','diff','diffTruncated','impact','computedAt',trialKey])
 if(row.schema!=='teloa.business-definition-preview/v1'||!receipt(row.receipt)||!stamp(row.computedAt)||typeof row.diffTruncated!=='boolean'||!Array.isArray(row.diff)||row.diff.length>businessCustomizationLimits.diffRows)throw invalid()
 const parsedDraft=draft(row.draft)
 if(parsedDraft.status!=='draft')throw invalid()
 const rawBase=record(row.base)
 const base=exact(rawBase,rawBase.origin==='none'?['origin']:['origin','semver','definitionHash'])
 if(!['template','local','none'].includes(base.origin as string)||(base.origin!=='none'&&(!text(base.semver,80)||!hash(base.definitionHash))))throw invalid()
 const diff=row.diff.map(item=>{const itemRow=exact(item,['path','before','after']);if(!text(itemRow.path,500)||!/^[$a-zA-Z0-9_.\[\]-]+$/.test(itemRow.path)||(itemRow.before!==null&&typeof itemRow.before!=='string')||(itemRow.after!==null&&typeof itemRow.after!=='string')||itemRow.before===itemRow.after)throw invalid();return itemRow as {path:string;before:string|null;after:string|null}})
 if(new Set(diff.map(item=>item.path)).size!==diff.length||(row.diffTruncated&&diff.length!==businessCustomizationLimits.diffRows))throw invalid()
 const impact=exact(row.impact,['scope','objectType','views','actions','fields','widgets','dashboards'])
 const boardKind=parsedDraft.kind==='widget'||parsedDraft.kind==='dashboard'
 if(impact.scope!==parsedDraft.scope||(boardKind?impact.objectType!=='':!localId(impact.objectType))||!['views','actions','fields','widgets','dashboards'].every(key=>Array.isArray(impact[key])&&(impact[key] as unknown[]).every(localId)))throw invalid()
 let extra:Pick<BusinessDefinitionPreview,'widgetTrial'|'dashboardTrial'|'mappingTrial'>={}
 if(trialKey==='widgetTrial'){
  let widgetTrial
  try{widgetTrial=readBusinessWidgetResult(row.widgetTrial)}catch{throw invalid()}
  if(widgetTrial.widgetId!==parsedDraft.localId)throw invalid()
  extra={widgetTrial}
 }else if(trialKey==='dashboardTrial'){
  const trial=exact(row.dashboardTrial,['layout']),layout=(readBusinessDefinitionBody('dashboard',JSON.parse(parsedDraft.body)) as {layout:BusinessDashboardLayoutItem[]}).layout
  if(JSON.stringify(trial.layout)!==JSON.stringify(layout))throw invalid()
  extra={dashboardTrial:{layout}}
 }else if(trialKey==='mappingTrial')extra={mappingTrial:mappingTrial(row.mappingTrial)}
 else if(hasTrial)trialBlock(row.trial,parsedDraft.scope,impact.objectType as string)
 // pull-required 只认受管 MCP 来源的映射草案；pull-failed / config-unreadable 只认映射草案（来源不限）。
 else if(row.trialUnavailable!=='source-disconnected'&&row.trialUnavailable!=='no-objects'&&!((row.trialUnavailable==='pull-failed'||row.trialUnavailable==='config-unreadable')&&parsedDraft.kind==='source-mapping')&&!(row.trialUnavailable==='pull-required'&&parsedDraft.kind==='source-mapping'&&(readBusinessDefinitionBody('source-mapping',JSON.parse(parsedDraft.body)) as BusinessSourceMappingDefinition).source.kind==='mcp-tool'))throw invalid()
 // 试算块复用台账契约；宿主在生成时已经沿用同一份检查。客户端这里只收住可选位，
 // 避免把会话草案预览与台账读取绑成一条模块加载链，正式台账仍会在刷新时逐条验收。
 const trial=hasTrial?row.trial as BusinessDefinitionPreview['trial']:undefined
 return {schema:'teloa.business-definition-preview/v1',draft:parsedDraft,receipt:row.receipt as string,base:base as BusinessDefinitionPreview['base'],diff,diffTruncated:row.diffTruncated,impact:{scope:impact.scope as string,objectType:impact.objectType as string,views:[...(impact.views as string[])],actions:[...(impact.actions as string[])],fields:[...(impact.fields as string[])],widgets:[...(impact.widgets as string[])],dashboards:[...(impact.dashboards as string[])]},...(trial?{trial}:trialKey==='trialUnavailable'?{trialUnavailable:row.trialUnavailable as NonNullable<BusinessDefinitionPreview['trialUnavailable']>}:extra),computedAt:row.computedAt as string}
}

export function createBusinessCustomizationApi(call:Call){
 return {
  async directory(input:{scope:string},signal?:AbortSignal){if(!scope(input.scope))throw Error('需要明确的业务范围。');return readBusinessCustomizationDirectory(await call('business-definitions/customization',{scope:input.scope},signal),input.scope)},
  /** `pull:true` 只在用户点了「试拉」时带：受管 MCP 工具来源的映射草案，打开预览不调外部工具。 */
  async preview(input:{draftId:string;pull?:true},signal?:AbortSignal){if(!uuid(input.draftId))throw Error('业务声明草案标识不合法。');return readBusinessDefinitionPreview(await call('business-definitions/preview',{draftId:input.draftId,...(input.pull===true?{pull:true}:{})},signal))},
  async apply(input:{requestId:string;draftId:string;expectedDefinitionHash:string;expectedCurrentVersion:number;previewReceipt:string},signal?:AbortSignal){if(!uuid(input.requestId)||!uuid(input.draftId)||!hash(input.expectedDefinitionHash)||!integer(input.expectedCurrentVersion)||!receipt(input.previewReceipt))throw Error('确认业务定制所需的版本信息不合法。');const value=await call('business-definitions/apply',{requestId:input.requestId,draftId:input.draftId,expectedDefinitionHash:input.expectedDefinitionHash,expectedCurrentVersion:input.expectedCurrentVersion,previewReceipt:input.previewReceipt},signal);const row=record(value);if(!scope(row.scope))throw invalid();return entry(value,row.scope as string)},
  async revert(input:{requestId:string;scope:string;kind:BusinessDefinitionKind;localId:string;target:{kind:'local-version';version:number}|{kind:'template'};expectedCurrentVersion:number},signal?:AbortSignal){if(!uuid(input.requestId)||!scope(input.scope)||!kind(input.kind)||!localId(input.localId)||!integer(input.expectedCurrentVersion)||(input.target.kind==='local-version'&&(!integer(input.target.version)||input.target.version<1)))throw Error('回退业务定制所需的信息不合法。');const value=await call('business-definitions/revert',input,signal);return entry(value,input.scope)},
 }
}
export type BusinessCustomizationApi=ReturnType<typeof createBusinessCustomizationApi>

import {createHash} from 'node:crypto'
import type {PoolClient} from 'pg'
import {WorkError,businessDashboardShareLimits,businessDashboardShareSnapshotText,readBusinessDashboardShareSnapshot,type BusinessDashboardShareSnapshot,type BusinessDashboardShareSection,type BusinessDashboardShareRaw,type BusinessObjectSnapshot,type BusinessWidgetDefinition,type BusinessViewWidgetResultV2,type BusinessWidgetResult} from '@teloa/contract'
import type {BusinessObjectTypeRecordVersioned,BusinessViewRecordVersioned} from './business-definition-source.ts'
import {BusinessViewV2Computer} from './business-view-compute-v2.ts'
import {businessWidgetDefinitionHash} from './business-widgets.ts'

const limit=(message:string)=>new WorkError('teloa/dashboard-share-limit',message)
function sectionOf(widget:BusinessWidgetDefinition,view:BusinessViewRecordVersioned,objectType:BusinessObjectTypeRecordVersioned,objects:BusinessObjectSnapshot[]):BusinessDashboardShareSection{
 const metadata=[['id','记录标识'],['version','记录版本'],['snapshotHash','记录摘要'],['title','标题'],['source','来源'],['observedAt','来源时间'],['receivedAt','接收时间'],['quality','数据质量'],['summary','摘要'],['fields','来源字段原文']] as const
 const columns=[...metadata.map(([name,label])=>({key:'record.'+name,label})),...objectType.definition.fields.map(field=>({key:'field.'+field.name,label:field.label}))]
 const rows:BusinessDashboardShareSection['rows']=[]
 let bytes=Buffer.byteLength(JSON.stringify(columns))
 for(const object of objects){
  const values=new Map(object.fields.map(field=>[field.label,field.value]))
  // rich 字段已以来源原文保存；完整 fields 也保留未映射原值，不以显示用聚合值冒充原件。
  const row=[...metadata.map(([name])=>name==='fields'?JSON.stringify(object.fields):object[name]),...objectType.definition.fields.map(field=>values.get(field.from)??null)]
  bytes+=Buffer.byteLength(JSON.stringify(row))+1
  if(bytes>businessDashboardShareLimits.bytes)throw limit('看板分享快照超过 8 MiB 上限，请缩小数据范围后重试；未导出截断数据。')
  rows.push(row)
 }
 return {widgetId:widget.id,viewId:view.definition.id,objectTypeId:objectType.definition.id,columns,rows,recordCount:rows.length}
}
/** 同一数据库事务、同一时刻计算展示与原始行；超限拒绝整份导出。 */
export async function dashboardShareView(db:PoolClient,ownerId:string,scope:string,widget:BusinessWidgetDefinition,view:BusinessViewRecordVersioned,objectType:BusinessObjectTypeRecordVersioned,objectTypes:BusinessObjectTypeRecordVersioned[],capturedAt:string,signal?:AbortSignal){
 const snapshot=await new BusinessViewV2Computer({now:()=>capturedAt}).snapshotInTransaction(db,{ownerId,scopeIds:[scope]},{scope,view,objectType,objectTypes},signal)
 if(snapshot.truncated||snapshot.objects.length>businessDashboardShareLimits.rows)throw limit('原始记录超过 5000 条扫描上限，请缩小业务数据范围后重试；未导出截断数据。')
 const result:BusinessViewWidgetResultV2={format:'teloa.business-view-widget-result/v2',widgetId:widget.id,definitionHash:businessWidgetDefinitionHash(widget),computedAt:capturedAt,view:snapshot.view,stale:false}
 const legacy:BusinessWidgetResult={widgetId:widget.id,definitionHash:result.definitionHash,computedAt:capturedAt,status:'ok',columns:[{name:'dimension',type:'text'},{name:'label',type:'text'},...snapshot.view.measures.map(measure=>({name:measure.id,type:'number' as const}))],rows:snapshot.view.rows.map(row=>[row.dimension,row.label,...row.values.map(value=>typeof value==='object'&&value!==null?JSON.stringify(value):value)]),rowCount:snapshot.view.rows.length,truncated:false,bytes:0,stale:false}
 legacy.bytes=Buffer.byteLength(JSON.stringify(legacy.rows))
 return {result,legacy,section:sectionOf(widget,view,objectType,snapshot.objects)}
}
export function dashboardShareRaw(sections:BusinessDashboardShareSection[]):BusinessDashboardShareRaw{
 if(sections.reduce((count,section)=>count+section.recordCount,0)>businessDashboardShareLimits.rows)throw limit('分享中的原始记录总数超过 5000 条，请缩小数据范围后重试；未导出截断数据。')
 return {status:'ready',sections}
}
export function sealDashboardShareSnapshot(value:Omit<BusinessDashboardShareSnapshot,'schema'|'snapshotHash'>):BusinessDashboardShareSnapshot{
 const input={schema:'teloa.business-dashboard-share/v1' as const,...value}
 if(Buffer.byteLength(JSON.stringify(input))>businessDashboardShareLimits.bytes-128)throw limit('看板分享快照超过 8 MiB 上限，请缩小数据范围后重试；未导出截断数据。')
 const snapshotHash=createHash('sha256').update(businessDashboardShareSnapshotText(input)).digest('hex')
 return readBusinessDashboardShareSnapshot({...input,snapshotHash})
}

import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import type {Pool,PoolClient} from 'pg'
import {readBusinessDashboardDefinition,readBusinessWidgetDefinition,readBusinessObjectTypeDefinitionVersioned,readBusinessViewDefinitionVersioned,businessDashboardShareDefinitionText,type BusinessObjectSnapshot,type BusinessDashboardShareTarget} from '@teloa/contract'
import {BusinessConfigurationPageService} from '../../src/work/business-configuration-page.ts'
import {BusinessDashboardService} from '../../src/work/business-dashboards.ts'
import {businessObjectSnapshotHash} from '../../src/work/business-data.ts'

export const scope='business_0123456789abcdef0123456789abcdef',ownerId='dashboard-share-owner',now='2026-10-21T12:00:00.000Z',configHash='c'.repeat(64)
const identity={now:()=>now,id:()=>crypto.randomUUID()}
export function object(id:string,changed='2026-10-20T12:00:00.000Z',state='新建',extra:Record<string,unknown>={}):BusinessObjectSnapshot{
 const value={scope,type:'customer',id,version:2,title:'客户 '+id,source:'本地记录',observedAt:changed,receivedAt:now,quality:'complete' as const,summary:'原始正文',fields:[{label:'阶段',value:state},{label:'更新',value:changed},{label:'金额',value:'{"currency":"CNY","decimal":"9007199254740993.0001"}'},{label:'标签',value:'["重要","续约"]'},{label:'原始标题',value:'=原文,\n含引号"'}],...extra}
 return {...value,snapshotHash:businessObjectSnapshotHash(value as never)} as BusinessObjectSnapshot
}
export function fixture(objects:BusinessObjectSnapshot[],options:{legacySql?:boolean;list?:boolean;v1?:boolean;widgetCount?:number}={}){
 const type=readBusinessObjectTypeDefinitionVersioned({format:options.v1?'teloa.business-object-type/v1':'teloa.business-object-type/v2',id:'customer',version:'1.0.0',domain:scope,title:'客户',unit:'位',lead:'客户数据',sourceId:'records',fields:[
  {name:'state',label:'阶段',type:'enum',required:false,from:'阶段',values:['新建','完成']},
  {name:'changed',label:'更新',type:'datetime',required:false,from:'更新'},
  ...(!options.v1?[{format:'teloa.business-rich-field/v2',name:'amount',label:'金额',from:'金额',type:'money',required:false,currencies:['CNY']},
  {format:'teloa.business-rich-field/v2',name:'tags',label:'标签',from:'标签',type:'multi-enum',required:false,values:['重要','续约']}]:[]),
  {name:'title',label:'原始标题',from:'原始标题',type:'text',required:false},
 ]})
 const view=readBusinessViewDefinitionVersioned({format:options.v1?'teloa.business-view/v1':'teloa.business-view/v2',id:'total',version:'1.0.0',domain:scope,title:'客户数量',kind:options.list?'list':'board-card',chart:options.list?'table':'number',objectType:'customer',measures:[{id:'count',label:'客户数',aggregation:'count'}],filters:[{field:'state',op:'eq',values:['新建']}],window:{field:'changed',relative:'last-7d'},...(options.list?{sort:{by:'dimension',direction:'asc'}}:{}),limit:options.list?100:1})
 const widget=readBusinessWidgetDefinition({format:'teloa.business-widget/v1',id:'count-widget',version:'1.0.0',domain:scope,title:'客户数量',...(options.legacySql?{kind:'metric',query:'select count(*) as total from customer',metric:{valueColumn:'total'},timeFilter:{table:'customer',column:'changed'}}:{kind:'view-ref',viewRef:'total'})})
 const widgets=Array.from({length:options.widgetCount??1},(_,i)=>i===0?widget:readBusinessWidgetDefinition({...widget,id:'count-widget-'+i}))
 const dashboard=readBusinessDashboardDefinition({format:'teloa.business-dashboard/v1',id:'overview',version:'1.0.0',domain:scope,title:'客户统计',widgets:widgets.map(widget=>widget.id),layout:widgets.map((widget,i)=>({widget:widget.id,x:0,y:i*2,w:12,h:2})),refresh:{kind:'every',seconds:300},acknowledgeShortInterval:false,...(options.legacySql?{filters:{timeRange:{options:['7d','all'],default:'all'}}}:{})})
 const source=(localId:string)=>({loadId:'00000000-0000-4000-8000-000000000001',scope,localId,version:'1.0.0',contentHash:'a'.repeat(64),fileHash:'b'.repeat(64),definitionHash:'d'.repeat(64),origin:'local' as const})
 const bundle={objectTypes:[{definition:type,source:source(type.id)}],views:[{definition:view,source:source(view.id)}],widgets:widgets.map(widget=>({definition:widget,source:source(widget.id)})),dashboards:[{definition:dashboard,source:source(dashboard.id)}]}
 const commands:Array<{sql:string;values:unknown[]}>=[]
 const db={query:async(sql:string,values:unknown[]=[])=>{
  commands.push({sql,values})
  if(sql.startsWith('begin')||sql==='commit'||sql==='rollback')return {rows:[]}
  if(sql.startsWith('with ids as')){assert.deepEqual(values.slice(0,3),[ownerId,scope,'customer']);return {rows:objects.map(snapshot=>({object_id:snapshot.id,object_version:snapshot.version,source_id:'records',snapshot_hash:snapshot.snapshotHash,snapshot:(()=>{const {snapshotHash:_,...body}=snapshot;return body})()}))}}
  if(sql.startsWith('select distinct on(object_id)'))return {rows:objects.map(snapshot=>({object_id:snapshot.id,first_seen_at:new Date(snapshot.observedAt)}))}
  if(sql.includes('teloa_business_data_changes')||sql.includes('teloa_business_dashboard_data_revisions'))return {rows:[]}
  if(sql.includes('pg_locks'))return {rows:[{held:false}]}
  throw Error('意外数据库操作：'+sql)
 },release(){}} as unknown as PoolClient
 const pool={connect:async()=>db} as Pool
 const current={ownerId,scope,version:2,hash:configHash,createdAt:now,leaves:[],manifest:{format:options.v1?'teloa.business-configuration/v1':'teloa.business-configuration/v2',pages:[{id:'overview-page',kind:'dashboard',title:'客户统计',dashboardId:dashboard.id}]}}
 const definitions={forScope:async()=>[bundle],forScopeVersioned:async()=>[bundle],forConfigurationCandidate:async()=>[bundle]} as never
 const pages=new BusinessConfigurationPageService(pool,identity,{drafts:{} as never,store:{currentInTransaction:async(_db,owner,target)=>{assert.equal(owner,ownerId);assert.equal(target,scope);return current as never}},definitions,executor:{} as never})
 const latest=new Map(widgets.map(widget=>[widget.id,{widgetId:widget.id,definitionHash:'d'.repeat(64),computedAt:now,status:'ok' as const,columns:[{name:'total',type:'number' as const}],rows:[[objects.length]],rowCount:1,truncated:false as const,bytes:3,stale:false}]))
 const dashboards=new BusinessDashboardService(pool,identity,definitions,{latest:async()=>latest,latestSuccessful:async()=>new Map()} as never)
 const target:BusinessDashboardShareTarget={kind:'configuration',scope,pageId:'overview-page',configurationVersion:2,configurationHash:configHash,timeRange:'all'}
 const legacy:BusinessDashboardShareTarget={kind:'legacy',scope,dashboardId:dashboard.id,definitionHash:createHash('sha256').update(businessDashboardShareDefinitionText(dashboard)).digest('hex'),timeRange:options.legacySql?'7d':'all'}
 return {pages,dashboards,target,legacy,commands,current,dashboard,widget}
}
/** 以实际服务生成合法快照，供独立浏览器夹具复用；不连接用户实例。 */
export async function dashboardShareFixture(count=2,list=false){const f=fixture(Array.from({length:count},(_,i)=>object('id-'+i)),{list});return f.pages.shareSnapshot({ownerId,scopeIds:[scope]},f.target)}

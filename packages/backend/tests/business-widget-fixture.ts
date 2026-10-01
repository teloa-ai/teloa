import {mkdtemp} from 'node:fs/promises'
import {homedir,tmpdir} from 'node:os'
import {join} from 'node:path'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {
 readBusinessDashboardDefinition,readBusinessObjectTypeDefinition,readBusinessViewDefinition,readBusinessWidgetDefinition,
 type BusinessDashboardDefinition,type BusinessDefinitionSource,type BusinessObjectTypeDefinition,type BusinessViewDefinition,type BusinessWidgetDefinition,
} from '@teloa/contract'
import {initializeTeloaDatabase} from '../src/work/initialize-database.ts'
import {businessSqlPoolConfig} from '../src/work/business-sql-executor.ts'
import {BusinessDataService} from '../src/work/business-data.ts'
import type {BusinessDefinitionBundle,BusinessDefinitionSourceReader} from '../src/work/business-definition-source.ts'

/**
 * 组件 / 看板两套真库测试共用：全库初始化（含快照表、安全函数、只读角色与结果表）、SOC 告警对象类型与风险分布视图、
 * 按 owner 写入告警快照。声明侧不进库：`forScope` 用替身直接回一个声明包，声明本身仍过契约读取器。
 */
/** reader：执行器专用连接池，按初始化写下的口令文件以只读角色直接登录（执行器 role 模式拒绝其他会话用户）。 */
export async function startDatabase():Promise<{container:StartedPostgreSqlContainer;pool:Pool;reader:Pool}>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 const container=await new PostgreSqlContainer('postgres:17-alpine').start()
 const pool=new Pool({connectionString:container.getConnectionUri()})
 const secretPath=join(await mkdtemp(join(tmpdir(),'teloa-widgets-')),'business-sql-reader.json')
 const {businessSqlRole}=await initializeTeloaDatabase(pool,{businessSqlSecretPath:secretPath})
 const reader=new Pool(await businessSqlPoolConfig({connectionString:container.getConnectionUri()},businessSqlRole,secretPath))
 return {container,pool,reader}
}

export const alertTicket:BusinessObjectTypeDefinition=readBusinessObjectTypeDefinition({
 format:'teloa.business-object-type/v1',id:'alert-ticket',version:'1.0.0',domain:'SOC',title:'告警工单',unit:'条',lead:'来自告警平台。',sourceId:'security-alert-http',
 fields:[
  {name:'severity',label:'严重度',type:'enum',required:true,from:'严重度',values:['高','中','低']},
  {name:'host',label:'主机',type:'text',required:true,from:'主机'},
  {name:'verdict',label:'当前判定',type:'enum',required:true,from:'当前判定',values:['还没有人看','正在核对','等你确认','已确认维护']},
 ],
})
export const riskView:BusinessViewDefinition=readBusinessViewDefinition({
 format:'teloa.business-view/v1',id:'soc-risk-distribution',version:'1.0.0',domain:'SOC',title:'风险分布',kind:'distribution',chart:'bar',objectType:'alert-ticket',
 dimension:{field:'severity',limit:3},measures:[{id:'total',label:'条数',aggregation:'count'}],filters:[],sort:{by:'measure',measureId:'total',direction:'desc'},limit:3,
})

const source=(localId:string):BusinessDefinitionSource=>({loadId:'00000000-0000-4000-8000-000000000001',scope:'SOC',localId,version:'1.0.0',contentHash:'a'.repeat(64),fileHash:'b'.repeat(64),definitionHash:'c'.repeat(64),origin:'local'})
export const widgetHead={format:'teloa.business-widget/v1',version:'1.0.0',domain:'SOC',title:'告警'}
export const widget=(value:Record<string,unknown>):BusinessWidgetDefinition=>readBusinessWidgetDefinition({...widgetHead,...value})
export const dashboardOf=(widgets:string[],overrides:Record<string,unknown>={}):BusinessDashboardDefinition=>readBusinessDashboardDefinition({
 format:'teloa.business-dashboard/v1',id:'soc-overview',version:'1.0.0',domain:'SOC',title:'安全运营大盘',widgets,
 layout:widgets.map((id,index)=>({widget:id,x:0,y:index*2,w:12,h:2})),refresh:{kind:'every',seconds:300},acknowledgeShortInterval:false,...overrides,
})

/** 声明包替身：`forScope` 每次按当前的 widgets/dashboards 数组回一个包，测试可以在中途改声明。 */
export function definitionsOf(state:{widgets:BusinessWidgetDefinition[];dashboards:BusinessDashboardDefinition[]}):Pick<BusinessDefinitionSourceReader,'forScope'>{
 return {forScope:async(_db,_owner,scope)=>scope!=='SOC'?[]:[{
  origin:{kind:'market',loadId:'00000000-0000-4000-8000-000000000001'},scope:'SOC',domain:'SOC',
  objectTypes:[{source:source(alertTicket.id),definition:alertTicket}],views:[{source:source(riskView.id),definition:riskView}],actions:[],mappings:[],
  widgets:state.widgets.map(definition=>({source:source(definition.id),definition})),
  dashboards:state.dashboards.map(definition=>({source:source(definition.id),definition})),
  sources:new Map([['security-alert-http',{connected:true}]]),
 } satisfies BusinessDefinitionBundle]}
}

const SEVERITIES=['高','中','低']
/** 给 owner 写 count 条告警快照：严重度按 高/中/低 轮转，判定全是「还没有人看」。 */
export async function seedAlerts(pool:Pool,owner:string,count:number,prefix='alert'):Promise<void>{
 const at=Date.now()-60_000
 const items=Array.from({length:count},(_value,index)=>({
  scope:'SOC',type:'alert-ticket',id:prefix+'-'+index,version:1,title:'告警 '+index,source:'EDR',
  observedAt:new Date(at).toISOString(),receivedAt:new Date(at+1000).toISOString(),quality:'complete',summary:'说明',
  fields:[{label:'严重度',value:SEVERITIES[index%3]!},{label:'主机',value:'prod-'+index},{label:'当前判定',value:'还没有人看'}],
 }))
 const port={id:'security-alert-http',scopes:['SOC'],query:async()=>({schema:'teloa.data-source-page/v1',sourceId:'security-alert-http',scope:'SOC',capturedAt:new Date().toISOString(),items})}
 await new BusinessDataService(pool,port as never).query({ownerId:owner,scopeIds:['SOC']},{scope:'SOC',limit:count})
}

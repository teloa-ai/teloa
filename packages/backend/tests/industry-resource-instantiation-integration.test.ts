import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import type {MarketPluginInstallPreview,MarketPluginRegistrySource} from '@teloa/contract'
import {initializeMarketContents,MarketContentStore} from '../src/market/content-store.ts'
import type {PluginInstallation} from '../src/market/plugin-installations.ts'
import {
 createIndustryLoadSource,IndustryLoadService,initializeIndustryLoads,
 IndustryDataSourceService,IndustryDataSourceSource,initializeIndustryDataSources,
 IndustryMcpConnectionService,IndustryMcpConnectionSource,initializeIndustryMcpConnections,
 IndustryPluginService,IndustryPluginSource,initializeIndustryPlugins,
 IndustryExecutionToolService,IndustryExecutionToolSource,initializeIndustryExecutionTools,
} from '../src/index.ts'

/**
 * 这些服务用真实 MarketContentStore 读取固定内容时会发出 `SELECT ... FOR SHARE`，
 * 因此它们的预览与投影事务不能带 `read only`（PostgreSQL 25006）。
 * 其余单元测试都用假 source，只有本文件会在真实存储上暴露该冲突。
 */

let container:StartedPostgreSqlContainer,pool:Pool
before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start()
 pool=new Pool({connectionString:container.getConnectionUri()})
 await initializeMarketContents(pool)
 await initializeIndustryLoads(pool)
 await initializeIndustryDataSources(pool)
 await initializeIndustryMcpConnections(pool)
 await initializeIndustryPlugins(pool)
 await initializeIndustryExecutionTools(pool)
},{timeout:120000})
after(async()=>{await pool?.end();await container?.stop()})

const identity={id:randomUUID,now:()=>new Date().toISOString()}
const encode=(path:string,value:unknown)=>({path,bytes:new TextEncoder().encode(JSON.stringify(value))})
// 四个定义文件的内容照 examples/industry/安全运营/ 里的固定声明。
const dataSourceDefinition={format:'teloa.data-source/v1',sourceId:'security-alert-http',scopes:['SOC']}
const mcpDefinition={format:'teloa.mcp-connection/v1',serverName:'teloa_reference',tools:['read_reference']}
const pluginDefinition={format:'teloa.plugin/v1',registry:'npm',packageName:'dsh-visualize',version:'0.1.2'}
const executionToolDefinition={format:'teloa.execution-tool/v1',adapterId:'security-action-http',tools:['security.endpoint.isolate']}
const manifest={
 format:'teloa.business-package/v2',id:'security-operations',title:'安全运营',version:'1.0.0',domain:'SOC',description:'真实存储实例化集成验证。',
 resources:[
  {id:'alert-data',kind:'data-source',title:'告警数据来源',version:'1.0.0',required:true,source:{kind:'local',path:'data/alerts.json'}},
  {id:'alert-mcp',kind:'mcp',title:'告警参考连接',version:'1.0.0',required:true,source:{kind:'local',path:'connections/alerts.json'}},
  {id:'visualize-plugin',kind:'plugin',title:'可视化插件',version:'0.1.2',required:false,source:{kind:'local',path:'plugins/visualize.json'}},
  {id:'isolate-tool',kind:'execution-tool',title:'终端隔离执行工具',version:'1.0.0',required:false,source:{kind:'local',path:'tools/isolate.json'}},
 ],
 relations:[],entrypoints:[],
}

const sha=(value:string)=>createHash('sha256').update(value).digest('hex')
const registrySource:MarketPluginRegistrySource={registry:'npm',packageName:'dsh-visualize',version:'0.1.2'}
const preview:MarketPluginInstallPreview={schema:'teloa.market-plugin-install-preview/v1',source:registrySource,trust:{status:'verified',publisher:'Teloa Labs',integrity:'sha512-QWxhZGRpbjpjpbnRlZ3JpdHk='},bundleHash:sha('bundle'),permissionSummary:{permissions:[{id:'workspace.read',description:'读取当前工作区',required:true}]}}

async function fixture(){
 const owner='local:'+randomUUID(),actor={ownerId:owner,kind:'human' as const}
 const market=new MarketContentStore(pool,identity)
 const imported=await market.import(actor,{
  kind:'industry-template',requestId:randomUUID(),source:{kind:'upload',name:'集成验证模板'},manifestPath:'teloa.json',
  files:[
   encode('teloa.json',manifest),
   encode('data/alerts.json',dataSourceDefinition),
   encode('connections/alerts.json',mcpDefinition),
   encode('plugins/visualize.json',pluginDefinition),
   encode('tools/isolate.json',executionToolDefinition),
  ],
  references:[],
 })
 const loads=new IndustryLoadService(pool,identity,createIndustryLoadSource(market))
 const load=await loads.create(owner,{requestId:randomUUID(),contentId:imported.content.id,contentHash:imported.content.hash,target:{kind:'new',spaceId:randomUUID(),name:'集成验证空间'}})
 const item=(localId:string)=>{const found=load.items.find(value=>value.localId===localId);assert.ok(found,localId+' 未登记');assert.equal(found.status,'pending-adapter');return found}
 return {owner,market,loads,load,item}
}

test('数据源经真实固定内容存储登记并授权为已连接',async()=>{
 const {owner,market,loads,load,item}=await fixture()
 let probes=0
 const service=new IndustryDataSourceService(pool,identity,loads,new IndustryDataSourceSource(market,loads),{
  ready:async(definition,scope,signal)=>{probes+=1;assert.deepEqual(definition,dataSourceDefinition);assert.equal(scope,'SOC');assert.equal(signal.aborted,false);return {ready:true,probedAt:'2026-09-14T00:00:00.000Z'}},
 })
 const created=await service.instantiate(owner,{requestId:randomUUID(),loadId:load.id,itemInstanceId:item('alert-data').instanceId})
 assert.equal(created.state,'needs_authorization');assert.equal(created.revision,1);assert.equal(created.binding,null);assert.equal(created.scope,load.space.scope)
 assert.deepEqual(await service.get(owner,{instanceId:created.id}),created)
 assert.deepEqual((await service.list(owner,{})).items,[created])
 const active=await service.authorize(owner,{requestId:randomUUID(),instanceId:created.id,expectedRevision:created.revision},new AbortController().signal)
 assert.equal(active.state,'active');assert.equal(active.revision,2);assert.equal(probes,1)
 assert.equal(active.binding?.sourceId,'security-alert-http');assert.deepEqual(active.binding?.scopes,['SOC'])
 assert.deepEqual(await service.get(owner,{instanceId:created.id}),active)
 assert.deepEqual((await service.list(owner,{})).items,[active])
})

test('MCP 连接经真实固定内容存储登记并核验为已连接',async()=>{
 const {owner,market,loads,load,item}=await fixture()
 let probes=0
 const service=new IndustryMcpConnectionService(pool,identity,loads,new IndustryMcpConnectionSource(market,loads),{
  ready:async(definition,signal)=>{probes+=1;assert.deepEqual(definition,mcpDefinition);assert.equal(signal.aborted,false);return {ready:true,observedAt:'2026-09-14T00:00:00.000Z'}},
 })
 const created=await service.instantiate(owner,{requestId:randomUUID(),loadId:load.id,itemInstanceId:item('alert-mcp').instanceId})
 assert.equal(created.state,'needs_connection');assert.equal(created.revision,1);assert.equal(created.binding,null)
 assert.deepEqual(await service.get(owner,{instanceId:created.id}),created)
 assert.deepEqual((await service.list(owner,{})).items,[created])
 const active=await service.connect(owner,{requestId:randomUUID(),instanceId:created.id,expectedRevision:created.revision},new AbortController().signal)
 assert.equal(active.state,'active');assert.equal(active.revision,2);assert.equal(probes,1)
 assert.equal(active.binding?.serverName,'teloa_reference')
 assert.deepEqual(active.binding?.tools,[{raw:'read_reference',fullName:'mcp__teloa_reference__read_reference'}])
 assert.deepEqual(await service.get(owner,{instanceId:created.id}),active)
 assert.deepEqual((await service.list(owner,{})).items,[active])
})

test('插件经真实固定内容存储登记并按宿主安装回执投影',async()=>{
 const {owner,market,loads,load,item}=await fixture()
 const installation:PluginInstallation={id:randomUUID(),ownerId:owner,preview,state:'preparing',attempt:1,createdAt:'2026-09-14T00:00:00.000Z',updatedAt:'2026-09-14T00:00:00.000Z'}
 let installs=0
 const service=new IndustryPluginService(pool,identity,loads,new IndustryPluginSource(market,loads),{
  preview:async(actor,source)=>{assert.equal(actor,owner);assert.deepEqual(source,registrySource);return preview},
  install:async(actor,spec)=>{installs+=1;assert.equal(actor,owner);assert.deepEqual(spec.preview,preview);return installation},
  reconcile:async()=>installation,
  find:async()=>null,
 })
 const created=await service.instantiate(owner,{requestId:randomUUID(),loadId:load.id,itemInstanceId:item('visualize-plugin').instanceId})
 assert.equal(created.state,'needs_install');assert.equal(created.revision,1);assert.equal(created.installationId,null)
 assert.deepEqual(created.definition,pluginDefinition)
 assert.deepEqual(await service.get(owner,{instanceId:created.id}),created)
 assert.deepEqual((await service.list(owner,{})).items,[created])
 const installing=await service.install(owner,{requestId:randomUUID(),instanceId:created.id,expectedRevision:created.revision,preview})
 assert.equal(installing.state,'installing');assert.equal(installing.revision,2);assert.equal(installing.installationId,installation.id);assert.equal(installs,1)
 assert.deepEqual(await service.get(owner,{instanceId:created.id}),installing)
 assert.deepEqual((await service.list(owner,{})).items,[installing])
})

test('执行工具经真实固定内容存储登记并授权为已连接并授权',async()=>{
 const {owner,market,loads,load,item}=await fixture()
 let probes=0
 const service=new IndustryExecutionToolService(pool,identity,loads,new IndustryExecutionToolSource(market,loads),{
  ready:async(tool,signal)=>{probes+=1;assert.equal(tool,'security.endpoint.isolate');assert.equal(signal.aborted,false);return {ready:true}},
 })
 const created=await service.instantiate(owner,{requestId:randomUUID(),loadId:load.id,itemInstanceId:item('isolate-tool').instanceId})
 assert.equal(created.state,'needs_authorization');assert.equal(created.revision,1);assert.equal(created.binding,null)
 assert.deepEqual(await service.get(owner,{instanceId:created.id}),created)
 assert.deepEqual((await service.list(owner,{})).items,[created])
 const active=await service.authorize(owner,{requestId:randomUUID(),instanceId:created.id,expectedRevision:created.revision},new AbortController().signal)
 assert.equal(active.state,'active');assert.equal(active.revision,2);assert.equal(probes,1)
 assert.equal(active.binding?.adapterId,'security-action-http');assert.deepEqual(active.binding?.tools,['security.endpoint.isolate'])
 assert.deepEqual(await service.get(owner,{instanceId:created.id}),active)
 assert.deepEqual((await service.list(owner,{})).items,[active])
})

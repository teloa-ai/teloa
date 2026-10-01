import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {WorkError} from '@teloa/contract'
import {ConnectorProbeService,IndustryDataSourceService,IndustryExecutionToolService,IndustryMcpConnectionService,IndustryLoadService,initializeIndustryDataSources,initializeIndustryExecutionTools,initializeIndustryLoads,initializeIndustryMcpConnections,type IndustryLoadSource} from '../src/index.ts'

let container:StartedPostgreSqlContainer,pool:Pool
before(async()=>{process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock');process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock';container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()});await initializeIndustryLoads(pool);await initializeIndustryDataSources(pool);await initializeIndustryMcpConnections(pool);await initializeIndustryExecutionTools(pool)})
after(async()=>{await pool?.end();await container?.stop()})

const NOW='2026-09-14T00:00:00.000Z'
const dataSourceDefinition={format:'teloa.data-source/v1' as const,sourceId:'security-alert-http',scopes:['SOC']}
const mcpDefinition={format:'teloa.mcp-connection/v1' as const,serverName:'teloa_reference',tools:['read_reference']}
const executionToolDefinition={format:'teloa.execution-tool/v1' as const,adapterId:'security-action-http' as const,tools:['security.endpoint.isolate'] as ['security.endpoint.isolate']}
const TABLE={'data-source':'teloa_industry_data_source_instances',mcp:'teloa_industry_mcp_instances','execution-tool':'teloa_industry_execution_tool_instances'} as const

/**
 * 一次夹具搭出三类连接各一条固定映射的实例：创建阶段固定来源总能读出来（否则连登记都做不到），
 * `contentDrift` 只影响创建完成之后——模拟"探针要用的时候来源已经读不出来"，这正是不掩盖的那条测试要的时序。
 */
async function fixture(pool:Pool,options:{contentDrift?:boolean}={}){
 const owner=randomUUID(),identity={id:randomUUID,now:()=>NOW}
 const contentId=randomUUID(),contentHash='a'.repeat(64)
 const snapshot={templateId:'security',templateVersion:'1.0.0',title:'安全工作',domain:'SOC',description:'安全行业模板',resources:[
  {localId:'alert-source',kind:'data-source' as const,title:'告警来源',version:'1.0.0',required:true,available:true},
  {localId:'alert-mcp',kind:'mcp' as const,title:'告警连接',version:'1.0.0',required:true,available:true},
  {localId:'isolate-tool',kind:'execution-tool' as const,title:'隔离工具',version:'1.0.0',required:true,available:true},
 ],relations:[],entrypoints:[]}
 const loadSource:IndustryLoadSource={read:async()=>structuredClone(snapshot)}
 const loads=new IndustryLoadService(pool,identity,loadSource)
 const load=await loads.create(owner,{requestId:randomUUID(),contentId,contentHash,target:{kind:'new',spaceId:randomUUID(),name:'安全空间'}})
 const dsItem=load.items.find(item=>item.kind==='data-source')!,mcpItem=load.items.find(item=>item.kind==='mcp')!,toolItem=load.items.find(item=>item.kind==='execution-tool')!

 let available=true
 const reader=<T,>(definition:T)=>({read:async(db:Parameters<IndustryLoadService['getInTransaction']>[0],ownerId:string,input:{loadId:string;itemInstanceId:string})=>{
  if(!available)throw new WorkError('teloa/source-unavailable','来源已不可读。')
  const found=await loads.getInTransaction(db,ownerId,{loadId:input.loadId}),item=found.items.find(value=>value.instanceId===input.itemInstanceId)
  assert.ok(item)
  return {loadId:found.id,itemInstanceId:item.instanceId,itemLocalId:item.localId,contentId:found.contentId,contentHash:found.contentHash,itemVersion:item.version,fileHash:'f'.repeat(64),definition}
 }})
 const dataSourceReader=reader(dataSourceDefinition),mcpReader=reader(mcpDefinition),executionToolReader=reader(executionToolDefinition)

 const readiness:Record<'data-source'|'mcp'|'execution-tool',(...args:any[])=>Promise<any>>={
  'data-source':async()=>({ready:true as const,probedAt:NOW}),
  mcp:async()=>({ready:true as const,observedAt:NOW}),
  'execution-tool':async()=>({ready:true as const}),
 }

 const dataSourceService=new IndustryDataSourceService(pool,identity,loads,dataSourceReader,{ready:(...args:any[])=>readiness['data-source'](...args)})
 const mcpService=new IndustryMcpConnectionService(pool,identity,loads,mcpReader,{ready:(...args:any[])=>readiness.mcp(...args)})
 const executionToolService=new IndustryExecutionToolService(pool,identity,loads,executionToolReader,{ready:(...args:any[])=>readiness['execution-tool'](...args)})

 const dataSourceInstance=await dataSourceService.instantiate(owner,{requestId:randomUUID(),loadId:load.id,itemInstanceId:dsItem.instanceId})
 const mcpInstance=await mcpService.instantiate(owner,{requestId:randomUUID(),loadId:load.id,itemInstanceId:mcpItem.instanceId})
 const executionToolInstance=await executionToolService.instantiate(owner,{requestId:randomUUID(),loadId:load.id,itemInstanceId:toolItem.instanceId})

 if(options.contentDrift)available=false

 const service=new ConnectorProbeService(pool,identity,{
  'data-source':{read:dataSourceReader.read,ready:(...args:any[])=>readiness['data-source'](...args)},
  mcp:{read:mcpReader.read,ready:(...args:any[])=>readiness.mcp(...args)},
  'execution-tool':{read:executionToolReader.read,ready:(...args:any[])=>readiness['execution-tool'](...args)},
 })

 return {
  owner,service,readiness,now:NOW,signal:new AbortController().signal,
  dataSourceId:dataSourceInstance.id,mcpId:mcpInstance.id,executionToolId:executionToolInstance.id,
  row:async(kind:keyof typeof TABLE,id:string)=>(await pool.query(`select * from ${TABLE[kind]} where id=$1`,[id])).rows[0],
 }
}

test('三类连接各探一次，成功给时刻，失败给可读原因',async()=>{
 const f=await fixture(pool)
 assert.deepEqual(await f.service.probe(f.owner,{kind:'data-source',instanceId:f.dataSourceId},f.signal),{kind:'data-source',instanceId:f.dataSourceId,probedAt:f.now,ok:true})
 assert.deepEqual(await f.service.probe(f.owner,{kind:'execution-tool',instanceId:f.executionToolId},f.signal),{kind:'execution-tool',instanceId:f.executionToolId,probedAt:f.now,ok:true})
 f.readiness['mcp']=async()=>({ready:false,reason:'MCP 服务当前没有登记这些工具。'})
 assert.deepEqual(await f.service.probe(f.owner,{kind:'mcp',instanceId:f.mcpId},f.signal),{kind:'mcp',instanceId:f.mcpId,probedAt:f.now,ok:false,reason:'MCP 服务当前没有登记这些工具。'})
})

test('探针不推进任何状态：revision、binding、updated_at 逐列不变',async()=>{
 const f=await fixture(pool),before=await f.row('data-source',f.dataSourceId)
 await f.service.probe(f.owner,{kind:'data-source',instanceId:f.dataSourceId},f.signal)
 assert.deepEqual(await f.row('data-source',f.dataSourceId),before)
 assert.equal((await pool.query('select count(*)::int count from teloa_industry_data_source_authorize_requests where owner_id=$1',[f.owner])).rows[0].count,0)
})

test('不属于本人的实例、未知 kind、多余键一律拒绝',async()=>{
 const f=await fixture(pool)
 await assert.rejects(f.service.probe('别人',{kind:'data-source',instanceId:f.dataSourceId},f.signal),{code:'teloa/forbidden'})
 await assert.rejects(f.service.probe(f.owner,{kind:'plugin',instanceId:f.dataSourceId},f.signal),{code:'teloa/invalid-input'})
 await assert.rejects(f.service.probe(f.owner,{kind:'data-source',instanceId:f.dataSourceId,expectedRevision:2},f.signal),{code:'teloa/invalid-input'})
})

test('来源已漂移时探针不掩盖：先报固定来源读不出来',async()=>{
 const f=await fixture(pool,{contentDrift:true})
 await assert.rejects(f.service.probe(f.owner,{kind:'data-source',instanceId:f.dataSourceId},f.signal),{code:'teloa/source-unavailable'})
})

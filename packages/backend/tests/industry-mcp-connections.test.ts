import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import type {IndustryMcpConnectionDefinition} from '@teloa/contract'
import {IndustryMcpConnectionService,IndustryLoadService,initializeIndustryMcpConnections,initializeIndustryLoads,initializeIndustryRoles,type IndustryMcpConnectionSourceSnapshot,type IndustryLoadSource} from '../src/index.ts'

let container:StartedPostgreSqlContainer,pool:Pool
before(async()=>{process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock');process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock';container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()});await initializeIndustryLoads(pool);await initializeIndustryMcpConnections(pool);await initializeIndustryRoles(pool)})
after(async()=>{await pool?.end();await container?.stop()})

const contentId=randomUUID(),contentHash='a'.repeat(64),snapshot={templateId:'security',templateVersion:'1.0.0',title:'安全工作',domain:'SOC',description:'安全行业模板',resources:[{localId:'alert-mcp',kind:'mcp' as const,title:'告警连接',version:'1.0.0',required:true,available:true}],relations:[],entrypoints:[]}
const source:IndustryLoadSource={read:async()=>structuredClone(snapshot)}
const fixedDefinition={format:'teloa.mcp-connection/v1' as const,serverName:'teloa_reference',tools:['read_reference']}
const sourceReader=(loads:IndustryLoadService,read?:(value:IndustryMcpConnectionSourceSnapshot)=>IndustryMcpConnectionSourceSnapshot)=>({read:async(db:Parameters<IndustryLoadService['getInTransaction']>[0],owner:string,input:{loadId:string;itemInstanceId:string})=>{const load=await loads.getInTransaction(db,owner,{loadId:input.loadId}),item=load.items.find(value=>value.instanceId===input.itemInstanceId);assert.ok(item);const value={loadId:load.id,itemInstanceId:item.instanceId,itemLocalId:item.localId,contentId:load.contentId,contentHash:load.contentHash,itemVersion:item.version,fileHash:'f'.repeat(64),definition:fixedDefinition};return read?read(value):value}})
const ready={ready:async()=>({ready:true as const,observedAt:'2026-09-14T00:00:00.000Z'})}

test('行业 MCP 连接只登记固定加载映射并保持待连接',async()=>{
 const owner=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()},loads=new IndustryLoadService(pool,identity,source)
 const load=await loads.create(owner,{requestId:randomUUID(),contentId,contentHash,target:{kind:'new',spaceId:randomUUID(),name:'SOC'}})
 const service=new IndustryMcpConnectionService(pool,identity,loads,sourceReader(loads),ready),requestId=randomUUID(),input={requestId,loadId:load.id,itemInstanceId:load.items[0]!.instanceId}
 const first=await service.instantiate(owner,input),retry=await service.instantiate(owner,input)
 assert.deepEqual(retry,first);assert.equal(first.state,'needs_connection');assert.equal(first.revision,1);assert.equal(first.scope,load.space.scope)
 assert.deepEqual((await service.list(owner,{})).items,[first]);assert.deepEqual(await service.get(owner,{instanceId:first.id}),first)
 assert.equal((await pool.query('select count(*)::int count from teloa_industry_mcp_instances where owner_id=$1',[owner])).rows[0].count,1)
})

test('行业 MCP 连接拒绝执行工具目标、跨本人读取及损坏固定映射',async()=>{
 const owner=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()},executionTool:IndustryLoadSource={read:async()=>({...snapshot,resources:[{...snapshot.resources[0]!,kind:'execution-tool' as const}]})},loads=new IndustryLoadService(pool,identity,executionTool)
 const load=await loads.create(owner,{requestId:randomUUID(),contentId:randomUUID(),contentHash:'b'.repeat(64),target:{kind:'new',spaceId:randomUUID(),name:'执行空间'}}),service=new IndustryMcpConnectionService(pool,identity,loads,sourceReader(loads),ready)
 await assert.rejects(service.instantiate(owner,{requestId:randomUUID(),loadId:load.id,itemInstanceId:load.items[0]!.instanceId}),{code:'teloa/conflict'})
 const properLoads=new IndustryLoadService(pool,identity,source),proper=await properLoads.create(owner,{requestId:randomUUID(),contentId:randomUUID(),contentHash:'c'.repeat(64),target:{kind:'new',spaceId:randomUUID(),name:'连接空间'}}),properService=new IndustryMcpConnectionService(pool,identity,properLoads,sourceReader(properLoads),ready),saved=await properService.instantiate(owner,{requestId:randomUUID(),loadId:proper.id,itemInstanceId:proper.items[0]!.instanceId})
 await assert.rejects(properService.get('other',{instanceId:saved.id}),{code:'teloa/forbidden'})
 await pool.query('update teloa_industry_mcp_instances set item_local_id=$2 where id=$1',[saved.id,'other'])
 await assert.rejects(properService.get(owner,{instanceId:saved.id}),{code:'teloa/storage-corrupt'})
})

test('真实 readiness 通过后激活并以同一请求恢复固定连接回执',async()=>{
 const owner=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()},loads=new IndustryLoadService(pool,identity,source),load=await loads.create(owner,{requestId:randomUUID(),contentId:randomUUID(),contentHash:'d'.repeat(64),target:{kind:'new',spaceId:randomUUID(),name:'连接授权空间'}})
 let probes=0,available=true
 const readiness={ready:async(definition:IndustryMcpConnectionDefinition,signal:AbortSignal)=>{probes+=1;assert.deepEqual(definition,fixedDefinition);assert.equal(signal.aborted,false);return available?{ready:true as const,observedAt:'2026-09-14T00:00:00.000Z'}:{ready:false as const,reason:'offline'}}}
 const service=new IndustryMcpConnectionService(pool,identity,loads,sourceReader(loads),readiness),created=await service.instantiate(owner,{requestId:randomUUID(),loadId:load.id,itemInstanceId:load.items[0]!.instanceId}),requestId=randomUUID(),command={requestId,instanceId:created.id,expectedRevision:created.revision},active=await service.connect(owner,command,new AbortController().signal)
 assert.equal(active.state,'active');assert.equal(active.revision,2);assert.deepEqual(active.binding,{serverName:'teloa_reference',tools:[{raw:'read_reference',fullName:'mcp__teloa_reference__read_reference'}],definitionHash:active.binding?.definitionHash,observedAt:'2026-09-14T00:00:00.000Z'});assert.match(active.binding!.definitionHash,/^[a-f0-9]{64}$/)
 available=false
 assert.deepEqual(await service.connect(owner,command,new AbortController().signal),active)
 assert.equal(probes,1)
 await assert.rejects(service.connect(owner,{...command,expectedRevision:2},new AbortController().signal),{code:'teloa/conflict'})
 assert.deepEqual(await service.get(owner,{instanceId:created.id}),active)
})

test('MCP 连接未就绪时不写连接状态或回执',async()=>{
 const owner=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()},loads=new IndustryLoadService(pool,identity,source),load=await loads.create(owner,{requestId:randomUUID(),contentId:randomUUID(),contentHash:'e'.repeat(64),target:{kind:'new',spaceId:randomUUID(),name:'未连接空间'}}),service=new IndustryMcpConnectionService(pool,identity,loads,sourceReader(loads),{ready:async()=>({ready:false as const,reason:'missing tool'})}),created=await service.instantiate(owner,{requestId:randomUUID(),loadId:load.id,itemInstanceId:load.items[0]!.instanceId}),requestId=randomUUID()
 await assert.rejects(service.connect(owner,{requestId,instanceId:created.id,expectedRevision:1},new AbortController().signal),{code:'teloa/dependency-unavailable'})
 assert.deepEqual(await service.get(owner,{instanceId:created.id}),created)
 assert.equal((await pool.query('select count(*)::int count from teloa_industry_mcp_connect_requests where owner_id=$1 and request_id=$2',[owner,requestId])).rows[0].count,0)
})

test('连接拒绝客户端伪造定义以及核验期间发生的固定来源漂移',async()=>{
 const owner=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()},loads=new IndustryLoadService(pool,identity,source),load=await loads.create(owner,{requestId:randomUUID(),contentId:randomUUID(),contentHash:'1'.repeat(64),target:{kind:'new',spaceId:randomUUID(),name:'漂移空间'}})
 let reads=0
 const drifting=sourceReader(loads,value=>{reads+=1;return reads<=2?value:{...value,fileHash:'0'.repeat(64)}}),service=new IndustryMcpConnectionService(pool,identity,loads,drifting,ready),created=await service.instantiate(owner,{requestId:randomUUID(),loadId:load.id,itemInstanceId:load.items[0]!.instanceId})
 await assert.rejects(service.connect(owner,{requestId:randomUUID(),instanceId:created.id,expectedRevision:1,serverName:'forged'},new AbortController().signal),{code:'teloa/invalid-input'})
 await assert.rejects(service.connect(owner,{requestId:randomUUID(),instanceId:created.id,expectedRevision:1},new AbortController().signal),{code:'teloa/source-unavailable'})
 assert.equal((await service.get(owner,{instanceId:created.id})).state,'needs_connection')
})

test('并发连接只有一个请求能推进同一预期版本',async()=>{
 const owner=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()},loads=new IndustryLoadService(pool,identity,source),load=await loads.create(owner,{requestId:randomUUID(),contentId:randomUUID(),contentHash:'2'.repeat(64),target:{kind:'new',spaceId:randomUUID(),name:'并发空间'}}),service=new IndustryMcpConnectionService(pool,identity,loads,sourceReader(loads),ready),created=await service.instantiate(owner,{requestId:randomUUID(),loadId:load.id,itemInstanceId:load.items[0]!.instanceId}),signal=new AbortController().signal
 const settled=await Promise.allSettled([service.connect(owner,{requestId:randomUUID(),instanceId:created.id,expectedRevision:1},signal),service.connect(owner,{requestId:randomUUID(),instanceId:created.id,expectedRevision:1},signal)])
 assert.equal(settled.filter(result=>result.status==='fulfilled').length,1)
 const failure=settled.find(result=>result.status==='rejected') as PromiseRejectedResult
 assert.equal(failure.reason.code,'teloa/version-conflict')
 assert.equal((await service.get(owner,{instanceId:created.id})).revision,2)
})

test('已激活实例的 binding 工具完整名被篡改后读取即判定损坏',async()=>{
 const owner=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()},loads=new IndustryLoadService(pool,identity,source),load=await loads.create(owner,{requestId:randomUUID(),contentId:randomUUID(),contentHash:'3'.repeat(64),target:{kind:'new',spaceId:randomUUID(),name:'篡改空间'}})
 const service=new IndustryMcpConnectionService(pool,identity,loads,sourceReader(loads),ready),created=await service.instantiate(owner,{requestId:randomUUID(),loadId:load.id,itemInstanceId:load.items[0]!.instanceId})
 const active=await service.connect(owner,{requestId:randomUUID(),instanceId:created.id,expectedRevision:1},new AbortController().signal)
 assert.equal(active.state,'active')
 await pool.query(`update teloa_industry_mcp_instances set binding=jsonb_set(binding,'{tools,0,fullName}','"mcp__x__y"') where id=$1`,[created.id])
 await assert.rejects(service.get(owner,{instanceId:created.id}),{code:'teloa/storage-corrupt'})
})

test('固定来源漂移后目录投影为待连接并保留绑定，写路径仍判定来源不可用',async()=>{
 const owner=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()},loads=new IndustryLoadService(pool,identity,source),load=await loads.create(owner,{requestId:randomUUID(),contentId:randomUUID(),contentHash:'4'.repeat(64),target:{kind:'new',spaceId:randomUUID(),name:'漂移投影空间'}})
 let drifted=false
 const reader=sourceReader(loads,value=>drifted?{...value,fileHash:'0'.repeat(64)}:value),service=new IndustryMcpConnectionService(pool,identity,loads,reader,ready)
 const created=await service.instantiate(owner,{requestId:randomUUID(),loadId:load.id,itemInstanceId:load.items[0]!.instanceId})
 const active=await service.connect(owner,{requestId:randomUUID(),instanceId:created.id,expectedRevision:1},new AbortController().signal)
 assert.equal(active.state,'active');assert.ok(!('drift' in active))
 drifted=true
 const projected=await service.get(owner,{instanceId:created.id})
 assert.deepEqual(projected,{...active,state:'needs_connection',drift:true})
 assert.deepEqual(await service.list(owner,{}),{items:[projected]})
 await assert.rejects(service.instantiate(owner,{requestId:randomUUID(),loadId:load.id,itemInstanceId:load.items[0]!.instanceId}),{code:'teloa/source-unavailable'})
 await assert.rejects(service.connect(owner,{requestId:randomUUID(),instanceId:created.id,expectedRevision:projected.revision},new AbortController().signal),{code:'teloa/source-unavailable'})
 const stored=(await pool.query('select state,revision,binding from teloa_industry_mcp_instances where id=$1',[created.id])).rows[0]
 assert.equal(stored.state,'active');assert.equal(stored.revision,2);assert.deepEqual(stored.binding,active.binding)
 assert.equal((await pool.query('select count(*)::int count from teloa_industry_mcp_connect_requests where owner_id=$1',[owner])).rows[0].count,1)
})

test('目录逐行容错：损坏的 MCP 连接实例只记入 errors，其余实例照常返回',async()=>{
 const owner=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()},loads=new IndustryLoadService(pool,identity,source)
 const first=await loads.create(owner,{requestId:randomUUID(),contentId:randomUUID(),contentHash:'5'.repeat(64),target:{kind:'new',spaceId:randomUUID(),name:'容错空间甲'}})
 const second=await loads.create(owner,{requestId:randomUUID(),contentId:randomUUID(),contentHash:'6'.repeat(64),target:{kind:'new',spaceId:randomUUID(),name:'容错空间乙'}})
 const service=new IndustryMcpConnectionService(pool,identity,loads,sourceReader(loads),ready)
 const broken=await service.instantiate(owner,{requestId:randomUUID(),loadId:first.id,itemInstanceId:first.items[0]!.instanceId})
 const good=await service.instantiate(owner,{requestId:randomUUID(),loadId:second.id,itemInstanceId:second.items[0]!.instanceId})
 await pool.query('update teloa_industry_mcp_instances set item_local_id=$2 where id=$1',[broken.id,'tampered'])
 assert.deepEqual(await service.list(owner,{}),{items:[good],errors:[{instanceId:broken.id,code:'teloa/storage-corrupt'}]})
 await assert.rejects(service.get(owner,{instanceId:broken.id}),{code:'teloa/storage-corrupt'})
})


test('运行态只向已关联岗位暴露已连接 MCP 的冻结完整工具名，并在解绑或来源漂移时撤回',async()=>{
 const owner=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()},loads=new IndustryLoadService(pool,identity,source),load=await loads.create(owner,{requestId:randomUUID(),contentId:randomUUID(),contentHash:'7'.repeat(64),target:{kind:'new',spaceId:randomUUID(),name:'运行授权空间'}})
 let drifted=false
 const reader=sourceReader(loads,value=>drifted?{...value,fileHash:'0'.repeat(64)}:value)
 const service=new IndustryMcpConnectionService(pool,identity,loads,reader,ready),item=load.items[0]!,created=await service.instantiate(owner,{requestId:randomUUID(),loadId:load.id,itemInstanceId:item.instanceId}),active=await service.connect(owner,{requestId:randomUUID(),instanceId:created.id,expectedRevision:created.revision},new AbortController().signal)
 const roleId=randomUUID(),instanceId=randomUUID(),now=identity.now()
 await pool.query(`insert into teloa_industry_role_instances(id,owner_id,load_id,item_instance_id,item_local_id,scope,definition,definition_hash,knowledge,omitted_knowledge,declarations,downstream_request_id,mapping_digest,role_id,phase,revision,failure_code,failure_message,created_at,updated_at) values($1,$2,$3,$4,$5,$6,'{}',$7,'[]','[]',$8,$9,$10,$11,'prepared',1,null,null,$12,$12)`,[instanceId,owner,load.id,randomUUID(),'运行岗位',load.space.scope,'a'.repeat(64),JSON.stringify([{kind:'mcp',itemInstanceId:item.instanceId,status:'pending-adapter'}]),randomUUID(),'b'.repeat(64),roleId,now])
 const db=await pool.connect()
 try{
  await db.query('begin')
  assert.deepEqual(await service.activeToolRulesForRoleInTransaction(db,owner,roleId),[{name:'mcp__teloa_reference__read_reference',anyArguments:true,allowed:[]}])
  await db.query('commit')
 }finally{db.release()}
 await pool.query("update teloa_industry_mcp_instances set state='detached',revision=revision+1 where id=$1",[active.id])
 const detached=await pool.connect()
 try{await detached.query('begin');assert.deepEqual(await service.activeToolRulesForRoleInTransaction(detached,owner,roleId),[]);await detached.query('commit')}finally{detached.release()}
 await pool.query("update teloa_industry_mcp_instances set state='active',revision=revision+1 where id=$1",[active.id])
 drifted=true
 const stale=await pool.connect()
 try{await stale.query('begin');await assert.rejects(service.activeToolRulesForRoleInTransaction(stale,owner,roleId),{code:'teloa/source-unavailable'});await stale.query('rollback')}finally{stale.release()}
})

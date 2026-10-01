import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {initializeRoles,RoleService} from '../src/work/roles.ts'
import {initializeTasks,TaskService} from '../src/work/tasks.ts'
import {businessObjectSnapshotHash,BusinessDataService,initializeBusinessData,type BusinessDataQuery,type BusinessDataSourcePort} from '../src/work/business-data.ts'
import {BusinessTaskService,initializeBusinessTasks,readBusinessTaskSource} from '../src/work/business-tasks.ts'
import type {BusinessDefinitionBundle} from '../src/work/business-definition-source.ts'
import type {IndustryWorkSnapshot} from '../src/work/industry-work-source.ts'
import {ObjectConversationService,initializeObjectConversations} from '../src/work/object-conversations.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'
import {businessTaskSourceDigest} from '../src/work/business-task-source-digest.ts'
import {readRunBusinessContext} from '../src/work/task-run-business-context.ts'
import {readBusinessSourceMappingDefinition,type IndustryModelPhase} from '@teloa/contract'
import {MarketContentStore,initializeMarketContents} from '../src/market/content-store.ts'
import {IndustryLoadService,initializeIndustryLoads} from '../src/work/industry-loads.ts'
import {createIndustryLoadSource} from '../src/work/industry-load-source.ts'
import {IndustryWorkSource} from '../src/work/industry-work-source.ts'
import {BusinessSpaceService} from '../src/work/business-spaces.ts'
import {initializeTaskRuns} from '../src/work/task-runs.ts'
import {initializeArtifactSnapshots} from '../src/work/artifact-snapshots.ts'
import {initializeArtifacts} from '../src/work/artifacts.ts'
import {initializeTaskCompletions} from '../src/work/task-transitions.ts'

let container:StartedPostgreSqlContainer,pool:Pool
const identity={id:randomUUID,now:()=>new Date().toISOString()}
const alert={scope:'SOC',type:'alert',id:'evt-1842',version:1,title:'prod-03 异常脚本与外联',source:'EDR',observedAt:'2026-09-12T01:00:00.000Z',receivedAt:'2026-09-12T01:00:01.000Z',quality:'complete' as const,summary:'需要关联账号与维护窗口后调查。',fields:[{label:'资产',value:'prod-03'},{label:'责任人',value:'生产运维组'}]}
const port:BusinessDataSourcePort={id:'security-alert-http',scopes:['SOC'],query:async(input:BusinessDataQuery)=>({schema:'teloa.data-source-page/v1',sourceId:'security-alert-http',scope:input.scope,capturedAt:'2026-09-12T01:00:02.000Z',items:[alert]})}

before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()})
 await initializeRoles(pool);await initializeTasks(pool);await initializeBusinessData(pool);await initializeBusinessTasks(pool);await initializeObjectConversations(pool)
 await initializeMarketContents(pool);await initializeIndustryLoads(pool)
 await initializeTaskRuns(pool);await initializeArtifactSnapshots(pool);await initializeArtifacts(pool);await initializeTaskCompletions(pool)
},{timeout:180_000})
after(async()=>{await pool?.end();await container?.stop()})

async function fixture(){
 const owner=randomUUID(),page=await new BusinessDataService(pool,port).query({ownerId:owner,scopeIds:['SOC']},{scope:'SOC',limit:10}),snapshot=page.items[0]!
 return {owner,snapshot,service:new BusinessTaskService(pool,identity,new TaskService(pool,identity))}
}

test('从固定告警快照并发创建唯一调查任务并持久恢复来源',async()=>{
 const {owner,snapshot,service}=await fixture(),input={requestId:randomUUID(),reference:{scope:snapshot.scope,type:snapshot.type,id:snapshot.id,version:snapshot.version,snapshotHash:snapshot.snapshotHash},goal:'核对相关账号、进程与维护窗口'}
 const [a,b]=await Promise.all([service.create({ownerId:owner,scopeIds:['SOC']},input),service.create({ownerId:owner,scopeIds:['SOC']},input)])
 assert.deepEqual(a,b);assert.equal(a.task.title,'调查：prod-03 异常脚本与外联');assert.equal(a.task.scope,'SOC');assert.equal(a.task.state,'ready')
 assert.deepEqual(a.source.reference,input.reference);assert.equal(a.source.sourceId,'security-alert-http');assert.equal(a.source.taskId,a.task.id)
 assert.equal((await pool.query('select snapshot_digest from teloa_business_task_sources where task_id=$1',[a.task.id])).rows[0].snapshot_digest,businessTaskSourceDigest(a.source))
 assert.deepEqual(await new BusinessTaskService(pool,identity,new TaskService(pool,identity)).source({ownerId:owner,scopeIds:['SOC']},{taskId:a.task.id}),a.source)
 assert.equal((await pool.query('select count(*)::int n from teloa_tasks where owner_id=$1',[owner])).rows[0].n,1)
 assert.equal((await pool.query('select count(*)::int n from teloa_business_task_sources where owner_id=$1',[owner])).rows[0].n,1)
})

test('MCP 来源身份带斜杠时独立进程重连仍读回固定任务来源',async()=>{
 const {owner,snapshot,service}=await fixture(),actor={ownerId:owner,scopeIds:['SOC']},sourceId='acc_business_sync/list_items'
 await pool.query('update teloa_business_object_snapshots set source_id=$2 where owner_id=$1',[owner,sourceId])
 const created=await service.create(actor,{requestId:randomUUID(),reference:{scope:'SOC',type:snapshot.type,id:snapshot.id,version:snapshot.version,snapshotHash:snapshot.snapshotHash},goal:'核对 MCP 告警'})
 assert.equal(created.source.sourceId,sourceId)
 const script=`import {Pool} from 'pg';import {BusinessTaskService} from ${JSON.stringify(new URL('../src/work/business-tasks.ts',import.meta.url).href)};import {TaskService} from ${JSON.stringify(new URL('../src/work/tasks.ts',import.meta.url).href)};
  const pool=new Pool({connectionString:process.env.TEST_PG_URI});const identity={id:()=>crypto.randomUUID(),now:()=>new Date().toISOString()};const service=new BusinessTaskService(pool,identity,new TaskService(pool,identity));
  try{const actor={ownerId:process.env.TEST_OWNER,scopeIds:['SOC']};const source=await service.source(actor,{taskId:process.env.TEST_TASK});const page=await service.listForObject(actor,{scope:'SOC',type:'alert',id:'evt-1842'});console.log(JSON.stringify({source,item:page.items[0]}))}finally{await pool.end()}`
 const output=execFileSync(process.execPath,['--input-type=module','-e',script],{cwd:fileURLToPath(new URL('../',import.meta.url)),encoding:'utf8',env:{...process.env,TEST_PG_URI:container.getConnectionUri(),TEST_OWNER:owner,TEST_TASK:created.task.id}})
 const restored=JSON.parse(output)
 assert.deepEqual(restored.source,created.source)
 assert.deepEqual(restored.item?.source,created.source)
 assert.equal(restored.item?.task.id,created.task.id)
})

test('契约允许的最长 MCP 工具来源可进入固定任务引用',async()=>{
 const serverName='s'.repeat(64),tool='t'.repeat(128)
 const mapping=readBusinessSourceMappingDefinition({
  format:'teloa.business-source-mapping/v1',id:'long-mcp-source',version:'1.0.0',domain:'SOC',title:'长名称告警来源',objectType:'alert',
  source:{kind:'mcp-tool',serverName,tool,arguments:{},itemsPath:'$.items[*]'},
  mapping:[{path:'$.alert_number',field:'alert_number'}],primaryKey:['alert_number'],deletionSemantics:'compare',schedule:{kind:'every',seconds:60},acknowledgeShortInterval:false,
 })
 assert.equal(mapping.source.kind,'mcp-tool')
 const sourceId=serverName+'/'+tool
 assert.equal(sourceId.length,193)
 const {owner,snapshot,service}=await fixture(),actor={ownerId:owner,scopeIds:['SOC']}
 await pool.query('update teloa_business_object_snapshots set source_id=$2 where owner_id=$1',[owner,sourceId])
 const reference={scope:snapshot.scope,type:snapshot.type,id:snapshot.id,version:snapshot.version,snapshotHash:snapshot.snapshotHash}
 assert.deepEqual((await service.reference(actor,reference)).sourceId,sourceId)
 const created=await service.create(actor,{requestId:randomUUID(),reference,goal:'核对受管告警'})
 assert.equal(created.source.sourceId,sourceId)
 assert.equal((await service.source(actor,{taskId:created.task.id}))?.sourceId,sourceId)
})

test('调查任务上下文返回创建时固定的完整告警快照',async()=>{
 const {owner,snapshot,service}=await fixture()
 const created=await service.create({ownerId:owner,scopeIds:['SOC']},{requestId:randomUUID(),reference:{scope:snapshot.scope,type:snapshot.type,id:snapshot.id,version:snapshot.version,snapshotHash:snapshot.snapshotHash},goal:'研判告警'})
 const context=await service.context({ownerId:owner,scopeIds:['SOC']},{taskId:created.task.id})
 assert.deepEqual(context,{source:created.source,object:snapshot})
})

test('交办预备只读核固定对象快照与授权，不创建任务或信任调用方标题',async()=>{
 const {owner,snapshot,service}=await fixture(),reference={scope:snapshot.scope,type:snapshot.type,id:snapshot.id,version:snapshot.version,snapshotHash:snapshot.snapshotHash}
 const resolved=await service.reference({ownerId:owner,scopeIds:['SOC']},reference)
 assert.deepEqual(resolved,{reference,object:snapshot,sourceId:'security-alert-http'})
 assert.equal((await pool.query('select count(*)::int n from teloa_tasks where owner_id=$1',[owner])).rows[0].n,0)
 await assert.rejects(service.reference({ownerId:owner,scopeIds:['AppSec']},reference),{code:'teloa/forbidden'})
 await assert.rejects(service.reference({ownerId:randomUUID(),scopeIds:['SOC']},reference),{code:'teloa/forbidden'})
 await assert.rejects(service.reference({ownerId:owner,scopeIds:['SOC']},{...reference,version:reference.version+1}),{code:'teloa/version-conflict'})
 await assert.rejects(service.reference({ownerId:owner,scopeIds:['SOC']},{...reference,snapshotHash:'b'.repeat(64)}),{code:'teloa/version-conflict'})
 assert.equal((await pool.query('select count(*)::int n from teloa_tasks where owner_id=$1',[owner])).rows[0].n,0)
})

test('默认业务动作固定当前声明、工作模板与映射输入',async()=>{
 const {owner,snapshot}=await fixture(),loadId=randomUUID(),itemInstanceId=randomUUID(),contentId=randomUUID()
 const source={loadId,scope:'SOC',localId:'assign-alert-review',version:'1.0.0',contentHash:'a'.repeat(64),fileHash:'b'.repeat(64),definitionHash:'c'.repeat(64),origin:'template' as const}
 const template:IndustryWorkSnapshot={loadId,itemInstanceId,itemLocalId:'alert-triage-review',contentId,contentHash:'a'.repeat(64),templateId:'alert-triage-review',templateVersion:'1.0.0',fileHash:'d'.repeat(64),title:'告警研判',method:'核对告警上下文。',requirements:['主机','告警标题','告警摘要'],output:'研判结论',skills:[],scope:'SOC'}
 const bundle:BusinessDefinitionBundle={origin:{kind:'market',loadId},scope:'SOC',domain:'SOC',sources:new Map(),views:[],mappings:[],widgets:[],dashboards:[],objectTypes:[{source:{...source,localId:'alert',definitionHash:'e'.repeat(64)},definition:{format:'teloa.business-object-type/v1',id:'alert',version:'1.0.0',domain:'SOC',title:'告警',unit:'条',lead:'待研判',sourceId:'security-alert-http',fields:[{name:'asset',label:'资产',type:'text',required:true,from:'资产'}]} }],actions:[{source,definition:{format:'teloa.business-action/v1',id:'assign-alert-review',version:'1.0.0',domain:'SOC',title:'研判此告警',objectType:'alert',target:{kind:'work-template',localId:'alert-triage-review'},inputs:[{from:'field',field:'asset'},{from:'object',part:'title'},{from:'object',part:'summary'}]}}]}
 const service=new BusinessTaskService(pool,identity,new TaskService(pool,identity),{definitions:{forScope:async()=>[bundle]},loads:{getInTransaction:async()=>({id:loadId,items:[{localId:'alert-triage-review',instanceId:itemInstanceId,kind:'work-template',status:'pending-adapter'}]}) as never},works:{read:async()=>template,assertModelsReady:async()=>{}}})
 const created=await service.create({ownerId:owner,scopeIds:['SOC']},{requestId:randomUUID(),reference:{scope:'SOC',type:snapshot.type,id:snapshot.id,version:snapshot.version,snapshotHash:snapshot.snapshotHash},goal:'研判当前告警',actionId:'assign-alert-review'})
 assert.equal(created.task.title,'告警研判')
 const context=await service.context({ownerId:owner,scopeIds:['SOC']},{taskId:created.task.id})
 assert.deepEqual(context?.action?.inputs,['prod-03','prod-03 异常脚本与外联','需要关联账号与维护窗口后调查。'])
 assert.equal(context?.action?.template.templateId,'alert-triage-review')
 assert.equal(context?.action?.action.definitionHash,'c'.repeat(64))
 assert.equal((await pool.query('select count(*)::int n from teloa_business_task_action_sources where task_id=$1',[created.task.id])).rows[0].n,1)
 assert.deepEqual(readRunBusinessContext({taskId:created.task.id,sourceId:created.source.sourceId,object:context?.object,action:context?.action})?.action,context?.action)
 const executionBundle:BusinessDefinitionBundle={...bundle,actions:[{...bundle.actions[0]!,definition:{...bundle.actions[0]!.definition,target:{kind:'execution-tool',localId:'isolate-alert',tool:'security.endpoint.isolate',workTemplate:'alert-triage-review',targetFrom:{from:'field',field:'asset'}}}}]}
 const executionOnly=new BusinessTaskService(pool,identity,new TaskService(pool,identity),{definitions:{forScope:async()=>[executionBundle]},loads:{getInTransaction:async()=>({id:loadId,items:[{localId:'alert-triage-review',instanceId:itemInstanceId,kind:'work-template',status:'pending-adapter'},{localId:'isolate-alert',instanceId:randomUUID(),kind:'execution-tool',status:'pending-adapter'}]}) as never},works:{read:async()=>template,assertModelsReady:async()=>{}}})
 await assert.rejects(executionOnly.create({ownerId:owner,scopeIds:['SOC']},{requestId:randomUUID(),reference:{scope:snapshot.scope,type:snapshot.type,id:snapshot.id,version:snapshot.version,snapshotHash:snapshot.snapshotHash},goal:'执行隔离',actionId:'assign-alert-review'}),{code:'teloa/dependency-unavailable'})
 const executionItemId=randomUUID(),activeExecution=new BusinessTaskService(pool,identity,new TaskService(pool,identity),{definitions:{forScope:async()=>[executionBundle]},loads:{getInTransaction:async()=>({id:loadId,items:[{localId:'alert-triage-review',instanceId:itemInstanceId,kind:'work-template',status:'pending-adapter'},{localId:'isolate-alert',instanceId:executionItemId,kind:'execution-tool',status:'pending-adapter'}]}) as never},works:{read:async()=>template,assertModelsReady:async()=>{}},executions:{activeBindingForItemInTransaction:async(_db,_owner,input)=>{assert.deepEqual(input,{loadId,itemInstanceId:executionItemId,tool:'security.endpoint.isolate'});return {adapterId:'security-action-http',tools:['security.endpoint.isolate'],definitionHash:'f'.repeat(64)}}}})
 const executionCreated=await activeExecution.create({ownerId:owner,scopeIds:['SOC']},{requestId:randomUUID(),reference:{scope:snapshot.scope,type:snapshot.type,id:snapshot.id,version:snapshot.version,snapshotHash:snapshot.snapshotHash},goal:'执行隔离',actionId:'assign-alert-review'})
 assert.equal(executionCreated.task.title,'告警研判')
 for(const origin of [{kind:'local-configuration',configurationVersion:1,configurationHash:'a'.repeat(64)},{kind:'configuration-preview',configurationHash:'a'.repeat(64)}] as const){
  bundle.origin=origin
  await assert.rejects(service.create({ownerId:owner,scopeIds:['SOC']},{requestId:randomUUID(),reference:{scope:'SOC',type:snapshot.type,id:snapshot.id,version:snapshot.version,snapshotHash:snapshot.snapshotHash},goal:'不允许本地伪造市场动作',actionId:'assign-alert-review'}),{code:'teloa/forbidden'})
 }

})

test('来源摘要保持既有固定数组字节编码与裸 hex',()=>{
 assert.equal(businessTaskSourceDigest({schema:'teloa.business-task-source/v1',taskId:'11111111-1111-4111-8111-111111111111',ownerId:'owner',sourceId:'security-alert-http',reference:{scope:'SOC',type:'alert',id:'evt-1',version:1,snapshotHash:'a'.repeat(64)},createdAssignee:null,createdAt:'2026-09-13T01:00:00.000Z'}),'c70829f38c85e1f6b48266ccd81682bb5e6774f48c2dbc7734ee39b46b3e45ef')
})

test('业务动作在创建与执行前按固定模板重验模型，停用不影响历史查阅和普通任务',async()=>{
 const {owner,snapshot}=await fixture(),actor={ownerId:owner,scopeIds:['SOC']},enc=new TextEncoder()
 const market=new MarketContentStore(pool,identity),loads=new IndustryLoadService(pool,identity,createIndustryLoadSource(market))
 const dependency={catalogId:'teloa.model.sensevoice',version:'1.0.0',usage:'speech-to-text',required:true}
 const manifest={format:'teloa.business-package/v3',id:'voice-alert-review',title:'告警语音研判',version:'1.0.0',domain:'SOC',description:'固定本地语音依赖的业务动作',resources:[{id:'alert-triage-review',kind:'work-template',title:'告警研判',version:'1.0.0',required:true,source:{kind:'local',path:'review.json'},modelDependencies:[dependency]}],relations:[],entrypoints:['alert-triage-review']}
 const work={format:'teloa.work-template/v1',id:'alert-triage-review',title:'告警研判',version:'1.0.0',domain:'SOC',description:'核对告警。',requirements:['告警标题'],output:'研判结论',skills:[]}
 const imported=await market.import({ownerId:owner,kind:'human'},{kind:'industry-template',requestId:randomUUID(),source:{kind:'upload',name:'voice-alert-review'},manifestPath:'teloa.json',files:[{path:'teloa.json',bytes:enc.encode(JSON.stringify(manifest))},{path:'review.json',bytes:enc.encode(JSON.stringify(work))}],references:[]})
 const personal=await new BusinessSpaceService(pool,identity).ensurePersonal(owner)
 const load=await loads.create(owner,{requestId:randomUUID(),contentId:imported.content.id,contentHash:imported.content.hash,target:{kind:'existing',spaceId:personal.id,expectedVersion:personal.version}})
 let phase:IndustryModelPhase='disabled',probes=0
 const works=new IndustryWorkSource(market,loads,async fixed=>{assert.deepEqual(fixed,dependency);probes++;return phase})
 const source={loadId:load.id,scope:'SOC',localId:'assign-alert-review',version:'1.0.0',contentHash:imported.content.hash,fileHash:'b'.repeat(64),definitionHash:'c'.repeat(64),origin:'template' as const}
 const bundle:BusinessDefinitionBundle={origin:{kind:'market',loadId:load.id},scope:'SOC',domain:'SOC',sources:new Map(),views:[],mappings:[],widgets:[],dashboards:[],objectTypes:[{source:{...source,localId:'alert'},definition:{format:'teloa.business-object-type/v1',id:'alert',version:'1.0.0',domain:'SOC',title:'告警',unit:'条',lead:'待研判',sourceId:'security-alert-http',fields:[{name:'asset',label:'资产',type:'text',required:true,from:'资产'}]}}],actions:[{source,definition:{format:'teloa.business-action/v1',id:'assign-alert-review',version:'1.0.0',domain:'SOC',title:'研判此告警',objectType:'alert',target:{kind:'work-template',localId:'alert-triage-review'},inputs:[{from:'object',part:'title'}]}}]}
 const service=new BusinessTaskService(pool,identity,new TaskService(pool,identity),{definitions:{forScope:async()=>[bundle]},loads,works})
 const input={requestId:randomUUID(),reference:{scope:'SOC',type:snapshot.type,id:snapshot.id,version:snapshot.version,snapshotHash:snapshot.snapshotHash},goal:'研判当前告警',actionId:'assign-alert-review'}
 await assert.rejects(service.create(actor,input),{code:'teloa/dependency-unavailable'})
 assert.equal((await pool.query('select count(*)::int n from teloa_tasks where owner_id=$1',[owner])).rows[0].n,0)
 phase='ready'
 const created=await service.create(actor,input),fixed=await service.context(actor,{taskId:created.task.id})
 assert.ok(fixed?.action)
 const db=await pool.connect()
 try{
  await db.query('begin')
  assert.deepEqual(await service.executionContextInTransaction(db,actor,{taskId:created.task.id}),fixed)
  phase='disabled'
  const before=probes
  assert.deepEqual(await service.context(actor,{taskId:created.task.id}),fixed)
  assert.deepEqual(await service.source(actor,{taskId:created.task.id}),created.source)
  assert.deepEqual(await service.contextInTransaction(db,actor,{taskId:created.task.id}),fixed)
  assert.equal(probes,before,'历史回读不调用模型探针')
  await assert.rejects(service.executionContextInTransaction(db,actor,{taskId:created.task.id}),{code:'teloa/dependency-unavailable'})
  await assert.rejects(service.executionContextInTransaction(db,{ownerId:owner,scopeIds:['AppSec']},{taskId:created.task.id}),{code:'teloa/forbidden'})
  const plain=await service.create(actor,{requestId:randomUUID(),reference:input.reference,goal:'普通调查'})
  const afterFailure=probes
  assert.equal((await service.executionContextInTransaction(db,actor,{taskId:plain.task.id}))?.source.taskId,plain.task.id)
  assert.equal(probes,afterFailure,'没有工作模板来源的调查任务不受模型依赖影响')
  phase='standby'
  assert.deepEqual(await service.executionContextInTransaction(db,actor,{taskId:created.task.id}),fixed)
  assert.equal((await service.create(actor,input)).task.id,created.task.id,'失败后沿用同一请求，不重复创建')
  await db.query('rollback')
 }finally{db.release()}
})

test('本人、业务范围、对象版本与摘要必须匹配已固化快照',async()=>{
 const {owner,snapshot,service}=await fixture(),base={requestId:randomUUID(),reference:{scope:'SOC',type:'alert',id:snapshot.id,version:1,snapshotHash:snapshot.snapshotHash},goal:'调查'}
 await assert.rejects(service.create({ownerId:'other',scopeIds:['SOC']},base),{code:'teloa/forbidden'})
 await assert.rejects(service.create({ownerId:owner,scopeIds:['AppSec']},base),{code:'teloa/forbidden'})
 await assert.rejects(service.create({ownerId:owner,scopeIds:['SOC']},{...base,requestId:randomUUID(),reference:{...base.reference,version:2}}),{code:'teloa/version-conflict'})
 await assert.rejects(service.create({ownerId:owner,scopeIds:['SOC']},{...base,requestId:randomUUID(),reference:{...base.reference,snapshotHash:'b'.repeat(64)}}),{code:'teloa/version-conflict'})
 assert.equal((await pool.query('select count(*)::int n from teloa_tasks where owner_id=$1',[owner])).rows[0].n,0)
})

test('同一请求改变目标或来源会冲突且不能收养普通任务',async()=>{
 const {owner,snapshot,service}=await fixture(),reference={scope:'SOC',type:'alert',id:snapshot.id,version:1,snapshotHash:snapshot.snapshotHash},requestId=randomUUID(),input={requestId,reference,goal:'调查'}
 await service.create({ownerId:owner,scopeIds:['SOC']},input)
 await assert.rejects(service.create({ownerId:owner,scopeIds:['SOC']},{...input,goal:'另一目标'}),{code:'teloa/conflict'})
 await assert.rejects(service.create({ownerId:owner,scopeIds:['SOC']},{...input,reference:{...reference,version:2}}),{code:'teloa/conflict'})
 await assert.rejects(service.create({ownerId:owner,scopeIds:['SOC']},{...input,assignee:{roleId:randomUUID(),expectedVersion:1}}),{code:'teloa/conflict'})
 const plainRequest=randomUUID();await new TaskService(pool,identity).create(owner,{requestId:plainRequest,fields:{title:'普通任务',goal:'普通',scope:'SOC'}})
 await assert.rejects(service.create({ownerId:owner,scopeIds:['SOC']},{...input,requestId:plainRequest}),{code:'teloa/conflict'})
})

test('数字员工负责人须通过公共岗位范围与版本核验',async()=>{
 const {owner,snapshot,service}=await fixture(),roles=new RoleService(pool,identity),role=await roles.create(owner,{requestId:randomUUID(),fields:{name:'安全调查员',kind:'employee',scopes:['SOC'],duty:'调查告警',dataScope:'SOC 告警',executionScope:'只读调查',skills:[],knowledge:[],responsibility:testRoleResponsibility}})
 await pool.query("update teloa_roles set state='active' where id=$1",[role.id])
 const base={requestId:randomUUID(),reference:{scope:'SOC',type:'alert',id:snapshot.id,version:1,snapshotHash:snapshot.snapshotHash},goal:'调查'}
 await assert.rejects(service.create({ownerId:owner,scopeIds:['SOC']},{...base,assignee:{roleId:role.id,expectedVersion:2}}),{code:'teloa/version-conflict'})
 const created=await service.create({ownerId:owner,scopeIds:['SOC']},{...base,requestId:randomUUID(),assignee:{roleId:role.id,expectedVersion:1}})
 assert.equal(created.task.assigneeRoleId,role.id);assert.deepEqual(created.source.createdAssignee,{roleId:role.id,roleVersion:1})
})

test('来源关系写入失败时任务与关系一起回滚，损坏来源显式失败',async()=>{
 const {owner,snapshot,service}=await fixture(),reference={scope:'SOC',type:'alert',id:snapshot.id,version:1,snapshotHash:snapshot.snapshotHash},requestId=randomUUID()
 await pool.query(`create function reject_business_task_source_test() returns trigger language plpgsql as $$ begin raise exception 'source failed'; end $$;create trigger reject_business_task_source_test before insert on teloa_business_task_sources for each row execute function reject_business_task_source_test()`)
 try{await assert.rejects(service.create({ownerId:owner,scopeIds:['SOC']},{requestId,reference,goal:'调查'}),/source failed/);assert.equal((await pool.query('select count(*)::int n from teloa_tasks where owner_id=$1',[owner])).rows[0].n,0)}finally{await pool.query('drop trigger reject_business_task_source_test on teloa_business_task_sources;drop function reject_business_task_source_test()')}
 const created=await service.create({ownerId:owner,scopeIds:['SOC']},{requestId,reference,goal:'调查'})
 await pool.query("update teloa_business_task_sources set snapshot_hash=$2 where task_id=$1",[created.task.id,'c'.repeat(64)])
 await assert.rejects(service.source({ownerId:owner,scopeIds:['SOC']},{taskId:created.task.id}),{code:'teloa/storage-corrupt'})
})

test('任务创建快照缺少必填负责人字段时显式失败',async()=>{
 const {owner,snapshot,service}=await fixture(),reference={scope:'SOC',type:'alert',id:snapshot.id,version:1,snapshotHash:snapshot.snapshotHash}
 const created=await service.create({ownerId:owner,scopeIds:['SOC']},{requestId:randomUUID(),reference,goal:'调查'})
 await pool.query("update teloa_tasks set request_spec=request_spec-'assignee' where id=$1",[created.task.id])
 await assert.rejects(service.source({ownerId:owner,scopeIds:['SOC']},{taskId:created.task.id}),{code:'teloa/storage-corrupt'})
})

test('会话是否绑定业务对象来源：关联过即成立，解除关联不撤销这件事实',async()=>{
 const {owner,snapshot,service}=await fixture()
 const created=await service.create({ownerId:owner,scopeIds:['SOC']},{requestId:randomUUID(),reference:{scope:'SOC',type:'alert',id:snapshot.id,version:1,snapshotHash:snapshot.snapshotHash},goal:'调查'})
 const sessionId='soc-'+randomUUID()
 const links=new ObjectConversationService(pool,async(who,id)=>({id:'conv-'+id,sessionId:id,ownerId:who,status:'ready'}),identity.now)
 // 关联之前：这条会话没有任何外部来源，外发工具不受影响。
 assert.equal(await service.hasBusinessSource(owner,sessionId),false)
 assert.equal(await service.businessSourceScope(owner,sessionId),null)
 const linked=await links.change(owner,{requestId:randomUUID(),kind:'task',objectId:created.task.id,expectedObjectVersion:created.task.version,sessionId,expectedLinkVersion:0,action:'link'})
 assert.equal(await service.hasBusinessSource(owner,sessionId),true)
 // 会话绑定的业务范围 = 任务来源对象所在范围（AI 同事看板工具按它收窄）。
 assert.equal(await service.businessSourceScope(owner,sessionId),'SOC')
 assert.equal(await service.businessSourceScope(randomUUID(),sessionId),null)
 // 解除关联不会把告警正文从会话历史里拿走，判据因此只看"关联是否存在过"。
 await links.change(owner,{requestId:randomUUID(),kind:'task',objectId:created.task.id,expectedObjectVersion:created.task.version,sessionId,expectedLinkVersion:linked.version,action:'unlink'})
 assert.equal(await service.hasBusinessSource(owner,sessionId),true)
 // 跨本人不成立；身份形状不合法时显式失败，调用方按"绑定了"拒绝。
 assert.equal(await service.hasBusinessSource(randomUUID(),sessionId),false)
 await assert.rejects(service.hasBusinessSource(owner,'bad session id'),{code:'teloa/invalid-input'})
 await assert.rejects(service.hasBusinessSource('',sessionId),{code:'teloa/invalid-input'})
})

test('普通任务关联的会话不算绑定业务来源',async()=>{
 const {owner}=await fixture(),service=new BusinessTaskService(pool,identity,new TaskService(pool,identity))
 const plain=await new TaskService(pool,identity).create(owner,{requestId:randomUUID(),fields:{title:'普通任务',goal:'普通',scope:'SOC'}})
 const sessionId='plain-'+randomUUID()
 const links=new ObjectConversationService(pool,async(who,id)=>({id:'conv-'+id,sessionId:id,ownerId:who,status:'ready'}),identity.now)
 await links.change(owner,{requestId:randomUUID(),kind:'task',objectId:plain.id,expectedObjectVersion:plain.version,sessionId,expectedLinkVersion:0,action:'link'})
 assert.equal(await service.hasBusinessSource(owner,sessionId),false)
})

// BEGIN responsibility title pure
// 纯reader覆盖可离线执行；正式PG文件运行也必须保留此例。
test('通用交办标题兼容纯reader：显式标题与旧调查公式各自固定',()=>{
 const owner=randomUUID(),taskId=randomUUID(),requestId=randomUUID(),now=new Date('2026-09-29T00:00:00.000Z'),snapshot={...alert},hash=businessObjectSnapshotHash(snapshot)
 const reference={scope:snapshot.scope,type:snapshot.type,id:snapshot.id,version:snapshot.version,snapshotHash:hash}
 const source={schema:'teloa.business-task-source/v1' as const,taskId,ownerId:owner,sourceId:'security-alert-http',reference,createdAssignee:null,createdAt:now.toISOString()}
 const row={task_id:taskId,owner_id:owner,request_id:requestId,scope_id:'SOC',object_type:snapshot.type,object_id:snapshot.id,object_version:1,snapshot_hash:hash,source_id:source.sourceId,source_snapshot:source,snapshot_digest:businessTaskSourceDigest(source),created_at:now,business_snapshot:snapshot,business_snapshot_hash:hash,business_source_id:source.sourceId,task_request_id:requestId,request_spec:{reference,goal:'编写客户跟进建议',assignee:null,title:'客户跟进'},task_request_spec:{fields:{title:'客户跟进',goal:'编写客户跟进建议',scope:'SOC'},assignee:null}}
 assert.deepEqual(readBusinessTaskSource(row),source)
 const legacy={...row,request_spec:{reference,goal:'编写客户跟进建议',assignee:null},task_request_spec:{...row.task_request_spec,fields:{...row.task_request_spec.fields,title:'调查：'+snapshot.title}}}
 assert.deepEqual(readBusinessTaskSource(legacy),source)
 assert.throws(()=>readBusinessTaskSource({...row,task_request_spec:{...row.task_request_spec,fields:{...row.task_request_spec.fields,title:'篡改'}}}),{code:'teloa/storage-corrupt'})
 assert.throws(()=>readBusinessTaskSource({...row,request_spec:{...row.request_spec,actionId:'action'}}),{code:'teloa/storage-corrupt'})
})
// END responsibility title pure

test('新通用标题持久去重且旧调查来源仍可读取',async()=>{
 const f=await fixture(),actor={ownerId:f.owner,scopeIds:['SOC']},reference={scope:'SOC',type:f.snapshot.type,id:f.snapshot.id,version:1,snapshotHash:f.snapshot.snapshotHash}
 const input={requestId:randomUUID(),reference,goal:'跟进处理',title:'客户跟进'}
 const [a,b]=await Promise.all([f.service.create(actor,input),f.service.create(actor,input)])
 assert.deepEqual(a,b);assert.equal(a.task.title,input.title);assert.deepEqual(await f.service.source(actor,{taskId:a.task.id}),a.source)
 await assert.rejects(f.service.create(actor,{...input,title:'另一个标题'}),{code:'teloa/conflict'})
 await assert.rejects(f.service.create(actor,{...input,requestId:randomUUID(),actionId:'act'}),{code:'teloa/invalid-input'})
 const old=await f.service.create(actor,{requestId:randomUUID(),reference,goal:'旧调查'})
 assert.equal(old.task.title,'调查：'+f.snapshot.title);assert.deepEqual(await f.service.source(actor,{taskId:old.task.id}),old.source)
})
test('业务任务分页不漏无对象任务，对象任务保留旧快照并约束cursor身份',async()=>{
 const f=await fixture(),actor={ownerId:f.owner,scopeIds:['SOC']},reference={scope:'SOC',type:f.snapshot.type,id:f.snapshot.id,version:1,snapshotHash:f.snapshot.snapshotHash}
 assert.equal(typeof f.service.listForObject,'function');assert.equal(typeof f.service.listForScope,'function')
 const linked=await f.service.create(actor,{requestId:randomUUID(),reference,goal:'对象工作'})
 const tasks=new TaskService(pool,identity),plain=await tasks.create(f.owner,{requestId:randomUUID(),fields:{title:'无对象日常工作',goal:'整理业务',scope:'SOC'}})
 await tasks.create(f.owner,{requestId:randomUUID(),fields:{title:'另一业务',goal:'不能混入',scope:'AppSec'}})
 await pool.query('update teloa_tasks set created_at=$2 where owner_id=$1',[f.owner,'2026-09-29T00:00:00.000Z'])
 const first=await f.service.listForScope(actor,{scope:'SOC',limit:1});assert.equal(first.items.length,1);assert.ok(first.nextCursor)
 const second=await f.service.listForScope(actor,{scope:'SOC',limit:1,cursor:first.nextCursor});assert.equal(second.items.length,1);assert.equal(second.nextCursor,undefined)
 assert.deepEqual(new Set([...first.items,...second.items].map(item=>item.task.id)),new Set([linked.task.id,plain.id]))
 assert.equal([...first.items,...second.items].find(item=>item.task.id===plain.id)!.source,null)
 const changed={...f.snapshot,version:2,title:'已改名且归档',deletedAt:identity.now()};const {snapshotHash:_,...changedBody}=changed
 await pool.query('insert into teloa_business_object_snapshots(owner_id,scope_id,object_type,object_id,object_version,snapshot_hash,snapshot,source_id,first_seen_at) values($1,$2,$3,$4,2,$5,$6,$7,now())',[f.owner,'SOC',reference.type,reference.id,businessObjectSnapshotHash(changedBody),JSON.stringify(changedBody),'security-alert-http'])
 const linkedAgain=await f.service.create(actor,{requestId:randomUUID(),reference,goal:'仍按历史版本',title:'历史任务'})
 const objects=await f.service.listForObject(actor,{scope:'SOC',type:reference.type,id:reference.id,limit:1})
 assert.equal(objects.items.length,1);assert.deepEqual(objects.items[0]!.source,linked.source);assert.ok(objects.nextCursor)
 const next=await f.service.listForObject(actor,{scope:'SOC',type:reference.type,id:reference.id,limit:1,cursor:objects.nextCursor})
 assert.equal(next.items[0]!.task.id,linkedAgain.task.id);assert.equal(next.items[0]!.source!.reference.version,1)
 await assert.rejects(f.service.listForObject(actor,{scope:'SOC',type:reference.type,id:'different',cursor:objects.nextCursor}),{code:'teloa/invalid-input'})
 assert.equal('goal' in objects.items[0]!.task,false,'列表不复制大正文或Run/成果状态')
 for(const input of [{scope:'AppSec',cursor:first.nextCursor},{scope:'SOC',limit:51},{scope:'SOC',cursor:'invalid'}])await assert.rejects(f.service.listForScope({...actor,scopeIds:['SOC','AppSec']},input),{code:'teloa/invalid-input'})
 await assert.rejects(f.service.listForObject(actor,{scope:'SOC',type:reference.type,id:reference.id,cursor:first.nextCursor}),{code:'teloa/invalid-input'})
 await assert.rejects(f.service.listForScope({...actor,scopeIds:['AppSec']},{scope:'SOC'}),{code:'teloa/forbidden'})
 assert.deepEqual((await f.service.listForScope({ownerId:randomUUID(),scopeIds:['SOC']},{scope:'SOC'})).items,[])
 await pool.query("update teloa_business_object_snapshots set snapshot_hash=$2 where owner_id=$1",[f.owner,'0'.repeat(64)])
 await assert.rejects(f.service.listForObject(actor,{scope:'SOC',type:reference.type,id:reference.id}),{code:'teloa/storage-corrupt'})
})
test('正式业务任务目录批量投影真实 Run 与固定验收成果；结束未验收不冒充完成',async()=>{
 const f=await fixture(),actor={ownerId:f.owner,scopeIds:['SOC']},reference={scope:'SOC',type:f.snapshot.type,id:f.snapshot.id,version:1,snapshotHash:f.snapshot.snapshotHash}
 const role=await new RoleService(pool,identity).create(f.owner,{requestId:randomUUID(),fields:{name:'进度员',kind:'employee',scopes:['SOC'],duty:'调查',dataScope:'SOC',executionScope:'只读',skills:[],knowledge:[],responsibility:testRoleResponsibility}})
 await pool.query("update teloa_roles set state='active',version=2 where owner_id=$1 and id=$2",[f.owner,role.id])
 const task=(await f.service.create(actor,{requestId:randomUUID(),reference,goal:'完成调查',assignee:{roleId:role.id,expectedVersion:2}})).task
 const noRun=(await new TaskService(pool,identity).create(f.owner,{requestId:randomUUID(),fields:{title:'尚未派发',goal:'等待',scope:'SOC'}}))
 const runId=randomUUID(),now=identity.now()
 await pool.query("insert into teloa_task_runs(id,owner_id,request_id,request_spec,task_id,role_id,task_version,role_version,link_version,session_id,native_request_id,state,input_text,created_at,evidence) values($1,$2,$3,'{}'::jsonb,$4,$5,$6,2,1,$7,$8,'ended','{}',$9,$10)",[runId,f.owner,randomUUID(),task.id,role.id,task.version,'task-run-'+randomUUID(),randomUUID(),now,{state:'ended',turn:1,messageSeq:1,endSeq:2,reason:'completed'}])
 await pool.query("update teloa_tasks set state='waiting',version=version+1 where owner_id=$1 and id=$2",[f.owner,task.id])
 const waiting=await f.service.listForScope(actor,{scope:'SOC'})
 assert.deepEqual(waiting.items.find(item=>item.task.id===task.id)?.progress,{runId,state:'ended',reason:'completed',stopRequestedAt:null})
 assert.equal(waiting.items.find(item=>item.task.id===task.id)?.completion,null)
 assert.equal(waiting.items.find(item=>item.task.id===noRun.id)?.progress,null)
 const acceptedId=randomUUID(),source={kind:'task',id:task.id,scope:'SOC',version:task.version+' · '+task.updatedAt,title:task.title}
 const content=(title:string)=>({title,sections:[{id:'body',title:'正文',text:'已核对'}],snapshotIds:[],note:'审阅'})
 await pool.query('insert into teloa_artifacts(id,owner_id,request_id,request_spec,source_key,current_version) values($1,$2,$3,$4,$5,2)',[acceptedId,f.owner,randomUUID(),{},JSON.stringify(['task',task.id,'SOC',''])])
 await pool.query('insert into teloa_artifact_versions(owner_id,artifact_id,number,source,content,created_at) values($1,$2,1,$3,$4,$5),($1,$2,2,$3,$6,$5)',[f.owner,acceptedId,source,content('已验收初版'),now,content('后续修订版')])
 await pool.query('insert into teloa_task_completions(owner_id,task_id,task_version,artifact_id,artifact_version,note,completed_at) values($1,$2,$3,$4,1,$5,$6)',[f.owner,task.id,task.version+2,acceptedId,'本人确认初版',now])
 await pool.query("update teloa_tasks set state='completed',version=version+1 where owner_id=$1 and id=$2",[f.owner,task.id])
 const completed=await f.service.listForObject(actor,{scope:'SOC',type:reference.type,id:reference.id})
 assert.deepEqual(completed.items[0]?.completion,{artifactId:acceptedId,version:1,title:'已验收初版',completedAt:now})
 assert.equal((await f.service.listForScope({ownerId:randomUUID(),scopeIds:['SOC']},{scope:'SOC'})).items.length,0)
 await pool.query("update teloa_tasks set state='completed',version=version+1 where owner_id=$1 and id=$2",[f.owner,noRun.id])
 await assert.rejects(f.service.listForScope(actor,{scope:'SOC'}),{code:'teloa/storage-corrupt'},'本人任务完成也必须有固定结项记录')
})
test('对象与业务列表在max=1连接池真实完成，耗尽超时后可继续读取',{timeout:10000},async()=>{
 const f=await fixture(),actor={ownerId:f.owner,scopeIds:['SOC']},reference={scope:'SOC',type:f.snapshot.type,id:f.snapshot.id,version:1,snapshotHash:f.snapshot.snapshotHash}
 await f.service.create(actor,{requestId:randomUUID(),reference,goal:'固定对象'})
 const single=new Pool({connectionString:container.getConnectionUri(),max:1,connectionTimeoutMillis:150,statement_timeout:2000}),service=new BusinessTaskService(single,identity,new TaskService(single,identity))
 try{
  assert.equal((await service.listForObject(actor,{scope:'SOC',type:reference.type,id:reference.id})).items.length,1)
  const held=await single.connect()
  try{await assert.rejects(service.listForScope(actor,{scope:'SOC'}),/timeout/)}finally{held.release()}
  assert.equal((await service.listForScope(actor,{scope:'SOC'})).items.length,1)
 }finally{await single.end()}
})

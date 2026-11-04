import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {createRequire} from 'node:module'
import {mkdtemp,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {Context} from '@deepseek-ai/cordis'
import {SessionId,type SessionEvent} from '@deepseek-ai/dsh-session'
import type {GenerateOptions,StreamChunk} from '@deepseek-ai/dsh-llm'
import {initializeTeloaDatabase,ResourceService,RoleService,TaskService,ConversationWorkService,TaskRunService,ObjectConversationService,TaskRunRuntimeLinkService,TaskRunSubagentService,TaskRunFlowService,WorkRetryService,defaultWorkBudgetPolicy,EmployeeIntegrationService,EmployeeApiWorkService,readStoredTask,type TaskRun,type TaskRunRuntimeLinks} from '@teloa/backend'
import {createPublicReferenceCatalog} from '../../mcp-reference/src/local.ts'
import {setupRoleWork,identity} from '../../backend/tests/role-work-test-fixture.ts'
import {testRoleResponsibility} from '../../backend/tests/role-test-fixture.ts'
import {installNativeSessions,installNativeHostServices,installNativeSessionController,ControlledPromptModel,nativeFixtureTitleResponse} from './fixtures/native-host-services.ts'
import {createResidentWorkRuntime} from '../src/resident-work-runtime.ts'
import {requireNativeInputProvider} from '../src/native-input-provider.ts'
import {dshTaskRunPorts,taskRunReviewMaterial} from '../src/task-run-dsh.ts'
import {observeTaskRun} from '../src/task-run-observation.ts'
import {readSessionEvents} from '../src/session-events.ts'
import {leaseTaskDeliveryReview,readDeliveryReviewCheckpoint,deliveryReviewToolName} from '../src/task-delivery-review.ts'
import {registerTaskToolGuard} from '../src/task-tool-guard.ts'
import {installResidentModelBudget} from '../src/resident-model-budget.ts'
import {readTaskRunGroupResult} from '../src/task-run-group-result.ts'
import {hotGate} from './fixtures/native-hot-causality.ts'
const nativeRequire=createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json'))
const official=(name:string)=>import(nativeRequire.resolve('@deepseek-ai/'+name))
async function nativeHost(directory:string){
 const ctx=new Context();await installNativeSessions(ctx);await installNativeHostServices(ctx,directory)
 const {Loader,Group}=await official('cordis-plugin-loader')
 class FixtureLoader extends Loader{write(){};async import(name:string){return import(nativeRequire.resolve(name))}}
 await ctx.plugin(FixtureLoader);ctx.loader.builtins.group=Group
 await ctx.loader.root.update([{id:'registry',name:'@deepseek-ai/dsh-agent-preset-registry',config:{default:'continuation-fixture'}},{id:'preset-continuation',name:'@deepseek-ai/dsh-agent-preset',config:{id:'continuation-fixture',plugins:[]}}]);await ctx.loader.await()
 await ctx.plugin((await official('dsh-storage')).Storage);await ctx.plugin(await official('dsh-storage-json'),{root:join(directory,'domains')});await ctx.plugin(await official('dsh-storage-domain'),{backend:'json'})
 await ctx.plugin((await official('dsh-workspace')).WorkspaceRegistry)
 await ctx.plugin((await official('dsh-session-query-sqlite')).SqliteSessionQueryEngine,{path:join(directory,'query.sqlite'),openAt:'never'})
 await ctx.plugin((await official('dsh-session-projection-cache')).SessionProjectionCache,{writeEveryEvents:100,writeIntervalMs:60000})
 // alpha3：Gateway 与 SessionController 都注入 remoteAccess；按官方组合同时挂载 RemoteAccessService，否则二者不激活。
 await ctx.plugin((await official('dsh-typert-registry')).default);await ctx.plugin((await official('dsh-api-remote-access')).default);await ctx.plugin((await official('dsh-api-gateway')).default)
 ctx.provide('agentDefaultModel',{currentSelection:()=>({provider:'controlled',model:'fixed'}),saveSelection:async()=>{}})
 ctx.provide('fileUploads',{registerAgentResolver:()=>()=>{},bindPrompt:()=>({commit(){},[Symbol.dispose](){}})})
 // alpha3 宿主装配已注册真实 LocalFileSystem 等服务；只在缺失时提供空桩，不重复注册。
 if(!ctx.get('fs'))ctx.provide('fs',{});if(!ctx.get('fileReferences'))ctx.provide('fileReferences',{})
 await installNativeSessionController(ctx,{nativeOpen:false})
 return ctx
}

class Model extends ControlledPromptModel{
 calls=0;scripts:StreamChunk[][]=[]
 override async *stream(options:GenerateOptions):AsyncIterable<StreamChunk>{const title=nativeFixtureTitleResponse(options);if(title){yield* title;return}this.calls++;const script=this.scripts.shift();assert.ok(script,'禁止未计划模型调用');yield* script}
}
const text=(value:string):StreamChunk[]=>[{type:'block-start',index:0,blockType:'text'},{type:'text-delta',index:0,text:value},{type:'block-end',index:0,block:{type:'text',text:value}},{type:'finish',reason:{kind:'stop'}}]
const call=(args:unknown):StreamChunk[]=>[{type:'block-start',index:0,blockType:'tool-call'},{type:'block-end',index:0,block:{type:'tool-call',id:randomUUID(),name:deliveryReviewToolName,arguments:JSON.stringify(args)}},{type:'finish',reason:{kind:'tool-calls'}}] as unknown as StreamChunk[]
const checks=(['goal',1,2,3,4,5,6,7,8] as const).map(id=>({id,status:'pass'}))

test('ready真实PG与两宿主Controller：原Inbox/同Run自动续作、旧预算封口及completed待复核恢复',{timeout:120000},async t=>{
 const f=await setupRoleWork();t.after(()=>f.close());await initializeTeloaDatabase(f.pool)
 await t.test('data17纯新增schema保全旧表和原行',async schemaTest=>{
  // 只在本用例刚创建的空账本中构造data16边界；不操作任何既有安装或用户数据。
  assert.equal(Number((await f.pool.query('select count(*) n from teloa_native_session_checkpoints')).rows[0].n),0)
  assert.equal(Number((await f.pool.query('select count(*) n from teloa_native_session_continuations')).rows[0].n),0)
  await f.pool.query('drop table teloa_native_session_checkpoints,teloa_native_session_continuations')
  const schema=async()=>(await f.pool.query(`select c.relname,a.attname,format_type(a.atttypid,a.atttypmod) as type,a.attnotnull,pg_get_expr(d.adbin,d.adrelid) as default_value from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_attribute a on a.attrelid=c.oid left join pg_attrdef d on d.adrelid=c.oid and d.adnum=a.attnum where n.nspname='public' and c.relkind='r' and a.attnum>0 and not a.attisdropped and c.relname not in ('teloa_native_session_checkpoints','teloa_native_session_continuations') order by c.relname,a.attnum`)).rows
  const before=await schema(),owner=randomUUID(),role=await new RoleService(f.pool,identity).create(owner,{requestId:randomUUID(),fields:{name:'升级保全行',kind:'employee',scopes:['general'],duty:'核对',dataScope:'本人资料',executionScope:'核对',skills:[],knowledge:[],responsibility:testRoleResponsibility}}),row=(await f.pool.query('select * from teloa_roles where id=$1',[role.id])).rows[0]
  await initializeTeloaDatabase(f.pool)
  assert.deepEqual(await schema(),before)
  assert.deepEqual((await f.pool.query('select * from teloa_roles where id=$1',[role.id])).rows[0],row)
  assert.deepEqual((await f.pool.query("select tablename from pg_tables where schemaname='public' and tablename like 'teloa_native_session_%' order by tablename")).rows.map(r=>r.tablename),['teloa_native_session_checkpoints','teloa_native_session_continuations'])
  const indexes=(await f.pool.query("select tablename,indexname,indexdef from pg_indexes where schemaname='public' and tablename in ('teloa_native_session_checkpoints','teloa_native_session_continuations') order by tablename,indexname")).rows
  assert.equal(indexes.length,4)
  schemaTest.diagnostic(JSON.stringify({schema:'teloa.native-continuation-ddl/v1',dataVersion:17,existingTableCount:new Set(before.map(row=>row.relname)).size,existingColumnsPreserved:true,existingRoleRowPreserved:true,addedTables:['teloa_native_session_checkpoints','teloa_native_session_continuations'],indexes}))
 })
 for(const scenario of ['pending','claimed','completed-review','published-pending','claimed-twice','elapsed-downtime','api-identity'] as const)await t.test(scenario,async sub=>{
  if(scenario==='elapsed-downtime')sub.mock.timers.enable({apis:['Date'],now:Date.now()-600000})
  const directory=await mkdtemp(join(process.cwd(),'.tmp-native-continuation-')),contexts:Context[]=[],residents:Awaited<ReturnType<typeof createResidentWorkRuntime>>[]=[]
  sub.after(async()=>{for(const r of residents)r.close();for(const ctx of contexts)await ctx.fiber.dispose();await rm(directory,{recursive:true,force:true})})
  const owner=randomUUID(),sessionId='run-'+randomUUID(),runtimeIds=[randomUUID(),randomUUID(),randomUUID()],conversationId=randomUUID(),reports:string[]=[]
  const inspect=async()=>({id:conversationId,ownerId:owner,sessionId,status:'ready'})
  const role=await new RoleService(f.pool,identity).create(owner,{requestId:randomUUID(),fields:{name:'核对岗',kind:'employee',scopes:['general'],duty:'核对事实',dataScope:'本人资料',executionScope:'核对原资料',skills:[],knowledge:[],responsibility:testRoleResponsibility,runtimeConfig:{agentPresetId:'continuation-fixture'}}})
  await f.pool.query("update teloa_roles set state='active' where id=$1",[role.id])
  let task:Awaited<ReturnType<TaskService['createForConversation']>>
  const service=new TaskRunService(f.pool,identity,inspect),journal=new TaskRunRuntimeLinkService(f.pool),links:TaskRunRuntimeLinks={list:input=>journal.list(owner,input),put:input=>journal.put(owner,input)}
  const resources=new ResourceService(f.pool,createPublicReferenceCatalog(),identity)
  const setup=async(index:number)=>{
   const ctx=await nativeHost(directory);contexts.push(ctx)
   const resident=await createResidentWorkRuntime(ctx,{owner,pool:f.pool,identity,runtimeId:runtimeIds[index]!,nativeInput:requireNativeInputProvider(ctx).input,ownerAuthority:{authorize:async()=>({assertCurrent(){}})},runs:async()=>service,resources,dailyLogs:async()=>{throw Error('不能生成额外员工日志')},executionScope:(db,actor,runId,mode)=>service.executionScopeInTransaction(db,actor,{runId,mode}),verifyInitialMessage:async()=>false,report:code=>reports.push(code)})
   residents.push(resident);ctx.provide('teloaResidentInputAdmission',resident)
   const ports=dshTaskRunPorts(ctx,owner,inspect,undefined,undefined,undefined,undefined,undefined,undefined,links,undefined,undefined,requireNativeInputProvider(ctx).input,undefined,runtimeIds[index])
   ports.subagentState=async run=>(await new TaskRunSubagentService(f.pool,identity).list(owner,run.id)).length?'outstanding':'none'
   ports.flowState=async run=>await new TaskRunFlowService(f.pool,identity).get(owner,{runId:run.id})?'outstanding':'none'
   ports.controlState=run=>resident.controls.stateForRun(owner,{runId:run.id})
   ports.continuations=(run,events)=>resident.nativeContinuations(run,events)
   const disposeBudget=installResidentModelBudget(ctx,{owner,pool:f.pool,identity,runs:async()=>service,controls:resident.controls,budgets:resident.budgets,resolveRun:resident.resolveRun,nativeInput:requireNativeInputProvider(ctx).input,report:code=>reports.push(code)})
   ctx.effect(()=>disposeBudget)
   registerTaskToolGuard(ctx,async id=>{const p=await service.toolPolicy(owner,{sessionId:id});return p},[],undefined,undefined,undefined,{authorizeMember:async()=>false,continuations:async(_root,requestId,events)=>{const run=await service.get(owner,{runId:prepared.id});assert.equal(run.nativeRequestId,requestId);return resident.nativeContinuations(run,events)}})
   await resident.attachRunDriver({ports,runtimeLinks:journal})
   const model=new Model();ctx.llm.registerAdapter(['controlled'],model)
   return {ctx,resident,ports,model}
  }
  let prepared:TaskRun
  const first=await setup(0)
  let api:EmployeeApiWorkService|undefined,apiIdentity:Awaited<ReturnType<EmployeeIntegrationService['authenticate']>>|undefined,workId:string|undefined,apiRequestId:string|undefined,apiNow=new Date(),currentHost=first
  if(scenario==='api-identity'){
   const secrets=new Map<string,string>(),keys=new EmployeeIntegrationService(f.pool,{write:async(id,value)=>{secrets.set(id,value)},read:async id=>secrets.get(id),remove:async id=>{secrets.delete(id)}},()=>apiNow)
   const issued=await keys.create(owner,{name:'隔离API原工作',employeeId:role.id,expectedEmployeeVersion:1,scope:'general',permissions:['read','execute'],maxConcurrent:2,expiresInDays:30});apiIdentity=await keys.authenticate(issued.apiKey)
   const unexpected=async():Promise<never>=>{throw Error('原API round已有固定Run，恢复不得prepare/start/stop/withdraw')}
   api=new EmployeeApiWorkService(f.pool,keys,{prepare:unexpected,start:unexpected,stop:unexpected,withdraw:unexpected,read:async(actor,id)=>service.get(actor,{runId:id}),waiting:async()=>false,result:async run=>{const events=await currentHost.ports.events(run),trusted=await currentHost.resident.nativeContinuations(run,events),value=readTaskRunGroupResult(events,run.nativeRequestId,trusted);return value?{text:value,review:'unreviewed'}:undefined},check:async()=>{}},owner,()=>apiNow)
   const work=await api.command(apiIdentity,'start',randomUUID(),{employeeId:role.id,input:'输出原资料核对结果',model:{provider:'controlled',model:'fixed'},permissionMode:'read-only'});workId=work.id
   const round=(await f.pool.query('select * from teloa_employee_api_rounds where work_id=$1 and round=1',[workId])).rows[0];apiRequestId=round.request_id;task=readStoredTask((await f.pool.query('select * from teloa_tasks where id=$1',[round.task_id])).rows[0])
  }else{
   const parentSession='parent-'+randomUUID(),requests=new ConversationWorkService(f.pool,identity.now,async()=>({ownerId:owner,sessionId:parentSession,status:'ready',submitted:false}))
   const parent=await requests.reserve(owner,{requestId:randomUUID(),sessionId:parentSession,messageId:'human',messageSeq:1,kind:'task',scope:'general',title:'核对原资料',goal:'输出原资料核对结果',roleId:role.id,expectedRoleVersion:1})
   task=await new TaskService(f.pool,identity).createForConversation(owner,{sessionId:parentSession,requestId:parent.requestId,roleId:role.id})
  }
  const handle=await first.ctx.agents.create({sessionId:SessionId(sessionId),meta:{cwd:directory,agentPreset:'continuation-fixture'},agentOptions:{provider:'controlled',model:'fixed'},setup:async scope=>{await first.ctx.agentPresets.mount(scope,'continuation-fixture')}})
  const link=await new ObjectConversationService(f.pool,inspect,identity.now).change(owner,{requestId:randomUUID(),kind:'task',objectId:task.id,expectedObjectVersion:1,sessionId,expectedLinkVersion:0,action:'link'})
  prepared=await service.prepare(owner,{requestId:apiRequestId??randomUUID(),taskId:task.id,expectedTaskVersion:1,roleId:role.id,expectedRoleVersion:1,sessionId,expectedLinkVersion:link.version},undefined,undefined,undefined,async()=> 'continuation-fixture',async()=>({primary:{provider:'controlled',model:'fixed'}}),undefined,scenario==='api-identity'?{permissionMode:'read-only'}:undefined)
  const claimed=await service.claim(owner,{runId:prepared.id})
  if(scenario==='elapsed-downtime')await first.resident.budgets.configure(owner,{requestId:randomUUID(),budgetAccountId:prepared.lineage!.budgetAccountId,expectedVersion:1,policy:{...defaultWorkBudgetPolicy,maxElapsedMs:500}})
  const oldReservation=await first.resident.budgets.reserve(owner,{budgetAccountId:prepared.lineage!.budgetAccountId,controlGeneration:1,modelRequestId:'old:'+randomUUID(),kind:'retry',tokens:30,rounds:0})
  const oldLease=first.resident.budgets.lease(owner,oldReservation)
  await first.resident.budgets.markDispatched(owner,{reservationId:oldReservation.id})
  await f.pool.query("insert into teloa_work_retries(owner_id,operation_id,run_id,budget_account_id,attempts,max_attempts,state,completed,last_reason,created_at,updated_at) values($1,$2,$3,$4,1,3,'unknown',false,'旧宿主用量未知',now(),now())",[owner,'op:'+oldReservation.modelRequestId,prepared.id,prepared.lineage!.budgetAccountId])
  await f.pool.query("insert into teloa_work_retry_claims(owner_id,request_id,operation_id,attempt,model_request_id,spec) values($1,$2,$3,1,$4,'{}')",[owner,randomUUID(),'op:'+oldReservation.modelRequestId,oldReservation.modelRequestId])
  let interrupted=false,ignoreTerminal=false,releaseReview:(()=>void)|undefined
  const saveCheckpoint=first.resident.nativeCheckpoint,saveProgress=first.resident.nativeProgress
  Object.assign(first.resident,{nativeCheckpoint:async input=>{await saveCheckpoint(input);if(scenario==='pending'&&!interrupted){interrupted=true;throw Error('持久受理后的旧宿主响应丢失')}},nativeProgress:async input=>{
   if(ignoreTerminal)return
   await saveProgress(input)
   if(scenario!=='pending'&&scenario!=='completed-review'&&scenario!=='elapsed-downtime'&&'phase'in input&&input.phase==='model'&&!interrupted){interrupted=true;input.agent.cancel({kind:'disposed'})}
   if(scenario==='elapsed-downtime'&&'phase'in input&&input.phase==='step-end'&&!interrupted){interrupted=true;input.agent.cancel({kind:'disposed'})}
   if(scenario==='completed-review'&&'phase'in input&&input.phase==='step-end'){
    const state=readDeliveryReviewCheckpoint(input.agent)
    if(state&&JSON.parse(state.json).current.round===2&&JSON.parse(state.json).submission){interrupted=true;ignoreTerminal=true;releaseReview?.()}
   }
  }} satisfies Partial<typeof first.resident>)
  if(scenario==='completed-review'){
   const material=taskRunReviewMaterial(prepared);assert.ok(!('skip'in material))
   releaseReview=leaseTaskDeliveryReview(handle.agent,{runId:prepared.id,requestId:prepared.nativeRequestId,material,trace(){},publish:async(message,signal)=>{await requireNativeInputProvider(first.ctx).input.withNewInput(handle.agent,message,{producer:'task-run',identity:'review:'+prepared.id},()=>handle.agent.inject(message),signal)}})
   first.model.scripts.push(text('原资料已核对。'),call({phase:'revise',issues:[]}),call({phase:'verify',verdict:'accept',checks,changeChecks:[],findings:[]}))
  }
  if(scenario==='elapsed-downtime'){sub.mock.timers.tick(100);first.model.scripts.push(text('原报告草稿'))}
  const db=await f.pool.connect();let target
  try{await db.query('begin');target=await service.executionScopeInTransaction(db,owner,{runId:prepared.id});await db.query('commit')}finally{db.release()}
  await first.ports.send(claimed.run,new AbortController().signal,target);await handle.agent.whenIdle();assert.equal(interrupted,true,JSON.stringify({calls:first.model.calls,events:readSessionEvents(handle.agent.session).map(e=>({seq:e.seq,type:e.type,...e.type==='user/message'?{source:e.data.source,parts:e.data.content.map(b=>b.type==='text'?b.text.slice(0,180):b.type)}:e.type==='turn/end'?{reason:e.data.reason}:e.type==='request/header'?{tools:e.data.header.tools?.map(t=>t.name)}:{}}))}))
  if(api){await api.tick(new AbortController().signal);assert.equal((await api.get(apiIdentity!,workId!)).state,'running');assert.equal((await f.pool.query('select run_id from teloa_employee_api_rounds where work_id=$1',[workId])).rows[0].run_id,prepared.id)}
  const before=[...readSessionEvents(handle.agent.session)],originalInputs=before.filter((e):e is Extract<SessionEvent,{type:'agent/inbox/spliced'}>=>e.type==='agent/inbox/spliced'&&e.data.inserted.some(m=>m.source.kind==='user'&&Reflect.get(m.source,'rpcId')===prepared.nativeRequestId))
  assert.equal(originalInputs.length,1)
  if(scenario==='completed-review'){
   const evidence=observeTaskRun(before,prepared.nativeRequestId);assert.ok(evidence.state==='ended'&&evidence.reason==='completed')
   await service.record(owner,{runId:prepared.id,sessionId,nativeRequestId:prepared.nativeRequestId,evidence})
   assert.equal((await f.pool.query('select state from teloa_tasks where id=$1',[task.id])).rows[0].state,'waiting')
  }
  let lastClaim:Awaited<ReturnType<WorkRetryService['claim']>>|undefined
  const gate=hotGate();sub.after(gate.release)
  const oldRetries=new WorkRetryService(f.pool,identity,{controls:first.resident.controls,authorizeAttempt:async(db,actor,input)=>{const r=await first.resident.budgets.reserveInTransaction(db,actor,{budgetAccountId:prepared.lineage!.budgetAccountId,controlGeneration:input.controlGeneration,modelRequestId:input.modelRequestId,kind:'retry',tokens:7,rounds:0});await gate.wait(new AbortController().signal);return first.resident.budgets.lease(actor,r)}})
  const operationId='last-old:'+randomUUID(),lateOperationId='queued-old:'+randomUUID()
  if(scenario==='pending'){await oldRetries.register(owner,{runId:prepared.id,operationId});await oldRetries.register(owner,{runId:prepared.id,operationId:lateOperationId})}
  const claiming=scenario==='pending'?oldRetries.claim(owner,{operationId,requestId:randomUUID(),expectedGeneration:1}):undefined
  if(claiming)await gate.entered
  first.resident.close();await first.ctx.fiber.dispose()
  if(scenario==='elapsed-downtime'){sub.mock.timers.reset();const beforeBudget=await first.resident.budgets.read(owner,{budgetAccountId:prepared.lineage!.budgetAccountId});assert.ok(beforeBudget.usedElapsedMs>500,'新宿主前真实DB时钟会把模拟停机跨度计满原有限额度')}
  const settingUp=setup(1)
  if(claiming){
   let waiting=false
   for(let i=0;i<100;i++){waiting=(await f.pool.query("select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%teloa_work_control_hosts%' and pid<>pg_backend_pid()")).rowCount!==0;if(waiting)break;await new Promise(resolve=>setTimeout(resolve,20))}
   assert.equal(waiting,true,'新host撤防必须等待旧host已取得的真实host/control/budget事务完成')
   gate.release();lastClaim=await claiming
  }
  let second=await settingUp
  if(lastClaim){assert.throws(()=>lastClaim!.lease.assertCurrent());assert.ok((await f.pool.query('select 1 from teloa_work_retry_claims where model_request_id=$1',[lastClaim.modelRequestId])).rowCount)}
  assert.equal(second.ctx.agents.get(SessionId(sessionId)),undefined,'启动只挑候选，ready之前不物化执行')
  second.model.scripts.push(text('继续完成原工作。'))
  const never=async():Promise<never>=>{throw Error('自动续作不得创建Task/Run或start')}
  const pump=()=>second.resident.pump({outbox:second.resident.outbox,createTask:never,prepare:never,start:never,readRun:never,reconcile:never,report:code=>reports.push(code)},never,new AbortController().signal)
  if(scenario==='published-pending'||scenario==='claimed-twice'){
   const checkpoint=second.resident.nativeCheckpoint,progress=second.resident.nativeProgress
   Object.assign(second.resident,{nativeCheckpoint:async input=>{if(scenario==='published-pending'&&'messages'in input&&input.messages.some(m=>m.source.kind==='plugin:teloa.session-continuation'))throw Error('续作已发布但原生受理确认丢失');await checkpoint(input)},nativeProgress:async input=>{await progress(input);if(scenario==='claimed-twice'&&'phase'in input&&input.phase==='model')input.agent.cancel({kind:'disposed'})}} satisfies Partial<typeof second.resident>)
   await pump();const prior=second.ctx.agents.get(SessionId(sessionId));assert.ok(prior);await prior.whenIdle();assert.equal(second.model.calls,0)
   second.resident.close();await second.ctx.fiber.dispose();second=await setup(2);second.model.scripts.push(text('继续完成原工作。'))
  }
  try{await Promise.all([pump(),pump()])}catch(error){sub.diagnostic(String((error as Error).stack));throw error}
  const agent=second.ctx.agents.get(SessionId(sessionId));assert.ok(agent,JSON.stringify({checkpoints:(await f.pool.query('select checkpoint from teloa_native_session_checkpoints where owner_id=$1',[owner])).rows,controls:(await f.pool.query('select state,pause_origin,generation from teloa_work_controls where owner_id=$1',[owner])).rows,reports,events:before.map(e=>[e.seq,e.type])}));await agent.whenIdle()
  const after=readSessionEvents(agent.session),trusted=await second.resident.nativeContinuations(await service.get(owner,{runId:prepared.id}),after)
  if(api){
   currentHost=second
   const evidence=observeTaskRun(after,prepared.nativeRequestId,trusted);assert.ok(evidence.state==='ended'&&evidence.reason==='completed')
   await service.record(owner,{runId:prepared.id,sessionId,nativeRequestId:prepared.nativeRequestId,evidence})
   apiNow=new Date(apiNow.getTime()+5000);await api.tick(new AbortController().signal)
   const done=await api.get(apiIdentity!,workId!);assert.equal(done.id,workId);assert.equal(done.state,'succeeded');assert.equal(done.round,1)
   const round=(await f.pool.query('select * from teloa_employee_api_rounds where work_id=$1',[workId])).rows
   assert.equal(round.length,1);assert.equal(round[0].task_id,prepared.taskId);assert.equal(round[0].run_id,prepared.id)
   assert.equal((await f.pool.query('select native_request_id,session_id from teloa_task_runs where id=$1',[prepared.id])).rows[0].native_request_id,prepared.nativeRequestId)
   assert.equal((await f.pool.query('select text from teloa_employee_api_results where work_id=$1 and version=1',[workId])).rows[0].text,'继续完成原工作。')
  }
  assert.deepEqual(after.slice(0,before.length),before,'历史前缀逐事件保留')
  assert.equal(after.filter(e=>e.type==='agent/inbox/spliced'&&e.data.inserted.some(m=>m.id===originalInputs[0]!.data.inserted[0]!.id)).length,1,'原Inbox只实际受理一次')
  assert.equal((await f.pool.query('select count(*)::int n from teloa_task_runs where owner_id=$1 and task_id=$2',[owner,task.id])).rows[0].n,1)
  const records=(await f.pool.query('select record from teloa_native_session_continuations where owner_id=$1',[owner])).rows.map(r=>r.record)
  assert.equal(records.length,scenario==='claimed-twice'?2:1);assert.ok(records.every(r=>r.state==='accepted'&&r.checkpoint.runId===prepared.id&&r.checkpoint.requestId===prepared.nativeRequestId))
  if(scenario==='published-pending'){assert.equal(records[0].hostGeneration,3);assert.equal(records[0].previousAdmissions.length,1);assert.equal(after.filter(e=>e.type==='agent/inbox/spliced'&&e.data.inserted.some(m=>m.source.kind==='plugin:teloa.session-continuation')).length,1,'第三宿主只接原续作Inbox，不再发布第二份续作')}
  if(scenario==='completed-review'){assert.equal(second.model.calls,0,'已成功的最终复核只折叠交付');assert.equal(readTaskRunGroupResult(after,prepared.nativeRequestId,trusted,undefined,{requireReview:true,runId:prepared.id}),'原资料已核对。')}
  else assert.equal(second.model.calls,1)
  if(lastClaim){const control=await second.resident.controls.get(owner,{controlId:prepared.lineage!.roundControlId});await assert.rejects(oldRetries.claim(owner,{operationId:lateOperationId,requestId:randomUUID(),expectedGeneration:control.generation}));assert.equal((await f.pool.query('select 1 from teloa_work_retry_claims where owner_id=$1 and operation_id=$2',[owner,lateOperationId])).rowCount,0)}
  const retired=(await f.pool.query('select * from teloa_work_budget_reservations where id=$1',[oldReservation.id])).rows[0]
  assert.equal(retired.state,'unknown');assert.equal(Number(retired.reserved_tokens),30);assert.equal(retired.actual_tokens,null);assert.ok(retired.elapsed_ended_at);assert.ok(retired.elapsed_terminal)
  if(scenario==='elapsed-downtime'){assert.equal(retired.elapsed_ended_at.toISOString(),new Date(before.at(-1)!.time).toISOString());const used=await second.resident.budgets.read(owner,{budgetAccountId:prepared.lineage!.budgetAccountId});assert.ok(used.usedElapsedMs<500,'只保留已证旧执行耗时，未把10分钟停机清零成实际用量或计入后继时钟')}
  assert.throws(()=>oldLease.assertCurrent(),{code:'teloa/budget-exhausted'})
  await pump();await agent.whenIdle();assert.equal(second.model.calls,scenario==='completed-review'?0:1)
  assert.deepEqual(reports,[])
 })
})

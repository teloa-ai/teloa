import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {Pool} from '../../backend/tests/postgres-test-lifecycle.ts'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {WorkBudgetService,initializeWorkBudgets} from '../../backend/src/work/work-budget.ts'
import {initializeBusinessSpaces} from '../../backend/src/work/business-spaces.ts'
import {initializeProjects,ProjectService} from '../../backend/src/work/projects.ts'
import {initializeProjectContext,ProjectContextService} from '../../backend/src/work/project-context.ts'
import {initializeProjectRuntime,ProjectRuntimeService} from '../../backend/src/work/project-runtime.ts'
import {initializeProjectMemoryExtraction} from '../../backend/src/work/project-memory-extraction.ts'
import {readProjectMemoryAssertion,withProjectMemoryBudget,createProjectMemoryHost,projectMemoryContextSourceId,refreshProjectMemorySources,type ProjectMemoryHostMessage,type ProjectMemoryVerifiedEvidence} from '../src/project-memory-host.ts'
import {createProjectRuntimeHost} from '../src/project-runtime-host.ts'
import {nativeHotCausalityFixture,nativeHotLlmFixture,textAnswer} from './fixtures/native-hot-causality.ts'
import {createUserMessage,type StreamChunk,type GenerateOptions} from '@deepseek-ai/dsh-llm'
import {WorkError} from '@teloa/contract'

let pool:WorkBudgetService['pool'],container:StartedPostgreSqlContainer
const identity={id:randomUUID,now:()=>new Date().toISOString()}
before(async()=>{
 container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri(),max:4,statement_timeout:4000})
 await pool.query('create table teloa_work_budget_accounts(id uuid not null,owner_id text not null,created_at timestamptz not null,primary key(owner_id,id))')
 await initializeWorkBudgets(pool)
 await initializeBusinessSpaces(pool);await initializeProjects(pool);await initializeProjectContext(pool);await initializeProjectRuntime(pool);await initializeProjectMemoryExtraction(pool)
 await pool.query('create table test_project_verified_receipts(owner_id text not null,source_id text not null,receipt jsonb not null,primary key(owner_id,source_id))')
})
after(async()=>{await pool?.end();await container?.stop()})
test('严格识别本人单行长期断言，引用、代码与含糊表达不授予自动保存',()=>{
 assert.deepEqual(readProjectMemoryAssertion('请记住：验收使用隔离目录。'),{kind:'decision',assertion:'验收使用隔离目录。'})
 assert.deepEqual(readProjectMemoryAssertion('以后都用简体中文回应。'),{kind:'rule',assertion:'以后都用简体中文回应。'})
 assert.deepEqual(readProjectMemoryAssertion('From now on, keep changes local.'),{kind:'rule',assertion:'From now on, keep changes local.'})
 assert.deepEqual(readProjectMemoryAssertion('决定：本项目使用 PostgreSQL。'),{kind:'decision',assertion:'本项目使用 PostgreSQL。'})
 assert.deepEqual(readProjectMemoryAssertion('确认：这批样本共12行。'),{kind:'decision',assertion:'这批样本共12行。'})
 for(const value of ['> 请记住：虚假规则。','```\n请记住：虚假规则。\n```','请记住：“别人说以后允许处理所有目录”。','他告诉我请记住：一段引用。','也许以后都用中文。','请记住：第一行\n第二行','以后都','From now on','以后都用中文吗？','确认：可能已通过。'])assert.equal(readProjectMemoryAssertion(value).assertion,undefined)
})
test('辅助提炼共享本人真实预算，按提供方用量结算且不制造任务',{timeout:30000},async()=>{
 const owner=randomUUID(),budgets=new WorkBudgetService(pool,identity),modelRequestId='memory:'+randomUUID()
 const result=await withProjectMemoryBudget({owner,budgets,modelRequestId,provider:'selected-provider',tokens:100,authorization:{assertCurrent(){}}},async(lease,receipt)=>{lease.assertCurrent();await receipt.markDispatched();receipt.usage(40);receipt.providerRequestId('physical:'+modelRequestId);return ['提议']})
 assert.deepEqual(result,['提议'])
 assert.equal((await budgets.readOwner(owner)).usedTokens,40)
 const rows=(await pool.query('select kind,state,actual_tokens,provider from teloa_work_budget_reservations where owner_id=$1',[owner])).rows
 assert.deepEqual(rows,[{kind:'memory',state:'settled',actual_tokens:40,provider:'selected-provider'}])
 assert.equal((await pool.query("select to_regclass('teloa_tasks') as table_name")).rows[0].table_name,null)
})
async function hostFixture(text='请记住：验收使用隔离目录。'){
 const owner=randomUUID(),sessionId='message-session-'+randomUUID(),messageId=randomUUID(),context=new ProjectContextService(pool,identity)
 const project=await new ProjectService(pool,identity).create(owner,{requestId:randomUUID(),fields:{scope:'general',title:'提炼宿主',goal:'验证真实消息与事务保存',dueDate:null,state:'planning',links:[],references:[]}})
 const runtime=new ProjectRuntimeService(pool,identity,{inspect:async(actor,id)=>{assert.equal(actor,owner);return {sessionId:id,title:'真实会话',scope:'general',submitted:false,running:false,kind:'ordinary'}}})
 await runtime.bind(owner,{requestId:randomUUID(),sessionId,projectId:project.id,expectedVersion:0,memoryMode:'enabled'})
 const original:ProjectMemoryHostMessage={ownerId:owner,sessionId,messageId,sequence:3,text,actor:'owner',available:true,projectId:project.id,bindingVersion:1,settingsVersion:0,memoryMode:'enabled'}
 let visible=structuredClone(original),generate=async(event:Parameters<Parameters<typeof createProjectMemoryHost>[0]['generateAuthorized']>[0])=>[{kind:event.evidence[0]?.kind==='rule'?'rule':'memory',topic:'验收目录',markdown:event.evidence[0]?.assertion??'验收使用隔离目录。',evidence:[{evidenceId:event.evidence[0]?.id,quote:event.evidence[0]?.assertion??'验收使用隔离目录。'}]}],syncCurrent=()=>{}
 const inputs:Array<{owner:string;sessionId:string;messageId:string}>=[]
 const hostOptions:Parameters<typeof createProjectMemoryHost>[0]={owner,pool,identity,runtime,context,loadMessage:async(actor,sid,mid)=>{inputs.push({owner:actor,sessionId:sid,messageId:mid});return sid===sessionId&&mid===messageId?structuredClone(visible):null},generateAuthorized:async(event)=>generate(event),resultCurrent:()=>syncCurrent(),worker:{pollMs:60000}}
 const host=createProjectMemoryHost(hostOptions)
 return {owner,sessionId,messageId,project,context,runtime,original,host,hostOptions,inputs,setSource:(change:Partial<ProjectMemoryHostMessage>)=>{visible={...visible,...change}},setGenerate:(value:typeof generate)=>{generate=value},setCurrent:(value:()=>void)=>{syncCurrent=value},close:()=>{host.dispose();runtime.dispose()}}
}
test('真实宿主只读取本轮原消息，默认策略偏移初始0并通过B1同事务自动保存',async t=>{
 const f=await hostFixture();t.after(f.close)
 const queued=await f.host.ingest({sessionId:f.sessionId,messageId:f.messageId});assert.ok(queued)
 await f.host.service.drain(f.owner)
 const detail=await f.context.get(f.owner,{projectId:f.project.id})
 assert.equal(detail.entries.length,1);assert.equal(detail.entries[0]?.markdown,'验收使用隔离目录。')
 assert.ok(f.inputs.length>0);assert.ok(f.inputs.every(input=>input.owner===f.owner&&input.sessionId===f.sessionId&&input.messageId===f.messageId))
 const event=(await pool.query('select event from teloa_project_extraction_events where owner_id=$1',[f.owner])).rows[0].event
 assert.equal(event.bindingVersion,1);assert.equal(event.policyVersion,1)
 await f.host.ingest({sessionId:f.sessionId,messageId:f.messageId});await f.host.service.drain(f.owner)
 assert.equal((await f.context.get(f.owner,{projectId:f.project.id})).entries[0]?.version,1)
})
test('宿主事件只由真实本人消息触发，引用和自主回复不自动保存规则',async t=>{
 for(const actor of ['assistant','runtime'] as const){
  const f=await hostFixture('以后都用简体中文回应。');t.after(f.close);f.setSource({actor})
  assert.equal(await f.host.ingest({sessionId:f.sessionId,messageId:f.messageId}),null)
  assert.equal((await pool.query('select count(*)::int n from teloa_project_extraction_events where owner_id=$1',[f.owner])).rows[0].n,0)
 }
 const f=await hostFixture('有人说：验收使用隔离目录。');t.after(f.close)
 await f.host.ingest({sessionId:f.sessionId,messageId:f.messageId});await f.host.service.drain(f.owner)
 assert.equal((await f.context.get(f.owner,{projectId:f.project.id})).entries.length,0)
 assert.equal((await f.host.service.listCandidates(f.owner,{projectId:f.project.id}))[0]?.status,'candidate')
})
test('原消息正文或受理版本改变时排队事件不能借当前会话归属提交',async t=>{
 for(const change of [{text:'原消息已更改。'},{sequence:9},{ownerId:randomUUID()},{bindingVersion:2},{settingsVersion:1},{available:false}]){
  const f=await hostFixture();t.after(f.close);await f.host.ingest({sessionId:f.sessionId,messageId:f.messageId});f.setSource(change)
  assert.equal((await f.host.service.drain(f.owner)).discarded,1)
  assert.equal((await f.context.get(f.owner,{projectId:f.project.id})).entries.length,0)
 }
})
test('原无记忆消息保留禁再提炼标记，关闭模式不入队也不请求模型',async t=>{
 const f=await hostFixture();t.after(f.close)
 await f.runtime.bind(f.owner,{requestId:randomUUID(),sessionId:f.sessionId,projectId:f.project.id,expectedVersion:1,memoryMode:'off'})
 f.setSource({bindingVersion:2,memoryMode:'off'})
 f.setGenerate(async()=>{throw Error('模型不应调用')})
 assert.equal((await f.host.ingest({sessionId:f.sessionId,messageId:f.messageId}))?.status,'discarded')
 assert.equal((await f.host.service.drain(f.owner)).processed,0)
 assert.equal((await pool.query('select count(*)::int n from teloa_project_extraction_forgotten_sources where owner_id=$1',[f.owner])).rows[0].n,1)
})
test('最终固定许可失效使B1事务回滚，本人明确接受则按直接操作保存',async t=>{
 const f=await hostFixture();t.after(f.close);await f.host.ingest({sessionId:f.sessionId,messageId:f.messageId})
 f.setCurrent(()=>{throw Error('controlled original project token expired')})
 assert.equal((await f.host.service.drain(f.owner)).failed,1)
 assert.equal((await f.context.get(f.owner,{projectId:f.project.id})).version,0)
 const explicit=await hostFixture('有人说：验收使用隔离目录。');t.after(explicit.close)
 await explicit.host.ingest({sessionId:explicit.sessionId,messageId:explicit.messageId});await explicit.host.service.drain(explicit.owner)
 const row=(await explicit.host.service.listCandidates(explicit.owner,{projectId:explicit.project.id}))[0]!
 await explicit.runtime.configure(explicit.owner,{projectId:explicit.project.id,requestId:randomUUID(),expectedVersion:0,automatic:'paused',readPersonal:false,resources:[]})
 explicit.setCurrent(()=>{throw Error('旧自动许可不适用于本人直接接受')})
 await explicit.host.service.resolveCandidate(explicit.owner,{candidateId:row.id,action:'accept',expectedContextVersion:0,requestId:randomUUID()})
 assert.equal((await explicit.context.get(explicit.owner,{projectId:explicit.project.id})).entries[0]?.markdown,'验收使用隔离目录。')
})
test('采纳候选的真实B1修订仍继承原证据，撤权未扫描即拒绝；本人直接编辑的新修订独立可读',async t=>{
 const f=await hostFixture('有人说：验收使用隔离目录。');t.after(f.close)
 await f.host.ingest({sessionId:f.sessionId,messageId:f.messageId});await f.host.service.drain(f.owner)
 const row=(await f.host.service.listCandidates(f.owner,{projectId:f.project.id}))[0]!
 await f.host.service.resolveCandidate(f.owner,{candidateId:row.id,action:'accept',expectedContextVersion:0,requestId:randomUUID(),expectedProjectId:f.project.id})
 const accepted=(await f.context.get(f.owner,{projectId:f.project.id})).entries[0]!,db=await pool.connect()
 try{
  assert.equal(await f.host.service.entryAvailableInTransaction(db,f.owner,{entryId:accepted.id,entryVersion:1}),true)
  f.setSource({available:false})
  assert.equal(await f.host.service.entryAvailableInTransaction(db,f.owner,{entryId:accepted.id,entryVersion:1}),false)
  await f.context.mutate(f.owner,{projectId:f.project.id,requestId:randomUUID(),expectedVersion:1,change:{kind:'save-entry',entryId:accepted.id,entryKind:'memory',topic:accepted.topic,markdown:'本人直接编辑：只使用本轮核实过的资料。'}})
  assert.equal(await f.host.service.entryAvailableInTransaction(db,f.owner,{entryId:accepted.id,entryVersion:2}),true)
  assert.equal((await f.context.get(f.owner,{projectId:f.project.id})).entries[0]?.version,2)
 }finally{db.release()}
})
test('宿主忘记沿B1撤回真实当前条目，停止worker保留未处理持久事件',async t=>{
 const f=await hostFixture();t.after(f.close);const queued=await f.host.ingest({sessionId:f.sessionId,messageId:f.messageId});assert.ok(queued)
 f.host.dispose();assert.equal(await f.host.ingest({sessionId:f.sessionId,messageId:f.messageId}),null)
 assert.equal((await pool.query('select status from teloa_project_extraction_events where owner_id=$1',[f.owner])).rows[0].status,'queued')
 await f.host.service.drain(f.owner)
 assert.equal((await f.context.get(f.owner,{projectId:f.project.id})).entries.length,0)
 // 用同一毫秒时钟明确核对未到期与已到期；PG now() 的微秒部分不应成为夹具的隐式等待。
 const readyAt=identity.now();let recoveryNow=new Date(Date.parse(readyAt)-1).toISOString()
 const recovered=createProjectMemoryHost({...f.hostOptions,identity:{...identity,now:()=>recoveryNow}});t.after(recovered.dispose)
 await pool.query('update teloa_project_extraction_events set next_attempt_at=$2 where owner_id=$1',[f.owner,readyAt])
 assert.deepEqual(await recovered.service.drain(f.owner),{processed:0,completed:0,discarded:0,failed:0})
 recoveryNow=readyAt
 assert.deepEqual(await recovered.service.drain(f.owner),{processed:1,completed:1,discarded:0,failed:0})
 const event=(await pool.query('select event from teloa_project_extraction_events where owner_id=$1',[f.owner])).rows[0].event
 assert.equal((await recovered.service.forgetSource(f.owner,{sourceId:event.sourceId})).withdrawnEntries,1)
 const detail=await f.context.get(f.owner,{projectId:f.project.id});assert.equal(detail.entries[0]?.state,'withdrawn');assert.equal(detail.entries[0]?.markdown,null)
})
test('真实PG忘源撤回事务持本人锁时并发模型与工具许可等待，提交后拒原许可且无死锁',{timeout:15000},async t=>{
 const f=await hostFixture();t.after(f.close)
 f.runtime.ports.memoryAvailable=(db,owner,input)=>f.host.service.entryAvailableInTransaction(db,owner,input)
 await f.host.ingest({sessionId:f.sessionId,messageId:f.messageId});await f.host.service.drain(f.owner)
 const prepared=await f.runtime.prepare(f.owner,{sessionId:f.sessionId,messageId:randomUUID(),query:'验收目录'})
 assert.ok(prepared);assert.match(prepared.text,/验收使用隔离目录/)
 const input={sessionId:f.sessionId,projectId:f.project.id,bindingVersion:prepared.binding.version,generation:prepared.binding.generation,contextVersion:prepared.binding.contextVersion,settingsVersion:prepared.binding.settingsVersion}
 await f.runtime.assertCurrent(f.owner,input)
 let enter!:()=>void,release!:()=>void,blockingPid=0,heldSince=0
 const entered=new Promise<void>(done=>{enter=done}),gate=new Promise<void>(done=>{release=done}),actualWithdraw=f.host.service.ports.withdraw
 f.host.service.ports.withdraw=async(db,owner,value,signal)=>{blockingPid=(await db.query('select pg_backend_pid() pid')).rows[0].pid;heldSince=performance.now();enter();await gate;await actualWithdraw(db,owner,value,signal)}
 t.after(release)
 const source=(await pool.query('select event from teloa_project_extraction_events where owner_id=$1',[f.owner])).rows[0].event
 const forgetting=f.host.service.forgetSource(f.owner,{sourceId:source.sourceId})
 await entered
 let settled=0
 const admissions=['model','tool'].map(async kind=>{try{await f.runtime.assertCurrent(f.owner,input);return {kind,accepted:true,code:null}}catch(error){return {kind,accepted:false,code:(error as {code?:string}).code}}finally{settled++}})
 try{
  const deadline=Date.now()+2500;let waiters=0
  while(Date.now()<deadline){waiters=(await pool.query("select count(*)::int n from pg_stat_activity where $1::integer=any(pg_blocking_pids(pid)) and wait_event_type='Lock' and wait_event='advisory'",[blockingPid])).rows[0].n;if(waiters===2)break;await new Promise<void>(done=>setImmediate(done))}
  assert.equal(waiters,2,'用PostgreSQL实际等待状态证明两条许可核验正被忘源事务阻塞')
  assert.equal(settled,0,'撤回事务未提交前不得放行原上下文许可')
  release();assert.equal((await forgetting).withdrawnEntries,1)
  t.diagnostic(`控闸锁观察窗口 ${Math.round(performance.now()-heldSince)}ms（包含测试协调与数据库查询，不作为性能阈值）`)
  assert.deepEqual(await Promise.all(admissions),[{kind:'model',accepted:false,code:'teloa/version-conflict'},{kind:'tool',accepted:false,code:'teloa/version-conflict'}])
  const fresh=await f.runtime.prepare(f.owner,{sessionId:f.sessionId,messageId:randomUUID(),query:'验收目录'})
  assert.ok(fresh);assert.ok(fresh.binding.generation>prepared.binding.generation);assert.doesNotMatch(fresh.text,/验收使用隔离目录/)
  assert.equal((await f.context.get(f.owner,{projectId:f.project.id})).entries[0]?.state,'withdrawn')
 }finally{release();await forgetting;await Promise.all(admissions)}
})
test('真实项目规则依赖允许提炼；规则撤回使原排队事件失效，版本键保留全依赖',async t=>{
 const f=await hostFixture();t.after(f.close)
 for(let i=0;i<40;i++)await f.context.mutate(f.owner,{requestId:randomUUID(),projectId:f.project.id,expectedVersion:i,change:{kind:'save-entry',entryId:null,entryKind:'rule',topic:'规则'+i,markdown:'当前边界'+i}})
 const rules=(await f.context.get(f.owner,{projectId:f.project.id})).entries
 f.setSource({derivedSourceIds:rules.map(row=>projectMemoryContextSourceId({kind:'rule',id:row.id,version:row.version,hash:row.hash!}))})
 assert.equal((await f.host.ingest({sessionId:f.sessionId,messageId:f.messageId}))?.status,'queued')
 await f.host.service.drain(f.owner)
 assert.equal((await f.context.get(f.owner,{projectId:f.project.id})).entries.filter(row=>row.kind==='memory').length,1)
 const event=(await pool.query('select event from teloa_project_extraction_events where owner_id=$1',[f.owner])).rows[0].event
 assert.equal(event.derivedSourceIds.length,40)
 const other=await hostFixture();t.after(other.close)
 await other.context.mutate(other.owner,{requestId:randomUUID(),projectId:other.project.id,expectedVersion:0,change:{kind:'save-entry',entryId:null,entryKind:'rule',topic:'边界',markdown:'只处理测试数据'}})
 const rule=(await other.context.get(other.owner,{projectId:other.project.id})).entries[0]!
 other.setSource({derivedSourceIds:[projectMemoryContextSourceId({kind:'rule',id:rule.id,version:rule.version,hash:rule.hash!})]})
 await other.host.ingest({sessionId:other.sessionId,messageId:other.messageId})
 await other.context.mutate(other.owner,{requestId:randomUUID(),projectId:other.project.id,expectedVersion:1,change:{kind:'withdraw-entry',entryId:rule.id}})
 assert.equal((await other.host.service.drain(other.owner)).discarded,1)
 assert.equal((await other.context.get(other.owner,{projectId:other.project.id})).entries.some(row=>row.kind==='memory'),false)
})
test('真实固定分享依赖不跟随源条目修订，但撤销原分享后旧事件不能写入',async t=>{
 const f=await hostFixture();t.after(f.close)
 const source=await new ProjectService(pool,identity).create(f.owner,{requestId:randomUUID(),fields:{scope:'general',title:'分享源',goal:'提供固定经验',dueDate:null,state:'planning',links:[],references:[]}})
 await f.context.mutate(f.owner,{requestId:randomUUID(),projectId:source.id,expectedVersion:0,change:{kind:'save-entry',entryId:null,entryKind:'memory',topic:'来源',markdown:'获准第一版经验'}})
 const entry=(await f.context.get(f.owner,{projectId:source.id})).entries[0]!
 await f.context.mutate(f.owner,{requestId:randomUUID(),projectId:source.id,expectedVersion:1,change:{kind:'share',entryId:entry.id,entryVersion:1,targetProjectId:f.project.id}})
 const share=(await f.context.get(f.owner,{projectId:f.project.id})).shares[0]!
 f.setSource({derivedSourceIds:[projectMemoryContextSourceId({kind:'share',id:share.id,version:share.entryVersion,hash:share.hash!})]})
 await f.context.mutate(f.owner,{requestId:randomUUID(),projectId:source.id,expectedVersion:2,change:{kind:'save-entry',entryId:entry.id,entryKind:'memory',topic:'来源',markdown:'第二版经验'}})
 assert.equal((await f.host.ingest({sessionId:f.sessionId,messageId:f.messageId}))?.status,'queued')
 await f.context.mutate(f.owner,{requestId:randomUUID(),projectId:f.project.id,expectedVersion:1,change:{kind:'revoke-share',shareId:share.id}})
 assert.equal((await f.host.service.drain(f.owner)).discarded,1)
 assert.equal((await f.context.get(f.owner,{projectId:f.project.id})).entries.length,0)
})
async function verifiedFixture(){
 const f=await hostFixture('按本轮检查结果整理资料。'),sourceId='completion:'+randomUUID(),assertion='导入样本共12行，其中12行均通过结构检查。'
 const receipt:ProjectMemoryVerifiedEvidence={sourceId,ownerId:f.owner,sessionId:f.sessionId,messageId:f.messageId,receiptId:randomUUID(),version:1,text:'验证报告：'+assertion,assertion,available:true,kind:'artifact'}
 await pool.query('insert into test_project_verified_receipts values($1,$2,$3)',[f.owner,sourceId,receipt])
 f.hostOptions.loadVerifiedEvidence=async(actor,id,db)=>(await(db??pool).query('select receipt from test_project_verified_receipts where owner_id=$1 and source_id=$2',[actor,id])).rows[0]?.receipt??null
 f.setGenerate(async event=>{const proof=event.evidence.find(e=>e.kind==='verified');return proof?[{kind:'memory',topic:'样本结构检查',markdown:proof.assertion!,evidence:[{evidenceId:proof.id,quote:proof.assertion!}]}]:[]})
 return {...f,sourceId,receipt,assertion,updateReceipt:async(change:Partial<ProjectMemoryVerifiedEvidence>)=>{Object.assign(receipt,change);await pool.query('update test_project_verified_receipts set receipt=$3 where owner_id=$1 and source_id=$2',[f.owner,sourceId,receipt])}}
}
test('verified恢复入队遇瞬态失败向扫描器保留位置，普通轮次入口不被阻断',async t=>{
 const f=await verifiedFixture();t.after(f.close)
 await f.runtime.configure(f.owner,{projectId:f.project.id,requestId:randomUUID(),expectedVersion:0,automatic:'verified',readPersonal:false,resources:[]});f.setSource({settingsVersion:1})
 const read=f.hostOptions.loadVerifiedEvidence!,input={sessionId:f.sessionId,messageId:f.messageId,verifiedSourceIds:[f.sourceId]},conflict=new WorkError('teloa/dependency-unavailable','受控并发变化',{retryable:true})
 f.hostOptions.loadVerifiedEvidence=async()=>{throw conflict}
 assert.equal(await f.host.ingest(input),null)
 await assert.rejects(f.host.ingest(input,{retryOnTransient:true}),error=>error===conflict)
 assert.equal((await pool.query('select count(*)::int n from teloa_project_extraction_events where owner_id=$1',[f.owner])).rows[0].n,0)
 f.hostOptions.loadVerifiedEvidence=read
 const queued=await f.host.ingest(input,{retryOnTransient:true});assert.equal(queued?.status,'queued')
 await f.host.service.drain(f.owner)
 assert.equal((await f.context.get(f.owner,{projectId:f.project.id})).entries[0]?.markdown,f.assertion)
})
test('已持久verified事件的事务内瞬态核验冲突保留原事件等待下一次drain',async t=>{
 const f=await verifiedFixture();t.after(f.close)
 await f.runtime.configure(f.owner,{projectId:f.project.id,requestId:randomUUID(),expectedVersion:0,automatic:'verified',readPersonal:false,resources:[]});f.setSource({settingsVersion:1})
 const queued=await f.host.ingest({sessionId:f.sessionId,messageId:f.messageId,verifiedSourceIds:[f.sourceId]});assert.ok(queued)
 const read=f.hostOptions.loadVerifiedEvidence!;let conflicted=false
 f.hostOptions.loadVerifiedEvidence=async(actor,id,db)=>{if(db&&!conflicted){conflicted=true;throw new WorkError('teloa/dependency-unavailable','受控事务内冲突',{retryable:true})}return read(actor,id,db)}
 assert.equal((await f.host.service.drain(f.owner)).failed,1)
 const pending=(await pool.query('select status,attempts,error_code from teloa_project_extraction_events where owner_id=$1 and event_id=$2',[f.owner,queued.eventId])).rows[0]
 assert.deepEqual(pending,{status:'queued',attempts:1,error_code:'teloa/dependency-unavailable'})
 await pool.query('update teloa_project_extraction_events set next_attempt_at=now() where owner_id=$1 and event_id=$2',[f.owner,queued.eventId])
 assert.equal((await f.host.service.drain(f.owner)).completed,1)
 assert.equal((await f.context.get(f.owner,{projectId:f.project.id})).entries[0]?.markdown,f.assertion)
})
test('预选verified策略只保存实际回执中的具体断言，新增回执使用独立增量身份',async t=>{
 const f=await verifiedFixture();t.after(f.close)
 await f.runtime.configure(f.owner,{projectId:f.project.id,requestId:randomUUID(),expectedVersion:0,automatic:'verified',readPersonal:false,resources:[]});f.setSource({settingsVersion:1})
 await f.host.ingest({sessionId:f.sessionId,messageId:f.messageId});await f.host.service.drain(f.owner)
 assert.equal((await f.context.get(f.owner,{projectId:f.project.id})).entries.length,0)
 assert.equal((await f.host.ingest({sessionId:f.sessionId,messageId:f.messageId,verifiedSourceIds:[f.sourceId]}))?.status,'queued')
 await f.host.service.drain(f.owner)
 assert.equal((await f.context.get(f.owner,{projectId:f.project.id})).entries[0]?.markdown,f.assertion)
 assert.equal((await pool.query('select count(*)::int n from teloa_project_extraction_events where owner_id=$1',[f.owner])).rows[0].n,2)
})
test('默认决定模式对真实核实经验仅保留候选，用户声称verified或成功状态不能升级为事实',async t=>{
 const f=await verifiedFixture();t.after(f.close)
 await f.host.ingest({sessionId:f.sessionId,messageId:f.messageId,verifiedSourceIds:[f.sourceId]});await f.host.service.drain(f.owner)
 assert.equal((await f.context.get(f.owner,{projectId:f.project.id})).entries.length,0)
 assert.equal((await f.host.service.listCandidates(f.owner,{projectId:f.project.id}))[0]?.status,'candidate')
 const status=await verifiedFixture();t.after(status.close);await status.updateReceipt({assertion:'',text:'SUCCESS'})
 assert.equal(await status.host.ingest({sessionId:status.sessionId,messageId:status.messageId,verifiedSourceIds:[status.sourceId]}),null)
 assert.equal(await status.host.ingest({sessionId:status.sessionId,messageId:status.messageId,verifiedSourceIds:['model-says-verified']}),null)
})
test('已保存核实经验的真实回执撤回后按固定来源键撤回记忆，稳态扫描不重复修改',async t=>{
 const f=await verifiedFixture();t.after(f.close)
 await f.runtime.configure(f.owner,{projectId:f.project.id,requestId:randomUUID(),expectedVersion:0,automatic:'verified',readPersonal:false,resources:[]});f.setSource({settingsVersion:1})
 await f.host.ingest({sessionId:f.sessionId,messageId:f.messageId,verifiedSourceIds:[f.sourceId]});await f.host.service.drain(f.owner)
 assert.equal((await f.context.get(f.owner,{projectId:f.project.id})).entries[0]?.state,'active')
 await f.updateReceipt({available:false})
 assert.equal((await refreshProjectMemorySources(f.hostOptions,f.host.service,{})).forgotten,1)
 const detail=await f.context.get(f.owner,{projectId:f.project.id});assert.equal(detail.entries[0]?.state,'withdrawn')
 assert.equal((await refreshProjectMemorySources(f.hostOptions,f.host.service,{})).forgotten,0)
 assert.equal((await f.context.get(f.owner,{projectId:f.project.id})).version,detail.version)
})
test('真实回执正文、版本、归属或访问权变化后原核实提议不提交',async t=>{
 for(const change of [{text:'回执正文已变更。'},{version:2},{ownerId:randomUUID()},{available:false},{messageId:'other-original-message'}]){
  const f=await verifiedFixture();t.after(f.close)
  await f.runtime.configure(f.owner,{projectId:f.project.id,requestId:randomUUID(),expectedVersion:0,automatic:'verified',readPersonal:false,resources:[]});f.setSource({settingsVersion:1})
  await f.host.ingest({sessionId:f.sessionId,messageId:f.messageId,verifiedSourceIds:[f.sourceId]});await f.updateReceipt(change)
  assert.equal((await f.host.service.drain(f.owner)).discarded,1)
  assert.equal((await f.context.get(f.owner,{projectId:f.project.id})).entries.length,0)
 }
})
test('派发前取消或许可失效不会消耗；发出后失败未知保留并发占用',async()=>{
 const owner=randomUUID(),budgets=new WorkBudgetService(pool,identity),abort=new AbortController();abort.abort()
 const input={owner,budgets,modelRequestId:'memory:'+randomUUID(),provider:'selected-provider',tokens:100,authorization:{assertCurrent(){}}}
 await assert.rejects(withProjectMemoryBudget({...input,signal:abort.signal},async()=>['禁止调用']),{name:'AbortError'})
 assert.equal((await budgets.readOwner(owner)).usedTokens,0)
 await assert.rejects(withProjectMemoryBudget({...input,authorization:{assertCurrent(){throw Error('controlled revoked authorization')}}},async()=>['禁止调用']),/revoked/)
 assert.equal((await budgets.readOwner(owner)).usedTokens,0)
 await assert.rejects(withProjectMemoryBudget(input,async(_lease,receipt)=>{await receipt.markDispatched();throw Error('controlled lost result')}),/lost result/)
 const unknown=await budgets.readOwner(owner);assert.equal(unknown.usedTokens,100);assert.equal(unknown.concurrent,1)
 const reservation=(await pool.query('select id,state from teloa_work_budget_reservations where owner_id=$1',[owner])).rows[0]
 assert.equal(reservation.state,'unknown');await assert.rejects(budgets.releaseUnaccepted(owner,{reservationId:reservation.id}),{code:'teloa/conflict'})
})
test('真实SDK私有闸拒绝零次物理派发时释放提炼预算，不制造未知消耗',async t=>{
 const f=await nativeHotCausalityFixture(t),owner=randomUUID(),budgets=new WorkBudgetService(pool,identity)
 const request=Object.freeze({provider:'hot-test',model:'hot-model',sessionId:f.agent.id,messages:Object.freeze([])})
 await assert.rejects(withProjectMemoryBudget({owner,budgets,modelRequestId:'memory:'+randomUUID(),provider:'hot-test',tokens:100,authorization:{assertCurrent(){}}},async()=>{for await(const _chunk of f.ctx.llm.stream(request as unknown as GenerateOptions)){};return []}),{code:'teloa/forbidden'})
 assert.equal(f.adapter.requests.length,0)
 assert.equal((await budgets.readOwner(owner)).usedTokens,0);assert.equal((await budgets.readOwner(owner)).concurrent,0)
 assert.equal((await pool.query('select state from teloa_work_budget_reservations where owner_id=$1',[owner])).rows[0].state,'released')
})
test('真实SDK受审派发入口已调用适配器后失败仍结未知，不从缺少delta释放额度',async t=>{
 const f=await nativeHotLlmFixture(t),owner=randomUUID(),budgets=new WorkBudgetService(pool,identity)
 await assert.rejects(withProjectMemoryBudget({owner,budgets,modelRequestId:'memory:'+randomUUID(),provider:'hot-test',tokens:100,authorization:{assertCurrent(){}}},async(_lease,receipt)=>{
  const install=Reflect.get(Object.getPrototypeOf(f.llm) as object,'installStreamProjection') as unknown
  assert.equal(typeof install,'function')
  Reflect.apply(install as (...args:unknown[])=>unknown,f.llm,[(_original:unknown,resolved:Readonly<GenerateOptions>)=>Object.freeze({...resolved,messages:Object.freeze([...resolved.messages])}),async()=>receipt.markDispatched()])
  for await(const chunk of f.llm.stream(f.request()))if(chunk.type==='finish'&&chunk.reason.kind==='error')throw Error('真实适配器调用失败');return []
 }),/真实适配器调用失败/)
 assert.equal(f.adapter.requests.length,1);assert.equal(f.adapter.yielded.length,0)
 assert.equal((await budgets.readOwner(owner)).usedTokens,100);assert.equal((await budgets.readOwner(owner)).concurrent,1)
 assert.equal((await pool.query('select state from teloa_work_budget_reservations where owner_id=$1',[owner])).rows[0].state,'unknown')
})
test('原许可在预留后失效释放未发额度，用量回报后的失败仍按真实消耗结算',async()=>{
 const owner=randomUUID(),budgets=new WorkBudgetService(pool,identity);let checks=0
 const authorization={assertCurrent(){if(++checks>1)throw Error('controlled authorization changed')}}
 await assert.rejects(withProjectMemoryBudget({owner,budgets,modelRequestId:'memory:'+randomUUID(),provider:'selected-provider',tokens:100,authorization},async()=>['禁止调用']),/changed/)
 assert.equal((await budgets.readOwner(owner)).usedTokens,0)
 assert.equal((await pool.query('select state from teloa_work_budget_reservations where owner_id=$1',[owner])).rows[0].state,'released')
 await assert.rejects(withProjectMemoryBudget({owner,budgets,modelRequestId:'memory:'+randomUUID(),provider:'selected-provider',tokens:100,authorization:{assertCurrent(){}}},async(_lease,receipt)=>{await receipt.markDispatched();receipt.usage(27);throw Error('controlled after usage')}),/after usage/)
 assert.equal((await budgets.readOwner(owner)).usedTokens,27);assert.equal((await budgets.readOwner(owner)).concurrent,0)
})
test('routing与memory共用本人累计额度和并发，不能建新辅助账户绕过未知消耗',async()=>{
 const owner=randomUUID(),budgets=new WorkBudgetService(pool,identity,{authorize:async()=>({assertCurrent(){}})}),policy=await budgets.readOwner(owner)
 await budgets.configureOwner(owner,{requestId:randomUUID(),expectedVersion:1,policy:{...policy.policy,maxTokens:200,maxConcurrent:1}})
 const routing=await budgets.reserveOwnerRouting(owner,{modelRequestId:'routing:'+randomUUID(),tokens:100});await budgets.markDispatched(owner,{reservationId:routing.id})
 await assert.rejects(budgets.reserveOwnerMemory(owner,{modelRequestId:'memory:'+randomUUID(),tokens:100}),{code:'teloa/budget-exhausted',details:{reason:'concurrent',scope:'owner'}})
 await budgets.settle(owner,{reservationId:routing.id,modelRequestId:routing.modelRequestId,provider:'selected-provider',providerRequestId:null,tokens:50,moneyMinorUnits:null,currency:null,receiptId:randomUUID()})
 const memory=await budgets.reserveOwnerMemory(owner,{modelRequestId:'memory:'+randomUUID(),tokens:150})
 assert.equal(memory.kind,'memory');assert.equal(memory.budgetAccountId,routing.budgetAccountId)
 await assert.rejects(budgets.reserveOwnerRouting(owner,{modelRequestId:'routing:'+randomUUID(),tokens:1}),{code:'teloa/budget-exhausted',details:{reason:'tokens',scope:'owner'}})
})
test('旧预算kind约束升级可重复执行，保留原routing回执并允许memory真实预留',async t=>{
 const schema='memory_budget_'+randomUUID().replaceAll('-','')
 await pool.query('create schema "'+schema+'"')
 const legacy=new Pool({connectionString:container.getConnectionUri(),options:'-csearch_path='+schema});t.after(()=>legacy.end())
 await legacy.query('create table teloa_work_budget_accounts(id uuid not null,owner_id text not null,created_at timestamptz not null,primary key(owner_id,id))')
 await initializeWorkBudgets(legacy)
 const owner=randomUUID(),budgets=new WorkBudgetService(legacy,identity),routing=await budgets.reserveOwnerRouting(owner,{modelRequestId:'routing:'+randomUUID(),tokens:10})
 await legacy.query("alter table teloa_work_budget_reservations drop constraint teloa_work_budget_reservations_kind_check;alter table teloa_work_budget_reservations add constraint teloa_work_budget_reservations_kind_check check(kind in ('goal','team','routing','retry'))")
 await initializeWorkBudgets(legacy);await initializeWorkBudgets(legacy)
 const memory=await budgets.reserveOwnerMemory(owner,{modelRequestId:'memory:'+randomUUID(),tokens:15})
 assert.equal(memory.kind,'memory');assert.equal(memory.budgetAccountId,routing.budgetAccountId)
 assert.equal((await budgets.readOwner(owner)).usedTokens,25)
 assert.equal((await legacy.query('select state,kind from teloa_work_budget_reservations where id=$1',[routing.id])).rows[0].kind,'routing')
})
test('真实原生SDK成功轮次自动入队，经私有辅助许可和本人预算保存B1规则依赖下的决定',{timeout:30000},async t=>{
 const f=await nativeHotCausalityFixture(t),owner=randomUUID(),context=new ProjectContextService(pool,identity),budgets=new WorkBudgetService(pool,identity)
 const project=await new ProjectService(pool,identity).create(owner,{requestId:randomUUID(),fields:{scope:'general',title:'原生SDK项目',goal:'真实模型闸口验证',dueDate:null,state:'planning',links:[],references:[]}})
 await context.mutate(owner,{projectId:project.id,requestId:randomUUID(),expectedVersion:0,change:{kind:'save-entry',entryId:null,entryKind:'rule',topic:'边界',markdown:'只处理本轮测试资料。'}})
 const codes:string[]=[],host=createProjectRuntimeHost(f.ctx,{owner,pool,budgets,nativeInput:f.work,inspect:async(actor,sessionId)=>{assert.equal(actor,owner);return {sessionId,title:'原生普通会话',scope:'general',submitted:false,running:false,kind:'ordinary'}},sessions:async()=>[],resource:async()=>{throw Error('未选择资料')},model:async()=>({provider:'hot-test',model:'hot-model',maxTokens:256}),authorize:async()=>({assertCurrent(){}}),checkText(){},report:code=>codes.push(code),conversation:async(actor,sessionId)=>{assert.equal(actor,owner);return {id:randomUUID(),ownerId:owner,title:'原生会话',scopeIds:['general'],version:1,status:'ready',requestedSessionId:sessionId,sessionId,createdAt:identity.now()}}})
 t.after(host.dispose)
 await host.runtime.bind(owner,{requestId:randomUUID(),sessionId:f.agent.id,projectId:project.id,expectedVersion:0,memoryMode:'enabled'})
 f.adapter.scripts.push(textAnswer)
 const message=createUserMessage({source:{kind:'user',rpcId:randomUUID()},content:[{type:'text',text:'请记住：验收使用隔离目录。'}]})
 await f.work.withNewInput(f.agent,message,{producer:'prompt',identity:message.id},()=>f.agent.followup(message));await f.agent.whenIdle()
 const deadline=Date.now()+3000
 while(!(await pool.query('select 1 from teloa_project_extraction_events where owner_id=$1',[owner])).rowCount&&Date.now()<deadline)await new Promise(done=>setTimeout(done,20))
 assert.equal((await pool.query('select count(*)::int n from teloa_project_extraction_events where owner_id=$1',[owner])).rows[0].n,1,'实际SDK turn/end必须触发原消息入队')
 const source=f.events().find(event=>event.type==='user/message'&&event.data.id===message.id)!
 const proposal=[{kind:'memory',topic:'验收目录',markdown:'验收使用隔离目录。',evidence:[{evidenceId:'message:'+source.seq,quote:'验收使用隔离目录。'}]}]
 const chunks:StreamChunk[]=[{type:'block-start',index:0,blockType:'text'},{type:'block-end',index:0,block:{type:'text',text:JSON.stringify(proposal)}},{type:'usage',usage:{inputTokens:7,outputTokens:3,totalTokens:10}},{type:'finish',reason:{kind:'stop'}}]
 f.adapter.scripts.push(chunks)
 const result=await host.memory.drain(owner)
 assert.equal(result.completed,1,JSON.stringify(codes))
 const detail=await context.get(owner,{projectId:project.id})
 assert.equal(detail.entries.find(entry=>entry.kind==='memory')?.markdown,'验收使用隔离目录。')
 assert.equal((await budgets.readOwner(owner)).usedTokens,10)
 assert.equal(f.adapter.requests.length,2)
 assert.equal((await pool.query("select count(*)::int n from teloa_work_budget_reservations where owner_id=$1 and kind='memory' and state='settled'",[owner])).rows[0].n,1)
 assert.equal(f.adapter.requests[1]?.tools,undefined);assert.equal(f.adapter.requests[1]?.toolHistory,undefined)
 const rule=detail.entries.find(entry=>entry.kind==='rule')!
 await context.mutate(owner,{projectId:project.id,requestId:randomUUID(),expectedVersion:detail.version,change:{kind:'withdraw-entry',entryId:rule.id}})
 const forgottenDeadline=Date.now()+3000
 while((await context.get(owner,{projectId:project.id})).entries.find(entry=>entry.kind==='memory')?.state==='active'&&Date.now()<forgottenDeadline)await new Promise(done=>setTimeout(done,20))
 assert.equal((await context.get(owner,{projectId:project.id})).entries.find(entry=>entry.kind==='memory')?.state,'withdrawn','真实宿主来源监听必须按精确依赖撤回已保存记忆')
})

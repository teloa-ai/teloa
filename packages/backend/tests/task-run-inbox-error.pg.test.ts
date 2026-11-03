import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID,createHash} from 'node:crypto'
import {readFile,realpath,lstat} from 'node:fs/promises'
import {dirname,isAbsolute,join} from 'node:path'
import type {Pool as PgPool,PoolClient} from 'pg'
import {Pool} from './postgres-test-lifecycle.ts'
import {initializeTeloaDatabase} from '../src/work/initialize-database.ts'
import {RoleService} from '../src/work/roles.ts'
import {TaskService} from '../src/work/tasks.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'
import {TaskRunService} from '../src/work/task-runs.ts'
import {ObjectConversationService} from '../src/work/object-conversations.ts'
import {TaskRunRuntimeLinkService} from '../src/work/task-run-runtime-links.ts'
import {TaskRunSubmissionService} from '../src/work/task-run-submission.ts'
import {WorkBudgetService} from '../src/work/work-budget.ts'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {patchedSessionFixture} from '../../harness-dsh/tests/fixtures/native-final-session.ts'
import {createNativeWorkInput} from '../../harness-dsh/src/native-work-input.ts'
import {dshTaskRunPorts} from '../../harness-dsh/src/task-run-dsh.ts'
import {readSessionEvents} from '../../harness-dsh/src/session-events.ts'

const identity={id:randomUUID,now:()=>new Date().toISOString()}
const configPath=process.env.TELOA_INBOX_ERROR_PG_CONFIG,hash=(s:string)=>createHash('sha256').update(s).digest('hex')
const deferred=()=>{let release!:()=>void;const wait=new Promise<void>(done=>{release=done});return {wait,release}}
type QueryHook=(sql:string,args:unknown[],client:PoolClient)=>Promise<void>
/** 只插入真实SQL前后的并发栅栏，不替换SQL结果或readVerified。 */
function observedPool(pool:Pool,hooks:{before?:QueryHook;after?:QueryHook}):PgPool{
 return new Proxy(pool,{get(target,key){if(key==='connect')return async()=>{const client=await target.connect();return new Proxy(client,{get(c,k){if(k==='query')return async(sql:string,args:unknown[]=[])=>{await hooks.before?.(sql,args,c);const result=await c.query(sql,args);await hooks.after?.(sql,args,c);return result};const value=Reflect.get(c,k);return typeof value==='function'?value.bind(c):value}})};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value}})
}

test('149 真PG：实际SDK受理失败的原子结算、回滚与markDispatched并发', {skip:!configPath,timeout:180000},async t=>{
 assert.ok(isAbsolute(configPath!),'只接受显式私有测试配置，不回退本机默认连接')
 const info=await lstat(configPath!);assert.equal(info.isSymbolicLink(),false);assert.equal(info.mode&0o077,0)
 const cfg=JSON.parse(await readFile(configPath!,'utf8')) as {connectionString:string;databaseName:string;fixtureRoot:string;fixtureId:string;dataDirectory:string;port:number;systemIdentifier:string}
 assert.match(cfg.databaseName,/^j149_inbox_error(?:_resume[0-9]+)?$/)
 assert.ok(isAbsolute(cfg.fixtureRoot));const root=await realpath(cfg.fixtureRoot);assert.equal(root,cfg.fixtureRoot)
 assert.match(cfg.fixtureId,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)
 assert.equal(dirname(await realpath(configPath!)),join(root,'private'));assert.equal(cfg.dataDirectory,join(root,'pgdata'))
 const dataInfo=await lstat(cfg.dataDirectory);assert.equal(dataInfo.isSymbolicLink(),false);assert.ok(dataInfo.isDirectory())
 const provenance=JSON.parse(await readFile(join(root,'private/pg-provenance.json'),'utf8'))
 assert.equal(provenance.schema,'teloa.pg-test-owned/v1');assert.equal(provenance.fixtureId,cfg.fixtureId);assert.equal(provenance.pgdata,cfg.dataDirectory);assert.equal(provenance.device,dataInfo.dev);assert.equal(provenance.inode,dataInfo.ino)
 assert.match(cfg.systemIdentifier,/^\d+$/);assert.equal(provenance.systemIdentifier,cfg.systemIdentifier)
 assert.equal((await readFile(join(cfg.dataDirectory,'global/pg_control'))).readBigUInt64LE(0).toString(),cfg.systemIdentifier)
 const url=new URL(cfg.connectionString);assert.equal(url.hostname,'127.0.0.1');assert.equal(Number(url.port),cfg.port);assert.equal(url.pathname,'/'+cfg.databaseName);assert.equal(url.username,'j149')
 const pool=new Pool({connectionString:cfg.connectionString,max:6,connectionTimeoutMillis:3000,statement_timeout:10000,application_name:'j149-settlement'});pool.on('error',()=>{})
 t.after(()=>pool.end())
 assert.equal((await pool.query('select current_database() as name')).rows[0].name,cfg.databaseName)
 assert.equal(await realpath((await pool.query('show data_directory')).rows[0].data_directory),await realpath(cfg.dataDirectory))
 assert.equal((await pool.query('select system_identifier::text as id from pg_control_system()')).rows[0].id,cfg.systemIdentifier)
 assert.equal((await pool.query("select count(*)::int as n from pg_tables where schemaname='public'")).rows[0].n,0,'仅新空专库初始化')
 await initializeTeloaDatabase(pool)
 // 同一小型官方SDK私有图复用；全图临时副本由TMPDIR限制在本轮目录，provider从不注册。
 assert.equal(process.env.TMPDIR,root+'/tmp')
 const harnessRequire=createRequire(new URL('../../harness-dsh/package.json',import.meta.url)),{createUserMessage}=await import(pathToFileURL(harnessRequire.resolve('@deepseek-ai/dsh-llm')).href)
 const sdk=await patchedSessionFixture(t)
 sdk.ctx.provide('jobs',{list:()=>[],events:{subscribe:()=>()=>{}},get:()=>{throw Error('本例没有Job')}} as never)
 const native=createNativeWorkInput(sdk.ctx,{authorize:async()=>({assertCurrent(){}}),authorizeSessionCapabilities:async()=>({assertCurrent(){}})} as never)
 // Agent/Session/Inbox/Loop/opaque工厂为真实实现；持久化flush端口受控，不冒充冷磁盘/installed验收。
 Object.defineProperty(sdk.sessions,'flush',{configurable:true,writable:true,value:async()=>true})
 async function fixture(){
  const owner=randomUUID(),role=await new RoleService(pool,identity).create(owner,{requestId:randomUUID(),fields:{name:'核对同事',kind:'employee',scopes:['general'],duty:'核对材料',dataScope:'本轮合成资料',executionScope:'只读',skills:[],knowledge:[],responsibility:testRoleResponsibility,runtimeConfig:{agentPresetId:'teloa-standard'}}})
  // 正常创建同时登记执行谱系；不使用仅插Task行的旧夹具绕过prepare归属核对。
  const task=await new TaskService(pool,identity).create(owner,{requestId:randomUUID(),fields:{title:'版本小结',goal:'核对材料',scope:'general'},assignee:{roleId:role.id,expectedVersion:role.version}}),taskId=task.id
  const {agent}=await sdk.ctx.agents.create({sessionId:sdk.sessionPackage.SessionId('pg149-'+randomUUID()),agentOptions:{provider:'test',model:'test'}})
  const sessionId=String(agent.id),conversationId=randomUUID(),inspect=async()=>({id:conversationId,ownerId:owner,sessionId,status:'ready'}),runtimeId=randomUUID(),links=new TaskRunRuntimeLinkService(pool)
  await new ObjectConversationService(pool,inspect,identity.now).change(owner,{requestId:randomUUID(),kind:'task',objectId:taskId,expectedObjectVersion:1,sessionId,expectedLinkVersion:0,action:'link'})
  let callbacks=0
  const makeRuns=(p:PgPool=pool)=>new TaskRunService(p,identity,inspect,{allowedTools:['get_goal'],onSettled:async()=>{callbacks++}})
  const runs=makeRuns(),prepared=await runs.prepare(owner,{requestId:randomUUID(),taskId,expectedTaskVersion:1,roleId:role.id,expectedRoleVersion:role.version,sessionId,expectedLinkVersion:1}),{run:claimed,dispatch}=await runs.claim(owner,{runId:prepared.id})
  assert.equal(dispatch,true)
  await links.put(owner,{runId:claimed.id,sessionId,kind:'job',nativeId:'owner:'+runtimeId+':'+sessionId,payload:{record:'owner',runtimeId,requestId:claimed.nativeRequestId}})
  const submissions=new TaskRunSubmissionService(pool),ticket=await submissions.begin(owner,claimed,runtimeId)
  const release=agent.ctx.on('agent/pre-step',()=>{throw Error('149合成pre-step失败；没有provider')})
  const message=createUserMessage({content:[{type:'text',text:claimed.inputText}],source:{kind:'user',rpcId:claimed.nativeRequestId}})
  try{await native.withNewInput(agent,message,{producer:'task-run',identity:claimed.id},()=>agent.followup(message));await agent.whenIdle()}finally{release()}
  const events=readSessionEvents(agent.session);assert.equal(events.some(e=>e.type==='user/message'||e.type==='request/header'||e.type==='assistant/message'||e.type.startsWith('tool/')),false)
  await submissions.finish(owner,ticket,'accepted')
  const run=await runs.record(owner,{runId:claimed.id,sessionId,nativeRequestId:claimed.nativeRequestId,evidence:{state:'accepted'}})
  const operationId='149:'+randomUUID(),modelRequestId='149-model:'+randomUUID()
  // 仅新测试对象的预算种子；不伪造旧现场或任何原生事件。
  await pool.query("insert into teloa_work_retries(owner_id,operation_id,run_id,budget_account_id,attempts,max_attempts,state,last_reason,created_at,updated_at) values($1,$2,$3,$4,1,3,'unknown','本轮真PG预算种子',now(),now())",[owner,operationId,run.id,run.lineage!.budgetAccountId])
  await pool.query('insert into teloa_work_retry_claims(owner_id,request_id,operation_id,attempt,model_request_id,spec) values($1,$2,$3,1,$4,$5)',[owner,randomUUID(),operationId,modelRequestId,JSON.stringify({synthetic:true})])
  const budgets=new WorkBudgetService(pool,identity),reservation=await budgets.reserve(owner,{budgetAccountId:run.lineage!.budgetAccountId,controlGeneration:run.lineage!.controlGeneration,modelRequestId,kind:'retry',tokens:17,rounds:0})
  const ports=dshTaskRunPorts(sdk.ctx,owner,inspect,undefined,undefined,undefined,undefined,undefined,undefined,{list:input=>links.list(owner,input),put:async()=>{throw Error('不新增宿主关联')}},undefined,undefined,native,undefined,runtimeId)
  ports.subagentState=async()=>'none';ports.flowState=async()=>'none'
  const settle=async(p:PgPool=pool)=>{let entered=false;const result=await ports.withAcceptedInboxFailureFence!(run,new AbortController().signal,async fence=>{entered=true;return makeRuns(p).recordAcceptedInboxFailure(owner,fence)});assert.equal(entered,true,'必须由真实SDK与生产opaque工厂签发');assert.ok(result);return result}
  const snapshot=async()=>({task:(await pool.query('select * from teloa_tasks where owner_id=$1 and id=$2',[owner,taskId])).rows[0],run:(await pool.query('select state,evidence,stop_requested_at,input_text,group_publication,group_publication_next_at,owner_result_pending,group_result_manifest from teloa_task_runs where owner_id=$1 and id=$2',[owner,run.id])).rows[0],owner:(await pool.query('select owner_settlement from teloa_task_run_runtime_links where owner_id=$1 and run_id=$2',[owner,run.id])).rows[0].owner_settlement,budget:(await pool.query('select state,settled_at,elapsed_ended_at from teloa_work_budget_reservations where id=$1',[reservation.id])).rows[0],ticket:(await pool.query('select * from teloa_task_run_submissions where run_id=$1',[run.id])).rows})
  return {owner,run,taskId,settle,snapshot,budgets,reservation,callbacks:()=>callbacks,events}
 }
 function assertSettled(s:Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['snapshot']>>){assert.equal(s.task.state,'blocked');assert.equal(s.run.state,'ended');assert.equal(s.run.evidence.reason,'error');assert.equal(s.run.evidence.inputAnchor.kind,'accepted-inbox-error');assert.equal(s.owner.evidence.reason,'error');assert.equal(s.budget.state,'released')}
 await t.test('accepted/error结算Task blocked、owner receipt与仅reserved预算同事务，原票据/input保留且幂等',async()=>{const f=await fixture(),before=await f.snapshot();await f.settle();const after=await f.snapshot();assertSettled(after);assert.equal(after.task.version,before.task.version+1);assert.equal(after.run.input_text,before.run.input_text);assert.equal(after.run.stop_requested_at,before.run.stop_requested_at);assert.deepEqual(after.ticket,before.ticket);assert.equal(f.callbacks(),1);await f.settle();assert.deepEqual(await f.snapshot(),after)})
 await t.test('真实SQL写异常与延迟约束COMMIT异常均回滚全部四项，不调用settled hook',async()=>{
  for(const commit of [false,true]){const f=await fixture(),before=await f.snapshot(),fn='j149_fail_'+randomUUID().replaceAll('-',''),tr=fn+'_trigger';await pool.query(`create function ${fn}() returns trigger language plpgsql as $$ begin if NEW.run_id='${f.run.id}'::uuid and NEW.owner_settlement is not null then raise exception 'j149-injected-${commit?'commit':'write'}'; end if; return NEW; end $$`)
   await pool.query(commit?`create constraint trigger ${tr} after update on teloa_task_run_runtime_links deferrable initially deferred for each row execute function ${fn}()`:`create trigger ${tr} before update on teloa_task_run_runtime_links for each row execute function ${fn}()`)
   try{await assert.rejects(f.settle(),new RegExp('j149-injected-'+(commit?'commit':'write')));assert.deepEqual(await f.snapshot(),before);assert.equal(f.callbacks(),0)}finally{await pool.query(`drop trigger ${tr} on teloa_task_run_runtime_links`);await pool.query(`drop function ${fn}()`)}
  }
 })
 await t.test('markDispatched在结算中途先提交unknown：结算全事务HOLD，不局部释放额度',async()=>{
  const f=await fixture(),before=await f.snapshot(),reached=deferred(),continueSQL=deferred();const p=observedPool(pool,{before:async sql=>{if(sql.startsWith('update teloa_work_budget_reservations b set')){reached.release();await continueSQL.wait}}}),settling=f.settle(p)
  try{await Promise.race([reached.wait,settling.then(()=>{throw Error('未到预算UPDATE栅栏即结算完成')})]);await f.budgets.markDispatched(f.owner,{reservationId:f.reservation.id})}finally{continueSQL.release()}
  await assert.rejects(settling);const after=await f.snapshot();assert.deepEqual(after.task,before.task);assert.deepEqual(after.run,before.run);assert.deepEqual(after.owner,before.owner);assert.equal(after.budget.state,'unknown');assert.equal(f.callbacks(),0)
 })
 await t.test('结算先持有reserved行锁：并发派发等待，提交released后派发拒绝',async()=>{
  const f=await fixture(),reached=deferred(),continueSQL=deferred(),dispatchPool=new Pool({connectionString:cfg.connectionString,max:1,application_name:'j149-dispatch-wait',statement_timeout:10000});dispatchPool.on('error',()=>{})
  const p=observedPool(pool,{after:async sql=>{if(sql.startsWith('update teloa_work_budget_reservations b set')){reached.release();await continueSQL.wait}}}),settling=f.settle(p)
  let dispatched:Promise<unknown>|undefined
  try{await Promise.race([reached.wait,settling.then(()=>{throw Error('未到预算锁栅栏即结算完成')})]);dispatched=new WorkBudgetService(dispatchPool,identity).markDispatched(f.owner,{reservationId:f.reservation.id});const observed=dispatched.then(()=>({accepted:true}),()=>({accepted:false}));let waiting=false;for(let i=0;i<100;i++){waiting=(await pool.query("select 1 from pg_stat_activity where application_name='j149-dispatch-wait' and wait_event_type='Lock'")).rowCount!>0;if(waiting)break;await new Promise(done=>setTimeout(done,10))}assert.equal(waiting,true,'必须实际观察到PG锁等待');continueSQL.release();await settling;assert.equal((await observed).accepted,false);assertSettled(await f.snapshot())}finally{continueSQL.release();await dispatched?.catch(()=>{});await dispatchPool.end()}
 })
 await t.test('人工Task暂停/新版本整行保留，可信旧Run失败与零派发预算仍原子收口',async()=>{
  const f=await fixture();await pool.query("update teloa_tasks set state='paused',version=version+1 where owner_id=$1 and id=$2",[f.owner,f.taskId]);const before=await f.snapshot();await f.settle();const after=await f.snapshot()
  assert.deepEqual(after.task,before.task);assert.equal(after.run.state,'ended');assert.equal(after.run.evidence.reason,'error');assert.equal(after.owner.evidence.reason,'error');assert.equal(after.budget.state,'released');assert.equal(after.run.input_text,before.run.input_text);assert.equal(after.run.stop_requested_at,before.run.stop_requested_at);assert.deepEqual(after.ticket,before.ticket)
  assert.equal(after.run.group_publication,null);assert.equal(after.run.group_publication_next_at,null);assert.equal(after.run.owner_result_pending,false);assert.deepEqual(after.run.group_result_manifest,before.run.group_result_manifest)
 })
 await t.test('控制generation与输入快照漂移整事务HOLD，不局部记账或释放预算',async()=>{
  for(const field of ['control','input']){const f=await fixture();if(field==='control')await pool.query('update teloa_work_controls set generation=generation+1 where owner_id=$1 and id=$2',[f.owner,f.run.lineage!.roundControlId]);else await pool.query('update teloa_task_runs set input_text=$3 where owner_id=$1 and id=$2',[f.owner,f.run.id,f.run.inputText+' '])
   const before=await f.snapshot();await assert.rejects(f.settle(),field);assert.deepEqual(await f.snapshot(),before,field);assert.equal(f.callbacks(),0,field)
  }
 })
 await t.test('同形JSON没有opaque资格，不能借正式错误marker改原Run',async()=>{const f=await fixture(),before=await f.snapshot();await assert.rejects(new TaskRunService(pool,identity,async()=>{throw Error('只读不能准备')}).recordAcceptedInboxFailure(f.owner,{runId:f.run.id,sessionId:f.run.sessionId,nativeRequestId:f.run.nativeRequestId,runtimeId:randomUUID(),inputSha256:hash(f.run.inputText),endedAt:new Date().toISOString(),evidence:{state:'ended',turn:1,messageSeq:1,endSeq:4,reason:'error',inputAnchor:{kind:'accepted-inbox-error',acceptedSeq:1,turnStartSeq:2,consumedSeq:3,messageId:'not-native',payloadSha256:'a'.repeat(64),inputSha256:hash(f.run.inputText),prefixSha256:'b'.repeat(64),errorSha256:'c'.repeat(64)}}}));assert.deepEqual(await f.snapshot(),before)})
})

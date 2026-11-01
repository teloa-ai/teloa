import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {Pool} from './postgres-test-lifecycle.ts'
import {PostgreSqlContainer} from '@testcontainers/postgresql'
import {initializeBusinessSpaces} from '../src/work/business-spaces.ts'
import {initializeProjects,ProjectService} from '../src/work/projects.ts'
import {initializeProjectContext,ProjectContextService} from '../src/work/project-context.ts'
import {initializeProjectRuntime,ProjectRuntimeService} from '../src/work/project-runtime.ts'
import {createProjectMemoryHost} from '../../harness-dsh/src/project-memory-host.ts'
import {initializeProjectMemoryExtraction} from '../src/work/project-memory-extraction.ts'

test('真实PG：已有会话原地关闭和恢复记忆，旧准备与提炼队列不能恢复失效许可',{timeout:60000},async t=>{
 const external=process.env.TELOA_MEMORY_MODE_TEST_PG_URL
 const container=external?undefined:await new PostgreSqlContainer('postgres:17-alpine').start(),pool=new Pool({connectionString:external??container!.getConnectionUri()})
 t.after(async()=>{await pool.end();await container?.stop()})
 await initializeBusinessSpaces(pool);await initializeProjects(pool);await initializeProjectContext(pool);await initializeProjectRuntime(pool);await initializeProjectMemoryExtraction(pool)
 const owner=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()},projects=new ProjectService(pool,identity),context=new ProjectContextService(pool,identity)
 const fields={scope:'general',title:'原项目',goal:'核对现有任务',dueDate:null,state:'planning',links:[],references:[]},project=await projects.create(owner,{requestId:randomUUID(),fields}),other=await projects.create(owner,{requestId:randomUUID(),fields:{...fields,title:'另一项目'}})
 let running=false,pending=false,submitted=false,optionalReads=0,generatorCalls=0
 const sessionId='same-session-'+randomUUID(),ports={inspect:async(actor:string,sid:string)=>{if(actor!==owner)throw Error('owner denied');assert.equal(sid,sessionId);return {sessionId:sid,title:'原会话',scope:'general',kind:'ordinary' as const,submitted,running,pending}},optionalMemories:async()=>{optionalReads++;return []}}
 const runtime=new ProjectRuntimeService(pool,identity,ports);t.after(()=>runtime.dispose())
 await context.mutate(owner,{requestId:randomUUID(),projectId:project.id,expectedVersion:0,change:{kind:'save-entry',entryId:null,entryKind:'memory',topic:'保留线索',markdown:'MEM05-OLD-MEMORY'}})
 const initial=await runtime.bind(owner,{requestId:randomUUID(),sessionId,projectId:project.id,expectedVersion:0,memoryMode:'enabled'})
 const prepared=await runtime.prepare(owner,{sessionId,messageId:'original-user-message',query:'保留线索'});assert.ok(prepared);assert.match(prepared.text,/MEM05-OLD-MEMORY/)
 await runtime.recordUsed(owner,{manifestId:prepared.manifestId,generation:prepared.binding.generation,promptHash:'a'.repeat(64),stage:'dispatched'});submitted=true
 const host=createProjectMemoryHost({owner,pool,identity,runtime,context,loadMessage:async()=>({ownerId:owner,sessionId,messageId:'queued-message',sequence:3,text:'确认：今后保留来源并核对清单',actor:'owner',available:true,projectId:project.id,bindingVersion:initial.version,settingsVersion:0,memoryMode:'enabled'}),generateAuthorized:async()=>{generatorCalls++;throw Error('NO_MODEL_ALLOWED')},worker:{pollMs:60000}});t.after(()=>host.dispose())
 const queued=await host.ingest({sessionId,messageId:'queued-message'});assert.ok(queued);assert.equal(queued.status,'queued')
 const offInput={requestId:randomUUID(),sessionId,projectId:project.id,expectedVersion:initial.version,memoryMode:'off'}
 const off=await runtime.bind(owner,offInput);assert.equal(off.sessionId,sessionId);assert.equal(off.projectId,project.id);assert.equal(off.memoryMode,'off');assert.equal(off.version,initial.version+1);assert.ok(off.generation>prepared.binding.generation)
 assert.deepEqual(await runtime.bind(owner,offInput),off,'同requestId重放不重复换代')
 await assert.rejects(runtime.bind(owner,{...offInput,memoryMode:'enabled'}),'原requestId不能授权另一模式')
 assert.throws(()=>runtime.assertPreparedCurrentSync(owner,prepared))
 await assert.rejects(runtime.assertCurrent(owner,{sessionId,projectId:project.id,bindingVersion:prepared.binding.version,generation:prepared.binding.generation,contextVersion:prepared.binding.contextVersion,settingsVersion:prepared.binding.settingsVersion}))
 await assert.rejects(runtime.recordUsed(owner,{manifestId:prepared.manifestId,generation:prepared.binding.generation,promptHash:'b'.repeat(64),stage:'dispatched'}))
 const reads=optionalReads,fresh=await runtime.prepare(owner,{sessionId,messageId:'new-message',query:'重新核对现有任务'});assert.ok(fresh);assert.equal(fresh.binding.memoryMode,'off');assert.doesNotMatch(fresh.text,/MEM05-OLD-MEMORY/);assert.equal(optionalReads,reads);assert.equal(fresh.reset,true)
 const drained=await host.service.drain(owner);assert.equal(drained.discarded,1);assert.equal(generatorCalls,0)
 const cold=new ProjectRuntimeService(pool,identity,ports);t.after(()=>cold.dispose());assert.equal((await cold.getBinding(owner,sessionId))?.memoryMode,'off');const restored=await cold.prepare(owner,{sessionId,messageId:'cold-message',query:'重新核对现有任务'});assert.ok(restored);assert.doesNotMatch(restored.text,/MEM05-OLD-MEMORY/);assert.equal(optionalReads,reads)
 const enable={requestId:randomUUID(),sessionId,projectId:project.id,expectedVersion:off.version,memoryMode:'enabled'}
 await assert.rejects(runtime.bind(owner,{...enable,expectedVersion:initial.version}),'旧membership CAS不能覆盖')
 await assert.rejects(runtime.bind('another-owner',enable))
 running=true;await assert.rejects(runtime.bind(owner,enable),/运行/);running=false;pending=true;await assert.rejects(runtime.bind(owner,enable),/运行/);pending=false
 // 真正等待owner事务锁后才发生的运行状态变化，也必须在写入前核对。
 const blocker=await pool.connect()
 try{
  await blocker.query('begin');await blocker.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['teloa/project-context',owner])])
  const waiting=runtime.bind(owner,enable),rejected=assert.rejects(waiting,/运行/)
  let blocked=false
  for(let i=0;i<100&&!blocked;i++){blocked=!!(await pool.query("select 1 from pg_stat_activity where datname=current_database() and wait_event='advisory' limit 1")).rowCount;if(!blocked)await new Promise(resolve=>setTimeout(resolve,5))}
  assert.equal(blocked,true,'请求确实等待事务锁');running=true;await blocker.query('commit');await rejected
 }finally{running=false;await blocker.query('rollback');blocker.release()}
 await assert.rejects(runtime.bind(owner,{...enable,projectId:other.id}),/新建会话/,'submitted跨项目改模式仍拒绝')
 const enabled=await runtime.bind(owner,enable);assert.equal(enabled.sessionId,sessionId);assert.equal(enabled.projectId,project.id);assert.equal(enabled.memoryMode,'enabled')
 assert.throws(()=>runtime.assertPreparedCurrentSync(owner,prepared),'明确重新启用也不能复活旧prepared')
 assert.equal((await host.service.drain(owner)).completed,0);assert.equal(generatorCalls,0,'重新启用不能复活已废弃的排队提炼')
 const race=await Promise.allSettled([1,2].map(()=>runtime.bind(owner,{requestId:randomUUID(),sessionId,projectId:project.id,expectedVersion:enabled.version,memoryMode:'off'})))
 assert.equal(race.filter(row=>row.status==='fulfilled').length,1);assert.equal(race.filter(row=>row.status==='rejected').length,1,'并发提交只有一个membership CAS可生效')
 const audit=(await pool.query('select stage,prompt_hash from teloa_project_context_uses where id=$1',[prepared.manifestId])).rows[0];assert.deepEqual(audit,{stage:'dispatched',prompt_hash:'a'.repeat(64)})
 assert.equal((await context.get(owner,{projectId:project.id})).entries[0]?.markdown,'MEM05-OLD-MEMORY','关闭不删除本人记忆和历史')
})

test('真实PG：原mode请求的持久收据在会话开始工作后仍可核对，新请求和无权重放不能修改模式',{timeout:60000},async t=>{
 const external=process.env.TELOA_MEMORY_MODE_TEST_PG_URL
 const container=external?undefined:await new PostgreSqlContainer('postgres:17-alpine').start(),pool=new Pool({connectionString:external??container!.getConnectionUri()})
 t.after(async()=>{await pool.end();await container?.stop()})
 await initializeBusinessSpaces(pool);await initializeProjects(pool);await initializeProjectContext(pool);await initializeProjectRuntime(pool)
 const owner=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()},project=await new ProjectService(pool,identity).create(owner,{requestId:randomUUID(),fields:{scope:'general',title:'原收据恢复',goal:'只核对已提交回执',dueDate:null,state:'planning',links:[],references:[]}})
 let running=false,pending=false,bindable=true
 const sessionId='replay-'+randomUUID(),runtime=new ProjectRuntimeService(pool,identity,{inspect:async(actor,sid)=>{if(actor!==owner)throw Error('owner denied');return {sessionId:sid,title:'原会话',scope:'general',kind:'ordinary',submitted:false,running,pending,bindable}}});t.after(()=>runtime.dispose())
 const initial=await runtime.bind(owner,{requestId:randomUUID(),sessionId,projectId:project.id,expectedVersion:0,memoryMode:'enabled'}),input={requestId:randomUUID(),sessionId,projectId:project.id,expectedVersion:initial.version,memoryMode:'off'},receipt=await runtime.bind(owner,input)
 const snapshot=async()=>({binding:await runtime.getBinding(owner,sessionId),requests:Number((await pool.query('select count(*) from teloa_project_runtime_requests where owner_id=$1',[owner])).rows[0].count)}),before=await snapshot()
 running=true;assert.deepEqual(await runtime.bind(owner,input),receipt,'HTTP回包丢失后，开始工作不应阻断原持久回执读取')
 running=false;pending=true;assert.deepEqual(await runtime.bind(owner,input),receipt,'排队工作也不能把已提交操作误认为新改动')
 for(const mutation of [{...input,requestId:randomUUID()},{...input,memoryMode:'enabled'},{...input,sessionId:'different-session'},{...input,expectedVersion:input.expectedVersion+1}])await assert.rejects(runtime.bind(owner,mutation))
 await assert.rejects(runtime.bind('another-owner',input))
 bindable=false;await assert.rejects(runtime.bind(owner,input),'已存收据不能绕过当前会话访问权限');bindable=true
 assert.deepEqual(await snapshot(),before,'所有原收据重放只读，不增加membership/generation或新请求')
})

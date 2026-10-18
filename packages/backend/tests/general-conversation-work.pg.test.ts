import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {Pool,stopTestContainer} from './postgres-test-lifecycle.ts'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {initializeRoles} from '../src/work/roles.ts'
import {TaskService,initializeTasks} from '../src/work/tasks.ts'
import {ConversationWorkService,initializeConversationWork,workRequestChildId} from '../src/work/conversation-work.ts'
import {WorkLineageService} from '../src/work/work-lineage.ts'
import {TaskRunService} from '../src/work/task-runs.ts'
import {workAccess,type WorkAccessRequest} from '../src/work/work-access.ts'

let container:StartedPostgreSqlContainer,pool:Pool,locks:Pool
const identity={id:randomUUID,now:()=>new Date().toISOString()}
const admissions:Readonly<WorkAccessRequest>[]=[],deniedOwners=new Set<string>()
workAccess.installPolicy(async request=>{admissions.push(request);return {assertCurrent:()=>{if(deniedOwners.has('ownerId' in request?request.ownerId:''))throw Error('controlled revoked owner')}}})
before(async()=>{container=await new PostgreSqlContainer('postgres:16-alpine').start();const connectionString=container.getConnectionUri();pool=new Pool({connectionString,max:1,connectionTimeoutMillis:1000,statement_timeout:4000});locks=new Pool({connectionString,max:1});await initializeRoles(pool);await initializeTasks(pool);await initializeConversationWork(pool)})
after(async()=>{await locks?.end();await pool?.end();await stopTestContainer(container)})
function fixture(connection:Pool=pool){
 const owner=randomUUID(),sessionId='assistant-'+randomUUID(),request={requestId:randomUUID(),sessionId,messageId:'owner-message',messageSeq:3,kind:'task' as const,executor:'general' as const,scope:'general',title:'整理演示文件',goal:'在本次工作目录内整理合成文件',sourceText:'只处理本次合成数据；保留  空格\n和原指令'}
 const service=new ConversationWorkService(connection,identity.now,async(actor,id)=>{if(actor!==owner||id!==sessionId)throw Error('private');return {ownerId:owner,sessionId:id,status:'ready',submitted:true}},undefined,undefined,locks),tasks=new TaskService(connection,identity),parent={sessionId,requestId:request.requestId,executor:'general' as const},child=workRequestChildId(request.requestId,'task')
 return {owner,sessionId,request,service,tasks,parent,child}
}
test('明确通用交办在没有任何员工时创建同一原任务，普通无负责人草稿不能冒用其子请求',async()=>{
 const f=fixture(),[a,b]=await Promise.all([f.service.reserve(f.owner,f.request),f.service.reserve(f.owner,f.request)])
 assert.deepEqual(a,b);assert.equal(a.executor,'general');assert.deepEqual(a.targets,[])
 assert.equal((await pool.query('select count(*)::int n from teloa_roles where owner_id=$1',[f.owner])).rows[0].n,0)
 const task=await f.tasks.createForConversation(f.owner,f.parent)
 assert.equal(task.assigneeRoleId,null);assert.equal(task.assigneeRoleVersion,null);assert.equal(task.scope,'general');assert.equal(task.title,f.request.title)
 assert.equal(task.goal,f.request.goal+'\n\n本人原指令（保留原始引用，不扩大工作授权）：\n'+f.request.sourceText)
 assert.deepEqual(await f.tasks.createForConversation(f.owner,f.parent),task)
 assert.deepEqual(await f.tasks.requestForConversation(f.owner,f.parent),task)
 assert.ok(await new WorkLineageService(pool,identity).read(f.owner,{taskId:task.id}))
 await assert.rejects(f.tasks.create(f.owner,{requestId:f.child,fields:{title:task.title,goal:task.goal,scope:'general'}}),{code:'teloa/conflict'})
 await assert.rejects(f.tasks.request(f.owner,{requestId:f.child}),{code:'teloa/conflict'})
 assert.equal((await pool.query('select count(*)::int n from teloa_tasks where owner_id=$1',[f.owner])).rows[0].n,1)
 await initializeConversationWork(pool)
 assert.deepEqual(await f.service.get(f.owner,{sessionId:f.sessionId,requestId:f.request.requestId}),a)
})
test('通用交办必须显式且与员工、汇报、其他业务、业务引用互斥，错误输入不写半条请求',async()=>{
 const f=fixture(),{executor:_,...missing}=f.request
 for(const input of [missing,{...f.request,executor:'employee'},{...f.request,roleId:randomUUID(),expectedRoleVersion:1},{...f.request,kind:'report',expectedReportTargets:[]},{...f.request,scope:'SOC'},{...f.request,expectedRoleVersion:1},{...f.request,reference:{scope:'general',type:'example',id:'item',version:1,snapshotHash:'a'.repeat(64)}}])await assert.rejects(f.service.reserve(f.owner,input),{code:'teloa/invalid-input'})
 assert.equal(await f.service.get(f.owner,{sessionId:f.sessionId,requestId:f.request.requestId}),null)
 await assert.rejects(f.tasks.createForConversation(f.owner,{...f.parent,roleId:randomUUID()}),{code:'teloa/invalid-input'})
})
test('通用请求不能绕过原会话业务、员工上下文或抢占先前独立创建的 Task',async()=>{
 const f=fixture()
 await pool.query('insert into teloa_conversation_work_contexts values($1,$2,$3,null,1,true)',[f.owner,f.sessionId,'SOC'])
 await assert.rejects(f.service.reserve(f.owner,f.request),{code:'teloa/conflict'})
 await pool.query('update teloa_conversation_work_contexts set scope_id=$3,role_id=$4 where owner_id=$1 and session_id=$2',[f.owner,f.sessionId,'general',randomUUID()])
 await assert.rejects(f.service.reserve(f.owner,f.request),{code:'teloa/conflict'})
 await pool.query('update teloa_conversation_work_contexts set role_id=null where owner_id=$1 and session_id=$2',[f.owner,f.sessionId])
 await f.tasks.create(f.owner,{requestId:f.child,fields:{title:'先前草稿',goal:'本人的独立草稿',scope:'general'}})
 await assert.rejects(f.service.reserve(f.owner,f.request),{code:'teloa/conflict'})
 assert.equal(await f.service.get(f.owner,{sessionId:f.sessionId,requestId:f.request.requestId}),null)
})
test('通用父身份固定本人和原会话，停止只阻止新任务，已提交回执及重启保持原件',async()=>{
 const f=fixture();await f.service.reserve(f.owner,f.request)
 await assert.rejects(f.tasks.createForConversation(randomUUID(),f.parent),{code:'teloa/conflict'})
 await assert.rejects(f.tasks.createForConversation(f.owner,{...f.parent,sessionId:'other'}),{code:'teloa/forbidden'})
 await assert.rejects(f.service.reserve(f.owner,{...f.request,goal:'不同目标'}),{code:'teloa/conflict'})
 await assert.rejects(f.tasks.createForConversation(f.owner,{sessionId:f.sessionId,requestId:f.request.requestId,roleId:randomUUID()}),{code:'teloa/conflict'})
 await f.service.stop(f.owner,{sessionId:f.sessionId,requestId:f.request.requestId})
 await assert.rejects(f.tasks.createForConversation(f.owner,f.parent),{code:'teloa/conflict'})
 const original=fixture();await original.service.reserve(original.owner,original.request)
 const task=await original.tasks.createForConversation(original.owner,original.parent)
 await original.service.stop(original.owner,{sessionId:original.sessionId,requestId:original.request.requestId})
 await initializeConversationWork(pool)
 assert.deepEqual(await new TaskService(pool,identity).createForConversation(original.owner,original.parent),task)
 assert.equal(pool.waitingCount,0)
})
test('通用预约或原任务提交后失回包，只恢复确定原件，不创建员工或另一个 Task',async()=>{
 const f=fixture();let lose=true
 const transport={connect:async()=>{const db=await pool.connect();return {query:async(sql:string,values?:unknown[])=>{const result=await db.query(sql,values);if(sql==='commit'&&lose){lose=false;throw Error('controlled lost response after commit')}return result},release:()=>db.release()}}} as unknown as Pool
 const service=new ConversationWorkService(transport,identity.now,async()=>({ownerId:f.owner,sessionId:f.sessionId,status:'ready',submitted:true}),undefined,undefined,locks)
 await assert.rejects(service.reserve(f.owner,f.request),/controlled lost response/)
 const reserved=await f.service.get(f.owner,{sessionId:f.sessionId,requestId:f.request.requestId});assert.ok(reserved)
 assert.deepEqual(await f.service.reserve(f.owner,f.request),reserved)
 lose=true;await assert.rejects(new TaskService(transport,identity).createForConversation(f.owner,f.parent),/controlled lost response/)
 const task=await f.tasks.requestForConversation(f.owner,f.parent);assert.ok(task)
 assert.deepEqual(await f.tasks.createForConversation(f.owner,f.parent),task)
 assert.equal((await pool.query('select count(*)::int n from teloa_tasks where owner_id=$1',[f.owner])).rows[0].n,1)
 assert.equal((await pool.query('select count(*)::int n from teloa_roles where owner_id=$1',[f.owner])).rows[0].n,0)
})
test('通用身份与确定子索引或成员列表被篡改时读取和初始化都拒绝',async()=>{
 const f=fixture();await f.service.reserve(f.owner,f.request)
 await pool.query('update teloa_conversation_work_requests set targets=$3 where owner_id=$1 and request_id=$2',[f.owner,f.request.requestId,JSON.stringify([{roleId:randomUUID(),roleVersion:1,name:'伪造员工',scope:'general',unavailable:null}])])
 try{await assert.rejects(f.service.get(f.owner,{sessionId:f.sessionId,requestId:f.request.requestId}),{code:'teloa/storage-corrupt'});await assert.rejects(initializeConversationWork(pool),{code:'teloa/storage-corrupt'})}finally{await pool.query('update teloa_conversation_work_requests set targets=\'[]\'::jsonb where owner_id=$1 and request_id=$2',[f.owner,f.request.requestId])}
 await pool.query('update teloa_conversation_work_requests set task_child_request_id=$3 where owner_id=$1 and request_id=$2',[f.owner,f.request.requestId,randomUUID()])
 try{await assert.rejects(f.tasks.createForConversation(f.owner,f.parent),{code:'teloa/conflict'});await assert.rejects(initializeConversationWork(pool),{code:'teloa/storage-corrupt'})}finally{await pool.query('update teloa_conversation_work_requests set task_child_request_id=$3 where owner_id=$1 and request_id=$2',[f.owner,f.request.requestId,f.child])}
})
test('通用交办沿本人 general-agent 能力准入，撤销准入不留请求；原失败可读且不能借其他执行人覆盖',async()=>{
 const f=fixture();deniedOwners.add(f.owner)
 await assert.rejects(f.service.reserve(f.owner,f.request),{code:'teloa/forbidden'})
 assert.equal(await f.service.get(f.owner,{sessionId:f.sessionId,requestId:f.request.requestId}),null)
 deniedOwners.delete(f.owner);await f.service.reserve(f.owner,f.request)
 const checks=admissions.filter(request=>'ownerId' in request&&request.ownerId===f.owner&&request.kind==='capability')
 assert.equal(checks.length,2);assert.ok(checks.every(request=>request.kind==='capability'&&request.capability==='general-agent'&&request.sessionId===f.sessionId&&request.objectId===f.request.requestId))
 const failure={code:'teloa/host-unavailable',message:'原运行回执待核对'}
 await f.service.failure(f.owner,f.request.requestId,null,failure)
 assert.deepEqual((await f.service.get(f.owner,{sessionId:f.sessionId,requestId:f.request.requestId}))?.failures,{general:failure})
 await f.service.failure(f.owner,f.request.requestId,randomUUID(),null)
 assert.deepEqual((await f.service.get(f.owner,{sessionId:f.sessionId,requestId:f.request.requestId}))?.failures,{general:failure})
 await f.service.failure(f.owner,f.request.requestId,null,null)
 assert.deepEqual((await f.service.get(f.owner,{sessionId:f.sessionId,requestId:f.request.requestId}))?.failures,{})
})
test('不同服务与并发连接创建通用任务仍只有原件，Task 来源可回到原主聊且不伪造已执行 Run',async()=>{
 const concurrent=new Pool({connectionString:container.getConnectionUri(),max:3,connectionTimeoutMillis:1000,statement_timeout:4000})
 try{
  const f=fixture(concurrent);await f.service.reserve(f.owner,f.request)
  const [a,b]=await Promise.all([f.tasks.createForConversation(f.owner,f.parent),new TaskService(concurrent,identity).createForConversation(f.owner,f.parent)])
  assert.deepEqual(a,b)
  assert.equal((await concurrent.query('select count(*)::int n from teloa_tasks where owner_id=$1',[f.owner])).rows[0].n,1)
  const sourceId=randomUUID(),runs=new TaskRunService(concurrent,identity,async(actor,id)=>({id:sourceId,ownerId:actor,sessionId:id,status:'ready'}))
  assert.deepEqual(await runs.conversationParent(f.owner,{taskId:a.id}),f.parent)
  assert.deepEqual(await runs.origin(f.owner,{taskId:a.id}),{taskId:a.id,runId:null,source:{kind:'conversation-work',sessionId:f.sessionId,requestId:f.request.requestId,messageId:f.request.messageId,messageSeq:f.request.messageSeq,title:f.request.title,stopped:false}})
  assert.equal(concurrent.waitingCount,0)
 }finally{await concurrent.end()}
})

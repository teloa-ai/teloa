import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {RoleService,initializeRoles} from '../src/work/roles.ts'
import {TaskService,initializeTasks} from '../src/work/tasks.ts'
import {ConversationWorkService,initializeConversationWork,workRequestChildId} from '../src/work/conversation-work.ts'
import {BusinessDataService,initializeBusinessData} from '../src/work/business-data.ts'
import {BusinessTaskService,initializeBusinessTasks} from '../src/work/business-tasks.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'
let container:StartedPostgreSqlContainer,pool:Pool,locks:Pool
const identity={id:randomUUID,now:()=>new Date().toISOString()}
before(async()=>{container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri(),max:1,connectionTimeoutMillis:1000,statement_timeout:4000});locks=new Pool({connectionString:container.getConnectionUri(),max:1});await initializeRoles(pool);await initializeTasks(pool);await initializeConversationWork(pool);await initializeBusinessData(pool);await initializeBusinessTasks(pool)})
after(async()=>{await locks?.end();await pool?.end();await container?.stop()})
async function fixture(object=false){
 const owner=randomUUID(),sessionId='origin-'+randomUUID(),role=await new RoleService(pool,identity).create(owner,{requestId:randomUUID(),fields:{name:'固定同事',kind:'employee',scopes:['SOC'],duty:'调查',dataScope:'资料',executionScope:'只读',skills:[],knowledge:[],responsibility:testRoleResponsibility}})
 const sourceText='原始指令：保留  空格与\n换行',request={requestId:randomUUID(),sessionId,messageId:'original',messageSeq:1,kind:'task' as const,scope:'SOC',title:'固定目标',goal:'检查业务原件',sourceText,roleId:role.id,expectedRoleVersion:role.version}
 let reference:undefined|{scope:string;type:string;id:string;version:number;snapshotHash:string}
 if(object){const snapshot={scope:'SOC',type:'alert',id:'object',version:1,title:'固定记录',source:'fixture',observedAt:identity.now(),receivedAt:identity.now(),quality:'complete' as const,summary:'原摘要',fields:[]},page=await new BusinessDataService(pool,{id:'test',scopes:['SOC'],query:async()=>({schema:'teloa.data-source-page/v1',sourceId:'test',scope:'SOC',capturedAt:identity.now(),items:[snapshot]})}).query({ownerId:owner,scopeIds:['SOC']},{scope:'SOC',limit:10}),item=page.items[0]!;reference={scope:item.scope,type:item.type,id:item.id,version:item.version,snapshotHash:item.snapshotHash}}
 const service=new ConversationWorkService(pool,identity.now,async()=>({ownerId:owner,sessionId,status:'ready',submitted:false}),undefined,undefined,locks)
 await service.reserve(owner,{...request,...(reference?{reference}:{})})
 const tasks=new TaskService(pool,identity),business=new BusinessTaskService(pool,identity,tasks),parent={sessionId,requestId:request.requestId,roleId:role.id},child=workRequestChildId(request.requestId,'task',role.id),goal=request.goal+'\n\n本人原指令（保留原始引用，不改变同事权限）：\n'+sourceText,input={requestId:child,fields:{title:request.title,goal,scope:'SOC'},assignee:{roleId:role.id,expectedVersion:role.version}},actor={ownerId:owner,scopeIds:['SOC']}
 return {owner,service,tasks,business,parent,request,role,child,goal,input,reference,actor}
}

test('R3 固定父身份从原spec创建，普通同字节create/request在无任务和有回执时均拒绝；max1',async()=>{
 const f=await fixture()
 for(const saved of [false,true]){
  if(saved)await f.tasks.createForConversation(f.owner,f.parent)
  await assert.rejects(f.tasks.create(f.owner,f.input),{code:'teloa/conflict'})
  await assert.rejects(f.tasks.request(f.owner,{requestId:f.child}),{code:'teloa/conflict'})
 }
 const task=await f.tasks.requestForConversation(f.owner,f.parent)
 assert.ok(task);assert.equal(task.goal,f.goal);assert.equal(task.title,f.request.title);assert.equal(task.assigneeRoleId,f.role.id)
 assert.equal((await pool.query('select count(*)::int n from teloa_tasks where owner_id=$1',[f.owner])).rows[0].n,1)
 const edited=await f.tasks.edit(f.owner,{taskId:task.id,expectedVersion:1,fields:{title:'本人修订后的标题',goal:'本人修订目标'}})
 assert.deepEqual(await f.tasks.requestForConversation(f.owner,f.parent),edited,'核原request_spec，不能把合法当前编辑当原指纹漂移')
 await f.service.stop(f.owner,{sessionId:f.parent.sessionId,requestId:f.parent.requestId})
 assert.deepEqual(await f.tasks.createForConversation(f.owner,f.parent),edited,'成功回执优先于stopped')
 assert.ok((await f.tasks.list(f.owner,{})).some(item=>item.id===task.id),'按task.id/目录的本人读取保持')
 assert.equal(pool.waitingCount,0)
})

test('R3 内部父身份拒绝错本人/会话/同事/未知字段，原任务指纹不同不充当成功',async()=>{
 const f=await fixture()
 await assert.rejects(f.tasks.createForConversation(randomUUID(),f.parent),{code:'teloa/conflict'})
 await assert.rejects(f.tasks.createForConversation(f.owner,{...f.parent,sessionId:'other'}),{code:'teloa/forbidden'})
 await assert.rejects(f.tasks.createForConversation(f.owner,{...f.parent,roleId:randomUUID()}),{code:'teloa/conflict'})
 await assert.rejects(f.tasks.createForConversation(f.owner,{...f.parent,fields:f.input.fields}),{code:'teloa/invalid-input'})
 const task=await f.tasks.createForConversation(f.owner,f.parent),original=(await pool.query('select request_spec from teloa_tasks where id=$1',[task.id])).rows[0].request_spec
 await pool.query('update teloa_tasks set request_spec=jsonb_set(request_spec,\'{fields,goal}\',\'"另一请求"\') where id=$1',[task.id])
 try{await assert.rejects(f.tasks.requestForConversation(f.owner,f.parent),{code:'teloa/conflict'});await assert.rejects(f.tasks.createForConversation(f.owner,f.parent),{code:'teloa/conflict'})}finally{await pool.query('update teloa_tasks set request_spec=$2 where id=$1',[task.id,original])}
 assert.equal(pool.waitingCount,0)
})

test('R3 对象交办复用真实固定快照与来源，同请求恢复；普通来源入口和非对象内部口不能冒用',async()=>{
 const f=await fixture(true),input={requestId:f.child,reference:f.reference,title:f.request.title,goal:f.goal,assignee:f.input.assignee}
 assert.equal(await f.business.requestForConversation(f.actor,f.parent),null)
 await assert.rejects(f.tasks.createForConversation(f.owner,f.parent),{code:'teloa/conflict'})
 await assert.rejects(f.tasks.requestForConversation(f.owner,f.parent),{code:'teloa/conflict'})
 await assert.rejects(f.business.create(f.actor,input),{code:'teloa/conflict'})
 const created=await f.business.createForConversation(f.actor,f.parent)
 assert.deepEqual(created.source.reference,f.reference);assert.equal(created.task.goal,f.goal)
 assert.deepEqual(await f.business.requestForConversation(f.actor,f.parent),created.task)
 await assert.rejects(f.business.create(f.actor,input),{code:'teloa/conflict'})
 await assert.rejects(f.business.requestForConversation({...f.actor,scopeIds:['AppSec']},f.parent),{code:'teloa/forbidden'})
 await f.service.stop(f.owner,{sessionId:f.parent.sessionId,requestId:f.parent.requestId})
 assert.deepEqual(await f.business.createForConversation(f.actor,f.parent),created)
 const original=(await pool.query('select request_spec from teloa_business_task_sources where task_id=$1',[created.task.id])).rows[0].request_spec
 await pool.query('update teloa_business_task_sources set request_spec=jsonb_set(request_spec,\'{reference,id}\',\'"other"\') where task_id=$1',[created.task.id])
 try{await assert.rejects(f.business.requestForConversation(f.actor,f.parent),{code:'teloa/conflict'});await assert.rejects(f.business.createForConversation(f.actor,f.parent),{code:'teloa/conflict'})}finally{await pool.query('update teloa_business_task_sources set request_spec=$2 where task_id=$1',[created.task.id,original])}
 assert.equal((await pool.query('select count(*)::int n from teloa_business_task_sources where owner_id=$1',[f.owner])).rows[0].n,1)
 assert.equal(pool.waitingCount,0)
})

for(const object of [false,true])test('R3 '+(object?'对象':'普通')+'内部创建真实提交后失回包，父身份读取与重试找回唯一Task',async()=>{
 const f=await fixture(object)
 let lose=true
 const transport={connect:async()=>{const db=await pool.connect();return {query:async(sql:string,values?:unknown[])=>{const result=await db.query(sql,values);if(sql==='commit'&&lose){lose=false;throw Error('controlled lost response after commit')}return result},release:()=>db.release()}}} as unknown as Pool
 const tasks=new TaskService(transport,identity),business=new BusinessTaskService(transport,identity,tasks)
 await assert.rejects(object?business.createForConversation(f.actor,f.parent):tasks.createForConversation(f.owner,f.parent),/controlled lost response/)
 const receipt=object?await f.business.requestForConversation(f.actor,f.parent):await f.tasks.requestForConversation(f.owner,f.parent)
 assert.ok(receipt)
 const retry=object?(await f.business.createForConversation(f.actor,f.parent)).task:await f.tasks.createForConversation(f.owner,f.parent)
 assert.deepEqual(retry,receipt)
 assert.equal((await pool.query('select count(*)::int n from teloa_tasks where owner_id=$1',[f.owner])).rows[0].n,1)
 assert.equal((await pool.query('select count(*)::int n from teloa_business_task_sources where owner_id=$1',[f.owner])).rows[0].n,object?1:0)
 assert.equal(pool.waitingCount,0)
})

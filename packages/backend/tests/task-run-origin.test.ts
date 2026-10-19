import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {Pool} from './postgres-test-lifecycle.ts'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {RoleService,initializeRoles} from '../src/work/roles.ts'
import {TaskService,initializeTasks} from '../src/work/tasks.ts'
import {ConversationWorkService,initializeConversationWork,workRequestChildId} from '../src/work/conversation-work.ts'
import {TaskRunService,initializeTaskRuns} from '../src/work/task-runs.ts'
import {ObjectConversationService,initializeObjectConversations} from '../src/work/object-conversations.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'
let container:StartedPostgreSqlContainer,pool:Pool,locks:Pool
const identity={id:randomUUID,now:()=>new Date().toISOString()}
before(async()=>{container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()});locks=new Pool({connectionString:container.getConnectionUri(),max:1});await initializeRoles(pool);await initializeTasks(pool);await initializeConversationWork(pool);await initializeObjectConversations(pool);await initializeTaskRuns(pool)},{timeout:120000})
after(async()=>{await locks?.end();await pool?.end();await container?.stop()})
async function fixture(){
 const owner=randomUUID(),sessionId='origin-'+randomUUID(),conversationId=randomUUID()
 const role=await new RoleService(pool,identity).create(owner,{requestId:randomUUID(),fields:{name:'接手同事',kind:'employee',scopes:['general'],duty:'整理',dataScope:'原资料',executionScope:'代拟',skills:[],knowledge:[],responsibility:testRoleResponsibility}})
 const requests=new ConversationWorkService(pool,identity.now,async()=>({ownerId:owner,sessionId,status:'ready',submitted:false}),undefined,undefined,locks)
 const parent=await requests.reserve(owner,{requestId:randomUUID(),sessionId,messageId:'original-human',messageSeq:7,kind:'task',scope:'general',title:'原交办',goal:'检查原始证据',roleId:role.id,expectedRoleVersion:role.version})
 const tasks=new TaskService(pool,identity),task=await tasks.createForConversation(owner,{sessionId,requestId:parent.requestId,roleId:role.id})
 let inspectedOwner:string=owner
 const inspect=async(actor:string,id:string)=>({id:id===sessionId?conversationId:randomUUID(),ownerId:actor===owner?inspectedOwner:actor,sessionId:id,status:'ready'})
 const runs=new TaskRunService(pool,identity,inspect)
 return {owner,sessionId,parent,task,tasks,runs,role,requests,inspect,foreign:()=>{inspectedOwner='other-owner'}}
}
test('真实PG从固定子Task及Run读回同一原交办；来源读口不创建执行或改上下文',async()=>{
 const f=await fixture(),before=(await pool.query('select count(*)::int n from teloa_task_runs where owner_id=$1',[f.owner])).rows[0].n
 const expected={kind:'conversation-work',sessionId:f.sessionId,requestId:f.parent.requestId,messageId:'original-human',messageSeq:7,title:'原交办',stopped:false}
 assert.deepEqual(await f.runs.origin(f.owner,{taskId:f.task.id}),{taskId:f.task.id,runId:null,source:expected})
 assert.equal((await pool.query('select count(*)::int n from teloa_task_runs where owner_id=$1',[f.owner])).rows[0].n,before)
 const runSession='run-'+randomUUID(),fixedConversationId=randomUUID(),links=new ObjectConversationService(pool,async(actor,id)=>({id:fixedConversationId,ownerId:actor,sessionId:id,status:'ready'}),identity.now)
 const link=await links.change(f.owner,{requestId:randomUUID(),kind:'task',objectId:f.task.id,expectedObjectVersion:f.task.version,sessionId:runSession,expectedLinkVersion:0,action:'link'})
 const runs=new TaskRunService(pool,identity,async(actor,id)=>({id:id===f.sessionId?(await f.inspect(actor,id)).id:fixedConversationId,ownerId:actor,sessionId:id,status:'ready'}))
 const run=await runs.prepare(f.owner,{requestId:randomUUID(),taskId:f.task.id,expectedTaskVersion:f.task.version,roleId:f.role.id,expectedRoleVersion:f.role.version,sessionId:runSession,expectedLinkVersion:link.version},undefined,undefined,undefined,async()=> 'default-agent')
 assert.deepEqual(await runs.origin(f.owner,{runId:run.id}),{taskId:f.task.id,runId:run.id,source:expected})
 assert.equal(await runs.retryTaskVersion(f.owner,run),f.task.version)
 await runs.claim(f.owner,{runId:run.id})
 const failed=await runs.record(f.owner,{runId:run.id,sessionId:run.sessionId,nativeRequestId:run.nativeRequestId,evidence:{state:'ended',turn:0,messageSeq:1,endSeq:2,reason:'error'}})
 const current=(await f.tasks.list(f.owner,{})).find(task=>task.id===f.task.id)!
 assert.equal(current.state,'blocked');assert.equal(await runs.retryTaskVersion(f.owner,failed),current.version)
 assert.equal((await runs.get(f.owner,{runId:run.id})).taskVersion,run.taskVersion,'新准备版本读取不改写首失败快照')
 const retryId=workRequestChildId(f.parent.requestId,'run-retry:'+run.id,f.role.id),retrySession='task-run-'+retryId
 const retryLink=await links.change(f.owner,{requestId:retryId,kind:'task',objectId:f.task.id,expectedObjectVersion:current.version,sessionId:retrySession,expectedLinkVersion:0,action:'link'})
 const retry=await runs.prepare(f.owner,{requestId:retryId,taskId:f.task.id,expectedTaskVersion:current.version,roleId:f.role.id,expectedRoleVersion:f.role.version,sessionId:retrySession,expectedLinkVersion:retryLink.version},undefined,undefined,undefined,async()=> 'default-agent')
 assert.equal(retry.taskId,run.taskId);assert.equal(retry.taskVersion,current.version);assert.notEqual(retry.id,run.id)
 assert.deepEqual(await runs.get(f.owner,{runId:run.id}),failed,'首失败及原输入快照不可被新执行覆盖')
 assert.deepEqual((await runs.origin(f.owner,{runId:retry.id})).source,expected,'新执行仍归属同一原平台交办')
 const replay=await runs.prepare(f.owner,{requestId:retryId,taskId:f.task.id,expectedTaskVersion:current.version,roleId:f.role.id,expectedRoleVersion:f.role.version,sessionId:retrySession,expectedLinkVersion:retryLink.version})
 assert.equal(replay.id,retry.id);assert.equal((await runs.list(f.owner,{taskId:f.task.id})).length,2)
 await pool.query("update teloa_tasks set definition=jsonb_set(definition,'{goal}',to_jsonb($1::text)) where owner_id=$2 and id=$3",['不同目标',f.owner,f.task.id])
 await assert.rejects(runs.retryTaskVersion(f.owner,failed),{code:'teloa/conflict'})

 await f.requests.stop(f.owner,{sessionId:f.sessionId,requestId:f.parent.requestId})
 assert.equal((await runs.origin(f.owner,{runId:run.id})).source?.stopped,true)
})
test('跨本人、伪造parent输入、原会话归属变化及损坏固定成员均fail closed',async()=>{
 const f=await fixture()
 await assert.rejects(f.runs.origin('other-owner',{taskId:f.task.id}),{code:'teloa/forbidden'})
 await assert.rejects(f.runs.origin(f.owner,{taskId:f.task.id,sessionId:'different-parent'}),{code:'teloa/invalid-input'})
 f.foreign();await assert.rejects(f.runs.origin(f.owner,{taskId:f.task.id}),{code:'teloa/forbidden'})
 const valid=await fixture()
 await pool.query("update teloa_conversation_work_requests set targets=jsonb_set(targets,'{0,roleId}',to_jsonb($1::text)) where owner_id=$2 and request_id=$3",[randomUUID(),valid.owner,valid.parent.requestId])
 await assert.rejects(valid.runs.origin(valid.owner,{taskId:valid.task.id}),{code:'teloa/storage-corrupt'})
})
test('真实本人普通任务明确无父来源，不能把无记录或错误Run冒充普通任务',async()=>{
 const f=await fixture(),task=await f.tasks.create(f.owner,{requestId:randomUUID(),fields:{scope:'general',title:'普通任务',goal:'整理资料'}})
 assert.deepEqual(await f.runs.origin(f.owner,{taskId:task.id}),{taskId:task.id,runId:null,source:null})
 await assert.rejects(f.runs.origin(f.owner,{runId:randomUUID()}),{code:'teloa/forbidden'})
 await assert.rejects(f.runs.origin(f.owner,{taskId:f.task.id,runId:randomUUID()}),{code:'teloa/invalid-input'})
})

import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {Pool,stopTestContainer} from './postgres-test-lifecycle.ts'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {initializeTeloaDatabase} from '../src/work/initialize-database.ts'
import {CollaborationService} from '../src/work/collaboration.ts'
import {GroupAgentGrantService} from '../src/work/group-agent-grants.ts'
import {GroupTaskService} from '../src/work/group-tasks.ts'
import {TaskService} from '../src/work/tasks.ts'
import {RoleService} from '../src/work/roles.ts'
import {GroupWorkInputService,readGroupWorkContinuation} from '../src/work/group-work-inputs.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'

let container:StartedPostgreSqlContainer,pool:Pool,tick=0
const identity={id:randomUUID,now:()=>new Date(Date.parse('2026-10-14T09:00:00.000Z')+(tick++)*1000).toISOString()}
const rules={historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true}
before(async()=>{container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()});await initializeTeloaDatabase(pool)},{timeout:120000})
after(async()=>{await pool?.end();await stopTestContainer(container)})

async function fixture(){
 const owner='work-inputs-test:'+randomUUID(),roles=new RoleService(pool,identity),groups=new CollaborationService(pool,identity),inputs=new GroupWorkInputService(pool,identity)
 const role=await roles.create(owner,{requestId:randomUUID(),fields:{name:'整理员',kind:'employee',scopes:['SOC'],duty:'整理记录',dataScope:'群内资料',executionScope:'代拟',skills:[],knowledge:[],responsibility:testRoleResponsibility}})
 const group=await groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:{name:'整理群',scope:'general',announcement:'',rules,memberRoleIds:[role.id]}})
 await new GroupAgentGrantService(pool,identity.now).change(owner,{requestId:randomUUID(),groupId:group.id,roleId:role.id,expectedGroupVersion:group.version,expectedRoleVersion:role.version,action:'save',resources:[],canPost:true,canAutoRun:true})
 const asked=await groups.send(owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:group.version,text:'整理这些记录，生成跟进表。'})
 const created=await new GroupTaskService(pool,identity,new TaskService(pool,identity)).create(owner,{requestId:randomUUID(),groupId:group.id,messageId:asked.id,expectedGroupVersion:group.version,goal:'整理',assignee:{roleId:role.id,expectedVersion:role.version},trigger:'routed',executionMode:'work',routingAttemptVersion:1})
 const send=(text:string)=>groups.send(owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:group.version,text})
 const reserve=async(messageId:string,operation:'continue'|'stop',version?:number)=>{const db=await pool.connect();try{return await inputs.reserveInTransaction(db,owner,{requestId:randomUUID(),groupId:group.id,messageId,taskId:created.task.id,expectedTaskVersion:version??(await taskRow(owner,created.task.id)).version,operation})}finally{db.release()}}
 return {owner,group,inputs,created,send,reserve}
}
const taskRow=async(owner:string,id:string)=>(await pool.query('select version,state from teloa_tasks where owner_id=$1 and id=$2',[owner,id])).rows[0] as {version:number;state:string}
const sourceRow=async(id:string)=>(await pool.query('select source_snapshot,snapshot_digest from teloa_group_task_sources where task_id=$1',[id])).rows[0]

test('续办内容版本提交后尚未送达：恢复泵仍能拾取，准备失败回执可进入unknown并保持原任务版本',async()=>{
 const f=await fixture()
 await pool.query("update teloa_tasks set state='waiting' where owner_id=$1 and id=$2",[f.owner,f.created.task.id])
 const message=await f.send('补上负责人列。'),reserved=await f.reserve(message.id,'continue')
 const continued=await f.inputs.continueTask(f.owner,reserved.requestId)
 const pending=await f.inputs.pending(f.owner)
 assert.ok(pending.some(row=>row.requestId===reserved.requestId),'内容版本已提交但没有原生送达，冷恢复不能丢弃此回执')
 const unknown=await f.inputs.settle(f.owner,{requestId:reserved.requestId,state:'unknown',runId:null,reason:'teloa/dependency-unavailable'})
 assert.equal(unknown.state,'unknown','真实服务不能以提前accepted阻止记录提交未知')
 assert.equal(unknown.taskVersion,continued.taskVersion)
})

test('完成后追加：保留同一 taskId、新增任务版本；原来源快照不变；追加来源只给对应版本的新 Run',async()=>{
 const f=await fixture(),before=await sourceRow(f.created.task.id)
 await pool.query("update teloa_tasks set state='waiting' where owner_id=$1 and id=$2",[f.owner,f.created.task.id])
 const original=await taskRow(f.owner,f.created.task.id),follow=await f.send('补上负责人列。')
 const first=await f.reserve(follow.id,'continue'),again=await f.reserve(follow.id,'continue',original.version)
 assert.equal(first.state,'reserved');assert.deepEqual(again,first,'同一消息对同一任务只登记一次')
 const continued=await f.inputs.continueTask(f.owner,first.requestId)
 assert.deepEqual([continued.state,continued.taskId,continued.taskVersion],['continued',f.created.task.id,original.version+1],'升版本后仍是可恢复的 continued，不提前写 accepted')
 assert.ok((await f.inputs.pending(f.owner)).some(item=>item.requestId===first.requestId),'升版本后崩溃：待处理目录仍可拾取')
 assert.deepEqual(await f.inputs.continueTask(f.owner,first.requestId),continued,'重复续办不再升版本')
 assert.deepEqual(await taskRow(f.owner,f.created.task.id),{version:original.version+1,state:'ready'})
 assert.deepEqual(await sourceRow(f.created.task.id),before,'原群任务来源快照与摘要不回写')
 assert.equal((await readGroupWorkContinuation(pool,f.owner,f.created.task.id,original.version+1))?.text,'补上负责人列。')
 assert.equal(await readGroupWorkContinuation(pool,f.owner,f.created.task.id,original.version),undefined,'旧版本 Run 读不到后来的追加')
 const runId=randomUUID()
 assert.equal((await f.inputs.settle(f.owner,{requestId:first.requestId,state:'continued',runId,reason:null})).runId,runId,'先记录续办 Run 身份')
 assert.equal((await f.inputs.settle(f.owner,{requestId:first.requestId,state:'continued',runId:randomUUID(),reason:null})).runId,runId,'已绑定的 Run 身份不可更换')
 assert.equal((await f.inputs.settle(f.owner,{requestId:first.requestId,state:'unknown',runId,reason:'teloa/execution-pending'})).state,'unknown')
 assert.equal((await f.inputs.continueTask(f.owner,first.requestId)).taskVersion,original.version+1,'未知回执不再升版本')
 const accepted=await f.inputs.settle(f.owner,{requestId:first.requestId,state:'accepted',runId,nativeRequestId:'native-1',reason:null})
 assert.deepEqual([accepted.state,accepted.nativeRequestId],['accepted','native-1'])
 assert.equal((await f.inputs.settle(f.owner,{requestId:first.requestId,state:'unknown',runId,reason:'x'})).state,'accepted','终态不能改回未知')
 assert.equal((await readGroupWorkContinuation(pool,f.owner,f.created.task.id,original.version+1))?.references.length,0)
 await assert.rejects(pool.query('delete from teloa_group_work_inputs where owner_id=$1',[f.owner]),/immutable/)
})

test('原 Run 进行中只保存不续办；登记后本人要求停止则续办被拒，停止后不复活；版本过期与别群消息被拒',async()=>{
 const f=await fixture(),runId=randomUUID()
 await pool.query("insert into teloa_task_runs(id,owner_id,request_id,request_spec,task_id,role_id,task_version,role_version,link_version,session_id,native_request_id,state,input_text,created_at,allowed_tools) select $1,$2,$3,'{}'::jsonb,$4,assignee_role_id,version,assignee_role_version,1,$5,$6,'prepared','{}',now(),'[]'::jsonb from teloa_tasks where id=$4",[runId,f.owner,randomUUID(),f.created.task.id,'session-'+runId,'native-'+runId]).catch(()=>undefined)
 const follow=await f.send('再加一列备注。'),queued=await f.reserve(follow.id,'continue')
 const active=(await pool.query("select count(*)::int n from teloa_task_runs where owner_id=$1 and task_id=$2 and state not in ('ended','withdrawn','configuration_failed')",[f.owner,f.created.task.id])).rows[0].n as number
 if(active)assert.equal((await f.inputs.continueTask(f.owner,queued.requestId)).state,'reserved','原运行未收敛时保持已保存')
 const stop=await f.send('停止这项整理。')
 assert.equal((await f.reserve(stop.id,'stop')).operation,'stop')
 await pool.query("update teloa_task_runs set state='withdrawn' where owner_id=$1 and task_id=$2",[f.owner,f.created.task.id]).catch(()=>undefined)
 await pool.query("update teloa_tasks set state='paused' where owner_id=$1 and id=$2",[f.owner,f.created.task.id])
 assert.equal((await f.inputs.continueTask(f.owner,queued.requestId)).state,'rejected','停止之后先前登记的追加不能复活工作')
 const stale=await f.send('改成周报。')
 const rejected=await f.reserve(stale.id,'continue',1_000)
 assert.equal(rejected.state,'rejected','版本过期的追加持久记为拒绝，不吞掉')
 const edited=await f.send('改成月报。'),pending=await f.reserve(edited.id,'continue')
 await pool.query('update teloa_tasks set content_version=content_version+1 where owner_id=$1 and id=$2',[f.owner,f.created.task.id])
 if(pending.state==='reserved')assert.equal((await f.inputs.continueTask(f.owner,pending.requestId)).state,'rejected','排队期间目标被改过，追加不能套到另一版目标上')
 const other=await fixture(),foreign=await other.send('别群消息。')
 await assert.rejects(f.reserve(foreign.id,'continue'),{code:'teloa/forbidden'})
})

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
 return {owner,group,groups,role,inputs,created,send,reserve}
}
const taskRow=async(owner:string,id:string)=>(await pool.query('select version,state from teloa_tasks where owner_id=$1 and id=$2',[owner,id])).rows[0] as {version:number;state:string}
const sourceRow=async(id:string)=>(await pool.query('select source_snapshot,snapshot_digest from teloa_group_task_sources where task_id=$1',[id])).rows[0]

test('引用另一个原工作时不能续办同群旧任务，旧版已登记的错误回执也在升版本前拒绝',async()=>{
 const f=await fixture(),quotedId=randomUUID(),quotedTask=randomUUID()
 // 测试专用持久员工回帖；不以名称或提示词作为引用身份。
 await pool.query(`insert into teloa_group_messages(id,owner_id,group_id,request_id,request_spec,author_id,task_id,run_id,text,reference_snapshot,created_at)
  values($1,$2,$3,$4,'{}',$5,$6,$7,'固定交付','[]',$8)`,[quotedId,f.owner,f.group.id,randomUUID(),f.role.id,quotedTask,randomUUID(),identity.now()])
 const message=await f.groups.send(f.owner,{requestId:randomUUID(),groupId:f.group.id,expectedVersion:f.group.version,replyToMessageId:quotedId,text:'继续引用的原工作。'})
 const before=await taskRow(f.owner,f.created.task.id)
 assert.equal((await f.reserve(message.id,'continue')).state,'rejected')
 const legacy=await f.groups.send(f.owner,{requestId:randomUUID(),groupId:f.group.id,expectedVersion:f.group.version,replyToMessageId:quotedId,text:'继续引用的原工作，保留旧回执。'}),requestId=randomUUID()
 await pool.query(`insert into teloa_group_work_inputs(owner_id,request_id,group_id,message_id,task_id,operation,expected_task_version,payload_sha256,observed_run_id,state,expected_content_version,created_at,updated_at)
  values($1,$2,$3,$4,$5,'continue',$6,$7,null,'reserved',1,$8,$8)`,[f.owner,requestId,f.group.id,legacy.id,f.created.task.id,before.version,'0'.repeat(64),identity.now()])
 assert.equal((await f.inputs.continueTask(f.owner,requestId)).state,'rejected')
 assert.deepEqual(await taskRow(f.owner,f.created.task.id),before,'错误续办不得改变另一项任务的版本或状态')
})

test('登记原工作归属与路由三条关联对齐：定义关联群或仅经本人同群引用可追溯的任务可登记；无任何关联或别人的任务仍拒绝',async()=>{
 const f=await fixture(),tasks=new TaskService(pool,identity)
 const reserveFor=async(messageId:string,taskId:string)=>{const db=await pool.connect();try{return await f.inputs.reserveInTransaction(db,f.owner,{requestId:randomUUID(),groupId:f.group.id,messageId,taskId,expectedTaskVersion:(await taskRow(f.owner,taskId))?.version??1,operation:'continue'})}finally{db.release()}}
 // 定义挂群、没有群交办来源（草稿/配置/计划领取形态）。
 const bound=await tasks.create(f.owner,{requestId:randomUUID(),fields:{title:'定义关联群的任务',goal:'原目标',scope:'general',groupId:f.group.id}})
 assert.equal((await reserveFor((await f.send('继续定义关联群的任务。')).id,bound.id)).state,'reserved')
 // 既无来源也不挂群，只能从本条消息引用的员工回帖追溯；引用由宿主按同本人同群持久关联读出。
 const quotedOnly=await tasks.create(f.owner,{requestId:randomUUID(),fields:{title:'仅经引用可追溯',goal:'原目标',scope:'general'}}),delivered=randomUUID()
 await pool.query(`insert into teloa_group_messages(id,owner_id,group_id,request_id,request_spec,author_id,task_id,run_id,text,reference_snapshot,created_at)
  values($1,$2,$3,$4,'{}',$5,$6,$7,'第2版交付','[]',$8)`,[delivered,f.owner,f.group.id,randomUUID(),f.role.id,quotedOnly.id,randomUUID(),identity.now()])
 const quoting=await f.groups.send(f.owner,{requestId:randomUUID(),groupId:f.group.id,expectedVersion:f.group.version,replyToMessageId:delivered,text:'按同一案例更新交付。'})
 assert.equal((await reserveFor(quoting.id,quotedOnly.id)).state,'reserved','被引用回帖所属原任务不再被「原工作不属于本群」误拒')
 assert.equal((await reserveFor((await f.send('不引用地继续它。')).id,quotedOnly.id).catch(error=>error)).code,'teloa/forbidden','未引用时仅经回帖可追溯的任务不算本群工作')
 const elsewhere=await tasks.create(f.owner,{requestId:randomUUID(),fields:{title:'无关任务',goal:'原目标',scope:'general'}})
 assert.equal((await reserveFor((await f.send('继续无关任务。')).id,elsewhere.id).catch(error=>error)).code,'teloa/forbidden')
 const other=await fixture()
 assert.equal((await reserveFor((await f.send('继续别人的任务。')).id,other.created.task.id).catch(error=>error)).code,'teloa/forbidden','跨本人任务即使同名同群也不登记')
})

test('本人引用自己当初的交办消息：按该消息唯一派生的原任务登记续办；指向同群另一项任务拒绝',async()=>{
 const f=await fixture(),tasks=new TaskService(pool,identity),asked=(await pool.query('select message_id from teloa_group_task_sources where task_id=$1',[f.created.task.id])).rows[0].message_id
 const reply=(text:string)=>f.groups.send(f.owner,{requestId:randomUUID(),groupId:f.group.id,expectedVersion:f.group.version,replyToMessageId:asked,text})
 assert.equal((await f.reserve((await reply('质量退回：按复核意见修订后再交。')).id,'continue')).state,'reserved')
 const bound=await tasks.create(f.owner,{requestId:randomUUID(),fields:{title:'同群另一项',goal:'原目标',scope:'general',groupId:f.group.id}})
 const db=await pool.connect()
 try{assert.equal((await f.inputs.reserveInTransaction(db,f.owner,{requestId:randomUUID(),groupId:f.group.id,messageId:(await reply('退回修订。')).id,taskId:bound.id,expectedTaskVersion:(await taskRow(f.owner,bound.id)).version,operation:'continue'})).state,'rejected')}finally{db.release()}
})

test('员工版本已高于任务固定负责人版本：续办在升版本前按 version-conflict 拒绝，不空升版本、不自动续签；本人确认交接到新版本后才续办',async()=>{
 const f=await fixture()
 await pool.query("update teloa_tasks set state='waiting' where owner_id=$1 and id=$2",[f.owner,f.created.task.id])
 // 模拟本人新增工具授权：员工版本 +1，任务固定的负责人版本仍是交办时那一版。
 await pool.query('update teloa_roles set version=version+1 where owner_id=$1 and id=$2',[f.owner,f.role.id])
 const before=await taskRow(f.owner,f.created.task.id),stale=await f.reserve((await f.send('继续原任务。')).id,'continue')
 assert.equal(stale.state,'reserved','登记本身仍持久保存')
 const rejected=await f.inputs.continueTask(f.owner,stale.requestId)
 assert.deepEqual([rejected.state,rejected.taskVersion],['rejected',before.version])
 assert.deepEqual(await taskRow(f.owner,f.created.task.id),before,'拒绝不升版本、不改状态、不把任务续签到新员工版本')
 assert.equal((await pool.query('select reason from teloa_group_work_inputs where owner_id=$1 and request_id=$2',[f.owner,stale.requestId])).rows[0].reason,'teloa/version-conflict')
 // 本人确认同员工新版本的交接（与 handoffs/change 写入等价的负责人版本推进）后，新的续办恢复正常升版本。
 const role=(await pool.query('select version from teloa_roles where owner_id=$1 and id=$2',[f.owner,f.role.id])).rows[0].version as number
 await pool.query('update teloa_tasks set assignee_role_version=$3,version=version+1 where owner_id=$1 and id=$2',[f.owner,f.created.task.id,role])
 const confirmed=await taskRow(f.owner,f.created.task.id),fresh=await f.reserve((await f.send('交接后再继续。')).id,'continue')
 assert.deepEqual([(await f.inputs.continueTask(f.owner,fresh.requestId)).state,(await taskRow(f.owner,f.created.task.id)).version],['continued',confirmed.version+1])
})

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
 // 执行失败只推进状态版本，重试仍需收到同一明确追加；本人改了目标后则不能套用旧追加。
 await pool.query("update teloa_tasks set state='blocked',version=version+2 where owner_id=$1 and id=$2",[f.owner,f.created.task.id])
 assert.equal((await readGroupWorkContinuation(pool,f.owner,f.created.task.id,original.version+3))?.text,'补上负责人列。')
 await new TaskService(pool,identity).edit(f.owner,{taskId:f.created.task.id,expectedVersion:original.version+3,fields:{title:f.created.task.title,goal:'新的独立目标。'}})
 assert.equal(await readGroupWorkContinuation(pool,f.owner,f.created.task.id,original.version+4),undefined,'内容版本改变不能继承先前追加')
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

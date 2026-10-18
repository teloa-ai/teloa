import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {Pool,stopTestContainer} from './postgres-test-lifecycle.ts'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import type {GroupRoutingDecision} from '@teloa/contract'
import {initializeTeloaDatabase} from '../src/work/initialize-database.ts'
import {CollaborationService} from '../src/work/collaboration.ts'
import {GroupRoutingDecisionService} from '../src/work/group-routing-decisions.ts'
import {GroupRoutingOutboxService} from '../src/work/group-routing-outbox.ts'
import {GroupRoutingAttemptService} from '../src/work/group-routing-attempts.ts'
import {GroupRoutingStatusService} from '../src/work/group-routing-status.ts'
import {roleFixture,insertRoleRun} from './role-work-test-fixture.ts'
import {WorkLineageService} from '../src/work/work-lineage.ts'

let container:StartedPostgreSqlContainer,pool:Pool
let tick=0
const identity={id:randomUUID,now:()=>new Date(Date.parse('2026-10-14T09:00:00.000Z')+(tick++)*1000).toISOString()}
const rules={historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true}
before(async()=>{container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()});await initializeTeloaDatabase(pool)},{timeout:120000})
after(async()=>{await pool?.end();await stopTestContainer(container)})

const decisionOf=(kind:GroupRoutingDecision['kind'],respond:string[]=[]):GroupRoutingDecision=>({kind,respond,reactions:[],hops:0,candidateIds:respond,truncatedCandidates:false,stopMessageId:null,at:identity.now()})

async function fixture(owner='attempts-test:'+randomUUID()){
 const groups=new CollaborationService(pool,identity),outbox=new GroupRoutingOutboxService(pool,identity)
 const routed=new CollaborationService(pool,identity,outbox)
 const group=await groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:{name:'连续协作',scope:'general',announcement:'',rules,memberRoleIds:[]}})
 const decisions=new GroupRoutingDecisionService(pool,identity),attempts=new GroupRoutingAttemptService(pool,identity),status=new GroupRoutingStatusService(pool)
 const send=(text:string,extra:Record<string,unknown>={})=>routed.send(owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:group.version,text,...extra})
 const decide=(messageId:string,decision:GroupRoutingDecision)=>decisions.withTopicLock(owner,group.id,messageId,db=>decisions.record(db,owner,{groupId:group.id,messageId,decision}))
 const read=async(messageId:string)=>(await status.status(owner,{groupId:group.id,messageIds:[messageId]})).items[0]!
 return {owner,groups,group,decisions,attempts,status,send,decide,read}
}

test('引用回复：同群消息持久保存关系与全员意图；别群消息与伪造作者被拒；旧请求回包形状不变',async()=>{
 const f=await fixture(),other=await fixture()
 const first=await f.send('先记下预算 680 元。')
 assert.deepEqual(Object.keys(first).sort(),['authorId','createdAt','groupId','id','mentions','references','rootId','text'])
 const reply=await f.send('还剩多少？',{replyToMessageId:first.id,mentionAll:true})
 assert.equal('replyToMessageId' in reply&&reply.replyToMessageId,first.id)
 assert.equal('mentionAll' in reply&&reply.mentionAll,true)
 const listed=(await f.groups.messages(f.owner,{groupId:f.group.id})).find(message=>message.id===reply.id)
 assert.deepEqual(listed,reply)
 const foreign=await other.send('另一群的消息。')
 await assert.rejects(f.send('引用别群',{replyToMessageId:foreign.id}),{code:'teloa/forbidden'})
 await assert.rejects(f.send('伪造作者',{replyToMessageId:first.id,replyAuthorId:randomUUID()}),{code:'teloa/invalid-input'})
 // 同一请求重放：关系不变、消息不复制。
 const request={requestId:randomUUID(),groupId:f.group.id,expectedVersion:f.group.version,text:'重放',replyToMessageId:first.id}
 const routed=new CollaborationService(pool,identity)
 assert.deepEqual(await routed.send(f.owner,request),await routed.send(f.owner,request))
})

test('路由失败：状态给出失败与恢复；同一重试请求重放两次只新增一个尝试，消息不复制、原决策保留',async()=>{
 const f=await fixture(),message=await f.send('帮我核对预算。')
 assert.equal((await f.read(message.id)).phase,'routing','已登记唤醒、尚无决策时是正在安排')
 await f.decide(message.id,decisionOf('degraded'))
 const failed=await f.read(message.id)
 assert.deepEqual({phase:failed.phase,hint:failed.hintCode,canRetry:failed.canRetry,attempt:failed.attemptVersion},{phase:'routing-failed',hint:'route-unavailable',canRetry:true,attempt:1})
 const retry={requestId:randomUUID(),groupId:f.group.id,messageId:message.id,expectedAttempt:1,expectedGroupVersion:f.group.version}
 const [a,b]=await Promise.all([f.attempts.retry(f.owner,retry),f.attempts.retry(f.owner,retry)])
 assert.deepEqual(a,{messageId:message.id,attemptVersion:2});assert.deepEqual(b,a)
 assert.equal((await pool.query('select count(*)::int n from teloa_group_routing_attempts where owner_id=$1 and message_id=$2',[f.owner,message.id])).rows[0].n,1)
 assert.equal((await pool.query('select count(*)::int n from teloa_group_messages where owner_id=$1',[f.owner])).rows[0].n,1)
 assert.equal((await pool.query('select decision->>$3 as kind from teloa_group_routing_decisions where owner_id=$1 and message_id=$2',[f.owner,message.id,'kind'])).rows[0].kind,'degraded')
 assert.equal((await pool.query('select state from teloa_group_routing_wakes where owner_id=$1 and message_id=$2',[f.owner,message.id])).rows[0].state,'pending')
 const pending=await f.read(message.id)
 assert.deepEqual({phase:pending.phase,canRetry:pending.canRetry,attempt:pending.attemptVersion},{phase:'routing',canRetry:false,attempt:2})
 // 安排中不能再叠加重试；同一请求换内容被拒。
 await assert.rejects(f.attempts.retry(f.owner,{...retry,requestId:randomUUID(),expectedAttempt:2}),{code:'teloa/conflict'})
 await assert.rejects(f.attempts.retry(f.owner,{...retry,expectedGroupVersion:f.group.version+1}),{code:'teloa/conflict'})
 // 尝试终态只写一次：第二次定案与旧尝试迟到都空手而归。
 const db=await pool.connect()
 try{
  assert.ok(await f.attempts.settle(db,f.owner,{messageId:message.id,attemptVersion:2,decision:decisionOf('parse-failed')}))
  assert.equal(await f.attempts.settle(db,f.owner,{messageId:message.id,attemptVersion:2,decision:decisionOf('routed')}),undefined)
  await assert.rejects(db.query('delete from teloa_group_routing_attempts where owner_id=$1',[f.owner]),/append-only/)
 }finally{db.release()}
 const invalid=await f.read(message.id)
 assert.deepEqual({phase:invalid.phase,hint:invalid.hintCode,canRetry:invalid.canRetry,attempt:invalid.attemptVersion},{phase:'routing-failed',hint:'route-invalid',canRetry:true,attempt:2})
 await assert.rejects(f.attempts.retry(f.owner,{...retry,requestId:randomUUID()}),{code:'teloa/version-conflict'},'过期的尝试版本不能重试')
 assert.deepEqual(await f.attempts.retry(f.owner,{...retry,requestId:randomUUID(),expectedAttempt:2}),{messageId:message.id,attemptVersion:3})
})

test('未知提交：状态只链接原工作，不允许重新选人；归档群与他人不能重试',async()=>{
 const f=await fixture(),message=await f.send('请整理跟进表。'),roleId=randomUUID()
 await f.decide(message.id,decisionOf('routed',[roleId]))
 await pool.query(`insert into teloa_group_routing_outbox(id,owner_id,group_id,message_id,decision_version,role_id,role_version,request_id,group_version,state,created_at)
  values($1,$2,$3,$4,1,$5,1,$6,$7,'unknown',$8)`,[randomUUID(),f.owner,f.group.id,message.id,roleId,randomUUID(),f.group.version,identity.now()])
 const unknown=await f.read(message.id)
 assert.deepEqual({phase:unknown.phase,hint:unknown.hintCode,canRetry:unknown.canRetry},{phase:'unknown',hint:'delivery-unknown',canRetry:false})
 assert.deepEqual(unknown.recipients,[{roleId,name:'',taskId:null,runId:null,phase:'unknown',resultMessageId:null,executionMode:'reply'}])
 await assert.rejects(f.attempts.retry(f.owner,{requestId:randomUUID(),groupId:f.group.id,messageId:message.id,expectedAttempt:1,expectedGroupVersion:f.group.version}),{code:'teloa/conflict'})
 const noted=await f.send('只是记一下，不用回复。')
 await f.decide(noted.id,decisionOf('routed'))
 const recorded=await f.read(noted.id)
 assert.deepEqual({phase:recorded.phase,canRetry:recorded.canRetry},{phase:'recorded',canRetry:false})
 const stale=await f.send('没人可选。')
 await f.decide(stale.id,decisionOf('no-candidate'))
 const archived=await f.groups.change(f.owner,{requestId:randomUUID(),groupId:f.group.id,expectedVersion:f.group.version,fields:{name:f.group.name,announcement:'',rules,memberRoleIds:[],pinned:false,archived:true}})
 assert.equal((await f.read(stale.id)).canRetry,false)
 await assert.rejects(f.attempts.retry(f.owner,{requestId:randomUUID(),groupId:f.group.id,messageId:stale.id,expectedAttempt:1,expectedGroupVersion:archived.version}),{code:'teloa/conflict'})
 await assert.rejects(f.attempts.retry('other-owner',{requestId:randomUUID(),groupId:f.group.id,messageId:stale.id,expectedAttempt:1,expectedGroupVersion:archived.version}),{code:'teloa/forbidden'})
})

test('依赖交接：后序阶段登记为 waiting，不进入待投递；前序未结束保持等待，前序被拦下则后序不再启动',async()=>{
 const f=await fixture(),message=await f.send('先整理记录，再由核对员核对整理结果。'),first=randomUUID(),second=randomUUID()
 await f.decide(message.id,{...decisionOf('routed',[first,second]),intent:'work',assignments:[{roleId:first,instructionRange:{start:0,end:6}},{roleId:second,instructionRange:{start:0,end:6},stage:2}],workTarget:null})
 const insert=(roleId:string,stage:number,state:string)=>pool.query(`insert into teloa_group_routing_outbox(id,owner_id,group_id,message_id,decision_version,role_id,role_version,request_id,group_version,state,created_at,execution_mode,stage)
  values($1,$2,$3,$4,1,$5,1,$6,$7,$8,$9,'work',$10)`,[randomUUID(),f.owner,f.group.id,message.id,roleId,randomUUID(),f.group.version,state,identity.now(),stage])
 await insert(first,1,'pending');await insert(second,2,'waiting')
 const outbox=new GroupRoutingOutboxService(pool,identity)
 assert.deepEqual((await outbox.pending(f.owner,{messageId:message.id})).map(item=>item.roleId),[first],'后序阶段不进入待投递')
 assert.equal(await outbox.releaseStages(f.owner,{messageId:message.id}),0,'前序没有结束的 Run 时保持等待')
 assert.equal((await pool.query('select state from teloa_group_routing_outbox where owner_id=$1 and role_id=$2',[f.owner,second])).rows[0].state,'waiting')
 await pool.query("update teloa_group_routing_outbox set state='blocked' where owner_id=$1 and role_id=$2",[f.owner,first])
 await outbox.releaseStages(f.owner,{messageId:message.id})
 assert.equal((await pool.query('select state from teloa_group_routing_outbox where owner_id=$1 and role_id=$2',[f.owner,second])).rows[0].state,'blocked','前序被拦下时后序不再启动')
 const status=await f.read(message.id)
 assert.ok(status.recipients.every(item=>item.executionMode==='work'))
})

test('依赖交接：前序 Run 以错误结束不等于已交付，后序阶段应阻断而非等待或启动',async()=>{
 const role=await roleFixture(pool,'employee'),f=await fixture(role.owner),message=await f.send('先整理，再核对。'),next=randomUUID()
 await f.decide(message.id,{...decisionOf('routed',[role.role.id,next]),intent:'work',assignments:[{roleId:role.role.id,instructionRange:{start:0,end:4}},{roleId:next,instructionRange:{start:0,end:4},stage:2}],workTarget:null})
 const runId=await insertRoleRun(pool,f.owner,role.role.id,role.taskId,'ended')
 await pool.query("update teloa_task_runs set evidence=jsonb_set(evidence,'{reason}','\"error\"') where owner_id=$1 and id=$2",[f.owner,runId])
 const insert=(roleId:string,stage:number,state:string,taskId:string|null,run:string|null)=>pool.query(`insert into teloa_group_routing_outbox(id,owner_id,group_id,message_id,decision_version,role_id,role_version,request_id,group_version,state,task_id,run_id,created_at,execution_mode,stage)
  values($1,$2,$3,$4,1,$5,1,$6,$7,$8,$9,$10,$11,'work',$12)`,[randomUUID(),f.owner,f.group.id,message.id,roleId,randomUUID(),f.group.version,state,taskId,run,identity.now(),stage])
 await insert(role.role.id,1,'settled',role.taskId,runId);await insert(next,2,'waiting',null,null)
 await new GroupRoutingOutboxService(pool,identity).releaseStages(f.owner,{messageId:message.id})
 assert.equal((await pool.query('select state from teloa_group_routing_outbox where owner_id=$1 and role_id=$2',[f.owner,next])).rows[0].state,'blocked','前序错误终态不能当作可信成果就绪')
})

test('冷恢复：原控制暂停不能把已经结束并贴回的交流回复投影为暂停',async()=>{
 const role=await roleFixture(pool,'employee'),f=await fixture(role.owner),message=await f.send('预算还剩多少？')
 await f.decide(message.id,decisionOf('routed',[role.role.id]))
 const runId=await insertRoleRun(pool,f.owner,role.role.id,role.taskId,'ended')
 await pool.query(`insert into teloa_group_routing_outbox(id,owner_id,group_id,message_id,decision_version,role_id,role_version,request_id,group_version,state,task_id,run_id,created_at)
  values($1,$2,$3,$4,1,$5,1,$6,$7,'settled',$8,$9,$10)`,[randomUUID(),f.owner,f.group.id,message.id,role.role.id,randomUUID(),f.group.version,role.taskId,runId,identity.now()])
 const answer=await f.send('还剩 680 元。',{rootId:message.id})
 await pool.query('update teloa_group_messages set author_id=$3,task_id=$4,run_id=$5 where owner_id=$1 and id=$2',[f.owner,answer.id,role.role.id,role.taskId,runId])
 const db=await pool.connect()
 try{
  await db.query('begin')
  const lineage=await new WorkLineageService(pool,identity).bindTask(db,f.owner,{taskId:role.taskId,source:{kind:'owner-task',taskId:role.taskId}})
  await db.query("update teloa_work_controls set state='paused' where owner_id=$1 and id=$2",[f.owner,lineage.roundControlId])
  await db.query('commit')
 }catch(error){await db.query('rollback');throw error}finally{db.release()}
 const actual=await f.read(message.id)
 assert.equal(actual.phase,'completed');assert.equal(actual.recipients[0]?.resultMessageId,answer.id)
})

test('依赖撤销：全部工作接手者失效时明确不可用，不把未完成的工作显示成仅记录',async()=>{
 const f=await fixture(),message=await f.send('先整理再核对。'),roleId=randomUUID()
 await f.decide(message.id,{...decisionOf('routed'),candidateIds:[roleId],intent:'work',assignments:[],workTarget:null,withdrawn:[roleId]})
 const status=await f.read(message.id)
 assert.equal(status.phase,'unavailable');assert.equal(status.hintCode,'not-authorized');assert.equal(status.recipients[0]?.phase,'unavailable')
})

test('原生失败：工作因输出截断结束且未交付时明确失败，不永久显示正在贴回成果',async()=>{
 const role=await roleFixture(pool,'employee'),f=await fixture(role.owner),text='制作预算核对报告。',message=await f.send(text)
 await f.decide(message.id,{...decisionOf('routed',[role.role.id]),intent:'work',assignments:[{roleId:role.role.id,instructionRange:{start:0,end:text.length}}],workTarget:null})
 const runId=await insertRoleRun(pool,f.owner,role.role.id,role.taskId,'ended')
 await pool.query("update teloa_task_runs set evidence=jsonb_set(evidence,'{reason}','\"max-tokens\"') where owner_id=$1 and id=$2",[f.owner,runId])
 await pool.query("update teloa_tasks set state='blocked' where owner_id=$1 and id=$2",[f.owner,role.taskId])
 await pool.query(`insert into teloa_group_routing_outbox(id,owner_id,group_id,message_id,decision_version,role_id,role_version,request_id,group_version,state,task_id,run_id,created_at,execution_mode)
  values($1,$2,$3,$4,1,$5,1,$6,$7,'settled',$8,$9,$10,'work')`,[randomUUID(),f.owner,f.group.id,message.id,role.role.id,randomUUID(),f.group.version,role.taskId,runId,identity.now()])
 const status=await f.read(message.id)
 assert.equal(status.phase,'blocked');assert.equal(status.hintCode,'work-failed');assert.equal(status.canRetry,false);assert.equal(status.recipients[0]?.taskId,role.taskId)
})

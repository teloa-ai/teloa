import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {setupRoleWork,insertRoleRun} from './role-work-test-fixture.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'
import {RoleService} from '../src/work/roles.ts'
import {TaskService} from '../src/work/tasks.ts'
import {CollaborationService} from '../src/work/collaboration.ts'
import {initializeArtifactSnapshots} from '../src/work/artifact-snapshots.ts'
import {ArtifactService,initializeArtifacts} from '../src/work/artifacts.ts'
import {taskArtifactSource} from '../src/work/artifact-task-source.ts'
import {initializeMarkdownKnowledge} from '../src/capabilities/markdown-knowledge.ts'
import {initializeRoleMemory,RoleMemoryService} from '../src/work/role-memory.ts'
import {initializePlans} from '../src/work/plans.ts'
import {initializePlanOccurrences} from '../src/work/plan-occurrences.ts'
import {initializeBusinessData} from '../src/work/business-data.ts'
import {initializeBusinessTasks} from '../src/work/business-tasks.ts'
import {initializeSecurityRequests} from '../src/security/request-journal.ts'
import {initializeSecurityActions} from '../src/security/actions.ts'
import {initializeSecurityApprovals} from '../src/security/approvals.ts'
import {initializeRoleDailyLogs,RoleDailyLogService} from '../src/work/role-daily-logs.ts'

import {AutoDreamHabitService} from '../src/work/auto-dream-habits.ts'
let f:Awaited<ReturnType<typeof setupRoleWork>>
before(async()=>{
 f=await setupRoleWork()
 await initializeArtifactSnapshots(f.pool);await initializeArtifacts(f.pool);await initializeMarkdownKnowledge(f.pool);await initializeRoleMemory(f.pool)
 await initializePlans(f.pool);await initializePlanOccurrences(f.pool);await initializeBusinessData(f.pool);await initializeBusinessTasks(f.pool)
 await initializeSecurityRequests(f.pool);await initializeSecurityActions(f.pool);await initializeSecurityApprovals(f.pool);await initializeRoleDailyLogs(f.pool)
},{timeout:120000})
after(async()=>{await f?.close()})

const day='2026-10-26',inDay='2026-10-26T04:00:00.000Z',outOfDay='2026-10-24T04:00:00.000Z',now='2026-10-26T15:45:00.000Z'
const ownerGoal='请甲员工核对合成金额20元与30元，给出总额。'
const employeeGoal='仅属员工交接措辞，不能学习成本人偏好。'.repeat(8)
async function world(parentInDay:boolean){
 const owner=randomUUID();let clock=parentInDay?inDay:outOfDay
 const identity={id:randomUUID,now:()=>clock},roles=new RoleService(f.pool,identity)
 const employee=await roles.create(owner,{requestId:randomUUID(),fields:{name:'来源核对员工',kind:'employee',scopes:['general'],duty:'核对合成资料',dataScope:'本轮合成资料',executionScope:'只读分析',skills:[],knowledge:[],responsibility:testRoleResponsibility}})
 const twin=await roles.ensurePersonalTwin(owner),groups=new CollaborationService(f.pool,identity)
 const group=await groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:{name:'本人和员工来源区分',scope:'general',announcement:'',rules:{historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true},memberRoleIds:[employee.id]}})
 const tasks=new TaskService(f.pool,identity),parent=await tasks.create(owner,{requestId:randomUUID(),fields:{title:'本人原始交办',goal:ownerGoal,scope:'general',groupId:group.id}})
 const self=await groups.send(owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:1,text:ownerGoal})
 const runId=await insertRoleRun(f.pool,owner,employee.id,parent.id,'ended')
 clock=inDay
 const employeeMessage=randomUUID()
 // 真实服务创建子 Task 前所需的持久 Run 作者事实；不执行 Run，不模拟模型输出成功。
 await f.pool.query(`insert into teloa_group_messages(id,owner_id,group_id,request_id,request_spec,root_id,author_id,text,reference_snapshot,created_at,task_id,run_id)
 values($1,$2,$3,$4,'{}'::jsonb,$5,$6,$7,'[]'::jsonb,$8,$9,$10)`,[employeeMessage,owner,group.id,randomUUID(),self.id,employee.id,employeeGoal,inDay,parent.id,runId])
 const db=await f.pool.connect();let child
 try{await db.query('begin');child=await tasks.createInTransaction(db,owner,{requestId:randomUUID(),fields:{title:'员工自动交接',goal:employeeGoal,scope:'general',groupId:group.id}},{kind:'group-run-message',runId,messageId:employeeMessage});await db.query('commit')}catch(error){await db.query('rollback');throw error}finally{db.release()}
 const memory=new RoleMemoryService(f.pool,identity),logs=new RoleDailyLogService(f.pool,identity,memory)
 const habits=new AutoDreamHabitService(f.pool,identity,logs,async()=>({enabled:true,trigger:{kind:'schedule',time:'23:30',cadence:'daily',weekday:1,timezone:'Asia/Singapore'}}))
 return {owner,twin,memory,habits,parent,child,runId}
}

test('本人交办+同owner员工child：仅本人goal进入日志和自动私有记忆，按日幂等且不新增Run',async()=>{
 const x=await world(true),before=(await f.pool.query('select count(*)::int n from teloa_task_runs where owner_id=$1',[x.owner])).rows[0].n
 const log=await x.habits.ensureForDay(x.owner,x.twin,now)
 assert.ok(log);assert.equal(log.kind,'habit-digest');assert.equal(log.runId,null)
 assert.match(log.markdown,/当天新建任务 1 条/)
 assert.ok(log.markdown.includes(`最短 ${ownerGoal.length} 字、中位 ${ownerGoal.length} 字、最长 ${ownerGoal.length} 字`))
 const memories=await x.memory.list({ownerId:x.owner,kind:'human'},{roleId:x.twin.id})
 assert.equal(memories.length,1);const memory=memories[0];assert.ok(memory)
 assert.equal(memory.state,'confirmed');assert.equal(memory.visibility.kind,'private');assert.equal(memory.content.markdown,log.markdown)
 assert.equal(await x.habits.ensureForDay(x.owner,x.twin,now),undefined)
 assert.equal((await f.pool.query("select count(*)::int n from teloa_role_daily_logs where owner_id=$1 and kind='habit-digest' and day=$2",[x.owner,day])).rows[0].n,1)
 assert.equal((await f.pool.query('select count(*)::int n from teloa_task_runs where owner_id=$1',[x.owner])).rows[0].n,before)
})

test('当天只有员工交接child：不把其goal记为本人习惯，也不生成或确认私有记忆',async()=>{
 const x=await world(false)
 assert.equal(await x.habits.ensureForDay(x.owner,x.twin,now),undefined)
 assert.equal((await f.pool.query("select count(*)::int n from teloa_role_daily_logs where owner_id=$1 and kind='habit-digest'",[x.owner])).rows[0].n,0)
 assert.deepEqual(await x.memory.list({ownerId:x.owner,kind:'human'},{roleId:x.twin.id}),[])
})

test('成果对象撤回后习惯观察不再把原成果修订计为当前依据，历史版本保留',async()=>{
 const identity={id:randomUUID,now:()=>now}
 const seed=async()=>{
  const x=await world(true),id=randomUUID(),source={kind:'task' as const,id:x.parent.id,scope:'general',version:'1',title:'本轮合成原稿'},content={title:'本轮合成原稿',sections:[{id:'body',title:'正文',text:'合成正文'}],snapshotIds:[],note:'历史合成版本'}
  await f.pool.query('insert into teloa_artifacts values($1,$2,$3,$4,$5,2)',[id,x.owner,randomUUID(),'{}',JSON.stringify(['task',x.parent.id,'general',''])])
  for(const number of [1,2])await f.pool.query('insert into teloa_artifact_versions(owner_id,artifact_id,number,source,content,created_at) values($1,$2,$3,$4,$5,$6)',[x.owner,id,number,JSON.stringify(number===1?{kind:'run',id:x.runId,scope:'general',version:'1',title:'原run'}:source),JSON.stringify(content),inDay])
  return {x,id,source}
 }
 const active=await seed(),kept=await active.x.habits.ensureForDay(active.x.owner,active.x.twin,now)
 assert.ok(kept?.evidence.some(e=>e.kind==='revision'&&e.id===active.id))
 const withdrawn=await seed(),before=(await f.pool.query('select * from teloa_artifact_versions where owner_id=$1 order by number',[withdrawn.x.owner])).rows
 await new ArtifactService(f.pool,identity,async()=>{throw Error('只撤回固定历史，不解析新来源')}).withdraw(withdrawn.x.owner,{requestId:randomUUID(),artifactId:withdrawn.id,expectedVersion:2,source:withdrawn.source})
 const log=await withdrawn.x.habits.ensureForDay(withdrawn.x.owner,withdrawn.x.twin,now);assert.ok(log)
 assert.equal(log.evidence.some(e=>e.kind==='revision'&&e.id===withdrawn.id),false)
 assert.deepEqual((await f.pool.query('select * from teloa_artifact_versions where owner_id=$1 order by number',[withdrawn.x.owner])).rows,before)
})

test('AD12 正常 task 来源成果的本人修订进入观察，初版不计修订且正文不进入习惯',async()=>{
 const owner=randomUUID();let clock=inDay
 const identity={id:randomUUID,now:()=>clock},roles=new RoleService(f.pool,identity)
 const employee=await roles.create(owner,{requestId:randomUUID(),fields:{name:'正常成果来源员工',kind:'employee',scopes:['general'],duty:'核对合成材料',dataScope:'本轮合成材料',executionScope:'只读分析',skills:[],knowledge:[],responsibility:testRoleResponsibility}})
 const twin=await roles.ensurePersonalTwin(owner),task=await new TaskService(f.pool,identity).create(owner,{requestId:randomUUID(),fields:{title:'本人交办',goal:'本轮合成核对',scope:'general'},assignee:{roleId:employee.id,expectedVersion:employee.version}})
 // 受控 Run 元数据仅用于真实 PG 的归属回归，不冒充宿主运行或模型产出。
 const runId=await insertRoleRun(f.pool,owner,employee.id,task.id,'ended')
 await f.pool.query('update teloa_task_runs set created_at=$2 where id=$1',[runId,inDay])
 clock='2026-10-26T04:01:00.000Z'
 const artifacts=new ArtifactService(f.pool,identity,async(actor,source,db)=>({source:await taskArtifactSource(db,actor,source.id,true),sessionIds:[]}))
 const source=await taskArtifactSource(f.pool,owner,task.id,false),content={title:'合成成果',sections:[{id:'body',title:'正文',text:'本轮初版，非长期偏好。'}],snapshotIds:[],note:'初版'}
 const first=await artifacts.create(owner,{requestId:randomUUID(),source,content})
 clock='2026-10-26T04:02:00.000Z'
 await artifacts.revise(owner,{artifactId:first.artifactId,expectedVersion:1,source,content:{...content,sections:[{id:'body',title:'正文',text:'AD12_PRIVATE_REVISION_BODY：只对这次例外适用。'}],note:'本人修订'}})
 // 后续本人接手同一 Task，不能反过来抹掉初版已经成立的员工来源。
 const future=await insertRoleRun(f.pool,owner,employee.id,task.id,'ended')
 await f.pool.query("update teloa_task_runs set created_at=$2,role_id=null,role_version=null,owner_executor='{\"kind\":\"owner\"}' where id=$1",[future,'2026-10-26T05:00:00.000Z'])
 const memory=new RoleMemoryService(f.pool,identity),logs=new RoleDailyLogService(f.pool,identity,memory),habits=new AutoDreamHabitService(f.pool,identity,logs,async()=>({enabled:true,trigger:{kind:'schedule',time:'23:30',cadence:'daily',weekday:1,timezone:'Asia/Singapore'}}))
 const log=await habits.ensureForDay(owner,twin,now);assert.ok(log)
 assert.deepEqual(log.evidence.filter(e=>e.kind==='revision'),[{kind:'revision',id:first.artifactId,version:2,title:'修订：本日新增 1 版'}])
 assert.doesNotMatch(log.markdown,/AD12_PRIVATE_REVISION_BODY|长期偏好|只对这次例外/)
 const saved=(await memory.list({ownerId:owner,kind:'human'},{roleId:twin.id}))[0];assert.ok(saved)
 assert.equal(saved.content.markdown,log.markdown);assert.equal(saved.state,'confirmed')
})

for(const scenario of ['没有原Run','只有本人Run','跨本人岗位','跨本人任务','初版之后的Run','高于保存版本的Run','多员工归属','来源业务不符','非当日修订','成果已撤回'] as const){
 test('AD12 task 修订拒绝不可信归属：'+scenario,async()=>{
  const owner=randomUUID(),identity={id:randomUUID,now:()=>inDay},roles=new RoleService(f.pool,identity)
  const employee=await roles.create(owner,{requestId:randomUUID(),fields:{name:'来源边界员工',kind:'employee',scopes:['general'],duty:'核对来源',dataScope:'本轮合成来源',executionScope:'只读',skills:[],knowledge:[],responsibility:testRoleResponsibility}})
  const twin=await roles.ensurePersonalTwin(owner),task=await new TaskService(f.pool,identity).create(owner,{requestId:randomUUID(),fields:{title:'本人任务',goal:'本轮来源边界核对',scope:'general'}})
  const source=await taskArtifactSource(f.pool,owner,task.id,false),artifactId=randomUUID(),content={title:'归属边界',sections:[{id:'body',title:'正文',text:'受控来源元数据，不是模型运行验收。'}],snapshotIds:[],note:'来源边界测试'}
  // 用例隔离库中的固定来源反例；不向保留运行库写伪造 Run、成果或生产回执。
  let runId:string|undefined
  if(scenario!=='没有原Run'){
   runId=await insertRoleRun(f.pool,owner,employee.id,task.id,'ended')
   await f.pool.query('update teloa_task_runs set created_at=$2 where id=$1',[runId,inDay])
  }
  if(scenario==='只有本人Run')await f.pool.query("update teloa_task_runs set role_id=null,role_version=null,owner_executor='{\"kind\":\"owner\"}' where id=$1",[runId])
  if(scenario==='跨本人岗位'){
   const foreign=await roles.create(randomUUID(),{requestId:randomUUID(),fields:{name:'他人岗位',kind:'employee',scopes:['general'],duty:'核对来源',dataScope:'他人资料',executionScope:'只读',skills:[],knowledge:[],responsibility:testRoleResponsibility}})
   await f.pool.query('update teloa_task_runs set role_id=$2 where id=$1',[runId,foreign.id])
  }
  if(scenario==='跨本人任务'){
   const foreign=await new TaskService(f.pool,identity).create(randomUUID(),{requestId:randomUUID(),fields:{title:'他人任务',goal:'他人任务来源',scope:'general'}})
   source.id=foreign.id
  }
  if(scenario==='初版之后的Run')await f.pool.query('update teloa_task_runs set created_at=$2 where id=$1',[runId,'2026-10-26T05:00:00.000Z'])
  if(scenario==='高于保存版本的Run')await f.pool.query('update teloa_task_runs set task_version=$2 where id=$1',[runId,task.version+1])
  if(scenario==='多员工归属'){
   const second=await roles.create(owner,{requestId:randomUUID(),fields:{name:'另一员工',kind:'employee',scopes:['general'],duty:'核对来源',dataScope:'本轮合成来源',executionScope:'只读',skills:[],knowledge:[],responsibility:testRoleResponsibility}})
   const secondRun=await insertRoleRun(f.pool,owner,second.id,task.id,'ended')
   await f.pool.query('update teloa_task_runs set created_at=$2 where id=$1',[secondRun,inDay])
  }
  if(scenario==='来源业务不符')source.scope='other'
  await f.pool.query('insert into teloa_artifacts values($1,$2,$3,$4,$5,2)',[artifactId,owner,randomUUID(),'{}',JSON.stringify([source.kind,source.id,source.scope,''])])
  for(const number of [1,2])await f.pool.query('insert into teloa_artifact_versions(owner_id,artifact_id,number,source,content,created_at) values($1,$2,$3,$4,$5,$6)',[owner,artifactId,number,JSON.stringify(source),JSON.stringify(content),scenario==='非当日修订'?outOfDay:number===1?'2026-10-26T04:01:00.000Z':'2026-10-26T04:02:00.000Z'])
  if(scenario==='成果已撤回')await new ArtifactService(f.pool,identity,async()=>{throw Error('撤回不读取新来源')}).withdraw(owner,{requestId:randomUUID(),artifactId,expectedVersion:2,source})
  const memory=new RoleMemoryService(f.pool,identity),logs=new RoleDailyLogService(f.pool,identity,memory),habits=new AutoDreamHabitService(f.pool,identity,logs,async()=>({enabled:true,trigger:{kind:'schedule',time:'23:30',cadence:'daily',weekday:1,timezone:'Asia/Singapore'}}))
  const log=await habits.ensureForDay(owner,twin,now);assert.ok(log)
  assert.deepEqual(log.evidence.filter(item=>item.kind==='revision'),[])
  assert.match(log.markdown,/当天没有修订记录/)
 })
}

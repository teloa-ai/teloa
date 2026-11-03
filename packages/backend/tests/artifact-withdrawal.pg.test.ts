import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID,createHash} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {Pool,stopTestContainer} from './postgres-test-lifecycle.ts'
import {ArtifactSnapshotStore,initializeArtifactSnapshots} from '../src/work/artifact-snapshots.ts'
import {ArtifactService,initializeArtifacts} from '../src/work/artifacts.ts'
import {ArtifactAvailabilityService,assertArtifactAvailable} from '../src/work/artifact-availability.ts'
import {ArtifactFeedbackService,initializeArtifactFeedback} from '../src/work/artifact-feedback.ts'
import {MethodReuseService} from '../src/work/method-reuse.ts'
import {readRunGroupArtifactImageBytes} from '../src/work/task-run-group-context.ts'
import {projectCandidates,readProjectItems} from '../src/work/project-items.ts'
import {ArtifactRevisionRequestService} from '../src/work/artifact-revision-requests.ts'
import {initializeRoles,RoleService} from '../src/work/roles.ts'
import {initializeTaskRuns} from '../src/work/task-runs.ts'
import {taskArtifactSource} from '../src/work/artifact-task-source.ts'
import {initializeRoleMemory,RoleMemoryService} from '../src/work/role-memory.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'
import {TaskService,initializeTasks} from '../src/work/tasks.ts'
import {TaskTransitions,initializeTaskTransitions,initializeTaskCompletions} from '../src/work/task-transitions.ts'

let container:StartedPostgreSqlContainer,pool:Pool
before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start()
 pool=new Pool({connectionString:container.getConnectionUri()})
 await initializeArtifactSnapshots(pool);await initializeArtifacts(pool)
 // 模拟升级后已持久化的撤回记录，验证现有修订入口不能绕过；不是修改既有实例。
 await pool.query(`create table if not exists teloa_artifact_withdrawals(
  owner_id text not null,artifact_id uuid not null,request_id uuid not null,request_spec jsonb not null,
  expected_version integer not null,source jsonb not null,withdrawn_at timestamptz not null,
  primary key(owner_id,artifact_id),unique(owner_id,request_id),
  foreign key(owner_id,artifact_id) references teloa_artifacts(owner_id,id)
 )`)
})
after(async()=>{await pool?.end();await stopTestContainer(container)})
async function fixture(){
 const owner=randomUUID(),source={kind:'session' as const,id:randomUUID(),scope:'general',version:'synthetic-v1',title:'撤回验收合成来源'}
 const service=new ArtifactService(pool,{id:randomUUID,now:()=>new Date().toISOString()},async()=>({source,sessionIds:[source.id]}))
 const content={title:'合成成果',sections:[{id:'body',title:'正文',text:'固定原稿'}],snapshotIds:[],note:'原件'}
 const input={requestId:randomUUID(),source,content},first=await service.create(owner,input)
 return {owner,source,service,content,input,first}
}
test('对象撤回阻断新的修订，但原版本和已经成功的创建/修订回执仍可审计恢复',async()=>{
 const f=await fixture(),edit={artifactId:f.first.artifactId,expectedVersion:1,source:f.source,content:{...f.content,sections:[{id:'body',title:'正文',text:'已保存第二版'}],note:'第二版'}}
 const second=await f.service.revise(f.owner,edit),before=await f.service.list(f.owner,{artifactId:f.first.artifactId})
 await pool.query('insert into teloa_artifact_withdrawals values($1,$2,$3,$4,$5,$6,$7)',[f.owner,f.first.artifactId,randomUUID(),JSON.stringify({synthetic:true}),2,JSON.stringify(f.source),new Date().toISOString()])
 await assert.rejects(f.service.revise(f.owner,{...edit,expectedVersion:2,content:{...f.content,note:'撤回后不能新修订'}}),error=>typeof error==='object'&&error!==null&&Reflect.get(error,'code')==='teloa/source-unavailable')
 assert.deepEqual(await f.service.list(f.owner,{artifactId:f.first.artifactId}),before)
 assert.deepEqual(await f.service.create(f.owner,f.input),f.first)
 assert.deepEqual(await f.service.revise(f.owner,edit),second)
 assert.equal((await pool.query('select count(*)::int as count from teloa_artifact_versions where owner_id=$1',[f.owner])).rows[0].count,2)
})

test('本人以固定头版本及来源撤回；相同请求恢复原回执，不同意图/跨本人/CAS不得改写',async()=>{
 const f=await fixture(),input={requestId:randomUUID(),artifactId:f.first.artifactId,expectedVersion:1,source:f.source}
 const service=f.service as ArtifactService&{withdraw:(owner:string,input:unknown)=>Promise<unknown>;availability:(owner:string,input:unknown)=>Promise<unknown>}
 await assert.rejects(service.withdraw('foreign',input),{code:'teloa/forbidden'})
 await assert.rejects(service.withdraw(f.owner,{...input,expectedVersion:2}),{code:'teloa/version-conflict'})
 await assert.rejects(service.withdraw(f.owner,{...input,source:{...f.source,version:'other'}}),{code:'teloa/version-conflict'})
 const [a,b]=await Promise.all([service.withdraw(f.owner,input),service.withdraw(f.owner,input)])
 assert.deepEqual(a,b);assert.deepEqual(await service.withdraw(f.owner,input),a)
 await assert.rejects(service.withdraw(f.owner,{...input,expectedVersion:2}),{code:'teloa/conflict'})
 await assert.rejects(service.withdraw(f.owner,{...input,requestId:randomUUID()}),{code:'teloa/conflict'})
 assert.equal(Reflect.get(await service.availability(f.owner,{artifactId:f.first.artifactId}) as object,'state'),'withdrawn')
 assert.deepEqual(await f.service.list(f.owner,{artifactId:f.first.artifactId}),[f.first])
 assert.deepEqual(await f.service.create(f.owner,f.input),f.first)
})

test('prepare前的可重复读快照不能在撤回提交后绕过最终输入准入',async()=>{
 const f=await fixture(),db=await pool.connect()
 try{
  await db.query('begin isolation level repeatable read')
  await db.query('select * from teloa_artifacts where owner_id=$1',[f.owner])
  await f.service.withdraw(f.owner,{requestId:randomUUID(),artifactId:f.first.artifactId,expectedVersion:1,source:f.source})
  await assert.rejects(assertArtifactAvailable(db,f.owner,f.first.artifactId,1),error=>typeof error==='object'&&error!==null&&['teloa/source-unavailable','40001'].includes(String(Reflect.get(error,'code'))))
 }finally{await db.query('rollback');db.release()}
})
test('撤回覆盖旧版本，审计版本与原文件快照不被删除',async()=>{
 const f=await fixture(),second=await f.service.revise(f.owner,{artifactId:f.first.artifactId,expectedVersion:1,source:f.source,content:{...f.content,note:'最新版本'}})
 const db=await pool.connect()
 try{
  await db.query('begin');await assertArtifactAvailable(db,f.owner,f.first.artifactId,1);await db.query('commit')
  await f.service.withdraw(f.owner,{requestId:randomUUID(),artifactId:f.first.artifactId,expectedVersion:2,source:f.source})
  for(const number of [1,2]){
   await db.query('begin');await assert.rejects(assertArtifactAvailable(db,f.owner,f.first.artifactId,number),{code:'teloa/source-unavailable'});await db.query('rollback')
  }
  assert.deepEqual(await f.service.list(f.owner,{artifactId:f.first.artifactId}),[f.first,second])
 }finally{await db.query('rollback');db.release()}
})

test('撤回后method_source不能再读取固定正文，owner历史读保持可用',async()=>{
 const f=await fixture(),unused=async()=>{throw Error('本用例不得进入写入或模型端口')}
 const methods=new MethodReuseService(pool,{id:randomUUID,now:()=>new Date().toISOString()},{artifacts:f.service,drafts:{createInTransaction:unused,draftInTransaction:unused},readAcceptedMessage:unused,assertSourceCurrent:async()=>{},prepareBody:unused})
 assert.deepEqual((await methods.readSource(f.owner,{artifactId:f.first.artifactId,version:1})).artifact,f.first)
 await f.service.withdraw(f.owner,{requestId:randomUUID(),artifactId:f.first.artifactId,expectedVersion:1,source:f.source})
 await assert.rejects(methods.readSource(f.owner,{artifactId:f.first.artifactId,version:1}),{code:'teloa/source-unavailable'})
 assert.deepEqual(await f.service.list(f.owner,{artifactId:f.first.artifactId}),[f.first])
})
test('撤回阻断新反馈，原反馈成功回执和历史仍保留',async()=>{
 const f=await fixture();await initializeArtifactFeedback(pool)
 const feedback=new ArtifactFeedbackService(pool,{id:randomUUID,now:()=>new Date().toISOString()}),input={requestId:randomUUID(),artifactId:f.first.artifactId,version:1,source:f.source,sectionId:'body',text:'原反馈'}
 const saved=await feedback.add(f.owner,input)
 await f.service.withdraw(f.owner,{requestId:randomUUID(),artifactId:f.first.artifactId,expectedVersion:1,source:f.source})
 await assert.rejects(feedback.add(f.owner,{...input,requestId:randomUUID(),text:'不应成为新反馈'}),{code:'teloa/source-unavailable'})
 assert.deepEqual(await feedback.add(f.owner,input),saved);assert.deepEqual(await feedback.list(f.owner,{artifactId:f.first.artifactId}),[saved])
})
test('已准备的群成果图片不能在撤回后从snapshot绕过，但owner审计原件仍exact',async()=>{
 const f=await fixture(),bytes=Buffer.from([137,80,78,71,13,10,26,10]),sha256=createHash('sha256').update(bytes).digest('hex'),store=new ArtifactSnapshotStore(pool)
 const snapshotId=await store.save(f.owner,{schema:'teloa.file-snapshot/v1',sessionId:f.source.id,id:'b'.repeat(64),path:'fixture.png',sha256,bytes:bytes.length,capturedAt:new Date().toISOString(),contentBase64:bytes.toString('base64')})
 await f.service.revise(f.owner,{artifactId:f.first.artifactId,expectedVersion:1,source:f.source,content:{...f.content,snapshotIds:[snapshotId],note:'固定图'}})
 const file={kind:'artifact' as const,id:f.first.artifactId,version:2,sha256,mime:'image/png',bytes:bytes.length,name:'fixture.png'}
 assert.deepEqual(Buffer.from(await readRunGroupArtifactImageBytes(pool,f.owner,file)),bytes)
 await f.service.withdraw(f.owner,{requestId:randomUUID(),artifactId:f.first.artifactId,expectedVersion:2,source:f.source})
 await assert.rejects(readRunGroupArtifactImageBytes(pool,f.owner,file),{code:'teloa/source-unavailable'})
 assert.equal((await store.read(f.owner,snapshotId)).contentBase64,bytes.toString('base64'))
})

test('项目不把撤回成果显示为新关联候选；原固定关联显示不可用而不改写',async()=>{
 const f=await fixture(),ref={kind:'artifact' as const,id:f.first.artifactId}
 assert.equal((await projectCandidates(pool,f.owner,'general','artifact','')).length,1)
 await f.service.withdraw(f.owner,{requestId:randomUUID(),artifactId:f.first.artifactId,expectedVersion:1,source:f.source})
 assert.deepEqual(await projectCandidates(pool,f.owner,'general','artifact',''),[])
 const db=await pool.connect()
 try{await db.query('begin');const rows=await readProjectItems(db,f.owner,'general',[ref]);assert.equal(rows.length,1);assert.equal(rows[0]!.id,ref.id);assert.equal(rows[0]!.available,false);await db.query('commit')}finally{await db.query('rollback');db.release()}
 assert.deepEqual(await f.service.list(f.owner,{artifactId:f.first.artifactId}),[f.first])
})

test('撤回后旧反馈请求不能转成新的Agent输入，新续改请求也不得创建；旧请求回执可读',async()=>{
 const f=await fixture();await initializeArtifactFeedback(pool)
 const feedback=new ArtifactFeedbackService(pool,{id:randomUUID,now:()=>new Date().toISOString()}),requests=new ArtifactRevisionRequestService(pool,()=>new Date().toISOString())
 const one=await feedback.add(f.owner,{requestId:randomUUID(),artifactId:f.first.artifactId,version:1,source:f.source,sectionId:'body',text:'原反馈'}),two=await feedback.add(f.owner,{requestId:randomUUID(),artifactId:f.first.artifactId,version:1,source:f.source,sectionId:'body',text:'另一原反馈'})
 const input={requestId:randomUUID(),artifactId:f.first.artifactId,baseVersion:1,feedbackId:one.id,sessionId:f.source.id},saved=await requests.request(f.owner,input)
 await f.service.withdraw(f.owner,{requestId:randomUUID(),artifactId:f.first.artifactId,expectedVersion:1,source:f.source})
 await assert.rejects(requests.goalForSource(f.owner,{sessionId:f.source.id,sourceText:'[teloa-revision:'+saved.id+']'}),{code:'teloa/source-unavailable'})
 await assert.rejects(requests.request(f.owner,{...input,requestId:randomUUID(),feedbackId:two.id}),{code:'teloa/source-unavailable'})
 assert.deepEqual(await requests.request(f.owner,input),saved)
})

test('最终输入准入记住受管来源，后续压缩丢掉marker仍不能在撤回后继续发送',async()=>{
 const f=await fixture(),inputs=new ArtifactAvailabilityService(pool,()=>new Date().toISOString()) as ArtifactAvailabilityService&{admitInput:(owner:string,input:{sessionId?:string;references:{artifactId:string;version:number}[]})=>Promise<{release:()=>Promise<void>}>},sessionId=randomUUID()
 const admission=await inputs.admitInput(f.owner,{sessionId,references:[{artifactId:f.first.artifactId,version:1}]})
 await admission.release()
 await f.service.withdraw(f.owner,{requestId:randomUUID(),artifactId:f.first.artifactId,expectedVersion:1,source:f.source})
 await assert.rejects(inputs.admitInput(f.owner,{sessionId,references:[]}),{code:'teloa/source-unavailable'})
 await assert.rejects(inputs.admitInput(f.owner,{sessionId:f.source.id,references:[]}),{code:'teloa/source-unavailable'})
})
test('已准入发送持有同一头锁，撤回必须在释放后提交；无引用输入不产生绑定',async()=>{
 const f=await fixture(),inputs=new ArtifactAvailabilityService(pool,()=>new Date().toISOString()) as ArtifactAvailabilityService&{admitInput:(owner:string,input:{sessionId?:string;references:{artifactId:string;version:number}[]})=>Promise<{release:()=>Promise<void>}>}
 const admission=await inputs.admitInput(f.owner,{sessionId:randomUUID(),references:[{artifactId:f.first.artifactId,version:1}]})
 const withdrawing=f.service.withdraw(f.owner,{requestId:randomUUID(),artifactId:f.first.artifactId,expectedVersion:1,source:f.source})
 try{
  let blocked=false
  for(let attempt=0;attempt<100&&!blocked;attempt++){
   blocked=Boolean((await pool.query("select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query='select current_version from teloa_artifacts where owner_id=$1 and id=$2 for update'")).rowCount)
   if(!blocked)await new Promise(resolve=>setTimeout(resolve,10))
  }
  assert.equal(blocked,true,'实际withdraw在同一artifact头锁等待，不能仅凭Promise尚未settled判断')
  assert.equal((await f.service.availability(f.owner,{artifactId:f.first.artifactId})).state,'available')
 }finally{await admission.release()}
 await withdrawing
 assert.equal((await f.service.availability(f.owner,{artifactId:f.first.artifactId})).state,'withdrawn')
 const untouched=await fixture(),single=new Pool({connectionString:container.getConnectionUri(),max:1,connectionTimeoutMillis:250})
 try{
  const empty=await new ArtifactAvailabilityService(single,()=>new Date().toISOString()).admitInput(untouched.owner,{sessionId:randomUUID(),references:[]})
  try{assert.equal((await single.query('select 1 as available')).rows[0].available,1,'无成果头锁的准入不占住唯一连接等待模型首块')}finally{await empty.release()}
 }finally{await single.end()}
 assert.equal((await pool.query('select count(*)::int as count from teloa_artifact_input_sources where owner_id=$1',[untouched.owner])).rows[0].count,0)
})

test('撤回成果不可新采纳结项，既有任务和原稿不能被伪改为完成',async()=>{
 await initializeRoles(pool);await initializeTasks(pool);await initializeTaskTransitions(pool);await initializeTaskCompletions(pool)
 const owner=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()},tasks=new TaskService(pool,identity),transitions=new TaskTransitions(pool,identity)
 const task=await tasks.create(owner,{requestId:randomUUID(),fields:{title:'合成验收',goal:'合成验收',scope:'general'}}),running=await transitions.change(owner,{requestId:randomUUID(),taskId:task.id,expectedVersion:1,action:'start'})
 const source={kind:'task' as const,id:task.id,scope:'general',version:running.version+' · '+running.updatedAt,title:task.title},artifacts=new ArtifactService(pool,identity,async()=>({source,sessionIds:[]}))
 const result=await artifacts.create(owner,{requestId:randomUUID(),source,content:{title:'合成待验收',sections:[{id:'body',title:'正文',text:'原件保留'}],snapshotIds:[],note:'原件'}})
 await artifacts.withdraw(owner,{requestId:randomUUID(),artifactId:result.artifactId,expectedVersion:1,source})
 await assert.rejects(transitions.change(owner,{requestId:randomUUID(),taskId:task.id,expectedVersion:2,action:'complete',artifact:{id:result.artifactId,version:1},note:'不能采纳撤回成果'}),{code:'teloa/source-unavailable'})
 assert.equal((await tasks.list(owner,{})).find(row=>row.id===task.id)!.state,'running');assert.deepEqual(await artifacts.list(owner,{artifactId:result.artifactId}),[result])
})

test('审计原快照不能变成撤回后的新成果，撤回前已成立的独立副本仍可修订复用',async()=>{
 const f=await fixture(),bytes=Buffer.from('合成原文件'),sha256=createHash('sha256').update(bytes).digest('hex'),store=new ArtifactSnapshotStore(pool)
 const snapshot=await store.save(f.owner,{schema:'teloa.file-snapshot/v1',sessionId:f.source.id,id:'d'.repeat(64),path:'synthetic.txt',sha256,bytes:bytes.length,capturedAt:new Date().toISOString(),contentBase64:bytes.toString('base64')})
 const content={...f.content,snapshotIds:[snapshot]},original=await f.service.revise(f.owner,{artifactId:f.first.artifactId,expectedVersion:1,source:f.source,content})
 await f.service.withdraw(f.owner,{requestId:randomUUID(),artifactId:original.artifactId,expectedVersion:2,source:f.source})
 await assert.rejects(f.service.create(f.owner,{requestId:randomUUID(),source:f.source,content}),{code:'teloa/source-unavailable'})
 assert.equal((await store.read(f.owner,snapshot)).contentBase64,bytes.toString('base64'))
 const g=await fixture(),otherSnapshot=await store.save(g.owner,{schema:'teloa.file-snapshot/v1',sessionId:g.source.id,id:'e'.repeat(64),path:'copy.txt',sha256,bytes:bytes.length,capturedAt:new Date().toISOString(),contentBase64:bytes.toString('base64')}),copyContent={...g.content,snapshotIds:[otherSnapshot]}
 await g.service.revise(g.owner,{artifactId:g.first.artifactId,expectedVersion:1,source:g.source,content:copyContent})
 const copy=await g.service.create(g.owner,{requestId:randomUUID(),source:g.source,content:copyContent})
 await g.service.withdraw(g.owner,{requestId:randomUUID(),artifactId:g.first.artifactId,expectedVersion:2,source:g.source})
 assert.equal((await g.service.revise(g.owner,{artifactId:copy.artifactId,expectedVersion:1,source:g.source,content:{...copyContent,note:'独立副本继续'}})).number,2)
 assert.equal((await g.service.availability(g.owner,{artifactId:copy.artifactId})).state,'available')
})

test('原来源会话不能在对象撤回后另造新成果身份来绕过，已经成立的副本不连带撤回',async()=>{
 const f=await fixture(),copy=await f.service.create(f.owner,{...f.input,requestId:randomUUID()})
 await f.service.withdraw(f.owner,{requestId:randomUUID(),artifactId:f.first.artifactId,expectedVersion:1,source:f.source})
 await assert.rejects(f.service.create(f.owner,{...f.input,requestId:randomUUID(),content:{...f.content,note:'另造新身份'}}),{code:'teloa/source-unavailable'})
 assert.deepEqual(await f.service.create(f.owner,f.input),f.first)
 assert.equal((await f.service.revise(f.owner,{artifactId:copy.artifactId,expectedVersion:1,source:f.source,content:{...f.content,note:'既有独立副本修订'}})).number,2)
})

test('P2-TASK-BOUNDARY 旧Task成果只约束原历史，新版本独立Run可用且显式引用仍拒绝',async()=>{
 await initializeRoles(pool);await initializeTasks(pool);await initializeTaskRuns(pool);await initializeRoleMemory(pool)
 const owner=randomUUID();let at='2026-10-29T01:00:00.000Z'
 const clock={id:randomUUID,now:()=>at},roles=new RoleService(pool,clock),tasks=new TaskService(pool,clock)
 const role=await roles.create(owner,{requestId:randomUUID(),fields:{name:'来源边界合成员工',kind:'employee',scopes:['general'],duty:'核对合成来源',dataScope:'本人合成材料',executionScope:'代拟',skills:[],knowledge:[],responsibility:testRoleResponsibility}})
 let task=await tasks.create(owner,{requestId:randomUUID(),fields:{title:'原任务',goal:'原合成目标',scope:'general'},assignee:{roleId:role.id,expectedVersion:role.version}})
 // 这里构造已落盘历史元数据，不发送或伪造一次模型完成；准入只消费这些固定列。
 const historicalRun=async(version:number,createdAt:string)=>{
  const id=randomUUID(),sessionId='boundary-'+id,input={task:{id:task.id,version,title:task.title,goal:task.goal,scope:'general'}}
  await pool.query(`insert into teloa_task_runs(id,owner_id,request_id,request_spec,task_id,role_id,task_version,role_version,link_version,session_id,native_request_id,state,input_text,created_at)
   values($1,$2,$3,'{}',$4,$5,$6,$7,1,$8,$9,'ended',$10,$11)`,[id,owner,randomUUID(),task.id,role.id,version,role.version,sessionId,randomUUID(),JSON.stringify(input),createdAt])
  return {id,sessionId}
 }
 const old=await historicalRun(task.version,'2026-10-29T01:01:00.000Z')
 at='2026-10-29T01:02:00.000Z';task=await tasks.edit(owner,{taskId:task.id,expectedVersion:task.version,fields:{title:'保存时任务状态已推进'}})
 const source=await taskArtifactSource(pool,owner,task.id,false)
 assert.ok(source.version.startsWith('2 · '),'成果保存版本真实晚于旧Run的起始版本1，不能用版本相等回溯')
 at='2026-10-29T01:03:00.000Z'
 const artifacts=new ArtifactService(pool,clock,async(actor,expected,db)=>({source:await taskArtifactSource(db,actor,expected.id,true),sessionIds:[old.sessionId]}))
 const saved=await artifacts.create(owner,{requestId:randomUUID(),source,content:{title:'原Task版本成果',sections:[{id:'body',title:'正文',text:'仅旧历史'}],snapshotIds:[],note:'固定来源'}})
 at='2026-10-29T01:04:00.000Z';task=await tasks.edit(owner,{taskId:task.id,expectedVersion:task.version,fields:{goal:'后来真正独立的新目标，不使用旧成果'}})
 const fresh=await historicalRun(task.version,'2026-10-29T01:05:00.000Z'),bound=await historicalRun(task.version,'2026-10-29T01:05:30.000Z')
 const memories=new RoleMemoryService(pool,clock),human={ownerId:owner,kind:'human' as const}
 for(const [kind,id,version,title]of [['task',task.id,task.version,'独立任务经验'],['run',old.id,1,'独立运行经验']] as const){const candidate=await memories.create(human,{requestId:randomUUID(),roleId:role.id,expectedRoleVersion:role.version,title,markdown:title,source:{kind,id,version},visibility:{kind:'role',scopeIds:['general']}});await memories.confirm(human,{requestId:randomUUID(),memoryId:candidate.id,expectedStateVersion:1})}
 const inputs=new ArtifactAvailabilityService(pool,clock.now),boundAdmission=await inputs.admitInput(owner,{sessionId:bound.sessionId,references:[{artifactId:saved.artifactId,version:1}]});await boundAdmission.release()
 const before=(await pool.query('select * from teloa_task_runs where owner_id=$1 order by id',[owner])).rows
 at='2026-10-29T01:06:00.000Z';await artifacts.withdraw(owner,{requestId:randomUUID(),artifactId:saved.artifactId,expectedVersion:1,source})
 await assert.rejects(inputs.admitInput(owner,{sessionId:old.sessionId,references:[]}),{code:'teloa/source-unavailable'})
 await assert.rejects(inputs.admitInput(owner,{sessionId:bound.sessionId,references:[]}),{code:'teloa/source-unavailable'})
 const independent=await inputs.admitInput(owner,{sessionId:fresh.sessionId,references:[]});await independent.release()
 await assert.rejects(inputs.admitInput(owner,{sessionId:fresh.sessionId,references:[{artifactId:saved.artifactId,version:1}]}),{code:'teloa/source-unavailable'})
 assert.equal((await memories.confirmedForExperience(pool,owner,'general',role)).length,2,'独立Task/Run记忆不是artifact指针，不连带撤回')
 assert.deepEqual((await pool.query('select * from teloa_task_runs where owner_id=$1 order by id',[owner])).rows,before)
})

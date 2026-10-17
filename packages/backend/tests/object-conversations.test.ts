import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {initializeRoles,RoleService} from '../src/work/roles.ts'
import {initializeTasks,TaskService} from '../src/work/tasks.ts'
import {ObjectConversationService,initializeObjectConversations} from '../src/work/object-conversations.ts'
import {taskArtifactSessions,taskArtifactSource} from '../src/work/artifact-task-source.ts'
import {ArtifactService,initializeArtifacts} from '../src/work/artifacts.ts'
import {initializeArtifactSnapshots} from '../src/work/artifact-snapshots.ts'
import {ArtifactMessageStore} from '../src/work/artifact-messages.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'
import {initializeTeloaDatabase} from '../src/work/initialize-database.ts'
import {createNativeSessionCapabilities} from '../../harness-dsh/src/native-session-capabilities.ts'
import {workAccess} from '../src/work/work-access.ts'
let container:StartedPostgreSqlContainer,pool:Pool
before(async()=>{process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock');process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock';container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()});await initializeRoles(pool);await initializeTasks(pool);await initializeObjectConversations(pool)})
after(async()=>{await pool?.end();await container?.stop()})
async function sourceFixture(){
 const owner=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()},task=await new TaskService(pool,identity).create(owner,{requestId:randomUUID(),fields:{title:'原聊天草稿',goal:'先保存，不执行',scope:'general'}}),sessionId=randomUUID(),conversationId=randomUUID()
 const service=new ObjectConversationService(pool,async(actor,id)=>({id:conversationId,sessionId:id,ownerId:actor,status:'ready'}),identity.now)
 const command={requestId:randomUUID(),kind:'task',objectId:task.id,expectedObjectVersion:1,sessionId,expectedLinkVersion:0,action:'link',sourceOnly:true}
 return {owner,task,sessionId,conversationId,service,command}
}
test('默认助手仅允许任务创建来源，不能变成员工或任务执行上下文',async()=>{
 const f=await sourceFixture(),service=new ObjectConversationService(pool,async(actor,id)=>({id:f.conversationId,sessionId:id,ownerId:actor,status:'ready',purpose:'assistant'}),()=>new Date().toISOString())
 const {sourceOnly:_,...execution}=f.command
 await assert.rejects(service.change(f.owner,execution),{code:'teloa/forbidden'})
 assert.deepEqual(await service.list(f.owner,{kind:'task',objectId:f.task.id}),[])
 const source=await service.change(f.owner,f.command)
 assert.equal(source.sourceOnly,true);assert.equal(source.sessionId,f.sessionId)
 assert.deepEqual(await service.bySession(f.owner,{sessionId:f.sessionId}),[])
 await assert.rejects(service.taskContext(f.owner,{taskId:f.task.id,sessionId:f.sessionId,expectedTaskVersion:1}),{code:'teloa/forbidden'})
})
test('创建来源保留原聊天入口，不成为会话身份或任务执行上下文',async()=>{
 await initializeTeloaDatabase(pool)
 const f=await sourceFixture(),source=await f.service.change(f.owner,f.command)
 assert.equal(source.sourceOnly,true);assert.equal(source.active,true)
 assert.deepEqual(await f.service.bySession(f.owner,{sessionId:f.sessionId}),[])
 const capabilities=createNativeSessionCapabilities({agents:{get:()=>undefined}} as never,{owner:f.owner,conversations:{repository:{read:async()=>[{sessionId:f.sessionId,ownerId:f.owner,status:'ready'}]}},links:f.service,pool,isRoutingSession:()=>false} as never)
 assert.deepEqual(await capabilities(f.sessionId,'prompt'),{ownerId:f.owner,capabilities:['general-agent']})
 assert.deepEqual(await capabilities(f.sessionId,'restore'),{ownerId:f.owner,capabilities:['general-agent']})
 assert.deepEqual(await f.service.list(f.owner,{kind:'task',objectId:f.task.id}),[source])
 await assert.rejects(f.service.taskContext(f.owner,{taskId:f.task.id,sessionId:f.sessionId,expectedTaskVersion:1}),{code:'teloa/forbidden'})
 assert.deepEqual(await f.service.change(f.owner,f.command),source)
 const {sourceOnly:_,...unlink}=f.command,removed=await f.service.change(f.owner,{...unlink,requestId:randomUUID(),expectedLinkVersion:1,action:'unlink'})
 assert.equal(removed.sourceOnly,true);assert.equal(removed.active,false)
})
test('创建来源等待期间取消或本人指令改变，来源与回执整体回滚',async()=>{
 for(const mode of ['cancel','instruction']){
  const f=await sourceFixture(),controller=new AbortController();let checks=0
  await assert.rejects(f.service.change(f.owner,f.command,controller.signal,async()=>{if(++checks===2){if(mode==='cancel')controller.abort();else throw Error('本人指令已变化')}}))
  assert.deepEqual(await f.service.list(f.owner,{kind:'task',objectId:f.task.id}),[])
  assert.equal((await pool.query('select 1 from teloa_object_conversation_requests where owner_id=$1 and request_id=$2',[f.owner,f.command.requestId])).rowCount,0)
 }
})
test('来源与执行关系身份固定，解除后也不能互相转换',async()=>{
 for(const sourceOnly of [false,true]){
  const f=await sourceFixture(),{sourceOnly:_,...command}=f.command,first={...command,...(sourceOnly?{sourceOnly:true}:{})}
  const linked=await f.service.change(f.owner,first)
  if(!sourceOnly){assert.equal('sourceOnly' in linked,false);assert.equal((await f.service.bySession(f.owner,{sessionId:f.sessionId})).length,1)}
  await assert.rejects(f.service.change(f.owner,{...command,requestId:randomUUID(),expectedLinkVersion:1,...(!sourceOnly?{sourceOnly:true}:{})}),{code:'teloa/conflict'})
  await f.service.change(f.owner,{...command,requestId:randomUUID(),expectedLinkVersion:1,action:'unlink'})
  await assert.rejects(f.service.change(f.owner,{...command,requestId:randomUUID(),expectedLinkVersion:2,...(!sourceOnly?{sourceOnly:true}:{})}),{code:'teloa/conflict'})
 }
})
test('创建来源仍核验本人和业务，字段只允许任务关联的明确true',async()=>{
 const f=await sourceFixture()
 await assert.rejects(f.service.change('other',f.command),{code:'teloa/forbidden'})
 await assert.rejects(f.service.change(f.owner,{...f.command,scopeId:'SOC'}),{code:'teloa/forbidden'})
 for(const patch of [{sourceOnly:false},{sourceOnly:'true'},{kind:'role'},{action:'unlink'}])await assert.rejects(f.service.change(f.owner,{...f.command,...patch}),{code:'teloa/invalid-input'})
 assert.deepEqual(await f.service.list(f.owner,{kind:'task',objectId:f.task.id}),[])
})
test('任务仅引用有效关联会话，解除后拒绝新增版本但历史快照可读',async()=>{
 await initializeArtifactSnapshots(pool);await initializeArtifacts(pool)
 const owner=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()},task=await new TaskService(pool,identity).create(owner,{requestId:randomUUID(),fields:{title:'调查',goal:'核验',scope:'general'}}),sessionId=randomUUID(),conversationId=randomUUID()
 const links=new ObjectConversationService(pool,async()=>({id:conversationId,sessionId,ownerId:owner,status:'ready'}),identity.now)
 const command={requestId:randomUUID(),kind:'task',objectId:task.id,expectedObjectVersion:1,sessionId,expectedLinkVersion:0,action:'link'}
 await links.change(owner,command)
 const holding=await pool.connect(),competing=await pool.connect()
 try{await holding.query('begin');assert.deepEqual(await taskArtifactSessions(holding,owner,task.id,true),[sessionId]);await assert.rejects(competing.query("select * from teloa_object_conversations where owner_id=$1 and object_id=$2 for update nowait",[owner,task.id]),{code:'55P03'});await holding.query('commit');await competing.query("select * from teloa_object_conversations where owner_id=$1 and object_id=$2 for update nowait",[owner,task.id])}finally{await holding.query('rollback');holding.release();competing.release()}
 const messages=new ArtifactMessageStore(pool),snapshot=await messages.save(owner,{sessionId,messageId:'m1',seq:1,role:'assistant',at:identity.now(),text:'调查结论',interrupted:false,omittedBlocks:0,images:[]})
 const service=new ArtifactService(pool,identity,async(actor,expected,client)=>({source:await taskArtifactSource(client,actor,expected.id,true),sessionIds:await taskArtifactSessions(client,actor,expected.id,true)})),source=await taskArtifactSource(pool,owner,task.id,false),content={title:'报告',sections:[{id:'p1',title:'结论',text:'引用原消息'}],snapshotIds:[],messageSnapshotIds:[snapshot],note:'保存'}
 const artifact=await service.create(owner,{requestId:randomUUID(),source,content});assert.equal(artifact.content.messageSnapshotIds![0],snapshot)
 await links.change(owner,{...command,requestId:randomUUID(),expectedLinkVersion:1,action:'unlink'})
 await assert.rejects(service.revise(owner,{artifactId:artifact.artifactId,expectedVersion:1,source,content:{...content,note:'修订'}}),{code:'teloa/forbidden'})
 assert.equal((await service.list(owner,{artifactId:artifact.artifactId}))[0]!.content.messageSnapshotIds![0],snapshot)
})
test('退役岗位不能新增关联，暂停岗位写回执失败仍整体回滚',async()=>{
 const owner=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()},role=await new RoleService(pool,identity).create(owner,{requestId:randomUUID(),fields:{name:'调查岗',kind:'employee',scopes:['general'],duty:'核验',dataScope:'只读',executionScope:'代拟',skills:[],knowledge:[],responsibility:testRoleResponsibility}}),sessionId=randomUUID(),conversationId=randomUUID()
 const service=new ObjectConversationService(pool,async()=>({id:conversationId,sessionId,ownerId:owner,status:'ready'}),identity.now),command={requestId:randomUUID(),kind:'role',objectId:role.id,expectedObjectVersion:1,sessionId,expectedLinkVersion:0,action:'link'}
 await pool.query("update teloa_roles set state='retired' where id=$1",[role.id])
 await assert.rejects(service.change(owner,command),{code:'teloa/conflict'})
 await pool.query("update teloa_roles set state='paused',version=2 where id=$1",[role.id])
 await pool.query(`create function reject_object_receipt() returns trigger language plpgsql as $$ begin if new.owner_id='${owner}' then raise exception 'receipt failed'; end if;return new;end $$;create trigger reject_object_receipt before insert on teloa_object_conversation_requests for each row execute function reject_object_receipt()`)
 try{await assert.rejects(service.change(owner,{...command,expectedObjectVersion:2}),/receipt failed/);assert.deepEqual(await service.list(owner,{kind:'role',objectId:role.id}),[])}finally{await pool.query('drop trigger reject_object_receipt on teloa_object_conversation_requests;drop function reject_object_receipt()')}
 const linked=await service.change(owner,{...command,expectedObjectVersion:2});assert.equal(linked.active,true)
 assert.equal((await new RoleService(pool,identity).list(owner,{}))[0]!.state,'paused')
})
test('关系并发防重，解除后旧关联请求不复活，重新构造服务可读',async()=>{
 const owner=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()},task=await new TaskService(pool,identity).create(owner,{requestId:randomUUID(),fields:{title:'调查',goal:'核验',scope:'general'}}),sessionId=randomUUID(),conversationId=randomUUID()
 const inspect=async(actor:string,id:string)=>{assert.equal(actor,owner);assert.equal(id,sessionId);return {id:conversationId,sessionId,ownerId:owner,status:'ready' as const}}
 const service=new ObjectConversationService(pool,inspect,identity.now),command={requestId:randomUUID(),kind:'task',objectId:task.id,expectedObjectVersion:1,sessionId,expectedLinkVersion:0,action:'link'}
 const [a,b]=await Promise.all([service.change(owner,command),service.change(owner,command)]);assert.deepEqual(a,b);assert.equal(a.active,true)
 const context=await service.taskContext(owner,{taskId:task.id,sessionId,expectedTaskVersion:1});assert.equal(context.task.goal,'核验');assert.equal(context.link.version,1);assert.equal(context.role,null)
 await assert.rejects(service.taskContext(owner,{taskId:task.id,sessionId,expectedTaskVersion:2}),{code:'teloa/version-conflict'})
 const removed=await service.change(owner,{...command,requestId:randomUUID(),expectedLinkVersion:1,action:'unlink'});assert.equal(removed.version,2);assert.equal(removed.active,false)
 assert.deepEqual(await service.change(owner,command),removed)
 await assert.rejects(service.taskContext(owner,{taskId:task.id,sessionId,expectedTaskVersion:1}),{code:'teloa/forbidden'})
 assert.equal((await new ObjectConversationService(pool,inspect,identity.now).list(owner,{kind:'task',objectId:task.id}))[0]!.active,false)
 await assert.rejects(service.change(owner,{...command,requestId:randomUUID()}),{code:'teloa/version-conflict'})
 await assert.rejects(service.change(owner,{...command,action:'unlink'}),{code:'teloa/conflict'})
})
test('对象归属、版本和会话身份均核验，失败不留下关联',async()=>{
 const owner=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()},task=await new TaskService(pool,identity).create(owner,{requestId:randomUUID(),fields:{title:'调查',goal:'核验',scope:'general'}}),sessionId=randomUUID()
 const service=new ObjectConversationService(pool,async()=>({id:randomUUID(),sessionId,ownerId:'other',status:'ready'}),identity.now),command={requestId:randomUUID(),kind:'task',objectId:task.id,expectedObjectVersion:1,sessionId,expectedLinkVersion:0,action:'link'}
 await assert.rejects(service.change(owner,command),{code:'teloa/forbidden'});assert.deepEqual(await service.list(owner,{kind:'task',objectId:task.id}),[])
 await assert.rejects(service.list('other',{kind:'task',objectId:task.id}),{code:'teloa/forbidden'})
 await assert.rejects(service.change(owner,{...command,expectedObjectVersion:9}),{code:'teloa/version-conflict'})
})
test('多业务岗位会话保存所选业务范围，重建服务后可按当前会话恢复',async()=>{
 const owner=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()}
 const role=await new RoleService(pool,identity).create(owner,{requestId:randomUUID(),fields:{name:'跨域研判岗',kind:'employee',scopes:['SOC','AppSec'],duty:'核验',dataScope:'只读',executionScope:'代拟',skills:[],knowledge:[],responsibility:testRoleResponsibility}})
 const sessionId=randomUUID(),conversationId=randomUUID(),inspect=async(actor:string,id:string)=>({id:conversationId,sessionId:id,ownerId:actor,status:'ready'})
 const service=new ObjectConversationService(pool,inspect,identity.now)
 const linked=await service.change(owner,{requestId:randomUUID(),kind:'role',objectId:role.id,expectedObjectVersion:role.version,sessionId,expectedLinkVersion:0,action:'link',scopeId:'AppSec'})
 assert.equal(linked.scopeId,'AppSec')
 await initializeObjectConversations(pool)
 const restored=await new ObjectConversationService(pool,inspect,identity.now).bySession(owner,{sessionId})
 assert.equal(restored.length,1);assert.equal(restored[0]?.objectId,role.id);assert.equal(restored[0]?.scopeId,'AppSec')
 await assert.rejects(service.change(owner,{requestId:randomUUID(),kind:'role',objectId:role.id,expectedObjectVersion:role.version,sessionId:randomUUID(),expectedLinkVersion:0,action:'link',scopeId:'GRC'}),{code:'teloa/forbidden'})
 const removed=await service.change(owner,{requestId:randomUUID(),kind:'role',objectId:role.id,expectedObjectVersion:role.version,sessionId,expectedLinkVersion:1,action:'unlink'})
 assert.equal(removed.scopeId,'AppSec');assert.deepEqual(await service.bySession(owner,{sessionId}),[])
})
test('关联核对等待后取消或本人复核失败，原会话不留下晚到关联',async()=>{
 const owner=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()},task=await new TaskService(pool,identity).create(owner,{requestId:randomUUID(),fields:{title:'原工作',goal:'核验',scope:'general'}}),sessionId=randomUUID(),conversationId=randomUUID()
 let entered!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>entered=resolve),waiting=new Promise<void>(resolve=>release=resolve),controller=new AbortController()
 const links=new ObjectConversationService(pool,async()=>{entered();await waiting;return {id:conversationId,sessionId,ownerId:owner,status:'ready'}},identity.now),command={requestId:randomUUID(),kind:'task',objectId:task.id,expectedObjectVersion:1,sessionId,expectedLinkVersion:0,action:'link'}
 const pending=links.change(owner,command,controller.signal);await started;controller.abort();release();await assert.rejects(pending);assert.deepEqual(await links.list(owner,{kind:'task',objectId:task.id}),[])
 const available=new ObjectConversationService(pool,async()=>({id:conversationId,sessionId,ownerId:owner,status:'ready'}),identity.now)
 let checks=0;await assert.rejects(available.change(owner,{...command,requestId:randomUUID()},undefined,async()=>{if(++checks===2)throw Error('本人指令已变化')}),/本人指令已变化/);assert.deepEqual(await available.list(owner,{kind:'task',objectId:task.id}),[])
})
test('基础权限可保存创建来源，执行上下文仍需people且不能由来源转换',async()=>{
 const f=await sourceFixture()
 workAccess.installPolicy(async request=>{if(request.kind==='capability'&&request.ownerId===f.owner&&request.capability!=='general-agent')throw Error('仅基础权限');return {assertCurrent(){}}})
 assert.equal((await f.service.change(f.owner,f.command)).sourceOnly,true)
 const {sourceOnly:_,...context}=f.command
 await assert.rejects(f.service.change(f.owner,{...context,requestId:randomUUID(),sessionId:randomUUID()}),{code:'teloa/forbidden'})
 await assert.rejects(f.service.change(f.owner,{...context,requestId:randomUUID(),expectedLinkVersion:1}),{code:'teloa/conflict'})
 await assert.rejects(f.service.taskContext(f.owner,{taskId:f.task.id,sessionId:f.sessionId,expectedTaskVersion:1}),{code:'teloa/forbidden'})
})
test('迟到创建来源可关联已结束任务的本人历史，结束任务仍不能创建执行上下文',async()=>{
 for(const state of ['completed','cancelled']){
  const f=await sourceFixture();await pool.query('update teloa_tasks set state=$2,version=2 where id=$1',[f.task.id,state])
  assert.equal((await f.service.change(f.owner,{...f.command,expectedObjectVersion:2})).sourceOnly,true)
  assert.deepEqual(await f.service.bySession(f.owner,{sessionId:f.sessionId}),[])
  const {sourceOnly:_,...context}=f.command
  await assert.rejects(f.service.change(f.owner,{...context,requestId:randomUUID(),sessionId:randomUUID(),expectedObjectVersion:2}),{code:'teloa/conflict'})
 }
})

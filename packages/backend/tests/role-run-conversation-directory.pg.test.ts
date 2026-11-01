import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {Pool} from './postgres-test-lifecycle.ts'
import {initializeTeloaDatabase} from '../src/work/initialize-database.ts'
import {RoleService} from '../src/work/roles.ts'
import {TaskService} from '../src/work/tasks.ts'
import {ObjectConversationService} from '../src/work/object-conversations.ts'
import {TaskRunService} from '../src/work/task-runs.ts'
import {ConversationService,type StoredConversation} from '../src/work/conversations.ts'
import {RoleRunConversationDirectory} from '../src/work/role-run-conversation-directory.ts'
import {createTaskRunHandler} from '../../harness-dsh/src/task-runs.ts'
import {WorkError} from '@teloa/contract'
import {businessObjectSnapshotHash} from '../src/work/business-data.ts'
import type {RunBusinessContext} from '../src/work/task-run-business-context.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'
let container:StartedPostgreSqlContainer,pool:Pool
before(async()=>{process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock');process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock';container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()});await initializeTeloaDatabase(pool)})
after(async()=>{await pool?.end();await container?.stop()})
async function fixture(){
 const owner=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()},roles=new RoleService(pool,identity),role=await roles.create(owner,{requestId:randomUUID(),fields:{name:'原自动研判员',kind:'employee',scopes:['SOC'],duty:'只读研判',dataScope:'只读',executionScope:'代拟',skills:[],knowledge:[],responsibility:testRoleResponsibility,runtimeConfig:{agentPresetId:'standard'}}});
 const contexts=new Map<string,RunBusinessContext>();let stored:StoredConversation[]=[],hostCreates=0;const repository={read:async()=>structuredClone(stored),write:async(rows:StoredConversation[])=>{stored=structuredClone(rows)}};
 const conversations=new ConversationService(repository,{create:async id=>{hostCreates++;return id},inspect:async()=>{}},identity),runs=new TaskRunService(pool,identity,(actor,id)=>conversations.snapshotBySession(actor,id),{allowedTools:[],businessContext:async(_db,_owner,task)=>contexts.get(task.id)});
 const manualLinks=new ObjectConversationService(pool,(actor,id)=>conversations.snapshotBySession(actor,id),identity.now),tasks=new TaskService(pool,identity);
 const originals:{task:Awaited<ReturnType<TaskService['create']>>;run:Awaited<ReturnType<TaskRunService['prepare']>>;sessionId:string}[]=[],historical:typeof originals=[];
 for(const key of ['A','B','C']){
  let task=await tasks.create(owner,{requestId:randomUUID(),fields:{title:'同名持续研判',goal:'核验'+key,scope:'SOC'},assignee:{roleId:role.id,expectedVersion:role.version}});const sessionId='task-run-'+randomUUID(),requestId=randomUUID();
  const snapshot={scope:'SOC',type:'alert',id:'alert-'+key,version:1,title:'合成告警-'+key,source:'隔离测试来源',observedAt:identity.now(),receivedAt:identity.now(),quality:'complete' as const,summary:'独立告警'+key,fields:[]};contexts.set(task.id,{taskId:task.id,sourceId:'test-alerts',object:{...snapshot,snapshotHash:businessObjectSnapshotHash(snapshot)}});
  if(key==='A'){
   const oldSession='task-run-'+randomUUID(),oldRequest=randomUUID();await conversations.createRun(owner,{requestId:oldRequest,title:task.title},{sessionId:oldSession,taskId:task.id,taskVersion:task.version,roleId:role.id,roleVersion:role.version,agentPresetId:'standard'});await manualLinks.change(owner,{requestId:randomUUID(),kind:'task',objectId:task.id,expectedObjectVersion:task.version,sessionId:oldSession,expectedLinkVersion:0,action:'link'});const old=await runs.prepare(owner,{requestId:oldRequest,taskId:task.id,expectedTaskVersion:task.version,roleId:role.id,expectedRoleVersion:role.version,sessionId:oldSession,expectedLinkVersion:1});await runs.claim(owner,{runId:old.id});await runs.record(owner,{runId:old.id,sessionId:oldSession,nativeRequestId:old.nativeRequestId,evidence:{state:'ended',turn:0,messageSeq:1,endSeq:2,reason:'error'}});historical.push({task,run:old,sessionId:oldSession});const latest=(await tasks.list(owner,{})).find(row=>row.id===task.id);assert.ok(latest);task=latest;
  }
  await conversations.createRun(owner,{requestId,title:task.title},{sessionId,taskId:task.id,taskVersion:task.version,roleId:role.id,roleVersion:role.version,agentPresetId:'standard'});
  await manualLinks.change(owner,{requestId:randomUUID(),kind:'task',objectId:task.id,expectedObjectVersion:task.version,sessionId,expectedLinkVersion:0,action:'link'});
  if(key==='A')await runs.failPreparation(owner,{requestId:randomUUID(),taskId:task.id,expectedTaskVersion:task.version,roleId:role.id,expectedRoleVersion:role.version,sessionId},Error('原配置失败'),'standard');
  const run=await runs.prepare(owner,{requestId,taskId:task.id,expectedTaskVersion:task.version,roleId:role.id,expectedRoleVersion:role.version,sessionId,expectedLinkVersion:1});await runs.claim(owner,{runId:run.id});await runs.record(owner,{runId:run.id,sessionId,nativeRequestId:run.nativeRequestId,evidence:{state:'ended',turn:0,messageSeq:1,endSeq:2,reason:'completed'}});originals.push({task,run,sessionId});
 }
 const handler=createTaskRunHandler(owner,async()=>runs,{check:async()=>{throw Error('目录不能装配')},send:async()=>{throw Error('目录不能发送')},stop:async()=>{throw Error('目录不能停止')},events:async()=>[]},undefined,{conversations,links:manualLinks});
 const readSession=async(actor:string,id:string)=>{assert.equal(actor,owner);return handler('task-runs/session',{sessionId:id},AbortSignal.timeout(10000))};
 const directory=new RoleRunConversationDirectory(pool,readSession),project=(actor:string,filter:{roleId?:string;sessionId?:string})=>directory.list(actor,filter),links=new ObjectConversationService(pool,(actor,id)=>conversations.snapshotBySession(actor,id),identity.now,project);
 const global=new ConversationService(repository,{create:async()=>{throw Error('不能新建')},inspect:async()=>{throw Error('不能激活')}},identity,undefined,async actor=>(await directory.list(actor)).map(row=>row.conversation));
 const snapshot=async()=>({stored:await repository.read(),runs:(await pool.query('select * from teloa_task_runs where owner_id=$1 order by id',[owner])).rows,links:(await pool.query('select * from teloa_object_conversations where owner_id=$1 order by kind,object_id,session_id',[owner])).rows,receipts:(await pool.query('select * from teloa_object_conversation_requests where owner_id=$1 order by request_id',[owner])).rows});
 return {owner,identity,role,roles,tasks,originals,historical,conversations,runs,readSession,directory,links,global,snapshot,hostCreates:()=>hostCreates};
}
test('原三告警真实Run/原预约只读并入员工和全局目录，同Session失败与成功记录去重且手工聊天保留',async()=>{
 const f=await fixture(),manual=await f.conversations.create(f.owner,{requestId:randomUUID(),title:'原手工员工会话'});await f.links.change(f.owner,{requestId:randomUUID(),kind:'role',objectId:f.role.id,expectedObjectVersion:f.role.version,sessionId:manual.sessionId,expectedLinkVersion:0,action:'link'});
 const before=await f.snapshot(),created=f.hostCreates(),rows=await f.links.list(f.owner,{kind:'role',objectId:f.role.id});assert.equal(rows.length,4);assert.equal(rows.filter(row=>row.readOnly).length,3);assert.deepEqual(rows.filter(row=>row.readOnly).map(row=>row.displayTitle).sort(),['合成告警-A','合成告警-B','合成告警-C']);assert.equal(rows.find(row=>row.sessionId===manual.sessionId)?.readOnly,undefined);
 assert.deepEqual((await f.global.list(f.owner,{})).map(row=>row.sessionId),[manual.sessionId]);const global=await f.global.list(f.owner,{},true);assert.equal(global.length,4);assert.deepEqual(new Set(global.filter(row=>row.purpose==='task-run').map(row=>row.title)),new Set(['同名持续研判']),'仅显示投影可区分告警，原预约标题不改写');for(const original of f.originals){assert.equal(global.find(row=>row.sessionId===original.sessionId)?.purpose,'task-run');const bySession=await f.links.bySession(f.owner,{sessionId:original.sessionId});assert.equal(bySession.filter(row=>row.kind==='role').length,1);assert.equal(bySession.find(row=>row.kind==='role')?.readOnly,true);const view=await f.readSession(f.owner,original.sessionId);assert.equal(view.run.id,original.run.id);assert.equal(view.anchor.id,original.run.id);assert.equal(view.conversation.run?.taskVersion,original.task.version)}
 for(const old of f.historical){assert.ok(!global.some(row=>row.sessionId===old.sessionId),'全局只展示同Task最新有效会话');assert.equal((await f.readSession(f.owner,old.sessionId)).run.id,old.run.id);assert.equal((await f.links.bySession(f.owner,{sessionId:old.sessionId})).find(row=>row.kind==='role')?.objectId,f.role.id)}assert.deepEqual(await f.snapshot(),before);assert.equal(f.hostCreates(),created);
})
test('停岗、退役和收窄执行scope不剥夺本人历史，但不产生新身份或放开旧Run执行',async()=>{
 const f=await fixture();await pool.query("update teloa_roles set state='paused',version=version+1,definition=jsonb_set(definition,'{scopes}','[\"AppSec\"]'::jsonb) where owner_id=$1 and id=$2",[f.owner,f.role.id]);
 for(const state of ['paused','retired']){await pool.query('update teloa_roles set state=$3 where owner_id=$1 and id=$2',[f.owner,f.role.id,state]);const rows=await f.links.list(f.owner,{kind:'role',objectId:f.role.id});assert.equal(rows.length,3);for(const row of rows){assert.equal(row.readOnly,true);assert.equal(row.objectVersion,f.role.version);assert.equal(row.scopeId,'SOC')}for(const original of f.originals){assert.equal((await f.readSession(f.owner,original.sessionId)).run.roleVersion,f.role.version);await assert.rejects(f.runs.skillScope(f.owner,{sessionId:original.sessionId}));}}
})
test('换负责人仍保留旧参与员工的真实历史绑定，跨owner不可读取且自动项不能解除或冒充手工关联',async()=>{
 const f=await fixture(),next=await f.roles.create(f.owner,{requestId:randomUUID(),fields:{name:'新负责员工',kind:'employee',scopes:['SOC'],duty:'核验',dataScope:'只读',executionScope:'代拟',skills:[],knowledge:[],responsibility:testRoleResponsibility}}),original=f.originals[0]!;
 await pool.query('update teloa_tasks set assignee_role_id=$3,assignee_role_version=$4,version=version+1 where owner_id=$1 and id=$2',[f.owner,original.task.id,next.id,next.version]);
 assert.equal((await f.links.list(f.owner,{kind:'role',objectId:f.role.id})).length,3);assert.deepEqual(await f.links.list(f.owner,{kind:'role',objectId:next.id}),[]);assert.equal((await f.readSession(f.owner,original.sessionId)).run.roleId,f.role.id);
 await assert.rejects(f.links.list('other',{kind:'role',objectId:f.role.id}),{code:'teloa/forbidden'});assert.deepEqual(await f.directory.list('other'),[]);const before=await f.snapshot();await assert.rejects(f.links.change(f.owner,{requestId:randomUUID(),kind:'role',objectId:f.role.id,expectedObjectVersion:f.role.version,sessionId:original.sessionId,expectedLinkVersion:0,action:'link'}),{code:'teloa/forbidden'});assert.deepEqual(await f.snapshot(),before);
})
test('目录只接受规范owner/Task/Run绑定，历史核验损坏不得回退最近raw Run',async()=>{
 const f=await fixture();const mismatch=new RoleRunConversationDirectory(pool,async(actor,id)=>{const view=await f.readSession(actor,id);return {...view,conversation:{...view.conversation,ownerId:'other'}}});assert.deepEqual(await mismatch.list(f.owner),[]);
 const broken=new RoleRunConversationDirectory(pool,async()=>{throw new WorkError('teloa/storage-corrupt','历史链损坏')});await assert.rejects(broken.list(f.owner),{code:'teloa/storage-corrupt'});
});

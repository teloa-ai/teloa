import test,{after,before} from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {initializeRoles,RoleService} from '../src/work/roles.ts'
import {initializeTasks,TaskService} from '../src/work/tasks.ts'
import {initializeObjectConversations,ObjectConversationService} from '../src/work/object-conversations.ts'
import {initializeTaskRuns,TaskRunService} from '../src/work/task-runs.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'

let container:StartedPostgreSqlContainer,pool:Pool
const identity={id:randomUUID,now:()=>new Date('2026-09-12T19:00:00.000Z').toISOString()},hash=(value:string)=>createHash('sha256').update(value).digest('hex')
const stable=(value:unknown):string=>JSON.stringify(value,(_,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a<b?-1:a>b?1:0)):item)

before(async()=>{process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock');process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock';container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()});await initializeRoles(pool);await initializeTasks(pool);await initializeObjectConversations(pool);await initializeTaskRuns(pool)},{timeout:180_000})
after(async()=>{await pool?.end();await container?.stop()})

async function fixture(){
 const owner=randomUUID(),role=await new RoleService(pool,identity).create(owner,{requestId:randomUUID(),fields:{name:'研究岗',kind:'employee',scopes:['general'],duty:'研究',dataScope:'资料',executionScope:'代拟',skills:[],knowledge:[],responsibility:testRoleResponsibility}});await pool.query("update teloa_roles set state='active',version=2 where id=$1",[role.id])
 const task=await new TaskService(pool,identity).create(owner,{requestId:randomUUID(),fields:{title:'研究任务',goal:'核对资料',scope:'general'},assignee:{roleId:role.id,expectedVersion:2}}),sessionId=randomUUID(),conversationId=randomUUID();let inspectCalls=0
 const inspect=async()=>{inspectCalls++;return {id:conversationId,sessionId,ownerId:owner,status:'ready'}}
 await new ObjectConversationService(pool,inspect,identity.now).change(owner,{requestId:randomUUID(),kind:'task',objectId:task.id,expectedObjectVersion:1,sessionId,expectedLinkVersion:0,action:'link'})
 const installationId=randomUUID(),content='固定正文',native={name:'review',description:'复核',modelInvocable:true,userInvocable:true,bodyHash:hash(content)},files=[{path:'SKILL.md',hash:hash('---\nname: review\n---\n'+content),size:31},{path:'references/source.md',hash:hash('来源'),size:6}],bundleHash=hash(JSON.stringify(files.map(file=>[file.path,file.hash]))),source={kind:'atomic',contentId:randomUUID(),contentHash:hash('content-'+installationId),resourceId:'review',resourceVersion:'1.0.0'},sourceKey=hash(stable(['atomic',source.contentId,source.contentHash,source.resourceId,source.resourceVersion])),recordHash=hash(stable([installationId,owner,source,bundleHash,native]))
 await pool.query('insert into teloa_skill_installations(id,owner_id,source,source_key,bundle_hash,record_hash,native,native_name,state,version,created_at,updated_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,$10)',[installationId,owner,JSON.stringify(source),sourceKey,bundleHash,recordHash,JSON.stringify(native),'review','installed',identity.now()]);await pool.query("insert into teloa_skill_install_availability values($1,$2,'enabled',1,$3)",[installationId,owner,identity.now()]);await pool.query("update teloa_roles set definition=jsonb_set(definition,'{skills}','[\"review\"]'::jsonb) where id=$1",[role.id])
 const skill={name:'review',provider:'teloa-market',source:'global',description:'复核',content,sha256:native.bodyHash,resourceBase:{kind:'directory' as const,path:'/skills/'+installationId},managed:{installationId,bundleHash,files}},service=new TaskRunService(pool,identity,inspect),command={requestId:randomUUID(),taskId:task.id,expectedTaskVersion:1,roleId:role.id,expectedRoleVersion:2,sessionId,expectedLinkVersion:1},run=await service.prepare(owner,command,async()=>[skill])
 inspectCalls=0
 return {owner,task,role,sessionId,conversationId,installationId,service,run,inspect,command,skill,get inspectCalls(){return inspectCalls}}
}

test('无任何执行返回 null 且不探测普通会话',async()=>{
 let calls=0;const service=new TaskRunService(pool,identity,async()=>{calls++;throw Error('不应探测')})
 assert.equal(await service.skillScope(randomUUID(),{sessionId:randomUUID()}),null);assert.equal(calls,0)
})

test('安装停用后仍按会话读取完整固定执行和受管引用',async()=>{
 const f=await fixture();await pool.query("update teloa_skill_install_availability set availability='disabled',version=2 where installation_id=$1",[f.installationId])
 assert.deepEqual(await f.service.skillScope(f.owner,{sessionId:f.sessionId}),f.run);assert.equal(f.inspectCalls,1);assert.equal(f.run.skills[0]!.managed?.installationId,f.installationId)
})

test('缺失固定引用与同会话多条非撤销执行均显式损坏',async()=>{
 const missing=await fixture();await pool.query('delete from teloa_task_run_skill_refs where run_id=$1',[missing.run.id]);await assert.rejects(missing.service.skillScope(missing.owner,{sessionId:missing.sessionId}),{code:'teloa/storage-corrupt'})
 const ambiguous=await fixture(),nextId=randomUUID(),nextRequest=randomUUID(),nextNative=randomUUID(),evidence={state:'ended',turn:0,messageSeq:1,endSeq:2,reason:'completed'}
 await pool.query("update teloa_task_runs set state='ended',evidence=$2 where id=$1",[ambiguous.run.id,JSON.stringify(evidence)])
 await pool.query(`insert into teloa_task_runs(id,owner_id,request_id,request_spec,task_id,role_id,task_version,role_version,link_version,session_id,native_request_id,state,input_text,created_at,industry_context_hash,plan_context_hash,tool_argument_rules,evidence,role_knowledge,role_skills,task_state_version,allowed_tools)
  select $2,owner_id,$3,jsonb_set(request_spec,'{requestId}',to_jsonb(($3::uuid)::text)),task_id,role_id,task_version,role_version,link_version,session_id,$4,'ended',input_text,created_at+interval '1 second',industry_context_hash,plan_context_hash,tool_argument_rules,$5,role_knowledge,role_skills,task_state_version,allowed_tools from teloa_task_runs where id=$1`,[ambiguous.run.id,nextId,nextRequest,nextNative,JSON.stringify(evidence)])
 await assert.rejects(ambiguous.service.skillScope(ambiguous.owner,{sessionId:ambiguous.sessionId}),{code:'teloa/storage-corrupt'})
})

test('跨本人会话不能伪装成无执行，原生会话身份也必须仍属本人且ready',async()=>{
 const f=await fixture();await assert.rejects(f.service.skillScope(randomUUID(),{sessionId:f.sessionId}),{code:'teloa/forbidden'})
 const wrongOwner=new TaskRunService(pool,identity,async()=>({id:f.conversationId,sessionId:f.sessionId,ownerId:randomUUID(),status:'ready'}));await assert.rejects(wrongOwner.skillScope(f.owner,{sessionId:f.sessionId}),{code:'teloa/forbidden'})
 const unready=new TaskRunService(pool,identity,async()=>({id:f.conversationId,sessionId:f.sessionId,ownerId:f.owner,status:'missing'}));await assert.rejects(unready.skillScope(f.owner,{sessionId:f.sessionId}),{code:'teloa/forbidden'})
})

test('只有撤销历史时返回最新撤销执行，不能降级成普通会话',async()=>{
 const f=await fixture();await f.service.withdraw(f.owner,{runId:f.run.id})
 const second=await f.service.prepare(f.owner,{...f.command,requestId:randomUUID()},async()=>[f.skill]),withdrawn=await f.service.withdraw(f.owner,{runId:second.id});await pool.query("update teloa_task_runs set created_at=created_at+interval '1 second' where id=$1",[second.id])
 const scope=await f.service.skillScope(f.owner,{sessionId:f.sessionId});assert.equal(scope?.id,withdrawn.id);assert.equal(scope?.state,'withdrawn')
})

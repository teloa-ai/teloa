import test,{after,before} from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from 'pg'
import type {PoolClient} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {WorkError} from '@teloa/contract'
import {initializeRoles,RoleService} from '../src/work/roles.ts'
import {initializePlans,PlanService} from '../src/work/plans.ts'
import {initializeTasks,TaskService} from '../src/work/tasks.ts'
import {initializeObjectConversations,ObjectConversationService} from '../src/work/object-conversations.ts'
import {initializeTaskRuns,TaskRunService} from '../src/work/task-runs.ts'
import {SkillInstallationService,type NativeSkillMetadata,type SkillInstallationFilesPort} from '../src/market/skill-installations.ts'
import type {SkillInstallSourceBundle,SkillInstallSourceInput} from '../src/market/skill-install-source.ts'
import {initializeSkillAvailabilities,SkillAvailabilityService} from '../src/market/skill-availability.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'

let container:StartedPostgreSqlContainer,pool:Pool
const at='2026-09-12T13:00:00.000Z',identity={id:randomUUID,now:()=>at},hash=(value:string)=>createHash('sha256').update(value).digest('hex')
class Reader{owner='';values=new Map<string,SkillInstallSourceBundle>();async read(owner:string,input:SkillInstallSourceInput){if(owner!==this.owner)throw new WorkError('teloa/forbidden','owner');const value=this.values.get(JSON.stringify(input));if(!value)throw new WorkError('teloa/source-unavailable','missing');return structuredClone(value)}}
class Files implements SkillInstallationFilesPort{lose=false;metadata:NativeSkillMetadata={name:'research-brief',description:'研究',modelInvocable:true,userInvocable:true,bodyHash:hash('正文')};async inspect(){return this.metadata}async publish(){if(this.lose){this.lose=false;throw new WorkError('teloa/storage-unavailable','lost')}}async verify(){}}
before(async()=>{process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock');process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock';container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()});await initializeRoles(pool);await initializePlans(pool);await initializeTasks(pool);await initializeObjectConversations(pool);await initializeTaskRuns(pool)},{timeout:180_000})
after(async()=>{await pool?.end();await container?.stop()})

async function fixture(){
 const owner=randomUUID(),reader=new Reader(),files=new Files();reader.owner=owner
 const atomic={kind:'atomic' as const,contentId:randomUUID()},source={kind:'atomic' as const,contentId:atomic.contentId,contentHash:hash('content-'+owner),resourceId:'research-brief',resourceVersion:'1.0.0'},skillFiles=[{path:'SKILL.md',hash:hash('原文件'),size:9}],bundleHash=hash(JSON.stringify(skillFiles.map(file=>[file.path,file.hash]))),sourceBundle:SkillInstallSourceBundle={ownerId:owner,source,entryPath:'SKILL.md',files:[{path:'SKILL.md',hash:skillFiles[0]!.hash,bytes:new TextEncoder().encode('原文件')}],bundleHash}
 reader.values.set(JSON.stringify(atomic),sourceBundle)
 const installs=new SkillInstallationService(pool,identity,reader,files),requestId=randomUUID(),installation=(await installs.install(owner,{requestId,source:atomic,expectedBundleHash:bundleHash})).installation
 const roles=new RoleService(pool,identity),role=await roles.create(owner,{requestId:randomUUID(),fields:{name:'研究岗',kind:'employee',scopes:['general'],duty:'研究',dataScope:'资料',executionScope:'代拟',skills:['research-brief'],knowledge:[],responsibility:testRoleResponsibility,runtimeConfig:{agentPresetId:'researcher'}}});await pool.query("update teloa_roles set state='active',version=2 where id=$1",[role.id])
 const active={...role,state:'active' as const,version:2},plan=await new PlanService(pool,identity).create(owner,{requestId:randomUUID(),fields:{title:'研究计划',goal:'整理资料',scope:'general',dataScope:'资料',delivery:'简报',roleId:role.id,expectedRoleVersion:2,trigger:{kind:'schedule',cadence:'daily',weekday:1,time:'09:00',timezone:'Asia/Singapore'},notificationPolicy:'attention'},source:{kind:'manual'}})
 const task=await new TaskService(pool,identity).create(owner,{requestId:randomUUID(),fields:{title:'研究任务',goal:'整理资料',scope:'general'},assignee:{roleId:role.id,expectedVersion:2}}),sessionId=randomUUID(),conversationId=randomUUID(),inspect=async()=>({id:conversationId,sessionId,ownerId:owner,status:'ready'})
 await new ObjectConversationService(pool,inspect,identity.now).change(owner,{requestId:randomUUID(),kind:'task',objectId:task.id,expectedObjectVersion:1,sessionId,expectedLinkVersion:0,action:'link'})
 const managed={name:'research-brief',provider:'teloa-market',source:'global',description:'研究',content:'正文',sha256:files.metadata.bodyHash,resourceBase:{kind:'directory' as const,path:'/managed/'+installation.id},managed:{installationId:installation.id,bundleHash,files:skillFiles}},runs=new TaskRunService(pool,identity,inspect),command={requestId:randomUUID(),taskId:task.id,expectedTaskVersion:1,roleId:role.id,expectedRoleVersion:2,sessionId,expectedLinkVersion:1},run=await runs.prepare(owner,command,async()=>[managed])
 const loadId=randomUUID(),itemInstanceId=randomUUID(),industry={kind:'industry' as const,loadId,itemInstanceId},aliasSource={kind:'industry-public' as const,loadId,itemInstanceId,contentId:randomUUID(),contentHash:hash('industry'),sourceContentId:source.contentId,sourceContentHash:source.contentHash,sourceResourceId:source.resourceId,sourceResourceVersion:source.resourceVersion,resourceId:'alias',resourceVersion:'1.0.0'};reader.values.set(JSON.stringify(industry),{...sourceBundle,source:aliasSource});await installs.install(owner,{requestId:randomUUID(),source:industry,expectedBundleHash:bundleHash})
 return {owner,reader,files,installs,installRequestId:requestId,atomic,installation,role:active,plan,task,run,runs,command,managed,usage:{loadId,itemInstanceId}}
}
async function extraRunTarget(f:Awaited<ReturnType<typeof fixture>>){const task=await new TaskService(pool,identity).create(f.owner,{requestId:randomUUID(),fields:{title:'并发任务',goal:'核对并发',scope:'general'},assignee:{roleId:f.role.id,expectedVersion:2}}),sessionId=randomUUID(),conversationId=randomUUID(),inspect=async()=>({id:conversationId,sessionId,ownerId:f.owner,status:'ready'});await new ObjectConversationService(pool,inspect,identity.now).change(f.owner,{requestId:randomUUID(),kind:'task',objectId:task.id,expectedObjectVersion:1,sessionId,expectedLinkVersion:0,action:'link'});return {task,inspect,command:{requestId:randomUUID(),taskId:task.id,expectedTaskVersion:1,roleId:f.role.id,expectedRoleVersion:2,sessionId,expectedLinkVersion:1}}}
async function waitForLock(queryPart:string){for(let count=0;count<100;count++){const found=(await pool.query("select exists(select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and position($1 in query)>0) waiting",[queryPart])).rows[0].waiting;if(found)return;await new Promise(resolve=>setTimeout(resolve,10))}const waiting=(await pool.query("select query from pg_stat_activity where datname=current_database() and wait_event_type='Lock' order by pid")).rows.map(row=>row.query);throw Error(`未观察到并发事务进入预期锁等待：${queryPart}；实际等待：${JSON.stringify(waiting)}`)}

test('可用状态预览固定完整影响，停用返回历史回执与当前状态',async()=>{
 const f=await fixture(),service=new SkillAvailabilityService(pool,identity),current=await service.get(f.owner,{installationId:f.installation.id}),preview=await service.preview(f.owner,{installationId:f.installation.id})
 assert.equal(current.availability,'enabled');assert.equal(current.version,1);assert.equal(preview.impact.installation.version,2);assert.equal(preview.impact.installation.bundleHash,f.installation.bundleHash)
 assert.deepEqual(preview.impact.industryUsages,[f.usage]);assert.deepEqual(preview.impact.roles.map(x=>x.roleId),[f.role.id]);assert.deepEqual(preview.impact.plans.map(x=>x.planId),[f.plan.id]);assert.deepEqual(preview.impact.tasks.map(x=>x.taskId),[f.task.id]);assert.deepEqual(preview.impact.runs.map(x=>x.runId),[f.run.id]);assert.deepEqual(preview.impact.ordinarySessions,{status:'unknown'})
 const input={requestId:randomUUID(),installationId:f.installation.id,expectedVersion:1,expectedBundleHash:f.installation.bundleHash,expectedImpactDigest:preview.impactDigest,action:'disable' as const},changed=await service.change(f.owner,input)
 assert.equal(changed.receipt.result.availability,'disabled');assert.equal(changed.receipt.result.version,2);assert.equal(changed.receipt.reason,'');assert.deepEqual(changed.current,changed.receipt.result)
 assert.deepEqual(await service.change(f.owner,input),changed)
})

test('停用拦截新安装、准备与领取，恢复同连接核源且旧回执不复活',async()=>{
 const f=await fixture(),service=new SkillAvailabilityService(pool,identity),disablePreview=await service.preview(f.owner,{installationId:f.installation.id}),disableInput={requestId:randomUUID(),installationId:f.installation.id,expectedVersion:disablePreview.availability.version,expectedBundleHash:f.installation.bundleHash,expectedImpactDigest:disablePreview.impactDigest,action:'disable' as const}
 const disabled=await service.change(f.owner,disableInput)
 assert.equal((await f.installs.install(f.owner,{requestId:f.installRequestId,source:f.atomic,expectedBundleHash:f.installation.bundleHash})).installation.id,f.installation.id)
 const beforeRequests=(await pool.query('select count(*)::int n from teloa_skill_install_requests where owner_id=$1',[f.owner])).rows[0].n
 await assert.rejects(f.installs.install(f.owner,{requestId:randomUUID(),source:f.atomic,expectedBundleHash:f.installation.bundleHash}),{code:'teloa/conflict'})
 assert.equal((await pool.query('select count(*)::int n from teloa_skill_install_requests where owner_id=$1',[f.owner])).rows[0].n,beforeRequests)
 assert.equal((await f.runs.get(f.owner,{runId:f.run.id})).id,f.run.id)
 await assert.rejects(f.runs.claim(f.owner,{runId:f.run.id}),{code:'teloa/conflict'})
 assert.equal((await f.runs.get(f.owner,{runId:f.run.id})).state,'prepared')

 const task=await new TaskService(pool,identity).create(f.owner,{requestId:randomUUID(),fields:{title:'后续任务',goal:'核对停用',scope:'general'},assignee:{roleId:f.role.id,expectedVersion:2}}),sessionId=randomUUID(),conversationId=randomUUID(),inspect=async()=>({id:conversationId,sessionId,ownerId:f.owner,status:'ready'})
 await new ObjectConversationService(pool,inspect,identity.now).change(f.owner,{requestId:randomUUID(),kind:'task',objectId:task.id,expectedObjectVersion:1,sessionId,expectedLinkVersion:0,action:'link'})
 const command={requestId:randomUUID(),taskId:task.id,expectedTaskVersion:1,roleId:f.role.id,expectedRoleVersion:2,sessionId,expectedLinkVersion:1},ordinary={name:'research-brief',provider:'native',source:'global',description:'研究',content:'正文',sha256:f.files.metadata.bodyHash}
 await assert.rejects(new TaskRunService(pool,identity,inspect).prepare(f.owner,command,async()=>[ordinary]),{code:'teloa/conflict'})
 assert.equal((await pool.query('select count(*)::int n from teloa_task_runs where task_id=$1',[task.id])).rows[0].n,0)

 const limited=new Pool({connectionString:container.getConnectionUri(),max:1}),verified:string[]=[]
 try{
  const restoring=new SkillAvailabilityService(limited,identity,{verify:async(db:PoolClient,ownerId,installation)=>{verified.push(installation.id);assert.equal(ownerId,f.owner);assert.equal((await db.query('select availability from teloa_skill_install_availability where installation_id=$1',[installation.id])).rows[0].availability,'disabled')}}),enablePreview=await restoring.preview(f.owner,{installationId:f.installation.id}),enableInput={requestId:randomUUID(),installationId:f.installation.id,expectedVersion:enablePreview.availability.version,expectedBundleHash:f.installation.bundleHash,expectedImpactDigest:enablePreview.impactDigest,action:'enable' as const,reason:'  已核对来源  '},enabled=await restoring.change(f.owner,enableInput)
  assert.deepEqual(verified,[f.installation.id]);assert.equal(enabled.current.availability,'enabled');assert.equal(enabled.receipt.reason,'已核对来源')
  const replay=await restoring.change(f.owner,disableInput);assert.equal(replay.receipt.result.availability,'disabled');assert.equal(replay.receipt.result.version,2);assert.equal(replay.current.availability,'enabled');assert.equal(replay.current.version,3)
  const same=await restoring.preview(f.owner,{installationId:f.installation.id});await assert.rejects(restoring.change(f.owner,{requestId:randomUUID(),installationId:f.installation.id,expectedVersion:same.availability.version,expectedBundleHash:f.installation.bundleHash,expectedImpactDigest:same.impactDigest,action:'enable'}),{code:'teloa/conflict'})
  await assert.rejects(restoring.change(f.owner,{...enableInput,action:'disable'}),{code:'teloa/conflict'})
  const directory=await restoring.directory(f.owner);assert.equal(directory.find(item=>item.installation.id===f.installation.id)?.availability.availability,'enabled')
 }finally{await limited.end()}
 assert.equal(disabled.receipt.result.version,2)
})

test('恢复核验失败整体回滚，跨本人和损坏可用状态不降级',async()=>{
 const f=await fixture(),service=new SkillAvailabilityService(pool,identity),preview=await service.preview(f.owner,{installationId:f.installation.id})
 await service.change(f.owner,{requestId:randomUUID(),installationId:f.installation.id,expectedVersion:1,expectedBundleHash:f.installation.bundleHash,expectedImpactDigest:preview.impactDigest,action:'disable'})
 const enablePreview=await service.preview(f.owner,{installationId:f.installation.id}),requestId=randomUUID(),failing=new SkillAvailabilityService(pool,identity,{verify:async()=>{throw new WorkError('teloa/source-unavailable','missing')}})
 await assert.rejects(failing.change(f.owner,{requestId,installationId:f.installation.id,expectedVersion:2,expectedBundleHash:f.installation.bundleHash,expectedImpactDigest:enablePreview.impactDigest,action:'enable'}),{code:'teloa/source-unavailable'})
 assert.equal((await service.get(f.owner,{installationId:f.installation.id})).version,2);assert.equal((await pool.query('select count(*)::int n from teloa_skill_install_maintenance_requests where request_id=$1',[requestId])).rows[0].n,0)
 await assert.rejects(service.get(randomUUID(),{installationId:f.installation.id}),{code:'teloa/forbidden'})
 await pool.query('delete from teloa_skill_install_availability where installation_id=$1',[f.installation.id]);await assert.rejects(service.get(f.owner,{installationId:f.installation.id}),{code:'teloa/storage-corrupt'})
})

test('准备先持有安装共享锁时停用等待提交，并因新增影响拒绝旧预览',async()=>{
 const f=await fixture(),target=await extraRunTarget(f),service=new SkillAvailabilityService(pool,identity),preview=await service.preview(f.owner,{installationId:f.installation.id}),gate=await pool.connect(),key=734921
 await pool.query(`create function block_skill_run_insert() returns trigger language plpgsql as $$ begin perform pg_advisory_xact_lock(${key});return new;end $$;create trigger block_skill_run_insert before insert on teloa_task_runs for each row execute function block_skill_run_insert()`)
 await gate.query('begin');await gate.query('select pg_advisory_xact_lock($1)',[key])
 try{
  const preparing=new TaskRunService(pool,identity,target.inspect).prepare(f.owner,target.command,async()=>[f.managed]);await waitForLock('insert into teloa_task_runs')
  const disabling=service.change(f.owner,{requestId:randomUUID(),installationId:f.installation.id,expectedVersion:1,expectedBundleHash:f.installation.bundleHash,expectedImpactDigest:preview.impactDigest,action:'disable'})
  await waitForLock('select * from teloa_skill_installations where id=$1 for update')
  await gate.query('commit');const run=await preparing;await assert.rejects(disabling,{code:'teloa/version-conflict'})
  const refreshed=await service.preview(f.owner,{installationId:f.installation.id});assert.ok(refreshed.impact.runs.some(item=>item.runId===run.id));assert.equal(refreshed.availability.availability,'enabled')
 }finally{await gate.query('rollback').catch(()=>{});gate.release();await pool.query('drop trigger if exists block_skill_run_insert on teloa_task_runs;drop function if exists block_skill_run_insert()')}
})

test('停用先取得排他锁时领取等待停用完成并保持prepared',async()=>{
 const f=await fixture(),service=new SkillAvailabilityService(pool,identity),preview=await service.preview(f.owner,{installationId:f.installation.id}),gate=await pool.connect(),key=734922
 await pool.query(`create function block_skill_availability_update() returns trigger language plpgsql as $$ begin perform pg_advisory_xact_lock(${key});return new;end $$;create trigger block_skill_availability_update before update on teloa_skill_install_availability for each row execute function block_skill_availability_update()`)
 await gate.query('begin');await gate.query('select pg_advisory_xact_lock($1)',[key])
 try{
  const disabling=service.change(f.owner,{requestId:randomUUID(),installationId:f.installation.id,expectedVersion:1,expectedBundleHash:f.installation.bundleHash,expectedImpactDigest:preview.impactDigest,action:'disable'});await waitForLock('update teloa_skill_install_availability')
  const claiming=f.runs.claim(f.owner,{runId:f.run.id});await waitForLock('select * from teloa_skill_installations where id=$1 and owner_id=$2 for share');await gate.query('commit');await disabling;await assert.rejects(claiming,{code:'teloa/conflict'});assert.equal((await f.runs.get(f.owner,{runId:f.run.id})).state,'prepared')
 }finally{await gate.query('rollback').catch(()=>{});gate.release();await pool.query('drop trigger if exists block_skill_availability_update on teloa_skill_install_availability;drop function if exists block_skill_availability_update()')}
})

test('维护影响快照持有表共享锁直到提交，岗位配置写不能穿过摘要计算',async()=>{
 const f=await fixture(),service=new SkillAvailabilityService(pool,identity),preview=await service.preview(f.owner,{installationId:f.installation.id}),gate=await pool.connect(),key=734923
 await pool.query(`create function block_skill_impact_commit() returns trigger language plpgsql as $$ begin perform pg_advisory_xact_lock(${key});return new;end $$;create trigger block_skill_impact_commit before update on teloa_skill_install_availability for each row execute function block_skill_impact_commit()`)
 await gate.query('begin');await gate.query('select pg_advisory_xact_lock($1)',[key])
 try{
  const changing=service.change(f.owner,{requestId:randomUUID(),installationId:f.installation.id,expectedVersion:1,expectedBundleHash:f.installation.bundleHash,expectedImpactDigest:preview.impactDigest,action:'disable'});await waitForLock('update teloa_skill_install_availability')
  const roleWrite=pool.query("update teloa_roles set definition=jsonb_set(definition,'{duty}','\"新的职责\"'::jsonb),version=version+1 where id=$1 returning version",[f.role.id]);await waitForLock('update teloa_roles set definition=')
  await gate.query('commit');await changing;assert.equal((await roleWrite).rows[0].version,3)
 }finally{await gate.query('rollback').catch(()=>{});gate.release();await pool.query('drop trigger if exists block_skill_impact_commit on teloa_skill_install_availability;drop function if exists block_skill_impact_commit()')}
})

test('旧安装仅在首次迁移回填启用，后续缺失状态重启仍按损坏拒绝',async()=>{
 const f=await fixture()
 await pool.query("delete from teloa_skill_install_availability_migrations where name='initial-backfill-v1'");await pool.query('delete from teloa_skill_install_availability where installation_id=$1',[f.installation.id]);await initializeSkillAvailabilities(pool)
 const service=new SkillAvailabilityService(pool,identity),backfilled=await service.get(f.owner,{installationId:f.installation.id});assert.equal(backfilled.availability,'enabled');assert.equal(backfilled.version,1)
 const preview=await service.preview(f.owner,{installationId:f.installation.id});await service.change(f.owner,{requestId:randomUUID(),installationId:f.installation.id,expectedVersion:1,expectedBundleHash:f.installation.bundleHash,expectedImpactDigest:preview.impactDigest,action:'disable'})
 await pool.query('delete from teloa_skill_install_availability where installation_id=$1',[f.installation.id]);await initializeSkillAvailabilities(pool);await assert.rejects(service.get(f.owner,{installationId:f.installation.id}),{code:'teloa/storage-corrupt'})
})

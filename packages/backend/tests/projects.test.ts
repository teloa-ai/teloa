import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {initializeTeloaDatabase} from '../src/work/initialize-database.ts'
import {readProjectItems,readProjectRelations} from '../src/work/project-items.ts'
import {ProjectService,initializeProjects} from '../src/work/projects.ts'
import {TaskService} from '../src/work/tasks.ts'
import {RoleService} from '../src/work/roles.ts'
import {PlanService} from '../src/work/plans.ts'
import {PlanOccurrenceService} from '../src/work/plan-occurrences.ts'
import {CollaborationService} from '../src/work/collaboration.ts'
import {ArtifactService} from '../src/work/artifacts.ts'
import {BusinessScopeService} from '../src/work/business-scopes.ts'
import {BusinessSpaceService} from '../src/work/business-spaces.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'
import type {ProjectDefinition} from '@teloa/contract'

let container:StartedPostgreSqlContainer,pool:Pool
const identity={id:randomUUID,now:()=>new Date().toISOString()}
const fields=(patch:Partial<ProjectDefinition>={}):ProjectDefinition=>({scope:'general',title:'Product launch',goal:'Ship a useful product',dueDate:null,state:'planning',links:[],references:[],...patch})
before(async()=>{container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()});await initializeTeloaDatabase(pool);await initializeProjects(pool)},{timeout:120000})
after(async()=>{await pool?.end();await container?.stop()})
async function fixture(){const owner=randomUUID(),service=new ProjectService(pool,identity),task=await new TaskService(pool,identity).create(owner,{requestId:randomUUID(),fields:{title:'First delivery',goal:'Produce a report',scope:'general'}});return {owner,service,task}}

test('并发创建幂等，服务重建后读取，跨本人不可读',async()=>{
 const {owner,service}=await fixture(),input={requestId:randomUUID(),fields:fields()}
 const [a,b]=await Promise.all([service.create(owner,input),service.create(owner,input)])
 assert.deepEqual(a,b);assert.equal(a.state,'planning')
 assert.deepEqual(await new ProjectService(pool,identity).list(owner,{scope:'general'}),[a])
 assert.equal((await service.get(owner,{projectId:a.id})).project.id,a.id)
 assert.deepEqual(await service.list(randomUUID(),{scope:'general'}),[])
 await assert.rejects(service.get(randomUUID(),{projectId:a.id}),{code:'teloa/not-found'})
 await assert.rejects(service.create(owner,{...input,fields:fields({title:'Different'})}),{code:'teloa/conflict'})
 await assert.rejects(service.create(owner,{requestId:randomUUID(),fields:fields({scope:'unregistered'})}),{code:'teloa/invalid-input'})
 await service.edit(owner,{projectId:a.id,expectedVersion:1,fields:fields({title:'Updated after creation'})})
 assert.deepEqual(await service.create(owner,input),a,'创建重试返回原回执，不被后续编辑改变')
})
test('显式关联校验归属和业务，未关联任务不进入项目',async()=>{
 const f=await fixture(),other=await fixture(),project=await f.service.create(f.owner,{requestId:randomUUID(),fields:fields()})
 assert.equal((await f.service.get(f.owner,{projectId:project.id})).items.length,0)
 for(const task of [other.task,await new TaskService(pool,identity).create(f.owner,{requestId:randomUUID(),fields:{title:'SOC',goal:'SOC',scope:'SOC'}})])await assert.rejects(f.service.edit(f.owner,{projectId:project.id,expectedVersion:1,fields:fields({links:[{kind:'task',id:task.id}]})}),{code:'teloa/forbidden'})
 const value=await f.service.edit(f.owner,{projectId:project.id,expectedVersion:1,fields:fields({links:[{kind:'task',id:f.task.id}]})})
 assert.equal(value.version,2)
 const detail=await f.service.get(f.owner,{projectId:project.id});assert.equal(detail.items[0]?.title,f.task.title)
 assert.equal((await f.service.candidates(f.owner,{scope:'general',kind:'task',query:'First'})).length,1)
 assert.equal((await f.service.candidates(f.owner,{scope:'SOC',kind:'task',query:'First'})).length,0)
 assert.equal((await new TaskService(pool,identity).list(f.owner,{})).find(t=>t.id===f.task.id)?.version,1)
})
test('编辑重放与并发不会覆盖，业务归属创建后不可改',async()=>{
 const f=await fixture(),project=await f.service.create(f.owner,{requestId:randomUUID(),fields:fields()}),input={projectId:project.id,expectedVersion:1,fields:fields({title:'Renamed'})}
 const [a,b]=await Promise.all([f.service.edit(f.owner,input),f.service.edit(f.owner,input)]);assert.deepEqual(a,b)
 await assert.rejects(f.service.edit(f.owner,{...input,fields:fields({title:'Lost update'})}),{code:'teloa/version-conflict'})
 await assert.rejects(f.service.edit(f.owner,{...input,expectedVersion:2,fields:fields({scope:'SOC'})}),{code:'teloa/invalid-input'})
 const outcomes=await Promise.allSettled(['A','B'].map(title=>f.service.edit(f.owner,{projectId:project.id,expectedVersion:2,fields:fields({title})})))
 assert.equal(outcomes.filter(v=>v.status==='fulfilled').length,1)
 assert.deepEqual(await f.service.edit(f.owner,input),a)
})
test('归档仅改变项目，禁止编辑关系，恢复后仍保留原任务',async()=>{
 const f=await fixture(),original=fields({links:[{kind:'task',id:f.task.id}]}),project=await f.service.create(f.owner,{requestId:randomUUID(),fields:original})
 const archived=await f.service.edit(f.owner,{projectId:project.id,expectedVersion:1,fields:{...original,state:'archived'}})
 await assert.rejects(f.service.edit(f.owner,{projectId:project.id,expectedVersion:2,fields:fields({state:'archived'})}),{code:'teloa/conflict'})
 await assert.rejects(f.service.edit(f.owner,{projectId:project.id,expectedVersion:2,fields:fields({state:'running'})}),{code:'teloa/conflict'})
 const restored=await f.service.edit(f.owner,{projectId:project.id,expectedVersion:2,fields:{...original,state:'running'}})
 assert.equal(restored.version,3);assert.equal(archived.links.length,1)
 assert.equal((await new TaskService(pool,identity).list(f.owner,{}))[0]?.state,'ready')
})
test('通用项目允许各岗位，退役后保留不可用项且可移除',async()=>{
 const f=await fixture(),role=await new RoleService(pool,identity).create(f.owner,{requestId:randomUUID(),fields:{name:'Analyst',kind:'employee',scopes:['SOC'],duty:'Analyze',dataScope:'Declared data',executionScope:'Draft',skills:[],knowledge:[],responsibility:testRoleResponsibility}})
 const project=await f.service.create(f.owner,{requestId:randomUUID(),fields:fields({links:[{kind:'role',id:role.id}]})})
 await pool.query("update teloa_roles set state='retired' where id=$1",[role.id])
 assert.deepEqual((await f.service.get(f.owner,{projectId:project.id})).items[0],{kind:'role',id:role.id,title:null,version:null,state:null,available:false,origin:'direct',attention:null})
 assert.equal((await f.service.candidates(f.owner,{scope:'general',kind:'role',query:''})).length,0)
 await assert.rejects(f.service.create(f.owner,{requestId:randomUUID(),fields:fields({links:[{kind:'role',id:role.id}]})}),{code:'teloa/forbidden'})
 const renamed=await f.service.edit(f.owner,{projectId:project.id,expectedVersion:1,fields:fields({title:'History',links:project.links})});assert.equal(renamed.links.length,1)
 assert.equal((await f.service.edit(f.owner,{projectId:project.id,expectedVersion:2,fields:fields()})).links.length,0)
})

async function relatedFixture(){
 const f=await fixture(),role=await new RoleService(pool,identity).create(f.owner,{requestId:randomUUID(),fields:{name:'Morgan',kind:'employee',scopes:['general'],duty:'Prepare launch',dataScope:'Project input',executionScope:'Draft',skills:[],knowledge:[],responsibility:testRoleResponsibility,runtimeConfig:{agentPresetId:'reviewer'}}})
 const group=await new CollaborationService(pool,identity).create(f.owner,{requestId:randomUUID(),expectedVersion:0,fields:{name:'Launch group',scope:'general',announcement:'Coordinate delivery',rules:{historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true},memberRoleIds:[]}})
 const plans=new PlanService(pool,identity),created=await plans.create(f.owner,{requestId:randomUUID(),source:{kind:'manual'},fields:{title:'Weekly check',goal:'Review delivery',scope:'general',dataScope:'Project data',delivery:'Progress report',roleId:role.id,expectedRoleVersion:1,trigger:{kind:'schedule',cadence:'daily',weekday:1,time:'09:00',timezone:'Asia/Singapore'},notificationPolicy:'attention'}})
 const plan=await plans.change(f.owner,{planId:created.id,requestId:randomUUID(),expectedVersion:1,action:'enable'})
 const resourceId=randomUUID();await pool.query("insert into teloa_resources(id,owner_id,revision,status,spec,created_at,updated_at) values($1,$2,1,'active',$3,now(),now())",[resourceId,f.owner,JSON.stringify({title:'Launch brief',sourceId:'brief',sourceVersion:'a'.repeat(64),scopeIds:['general']})])
 const source={kind:'task' as const,id:f.task.id,scope:'general',version:'1',title:f.task.title},artifacts=new ArtifactService(pool,identity,async(_owner,expected)=>({source:expected,sessionIds:[]})),content={title:'Launch report',sections:[{id:'body',title:'Report',text:'Delivery ready'}],snapshotIds:[],note:'Saved for review'}
 const artifact=await artifacts.create(f.owner,{requestId:randomUUID(),source,content})
 return {...f,role,group,plan,plans,resourceId,artifact,artifacts,content}
}
test('六类关联可读；撤回资料与归档群、自动化不得新关联',async()=>{
 const f=await relatedFixture(),links:ProjectDefinition['links']=[{kind:'task',id:f.task.id},{kind:'role',id:f.role.id},{kind:'group',id:f.group.id},{kind:'plan',id:f.plan.id},{kind:'resource',id:f.resourceId},{kind:'artifact',id:f.artifact.artifactId}]
 const project=await f.service.create(f.owner,{requestId:randomUUID(),fields:fields({links})}),detail=await f.service.get(f.owner,{projectId:project.id})
 assert.equal(detail.items.length,6);assert.ok(detail.items.every(item=>item.available))
 await pool.query("update teloa_resources set status='withdrawn' where id=$1",[f.resourceId]);await pool.query('update teloa_groups set archived=true where id=$1',[f.group.id]);await f.plans.change(f.owner,{planId:f.plan.id,requestId:randomUUID(),expectedVersion:f.plan.version,action:'archive',note:'Project test'})
 assert.equal((await f.service.get(f.owner,{projectId:project.id})).items.filter(item=>!item.available).length,3)
 for(const kind of ['resource','group','plan'] as const)assert.equal((await f.service.candidates(f.owner,{scope:'general',kind,query:''})).length,0)
})
test('自动化派生任务和任务成果真实汇入、去重，待验收不计完成，解除后重算',async()=>{
 const f=await relatedFixture(),project=await f.service.create(f.owner,{requestId:randomUUID(),fields:fields({links:[{kind:'task',id:f.task.id},{kind:'plan',id:f.plan.id}]})}),occurrences=new PlanOccurrenceService(pool,{id:randomUUID}),now=new Date().toISOString()
 const {occurrence}=await occurrences.trigger(f.owner,{planId:f.plan.id,requestId:randomUUID(),expectedVersion:f.plan.version,expectedConfigVersion:f.plan.configVersion,now})
 const {task:generated}=await occurrences.dispatchTask(f.owner,{claimId:occurrence.id,taskRequestId:occurrence.taskRequestId,now})
 await pool.query("update teloa_tasks set state='waiting' where id=$1",[generated.id]);await pool.query("update teloa_tasks set state='completed' where id=$1",[f.task.id])
 const detail=await f.service.get(f.owner,{projectId:project.id})
 assert.deepEqual(detail.summary,{totalTasks:2,completedTasks:1,cancelledTasks:0,attentionTasks:1})
 assert.equal(detail.items.find(item=>item.id===generated.id)?.origin,'automation')
 assert.equal(detail.items.find(item=>item.id===f.artifact.artifactId)?.origin,'task-output')
 const duplicate=await f.service.edit(f.owner,{projectId:project.id,expectedVersion:1,fields:fields({links:[...project.links,{kind:'task',id:generated.id},{kind:'artifact',id:f.artifact.artifactId}]})})
 const deduped=await f.service.get(f.owner,{projectId:project.id});assert.equal(deduped.items.filter(item=>item.id===generated.id).length,1);assert.equal(deduped.items.filter(item=>item.id===f.artifact.artifactId).length,1)
 await pool.query("update teloa_tasks set state='cancelled' where id=$1",[generated.id]);assert.deepEqual((await f.service.get(f.owner,{projectId:project.id})).summary,{totalTasks:2,completedTasks:1,cancelledTasks:1,attentionTasks:0})
 await f.service.edit(f.owner,{projectId:project.id,expectedVersion:duplicate.version,fields:fields({links:[{kind:'task',id:f.task.id}]})})
 assert.equal((await f.service.get(f.owner,{projectId:project.id})).summary.totalTasks,1)
})


test('项目新增岗位与任务关联遵守退役的岗位到任务锁序',async()=>{
 const {owner,task}=await fixture(),role=await new RoleService(pool,identity).create(owner,{requestId:randomUUID(),fields:{name:'Lock test',kind:'employee',scopes:['general'],duty:'Review',dataScope:'Input',executionScope:'Draft',skills:[],knowledge:[],responsibility:testRoleResponsibility}})
 const projectDb=await pool.connect(),lifecycleDb=await pool.connect()
 try{
  await projectDb.query('begin');await lifecycleDb.query('begin')
  await lifecycleDb.query('select id from teloa_roles where id=$1 for update',[role.id])
  let reached!:()=>void;const waitingForRole=new Promise<void>(resolve=>{reached=resolve})
  const wrapped={query:async(sql:string,args:unknown[])=>{if(sql.includes('from teloa_roles'))reached();return projectDb.query(sql,args)}} as unknown as typeof projectDb
  const linking=readProjectItems(wrapped,owner,'general',[{kind:'task',id:task.id},{kind:'role',id:role.id}],true).then(async rows=>{await projectDb.query('commit');return rows},async error=>{await projectDb.query('rollback');throw error})
  const observed=linking.then(()=>null,error=>error)
  await waitingForRole
  const retiring=lifecycleDb.query('select id from teloa_tasks where id=$1 for update',[task.id]).then(async()=>{await lifecycleDb.query('commit');return null},async error=>{await lifecycleDb.query('rollback');return error})
  const outcomes=await Promise.all([observed,retiring]);assert.deepEqual(outcomes,[null,null],'两笔操作都应完成，不得出现 40P01')
 }finally{await projectDb.query('rollback');await lifecycleDb.query('rollback');projectDb.release();lifecycleDb.release()}
})

test('跨业务引用只读读回，不进 items/summary，不反向修改对方；同业务、未登记范围与他人对象被拒',async()=>{
 const f=await fixture(),other=await fixture(),tasks=new TaskService(pool,identity)
 const soc=await tasks.create(f.owner,{requestId:randomUUID(),fields:{title:'SOC triage',goal:'Triage alerts',scope:'SOC'}})
 const otherSoc=await tasks.create(other.owner,{requestId:randomUUID(),fields:{title:'Other SOC',goal:'Not mine',scope:'SOC'}})
 const project=await f.service.create(f.owner,{requestId:randomUUID(),fields:fields({links:[{kind:'task',id:f.task.id}]})}),before=(await pool.query('select version,definition from teloa_tasks where id=$1',[soc.id])).rows
 const attempt=(references:ProjectDefinition['references'])=>f.service.edit(f.owner,{projectId:project.id,expectedVersion:1,fields:fields({links:project.links,references})})
 await assert.rejects(attempt([{kind:'task',id:soc.id,scope:'general'}]),{code:'teloa/invalid-input'})
 await assert.rejects(attempt([{kind:'task',id:soc.id,scope:'nope-unregistered'}]),{code:'teloa/forbidden'})
 await assert.rejects(attempt([{kind:'task',id:otherSoc.id,scope:'SOC'}]),{code:'teloa/forbidden'})
 await assert.rejects(attempt([{kind:'task',id:f.task.id,scope:'SOC'}]),{code:'teloa/forbidden'},'general 任务冒充 SOC 引用')
 await assert.rejects(f.service.create(f.owner,{requestId:randomUUID(),fields:fields({references:[{kind:'task',id:otherSoc.id,scope:'SOC'}]})}),{code:'teloa/forbidden'})
 const edited=await attempt([{kind:'task',id:soc.id,scope:'SOC'}])
 assert.equal(edited.version,2);assert.deepEqual(edited.references,[{kind:'task',id:soc.id,scope:'SOC'}])
 const detail=await f.service.get(f.owner,{projectId:project.id})
 assert.deepEqual(detail.references,[{kind:'task',id:soc.id,scope:'SOC',title:'SOC triage',state:'ready',version:1,available:true}])
 assert.equal(detail.items.length,1);assert.deepEqual(detail.summary,{totalTasks:1,completedTasks:0,cancelledTasks:0,attentionTasks:0})
 assert.deepEqual((await pool.query('select version,definition from teloa_tasks where id=$1',[soc.id])).rows,before)
 assert.deepEqual(Object.keys(detail).sort(),['items','project','references','summary'])
})
test('被引用资料撤回后显示占位且不报错；引用自动化不触发派生汇入，items 与 summary 不变',async()=>{
 const f=await relatedFixture(),resourceId=randomUUID()
 await pool.query("insert into teloa_resources(id,owner_id,revision,status,spec,created_at,updated_at) values($1,$2,1,'active',$3,now(),now())",[resourceId,f.owner,JSON.stringify({title:'SOC runbook',sourceId:'runbook',sourceVersion:'b'.repeat(64),scopeIds:['SOC']})])
 const socRole=await new RoleService(pool,identity).create(f.owner,{requestId:randomUUID(),fields:{name:'SOC analyst',kind:'employee',scopes:['SOC'],duty:'Triage',dataScope:'Alerts',executionScope:'Draft',skills:[],knowledge:[],responsibility:testRoleResponsibility,runtimeConfig:{agentPresetId:'reviewer'}}})
 const created=await f.plans.create(f.owner,{requestId:randomUUID(),source:{kind:'manual'},fields:{title:'SOC weekly',goal:'Review alerts',scope:'SOC',dataScope:'Alert data',delivery:'Alert report',roleId:socRole.id,expectedRoleVersion:1,trigger:{kind:'schedule',cadence:'daily',weekday:1,time:'09:00',timezone:'Asia/Singapore'},notificationPolicy:'attention'}})
 const socPlan=await f.plans.change(f.owner,{planId:created.id,requestId:randomUUID(),expectedVersion:1,action:'enable'}),occurrences=new PlanOccurrenceService(pool,{id:randomUUID}),now=new Date().toISOString()
 const {occurrence}=await occurrences.trigger(f.owner,{planId:socPlan.id,requestId:randomUUID(),expectedVersion:socPlan.version,expectedConfigVersion:socPlan.configVersion,now})
 const {task:derived}=await occurrences.dispatchTask(f.owner,{claimId:occurrence.id,taskRequestId:occurrence.taskRequestId,now})
 const project=await f.service.create(f.owner,{requestId:randomUUID(),fields:fields({links:[{kind:'task',id:f.task.id},{kind:'plan',id:f.plan.id}]})}),before=await f.service.get(f.owner,{projectId:project.id})
 const references:ProjectDefinition['references']=[{kind:'resource',id:resourceId,scope:'SOC'},{kind:'plan',id:socPlan.id,scope:'SOC'}]
 await f.service.edit(f.owner,{projectId:project.id,expectedVersion:1,fields:fields({links:project.links,references})})
 const after=await f.service.get(f.owner,{projectId:project.id})
 assert.deepEqual(after.items,before.items);assert.deepEqual(after.summary,before.summary)
 assert.ok(!after.items.some(item=>item.id===derived.id),'SOC 自动化派生任务不得汇入')
 assert.deepEqual(after.references.map(item=>[item.kind,item.scope,item.available,item.title]),[['plan','SOC',true,'SOC weekly'],['resource','SOC',true,'SOC runbook']])
 await pool.query("update teloa_resources set status='withdrawn' where id=$1",[resourceId])
 const withdrawn=await f.service.get(f.owner,{projectId:project.id})
 assert.deepEqual(withdrawn.references[1],{kind:'resource',id:resourceId,scope:'SOC',title:null,state:null,version:null,available:false})
 assert.deepEqual(withdrawn.project.references,references.slice().sort((a,b)=>a.kind.localeCompare(b.kind)),'已存引用不因对方撤回而被改写')
 await assert.rejects(f.service.create(f.owner,{requestId:randomUUID(),fields:fields({references:[{kind:'resource',id:resourceId,scope:'SOC'}]})}),{code:'teloa/forbidden'})
})
/** 旧版（迁移标记之前）的项目表 DDL：只建表，不含 references 回填与迁移表。 */
const legacyProjectTables=`
 create table teloa_projects(
  id uuid primary key,owner_id text not null,request_id uuid not null,request_spec jsonb not null,
  definition jsonb not null,version integer not null check(version>0),created_at timestamptz not null,updated_at timestamptz not null,
  unique(owner_id,request_id),check(jsonb_typeof(definition)='object'),check(jsonb_typeof(request_spec)='object')
 );
 create index teloa_projects_owner_scope on teloa_projects(owner_id,(definition->>'scope'));
 create table teloa_project_edits(
  project_id uuid not null references teloa_projects(id),base_version integer not null check(base_version>0),
  request_spec jsonb not null,result jsonb not null,primary key(project_id,base_version)
 );`
async function freshDatabase(name:string){
 await pool.query(`create database ${name}`)
 const url=new URL(container.getConnectionUri());url.pathname='/'+name;return new Pool({connectionString:url.toString()})
}
const legacyDefinition=(title:string)=>JSON.stringify({scope:'general',title,goal:'Legacy goal',dueDate:null,state:'planning',links:[]})
async function insertLegacyProject(db:Pool,title:string){
 const id=randomUUID();await db.query("insert into teloa_projects(id,owner_id,request_id,request_spec,definition,version,created_at,updated_at) values($1,'legacy',$2,$3,$3,1,now(),now())",[id,randomUUID(),legacyDefinition(title)]);return id
}
const hasReferences=async(db:Pool)=>(await db.query("select (select array_agg(definition ? 'references' and request_spec ? 'references' order by id) from teloa_projects) as projects,(select array_agg(request_spec ? 'references' and result ? 'references') from teloa_project_edits) as edits")).rows[0]
test('references 回填是一次性迁移：首次补齐四处并落标记，之后启动不再回填，并发初始化不报错',async()=>{
 const db=await freshDatabase('teloa_projects_migration_legacy')
 try{
  await db.query(legacyProjectTables)
  const first=await insertLegacyProject(db,'Legacy one');await insertLegacyProject(db,'Legacy two')
  await db.query("insert into teloa_project_edits(project_id,base_version,request_spec,result) values($1,1,$2,$2)",[first,legacyDefinition('Legacy one')])
  await initializeProjects(db)
  assert.deepEqual(await hasReferences(db),{projects:[true,true],edits:[true]})
  assert.deepEqual((await db.query("select distinct definition->'references' as d,request_spec->'references' as r from teloa_projects")).rows,[{d:[],r:[]}])
  assert.deepEqual((await db.query("select request_spec->'references' as r,result->'references' as s from teloa_project_edits")).rows,[{r:[],s:[]}])
  assert.deepEqual((await db.query('select name from teloa_project_migrations')).rows,[{name:'references-backfill-v1'}])
  const late=await insertLegacyProject(db,'Inserted after marker')
  await initializeProjects(db)
  assert.deepEqual((await db.query("select definition ? 'references' as d,request_spec ? 'references' as r from teloa_projects where id=$1",[late])).rows,[{d:false,r:false}],'标记之后不再全表回填')
  await Promise.all([initializeProjects(db),initializeProjects(db)])
  assert.equal((await db.query('select count(*)::int as n from teloa_project_migrations')).rows[0].n,1)
 }finally{await db.end()}
 const empty=await freshDatabase('teloa_projects_migration_empty')
 try{
  await Promise.all([initializeProjects(empty),initializeProjects(empty)])
  assert.deepEqual((await empty.query('select name from teloa_project_migrations')).rows,[{name:'references-backfill-v1'}],'空库并发初始化建表不冲突')
 }finally{await empty.end()}
})
test('回填中途失败时标记随事务回滚，下次启动重试补齐；回填后 get 与 edit 重放与原回执一致',async()=>{
 const db=await freshDatabase('teloa_projects_migration_partial')
 try{
  await db.query(legacyProjectTables)
  const first=await insertLegacyProject(db,'Partial one')
  await db.query("insert into teloa_project_edits(project_id,base_version,request_spec,result) values($1,1,$2,$2)",[first,legacyDefinition('Partial one')])
  await db.query("alter table teloa_project_edits add constraint block_result_references check(not (result ? 'references'))")
  await assert.rejects(initializeProjects(db),/block_result_references/,'第四条 update 被临时约束拒绝')
  assert.deepEqual(await hasReferences(db),{projects:[false],edits:[false]},'前三条 update 随事务回滚')
  assert.equal((await db.query("select to_regclass('teloa_project_migrations') as t")).rows[0].t,null,'标记表与标记一并回滚，不存在「标记已写、回填未完成」')
  await db.query('alter table teloa_project_edits drop constraint block_result_references')
  await initializeProjects(db)
  assert.deepEqual(await hasReferences(db),{projects:[true],edits:[true]})
  assert.deepEqual((await db.query('select name from teloa_project_migrations')).rows,[{name:'references-backfill-v1'}])
 }finally{await db.end()}
 const f=await fixture(),project=await f.service.create(f.owner,{requestId:randomUUID(),fields:fields()}),input={projectId:project.id,expectedVersion:1,fields:fields({title:'Renamed before backfill'})}
 const edited=await f.service.edit(f.owner,input)
 await pool.query("update teloa_projects set definition=definition-'references',request_spec=request_spec-'references' where id=$1",[project.id])
 await pool.query("update teloa_project_edits set request_spec=request_spec-'references',result=result-'references' where project_id=$1",[project.id])
 await pool.query('delete from teloa_project_migrations')
 const keyed=async()=>(await pool.query("select (select definition ? 'references' and request_spec ? 'references' from teloa_projects where id=$1) as project,(select bool_and(request_spec ? 'references' and result ? 'references') from teloa_project_edits where project_id=$1) as edits",[project.id])).rows[0]
 assert.deepEqual(await keyed(),{project:false,edits:false})
 await initializeProjects(pool)
 assert.deepEqual(await keyed(),{project:true,edits:true},'清空标记后再初始化会回填缺键行')
 const detail=await f.service.get(f.owner,{projectId:project.id});assert.deepEqual(detail.project,edited);assert.deepEqual(detail.references,[])
 assert.deepEqual(await f.service.edit(f.owner,input),edited,'回填后重放回执与原编辑一致')
})
test('总览跨业务聚合、筛选与 keyset 分页：排序稳定、两页拼接等于三次 list 并集、不越本人',async()=>{
 const f=await fixture(),scopes=['general','SOC','AppSec']
 for(const scope of scopes)for(const i of [0,1]){
  const created=await f.service.create(f.owner,{requestId:randomUUID(),fields:fields({scope,title:`${scope} ${i}`})})
  if(i===1)await f.service.edit(f.owner,{projectId:created.id,expectedVersion:1,fields:fields({scope,title:`${scope} ${i}`,state:'archived'})})
 }
 const first=await f.service.overview(f.owner,{scope:null,state:null,cursor:null,limit:4})
 assert.equal(first.rows.length,4);assert.equal(typeof first.nextCursor,'string')
 const second=await f.service.overview(f.owner,{scope:null,state:null,cursor:first.nextCursor,limit:4})
 assert.equal(second.rows.length,2);assert.equal(second.nextCursor,null)
 const all=[...first.rows,...second.rows];assert.equal(new Set(all.map(row=>row.id)).size,6)
 for(let i=1;i<all.length;i++){const a=all[i-1]!,b=all[i]!;assert.ok(a.updatedAt>b.updatedAt||(a.updatedAt===b.updatedAt&&a.id<b.id),'updated_at desc,id 与 list 一致')}
 const listed=(await Promise.all(scopes.map(scope=>f.service.list(f.owner,{scope})))).flat()
 assert.deepEqual(all.map(row=>row.id).sort(),listed.map(row=>row.id).sort())
 assert.deepEqual((await f.service.overview(f.owner,{scope:'SOC',state:null,cursor:null,limit:10})).rows.map(row=>row.scope),['SOC','SOC'])
 assert.equal((await f.service.overview(f.owner,{scope:null,state:'archived',cursor:null,limit:10})).rows.length,3)
 assert.equal((await f.service.overview(f.owner,{scope:'AppSec',state:'planning',cursor:null,limit:10})).rows.length,1)
 assert.deepEqual(await f.service.overview(randomUUID(),{scope:null,state:null,cursor:null,limit:10}),{rows:[],nextCursor:null})
 await assert.rejects(f.service.overview(f.owner,{scope:null,state:null,cursor:null,limit:101}),{code:'teloa/invalid-input'})
 await assert.rejects(f.service.overview(f.owner,{scope:null,state:null,limit:10}),{code:'teloa/invalid-input'})
})
test('总览同一时间点按 id 升序与 list 一致，游标跨越同时间行不重不漏',async()=>{
 const f=await fixture(),ids:string[]=[]
 for(let i=0;i<5;i++)ids.push((await f.service.create(f.owner,{requestId:randomUUID(),fields:fields({title:`Same ${i}`})})).id)
 await pool.query("update teloa_projects set updated_at='2026-09-25T00:00:00.000Z' where owner_id=$1",[f.owner])
 const listed=await f.service.list(f.owner,{scope:'general'});assert.deepEqual(listed.map(row=>row.id),[...ids].sort())
 const first=await f.service.overview(f.owner,{scope:null,state:null,cursor:null,limit:2}),second=await f.service.overview(f.owner,{scope:null,state:null,cursor:first.nextCursor,limit:2}),third=await f.service.overview(f.owner,{scope:null,state:null,cursor:second.nextCursor,limit:2})
 assert.deepEqual([...first.rows,...second.rows,...third.rows].map(row=>row.id),listed.map(row=>row.id));assert.equal(third.nextCursor,null)
})
test('「当前」筛选下推服务端：90 行（60 当前、30 归档交错）按页补足 limit，次序与 list 一致，叠加业务筛选同样成立',async()=>{
 const owner=randomUUID(),service=new ProjectService(pool,identity),current=['planning','running','review','completed']
 for(let i=0;i<90;i++){
  const state=i%3===2?'archived':current[i%4]!,scope=i%2===0?'general':'SOC'
  await pool.query("insert into teloa_projects(id,owner_id,request_id,request_spec,definition,version,created_at,updated_at) values($1,$2,$3,$4,$4,1,$5,$5)",[randomUUID(),owner,randomUUID(),JSON.stringify(fields({scope,title:`Paged ${i}`,state:state as ProjectDefinition['state']})),new Date(Date.UTC(2026,8,1)-i*1000).toISOString()])
 }
 const ordered=(rows:{updatedAt:string;id:string}[])=>[...rows].sort((a,b)=>a.updatedAt<b.updatedAt?1:a.updatedAt>b.updatedAt?-1:a.id<b.id?-1:1)
 const listed=(await Promise.all(['general','SOC'].map(scope=>service.list(owner,{scope})))).flat()
 const first=await service.overview(owner,{scope:null,state:'current',cursor:null,limit:50})
 assert.equal(first.rows.length,50,'首页恰好补足 50 行');assert.ok(first.rows.every(row=>row.state!=='archived'));assert.equal(typeof first.nextCursor,'string')
 const second=await service.overview(owner,{scope:null,state:'current',cursor:first.nextCursor,limit:50})
 assert.equal(second.rows.length,10);assert.equal(second.nextCursor,null);assert.ok(second.rows.every(row=>row.state!=='archived'))
 assert.deepEqual([...first.rows,...second.rows].map(row=>row.id),ordered(listed.filter(row=>row.state!=='archived')).map(row=>row.id))
 const general=listed.filter(row=>row.scope==='general'&&row.state!=='archived');assert.equal(general.length,30)
 const a=await service.overview(owner,{scope:'general',state:'current',cursor:null,limit:20}),b=await service.overview(owner,{scope:'general',state:'current',cursor:a.nextCursor,limit:20})
 assert.equal(a.rows.length,20);assert.equal(b.rows.length,10);assert.equal(b.nextCursor,null)
 assert.deepEqual([...a.rows,...b.rows].map(row=>row.id),general.map(row=>row.id),'叠加业务筛选时次序与 list 一致')
 assert.equal((await service.overview(owner,{scope:null,state:null,cursor:null,limit:100})).rows.length,90,'null 仍为全部状态')
 assert.equal((await service.overview(owner,{scope:null,state:'archived',cursor:null,limit:100})).rows.length,30)
})
test('links 与 references 混合校验按全局锁序一趟加锁：SOC 岗位引用先于 general 任务关联',async()=>{
 const {owner,task}=await fixture(),role=await new RoleService(pool,identity).create(owner,{requestId:randomUUID(),fields:{name:'SOC lock',kind:'employee',scopes:['SOC'],duty:'Review',dataScope:'Input',executionScope:'Draft',skills:[],knowledge:[],responsibility:testRoleResponsibility}})
 const projectDb=await pool.connect(),lifecycleDb=await pool.connect()
 try{
  await projectDb.query('begin');await lifecycleDb.query('begin')
  await lifecycleDb.query('select id from teloa_roles where id=$1 for update',[role.id])
  let reached!:()=>void;const waitingForRole=new Promise<void>(resolve=>{reached=resolve}),order:string[]=[]
  const wrapped={query:async(sql:string,args:unknown[])=>{const table=/from (teloa_[a-z_]+)/.exec(sql)?.[1];if(table)order.push(table);if(sql.includes('from teloa_roles'))reached();return projectDb.query(sql,args)}} as unknown as typeof projectDb
  const linking=readProjectRelations(wrapped,owner,'general',[{kind:'task',id:task.id}],[{kind:'role',id:role.id,scope:'SOC'}],true).then(async rows=>{await projectDb.query('commit');return rows},async error=>{await projectDb.query('rollback');throw error})
  const observed=linking.then(()=>null,error=>error)
  await waitingForRole
  const retiring=lifecycleDb.query('select id from teloa_tasks where id=$1 for update',[task.id]).then(async()=>{await lifecycleDb.query('commit');return null},async error=>{await lifecycleDb.query('rollback');return error})
  const outcomes=await Promise.all([observed,retiring]);assert.deepEqual(outcomes,[null,null],'两笔操作都应完成，不得出现 40P01')
  assert.deepEqual(order,['teloa_roles','teloa_tasks'],'引用的岗位先于关联的任务加锁')
  const result=await linking;assert.equal(result.items[0]?.available,true);assert.equal(result.references[0]?.available,true)
 }finally{await projectDb.query('rollback');await lifecycleDb.query('rollback');projectDb.release();lifecycleDb.release()}
})
test('读侧可访问校验：引用范围失去登记后 get 整组占位、不泄露标题、不报错，新增引用被拒',async()=>{
 const f=await fixture(),spaceId=(await new BusinessSpaceService(pool,identity).ensurePersonal(f.owner)).id
 await BusinessScopeService.ensure(pool,f.owner,{scope:'Marketing',title:'市场',kind:'domain',spaceId})
 const campaign=await new TaskService(pool,identity).create(f.owner,{requestId:randomUUID(),fields:{title:'Campaign brief',goal:'Draft brief',scope:'Marketing'}})
 const references:ProjectDefinition['references']=[{kind:'task',id:campaign.id,scope:'Marketing'}]
 const project=await f.service.create(f.owner,{requestId:randomUUID(),fields:fields({references})})
 assert.equal((await f.service.get(f.owner,{projectId:project.id})).references[0]?.title,'Campaign brief')
 await pool.query("delete from teloa_business_scopes where owner_id=$1 and scope='Marketing'",[f.owner])
 const detail=await f.service.get(f.owner,{projectId:project.id})
 assert.deepEqual(detail.references,[{kind:'task',id:campaign.id,scope:'Marketing',title:null,state:null,version:null,available:false}])
 assert.deepEqual(detail.project.references,references)
 await assert.rejects(f.service.create(f.owner,{requestId:randomUUID(),fields:fields({references})}),{code:'teloa/forbidden'})
})
test('服务层 edit 混合 links+references 只走一趟全局锁序：并发岗位→任务加锁不死锁',async()=>{
 const {owner,task,service}=await fixture(),role=await new RoleService(pool,identity).create(owner,{requestId:randomUUID(),fields:{name:'SOC service lock',kind:'employee',scopes:['SOC'],duty:'Review',dataScope:'Input',executionScope:'Draft',skills:[],knowledge:[],responsibility:testRoleResponsibility}})
 const project=await service.create(owner,{requestId:randomUUID(),fields:fields()}),lifecycleDb=await pool.connect()
 try{
  await lifecycleDb.query('begin');await lifecycleDb.query('select id from teloa_roles where id=$1 for update',[role.id])
  let reached!:()=>void;const waitingForRole=new Promise<void>(resolve=>{reached=resolve}),order:string[]=[]
  const wrappedPool=Object.assign(Object.create(pool),{connect:async()=>{const client=await pool.connect();return Object.assign(Object.create(client),{query:(sql:string,args?:unknown[])=>{const table=/from (teloa_(?:roles|tasks))\b/.exec(sql)?.[1];if(table)order.push(table);if(table==='teloa_roles')reached();return client.query(sql,args)},release:()=>client.release()})}}) as Pool
  const editing=new ProjectService(wrappedPool,identity).edit(owner,{projectId:project.id,expectedVersion:1,fields:fields({links:[{kind:'task',id:task.id}],references:[{kind:'role',id:role.id,scope:'SOC'}]})})
  const observed=editing.then(()=>null,error=>error)
  await waitingForRole
  const retiring=lifecycleDb.query('select id from teloa_tasks where id=$1 for update',[task.id]).then(async()=>{await lifecycleDb.query('commit');return null},async error=>{await lifecycleDb.query('rollback');return error})
  const outcomes=await Promise.all([observed,retiring]);assert.deepEqual(outcomes,[null,null],'两笔操作都应完成，不得出现 40P01')
  assert.deepEqual(order,['teloa_roles','teloa_tasks'],'若 validateRelations 拆回两趟，这里会先出现 teloa_tasks')
  const edited=await editing;assert.equal(edited.version,2);assert.equal(edited.references.length,1)
 }finally{await lifecycleDb.query('rollback').catch(()=>{});lifecycleDb.release()}
})

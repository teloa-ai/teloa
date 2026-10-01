import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {initializeTeloaDatabase} from '../src/work/initialize-database.ts'
import {ProjectService} from '../src/work/projects.ts'
import {TaskService} from '../src/work/tasks.ts'
import {RoleService} from '../src/work/roles.ts'
import {TaskMaterialService} from '../src/work/task-materials.ts'
import {RoleMemoryService} from '../src/work/role-memory.ts'
import {ObjectConversationService} from '../src/work/object-conversations.ts'
import {TaskRunService} from '../src/work/task-runs.ts'
import {businessObjectSnapshotHash} from '../src/work/business-data.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'
import type {ProjectDefinition} from '@teloa/contract'

// 2026-09-25 计划 功能验证：项目跨业务引用只是只读视角，任务运行、固定知识与岗位记忆的范围判定不因引用而放宽。
let container:StartedPostgreSqlContainer,pool:Pool
const identity={id:randomUUID,now:()=>new Date().toISOString()}
const fields=(patch:Partial<ProjectDefinition>={}):ProjectDefinition=>({scope:'general',title:'Launch',goal:'Ship',dueDate:null,state:'planning',links:[],references:[],...patch})
before(async()=>{container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()});await initializeTeloaDatabase(pool)},{timeout:120000})
after(async()=>{await pool?.end();await container?.stop()})

async function fixture(){
 const owner=randomUUID(),tasks=new TaskService(pool,identity),projects=new ProjectService(pool,identity)
 const task=await tasks.create(owner,{requestId:randomUUID(),fields:{title:'General delivery',goal:'Produce a report',scope:'general'}})
 const socTask=await tasks.create(owner,{requestId:randomUUID(),fields:{title:'SOC triage',goal:'Triage alerts',scope:'SOC'}})
 const socResourceId=randomUUID()
 await pool.query("insert into teloa_resources(id,owner_id,revision,status,spec,created_at,updated_at) values($1,$2,1,'active',$3,now(),now())",[socResourceId,owner,JSON.stringify({title:'SOC runbook',sourceId:'knowledge_'+socResourceId,sourceVersion:'a'.repeat(64),scopeIds:['SOC']})])
 const project=await projects.create(owner,{requestId:randomUUID(),fields:fields({links:[{kind:'task',id:task.id}]})})
 return {owner,tasks,projects,task,socTask,socResourceId,project}
}

test('源码守卫：运行装配、业务依据、知识与记忆链路不读项目表、不引项目模块',()=>{
 const root=join(import.meta.dirname,'../src/work')
 for(const file of ['task-runs.ts','task-run-business-context.ts','task-run-knowledge.ts','task-materials.ts','role-memory.ts']){
  const source=readFileSync(join(root,file),'utf8')
  for(const forbidden of ['teloa_projects','ProjectService','project-items','./projects'])assert.ok(!source.includes(forbidden),`${file} 不得出现 ${forbidden}`)
 }
})
test('跨业务引用不放宽固定知识范围：general 任务仍不能选用被引用的 SOC 资料',async()=>{
 const f=await fixture(),materials=new TaskMaterialService(pool,identity)
 const input=()=>({requestId:randomUUID(),taskId:f.task.id,expectedTaskVersion:1,resourceId:f.socResourceId,expectedResourceVersion:1})
 await assert.rejects(materials.add(f.owner,input()),{code:'teloa/forbidden',message:'当前任务业务范围无权使用这份知识。'})
 await f.projects.edit(f.owner,{projectId:f.project.id,expectedVersion:1,fields:fields({links:f.project.links,references:[{kind:'resource',id:f.socResourceId,scope:'SOC'}]})})
 assert.equal((await f.projects.get(f.owner,{projectId:f.project.id})).references[0]?.available,true)
 await assert.rejects(materials.add(f.owner,input()),{code:'teloa/forbidden',message:'当前任务业务范围无权使用这份知识。'})
 assert.deepEqual(await materials.list(f.owner,{taskId:f.task.id}),[])
})
test('跨业务引用不放宽岗位记忆读取：general 运行仍读不到 SOC 范围的已确认记忆',async()=>{
 const f=await fixture(),roles=new RoleService(pool,identity),memories=new RoleMemoryService(pool,identity),human={ownerId:f.owner,kind:'human' as const}
 const created=await roles.create(f.owner,{requestId:randomUUID(),fields:{name:'Dual analyst',kind:'employee',scopes:['general','SOC'],duty:'Triage',dataScope:'Alerts',executionScope:'Draft',skills:[],knowledge:[],responsibility:testRoleResponsibility,runtimeConfig:{agentPresetId:'standard'}}})
 await pool.query("update teloa_roles set state='active',version=2 where id=$1",[created.id])
 const role=(await roles.list(f.owner,{})).find(item=>item.id===created.id)!
 const candidate=await memories.create(human,{requestId:randomUUID(),roleId:role.id,expectedRoleVersion:2,title:'SOC 经验',markdown:'先核对告警来源。',source:{kind:'self-feedback',id:randomUUID(),version:1},visibility:{kind:'role',scopeIds:['SOC']}})
 await memories.confirm(human,{requestId:randomUUID(),memoryId:candidate.id,expectedStateVersion:1})
 assert.equal((await memories.confirmedForRun(pool,f.owner,{scope:'SOC'},role)).length,1)
 const before=await memories.confirmedForRun(pool,f.owner,{scope:'general'},role);assert.deepEqual(before,[])
 await f.projects.edit(f.owner,{projectId:f.project.id,expectedVersion:1,fields:fields({links:f.project.links,references:[{kind:'role',id:role.id,scope:'SOC'}]})})
 assert.equal((await f.projects.get(f.owner,{projectId:f.project.id})).references[0]?.available,true)
 assert.deepEqual(await memories.confirmedForRun(pool,f.owner,{scope:'general'},role),before)
})
test('引用不改变项目条目与进度：items 与 summary 在引用前后深等',async()=>{
 const f=await fixture(),before=await f.projects.get(f.owner,{projectId:f.project.id})
 await f.projects.edit(f.owner,{projectId:f.project.id,expectedVersion:1,fields:fields({links:f.project.links,references:[{kind:'task',id:f.socTask.id,scope:'SOC'},{kind:'resource',id:f.socResourceId,scope:'SOC'}]})})
 const after=await f.projects.get(f.owner,{projectId:f.project.id})
 assert.deepEqual(after.items,before.items);assert.deepEqual(after.summary,before.summary);assert.deepEqual(before.references,[])
 assert.deepEqual(after.references.map(item=>[item.kind,item.available]),[['resource',true],['task',true]])
 assert.deepEqual((await f.tasks.list(f.owner,{})).map(item=>item.version).sort(),[1,1])
})
test('任务 prepare 带异业务 businessContext 仍按 storage-corrupt 拒绝，项目引用不放宽',async()=>{
 const f=await fixture(),roles=new RoleService(pool,identity)
 const created=await roles.create(f.owner,{requestId:randomUUID(),fields:{name:'General analyst',kind:'employee',scopes:['general'],duty:'Review',dataScope:'Input',executionScope:'Draft',skills:[],knowledge:[],responsibility:testRoleResponsibility,runtimeConfig:{agentPresetId:'security-analyst'}}})
 await pool.query("update teloa_roles set state='active',version=2 where id=$1",[created.id])
 const task=await f.tasks.create(f.owner,{requestId:randomUUID(),fields:{title:'General review',goal:'Review',scope:'general'},assignee:{roleId:created.id,expectedVersion:2}}),sessionId=randomUUID(),conversationId=randomUUID()
 const inspect=async()=>({id:conversationId,sessionId,ownerId:f.owner,status:'ready' as const})
 await new ObjectConversationService(pool,inspect,identity.now).change(f.owner,{requestId:randomUUID(),kind:'task',objectId:task.id,expectedObjectVersion:1,sessionId,expectedLinkVersion:0,action:'link'})
 await f.projects.edit(f.owner,{projectId:f.project.id,expectedVersion:1,fields:fields({links:f.project.links,references:[{kind:'task',id:f.socTask.id,scope:'SOC'}]})})
 const snapshot={scope:'SOC',type:'alert',id:'edr-001',version:1,title:'SOC alert',source:'EDR',observedAt:'2026-09-14T01:00:00.000Z',receivedAt:'2026-09-14T01:00:01.000Z',quality:'complete' as const,summary:'Cross-business object.',fields:[{label:'asset',value:'prod-03'}]}
 const service=new TaskRunService(pool,identity,inspect,{allowedTools:[],businessContext:async()=>({taskId:task.id,sourceId:'security-alert-http',object:{...snapshot,snapshotHash:businessObjectSnapshotHash(snapshot)}})})
 await assert.rejects(service.prepare(f.owner,{requestId:randomUUID(),taskId:task.id,expectedTaskVersion:1,roleId:created.id,expectedRoleVersion:2,sessionId,expectedLinkVersion:1}),{code:'teloa/storage-corrupt',message:'业务对象依据不属于当前任务。'})
 assert.equal((await pool.query('select count(*)::int as n from teloa_task_runs where owner_id=$1',[f.owner])).rows[0].n,0)
})

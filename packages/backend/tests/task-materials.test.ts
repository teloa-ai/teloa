import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {initializeResources} from '../src/capabilities/schema.ts'
import {initializeRoles,RoleService} from '../src/work/roles.ts'
import {initializeTasks,TaskService} from '../src/work/tasks.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'
import {initializeTaskRuns} from '../src/work/task-runs.ts'
import {initializeTaskMaterials,TaskMaterialService} from '../src/work/task-materials.ts'

let container:StartedPostgreSqlContainer,pool:Pool
const identity={id:randomUUID,now:()=>new Date().toISOString()}
before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start()
 pool=new Pool({connectionString:container.getConnectionUri()})
 await initializeResources(pool);await initializeRoles(pool);await initializeTasks(pool);await initializeTaskRuns(pool);await initializeTaskMaterials(pool)
})
after(async()=>{await pool?.end();await container?.stop()})

async function task(owner=randomUUID(),scope='general'){
 const value=await new TaskService(pool,identity).create(owner,{requestId:randomUUID(),fields:{title:'发布任务',goal:'核对发布材料',scope}})
 return {owner,value}
}
async function resource(owner:string,scope='general',title='发布检查'){
 const id=randomUUID(),sourceId='knowledge_'+id,sourceVersion='a'.repeat(64)
 await pool.query("insert into teloa_resources(id,owner_id,revision,status,spec,created_at,updated_at) values($1,$2,1,'active',$3,now(),now())",[id,owner,JSON.stringify({title,sourceId,sourceVersion,scopeIds:[scope]})])
 return {id,version:1,title,sourceId,sourceVersion,scopeIds:[scope]}
}

test('添加知识固定资源快照并推进任务版本，目录只返回本人任务',async()=>{
 const {owner,value}=await task(),selected=await resource(owner),service=new TaskMaterialService(pool,identity),requestId=randomUUID()
 const input={requestId,taskId:value.id,expectedTaskVersion:1,resourceId:selected.id,expectedResourceVersion:1},[result,retry]=await Promise.all([service.add(owner,input),service.add(owner,input)])
 assert.deepEqual(retry,result)
 assert.equal(result.task.version,2);assert.equal(result.task.state,'ready')
 assert.deepEqual(result.material,{id:result.material.id,taskId:value.id,taskVersion:2,resourceId:selected.id,resourceVersion:1,title:selected.title,sourceId:selected.sourceId,sourceVersion:selected.sourceVersion,scopeIds:['general'],available:true,createdAt:result.material.createdAt})
 assert.deepEqual(await service.list(owner,{taskId:value.id}),[result.material])
 await assert.rejects(service.list('other',{taskId:value.id}),{code:'teloa/forbidden'})
 await assert.rejects(service.add(owner,{requestId:randomUUID(),taskId:value.id,expectedTaskVersion:2,resourceId:selected.id,expectedResourceVersion:1,ownerId:'forged'}),{code:'teloa/invalid-input'})
})

test('相同请求恢复原任务与引用，变化后的请求内容明确冲突',async()=>{
 const {owner,value}=await task(),selected=await resource(owner),service=new TaskMaterialService(pool,identity),input={requestId:randomUUID(),taskId:value.id,expectedTaskVersion:1,resourceId:selected.id,expectedResourceVersion:1}
 const saved=await service.add(owner,input)
 await pool.query("update teloa_tasks set state='paused',version=version+1,updated_at=now() where id=$1",[value.id])
 await pool.query("update teloa_resources set status='withdrawn',revision=revision+1,updated_at=now() where id=$1",[selected.id])
 assert.deepEqual(await new TaskMaterialService(pool,identity).add(owner,input),saved)
 await assert.rejects(service.add(owner,{...input,resourceId:randomUUID()}),{code:'teloa/conflict'})
 assert.equal((await service.list(owner,{taskId:value.id}))[0]!.available,false)
})

test('拒绝跨本人、跨业务、撤回、版本不符与重复资源',async()=>{
 const {owner,value}=await task(),service=new TaskMaterialService(pool,identity)
 const foreign=await resource('other'),wrongScope=await resource(owner,'soc'),withdrawn=await resource(owner),selected=await resource(owner)
 await pool.query("update teloa_resources set status='withdrawn',revision=2 where id=$1",[withdrawn.id])
 for(const [resourceId,expectedResourceVersion,code] of [[foreign.id,1,'teloa/forbidden'],[wrongScope.id,1,'teloa/forbidden'],[withdrawn.id,2,'teloa/resource-withdrawn'],[selected.id,2,'teloa/version-conflict']] as const){
  await assert.rejects(service.add(owner,{requestId:randomUUID(),taskId:value.id,expectedTaskVersion:1,resourceId,expectedResourceVersion}),{code})
 }
 const added=await service.add(owner,{requestId:randomUUID(),taskId:value.id,expectedTaskVersion:1,resourceId:selected.id,expectedResourceVersion:1})
 await assert.rejects(service.add(owner,{requestId:randomUUID(),taskId:value.id,expectedTaskVersion:added.task.version,resourceId:selected.id,expectedResourceVersion:1}),{code:'teloa/conflict'})
})

test('只有可修改且无未结束执行的当前任务版本可以添加知识',async()=>{
 for(const state of ['ready','paused','blocked','waiting']){
  const {owner,value}=await task(),selected=await resource(owner),service=new TaskMaterialService(pool,identity)
  if(state!=='ready')await pool.query('update teloa_tasks set state=$2 where id=$1',[value.id,state])
  assert.equal((await service.add(owner,{requestId:randomUUID(),taskId:value.id,expectedTaskVersion:1,resourceId:selected.id,expectedResourceVersion:1})).task.state,state)
 }
 for(const state of ['running','completed','cancelled']){
  const {owner,value}=await task(),selected=await resource(owner),service=new TaskMaterialService(pool,identity)
  await pool.query('update teloa_tasks set state=$2 where id=$1',[value.id,state])
  await assert.rejects(service.add(owner,{requestId:randomUUID(),taskId:value.id,expectedTaskVersion:1,resourceId:selected.id,expectedResourceVersion:1}),{code:'teloa/conflict'})
 }
 const {owner,value}=await task(),selected=await resource(owner),role=await new RoleService(pool,identity).create(owner,{requestId:randomUUID(),fields:{name:'调查岗',kind:'employee',scopes:['general'],duty:'调查',dataScope:'资料',executionScope:'只读',skills:[],knowledge:[],responsibility:testRoleResponsibility}})
 await pool.query("insert into teloa_task_runs(id,owner_id,request_id,request_spec,task_id,role_id,task_version,role_version,link_version,session_id,native_request_id,state,input_text,created_at) values($1,$2,$3,'{}',$4,$5,1,1,1,$6,$7,'prepared','{}',now())",[randomUUID(),owner,randomUUID(),value.id,role.id,randomUUID(),randomUUID()])
 await assert.rejects(new TaskMaterialService(pool,identity).add(owner,{requestId:randomUUID(),taskId:value.id,expectedTaskVersion:1,resourceId:selected.id,expectedResourceVersion:1}),{code:'teloa/conflict'})
})

test('运行配置失败是终态，不阻止任务补充知识',async()=>{
 const {owner,value}=await task(),selected=await resource(owner),role=await new RoleService(pool,identity).create(owner,{requestId:randomUUID(),fields:{name:'调查岗',kind:'employee',scopes:['general'],duty:'调查',dataScope:'资料',executionScope:'只读',skills:[],knowledge:[],responsibility:testRoleResponsibility,runtimeConfig:{agentPresetId:'missing-preset'}}})
 await pool.query("insert into teloa_task_runs(id,owner_id,request_id,request_spec,task_id,role_id,task_version,role_version,link_version,session_id,native_request_id,state,input_text,created_at,agent_preset_id,configuration_error) values($1,$2,$3,'{}',$4,$5,1,1,0,$6,$7,'configuration_failed','{}',now(),'missing-preset',$8)",[randomUUID(),owner,randomUUID(),value.id,role.id,randomUUID(),randomUUID(),JSON.stringify({code:'teloa/preset-unavailable',stage:'preset-resolve',message:'运行配置不可用'})])
 const result=await new TaskMaterialService(pool,identity).add(owner,{requestId:randomUUID(),taskId:value.id,expectedTaskVersion:1,resourceId:selected.id,expectedResourceVersion:1})
 assert.equal(result.task.version,2)
})

test('执行准备累积读取当前任务版本的固定引用并拒绝漂移',async()=>{
 const {owner,value}=await task(),first=await resource(owner),second=await resource(owner),service=new TaskMaterialService(pool,identity)
 const a=await service.add(owner,{requestId:randomUUID(),taskId:value.id,expectedTaskVersion:1,resourceId:first.id,expectedResourceVersion:1})
 const b=await service.add(owner,{requestId:randomUUID(),taskId:value.id,expectedTaskVersion:2,resourceId:second.id,expectedResourceVersion:1})
 assert.deepEqual(await service.executionRefs(owner,value.id,3),[{id:first.id,version:1},{id:second.id,version:1}])
 await assert.rejects(service.executionRefs(owner,value.id,2),{code:'teloa/version-conflict'})
 await pool.query("update teloa_resources set status='withdrawn',revision=2 where id=$1",[first.id])
 await assert.rejects(service.executionRefs(owner,value.id,3),{code:'teloa/resource-withdrawn'})
 assert.equal(a.material.taskVersion,2);assert.equal(b.material.taskVersion,3)
})

test('资源锁后的撤回先完成时，等待中的添加不能保存过期引用',async()=>{
 const {owner,value}=await task(),selected=await resource(owner),service=new TaskMaterialService(pool,identity),holder=await pool.connect()
 await holder.query('begin');await holder.query('select * from teloa_resources where id=$1 for update',[selected.id])
 const pending=service.add(owner,{requestId:randomUUID(),taskId:value.id,expectedTaskVersion:1,resourceId:selected.id,expectedResourceVersion:1}).then(value=>({value,error:null}),error=>({value:null,error}))
 try{
  const deadline=Date.now()+3000;let waiting=false
  while(Date.now()<deadline){const rows=await pool.query("select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like 'select * from teloa_resources where id=%'");if(rows.rowCount){waiting=true;break}await new Promise(resolve=>setTimeout(resolve,10))}
  assert.equal(waiting,true)
  await holder.query("update teloa_resources set status='withdrawn',revision=2 where id=$1",[selected.id]);await holder.query('commit')
  assert.equal((await pending).error?.code,'teloa/resource-withdrawn')
  assert.equal((await new TaskService(pool,identity).list(owner,{}))[0]!.version,1)
 }finally{await holder.query('rollback');holder.release();await pending}
})

test('任务锁后的并发版本推进先完成时，等待中的添加不能覆盖新任务事实',async()=>{
 const {owner,value}=await task(),selected=await resource(owner),service=new TaskMaterialService(pool,identity),holder=await pool.connect()
 await holder.query('begin');await holder.query('select * from teloa_tasks where id=$1 for update',[value.id])
 const pending=service.add(owner,{requestId:randomUUID(),taskId:value.id,expectedTaskVersion:1,resourceId:selected.id,expectedResourceVersion:1}).then(value=>({value,error:null}),error=>({value:null,error}))
 try{
  const deadline=Date.now()+3000;let waiting=false
  while(Date.now()<deadline){const rows=await pool.query("select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like 'select * from teloa_tasks where id=%'");if(rows.rowCount){waiting=true;break}await new Promise(resolve=>setTimeout(resolve,10))}
  assert.equal(waiting,true)
  await holder.query("update teloa_tasks set version=2,state='running',updated_at=now() where id=$1",[value.id]);await holder.query('commit')
  assert.equal((await pending).error?.code,'teloa/version-conflict')
  assert.deepEqual(await service.list(owner,{taskId:value.id}),[])
 }finally{await holder.query('rollback');holder.release();await pending}
})

test('材料归属和固定快照损坏不能被目录静默隐藏或截断',async()=>{
 for(const changed of ['owner','snapshot','future-version']){
  const {owner,value}=await task(),selected=await resource(owner),service=new TaskMaterialService(pool,identity)
  const saved=await service.add(owner,{requestId:randomUUID(),taskId:value.id,expectedTaskVersion:1,resourceId:selected.id,expectedResourceVersion:1})
  if(changed==='owner')await pool.query('update teloa_task_materials set owner_id=$2 where id=$1',[saved.material.id,'other'])
  else if(changed==='snapshot')await pool.query("update teloa_task_materials set snapshot=jsonb_set(snapshot,'{ownerId}','\"forged\"'::jsonb) where id=$1",[saved.material.id])
  else await pool.query('update teloa_task_materials set task_version=task_version+10 where id=$1',[saved.material.id])
  await assert.rejects(service.list(owner,{taskId:value.id}),{code:'teloa/storage-corrupt'})
  await assert.rejects(service.executionRefs(owner,value.id,2),{code:'teloa/storage-corrupt'})
 }
})

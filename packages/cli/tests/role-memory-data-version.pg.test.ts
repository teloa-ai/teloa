import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {createRequire} from 'node:module'
import {mkdir,mkdtemp,readFile,writeFile,symlink,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {dirname,join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {createServer} from 'node:net'
import {Pool,stopTestContainer} from '../../backend/tests/postgres-test-lifecycle.ts'
import {RoleMemoryService} from '../../backend/src/work/role-memory.ts'
import {TaskService} from '../../backend/src/work/tasks.ts'
import {TaskRunService} from '../../backend/src/work/task-runs.ts'
import {ObjectConversationService} from '../../backend/src/work/object-conversations.ts'
import {ownerAuthority} from '../../backend/tests/role-work-test-fixture.ts'
import {prepareDatabase,inspectDatabase} from '../src/database.ts'
import {createBackup,verifyBackup,restoreBackup} from '../src/maintenance.ts'
import {resolveLayout} from '../src/layout.ts'
import type {InstallState} from '../src/contracts.ts'

const backendRequire=createRequire(new URL('../../backend/package.json',import.meta.url)),{PostgreSqlContainer}=backendRequire('@testcontainers/postgresql')
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex'),identity={id:randomUUID,now:()=>new Date().toISOString()}
async function freePort(){const server=createServer();await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const port=(server.address() as {port:number}).port;await new Promise<void>(done=>server.close(()=>done()));return port}

async function releaseFixture(root:string,version:string,dataVersion:5|6,oldProgram:string,fail=false){
 await mkdir(join(root,'packages/backend/lib/work'),{recursive:true,mode:0o700});await mkdir(join(root,'node_modules'),{mode:0o700})
 const module=(name:string)=>dataVersion===5?pathToFileURL(join(oldProgram,'packages/backend/lib/work',name+'.js')).href:new URL('../../backend/src/work/'+name+'.ts',import.meta.url).href
 const files={
  'package.json':JSON.stringify({name:'@teloa/cli',version,type:'module',dependencies:{pg:'8.23.0'}}),
  'packages/backend/lib/work/initialize-database.js':`import {initializeTeloaDatabase as initialize} from ${JSON.stringify(module('initialize-database'))};export async function initializeTeloaDatabase(pool){await initialize(pool);${fail?'throw Error("本轮隔离迁移失败")':''}}`,
  'packages/backend/lib/work/plans.js':`export {PlanService} from ${JSON.stringify(module('plans'))}`,
 }
 for(const [name,body] of Object.entries(files))await writeFile(join(root,name),body,{mode:0o600})
 await symlink(dirname(dirname(backendRequire.resolve('pg'))),join(root,'node_modules/pg'))
 await writeFile(join(root,'release-manifest.json'),JSON.stringify({schema:'teloa.release/v1',version,dshVersion:'0.2.1-rc.2',dataVersion,compatibleDataVersions:[dataVersion],files:Object.entries(files).map(([path,body])=>({path,sha256:hash(body)}))}),{mode:0o600})
}

test('真实 data5→6 备份迁移：旧记忆保留、新偏好按 Task 消费、实际旧5拒绝6、失败及正常5恢复保持备份',{timeout:180000,skip:!process.env.TELOA_TEST_DATA5_PROGRAM_ROOT},async t=>{
 const oldProgram=process.env.TELOA_TEST_DATA5_PROGRAM_ROOT!,oldMetadata=JSON.parse(await readFile(join(oldProgram,'packages/cli/lib/data-version.json'),'utf8'));assert.equal(oldMetadata.dataVersion,5)
 const oldCli=await import(pathToFileURL(join(oldProgram,'packages/cli/lib/database.js')).href),oldMemory=await import(pathToFileURL(join(oldProgram,'packages/backend/lib/work/role-memory.js')).href),oldRoles=await import(pathToFileURL(join(oldProgram,'packages/backend/lib/work/roles.js')).href)
 const root=await mkdtemp(join(tmpdir(),'teloa-preference-migration-')),container=await new PostgreSqlContainer('postgres:17-alpine').withDatabase('teloa').withUsername('teloa').start()
 let pool=new Pool({connectionString:container.getConnectionUri()}),poolEnded=false;t.after(async()=>{if(!poolEnded)await pool.end();await stopTestContainer(container);await rm(root,{recursive:true,force:true})})
 const config=join(root,'connection.json'),workspace=join(root,'workspace'),home=join(root,'home');await mkdir(workspace,{mode:0o700});await writeFile(config,JSON.stringify({connectionString:container.getConnectionUri()}),{mode:0o600})
 const layout=await resolveLayout({home,workspace,version:'0.2.84-data5.fixture'}),old:InstallState={schema:'teloa.install/v1',id:randomUUID(),version:'0.2.84-data5.fixture',phase:'stopped',port:await freePort(),database:{kind:'existing',configFile:config},layout}
 await mkdir(layout.dshHome,{recursive:true,mode:0o700});await mkdir(layout.runtimeRoot,{recursive:true,mode:0o700});await releaseFixture(layout.releaseRoot,old.version,5,oldProgram)
 await oldCli.prepareDatabase(old)
 const owner=randomUUID(),role=await new oldRoles.RoleService(pool,identity).ensurePersonalTwin(owner),human={ownerId:owner,kind:'human' as const},oldService=new oldMemory.RoleMemoryService(pool,identity)
 const candidate=await oldService.create(human,{requestId:randomUUID(),roleId:role.id,expectedRoleVersion:role.version,title:'原 data5 本人记忆',markdown:'原固定正文与来源保持。',source:{kind:'self-feedback',id:randomUUID(),version:1},visibility:{kind:'private',scopeIds:[]}}),legacy=await oldService.confirm(human,{requestId:randomUUID(),memoryId:candidate.id,expectedStateVersion:1})
 assert.equal((await pool.query("select to_regclass('teloa_role_memory_preference_versions') as name")).rows[0].name,null)
 const before=(await pool.query('select * from teloa_role_memory_versions')).rows,backup=join(root,'backup5'),manifest=await createBackup(old,backup),manifestBody=await readFile(join(backup,'backup-manifest.json'))
 assert.equal(manifest.dataVersion,5)
 const next:InstallState={...old,version:'0.2.85-data6.fixture',phase:'maintenance',layout:await resolveLayout({home,workspace,version:'0.2.85-data6.fixture'})},failed:InstallState={...old,version:'0.2.85-data6.fail',phase:'maintenance',layout:await resolveLayout({home,workspace,version:'0.2.85-data6.fail'})}
 await releaseFixture(next.layout.releaseRoot,next.version,6,oldProgram);await releaseFixture(failed.layout.releaseRoot,failed.version,6,oldProgram,true)
 const marker=async()=>(await pool.query('select id,data_version from teloa_installation')).rows
 await assert.rejects(prepareDatabase(next),/先备份迁移/);await assert.rejects(prepareDatabase(next,{initialize:false,migrationBackup:backup}),/先备份迁移/)
 await assert.rejects(prepareDatabase(failed,{migrationBackup:backup}),/初始化失败/)
 assert.deepEqual(await marker(),[{id:old.id,data_version:5}]);assert.deepEqual((await pool.query('select * from teloa_role_memory_versions')).rows,before)
 assert.deepEqual(await verifyBackup(backup),manifest);assert.deepEqual(await readFile(join(backup,'backup-manifest.json')),manifestBody)
 await prepareDatabase(next,{migrationBackup:backup});assert.deepEqual(await marker(),[{id:old.id,data_version:6}]);assert.equal(await inspectDatabase(next),'ready')
 const service=new RoleMemoryService(pool,identity);assert.deepEqual((await service.list(human,{roleId:role.id}))[0],legacy);assert.deepEqual((await pool.query('select * from teloa_role_memory_versions')).rows,before)
 const tasks=new TaskService(pool,identity,ownerAuthority),goal='只在本次任务使用表格。',task=await tasks.createConfirmed(owner,{requestId:randomUUID(),fields:{title:'本次偏好边界',goal,scope:'general'},assignee:{roleId:role.id,expectedVersion:role.version}}),sessionId=randomUUID(),conversationId=randomUUID(),inspect=async()=>({id:conversationId,ownerId:owner,sessionId,status:'ready'})
 await new ObjectConversationService(pool,inspect,identity.now).change(owner,{requestId:randomUUID(),kind:'task',objectId:task.id,expectedObjectVersion:task.version,sessionId,expectedLinkVersion:0,action:'link'})
 const runs=new TaskRunService(pool,identity,inspect),run=await runs.prepare(owner,{requestId:randomUUID(),taskId:task.id,expectedTaskVersion:task.version,roleId:role.id,expectedRoleVersion:role.version,sessionId,expectedLinkVersion:1},undefined,undefined,undefined,async()=> 'default-agent')
 await runs.claim(owner,{runId:run.id});await runs.record(owner,{runId:run.id,sessionId,nativeRequestId:run.nativeRequestId,evidence:{state:'active',turn:0,messageSeq:1}})
 const once=await service.create({ownerId:owner,kind:'agent',roleId:role.id},{requestId:randomUUID(),roleId:role.id,expectedRoleVersion:role.version,title:'仅本任务表格',markdown:goal,source:{kind:'run',id:run.id,version:1},visibility:{kind:'private',scopeIds:[]},preference:{schema:'teloa.preference-candidate/v1',kind:'one-off',scope:'general',basis:{kind:'owner-input',quote:goal}}})
 await service.confirm(human,{requestId:randomUUID(),memoryId:once.id,expectedStateVersion:1})
 const context=(taskId?:string)=>service.confirmedForRun(pool,owner,{scope:'general',groupId:null,memoryViewId:null,...(taskId?{taskId}:{})},role)
 assert.ok((await context(task.id)).some(m=>m.id===once.id));assert.equal((await context()).some(m=>m.id===once.id),false)
 const other=await tasks.createConfirmed(owner,{requestId:randomUUID(),fields:{title:'另一任务',goal:'不能继承表格例外。',scope:'general'},assignee:{roleId:role.id,expectedVersion:role.version}})
 assert.equal((await context(other.id)).some(m=>m.id===once.id),false)
 await assert.rejects(service.confirmedForRun(pool,owner,{scope:'SOC',groupId:null,memoryViewId:null,taskId:task.id},role),{code:'teloa/forbidden'})
 await assert.rejects(oldCli.prepareDatabase(old),/数据版本尚不支持/);await assert.rejects(oldCli.prepareDatabase(old,{initialize:false}),/数据版本尚不支持/);assert.equal(await oldCli.inspectDatabase(old),'unavailable')
 assert.deepEqual(await marker(),[{id:old.id,data_version:6}]);assert.deepEqual(await verifyBackup(backup),manifest)
 // 只重建本轮容器拥有的专库，正常恢复必须使用原 data5 备份与 data5 发行；从不手改 marker。
 await pool.end();poolEnded=true;const uri=new URL(container.getConnectionUri());uri.pathname='/postgres';const admin=new Pool({connectionString:uri.href})
 try{await admin.query('drop database teloa');await admin.query('create database teloa')}finally{await admin.end()}
 pool=new Pool({connectionString:container.getConnectionUri()});poolEnded=false
 const restored=await restoreBackup(backup,join(root,'restored5'),{kind:'existing',configFile:config},old.layout.releaseRoot)
 assert.equal(restored.phase,'stopped');assert.notEqual(restored.id,old.id);assert.deepEqual(await marker(),[{id:restored.id,data_version:5}])
 await oldCli.prepareDatabase(restored,{initialize:false});assert.equal(await oldCli.inspectDatabase(restored),'ready')
 const recovered=new oldMemory.RoleMemoryService(pool,identity);assert.deepEqual((await recovered.list(human,{roleId:role.id}))[0],legacy)
 assert.deepEqual(await readFile(join(backup,'backup-manifest.json')),manifestBody);assert.deepEqual(await verifyBackup(backup),manifest)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {createRequire} from 'node:module'
import {mkdtemp,mkdir,readFile,rm,symlink,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {dirname,join} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {createServer} from 'node:net'
import type {InstallState} from '../src/contracts.ts'
import {prepareDatabase,databaseConfig,databasePool,databaseName,docker,stopDatabase} from '../src/database.ts'
import {createBackup,restoreBackup,verifyBackup} from '../src/maintenance.ts'
import {canUseData,upgradeInstall} from '../src/upgrade.ts'
import {resolveLayout} from '../src/layout.ts'
import {writeInstall} from '../src/state.ts'
import {RoleService} from '../../backend/src/work/roles.ts'
import {RoleMemoryService} from '../../backend/src/work/role-memory.ts'
import {testRoleResponsibility} from '../../backend/tests/role-test-fixture.ts'

const backendRequire=createRequire(new URL('../../backend/package.json',import.meta.url))
const repository=fileURLToPath(new URL('../../',import.meta.url))
const identity={id:randomUUID,now:()=>new Date().toISOString()}
async function freePort():Promise<number>{
 const server=createServer();await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
 const port=(server.address() as {port:number}).port;await new Promise<void>(resolve=>server.close(()=>resolve()));return port
}
async function releaseFixture(root:string,version:string,dataVersion:number,fail=false){
 await mkdir(join(root,'packages/backend/lib/work'),{recursive:true,mode:0o700});await mkdir(join(root,'node_modules'),{mode:0o700})
 const initializer=pathToFileURL(join(repository,'backend/src/work/initialize-database.ts')).href
 const plans=pathToFileURL(join(repository,'backend/src/work/plans.ts')).href
 const files:Record<string,string>={
  'package.json':JSON.stringify({name:'@teloa/cli',version,type:'module',dependencies:{pg:'8.23.0'}}),
  'packages/backend/package.json':JSON.stringify({name:'@teloa/backend',version,type:'module'}),
  'packages/backend/lib/work/initialize-database.js':`import {initializeTeloaDatabase as initialize} from ${JSON.stringify(initializer)};export async function initializeTeloaDatabase(pool){await initialize(pool,{businessSqlSecretPath:${JSON.stringify(join(root,'sql-secret.json'))}});${fail?'throw Error("本轮隔离初始化失败")':''}}`,
  'packages/backend/lib/work/plans.js':`export {PlanService} from ${JSON.stringify(plans)}`,
 }
 for(const [path,content] of Object.entries(files))await writeFile(join(root,path),content,{mode:0o600})
 await symlink(dirname(dirname(backendRequire.resolve('pg'))),join(root,'node_modules/pg'))
 await writeFile(join(root,'release-manifest.json'),JSON.stringify({schema:'teloa.release/v1',version,dshVersion:'0.1.6-alpha.1',dataVersion,compatibleDataVersions:[dataVersion],files:Object.entries(files).map(([path,content])=>({path,sha256:createHash('sha256').update(content).digest('hex')}))}),{mode:0o600})
}
async function marker(state:InstallState){const pool=await databasePool(state);try{return (await pool.query('select id,data_version from teloa_installation')).rows}finally{await pool.end()}}

test('真实隔离 PG：旧记忆迁到数据2、新读写、1/2备份恢复及旧候选拒绝', {timeout:240_000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'teloa-data-version-')),home=join(root,'home'),owned=new Set<string>()
 // 仅创建随机安装身份的本轮 Docker 资源；不连接任何已有用户 home、端口或数据库。
 t.after(async()=>{
  for(const id of owned){
   const name='teloa-'+id
   const containers=await docker(['ps','-a','--filter','label=ai.teloa.install='+id,'--format','{{.Names}}'])
   if(containers.split('\n').includes(name))await docker(['rm','-f',name])
   const volumes=await docker(['volume','ls','--filter','label=ai.teloa.install='+id,'--format','{{.Name}}'])
   if(volumes.split('\n').includes(name+'-data'))await docker(['volume','rm',name+'-data'])
  }
  await rm(root,{recursive:true,force:true})
 })
 const layout=await resolveLayout({home,workspace:join(root,'workspace'),version:'0.2.3'})
 const old:InstallState={schema:'teloa.install/v1',id:randomUUID(),version:'0.2.3',phase:'stopped',port:await freePort(),database:{kind:'docker'},layout}
 owned.add(old.id)
 await mkdir(layout.workspaceRoot,{recursive:true,mode:0o700});await mkdir(layout.dshHome,{recursive:true,mode:0o700})
 await releaseFixture(layout.releaseRoot,'0.2.3',1)
 await writeInstall(old);await prepareDatabase(old)
 let pool=await databasePool(old)
 const owner=randomUUID(),human={ownerId:owner,kind:'human' as const}
 const created=await new RoleService(pool,identity).create(owner,{requestId:randomUUID(),fields:{name:'原本人分身',kind:'twin',scopes:['general'],duty:'核对原资料',dataScope:'本人资料',executionScope:'代拟',skills:[],knowledge:[],responsibility:testRoleResponsibility,runtimeConfig:{agentPresetId:'standard'}}})
 await pool.query("update teloa_roles set state='active',version=2 where id=$1",[created.id])
 const candidate=await new RoleMemoryService(pool,identity).create(human,{requestId:randomUUID(),roleId:created.id,expectedRoleVersion:2,title:'旧版本人经验',markdown:'旧版原固定正文',source:{kind:'self-feedback',id:randomUUID(),version:1},visibility:{kind:'private',scopeIds:[]}})
 await pool.query("alter table teloa_role_memories drop constraint teloa_role_memories_lifecycle; alter table teloa_role_memories add constraint legacy_lifecycle check((state='candidate' and state_version=1 and confirmed_at is null and withdrawn_at is null) or (state='confirmed' and state_version=2 and confirmed_at is not null and withdrawn_at is null) or (state='withdrawn' and withdrawn_at is not null and state_version=case when confirmed_at is null then 2 else 3 end)); drop table teloa_role_memory_edits")
 await pool.end()
 const backup1=join(root,'backup-1'),v1=await createBackup(old,backup1)
 assert.equal(v1.dataVersion,1);assert.equal(v1.installId,old.id)
 const next:InstallState={...old,version:'0.2.4',phase:'maintenance',layout:await resolveLayout({home,workspace:layout.workspaceRoot,version:'0.2.4'})}
 await releaseFixture(next.layout.releaseRoot,next.version,2)
 await t.test('无备份的普通初始化/恢复准备拒绝迁移，原数据版本和旧约束保持',async()=>{
  for(const options of [{},{initialize:false}])await assert.rejects(prepareDatabase(next,options),/需要先备份迁移/)
  assert.deepEqual(await marker(next),[{id:old.id,data_version:1}])
  pool=await databasePool(next)
  try{assert.equal((await pool.query("select 1 from pg_constraint where conname='legacy_lifecycle'")).rowCount,1)}finally{await pool.end()}
 })
 await t.test('错误安装的备份不可授权迁移；初始化失败不提前更新版本',async()=>{
  const wrong=join(root,'wrong-backup');await mkdir(wrong)
  for(const file of ['backup-manifest.json',...v1.files.map(row=>row.path)]){
   const destination=join(wrong,file);await mkdir(dirname(destination),{recursive:true,mode:0o700});await writeFile(destination,await readFile(join(backup1,file)),{mode:0o600})
  }
  await writeFile(join(wrong,'backup-manifest.json'),JSON.stringify({...v1,installId:randomUUID()}),{mode:0o600})
  await assert.rejects(prepareDatabase(next,{migrationBackup:wrong}),/备份与原安装/)
  const failing:InstallState={...next,version:'0.2.4-testfail',layout:await resolveLayout({home,workspace:layout.workspaceRoot,version:'0.2.4-testfail'})}
  await releaseFixture(failing.layout.releaseRoot,failing.version,2,true)
  await assert.rejects(prepareDatabase(failing,{migrationBackup:backup1}),/初始化失败/)
  assert.deepEqual(await marker(next),[{id:old.id,data_version:1}]);assert.equal((await verifyBackup(backup1)).dataVersion,1)
 })
 await t.test('受控备份迁移成功后才标记2，本人可编辑且旧正文与原来源保留',async()=>{
  await prepareDatabase(next,{migrationBackup:backup1})
  assert.deepEqual(await marker(next),[{id:old.id,data_version:2}])
  pool=await databasePool(next)
  try{
   const service=new RoleMemoryService(pool,identity)
   const original=(await service.list(human,{roleId:created.id}))[0]!
   assert.deepEqual(original,candidate)
   const edited=await service.edit(human,{requestId:randomUUID(),roleId:created.id,memoryId:candidate.id,expectedContentVersion:1,expectedContentHash:candidate.content.contentHash,expectedStateVersion:1,title:'新版本人经验',markdown:'新版本人明确编辑后的正文'})
   assert.equal(edited.content.version,2);assert.equal(edited.stateVersion,2);assert.equal(edited.content.editedBy,'self');assert.deepEqual(edited.source,candidate.source)
   assert.deepEqual(await service.readVersion(human,{roleId:created.id,memoryId:candidate.id,version:1}),candidate)
  }finally{await pool.end()}
  await prepareDatabase(next)
 })
 await t.test('数据2不允许旧发行准备/备份/降级候选，身份不同仍不可接管',async()=>{
  await assert.rejects(prepareDatabase(old),/数据库数据版本尚不支持/)
  await assert.rejects(createBackup(old,join(root,'wrong-v1-backup')),/数据库数据版本尚不支持/)
  await prepareDatabase(next,{initialize:false})
  await assert.rejects(prepareDatabase({...next,id:randomUUID(),database:{kind:'existing',configFile:databaseConfig(next)}}),/数据库已归属/)
  assert.equal(canUseData({dataVersion:1,compatibleDataVersions:[1,2]} as never,2),false)
  await writeInstall({...next,phase:'stopped'})
  await assert.rejects(upgradeInstall({...next,phase:'stopped'},old.version,async()=>old.layout.releaseRoot),/数据兼容性/)
  assert.deepEqual(await marker(next),[{id:old.id,data_version:2}])
 })
 const backup2=join(root,'backup-2'),v2=await createBackup({...next,phase:'stopped'},backup2)
 assert.equal(v2.dataVersion,2);assert.equal(v2.version,next.version)
 await t.test('恢复必须精确匹配发行与数据版本；两版备份各自恢复并保持本人/旧正文',async()=>{
  await assert.rejects(restoreBackup(backup2,join(root,'mismatch'),{kind:'docker'},old.layout.releaseRoot),/完全匹配/)
  for(const [archive,source,version,contentVersion] of [[backup1,old,1,1],[backup2,next,2,2]] as const){
   const targetHome=join(root,'restore-'+version)
   // 即使恢复中途失败也登记随机目标身份，仅清理此次创建且标签一致的资源。
   let restored:Awaited<ReturnType<typeof restoreBackup>>
   try{restored=await restoreBackup(archive,targetHome,{kind:'docker'},source.layout.releaseRoot)}finally{
    const value=await readFile(join(targetHome,'instances/default/state.json'),'utf8').then(JSON.parse).catch(()=>undefined);if(value?.id)owned.add(value.id)
   }
   assert.notEqual(restored.id,old.id);assert.equal(restored.phase,'stopped')
   await prepareDatabase(restored,{initialize:false})
   assert.deepEqual(await marker(restored),[{id:restored.id,data_version:version}])
   pool=await databasePool(restored)
   try{const memory=(await new RoleMemoryService(pool,identity).list(human,{roleId:created.id}))[0]!;assert.equal(memory.ownerId,owner);assert.equal(memory.content.version,contentVersion);assert.deepEqual(memory.source,candidate.source)}finally{await pool.end()}
   await stopDatabase(restored)
  }
 })
 assert.equal(databaseName(old),'teloa-'+old.id)
})

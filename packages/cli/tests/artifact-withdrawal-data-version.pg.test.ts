import assert from 'node:assert/strict'
import test from 'node:test'
import {createHash,randomUUID} from 'node:crypto'
import {createRequire} from 'node:module'
import {mkdir,mkdtemp,readFile,rm,symlink,writeFile,access} from 'node:fs/promises'
import {homedir,tmpdir} from 'node:os'
import {dirname,join} from 'node:path'
import {spawnSync} from 'node:child_process'
import {Pool,stopTestContainer} from '../../backend/tests/postgres-test-lifecycle.ts'
import {ArtifactService,initializeArtifacts} from '../../backend/src/work/artifacts.ts'
import {ArtifactSnapshotStore,initializeArtifactSnapshots} from '../../backend/src/work/artifact-snapshots.ts'
import {prepareDatabase,inspectDatabase,databaseConfig} from '../src/database.ts'
import {verifyBackup,restoreBackup} from '../src/maintenance.ts'
import {upgradeInstall} from '../src/upgrade.ts'
import type {InstallState,BackupManifest} from '../src/contracts.ts'

const digest=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex')
const backendRequire=createRequire(new URL('../../backend/package.json',import.meta.url))
const {PostgreSqlContainer}=backendRequire('@testcontainers/postgresql')

/** 最小发行文件端口，不启动CLI/home/宿主；真正PG和正式prepareDatabase负责版本与备份准入。 */
async function releaseFixture(root:string,version:string,dataVersion:number,fail=false){
 await mkdir(join(root,'packages/backend/lib/work'),{recursive:true,mode:0o700})
 await mkdir(join(root,'node_modules'),{mode:0o700})
 const artifacts=new URL('../../backend/src/work/artifacts.ts',import.meta.url).href
 const snapshots=new URL('../../backend/src/work/artifact-snapshots.ts',import.meta.url).href
 const files={
  'package.json':JSON.stringify({name:'@teloa/cli',version,type:'module'}),
  'packages/backend/lib/work/initialize-database.js':`import {initializeArtifacts} from ${JSON.stringify(artifacts)};import {initializeArtifactSnapshots} from ${JSON.stringify(snapshots)};export async function initializeTeloaDatabase(pool){await initializeArtifactSnapshots(pool);await initializeArtifacts(pool);await pool.query('insert into initialization_audit values($1)',[${JSON.stringify(version)}]);${fail?'throw Error("synthetic initialization failed")':''}}`,
 }
 for(const [name,content]of Object.entries(files))await writeFile(join(root,name),content,{mode:0o600})
 await symlink(dirname(dirname(backendRequire.resolve('pg'))),join(root,'node_modules/pg'))
 await writeFile(join(root,'release-manifest.json'),JSON.stringify({schema:'teloa.release/v1',version,dshVersion:'0.2.1-rc.2',dataVersion,compatibleDataVersions:[dataVersion],files:Object.entries(files).map(([path,content])=>({path,sha256:digest(content)}))}),{mode:0o600})
}

test('数据4到5的实际PG准入：绑定备份才迁移；失败保4，成功保原件/撤回，旧读者及降级拒绝',{timeout:120000},async t=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 const root=await mkdtemp(join(tmpdir(),'teloa-withdrawal-floor-'))
 let owned:{stop:()=>Promise<unknown>}|undefined,opened:Pool|undefined
 t.after(async()=>{await opened?.end();await stopTestContainer(owned);await rm(root,{recursive:true,force:true})})
 const container=await new PostgreSqlContainer('postgres:17-alpine').withDatabase('teloa').withUsername('teloa').start()
 owned=container
 const pool=new Pool({connectionString:container.getConnectionUri()})
 opened=pool
 const fixture=join(root,'state-fixture'),runtimeRoot=join(fixture,'runtime'),config=join(root,'pg.json'),workspaceRoot=join(root,'workspace')
 await mkdir(runtimeRoot,{recursive:true,mode:0o700});await mkdir(workspaceRoot,{mode:0o700})
 await writeFile(config,JSON.stringify({connectionString:container.getConnectionUri()}),{mode:0o600})
 const layout=(version:string)=>({home:fixture,releaseRoot:join(fixture,'releases',version),instanceRoot:join(fixture,'instances/default'),dshHome:join(fixture,'dsh'),runtimeRoot,workspaceRoot})
 const old:InstallState={schema:'teloa.install/v1',id:randomUUID(),version:'0.2.0-floor4',phase:'stopped',port:49151,database:{kind:'existing',configFile:config},layout:layout('0.2.0-floor4')}
 const next:InstallState={...old,version:'0.2.1-floor5',phase:'maintenance',layout:layout('0.2.1-floor5')}
 const failed:InstallState={...next,version:'0.2.1-floor5.failed',layout:layout('0.2.1-floor5.failed')}
 await releaseFixture(old.layout.releaseRoot,old.version,4);await releaseFixture(next.layout.releaseRoot,next.version,5);await releaseFixture(failed.layout.releaseRoot,failed.version,5,true)
 await pool.query('create table teloa_installation(id uuid primary key,data_version integer not null)')
 await pool.query('insert into teloa_installation values($1,4)',[old.id])
 await pool.query('create table initialization_audit(version text not null)')
 await initializeArtifactSnapshots(pool);await initializeArtifacts(pool)
 const owner=randomUUID(),source={kind:'session' as const,id:randomUUID(),scope:'general',version:'synthetic-v1',title:'本轮原件'},identity={id:randomUUID,now:()=>new Date().toISOString()},artifacts=new ArtifactService(pool,identity,async()=>({source,sessionIds:[source.id]}))
 const bytes=Buffer.from('synthetic original'),snapshot=await new ArtifactSnapshotStore(pool).save(owner,{schema:'teloa.file-snapshot/v1',sessionId:source.id,id:'a'.repeat(64),path:'original.txt',sha256:digest(bytes),bytes:bytes.length,capturedAt:identity.now(),contentBase64:bytes.toString('base64')})
 const original=await artifacts.create(owner,{requestId:randomUUID(),source,content:{title:'原稿',sections:[{id:'body',title:'正文',text:'合成固定正文'}],snapshotIds:[snapshot],note:'保留'}})
 // 模拟data4原表；版本5的两个私有新表尚不存在。不是运行旧home或撤回已有数据。
 await pool.query('drop table teloa_artifact_input_sources;drop table teloa_artifact_withdrawals')
 const before=(await pool.query('select * from teloa_artifact_versions')).rows
 const marker=async()=>(await pool.query('select id,data_version from teloa_installation')).rows
 const audit=async()=>(await pool.query('select * from initialization_audit')).rows
 await prepareDatabase(old,{initialize:false})
 const backup=join(root,'backup4');await mkdir(backup,{mode:0o700})
 const dumped=spawnSync('docker',['exec',container.getId(),'pg_dump','--username=teloa','--format=custom','--dbname=teloa'],{maxBuffer:16*1024*1024})
 assert.equal(dumped.status,0,dumped.stderr?.toString());assert.equal(dumped.stdout.subarray(0,5).toString(),'PGDMP')
 const backupFiles={'database.dump':dumped.stdout,'installation.json':Buffer.from(JSON.stringify({workspaceRoot,port:old.port}))}
 for(const [name,body]of Object.entries(backupFiles))await writeFile(join(backup,name),body,{mode:0o600})
 const manifest:BackupManifest={schema:'teloa.backup/v1',id:randomUUID(),createdAt:identity.now(),installId:old.id,version:old.version,dataVersion:4,externalWorkspaceIncluded:false,files:Object.entries(backupFiles).map(([path,body])=>({path,sha256:digest(body)}))}
 await writeFile(join(backup,'backup-manifest.json'),JSON.stringify(manifest),{mode:0o600});assert.deepEqual(await verifyBackup(backup),manifest)
 await assert.rejects(prepareDatabase(next),/数据库数据版本/)
 await assert.rejects(prepareDatabase(next,{initialize:false,migrationBackup:backup}),/数据库数据版本/)
 await assert.rejects(prepareDatabase({...next,phase:'stopped'},{migrationBackup:backup}),/数据库数据版本/)
 assert.deepEqual(await audit(),[]);assert.deepEqual(await marker(),[{id:old.id,data_version:4}])
 await assert.rejects(prepareDatabase(failed,{migrationBackup:backup}),/数据库初始化失败/)
 assert.deepEqual(await marker(),[{id:old.id,data_version:4}]);assert.deepEqual((await pool.query('select * from teloa_artifact_versions')).rows,before)
 assert.equal((await audit()).length,1,'初始化可留下已执行DDL，失败不能伪造整库回滚或提前标记5')
 await prepareDatabase(next,{migrationBackup:backup})
 assert.deepEqual(await marker(),[{id:old.id,data_version:5}]);assert.deepEqual((await pool.query('select * from teloa_artifact_versions')).rows,before)
 const receipt=await artifacts.withdraw(owner,{requestId:randomUUID(),artifactId:original.artifactId,expectedVersion:1,source})
 await pool.query('insert into teloa_artifact_input_sources values($1,$2,$3,$4)',[owner,'synthetic-session',original.artifactId,identity.now()])
 const protectedRows=async()=>({withdrawals:(await pool.query('select * from teloa_artifact_withdrawals')).rows,inputs:(await pool.query('select * from teloa_artifact_input_sources')).rows,versions:(await pool.query('select * from teloa_artifact_versions')).rows,snapshot:(await new ArtifactSnapshotStore(pool).read(owner,snapshot))})
 const protectedBefore=await protectedRows(),calls=(await audit()).length
 await assert.rejects(prepareDatabase(old),/数据库数据版本尚不支持/)
 assert.equal(await inspectDatabase(old),'unavailable');assert.equal((await audit()).length,calls)
 await assert.rejects(upgradeInstall({...next,phase:'stopped'},old.version,async()=>old.layout.releaseRoot),/数据兼容性/)
 await assert.rejects(access(fixture+'.backups'),{code:'ENOENT'})
 await assert.rejects(restoreBackup(backup,fixture,{kind:'existing',configFile:config},next.layout.releaseRoot),/完全匹配/)
 await prepareDatabase(next)
 assert.equal(await inspectDatabase(next),'ready');assert.deepEqual(await protectedRows(),protectedBefore)
 assert.deepEqual(await artifacts.withdraw(owner,{requestId:receipt.requestId,artifactId:original.artifactId,expectedVersion:1,source}),receipt)
 const count=(await audit()).length;await pool.query('update teloa_installation set data_version=6')
 await assert.rejects(prepareDatabase(next),/数据库数据版本尚不支持/)
 assert.equal(await inspectDatabase(next),'unavailable');assert.equal((await audit()).length,count)
 assert.equal((JSON.parse(await readFile(databaseConfig(next),'utf8')) as {connectionString:string}).connectionString,container.getConnectionUri())
})

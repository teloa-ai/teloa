import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID,createHash} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {ArtifactSnapshotStore,initializeArtifactSnapshots} from '../src/work/artifact-snapshots.ts'
import {ArtifactService,initializeArtifacts} from '../src/work/artifacts.ts'
let container:StartedPostgreSqlContainer,pool:Pool
before(async()=>{process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock');process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock';container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()});await initializeArtifactSnapshots(pool);await initializeArtifacts(pool)})
after(async()=>{await pool?.end();await container?.stop()})
async function fixture(){
 const owner=randomUUID(),source={kind:'session' as const,id:randomUUID(),scope:'general',version:'bound-v1',title:'来源会话'},snapshots=new ArtifactSnapshotStore(pool)
 const snapshotId=await snapshots.save(owner,{schema:'teloa.file-snapshot/v1',sessionId:source.id,id:'a'.repeat(64),path:'a.py',sha256:createHash('sha256').update('x').digest('hex'),bytes:1,capturedAt:new Date().toISOString(),contentBase64:'eA=='})
 const service=new ArtifactService(pool,{id:randomUUID,now:()=>new Date().toISOString()},async()=>({source,sessionIds:[source.id]}))
 const content={title:'脚本',sections:[{id:'p1',title:'说明',text:'初稿'}],snapshotIds:[snapshotId],note:'首次保存'}
 return {owner,source,service,content,input:{requestId:randomUUID(),source,content}}
}
test('创建和修订幂等，固定历史版本及文件引用，旧请求不生成重复版本',async()=>{
 const f=await fixture(),[a,b]=await Promise.all([f.service.create(f.owner,f.input),f.service.create(f.owner,f.input)])
 assert.deepEqual(a,b)
 const input={artifactId:a.artifactId,expectedVersion:1,source:f.source,content:{...f.content,sections:[{id:'p1',title:'说明',text:'修订'}],note:'修改正文'}}
 const [c,d]=await Promise.all([f.service.revise(f.owner,input),f.service.revise(f.owner,input)]);assert.deepEqual(c,d);assert.equal(c.number,2)
 assert.deepEqual(await f.service.create(f.owner,f.input),a)
 const versions=await f.service.list(f.owner,{artifactId:a.artifactId});assert.equal(versions.length,2);assert.equal(versions[0]?.content.sections[0]?.text,'初稿');assert.deepEqual(versions[1]?.content.snapshotIds,f.content.snapshotIds)
 await assert.rejects(f.service.revise(f.owner,{...input,content:{...f.content,note:'其他意图'}}),{code:'teloa/version-conflict'})
 await assert.rejects(f.service.list('other',{artifactId:a.artifactId}),{code:'teloa/forbidden'})
})
test('来源变化或跨会话文件不保存，非法旧数据不静默跳过',async()=>{
 const f=await fixture()
 await assert.rejects(f.service.create(f.owner,{...f.input,source:{...f.source,version:'old'}}),{code:'teloa/version-conflict'})
 const other=await fixture();await assert.rejects(f.service.create(f.owner,{...f.input,content:{...f.content,snapshotIds:other.content.snapshotIds}}),{code:'teloa/forbidden'})
 const foreign=await new ArtifactSnapshotStore(pool).save(f.owner,{schema:'teloa.file-snapshot/v1',sessionId:other.source.id,id:'a'.repeat(64),path:'a.py',sha256:createHash('sha256').update('x').digest('hex'),bytes:1,capturedAt:new Date().toISOString(),contentBase64:'eA=='})
 await assert.rejects(f.service.create(f.owner,{...f.input,content:{...f.content,snapshotIds:[foreign]}}),{code:'teloa/forbidden'})
 const saved=await f.service.create(f.owner,f.input)
 await pool.query("update teloa_artifact_versions set content=jsonb_set(content,'{snapshotIds}','[\"bad\"]') where artifact_id=$1",[saved.artifactId])
 await assert.rejects(f.service.list(f.owner,{artifactId:saved.artifactId}),{code:'teloa/storage-corrupt'})
})
test('初版写入失败不会留下目录，原请求可在修复后继续保存',async()=>{
 const f=await fixture()
 await pool.query(`create function reject_artifact_version_test() returns trigger language plpgsql as $$ begin if new.source->>'id'='${f.source.id}' then raise exception 'version unavailable'; end if; return new; end $$;create trigger reject_artifact_version_test before insert on teloa_artifact_versions for each row execute function reject_artifact_version_test()`)
 try{await assert.rejects(f.service.create(f.owner,f.input),/version unavailable/);assert.equal((await pool.query('select * from teloa_artifacts where owner_id=$1',[f.owner])).rowCount,0)}finally{await pool.query('drop trigger reject_artifact_version_test on teloa_artifact_versions;drop function reject_artifact_version_test()')}
 const saved=await f.service.create(f.owner,f.input);assert.equal(saved.number,1)
 await pool.query('update teloa_artifacts set current_version=2000000000 where id=$1',[saved.artifactId])
 await assert.rejects(f.service.list(f.owner,{artifactId:saved.artifactId}),{code:'teloa/storage-corrupt'})
})
test('成果固定消息引用，拒绝跨会话与同消息多份快照，引用损坏显式失败',async()=>{
 const {ArtifactMessageStore}=await import('../src/work/artifact-messages.ts')
 const f=await fixture(),store=new ArtifactMessageStore(pool),message={sessionId:f.source.id,messageId:'m1',seq:3,role:'user',at:'2026-09-11T00:00:00Z',text:'原消息',interrupted:false,omittedBlocks:0,images:[]}
 const first=await store.save(f.owner,message),other=await store.save(f.owner,{...message,sessionId:'other'})
 await assert.rejects(f.service.create(f.owner,{...f.input,content:{...f.content,messageSnapshotIds:[other]}}),{code:'teloa/forbidden'})
 const duplicate=await store.save(f.owner,{...message,text:'另一正文'})
 await assert.rejects(f.service.create(f.owner,{...f.input,content:{...f.content,messageSnapshotIds:[first,duplicate]}}),{code:'teloa/invalid-input'})
 const saved=await f.service.create(f.owner,{...f.input,content:{...f.content,messageSnapshotIds:[first]}})
 assert.deepEqual((await f.service.list(f.owner,{artifactId:saved.artifactId}))[0]!.content.messageSnapshotIds,[first])
 await pool.query('delete from teloa_artifact_messages where artifact_id=$1',[saved.artifactId])
 await assert.rejects(f.service.list(f.owner,{artifactId:saved.artifactId}),{code:'teloa/storage-corrupt'})
})
test('同事务定版不自行提交，调用方回滚后不留成果目录与版本',async()=>{
 const f=await fixture(),client=await pool.connect()
 try{
  await client.query('begin')
  const saved=await f.service.createInTransaction(client,f.owner,f.input)
  assert.equal(saved.number,1)
  // 同一事务内重放同一请求只得到同一版，不写第二版。
  assert.deepEqual(await f.service.createInTransaction(client,f.owner,f.input),saved)
  await assert.rejects(f.service.createInTransaction(client,f.owner,{...f.input,content:{...f.content,note:'另一份意图'}}),{code:'teloa/conflict'})
  await client.query('rollback')
 }finally{client.release()}
 assert.equal((await pool.query('select * from teloa_artifacts where owner_id=$1',[f.owner])).rowCount,0)
 assert.equal((await f.service.create(f.owner,f.input)).number,1)
})

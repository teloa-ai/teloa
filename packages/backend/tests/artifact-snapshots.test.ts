import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {ArtifactSnapshotStore,initializeArtifactSnapshots} from '../src/work/artifact-snapshots.ts'
let container:StartedPostgreSqlContainer,pool:Pool
before(async()=>{process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock');process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock';container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()});await initializeArtifactSnapshots(pool)})
after(async()=>{await pool?.end();await container?.stop()})
const file=(text:string)=>({schema:'teloa.file-snapshot/v1' as const,sessionId:randomUUID(),id:'a'.repeat(64),path:'out/script.py',sha256:createHash('sha256').update(text).digest('hex'),bytes:Buffer.byteLength(text),capturedAt:new Date().toISOString(),contentBase64:Buffer.from(text).toString('base64')})
test('保存并发去重，重新构造存储后仍保留原始字节与时间',async()=>{
 const owner=randomUUID(),store=new ArtifactSnapshotStore(pool),input=file('print(1)\r\n'),[a,b]=await Promise.all([store.save(owner,input),store.save(owner,input)])
 assert.equal(a,b);assert.deepEqual(await new ArtifactSnapshotStore(pool).read(owner,a),input)
 await assert.rejects(store.read('other',a),{code:'teloa/forbidden'})
 const next={...input,contentBase64:Buffer.from('new').toString('base64'),bytes:3,sha256:createHash('sha256').update('new').digest('hex')},id=await store.save(owner,next)
 assert.notEqual(id,a);assert.deepEqual(await store.read(owner,a),input)
})
test('损坏或伪造的字节摘要不能保存，坏数据库记录不能作为可用快照返回',async()=>{
 const owner=randomUUID(),store=new ArtifactSnapshotStore(pool),input=file('correct')
 await assert.rejects(store.save(owner,{...input,sha256:'b'.repeat(64)}),{code:'teloa/invalid-input'})
 const id=await store.save(owner,input)
 await pool.query("update teloa_artifact_snapshots set content=jsonb_set(content,'{sha256}',to_jsonb($3::text)) where owner_id=$1 and snapshot_id=$2",[owner,id,'b'.repeat(64)])
 await assert.rejects(store.read(owner,id),{code:'teloa/storage-corrupt'})
 await assert.rejects(store.save(owner,input),{code:'teloa/storage-corrupt'})
})

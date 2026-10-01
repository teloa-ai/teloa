import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {ArtifactMessageStore,initializeArtifactMessages} from '../src/work/artifact-messages.ts'
let container:StartedPostgreSqlContainer,pool:Pool
before(async()=>{process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock');process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock';container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()});await initializeArtifactMessages(pool)})
after(async()=>{await pool?.end();await container?.stop()})
const input={sessionId:'s1',messageId:'m1',seq:2,role:'assistant',at:'2026-09-11T00:00:00Z',text:'固定原正文',interrupted:false,omittedBlocks:1,images:[]}
test('原消息快照并发去重，重建读取与跨本人隔离',async()=>{
 const owner=randomUUID(),store=new ArtifactMessageStore(pool),[a,b]=await Promise.all([store.save(owner,input),store.save(owner,input)])
 assert.equal(a,b);assert.deepEqual(await new ArtifactMessageStore(pool).read(owner,a),input)
 await assert.rejects(store.read('other',a),{code:'teloa/forbidden'})
 const next=await store.save(owner,{...input,text:'另一个内容'})
 assert.notEqual(next,a);assert.deepEqual(await store.read(owner,a),input)
})
test('损坏原消息拒绝读取，重复捕获不能掩盖损坏',async()=>{
 const owner=randomUUID(),store=new ArtifactMessageStore(pool),id=await store.save(owner,input)
 await pool.query("update teloa_artifact_message_snapshots set content=jsonb_set(content,'{text}',to_jsonb('损坏'::text)) where owner_id=$1 and snapshot_id=$2",[owner,id])
 await assert.rejects(store.read(owner,id),{code:'teloa/storage-corrupt'})
 await assert.rejects(store.save(owner,input),{code:'teloa/storage-corrupt'})
})

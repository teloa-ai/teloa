import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID,createHash} from 'node:crypto'
import {Pool} from './postgres-test-lifecycle.ts'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {createDirectDeviceStore} from '../src/devices/direct-store.ts'
let pool:Pool,container:StartedPostgreSqlContainer
before(async()=>{container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()})},{timeout:120000})
after(async()=>{await pool?.end();await container?.stop()})
const hash=(v:string)=>createHash('sha256').update(v).digest('hex')
async function fixture(){
 const identity={ownerId:randomUUID(),installationId:randomUUID()},store=createDirectDeviceStore(pool,identity)
 await store.initialize()
 const binding={id:randomUUID(),assistantSessionId:randomUUID(),contextVersion:1,credentialDigest:hash(randomUUID())}
 await store.register(binding)
 return {store,binding,identity}
}
test('先保留 capture 与固定请求，重复和重启不能再次识别或派发',async()=>{
 const {store,binding,identity}=await fixture(),captureId=randomUUID()
 const [one,two]=await Promise.all([store.reserve(binding.id,captureId),store.reserve(binding.id,captureId)])
 assert.equal(Number(one.created)+Number(two.created),1)
 assert.equal(one.record.nativeRequestId,two.record.nativeRequestId)
 await store.transcribed(binding.id,captureId,'你好。')
 const claims=await Promise.all([store.claim(binding.id,captureId),store.claim(binding.id,captureId)])
 assert.equal(claims.filter(Boolean).length,1)
 const restored=createDirectDeviceStore(pool,identity)
 assert.equal((await restored.reserve(binding.id,captureId)).created,false)
 assert.equal(await restored.claim(binding.id,captureId),false)
 assert.deepEqual(await restored.nativeRequestIds(),[one.record.nativeRequestId])
})
test('安装隔离、撤权屏障，配置重读不会恢复已撤销权限',async()=>{
 const {store,binding}=await fixture(),captureId=randomUUID()
 await store.reserve(binding.id,captureId);await store.transcribed(binding.id,captureId,'不能重发。')
 const foreign=createDirectDeviceStore(pool,{ownerId:randomUUID(),installationId:randomUUID()})
 await assert.rejects(foreign.get(binding.id,captureId))
 await store.revoke(binding.id);await store.register(binding)
 assert.equal(await store.authorize(binding.credentialDigest),null)
 assert.equal(await store.claim(binding.id,captureId),false)
})

test('配对完成写入失败必须回滚凭据，取消后不能留下可连接的授权',async()=>{
 const {store,binding}=await fixture(),id=randomUUID(),credentialDigest=hash('atomic-pair-'+id),stamp=Date.now()
 const ready={id,state:'ready',createdAt:stamp,expiresAt:stamp+300000,nonce:randomUUID(),digest:'d'.repeat(64),allowApprovals:true,assistantSessionId:binding.assistantSessionId,contextVersion:1}
 await store.savePairing(ready)
 // 独立测试数据库中制造第二次持久写入失败，验证第一次插入也被回滚。
 await pool.query(`alter table teloa_device_pairing_jobs add constraint fail_paired_record check (id <> '${id}' or record->>'state' <> 'paired')`)
 const input={...binding,id,credentialDigest,allowApprovals:true}
 const paired={...ready,state:'paired'},cancelled={...ready,state:'cancelled'}
 await assert.rejects(store.completePairing(paired,input))
 assert.equal(await store.authorize(credentialDigest),null)
 assert.equal((await store.readPairing(id) as {state:string}).state,'ready')
 await store.savePairing(cancelled)
 await pool.query('alter table teloa_device_pairing_jobs drop constraint fail_paired_record')
 await assert.rejects(store.completePairing(paired,input))
 assert.equal(await store.authorize(credentialDigest),null)
 const second={...ready,id:randomUUID()};await store.savePairing(second)
 const secondPaired={...second,state:'paired'}
 await store.completePairing(secondPaired,{...input,id:second.id})
 assert.equal((await store.authorize(credentialDigest))?.allowApprovals,true)
 assert.equal((await store.readPairing(second.id) as {state:string}).state,'paired')
})

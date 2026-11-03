import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID,createHash} from 'node:crypto'
import {Pool} from './postgres-test-lifecycle.ts'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {createDirectDeviceStore} from '../src/devices/direct-store.ts'
import {createDevicePairing,type DevicePairingJob} from '../../harness-dsh/src/device-pairing.ts'
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

test('配对完成等待真实行锁时取消，事务不能登记凭据或覆盖取消状态',{timeout:15000},async()=>{
 const {store,binding}=await fixture()
 const pairing=createDevicePairing({secret:Buffer.alloc(32,11),host:'127.0.0.1',port:32101,serverName:'fixture.test',ca:'synthetic-certificate',
  target:async()=>({assistantSessionId:binding.assistantSessionId,contextVersion:1}),
  save:job=>store.savePairing(job),load:async id=>await store.readPairing(id) as DevicePairingJob|undefined,
  finish:(job,input,assertCurrent)=>store.completePairing(job,input,assertCurrent),
 })
 const job=await pairing.begin({allowApprovals:true}),provision=await pairing.provision(job.id,{nonce:randomUUID(),confirmed:true})
 const credentialDigest=hash(JSON.parse(provision.configuration).credential),blocker=await pool.connect()
 try{
  await blocker.query('begin');await blocker.query('select id from teloa_device_pairing_jobs where id=$1 for update',[job.id])
  const pending=pairing.complete(job.id,provision.digest),outcome=pending.then(value=>({value,error:undefined}),error=>({value:undefined,error}))
  let waiting=false
  for(let i=0;i<100&&!waiting;i++){
   waiting=Number((await pool.query("select count(*) as n from pg_stat_activity where pid<>pg_backend_pid() and wait_event_type='Lock' and query like 'select record from teloa_device_pairing_jobs%for update'")).rows[0].n)>0
   if(!waiting)await new Promise(resolve=>setTimeout(resolve,10))
  }
  assert.equal(waiting,true,'必须实际进入 store 的 PostgreSQL 行锁等待')
  const cancelled=pairing.cancel(job.id),cancelOutcome=cancelled.then(value=>({value,error:undefined}),error=>({value:undefined,error}))
  await blocker.query('commit')
  const result=await outcome,cancel=await cancelOutcome
  assert.equal(result.error?.code,'teloa/forbidden');assert.equal(cancel.error,undefined);assert.equal(cancel.value?.state,'cancelled')
  assert.equal(await store.authorize(credentialDigest),null)
  assert.equal((await store.readPairing(job.id) as DevicePairingJob).state,'cancelled')
 }finally{await blocker.query('rollback');blocker.release()}
})

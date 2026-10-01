import test,{after,before} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {PendingRequestService,initializePendingRequests} from '../src/work/pending-requests.ts'

let container:StartedPostgreSqlContainer,pool:Pool
const now='2026-09-18T00:00:00.000Z'
before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start()
 pool=new Pool({connectionString:container.getConnectionUri()})
 await initializePendingRequests(pool)
},{timeout:180_000})
after(async()=>{await pool?.end();await container?.stop()})

const input=(requestId=randomUUID())=>({requestId,fields:{name:'待核对数字员工'}})
const fixture=()=>({owner:randomUUID(),service:new PendingRequestService(pool)})

test('服务端待恢复目录只暴露元数据，并按本人隔离',async()=>{
 const {owner,service}=fixture(),request=input()
 await service.reserve(owner,'roles/create',request,now)
 const rows=await service.list(owner)
 assert.equal(rows.length,1)
 assert.deepEqual(Object.keys(rows[0]!).sort(),['createdAt','endpoint','requestId','updatedAt'])
 assert.equal(rows[0]!.requestId,request.requestId.toLowerCase())
 assert.equal(rows[0]!.endpoint,'roles/create')
 assert.deepEqual(await service.list(randomUUID()),[])
})

test('同一身份只能登记同一命令与不可变载荷，原请求只从服务端读取',async()=>{
 const {owner,service}=fixture(),request=input()
 await service.reserve(owner,'roles/create',request,now)
 await service.reserve(owner,'roles/create',{...request,requestId:request.requestId.toUpperCase()},now)
 await assert.rejects(service.reserve(owner,'tasks/create',request,now),{code:'teloa/conflict'})
 await assert.rejects(service.reserve(owner,'roles/create',{...request,fields:{name:'被替换'}},now),{code:'teloa/conflict'})
 const stored=await service.readForRecovery(owner,request.requestId)
 assert.equal(stored.endpoint,'roles/create')
 assert.deepEqual(stored.payload,{...request,requestId:request.requestId.toLowerCase()})
 await assert.rejects(service.readForRecovery(randomUUID(),request.requestId),{code:'teloa/not-found'})
})

test('浏览器确认、完成和确定性拒绝不再作为待恢复项，未知错误码保留给操作者核对',async()=>{
 const {owner,service}=fixture(),completed=input(),rejected=input(),pending=input()
 await service.reserve(owner,'roles/create',completed,now)
 await service.reserve(owner,'roles/create',rejected,now)
 await service.reserve(owner,'roles/create',pending,now)
 await assert.rejects(service.acknowledge(owner,completed.requestId,'2026-09-18T00:01:00.000Z'),{code:'teloa/conflict'})
 await service.markResponseReady(owner,completed.requestId,'2026-09-18T00:01:00.000Z')
 assert.equal((await service.list(owner)).length,3,'产出成功结果仍须等待客户端收讫确认')
 await service.acknowledge(owner,completed.requestId,'2026-09-18T00:01:00.000Z')
 await service.acknowledge(owner,completed.requestId,'2026-09-18T00:01:00.000Z')
 await service.reject(owner,rejected.requestId,'teloa/version-conflict','2026-09-18T00:02:00.000Z')
 assert.deepEqual((await service.list(owner)).map(row=>row.requestId),[pending.requestId.toLowerCase()])
 await assert.rejects(service.readForRecovery(owner,completed.requestId),{code:'teloa/not-found'})
 await assert.rejects(service.readForRecovery(owner,rejected.requestId),{code:'teloa/not-found'})
 await assert.rejects(service.acknowledge(owner,rejected.requestId,now),{code:'teloa/conflict'})
 await assert.rejects(service.acknowledge(randomUUID(),pending.requestId,now),{code:'teloa/not-found'})
})

test('白名单、请求身份、大小和凭据字段都在入库前拒绝',async()=>{
 const {owner,service}=fixture(),request=input()
 await assert.rejects(service.reserve(owner,'roles/list' as never,request,now),{code:'teloa/invalid-input'})
 await assert.rejects(service.reserve(owner,'roles/create',{fields:{}},now),{code:'teloa/invalid-input'})
 await assert.rejects(service.reserve(owner,'roles/create',{...request,fields:{apiKey:'never-store-me'}},now),{code:'teloa/invalid-input'})
 await assert.rejects(service.reserve(owner,'roles/create',{...request,fields:{note:'x'.repeat(100_001)}},now),{code:'teloa/invalid-input'})
 assert.deepEqual(await service.list(owner),[])
})

test('凭据键按子串拦截：嵌套 credentials、*_TOKEN、privateKey 等一律拒绝入表；im/channels/save 不在白名单',async()=>{
 const {owner,service}=fixture(),request=input()
 await assert.rejects(service.reserve(owner,'im/channels/save' as never,{requestId:randomUUID(),channelId:'telegram',kind:'telegram',credentials:{TELEGRAM_BOT_TOKEN:'x'}},now),{code:'teloa/invalid-input'})
 await assert.rejects(service.reserve(owner,'im/channels/enable',{requestId:randomUUID(),channelId:'telegram',credentials:{TELEGRAM_BOT_TOKEN:'x'}},now),{code:'teloa/invalid-input'})
 for(const key of ['TELEGRAM_BOT_TOKEN','FEISHU_APP_SECRET','accessToken','dbPassword','credentialsRef','Proxy-Authorization','EXA_API_KEY','api-key','privateKey','PRIVATE_KEY'])
  await assert.rejects(service.reserve(owner,'roles/create',{...request,fields:{[key]:'x'}},now),{code:'teloa/invalid-input'},key)
 assert.deepEqual(await service.list(owner),[])
})

test('初始化清除旧版登记的 im/channels/save 行（请求体含凭据原值）',async()=>{
 const {owner,service}=fixture()
 await pool.query("insert into teloa_pending_request_registry(owner_id,request_id,endpoint,request_spec,state,created_at,updated_at) values($1,$2,'im/channels/save',$3,'pending',$4,$4)",[owner,randomUUID(),JSON.stringify({credentials:{TELEGRAM_BOT_TOKEN:'x'}}),now])
 await initializePendingRequests(pool)
 assert.equal((await pool.query("select 1 from teloa_pending_request_registry where endpoint='im/channels/save'")).rowCount,0)
 assert.deepEqual(await service.list(owner),[])
})

test('重复初始化为旧登记表补齐收讫状态且不丢原请求',async()=>{
 const {owner,service}=fixture(),request=input()
 await service.reserve(owner,'tasks/create',request,now)
 await initializePendingRequests(pool)
 await initializePendingRequests(pool)
 assert.equal((await service.list(owner)).length,1)
 await assert.rejects(service.acknowledge(owner,request.requestId,now),{code:'teloa/conflict'})
 await service.markResponseReady(owner,request.requestId,now)
 await service.acknowledge(owner,request.requestId,now)
 assert.deepEqual(await service.list(owner),[])
})

test('discard 删除本人该请求的整行（任何状态），不动他人同身份记录',async()=>{
 const {owner,service}=fixture(),other=randomUUID(),request=input()
 await service.reserve(owner,'roles/create',request,now)
 await service.reserve(other,'roles/create',request,now)
 await service.reject(owner,request.requestId,'teloa/invalid-input',now)
 await service.discard(owner,request.requestId.toUpperCase())
 assert.equal(Number((await pool.query('select count(*)::int as count from teloa_pending_request_registry where owner_id=$1 and request_id=$2',[owner,request.requestId])).rows[0].count),0)
 assert.equal((await service.list(other)).length,1)
 const pending=input()
 await service.reserve(owner,'roles/create',pending,now)
 await service.discard(owner,pending.requestId)
 await assert.rejects(service.readForRecovery(owner,pending.requestId),{code:'teloa/not-found'})
 await service.discard(owner,randomUUID())
 await assert.rejects(service.discard(owner,'not-a-uuid'),{code:'teloa/invalid-input'})
})

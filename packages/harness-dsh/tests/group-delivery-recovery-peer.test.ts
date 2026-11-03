import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {homedir} from 'node:os'
import {PostgreSqlContainer} from '@testcontainers/postgresql'
import {openResourceDatabase,PendingRequestService} from '@teloa/backend'
import {host,type RpcReply} from './fixtures/production-host.ts'
import {apply} from '../src/index.ts'

test('真实/teloa RPC：delivery直接与pending恢复都仅本人browser peer可达，非browser在reserve前拒绝',{timeout:180000},async t=>{
 const root=await mkdtemp(join(process.cwd(),'.tmp-text-recovery-peer-')),runtime=host(),previousRoot=process.env.TELOA_PROJECT_ROOT,owner='local:teloa-owner'
 let container:Awaited<ReturnType<InstanceType<typeof PostgreSqlContainer>['start']>>|undefined,database:Awaited<ReturnType<typeof openResourceDatabase>>|undefined
 t.after(async()=>{await runtime.ctx.fiber.dispose();await database?.close();await container?.stop();if(previousRoot===undefined)delete process.env.TELOA_PROJECT_ROOT;else process.env.TELOA_PROJECT_ROOT=previousRoot;await rm(root,{recursive:true,force:true})})
 process.env.TELOA_PROJECT_ROOT=process.cwd();process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock');process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').withDatabase('teloa').start()
 const runtimeRoot=join(root,'.runtime/teloa'),config=join(runtimeRoot,'database.json')
 await mkdir(join(runtimeRoot,'skills'),{recursive:true});await writeFile(config,JSON.stringify({connectionString:container.getConnectionUri()}),{mode:0o600})
 await mkdir(join(root,'.runtime/dsh/profiles/teloa'),{recursive:true});await writeFile(join(root,'.runtime/dsh/profiles/teloa/package.json'),JSON.stringify({dsh:{profile:{bundles:[],patchReload:'startup'}}}))
 database=await openResourceDatabase(config,{id:randomUUID,now:()=>new Date().toISOString()})
 await runtime.ready(join(root,'.runtime/dsh'));await apply(runtime.ctx,{projectRoot:root})
 const browserPeer={id:'owner-browser'},foreignPeer={id:'non-browser-sdk'};Reflect.set(runtime.ctx.connection,'browserPeer',browserPeer)
 const rpc=runtime.rpc as (endpoint:string,payload:unknown,signal:AbortSignal,peer?:unknown)=>Promise<RpcReply>,command={groupId:randomUUID(),messageId:randomUUID(),roleId:randomUUID(),requestId:randomUUID(),itemId:randomUUID(),expectedBasisSha256:'0'.repeat(64),capability:'text'},target={groupId:command.groupId,messageId:command.messageId,roleId:command.roleId}
 const counts=async()=>({pending:Number((await database!.pool.query('select count(*) n from teloa_pending_request_registry')).rows[0].n),accepted:Number((await database!.pool.query('select count(*) n from teloa_group_delivery_recoveries')).rows[0].n),negative:Number((await database!.pool.query('select count(*) n from teloa_group_delivery_recovery_rejections')).rows[0].n)})
 const before=await counts()
 for(const peer of [foreignPeer,{},undefined])for(const endpoint of ['groups/delivery/inspect','groups/delivery/recover','groups/delivery/receipt']){
  const response=await rpc(endpoint,endpoint.endsWith('inspect')?target:command,AbortSignal.timeout(10000),peer);assert.equal(response.error?.code,'teloa/forbidden',endpoint)
 }
 assert.deepEqual(await counts(),before,'非browser不得登记pending或业务/负回执')
 const unobserved=await rpc('groups/delivery/receipt',command,AbortSignal.timeout(10000),browserPeer);assert.equal(unobserved.ok,true);assert.equal((unobserved.value as {state:string}).state,'unobserved')
 const inspected=await rpc('groups/delivery/inspect',target,AbortSignal.timeout(10000),browserPeer);assert.equal(inspected.error?.code,'teloa/conflict','本人通过peer闸后按真实不存在原工作返回业务拒绝')
 const ownerRecovery=await rpc('groups/delivery/recover',command,AbortSignal.timeout(10000),browserPeer);assert.equal(ownerRecovery.error?.code,'teloa/conflict')
 const negative=await rpc('groups/delivery/receipt',command,AbortSignal.timeout(10000),browserPeer);assert.equal(negative.ok,true);assert.equal((negative.value as {state:string}).state,'not-accepted')
 const pendingCommand={...command,requestId:randomUUID()};await new PendingRequestService(database.pool).reserve(owner,'groups/delivery/recover',pendingCommand,new Date().toISOString())
 const original=(await database.pool.query('select * from teloa_pending_request_registry where owner_id=$1 and request_id=$2',[owner,pendingCommand.requestId])).rows[0],pendingBefore=await counts()
 const bypass=await rpc('requests/pending/recover',{requestId:pendingCommand.requestId},AbortSignal.timeout(10000),foreignPeer);assert.equal(bypass.error?.code,'teloa/forbidden')
 assert.deepEqual(await counts(),pendingBefore);assert.deepEqual((await database.pool.query('select * from teloa_pending_request_registry where owner_id=$1 and request_id=$2',[owner,pendingCommand.requestId])).rows[0],original,'非browser原请求恢复不得改变登记/响应状态')
 const ownerReplay=await rpc('requests/pending/recover',{requestId:pendingCommand.requestId},AbortSignal.timeout(10000),browserPeer);assert.equal(ownerReplay.error?.code,'teloa/conflict')
 const replayReceipt=await rpc('groups/delivery/receipt',pendingCommand,AbortSignal.timeout(10000),browserPeer);assert.equal(replayReceipt.ok,true);assert.equal((replayReceipt.value as {state:string}).state,'not-accepted');assert.deepEqual(runtime.modelCalls,[])
})

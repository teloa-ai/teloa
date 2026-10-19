import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {Pool} from './postgres-test-lifecycle.ts'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import * as implementation from '../src/devices/store.ts'

let pool:Pool,container:StartedPostgreSqlContainer
before(async()=>{container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()})},{timeout:120000})
after(async()=>{await pool?.end();await container?.stop()})
async function fixture(){
 assert.equal(typeof implementation.createHardwareStore,'function')
 await implementation.initializeHardwareDevices(pool)
 let time=Date.parse('2026-10-16T10:00:00.000Z')
 const identity={ownerId:'hardware-test:'+randomUUID(),installationId:randomUUID(),now:()=>new Date(time).toISOString()}
 const store=implementation.createHardwareStore(pool,identity)
 const binding=await store.bind({assistantSessionId:'session-'+randomUUID(),contextVersion:1})
 return {store,binding,identity,advance:(ms:number)=>{time+=ms}}
}
test('并发准备复用固定操作，派发占位只能成功一次',async()=>{
 const {store,binding}=await fixture()
 const [one,two]=await Promise.all([store.prepare(binding.id,'整理测试任务。'),store.prepare(binding.id,'整理测试任务。')])
 assert.equal(one.id,two.id)
 await assert.rejects(store.prepare(binding.id,'别的任务。'))
 const claims=await Promise.all([store.markDispatching(one.id),store.markDispatching(one.id)])
 assert.equal(claims.filter(Boolean).length,1)
 const reloaded=implementation.createHardwareStore(pool,{ownerId:binding.ownerId,installationId:binding.installationId})
 assert.equal((await reloaded.get(binding.id,one.id))?.nativeRequestId,one.nativeRequestId)
 assert.equal(await reloaded.markDispatching(one.id),false)
})
test('过期只拒绝尚未派发项，已受理项仍可查，其他安装不可读',async()=>{
 const {store,binding,identity,advance}=await fixture()
 const expired=await store.prepare(binding.id,'过期任务。');advance(300001)
 assert.equal(await store.markDispatching(expired.id),false)
 const op=await store.prepare(binding.id,'新的任务。')
 assert.equal(await store.markDispatching(op.id),true)
 await store.recordReceipt(op.id,{state:'accepted',resultRef:null})
 advance(3600000)
 assert.equal((await store.get(binding.id,op.id))?.state,'accepted')
 const foreign=implementation.createHardwareStore(pool,{...identity,installationId:randomUUID()})
 await assert.rejects(foreign.get(binding.id,op.id))
})
test('撤销推进授权世代，旧准备项不能派发，重复查询不能更换请求',async()=>{
 const {store,binding}=await fixture(),op=await store.prepare(binding.id,'准备任务。')
 await store.revoke(binding.id)
 assert.equal((await store.readBinding(binding.id)).grantVersion,binding.grantVersion+1)
 assert.equal(await store.markDispatching(op.id),false)
 await assert.rejects(store.prepare(binding.id,'迟到任务。'))
})

test('最近操作按实际写入顺序选择，不按随机 UUID 或相同时间排序',async()=>{
 const {store,binding}=await fixture(),op=await store.prepare(binding.id,'第一个请求。')
 const second={...op,id:'00000000-0000-4000-8000-000000000001',nativeRequestId:'00000000-0000-4000-8000-000000000002',state:'accepted'}
 await pool.query('insert into teloa_device_inputs(id,binding_id,native_request_id,record) values($1,$2,$3,$4)',[second.id,binding.id,second.nativeRequestId,second])
 assert.equal((await store.get(binding.id))?.id,second.id)
})

test('冷启动恢复外部请求命名空间仍隔离本人和安装',async()=>{
 const one=await fixture(),two=await fixture()
 const op=await one.store.prepare(one.binding.id,'恢复请求身份。')
 assert.equal(typeof one.store.nativeRequestIds,'function')
 assert.deepEqual(await one.store.nativeRequestIds(),[op.nativeRequestId])
 assert.deepEqual(await two.store.nativeRequestIds(),[])
})
test('撤销及重新授权结束旧准备项，新工作立即可准备且已受理工作保留',async()=>{
 const {store,binding}=await fixture(),accepted=await store.prepare(binding.id,'已受理工作')
 await store.markDispatching(accepted.id);await store.recordReceipt(accepted.id,{state:'accepted',resultRef:null})
 const old=await store.prepare(binding.id,'待提交旧工作')
 await store.revoke(binding.id)
 assert.equal((await store.get(binding.id,old.id))?.state,'rejected')
 await store.updateGrant(binding.id,binding.scopes)
 const next=await store.prepare(binding.id,'新的工作')
 await store.updateGrant(binding.id,binding.scopes)
 assert.equal((await store.get(binding.id,next.id))?.state,'rejected')
 assert.ok(await store.prepare(binding.id,'新一轮工作'))
 assert.equal((await store.get(binding.id,accepted.id))?.state,'accepted')
})

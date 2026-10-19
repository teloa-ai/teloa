import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {Pool} from '../../backend/tests/postgres-test-lifecycle.ts'
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {createHardwareStore,initializeHardwareDevices,createDirectDeviceStore} from '@teloa/backend'
import {hardwareScopes,type HardwareBinding} from '@teloa/contract'
let pool:Parameters<typeof initializeHardwareDevices>[0],container:StartedPostgreSqlContainer
before(async()=>{container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()});await initializeHardwareDevices(pool)},{timeout:120000})
after(async()=>{await pool?.end();await container?.stop()})
async function fixture(){
 const implementation=await import('../src/assistant-channel-host.ts').catch(()=>({createAssistantChannelHost:undefined}))
 assert.equal(typeof implementation.createAssistantChannelHost,'function')
 const store=createHardwareStore(pool,{ownerId:randomUUID(),installationId:randomUUID()})
 let inputs=0,ensures=0,release:()=>void=()=>{}
 let held:Promise<void>|undefined
 const host=implementation.createAssistantChannelHost!({store:async()=>store,allowed:()=>true,workSignal:new AbortController().signal,waitMs:0,
  ensure:async()=>{ensures++;if(held)await held;return {assistantSessionId:'original-assistant',contextVersion:1}},
  verify:async(binding:HardwareBinding)=>{assert.equal(binding.assistantSessionId,'original-assistant');return ()=>{}},
  dispatch:async(_op:unknown,_binding:unknown,assertCurrent:()=>void)=>{assertCurrent();inputs++},
  read:async(op:{id:string})=>({operationId:op.id,state:'pending' as const,speakableText:'处理中',resultRef:null}),
 })
 return {host,store,get inputs(){return inputs},get ensures(){return ensures},hold(){held=new Promise(resolve=>{release=resolve})},release(){release()}}
}
test('装载只登记管理入口；授权才绑定原助手，并发提交只派发一次，卸载不删除原记录',async()=>{
 const f=await fixture(),lease=f.host.service.attach({id:'xiaozhi-mcp',handle:async()=>({managed:true})})
 assert.equal((await lease.snapshot()).enabled,false);assert.equal(f.ensures,0)
 await assert.rejects(lease.requests.prepare('未授权'),{code:'teloa/forbidden'})
 await lease.updateGrant(hardwareScopes)
 const prepared=await lease.requests.prepare('整理联调清单')
 await Promise.all([lease.requests.submit(prepared.operationId),lease.requests.submit(prepared.operationId)])
 assert.equal(f.inputs,1)
 assert.deepEqual(await f.host.handle('devices/status',{},new AbortController().signal),{managed:true})
 await lease.close()
 await assert.rejects(lease.requests.result(prepared.operationId),{code:'teloa/forbidden'})
 assert.ok(await f.store.get((await f.store.current())!.id,prepared.operationId))
 assert.deepEqual(await f.host.handle('devices/status',{},new AbortController().signal),{available:false})
})
test('撤销同步关闭准入；更早等待中的启用不能重新开放授权',async()=>{
 const f=await fixture(),lease=f.host.service.attach({id:'xiaozhi-mcp',handle:async()=>null})
 f.hold();const enabling=lease.updateGrant(hardwareScopes)
 const rejected=assert.rejects(enabling,{code:'teloa/forbidden'})
 await new Promise(resolve=>setImmediate(resolve))
 const revoked=lease.revoke()
 await assert.rejects(lease.requests.prepare('迟到请求'),{code:'teloa/forbidden'})
 f.release();await rejected;await revoked
 assert.equal((await lease.snapshot()).enabled,false)
 assert.equal(f.inputs,0);await lease.close()
})
test('已有硬件来源时身份缺失或不匹配须拒绝，不能生成新身份漏掉冷恢复来源',async t=>{
 const root=await mkdtemp(join(tmpdir(),'teloa-hardware-identity-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const implementation=await import('../src/assistant-channel-host.ts') as Record<string,any>
 assert.equal(typeof implementation.readAssistantChannelInstallation,'function')
 const ownerId=randomUUID(),read=()=>implementation.readAssistantChannelInstallation(pool,ownerId,root)
 const installationId=await read(),store=createHardwareStore(pool,{ownerId,installationId})
 const binding=await store.bind({assistantSessionId:'original-assistant',contextVersion:1})
 const op=await store.prepare(binding.id,'恢复原硬件请求')
 const path=join(root,'usage-stats','installation-id.json'),original=await readFile(path,'utf8')
 assert.equal(await read(),installationId)
 assert.deepEqual(await store.nativeRequestIds(),[op.nativeRequestId])
 await rm(path)
 await assert.rejects(read(),{code:'teloa/storage-corrupt'})
 await assert.rejects(readFile(path),{code:'ENOENT'})
 await writeFile(path,JSON.stringify({installationId:randomUUID()}))
 await assert.rejects(read(),{code:'teloa/storage-corrupt'})
 await writeFile(path,original)
 assert.equal(await read(),installationId)
})
test('只有直连历史且监听已禁用时，原安装身份和受限来源仍必须恢复',async t=>{
 const root=await mkdtemp(join(tmpdir(),'teloa-direct-identity-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const {readAssistantChannelInstallation}=await import('../src/assistant-channel-host.ts'),ownerId=randomUUID()
 const installationId=await readAssistantChannelInstallation(pool,ownerId,root);assert.ok(installationId)
 const store=createDirectDeviceStore(pool,{ownerId,installationId});await store.initialize()
 const binding=await store.register({id:randomUUID(),assistantSessionId:randomUUID(),contextVersion:1,credentialDigest:'a'.repeat(64)}),capture=await store.reserve(binding.id,randomUUID())
 assert.deepEqual(await store.nativeRequestIds(),[capture.record.nativeRequestId])
 await writeFile(join(root,'direct-device.json'),JSON.stringify({enabled:false}))
 assert.equal(await readAssistantChannelInstallation(pool,ownerId,root),installationId)
 await rm(join(root,'usage-stats','installation-id.json'))
 await assert.rejects(readAssistantChannelInstallation(pool,ownerId,root),{code:'teloa/storage-corrupt'})
})

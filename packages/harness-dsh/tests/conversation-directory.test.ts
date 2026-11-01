import test from 'node:test'
import assert from 'node:assert/strict'
import {ConversationDirectoryChanges} from '../src/conversation-directory.ts'
import {ConversationService, type ConversationRepository} from '../../backend/src/work/conversations.ts'

test('已有会话反复ensure或adopt重放不发布失效，真实新增才唤醒目录',async()=>{
 const changes=new ConversationDirectoryChanges(),signal=new AbortController().signal
 let rows:Awaited<ReturnType<ConversationRepository['read']>>=[],sequence=0,writes=0,inspections=0
 const repository=changes.trackWrites({read:async()=>structuredClone(rows),write:async(value:typeof rows)=>{writes++;rows=structuredClone(value)}})
 const service=new ConversationService(repository,{create:async id=>id,inspect:async()=>{inspections++}},{id:()=> 'conversation-'+(++sequence),now:()=> '2026-10-30T10:00:00Z'}),owner='local:teloa-owner'
 await service.ensure(owner,{sessionId:'known'})
 assert.deepEqual(await changes.watch({},signal),{revision:1})
 for(let i=0;i<3;i++)await service.ensure(owner,{sessionId:'known'})
 assert.equal(inspections,4,'每次核验原生会话与主体权限，不使用显示缓存代替准入')
 assert.equal(writes,1);assert.deepEqual(await changes.watch({},signal),{revision:1})
 const adoption={sessionId:'known',requestId:'11111111-1111-4111-8111-111111111111',title:'已接入会话'}
 await service.adopt(owner,adoption);assert.deepEqual(await changes.watch({},signal),{revision:2})
 await service.adopt(owner,adoption);assert.deepEqual(await changes.watch({},signal),{revision:2})
 await assert.rejects(service.ensure('another-owner',{sessionId:'known'}),{code:'teloa/forbidden'})
 assert.deepEqual(await changes.watch({},signal),{revision:2})
 let woke=false
 const waiting=changes.watch({revision:2},signal).then(value=>{woke=true;return value})
 await service.ensure(owner,{sessionId:'another'})
 assert.deepEqual(await waiting,{revision:3});assert.equal(woke,true)
 changes.dispose()
})

test('落盘失败不通知；已保存预约后宿主创建失败仍通知，保留原请求恢复入口',async()=>{
 const failed=new ConversationDirectoryChanges(),signal=new AbortController().signal
 const broken=failed.trackWrites({read:async()=>[],write:async(_rows:never[])=>{throw Error('disk error')}})
 await assert.rejects(broken.write([]),/disk error/);assert.deepEqual(await failed.watch({},signal),{revision:0});failed.dispose()
 const changes=new ConversationDirectoryChanges()
 let rows:Awaited<ReturnType<ConversationRepository['read']>>=[]
 const repository=changes.trackWrites({read:async()=>rows,write:async(value:typeof rows)=>{rows=structuredClone(value)}})
 const service=new ConversationService(repository,{create:async()=>{throw Error('host unavailable')},inspect:async()=>{}},{id:()=> 'pending-work',now:()=> '2026-10-30T10:00:00Z'})
 await assert.rejects(service.create('owner',{requestId:'11111111-1111-4111-8111-111111111111',title:'待恢复工作'}),/host unavailable/)
 assert.equal(rows[0]?.status,'pending');assert.deepEqual(await changes.watch({},signal),{revision:1});changes.dispose()
})

test('接入落盘后唤醒原目录；读取和订阅之间的接入不会漏掉',async()=>{
 const changes=new ConversationDirectoryChanges(),signal=new AbortController()
 let rows:Awaited<ReturnType<ConversationRepository['read']>>=[]
 const repository:ConversationRepository={read:async()=>structuredClone(rows),write:async value=>{rows=structuredClone(value)}}
 const service=new ConversationService(repository,{create:async id=>id,inspect:async()=>{}},{id:()=> 'conversation-one',now:()=> '2026-10-06T10:00:00Z'})
 const owner='local:teloa-owner',initial=await changes.watch({},signal.signal)
 assert.deepEqual(await service.list(owner,{}),[])
 await changes.mutate(()=>service.adopt(owner,{sessionId:'remote-one',requestId:'11111111-1111-4111-8111-111111111111',title:'手机发来的工作'}))
 assert.deepEqual(await changes.watch(initial,signal.signal),{revision:1})
 assert.equal((await service.list(owner,{}))[0]?.title,'手机发来的工作')
 let woke=false
 const waiting=changes.watch({revision:1},signal.signal).then(value=>{woke=true;return value})
 await changes.mutate(()=>service.adopt(owner,{sessionId:'remote-two',requestId:'22222222-2222-4222-8222-222222222222',title:'第二项工作'}))
 await new Promise(resolve=>setImmediate(resolve))
 assert.equal(woke,true,'成功落盘立即唤醒，而非等待长轮询到期')
 assert.deepEqual(await waiting,{revision:2})
 changes.dispose()
})

test('失败的接入不发布失效；无变化的watch二十秒内返回原revision',async t=>{
 t.mock.timers.enable({apis:['setTimeout']})
 const changes=new ConversationDirectoryChanges(),signal=new AbortController()
 await assert.rejects(changes.mutate(async()=>{throw Error('尚未落盘')}),/尚未落盘/)
 assert.deepEqual(await changes.watch({},signal.signal),{revision:0})
 let settled=false
 const waiting=changes.watch({revision:0},signal.signal).then(value=>{settled=true;return value})
 t.mock.timers.tick(19_999);await Promise.resolve();assert.equal(settled,false)
 t.mock.timers.tick(1);assert.deepEqual(await waiting,{revision:0})
 changes.dispose()
})

test('请求取消和宿主释放均解除watch等待；未知payload不建立订阅',async()=>{
 const changes=new ConversationDirectoryChanges(),cancelled=new AbortController(),live=new AbortController()
 for(const payload of [{revision:-1},{revision:1.2},{revision:'0'},{revision:0,owner:'foreign'}])await assert.rejects(changes.watch(payload,live.signal),{code:'teloa/invalid-input'})
 const a=changes.watch({revision:0},cancelled.signal),b=changes.watch({revision:0},live.signal)
 const aRejected=assert.rejects(a,{name:'AbortError'}),bRejected=assert.rejects(b,{code:'teloa/host-unavailable'})
 cancelled.abort();changes.dispose();await Promise.all([aRejected,bRejected])
 await assert.rejects(changes.watch({},live.signal),{code:'teloa/host-unavailable'})
})

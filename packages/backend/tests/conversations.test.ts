import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationService, FileConversationRepository } from '../src/work/conversations.ts'

const owner='local:teloa-owner'
const request={requestId:'12345678-1234-4234-8234-123456789012',title:'通用资料整理'}
async function fixture() {
  const path=join(await mkdtemp(join(tmpdir(),'teloa-bindings-')),'conversations.json')
  const created:string[]=[]
  const existing=new Set<string>()
  let failures=0
  let counter=0
  const host={async create(id:string) { created.push(id);if(failures-- >0)throw Error('DSH 暂不可用');existing.add('host-'+id);return 'host-'+id }, async inspect(id:string) {if(!existing.has(id))throw Error('不存在的原生会话')} }
  const identity={id:()=>`identity-${++counter}`,now:()=> '2026-09-10T10:00:00.000Z'}
  const repository=new FileConversationRepository(path)
  const service=new ConversationService(repository,host,identity)
  return {path,created,existing,host,identity,repository,service,failOnce:()=>{failures=1}}
}
test('并发双击只创建一个工作会话，使用宿主返回的权威身份',async()=>{
  const f=await fixture()
  const [a,b]=await Promise.all([f.service.create(owner,request),f.service.create(owner,request)])
  assert.deepEqual(a,b);assert.equal(f.created.length,1)
  assert.equal(a.status,'ready');assert.equal(a.sessionId,'host-'+a.requestedSessionId)
  assert.notEqual(a.id,a.sessionId);assert.deepEqual(a.scopeIds,['general'])
})
test('宿主失败后重启沿用预约，不制造第二条会话',async()=>{
  const f=await fixture();f.failOnce()
  await assert.rejects(f.service.create(owner,request),/DSH 暂不可用/)
  const pending=await f.repository.read();assert.equal(pending[0]?.status,'pending')
  const restarted=new ConversationService(new FileConversationRepository(f.path),f.host,f.identity)
  const ready=await restarted.create(owner,request)
  assert.equal(ready.id,pending[0]?.id);assert.deepEqual(f.created,[ready.requestedSessionId,ready.requestedSessionId])
  assert.equal((await f.repository.read()).length,1)
})
test('已有原生会话领养幂等，原生与工作入口返回同一绑定',async()=>{
  const f=await fixture();const a=await f.service.create(owner,request)
  assert.deepEqual(await f.service.ensure(owner,{sessionId:a.sessionId}),a)
  f.existing.add('native-second')
  const [b,c]=await Promise.all([f.service.ensure(owner,{sessionId:'native-second'}),f.service.ensure(owner,{sessionId:'native-second'})])
  assert.equal(b.id,c.id);assert.notEqual(a.id,b.id);assert.equal(f.created.length,1)
})
test('伪造主体范围、未知字段与不存在的会话都拒绝',async()=>{
  const f=await fixture()
  await assert.rejects(f.service.create(owner,{...request,scopeIds:['soc']}),{code:'teloa/invalid-input'})
  await assert.rejects(f.service.ensure(owner,{sessionId:'../outside'}),{code:'teloa/invalid-input'})
  await assert.rejects(f.service.ensure(owner,{sessionId:'unknown'}),/不存在的原生会话/)
  assert.equal((await f.repository.read()).length,0)
  const a=await f.service.create(owner,request)
  await assert.rejects(f.service.bySession('another-user',a.sessionId),{code:'teloa/forbidden'})
  await assert.rejects(f.service.ensure('another-user',{sessionId:a.sessionId}),{code:'teloa/forbidden'})
})
test('相同幂等键不同意图拒绝，未知绑定不伪装成空范围',async()=>{
  const f=await fixture();await f.service.create(owner,request)
  await assert.rejects(f.service.create(owner,{...request,title:'换一个工作'}),{code:'teloa/conflict'})
  await assert.rejects(f.service.bySession(owner,'unbound'),{code:'teloa/not-bound'})
})
test('宿主返回已绑定身份时拒绝领养冲突',async()=>{
  const f=await fixture();const a=await f.service.create(owner,request)
  const conflicting=new ConversationService(f.repository,{...f.host,create:async()=>a.sessionId},f.identity)
  await assert.rejects(conflicting.create(owner,{...request,requestId:'22345678-1234-4234-8234-123456789012'}),{code:'teloa/conflict'})
  assert.equal((await f.repository.read()).filter(row=>row.status==='ready').length,1)
})
test('持久文件损坏或含非法范围时显式失败，原内容保留',async()=>{
  const f=await fixture();await writeFile(f.path,'broken')
  await assert.rejects(f.repository.read(),/存储损坏/);assert.equal(await readFile(f.path,'utf8'),'broken')
  await writeFile(f.path,JSON.stringify({schema:'teloa.conversations/v1',rows:[{scopeIds:['soc']}]}))
  await assert.rejects(f.repository.read(),/存储损坏/)
})
test('工作目录保留待恢复预约，只返回本人显式创建的工作',async()=>{
  const f=await fixture();f.existing.add('native');await f.service.ensure(owner,{sessionId:'native'})
  const a=await f.service.create(owner,request)
  f.failOnce();await assert.rejects(f.service.create(owner,{...request,requestId:'22345678-1234-4234-8234-123456789012'}))
  const rows=await f.service.list(owner,{})
  assert.equal(rows.length,2);assert.equal(rows[0]?.id,a.id);assert.equal(rows[1]?.status,'pending')
  assert.deepEqual(await f.service.list('someone-else',{}),[])
  await assert.rejects(f.service.list(owner,{ownerId:'someone-else'}),{code:'teloa/invalid-input'})
})
test('明确加入原生副本才进入工作目录，沿用原绑定并在重启后保持幂等',async()=>{
  const f=await fixture();f.existing.add('native-copy')
  const implicit=await f.service.ensure(owner,{sessionId:'native-copy'})
  assert.deepEqual(await f.service.list(owner,{}),[])
  const payload={...request,sessionId:'native-copy',title:'独立调查副本'}
  const [a,b]=await Promise.all([f.service.adopt(owner,payload),f.service.adopt(owner,payload)])
  assert.equal(a.id,implicit.id);assert.deepEqual(a,b);assert.equal(f.created.length,0)
  assert.deepEqual((await f.service.list(owner,{})).map(row=>row.sessionId),['native-copy'])
  const restarted=new ConversationService(new FileConversationRepository(f.path),f.host,f.identity)
  assert.equal((await restarted.adopt(owner,{...payload,requestId:'22345678-1234-4234-8234-123456789012'})).id,a.id)
  assert.equal((await f.repository.read()).length,1)
})
test('加入目录不接受他人身份、未确认会话和复用到另一目标的请求键',async()=>{
  const f=await fixture();f.existing.add('native-copy');f.existing.add('other-copy')
  const payload={...request,sessionId:'native-copy'}
  await f.service.adopt(owner,payload)
  await assert.rejects(f.service.adopt('another-user',payload),{code:'teloa/forbidden'})
  await assert.rejects(f.service.adopt(owner,{...payload,sessionId:'other-copy'}),{code:'teloa/conflict'})
  await assert.rejects(f.service.adopt(owner,{...payload,sessionId:'missing',requestId:'22345678-1234-4234-8234-123456789012'}),/不存在/)
  assert.equal((await f.repository.read()).length,1)
})

test("所选工作区随创建预约持久保存，重启重试不得改投其他目录",async()=>{
 const f=await fixture(),calls:{id:string;workspaceId:string|undefined}[]=[]
 let fail=true
 const host={...f.host,create:async(id:string,workspaceId?:string)=>{calls.push({id,workspaceId});if(fail)throw Error("连接中断");f.existing.add(id);return id}}
 const service=new ConversationService(f.repository,host,f.identity),input={...request,workspaceId:"workspace-a"}
 await assert.rejects(service.create(owner,input),/连接中断/)
 const pending=(await f.repository.read())[0]!
 assert.equal(pending.requestedWorkspaceId,"workspace-a")
 const restarted=new ConversationService(new FileConversationRepository(f.path),host,f.identity)
 await assert.rejects(restarted.create(owner,{...input,workspaceId:"workspace-b"}),{code:"teloa/conflict"})
 await assert.rejects(restarted.create(owner,request),{code:"teloa/conflict"})
 fail=false
 const ready=await restarted.create(owner,input)
 assert.equal(ready.requestedWorkspaceId,"workspace-a")
 assert.deepEqual(calls,[{id:pending.requestedSessionId,workspaceId:"workspace-a"},{id:pending.requestedSessionId,workspaceId:"workspace-a"}])
})

test("非法工作区身份在预约落盘前拒绝；旧绑定不要求补写新字段",async()=>{
 const f=await fixture()
 for(const workspaceId of ["",null,42,"../escape"])await assert.rejects(f.service.create(owner,{...request,workspaceId}),{code:"teloa/invalid-input"})
 assert.equal((await f.repository.read()).length,0)
 const old=await f.service.create(owner,request)
 assert.equal(old.requestedWorkspaceId,undefined)
 assert.deepEqual(await f.repository.read(),[old])
})

test('运行专用会话由服务端固定身份并在首次创建时直传 preset，重放仍核对同一配置',async()=>{
 const f=await fixture(),calls:{id:string;workspaceId:string|undefined;agentPresetId:string|undefined}[]=[]
 const fixed=new Map<string,string>(),host={...f.host,create:async(id:string,workspaceId?:string,agentPresetId?:string)=>{calls.push({id,workspaceId,agentPresetId});if(fixed.has(id)&&fixed.get(id)!==agentPresetId)throw Error('preset mismatch');fixed.set(id,agentPresetId!);f.existing.add(id);return id}}
 const service=new ConversationService(f.repository,host,f.identity),sessionId='task-run-12345678-1234-4234-8234-123456789012'
 const run={sessionId,taskId:'22345678-1234-4234-8234-123456789012',taskVersion:3,roleId:'32345678-1234-4234-8234-123456789012',roleVersion:5,agentPresetId:'security-analyst'}
 const first=await service.createRun(owner,request,run)
 const replay=await service.createRun(owner,request,run)
 assert.deepEqual(replay,first);assert.equal(first.sessionId,sessionId);assert.equal(first.requestedSessionId,sessionId)
 assert.equal(first.purpose,'task-run');assert.deepEqual(first.run,{taskId:run.taskId,taskVersion:3,roleId:run.roleId,roleVersion:5,agentPresetId:'security-analyst'})
 assert.deepEqual(await service.list(owner,{}),[])
 assert.deepEqual(calls,[{id:sessionId,workspaceId:undefined,agentPresetId:'security-analyst'},{id:sessionId,workspaceId:undefined,agentPresetId:'security-analyst'}])
 await assert.rejects(service.createRun(owner,request,{...run,sessionId:'task-run-other'}),{code:'teloa/conflict'})
 await assert.rejects(service.createRun(owner,request,{...run,roleVersion:6}),{code:'teloa/conflict'})
 await assert.rejects(service.createRun(owner,request,{...run,agentPresetId:'security-reviewer'}),{code:'teloa/conflict'})
})

test('配置失败后将运行预约持久收口并从目录隐藏，不删除或冒充普通会话',async()=>{
 const f=await fixture(),sessionId='task-run-12345678-1234-4234-8234-123456789012'
 const run={sessionId,taskId:'22345678-1234-4234-8234-123456789012',taskVersion:3,roleId:'32345678-1234-4234-8234-123456789012',roleVersion:5,agentPresetId:'security-analyst'}
 f.failOnce()
 await assert.rejects(f.service.createRun(owner,request,run),/DSH 暂不可用/)
 assert.equal((await f.repository.read())[0]?.status,'pending');assert.equal(await f.service.isTaskRunReserved(owner,sessionId),true)
 assert.equal(await f.service.failRunReservation(owner,{requestId:request.requestId,sessionId}),true)
 assert.equal(await f.service.failRunReservation(owner,{requestId:request.requestId,sessionId}),true)
 assert.equal((await f.repository.read())[0]?.status,'failed');assert.deepEqual(await f.service.list(owner,{}),[])
 await assert.rejects(f.service.createRun(owner,request,run),{code:'teloa/preset-unavailable'})
})

test('只读已落盘快照不进入create串行队列，并复用身份与ready校验',async()=>{
 const f=await fixture();f.existing.add('native-snapshot');await f.service.ensure(owner,{sessionId:'native-snapshot'})
 let entered!:()=>void,release!:()=>void;const atCreate=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>release=resolve)
 const service=new ConversationService(f.repository,{...f.host,create:async id=>{entered();await gate;return f.host.create(id)}},f.identity)
 const creating=service.create(owner,request)
 try{
  await atCreate
  assert.equal((await service.snapshotBySession(owner,'native-snapshot')).requestId,undefined)
  await assert.rejects(service.snapshotBySession('another','native-snapshot'),{code:'teloa/forbidden'})
  await assert.rejects(service.snapshotBySession(owner,'missing'),{code:'teloa/not-bound'})
  const pending=(await f.repository.read()).find(row=>row.status==='pending')!
  await assert.rejects(service.snapshotBySession(owner,pending.sessionId),{code:'teloa/binding-pending'})
 }finally{release();await creating}
 await service.adopt(owner,{sessionId:'native-snapshot',requestId:'22345678-1234-4234-8234-123456789012',title:'已入目录'})
 assert.equal((await service.snapshotBySession(owner,'native-snapshot')).title,'已入目录')
})

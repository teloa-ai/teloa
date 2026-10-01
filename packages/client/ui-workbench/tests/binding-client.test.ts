import {homeCreationLocation,mayContinueHomeCreation} from '../src/client/home-creation-navigation.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import type { Conversation, CapabilitySnapshot } from '@teloa/contract'
import { BindingClient, type ConversationCreation, type WorkPort } from '../src/client/binding-client.ts'
function row(sessionId:string):Conversation {return {id:'work-'+sessionId,ownerId:'owner',title:sessionId,scopeIds:['general'],version:1,status:'ready',sessionId,requestedSessionId:sessionId,createdAt:'2026-09-10T00:00:00Z'}}
function deferred<T>() {let resolve!:(value:T)=>void;let reject!:(error:Error)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject}}
function fixture() {
  const calls=new Map<string,ReturnType<typeof deferred<Conversation>>>(),blocks=new Map<string,string|undefined>()
  const port:WorkPort={isNativeChild:()=>false,list:async()=>[],read:async id=>row(id),ensure:async id=>{const d=deferred<Conversation>();calls.set(id,d);return d.promise},catalog:async id=>({schema:'teloa.capabilities/v1',conversation:row(id),observedAt:'2026-09-10T00:00:00Z',skills:[],knowledge:{status:'not-connected'},connections:{status:'not-connected'},writes:{status:'not-implemented'}}),block:(id,reason)=>{blocks.set(id,reason)},create:async input=>({...row('new'),requestId:input.requestId,...(input.workspaceId===undefined?{}:{requestedWorkspaceId:input.workspaceId})}),adopt:async id=>id,open:()=>{},current:()=>undefined}
  return {calls,blocks,port,client:new BindingClient(port)}
}
test('openSession在read/adopt前固定导航代次；迟到不得publish/block或抢开',async()=>{
 for(const stage of ['read','adopt']){
  const f=fixture(),gate=deferred<void>(),opened:string[]=[]
  let current='A',permitted=true
  f.port.current=()=>current;f.port.open=id=>opened.push(id);f.port.ensure=async id=>row(id)
  await f.client.select('A')
  f.port.read=async id=>{if(stage==='read')await gate.promise;return row(id)}
  f.port.adopt=async id=>{if(stage==='adopt')await gate.promise;return id}
  const opening=f.client.openSession('C',undefined,()=>permitted)
  await new Promise(resolve=>setImmediate(resolve))
  current='B';await f.client.select('B');permitted=false
  const blocks=[...f.blocks.entries()];gate.resolve();await opening
  assert.deepEqual(opened,[]);assert.equal(f.client.getSnapshot().sessionId,'B');assert.deepEqual([...f.blocks.entries()],blocks)
 }
})
test('openSession入口序列保留后发导航，signal和最终mayOpen拒绝不会打开',async()=>{
 for(const change of ['newer','signal','guard']){
  const f=fixture(),gate=deferred<void>(),opened:string[]=[],signal=new AbortController()
  let permitted=true,current:string|undefined
  f.port.read=async id=>{if(id==='slow')await gate.promise;return row(id)}
  f.port.ensure=async id=>row(id);f.port.current=()=>current;f.port.open=id=>{current=id;opened.push(id)}
  const old=f.client.openSession('slow',signal.signal,()=>permitted)
  if(change==='newer')await f.client.openSession('new')
  if(change==='signal')signal.abort()
  if(change==='guard')permitted=false
  gate.resolve();await old
  assert.deepEqual(opened,change==='newer'?['new']:[])
  assert.equal(f.client.getSnapshot().sessionId,change==='newer'?'new':undefined)
 }
})
test('openSession在adopt中取消保持原绑定和输入，未经select的导航变化也不能回写',async()=>{
 for(const change of ['signal','current']){
  const f=fixture(),gate=deferred<string>(),opened:string[]=[],abort=new AbortController()
  let current='A'
  f.port.current=()=>current;f.port.ensure=async id=>row(id);f.port.open=id=>{current=id;opened.push(id)}
  await f.client.select('A');f.port.adopt=()=>gate.promise
  const pending=f.client.openSession('C',abort.signal)
  await new Promise(resolve=>setImmediate(resolve))
  if(change==='signal')abort.abort();else current='B'
  gate.resolve('C');await pending
  assert.deepEqual(opened,[]);assert.equal(f.client.getSnapshot().sessionId,'A')
  if(change==='signal')assert.equal(f.blocks.get('A'),undefined)
  assert.equal(f.blocks.has('C'),false)
 }
})
for(const outcome of ['aborted','guard','read-failed','read-aborted'] as const){
 test('后续openSession '+outcome+' 撤下旧导航阻断且保留原任务限制',async()=>{
  for(const purpose of ['normal','task-run'] as const){
   const f=fixture(),adoption=deferred<string>(),reading=deferred<Conversation>(),abort=new AbortController(),opened:string[]=[],ensured:string[]=[]
   const original:Conversation=purpose==='normal'?row('A'):{...row('A'),purpose:'task-run',run:{taskId:'22345678-1234-4234-8234-123456789012',taskVersion:1,roleId:'32345678-1234-4234-8234-123456789012',roleVersion:1,agentPresetId:'standard'}}
   f.port.current=()=> 'A';f.port.open=id=>opened.push(id)
   f.port.ensure=async id=>{ensured.push(id);return original}
   await f.client.select('A');await f.client.select('A')
   const snapshot=f.client.getSnapshot(),block=f.blocks.get('A')
   if(purpose==='task-run')assert.match(block??'',/任务执行/)
   f.port.adopt=()=>adoption.promise
   const old=f.client.openSession('C')
   await new Promise(resolve=>setImmediate(resolve));assert.match(f.blocks.get('A')??'',/打开/)
   f.port.read=async()=>{if(outcome==='read-failed')throw Error('读取目标失败');return reading.promise}
   if(outcome==='aborted')abort.abort()
   const next=f.client.openSession('D',abort.signal,()=>outcome!=='guard')
   if(outcome==='read-aborted'){
    abort.abort()
    assert.equal(f.blocks.get('A'),block,'旧adopt和新read都未结束时也应撤下旧导航阻断')
    reading.resolve(row('D'))
   }
   if(outcome==='read-failed')await assert.rejects(next,/读取目标失败/);else await next
   assert.equal(f.blocks.get('A'),block)
   adoption.resolve('C');await old
   assert.equal(f.blocks.get('A'),block);assert.equal(f.client.getSnapshot(),snapshot)
   assert.deepEqual(opened,[]);assert.deepEqual(ensured,['A'],'清理不重新select原会话')
  }
 })
}
test('A 迟到不得覆盖 B，选择目标时立即阻断输入',async()=>{
  const f=fixture(),a=f.client.select('A'),b=f.client.select('B')
  assert.match(f.blocks.get('B')??'',/绑定/)
  f.calls.get('B')!.resolve(row('B'));await b
  f.calls.get('A')!.resolve(row('A'));await a
  assert.equal(f.client.getSnapshot().sessionId,'B');assert.equal(f.client.getSnapshot().conversation?.sessionId,'B')
  assert.equal(f.blocks.get('B'),undefined)
})
test('失败显示原因并保持阻断，重试成功才解除',async()=>{
  const f=fixture(),first=f.client.select('A');f.calls.get('A')!.reject(Error('绑定读取失败'));await first
  assert.equal(f.client.getSnapshot().status,'failed');assert.match(f.blocks.get('A')??'',/绑定读取失败/)
  const retry=f.client.retry();f.calls.get('A')!.resolve(row('A'));await retry
  assert.equal(f.client.getSnapshot().status,'ready');assert.equal(f.blocks.get('A'),undefined)
})
test('返回不匹配的会话身份必须失败',async()=>{
  const f=fixture(),first=f.client.select('A');f.calls.get('A')!.resolve(row('B'));await first
  assert.equal(f.client.getSnapshot().status,'failed');assert.equal(f.client.getSnapshot().conversation,undefined)
})
test('能力查询迟到不能把 A 的目录带进 B',async()=>{
  const f=fixture(),a=f.client.select('A');f.calls.get('A')!.resolve(row('A'));await a
  const delayed=deferred<CapabilitySnapshot>();f.port.catalog=()=>delayed.promise
  const catalog=f.client.readCatalog(),b=f.client.select('B');f.calls.get('B')!.resolve(row('B'));await b
  delayed.resolve({schema:'teloa.capabilities/v1',conversation:row('A'),observedAt:'2026-09-10T00:00:00Z',skills:[],knowledge:{status:'not-connected'},connections:{status:'not-connected'},writes:{status:'not-implemented'}});await catalog
  assert.equal(f.client.getSnapshot().capabilities,undefined);assert.equal(f.client.getSnapshot().sessionId,'B')
})
test('创建失败重试保留幂等键，期间切换后不抢回当前会话',async()=>{
  const f=fixture(),keys:string[]=[];let attempts=0;let current:string|undefined;const opened:string[]=[]
  f.port.create=async input=>{keys.push(input.requestId);if(attempts++===0)throw Error('断线');current='B';return {...row('new'),requestId:input.requestId}}
  f.port.current=()=>current;f.port.open=id=>opened.push(id)
  await assert.rejects(f.client.create(),/断线/)
  const result=await f.client.create()
  assert.equal(result.sessionId,'new');assert.equal(keys[0],keys[1]);assert.deepEqual(opened,[])
})
test('打开目录中的旧工作期间阻断原输入，旧请求迟到不抢回选中项',async()=>{
  const f=fixture(),a=f.client.select('A');f.calls.get('A')!.resolve(row('A'));await a
  f.port.current=()=> 'A'
  f.port.ensure=async id=>row(id)
  const delayed=deferred<string>(),opened:string[]=[]
  f.port.adopt=id=>id==='B'?delayed.promise:Promise.resolve(id);f.port.open=id=>opened.push(id)
  const b=f.client.openConversation(row('B'))
  assert.match(f.blocks.get('A')??'',/打开/)
  await f.client.openConversation(row('C'))
  delayed.resolve('B');await b
  assert.deepEqual(opened,['C'])
})
test('新建请求不能抢先覆盖后来发起但尚未完成的目录切换',async()=>{
  const f=fixture(),a=f.client.select('A');f.calls.get('A')!.resolve(row('A'));await a
  let current='A';const opened:string[]=[],creation=deferred<Conversation>(),adoption=deferred<string>();let requestId=''
  f.port.current=()=>current;f.port.ensure=async id=>row(id);f.port.create=input=>{requestId=input.requestId;return creation.promise}
  f.port.adopt=id=>id==='B'?adoption.promise:Promise.resolve(id)
  f.port.open=id=>{current=id;opened.push(id)}
  const creating=f.client.create(),opening=f.client.openConversation(row('B'))
  creation.resolve({...row('new'),requestId});await creating
  assert.deepEqual(opened,[])
  adoption.resolve('B');await opening;assert.deepEqual(opened,['B'])
})
test('目录切换被新建请求替代而新建失败后，原会话仍能恢复输入',async()=>{
  const f=fixture(),a=f.client.select('A');f.calls.get('A')!.resolve(row('A'));await a
  f.port.current=()=> 'A';f.port.ensure=async id=>row(id)
  const adoption=deferred<string>();f.port.adopt=()=>adoption.promise;f.port.create=async()=>{throw Error('创建失败')}
  const opening=f.client.openConversation(row('B'))
  await assert.rejects(f.client.create(),/创建失败/)
  adoption.resolve('B');await opening
  assert.equal(f.blocks.get('A'),undefined);assert.equal(f.client.getSnapshot().status,'ready')
})
test('关闭副本管理框取消迟到的打开，不切换会话且恢复原输入',async()=>{
  const f=fixture(),selected=f.client.select('A');f.calls.get('A')!.resolve(row('A'));await selected
  f.port.current=()=> 'A';f.port.ensure=async id=>row(id)
  const adoption=deferred<string>(),opened:string[]=[],controller=new AbortController()
  f.port.adopt=()=>adoption.promise;f.port.open=id=>opened.push(id)
  const opening=f.client.openConversation(row('copy'),controller.signal)
  controller.abort()
  assert.equal(f.blocks.get('A'),undefined,'旧请求仍未完成时应立即恢复输入')
  adoption.resolve('copy');await opening
  assert.deepEqual(opened,[]);assert.equal(f.blocks.get('A'),undefined)
  assert.equal(f.client.getSnapshot().sessionId,'A')
})
test('取消旧打开不能解除后来打开操作的输入阻断',async()=>{
  const f=fixture(),selected=f.client.select('A');f.calls.get('A')!.resolve(row('A'));await selected
  f.port.current=()=> 'A';f.port.ensure=async id=>row(id)
  const copies=deferred<string>(),next=deferred<string>(),controller=new AbortController(),opened:string[]=[]
  f.port.adopt=id=>id==='copy'?copies.promise:next.promise;f.port.open=id=>opened.push(id)
  const old=f.client.openConversation(row('copy'),controller.signal)
  const latest=f.client.openConversation(row('B'))
  controller.abort();copies.resolve('copy');await old
  assert.match(f.blocks.get('A')??'',/打开/)
  next.resolve('B');await latest
  assert.deepEqual(opened,['B'])
})
test('选定工作区创建失败后固定请求身份，同目标重试成功才清除恢复信息',async()=>{
  const f=fixture(),calls:{requestId:string;title?:string;workspaceId?:string}[]=[],adoptions:{sessionId:string;workspaceId:string|undefined}[]=[];let attempts=0
  f.port.create=async input=>{calls.push(input);if(attempts++===0)throw Error('连接中断');return {...row('new'),requestId:calls[0]!.requestId,requestedWorkspaceId:'workspace-a'}}
  f.port.adopt=async(sessionId,workspaceId)=>{adoptions.push({sessionId,workspaceId});return sessionId}
  await assert.rejects(f.client.create({workspaceId:'workspace-a'}),/连接中断/)
  const pending=f.client.getPendingCreation()
  assert.equal(pending?.workspaceId,'workspace-a')
  assert.equal(pending?.requestId,calls[0]!.requestId)
  const result=await f.client.create({workspaceId:'workspace-a'})
  assert.equal(result.requestedWorkspaceId,'workspace-a')
  assert.deepEqual(calls,[
    {requestId:pending!.requestId,workspaceId:'workspace-a'},
    {requestId:pending!.requestId,workspaceId:'workspace-a'},
  ])
  assert.deepEqual(adoptions,[{sessionId:'new',workspaceId:'workspace-a'}])
  assert.equal(f.client.getPendingCreation(),undefined)
})
test('未完成创建不得把同一幂等键改投其他工作区',async()=>{
  const f=fixture(),calls:unknown[]=[]
  f.port.create=async input=>{calls.push(input);throw Error('连接中断')}
  await assert.rejects(f.client.create({workspaceId:'workspace-a'}),/连接中断/)
  await assert.rejects(f.client.create({workspaceId:'workspace-b'}),/原工作区/)
  await assert.rejects(f.client.create(),/原工作区/)
  assert.equal(calls.length,1)
  assert.equal(f.client.getPendingCreation()?.workspaceId,'workspace-a')
})
test('未完成创建不得把同一幂等键改投其他岗位（群内直接回应一期 T14 修复轮 1）',async()=>{
  const roleA='11111111-1111-4111-8111-111111111111',roleB='22222222-2222-4222-8222-222222222222'
  // 岗位 A 待恢复：既不能改投岗位 B，也不能当成不带岗位的普通新建——服务端按 requestedRoleId 比对，
  // undefined 也是一种值，漏比就会在恢复重试时撞 teloa/conflict。
  const one=fixture(),oneCalls:unknown[]=[]
  one.port.create=async input=>{oneCalls.push(input);throw Error('连接中断')}
  await assert.rejects(one.client.create({roleId:roleA}),/连接中断/)
  await assert.rejects(one.client.create({roleId:roleB}),/原员工/)
  await assert.rejects(one.client.create(),/原员工/)
  assert.equal(oneCalls.length,1)
  assert.equal(one.client.getPendingCreation()?.roleId,roleA)
  // 普通会话待恢复：再去「找岗位 B 说话」同样被拒，方向对称。
  const two=fixture(),twoCalls:unknown[]=[]
  two.port.create=async input=>{twoCalls.push(input);throw Error('连接中断')}
  await assert.rejects(two.client.create(),/连接中断/)
  await assert.rejects(two.client.create({roleId:roleB}),/原员工/)
  assert.equal(twoCalls.length,1)
  assert.equal(two.client.getPendingCreation()?.roleId,undefined)
  // 同一岗位原样重试仍然放行，且复用同一个 requestId。
  const three=fixture(),threeCalls:{requestId:string;roleId?:string}[]=[]
  three.port.create=async input=>{threeCalls.push(input);if(threeCalls.length===1)throw Error('连接中断');return {...row('new'),requestId:input.requestId}}
  await assert.rejects(three.client.create({roleId:roleA}),/连接中断/)
  await three.client.create({roleId:roleA})
  assert.equal(threeCalls.length,2)
  assert.equal(threeCalls[0]!.requestId,threeCalls[1]!.requestId)
  assert.equal(threeCalls[1]!.roleId,roleA)
})
test('打开待恢复预约时沿用记录固定的工作区',async()=>{
  const f=fixture(),calls:{requestId:string;title?:string;workspaceId?:string}[]=[],adoptions:{sessionId:string;workspaceId:string|undefined}[]=[]
  const pending:Conversation={...row('reserved'),status:'pending',requestId:'12345678-1234-4234-8234-123456789012',requestedWorkspaceId:'workspace-a'}
  f.port.create=async input=>{calls.push(input);return {...pending,status:'ready'}}
  f.port.adopt=async(sessionId,workspaceId)=>{adoptions.push({sessionId,workspaceId});return sessionId}
  await f.client.openConversation(pending)
  assert.deepEqual(calls,[{requestId:pending.requestId,title:pending.title,workspaceId:'workspace-a'}])
  assert.deepEqual(adoptions,[{sessionId:'reserved',workspaceId:'workspace-a'}])
})
test('创建返回的固定工作区不一致时停止原生领养并保留原请求',async()=>{
  const f=fixture();let adopted=false
  f.port.create=async input=>({...row('new'),requestId:input.requestId,requestedWorkspaceId:'workspace-b'})
  f.port.adopt=async id=>{adopted=true;return id}
  await assert.rejects(f.client.create({workspaceId:'workspace-a'}),/工作区身份不一致/)
  assert.equal(adopted,false)
  assert.equal(f.client.getPendingCreation()?.workspaceId,'workspace-a')
})
test('从目录恢复同一创建请求成功后解除客户端目标锁',async()=>{
  const f=fixture();let first=true
  f.port.create=async input=>{if(first){first=false;throw Error('连接中断')}return {...row('reserved'),status:'ready',requestId:input.requestId,...(input.workspaceId===undefined?{}:{requestedWorkspaceId:input.workspaceId})}}
  await assert.rejects(f.client.create({workspaceId:'workspace-a'}),/连接中断/)
  const creation=f.client.getPendingCreation()!
  await f.client.openConversation({...row('reserved'),status:'pending',requestId:creation.requestId,requestedWorkspaceId:'workspace-a'})
  assert.equal(f.client.getPendingCreation(),undefined)
})
test('服务端已就绪但首次原生领养失败，从 ready 目录恢复后解除同一目标锁',async()=>{
  const f=fixture();let adoption=0
  f.port.create=async input=>({...row('reserved'),requestId:input.requestId,requestedWorkspaceId:'workspace-a'})
  f.port.adopt=async id=>{if(adoption++===0)throw Error('原生领养失败');return id}
  await assert.rejects(f.client.create({workspaceId:'workspace-a'}),/原生领养失败/)
  const creation=f.client.getPendingCreation()!
  const ready={...row('reserved'),requestId:creation.requestId,requestedWorkspaceId:'workspace-a'}
  f.port.ensure=async()=>ready
  await f.client.openConversation(ready)
  assert.equal(f.client.getPendingCreation(),undefined)
})
test('ready 目录中的同一请求若工作区身份变化，不得领养或解除目标锁',async()=>{
  const f=fixture();let adoption=0
  f.port.create=async input=>({...row('reserved'),requestId:input.requestId,requestedWorkspaceId:'workspace-a'})
  f.port.adopt=async id=>{if(adoption++===0)throw Error('原生领养失败');return id}
  await assert.rejects(f.client.create({workspaceId:'workspace-a'}),/原生领养失败/)
  const creation=f.client.getPendingCreation()!
  const changed={...row('reserved'),requestId:creation.requestId,requestedWorkspaceId:'workspace-b'}
  f.port.ensure=async()=>changed
  await assert.rejects(f.client.openConversation(changed),/工作区身份不一致/)
  assert.equal(adoption,1)
  assert.equal(f.client.getPendingCreation()?.workspaceId,'workspace-a')
})
test("明确另建工作使用新请求，原失败尝试仍留在目录中",async()=>{
  const f=fixture(),created:ConversationCreation[]=[],saved:Conversation[]=[]
  f.port.list=async()=>saved
  f.port.create=async input=>{created.push({...input});const value={...row("work-"+created.length),status:"pending" as const,requestId:input.requestId,...(input.workspaceId?{requestedWorkspaceId:input.workspaceId}:{})};saved.push(value);throw Error("目录不可用")}
  await assert.rejects(f.client.create({workspaceId:"workspace-a"}),/目录不可用/)
  const original=f.client.getPendingCreation()!
  assert.throws(()=>f.client.releaseCreationForNewWork("过期请求"),/已变化/)
  assert.equal(f.client.getPendingCreation()?.requestId,original.requestId)
  f.client.releaseCreationForNewWork(original.requestId)
  assert.equal(f.client.getPendingCreation(),undefined)
  await assert.rejects(f.client.create({workspaceId:"workspace-b"}),/目录不可用/)
  assert.notEqual(created[0]!.requestId,created[1]!.requestId)
  assert.equal(created[0]!.workspaceId,"workspace-a");assert.equal(created[1]!.workspaceId,"workspace-b")
  await f.client.refreshDirectory()
  assert.deepEqual(f.client.getDirectorySnapshot().rows.map(value=>value.requestId),created.map(value=>value.requestId))
})
test("正在进行的创建不能被另建入口释放",async()=>{
  const f=fixture(),pending=deferred<Conversation>()
  f.port.create=()=>pending.promise
  const creating=f.client.create({workspaceId:"workspace-a"}),request=f.client.getPendingCreation()!
  assert.throws(()=>f.client.releaseCreationForNewWork(request.requestId),/正在创建/)
  assert.equal(f.client.getPendingCreation()?.requestId,request.requestId)
  pending.reject(Error("连接中断"));await assert.rejects(creating,/连接中断/)
})

test('任务运行会话按精确绑定打开，不要求进入普通工作目录',async()=>{
  const f=fixture(),opened:string[]=[]
  const run:Conversation={...row('task-run-request'),requestId:'12345678-1234-4234-8234-123456789012',purpose:'task-run',run:{taskId:'22345678-1234-4234-8234-123456789012',taskVersion:1,roleId:'32345678-1234-4234-8234-123456789012',roleVersion:1,agentPresetId:'standard'}}
  let reads=0,ensures=0,current:string|undefined
  f.port.list=async()=>[]
  f.port.read=async sessionId=>{reads++;assert.equal(sessionId,run.sessionId);return run}
  f.port.ensure=async()=>{ensures++;throw Error('运行会话不能走普通绑定入口')}
  f.port.current=()=>current
  f.port.adopt=async sessionId=>sessionId
  f.port.open=sessionId=>{current=sessionId;opened.push(sessionId)}
  await f.client.openSession(run.sessionId)
  // 原生会话切换通知会紧随 open 到达；专用运行会话必须沿用刚完成的精确读取，
  // 不能退回普通 ensure 路径而把已经打开的结果标成绑定失败。
  await f.client.select(run.sessionId)
  assert.equal(reads,1)
  assert.equal(ensures,0)
  assert.deepEqual(opened,[run.sessionId])
  assert.equal(f.client.getSnapshot().status,'ready')
  assert.equal(f.client.getSnapshot().conversation?.sessionId,run.sessionId)
  assert.match(f.blocks.get(run.sessionId)??'',/任务执行编排/)
})

test('恢复原生执行助手只读其原生会话，不领养为普通工作或继承父会话能力',async()=>{
  const f=fixture(),parent=f.client.select('parent')
  f.calls.get('parent')!.resolve(row('parent'));await parent
  await f.client.readCatalog()
  let ensures=0,catalogs=0
  f.port.isNativeChild=id=>id==='child'
  f.port.ensure=async()=>{ensures++;throw Error('子 Agent 会话不能作为普通工作会话接入。')}
  f.port.catalog=async()=>{catalogs++;throw Error('执行助手不能读取父工作目录')}
  await f.client.select('child')
  await f.client.retry()
  await f.client.readCatalog()
  assert.equal(ensures,0)
  assert.equal(catalogs,0)
  assert.equal(f.client.getSnapshot().sessionId,'child')
  assert.equal(f.client.getSnapshot().status,'idle')
  assert.equal(f.client.getSnapshot().conversation,undefined)
  assert.equal(f.client.getSnapshot().capabilities,undefined)
  assert.equal(f.client.getSnapshot().error,undefined)
  assert.equal(f.blocks.get('child'),undefined)
})

test('原生子会话分类迟到后清除旧绑定失败，旧请求不能重新阻断输入',async()=>{
  const f=fixture()
  let nativeChild=false
  f.port.isNativeChild=()=>nativeChild
  const initial=f.client.select('child'),initialRequest=f.calls.get('child')!
  nativeChild=true
  const identified=f.client.select('child')
  assert.equal(f.client.getSnapshot().status,'idle')
  initialRequest.reject(Error('子 Agent 会话不能作为普通工作会话接入。'))
  await initial;await identified
  assert.equal(f.client.getSnapshot().status,'idle')
  assert.equal(f.blocks.get('child'),undefined)
})

test('未被原生服务识别的绑定拒绝仍然失败关闭，不能按错误文案豁免',async()=>{
  const f=fixture()
  f.port.ensure=async()=>{throw Error('子 Agent 会话不能作为普通工作会话接入。')}
  await f.client.select('unknown')
  assert.equal(f.client.getSnapshot().status,'failed')
  assert.ok(f.blocks.get('unknown'))
})

test('从原生子会话打开工作后取消，立即撤下导航临时阻断而不创建子会话绑定',async()=>{
  const f=fixture(),adoption=deferred<string>(),controller=new AbortController()
  f.port.isNativeChild=id=>id==='child'
  f.port.current=()=> 'child'
  f.port.ensure=async id=>{assert.notEqual(id,'child');return row(id)}
  f.port.adopt=()=>adoption.promise
  await f.client.select('child')
  const opening=f.client.openConversation(row('work'),controller.signal)
  assert.ok(f.blocks.get('child'))
  controller.abort()
  assert.equal(f.blocks.get('child'),undefined)
  adoption.resolve('work');await opening
  assert.equal(f.client.getSnapshot().status,'idle')
})

test('业务绑定在原生领养后、打开前落定；丢回包时原创建身份可以续办',async()=>{
 const f=fixture(),requests:string[]=[],events:string[]=[];let attempt=0
 f.port.create=async input=>{requests.push(input.requestId);events.push('create');return {...row('new'),requestId:input.requestId}}
 f.port.adopt=async id=>{events.push('adopt');return id};f.port.open=id=>{events.push('open:'+id)}
 const beforeOpen=async(conversation:Conversation)=>{events.push('context:'+conversation.sessionId);if(attempt++===0)throw Error('context response lost')}
 await assert.rejects(f.client.create({beforeOpen}),/context response lost/)
 assert.deepEqual(events,['create','adopt','context:new']);assert.ok(f.client.getPendingCreation())
 await f.client.create({beforeOpen})
 assert.equal(requests[0],requests[1]);assert.equal(events.at(-1),'open:new');assert.equal(f.client.getPendingCreation(),undefined)
})

test('业务保存回执迟到且页面已变时，完成保存但不打开主会话',async()=>{
 const f=fixture(),saved=deferred<void>(),opened:string[]=[];let mayOpen=true
 f.port.open=id=>opened.push(id)
 const operation=f.client.create({beforeOpen:()=>saved.promise,mayOpen:()=>mayOpen})
 await new Promise(resolve=>setImmediate(resolve));mayOpen=false;saved.resolve();await operation
 assert.deepEqual(opened,[]);assert.equal(f.client.getPendingCreation(),undefined)
})


test('原生页切群、目录或同级其他对象后，创建迟到不重开原生页',async()=>{
 for(const change of [{view:'messages',messageMode:'groups',groupTarget:{groupId:'g'}},{view:'messages',messageMode:'directory'},{view:'tasks',taskId:'different'},{view:'team',roleId:'different'}]){
  const f=fixture(),gate=deferred<void>(),opened:string[]=[]
  let location:any={view:change.view,messageMode:'native',taskId:'initial',roleId:'initial'}
  const start=homeCreationLocation(location);f.port.open=id=>opened.push(id)
  const operation=f.client.create({beforeOpen:()=>gate.promise,mayOpen:()=>homeCreationLocation(location)===start})
  await new Promise(resolve=>setImmediate(resolve));location={...location,...change};gate.resolve();await operation
  assert.deepEqual(opened,[])
  assert.equal(mayContinueHomeCreation(start,location,'new','new'),false)
 }
 assert.equal(mayContinueHomeCreation('original',{view:'messages',messageMode:'native'},'new','new'),true)
})

test('外部预约固定requestId/title跨客户端恢复，标题或请求身份变化不能复用pending',async()=>{
 const f=fixture(),requestId='11111111-1111-4111-8111-111111111111',seen:ConversationCreation[]=[],opened:string[]=[]
 f.port.create=async input=>{seen.push(input);return {...row('builder'),title:input.title??'default',requestId:input.requestId}}
 f.port.open=id=>opened.push(id)
 await assert.rejects(f.client.create({requestId,title:'新业务',beforeOpen:async()=>{throw Error('bind lost')}}),/bind lost/)
 assert.deepEqual(f.client.getPendingCreation(),{requestId,title:'新业务'})
 await assert.rejects(f.client.create({requestId,title:'改名'}))
 await assert.rejects(f.client.create({requestId:'22222222-2222-4222-8222-222222222222',title:'新业务'}))
 assert.equal(seen.length,1);assert.deepEqual(opened,[])
 const restored=new BindingClient(f.port)
 await restored.create({requestId,title:'新业务'})
 assert.deepEqual(seen,[{requestId,title:'新业务'},{requestId,title:'新业务'}])
 assert.deepEqual(opened,['builder'])
})
test('显式创建标题回包不一致时不领养、不绑定、不打开',async()=>{
 const f=fixture();let adopted=0,bound=0,opened=0
 f.port.create=async input=>({...row('builder'),title:'另一标题',requestId:input.requestId})
 f.port.adopt=async id=>{adopted++;return id};f.port.open=()=>{opened++}
 await assert.rejects(f.client.create({title:'新业务',beforeOpen:async()=>{bound++}}))
 assert.equal(adopted,0);assert.equal(bound,0);assert.equal(opened,0)
})

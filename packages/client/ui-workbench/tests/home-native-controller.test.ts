import assert from 'node:assert/strict'
import test from 'node:test'
import {HomeNativeController,createHomeContextApi} from '../src/client/home-native-controller.ts'
import {prepareInitialNativeSession,createInitialNativeSessionCoordinator} from '../src/client/initial-native-session.ts'

const memory=()=>{const rows=new Map<string,string>();return {getItem:(key:string)=>rows.get(key)??null,setItem:(key:string,value:string)=>{rows.set(key,value)},removeItem:(key:string)=>{rows.delete(key)}}}

test('显式初始 provider 在非首页也启动，首页等待同一真实请求且取消不能认领',async()=>{
 const ready=Promise.withResolvers<void>(),opened=Promise.withResolvers<void>(),lifetime=new AbortController(),calls:string[]=[],binding={sessionId:'official'},storage=memory()
 const sessions={binding:()=>binding,using:async(_id:string,_options:unknown,operation:any)=>operation({ready:ready.promise,binding})}
 const ports={current:{getSnapshot:()=> 'official' as any,subscribe:()=>()=>{}},sessions:()=>sessions as any,isBlank:async()=>true}
 const initial=createInitialNativeSessionCoordinator(async()=>ports,lifetime.signal)
 initial.register(async request=>{calls.push('provider');const proof=await request.waitForCurrent();proof.assertCurrent();calls.push('open');await opened.promise;return proof.sessionId})
 await Promise.resolve();assert.deepEqual(calls,['provider'])
 const caller=new AbortController(),prepared=initial.prepare(caller.signal)
 caller.abort();ready.resolve();await new Promise(setImmediate)
 assert.deepEqual(calls,['provider','open']);opened.resolve()
 await assert.rejects(prepared,{name:'AbortError'})
 assert.equal(storage.getItem('teloa.home-native-session/v1'),null)
 const proof=await initial.prepare(lifetime.signal)
 assert.ok(proof);assert.deepEqual(calls,['provider','open'])
 assert.throws(()=>initial.register(async()=>undefined),/已有提供者/)
})

test('初始首页沿官方当前引用 ready 核空并认领，不新建另一份空稿',async()=>{
 const listeners=new Set<()=>void>(),binding={sessionId:'official'},storage=memory(),calls:string[]=[]
 let current:any,finish!:(value:unknown)=>void
 const ready=new Promise(resolve=>{finish=resolve}),sessions={binding:()=>binding,using:async(id:string,options:any,operation:any)=>{calls.push(id+':'+options.source);try{return await operation({ready,binding})}finally{calls.push('released')}}}
 const controller=new HomeNativeController({storage,identity:()=> 'extra',isBlank:()=>true,create:async id=>{calls.push('create');return id}})
 const initial=prepareInitialNativeSession({current:{getSnapshot:()=>current,subscribe:listener=>{listeners.add(listener);return()=>{listeners.delete(listener)}}},sessions:()=>sessions as any,isBlank:async()=>true},new AbortController().signal,async()=>undefined)
 await Promise.resolve();assert.deepEqual(calls,[])
 current='official';for(const listener of [...listeners])listener()
 await Promise.resolve();assert.deepEqual(calls,['official:controllerOperation'])
 finish(binding);const proof=await initial
 assert.ok(proof);assert.equal(await controller.claimPrepared(proof.sessionId,proof.assertCurrent),true)
 assert.equal(await controller.prepare(),'official');assert.deepEqual(calls,['official:controllerOperation','released']);assert.equal(controller.owns('official'),true)
})

test('初始等待取消或核空期间选择/绑定变化不能认领与改写归属',async()=>{
 for(const change of ['abort','selection','binding'] as const){
  const controller=new AbortController(),storage=memory(),listeners=new Set<()=>void>()
  let current:any='A',binding:any={sessionId:'A'},finish!:(value:boolean)=>void,entered!:()=>void
  const blank=new Promise<boolean>(resolve=>{finish=resolve}),checking=new Promise<void>(resolve=>{entered=resolve})
  const sessions={binding:()=>binding,using:async(_id:string,_options:unknown,operation:any)=>operation({ready:Promise.resolve(),binding})}
  const initial=prepareInitialNativeSession({current:{getSnapshot:()=>current,subscribe:listener=>{listeners.add(listener);return()=>{listeners.delete(listener)}}},sessions:()=>sessions as any,isBlank:async()=>{entered();return blank}},controller.signal,async()=>undefined)
  await checking
  if(change==='abort')controller.abort()
  if(change==='selection')current='B'
  if(change==='binding')binding={sessionId:'A'}
  finish(true)
  await assert.rejects(initial,change==='abort'?{name:'AbortError'}:/作用域已变化/)
  assert.equal(storage.getItem('teloa.home-native-session/v1'),null)
 }
})

test('官方引用 ready 返回前的较新选择不能被初始原稿接续认领',async()=>{
 const ready=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>(),storage=memory(),calls:string[]=[],binding={sessionId:'A'}
 let current:any='A'
 const sessions={binding:()=>binding,using:async(id:string,_options:unknown,operation:any)=>{calls.push(id);entered.resolve();return operation({ready:ready.promise,binding})}}
 const preparing=prepareInitialNativeSession({current:{getSnapshot:()=>current,subscribe:()=>()=>{}},sessions:()=>sessions as any,isBlank:async()=>true},new AbortController().signal,async()=>undefined)
 await entered.promise;current='B';ready.resolve()
 await assert.rejects(preparing,/作用域已变化/)
 assert.deepEqual(calls,['A']);assert.equal(storage.getItem('teloa.home-native-session/v1'),null)
})

test('认领初始会话要求真实空历史，取消与另一份待用身份变化仍失败关闭',async()=>{
 for(const blank of [false,undefined]){
  const storage=memory(),controller=new HomeNativeController({storage,identity:()=> 'new',isBlank:()=>blank,create:async id=>id})
  assert.equal(await controller.claimPrepared('initial',()=>{}),false)
  assert.equal(controller.owns('initial'),false);assert.equal(storage.getItem('teloa.home-native-session/v1'),null)
 }
 const storage=memory(),controller=new HomeNativeController({storage,identity:()=> 'new',isBlank:async()=>{storage.setItem('teloa.home-native-session/v1','newer');return true},create:async id=>id})
 await assert.rejects(controller.claimPrepared('initial',()=>{}),/身份已变化/)
 assert.equal(storage.getItem('teloa.home-native-session/v1'),'newer');assert.equal(controller.owns('initial'),false)
})

test('已有待用草稿身份仍由原生历史恢复，不被官方默认空白会话覆盖',async()=>{
 const storage=memory();storage.setItem('teloa.home-native-session/v1','original')
 const created:string[]=[],controller=new HomeNativeController({storage,identity:()=> 'new',isBlank:()=>true,create:async id=>{created.push(id);return id}})
 assert.equal(await controller.claimPrepared('official-default',()=>{}),false)
 assert.equal(storage.getItem('teloa.home-native-session/v1'),'original')
 assert.equal(await controller.prepare(),'original');assert.deepEqual(created,['original'])
 assert.equal(await controller.claimPrepared('explicit-owned-draft',()=>{},true),true)
 assert.equal(storage.getItem('teloa.home-native-session/v1'),'explicit-owned-draft')
 assert.equal(controller.owns('explicit-owned-draft'),true)
})

test('待用会话并发、刷新和创建回包丢失重试使用同一身份',async()=>{
 const storage=memory(),calls:string[]=[];let failures=1,ids=0
 const port={storage,identity:()=>`s-${++ids}`,isBlank:(_id:string)=>true,create:async(id:string)=>{calls.push(id);if(failures-- >0)throw Error('lost');return id}}
 const controller=new HomeNativeController(port)
 await assert.rejects(controller.prepare(),/lost/)
 const restored=new HomeNativeController(port)
 assert.deepEqual(await Promise.all([restored.prepare(),restored.prepare()]),['s-1','s-1'])
 assert.deepEqual(calls,['s-1','s-1'])
 assert.equal(await restored.prepare(),'s-1')
 assert.equal(ids,1)
})

test('仅明确已发送的待用会话换新，未知恢复状态不产生第二份',async()=>{
 let blank:boolean|undefined=true,ids=0
 const controller=new HomeNativeController({storage:memory(),identity:()=>`s-${++ids}`,isBlank:id=>id==='s-1'?blank:true,create:async id=>id})
 assert.equal(await controller.prepare(),'s-1');blank=undefined
 await assert.rejects(controller.prepare(),/核对/);assert.equal(ids,1);blank=false
 assert.equal(await controller.prepare(),'s-2')
})

test('刷新恢复旧待用ID必须等真实历史加载；已发送ID不adopt不开放，改准备新空白',async()=>{
 const storage=memory();storage.setItem('teloa.home-native-session/v1','old')
 const calls:string[]=[];let finish!:(blank:boolean)=>void
 const controller=new HomeNativeController({storage,identity:()=> 'new',isBlank:id=>id==='old'?new Promise<boolean>(resolve=>{finish=resolve}):true,create:async id=>{calls.push(id);return id}})
 const preparing=controller.prepare();await Promise.resolve();await Promise.resolve()
 assert.deepEqual(calls,[]);assert.equal(controller.owns('old'),false)
 finish(false);assert.equal(await preparing,'new');assert.deepEqual(calls,['new']);assert.equal(controller.owns('old'),false);assert.equal(controller.owns('new'),true)
})

test('同ID创建回包返回后才加载的真实消息也必须复核，未知恢复不清原身份',async()=>{
 const storage=memory();storage.setItem('teloa.home-native-session/v1','old')
 let exists=false,unknown=true;const created:string[]=[]
 const controller=new HomeNativeController({storage,identity:()=> 'new',isBlank:id=>id==='new'?true:!exists?undefined:unknown?undefined:false,create:async id=>{exists=true;created.push(id);return id}})
 await assert.rejects(controller.prepare(),/核对/);assert.equal(storage.getItem('teloa.home-native-session/v1'),'old')
 unknown=false;assert.equal(await controller.prepare(),'new');assert.deepEqual(created,['old','new'])
})

test('上下文写入回包丢失后复用身份，未核对前拒绝改投',async()=>{
 const calls:any[]=[];let lost=true
 const api=createHomeContextApi(async(endpoint,payload:any)=>{calls.push([endpoint,payload]);if(lost){lost=false;throw Error('lost')};return {...payload,version:1,locked:false}},memory(),()=> 'request-1')
 const input={sessionId:'s-1',scopeId:'SOC',roleId:'role-1',expectedVersion:0}
 await assert.rejects(api.set(input),/lost/)
 await assert.rejects(api.set({...input,scopeId:'general'}),/待核对/)
 assert.equal((await api.set(input)).scopeId,'SOC')
 assert.equal(calls[0][1].requestId,calls[1][1].requestId)
})

test('上下文不能接受另一会话的回执',async()=>{
 const api=createHomeContextApi(async()=>({sessionId:'other',scopeId:'general',roleId:null,version:1,locked:false}),memory(),()=> 'request-1')
 await assert.rejects(api.set({sessionId:'s',scopeId:'general',roleId:null,expectedVersion:0}),/身份/)
})

test('另一个已打开标签页可读到未决业务设置，明确拒绝后可改正',async()=>{
 const storage=memory(),tabB=createHomeContextApi(async()=>null,storage)
 const tabA=createHomeContextApi(async()=>{throw Error('lost')},storage,()=> 'stable')
 await assert.rejects(tabA.set({sessionId:'s',scopeId:'SOC',roleId:null,expectedVersion:0}))
 assert.equal(tabB.pending()?.requestId,'stable')
 await assert.rejects(tabB.set({sessionId:'s',scopeId:'Other',roleId:null,expectedVersion:0}),/改投/)
 const rejected=createHomeContextApi(async()=>{throw Object.assign(Error('invalid'),{code:'teloa/invalid-input'})},storage)
 await assert.rejects(rejected.retry());assert.equal(tabA.pending(),undefined);assert.equal(tabB.pending(),undefined)
})

test('read旧版本不能解除未知写入，精确内容和版本对上才恢复',async()=>{
 const storage=memory(),writer=createHomeContextApi(async()=>{throw Error('lost')},storage,()=> 'stable')
 await assert.rejects(writer.set({sessionId:'s',scopeId:'SOC',roleId:null,expectedVersion:1}))
 let version=1
 const reader=createHomeContextApi(async()=>({sessionId:'s',scopeId:'SOC',roleId:null,version,locked:false}),storage)
 await reader.read('s');assert.ok(reader.pending());version=2
 await reader.read('s');assert.equal(writer.pending(),undefined)
})


test('真实已发送回执退役待用会话，过时blank与迟到回执不能复用旧会话或清新草稿',async()=>{
 let ids=0
 const controller=new HomeNativeController({storage:memory(),identity:()=>`s-${++ids}`,isBlank:()=>true,create:async id=>id})
 assert.equal(await controller.prepare(),'s-1')
 controller.accept('s-1');assert.equal(await controller.prepare(),'s-2')
 controller.accept('s-1');assert.equal(await controller.prepare(),'s-2')
})

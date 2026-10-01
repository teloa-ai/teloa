import assert from 'node:assert/strict'
import test from 'node:test'
import {HomeNativeController,createHomeContextApi} from '../src/client/home-native-controller.ts'

const memory=()=>{const rows=new Map<string,string>();return {getItem:(key:string)=>rows.get(key)??null,setItem:(key:string,value:string)=>{rows.set(key,value)},removeItem:(key:string)=>{rows.delete(key)}}}

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

import test from 'node:test'
import assert from 'node:assert/strict'
import {registerHooks} from 'node:module'
import {createApplicationPresentationStore} from '../src/client/application-presentation.ts'

// 只读取本批同源 validator 源码；不 emit 固定核心，也不复制后端分类逻辑。
registerHooks({resolve:(specifier,context,next)=>specifier==='@teloa/contract'&&context.parentURL?.endsWith('/session-capability-presentation.ts')?{url:new URL('../../../contract/src/session-capabilities.ts',import.meta.url).href,shortCircuit:true}:next(specifier,context)})
const {createSessionCapabilityPresentation}=await import('../src/client/session-capability-presentation.ts')
const identity=(name='ML')=>({schema:'teloa.application-presentation/v1',product:'Pro',account:{displayName:name,email:name.toLowerCase()+'@example.test'}})
const rights=(paid:boolean)=>({schema:'teloa.application-capabilities/v1',capabilities:{'general-agent':true,'parallel-agents':paid,groups:paid,people:paid,automation:paid},reason:paid?null:'subscription-expired'})
const classified=(sessionId:string,requiredCapabilities:readonly string[]=['general-agent'])=>({schema:'teloa.session-capabilities/v1',sessionId,status:'ready',requiredCapabilities})
const basic=async()=>{const app=createApplicationPresentationStore();await app.configure({presentation:async()=>identity(),openAccount:async()=>{},capabilities:async()=>rights(false)});return app}

test('社区无商业桥仍全开且无需查询；真实基础会话可发送，高级分类明确只读',async()=>{
 const community=createApplicationPresentationStore();let reads=0
 const free=createSessionCapabilityPresentation(async()=>{reads++;throw Error('not needed')},community)
 free.select('history');assert.equal(free.getSnapshot().status,'ready');assert.equal(reads,0);free.dispose()
 const app=await basic(),reader=createSessionCapabilityPresentation(async sessionId=>classified(sessionId,sessionId==='employee'?['general-agent','people']:['general-agent']),app)
 reader.select('basic');await reader.refresh();assert.equal(reader.getSnapshot().status,'ready');assert.equal(reader.getSnapshot().deniedCapability,undefined)
 reader.select('employee');await reader.refresh();assert.equal(reader.getSnapshot().deniedCapability,'people');reader.dispose()
})

test('到期及恢复实时重读同源分类，不授予未知能力，也不执行授权、发送或购买',async()=>{
 const app=createApplicationPresentationStore();let push!:(value:unknown)=>void,reads=0
 await app.configure({presentation:async()=>identity(),openAccount:async()=>{},capabilities:async()=>rights(true),subscribeCapabilities:listener=>{push=listener;return()=>{}}})
 const reader=createSessionCapabilityPresentation(async sessionId=>{reads++;return classified(sessionId,['general-agent','groups'])},app)
 reader.select('group');await reader.refresh();assert.equal(reader.getSnapshot().deniedCapability,undefined)
 const before=reads;push(rights(false));await reader.refresh();assert.ok(reads>before);assert.equal(reader.getSnapshot().deniedCapability,'groups')
 push(rights(true));await reader.refresh();assert.equal(reader.getSnapshot().deniedCapability,undefined);reader.dispose()
})

test('无法核对、额外字段、错会话和非法分类都保守限制，不能猜员工或群身份',async()=>{
 const app=await basic();let value:unknown
 const reader=createSessionCapabilityPresentation(async()=>value,app);reader.select('current')
 for(value of [{schema:'teloa.session-capabilities/v1',sessionId:'current',status:'unavailable',requiredCapabilities:null},classified('other'),{...classified('current'),ownerProof:'private'},classified('current',['unknown']),classified('current',[])]){
  await reader.refresh();assert.equal(reader.getSnapshot().status,'unavailable');assert.equal(reader.getSnapshot().requiredCapabilities,null);assert.equal(reader.getSnapshot().deniedCapability,undefined);assert.equal(JSON.stringify(reader.getSnapshot()).includes('private'),false)
 }
 reader.dispose()
})

test('换会话与换账号取消旧读取，迟到旧分类不能解除当前限制；释放后不再投影',async()=>{
 const app=await basic();let resolve!:(value:unknown)=>void,oldSignal!:AbortSignal,pending=true
 const reader=createSessionCapabilityPresentation((sessionId,signal)=>sessionId==='old'&&pending?new Promise(done=>{resolve=done;oldSignal=signal}):Promise.resolve(classified(sessionId,['general-agent','automation'])),app)
 reader.select('old');reader.select('new');await reader.refresh();assert.equal(oldSignal.aborted,true)
 resolve(classified('old'));await Promise.resolve();assert.equal(reader.getSnapshot().sessionId,'new');assert.equal(reader.getSnapshot().deniedCapability,'automation')
 reader.select('old');const captured=resolve
 await app.configure({presentation:async()=>identity('Bob'),openAccount:async()=>{},capabilities:async()=>rights(false)})
 pending=false;await reader.refresh();captured(classified('old'));await Promise.resolve();assert.equal(reader.getSnapshot().deniedCapability,'automation')
 reader.select('old');reader.dispose();const snapshot=reader.getSnapshot();reader.select('new');await reader.refresh();assert.equal(reader.getSnapshot(),snapshot)
})

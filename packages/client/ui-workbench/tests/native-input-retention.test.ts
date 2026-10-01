import test from 'node:test'
import assert from 'node:assert/strict'
import type {DraftAttachmentId,InputState} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {SessionBinding,SessionReference} from '@deepseek-ai/dsh-api-session-controller/client'
import {brandString} from '@deepseek-ai/dsh-brand'
import type {SessionId} from '@deepseek-ai/dsh-session'
import {retainNativeInputs} from '../src/client/native-input-retention.ts'

function source<T>(value:T){const listeners=new Set<()=>void>();return {getSnapshot:()=>value,subscribe:(fn:()=>void)=>{listeners.add(fn);return()=>{listeners.delete(fn)}},set(next:T){value=next;for(const fn of [...listeners])fn()},notify(){for(const fn of [...listeners])fn()},listeners}}
const empty=():InputState=>({draft:'',draftRev:0,attachmentIds:[],occurrences:[],queue:[],phase:'plain'})
function fixture(){
 const current=source<SessionId|undefined>(undefined),owner=source<string|null>('owner-A'),catalog=source(0)
 const rows=new Map<SessionId,ReturnType<typeof add>>(),retains:SessionId[]=[],releases:SessionId[]=[]
 function add(name:string){const id=brandString<SessionId>(name),input=source(empty()),session=source({pendingSubmissions:[] as unknown[]}),unknown=source(false)
  const binding={sessionId:id,ctx:{},session} as unknown as SessionBinding
  const row={binding,input,session,unknown};rows.set(id,row);return row
 }
 const ports={current,owner,sessions:{binding:(id:SessionId)=>rows.get(id)?.binding,list:catalog,retain:(id:SessionId)=>{
  const binding=rows.get(id)!.binding;retains.push(id);catalog.notify()
  let active=true
  const release=()=>{if(active){active=false;releases.push(id);catalog.notify()}}
  return {sessionId:id,binding,ready:Promise.resolve(binding),release,[Symbol.dispose]:release} satisfies SessionReference
 }},input:(binding:SessionBinding)=>rows.get(binding.sessionId)!.input,monitor:(binding:SessionBinding)=>rows.get(binding.sessionId)!.unknown}
 const dispose=retainNativeInputs(ports)
 return {add,current,owner,catalog,rows,retains,releases,dispose,ports,select:(name:string)=>current.set(brandString<SessionId>(name))}
}
test('仅真实当前输入持有1个官方引用，切到空B仍保留A；重复同步通知不重入retain',()=>{
 const f=fixture(),a=f.add('A'),b=f.add('B');f.select('A');assert.equal(f.retains.length,0)
 a.input.set({...empty(),attachmentIds:[brandString<DraftAttachmentId>('image-A'),brandString<DraftAttachmentId>('file-A')]})
 assert.deepEqual(f.retains,['A']);f.catalog.notify();a.input.notify();assert.deepEqual(f.retains,['A'])
 f.select('B');assert.deepEqual(f.releases,[]);assert.deepEqual(b.input.getSnapshot(),empty())
 f.select('A');assert.deepEqual(f.retains,['A']);assert.equal(a.input.getSnapshot().attachmentIds.length,2)
 f.dispose();assert.deepEqual(f.releases,['A']);assert.equal(a.input.listeners.size,0);assert.equal(b.input.listeners.size,0)
})
test('完整快照的引用、claim、queue、各非plain阶段均保活，不遍历空历史',()=>{
 for(const patch of [{occurrences:[{}]},{claim:{name:'test',token:'/test'}},{queue:[{}]},{phase:'adjudicating'},{phase:'claimed'},{phase:'submitting'}]){
  const f=fixture(),a=f.add('A');f.add('history');f.select('A');a.input.set({...empty(),...patch} as InputState)
  assert.deepEqual(f.retains,['A']);f.dispose()
 }
})
test('原生pending与共享monitor unknown独立保活，空快照不提前取消detached发送',()=>{
 for(const kind of ['pending','unknown','attachments'] as const){
  const f=fixture(),a=f.add('A');f.add('B');f.select('A')
  if(kind==='pending')a.session.set({pendingSubmissions:[{requestId:'r'}]})
  if(kind==='unknown')a.unknown.set(true)
  if(kind==='attachments')a.input.set({...empty(),attachmentIds:[brandString<DraftAttachmentId>('image-A')]})
  assert.deepEqual(f.retains,['A'])
  // rc.1 的异步reference序列化间隙：input已空，pending尚未出现，不等于发送已结算。
  a.input.set(empty());a.session.set({pendingSubmissions:[]});a.unknown.set(false);f.select('B')
  assert.deepEqual(f.releases,[]);f.dispose();assert.deepEqual(f.releases,['A'])
 }
})
test('身份读取暂缺或断连不释放，确认换owner才清理且不重绑上一owner的binding',()=>{
 const f=fixture(),a=f.add('A');f.select('A');a.input.set({...empty(),draft:'原稿',attachmentIds:[brandString<DraftAttachmentId>('image-A')]})
 f.owner.set(null);f.catalog.notify();assert.deepEqual(f.releases,[])
 f.owner.set('owner-A');assert.deepEqual(f.retains,['A'])
 f.owner.set('owner-B');assert.deepEqual(f.releases,['A']);assert.deepEqual(f.retains,['A'])
 f.catalog.notify();a.input.notify();assert.deepEqual(f.retains,['A'])
 const next=f.add('A');next.input.set({...empty(),draft:'新本人',attachmentIds:[brandString<DraftAttachmentId>('image-new')]});f.catalog.notify();assert.deepEqual(f.retains,['A','A'])
 f.dispose();assert.deepEqual(f.releases,['A','A']);assert.equal(a.input.listeners.size,0)
})
test('同ID官方binding换代只释放旧引用并订阅真实新输入',()=>{
 const f=fixture(),a=f.add('A');f.select('A');a.input.set({...empty(),draft:'旧输入',attachmentIds:[brandString<DraftAttachmentId>('image-old')]})
 const b=f.add('A');f.catalog.notify();assert.deepEqual(f.releases,['A']);assert.equal(a.input.listeners.size,0)
 b.input.set({...empty(),draft:'新输入',attachmentIds:[brandString<DraftAttachmentId>('image-new')]});assert.deepEqual(f.retains,['A','A'])
 a.input.notify();assert.deepEqual(f.retains,['A','A']);f.dispose()
})
test('owner未确认不取得新引用；销毁幂等，迟到通知不复活且全部订阅清理',()=>{
 const f=fixture();f.owner.set(null);const a=f.add('A');f.select('A');a.input.set({...empty(),draft:'内容',attachmentIds:[brandString<DraftAttachmentId>('image-A')]})
 assert.equal(f.retains.length,0);f.owner.set('owner-A');assert.deepEqual(f.retains,['A'])
 f.dispose();f.dispose();f.current.notify();f.owner.notify();f.catalog.notify();a.input.notify()
 assert.deepEqual(f.releases,['A']);assert.deepEqual(f.retains,['A'])
 for(const value of [f.current,f.owner,f.catalog,a.input,a.session,a.unknown])assert.equal(value.listeners.size,0)
})

test('纯文本沿官方持久镜像，不持有引用；开始提交才保活',()=>{
 const f=fixture(),a=f.add('A');f.add('B');f.select('A');a.input.set({...empty(),draft:'纯文本草稿'})
 assert.deepEqual(f.retains,[]);f.select('B');assert.equal(a.input.listeners.size,0);f.select('A')
 a.input.set({...a.input.getSnapshot(),phase:'adjudicating'});assert.deepEqual(f.retains,['A']);f.dispose()
})
test('retain同步回调中ctx销毁也释放新返回引用，不留下复活订阅',()=>{
 const f=fixture(),a=f.add('A');f.select('A')
 const original=f.ports.sessions.retain
 f.ports.sessions.retain=id=>{const reference=original(id);f.dispose();return reference}
 a.input.set({...empty(),attachmentIds:[brandString<DraftAttachmentId>('image-A')]})
 assert.deepEqual(f.retains,['A']);assert.deepEqual(f.releases,['A'])
 for(const value of [f.current,f.owner,f.catalog,a.input,a.session,a.unknown])assert.equal(value.listeners.size,0)
})
test('只按曾需保留的binding增长，无LRU丢稿；owner变化一次回收全部引用和旧订阅',()=>{
 const f=fixture(),edited=[]
 for(let i=0;i<20;i++){
  const a=f.add('edited-'+i);edited.push(a);f.select('edited-'+i)
  a.input.set({...empty(),attachmentIds:[brandString<DraftAttachmentId>('image-'+i)]});a.input.set(empty())
  f.add('empty-'+i);f.select('empty-'+i)
 }
 assert.equal(f.retains.length,20);assert.equal(f.releases.length,0)
 f.owner.set('owner-B');assert.equal(f.releases.length,20)
 for(const row of edited)for(const value of [row.input,row.session,row.unknown])assert.equal(value.listeners.size,0)
 f.dispose();assert.equal(f.releases.length,20)
})
test('历史open失败不误删仍live的原生输入，ready拒绝已处理',async()=>{
 const f=fixture(),a=f.add('A');f.select('A')
 const original=f.ports.sessions.retain
 f.ports.sessions.retain=id=>({...original(id),ready:Promise.reject(Error('offline history'))})
 a.input.set({...empty(),attachmentIds:[brandString<DraftAttachmentId>('image-A')]})
 await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(f.releases,[])
 f.dispose();assert.deepEqual(f.releases,['A'])
})
test('retain同步通知中官方generation退休后binding getter抛错，仍释放引用并继续新generation',async()=>{
 const f=fixture(),a=f.add('A');f.select('A')
 const original=f.ports.sessions.retain;let replacement:ReturnType<typeof f.add>|undefined
 f.ports.sessions.retain=id=>{
  const reference=original(id)
  if(replacement)return reference
  replacement=f.add('A');replacement.input.set({...empty(),attachmentIds:[brandString<DraftAttachmentId>('image-new')]});f.catalog.notify()
  const ready=Promise.reject<SessionBinding>(Error('官方generation已退休'))
  // 官方 ClientSessionReference 本就为 ready 注册内部 catch；红例不宣称未处理拒绝。
  void ready.catch(()=>{})
  return {...reference,ready,get binding():SessionBinding{throw Error('Session reference is released')}}
 }
 assert.doesNotThrow(()=>a.input.set({...empty(),attachmentIds:[brandString<DraftAttachmentId>('image-old')]}))
 await new Promise(resolve=>setImmediate(resolve))
 assert.deepEqual(f.retains,['A','A']);assert.deepEqual(f.releases,['A']);assert.equal(a.input.listeners.size,0)
 assert.equal(replacement!.input.listeners.size,1)
 f.dispose();assert.deepEqual(f.releases,['A','A']);assert.equal(replacement!.input.listeners.size,0)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import {applicationPresentation,applicationProductName,createApplicationPresentationStore,readApplicationPresentation} from '../src/client/application-presentation.ts'
import {personalProfile} from '../src/client/personal-profile.ts'
import {installConversationBrand} from '../src/client/conversation-brand.ts'

const identity=(name='Alice')=>({schema:'teloa.application-presentation/v1',product:'Pro',account:{displayName:name,email:name.toLowerCase()+'@example.test'}})
const bridge=(name='Alice')=>({presentation:async()=>identity(name),openAccount:async()=>{}})

test('社区版名称适配 DSH 与地区语言，商业名称不因翻译改变',()=>{
 for(const locale of ['zh','zh-CN','zh-Hans'])assert.equal(applicationProductName('Free',locale),'社区版')
 for(const locale of ['zh-Hant','zh-TW','zh-HK','zh-MO'])assert.equal(applicationProductName('Free',locale),'社區版')
 for(const locale of ['en','en-US','ja','ko','vi','es','fr','de','pt','unsupported'])assert.equal(applicationProductName('Free',locale),'Community')
 for(const product of ['Pro','Enterprise'] as const)for(const locale of ['zh','en'])assert.equal(applicationProductName(product,locale),product)
})

test('默认 Free 无账号；宿主展示严格裁剪，混合身份或额外许可字段不能进入工作台',()=>{
 const free={schema:'teloa.application-presentation/v1',product:'Free',account:null}
 assert.deepEqual(readApplicationPresentation(free),free)
 assert.deepEqual(readApplicationPresentation(identity()),identity())
 for(const invalid of [{...identity(),token:'private'}, {...identity(),product:'Cloud'}, {...identity(),product:{toString:()=> 'Pro'}},{...free,account:identity().account},{...identity(),account:null},{...identity(),account:{...identity().account,displayName:null}},{...identity(),account:{...identity().account,email:''}}])assert.throws(()=>readApplicationPresentation(invalid))
 for(const displayName of ['', ' '])assert.equal(readApplicationPresentation({...identity(),account:{displayName,email:'alice@example.test'}}).account?.displayName,'')
})

test('后发身份优先；迟到旧读取与旧卸载不能覆盖新账号，关闭后不再打开账号页',async()=>{
 const store=createApplicationPresentationStore();let resolve!:(value:unknown)=>void
 const delayed=store.configure({presentation:()=>new Promise(done=>{resolve=done}),openAccount:async()=>{}})
 const denied=assert.rejects(delayed)
 const close=await store.configure(bridge('Bob'));resolve(identity('Alice'));await denied
 assert.equal(store.getSnapshot().account?.displayName,'Bob')
 const closeNew=await store.configure(bridge('Carol'));close()
 assert.equal(store.getSnapshot().account?.displayName,'Carol');closeNew()
 assert.equal(store.getSnapshot().account,null);await assert.rejects(store.openAccount())
 await assert.rejects(store.configure({presentation:async()=>({...identity(),token:'secret'}),openAccount:async()=>{}}))
 assert.equal(store.getSnapshot().product,'Free')
})

test('账号姓名覆盖全部本人资料与欢迎徽标，禁止本机改名且不将账号信息写入浏览器存储',async t=>{
 const previous=Object.getOwnPropertyDescriptor(globalThis,'window'),values=new Map<string,string>(),writes:string[]=[]
 Object.defineProperty(globalThis,'window',{configurable:true,value:{localStorage:{getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{writes.push(value);values.set(key,value)}},addEventListener(){},removeEventListener(){}}})
 let close:(()=>void)|undefined
 t.after(()=>{close?.();if(previous)Object.defineProperty(globalThis,'window',previous);else Reflect.deleteProperty(globalThis,'window')})
 personalProfile.setDisplayName('Local name')
 let opened=0
 close=await applicationPresentation.configure({...bridge(),openAccount:async()=>{opened++}})
 assert.deepEqual(personalProfile.getSnapshot(),{displayName:'Alice',email:'alice@example.test',managed:true})
 assert.throws(()=>personalProfile.setDisplayName('Wrong account'))
 assert.deepEqual(writes,[JSON.stringify({displayName:'Local name'})])
 const locale={getSnapshot:()=>({active:'en'}),bind:(_namespace:string)=>((key:string)=>key)},dispose=installConversationBrand(locale)
 assert.equal(locale.bind('conversation')('hero.preview'),'Pro')
 await applicationPresentation.openAccount();assert.equal(opened,1)
 close();close=undefined;assert.equal(personalProfile.getSnapshot().displayName,'Local name')
 assert.equal(locale.bind('conversation')('hero.preview'),'Community');dispose()
})

test('无有效账号姓名时个人资料保留空姓名，邮箱只保留在独立账号字段',async t=>{
 let close:(()=>void)|undefined
 t.after(()=>close?.())
 for(const displayName of ['', '  ', 'max@example.test', 'Max <max@example.test>', '  Max   Luo  ']){
  close=await applicationPresentation.configure({presentation:async()=>({...identity(),account:{displayName,email:'max@example.test'}}),openAccount:async()=>{}})
  assert.deepEqual(personalProfile.getSnapshot(),{displayName:displayName.includes('Luo')?'Max Luo':'',email:'max@example.test',managed:true})
  close();close=undefined
 }
})

test('原生导航 scope 仅接收宿主 SHA-256，失败或卸载清空范围，普通 Free 不持久恢复',async()=>{
 const store=createApplicationPresentationStore(),scope='a'.repeat(64)
 const close=await store.configure({...bridge(),navigationStorageScope:async()=>scope})
 assert.equal(store.getNavigationStorageScope(),scope)
 close();assert.equal(store.getNavigationStorageScope(),undefined)
 for(const invalid of ['', 'alice@example.test', 'a'.repeat(63), 'g'.repeat(64), scope+' ', null]){
  await assert.rejects(store.configure({...bridge(),navigationStorageScope:async()=>invalid as string}))
  assert.equal(store.getNavigationStorageScope(),undefined)
 }
 await store.configure(bridge());assert.equal(store.getNavigationStorageScope(),undefined)
 await store.configure({presentation:async()=>({schema:'teloa.application-presentation/v1',product:'Free',account:null}),openAccount:async()=>{},navigationStorageScope:async()=>scope})
 assert.equal(store.getNavigationStorageScope(),undefined)
})

test('迟到旧导航 scope 与旧卸载不能覆盖新账号范围',async()=>{
 const store=createApplicationPresentationStore();let resolve!:(value:string)=>void
 const delayed=store.configure({...bridge(),navigationStorageScope:()=>new Promise(done=>{resolve=done})})
 const denied=assert.rejects(delayed)
 await Promise.resolve()
 const close=await store.configure({...bridge('Bob'),navigationStorageScope:async()=> 'b'.repeat(64)})
 resolve('a'.repeat(64));await denied
 assert.equal(store.getSnapshot().account?.displayName,'Bob')
 assert.equal(store.getNavigationStorageScope(),'b'.repeat(64))
 const closeNew=await store.configure({...bridge('Carol'),navigationStorageScope:async()=> 'c'.repeat(64)})
 close();assert.equal(store.getNavigationStorageScope(),'c'.repeat(64))
 closeNew();assert.equal(store.getNavigationStorageScope(),undefined)
})

const rights=(allowed:boolean,reason:unknown=allowed?null:'subscription-expired')=>({schema:'teloa.application-capabilities/v1',capabilities:{'general-agent':true,'parallel-agents':allowed,groups:allowed,people:allowed,automation:allowed},reason})

test('社区能力默认全开；商业缺失或非法权益保守只读，不能由身份名称授予高级能力',async()=>{
 const store=createApplicationPresentationStore()
 assert.equal(store.getCapabilitySnapshot().capabilities.groups,true)
 await store.configure(bridge())
 assert.equal(store.getCapabilitySnapshot().capabilities['general-agent'],true)
 assert.equal(store.getCapabilitySnapshot().capabilities.groups,false)
 assert.equal(store.getCapabilitySnapshot().reason,'unavailable')
 for(const value of [{...rights(true),token:'private'},rights(true,'unknown'),{...rights(true),capabilities:{...rights(true).capabilities,groups:'yes'}},null]){
  await store.configure({...bridge(),capabilities:async()=>value})
  assert.equal(store.getCapabilitySnapshot().capabilities.people,false)
  assert.equal(store.getCapabilitySnapshot().reason,'unavailable')
 }
 await store.configure()
 assert.equal(store.getCapabilitySnapshot().capabilities.automation,true)
})

test('权益实时到期降为只读，迟到读取及旧账号推送不能重新授予高级能力',async()=>{
 const store=createApplicationPresentationStore();let push!:(value:unknown)=>void,resolve!:(value:unknown)=>void,unsubscribed=0
 const configured=store.configure({...bridge(),capabilities:()=>new Promise(done=>{resolve=done}),subscribeCapabilities:listener=>{push=listener;return()=>{unsubscribed++}}})
 await Promise.resolve();await Promise.resolve()
 assert.equal(store.getCapabilitySnapshot().reason,'checking')
 push(rights(false));resolve(rights(true));const close=await configured
 assert.equal(store.getCapabilitySnapshot().reason,'subscription-expired')
 push(rights(true));assert.equal(store.getCapabilitySnapshot().capabilities.groups,true)
 push(rights(false));assert.equal(store.getCapabilitySnapshot().capabilities.groups,false)
 await store.configure({...bridge('Bob'),capabilities:async()=>rights(true)})
 push(rights(false));close()
 assert.equal(store.getSnapshot().account?.displayName,'Bob')
 assert.equal(store.getCapabilitySnapshot().capabilities.groups,true)
 assert.equal(unsubscribed,1)
})

test('订阅入口只在本人主动调用时打开；可选新桥优先且旧宿主回退账号入口',async()=>{
 const store=createApplicationPresentationStore();let account=0,subscription=0
 const owner={...bridge(),openAccount:async()=>{account++},openSubscription:async()=>{subscription++},capabilities:async()=>rights(false)}
 await store.configure(owner);assert.equal(subscription,0);assert.equal(account,0)
 await store.openSubscription();assert.equal(subscription,1);assert.equal(account,0)
 await store.configure({...bridge(),openAccount:async()=>{account++}})
 await store.openSubscription();assert.equal(account,1)
 await store.configure();await assert.rejects(store.openSubscription())
})

test('宿主就绪后重新核实名字；暂不可用到有效权益及连接恢复都更新本人昵称',async()=>{
 const store=createApplicationPresentationStore();let name='',push!:(value:unknown)=>void,ready=false
 const current=()=>({...identity(),account:{displayName:name,email:'alice@example.test'}})
 await store.configure({presentation:async()=>current(),openAccount:async()=>{},capabilities:async()=>rights(false,ready?'subscription-required':'unavailable'),subscribeCapabilities:listener=>{push=listener;return()=>{}}})
 assert.equal(store.getSnapshot().account?.displayName,'')
 name='ML';ready=true;push(rights(false,'subscription-required'));await Promise.resolve();await Promise.resolve()
 assert.equal(store.getSnapshot().account?.displayName,'ML')
 name='Max Luo';await store.refresh()
 assert.equal(store.getSnapshot().account?.displayName,'Max Luo')
 assert.equal(store.getSnapshot().account?.email,'alice@example.test')
})

test('昵称回执与本人归属隔离；迟到旧刷新不能覆盖新账号或沿旧导航范围换号',async()=>{
 const store=createApplicationPresentationStore();let resolve!:(value:unknown)=>void,delayed=false
 await store.configure({presentation:()=>delayed?new Promise(done=>{resolve=done}):Promise.resolve(identity()),openAccount:async()=>{}})
 delayed=true;const old=store.refresh()
 await Promise.resolve()
 await store.configure(bridge('Bob'));resolve(identity('Wrong owner'));await old
 assert.equal(store.getSnapshot().account?.displayName,'Bob')
 let current=identity('Bob')
 await store.configure({presentation:async()=>current,openAccount:async()=>{},capabilities:async()=>rights(true)})
 current=identity('Carol');await store.refresh()
 assert.equal(store.getSnapshot().account?.displayName,'Bob')
 assert.equal(store.getCapabilitySnapshot().reason,'unavailable')
})

import test from 'node:test'
import assert from 'node:assert/strict'
import {applicationPresentation,createApplicationPresentationStore,readApplicationPresentation} from '../src/client/application-presentation.ts'
import {personalProfile} from '../src/client/personal-profile.ts'
import {installConversationBrand} from '../src/client/conversation-brand.ts'

const identity=(name='Alice')=>({schema:'teloa.application-presentation/v1',product:'Pro',account:{displayName:name,email:name.toLowerCase()+'@example.test'}})
const bridge=(name='Alice')=>({presentation:async()=>identity(name),openAccount:async()=>{}})

test('默认 Free 无账号；宿主展示严格裁剪，混合身份或额外许可字段不能进入工作台',()=>{
 const free={schema:'teloa.application-presentation/v1',product:'Free',account:null}
 assert.deepEqual(readApplicationPresentation(free),free)
 assert.deepEqual(readApplicationPresentation(identity()),identity())
 for(const invalid of [{...identity(),token:'private'}, {...identity(),product:'Cloud'}, {...identity(),product:{toString:()=> 'Pro'}},{...free,account:identity().account},{...identity(),account:null},{...identity(),account:{...identity().account,displayName:' '}}])assert.throws(()=>readApplicationPresentation(invalid))
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
 assert.equal(locale.bind('conversation')('hero.preview'),'Free');dispose()
})

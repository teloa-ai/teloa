import assert from 'node:assert/strict'
import test from 'node:test'
import {HomeNativeController} from '../src/client/home-native-controller.ts'
import {recoverHomeNativeInput} from '../src/client/home-native-preparation.ts'

test('恢复领养的短暂断连沿用同一待用会话，不新建第二份草稿',async()=>{
 const values=new Map<string,string>(),created=new Set<string>(),adopted:string[]=[]
 let identities=0
 const home=new HomeNativeController({
  storage:{getItem:key=>values.get(key)??null,setItem:(key,value)=>{values.set(key,value)},removeItem:key=>{values.delete(key)}},
  identity:()=>`home-${++identities}`,isBlank:()=>true,
  create:async id=>{created.add(id);return id},
  adopt:async id=>{adopted.push(id);if(adopted.length===1)throw TypeError('connection lost')},
 })
 assert.equal(await recoverHomeNativeInput(()=>home.prepare(),new AbortController().signal),'home-1')
 assert.equal(identities,1);assert.deepEqual([...created],['home-1']);assert.deepEqual(adopted,['home-1','home-1'])
 assert.equal(home.owns('home-1'),true)
})

test('持续不可用的自动恢复有次数上限，并保留原始失败供重试入口展示',async()=>{
 const failure=TypeError('connection lost');let calls=0
 await assert.rejects(recoverHomeNativeInput(async()=>{calls++;throw failure},new AbortController().signal),error=>error===failure)
 assert.equal(calls,3)
})

for(const code of ['teloa/home-location-required','teloa/forbidden','teloa/storage-corrupt'])test(code+' 不自动重试明确的前置条件或业务拒绝',async()=>{
 const failure=Object.assign(Error('rejected'),{code});let calls=0
 await assert.rejects(recoverHomeNativeInput(async()=>{calls++;throw failure},new AbortController().signal),error=>error===failure)
 assert.equal(calls,1)
})

test('离开页面取消退避中的恢复，不再重试或选中旧会话',async()=>{
 const controller=new AbortController();let calls=0
 const recovering=recoverHomeNativeInput(async()=>{calls++;throw TypeError('connection lost')},controller.signal)
 await new Promise<void>(resolve=>setImmediate(resolve));controller.abort()
 await assert.rejects(recovering,{name:'AbortError'});assert.equal(calls,1)
})

test('旧准备器忽略取消后迟到的成功也不能作为当前首页结果',async()=>{
 const controller=new AbortController();let finish!:(value:string)=>void
 const recovering=recoverHomeNativeInput(()=>new Promise(resolve=>{finish=resolve}),controller.signal)
 controller.abort();finish('old-home')
 await assert.rejects(recovering,{name:'AbortError'})
})

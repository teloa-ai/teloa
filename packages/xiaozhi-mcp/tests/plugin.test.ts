import test from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {readFile} from 'node:fs/promises'
import {WorkError} from '@teloa/contract'
import * as plugin from '../src/index.ts'

const {Context}=createRequire(new URL('../../harness-dsh/package.json',import.meta.url))('@deepseek-ai/cordis')
const signal=new AbortController().signal
const endpoint='wss://api.xiaozhi.me/mcp/?token=private-endpoint'
async function mount(version=1){
 assert.equal(typeof plugin.apply,'function','独立包必须提供真实 Cordis 插件入口')
 const calls:string[]=[],secrets=new Map<string,string>()
 let enabled=false,handler:((endpoint:string,payload:unknown,signal:AbortSignal)=>Promise<unknown>)|undefined
 let requestPort:unknown
 let resultReader=async()=>({operationId:'op',state:'completed',speakableText:'原结果',resultRef:null})
 const ctx=new Context()
 ctx.provide('credentials',{
  describe:async(ref:string)=>({configured:secrets.has(ref),writable:true}),
  resolve:async(ref:string)=>secrets.has(ref)?{value:secrets.get(ref),source:'test'}:undefined,
  set:async(ref:string,value:string)=>{secrets.set(ref,value)},
 })
 ctx.provide('teloaAssistantChannels',{version,attach:(registration:{id:string;handle:typeof handler})=>{
  assert.equal(registration.id,'xiaozhi-mcp');handler=registration.handle;calls.push('attach')
  return {
   requests:{prepare:async(text:string)=>({operationId:'op',state:'prepared',speakableText:text,resultRef:null}),submit:async()=>{},result:()=>resultReader()},
   snapshot:async()=>({enabled,scopes:enabled?['assistant.send','reply.read','task.prepare']:[],grantVersion:1,assistantName:'小松鼠'}),
   updateGrant:async()=>{enabled=true;calls.push('grant')},
   revoke:async()=>{enabled=false;calls.push('revoke')},
   close:async()=>{enabled=false;handler=undefined;calls.push('close')},
  }
 }})
 const fiber=ctx.plugin(plugin,{createBridge:(ports:{requests:unknown;endpoint:()=>Promise<string>})=>{
  requestPort=ports.requests
  return {state:'idle',start:()=>{calls.push('connect');void ports.endpoint().then(value=>assert.equal(value,endpoint))},stop:async()=>{calls.push('stop')}}
 }})
 await fiber
 return {calls,secrets,fiber,invoke:(route:string,payload:unknown={})=>handler!(route,payload,signal),requests:()=>requestPort,attached:()=>!!handler,setResultReader:(read:typeof resultReader)=>{resultReader=read}}
}

test('插件装载与保存不联网；本人启用后才连接，状态和日志不返回接入点秘密',async()=>{
 const {calls,fiber,invoke}=await mount()
 try{
  assert.equal(calls.includes('connect'),false)
  const saved=await invoke('devices/mcp/save',{endpoint})
  assert.equal(calls.includes('connect'),false)
  assert.doesNotMatch(JSON.stringify(saved),/private-endpoint|wss:/)
  await invoke('devices/grant/update',{scopes:['assistant.send','reply.read','task.prepare']})
  assert.equal(calls.filter(x=>x==='connect').length,1)
  assert.doesNotMatch(JSON.stringify(await invoke('devices/status')),/private-endpoint|wss:/)
 }finally{await fiber.dispose()}
})

test('撤销和卸载先拒绝新请求，释放管理处理器，保留原生工作由宿主负责',async()=>{
 const mounted=await mount()
 await mounted.invoke('devices/mcp/save',{endpoint})
 await mounted.invoke('devices/grant/update',{scopes:['assistant.send','reply.read','task.prepare']})
 const requests=mounted.requests() as {prepare:(text:string)=>Promise<unknown>}
 assert.equal((await requests.prepare('测试') as {state:string}).state,'prepared')
 const revoked=mounted.invoke('devices/revoke')
 assert.equal(mounted.calls.at(-1),'revoke','持久撤销调用的同步屏障不能等断链结束')
 await assert.rejects(requests.prepare('迟到输入'),{code:'teloa/forbidden'})
 await revoked
 await mounted.fiber.dispose()
 assert.equal(mounted.attached(),false)
 assert.equal(mounted.calls.filter(x=>x==='close').length,1)
 await assert.rejects(requests.prepare('卸载后'),{code:'teloa/forbidden'})
 assert.equal(mounted.calls.includes('cancel'),false)
})

test('撤销期间刚读出的旧结果不能迟到外发',async()=>{
 const mounted=await mount()
 try{
  await mounted.invoke('devices/mcp/save',{endpoint})
  await mounted.invoke('devices/grant/update',{scopes:['assistant.send','reply.read','task.prepare']})
  let finish!:()=>void
  const held=new Promise<void>(resolve=>{finish=resolve})
  mounted.setResultReader(async()=>{await held;return {operationId:'op',state:'completed',speakableText:'原结果',resultRef:null}})
  const pending=(mounted.requests() as {result:()=>Promise<unknown>}).result()
  const blocked=assert.rejects(pending,{code:'teloa/forbidden'})
  const revoked=mounted.invoke('devices/revoke')
  finish();await blocked;await revoked
 }finally{await mounted.fiber.dispose()}
})

test('没有凭据不能启用，不兼容宿主不挂接、不连接；任意管理参数不可进入工具端口',async()=>{
 const mounted=await mount()
 try{
  await assert.rejects(mounted.invoke('devices/grant/update',{scopes:['assistant.send']}),{code:'teloa/unavailable'})
  await assert.rejects(mounted.invoke('devices/mcp/save',{endpoint,owner:'other'}),{code:'teloa/invalid-input'})
  await assert.rejects(mounted.invoke('devices/status',{sessionId:'other'}),{code:'teloa/invalid-input'})
  await assert.rejects(mounted.invoke('arbitrary/endpoint'),{code:'teloa/forbidden'})
  assert.equal(mounted.calls.includes('connect'),false)
  assert.deepEqual(Object.keys(mounted.requests() as object).sort(),['prepare','result','submit'])
 }finally{await mounted.fiber.dispose()}
 // Cordis 将装载失败记在 fiber；直接 apply 核验兼容检查的固定脱敏错误。
 assert.throws(()=>plugin.apply({get:()=>({version:0})} as never),(error:unknown)=>error instanceof WorkError&&error.code==='teloa/unavailable')
})

test('包使用可选 DSH bundle，不把小智反向加入主宿主或默认组合',async()=>{
 const manifest=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'))
 assert.deepEqual(manifest.dsh,{bundle:{patch:'./cordis.patch.yml'}})
 assert.equal(manifest.engines.dsh,'0.2.1-rc.2')
 assert.ok(!('@teloa/harness-dsh'in manifest.dependencies))
 assert.ok(!('@teloa/backend'in manifest.dependencies))
 const harness=JSON.parse(await readFile(new URL('../../harness-dsh/package.json',import.meta.url),'utf8'))
 const bundle=JSON.parse(await readFile(new URL('../../bundle/package.json',import.meta.url),'utf8'))
 assert.ok(!('@teloa/xiaozhi-mcp'in harness.dependencies))
 assert.ok(!('@teloa/xiaozhi-mcp'in bundle.dependencies))
 const {parse}=createRequire(new URL('../../harness-dsh/package.json',import.meta.url))('yaml')
 assert.deepEqual(parse(await readFile(new URL('../cordis.patch.yml',import.meta.url),'utf8')),[{insert:[{id:'teloa-xiaozhi-mcp',name:'@teloa/xiaozhi-mcp'}]}])
})

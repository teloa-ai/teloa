import test from 'node:test'
import assert from 'node:assert/strict'
import {getEventListeners} from 'node:events'
import {readOllamaAddress,WorkError} from '@teloa/contract'
import {OllamaClient} from '../src/ollama-client.ts'
import {startOllamaStub,type StubOptions} from './fixtures/ollama-stub.ts'

const models=[{name:'qwen3:8b',size:5_200_000_000,digest:'sha256:'+'a'.repeat(64),capabilities:['completion','tools']},{name:'phi4:14b',size:9_100_000_000,digest:'sha256:'+'c'.repeat(64),family:'phi3',parameterSize:'14B'}]
async function withStub<T>(options:StubOptions,run:(stub:Awaited<ReturnType<typeof startOllamaStub>>,client:OllamaClient)=>Promise<T>):Promise<T>{
 const stub=await startOllamaStub(options)
 try{return await run(stub,new OllamaClient(readOllamaAddress(stub.baseURL),{timeoutMs:1000}))}finally{await stub.close()}
}
const code=(error:unknown)=>error instanceof WorkError?error.code:String(error)

test('version / tags / ps / show：固定路径 GET/POST，回包按 §3 形状收窄',async()=>{
 await withStub({version:'0.12.1',models,running:['qwen3:8b']},async(stub,client)=>{
  assert.equal(await client.version(),'0.12.1')
  assert.deepEqual(await client.tags(),[
   {name:'qwen3:8b',size:5_200_000_000,digest:'sha256:'+'a'.repeat(64),family:'qwen3',parameterSize:'8B',quantizationLevel:'Q4_K_M'},
   {name:'phi4:14b',size:9_100_000_000,digest:'sha256:'+'c'.repeat(64),family:'phi3',parameterSize:'14B',quantizationLevel:'Q4_K_M'},
  ])
  assert.deepEqual(await client.ps(),[{name:'qwen3:8b',digest:stub.models.find(row=>row.name==='qwen3:8b')!.digest,contextLength:4096}])
  assert.deepEqual(await client.show('qwen3:8b'),{family:'qwen3',contextLength:40960,capabilities:['completion','tools']})
  assert.deepEqual(await client.show('phi4:14b'),{family:'phi3',contextLength:40960,capabilities:null})
  assert.deepEqual(stub.calls.map(c=>[c.method,c.path]),[['GET','/api/version'],['GET','/api/tags'],['GET','/api/ps'],['POST','/api/show'],['POST','/api/show']])
  assert.deepEqual(stub.calls[3]!.body,{model:'qwen3:8b'})
 })
})
test('连接被拒 → teloa/dependency-unavailable；fetch 抛错也归为依赖不可用',async()=>{
 const client=new OllamaClient(readOllamaAddress('http://127.0.0.1:1'),{timeoutMs:500})
 await assert.rejects(client.version(),error=>code(error)==='teloa/dependency-unavailable')
 const thrower=new OllamaClient(readOllamaAddress('http://127.0.0.1:11434'),{fetch:async()=>{throw new TypeError('fetch failed')}})
 await assert.rejects(thrower.tags(),error=>code(error)==='teloa/dependency-unavailable')
})
test('空聊天只请求加载，运行容量来自 ps；缺字段保持未知',async()=>{
 await withStub({models:[models[0]!,{...models[1]!,allocatedContext:null}]},async(stub,client)=>{
  const controller=new AbortController()
  assert.deepEqual(await client.ps(),[])
  await client.load('qwen3:8b',controller.signal)
  assert.deepEqual(stub.calls.find(call=>call.path==='/api/chat')?.body,{model:'qwen3:8b',messages:[],stream:false})
  assert.equal((await client.ps())[0]!.contextLength,4096)
  await client.load('phi4:14b',controller.signal)
  assert.equal((await client.ps())[1]!.contextLength,null)
  assert.equal(getEventListeners(controller.signal,'abort').length,0)
 })
})
test('运行容量畸形或同名重复拒绝，不静默使用错误容量',async()=>{
 const row={name:'qwen3:8b',digest:models[0]!.digest,context_length:4096}
 for(const rows of [[row,row],...[0,-1,1.2,'4096',null,Number.MAX_SAFE_INTEGER+1].map(value=>[{...row,context_length:value}]),[{...row,digest:''}]]){
  const client=new OllamaClient(readOllamaAddress('http://127.0.0.1:11434'),{fetch:async()=>new Response(JSON.stringify({models:rows}))})
  await assert.rejects(client.ps(),{code:'teloa/invalid-host-response'})
 }
})
test('官方清单裸摘要与目录 sha256 摘要统一，坏摘要不能落盘',async()=>{
 const hex='a'.repeat(64)
 for(const digest of [hex,`sha256:${hex}`]){
  const client=new OllamaClient(readOllamaAddress('http://127.0.0.1:11434'),{fetch:async()=>new Response(JSON.stringify({models:[{name:'qwen3:8b',size:10,digest,context_length:4096}]}))})
  assert.equal((await client.tags())[0]!.digest,`sha256:${hex}`)
  assert.equal((await client.ps())[0]!.digest,`sha256:${hex}`)
 }
 for(const digest of ['a'.repeat(63),'sha512:'+'a'.repeat(64),'not-a-digest']){
  const client=new OllamaClient(readOllamaAddress('http://127.0.0.1:11434'),{fetch:async()=>new Response(JSON.stringify({models:[{name:'qwen3:8b',size:10,digest,context_length:4096}]}))})
  await assert.rejects(client.tags(),{code:'teloa/invalid-host-response'})
  await assert.rejects(client.ps(),{code:'teloa/invalid-host-response'})
 }
})
test('空加载响应超时和中途取消都结束等待并清理监听（直连与 DNS 钉住）',async()=>{
 const stub=await startOllamaStub({hangLoadBody:true})
 try{
  for(const pinned of [false,true]){
   const address=readOllamaAddress(pinned?`http://ollama.lan:${stub.port}`:stub.baseURL)
   const deps={loadTimeoutMs:100,...(pinned?{lookup:async()=>[{address:'127.0.0.1',family:4}]}:{})}
   const signal=new AbortController().signal,started=Date.now()
   await assert.rejects(new OllamaClient(address,deps).load('qwen3:8b',signal),{code:'teloa/dependency-unavailable'})
   assert.ok(Date.now()-started<1500)
   assert.equal(getEventListeners(signal,'abort').length,0)
   const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),40)
   try{await assert.rejects(new OllamaClient(address,{...deps,loadTimeoutMs:5000}).load('qwen3:8b',controller.signal),{name:'AbortError'})}finally{clearTimeout(timer)}
   assert.equal(getEventListeners(controller.signal,'abort').length,0)
  }
 }finally{await stub.close()}
})
test('非 2xx / 非 JSON / 形状不符 → teloa/invalid-host-response',async()=>{
 await withStub({versionContentType:'text/html'},async(_stub,client)=>{
  await assert.rejects(client.version(),error=>code(error)==='teloa/invalid-host-response')
 })
 await withStub({models},async(_stub,client)=>{
  await assert.rejects(client.show('missing:1b'),error=>code(error)==='teloa/invalid-host-response')
  await assert.rejects(client.remove('missing:1b'),error=>code(error)==='teloa/invalid-host-response')
 })
 const badShape=new OllamaClient(readOllamaAddress('http://127.0.0.1:11434'),{fetch:async()=>new Response(JSON.stringify({models:[{name:'x'}]}),{status:200,headers:{'Content-Type':'application/json'}})})
 await assert.rejects(badShape.tags(),error=>code(error)==='teloa/invalid-host-response')
 const notObject=new OllamaClient(readOllamaAddress('http://127.0.0.1:11434'),{fetch:async()=>new Response('[]',{status:200,headers:{'Content-Type':'application/json'}})})
 await assert.rejects(notObject.version(),error=>code(error)==='teloa/invalid-host-response')
})
test('remove：DELETE /api/delete 带 model；成功后桩清单减少',async()=>{
 await withStub({models},async(stub,client)=>{
  await client.remove('phi4:14b')
  assert.deepEqual(stub.calls.at(-1),{method:'DELETE',path:'/api/delete',body:{model:'phi4:14b'},host:stub.calls.at(-1)!.host})
  assert.deepEqual(stub.models.map(m=>m.name),['qwen3:8b'])
 })
})
test('pull：≥4 次进度且 completed 单调递增，桩记录 POST /api/pull，结束后清单含新模型',async()=>{
 await withStub({pullChunks:5},async(stub,client)=>{
  const progress:{completed:number;total:number|null;status:string}[]=[]
  await client.pull('gemma3:4b',p=>progress.push(p),new AbortController().signal)
  assert.ok(progress.length>=4,`进度回调 ${progress.length} 次`)
  for(let i=1;i<progress.length;i++)assert.ok(progress[i]!.completed>=progress[i-1]!.completed,'completed 单调递增')
  assert.equal(progress.at(-1)!.status,'success')
  assert.deepEqual(stub.calls.map(c=>[c.method,c.path,c.body]),[['POST','/api/pull',{model:'gemma3:4b',stream:true}]])
  assert.ok(stub.models.some(m=>m.name==='gemma3:4b'))
 })
})
test('pull：{error} 行 → teloa/source-unavailable，错误文字进入消息',async()=>{
 await withStub({pullError:'pull model manifest: dial tcp: no such host'},async(_stub,client)=>{
  await assert.rejects(client.pull('nope:1b',()=>{},new AbortController().signal),error=>code(error)==='teloa/source-unavailable'&&/no such host/.test((error as Error).message))
 })
})
test('pull：第 2 片后 abort → 以 AbortError 拒绝，桩响应被销毁',async()=>{
 await withStub({pullChunks:6,pullDelayMs:40},async(stub,client)=>{
  const controller=new AbortController();let count=0
  await assert.rejects(client.pull('gemma3:4b',()=>{if(++count===2)controller.abort()},controller.signal),error=>(error as Error).name==='AbortError')
  await new Promise(r=>setTimeout(r,120))
  assert.equal(stub.lastPullResponse()?.destroyed,true)
  assert.ok(!stub.models.some(m=>m.name==='gemma3:4b'))
 })
})
test('pull：分片空闲超时 → teloa/source-unavailable 并断开',async()=>{
 const stub=await startOllamaStub({pullChunks:3,pullDelayMs:300})
 try{
  const client=new OllamaClient(readOllamaAddress(stub.baseURL),{pullIdleTimeoutMs:60})
  await assert.rejects(client.pull('gemma3:4b',()=>{},new AbortController().signal),error=>code(error)==='teloa/source-unavailable')
  await new Promise(r=>setTimeout(r,120))
  assert.equal(stub.lastPullResponse()?.destroyed,true)
 }finally{await stub.close()}
})
test('DNS 名：每次请求前解析；解析到拒绝网段 → teloa/forbidden 且不发请求',async()=>{
 let fetched=0
 const client=new OllamaClient(readOllamaAddress('http://ollama.lan:11434'),{lookup:async()=>[{address:'169.254.169.254',family:4}],fetch:async(...args)=>{fetched++;return fetch(...args)}})
 await assert.rejects(client.version(),error=>code(error)==='teloa/forbidden')
 const mixed=new OllamaClient(readOllamaAddress('http://ollama.lan:11434'),{lookup:async()=>[{address:'10.0.0.8',family:4},{address:'fe80::1',family:6}],fetch:async(...args)=>{fetched++;return fetch(...args)}})
 await assert.rejects(mixed.tags(),error=>code(error)==='teloa/forbidden')
 const unresolved=new OllamaClient(readOllamaAddress('http://ollama.lan:11434'),{lookup:async()=>{throw new Error('ENOTFOUND')},fetch:async(...args)=>{fetched++;return fetch(...args)}})
 await assert.rejects(unresolved.version(),error=>code(error)==='teloa/dependency-unavailable')
 const empty=new OllamaClient(readOllamaAddress('http://ollama.lan:11434'),{lookup:async()=>[],fetch:async(...args)=>{fetched++;return fetch(...args)}})
 await assert.rejects(empty.version(),error=>code(error)==='teloa/forbidden')
 for(const [address,family] of [['::ffff:a9fe:a9fe',6],['fd00:ec2::254',6],['100.100.100.200',4]] as const){
  const blocked=new OllamaClient(readOllamaAddress('http://ollama.lan:11434'),{lookup:async()=>[{address,family}]})
  await assert.rejects(blocked.version(),error=>code(error)==='teloa/forbidden')
 }
 assert.equal(fetched,0)
})
test('DNS 名：钉住解析出的第一个地址建连，保留原 Host 头',async()=>{
 await withStub({version:'0.9.0'},async(stub,_client)=>{
  const lookups:string[]=[]
  const client=new OllamaClient(readOllamaAddress(`http://ollama.lan:${stub.port}`),{lookup:async host=>{lookups.push(host);return [{address:'127.0.0.1',family:4}]}})
  assert.equal(await client.version(),'0.9.0')
  assert.equal(await client.version(),'0.9.0')
  assert.deepEqual(lookups,['ollama.lan','ollama.lan'])
  assert.equal(stub.calls[0]!.host,`ollama.lan:${stub.port}`)
 })
})
test('redirect：跳转响应不跟随，归为依赖不可用',async()=>{
 const client=new OllamaClient(readOllamaAddress('http://127.0.0.1:11434'),{fetch:async(_url,init)=>{assert.equal((init as RequestInit).redirect,'error');throw new TypeError('fetch failed: unexpected redirect')}})
 await assert.rejects(client.version(),error=>code(error)==='teloa/dependency-unavailable')
})
test('DNS 名钉住通道：pull 进度、abort 与空闲超时语义与直连一致',async()=>{
 const stub=await startOllamaStub({pullChunks:6,pullDelayMs:40})
 try{
  const pin={lookup:async()=>[{address:'127.0.0.1',family:4}]}
  const progress:number[]=[]
  await new OllamaClient(readOllamaAddress(`http://ollama.lan:${stub.port}`),pin).pull('gemma3:4b',p=>progress.push(p.completed),new AbortController().signal)
  assert.ok(progress.length>=6)
  assert.deepEqual(stub.calls.map(c=>[c.method,c.path,c.host]),[['POST','/api/pull',`ollama.lan:${stub.port}`]])
  const controller=new AbortController();let count=0
  await assert.rejects(new OllamaClient(readOllamaAddress(`http://ollama.lan:${stub.port}`),pin).pull('llama3.1:8b',()=>{if(++count===2)controller.abort()},controller.signal),error=>(error as Error).name==='AbortError')
  await assert.rejects(new OllamaClient(readOllamaAddress(`http://ollama.lan:${stub.port}`),{...pin,pullIdleTimeoutMs:10}).pull('phi4:14b',()=>{},new AbortController().signal),error=>code(error)==='teloa/source-unavailable')
  await new Promise(r=>setTimeout(r,120))
  assert.equal(stub.lastPullResponse()?.destroyed,true)
 }finally{await stub.close()}
})
test('审查 H-2：响应头到了但体不结束 → 在 timeoutMs 内以 dependency-unavailable 结束（直连与钉住通道）',async()=>{
 const stub=await startOllamaStub({hangVersionBody:true})
 try{
  for(const deps of [{timeoutMs:300},{timeoutMs:300,lookup:async()=>[{address:'127.0.0.1',family:4}]}]){
   const address=readOllamaAddress(deps.lookup?`http://ollama.lan:${stub.port}`:stub.baseURL),started=Date.now()
   await assert.rejects(new OllamaClient(address,deps).version(),error=>code(error)==='teloa/dependency-unavailable')
   const elapsed=Date.now()-started
   assert.ok(elapsed>=250&&elapsed<1500,`耗时 ${elapsed}ms 应接近 timeoutMs`)
  }
 }finally{await stub.close()}
})
test('审查 H-2：非流式回包超过 1 MiB → invalid-host-response；1 MiB 以内照常解析',async()=>{
 await withStub({tagsPaddingBytes:1_100_000},async(_stub,client)=>{
  await assert.rejects(client.tags(),error=>code(error)==='teloa/invalid-host-response'&&/上限/.test((error as Error).message))
 })
 await withStub({tagsPaddingBytes:900_000},async(_stub,client)=>{assert.deepEqual(await client.tags(),[])})
})
test('审查 M-1：拉取分片无换行超过 64 KiB → invalid-host-response 并断开；空闲计时只按解析出的行重置',async()=>{
 const stub=await startOllamaStub({pullRawBytes:4_000_000})
 try{
  const client=new OllamaClient(readOllamaAddress(stub.baseURL),{timeoutMs:1000})
  await assert.rejects(client.pull('gemma3:4b',()=>{},new AbortController().signal),error=>code(error)==='teloa/invalid-host-response'&&/过长/.test((error as Error).message))
  await new Promise(r=>setTimeout(r,120))
  assert.equal(stub.lastPullResponse()?.destroyed,true)
 }finally{await stub.close()}
})
test('审查 L-3：show / pull / remove 的模型名在客户端层按 Ollama 名称文法校验，不发请求',async()=>{
 let fetched=0
 const client=new OllamaClient(readOllamaAddress('http://127.0.0.1:11434'),{fetch:async(...args)=>{fetched++;return fetch(...args)}})
 for(const bad of ['qwen3','../x:1','Qwen3:8B','a:b c','',"x:1\n"]){
  await assert.rejects(client.show(bad),error=>code(error)==='teloa/invalid-input',bad)
  await assert.rejects(client.remove(bad),error=>code(error)==='teloa/invalid-input',bad)
  await assert.rejects(client.pull(bad,()=>{},new AbortController().signal),error=>code(error)==='teloa/invalid-input',bad)
 }
 assert.equal(fetched,0)
})
test('审查 L-1：注入 fetch 只对 IP 字面量生效，DNS 名仍走钉住通道',async()=>{
 await withStub({version:'0.9.0'},async(stub,_client)=>{
  let injected=0
  const client=new OllamaClient(readOllamaAddress(`http://ollama.lan:${stub.port}`),{lookup:async()=>[{address:'127.0.0.1',family:4}],fetch:async(...args)=>{injected++;return fetch(...args)}})
  assert.equal(await client.version(),'0.9.0')
  assert.equal(injected,0)
  assert.equal(stub.calls[0]!.host,`ollama.lan:${stub.port}`)
 })
})
test('DNS 未返回也受整体截止时间与外部取消约束，超时后不发请求',async()=>{
 const client=new OllamaClient(readOllamaAddress('http://ollama.lan:11434'),{timeoutMs:40,lookup:()=>new Promise(()=>{})})
 const bounded=(run:Promise<unknown>)=>Promise.race([run,new Promise((_,reject)=>setTimeout(()=>reject(Error('请求没有按时结束')),500))])
 await assert.rejects(bounded(client.version()),error=>code(error)==='teloa/dependency-unavailable')
 const controller=new AbortController()
 const pull=bounded(client.pull('qwen3:4b',()=>{},controller.signal))
 controller.abort()
 await assert.rejects(pull,error=>error instanceof Error&&error.name==='AbortError')
 assert.equal(getEventListeners(controller.signal,'abort').length,0)
})
test('拉取进度按 UTF-8 字节限制整行与末行，结束后释放外部取消监听',async()=>{
 for(const text of ['x'.repeat(65_536),'字'.repeat(30_000)]){
  for(const ending of ['\n','']){
   const controller=new AbortController()
   const client=new OllamaClient(readOllamaAddress('http://127.0.0.1:11434'),{fetch:async()=>new Response(JSON.stringify({status:text})+ending)})
   await assert.rejects(client.pull('qwen3:4b',()=>{},controller.signal),error=>code(error)==='teloa/invalid-host-response')
   assert.equal(getEventListeners(controller.signal,'abort').length,0)
  }
 }
})
test('拉取流未收到 success 就结束，不能把旧模型当成这次下载成功',async()=>{
 for(const body of ['',JSON.stringify({status:'pulling manifest'})+'\n']){
  const client=new OllamaClient(readOllamaAddress('http://127.0.0.1:11434'),{fetch:async()=>new Response(body)})
  await assert.rejects(client.pull('qwen3:4b',()=>{},new AbortController().signal),error=>code(error)==='teloa/source-unavailable')
 }
})

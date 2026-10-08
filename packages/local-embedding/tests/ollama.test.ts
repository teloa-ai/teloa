import test,{type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import {createServer,type IncomingMessage,type ServerResponse} from 'node:http'
import {setTimeout as sleep} from 'node:timers/promises'
import {readEmbeddingPreparationState,readRetrievalPreparationDetails,type EmbeddingPreparationState} from '@teloa/contract'
import {createOllamaEmbeddingProvider,embeddingGemma2Digest,embeddingGemma2Model,embeddingGemma2Profile,embeddingGemma2ProfileHash,ollamaPreparationDetails} from '../src/ollama.ts'

const nativeVector=()=>Array.from({length:768},(_,i)=>i===0?2:0)
const json=(res:ServerResponse,value:unknown,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value))}
async function server(t:TestContext,handle:(req:IncomingMessage,res:ServerResponse,body:Record<string,unknown>)=>void|Promise<void>){
 const requests:{path:string;body:Record<string,unknown>}[]=[]
 const instance=createServer(async(req,res)=>{
  let bytes='';for await(const chunk of req)bytes+=String(chunk)
  const body=bytes?JSON.parse(bytes):{}
  requests.push({path:req.url!,body})
  await handle(req,res,body)
 })
 await new Promise<void>(resolve=>instance.listen(0,'127.0.0.1',resolve))
 t.after(()=>new Promise<void>((resolve,reject)=>{instance.close(error=>error?reject(error):resolve());instance.closeAllConnections()}))
 const address=instance.address() as {port:number}
 return {endpoint:`http://127.0.0.1:${address.port}`,requests}
}
const tags=(digest=embeddingGemma2Digest)=>({models:[{name:embeddingGemma2Model,digest:digest.replace(/^sha256:/,'')}]})
const wait=async(check:()=>boolean)=>{for(let i=0;i<200&&!check();i++)await sleep(5);assert.ok(check())}

test('Ollama端点只接受数字loopback且拒绝凭据、路径、查询和非HTTP；配置摘要绑定维度、摘要及精确前缀',()=>{
 for(const endpoint of ['https://127.0.0.1:11434','http://localhost:11434','http://example.com:11434','http://127.0.0.1:11434/proxy','http://user:pass@127.0.0.1:11434','http://127.0.0.1:11434/?key=x'])
  assert.throws(()=>createOllamaEmbeddingProvider({endpoint,totalMemoryBytes:16*1024**3}),/本机/)
 const profile=embeddingGemma2Profile
 assert.equal(profile.nativeDimensions,768);assert.equal(profile.storageDimensions,1024)
 assert.equal(profile.queryInstruction,'task: search result | query: ')
 assert.equal(profile.documentPrefix,'title: none | text: ')
 assert.notEqual(embeddingGemma2ProfileHash({...profile,storageDimensions:768}),embeddingGemma2ProfileHash())
 assert.notEqual(embeddingGemma2ProfileHash({...profile,modelDigest:'sha256:'+'a'.repeat(64)}),embeddingGemma2ProfileHash())
 assert.notEqual(embeddingGemma2ProfileHash({...profile,queryInstruction:'query: '}),embeddingGemma2ProfileHash())
 const details=readRetrievalPreparationDetails(ollamaPreparationDetails())
 assert.equal(details.kind,'ollama')
 if(details.kind==='ollama'){
  assert.equal(details.license,'Apache-2.0')
  assert.equal(details.model.bytes,1325205612)
  assert.equal(details.model.digest,embeddingGemma2Digest)
  assert.equal('integrity' in details.runtime,false)
 }
})

test('启用只检查本机服务和digest；未下载不隐式pull或embed，显式prepare消费实际层进度后进入ready',async t=>{
 let installed=false
 const states:EmbeddingPreparationState[]=[]
 const local=await server(t,(_req,res,body)=>{
  if(_req.url==='/api/version')return json(res,{version:'0.40.1'})
  if(_req.url==='/api/tags')return json(res,installed?tags():{models:[]})
  if(_req.url==='/api/pull'){
   assert.deepEqual(body,{model:embeddingGemma2Model,stream:true})
   res.writeHead(200,{'content-type':'application/x-ndjson'})
   res.write(JSON.stringify({status:'pulling layer',digest:'sha256:'+'a'.repeat(64),total:100,completed:40})+'\n')
   res.write(JSON.stringify({status:'pulling layer',digest:'sha256:'+'b'.repeat(64),total:60,completed:30})+'\n')
   installed=true;res.end(JSON.stringify({status:'success'})+'\n');return
  }
  if(_req.url==='/api/embed')return json(res,{model:embeddingGemma2Model,embeddings:(body.input as string[]).map(nativeVector)})
  json(res,{error:'不支持'},404)
 })
 const provider=createOllamaEmbeddingProvider({...local,totalMemoryBytes:16*1024**3,onChange:state=>states.push(readEmbeddingPreparationState(state))})
 t.after(()=>provider.dispose())
 await provider.inspected
 assert.equal(provider.state().phase,'unprepared')
 await assert.rejects(provider.embed({kind:'query',texts:['报销']},new AbortController().signal),{code:'teloa/dependency-unavailable'})
 assert.ok(local.requests.every(row=>row.path==='/api/version'||row.path==='/api/tags'))
 provider.prepare();await provider.settled()
 assert.equal(provider.state().phase,'ready')
 assert.deepEqual(local.requests.filter(row=>row.path==='/api/embed').map(row=>row.body.input),[['task: search result | query: Teloa']],'明确准备须用固定无用户资料短文本验证真实嵌入')
 assert.ok(states.some(state=>state.phase==='downloading'&&state.stage==='assets'&&state.completedBytes===70))
 assert.ok(!states.some(state=>state.phase==='downloading'&&state.stage==='runtime'))
 assert.equal(provider.snapshotRow().variant,'ollama')
 assert.equal(provider.snapshotRow().profileHash,embeddingGemma2ProfileHash())
})

test('明确准备实际探针：摘要到位而Ollama不支持推理或返回错误维度时不能宣称ready',async t=>{
 for(const behavior of ['unsupported','dimensions'] as const){
  let installed=false
  const local=await server(t,(req,res)=>{
   if(req.url==='/api/version')return json(res,{version:'0.40.1'})
   if(req.url==='/api/tags')return json(res,installed?tags():{models:[]})
   if(req.url==='/api/pull'){installed=true;res.end(JSON.stringify({status:'success'})+'\n');return}
   if(req.url==='/api/embed')return behavior==='unsupported'?json(res,{error:'unsupported architecture'},500):json(res,{model:embeddingGemma2Model,embeddings:[[1,0]]})
   json(res,{error:'不支持'},404)
  })
  const provider=createOllamaEmbeddingProvider({...local,totalMemoryBytes:16*1024**3})
  t.after(()=>provider.dispose())
  await provider.inspected;provider.prepare();await provider.settled()
  assert.equal(provider.state().phase,'failed',behavior)
  assert.equal(local.requests.filter(row=>row.path==='/api/embed').length,1)
 }
})

test('明确准备已有缓存也执行真实探针；仅启用检查不进行推理',async t=>{
 const local=await server(t,(req,res,body)=>{
  if(req.url==='/api/version')return json(res,{version:'0.40.1'})
  if(req.url==='/api/tags')return json(res,tags())
  if(req.url==='/api/embed')return json(res,{model:embeddingGemma2Model,embeddings:(body.input as string[]).map(nativeVector)})
  json(res,{error:'不应调用'},404)
 })
 const provider=createOllamaEmbeddingProvider({...local,totalMemoryBytes:16*1024**3})
 t.after(()=>provider.dispose())
 await provider.inspected
 assert.equal(provider.state().phase,'standby')
 assert.equal(local.requests.filter(row=>row.path==='/api/embed').length,0)
 provider.prepare();await provider.settled()
 assert.equal(provider.state().phase,'ready')
 assert.deepEqual(local.requests.filter(row=>row.path==='/api/embed').map(row=>row.body.input),[['task: search result | query: Teloa']])
 assert.equal(local.requests.filter(row=>row.path==='/api/pull').length,0)
})

test('原生768维向量以精确检索前缀调用/api/embed，L2归一化并补256零；每次推理核验摘要',async t=>{
 let digest=embeddingGemma2Digest
 let changeDuringEmbed=false
 const local=await server(t,(req,res,body)=>{
  if(req.url==='/api/version')return json(res,{version:'0.40.1'})
  if(req.url==='/api/tags')return json(res,tags(digest))
  if(req.url==='/api/embed'){
   if(changeDuringEmbed)digest='sha256:'+'d'.repeat(64)
   return json(res,{model:embeddingGemma2Model,embeddings:(body.input as string[]).map(nativeVector)})
  }
  json(res,{error:'不支持'},404)
 })
 const provider=createOllamaEmbeddingProvider({...local,totalMemoryBytes:16*1024**3})
 t.after(()=>provider.dispose())
 await provider.inspected
 const query=await provider.embed({kind:'query',texts:['报销']},new AbortController().signal)
 await provider.embed({kind:'passage',texts:['审批流程']},new AbortController().signal)
 assert.equal(query.vectors[0]!.length,1024)
 assert.equal(query.vectors[0]![0],1)
 assert.ok(query.vectors[0]!.slice(768).every(value=>value===0))
 const embeddings=local.requests.filter(row=>row.path==='/api/embed')
 assert.deepEqual(embeddings.map(row=>row.body.input),[['task: search result | query: 报销'],['title: none | text: 审批流程']])
 assert.ok(embeddings.every(row=>row.body.truncate===false&&row.body.dimensions===768))
 assert.ok(local.requests.every(row=>row.path!=='/api/chat'))
 digest='sha256:'+'d'.repeat(64)
 await assert.rejects(provider.embed({kind:'query',texts:['报销']},new AbortController().signal),{code:'teloa/dependency-unavailable'})
 assert.equal(local.requests.filter(row=>row.path==='/api/embed').length,2)
 assert.equal(provider.state().phase,'unprepared')
 // 使用同一接口创建新提供器复核：推理开始后发生标签漂移也拒绝返回向量。
 digest=embeddingGemma2Digest;changeDuringEmbed=true
 const during=createOllamaEmbeddingProvider({...local,totalMemoryBytes:16*1024**3})
 t.after(()=>during.dispose())
 await during.inspected
 await assert.rejects(during.embed({kind:'query',texts:['报销']},new AbortController().signal),{code:'teloa/dependency-unavailable'})
 assert.equal(local.requests.filter(row=>row.path==='/api/embed').length,3)
})

test('pull摘要漂移与畸形向量拒绝使用；不静默回退；非官方下载来源拒绝',async t=>{
 let installed=false
 const local=await server(t,(req,res)=>{
  if(req.url==='/api/version')return json(res,{version:'0.40.1'})
  if(req.url==='/api/tags')return json(res,installed?tags('sha256:'+'d'.repeat(64)):{models:[]})
  if(req.url==='/api/pull'){installed=true;res.end(JSON.stringify({status:'success'})+'\n');return}
  json(res,{error:'不支持'},404)
 })
 const provider=createOllamaEmbeddingProvider({...local,totalMemoryBytes:16*1024**3})
 t.after(()=>provider.dispose())
 await provider.inspected;provider.prepare();await provider.settled()
 const failed=provider.state()
 assert.equal(failed.phase,'failed')
 assert.equal(failed.phase==='failed'&&failed.download?.reason,'integrity')
 const calls=local.requests.length
 provider.prepare({source:'hf-mirror'});await provider.settled()
 assert.equal(provider.state().phase,'failed')
 assert.ok(local.requests.slice(calls).every(row=>row.path!=='/api/pull'))

 const malformed=await server(t,(req,res)=>{
  if(req.url==='/api/version')return json(res,{version:'0.40.1'})
  if(req.url==='/api/tags')return json(res,tags())
  if(req.url==='/api/embed')return json(res,{model:embeddingGemma2Model,embeddings:[Array(768).fill(0)]})
  json(res,{error:'不支持'},404)
 })
 const other=createOllamaEmbeddingProvider({...malformed,totalMemoryBytes:16*1024**3})
 t.after(()=>other.dispose())
 await other.inspected
 await assert.rejects(other.embed({kind:'query',texts:['x']},new AbortController().signal),{code:'teloa/dependency-unavailable'})
})

test('pull取消会等待请求收尾，再发布cancelled；停用只释放请求，不关闭Ollama服务',async t=>{
 let pulling=false,disconnected=false
 const local=await server(t,(req,res)=>{
  if(req.url==='/api/version')return json(res,{version:'0.40.1'})
  if(req.url==='/api/tags')return json(res,{models:[]})
  if(req.url==='/api/pull'){
   pulling=true
   res.on('close',()=>{disconnected=true})
   res.write(JSON.stringify({status:'pulling layer',digest:'sha256:'+'a'.repeat(64),total:100,completed:20})+'\n');return
  }
  json(res,{error:'不支持'},404)
 })
 const provider=createOllamaEmbeddingProvider({...local,totalMemoryBytes:16*1024**3})
 await provider.inspected;provider.prepare();await wait(()=>pulling)
 await provider.cancelPreparation()
 assert.equal(provider.state().phase,'cancelled')
 await wait(()=>disconnected)
 await provider.dispose()
 assert.equal((await fetch(local.endpoint+'/api/version')).ok,true)
})


test('老版本在拉取前拒绝，MLX 不支持与安全网络拒绝返回可理解的原因且不泄露原始错误',async t=>{
 for(const [version,message,reason] of [
  ['0.34.4','','runtime-version'],
  ['0.40.1','this model requires MLX support, but the MLX runtime is not available','runtime-unsupported'],
  ['0.40.1','refusing non-public IP 198.18.0.100 at https://private.example.test?token=secret','network']
 ] as const){
  const local=await server(t,(req,res)=>{
   if(req.url==='/api/version')return json(res,{version})
   if(req.url==='/api/tags')return json(res,{models:[]})
   if(req.url==='/api/pull')return json(res,{error:message},400)
   json(res,{},404)
  })
  const provider=createOllamaEmbeddingProvider({...local,totalMemoryBytes:16*1024**3});t.after(()=>provider.dispose())
  await provider.inspected;provider.prepare();await provider.settled()
  const state=provider.state();assert.equal(state.phase,'failed')
  if(state.phase==='failed'){assert.equal(state.download?.reason,reason);assert.doesNotMatch(state.message,/198\.18|private\.example|secret|MLX/)}
  if(version==='0.34.4')assert.equal(local.requests.some(row=>row.path==='/api/pull'),false)
 }
})

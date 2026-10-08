import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,readdir,rm,stat,writeFile,mkdir} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {randomUUID} from 'node:crypto'
import {WorkError,localModelEndpoints,type LocalModelsOverview,type PullJobView,type MarketCatalogModelEntry} from '@teloa/contract'
import {OfficialCatalogService,type MarketContentStore} from '@teloa/backend'
import {createLocalModelsHandler,type LocalModelsDeps} from '../src/local-models.ts'
import {OllamaClient} from '../src/ollama-client.ts'
import {createTeloaWorkService} from '../src/teloa-work-service.ts'
import {startOllamaStub,type StubOptions} from './fixtures/ollama-stub.ts'

const catalog=new OfficialCatalogService({} as unknown as MarketContentStore).listLocalModelEntries()
const qwen=catalog.find(entry=>entry.id==='teloa.model.local.qwen3')!
const qwenVariants=qwen.model.form==='local-general'?qwen.model.variants:[]
const qwen4bDigest=qwenVariants[0]!.sources[0].digest!
const llama=catalog.find(entry=>entry.id==='teloa.model.local.llama3.1')!
const GiB=2**30
const code=(error:unknown)=>error instanceof WorkError?error.code:String(error)
const rid=()=>randomUUID()

type Op={op:string;path:readonly string[];value?:unknown}
function fakeSettings(initial?:Record<string,unknown>){
 const section:Record<string,unknown>={providers:initial?{ollama:initial}:{}}
 let revision=1
 const ops:Op[][]=[],timeline:string[]=[]
 return {ops,timeline,current:()=>section,writable:true,
  describe:()=>[{ns:'llm-pi-ai',revision,value:section,user:section}],
  mutate:async(_ns:string,edits:readonly Op[],expected?:number)=>{
   if(expected!==revision)throw Object.assign(Error('stale'),{code:'SETTINGS_CONFLICT'})
   ops.push([...edits]);timeline.push('route')
   for(const edit of edits){
    let cursor=section
    for(const key of edit.path.slice(0,-1)){if(typeof cursor[key]!=='object'||cursor[key]===null)cursor[key]={};cursor=cursor[key] as Record<string,unknown>}
    const last=edit.path[edit.path.length-1]!
    if(edit.op==='set')cursor[last]=edit.value;else delete cursor[last]
   }
   revision++
  }}
}
const routeIds=(settings:ReturnType<typeof fakeSettings>)=>{const route=(settings.current().providers as Record<string,{models?:{id:string}[]}>).ollama;return route?.models?.map(m=>m.id)??[]}

async function stand(stubOptions:StubOptions|null,over:Partial<LocalModelsDeps>={}){
 const runtimeRoot=await mkdtemp(join(tmpdir(),'teloa-local-models-'))
 const stub=stubOptions===null?null:await startOllamaStub(stubOptions)
 const settings=fakeSettings(),sets:string[]=[]
 const deps:LocalModelsDeps={
  runtimeRoot,catalog:()=>catalog,settings,
  // 与 DSH 一致：set 之后 describe 即报已配置，占位凭据只写一次。
  credentials:{describe:async()=>({configured:sets.length>0,writable:true}),set:async(ref)=>{sets.push(ref)}},
  client:address=>{
   const client=new OllamaClient(address,{timeoutMs:1000,lookup:async()=>[{address:'127.0.0.1',family:4}]})
   return {version:()=>client.version(),tags:()=>client.tags(),ps:signal=>client.ps(signal),load:(name,signal)=>client.load(name,signal),show:name=>client.show(name),pull:(name,onProgress,signal)=>client.pull(name,onProgress,signal),remove:name=>{settings.timeline.push('delete');return client.remove(name)}}
  },
  hardware:()=>({totalMemBytes:32*GiB,arch:'arm64',platform:'darwin'}),
  diskFree:async()=>500*GiB,
  logger:{info(){},warn(){}},
  ...over,
 }
 // 桩地址预写进状态文件（与浏览器验收启动器同一机制）
 if(stub){await mkdir(runtimeRoot,{recursive:true});await writeFile(join(runtimeRoot,'local-models.json'),JSON.stringify({format:'teloa.local-models/v1',address:{baseURL:stub.baseURL,custom:true,updatedAt:'2026-09-26T00:00:00.000Z'},records:[]}))}
 const handler=createLocalModelsHandler(deps)
 const overview=()=>handler.handle('local-models/overview',{}) as Promise<LocalModelsOverview>
 const invoke=async(endpoint:string,payload:unknown)=>handler.handle(endpoint,['local-models/pull','local-models/attach','local-models/remove'].includes(endpoint)?{expectedAddress:(await overview()).runtime.address.baseURL,...payload as object}:payload)
 const row=(o:LocalModelsOverview,name:string)=>o.rows.find(r=>r.name===name)!
 const records=async()=>(JSON.parse(await readFile(join(runtimeRoot,'local-models.json'),'utf8')) as {records:{name:string;status:string;routeModelId:string|null}[]}).records
 const waitPull=async(until:(view:PullJobView)=>boolean)=>{for(let i=0;i<400;i++){const view=await handler.handle('local-models/pull-status',{}) as PullJobView|null;if(view&&until(view))return view;await new Promise(r=>setTimeout(r,10))}throw new Error('拉取作业没有到达预期阶段')}
 const close=async()=>{await handler.dispose();await stub?.close();await rm(runtimeRoot,{recursive:true,force:true})}
 return {runtimeRoot,stub,settings,sets,handler,invoke,overview,row,records,waitPull,close}
}
const pullInput=(entry:MarketCatalogModelEntry,variant:number,acknowledgeRestrictions=false)=>({requestId:rid(),entryId:entry.id,version:entry.version,variant,acknowledgeRestrictions})

test('真实思考元数据贯穿下载核验和目录外接入，写入原生模型声明',async t=>{
 const e=await stand({version:'0.34.4',models:[{name:'qwen3:4b',size:2497293931,digest:qwen4bDigest,capabilities:['completion','thinking'],thinking:{values:[true],default:true}}]});t.after(e.close)
 await e.invoke('local-models/pull',pullInput(qwen,0))
 assert.equal((await e.waitPull(view=>view.phase==='done'||view.phase==='failed')).phase,'done')
 const models=()=>(e.settings.current().providers as Record<string,{models:{reasoningEfforts:unknown}[]}>).ollama!.models
 assert.deepEqual(models()[0]!.reasoningEfforts,{high:'high'})
 await e.invoke('local-models/attach',{requestId:rid(),name:'qwen3:4b'})
 assert.deepEqual(models()[0]!.reasoningEfforts,{high:'high'})
})
test('旧版缺思考元数据保留已下载权重且不写路由；目录外接入也不能绕过',async t=>{
 const e=await stand({models:[{name:'qwen3:4b',size:2497293931,digest:qwen4bDigest,capabilities:['completion','thinking']}]});t.after(e.close)
 await e.invoke('local-models/pull',pullInput(qwen,0))
 const failed=await e.waitPull(view=>view.phase==='failed'||view.phase==='done')
 assert.equal(failed.phase,'failed');assert.match(failed.error!,/更新 Ollama/)
 assert.deepEqual(routeIds(e.settings),[]);assert.deepEqual(e.sets,[])
 assert.ok(e.stub!.models.some(model=>model.name==='qwen3:4b'))
 await assert.rejects(e.invoke('local-models/attach',{requestId:rid(),name:'qwen3:4b'}),{code:'teloa/source-unavailable'})
 assert.deepEqual(routeIds(e.settings),[])
})

test('会话批准后下载目标或目录事实变化：写锁内拒绝，不启动拉取',async t=>{
 const e=await stand({});t.after(e.close)
 const facts=await e.handler.pullFacts(qwen.id,0)
 assert.equal(facts.baseURL,e.stub!.baseURL);assert.equal(facts.quant,qwenVariants[0]!.quant)
 for(const altered of [{...facts,baseURL:'http://127.0.0.1:1'},{...facts,sizeBytes:facts.sizeBytes+1},{...facts,licenseTier:'restricted' as const},{...facts,catalogDigest:null}]){
  await assert.rejects(e.handler.startPull(pullInput(qwen,0),altered),{code:'teloa/version-conflict'})
  assert.equal((await e.overview()).pull,null)
 }
})

test('下载前磁盘检查期间取消，不创建作业或调用 pull',async t=>{
 const controller=new AbortController()
 const e=await stand({},{diskFree:async()=>{controller.abort();return 500*GiB}});t.after(e.close)
 await assert.rejects(e.handler.startPull(pullInput(qwen,0),undefined,controller.signal),{name:'AbortError'})
 assert.equal(await e.invoke('local-models/pull-status',{}),null)
})

test('目录服务只回 local-general 五条目；变体名称带 tag、首条 qwen3:4b 有目录摘要',()=>{
 assert.equal(catalog.length,5)
 assert.ok(catalog.every(entry=>entry.kind==='model'&&entry.model.form==='local-general'))
 assert.equal(qwenVariants[0]!.sources[0].name,'qwen3:4b')
 assert.match(qwen4bDigest,/^sha256:[0-9a-f]{64}$/)
})

test('overview：桩关闭 → runtime.state missing、行 runtime-missing、pull 为 null、磁盘为 null',async()=>{
 const t=await stand({});await t.stub!.close()
 try{
  const o=await t.overview()
  assert.equal(o.runtime.state,'missing');assert.equal(o.runtime.version,null);assert.equal(o.pull,null)
  assert.ok(o.rows.length>=9);assert.ok(o.rows.every(r=>r.status==='runtime-missing'))
  assert.equal(o.hardware.diskFreeBytes,null);assert.equal(o.offCatalog.length,0)
  assert.equal(o.runtime.address.baseURL,t.stub!.baseURL);assert.equal(o.runtime.address.custom,true);assert.equal(o.runtime.address.local,true)
 }finally{await t.close()}
})

test('overview：桩开清单空 → not-pulled；version 0.5.9 → outdated；硬件 8 GiB → qwen3:4b slow / qwen3:14b poor；32 GiB → 14b good；目录外模型分组',async()=>{
 const small=await stand({version:'0.5.9',models:[{name:'foo:latest',size:123,digest:'sha256:'+'f'.repeat(64),family:'llama',parameterSize:'1B'}],running:['foo:latest']},{hardware:()=>({totalMemBytes:8*GiB,arch:'x64',platform:'linux'})})
 try{
  const o=await small.overview()
  assert.equal(o.runtime.state,'running');assert.equal(o.runtime.version,'0.5.9');assert.equal(o.runtime.outdated,true)
  assert.equal(o.hardware.totalMemGb,8);assert.equal(o.hardware.unified,false);assert.equal(o.hardware.diskFreeBytes,500*GiB)
  assert.ok(o.rows.every(r=>r.status==='not-pulled'&&r.loaded===false))
  assert.equal(small.row(o,'qwen3:4b').fit,'slow');assert.equal(small.row(o,'qwen3:14b').fit,'poor')
  assert.equal(small.row(o,'qwen3:4b').catalogDigest,qwen4bDigest);assert.equal(small.row(o,'llama3.1:8b').licenseTier,'restricted')
  assert.deepEqual(o.offCatalog,[{name:'foo:latest',sizeBytes:123,family:'llama',parameterSize:'1B',loaded:true,runtimeContextLength:4096,status:'unverified'}])
 }finally{await small.close()}
 const big=await stand({version:'0.12.0'})
 try{
  const o=await big.overview()
  assert.equal(o.runtime.outdated,false);assert.equal(o.hardware.unified,true)
  assert.equal(big.row(o,'qwen3:14b').fit,'good');assert.equal(big.row(o,'qwen3:4b').fit,'good')
 }finally{await big.close()}
})

test('address：合法外部地址写入（custom:true、local:false）、null 恢复缺省；坏地址 invalid-input 且文件不变；未知字段拒绝',async()=>{
 const t=await stand({})
 try{
  const before=await readFile(join(t.runtimeRoot,'local-models.json'),'utf8')
  await assert.rejects(t.invoke('local-models/address',{requestId:rid(),baseURL:'http://169.254.169.254:80'}),error=>code(error)==='teloa/invalid-input')
  await assert.rejects(t.invoke('local-models/address',{requestId:rid(),baseURL:'http://ollama.lan:11434/v1'}),error=>code(error)==='teloa/invalid-input')
  await assert.rejects(t.invoke('local-models/address',{requestId:rid(),baseURL:'http://ollama.lan:1',extra:1}),error=>code(error)==='teloa/invalid-input')
  assert.equal(await readFile(join(t.runtimeRoot,'local-models.json'),'utf8'),before)
  // DNS 名注入解析到 127.0.0.1:1（立即拒连）：外部地址写入成功，探测为 missing
  const external=await t.invoke('local-models/address',{requestId:rid(),baseURL:'http://ollama.lan:1/'}) as LocalModelsOverview
  assert.deepEqual(external.runtime.address,{baseURL:'http://ollama.lan:1',custom:true,local:false});assert.equal(external.runtime.state,'missing')
  const saved=JSON.parse(await readFile(join(t.runtimeRoot,'local-models.json'),'utf8')) as {address:{baseURL:string;custom:boolean}}
  assert.deepEqual([saved.address.baseURL,saved.address.custom],['http://ollama.lan:1',true])
  const restored=await t.invoke('local-models/address',{requestId:rid(),baseURL:null}) as LocalModelsOverview
  assert.deepEqual(restored.runtime.address,{baseURL:'http://127.0.0.1:11434',custom:false,local:true})
  assert.equal(((await stat(join(t.runtimeRoot,'local-models.json'))).mode&0o777),0o600)
 }finally{await t.close()}
})

test('pull：restricted 未知悉 → invalid-input；磁盘 1 GiB → dependency-unavailable；版本不符 → version-conflict；条目不存在 → not-found',async()=>{
 const t=await stand({},{diskFree:async()=>1*GiB})
 try{
  await assert.rejects(t.invoke('local-models/pull',pullInput(llama,0,false)),error=>code(error)==='teloa/invalid-input')
  await assert.rejects(t.invoke('local-models/pull',pullInput(qwen,0)),error=>code(error)==='teloa/dependency-unavailable')
  await assert.rejects(t.invoke('local-models/pull',{...pullInput(qwen,0),version:'9.9.9'}),error=>code(error)==='teloa/version-conflict')
  await assert.rejects(t.invoke('local-models/pull',{...pullInput(qwen,0),entryId:'teloa.model.local.nope'}),error=>code(error)==='teloa/not-found')
  await assert.rejects(t.invoke('local-models/pull',{...pullInput(qwen,0),variant:5}),error=>code(error)==='teloa/invalid-input')
  assert.equal(t.stub!.calls.filter(c=>c.path==='/api/pull').length,0)
 }finally{await t.close()}
})

test('pull：digest 与目录一致 → pulling → done、行 ready、路由 ops 含该 id、records 写入 routeModelId、占位凭据 set 一次；同 requestId 重放回同一作业；并发第二个 pull → conflict',async()=>{
 const t=await stand({pullChunks:6,pullDelayMs:15,pulledDigest:()=>qwen4bDigest})
 try{
  const input=pullInput(qwen,0)
  const started=await t.invoke('local-models/pull',input) as PullJobView
  assert.equal(started.phase,'pulling');assert.equal(started.name,'qwen3:4b');assert.equal(started.error,null)
  const replayed=await t.invoke('local-models/pull',input) as PullJobView
  // 重放回同一作业的当前进度；HTTP 桩可在两次回包之间合法推进。
  assert.equal(replayed.pullId,started.pullId);assert.equal(replayed.name,started.name);assert.equal(replayed.error,null)
  assert.ok(replayed.completed>=started.completed&&replayed.completed<=4_000_000)
  assert.ok(replayed.total===null||replayed.total===4_000_000)
  await assert.rejects(t.invoke('local-models/pull',pullInput(qwen,1)),error=>code(error)==='teloa/conflict')
  const mid=await t.overview();assert.ok(['pulling','verifying'].includes(t.row(mid,'qwen3:4b').status));assert.equal(mid.pull?.pullId,started.pullId)
  const done=await t.waitPull(view=>view.phase==='done'||view.phase==='failed')
  assert.equal(done.phase,'done');assert.equal(done.error,null);assert.equal(done.completed,4_000_000);assert.equal(done.total,4_000_000)
  assert.ok(done.completed>=replayed.completed)
  assert.deepEqual(t.stub!.calls.filter(call=>call.path==='/api/pull').map(call=>call.body),[{model:'qwen3:4b',stream:true}],'重放必须保持固定参数且不产生第二次实际拉取')
  const o=await t.overview()
  assert.equal(t.row(o,'qwen3:4b').status,'ready');assert.equal(o.pull?.phase,'done')
  assert.deepEqual(routeIds(t.settings),['qwen3:4b']);assert.equal(t.settings.ops.length,1)
  assert.deepEqual(t.sets,['OLLAMA_API_KEY'])
  const route=(t.settings.current().providers as Record<string,Record<string,unknown>>).ollama!
  assert.equal(route.baseURL,t.stub!.baseURL+'/v1');assert.equal(route.apiKeyEnv,'OLLAMA_API_KEY')
  assert.deepEqual(route.models,[{id:'qwen3:4b',name:'qwen3:4b',contextWindow:4096,maxTokens:2048,input:['text']}])
  assert.deepEqual((await t.records()).map(r=>[r.name,r.status,r.routeModelId]),[['qwen3:4b','ready','qwen3:4b']])
  assert.equal(((await stat(join(t.runtimeRoot,'local-models.json'))).mode&0o777),0o600)
  // 拉取完成后可再次发起（作业已结束）
  const again=await t.invoke('local-models/pull',pullInput(qwen,1)) as PullJobView
  assert.equal(again.name,'qwen3:8b');await t.waitPull(view=>view.name==='qwen3:8b'&&view.phase!=='pulling'&&view.phase!=='verifying')
 }finally{await t.close()}
})

test('pull：digest 不符 → unverified，不写路由；桩 pullError → failed 且 error 含「需要联网」；已就绪行不受影响',async()=>{
 const t=await stand({pulledDigest:()=>'sha256:'+'d'.repeat(64)})
 try{
  await t.invoke('local-models/pull',pullInput(qwen,0))
  const done=await t.waitPull(view=>view.phase==='done'||view.phase==='failed')
  assert.equal(done.phase,'done')
  const o=await t.overview()
  assert.equal(t.row(o,'qwen3:4b').status,'unverified');assert.equal(t.settings.ops.length,0);assert.equal(t.sets.length,0)
  assert.deepEqual((await t.records()).map(r=>[r.name,r.status,r.routeModelId]),[['qwen3:4b','unverified',null]])
 }finally{await t.close()}
 const offline=await stand({pullError:'pull model manifest: dial tcp: lookup registry.ollama.ai: no such host',models:[{name:'qwen3:8b',size:1,digest:qwenVariants[1]!.sources[0].digest!}]})
 try{
  await offline.invoke('local-models/pull',pullInput(qwen,0))
  const failed=await offline.waitPull(view=>view.phase==='failed'||view.phase==='done')
  assert.equal(failed.phase,'failed');assert.match(failed.error!,/需要联网/);assert.match(failed.error!,/registry\.ollama\.ai/)
  const o=await offline.overview()
  assert.equal(offline.row(o,'qwen3:4b').status,'not-pulled');assert.equal(offline.row(o,'qwen3:8b').status,'route-pending')
  assert.equal(offline.settings.ops.length,0)
 }finally{await offline.close()}
})

test('pull-cancel：中止连接、作业 cancelled、不写记录；取消不存在的作业 → not-found',async()=>{
 const t=await stand({pullChunks:50,pullDelayMs:30})
 try{
  await assert.rejects(t.invoke('local-models/pull-cancel',{requestId:rid(),name:'qwen3:4b'}),error=>code(error)==='teloa/not-found')
  await t.invoke('local-models/pull',pullInput(qwen,0))
  await t.waitPull(view=>view.completed>0)
  const cancelled=await t.invoke('local-models/pull-cancel',{requestId:rid(),name:'qwen3:4b'}) as PullJobView
  assert.equal(cancelled.phase,'cancelled')
  await new Promise(r=>setTimeout(r,80))
  const view=await t.invoke('local-models/pull-status',{}) as PullJobView
  assert.equal(view.phase,'cancelled')
  assert.equal((await t.records()).length,0);assert.equal(t.settings.ops.length,0)
  // 作业已结束，可再次拉取
  const again=await t.invoke('local-models/pull',pullInput(qwen,0)) as PullJobView
  assert.equal(again.phase,'pulling');await t.invoke('local-models/pull-cancel',{requestId:rid(),name:'qwen3:4b'})
 }finally{await t.close()}
})
test('加载失败或旧运行清单缺容量，保留权重而不写路由，不误报需要联网',async t=>{
 for(const options of [{loadError:'cannot allocate memory'},{models:[{name:'qwen3:4b',digest:qwen4bDigest,size:10,allocatedContext:null}]}]){
  const e=await stand({...options,pulledDigest:()=>qwen4bDigest});t.after(e.close)
  await e.invoke('local-models/pull',pullInput(qwen,0))
  const failed=await e.waitPull(view=>view.phase==='failed'||view.phase==='done')
  assert.equal(failed.phase,'failed');assert.ok(failed.error)
  assert.doesNotMatch(failed.error!,/需要联网/)
  assert.ok(e.stub!.models.some(model=>model.name==='qwen3:4b'))
  assert.equal(e.settings.ops.length,0);assert.equal(e.sets.length,0)
  assert.equal(e.row(await e.overview(),'qwen3:4b').status,'route-pending')
 }
})
test('核验阶段正在加载时仍能立即取消，不等加载锁；权重保留且不写路由',async t=>{
 const e=await stand({hangLoadBody:true,pulledDigest:()=>qwen4bDigest});t.after(e.close)
 await e.invoke('local-models/pull',pullInput(qwen,0))
 await e.waitPull(view=>view.phase==='verifying')
 for(let i=0;i<100&&!e.stub!.calls.some(call=>call.path==='/api/chat');i++)await new Promise(resolve=>setTimeout(resolve,10))
 assert.ok(e.stub!.calls.some(call=>call.path==='/api/chat'),'已进入空加载请求')
 const started=Date.now()
 const cancelled=await e.invoke('local-models/pull-cancel',{requestId:rid(),name:'qwen3:4b'}) as PullJobView
 assert.equal(cancelled.phase,'cancelled');assert.ok(Date.now()-started<1500)
 assert.equal(e.settings.ops.length,0);assert.equal((await e.records()).length,0)
 assert.ok(e.stub!.models.some(model=>model.name==='qwen3:4b'))
})
test('卸载宿主时中止接入中的加载等待，不能卡住关闭或落下路由',async t=>{
 const e=await stand({hangLoadBody:true,models:[{name:'custom:latest',size:10,digest:'sha256:'+'f'.repeat(64)}]});t.after(e.close)
 const attaching=e.invoke('local-models/attach',{requestId:rid(),name:'custom:latest'})
 const rejected=assert.rejects(attaching,{name:'AbortError'})
 for(let i=0;i<100&&!e.stub!.calls.some(call=>call.path==='/api/chat');i++)await new Promise(resolve=>setTimeout(resolve,10))
 assert.ok(e.stub!.calls.some(call=>call.path==='/api/chat'))
 const started=Date.now()
 await e.handler.dispose();await rejected
 assert.ok(Date.now()-started<1500);assert.equal(e.settings.ops.length,0)
})

test('attach：目录外名称 → 路由加入、contextWindow 取实际加载容量、记录 attached；目录内 unverified 也可 attach 并显示 attached；不在清单 → source-unavailable',async()=>{
 const t=await stand({models:[{name:'foo:latest',size:10,digest:'sha256:'+'f'.repeat(64),contextLength:16384,capabilities:['completion','vision']},{name:'qwen3:4b',size:10,digest:'sha256:'+'e'.repeat(64)}]})
 try{
  await assert.rejects(t.invoke('local-models/attach',{requestId:rid(),name:'bar:latest'}),error=>code(error)==='teloa/source-unavailable')
  const first=await t.invoke('local-models/attach',{requestId:rid(),name:'foo:latest'}) as LocalModelsOverview
  assert.deepEqual(routeIds(t.settings),['foo:latest'])
  const route=(t.settings.current().providers as Record<string,Record<string,unknown>>).ollama!
  assert.deepEqual(route.models,[{id:'foo:latest',name:'foo:latest',contextWindow:4096,maxTokens:2048,input:['text','image']}])
  assert.equal(first.offCatalog[0]!.name,'foo:latest')
  const before=await t.overview();assert.equal(t.row(before,'qwen3:4b').status,'unverified')
  const second=await t.invoke('local-models/attach',{requestId:rid(),name:'qwen3:4b'}) as LocalModelsOverview
  assert.equal(t.row(second,'qwen3:4b').status,'attached')
  assert.deepEqual(routeIds(t.settings),['foo:latest','qwen3:4b'])
  assert.deepEqual((await t.records()).map(r=>[r.name,r.status,r.routeModelId]),[['foo:latest','attached','foo:latest'],['qwen3:4b','attached','qwen3:4b']])
  assert.deepEqual(t.sets,['OLLAMA_API_KEY'])
 }finally{await t.close()}
})

test('remove：先删路由再 DELETE /api/delete；成功后记录移除、行回 not-pulled；桩 404 → source-unavailable 且 records 已去掉 routeModelId',async()=>{
 const t=await stand({models:[{name:'foo:latest',size:10,digest:'sha256:'+'f'.repeat(64)},{name:'qwen3:4b',size:10,digest:'sha256:'+'e'.repeat(64)}]})
 try{
  await t.invoke('local-models/attach',{requestId:rid(),name:'foo:latest'})
  await t.invoke('local-models/attach',{requestId:rid(),name:'qwen3:4b'})
  t.settings.timeline.length=0
  const o=await t.invoke('local-models/remove',{requestId:rid(),name:'foo:latest'}) as LocalModelsOverview
  assert.deepEqual(t.settings.timeline,['route','delete'])
  assert.deepEqual(routeIds(t.settings),['qwen3:4b'])
  assert.deepEqual(t.stub!.calls.filter(c=>c.method==='DELETE').map(c=>c.body),[{model:'foo:latest'}])
  assert.equal(o.offCatalog.length,0);assert.deepEqual((await t.records()).map(r=>r.name),['qwen3:4b'])
  // 模型已被别处删掉：路由先删成功，DELETE 404 → source-unavailable，记录去掉 routeModelId 但仍在
  t.stub!.models.splice(t.stub!.models.findIndex(m=>m.name==='qwen3:4b'),1)
  await assert.rejects(t.invoke('local-models/remove',{requestId:rid(),name:'qwen3:4b'}),error=>code(error)==='teloa/source-unavailable')
  assert.deepEqual(routeIds(t.settings),[])
  assert.deepEqual((await t.records()).map(r=>[r.name,r.routeModelId]),[['qwen3:4b',null]])
  const after=await t.overview();assert.equal(t.row(after,'qwen3:4b').status,'missing')
 }finally{await t.close()}
})

test('状态文件：损坏 JSON → storage-unavailable；格式不符同样拒绝',async()=>{
 const t=await stand({})
 try{
  await writeFile(join(t.runtimeRoot,'local-models.json'),'{not json')
  await assert.rejects(t.overview(),error=>code(error)==='teloa/storage-unavailable')
  await writeFile(join(t.runtimeRoot,'local-models.json'),JSON.stringify({format:'other',records:[]}))
  await assert.rejects(t.overview(),error=>code(error)==='teloa/storage-unavailable')
 }finally{await t.close()}
})

test('并发拉取：同一请求共用作业，不同请求被拒；完成后重放不重新下载，同标识不能改参数',async()=>{
 const t=await stand({pullChunks:3,pullDelayMs:20,pulledDigest:()=>qwen4bDigest})
 try{
  const input=pullInput(qwen,0)
  const [first,replay]=await Promise.all([t.invoke('local-models/pull',input),t.invoke('local-models/pull',input)]) as PullJobView[]
  assert.equal(first!.pullId,replay!.pullId)
  await assert.rejects(t.invoke('local-models/pull',pullInput(qwen,1)),error=>code(error)==='teloa/conflict')
  await t.waitPull(view=>view.phase==='done')
  const done=await t.invoke('local-models/pull',input) as PullJobView
  assert.equal(done.pullId,first!.pullId);assert.equal(done.phase,'done')
  assert.equal(t.stub!.calls.filter(call=>call.path==='/api/pull').length,1)
  await assert.rejects(t.invoke('local-models/pull',{...input,variant:1}),error=>code(error)==='teloa/conflict')
 }finally{await t.close()}
})
test('就绪状态每次核对真实摘要和路由；用户删路由后待接入，原地换模型后未核验',async()=>{
 const t=await stand({pulledDigest:()=>qwen4bDigest})
 try{
  await t.invoke('local-models/pull',pullInput(qwen,0));await t.waitPull(view=>view.phase==='done')
  assert.equal(t.row(await t.overview(),'qwen3:4b').status,'ready')
  const route=(t.settings.current().providers as Record<string,Record<string,unknown>>).ollama!
  route.models=[]
  assert.equal(t.row(await t.overview(),'qwen3:4b').status,'route-pending')
  t.stub!.models[0]!.digest='sha256:'+'e'.repeat(64)
  assert.equal(t.row(await t.overview(),'qwen3:4b').status,'unverified')
 }finally{await t.close()}
})
test('状态文件记录逐条校验：字段损坏不得伪装成空记录或触发模型请求',async()=>{
 const t=await stand({})
 try{
  const file=join(t.runtimeRoot,'local-models.json'),base=JSON.parse(await readFile(file,'utf8'))
  for(const records of [[null],[{name:'qwen3:4b'}],[{name:'qwen3:4b',digest:'x',status:'ready',routeModelId:'another-model'}]]){
   await writeFile(file,JSON.stringify({...base,records}))
   await assert.rejects(t.overview(),error=>code(error)==='teloa/storage-unavailable')
  }
  assert.equal(t.stub!.calls.length,0)
 }finally{await t.close()}
})
test('复用用户同名路由不会取得其删除权',async()=>{
 const t=await stand({models:[{name:'qwen3:4b',size:10,digest:qwen4bDigest}]})
 try{
  t.settings.current().providers={ollama:{api:'openai-completions',baseURL:t.stub!.baseURL+'/v1',models:[{id:'qwen3:4b',contextWindow:2048}]}}
  await t.invoke('local-models/attach',{requestId:rid(),name:'qwen3:4b'})
  assert.equal((await t.records())[0]!.routeModelId,null)
  const before=structuredClone(t.settings.current()),writes=t.settings.ops.length
  t.stub!.models[0]!.allocatedContext=1024
  assert.equal((await t.handler.prepareRequest({provider:'ollama',model:'qwen3:4b',maxTokens:4096},new AbortController().signal)).maxTokens,512)
  assert.deepEqual(t.settings.current(),before,'批准复用只限制本次请求，不修改用户路由')
  assert.equal(t.settings.ops.length,writes)
  await assert.rejects(t.invoke('local-models/remove',{requestId:rid(),name:'qwen3:4b'}),error=>code(error)==='teloa/conflict')
  assert.deepEqual(routeIds(t.settings),['qwen3:4b'])
  assert.equal(t.stub!.calls.filter(call=>call.method==='DELETE').length,0)
 }finally{await t.close()}
})
test('只支持 embedding 的模型不能登记为对话模型',async()=>{
 const t=await stand({models:[{name:'embed:latest',size:10,digest:'sha256:'+'e'.repeat(64),capabilities:['embedding']}]})
 try{
  await assert.rejects(t.invoke('local-models/attach',{requestId:rid(),name:'embed:latest'}),error=>code(error)==='teloa/source-invalid')
  assert.equal(t.settings.ops.length,0);assert.equal(t.sets.length,0);assert.equal((await t.records()).length,0)
 }finally{await t.close()}
})

test('handle：未知端点 not-found；overview / pull-status 不接受任何字段；pull-status 无作业回 null',async()=>{
 const t=await stand(null)
 try{
  await assert.rejects(t.invoke('local-models/list',{}),error=>code(error)==='teloa/not-found')
  await assert.rejects(t.invoke('local-models/overview',{requestId:rid()}),error=>code(error)==='teloa/invalid-input')
  await assert.rejects(t.invoke('local-models/pull-status',{pullId:rid()}),error=>code(error)==='teloa/invalid-input')
  assert.equal(await t.invoke('local-models/pull-status',{}),null)
  await assert.rejects(t.invoke('local-models/remove',{requestId:rid(),name:'Bad Name'}),error=>code(error)==='teloa/invalid-input')
 }finally{await t.close()}
})

test('鉴权：IM 通道 teloaWork.invoke 不能触达七端点（forbidden，不派发）',async()=>{
 let dispatched=0
 const work=createTeloaWorkService({owner:'o',runtimeRoot:'/tmp/none',dispatch:async()=>{dispatched++;return null},broadcast:{add:()=>()=>{}} as never,install:async()=>'',attachAllowed:()=>false})
 for(const endpoint of localModelEndpoints)await assert.rejects(work.invoke(endpoint,{},new AbortController().signal),error=>code(error)==='teloa/forbidden')
 assert.equal(dispatched,0)
})

test('endpointSet 守卫：七个端点进 endpointSet 与分发链，字面量只在契约',async()=>{
 assert.deepEqual([...localModelEndpoints],['local-models/overview','local-models/address','local-models/pull','local-models/pull-status','local-models/pull-cancel','local-models/remove','local-models/attach'])
 const root=new URL('../src/',import.meta.url)
 const source=await readFile(new URL('index.ts',root),'utf8')
 const line=source.split('\n').find(row=>row.startsWith('const endpointSet=new Set('))
 assert.ok(line,'index.ts 里找不到 endpointSet 的声明行')
 assert.match(line,/\.\.\.localModelEndpoints/)
 assert.match(source,/if\(\(localModelEndpoints as readonly string\[\]\)\.includes\(endpoint\)\)return localModelsHandler\.handle\(endpoint,payload,signal\)/)
 for(const entry of await readdir(root,{withFileTypes:true})){
  if(!entry.isFile()||!entry.name.endsWith('.ts'))continue
  const text=await readFile(new URL(entry.name,root),'utf8')
  for(const endpoint of localModelEndpoints){
   // local-models.ts 的分支比对允许出现端点字面量；其余文件不得另起清单。
   if(entry.name==='local-models.ts')continue
   assert.doesNotMatch(text,new RegExp(`["'\`]${endpoint}["'\`]`),`${entry.name} 里不得出现 ${endpoint} 的字面量`)
  }
 }
})

test('页面确认与目标地址绑定：下载/接入/移除不能落到另一个服务，缺目标也拒绝',async()=>{
 const t=await stand({})
 try{
  const before=(await t.overview()).runtime.address.baseURL
  for(const endpoint of ['local-models/pull','local-models/attach','local-models/remove']){
   const payload=endpoint==='local-models/pull'?pullInput(qwen,0):{requestId:rid(),name:'qwen3:4b'}
   await assert.rejects(t.handler.handle(endpoint,payload),error=>code(error)==='teloa/invalid-input')
   await assert.rejects(t.handler.handle(endpoint,{...payload,expectedAddress:'http://127.0.0.1:11435'}),error=>code(error)==='teloa/version-conflict')
  }
  assert.equal((await t.overview()).runtime.address.baseURL,before)
  assert.equal(await t.handler.handle('local-models/pull-status',{}),null)
  assert.equal(t.settings.ops.length,0)
 }finally{await t.close()}
})


test('运行期重新加载后收紧实际预算，保留用户字段与其他模型，不擅自放大容量',async t=>{
 const e=await stand({models:[{name:'qwen3:4b',size:123,digest:qwen4bDigest,allocatedContext:8192}]});t.after(e.close)
 await e.invoke('local-models/attach',{requestId:rid(),name:'qwen3:4b'})
 const provider=(e.settings.current().providers as any).ollama
 provider.models[0].name='我的模型';provider.models[0].customField='preserve'
 provider.models.push({id:'manual',name:'用户自建',contextWindow:10000,maxTokens:300})
 e.stub!.models[0]!.allocatedContext=2048
 const input={provider:'ollama',model:'qwen3:4b',maxTokens:4096,temperature:0.3,stop:['END']}
 const prepared=await e.handler.prepareRequest(input,new AbortController().signal)
 assert.deepEqual(prepared,{...input,maxTokens:1024})
 assert.equal(provider.models[0].contextWindow,2048)
 assert.equal(provider.models[0].name,'我的模型');assert.equal(provider.models[0].customField,'preserve')
 assert.deepEqual(provider.models[1],{id:'manual',name:'用户自建',contextWindow:10000,maxTokens:300})
 e.stub!.models[0]!.allocatedContext=16384
 assert.equal(await e.handler.requestCapacity(prepared,new AbortController().signal,true),2048)
 const before=e.stub!.calls.length
 assert.equal(await e.handler.requestCapacity({provider:'ollama',model:'manual'},new AbortController().signal),null)
 assert.equal(await e.handler.requestCapacity({provider:'remote',model:'x'},new AbortController().signal),null)
 assert.equal(e.stub!.calls.length,before)
 assert.equal(e.stub!.calls.filter(row=>row.path==='/api/chat').length,3)
})

test('运行期拒绝地址漂移、权重换版、取消；容量未知与服务故障回原生稳定码',async t=>{
 const options:StubOptions={models:[{name:'qwen3:4b',size:123,digest:qwen4bDigest}]}
 const e=await stand(options);t.after(e.close)
 await e.invoke('local-models/attach',{requestId:rid(),name:'qwen3:4b'})
 const config={provider:'ollama',model:'qwen3:4b'},signal=new AbortController().signal
 const route=(e.settings.current().providers as any).ollama,baseURL=route.baseURL
 route.baseURL='http://127.0.0.1:1/v1'
 const count=e.stub!.calls.length
 await assert.rejects(e.handler.prepareRequest(config,signal),{code:'teloa/version-conflict'})
 assert.equal(e.stub!.calls.length,count);route.baseURL=baseURL
 e.stub!.models[0]!.digest='sha256:'+'f'.repeat(64)
 await assert.rejects(e.handler.prepareRequest(config,signal),{code:'teloa/version-conflict'})
 e.stub!.models[0]!.digest=qwen4bDigest;e.stub!.models[0]!.allocatedContext=null
 // 终审 Minor 1：容量未报告是运行时版本问题 → INVALID_REQUEST（不可恢复、不切远程），不再冒充服务故障。
 await assert.rejects(e.handler.prepareRequest(config,signal),{code:'INVALID_REQUEST'})
 e.stub!.models[0]!.allocatedContext=4096;options.loadError='do not echo server body'
 await assert.rejects(e.handler.prepareRequest(config,signal),{code:'SERVER',message:'本地模型服务拒绝请求。'})
 const controller=new AbortController();controller.abort()
 await assert.rejects(e.handler.prepareRequest(config,controller.signal),{name:'AbortError'})
})

test('容量核对期间手工改配置不被覆盖，宿主关闭中止正在加载的请求',async t=>{
 const options:StubOptions={models:[{name:'qwen3:4b',size:123,digest:qwen4bDigest}]}
 let entered:()=>void=()=>{},release:()=>void=()=>{},gate=false
 const e=await stand(options,{client:address=>{
  const client=new OllamaClient(address)
  return {version:()=>client.version(),tags:()=>client.tags(),ps:signal=>client.ps(signal),show:name=>client.show(name),pull:(...args)=>client.pull(...args),remove:name=>client.remove(name),load:async(name,signal)=>{if(gate){entered();await new Promise<void>(resolve=>{release=resolve})};return client.load(name,signal)}}
 }});t.after(e.close)
 await e.invoke('local-models/attach',{requestId:rid(),name:'qwen3:4b'})
 const began=new Promise<void>(resolve=>{entered=resolve});gate=true
 const pending=e.handler.prepareRequest({provider:'ollama',model:'qwen3:4b'},new AbortController().signal)
 await began
 const route=(e.settings.current().providers as any).ollama;route.models[0].name='正在修改'
 release();await assert.rejects(pending,{code:'teloa/version-conflict'})
 assert.equal(route.models[0].name,'正在修改')
 gate=false;options.hangLoadBody=true
 const waiting=e.handler.prepareRequest({provider:'ollama',model:'qwen3:4b'},new AbortController().signal)
 const rejection=assert.rejects(waiting,{name:'AbortError'})
 await new Promise(resolve=>setTimeout(resolve,20));await e.handler.dispose();await rejection
})


test('换地址撤销旧接入的请求授权，不探测新服务的同名模型',async t=>{
 const e=await stand({models:[{name:'qwen3:4b',size:10,digest:qwen4bDigest}]});t.after(e.close)
 await e.invoke('local-models/attach',{requestId:rid(),name:'qwen3:4b'})
 await e.handler.handle('local-models/address',{requestId:rid(),baseURL:'http://127.0.0.1:1'})
 await assert.rejects(e.handler.prepareRequest({provider:'ollama',model:'qwen3:4b'},new AbortController().signal),{code:'teloa/version-conflict'})
})


test('另一个模型加载占锁时可立即取消排队请求，迟到队列不再发请求',{timeout:2000},async t=>{
 const options:StubOptions={models:[{name:'qwen3:4b',size:10,digest:qwen4bDigest}]}
 const e=await stand(options);t.after(e.close)
 await e.invoke('local-models/attach',{requestId:rid(),name:'qwen3:4b'})
 options.hangLoadBody=true
 const first=new AbortController(),second=new AbortController(),config={provider:'ollama',model:'qwen3:4b'}
 const before=e.stub!.calls.filter(row=>row.path==='/api/chat').length
 const firstStopped=assert.rejects(e.handler.prepareRequest(config,first.signal),{name:'AbortError'})
 for(let i=0;e.stub!.calls.filter(row=>row.path==='/api/chat').length===before&&i<50;i++)await new Promise(resolve=>setTimeout(resolve,5))
 const secondStopped=assert.rejects(e.handler.prepareRequest(config,second.signal),{name:'AbortError'})
 second.abort();await secondStopped
 assert.equal(first.signal.aborted,false)
 first.abort();await firstStopped;await e.handler.dispose()
 assert.equal(e.stub!.calls.filter(row=>row.path==='/api/chat').length,before+1)
})


test('内存估算只对应受审的本机工件和实际上下文，远端与摘要漂移不伪称适配',async t=>{
 const e=await stand({running:['qwen3:4b'],models:[{name:'qwen3:4b',size:2497293931,digest:qwen4bDigest,allocatedContext:32768}]});t.after(e.close)
 const first=await e.overview(),model=e.row(first,'qwen3:4b')
 assert.equal(model.memoryEstimate?.sourceVersion,'1.1.16')
 assert.equal(model.memoryEstimate?.contextTokens,32768)
 assert.equal(model.memoryEstimate?.contextSupported,true)
 assert.ok(model.memoryEstimate!.requiredMemoryBytes>7*GiB)
 const changed=catalog.map(entry=>entry.id===qwen.id?{...entry,model:{...entry.model,variants:qwenVariants.map(v=>({...v,sources:[{...v.sources[0],digest:'sha256:'+'f'.repeat(64)}]}))}} as MarketCatalogModelEntry:entry)
 const mismatch=await stand(null,{catalog:()=>changed});t.after(mismatch.close)
 assert.equal(mismatch.row(await mismatch.overview(),'qwen3:4b').memoryEstimate,undefined)
 await e.invoke('local-models/address',{requestId:rid(),baseURL:'http://remote.example:11434'})
 assert.ok((await e.overview()).rows.every(row=>row.memoryEstimate===undefined))
})


test('已加载模型的容量未知或当前摘要漂移时，不用8K和旧Q4工件伪称内存够用',async t=>{
 for(const model of [
  {name:'qwen3:4b',size:2497293931,digest:qwen4bDigest,allocatedContext:null},
  {name:'qwen3:4b',size:2497293931,digest:'sha256:'+'e'.repeat(64),allocatedContext:4096}
 ]){
  const e=await stand({running:['qwen3:4b'],models:[model]});t.after(e.close)
  const current=e.row(await e.overview(),'qwen3:4b')
  assert.equal(current.loaded,true);assert.equal(current.memoryEstimate,undefined)
 }
})

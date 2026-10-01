import test from 'node:test'
import assert from 'node:assert/strict'
import type {TestContext} from 'node:test'
import {createServer,type IncomingMessage,type ServerResponse} from 'node:http'
import {spawn,spawnSync} from 'node:child_process'
import {once} from 'node:events'
import {createHash,randomBytes} from 'node:crypto'
import {existsSync} from 'node:fs'
import {mkdir,mkdtemp,readdir,readFile,rm,stat,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {AssetDownloadError,hostAllowed,processStartTime,assetsCacheDir,assetsRevision,inspectAssets,prepareAssets,variantFiles,type AssetFile,type AssetsManifest} from '../src/assets.ts'
import assets from '../runtime/assets.json' with {type:'json'}

const sha=(data:Buffer)=>createHash('sha256').update(data).digest('hex')
const blobs={a:randomBytes(40_000),b:randomBytes(70_000)}
const file=(path:string,data:Buffer):AssetFile=>({path,variant:'fp32',url:`https://huggingface.co/org/repo/resolve/${'c'.repeat(40)}/${path}`,bytes:data.length,sha256:sha(data)})
const files=[file('onnx/model.onnx',blobs.a),file('tokenizer.json',blobs.b)]
const hosts={allowedHosts:['huggingface.co'],redirectHosts:(assets as AssetsManifest).redirectHosts}

type Route=(req:IncomingMessage,res:ServerResponse,host:string,path:string)=>void|Promise<void>
/** 本地回环 HTTP 桩：请求经注入的 fetch 从 https://<host>/<path> 改写为 http://127.0.0.1:<port>/<host>/<path>，主机校验仍按原始地址进行。 */
async function stub(t:TestContext,route:Route){
 const seen:{host:string;path:string}[]=[]
 const server=createServer((req,res)=>{
  const [,host,...rest]=(req.url??'/').split('/')
  const path=('/'+rest.join('/')).replace(/\?.*$/,'')
  seen.push({host:host!,path})
  void route(req,res,host!,path)
 })
 await new Promise<void>(done=>server.listen(0,'127.0.0.1',done))
 t.after(()=>new Promise<void>(done=>{server.closeAllConnections();server.close(()=>done())}))
 const port=(server.address() as {port:number}).port
 const fetchImpl:typeof fetch=(input,init)=>{
  const url=new URL(String(input))
  assert.equal(url.protocol,'https:')
  return fetch(`http://127.0.0.1:${port}/${url.host}${url.pathname}${url.search}`,init)
 }
 return {fetch:fetchImpl,seen}
}
const serve=(data:Buffer):Route=>(_req,res)=>{res.writeHead(200,{'content-length':String(data.length)});res.end(data)}
const byPath=(path:string)=>path.endsWith('model.onnx')?blobs.a:blobs.b
const okRoute:Route=(req,res,_host,path)=>serve(byPath(path))(req,res,_host,path)

async function tempDir(t:TestContext){
 const dir=await mkdtemp(join(tmpdir(),'teloa-embed-assets-'))
 t.after(()=>rm(dir,{recursive:true,force:true}))
 return join(dir,'cache')
}
const enough=async()=>Number.MAX_SAFE_INTEGER
const listAll=async(dir:string):Promise<string[]>=>{
 const out:string[]=[]
 for(const entry of await readdir(dir,{withFileTypes:true,recursive:true}))if(entry.isFile())out.push(join(entry.parentPath,entry.name).slice(dir.length+1))
 return out.sort()
}

test('变体文件与缓存目录：fp32 含分词文件，int8 只来自 evaluationOnly；目录为 dshHome/teloa-models/embedding/qwen3-embedding-0.6b/<assetsRevision>/<variant>',()=>{
 const manifest=assets as AssetsManifest
 assert.deepEqual(variantFiles(manifest,'fp32').map(file=>file.path),['onnx/model.onnx','onnx/model.onnx_data','tokenizer.json','tokenizer_config.json'])
 assert.deepEqual(variantFiles(manifest,'int8').map(file=>file.path),['onnx/model_int8.onnx','tokenizer.json','tokenizer_config.json'])
 const revision=assetsRevision(variantFiles(manifest,'fp32'))
 assert.match(revision,/^[a-f0-9]{16}$/)
 assert.notEqual(assetsRevision(variantFiles(manifest,'int8')),revision)
 assert.equal(assetsCacheDir(manifest,'fp32',(...segments)=>join('/home/.dsh',...segments)),join('/home/.dsh','teloa-models','embedding','qwen3-embedding-0.6b',revision,'fp32'))
})

test('内存评估 补测件：q4、bnb4 只来自 evaluationOnly，按固定修订与 LFS 摘要固定；发行默认与变体表不变',()=>{
 const manifest=assets as AssetsManifest
 assert.equal(manifest.defaultVariant,'fp32')
 assert.deepEqual(manifest.variants,['fp32'])
 assert.deepEqual(manifest.files.map(file=>file.variant),['fp32','fp32','shared','shared'])
 assert.deepEqual(manifest.sessionOptions,{})
 assert.deepEqual(variantFiles(manifest,'q4').map(file=>file.path),['onnx/model_q4.onnx','tokenizer.json','tokenizer_config.json'])
 assert.deepEqual(variantFiles(manifest,'bnb4').map(file=>file.path),['onnx/model_bnb4.onnx','tokenizer.json','tokenizer_config.json'])
 const q4=variantFiles(manifest,'q4')[0]!,bnb4=variantFiles(manifest,'bnb4')[0]!
 assert.deepEqual(q4,{path:'onnx/model_q4.onnx',variant:'q4',url:'https://huggingface.co/onnx-community/Qwen3-Embedding-0.6B-ONNX/resolve/c25a394dd583836952667c12f008335071b3f43d/onnx/model_q4.onnx',bytes:914_121_462,sha256:'8be554b37368134c3f38613c6f6ad0b7bb5f3a6465ab87574dbc0dcf24daa428'})
 assert.deepEqual(bnb4,{path:'onnx/model_bnb4.onnx',variant:'bnb4',url:'https://huggingface.co/onnx-community/Qwen3-Embedding-0.6B-ONNX/resolve/c25a394dd583836952667c12f008335071b3f43d/onnx/model_bnb4.onnx',bytes:886_593_402,sha256:'043b1fad2d02dc5c59de13deb8b059aab093b1e3f85d5554edb73dc2e0abacd1'})
 // 评估段的变体不会从发行段取件：发行段里没有它们，缺了评估段就报没有该变体。
 const {evaluationOnly:_evaluationOnly,...releaseOnly}=manifest
 for(const variant of ['int8','q4','bnb4'] as const)assert.throws(()=>variantFiles(releaseOnly,variant),new RegExp(`没有 ${variant} 变体`))
 assert.equal(new Set(['fp32','int8','q4','bnb4'].map(variant=>assetsRevision(variantFiles(manifest,variant as 'fp32')))).size,4)
})

test('下载成功：逐个校验大小与 sha256 后原子发布，目录 0700，不留 .partial；进度单调；再次准备复用已校验文件、不再联网',async t=>{
 const dir=await tempDir(t)
 const server=await stub(t,okRoute)
 const progress:{resource:string;completedBytes:number;totalBytes:number}[]=[]
 await prepareAssets({dir,files,...hosts,fetch:server.fetch,freeBytes:enough,signal:new AbortController().signal,onProgress:state=>progress.push(state)})
 assert.deepEqual(await listAll(dir),['.teloa-assets.json','onnx/model.onnx','tokenizer.json'])
 assert.deepEqual(await readFile(join(dir,'onnx/model.onnx')),blobs.a)
 assert.equal((await stat(dir)).mode&0o777,0o700)
 assert.equal(await inspectAssets(dir,files),'complete')
 for(const resource of ['onnx/model.onnx','tokenizer.json']){
  const rows=progress.filter(row=>row.resource===resource)
  assert.ok(rows.length>0)
  assert.deepEqual(rows.map(row=>row.completedBytes),[...rows.map(row=>row.completedBytes)].sort((x,y)=>x-y))
  assert.equal(rows.at(-1)!.completedBytes,rows.at(-1)!.totalBytes)
 }
 assert.equal(server.seen.length,2)
 const offline:typeof fetch=async()=>{throw new Error('不应联网')}
 await prepareAssets({dir,files,...hosts,fetch:offline,freeBytes:enough,signal:new AbortController().signal,onProgress:()=>{}})
})

test('检查只看缓存：缺文件、被改大小、清单外改动一律视为未准备；不联网',async t=>{
 const dir=await tempDir(t)
 assert.equal(await inspectAssets(dir,files),'missing')
 const server=await stub(t,okRoute)
 await prepareAssets({dir,files,...hosts,fetch:server.fetch,freeBytes:enough,signal:new AbortController().signal,onProgress:()=>{}})
 await writeFile(join(dir,'tokenizer.json'),Buffer.concat([blobs.b,Buffer.from('x')]))
 assert.equal(await inspectAssets(dir,files),'missing')
 const other=[files[0]!,{...files[1]!,sha256:'0'.repeat(64)}]
 assert.equal(await inspectAssets(dir,other),'missing')
})

async function failure(promise:Promise<unknown>):Promise<AssetDownloadError>{
 try{await promise}catch(error){assert.ok(error instanceof AssetDownloadError,String(error));return error}
 assert.fail('应当失败')
}

test('大小不符、sha256 不符、响应超出声明字节时中止：原因 integrity，删除半成品，不发布',async t=>{
 for(const [name,body] of [['短',blobs.b.subarray(0,1000)],['长',Buffer.concat([blobs.b,randomBytes(50_000)])],['同长异内容',randomBytes(blobs.b.length)]] as const){
  const dir=await tempDir(t)
  const server=await stub(t,(req,res,host,path)=>{if(!path.endsWith('tokenizer.json'))return okRoute(req,res,host,path);res.writeHead(200);res.end(body)})
  const error=await failure(prepareAssets({dir,files,...hosts,fetch:server.fetch,freeBytes:enough,signal:new AbortController().signal,onProgress:()=>{}}))
  assert.equal(error.reason,'integrity',name)
  assert.equal(error.resource,'tokenizer.json',name)
  assert.equal(error.source,'huggingface.co',name)
  assert.ok(!(await listAll(dir)).some(entry=>entry.includes('.partial')),name)
  assert.equal(existsSync(join(dir,'tokenizer.json')),false,name)
 }
})

test('跳转：清单内 CDN 主机放行；清单外主机与非 https 被拒，且失败信息不含 URL 查询参数',async t=>{
 const dir=await tempDir(t)
 const cdn=await stub(t,(req,res,host,path)=>{if(host!=='huggingface.co')return okRoute(req,res,host,path);res.writeHead(302,{location:`https://us.aws.cdn.hf.co/xet${path}?X-Amz-Signature=secret`});res.end()})
 await prepareAssets({dir,files,...hosts,fetch:cdn.fetch,freeBytes:enough,signal:new AbortController().signal,onProgress:()=>{}})
 assert.deepEqual(cdn.seen.map(row=>row.host),['huggingface.co','us.aws.cdn.hf.co','huggingface.co','us.aws.cdn.hf.co'])
 for(const location of ['https://evil.example/x?token=secret','http://us.aws.cdn.hf.co/x?token=secret','https://huggingface.co.evil.example/x?token=secret','https://hf.co.evil.com/x?token=secret','https://evilhf.co/x?token=secret']){
  const other=await tempDir(t)
  const server=await stub(t,(_req,res)=>{res.writeHead(302,{location});res.end()})
  const error=await failure(prepareAssets({dir:other,files,...hosts,fetch:server.fetch,freeBytes:enough,signal:new AbortController().signal,onProgress:()=>{}}))
  assert.equal(error.reason,'http',location)
  assert.equal(error.source,'huggingface.co')
  assert.equal(error.resource,'onnx/model.onnx')
  assert.doesNotMatch(error.message,/secret|token=|\?/,location)
  assert.equal(server.seen.length,1,'不向清单外主机发请求')
 }
})

test('跳转主机表：huggingface.co、*.huggingface.co、*.hf.co 按标签边界放行；相似域名与裸后缀拒绝',()=>{
 const patterns=(assets as AssetsManifest).redirectHosts
 assert.deepEqual(patterns,['huggingface.co','*.huggingface.co','*.hf.co'])
 for(const host of ['huggingface.co','us.aws.cdn.hf.co','eu.aws.cdn.hf.co','cas-bridge.xethub.hf.co','cdn-lfs.hf.co','cdn-lfs-us-1.huggingface.co'])assert.equal(hostAllowed(host,patterns),true,host)
 for(const host of ['hf.co.evil.com','evilhf.co','evilhuggingface.co','huggingface.co.evil.example','hf.co','xhf.co','hf.co.','evil.com','cdn.hf.co.evil.com'])assert.equal(hostAllowed(host,patterns),false,host)
})

test('多个 HF CDN 主机的真实跳转都通过；清单内主机降级 http 被拒',async t=>{
 for(const cdn of ['cas-bridge.xethub.hf.co','cdn-lfs-us-1.huggingface.co','eu.aws.cdn.hf.co']){
  const dir=await tempDir(t)
  const server=await stub(t,(req,res,host,path)=>{if(host!=='huggingface.co')return okRoute(req,res,host,path);res.writeHead(302,{location:`https://${cdn}/x${path}?sig=1`});res.end()})
  await prepareAssets({dir,files,...hosts,fetch:server.fetch,freeBytes:enough,signal:new AbortController().signal,onProgress:()=>{}})
  assert.ok(server.seen.some(row=>row.host===cdn),cdn)
 }
 const dir=await tempDir(t)
 const server=await stub(t,(_req,res)=>{res.writeHead(302,{location:'http://cas-bridge.xethub.hf.co/x'});res.end()})
 const error=await failure(prepareAssets({dir,files,...hosts,fetch:server.fetch,freeBytes:enough,signal:new AbortController().signal,onProgress:()=>{}}))
 assert.equal(error.reason,'http')
 assert.equal(server.seen.length,1)
})

test('HTTP 错误：原因 http，信息含文件名、来源主机，不含查询参数',async t=>{
 const dir=await tempDir(t)
 const server=await stub(t,(_req,res)=>{res.writeHead(404);res.end()})
 const error=await failure(prepareAssets({dir,files:[{...files[0]!,url:files[0]!.url+'?download=true'}],...hosts,fetch:server.fetch,freeBytes:enough,signal:new AbortController().signal,onProgress:()=>{}}))
 assert.equal(error.reason,'http')
 assert.match(error.message,/onnx\/model\.onnx/)
 assert.match(error.message,/huggingface\.co/)
 assert.match(error.message,/404/)
 assert.doesNotMatch(error.message,/download=true|\?/)
})

test('磁盘空余不足（待下载声明字节 + 512 MiB）：下载前失败并说明，原因 storage，不发请求',async t=>{
 const dir=await tempDir(t)
 const server=await stub(t,okRoute)
 const need=blobs.a.length+blobs.b.length+512*1024*1024
 const error=await failure(prepareAssets({dir,files,...hosts,fetch:server.fetch,freeBytes:async()=>need-1,signal:new AbortController().signal,onProgress:()=>{}}))
 assert.equal(error.reason,'storage')
 assert.match(error.message,/磁盘/)
 assert.equal(server.seen.length,0)
 await prepareAssets({dir,files,...hosts,fetch:server.fetch,freeBytes:async()=>need,signal:new AbortController().signal,onProgress:()=>{}})
})

test('取消：删除 .partial；重试复用已校验的第一个文件，只重下未完成的文件',async t=>{
 const dir=await tempDir(t)
 const controller=new AbortController()
 let slow=true
 const server=await stub(t,async(req,res,host,path)=>{
  if(!path.endsWith('tokenizer.json')||!slow)return okRoute(req,res,host,path)
  res.writeHead(200,{'content-length':String(blobs.b.length)})
  res.write(blobs.b.subarray(0,1000))
  controller.abort(new Error('用户取消'))
 })
 await assert.rejects(prepareAssets({dir,files,...hosts,fetch:server.fetch,freeBytes:enough,signal:controller.signal,onProgress:()=>{}}),(error:unknown)=>controller.signal.aborted&&!(error instanceof AssetDownloadError&&error.reason==='integrity'))
 assert.deepEqual(await listAll(dir),['.teloa-assets.json','onnx/model.onnx'])
 slow=false
 await prepareAssets({dir,files,...hosts,fetch:server.fetch,freeBytes:enough,signal:new AbortController().signal,onProgress:()=>{}})
 assert.deepEqual(server.seen.map(row=>row.path.split('/').at(-1)),['model.onnx','tokenizer.json','tokenizer.json'])
 assert.equal(await inspectAssets(dir,files),'complete')
})

test('两个并发准备由 withFileLock 串行化：每个文件只下载一次，两者都成功',async t=>{
 const dir=await tempDir(t)
 let active=0,peak=0
 const server=await stub(t,async(req,res,host,path)=>{
  active++;peak=Math.max(peak,active)
  await new Promise(done=>setTimeout(done,50))
  okRoute(req,res,host,path)
  active--
 })
 const run=()=>prepareAssets({dir,files,...hosts,fetch:server.fetch,freeBytes:enough,signal:new AbortController().signal,onProgress:()=>{}})
 await Promise.all([run(),run()])
 assert.equal(server.seen.length,2)
 assert.equal(peak,1)
 assert.equal(existsSync(join(dir,'.prepare.lock')),false)
})

const until=async(check:()=>boolean,ms=10_000)=>{const end=Date.now()+ms;while(!check()&&Date.now()<end)await new Promise(done=>setTimeout(done,20));assert.ok(check())}

test('强杀恢复：持锁进程被 SIGKILL 后留下的准备锁被立即接管，不等待；准备照常完成且不留锁与接管互斥文件',async t=>{
 const dir=await tempDir(t)
 const script=join(dir,'..','holder.mjs')
 await writeFile(script,`import {prepareAssets} from ${JSON.stringify(new URL('../src/assets.ts',import.meta.url).href)}
await prepareAssets({dir:${JSON.stringify(dir)},files:${JSON.stringify(files)},allowedHosts:['huggingface.co'],redirectHosts:[],fetch:()=>new Promise(()=>{setInterval(()=>{},1000)}),freeBytes:async()=>Number.MAX_SAFE_INTEGER,signal:new AbortController().signal,onProgress:()=>{}})`)
 const holder=spawn(process.execPath,[script],{stdio:'ignore'})
 t.after(()=>{holder.kill('SIGKILL')})
 await until(()=>existsSync(join(dir,'.prepare.lock'))&&existsSync(join(dir,'.prepare.owner.json')))
 holder.kill('SIGKILL')
 await once(holder,'exit')
 assert.ok(existsSync(join(dir,'.prepare.lock')),'强杀后遗留锁')
 const server=await stub(t,okRoute)
 const started=Date.now()
 await prepareAssets({dir,files,...hosts,fetch:server.fetch,freeBytes:enough,signal:new AbortController().signal,onProgress:()=>{}})
 assert.ok(Date.now()-started<5000,'立即接管，不等锁超时')
 assert.equal(await inspectAssets(dir,files),'complete')
 assert.deepEqual((await readdir(dir)).filter(name=>name.startsWith('.prepare')),[])
})

test('PID 复用：锁里的 PID 仍在运行但启动时间与记录不符，视为孤儿立即接管；两个准备同时接管也只下载一次',async t=>{
 const dir=await tempDir(t)
 await mkdir(dir,{recursive:true})
 assert.ok(await processStartTime(process.pid),'本机可读进程启动时间')
 // 本进程 PID 活着，但记录的启动时间属于另一个（已退出的）同号进程
 await writeFile(join(dir,'.prepare.lock'),`${process.pid}\n`)
 await writeFile(join(dir,'.prepare.owner.json'),JSON.stringify({pid:process.pid,started:'Mon Jan  1 00:00:00 2001'}))
 const server=await stub(t,okRoute)
 const run=()=>prepareAssets({dir,files,...hosts,fetch:server.fetch,freeBytes:enough,signal:new AbortController().signal,onProgress:()=>{}})
 const started=Date.now()
 await Promise.all([run(),run()])
 assert.ok(Date.now()-started<5000)
 assert.equal(server.seen.length,2,'每个文件只下载一次')
 // 已退出进程的 PID：同样立即接管
 const other=await tempDir(t)
 await mkdir(other,{recursive:true})
 const dead=spawnSync(process.execPath,['-e','']).pid
 await writeFile(join(other,'.prepare.lock'),`${dead}\n`)
 await prepareAssets({dir:other,files,...hosts,fetch:server.fetch,freeBytes:enough,signal:new AbortController().signal,onProgress:()=>{}})
 assert.equal(await inspectAssets(other,files),'complete')
})

test('活着的持有者不被接管：锁 PID 与启动时间都与记录一致时等待，取消后立即返回、不删对方的锁',async t=>{
 const dir=await tempDir(t)
 await mkdir(dir,{recursive:true})
 await writeFile(join(dir,'.prepare.lock'),`${process.pid}\n`)
 await writeFile(join(dir,'.prepare.owner.json'),JSON.stringify({pid:process.pid,started:await processStartTime(process.pid)}))
 const server=await stub(t,okRoute)
 const controller=new AbortController()
 setTimeout(()=>controller.abort(new Error('取消')),300)
 const started=Date.now()
 await assert.rejects(prepareAssets({dir,files,...hosts,fetch:server.fetch,freeBytes:enough,signal:controller.signal,onProgress:()=>{}}))
 assert.ok(Date.now()-started<1500,'等锁期间取消在一个轮询间隔内返回')
 assert.ok(existsSync(join(dir,'.prepare.lock')))
 assert.equal(server.seen.length,0)
})

const mirrors=(assets as AssetsManifest).mirrors
const officialPaths=files.map(row=>new URL(row.url).pathname)
test('镜像跳转表：实测 hf-mirror.com → huggingface.co → *.hf.co，另按裁定放行镜像子域 *.hf-mirror.com；只在镜像表里，官方表不收镜像主机',()=>{
 assert.deepEqual(mirrors,[{id:'hf-mirror',hostMap:{'huggingface.co':'hf-mirror.com'},redirectHosts:['huggingface.co','*.huggingface.co','*.hf.co','*.hf-mirror.com']}])
 const patterns=mirrors[0]!.redirectHosts
 for(const host of ['huggingface.co','us.aws.cdn.hf.co','cas-bridge.xethub.hf.co','cdn.hf-mirror.com','cas-bridge.xethub.hf-mirror.com'])assert.equal(hostAllowed(host,patterns),true,host)
 for(const host of ['hf-mirror.com.evil.example','evilhf-mirror.com','hf.co','evil.com','cdn.hf-mirror.com.evil.example'])assert.equal(hostAllowed(host,patterns),false,host)
 const official=(assets as AssetsManifest)
 for(const host of ['hf-mirror.com','cdn.hf-mirror.com'])assert.equal(official.allowedHosts.includes(host)||hostAllowed(host,official.redirectHosts),false,host)
})

test('镜像子域：选镜像时跳到 cdn.hf-mirror.com 放行并照常校验发布；选官方时跳到镜像子域仍被拒',async t=>{
 const toMirrorCdn:Route=(req,res,host,path)=>{if(host==='cdn.hf-mirror.com')return okRoute(req,res,host,path);res.writeHead(302,{location:`https://cdn.hf-mirror.com${path}?sig=1`});res.end()}
 const dir=await tempDir(t)
 const mirrored=await stub(t,toMirrorCdn)
 await prepareAssets({dir,files,...hosts,source:'hf-mirror',mirrors,fetch:mirrored.fetch,freeBytes:enough,signal:new AbortController().signal,onProgress:()=>{}})
 assert.deepEqual(mirrored.seen.map(row=>row.host),['hf-mirror.com','cdn.hf-mirror.com','hf-mirror.com','cdn.hf-mirror.com'])
 assert.equal(await inspectAssets(dir,files),'complete')
 const official=await stub(t,toMirrorCdn)
 const error=await failure(prepareAssets({dir:await tempDir(t),files,...hosts,source:'official',mirrors,fetch:official.fetch,freeBytes:enough,signal:new AbortController().signal,onProgress:()=>{}}))
 assert.equal(error.reason,'http')
 assert.equal(error.source,'huggingface.co')
 assert.equal(official.seen.length,1,'不向镜像子域发请求')
})

test('选镜像：请求主机为 hf-mirror.com、路径（含固定修订）与官方逐字相同；每一跳都不带 Authorization/Cookie；照常按大小与 sha256 发布',async t=>{
 const dir=await tempDir(t)
 const headers:Record<string,string|string[]|undefined>[]=[]
 const server=await stub(t,(req,res,host,path)=>{headers.push(req.headers);okRoute(req,res,host,path)})
 await prepareAssets({dir,files,...hosts,source:'hf-mirror',mirrors,fetch:server.fetch,freeBytes:enough,signal:new AbortController().signal,onProgress:()=>{}})
 assert.deepEqual(server.seen.map(row=>row.host),['hf-mirror.com','hf-mirror.com'])
 assert.deepEqual(server.seen.map(row=>row.path),officialPaths)
 assert.equal(await inspectAssets(dir,files),'complete')
 const chain=await stub(t,(req,res,host,path)=>{
  headers.push(req.headers)
  if(host==='hf-mirror.com'){res.writeHead(308,{location:`https://huggingface.co${path}`});res.end();return}
  if(host==='huggingface.co'){res.writeHead(302,{location:`https://us.aws.cdn.hf.co/xet${path}?X-Amz-Signature=secret`});res.end();return}
  okRoute(req,res,host,path)
 })
 await prepareAssets({dir:await tempDir(t),files,...hosts,source:'hf-mirror',mirrors,fetch:chain.fetch,freeBytes:enough,signal:new AbortController().signal,onProgress:()=>{}})
 assert.deepEqual(chain.seen.map(row=>row.host),['hf-mirror.com','huggingface.co','us.aws.cdn.hf.co','hf-mirror.com','huggingface.co','us.aws.cdn.hf.co'])
 assert.equal(headers.length,8)
 for(const row of headers){assert.equal(row.authorization,undefined);assert.equal(row.cookie,undefined)}
})

test('缺省与 official：仍只请求 huggingface.co 与官方跳转表，镜像表不参与',async t=>{
 for(const source of [undefined,'official'] as const){
  const dir=await tempDir(t)
  const server=await stub(t,okRoute)
  await prepareAssets({dir,files,...hosts,...(source?{source}:{}),mirrors,fetch:server.fetch,freeBytes:enough,signal:new AbortController().signal,onProgress:()=>{}})
  assert.deepEqual(server.seen.map(row=>row.host),['huggingface.co','huggingface.co'],String(source))
  assert.deepEqual(server.seen.map(row=>row.path),officialPaths)
  const other=await stub(t,(_req,res)=>{res.writeHead(302,{location:'https://hf-mirror.com/x'});res.end()})
  const error=await failure(prepareAssets({dir:await tempDir(t),files,...hosts,...(source?{source}:{}),mirrors,fetch:other.fetch,freeBytes:enough,signal:new AbortController().signal,onProgress:()=>{}}))
  assert.equal(error.reason,'http',String(source))
 }
})

test('镜像跳转到跳转表外主机或降级 http 被拒：原因 http、来源为镜像主机、不向表外主机发请求',async t=>{
 for(const location of ['https://evil.example/x?token=secret','https://cdn.hf-mirror.com.evil.example/x','http://cdn.hf-mirror.com/x','https://hf-mirror.com.evil.example/x','http://hf-mirror.com/x','http://huggingface.co/x']){
  const server=await stub(t,(_req,res)=>{res.writeHead(302,{location});res.end()})
  const error=await failure(prepareAssets({dir:await tempDir(t),files,...hosts,source:'hf-mirror',mirrors,fetch:server.fetch,freeBytes:enough,signal:new AbortController().signal,onProgress:()=>{}}))
  assert.equal(error.reason,'http',location)
  assert.equal(error.source,'hf-mirror.com',location)
  assert.doesNotMatch(error.message,/secret|token=|\?/,location)
  assert.equal(server.seen.length,1,location)
 }
})

test('镜像文件摘要不符：按 integrity 失败并提示改用官方来源；官方来源失败不带此提示',async t=>{
 const tampered:Route=(req,res,host,path)=>{if(!path.endsWith('tokenizer.json'))return okRoute(req,res,host,path);res.writeHead(200);res.end(randomBytes(blobs.b.length))}
 const mirrored=await stub(t,tampered)
 const dir=await tempDir(t)
 const error=await failure(prepareAssets({dir,files,...hosts,source:'hf-mirror',mirrors,fetch:mirrored.fetch,freeBytes:enough,signal:new AbortController().signal,onProgress:()=>{}}))
 assert.equal(error.reason,'integrity')
 assert.equal(error.source,'hf-mirror.com')
 assert.match(error.message,/改用 Hugging Face 官方来源/)
 assert.equal(existsSync(join(dir,'tokenizer.json')),false)
 const official=await stub(t,tampered)
 const plain=await failure(prepareAssets({dir:await tempDir(t),files,...hosts,source:'official',mirrors,fetch:official.fetch,freeBytes:enough,signal:new AbortController().signal,onProgress:()=>{}}))
 assert.equal(plain.reason,'integrity')
 assert.doesNotMatch(plain.message,/官方来源/)
})

test('未知来源或镜像表缺失：准备前按可识别的下载失败拒绝（http，来源为官方主机，不回显来源名），不发请求',async t=>{
 const server=await stub(t,okRoute)
 for(const options of [{source:'evil-mirror',mirrors},{source:'hf-mirror'},{source:'hf-mirror',mirrors:[]}]){
  const error=await failure(prepareAssets({dir:await tempDir(t),files,...hosts,...options,fetch:server.fetch,freeBytes:enough,signal:new AbortController().signal,onProgress:()=>{}} as never))
  assert.equal(error.reason,'http')
  assert.equal(error.resource,'onnx/model.onnx')
  assert.equal(error.source,'huggingface.co')
  assert.match(error.message,/官方来源/)
  assert.doesNotMatch(error.message,/evil-mirror/)
 }
 assert.equal(server.seen.length,0)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import type {TestContext} from 'node:test'
import {spawn} from 'node:child_process'
import {mkdtemp,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import type {SubprocessHandle,SubprocessSpawnSpec} from '@deepseek-ai/dsh-subprocess'
import {startWorkerEngine,workerEnvironment} from '../src/engine.ts'
import type {WorkerConfig} from '../src/inference.ts'

/** 用真实子进程模拟 ctx.subprocess.spawn 的最小子集：记录 spec，stdin/stdout 管道，终止后 waitForExit。 */
function subprocess(specs:SubprocessSpawnSpec[]){
 return (spec:SubprocessSpawnSpec):SubprocessHandle=>{
  specs.push(spec)
  // 同本地提供者：清洗后父环境为底，合入 spec.env，undefined 为墓碑
  const merged:Record<string,string>={}
  for(const [name,value] of Object.entries({...process.env,...spec.env}))if(value!==undefined)merged[name]=value
  const child=spawn(spec.argv[0]!,spec.argv.slice(1),{cwd:spec.cwd,stdio:['pipe','pipe','ignore'],env:merged})
  const done=new Promise<{exitCode:number|null;signal:NodeJS.Signals|null}>(resolve=>child.once('close',(exitCode,signal)=>resolve({exitCode,signal})))
  return {stdin:child.stdin,stdout:child.stdout,stderr:undefined,control:undefined,collected:{},done,terminate:()=>{child.kill('SIGTERM')},waitForExit:async()=>{await done;return true}}
 }
}
const config:WorkerConfig={runtimeDir:'/r',modelPath:'/m',tokenizerPath:'/t',tokenizerConfigPath:'/tc',maxTokens:512,appendedTokenId:151643,queryInstruction:'',documentPrefix:'',padTokenId:151643,kvLayers:28,kvHeads:8,headDim:128,batchSize:4,dimensions:1024}

/** 假子进程脚本：按 mode 模拟正常、先退出、输出坏帧、回错误类别、崩溃。 */
async function fakeWorker(t:TestContext,body:string){
 const dir=await mkdtemp(join(tmpdir(),'teloa-embed-engine-'))
 t.after(()=>rm(dir,{recursive:true,force:true}))
 const path=join(dir,'worker.mjs')
 await writeFile(path,`import {createInterface} from 'node:readline'
const write=v=>process.stdout.write(JSON.stringify(v)+'\\n')
const config=JSON.parse(process.argv[2])
${body}`)
 return path
}
const normal=`write({ready:true})
for await(const line of createInterface({input:process.stdin})){
 const req=JSON.parse(line)
 const flat=new Float32Array(req.texts.length*config.dimensions)
 req.texts.forEach((_,i)=>{flat[i*config.dimensions+i]=1})
 write({id:req.id,vectors:Buffer.from(flat.buffer).toString('base64'),truncated:req.texts.length>1?1:0})
}`

test('启动：以 process.execPath <worker> <config> 经注入的 spawn 启动，stdin/stdout 为管道；等 ready 后可嵌入；关闭后进程退出',async t=>{
 const specs:SubprocessSpawnSpec[]=[]
 const worker=await fakeWorker(t,normal)
 const engine=await startWorkerEngine({spawn:subprocess(specs),workerPath:worker,config,cwd:tmpdir(),signal:new AbortController().signal})
 assert.equal(specs.length,1)
 assert.deepEqual(specs[0]!.argv,[process.execPath,worker,JSON.stringify(config)])
 assert.equal(specs[0]!.stdio.stdin,'pipe')
 assert.equal(specs[0]!.stdio.stdout,'pipe')
 assert.equal(specs[0]!.env?.ELECTRON_RUN_AS_NODE,'1')
 assert.deepEqual(specs[0]!.env,workerEnvironment())
 const result=await engine.embed('passage',['a','b'],new AbortController().signal)
 assert.equal(result.vectors.length,2)
 assert.equal(result.vectors[1]![1],1)
 assert.equal(result.truncated,1)
 const again=await engine.embed('query',['c'],new AbortController().signal)
 assert.equal(again.vectors.length,1)
 await engine.close()
 await engine.exited
})

test('子进程环境白名单：只留 PATH/HOME/临时目录/区域/时区与 ELECTRON_RUN_AS_NODE；工作区 .env 合入的其它名字一律墓碑移除',async t=>{
 const parent={PATH:'/bin',HOME:'/h',TMPDIR:'/t',LANG:'C',OMP_NUM_THREADS:'7',ORT_LOGGING_LEVEL:'0',NODE_OPTIONS:'--require=/evil.js',HTTPS_PROXY:'http://proxy',TELOA_ANYTHING:'x',DEEPSEEK_API_KEY:'k'}
 const env=workerEnvironment(parent)
 assert.deepEqual(Object.fromEntries(Object.entries(env).filter(([,value])=>value!==undefined)),{PATH:'/bin',HOME:'/h',TMPDIR:'/t',LANG:'C',ELECTRON_RUN_AS_NODE:'1'})
 for(const name of ['OMP_NUM_THREADS','ORT_LOGGING_LEVEL','NODE_OPTIONS','HTTPS_PROXY','TELOA_ANYTHING','DEEPSEEK_API_KEY'])assert.ok(Object.hasOwn(env,name)&&env[name]===undefined,name)
 // 真实子进程：宿主 process.env 里被 .env 合入的名字到不了推理进程
 process.env.OMP_NUM_THREADS='7'
 t.after(()=>{delete process.env.OMP_NUM_THREADS})
 const worker=await fakeWorker(t,`write({ready:true,env:Object.keys(process.env).sort()});setInterval(()=>{},1000)`)
 const seen:string[]=[]
 const spawnSpy=(spec:SubprocessSpawnSpec)=>{const handle=subprocess([])(spec);handle.stdout!.once('data',chunk=>seen.push(String(chunk)));return handle}
 const engine=await startWorkerEngine({spawn:spawnSpy,workerPath:worker,config,cwd:tmpdir(),signal:new AbortController().signal})
 const keys=(JSON.parse(seen.join('').split('\n')[0]!) as {env:string[]}).env
 assert.ok(!keys.includes('OMP_NUM_THREADS'))
 assert.ok(keys.every(name=>['PATH','HOME','USERPROFILE','TMPDIR','TMP','TEMP','LANG','LC_ALL','LC_CTYPE','TZ','SYSTEMROOT','WINDIR','ELECTRON_RUN_AS_NODE','__CF_USER_TEXT_ENCODING'].includes(name)),keys.join(','))
 await engine.close()
})

test('ready 之前退出、启动超时：拒绝并终止进程',async t=>{
 const early=await fakeWorker(t,'process.exit(3)')
 await assert.rejects(startWorkerEngine({spawn:subprocess([]),workerPath:early,config,cwd:tmpdir(),signal:new AbortController().signal}),/推理进程/)
 const hang=await fakeWorker(t,'setInterval(()=>{},1000)')
 await assert.rejects(startWorkerEngine({spawn:subprocess([]),workerPath:hang,config,cwd:tmpdir(),signal:AbortSignal.timeout(100)}))
})

test('响应格式错（向量字节数不符、id 不符、非 JSON）、错误类别、崩溃与超时：embed 拒绝',async t=>{
 const cases=[
  `write({ready:true});for await(const line of createInterface({input:process.stdin})){const req=JSON.parse(line);write({id:req.id,vectors:Buffer.alloc(8).toString('base64'),truncated:0})}`,
  `write({ready:true});for await(const line of createInterface({input:process.stdin})){const req=JSON.parse(line);write({id:req.id+1,vectors:'',truncated:0})}`,
  `write({ready:true});for await(const line of createInterface({input:process.stdin})){process.stdout.write('not json\\n')}`,
  `write({ready:true});for await(const line of createInterface({input:process.stdin})){const req=JSON.parse(line);write({id:req.id,error:{category:'inference'}})}`,
  `write({ready:true});for await(const line of createInterface({input:process.stdin})){process.exit(1)}`,
 ]
 for(const body of cases){
  const engine=await startWorkerEngine({spawn:subprocess([]),workerPath:await fakeWorker(t,body),config,cwd:tmpdir(),signal:new AbortController().signal})
  await assert.rejects(engine.embed('query',['a'],new AbortController().signal),body)
  await engine.close()
 }
 const slow=await startWorkerEngine({spawn:subprocess([]),workerPath:await fakeWorker(t,`write({ready:true});setInterval(()=>{},1000)`),config,cwd:tmpdir(),signal:new AbortController().signal})
 await assert.rejects(slow.embed('query',['a'],AbortSignal.timeout(50)))
 await slow.close()
})

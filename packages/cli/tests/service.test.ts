import assert from 'node:assert/strict'
import test from 'node:test'
import {createServer} from 'node:http'
import {mkdtemp,mkdir,writeFile,access} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {resolveLayout} from '../src/layout.ts'
import {writePrivateJson} from '../src/state.ts'
import type {InstallState} from '../src/contracts.ts'
const service=await import('../src/service.ts').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return {};throw error}) as any
test('维护状态直接禁止底层启动，restart 不能绕过失败恢复保护',async()=>{
 const home=join(await mkdtemp(join(tmpdir(),'teloa-maintenance-')),'home')
 const state:InstallState={schema:'teloa.install/v1',id:randomUUID(),version:'0.2.0-alpha.3',layout:await resolveLayout({home,version:'0.2.0-alpha.3'}),database:{kind:'docker'},phase:'maintenance',port:65530}
 await assert.rejects(service.startService(state),/维护/)
})
test('占用端口拒绝启动，原进程仍可用',async()=>{
 assert.equal(typeof service.startService,'function','缺少服务启动')
 const server=createServer((_req,res)=>res.end('unrelated'))
 await new Promise<void>(done=>server.listen(0,'127.0.0.1',done))
 try{
  const port=(server.address() as any).port,home=join(await mkdtemp(join(tmpdir(),'teloa-port-')),'home')
  const state:InstallState={schema:'teloa.install/v1',id:randomUUID(),version:'0.2.0-alpha.3',layout:await resolveLayout({home,version:'0.2.0-alpha.3'}),database:{kind:'docker'},phase:'prepared',port}
  await assert.rejects(service.startService(state),/端口/)
  assert.equal(await fetch('http://127.0.0.1:'+port).then(r=>r.text()),'unrelated')
 }finally{server.close()}
})
test('失联进程身份不能被当成已停止，也不能对 PID 发送停止信号',async()=>{
 assert.equal(typeof service.stopService,'function','缺少服务停止')
 const home=join(await mkdtemp(join(tmpdir(),'teloa-process-')),'home')
 const state:InstallState={schema:'teloa.install/v1',id:randomUUID(),version:'0.2.0-alpha.3',layout:await resolveLayout({home,version:'0.2.0-alpha.3'}),database:{kind:'docker'},phase:'prepared',port:65534}
 await writePrivateJson(join(state.layout.instanceRoot,'control.json'),{pid:process.pid,startedAt:new Date().toISOString(),nonce:randomUUID(),installId:state.id,port:1,secret:'a'.repeat(64)})
 assert.equal((await service.serviceStatus(state)).app,'unknown')
 await assert.rejects(service.stopService(state),/身份|失联/)
})
test('重复启动必须等正在启动的原服务真正就绪',async()=>{
 const home=join(await mkdtemp(join(tmpdir(),'teloa-starting-')),'home')
 const state:InstallState={schema:'teloa.install/v1',id:randomUUID(),version:'0.2.0-alpha.3',layout:await resolveLayout({home,version:'0.2.0-alpha.3'}),database:{kind:'docker'},phase:'prepared',port:65533}
 const nonce=randomUUID();let calls=0
 const server=createServer((_req,res)=>{calls++;res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,nonce,installId:state.id,value:{app:calls<3?'starting':'ready',activeWork:0,database:'ready',version:state.version,port:state.port}}))})
 await new Promise<void>(done=>server.listen(0,'127.0.0.1',done))
 try{
  await writePrivateJson(join(state.layout.instanceRoot,'control.json'),{pid:process.pid,startedAt:new Date().toISOString(),nonce,installId:state.id,port:(server.address() as any).port,secret:'a'.repeat(64)})
  assert.equal((await service.startService(state)).app,'ready')
  assert.ok(calls>=3)
 }finally{server.close()}
})
test('启动超时必须结束亲自创建的 supervisor，迟到回调不能再启动应用',async()=>{
 const home=join(await mkdtemp(join(tmpdir(),'teloa-late-start-')),'home'),layout=await resolveLayout({home,version:'0.2.0-alpha.3'})
 await mkdir(layout.workspaceRoot,{recursive:true});await mkdir(join(layout.releaseRoot,'scripts/runtime'),{recursive:true});await mkdir(join(layout.releaseRoot,'packages/cli/lib'),{recursive:true})
 const marker=join(home,'late-ready')
 await writeFile(join(layout.releaseRoot,'scripts/runtime/profile.mjs'),'export const runtimeEnvironment=()=>process.env')
 await writeFile(join(layout.releaseRoot,'packages/cli/lib/service-entry.js'),`import {writeFileSync} from 'node:fs';setTimeout(()=>writeFileSync(${JSON.stringify(marker)},'ready'),1200);setTimeout(()=>{},5000)`)
 const state:InstallState={schema:'teloa.install/v1',id:randomUUID(),version:'0.2.0-alpha.3',layout,database:{kind:'existing',configFile:join(home,'missing-database.json')},phase:'stopped',port:65532}
 await assert.rejects(service.startService(state,{timeoutMs:50}),/超时/)
 await new Promise(done=>setTimeout(done,1400))
 await assert.rejects(access(marker),error=>(error as NodeJS.ErrnoException).code==='ENOENT')
})
test('supervisor 不响应终止时只清理本次独立进程组，不留下迟到的子进程',async()=>{
 const home=join(await mkdtemp(join(tmpdir(),'teloa-stuck-start-')),'home'),layout=await resolveLayout({home,version:'0.2.0-alpha.3'})
 await mkdir(layout.workspaceRoot,{recursive:true});await mkdir(join(layout.releaseRoot,'scripts/runtime'),{recursive:true});await mkdir(join(layout.releaseRoot,'packages/cli/lib'),{recursive:true})
 const marker=join(home,'orphan-ready'),started=join(home,'started')
 await writeFile(join(layout.releaseRoot,'scripts/runtime/profile.mjs'),'export const runtimeEnvironment=()=>process.env')
 const nested=`import {writeFileSync} from 'node:fs';setTimeout(()=>writeFileSync(${JSON.stringify(marker)},'ready'),17000);setTimeout(()=>{},22000)`
 await writeFile(join(layout.releaseRoot,'packages/cli/lib/service-entry.js'),`import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';process.on('SIGTERM',()=>{});spawn(process.execPath,['--input-type=module','-e',${JSON.stringify(nested)}],{stdio:'ignore'});writeFileSync(${JSON.stringify(started)},'yes');setTimeout(()=>{},22000)`)
 const state:InstallState={schema:'teloa.install/v1',id:randomUUID(),version:'0.2.0-alpha.3',layout,database:{kind:'existing',configFile:join(home,'missing-database.json')},phase:'stopped',port:65531}
 await assert.rejects(service.startService(state,{timeoutMs:500}),/超时/)
 await access(started)
 await new Promise(done=>setTimeout(done,2000))
 await assert.rejects(access(marker),error=>(error as NodeJS.ErrnoException).code==='ENOENT')
})

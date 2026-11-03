import assert from 'node:assert/strict'
import {spawn,spawnSync,execFileSync} from 'node:child_process'
import {access,mkdir,mkdtemp,readFile,stat,rm,writeFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {tmpdir,release} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import test from 'node:test'

const cli=fileURLToPath(new URL('..',import.meta.url))
const build=join(cli,'scripts/build-maintenance-helper.mjs')
const helper=join(cli,'libexec/maintenance-process')
const binding='b'.repeat(64)
const supported=process.platform==='darwin'&&process.arch==='arm64'&&release().split('.')[0]==='25'

test('维护 helper 有构建入口并按平台写入可信摘要',async()=>{
 await assert.doesNotReject(access(build),'缺少维护进程 helper 构建入口')
 execFileSync(process.execPath,[build],{cwd:cli,stdio:'pipe'})
 const support=JSON.parse(await readFile(join(cli,'libexec/support.json'),'utf8'))
 assert.equal(support.schema,'teloa.maintenance-process-support/v1')
 assert.equal(support.platform,process.platform)
 assert.equal(support.arch,process.arch)
 assert.equal(support.osRelease,release())
 assert.equal(support.supported,supported)
 if(supported){
  assert.equal(support.binarySha256,createHash('sha256').update(await readFile(helper)).digest('hex'))
  assert.equal(support.abi.procUniqueIdentifierInfoSize,56)
 }else assert.equal(typeof support.reason,'string')
})

test('inspect 明确区分进程不存在与不可证明',{skip:!supported},async()=>{
 const own=spawn('/usr/bin/true',[],{stdio:'ignore'})
 await new Promise<void>(resolve=>own.once('exit',()=>resolve()))
 const absent=spawnSync(helper,['inspect',String(own.pid)],{encoding:'utf8'})
 assert.equal(absent.status,3,absent.stderr)
 assert.deepEqual(JSON.parse(absent.stdout),{absent:true,pid:own.pid})
 assert.equal(spawnSync(helper,['inspect','invalid'],{encoding:'utf8'}).status,1)
})

test('发行只复制匹配摘要的 helper 和支持清单',async()=>{
 // 发行脚本是独立 mjs；通过 URL 加载并为本测试实际使用的调用面声明类型。
 const release=await import(new URL('../../../scripts/release/package-files.mjs',import.meta.url).href)
 assert.equal(typeof release.prepareReleasePackage,'function')
 const prepareReleasePackage:(options:{root:string;stage:string;directory:string;version:string})=>Promise<unknown>=release.prepareReleasePackage
 const root=await mkdtemp(join(tmpdir(),'teloa-maintenance-release-'))
 const source=join(root,'packages/cli'),stage=join(root,'stage')
 try{
  await mkdir(join(source,'lib'),{recursive:true});await mkdir(join(source,'libexec'))
  await mkdir(join(source,'src'))
  await writeFile(join(source,'package.json'),JSON.stringify({name:'@teloa/cli',exports:{'.':'./src/index.ts'}}))
  await writeFile(join(source,'tsconfig.json'),JSON.stringify({compilerOptions:{rootDir:'src',outDir:'lib',module:'ESNext'},include:['src']}))
  await writeFile(join(source,'src/index.ts'),'export {}')
  await writeFile(join(source,'lib/index.js'),'export {}')
  await writeFile(join(source,'libexec/private-proof.json'),'not for release')
  const support=JSON.parse(await readFile(join(cli,'libexec/support.json'),'utf8'))
  await writeFile(join(source,'libexec/support.json'),JSON.stringify(support))
  if(support.supported)await writeFile(join(source,'libexec/maintenance-process'),await readFile(helper))
  const options={root,stage,directory:'cli',version:'0.2.10'}
  await prepareReleasePackage(options)
  assert.deepEqual(JSON.parse(await readFile(join(stage,'packages/cli/libexec/support.json'),'utf8')),support)
  await assert.rejects(access(join(stage,'packages/cli/libexec/private-proof.json')))
  if(support.supported){
   assert.ok((await stat(join(stage,'packages/cli/libexec/maintenance-process'))).mode&0o111)
   await writeFile(join(source,'libexec/maintenance-process'),'wrong binary')
   await assert.rejects(prepareReleasePackage({...options,stage:join(root,'rejected')}),/摘要/)
  }
  await writeFile(join(source,'libexec/support.json'),JSON.stringify({...support,supported:false,reason:'unsupported fixture'}))
  const unsupported=join(root,'unsupported')
  await prepareReleasePackage({...options,stage:unsupported})
  await assert.rejects(access(join(unsupported,'packages/cli/libexec/maintenance-process')))
 }finally{await rm(root,{recursive:true,force:true})}
})

test('真实进程世代与完整退出决定是否签收据',{skip:!supported,timeout:100_000},async t=>{
 await assert.doesNotReject(access(helper),'缺少已构建的维护进程 helper')
 const root=await mkdtemp(join(tmpdir(),'teloa-maintenance-native-'))
 const fixture=join(root,'fixture')
 execFileSync('xcrun',['clang','-std=c11','-Wall','-Wextra','-Werror',join(cli,'tests/fixtures/maintenance-process-fixture.c'),'-o',fixture])
 const inspect=(pid:number)=>JSON.parse(execFileSync(helper,['inspect',String(pid)],{encoding:'utf8'}))
 async function setup(mode:string){
  const cleanupFile=join(root,'cleanup-'+mode+'-'+Math.random().toString(16).slice(2))
  const processFixture=spawn(fixture,[mode,cleanupFile],{stdio:['ignore','pipe','pipe']})
  let closed=false
  const closing=new Promise<void>(resolve=>processFixture.once('close',()=>{closed=true;resolve()}))
  const ready=await new Promise<{child:number;port:number;referenceMcp?:number}>((resolve,reject)=>{
   let data=''
   processFixture.stdout.on('data',chunk=>{
    data+=chunk;const end=data.indexOf('\n');if(end<0)return
    try{
     const value=JSON.parse(data.slice(0,end)) as {child?:unknown;port?:unknown;referenceMcp?:unknown}
     if(typeof value.child!=='number'||!Number.isSafeInteger(value.child)||value.child<1||typeof value.port!=='number'||!Number.isSafeInteger(value.port)||value.port<1||value.port>65535)throw Error('fixture identity invalid')
     if(value.referenceMcp!==undefined&&(typeof value.referenceMcp!=='number'||!Number.isSafeInteger(value.referenceMcp)||value.referenceMcp<1))throw Error('fixture reference identity invalid')
     resolve({child:value.child,port:value.port,...value.referenceMcp===undefined?{}:{referenceMcp:value.referenceMcp as number}})
    }catch(error){reject(error)}
   })
   processFixture.once('error',reject)
   processFixture.once('exit',code=>reject(Error('fixture exited before ready: '+code)))
  })
  const supervisor=inspect(processFixture.pid!),child=inspect(ready.child),referenceMcp=ready.referenceMcp?inspect(ready.referenceMcp):undefined
  const receipt=join(root,mode+'-'+processFixture.pid+'.json')
  const args=()=>[referenceMcp?'fence-reference':'fence',String(supervisor.pid),String(supervisor.pidVersion),supervisor.uniqueId,String(child.pid),String(child.pidVersion),child.uniqueId,...referenceMcp?[String(referenceMcp.pid),String(referenceMcp.pidVersion),referenceMcp.uniqueId]:[],receipt,binding]
  const run=(executable=helper,environment:NodeJS.ProcessEnv=process.env)=>{
   const command=spawn(executable,args(),{stdio:['ignore','pipe','pipe'],env:environment})
   let stderr='';command.stderr.on('data',chunk=>stderr+=chunk)
   const completion=new Promise<{code:number|null;stderr:string}>(resolve=>command.once('exit',code=>resolve({code,stderr})))
   return {command,completion}
  }
  const cleanup=async()=>{
   await writeFile(cleanupFile,'cleanup')
   if(processFixture.exitCode===null&&processFixture.signalCode===null)processFixture.kill('SIGTERM')
   if(!closed)await closing
   if(referenceMcp){
    let absent=false
    for(let count=0;count<100;count++){
     if(spawnSync(helper,['inspect',String(referenceMcp.pid)]).status===3){absent=true;break}
     await new Promise(done=>setTimeout(done,10))
    }
    assert.ok(absent,'本轮 reference 叶进程必须退出')
   }
   const escaped=await readFile(cleanupFile+'.escaped','utf8').then(Number).catch(()=>undefined)
   if(escaped){
    let absent=false
    for(let count=0;count<100;count++){
     if(spawnSync(helper,['inspect',String(escaped)]).status===3){absent=true;break}
     await new Promise(done=>setTimeout(done,10))
    }
    assert.ok(absent,'私有清理标记必须先让本轮脱离后代真实退出')
   }
  }
  return {supervisor,child,referenceMcp,receipt,ready,args,run,cleanup,cleanupFile,processFixture}
 }
 try{
  for(const reference of [false,true])for(const window of ['initial-read','registration-gap'])await t.test((reference?'reference ':'')+window+' 已观察对象fork并脱离的真实后代必须阻止签发收据',async()=>{
   const observed=join(root,'observed-window')
   execFileSync('xcrun',['clang','-std=c11','-Wall','-Wextra','-Werror','-DTELOA_OS_MAJOR=25','-DTELOA_BUILD_ARCH="arm64"',join(cli,'tests/fixtures/maintenance-process-window.c'),'-o',observed])
   const f=await setup(reference?'reference-pre-registration-fork':'pre-registration-fork')
   try{
    const result=await f.run(observed,{...process.env,TELOA_FIXTURE_CHILD:String(f.referenceMcp?.pid??f.child.pid),TELOA_FIXTURE_CLEANUP:f.cleanupFile,...(window==='registration-gap'?{TELOA_FIXTURE_WINDOW:window}:{})}).completion
    assert.notEqual(result.code,0,'读取与注册之间的真实fork不能漏签')
    await assert.rejects(access(f.receipt));assert.equal(f.processFixture.exitCode,null,'拒绝发生在发信号前')
    const escaped=Number(await readFile(f.cleanupFile+'.escaped','utf8'))
    assert.ok(inspect(escaped).uniqueId,'确实存在脱离原父子拓扑的自有后代')
   }finally{await f.cleanup()}
  })
  await t.test('reference 三进程完整退出保留同一收据语义',async()=>{
   const f=await setup('reference-normal')
   try{
    assert.ok(f.referenceMcp)
    assert.deepEqual(f.child.children,[f.referenceMcp.pid]);assert.deepEqual(f.referenceMcp.children,[])
    const result=await f.run().completion;assert.equal(result.code,0,result.stderr)
    const receipt=JSON.parse(await readFile(f.receipt,'utf8'))
    assert.deepEqual(receipt.supervisor,f.supervisor);assert.deepEqual(receipt.child,f.child);assert.deepEqual(receipt.referenceMcp,f.referenceMcp)
    assert.deepEqual(receipt.exited,[f.supervisor.pid,f.child.pid,f.referenceMcp.pid].sort((a,b)=>a-b))
    assert.equal(receipt.schema,'teloa.maintenance-process-exit/v1');assert.equal(receipt.observationScope,'bound-processes-after-registration')
    assert.equal(receipt.signal,'SIGTERM');assert.equal((await stat(f.receipt)).mode&0o777,0o600)
   }finally{await f.cleanup()}
  })
  await t.test('reference 错误世代在发信号前拒绝',async()=>{
   const f=await setup('reference-normal')
   try{
    assert.ok(f.referenceMcp)
    f.referenceMcp.pidVersion++
    const result=await f.run().completion;assert.notEqual(result.code,0);assert.match(result.stderr,/generation or topology mismatch/)
    assert.equal(f.processFixture.exitCode,null);assert.equal(inspect(f.referenceMcp.pid).pidVersion,f.referenceMcp.pidVersion-1)
    await assert.rejects(access(f.receipt))
   }finally{await f.cleanup()}
  })
  for(const mode of ['reference-descendant','reference-fork','reference-exec','reference-orphan'])await t.test(mode+' 拒绝第三进程额外后代、变化或缺失退出',async()=>{
   const f=await setup(mode)
   try{
    assert.ok(f.referenceMcp)
    const result=await f.run().completion;assert.notEqual(result.code,0)
    assert.match(result.stderr,mode==='reference-descendant'?/generation or topology mismatch/:/complete stable process exit was not observed/)
    await assert.rejects(access(f.receipt))
    if(mode==='reference-descendant')assert.equal(f.processFixture.exitCode,null)
    if(mode==='reference-orphan')assert.equal(inspect(f.referenceMcp.pid).uniqueId,f.referenceMcp.uniqueId)
   }finally{await f.cleanup()}
  })
  await t.test('inspect 只含真实身份；正常退出产生0600收据',async()=>{
   const f=await setup('normal')
   try{
    assert.equal(f.child.ppid,f.supervisor.pid)
    assert.equal(f.child.parentUniqueId,f.supervisor.uniqueId)
    assert.deepEqual(f.supervisor.children,[f.child.pid])
    for(const key of ['uniqueId','parentUniqueId','executable','cwd','bootId'])assert.equal(typeof f.child[key],'string')
    assert.ok(f.child.birthSec>0&&f.child.birthUsec>=0&&f.child.pidVersion>0)
    assert.equal('env' in f.child,false);assert.equal('argv' in f.child,false)
    const result=await f.run().completion
    assert.equal(result.code,0,result.stderr)
    const receipt=JSON.parse(await readFile(f.receipt,'utf8'))
    assert.equal(receipt.schema,'teloa.maintenance-process-exit/v1')
    assert.equal(receipt.bindingSha256,binding)
    assert.deepEqual(receipt.supervisor,f.supervisor)
    assert.deepEqual(receipt.child,f.child)
    assert.deepEqual(receipt.exited,[f.supervisor.pid,f.child.pid].sort((a,b)=>a-b))
    assert.equal(receipt.signal,'SIGTERM');assert.equal(receipt.platform,'darwin')
    assert.equal(receipt.observationScope,'bound-processes-after-registration')
    assert.equal((await stat(f.receipt)).mode&0o777,0o600)
   }finally{await f.cleanup()}
  })
  for(const field of ['supervisor-generation','child-identity','existing-receipt'])await t.test(field+' 在发信号前拒绝',async()=>{
   const f=await setup('normal')
   try{
    if(field==='supervisor-generation')f.supervisor.pidVersion++
    if(field==='child-identity')f.child.uniqueId=String(BigInt(f.child.uniqueId)+1n)
    if(field==='existing-receipt')await writeFile(f.receipt,'existing',{mode:0o600})
    const result=await f.run().completion
    assert.notEqual(result.code,0)
    assert.equal(inspect(f.child.pid).uniqueId,field==='child-identity'?String(BigInt(f.child.uniqueId)-1n):f.child.uniqueId)
    assert.equal(f.processFixture.exitCode,null)
    if(field==='existing-receipt')assert.equal(await readFile(f.receipt,'utf8'),'existing')
    else await assert.rejects(access(f.receipt))
   }finally{await f.cleanup()}
  })
  for(const mode of ['orphan','portless-orphan','fork','exec','descendant'])await t.test(mode+' 不签发退出收据',async()=>{
   const f=await setup(mode)
   try{
    const result=await f.run().completion
    assert.notEqual(result.code,0)
    await assert.rejects(access(f.receipt))
    if(mode.includes('orphan')){
     assert.equal(inspect(f.child.pid).uniqueId,f.child.uniqueId)
     if(mode==='portless-orphan'){
      const {createServer}=await import('node:net')
      const server=createServer()
      await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(f.ready.port,'127.0.0.1',resolve)})
      await new Promise<void>(resolve=>server.close(()=>resolve()))
     }
    }
    if(mode==='descendant')assert.equal(f.processFixture.exitCode,null)
   }finally{await f.cleanup()}
  })
  await t.test('观察器丢失不留下退出收据',async()=>{
   const f=await setup('orphan')
   try{
    const run=f.run()
    await new Promise<void>(resolve=>f.processFixture.once('exit',()=>resolve()))
    run.command.kill('SIGTERM')
    await run.completion
    await assert.rejects(access(f.receipt))
    assert.equal(inspect(f.child.pid).uniqueId,f.child.uniqueId)
   }finally{await f.cleanup()}
  })
 }finally{await rm(root,{recursive:true,force:true})}
})

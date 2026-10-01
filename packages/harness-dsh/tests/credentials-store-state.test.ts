import test from 'node:test'
import assert from 'node:assert/strict'
import {chmod,mkdir,readFile,stat,symlink,utimes,writeFile} from 'node:fs/promises'
import {fork,spawnSync} from 'node:child_process'
import {readdir} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {lockWait,resolveStore,storePaths} from '../src/credentials/store-state.ts'
import {keyIdOf,seal} from '../src/credentials/envelope.ts'
import {defaultKeyDir,loadNativeKeyring} from '../src/credentials/key-sources.ts'
import {memoryKeyring,tempHome} from './fixtures/credentials.ts'

test('首次初始化：钥匙串可用 → keyring 档，meta 持久化并读回',async t=>{
 const home=await tempHome(t),{port,items}=memoryKeyring()
 const state=await resolveStore(storePaths(home),'auto',{keyring:port,env:{},keyDir:join(await tempHome(t),'keys')})
 assert.equal(state.mode,'encrypted')
 const meta=JSON.parse(await readFile(join(home,'.credentials.meta.json'),'utf8'))
 assert.equal(meta.tier,'keyring');assert.equal(items.size,1);assert.equal([...items.keys()][0],`${meta.installId}:${meta.keyId}`)
 assert.equal((await stat(join(home,'.credentials.meta.json'))).mode&0o777,0o600)
})

test('钥匙串超时 → 在 DSH_HOME 外生成 0600 密钥文件',async t=>{
 const home=await tempHome(t),keyDir=join(await tempHome(t),'keys')
 const state=await resolveStore(storePaths(home),'auto',{keyring:memoryKeyring({hang:true}).port,env:{},keyDir})
 assert.equal(state.mode,'encrypted')
 if(state.mode!=='encrypted')return
 assert.equal(state.meta.tier,'file');assert.ok(state.meta.keyFile?.startsWith(keyDir))
 assert.equal((await stat(state.meta.keyFile!)).mode&0o777,0o600)
})

test('无钥匙串、密钥目录落在 DSH_HOME 内 → 仅首次初始化回退明文，且档位持久化',async t=>{
 const home=await tempHome(t)
 const state=await resolveStore(storePaths(home),'auto',{keyring:undefined,env:{},keyDir:join(home,'keys')})
 assert.equal(state.mode,'plaintext')
 assert.equal(JSON.parse(await readFile(join(home,'.credentials.meta.json'),'utf8')).tier,'plaintext')
})

test('明文档在钥匙串可用后升级为加密',async t=>{
 const home=await tempHome(t),paths=storePaths(home)
 await resolveStore(paths,'auto',{keyring:undefined,env:{},keyDir:join(home,'keys')})
 const upgraded=await resolveStore(paths,'auto',{keyring:memoryKeyring().port,env:{},keyDir:join(home,'keys')})
 assert.equal(upgraded.mode,'encrypted')
})

test('已加密后取不到主密钥 → 锁定 key-unavailable，绝不降级',async t=>{
 const home=await tempHome(t),paths=storePaths(home)
 const first=await resolveStore(paths,'auto',{keyring:memoryKeyring().port,env:{},keyDir:join(await tempHome(t),'k')})
 assert.equal(first.mode,'encrypted')
 const again=await resolveStore(paths,'auto',{keyring:memoryKeyring().port,env:{},keyDir:join(home,'keys')})
 assert.deepEqual(again,{mode:'locked',reason:'key-unavailable'})
})

test('有 .enc 无 meta → 锁定 meta-missing；显式 keyring 不可用 → store-unavailable',async t=>{
 const home=await tempHome(t),paths=storePaths(home)
 await writeFile(paths.encrypted,seal(Buffer.alloc(32,1),'00000000-0000-4000-8000-000000000000','{}'),{mode:0o600})
 assert.deepEqual(await resolveStore(paths,'auto',{keyring:memoryKeyring().port,env:{},keyDir:join(home,'k')}),{mode:'locked',reason:'meta-missing'})
 const other=await tempHome(t)
 assert.deepEqual(await resolveStore(storePaths(other),'keyring',{keyring:undefined,env:{},keyDir:join(await tempHome(t),'k')}),{mode:'locked',reason:'store-unavailable'})
})

test('显式密钥文件（容器 0440 十六进制）→ file 档；其他人可读 → 锁定',async t=>{
 const home=await tempHome(t),dir=await tempHome(t),file=join(dir,'key')
 await writeFile(file,Buffer.alloc(32,7).toString('hex'),{mode:0o440})
 const ok=await resolveStore(storePaths(home),'auto',{keyring:undefined,env:{TELOA_CREDENTIALS_KEY_FILE:file},keyDir:join(dir,'k')})
 assert.equal(ok.mode,'encrypted')
 const home2=await tempHome(t),loose=join(dir,'loose')
 await writeFile(loose,Buffer.alloc(32,7).toString('hex'),{mode:0o644})
 assert.deepEqual(await resolveStore(storePaths(home2),'auto',{keyring:undefined,env:{TELOA_CREDENTIALS_KEY_FILE:loose},keyDir:join(dir,'k2')}),{mode:'locked',reason:'key-unavailable'})
 // 组可写即可被替换密钥：外部密钥文件掩码 0o027，组写与其他人任何权限都拒绝
 for(const mode of [0o460,0o660,0o441,0o442]){
  const home3=await tempHome(t),file3=join(dir,`mode-${mode.toString(8)}`)
  await writeFile(file3,Buffer.alloc(32,7).toString('hex'));await chmod(file3,mode) // chmod 不受 umask 影响
  assert.deepEqual(await resolveStore(storePaths(home3),'auto',{keyring:undefined,env:{TELOA_CREDENTIALS_KEY_FILE:file3},keyDir:join(dir,'k3')}),{mode:'locked',reason:'key-unavailable'},mode.toString(8))
 }
})

test('并发首次初始化：只生成一份 meta 与一个钥匙串账户，两方 installId 一致',async t=>{
 const home=await tempHome(t),paths=storePaths(home),{port,items}=memoryKeyring(),keyDir=join(await tempHome(t),'k')
 const [a,b]=await Promise.all([resolveStore(paths,'auto',{keyring:port,env:{},keyDir}),resolveStore(paths,'auto',{keyring:port,env:{},keyDir})])
 assert.equal(a.mode,'encrypted');assert.equal(b.mode,'encrypted')
 if(a.mode!=='encrypted'||b.mode!=='encrypted')return
 assert.equal(a.meta.installId,b.meta.installId);assert.ok(a.key.equals(b.key));assert.equal(items.size,1)
})

test('读取已有密钥用放宽的超时：钥匙串 3.5 s 才返回仍能解锁',async t=>{
 const home=await tempHome(t),paths=storePaths(home),items=new Map<string,string>(),keyDir=join(await tempHome(t),'k')
 assert.equal((await resolveStore(paths,'auto',{keyring:memoryKeyring({items}).port,env:{},keyDir})).mode,'encrypted')
 assert.equal((await resolveStore(paths,'auto',{keyring:memoryKeyring({items,getDelayMs:3_500}).port,env:{},keyDir})).mode,'encrypted')
})

test('测试开关：TELOA_CREDENTIALS_KEYRING=off 视为无钥匙串；TELOA_CREDENTIALS_KEY_DIR 覆盖默认密钥目录',async()=>{
 const acceptance={TELOA_BROWSER_ACCEPTANCE:'1'}
 assert.equal(await loadNativeKeyring({...acceptance,TELOA_CREDENTIALS_KEYRING:'off'}),undefined)
 assert.equal(defaultKeyDir({...acceptance,TELOA_CREDENTIALS_KEY_DIR:'/tmp/teloa-k'},'darwin','/home/u'),'/tmp/teloa-k')
 assert.equal(defaultKeyDir({...acceptance,TELOA_CREDENTIALS_KEY_DIR:'relative'},'linux','/home/u'),'/home/u/.config/teloa/credential-keys')
})

test('测试开关只在 TELOA_BROWSER_ACCEPTANCE=1 时生效，正式环境设置了也不降档',async t=>{
 if(await import('@napi-rs/keyring').then(()=>false,()=>true))t.diagnostic('本平台无原生钥匙串绑定，跳过 loadNativeKeyring 反向断言')
 else assert.notEqual(await loadNativeKeyring({TELOA_CREDENTIALS_KEYRING:'off'}),undefined)
 assert.equal(defaultKeyDir({TELOA_CREDENTIALS_KEY_DIR:'/tmp/teloa-k'},'darwin','/home/u'),'/home/u/Library/Application Support/Teloa/credential-keys')
})

test('.enc 损坏 → 锁定 document-corrupt，文件原样保留不重建',async t=>{
 const home=await tempHome(t),paths=storePaths(home),keyDir=join(await tempHome(t),'k')
 assert.equal((await resolveStore(paths,'auto',{keyring:memoryKeyring().port,env:{},keyDir})).mode,'encrypted')
 await writeFile(paths.encrypted,'{"format":"teloa.credentials/v1","fileId":"trunc',{mode:0o600})
 assert.deepEqual(await resolveStore(paths,'auto',{keyring:memoryKeyring().port,env:{},keyDir}),{mode:'locked',reason:'document-corrupt'})
 assert.equal(await readFile(paths.encrypted,'utf8'),'{"format":"teloa.credentials/v1","fileId":"trunc')
})

test('轮换中途崩溃：meta 已指向新密钥、.enc 仍是旧 keyId → 按信封头找回旧密钥（file 与 keyring 两档）',async t=>{
 const home=await tempHome(t),paths=storePaths(home),keyDir=join(await tempHome(t),'k')
 const first=await resolveStore(paths,'auto',{keyring:undefined,env:{},keyDir})
 assert.equal(first.mode,'encrypted')
 if(first.mode!=='encrypted')return
 const fileId='00000000-0000-4000-8000-000000000001'
 await writeFile(paths.encrypted,seal(first.key,fileId,'{}'),{mode:0o600})
 const next=Buffer.alloc(32,9),nextFile=join(keyDir,`${first.meta.installId}.${keyIdOf(next)}.key`)
 await writeFile(nextFile,next.toString('hex'),{mode:0o600})
 await writeFile(paths.meta,JSON.stringify({...first.meta,keyId:keyIdOf(next),keyFile:nextFile}),{mode:0o600})
 const again=await resolveStore(paths,'auto',{keyring:undefined,env:{},keyDir})
 assert.equal(again.mode,'encrypted')
 if(again.mode!=='encrypted')return
 assert.ok(again.key.equals(first.key));assert.equal(again.meta.keyId,first.meta.keyId)

 const home2=await tempHome(t),paths2=storePaths(home2),{port,items}=memoryKeyring()
 const k1=await resolveStore(paths2,'auto',{keyring:port,env:{},keyDir})
 assert.equal(k1.mode,'encrypted')
 if(k1.mode!=='encrypted')return
 await writeFile(paths2.encrypted,seal(k1.key,fileId,'{}'),{mode:0o600})
 items.set(`${k1.meta.installId}:${keyIdOf(next)}`,next.toString('base64'))
 await writeFile(paths2.meta,JSON.stringify({...k1.meta,keyId:keyIdOf(next)}),{mode:0o600})
 const k2=await resolveStore(paths2,'auto',{keyring:port,env:{},keyDir})
 assert.equal(k2.mode,'encrypted')
 if(k2.mode!=='encrypted')return
 assert.ok(k2.key.equals(k1.key))
})

test('DSH_HOME 尚不存在 → 创建后完成首次初始化，不抛出',async t=>{
 const root=await tempHome(t),home=join(root,'nested','dsh')
 const state=await resolveStore(storePaths(home),'auto',{keyring:memoryKeyring().port,env:{},keyDir:join(root,'k')})
 assert.equal(state.mode,'encrypted')
 assert.equal((await stat(home)).mode&0o777,0o700)
})

test('并发升级：明文档两方同时升级 → 都拿到加密档、同一主密钥、只生成一个钥匙串账户',async t=>{
 const home=await tempHome(t),paths=storePaths(home),keyDir=join(home,'keys')
 assert.equal((await resolveStore(paths,'auto',{keyring:undefined,env:{},keyDir})).mode,'plaintext')
 const {port,items}=memoryKeyring()
 const [a,b]=await Promise.all([resolveStore(paths,'auto',{keyring:port,env:{},keyDir}),resolveStore(paths,'auto',{keyring:port,env:{},keyDir})])
 assert.equal(a.mode,'encrypted');assert.equal(b.mode,'encrypted')
 if(a.mode!=='encrypted'||b.mode!=='encrypted')return
 assert.ok(a.key.equals(b.key));assert.equal(items.size,1)
})

test('显式档位 keyring/file：明文档升级失败 → 锁定 store-unavailable，只有 auto 可维持明文',async t=>{
 const home=await tempHome(t),paths=storePaths(home),keyDir=join(home,'keys')
 assert.equal((await resolveStore(paths,'auto',{keyring:undefined,env:{},keyDir})).mode,'plaintext')
 assert.deepEqual(await resolveStore(paths,'keyring',{keyring:undefined,env:{},keyDir}),{mode:'locked',reason:'store-unavailable'})
 assert.deepEqual(await resolveStore(paths,'file',{keyring:memoryKeyring().port,env:{},keyDir}),{mode:'locked',reason:'store-unavailable'})
 assert.equal((await resolveStore(paths,'auto',{keyring:undefined,env:{},keyDir})).mode,'plaintext')
 assert.equal(JSON.parse(await readFile(paths.meta,'utf8')).tier,'plaintext')
})

test('preference=file 首次初始化跳过钥匙串走密钥文件；密钥目录在 DSH_HOME 内 → store-unavailable',async t=>{
 const home=await tempHome(t),{port,items}=memoryKeyring()
 const state=await resolveStore(storePaths(home),'file',{keyring:port,env:{},keyDir:join(await tempHome(t),'k')})
 assert.equal(state.mode,'encrypted');assert.equal(items.size,0)
 if(state.mode==='encrypted')assert.equal(state.meta.tier,'file')
 const home2=await tempHome(t)
 assert.deepEqual(await resolveStore(storePaths(home2),'file',{keyring:port,env:{},keyDir:join(home2,'k')}),{mode:'locked',reason:'store-unavailable'})
})

test('meta 损坏 → meta-invalid；明文档旁出现 .enc → meta-invalid',async t=>{
 const home=await tempHome(t),paths=storePaths(home)
 await writeFile(paths.meta,'{"schema":"teloa.credentials-meta/v1"',{mode:0o600})
 assert.deepEqual(await resolveStore(paths,'auto',{keyring:memoryKeyring().port,env:{},keyDir:join(home,'k')}),{mode:'locked',reason:'meta-invalid'})
 const home2=await tempHome(t),paths2=storePaths(home2)
 await resolveStore(paths2,'auto',{keyring:undefined,env:{},keyDir:join(home2,'k')})
 await writeFile(paths2.encrypted,seal(Buffer.alloc(32,1),'00000000-0000-4000-8000-000000000000','{}'),{mode:0o600})
 assert.deepEqual(await resolveStore(paths2,'auto',{keyring:memoryKeyring().port,env:{},keyDir:join(home2,'k')}),{mode:'locked',reason:'meta-invalid'})
})

test('孤儿锁：持锁进程已退出 → 接管，首次初始化与明文升级都不等满超时',async t=>{
 const dead=spawnSync(process.execPath,['-e','process.stdout.write(String(process.pid))']).stdout.toString()
 const home=await tempHome(t),paths=storePaths(home),keyDir=join(await tempHome(t),'k')
 await writeFile(`${paths.meta}.lock`,`${dead}\n`)
 const started=Date.now()
 assert.equal((await resolveStore(paths,'auto',{keyring:memoryKeyring().port,env:{},keyDir})).mode,'encrypted')
 const home2=await tempHome(t),paths2=storePaths(home2)
 await resolveStore(paths2,'auto',{keyring:undefined,env:{},keyDir:join(home2,'k')})
 await writeFile(`${paths2.meta}.lock`,`${dead}\n`)
 assert.equal((await resolveStore(paths2,'auto',{keyring:memoryKeyring().port,env:{},keyDir})).mode,'encrypted')
 assert.ok(Date.now()-started<5_000)
})

test('锁超龄视为孤儿（覆盖 PID 复用）；活锁等待超时：明文档维持明文、首次初始化锁定而不抛出',async t=>{
 const saved={...lockWait}
 t.after(()=>Object.assign(lockWait,saved))
 Object.assign(lockWait,{waitMs:200,upgradeWaitMs:200})
 const home=await tempHome(t),paths=storePaths(home),keyDir=join(await tempHome(t),'k'),lock=`${paths.meta}.lock`
 await writeFile(lock,'1\n')
 const old=new Date(Date.now()-3_600_000)
 await utimes(lock,old,old)
 assert.equal((await resolveStore(paths,'auto',{keyring:memoryKeyring().port,env:{},keyDir})).mode,'encrypted')
 const home2=await tempHome(t),paths2=storePaths(home2)
 await writeFile(`${paths2.meta}.lock`,'1\n')
 assert.deepEqual(await resolveStore(paths2,'auto',{keyring:memoryKeyring().port,env:{},keyDir}),{mode:'locked',reason:'store-unavailable'})
 const home3=await tempHome(t),paths3=storePaths(home3)
 await resolveStore(paths3,'auto',{keyring:undefined,env:{},keyDir:join(home3,'k')})
 await writeFile(`${paths3.meta}.lock`,'1\n')
 assert.equal((await resolveStore(paths3,'auto',{keyring:memoryKeyring().port,env:{},keyDir})).mode,'plaintext')
})

test('XDG_CONFIG_HOME / APPDATA 为相对路径时忽略',()=>{
 assert.equal(defaultKeyDir({XDG_CONFIG_HOME:'rel'},'linux','/home/u'),'/home/u/.config/teloa/credential-keys')
 assert.equal(defaultKeyDir({XDG_CONFIG_HOME:'/x'},'linux','/home/u'),'/x/teloa/credential-keys')
 assert.equal(defaultKeyDir({APPDATA:'rel'},'win32','/home/u'),join('/home/u','AppData','Roaming','Teloa','credential-keys'))
})

test('密钥目录经符号链接落在 DSH_HOME 内 → 视同在内，首次初始化回退明文而不生成密钥文件',async t=>{
 const home=await tempHome(t),outside=await tempHome(t),link=join(outside,'link')
 await mkdir(join(home,'keys'))
 await symlink(join(home,'keys'),link)
 assert.equal((await resolveStore(storePaths(home),'auto',{keyring:undefined,env:{},keyDir:join(link,'sub')})).mode,'plaintext')
})

test('自动生成的密钥文件被放宽为组可读 → 不再接受',async t=>{
 const home=await tempHome(t),paths=storePaths(home),keyDir=join(await tempHome(t),'k')
 const first=await resolveStore(paths,'auto',{keyring:undefined,env:{},keyDir})
 assert.equal(first.mode,'encrypted')
 if(first.mode!=='encrypted')return
 await chmod(first.meta.keyFile!,0o640)
 assert.deepEqual(await resolveStore(paths,'auto',{keyring:undefined,env:{},keyDir}),{mode:'locked',reason:'key-unavailable'})
})

test('多进程并发接管孤儿锁（8 进程 × 首次初始化/明文升级）：不同时持锁，所有进程与磁盘 meta 一致',{timeout:120_000},async t=>{
 const child=fileURLToPath(new URL('./fixtures/credentials-race-child.ts',import.meta.url))
 const dead=spawnSync(process.execPath,['-e','0']).pid
 for(const scenario of ['first-init','upgrade','first-init','upgrade']){
  const home=await tempHome(t),shared=await tempHome(t),paths=storePaths(home)
  if(scenario==='upgrade')assert.equal((await resolveStore(paths,'auto',{keyring:undefined,env:{},keyDir:join(home,'k')})).mode,'plaintext')
  await writeFile(`${paths.meta}.lock`,`${dead}\n`)
  const procs=Array.from({length:8},()=>fork(child,[home,shared],{stdio:['ignore','ignore','inherit','ipc']}))
  await Promise.all(procs.map(proc=>new Promise(done=>proc.once('message',done))))
  const results=await Promise.all(procs.map(proc=>new Promise<Record<string,unknown>>(done=>{proc.once('message',done as never);proc.send('go')})))
  const meta=JSON.parse(await readFile(paths.meta,'utf8'))
  for(const result of results)assert.deepEqual(result,{mode:'encrypted',installId:meta.installId,keyId:meta.keyId},scenario)
  const names=await readdir(shared)
  assert.deepEqual(names.filter(name=>name.startsWith('overlap-')),[],`${scenario}：meta 锁被同时持有`)
  assert.equal((await readdir(join(shared,'items'))).length,1,scenario)
  assert.deepEqual((await readdir(home)).filter(name=>name.includes('.lock')),[],scenario)
 }
})

test('接管者崩溃留下的互斥文件超龄 → 改用下一级互斥文件完成接管，结束后不残留',async t=>{
 const home=await tempHome(t),paths=storePaths(home),lock=`${paths.meta}.lock`
 await writeFile(lock,`${spawnSync(process.execPath,['-e','0']).pid}\n`)
 const info=await stat(lock,{bigint:true}),guard=`${lock}.takeover-${info.ino}-${info.mtimeNs}-0`
 await writeFile(guard,'1\n')
 const old=new Date(Date.now()-60_000)
 await utimes(guard,old,old)
 const started=Date.now()
 assert.equal((await resolveStore(paths,'auto',{keyring:memoryKeyring().port,env:{},keyDir:join(await tempHome(t),'k')})).mode,'encrypted')
 assert.ok(Date.now()-started<5_000)
 assert.deepEqual((await readdir(home)).filter(name=>name.includes('.lock')),[])
})

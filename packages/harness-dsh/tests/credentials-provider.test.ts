import test,{type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {chmod,link,lstat,mkdir,readdir,readFile,stat,symlink,writeFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {join} from 'node:path'
import {setTimeout as sleep} from 'node:timers/promises'
import {Context} from '@deepseek-ai/cordis'
import {credentialKey,credentialRef} from '@deepseek-ai/dsh-credentials'
import {parseCredentialsDocument} from '@deepseek-ai/dsh-credentials-local'
import * as clientConnection from '@deepseek-ai/dsh-client-connection'
import {createLaunchEnvironmentSnapshot} from '@deepseek-ai/dsh-launch-environment'
import {parse as parseYaml} from 'yaml'
import TeloaCredentialProvider,{keySourceEnv,type ProviderDeps} from '../src/credentials/provider.ts'
import {isCredentialStoreLocked,lockWait} from '../src/credentials/store-state.ts'
import {isSecretField,secretValuesOf} from '../src/credentials/known-values.ts'
import {memoryKeyring,rand,tempHome} from './fixtures/credentials.ts'

async function mount(t:TestContext,dshHome:string,deps:ProviderDeps):Promise<TeloaCredentialProvider>{
 const ctx=new Context()
 t.after(()=>ctx.fiber.dispose())
 class Mounted extends TeloaCredentialProvider{constructor(c:Context,config:{dshHome?:string}){super(c,config,deps)}}
 await ctx.plugin(Mounted,{dshHome})
 return ctx.credentials as TeloaCredentialProvider
}
const ref=credentialRef('TELOA_TEST_PROVIDER_KEY')
const withEnv=async(values:Record<string,string>,run:()=>Promise<void>)=>{const saved=Object.fromEntries(Object.keys(values).map(key=>[key,process.env[key]]));Object.assign(process.env,values);try{await run()}finally{for(const [key,value] of Object.entries(saved))if(value===undefined)delete process.env[key];else process.env[key]=value}}
const encrypted=async(t:TestContext)=>{const home=await tempHome(t),keyring=memoryKeyring();return {home,keyring,deps:{keyring:keyring.port,env:{},keyDir:join(await tempHome(t),'k')} satisfies ProviderDeps}}

test('C1 空存储未配置且可写',async t=>{const {home,deps}=await encrypted(t),p=await mount(t,home,deps);assert.equal(await p.resolve(ref),undefined);assert.deepEqual(await p.describe(ref),{configured:false,writable:true})})

test('C2/C3/C11 写读删；空值拒收；磁盘无明文',async t=>{
 const {home,deps}=await encrypted(t),p=await mount(t,home,deps),value=rand(32)
 await assert.rejects(p.set(ref,''),/empty/)
 await p.set(ref,value)
 assert.deepEqual(await p.resolve(ref),{value,source:'file'})
 assert.deepEqual(await p.describe(ref),{configured:true,source:'file',writable:true})
 const disk=await readFile(join(home,'.credentials.enc'),'utf8')
 assert.ok(!disk.includes(value));assert.equal((await stat(join(home,'.credentials.enc'))).mode&0o777,0o600)
 await assert.rejects(readFile(join(home,'.credentials.yaml')))
 await p.unset(ref);assert.equal(await p.resolve(ref),undefined)
})

test('C4/C5 进程环境优先且写被拒；REF_FILE 读取文件内容',async t=>{
 const {home,deps}=await encrypted(t),p=await mount(t,home,deps),file=join(home,'value.txt')
 await writeFile(file,'from-file-value\n',{mode:0o600})
 await withEnv({TELOA_TEST_PROVIDER_KEY:'from-env-value'},async()=>{
  assert.deepEqual(await p.resolve(ref),{value:'from-env-value',source:'env'})
  await assert.rejects(p.set(ref,'x'.repeat(12)),/shadowed/)
 })
 await withEnv({TELOA_TEST_PROVIDER_KEY_FILE:file},async()=>{
  assert.deepEqual(await p.resolve(ref),{value:'from-file-value',source:'env-file'})
  assert.equal((await p.describe(ref)).writable,false)
 })
})

test('C7/C8 记录读改写、通知、删除、枚举',async t=>{
 const {home,deps}=await encrypted(t),p=await mount(t,home,deps),key=credentialKey('teloa-test','one'),seen:string[]=[]
 ;(p as unknown as {ctx:Context}).ctx.on('credentials/record-updated',changed=>{seen.push(String(changed))}) // ctx 是 Service 的受保护成员
 assert.equal(await p.modifyRecord(key,async()=>undefined),undefined)
 const saved=await p.modifyRecord(key,async()=>({kind:'grant',payload:{token:'t-'+rand(20)}}))
 assert.equal(saved?.kind,'grant');assert.deepEqual(seen,['teloa-test/one'])
 assert.deepEqual(await p.listRecords(),[{key,kind:'grant'}])
 await p.deleteRecord(key);assert.equal(await p.readRecord(key),undefined)
})

test('C9/C10 外部修改热发布；双实例并发不丢写',async t=>{
 const {home,deps}=await encrypted(t),a=await mount(t,home,deps),b=await mount(t,home,deps),value=rand(24)
 await b.set(ref,value)
 let seen
 for(let i=0;i<15&&!(seen=await a.resolve(ref));i++)await sleep(100) // 规格：1.5 s 内热发布
 assert.equal(seen?.value,value)
 await Promise.all([a,b].flatMap((p,side)=>Array.from({length:20},(_,i)=>p.modifyRecord(credentialKey('teloa-test',`k${side}x${i}`),async()=>({kind:'api-key',key:rand(16)})))))
 const c=await mount(t,home,deps)
 assert.equal((await c.listRecords()).length,40)
})

test('C12 旧明文迁移：值一致、旧文件消失',async t=>{
 const {home,deps}=await encrypted(t),value=rand(28)
 await writeFile(join(home,'.credentials.yaml'),`version: 1\nrefs:\n  TELOA_TEST_PROVIDER_KEY: ${value}\n`,{mode:0o600})
 const p=await mount(t,home,deps)
 assert.deepEqual(await p.resolve(ref),{value,source:'file'})
 await assert.rejects(stat(join(home,'.credentials.yaml')))
 assert.ok(!(await readFile(join(home,'.credentials.enc'),'utf8')).includes(value))
})

test('C13 GCM 篡改：只读、写被拒、不覆盖',async t=>{
 const {home,deps}=await encrypted(t),p=await mount(t,home,deps),value=rand(20)
 await p.set(ref,value)
 const path=join(home,'.credentials.enc'),row=JSON.parse(await readFile(path,'utf8'))
 row.ciphertext=Buffer.from('tampered').toString('base64');const tampered=JSON.stringify(row)
 await writeFile(path,tampered)
 await assert.rejects(p.set(credentialRef('OTHER_KEY'),rand(20)))
 assert.equal(await readFile(path,'utf8'),tampered)
 assert.deepEqual(p.status(),{tier:'keyring',fault:'document-corrupt'})
 assert.deepEqual(await p.resolve(ref),{value,source:'file'}) // 仍从最后一次读好的快照只读服务
})

test('C14 取不到钥匙 → 锁定 key-unavailable，写被拒，读记录抛锁定错误而不是返回空',async t=>{
 const {home,deps}=await encrypted(t),first=await mount(t,home,deps)
 await first.set(ref,rand(20))
 const second=await mount(t,home,{...deps,keyring:memoryKeyring().port})
 assert.equal(await second.resolve(ref),undefined)
 assert.deepEqual(second.status(),{tier:null,fault:'key-unavailable'})
 await assert.rejects(second.set(ref,rand(20)),/key-unavailable/)
 await assert.rejects(second.readRecord(credentialKey('teloa-test','one')),isCredentialStoreLocked)
 await assert.rejects(second.listRecords(),isCredentialStoreLocked)
})

test('C16 激活出错转锁定 store-unavailable，插件照常激活',async t=>{
 if(process.getuid?.()===0)return t.skip('root 不受目录权限限制')
 const {home,deps}=await encrypted(t)
 await chmod(home,0o500);t.after(()=>chmod(home,0o700).catch(()=>{})) // 清理钩子先登记、先执行：空目录已被删除时忽略
 const p=await mount(t,home,deps)
 assert.ok(p);assert.deepEqual(p.status(),{tier:null,fault:'store-unavailable'})
 await assert.rejects(p.set(ref,rand(20)),/store-unavailable/)
 await assert.rejects(p.readRecord(credentialKey('teloa-test','one')),isCredentialStoreLocked)
})

test('C17 启动时 .enc 已损坏 → 锁定 document-corrupt，文件原样不动',async t=>{
 const {home,deps}=await encrypted(t),first=await mount(t,home,deps)
 await first.set(ref,rand(20))
 const path=join(home,'.credentials.enc');await writeFile(path,'not an envelope')
 const second=await mount(t,home,deps)
 assert.deepEqual(second.status(),{tier:null,fault:'document-corrupt'})
 await assert.rejects(second.set(ref,rand(20)))
 assert.equal(await readFile(path,'utf8'),'not an envelope')
})

test('C18 运行标记：激活写入本进程 pid，停用删除',async t=>{
 const {home,deps}=await encrypted(t),ctx=new Context()
 class Mounted extends TeloaCredentialProvider{constructor(c:Context,config:{dshHome?:string}){super(c,config,deps)}}
 const fiber=ctx.plugin(Mounted,{dshHome:home});await fiber
 assert.equal((await readFile(join(home,'.credentials.host.pid'),'utf8')).trim(),String(process.pid))
 await fiber.dispose()
 await assert.rejects(stat(join(home,'.credentials.host.pid')))
})

test('known-values：字段名分段匹配，publicKey/keyboard 不收，短于 8 不收',()=>{
 for(const field of ['access_token','refreshToken','client-secret','apiKey','password'])assert.equal(isSecretField(field),true,field)
 for(const field of ['publicKey','public_key','keyboard','monkey','tokenizer_name'])assert.equal(isSecretField(field),false,field)
 const long=rand(12)
 assert.deepEqual(secretValuesOf('teloa-x/a',{kind:'grant',payload:{publicKey:rand(40),nested:{access_token:long,token:'short7x'}}}),[long])
})

test('C15 明文档：0600、官方解析器可读回',async t=>{
 const home=await tempHome(t),p=await mount(t,home,{keyring:undefined,env:{},keyDir:join(home,'k')}),value=rand(20)
 await p.set(ref,value)
 const text=await readFile(join(home,'.credentials.yaml'),'utf8')
 assert.equal(parseCredentialsDocument(text,'x').refs.get('TELOA_TEST_PROVIDER_KEY'),value)
 assert.equal((await stat(join(home,'.credentials.yaml'))).mode&0o777,0o600)
 assert.deepEqual(p.status(),{tier:'plaintext',fault:null})
})

/** DSH 首启时 client-connection 经 ctx.credentials 自动写入的浏览器会话签名记录（官方明文插件渲染，161 B）。 */
const firstStartDocument=(secret:string)=>`version: 1\nrecords:\n  client-connection/browser-session:\n    kind: grant\n    payload:\n      version: 1\n      secret: ${secret}\n`

test('C12b DSH 首启自动生成的 .credentials.yaml 迁入加密存储：记录保留，原文件先零覆写再删除',async t=>{
 const {home,deps}=await encrypted(t),secret=rand(43),legacy=join(home,'.credentials.yaml'),probe=join(home,'probe')
 await writeFile(legacy,firstStartDocument(secret),{mode:0o600})
 assert.equal((await stat(legacy)).size,161)
 await link(legacy,probe) // 硬链接与旧文件同一 inode：删除后仍能看到零覆写的结果
 const p=await mount(t,home,deps),key=credentialKey('client-connection','browser-session')
 assert.deepEqual(await p.readRecord(key),{kind:'grant',payload:{version:1,secret}})
 assert.deepEqual(await p.listRecords(),[{key,kind:'grant'}])
 await assert.rejects(stat(legacy))
 const zeroed=await readFile(probe)
 assert.equal(zeroed.length,161);assert.ok(zeroed.every(byte=>byte===0))
 assert.ok(!(await readFile(join(home,'.credentials.enc'),'utf8')).includes(secret))
 assert.deepEqual(p.secretValues(),[secret])
})

test('副本清单：加密档读好后 DSH_HOME 的 .credentials.yaml 不再是在用文件；明文档与锁定时仍在用',async t=>{
 const {home,deps}=await encrypted(t),legacy=join(home,'.credentials.yaml')
 await writeFile(legacy,firstStartDocument(rand(43)),{mode:0o600})
 const migrated=await mount(t,home,deps)
 assert.equal(migrated.livePlaintextPath(),undefined)
 const locked=await mount(t,home,{...deps,keyring:memoryKeyring().port})
 assert.equal(locked.livePlaintextPath(),legacy)
 const plainHome=await tempHome(t),plain=await mount(t,plainHome,{keyring:undefined,env:{},keyDir:join(plainHome,'k')})
 assert.deepEqual(plain.status(),{tier:'plaintext',fault:null})
 assert.equal(plain.livePlaintextPath(),join(plainHome,'.credentials.yaml'))
})

test('C16 旧明文无法解析：迁移失败转锁定，旧文件原样保留',async t=>{
 const {home,deps}=await encrypted(t),legacy=join(home,'.credentials.yaml'),text='version: 2\nrefs: {}\n'
 await writeFile(legacy,text,{mode:0o600})
 const p=await mount(t,home,deps)
 assert.deepEqual(p.status(),{tier:'keyring',fault:'store-unavailable'})
 assert.equal(await readFile(legacy,'utf8'),text)
 assert.equal(p.livePlaintextPath(),legacy)
 await assert.rejects(p.listRecords(),isCredentialStoreLocked)
})

test('C16 信封 fileId 与 meta installId 不符（同钥匙换入别的存储的密文）→ document-corrupt，不覆盖',async t=>{
 const keyDir=await tempHome(t),keyFile=join(keyDir,'shared.key')
 await writeFile(keyFile,Buffer.alloc(32,9).toString('hex'),{mode:0o600})
 const deps:ProviderDeps={keyring:undefined,env:{TELOA_CREDENTIALS_KEY_FILE:keyFile},keyDir:join(keyDir,'k')}
 const home=await tempHome(t),other=await tempHome(t)
 await (await mount(t,home,deps)).set(ref,rand(20))
 await (await mount(t,other,deps)).set(ref,rand(20))
 const foreign=await readFile(join(other,'.credentials.enc'),'utf8')
 await writeFile(join(home,'.credentials.enc'),foreign)
 const p=await mount(t,home,deps)
 assert.deepEqual(p.status(),{tier:'file',fault:'document-corrupt'})
 assert.equal(await p.resolve(ref),undefined)
 await assert.rejects(p.readRecord(credentialKey('teloa-test','one')),isCredentialStoreLocked)
 await assert.rejects(p.set(ref,rand(20)),/document-corrupt/)
 assert.equal(await readFile(join(home,'.credentials.enc'),'utf8'),foreign)
})

test('C16 激活时等锁超时、meta 路径不可用、取环境抛错 → 锁定 store-unavailable，插件照常激活',async t=>{
 const saved=lockWait.waitMs;lockWait.waitMs=200;t.after(()=>{lockWait.waitMs=saved})
 const busy=await encrypted(t)
 await writeFile(join(busy.home,'.credentials.meta.json.lock'),`${process.pid}\n`) // 持锁者存活且锁未超龄：不会被当作孤儿接管
 const waited=await mount(t,busy.home,busy.deps)
 assert.deepEqual(waited.status(),{tier:null,fault:'store-unavailable'})
 const broken=await encrypted(t)
 await mkdir(join(broken.home,'.credentials.meta.json'))
 assert.deepEqual((await mount(t,broken.home,broken.deps)).status(),{tier:null,fault:'store-unavailable'})
 const throwing=await encrypted(t),env=new Proxy({},{get(){throw new Error('environment unavailable')}})
 const p=await mount(t,throwing.home,{keyring:throwing.deps.keyring,env})
 assert.deepEqual(p.status(),{tier:null,fault:'store-unavailable'})
 await assert.rejects(p.set(ref,rand(20)),/store-unavailable/)
})

test('写锁孤儿（持锁进程已退出）自动接管，写入不被永久阻塞',async t=>{
 const saved=lockWait.waitMs;lockWait.waitMs=500;t.after(()=>{lockWait.waitMs=saved})
 const {home,deps}=await encrypted(t),p=await mount(t,home,deps)
 await p.set(ref,rand(20))
 await writeFile(join(home,'.credentials.enc.lock'),`${spawnSync(process.execPath,['-e','0']).pid}\n`)
 const value=rand(20)
 await p.set(ref,value)
 assert.deepEqual(await p.resolve(ref),{value,source:'file'})
})

const diskState=async(dir:string)=>Object.fromEntries(await Promise.all((await readdir(dir)).sort().map(async name=>[name,(await readFile(join(dir,name))).toString('base64')] as const)))

test('锁定时仅 client-connection 浏览器会话记录走内存覆盖层：真实插件照常激活，磁盘无改动，其它写入仍被拒',async t=>{
 const {home,deps}=await encrypted(t)
 await (await mount(t,home,deps)).set(ref,rand(20))
 const ctx=new Context()
 t.after(()=>ctx.fiber.dispose())
 class Locked extends TeloaCredentialProvider{constructor(c:Context,config:{dshHome?:string}){super(c,config,{...deps,keyring:memoryKeyring().port})}}
 await ctx.plugin(Locked,{dshHome:home})
 const p=ctx.credentials as TeloaCredentialProvider,before=await diskState(home)
 assert.deepEqual(p.status(),{tier:null,fault:'key-unavailable'})
 await ctx.plugin(clientConnection as never,{} as never)
 assert.ok(ctx.get('connection'),'client-connection 应在存储锁定时照常激活')
 const key=credentialKey('client-connection','browser-session'),record=await p.readRecord(key)
 assert.equal(record?.kind,'grant')
 assert.deepEqual(await p.describeRecord(key),{configured:true,kind:'grant',writable:false})
 // 同一进程内再次初始化拿到同一份签名密钥
 assert.deepEqual(await p.modifyRecord(key,async current=>current?undefined:{kind:'grant',payload:{version:1,secret:rand(43)}}),record)
 const secret=(record as {payload:{secret:string}}).payload.secret
 assert.ok(p.secretValues().includes(secret))
 await assert.rejects(p.modifyRecord(credentialKey('teloa-test','one'),async()=>({kind:'api-key',key:rand(16)})),isCredentialStoreLocked)
 await assert.rejects(p.modifyRecord(credentialKey('client-connection','other'),async()=>({kind:'grant',payload:{}})),isCredentialStoreLocked)
 await assert.rejects(p.set(ref,rand(20)),isCredentialStoreLocked)
 await assert.rejects(p.deleteRecord(key),isCredentialStoreLocked)
 await assert.rejects(p.readRecord(credentialKey('teloa-test','one')),isCredentialStoreLocked)
 await assert.rejects(p.listRecords(),isCredentialStoreLocked)
 assert.deepEqual(await diskState(home),before)
 assert.ok(!Object.values(before).some(content=>Buffer.from(content,'base64').toString('utf8').includes(secret)))
 // 停用后覆盖层丢弃：重新挂载仍是锁定且读不到这条记录
 await ctx.fiber.dispose()
 const again=await mount(t,home,{...deps,keyring:memoryKeyring().port})
 await assert.rejects(again.readRecord(key),isCredentialStoreLocked)
})

test('I1 档位与密钥来源只认启动时继承的进程环境：工作区 .env 与 DSH_HOME/.env 注入的 TELOA_CREDENTIALS_* 不生效',async t=>{
 const launch=createLaunchEnvironmentSnapshot([
  {source:'process',values:{TELOA_RUNTIME_ROOT:'/srv/teloa',PATH:'/bin'}},
  {source:'project-env',values:{TELOA_CREDENTIALS_KEY_FILE:'/w/k',TELOA_BROWSER_ACCEPTANCE:'1',TELOA_CREDENTIALS_KEYRING:'off',TELOA_CREDENTIALS_KEY_DIR:'/w/d',CREDENTIALS_DIRECTORY:'/w',APPDATA:'/w/a'}},
  {source:'user-env',values:{TELOA_CREDENTIALS_STORE:'file',XDG_CONFIG_HOME:'/w/x'}},
 ])
 assert.deepEqual(keySourceEnv(launch),{TELOA_RUNTIME_ROOT:'/srv/teloa'})
 // 真实挂载：工作区 .env 指向模型自写的密钥文件，且已被 DSH 合入 process.env；首次初始化不得采用它
 const home=await tempHome(t),workspace=await tempHome(t),planted=join(workspace,'planted.key'),keyDir=join(await tempHome(t),'k')
 await writeFile(planted,Buffer.alloc(32,5).toString('hex'),{mode:0o600})
 await withEnv({TELOA_CREDENTIALS_KEY_FILE:planted},async()=>{
  const ctx=new Context()
  t.after(()=>ctx.fiber.dispose())
  ctx.provide('launchEnvironment',createLaunchEnvironmentSnapshot([{source:'process',values:{}},{source:'project-env',values:{TELOA_CREDENTIALS_KEY_FILE:planted}}]))
  class Mounted extends TeloaCredentialProvider{constructor(c:Context,config:{dshHome?:string}){super(c,config,{keyring:undefined,keyDir})}}
  await ctx.plugin(Mounted,{dshHome:home})
  assert.deepEqual((ctx.credentials as TeloaCredentialProvider).status(),{tier:'file',fault:null})
 })
 const meta=JSON.parse(await readFile(join(home,'.credentials.meta.json'),'utf8'))
 assert.notEqual(meta.keyFile,planted);assert.ok(meta.keyFile.startsWith(keyDir))
 // 组合补丁的档位表达式同样只取进程层
 const patch=parseYaml(await readFile(new URL('../../bundle/cordis.patch.yml',import.meta.url),'utf8'),{customTags:[{tag:'tag:yaml.org,2002:js',resolve:(source:string)=>({__jsExpr:source})}]}) as {insert?:{id:string;config?:{store?:{__jsExpr:string}}}[]}[]
 const expression=patch.flatMap(row=>row.insert??[]).find(row=>row.id==='teloa-credentials')!.config!.store!.__jsExpr
 // 用真实 Loader 的求值函数（`with(ctx) eval(expr)`）；process.env 里即便已有 file 也不采用
 const loaderPath=createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-agent-preset-registry/package.json')).resolve('@deepseek-ai/cordis-plugin-loader')
 const {evaluate}=await import(loaderPath) as {evaluate:(ctx:Context,expr:string)=>unknown}
 const storeFrom=(layers:{source:'process'|'project-env'|'user-env';values:Record<string,string>}[])=>{const c=new Context();c.provide('launchEnvironment',createLaunchEnvironmentSnapshot(layers));return evaluate(c,expression)}
 await withEnv({TELOA_CREDENTIALS_STORE:'file'},async()=>{
  assert.equal(storeFrom([{source:'process',values:{}},{source:'project-env',values:{TELOA_CREDENTIALS_STORE:'file'}}]),'auto')
  assert.equal(storeFrom([{source:'process',values:{TELOA_CREDENTIALS_STORE:'keyring'}}]),'keyring')
  assert.equal(evaluate(new Context(),expression),'auto')
 })
})

test('I2 擦除中断残留（.enc 已在、旧文件为空或全 NUL）→ 直接删除，不锁定、不隔离',async t=>{
 for(const residue of [Buffer.alloc(161),Buffer.alloc(0)]){
  const {home,deps}=await encrypted(t),value=rand(20),legacy=join(home,'.credentials.yaml')
  await (await mount(t,home,deps)).set(ref,value)
  await writeFile(legacy,residue,{mode:0o600})
  const p=await mount(t,home,deps)
  assert.deepEqual(p.status(),{tier:'keyring',fault:null},String(residue.length))
  assert.deepEqual(await p.resolve(ref),{value,source:'file'})
  await assert.rejects(stat(legacy))
  assert.deepEqual(p.quarantinedPlaintextPaths(),[])
 }
})

test('M5 接管后新出现的 .credentials.yaml：内容一致则收尾删除；不一致或无法解析则不导入、不锁定，改名隔离为 0600 并常驻警告',async t=>{
 const {home,deps}=await encrypted(t),value=rand(20),legacy=join(home,'.credentials.yaml')
 await (await mount(t,home,deps)).set(ref,value)
 await writeFile(legacy,`version: 1\nrefs:\n  TELOA_TEST_PROVIDER_KEY: ${value}\n`,{mode:0o600})
 const same=await mount(t,home,deps)
 await assert.rejects(stat(legacy));assert.deepEqual(same.quarantinedPlaintextPaths(),[])
 const injected=`version: 1\nrefs:\n  TELOA_TEST_PROVIDER_KEY: ${rand(24)}\n`
 await writeFile(legacy,injected);await chmod(legacy,0o644)
 const p=await mount(t,home,deps)
 assert.deepEqual(p.status(),{tier:'keyring',fault:null})
 assert.deepEqual(await p.resolve(ref),{value,source:'file'})
 await assert.rejects(stat(legacy))
 const [quarantined]=p.quarantinedPlaintextPaths()
 assert.match(quarantined!,/\/\.credentials\.yaml\.quarantine-[^/]+$/)
 assert.equal(await readFile(quarantined!,'utf8'),injected)
 assert.equal((await stat(quarantined!)).mode&0o777,0o600)
 assert.ok(p.protectedPaths().includes(quarantined!))
 await writeFile(legacy,'version: 2\n',{mode:0o600})
 const again=await mount(t,home,deps)
 assert.deepEqual(again.status(),{tier:'keyring',fault:null})
 const listed=again.quarantinedPlaintextPaths()
 assert.equal(listed.length,2);assert.ok(listed.includes(quarantined!)) // 常驻：重启后仍列出，直到本人确认删除
})

test('M4 .credentials.yaml 是符号链接：不跟随、不覆写目标；已有 .enc 时隔离链接本身，首次初始化时锁定',async t=>{
 const outside=await tempHome(t),target=join(outside,'precious.txt')
 await writeFile(target,'precious\n',{mode:0o600})
 const {home,deps}=await encrypted(t)
 await (await mount(t,home,deps)).set(ref,rand(20))
 await symlink(target,join(home,'.credentials.yaml'))
 const p=await mount(t,home,deps)
 assert.deepEqual(p.status(),{tier:'keyring',fault:null})
 const [quarantined]=p.quarantinedPlaintextPaths()
 assert.ok((await lstat(quarantined!)).isSymbolicLink())
 assert.equal(await readFile(target,'utf8'),'precious\n')
 const fresh=await encrypted(t)
 await symlink(target,join(fresh.home,'.credentials.yaml'))
 const first=await mount(t,fresh.home,fresh.deps)
 assert.deepEqual(first.status(),{tier:'keyring',fault:'store-unavailable'})
 assert.ok((await lstat(join(fresh.home,'.credentials.yaml'))).isSymbolicLink())
 assert.equal(await readFile(target,'utf8'),'precious\n')
})

test('M3 运行标记不跟随符号链接；停用时只删本进程写的标记',async t=>{
 const outside=await tempHome(t),target=join(outside,'victim.txt')
 await writeFile(target,'victim\n',{mode:0o600})
 const {home,deps}=await encrypted(t),marker=join(home,'.credentials.host.pid')
 await symlink(target,marker)
 await mount(t,home,deps)
 assert.equal(await readFile(target,'utf8'),'victim\n')
 const other=await encrypted(t),ctx=new Context(),otherMarker=join(other.home,'.credentials.host.pid')
 class Mounted extends TeloaCredentialProvider{constructor(c:Context,config:{dshHome?:string}){super(c,config,other.deps)}}
 const fiber=ctx.plugin(Mounted,{dshHome:other.home});await fiber
 await writeFile(otherMarker,'999999\n') // 同一 DSH_HOME 上后起的另一宿主改写了标记
 await fiber.dispose()
 assert.equal(await readFile(otherMarker,'utf8'),'999999\n')
})

test('M8 设置了 REF_FILE 但读不到：describe 与 set 口径一致，均为不可写',async t=>{
 const {home,deps}=await encrypted(t),p=await mount(t,home,deps),value=rand(20)
 await p.set(ref,value)
 await withEnv({TELOA_TEST_PROVIDER_KEY_FILE:join(home,'missing.txt')},async()=>{
  assert.deepEqual(await p.describe(ref),{configured:true,source:'file',writable:false})
  await assert.rejects(p.set(ref,rand(20)),/shadowed/)
 })
})

test('启动清理 .credentials.yaml.<hex>.tmp 明文残留：普通文件擦除删除，符号链接只删链接不跟随，硬链接拒绝',async t=>{
 const {home,deps}=await encrypted(t),outside=await tempHome(t),value=rand(30)
 await writeFile(join(home,'.credentials.yaml.0123456789ab.tmp'),JSON.stringify({version:1,refs:{DEEPSEEK_API_KEY:value},records:{}}),{mode:0o600})
 const target=join(outside,'target.txt');await writeFile(target,value)
 await symlink(target,join(home,'.credentials.yaml.aaaaaaaaaaaa.tmp'))
 const shared=join(outside,'shared.txt');await writeFile(shared,value);await link(shared,join(home,'.credentials.yaml.bbbbbbbbbbbb.tmp'))
 await mount(t,home,deps)
 const names=await readdir(home)
 assert.ok(!names.includes('.credentials.yaml.0123456789ab.tmp'));assert.ok(!names.includes('.credentials.yaml.aaaaaaaaaaaa.tmp'))
 assert.equal(await readFile(target,'utf8'),value)
 assert.ok(names.includes('.credentials.yaml.bbbbbbbbbbbb.tmp'));assert.equal(await readFile(shared,'utf8'),value)
 assert.ok(!names.some(name=>name.endsWith('.lock')))
})

test('N1 已有 .enc 时打不开的旧明文（0000 权限）：按 M5 隔离为 0600，不锁定',async t=>{
 const {home,deps}=await encrypted(t),value=rand(20),legacy=join(home,'.credentials.yaml'),injected=`version: 1\nrefs:\n  TELOA_TEST_PROVIDER_KEY: ${rand(24)}\n`
 await (await mount(t,home,deps)).set(ref,value)
 await writeFile(legacy,injected,{mode:0o600});await chmod(legacy,0o000)
 const p=await mount(t,home,deps)
 assert.deepEqual(p.status(),{tier:'keyring',fault:null})
 assert.deepEqual(await p.resolve(ref),{value,source:'file'})
 await assert.rejects(lstat(legacy))
 const [quarantined]=p.quarantinedPlaintextPaths()
 assert.equal((await stat(quarantined!)).mode&0o777,0o600)
 assert.equal(await readFile(quarantined!,'utf8'),injected)
 // 首次初始化（没有 .enc）时打不开的旧明文仍是唯一数据：锁定，原样保留
 const fresh=await encrypted(t),only=join(fresh.home,'.credentials.yaml')
 await writeFile(only,injected,{mode:0o600});await chmod(only,0o000)
 t.after(()=>chmod(only,0o600).catch(()=>{}))
 const first=await mount(t,fresh.home,fresh.deps)
 assert.deepEqual(first.status(),{tier:'keyring',fault:'store-unavailable'})
 assert.equal((await lstat(only)).mode&0o777,0o000)
})

test('N2 运行标记与隔离都拒绝硬链接：不截断、不改名、不改外部文件内容与权限，也不锁定',async t=>{
 const outside=await tempHome(t),victim=join(outside,'victim.txt')
 await writeFile(victim,'victim\n',{mode:0o644})
 const {home,deps}=await encrypted(t),marker=join(home,'.credentials.host.pid')
 await link(victim,marker)
 await mount(t,home,deps)
 assert.equal(await readFile(victim,'utf8'),'victim\n')
 const shared=join(outside,'shared.yaml'),injected=`version: 1\nrefs:\n  TELOA_TEST_PROVIDER_KEY: ${rand(24)}\n`
 await writeFile(shared,injected);await chmod(shared,0o644)
 const other=await encrypted(t),legacy=join(other.home,'.credentials.yaml'),value=rand(20)
 await (await mount(t,other.home,other.deps)).set(ref,value)
 await link(shared,legacy)
 const p=await mount(t,other.home,other.deps)
 assert.deepEqual(p.status(),{tier:'keyring',fault:null})
 assert.deepEqual(await p.resolve(ref),{value,source:'file'})
 assert.deepEqual(p.quarantinedPlaintextPaths(),[])
 assert.equal((await lstat(legacy)).nlink,2) // 原位保留：加密档已读好，它作为历史明文副本进清单，由本人处理
 assert.equal(await readFile(shared,'utf8'),injected);assert.equal((await stat(shared)).mode&0o777,0o644)
 assert.equal(p.livePlaintextPath(),undefined)
})

test('N3 擦除中断留下的明文尾巴（前段已零覆写）：不导入、不锁定，隔离后进历史副本清单',async t=>{
 const {home,deps}=await encrypted(t),value=rand(20),legacy=join(home,'.credentials.yaml'),tail=`  TELOA_TEST_PROVIDER_KEY: ${rand(24)}\n`
 await (await mount(t,home,deps)).set(ref,value)
 await writeFile(legacy,Buffer.concat([Buffer.alloc(24),Buffer.from(tail)]),{mode:0o600})
 const p=await mount(t,home,deps)
 assert.deepEqual(p.status(),{tier:'keyring',fault:null})
 assert.deepEqual(await p.resolve(ref),{value,source:'file'})
 const [quarantined]=p.quarantinedPlaintextPaths()
 assert.ok((await readFile(quarantined!,'utf8')).endsWith(tail))
})

test('secretValuesOf：api-key 记录的 TELOA_BINDING_SHA256 槽不算已存值',()=>{
 const env={XAI_API_KEY:'xai-'+'0123456789abcdefghij',TELOA_BINDING_SHA256:'a'.repeat(64)}
 assert.deepEqual(secretValuesOf('teloa-skill/x-search',{kind:'api-key',env}),[env.XAI_API_KEY])
 // 排除只限技能密钥记录且取值形如 sha256：其他记录或非指纹取值仍按已存值保护。
 assert.deepEqual(secretValuesOf('teloa-model/x',{kind:'api-key',env}),[env.XAI_API_KEY,env.TELOA_BINDING_SHA256])
 const odd={...env,TELOA_BINDING_SHA256:'not-a-fingerprint-'+'Z'.repeat(20)}
 assert.deepEqual(secretValuesOf('teloa-skill/x-search',{kind:'api-key',env:odd}),[odd.XAI_API_KEY,odd.TELOA_BINDING_SHA256])
 // 共享密钥组记录（teloa-skill-group/*）的组指纹槽同样不算已存值，否则组指纹会被全局脱敏遮住、密钥页读不回指纹
 assert.deepEqual(secretValuesOf('teloa-skill-group/shared-demo',{kind:'api-key',env}),[env.XAI_API_KEY])
 assert.deepEqual(secretValuesOf('teloa-skill-group/shared-demo',{kind:'api-key',env:odd}),[odd.XAI_API_KEY,odd.TELOA_BINDING_SHA256])
})

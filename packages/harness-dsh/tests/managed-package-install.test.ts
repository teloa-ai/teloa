import test from 'node:test'
import assert from 'node:assert/strict'
import type {TestContext} from 'node:test'
import {chmod,mkdir,mkdtemp,readFile,readdir,realpath,rm,stat,utimes,writeFile} from 'node:fs/promises'
import {existsSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname,join} from 'node:path'
import {assertAllowedManagedPackage,installLockedPackage,managedInstallTimeoutMs,installManagedPackage,managedPackageInstalled,readManagedPackageLock,sweepManagedPackageStaging,managedPackageAllowlist,managedPackageDir,managedPackageLock,type ManagedPackageRecipe} from '../src/managed-package-install.ts'

const good='sha512-'+'A'.repeat(86)+'=='
const bad='sha512-'+'B'.repeat(86)+'=='
const good2='sha512-'+'C'.repeat(86)+'=='
const envWhitelist=new Set(['PATH','HOME','USERPROFILE','APPDATA','LOCALAPPDATA','TMPDIR','TMP','TEMP','NPM_CONFIG_CACHE','NPM_CONFIG_PREFIX','NPM_CONFIG_GLOBALCONFIG','HTTP_PROXY','HTTPS_PROXY','NO_PROXY','http_proxy','https_proxy','no_proxy','NODE_EXTRA_CA_CERTS','CAFILE'])

async function tempRoot(t:TestContext):Promise<string>{
 const dir=await mkdtemp(join(tmpdir(),'teloa-managed-install-'))
 t.after(()=>rm(dir,{recursive:true,force:true}))
 return dir
}

type NpmRun={args:string[];envKeys:string[];cwd:string;start:number;end:number;lock:unknown;manifest:unknown}
type Lock={name:string;version:string;lockfileVersion:number;requires:boolean;packages:Record<string,Record<string,unknown>>}

/** 测试用随附 lock：顶层包 + 一个传递依赖。 */
const lockFor=(name='@scope/pkg'):Lock=>({name:'teloa-managed-install',version:'1.0.0',lockfileVersion:3,requires:true,packages:{
 '':{name:'teloa-managed-install',version:'1.0.0',dependencies:{[name]:'1.0.0'}},
 [`node_modules/${name}`]:{version:'1.0.0',resolved:`https://registry.npmjs.org/${name}/-/pkg-1.0.0.tgz`,integrity:good,dependencies:{dep:'^2.0.0'}},
 'node_modules/dep':{version:'2.1.0',resolved:'https://registry.npmjs.org/dep/-/dep-2.1.0.tgz',integrity:good2},
}})

/**
 * 假 npm ci：读 cwd 的 package-lock.json 与 package.json，按 lock 写 node_modules 与 .package-lock.json；
 * 旁路 tamper.json 可改写/增删已装条目，fail.txt 存在时写半成品后以非零退出；逐行记录 argv、环境键、cwd、起止时间与所见 lock/manifest。
 */
async function fakeNpm(root:string,delayMs=0){
 const path=join(root,'fake-npm.mjs')
 const log=join(root,'npm-log.jsonl')
 const tamperFile=join(root,'tamper.json')
 const failFile=join(root,'fail.txt')
 await writeFile(path,[
  '#!/usr/bin/env node',
  "import {appendFileSync,existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs'",
  "import {dirname,join} from 'node:path'",
  'const args=process.argv.slice(2)',
  'const start=Date.now()',
  `await new Promise(resolve=>setTimeout(resolve,${delayMs}))`,
  "const lock=JSON.parse(readFileSync(join(process.cwd(),'package-lock.json'),'utf8'))",
  "const manifest=JSON.parse(readFileSync(join(process.cwd(),'package.json'),'utf8'))",
  `appendFileSync(${JSON.stringify(log)},JSON.stringify({args,envKeys:Object.keys(process.env),cwd:process.cwd(),start,end:Date.now(),lock,manifest})+'\\n')`,
  'const installed={}',
  "for(const [key,entry] of Object.entries(lock.packages)){if(!key)continue;mkdirSync(join(process.cwd(),key),{recursive:true});writeFileSync(join(process.cwd(),key,'package.json'),JSON.stringify({name:key.slice('node_modules/'.length),version:entry.version}));installed[key]={...entry}}",
  `if(existsSync(${JSON.stringify(failFile)}))process.exit(1)`,
  `if(existsSync(${JSON.stringify(tamperFile)}))for(const [key,patch] of Object.entries(JSON.parse(readFileSync(${JSON.stringify(tamperFile)},'utf8'))))patch===null?delete installed[key]:installed[key]={...installed[key],...patch}`,
  "writeFileSync(join(process.cwd(),'node_modules','.package-lock.json'),JSON.stringify({name:lock.name,version:lock.version,lockfileVersion:3,requires:true,packages:installed}))",
 ].join('\n'),'utf8')
 await chmod(path,0o755)
 return {
  path,
  runs:async():Promise<NpmRun[]>=>existsSync(log)?(await readFile(log,'utf8')).trim().split('\n').map(line=>JSON.parse(line) as NpmRun):[],
  tamper:(patch:Record<string,Record<string,unknown>|null>|undefined)=>patch?writeFile(tamperFile,JSON.stringify(patch)):rm(tamperFile,{force:true}),
  fail:(on:boolean)=>on?writeFile(failFile,'1'):rm(failFile,{force:true}),
 }
}

const recipe=(name='@scope/pkg'):ManagedPackageRecipe=>({package:name,version:'1.0.0',integrity:good})
const packagesDirEntries=async(root:string)=>existsSync(join(root,'packages'))?(await readdir(join(root,'packages'))).sort():[]

test('managedPackageDir：root/packages/<scope__name>@<version>',()=>{
 assert.equal(managedPackageDir('/r',{package:'@larksuiteoapi/node-sdk',version:'1.74.0',integrity:good}),'/r/packages/@larksuiteoapi__node-sdk@1.74.0')
})

test('安装走 npm ci --ignore-scripts --no-audit --no-fund：在临时目录写随附 lock 与最小 package.json；子进程环境只含白名单键；成功后改名为正式目录（0700）',{timeout:20000},async t=>{
 const root=await tempRoot(t)
 const npm=await fakeNpm(root)
 process.env.TELOA_TEST_SECRET='teloa-secret'
 process.env.DSH_TEST_SECRET='dsh-secret'
 t.after(()=>{delete process.env.TELOA_TEST_SECRET;delete process.env.DSH_TEST_SECRET})
 const dir=await installManagedPackage(root,recipe(),npm.path,lockFor())
 assert.equal(dir,managedPackageDir(root,recipe()))
 const [run]=await npm.runs()
 assert.deepEqual(run!.args,['ci','--ignore-scripts','--no-audit','--no-fund'])
 assert.notEqual(run!.cwd,await realpath(dir),'npm 应在临时目录执行，而非正式目录')
 assert.equal(dirname(run!.cwd),await realpath(join(root,'packages')),'临时目录应与正式目录同级（改名为原子操作）')
 assert.deepEqual(run!.lock,lockFor())
 assert.deepEqual(run!.manifest,{name:'teloa-managed-install',version:'1.0.0',private:true,dependencies:{'@scope/pkg':'1.0.0'}})
 assert.ok(!run!.envKeys.some(key=>key.startsWith('TELOA_')||key.startsWith('DSH_')),run!.envKeys.join(','))
 // macOS 会给每个子进程注入 __CF_USER_TEXT_ENCODING，不来自宿主环境。
 assert.deepEqual(run!.envKeys.filter(key=>!envWhitelist.has(key)&&key!=='__CF_USER_TEXT_ENCODING'),[])
 assert.equal((await stat(dir)).mode&0o777,0o700)
 assert.ok(existsSync(join(dir,'node_modules','dep','package.json')))
 assert.deepEqual(await packagesDirEntries(root),['@scope__pkg@1.0.0'],'不应残留临时目录')
})

for(const [label,patch] of [
 ['传递依赖 integrity 被替换',{'node_modules/dep':{integrity:bad}}],
 ['传递依赖版本漂移',{'node_modules/dep':{version:'2.9.9'}}],
 ['顶层包 integrity 不符',{'node_modules/@scope/pkg':{integrity:bad}}],
 ['多出 lock 之外的条目',{'node_modules/evil':{version:'1.0.0',integrity:good}}],
 ['缺少 lock 中的条目',{'node_modules/dep':null}],
] as const){
 test(`核对失败（${label}）→ teloa/dependency-unavailable，删除临时目录、不留正式目录；恢复后重试成功`,{timeout:20000},async t=>{
  const root=await tempRoot(t)
  const npm=await fakeNpm(root)
  await npm.tamper(patch)
  await assert.rejects(installManagedPackage(root,recipe(),npm.path,lockFor()),{code:'teloa/dependency-unavailable'})
  assert.deepEqual(await packagesDirEntries(root),[])
  await npm.tamper(undefined)
  assert.equal(await installManagedPackage(root,recipe(),npm.path,lockFor()),managedPackageDir(root,recipe()))
  assert.equal((await npm.runs()).length,2)
 })
}

test('npm ci 非零退出 → 临时半成品删除、不留正式目录',{timeout:20000},async t=>{
 const root=await tempRoot(t)
 const npm=await fakeNpm(root)
 await npm.fail(true)
 await assert.rejects(installManagedPackage(root,recipe(),npm.path,lockFor()))
 assert.deepEqual(await packagesDirEntries(root),[])
})

test('M1：npm ci 超时 → SIGKILL 终止、teloa/dependency-unavailable，删除临时目录、不留正式目录',{timeout:20000},async t=>{
 const root=await tempRoot(t)
 const npm=await fakeNpm(root,10_000)
 const started=Date.now()
 await assert.rejects(installManagedPackage(root,recipe(),npm.path,lockFor(),300),{code:'teloa/dependency-unavailable',details:{errorCode:'install-timeout',retryable:true}})
 assert.ok(Date.now()-started<5000,'超时即终止，不等 npm 自行结束')
 assert.deepEqual(await packagesDirEntries(root),[])
 assert.equal((await npm.runs()).length,0,'子进程在写日志前已被终止')
})

test('已安装且逐条核对通过 → 第二次调用不再执行 npm',{timeout:20000},async t=>{
 const root=await tempRoot(t)
 const npm=await fakeNpm(root)
 await installManagedPackage(root,recipe(),npm.path,lockFor())
 assert.equal(await installManagedPackage(root,recipe(),npm.path,lockFor()),managedPackageDir(root,recipe()))
 assert.equal((await npm.runs()).length,1)
})

test('已安装目录被改动（传递依赖 integrity 不符）→ 加载前核对不过，重新安装并替换正式目录',{timeout:20000},async t=>{
 const root=await tempRoot(t)
 const npm=await fakeNpm(root)
 const dir=await installManagedPackage(root,recipe(),npm.path,lockFor())
 const hidden=join(dir,'node_modules','.package-lock.json')
 const data=JSON.parse(await readFile(hidden,'utf8')) as Lock
 data.packages['node_modules/dep']!.integrity=bad
 await writeFile(hidden,JSON.stringify(data))
 assert.equal(await installManagedPackage(root,recipe(),npm.path,lockFor()),dir)
 assert.equal((await npm.runs()).length,2)
 assert.equal((JSON.parse(await readFile(hidden,'utf8')) as Lock).packages['node_modules/dep']!.integrity,good2)
 assert.deepEqual(await packagesDirEntries(root),['@scope__pkg@1.0.0'])
})

test('两次并发安装串行执行：起止时间不重叠',{timeout:20000},async t=>{
 const root=await tempRoot(t)
 const npm=await fakeNpm(root,300)
 await Promise.all([installManagedPackage(root,recipe('@scope/one'),npm.path,lockFor('@scope/one')),installManagedPackage(root,recipe('@scope/two'),npm.path,lockFor('@scope/two'))])
 const runs=(await npm.runs()).sort((a,b)=>a.start-b.start)
 assert.equal(runs.length,2)
 assert.ok(runs[1]!.start>=runs[0]!.end,`重叠：${JSON.stringify(runs.map(run=>[run.start,run.end]))}`)
})

test('随附 lock 缺失、条目缺 integrity 或顶层条目与配方不一致 → teloa/forbidden，不执行 npm',{timeout:20000},async t=>{
 const root=await tempRoot(t)
 const npm=await fakeNpm(root)
 await assert.rejects(installManagedPackage(root,recipe(),npm.path),{code:'teloa/forbidden'})
 const noIntegrity=lockFor();delete noIntegrity.packages['node_modules/dep']!.integrity
 await assert.rejects(installManagedPackage(root,recipe(),npm.path,noIntegrity),{code:'teloa/forbidden'})
 const otherTop=lockFor();otherTop.packages['node_modules/@scope/pkg']!.integrity=bad
 await assert.rejects(installManagedPackage(root,recipe(),npm.path,otherTop),{code:'teloa/forbidden'})
 const oldFormat={...lockFor(),lockfileVersion:2}
 await assert.rejects(installManagedPackage(root,recipe(),npm.path,oldFormat),{code:'teloa/forbidden'})
 assert.equal((await npm.runs()).length,0)
})

test('随附 lock 与配方声明不一致（根依赖多出/版本不符、条目键越界、link 条目、非 sha512 integrity）→ teloa/forbidden，不执行 npm',{timeout:20000},async t=>{
 const root=await tempRoot(t)
 const npm=await fakeNpm(root)
 const extraRoot=lockFor();extraRoot.packages['']!.dependencies={'@scope/pkg':'1.0.0',dep:'2.1.0'}
 const rangeRoot=lockFor();rangeRoot.packages['']!.dependencies={'@scope/pkg':'^1.0.0'}
 const escape=lockFor();escape.packages['node_modules/../../evil']={version:'1.0.0',resolved:'https://registry.npmjs.org/evil/-/evil-1.0.0.tgz',integrity:good}
 const linked=lockFor();linked.packages['node_modules/dep']={resolved:'../dep',link:true,integrity:good2}
 const sha1=lockFor();sha1.packages['node_modules/dep']!.integrity='sha1-'+'A'.repeat(27)+'='
 const topVersion=lockFor();topVersion.packages['node_modules/@scope/pkg']!.version='1.0.1'
 for(const lock of [extraRoot,rangeRoot,escape,linked,sha1,topVersion]){
  assert.throws(()=>readManagedPackageLock(lock,recipe()),{code:'teloa/forbidden'},JSON.stringify(lock.packages))
  await assert.rejects(installManagedPackage(root,recipe(),npm.path,lock),{code:'teloa/forbidden'})
 }
 assert.equal((await npm.runs()).length,0)
 assert.deepEqual(await packagesDirEntries(root),[])
})

test('R1-L1：lock 里每个包的 resolved 必须是 https://registry.npmjs.org/ 下的地址，否则 teloa/forbidden、不执行 npm',{timeout:20000},async t=>{
 const root=await tempRoot(t)
 const npm=await fakeNpm(root)
 for(const resolved of [undefined,'https://evil.example/dep-2.1.0.tgz','http://registry.npmjs.org/dep/-/dep-2.1.0.tgz','git+ssh://git@github.com/evil/dep.git#abc','https://registry.npmjs.org.evil.example/dep.tgz','file:../dep']){
  const lock=lockFor()
  if(resolved===undefined)delete lock.packages['node_modules/dep']!.resolved
  else lock.packages['node_modules/dep']!.resolved=resolved
  assert.throws(()=>readManagedPackageLock(lock,recipe()),{code:'teloa/forbidden'},String(resolved))
  await assert.rejects(installManagedPackage(root,recipe(),npm.path,lock),{code:'teloa/forbidden'})
 }
 assert.equal((await npm.runs()).length,0)
})

test('R1-L2：快路径不信任磁盘——node_modules 内文件被改（隐藏 lock 未动）、只伪造隐藏 lock 而无安装记录、安装记录对应另一份 lock，都重新 npm ci',{timeout:20000},async t=>{
 const root=await tempRoot(t)
 const npm=await fakeNpm(root)
 const dir=await installManagedPackage(root,recipe(),npm.path,lockFor())
 // 1) 篡改已装包内的文件，不动 .package-lock.json
 await writeFile(join(dir,'node_modules','dep','package.json'),'{"name":"dep","version":"2.1.0","main":"evil.js"}')
 assert.equal(await installManagedPackage(root,recipe(),npm.path,lockFor()),dir)
 assert.equal((await npm.runs()).length,2,'文件被改后重新安装')
 assert.notEqual(await readFile(join(dir,'node_modules','dep','package.json'),'utf8'),'{"name":"dep","version":"2.1.0","main":"evil.js"}')
 // 2) 目录里多出一个文件（例如植入的脚本）
 await writeFile(join(dir,'node_modules','dep','evil.js'),'process.exit(1)')
 await installManagedPackage(root,recipe(),npm.path,lockFor())
 assert.equal((await npm.runs()).length,3)
 assert.equal(existsSync(join(dir,'node_modules','dep','evil.js')),false)
 // 3) 只有伪造的隐藏 lock（与随附 lock 逐条一致）、没有安装记录：不走快路径
 const forged=join(root,'forged')
 const forgedDir=join(forged,'packages','@scope__pkg@1.0.0')
 await mkdir(join(forgedDir,'node_modules'),{recursive:true})
 const lock=lockFor()
 await writeFile(join(forgedDir,'node_modules','.package-lock.json'),JSON.stringify({...lock,packages:Object.fromEntries(Object.entries(lock.packages).filter(([key])=>key!==''))}))
 const npm2=await fakeNpm(forged)
 await installManagedPackage(forged,recipe(),npm2.path,lockFor())
 assert.equal((await npm2.runs()).length,1,'伪造的隐藏 lock 不被信任')
 // 4) 安装记录对应另一份 lock（同包同版本、传递依赖不同）：重新安装
 const other=lockFor();other.packages['node_modules/dep']!.version='2.2.0'
 await installManagedPackage(forged,recipe(),npm2.path,other)
 assert.equal((await npm2.runs()).length,2)
 // 复核通过时照常不执行 npm
 await installManagedPackage(forged,recipe(),npm2.path,other)
 assert.equal((await npm2.runs()).length,2)
})

test('optional 条目（平台不符被 npm 跳过）未装仍通过；装了就必须逐条一致',{timeout:20000},async t=>{
 const root=await tempRoot(t)
 const npm=await fakeNpm(root)
 const lock=lockFor();lock.packages['node_modules/fsevents']={version:'2.3.3',resolved:'https://registry.npmjs.org/fsevents/-/fsevents-2.3.3.tgz',integrity:good2,optional:true}
 await npm.tamper({'node_modules/fsevents':null})
 assert.equal(await installManagedPackage(root,recipe(),npm.path,lock),managedPackageDir(root,recipe()))
 const other=await tempRoot(t)
 const npm2=await fakeNpm(other)
 await npm2.tamper({'node_modules/fsevents':{integrity:bad}})
 await assert.rejects(installManagedPackage(other,recipe(),npm2.path,lock),{code:'teloa/dependency-unavailable'})
})

test('installLockedPackage：装到调用方给定目录、不进串行队列（受管 MCP 已在队列内调用），lock 以未知值传入先核对',{timeout:20000},async t=>{
 const root=await tempRoot(t)
 const npm=await fakeNpm(root)
 const dir=join(root,'mcp','packages','@scope__pkg@1.0.0')
 assert.equal(await installLockedPackage(dir,recipe(),JSON.parse(JSON.stringify(lockFor())) as unknown,npm.path),dir)
 assert.ok(existsSync(join(dir,'node_modules','dep','package.json')))
 const [run]=await npm.runs()
 assert.deepEqual(run!.args,['ci','--ignore-scripts','--no-audit','--no-fund'])
 assert.equal(dirname(run!.cwd),await realpath(join(root,'mcp','packages')))
 await assert.rejects(installLockedPackage(join(root,'x'),recipe(),undefined,npm.path),{code:'teloa/forbidden'})
 assert.equal(await installLockedPackage(dir,recipe(),lockFor(),npm.path),dir)
 assert.equal((await npm.runs()).length,1,'已装且核对通过不再执行 npm')
})

test('安装超时常量 180 秒（与建连 30 秒分开）；onInstall 只在真正执行 npm 前调用一次，已装复核不调用；npm 失败带 install-failed',{timeout:20000},async t=>{
 assert.equal(managedInstallTimeoutMs,180_000)
 const root=await tempRoot(t)
 const npm=await fakeNpm(root)
 const dir=join(root,'mcp','packages','@scope__pkg@1.0.0')
 let calls=0
 await installLockedPackage(dir,recipe(),lockFor(),npm.path,5_000,()=>{calls++})
 await installLockedPackage(dir,recipe(),lockFor(),npm.path,5_000,()=>{calls++})
 assert.equal(calls,1)
 await npm.fail(true)
 await assert.rejects(installLockedPackage(join(root,'other'),recipe(),lockFor(),npm.path,5_000),{code:'teloa/dependency-unavailable',details:{errorCode:'install-failed',retryable:true}})
})

test('飞书 SDK 随附 lock：v3、所有条目带 sha512 integrity、根依赖精确钉 1.74.0、顶层条目与配方一致',()=>{
 const lock=managedPackageLock(managedPackageAllowlist[0]!) as Lock|undefined
 assert.ok(lock)
 assert.equal(lock.lockfileVersion,3)
 assert.deepEqual(lock.packages['']!.dependencies,{'@larksuiteoapi/node-sdk':'1.74.0'})
 const entries=Object.entries(lock.packages).filter(([key])=>key!=='')
 assert.ok(entries.length>10,'应含全部传递依赖')
 for(const [key,entry] of entries){
  assert.match(String(entry.integrity),/^sha512-/,key)
  assert.match(String(entry.resolved),/^https:\/\/registry\.npmjs\.org\//,key)
 }
 assert.equal(lock.packages['node_modules/@larksuiteoapi/node-sdk']!.integrity,managedPackageAllowlist[0]!.integrity)
 assert.equal(lock.packages['node_modules/@larksuiteoapi/node-sdk']!.version,'1.74.0')
 for(const name of ['axios','ws','qs','protobufjs'])assert.ok(lock.packages[`node_modules/${name}`],name)
})

test('包名白名单：只允许 @larksuiteoapi/node-sdk@1.74.0 与 onnxruntime-node@1.30.0 且 integrity 一致；其余 teloa/forbidden',()=>{
 assert.deepEqual(managedPackageAllowlist,[
  {package:'@larksuiteoapi/node-sdk',version:'1.74.0',integrity:'sha512-K2WoGy6x97u2kPPSFsu0v9X8CY+0q4OwO3rhXiOSRXYjGS7ovydFpEH07AS5VYcBnbQCoc5sGezo0IEGVViuoA=='},
  {package:'onnxruntime-node',version:'1.30.0',integrity:'sha512-twhs1C2C/BFkz1yc5OY0KIU2GUq6DURO7hD4bx5Q2Qy3nAMJwRXW8xU3NVczE29VA9lolLOYepoD8fjTGOfIqw=='},
 ])
 for(const entry of managedPackageAllowlist)assert.doesNotThrow(()=>assertAllowedManagedPackage(entry))
 for(const other of [
  {package:'left-pad',version:'1.3.0',integrity:good},
  {...managedPackageAllowlist[0]!,version:'1.75.0'},
  {...managedPackageAllowlist[0]!,integrity:good},
  // 同名同版本、integrity 不同的 onnxruntime-node 配方一律拒收
  {...managedPackageAllowlist[1]!,integrity:good},
  {...managedPackageAllowlist[1]!,version:'1.29.0'},
 ])assert.throws(()=>assertAllowedManagedPackage(other),{code:'teloa/forbidden'})
})

test('onnxruntime-node 随附 lock：readManagedPackageLock 通过；顶层版本与 integrity 等于配方；全部条目 sha512、无 link、官方源；含 onnxruntime-common 1.30.0',()=>{
 const recipe=managedPackageAllowlist.find(entry=>entry.package==='onnxruntime-node')!
 const lock=managedPackageLock(recipe) as Lock|undefined
 assert.ok(lock)
 assert.doesNotThrow(()=>readManagedPackageLock(lock,recipe))
 assert.deepEqual(lock.packages['']!.dependencies,{'onnxruntime-node':'1.30.0'})
 assert.equal(lock.packages['node_modules/onnxruntime-node']!.version,'1.30.0')
 assert.equal(lock.packages['node_modules/onnxruntime-node']!.integrity,recipe.integrity)
 assert.equal(lock.packages['node_modules/onnxruntime-common']!.version,'1.30.0')
 for(const [key,entry] of Object.entries(lock.packages).filter(([key])=>key!=='')){
  assert.match(String(entry.integrity),/^sha512-[A-Za-z0-9+/]{86}==$/,key)
  assert.match(String(entry.resolved),/^https:\/\/registry\.npmjs\.org\//,key)
  assert.equal(entry.link,undefined,key)
 }
 // 同名不同 integrity 的配方拿这份 lock 也核对不过
 assert.throws(()=>readManagedPackageLock(lock,{...recipe,integrity:good}),{code:'teloa/forbidden'})
})

test('managedPackageInstalled：只核对不安装——未装、装后被改动为 false，装好为 true；从不执行 npm',{timeout:20000},async t=>{
 const root=await tempRoot(t)
 const npm=await fakeNpm(root)
 assert.equal(await managedPackageInstalled(root,recipe(),lockFor()),false)
 assert.equal((await npm.runs()).length,0)
 const dir=await installManagedPackage(root,recipe(),npm.path,lockFor())
 assert.equal(await managedPackageInstalled(root,recipe(),lockFor()),true)
 await writeFile(join(dir,'node_modules','dep','evil.js'),'1')
 assert.equal(await managedPackageInstalled(root,recipe(),lockFor()),false)
 assert.equal((await npm.runs()).length,1)
 await assert.rejects(managedPackageInstalled(root,recipe(),undefined),{code:'teloa/forbidden'})
})

test('L2：启动清扫只删一小时前的 .installing-<uuid> 残留；新近临时目录、正式目录与其它文件不动；index.ts 启动时对按需包与受管 MCP 包两处调用',async t=>{
 const root=await tempRoot(t)
 const packages=join(root,'packages')
 const stale=join(packages,'@scope__pkg@1.0.0.installing-11111111-2222-4333-8444-555555555555')
 const fresh=join(packages,'@scope__pkg@1.0.0.installing-66666666-7777-4888-9999-aaaaaaaaaaaa')
 for(const dir of [stale,fresh,join(packages,'@scope__pkg@1.0.0'),join(packages,'other.installing-x')])await mkdir(join(dir,'node_modules'),{recursive:true})
 const old=new Date(Date.now()-2*60*60_000)
 await utimes(stale,old,old)
 await sweepManagedPackageStaging(root)
 assert.deepEqual(await packagesDirEntries(root),['@scope__pkg@1.0.0','@scope__pkg@1.0.0.installing-66666666-7777-4888-9999-aaaaaaaaaaaa','other.installing-x'])
 // 一小时内的临时目录一律保留：共用运行目录的另一宿主进程可能正在用它安装
 const recent=join(packages,'@scope__pkg@1.0.0.installing-bbbbbbbb-cccc-4ddd-8eee-ffffffffffff')
 await mkdir(recent)
 const tenMinutes=new Date(Date.now()-10*60_000)
 await utimes(recent,tenMinutes,tenMinutes)
 await sweepManagedPackageStaging(root)
 assert.ok(existsSync(recent))
 await sweepManagedPackageStaging(join(root,'missing'))
 const source=await readFile(new URL('../src/index.ts',import.meta.url),'utf8')
 assert.match(source,/void sweepManagedPackageStaging\(runtimeRoot\)/)
 assert.match(source,/void sweepManagedPackageStaging\(resolve\(runtimeRoot,'mcp'\)\)/,'受管 MCP 包目录 runtimeRoot/mcp/packages 同样清扫')
})

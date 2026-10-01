import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,readFile,stat,symlink,writeFile} from 'node:fs/promises'
import {createRequire,syncBuiltinESMExports} from 'node:module'
import {tmpdir} from 'node:os'
import {join,relative,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {bundledExtensions} from '@teloa/contract'
import {BUNDLED_EXTENSIONS_FILE,IM_GATEWAY_PACKAGE,LOCAL_EMBEDDING_PACKAGE,bundledSourceConflicts,bundledSourceMismatch,bundledSourcesToRegister,migrateBundledExtensions,officialBundledSpecs,setBundledExtension} from '../src/bundled-extensions-profile.ts'

const projectRoot=resolve(fileURLToPath(new URL('../../../',import.meta.url)))
const official='link:'+join(projectRoot,'packages/im-gateway')
/** 夹具只登记 IM 通道；本地中文检索同为随附扩展，未登记时补登记结果里总会带上它的官方值。 */
const embedding={[LOCAL_EMBEDDING_PACKAGE]:'link:'+join(projectRoot,'packages/local-embedding')}
async function fixture(spec:string|undefined,channels?:number){
 const home=await mkdtemp(join(tmpdir(),'teloa-bundled-'))
 const profileDir=join(home,'profiles','teloa'),runtimeRoot=join(home,'runtime')
 await mkdir(profileDir,{recursive:true})
 await writeFile(join(profileDir,'package.json'),JSON.stringify({dependencies:spec===undefined?{}:{[IM_GATEWAY_PACKAGE]:spec},dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@teloa/bundle']}}}))
 if(channels!==undefined){
  await mkdir(join(runtimeRoot,'im-gateway'),{recursive:true})
  await writeFile(join(runtimeRoot,'im-gateway','channels.json'),JSON.stringify({channels:Array.from({length:channels},(_,i)=>({kind:'telegram',id:'c'+i}))}))
 }
 return {profileDir,runtimeRoot}
}
const bundles=async(profileDir:string)=>JSON.parse(await readFile(join(profileDir,'package.json'),'utf8')).dsh.profile.bundles as string[]
const marker=async(profileDir:string)=>JSON.parse(await readFile(join(profileDir,BUNDLED_EXTENSIONS_FILE),'utf8')) as Record<string,unknown>

test('启用插在 @teloa/bundle 之后、第三方 bundle 之前：第三方不能抢先挂接 im/*；迁移同理',async()=>{
 const withVendor=async(channels?:number)=>{
  const target=await fixture(official,channels)
  const manifest=JSON.parse(await readFile(join(target.profileDir,'package.json'),'utf8'))
  manifest.dsh.profile.bundles.push('@vendor/early','@vendor/late')
  await writeFile(join(target.profileDir,'package.json'),JSON.stringify(manifest))
  return target
 }
 const expected=['@deepseek-ai/dsh-base','@teloa/bundle',IM_GATEWAY_PACKAGE,'@vendor/early','@vendor/late']
 const enabled=await withVendor()
 await setBundledExtension(enabled.profileDir,projectRoot,IM_GATEWAY_PACKAGE,true)
 assert.deepEqual(await bundles(enabled.profileDir),expected)
 const migrated=await withVendor(1)
 assert.equal(await migrateBundledExtensions(migrated.profileDir,migrated.runtimeRoot,projectRoot),'enabled')
 assert.deepEqual(await bundles(migrated.profileDir),expected)
})
test('启用幂等；停用只摘除该包',async()=>{
 const {profileDir}=await fixture(official)
 await setBundledExtension(profileDir,projectRoot,IM_GATEWAY_PACKAGE,true)
 await setBundledExtension(profileDir,projectRoot,IM_GATEWAY_PACKAGE,true)
 assert.deepEqual(await bundles(profileDir),['@deepseek-ai/dsh-base','@teloa/bundle',IM_GATEWAY_PACKAGE])
 await setBundledExtension(profileDir,projectRoot,IM_GATEWAY_PACKAGE,false)
 assert.deepEqual(await bundles(profileDir),['@deepseek-ai/dsh-base','@teloa/bundle'])
})
test('来源为相对 link 且指向随附目录时也放行；组合里没有 @teloa/bundle 时追加到末尾',async()=>{
 const {profileDir}=await fixture(undefined)
 await writeFile(join(profileDir,'package.json'),JSON.stringify({dependencies:{[IM_GATEWAY_PACKAGE]:'link:'+relative(profileDir,join(projectRoot,'packages/im-gateway'))},dsh:{profile:{bundles:[]}}}))
 await setBundledExtension(profileDir,projectRoot,IM_GATEWAY_PACKAGE,true)
 assert.deepEqual(await bundles(profileDir),[IM_GATEWAY_PACKAGE])
})
test('来源被替换时拒绝启用，bundles 不变；启动核对报出冲突',async()=>{
 const {profileDir}=await fixture('link:'+tmpdir())
 await assert.rejects(setBundledExtension(profileDir,projectRoot,IM_GATEWAY_PACKAGE,true),{message:bundledSourceMismatch})
 assert.deepEqual(await bundles(profileDir),['@deepseek-ai/dsh-base','@teloa/bundle'])
 const manifest=JSON.parse(await readFile(join(profileDir,'package.json'),'utf8'))
 manifest.dsh.profile.bundles.push(IM_GATEWAY_PACKAGE)
 await writeFile(join(profileDir,'package.json'),JSON.stringify(manifest))
 assert.deepEqual(await bundledSourceConflicts(profileDir,projectRoot),[IM_GATEWAY_PACKAGE])
})
test('迁移：有渠道的老用户自动启用，只迁一次，之后尊重停用',async()=>{
 const {profileDir,runtimeRoot}=await fixture(official,1)
 assert.equal(await migrateBundledExtensions(profileDir,runtimeRoot,projectRoot),'enabled')
 assert.ok((await bundles(profileDir)).includes(IM_GATEWAY_PACKAGE))
 assert.equal((await stat(join(profileDir,BUNDLED_EXTENSIONS_FILE))).mode&0o777,0o600)
 assert.deepEqual(await marker(profileDir),{'im-gateway-optional-v1':'enabled'})
 await setBundledExtension(profileDir,projectRoot,IM_GATEWAY_PACKAGE,false)
 assert.equal(await migrateBundledExtensions(profileDir,runtimeRoot,projectRoot),'skipped')
 assert.ok(!(await bundles(profileDir)).includes(IM_GATEWAY_PACKAGE))
})
test('迁移：没有渠道不启用但写标记；来源未登记则推迟且不写标记',async()=>{
 const empty=await fixture(official,0)
 assert.equal(await migrateBundledExtensions(empty.profileDir,empty.runtimeRoot,projectRoot),'skipped')
 assert.ok(!(await bundles(empty.profileDir)).includes(IM_GATEWAY_PACKAGE))
 assert.equal((await stat(join(empty.profileDir,BUNDLED_EXTENSIONS_FILE))).mode&0o777,0o600)
 assert.deepEqual(await marker(empty.profileDir),{'im-gateway-optional-v1':'skipped'})
 const missing=await fixture(undefined,3)
 assert.equal(await migrateBundledExtensions(missing.profileDir,missing.runtimeRoot,projectRoot),'deferred')
 await assert.rejects(stat(join(missing.profileDir,BUNDLED_EXTENSIONS_FILE)),{code:'ENOENT'})
})
test('迁移：渠道文件除不存在外读不了（JSON 损坏、是目录）一律推迟，不写标记、不启用',async()=>{
 // EISDIR 与 EACCES 走同一分支；chmod 000 在 root 下不生效，这里用目录代替。
 for(const broken of ['{','dir']){
  const {profileDir,runtimeRoot}=await fixture(official)
  await mkdir(join(runtimeRoot,'im-gateway'),{recursive:true})
  if(broken==='dir')await mkdir(join(runtimeRoot,'im-gateway','channels.json'))
  else await writeFile(join(runtimeRoot,'im-gateway','channels.json'),broken)
  assert.equal(await migrateBundledExtensions(profileDir,runtimeRoot,projectRoot),'deferred',broken)
  await assert.rejects(stat(join(profileDir,BUNDLED_EXTENSIONS_FILE)),{code:'ENOENT'})
  assert.ok(!(await bundles(profileDir)).includes(IM_GATEWAY_PACKAGE))
 }
})
test('补登记：缺失或指向其它目录时给出官方值，已是官方来源时为空',async()=>{
 assert.deepEqual(await bundledSourcesToRegister((await fixture(undefined)).profileDir,projectRoot),{[IM_GATEWAY_PACKAGE]:official,...embedding})
 assert.deepEqual(await bundledSourcesToRegister((await fixture('link:'+tmpdir())).profileDir,projectRoot),{[IM_GATEWAY_PACKAGE]:official,...embedding})
 assert.deepEqual(await bundledSourcesToRegister((await fixture(official)).profileDir,projectRoot),embedding)
})
test('来源核对反例：非 link、目标不存在、符号链接指向别处一律拒绝；穿越写法与指向官方的符号链接放行',async()=>{
 const scratch=await mkdtemp(join(tmpdir(),'teloa-bundled-link-'))
 const elsewhere=join(scratch,'elsewhere'),toOfficial=join(scratch,'to-official')
 await mkdir(elsewhere)
 await symlink(join(projectRoot,'packages/im-gateway'),toOfficial)
 const other=join(scratch,'to-elsewhere')
 await symlink(elsewhere,other)
 for(const spec of ['file:'+join(projectRoot,'packages/im-gateway'),'0.2.0','link:','link:'+join(scratch,'missing'),'link:'+other]){
  const {profileDir}=await fixture(spec)
  await assert.rejects(setBundledExtension(profileDir,projectRoot,IM_GATEWAY_PACKAGE,true),{message:bundledSourceMismatch},spec)
  assert.deepEqual(await bundledSourcesToRegister(profileDir,projectRoot),{[IM_GATEWAY_PACKAGE]:official,...embedding},spec)
 }
 for(const spec of ['link:'+join(projectRoot,'packages/bundle')+'/../im-gateway','link:'+toOfficial]){
  const {profileDir}=await fixture(spec)
  await setBundledExtension(profileDir,projectRoot,IM_GATEWAY_PACKAGE,true)
  assert.deepEqual(await bundledSourceConflicts(profileDir,projectRoot),[],spec)
 }
})
test('原型链上的名字不算官方扩展：不报冲突、不能越过未知包名检查',async()=>{
 const {profileDir}=await fixture(official)
 const manifest=JSON.parse(await readFile(join(profileDir,'package.json'),'utf8'))
 manifest.dsh.profile.bundles.push('toString','constructor')
 await writeFile(join(profileDir,'package.json'),JSON.stringify(manifest))
 assert.deepEqual(await bundledSourceConflicts(profileDir,projectRoot),[])
 for(const name of ['toString','constructor','__proto__'])
  await assert.rejects(setBundledExtension(profileDir,projectRoot,name,false),{message:bundledSourceMismatch},name)
 assert.deepEqual(await bundles(profileDir),['@deepseek-ai/dsh-base','@teloa/bundle','toString','constructor'])
})
test('迁移记录：不可读时抛出且不启用；写回时保留其它键',async()=>{
 const broken=await fixture(official,1)
 await mkdir(join(broken.profileDir,BUNDLED_EXTENSIONS_FILE))
 await assert.rejects(migrateBundledExtensions(broken.profileDir,broken.runtimeRoot,projectRoot),/迁移记录不可读/)
 assert.ok(!(await bundles(broken.profileDir)).includes(IM_GATEWAY_PACKAGE))
 const kept=await fixture(official,1)
 await writeFile(join(kept.profileDir,BUNDLED_EXTENSIONS_FILE),JSON.stringify({other:'x'}))
 assert.equal(await migrateBundledExtensions(kept.profileDir,kept.runtimeRoot,projectRoot),'enabled')
 assert.deepEqual(await marker(kept.profileDir),{other:'x','im-gateway-optional-v1':'enabled'})
})
test('迁移：标记写失败就不启用——宁漏自动启用，也不留「已启用却没标记」（否则下次启动会改回本人的停用）',async t=>{
 const {profileDir,runtimeRoot}=await fixture(official,1)
 // 内置模块的具名导出随 CJS 对象同步：只让写迁移记录那一次 rename 失败，profile 清单照常可写。
 const fs=createRequire(import.meta.url)('node:fs/promises') as {rename:(from:string,to:string)=>Promise<void>}
 const rename=fs.rename
 t.after(()=>{fs.rename=rename;syncBuiltinESMExports()})
 fs.rename=async(from,to)=>{if(String(to).endsWith(BUNDLED_EXTENSIONS_FILE))throw Object.assign(Error('denied'),{code:'EACCES'});return rename(from,to)}
 syncBuiltinESMExports()
 await assert.rejects(migrateBundledExtensions(profileDir,runtimeRoot,projectRoot),{code:'EACCES'})
 assert.ok(!(await bundles(profileDir)).includes(IM_GATEWAY_PACKAGE))
 await assert.rejects(stat(join(profileDir,BUNDLED_EXTENSIONS_FILE)),{code:'ENOENT'})
})
test('包名表与契约的随附扩展常量一致',()=>{
 assert.deepEqual(Object.keys(officialBundledSpecs(projectRoot)),bundledExtensions.map(row=>row.packageName))
 assert.ok(bundledExtensions.some(row=>row.packageName===IM_GATEWAY_PACKAGE))
})

test('启动来源核对：bundles 里 @teloa/ 作用域的大小写变体一律算冲突，小写官方名照常核对',async()=>{
 const {profileDir}=await fixture(official)
 const manifest=JSON.parse(await readFile(join(profileDir,'package.json'),'utf8'))
 manifest.dsh.profile.bundles.push('@Teloa/im-gateway','@teloa/IM-GATEWAY','@TELOA/bundle','@teloa/native-browser')
 await writeFile(join(profileDir,'package.json'),JSON.stringify(manifest))
 assert.deepEqual(await bundledSourceConflicts(profileDir,projectRoot),['@Teloa/im-gateway','@teloa/IM-GATEWAY','@TELOA/bundle'])
})
test('启动来源核对：@teloa/ 作用域按白名单放行——只认 @teloa/bundle 与随附扩展，其余小写名同样算冲突',async()=>{
 const {profileDir}=await fixture(official)
 const manifest=JSON.parse(await readFile(join(profileDir,'package.json'),'utf8'))
 manifest.dsh.profile.bundles.push(IM_GATEWAY_PACKAGE,'@teloa/evil','@vendor/x')
 await writeFile(join(profileDir,'package.json'),JSON.stringify(manifest))
 assert.deepEqual(await bundledSourceConflicts(profileDir,projectRoot),['@teloa/evil'])
})

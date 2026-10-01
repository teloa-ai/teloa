import test from 'node:test'
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {chmod,mkdtemp,mkdir,readFile,readdir,rm,stat,writeFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {dirname,join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {fileURLToPath} from 'node:url'
import {
 pendingBundleConflicts,
 pendingListUnreadable,
 pendingPackageNames,
 readPendingPlugins,
 rewriteProfileBundles,
 suppressPendingBundles,
 withProfileLock,
 writePendingPlugins,
} from '../src/pending-plugins.ts'

const projectRoot=resolve(fileURLToPath(new URL('../../../',import.meta.url)))
const hash=(seed:string)=>seed.repeat(64).slice(0,64)

async function profile(bundles:string[],dependencies:Record<string,string>={}):Promise<string> {
 const home=await mkdtemp(join(tmpdir(),'teloa-pending-'))
 const profileDir=join(home,'profiles','teloa')
 await mkdir(profileDir,{recursive:true})
 await writeFile(join(profileDir,'package.json'),JSON.stringify({name:'p',private:true,dependencies,dsh:{profile:{bundles,patchReload:'startup'}}},null,2)+'\n')
 return profileDir
}
const bundlesOf=async(profileDir:string):Promise<string[]>=>JSON.parse(await readFile(join(profileDir,'package.json'),'utf8')).dsh.profile.bundles

test('包引用去掉版本段；清单读不出来一律拒绝，只有"文件不存在"才算没有待启用插件',async()=>{
 assert.deepEqual(pendingPackageNames({'@scope/name@1.2.3':hash('a'),'plain@0.1.0':hash('b')}),['@scope/name','plain'])
 const profileDir=await profile([])
 const listPath=join(profileDir,'teloa-待启用插件.json')
 try{
  // 还没装过任何市场插件：这是唯一允许的"空"。
  assert.deepEqual(await readPendingPlugins(profileDir),{})
  await writeFile(listPath,JSON.stringify({'ok@1.0.0':hash('c')}))
  assert.deepEqual(await readPendingPlugins(profileDir),{'ok@1.0.0':hash('c')})
  // 读不出来 ≠ 没有待启用插件：正文被改坏、摘要格式不认识、原型键，都可能是有人在绕开这道闸。
  // 一律抛固定文案，由调用方按拒绝处理；不能像以前那样静悄悄退化成 `{}`（那等于"随便改坏就放行"）。
  for(const body of [
   '不是 JSON',
   JSON.stringify(['数组不是对象']),
   JSON.stringify({'ok@1.0.0':hash('c'),'bad@1.0.0':'短'}),
   JSON.stringify({'ok@1.0.0':hash('c'),'bad@1.0.0':123}),
   // 原型键只能写成原文：对象字面量里的 `__proto__` 是在设原型，`JSON.stringify` 出来是 `{}`。
   // `JSON.parse` 反过来会把它建成一个**自有**属性，所以这条路径真的存在。
   '{"__proto__":"'+hash('d')+'"}',
  ]){
   await writeFile(listPath,body)
   await assert.rejects(readPendingPlugins(profileDir),{message:pendingListUnreadable},body)
   // 交集判据同样拒绝：读不出清单就核不了"有没有待启用插件已经进组合"。
   await assert.rejects(pendingBundleConflicts(profileDir),{message:pendingListUnreadable})
  }
  // 权限不对也算读不出来。
  await writeFile(listPath,JSON.stringify({'ok@1.0.0':hash('c')}))
  await chmod(listPath,0o000)
  if(process.getuid?.()!==0)await assert.rejects(readPendingPlugins(profileDir),{message:pendingListUnreadable})
  await chmod(listPath,0o600)
  // 固定文案不带路径、不带包名。
  assert.ok(!pendingListUnreadable.includes('/')&&!pendingListUnreadable.includes('ok@'))
 }finally{await rm(dirname(dirname(profileDir)),{recursive:true,force:true})}
})

test('原子写保留目标原有的权限位，不把清单悄悄放宽',async()=>{
 const profileDir=await profile(['@deepseek-ai/dsh-base'])
 try{
  const manifestPath=join(profileDir,'package.json')
  await chmod(manifestPath,0o640)
  await rewriteProfileBundles(profileDir,bundles=>[...bundles,'pkg'])
  assert.equal((await stat(manifestPath)).mode&0o777,0o640,'没显式给 mode 时要抄目标原有的权限位')
  // 待启用清单显式要 0600，改写之后仍是 0600。
  await withProfileLock(profileDir,()=>writePendingPlugins(profileDir,{'a@1.0.0':hash('a')}))
  const listPath=join(profileDir,'teloa-待启用插件.json')
  assert.equal((await stat(listPath)).mode&0o777,0o600)
  await withProfileLock(profileDir,()=>writePendingPlugins(profileDir,{'a@1.0.0':hash('a'),'b@1.0.0':hash('b')}))
  assert.equal((await stat(listPath)).mode&0o777,0o600)
 }finally{await rm(dirname(dirname(profileDir)),{recursive:true,force:true})}
})

test('压制把待启用的包从 bundles 摘掉，其余内容与 dependencies 逐字保留',async()=>{
 const profileDir=await profile(['@deepseek-ai/dsh-base','@vendor/plugin'],{'@vendor/plugin':'1.0.0'})
 try{
  await withProfileLock(profileDir,()=>writePendingPlugins(profileDir,{'@vendor/plugin@1.0.0':hash('a')}))
  assert.deepEqual(await pendingBundleConflicts(profileDir),['@vendor/plugin'])
  await suppressPendingBundles(profileDir)
  assert.deepEqual(await bundlesOf(profileDir),['@deepseek-ai/dsh-base'])
  assert.deepEqual(await pendingBundleConflicts(profileDir),[])
  const manifest=JSON.parse(await readFile(join(profileDir,'package.json'),'utf8'))
  assert.equal(manifest.dependencies['@vendor/plugin'],'1.0.0','dependencies 不动：包仍装着，只是不进组合')
  assert.equal(manifest.dsh.profile.patchReload,'startup')
  assert.equal(manifest.name,'p')
  // 反复压制是幂等的：任何一次 dsh plugin 之后都要跑，跑几次都一样。
  await suppressPendingBundles(profileDir)
  assert.deepEqual(await bundlesOf(profileDir),['@deepseek-ai/dsh-base'])
 }finally{await rm(dirname(dirname(profileDir)),{recursive:true,force:true})}
})

test('profile 清单的并发改写按 profile 排队，不会互相覆盖，也不留临时文件',async()=>{
 const profileDir=await profile([])
 try{
  // 无互斥时这十次"读—改—写"会互相覆盖，最终只剩一两个名字。
  await Promise.all(Array.from({length:10},(_,index)=>rewriteProfileBundles(profileDir,bundles=>[...bundles,'pkg-'+index])))
  const bundles=await bundlesOf(profileDir)
  assert.equal(bundles.length,10)
  assert.deepEqual([...bundles].sort(),Array.from({length:10},(_,index)=>'pkg-'+index).sort())
  assert.deepEqual((await readdir(profileDir)).filter(name=>name.includes('.tmp')),[],'原子写的临时文件必须清干净')
 }finally{await rm(dirname(dirname(profileDir)),{recursive:true,force:true})}
})

/**
 * 上游 `reconcilePlugins` 的真实行为，用真的 `dsh plugin add` 复现（不联网：两个包都用 `link:`）。
 * rc.1 保留已安装包的停用选择；Teloa 仍检查既有待启用记录，保持升级前后的收尾幂等。
 */
test('真实 rc.1 plugin add 保留待启用包的停用选择，重复压制保持幂等',async t=>{
 let dshBin:string
 // 跳过要显式标记：裸 return 会让这一例在依赖装不上时静静地变成"通过"，
 // 而它正是 C-1 的唯一真实证据 —— 悄悄不跑等于这道钉没人守。
 try{dshBin=join(dirname(createRequire(join(projectRoot,'package.json')).resolve('@deepseek-ai/dsh/package.json')),'lib/bin.js')}
 catch{t.skip('解析不到 @deepseek-ai/dsh，跳过真实 reconcile 复现');return}
 const home=await mkdtemp(join(tmpdir(),'teloa-reconcile-'))
 try{
  const profileDir=join(home,'profiles','teloa'),packages=join(home,'packages')
  await mkdir(profileDir,{recursive:true})
  await writeFile(join(profileDir,'package.json'),JSON.stringify({name:'p',private:true,dependencies:{},dsh:{profile:{bundles:[],patchReload:'startup'}}},null,2)+'\n')
  for(const name of ['vendor-plugin','other-plugin']){
   await mkdir(join(packages,name),{recursive:true})
   await writeFile(join(packages,name,'package.json'),JSON.stringify({name,version:'1.0.0',dsh:{bundle:{patch:'./cordis.patch.yml'}}}))
   await writeFile(join(packages,name,'cordis.patch.yml'),'[]\n')
  }
  const add=(name:string)=>spawnSync(process.execPath,[dshBin,'plugin','--profile','teloa','add','link:'+join(packages,name),'--save-exact','--ignore-scripts'],{env:{...process.env,DSH_HOME:home},encoding:'utf8',timeout:180_000})
  const first=add('vendor-plugin')
  if(first.status!==0){t.skip('首次 dsh plugin add 未成功（pnpm 不可用？），跳过真实 reconcile 复现');return}
  // reconcile 装完就把声明了 dsh.bundle 的包追进 bundles。
  assert.deepEqual(await bundlesOf(profileDir),['vendor-plugin'])
  // Teloa 的安装收尾：记成待启用并从 bundles 摘掉。
  await withProfileLock(profileDir,()=>writePendingPlugins(profileDir,{'vendor-plugin@1.0.0':hash('a')}))
  await suppressPendingBundles(profileDir)
  assert.deepEqual(await bundlesOf(profileDir),[])
  // 装另一个包时，rc.1 不再重新启用已安装但从 bundles 摘掉的包。
  assert.equal(add('other-plugin').status,0)
  assert.deepEqual(await bundlesOf(profileDir),['other-plugin'],'官方保留已有停用选择')
  assert.deepEqual(await pendingBundleConflicts(profileDir),[])
  // 无条件重新压制之后，待启用的包不在组合里，刚装的那个照常留着。
  await suppressPendingBundles(profileDir)
  assert.deepEqual(await bundlesOf(profileDir),['other-plugin'])
  assert.deepEqual(await pendingBundleConflicts(profileDir),[])
 }finally{await rm(home,{recursive:true,force:true})}
})

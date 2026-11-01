import assert from 'node:assert/strict'
import test from 'node:test'
const api=await import('../src/upgrade.ts').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return {};throw error}) as any
const release={schema:'teloa.release/v1',version:'0.2.0-alpha.3',dshVersion:'0.1.6-alpha.1',dataVersion:1,compatibleDataVersions:[1],files:[]}
test('仅放行已验收的数据版本，不将兼容读取等同于可逆迁移',()=>{
 assert.equal(typeof api.canUseData,'function')
 assert.equal(api.canUseData(release,1),true)
 assert.equal(api.canUseData(release,2),false)
 assert.equal(api.canUseData({...release,dataVersion:2,compatibleDataVersions:[1,2]},1),false)
 assert.equal(api.canUseData({...release,dataVersion:2,compatibleDataVersions:[2]},2),true)
 assert.equal(api.canUpgradeData({...release,dataVersion:2,compatibleDataVersions:[2]},1),true)
 assert.equal(api.canUpgradeData(release,2),false,'数据 2 不降级为 1，即使旧发行曾声明同版本兼容')
 for(const from of [1,2])assert.equal(api.canUpgradeData({...release,dataVersion:3,compatibleDataVersions:[3]},from),true)
 assert.equal(api.canUseData({...release,dataVersion:2,compatibleDataVersions:[2,3]},3),false,'旧发行即使声称兼容也不能读取数据 3')
 assert.equal(api.canUpgradeData({...release,dataVersion:2,compatibleDataVersions:[2]},3),false,'未知提交的数据不能降级给旧读口')
 for(const from of [1,2,3])assert.equal(api.canUpgradeData({...release,dataVersion:4,compatibleDataVersions:[4]},from),true,'固定迁移表已支持历史数据升级到 4')
 for(const from of [1,2,3,4,5])assert.equal(api.canUpgradeData({...release,dataVersion:6,compatibleDataVersions:[6]},from),true,'保留历史数据6固定迁移边')
 for(const from of [1,2,3,4,5,6])assert.equal(api.canUpgradeData({...release,dataVersion:7,compatibleDataVersions:[7]},from),true,'本人分身候选格式须备份迁移到7')
 for(const from of [1,2,3,4,5,6,7])assert.equal(api.canUpgradeData({...release,dataVersion:99,compatibleDataVersions:[99]},from),false,'未知数据版本不能作为升级候选')
})
test('注册表安装记录必须固定包名、版本和完整性',()=>{
 assert.equal(typeof api.verifyRegistryInstall,'function')
 const pkg={name:'@teloa/cli',version:'0.2.0-alpha.4'},entry={version:pkg.version,integrity:'sha512-'+Buffer.alloc(64,7).toString('base64')},lock={packages:{'node_modules/@teloa/cli':entry}}
 assert.doesNotThrow(()=>api.verifyRegistryInstall(pkg,lock,pkg.version))
 assert.throws(()=>api.verifyRegistryInstall({...pkg,name:'other'},lock,pkg.version),/注册表/)
 assert.throws(()=>api.verifyRegistryInstall(pkg,{packages:{'node_modules/@teloa/cli':{...entry,integrity:'none'}}},pkg.version),/完整性/)
 assert.throws(()=>api.verifyRegistryInstall(pkg,lock,'latest'),/版本/)
})
test('已切换版本但仍在维护中时，不把再次请求同版本报告为升级完成',async()=>{
 const state={version:'0.2.0-alpha.4',phase:'maintenance',layout:{instanceRoot:'/tmp/teloa-upgrade-test/instances/0.2.0-alpha.4'}}
 let downloads=0
 await assert.rejects(api.upgradeInstall(state,state.version,async()=>{downloads++;throw Error('不能下载')}),/维护状态[\s\S]*upgrade\.json[\s\S]*专用备份不能用普通restore/)
 assert.equal(downloads,0)
 assert.equal(state.phase,'maintenance')
})
test('正常同版本请求保持幂等，不下载或改写安装状态',async()=>{
 for(const phase of ['ready','stopped']){
  const state={version:'0.2.0-alpha.4',phase}
  const result=await api.upgradeInstall(state,state.version,async()=>{throw Error('不能下载')})
  assert.equal(result,state)
 }
})
test('明确升级到当前命令包自身版本时以该包为候选，其他版本仍从注册表取得',async()=>{
 assert.equal(typeof api.releaseSource,'function')
 const cli={version:'0.2.0-beta.3',root:'/tmp/teloa-command/node_modules/@teloa/cli'}
 assert.equal(await api.releaseSource('0.2.0-beta.3',cli)({},'0.2.0-beta.3'),cli.root)
 assert.equal(api.releaseSource('0.2.0-beta.4',cli),api.fetchRelease)
 assert.equal(api.releaseSource('0.2.0-alpha.7',cli),api.fetchRelease)
})
test('本地命令包候选与注册表候选一样经过版本与数据兼容检查，不匹配时不 stage、不备份',async()=>{
 const {mkdtemp,mkdir,writeFile,rm,access}=await import('node:fs/promises'),{join}=await import('node:path'),{tmpdir}=await import('node:os')
 const root=await mkdtemp(join(tmpdir(),'teloa-upgrade-source-'))
 try{
  const home=join(root,'home'),current=join(root,'current')
  await mkdir(current,{recursive:true});await writeFile(join(current,'release-manifest.json'),JSON.stringify({...release,version:'0.2.0-beta.2'}))
  const state={version:'0.2.0-beta.2',phase:'stopped',layout:{home,releaseRoot:current,instanceRoot:join(home,'instances/default'),runtimeRoot:join(home,'instances/default/runtime'),workspaceRoot:join(home,'workspaces/default')}}
  for(const [name,manifest,error] of [['data',{version:'0.2.0-beta.3',dataVersion:99,compatibleDataVersions:[99]},/数据兼容性/],['version',{version:'0.2.0-beta.4'},/数据兼容性/]] as const){
   const candidate=join(root,name);await mkdir(candidate,{recursive:true})
   await writeFile(join(candidate,'release-manifest.json'),JSON.stringify({...release,...manifest}))
   await assert.rejects(api.upgradeInstall(state,'0.2.0-beta.3',api.releaseSource('0.2.0-beta.3',{version:'0.2.0-beta.3',root:candidate})),error)
  }
  await assert.rejects(access(join(home,'releases/0.2.0-beta.3')),{code:'ENOENT'})
  await assert.rejects(access(home+'.backups'),{code:'ENOENT'})
 }finally{await rm(root,{recursive:true,force:true})}
})
test('upgrade 命令把当前命令包版本与包根交给候选选择',async()=>{
 const {readFile}=await import('node:fs/promises')
 const source=await readFile(new URL('../src/bin.ts',import.meta.url),'utf8')
 assert.match(source,/upgradeInstall\(state,String\(options\.to\),releaseSource\(String\(options\.to\),\{version:pkg\.version,root:programRoot\}\)\)/)
 assert.match(source,/state\.version!==pkg\.version\)console\.error\(/,'版本提示走 stderr，不影响 stdout 解析')
})
test('只有显式升级把一次性计划重启回执交给新宿主；普通启动清除调用者 shell 中的同名值',async()=>{
 const {serviceEnvironment}=await import('../src/service.ts'),runtime=await import('../../../scripts/runtime/profile.mjs') as any,id='8f0c2a52-5b8e-4f0e-9c1d-2a3b4c5d6e7f'
 const inherited=runtime.runtimeEnvironment({programRoot:'/app',dshHome:'/d',runtimeRoot:'/r',workspaceRoot:'/w',profileName:'teloa'},{PATH:'/tools',TELOA_PLANNED_RESTART:'0e4f8a1c-1111-4222-8333-944455556666'})
 assert.equal(serviceEnvironment(inherited).TELOA_PLANNED_RESTART,undefined,'普通启动不沿用 shell 中的回执')
 assert.equal(serviceEnvironment(inherited,id).TELOA_PLANNED_RESTART,id)
 assert.equal(inherited.TELOA_PLANNED_RESTART,'0e4f8a1c-1111-4222-8333-944455556666','不改调用方的环境对象')
 // supervisor 用同一 runtimeEnvironment 组装宿主环境，必须转交回执。
 assert.equal(runtime.runtimeEnvironment({programRoot:'/app',dshHome:'/d',runtimeRoot:'/r',workspaceRoot:'/w',profileName:'teloa'},serviceEnvironment(inherited,id)).TELOA_PLANNED_RESTART,id)
 // upgradeInstall 需要真实发行包、备份与数据库才能走到 startService，这里只核对它把本次 restartId 交给启动。
 const {readFile}=await import('node:fs/promises'),upgrade=await readFile(new URL('../src/upgrade.ts',import.meta.url),'utf8')
 assert.match(upgrade,/startService\(\{\.\.\.next,phase:'stopped'\},\{plannedRestartId:restartId\}\)/)
})

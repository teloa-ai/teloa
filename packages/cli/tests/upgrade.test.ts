import assert from 'node:assert/strict'
import test from 'node:test'
const api=await import('../src/upgrade.ts').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return {};throw error}) as any
const release={schema:'teloa.release/v1',version:'0.2.0-alpha.3',dshVersion:'0.1.6-alpha.1',dataVersion:1,compatibleDataVersions:[1],files:[]}
test('仅放行已验收的数据版本，不将兼容读取等同于可逆迁移',()=>{
 assert.equal(typeof api.canUseData,'function')
 assert.equal(api.canUseData(release,1),true)
 assert.equal(api.canUseData(release,2),false)
 assert.equal(api.canUseData({...release,dataVersion:2,compatibleDataVersions:[1,2]},1),false)
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
 await assert.rejects(api.upgradeInstall(state,state.version,async()=>{downloads++;throw Error('不能下载')}),/升级尚未完成[\s\S]*upgrade\.json[\s\S]*恢复/)
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

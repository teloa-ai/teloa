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

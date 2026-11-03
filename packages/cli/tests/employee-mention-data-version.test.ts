import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {canUseData,canUpgradeData,dataVersionMetadata,supportedDataVersion} from '../src/data-version.ts'

test('每轮员工身份及权限语义以data8隔离，旧数据只经明确备份升级',()=>{
 const current=dataVersionMetadata.dataVersion;assert.ok(current>=8)
 assert.deepEqual(dataVersionMetadata.compatibleDataVersions,[current])
 assert.equal(canUseData(dataVersionMetadata,current),true)
 for(let version=1;version<current;version++){
  assert.equal(canUseData(dataVersionMetadata,version),false)
  assert.equal(canUpgradeData(dataVersionMetadata,version),true)
  assert.equal(canUseData({dataVersion:version,compatibleDataVersions:[version,current]},current),false)
  assert.equal(canUpgradeData({dataVersion:version,compatibleDataVersions:[version,current]},current),false)
 }
 assert.equal(supportedDataVersion(current+1),false)
 assert.equal(canUpgradeData({dataVersion:current+1,compatibleDataVersions:[current+1]},current),false)
})

test('实际冻结110读取器拒绝data8，不能把员工父会话降为普通本人权限继续',async t=>{
 const fixture=new URL('./fixtures/data7-employee-mention/',import.meta.url)
 const proof=JSON.parse(await readFile(new URL('provenance.json',fixture),'utf8'))
 assert.equal(proof.version,'0.2.86');assert.equal(proof.dataVersion,7)
 const guard=await readFile(new URL(proof.sharedActualGuardFixture,fixture))
 const metadata=await readFile(new URL('data-version.json',fixture))
 const hash=(value:Buffer)=>createHash('sha256').update(value).digest('hex')
 assert.equal(hash(guard),proof.guardSha256);assert.equal(hash(metadata),proof.metadataSha256)
 const root=await mkdtemp(join(tmpdir(),'teloa-employee-data7-reader-'))
 t.after(()=>rm(root,{recursive:true,force:true}))
 await writeFile(join(root,'data-version.mjs'),guard)
 await writeFile(join(root,'data-version.json'),metadata)
 const old=await import(pathToFileURL(join(root,'data-version.mjs')).href) as typeof import('../src/data-version.ts')
 assert.equal(old.canUseData(old.dataVersionMetadata,7),true)
 assert.equal(old.supportedDataVersion(8),false)
 assert.equal(old.canUseData({...old.dataVersionMetadata,compatibleDataVersions:[7,8]},8),false)
 assert.equal(old.canUpgradeData(dataVersionMetadata,7),false)
 assert.equal(old.canUpgradeData(old.dataVersionMetadata,8),false)
})

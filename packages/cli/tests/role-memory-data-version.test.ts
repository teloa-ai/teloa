import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {canUseData,canUpgradeData,supportedDataVersion,dataVersionMetadata} from '../src/data-version.ts'

test('历史偏好语义data6：1..5 均需显式备份迁移，旧迁移边和精确恢复仍保留',()=>{
 const data6={dataVersion:6,compatibleDataVersions:[6]}
 assert.equal(canUseData(data6,6),true)
 for(const version of [1,2,3,4,5]){
  assert.equal(canUseData(data6,version),false)
  assert.equal(canUpgradeData(data6,version),true)
  assert.equal(canUseData({dataVersion:version,compatibleDataVersions:[version]},version),true,'原版本备份仍须使用同数据版本发行恢复')
  assert.equal(canUseData({dataVersion:version,compatibleDataVersions:[version,6]},6),false)
  assert.equal(canUpgradeData({dataVersion:version,compatibleDataVersions:[version,6]},6),false)
 }
 for(const version of [1,2,3,4])assert.equal(canUpgradeData({dataVersion:5,compatibleDataVersions:[5]},version),true)
 const future=dataVersionMetadata.dataVersion+1;assert.equal(supportedDataVersion(future),false);assert.equal(canUpgradeData({dataVersion:future,compatibleDataVersions:[future]},6),false)
})

test('原官方 guard 配旧 data5 元数据明确拒绝 data6，不能借兼容列表读取新偏好',async t=>{
 const root=await mkdtemp(join(tmpdir(),'teloa-data5-preference-reader-'));t.after(()=>rm(root,{recursive:true,force:true}))
 // guard 算法未改；同一份官方源码配原 data5 元数据，不另写模拟判断函数。
 await writeFile(join(root,'reader.ts'),await readFile(new URL('../src/data-version.ts',import.meta.url)))
 await writeFile(join(root,'data-version.json'),JSON.stringify({schema:'teloa.data-version/v1',dataVersion:5,compatibleDataVersions:[5],migrations:[{from:1,to:2},{from:1,to:3},{from:2,to:3},{from:1,to:4},{from:2,to:4},{from:3,to:4},{from:1,to:5},{from:2,to:5},{from:3,to:5},{from:4,to:5}]}))
 const old=await import(pathToFileURL(join(root,'reader.ts')).href) as typeof import('../src/data-version.ts')
 assert.equal(old.supportedDataVersion(6),false)
 assert.equal(old.canUseData({dataVersion:5,compatibleDataVersions:[5,6]},6),false)
 assert.equal(old.canUpgradeData({dataVersion:5,compatibleDataVersions:[5,6]},6),false)
 assert.equal(old.canUseData({dataVersion:5,compatibleDataVersions:[5]},5),true)
})

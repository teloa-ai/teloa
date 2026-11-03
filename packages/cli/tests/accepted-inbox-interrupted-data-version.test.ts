import test from 'node:test'
import assert from 'node:assert/strict'
import {frozenData15} from './frozen-data15-reader.ts'
import {frozenData14} from './frozen-data14-reader.ts'

test('输入发布前中断的新持久证据由data15保护，保留原91边且仅追加1..14到15',async t=>{
 const {old:{canUpgradeData,canUseData,dataVersionMetadata,supportedDataVersion}}=await frozenData15(t)
 const {old}=await frozenData14(t)
 assert.equal(old.dataVersionMetadata.dataVersion,14)
 assert.equal(old.dataVersionMetadata.migrations.length,91)
 assert.equal(dataVersionMetadata.dataVersion,15)
 assert.deepEqual(dataVersionMetadata.compatibleDataVersions,[15])
 assert.equal(dataVersionMetadata.migrations.length,105)
 assert.deepEqual(dataVersionMetadata.migrations.slice(0,91),old.dataVersionMetadata.migrations)
 assert.deepEqual(dataVersionMetadata.migrations.slice(91),Array.from({length:14},(_,i)=>({from:i+1,to:15})))
 for(let from=1;from<=14;from++){
  assert.equal(canUseData(dataVersionMetadata,from),false,'旧数据必须经备份和正常迁移')
  assert.equal(canUpgradeData(dataVersionMetadata,from),true)
 }
 assert.equal(canUseData(dataVersionMetadata,15),true)
 for(const version of [0,16]){
  assert.equal(supportedDataVersion(version),false)
  assert.equal(canUpgradeData(dataVersionMetadata,version),false)
 }
})

test('真实冻结data14读者拒绝15，兼容数组不能绕过读者能力或执行未来迁移',async t=>{
 const {old:{canUpgradeData,canUseData,dataVersionMetadata,supportedDataVersion}}=await frozenData15(t)
 const {old}=await frozenData14(t)
 assert.equal(old.canUseData(old.dataVersionMetadata,14),true)
 assert.equal(old.supportedDataVersion(15),false)
 assert.equal(old.canUseData(dataVersionMetadata,15),false)
 assert.equal(old.canUseData({...old.dataVersionMetadata,compatibleDataVersions:[14,15]},15),false)
 assert.equal(old.canUpgradeData(dataVersionMetadata,14),false)
 assert.equal(old.canUpgradeData(old.dataVersionMetadata,15),false)
 assert.equal(canUpgradeData(dataVersionMetadata,14),true)
})

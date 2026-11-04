import test from 'node:test'
import assert from 'node:assert/strict'
import {dataVersionMetadata,canUseData,canUpgradeData} from '../src/data-version.ts'
import {frozenData16} from './frozen-data16-reader.ts'

test('原生续作使用data17正常升级边界，旧data16发行不能读取新跨轮语义',async t=>{
 const {old}=await frozenData16(t)
 assert.equal(dataVersionMetadata.dataVersion,17)
 assert.deepEqual(dataVersionMetadata.compatibleDataVersions,[17])
 const release={dataVersion:17,compatibleDataVersions:[17]}
 assert.equal(canUpgradeData(release,16),true)
 assert.equal(canUseData(release,16),false)
 assert.equal(canUseData({dataVersion:16,compatibleDataVersions:[16]},17),false)
 assert.equal(canUpgradeData({dataVersion:16,compatibleDataVersions:[16]},17),false)
 for(let version=1;version<=16;version++)assert.ok(dataVersionMetadata.migrations.some(edge=>edge.from===version&&edge.to===17))
 assert.deepEqual(dataVersionMetadata.migrations.slice(0,120),old.dataVersionMetadata.migrations)
 assert.equal(old.canUseData(dataVersionMetadata,17),false)
 assert.equal(old.canUpgradeData(dataVersionMetadata,16),false)
 assert.equal(old.canUseData({...old.dataVersionMetadata,compatibleDataVersions:[16,17]},17),false)
})

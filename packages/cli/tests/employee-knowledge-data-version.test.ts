import test from 'node:test'
import assert from 'node:assert/strict'
import {canUpgradeData,canUseData,dataVersionMetadata,supportedDataVersion} from '../src/data-version.ts'
import {frozenData15} from './frozen-data15-reader.ts'

test('员工知识归档退役与会话预算由data16保护，保留105边再追加1..15到16',async t=>{
 const {old}=await frozenData15(t)
 assert.equal(old.dataVersionMetadata.dataVersion,15)
 assert.equal(old.dataVersionMetadata.migrations.length,105)
 assert.equal(dataVersionMetadata.dataVersion,16)
 assert.deepEqual(dataVersionMetadata.compatibleDataVersions,[16])
 assert.equal(dataVersionMetadata.migrations.length,120)
 assert.deepEqual(dataVersionMetadata.migrations.slice(0,105),old.dataVersionMetadata.migrations)
 assert.deepEqual(dataVersionMetadata.migrations.slice(105),Array.from({length:15},(_,i)=>({from:i+1,to:16})))
 for(let from=1;from<=15;from++){
  assert.equal(canUseData(dataVersionMetadata,from),false)
  assert.equal(canUpgradeData(dataVersionMetadata,from),true)
 }
 assert.equal(canUseData(dataVersionMetadata,16),true)
 for(const future of [0,17]){assert.equal(supportedDataVersion(future),false);assert.equal(canUpgradeData(dataVersionMetadata,future),false)}
})

test('真实冻结data15读者拒绝16，兼容数组与同代CLI版本不能绕过数据门',async t=>{
 const {old}=await frozenData15(t)
 assert.equal(old.canUseData(old.dataVersionMetadata,15),true)
 assert.equal(old.supportedDataVersion(16),false)
 assert.equal(old.canUseData(dataVersionMetadata,16),false)
 assert.equal(old.canUseData({...old.dataVersionMetadata,compatibleDataVersions:[15,16]},16),false)
 assert.equal(old.canUpgradeData(dataVersionMetadata,15),false)
 assert.equal(old.canUpgradeData(old.dataVersionMetadata,16),false)
 assert.equal(canUpgradeData(old.dataVersionMetadata,16),false,'新数据不能回到旧15，不以相同RC版本包装绕过')
})

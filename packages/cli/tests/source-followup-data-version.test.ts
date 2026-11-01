import assert from 'node:assert/strict'
import test from 'node:test'
import {canUpgradeData,canUseData} from '../src/data-version.ts'

test('同源核验typed输入只由数据4读者启动；旧数据仅允许经过明确迁移进入4',()=>{
 const current={dataVersion:4,compatibleDataVersions:[4]},old={dataVersion:3,compatibleDataVersions:[3,4]}
 assert.equal(canUseData(current,4),true)
 for(const source of [1,2,3]){
  assert.equal(canUseData(current,source),false,'迁移支持不能冒充直接兼容启动')
  assert.equal(canUpgradeData(current,source),true)
 }
 assert.equal(canUseData(old,4),false,'旧reader不能借compatible列表读含typed新输入的数据')
 assert.equal(canUpgradeData(old,4),false,'不能隐式降级数据4')
 assert.equal(canUpgradeData(current,5),false,'未知未来结构不得认领')
})

import test from 'node:test'
import assert from 'node:assert/strict'
import {canUpgradeData,canUseData,dataVersionMetadata} from '../src/data-version.ts'
const current={dataVersion:18,compatibleDataVersions:[18]}
test('独立群回复的消息证明分支使用18，不能交给旧17运行时读取',()=>{
 assert.equal(dataVersionMetadata.dataVersion,18)
 assert.deepEqual(dataVersionMetadata.compatibleDataVersions,[18])
 assert.equal(canUseData(current,18),true)
 assert.equal(canUseData(current,17),false)
 assert.equal(canUseData({dataVersion:17,compatibleDataVersions:[17]},18),false)
})
test('历史迁移声明保留，17到18须走有备份的升级而不是兼容读取或降级',()=>{
 for(let from=1;from<=17;from++)assert.equal(canUpgradeData(current,from),true,'历史版本 '+from)
 assert.equal(canUpgradeData(current,19),false)
 assert.equal(canUpgradeData({dataVersion:17,compatibleDataVersions:[17]},18),false)
 assert(dataVersionMetadata.migrations.some(row=>row.from===16&&row.to===17),'原迁移历史不回改')
})

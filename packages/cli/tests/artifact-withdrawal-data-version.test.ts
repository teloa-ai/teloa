import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {canUpgradeData,canUseData,dataVersionMetadata} from '../src/data-version.ts'

test('历史撤回读者只直接运行其数据5；历史1/2/3/4只可显式备份迁移，不能借兼容列表降级',()=>{
 assert.equal(canUseData(dataVersionMetadata,dataVersionMetadata.dataVersion),true,'实际发行元数据须允许自身数据版本；历史5只按匹配发行恢复')
 const next={dataVersion:5,compatibleDataVersions:[5]}
 for(const version of [1,2,3,4]){
  assert.equal(canUseData(next,version),false,'历史迁移支持不是无备份直接运行')
  assert.equal(canUpgradeData(next,version),true,'每个已支持历史版本须有明确直达5迁移边')
  assert.equal(canUseData({dataVersion:version,compatibleDataVersions:[version,5]},5),false)
  assert.equal(canUpgradeData({dataVersion:version,compatibleDataVersions:[version,5]},5),false)
 }
 assert.equal(canUseData(next,5),true)
 assert.equal(canUpgradeData(next,6),false)
})

test('既有data4官方读者用原同字节guard和历史元数据拒绝未来5，不理解新floor也不能接管',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'teloa-old-data-reader-'));t.after(()=>rm(directory,{recursive:true,force:true}))
 // 旧读者算法不另抄一份；本批不改原guard，配其已发行的data4元数据调用真实模块。
 const guard=await readFile(new URL('../src/data-version.ts',import.meta.url),'utf8')
 await writeFile(join(directory,'reader.ts'),guard)
 await writeFile(join(directory,'data-version.json'),JSON.stringify({schema:'teloa.data-version/v1',dataVersion:4,compatibleDataVersions:[4],migrations:[{from:1,to:2},{from:1,to:3},{from:2,to:3},{from:1,to:4},{from:2,to:4},{from:3,to:4}]}))
 const old=await import(pathToFileURL(join(directory,'reader.ts')).href) as typeof import('../src/data-version.ts')
 assert.equal(old.canUseData({dataVersion:4,compatibleDataVersions:[4]},4),true)
 assert.equal(old.supportedDataVersion(5),false)
 assert.equal(old.canUseData({dataVersion:4,compatibleDataVersions:[4,5]},5),false)
 assert.equal(old.canUpgradeData({dataVersion:4,compatibleDataVersions:[4,5]},5),false)
})

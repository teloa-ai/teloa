import {createHash} from 'node:crypto'
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'
import {frozenData11} from './frozen-data11-reader.ts'

test('同源核验typed输入只由数据4读者启动；旧数据仅允许经过明确迁移进入4',async t=>{
 const {dataVersionMetadata,canUseData,canUpgradeData}=await frozenData11(t)
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

test('error-recovery持久kind由正式data11保护，保留旧迁移边且旧10拒读11',async t=>{
 const {dataVersionMetadata,canUseData,canUpgradeData}=await frozenData11(t)
 const current={dataVersion:11,compatibleDataVersions:[11]},old={dataVersion:10,compatibleDataVersions:[10,11]}
 assert.equal(dataVersionMetadata.dataVersion,11);assert.deepEqual(dataVersionMetadata.compatibleDataVersions,[11]);assert.equal(canUseData(old,11),false);assert.equal(canUseData(current,11),true)
 for(let from=1;from<=10;from++){assert.equal(canUpgradeData(current,from),true);assert.equal(canUseData(current,from),false)}
 assert.equal(canUpgradeData(old,11),false);assert.equal(canUpgradeData(current,12),false)
})

test('actual signed137/data10 CLI真实拒读data11，允许正式10→11且不改旧工件',async t=>{
 const {dataVersionMetadata,canUseData,canUpgradeData}=await frozenData11(t)
 const fixture=new URL('./fixtures/data10-source-error-recovery/',import.meta.url),proof=JSON.parse(await readFile(new URL('provenance.json',fixture),'utf8')),root=await mkdtemp(join(tmpdir(),'teloa-data10-reader-'));t.after(()=>rm(root,{recursive:true,force:true}))
 for(const f of proof.files){const b=await readFile(new URL(f.path,fixture));assert.equal(b.length,f.bytes);assert.equal(createHash('sha256').update(b).digest('hex'),f.sha256);await writeFile(join(root,f.path==='data-version.js.txt'?'data-version.mjs':f.path),b)}
 const old=await import(pathToFileURL(join(root,'data-version.mjs')).href) as typeof import('../src/data-version.ts')
 assert.equal(old.dataVersionMetadata.dataVersion,10);assert.equal(old.canUseData(old.dataVersionMetadata,10),true);assert.equal(old.canUseData(dataVersionMetadata,11),false);assert.equal(old.canUseData({...old.dataVersionMetadata,compatibleDataVersions:[10,11]},11),false);assert.equal(old.canUpgradeData(dataVersionMetadata,10),false);assert.equal(canUpgradeData(dataVersionMetadata,10),true)
})

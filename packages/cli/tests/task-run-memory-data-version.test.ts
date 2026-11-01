import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {dataVersionMetadata,canUseData,canUpgradeData,supportedDataVersion} from '../src/data-version.ts'

test('本次经验选择的持久语义以data9保护，历史边保留且8只经正常备份升级',()=>{
 assert.equal(dataVersionMetadata.dataVersion,9);assert.deepEqual(dataVersionMetadata.compatibleDataVersions,[9])
 assert.equal(canUseData(dataVersionMetadata,9),true)
 for(let from=1;from<=8;from++){
  assert.equal(canUseData(dataVersionMetadata,from),false)
  assert.equal(canUpgradeData(dataVersionMetadata,from),true)
  assert.equal(canUseData({dataVersion:from,compatibleDataVersions:[from,9]},9),false)
 }
 assert.equal(supportedDataVersion(10),false)
 assert.equal(canUpgradeData({dataVersion:10,compatibleDataVersions:[10]},9),false)
})
test('实际冻结118/data8 CLI拒绝9，不能靠伪compatible或新manifest绕过',async t=>{
 const fixture=new URL('./fixtures/data8-memory-selection/',import.meta.url)
 const proof=JSON.parse(await readFile(new URL('provenance.json',fixture),'utf8')) as {candidate:number;dataVersion:number;files:{path:string;bytes:number;sha256:string}[]}
 assert.equal(proof.candidate,118);assert.equal(proof.dataVersion,8)
 const root=await mkdtemp(join(tmpdir(),'teloa-data8-memory-reader-'));t.after(()=>rm(root,{recursive:true,force:true}))
 for(const item of proof.files){
  const bytes=await readFile(new URL(item.path,fixture));assert.equal(bytes.length,item.bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),item.sha256)
  await writeFile(join(root,item.path==='data-version.js.txt'?'data-version.mjs':item.path),bytes)
 }
 const old=await import(pathToFileURL(join(root,'data-version.mjs')).href) as typeof import('../src/data-version.ts')
 assert.equal(old.canUseData(old.dataVersionMetadata,8),true)
 assert.equal(old.supportedDataVersion(9),false)
 assert.equal(old.canUseData({...old.dataVersionMetadata,compatibleDataVersions:[8,9]},9),false)
 assert.equal(old.canUseData(dataVersionMetadata,9),false)
 assert.equal(old.canUpgradeData(dataVersionMetadata,8),false)
 assert.equal(old.canUpgradeData(old.dataVersionMetadata,9),false)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {frozenData11} from './frozen-data11-reader.ts'

test('149 data10证据由data11继续保护并保留全部历史边；actual135/data9 CLI拒绝新库而不是伪兼容回读',async t=>{
 const {dataVersionMetadata,canUseData,canUpgradeData}=await frozenData11(t)
 assert.equal(dataVersionMetadata.dataVersion,11);assert.deepEqual(dataVersionMetadata.compatibleDataVersions,[11])
 for(let from=1;from<=10;from++){assert.equal(canUseData(dataVersionMetadata,from),false);assert.equal(canUpgradeData(dataVersionMetadata,from),true)}
 assert.equal(canUseData(dataVersionMetadata,11),true)
 const fixture=new URL('./fixtures/data9-inbox-error/',import.meta.url),proof=JSON.parse(await readFile(new URL('provenance.json',fixture),'utf8'))
 const root=await mkdtemp(join(tmpdir(),'teloa-old-data9-reader-'));t.after(()=>rm(root,{recursive:true,force:true}))
 for(const f of proof.files){const b=await readFile(new URL(f.path,fixture));assert.equal(b.length,f.bytes);assert.equal(createHash('sha256').update(b).digest('hex'),f.sha256);await writeFile(join(root,f.path==='data-version.js.txt'?'data-version.mjs':f.path),b)}
 const old=await import(pathToFileURL(join(root,'data-version.mjs')).href) as typeof import('../src/data-version.ts')
 assert.equal(old.canUseData(old.dataVersionMetadata,9),true)
 assert.equal(old.canUseData(dataVersionMetadata,10),false)
 assert.equal(old.canUseData({...old.dataVersionMetadata,compatibleDataVersions:[9,10]},10),false)
 assert.equal(old.canUpgradeData(dataVersionMetadata,9),false)
})

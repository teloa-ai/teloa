import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {canUseData,canUpgradeData} from '../src/data-version.ts'

test('追加维护周期审计由data13保护：10/12须正式迁移，冻结data12读者仍拒绝13',async t=>{
 const dataVersionMetadata=JSON.parse(await readFile(new URL('./fixtures/data13-stopped-continuation/data-version.json',import.meta.url),'utf8'))
 assert.equal(dataVersionMetadata.dataVersion,13);assert.deepEqual(dataVersionMetadata.compatibleDataVersions,[13])
 for(const from of [10,12]){assert.equal(canUseData(dataVersionMetadata,from),false);assert.equal(canUpgradeData(dataVersionMetadata,from),true)}
 const fixture=new URL('./fixtures/data12-prepared-maintenance-cycles/',import.meta.url),proof=JSON.parse(await readFile(new URL('provenance.json',fixture),'utf8')),root=await mkdtemp(join(tmpdir(),'teloa-data12-maintenance-reader-'))
 t.after(()=>rm(root,{recursive:true,force:true}))
 for(const file of proof.files){const bytes=await readFile(new URL(file.path,fixture));assert.equal(bytes.length,file.bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),file.sha256);await writeFile(join(root,file.path==='data-version.js.txt'?'data-version.mjs':file.path),bytes)}
 const old=await import(pathToFileURL(join(root,'data-version.mjs')).href) as typeof import('../src/data-version.ts')
 assert.equal(old.dataVersionMetadata.dataVersion,12);assert.equal(old.canUseData(old.dataVersionMetadata,12),true)
 assert.equal(old.canUseData(dataVersionMetadata,13),false);assert.equal(old.canUpgradeData(dataVersionMetadata,12),false)
 assert.equal(old.canUseData({...old.dataVersionMetadata,compatibleDataVersions:[12,13]},13),false,'不能由兼容列表绕过读者版本')
})

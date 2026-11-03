import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {readRunAnalysisScope,runAnalysisNotice,ownerTaskMemoryAnalysisNotice} from '../../contract/src/run-analysis-scope.ts'
import {dataVersionMetadata,canUseData,canUpgradeData,supportedDataVersion} from '../src/data-version.ts'

const fixture=new URL('./fixtures/data6-owner-task-analysis/',import.meta.url)
async function frozen(name:string):Promise<Buffer>{
 const proof=JSON.parse(await readFile(new URL('provenance.json',fixture),'utf8')) as {version:string;dataVersion:number;files:{path:string;sha256:string;bytes:number}[]}
 assert.equal(proof.version,'0.2.85');assert.equal(proof.dataVersion,6)
 const pin=proof.files.find(row=>row.path===name);assert.ok(pin)
 const bytes=await readFile(new URL(name,fixture))
 assert.equal(bytes.length,pin.bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),pin.sha256)
 return bytes
}
test('本人分身候选data7历史迁移保留；当前发行仍只直接读自己的数据边界',()=>{
 const data7={dataVersion:7,compatibleDataVersions:[7]}
 assert.equal(canUseData(data7,7),true)
 for(const from of [1,2,3,4,5,6]){
  assert.equal(canUseData(data7,from),false);assert.equal(canUpgradeData(data7,from),true)
  assert.equal(canUseData({dataVersion:from,compatibleDataVersions:[from]},from),true,'历史备份只按对应发行恢复')
  assert.equal(canUseData({dataVersion:from,compatibleDataVersions:[from,7]},7),false)
 }
 const current=dataVersionMetadata.dataVersion;assert.ok(current>=7)
 assert.deepEqual(dataVersionMetadata.compatibleDataVersions,[current]);assert.equal(canUseData(dataVersionMetadata,current),true)
 for(let from=1;from<current;from++){assert.equal(canUseData(dataVersionMetadata,from),false);assert.equal(canUpgradeData(dataVersionMetadata,from),true)}
 assert.equal(supportedDataVersion(current+1),false);assert.equal(canUpgradeData({dataVersion:current+1,compatibleDataVersions:[current+1]},current),false)
})
test('实际冻结109读取器证明新scope不兼容data6；冻结CLI元数据在读取前拒绝data7',async t=>{
 const root=await mkdtemp(join(tmpdir(),'teloa-owner-task-data6-reader-'));t.after(()=>rm(root,{recursive:true,force:true}))
 await writeFile(join(root,'package.json'),'{"type":"module"}')
 await writeFile(join(root,'data-version.mjs'),await frozen('data-version.js.txt'))
 await writeFile(join(root,'data-version.json'),await frozen('data-version.json'))
 const old=await import(pathToFileURL(join(root,'data-version.mjs')).href) as typeof import('../src/data-version.ts')
 assert.equal(old.canUseData(old.dataVersionMetadata,6),true)
 assert.equal(old.supportedDataVersion(7),false)
 assert.equal(old.canUseData({dataVersion:6,compatibleDataVersions:[6,7]},7),false)
 assert.equal(old.canUpgradeData({dataVersion:7,compatibleDataVersions:[7]},6),false)
 assert.equal(old.canUpgradeData({dataVersion:6,compatibleDataVersions:[6,7]},7),false)
 // 原发行读取器正文逐字冻结；仅把五个相对 helper import 绑定到同名真实生产源，不另写宽松解析器。
 const source=(await frozen('run-analysis-scope.js.txt')).toString().replace(/from "\.\/([-a-z]+)\.js"/g,(_all,name:string)=>`from ${JSON.stringify(new URL('../../contract/src/'+name+'.ts',import.meta.url).href)}`)
 await writeFile(join(root,'scope-reader.mjs'),source)
 const reader=await import(pathToFileURL(join(root,'scope-reader.mjs')).href) as {readRunAnalysisScope:typeof readRunAnalysisScope}
 const original={schema:'teloa.run-analysis-scope/v1',kind:'owner-task-derived',ownerId:'owner',taskId:randomUUID(),taskVersion:1,roleId:randomUUID(),roleVersion:1,requestId:randomUUID(),sourceDigest:'a'.repeat(64),contextSha256:'b'.repeat(64),lineageSha256:'c'.repeat(64),materialsSha256:'d'.repeat(64),knowledgeSha256:'e'.repeat(64),controls:[{id:randomUUID(),generation:1}],files:[],notice:runAnalysisNotice}
 const candidate={...original,selfAuthorizedTools:['teloa_role_memory_propose'],notice:ownerTaskMemoryAnalysisNotice}
 assert.deepEqual(reader.readRunAnalysisScope(original),readRunAnalysisScope(original))
 assert.throws(()=>reader.readRunAnalysisScope(candidate),{code:'teloa/invalid-input'})
 assert.throws(()=>reader.readRunAnalysisScope({...original,notice:ownerTaskMemoryAnalysisNotice}),{code:'teloa/invalid-input'})
 assert.throws(()=>reader.readRunAnalysisScope({...candidate,notice:runAnalysisNotice}),{code:'teloa/invalid-input'})
 assert.deepEqual(readRunAnalysisScope(candidate),candidate)
})

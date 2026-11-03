import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {frozenData14} from './frozen-data14-reader.ts'
import {readTaskRunSourceFollowup,errorRecoveryNotice,stoppedContinuationNotice} from '../../contract/src/index.ts'

const fixture=new URL('./fixtures/data13-stopped-continuation/',import.meta.url)
async function frozen13(t:{after:(action:()=>unknown)=>void}){
 const proof=JSON.parse(await readFile(new URL('provenance.json',fixture),'utf8'))
 const root=await mkdtemp(join(tmpdir(),'teloa-data13-stopped-reader-'))
 t.after(()=>rm(root,{recursive:true,force:true}))
 await writeFile(join(root,'package.json'),JSON.stringify({type:'module'}))
 for(const file of proof.files){
  const bytes=await readFile(new URL(file.path,fixture))
  assert.equal(bytes.length,file.bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),file.sha256)
  await writeFile(join(root,file.path.replace('.js.txt','.js')),bytes)
 }
 const old=await import(pathToFileURL(join(root,'data-version.js')).href) as typeof import('../src/data-version.ts')
 return {root,old}
}

test('停止后新持久意图由data14保护，原78条迁移边完整保留且只追加1..13→14',async t=>{
 const {old:{canUpgradeData,canUseData,dataVersionMetadata,supportedDataVersion}}=await frozenData14(t)
 const {old}=await frozen13(t)
 assert.equal(old.dataVersionMetadata.dataVersion,13);assert.equal(old.dataVersionMetadata.migrations.length,78)
 assert.equal(dataVersionMetadata.dataVersion,14);assert.deepEqual(dataVersionMetadata.compatibleDataVersions,[14])
 assert.equal(dataVersionMetadata.migrations.length,91)
 assert.deepEqual(dataVersionMetadata.migrations.slice(0,78),old.dataVersionMetadata.migrations)
 assert.deepEqual(dataVersionMetadata.migrations.slice(78),Array.from({length:13},(_,i)=>({from:i+1,to:14})))
 assert.equal(canUseData(dataVersionMetadata,14),true)
 for(let from=1;from<=13;from++){
  assert.equal(canUseData(dataVersionMetadata,from),false,'历史数据须正式备份迁移，不能直接当14启动')
  assert.equal(canUpgradeData(dataVersionMetadata,from),true)
 }
 assert.equal(supportedDataVersion(15),false);assert.equal(canUpgradeData(dataVersionMetadata,15),false)
 assert.equal(canUpgradeData(dataVersionMetadata,0),false)
})

test('实际冻结data13 CLI拒绝读取或降级data14，compatible数组不能授予新读者能力',async t=>{
 const {old:{canUpgradeData,dataVersionMetadata}}=await frozenData14(t)
 const {old}=await frozen13(t)
 assert.equal(old.canUseData(old.dataVersionMetadata,13),true)
 assert.equal(old.canUseData(dataVersionMetadata,14),false)
 assert.equal(old.canUseData({...old.dataVersionMetadata,compatibleDataVersions:[13,14]},14),false)
 assert.equal(old.canUpgradeData(dataVersionMetadata,13),false,'旧二进制不能执行目标14迁移')
 assert.equal(old.canUpgradeData(old.dataVersionMetadata,14),false,'旧13不能认领14数据做降级')
 assert.equal(canUpgradeData(dataVersionMetadata,13),true)
})

test('冻结data13 closed leaf拒绝新18字段；data14 reader保留停止审计并仍读旧17字段',async t=>{
 const {old:{canUseData,dataVersionMetadata}}=await frozenData14(t)
 const {root,old}=await frozen13(t)
 // 只共享本补丁未改变的基础reader；kind/字段/notice白名单来自已逐字冻结的13 leaf。
 await writeFile(join(root,'index.js'),`export {WorkError,taskInput,businessObjectReference} from ${JSON.stringify(new URL('../../contract/src/index.ts',import.meta.url).href)};`)
 await writeFile(join(root,'task-run-submission.js'),`export {readTaskRunSubmissionDisposition} from ${JSON.stringify(new URL('../../contract/src/task-run-submission.ts',import.meta.url).href)};`)
 const closed=await import(pathToFileURL(join(root,'task-run-source-followup.js')).href) as {readTaskRunSourceFollowup:typeof readTaskRunSourceFollowup}
 const binding={schema:'teloa.task-run-source-followup/v1',kind:'stopped-continuation',requestId:randomUUID(),taskId:randomUUID(),taskVersion:19,sessionId:'same-original-session',originalRunId:randomUUID(),originalNativeRequestId:randomUUID(),originalInputSha256:'a'.repeat(64),originalEvidenceSha256:'b'.repeat(64),originalStopRequestedAt:'2026-11-02T20:21:47.715Z',sourceUpdateId:randomUUID(),sourceTaskVersion:15,sourceEventId:randomUUID(),reference:{scope:'SOC',type:'alert',id:'AL-01',version:4,snapshotHash:'c'.repeat(64)},instruction:'本人新续办；不重启旧执行、不重放旧输入。',confirmedAt:'2026-11-03T00:00:00.000Z',notice:stoppedContinuationNotice}
 const persisted=JSON.parse(JSON.stringify({binding,input_text:JSON.stringify({sourceFollowup:binding}),request_spec:{sourceFollowup:binding}}))
 assert.equal(Object.keys(persisted.binding).length,18)
 assert.equal(old.canUseData(dataVersionMetadata,14),false,'先在安装/版本边界拒绝，不把18字段送给旧reader')
 assert.throws(()=>closed.readTaskRunSourceFollowup(persisted.binding))
 assert.equal(canUseData(dataVersionMetadata,14),true)
 for(const value of [persisted.binding,JSON.parse(persisted.input_text).sourceFollowup,persisted.request_spec.sourceFollowup])assert.deepEqual(readTaskRunSourceFollowup(value),binding)
 const {originalStopRequestedAt:_stop,...legacy}=binding
 const oldBinding={...legacy,kind:'error-recovery',notice:errorRecoveryNotice}
 assert.equal(Object.keys(oldBinding).length,17)
 assert.deepEqual(closed.readTaskRunSourceFollowup(oldBinding),oldBinding)
 assert.deepEqual(readTaskRunSourceFollowup(oldBinding),oldBinding,'迁移不改写旧绑定/输入/来源或删除审计')
})

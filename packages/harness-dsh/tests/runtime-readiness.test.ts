import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {FileConversationRepository} from '@teloa/backend'
import {WorkError} from '@teloa/contract'
import {createRuntimeReadinessHandler} from '../src/runtime-readiness.ts'

test('真实目录元数据就绪检查保持原字节，不读取运行详情或产生新会话',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'teloa-readiness-'));t.after(()=>rm(directory,{recursive:true,force:true}))
 const path=join(directory,'conversations.json'),repository=new FileConversationRepository(path)
 await repository.write([]);const before=await readFile(path),calls:string[]=[]
 const read=createRuntimeReadinessHandler('owner',{database:async()=>{calls.push('database')},conversations:async()=>{calls.push('conversations');return repository.read()}})
 assert.deepEqual(await read({},AbortSignal.timeout(5000)),{schema:'teloa.runtime-readiness/v1',ready:true})
 assert.deepEqual(calls,['database','conversations']);assert.deepEqual(await readFile(path),before)
 await writeFile(path,'{"schema":"wrong","rows":[]}')
 await assert.rejects(read({},AbortSignal.timeout(5000)),{code:'teloa/storage-corrupt'})
 assert.equal(await readFile(path,'utf8'),'{"schema":"wrong","rows":[]}')
})
test('数据库未就绪、无可信主体或未知输入均不能返回健康',async()=>{
 let metadataReads=0
 const ports={database:async()=>{throw new WorkError('teloa/storage-unavailable','数据库不可用')},conversations:async()=>{metadataReads++;return []}}
 await assert.rejects(createRuntimeReadinessHandler('owner',ports)({},AbortSignal.timeout(5000)),{code:'teloa/storage-unavailable'})
 await assert.rejects(createRuntimeReadinessHandler('',ports)({},AbortSignal.timeout(5000)),{code:'teloa/forbidden'})
 await assert.rejects(createRuntimeReadinessHandler('owner',ports)({includeRuns:false},AbortSignal.timeout(5000)),{code:'teloa/invalid-input'})
 assert.equal(metadataReads,0)
})
test('取消的健康检查不继续读存储，也不把取消返回为就绪',async()=>{
 let begin!:()=>void,release!:()=>void,metadataReads=0,databaseReads=0
 const started=new Promise<void>(resolve=>{begin=resolve}),gate=new Promise<void>(resolve=>{release=resolve})
 const controller=new AbortController(),read=createRuntimeReadinessHandler('owner',{database:async()=>{databaseReads++;begin();await gate},conversations:async()=>{metadataReads++;return []}})
 const pending=read({},controller.signal);await started;controller.abort();release()
 await assert.rejects(pending,{name:'AbortError'});assert.equal(metadataReads,0);assert.equal(databaseReads,1)
 await assert.rejects(read({},controller.signal),{name:'AbortError'});assert.equal(databaseReads,1)
})

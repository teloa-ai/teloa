import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {SessionId} from '@deepseek-ai/dsh-session'
import {nativeProviderKernel} from './fixtures/native-input-provider.ts'

test('Teloa 与独立 DSH 使用同一工作目录时，会话仅属于各自持久目录',async t=>{
 const root=await mkdtemp(join(tmpdir(),'teloa-dsh-session-isolation-'))
 t.after(()=>rm(root,{recursive:true,force:true}))
 const teloa=await nativeProviderKernel(t),dsh=await nativeProviderKernel(t),workspace=join(root,'same-workspace')
 for(const [host,home,id] of [[teloa,join(root,'teloa'),SessionId('teloa-only')],[dsh,join(root,'native-dsh'),SessionId('native-only')]] as const){
  await host.ctx.plugin(host.persistencePackage,{root:join(home,'sessions'),compression:'none'})
  const header={...host.sessionPackage.Session.create(id).header,cwd:workspace}
  const writer=await host.ctx.sessionPersistence.create(header,{inheritedEventCount:host.sessionPackage.SessionLogOffset(0)})
  try{await writer.flush()}finally{await writer.close()}
 }
 assert.deepEqual((await teloa.ctx.sessionPersistence.list()).map(row=>row.header.id),['teloa-only'])
 assert.deepEqual((await dsh.ctx.sessionPersistence.list()).map(row=>row.header.id),['native-only'])
 assert.equal(await teloa.ctx.sessionPersistence.stat(SessionId('native-only')),undefined)
 assert.equal(await dsh.ctx.sessionPersistence.stat(SessionId('teloa-only')),undefined)
 await assert.rejects(teloa.ctx.sessionPersistence.open(SessionId('native-only'),'read'),{name:'SessionPersistenceNotFoundError'})
 await assert.rejects(dsh.ctx.sessionPersistence.open(SessionId('teloa-only'),'read'),{name:'SessionPersistenceNotFoundError'})
})

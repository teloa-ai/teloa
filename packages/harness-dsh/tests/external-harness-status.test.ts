import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createRequire} from 'node:module'
import {Context} from '@deepseek-ai/cordis'

test('真实 DSH storageDomain 保存外部状态，重启只将未决工作标未知，账号不串读',{timeout:10000},async t=>{
 let api:any;try{api=await import('../src/external-harness-status.ts')}catch(error){if((error as NodeJS.ErrnoException).code!=='ERR_MODULE_NOT_FOUND')throw error;api={}}
 assert.equal(typeof api.openExternalHarnessStatus,'function')
 const root=await mkdtemp(join(tmpdir(),'teloa-external-state-')),require=createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json'))
 const ctx=new Context();t.after(async()=>{await ctx.fiber.dispose();await rm(root,{recursive:true,force:true})})
 await ctx.plugin((await import(require.resolve('@deepseek-ai/dsh-storage'))).Storage)
 await ctx.plugin(await import(require.resolve('@deepseek-ai/dsh-storage-json')),{root})
 await ctx.plugin(await import(require.resolve('@deepseek-ai/dsh-storage-domain')),{backend:'json'})
 const store=await api.openExternalHarnessStatus(ctx,'owner')
 const identity={sessionId:'parent',runId:null,provider:'codex',runtimeId:'runtime-1',requestId:'request',reservationId:'reservation',workspaceRoot:root}
 await store.save({...identity,status:'reserved'})
 await store.save({...identity,activationId:'external-id',status:'running'})
 assert.equal(store.list('parent','runtime-1')[0].status,'running')
 await assert.rejects(store.save({...identity,activationId:'another-id',status:'running'}),/身份/)
 await store.save({...identity,reservationId:'terminal',activationId:'done-id',status:'completed'})
 await store.close()
 const cold=await api.openExternalHarnessStatus(ctx,'owner'),rows=cold.list('parent','runtime-2')
 assert.equal(rows.find((row:any)=>row.activationId==='external-id').status,'unknown')
 assert.equal(rows.find((row:any)=>row.activationId==='done-id').status,'completed')
 await assert.rejects(cold.save({...identity,reservationId:'terminal',activationId:'done-id',status:'running'}),/终态/)
 await cold.close()
 const other=await api.openExternalHarnessStatus(ctx,'other-owner');assert.deepEqual(other.list('parent','runtime-2'),[]);await other.close()
})

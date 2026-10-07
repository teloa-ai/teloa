import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,realpath,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Context} from '@deepseek-ai/cordis'
import {SessionId,SessionSeq} from '@deepseek-ai/dsh-session'
import {createUserMessage,LlmAdapter} from '@deepseek-ai/dsh-llm'
import {nativeProviderKernel} from './fixtures/native-input-provider.ts'

class NoModel extends LlmAdapter{
 calls=0
 async resolveModel(provider:string,model:string){return {provider,id:model,name:model,inputModalities:['text'] as const}}
 async *stream():AsyncIterable<never>{this.calls++;throw Error('恢复尚未完成不得派发模型')}
}

for(const window of ['session-publish','agent-publish','publish-microtask'] as const){
 test(`恢复在${window}撤销时保留原pending，不能写成用户取消`,{timeout:10000},async t=>{
  const f=await nativeProviderKernel(t),root=await realpath(await mkdtemp(join(tmpdir(),'teloa-restore-preservation-'))),model=new NoModel()
  t.after(()=>rm(root,{recursive:true,force:true}))
  f.ctx.llm.registerAdapter(['controlled'],model)
  await f.ctx.plugin(f.persistencePackage.default,{root,compression:'none'})
  await f.ctx.plugin(f.loopPackage.AgentLoop,{agents:[]})
  const loop=f.ctx.get('agentLoop') as unknown as {requireRestoreAdmission():void;installRestoreAdmission(policy:()=>unknown):void}
  let current=true
  loop.requireRestoreAdmission()
  loop.installRestoreAdmission(()=>Object.freeze({assertCurrent(){if(!current)throw Error('checkpoint revoked')}}))
  const id=SessionId('preserve-'+window),message=createUserMessage({source:{kind:'user'},content:[{type:'text',text:'已落盘的工作'}]})
  const cold=f.sessionPackage.Session.create(id,[{type:'agent/inbox/spliced',seq:SessionSeq(0),time:1,data:{target:'next-turn',start:0,removedCount:0,inserted:[message]}}])
  const writer=await f.ctx.sessionPersistence.create(cold.header)
  await writer.append(cold.snapshotEvents());await writer.flush();await writer.close()
  if(window==='session-publish')f.ctx.on('session/created',()=>{current=false})
  else f.ctx.on('agent/created',()=>{
   if(window==='agent-publish')current=false
   else queueMicrotask(()=>{current=false})
   return undefined
  })
  await assert.rejects(f.ctx.agents.resume({resumeSessionId:id,agentOptions:{provider:'controlled',model:'fixed'}}),/checkpoint revoked/)
  assert.equal(f.ctx.agents.get(id),undefined);assert.equal(f.sessions.get(id),undefined);assert.equal(model.calls,0)
  const reader=await f.ctx.sessionPersistence.open(id,'write')
  const restored=await reader.read();await reader.close()
  // 官方结束标记可以已落盘；撤销恢复并不等同于取消已受理的工作。
  const inboxEvents=restored.events.filter(event=>event.type==='agent/inbox/spliced')
  assert.deepEqual(inboxEvents,cold.snapshotEvents().filter(event=>event.type==='agent/inbox/spliced'))
  const carrier=f.sessionPackage.Session.create(id,restored.events,cold.header)
  const projections=f.ctx.get('sessionProjections') as Context['sessionProjections']
  assert.deepEqual(projections.stateOf(carrier,'inbox')?.['next-turn'].map(input=>input.id),[message.id])
 })
}

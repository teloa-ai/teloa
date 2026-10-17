import test from 'node:test'
import assert from 'node:assert/strict'
import {createPlanDraftApi} from '../src/client/plan-draft-api.ts'
const draftId='10000000-0000-4000-8000-000000000001',planId='20000000-0000-4000-8000-000000000001',bodyHash='a'.repeat(64)
const input={draftId,expectedBodyHash:bodyHash},reply={schema:'teloa.plan-draft-confirmation/v1',draftId,bodyHash,planId,state:'paused',version:1,configVersion:1}
test('计划草案采用只传原id/hash和signal，回包不得替换原草案或成果',async()=>{
 const calls:unknown[]=[],abort=new AbortController()
 const api=createPlanDraftApi(async(...args)=>{calls.push(args);return reply})
 assert.deepEqual(await api.confirm(input,abort.signal),reply)
 assert.deepEqual(calls,[['page-create-plans/confirm',input,abort.signal]])
 for(const patch of [{draftId:planId},{bodyHash:'b'.repeat(64)},{planId:'latest'},{state:'done'},{version:0},{configVersion:1.5},{extra:'ignore'}]){
  await assert.rejects(createPlanDraftApi(async()=>({...reply,...patch})).confirm(input),{code:'teloa/invalid-host-response'})
 }
})
test('无效摘要或不明字段在派发前拒绝，不自动修复或放行',async()=>{
 let calls=0
 const api=createPlanDraftApi(async()=>{calls++;return reply})
 for(const value of [{...input,draftId:'draft-latest'},{...input,expectedBodyHash:'A'.repeat(64)},{...input,confirmed:true}]){
  await assert.rejects(api.confirm(value),{code:'teloa/invalid-input'})
 }
 assert.equal(calls,0)
})
test('保存/启用/归档均为真实状态，未知回执不自动重发',async()=>{
 for(const state of ['paused','active','archived'])assert.equal((await createPlanDraftApi(async()=>({...reply,state,version:4,configVersion:3})).confirm(input)).state,state)
 const error=Object.assign(Error('unknown'),{code:'teloa/network'});let calls=0
 await assert.rejects(createPlanDraftApi(async()=>{calls++;throw error}).confirm(input),error)
 assert.equal(calls,1)
})
test('会话原对象打开只是原身份通知，取消订阅后不通知、不写宿主',()=>{
 let calls=0,opened:unknown
 const api=createPlanDraftApi(async()=>{calls++;return reply}),draft={id:draftId,ownerId:'self',requestId:draftId,entity:'plan' as const,body:'{}',bodyHash,title:'原计划',status:'draft' as const,createdAt:'2026-10-17T00:00:00.000Z',updatedAt:'2026-10-17T00:00:00.000Z'}
 const off=api.onOpen(value=>{opened=value});api.openDraft(draft);assert.equal(opened,draft);off();opened=undefined;api.openDraft(draft)
 assert.equal(opened,undefined);assert.equal(calls,0)
})

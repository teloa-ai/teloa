import test from 'node:test'
import assert from 'node:assert/strict'
import {createGroupDeliveryRecoveryApi} from '../src/client/group-delivery-recovery-api.ts'
const id=(n:number)=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0'),target={groupId:id(1),messageId:id(2),roleId:id(3)},basis={schema:'teloa.group-delivery-recovery-candidate/v1' as const,target,itemId:id(4),taskId:id(5),taskTitle:'原任务',basisSha256:'a'.repeat(64),materials:[{id:id(6),title:'固定资料',version:1,sha256:'b'.repeat(64)}],reason:'text-capability-required' as const}
const receipt={schema:'teloa.group-delivery-recovery-receipt/v1',requestId:id(7),recoveryId:id(8),itemId:id(4),groupId:id(1),messageId:id(2),taskId:id(5),dispatchRequestId:id(9),state:'pending',capability:'text',confirmedAt:'2026-10-26T00:00:00.000Z'}
function journal(){let raw:string|null=null;return {read:()=>raw,write:(value:string)=>{raw=value},clear:()=>{raw=null}}}
test('检查只读；明确确认前持久保存原身份，丢回包刷新只沿原请求核对',async()=>{
 const saved=journal(),calls:Array<[string,unknown]>=[],api=createGroupDeliveryRecoveryApi(async(endpoint,payload)=>{calls.push([endpoint,structuredClone(payload)]);if(endpoint.endsWith('inspect'))return basis;assert.ok(saved.read());throw Error('lost response')},saved,()=>id(7))
 assert.deepEqual(await api.inspect(target),basis);assert.deepEqual(calls,[['groups/delivery/inspect',target]]);assert.equal(saved.read(),null)
 await assert.rejects(api.confirm(basis));assert.ok(saved.read());assert.equal(api.pending()?.requestId,id(7))
 await assert.rejects(api.confirm({...basis,basisSha256:'c'.repeat(64)}));await assert.rejects(api.confirm({...basis,taskId:id(10)}));assert.equal(calls.length,2)
 const restored=createGroupDeliveryRecoveryApi(async(endpoint,payload)=>{calls.push([endpoint,structuredClone(payload)]);return {schema:'teloa.group-delivery-recovery-check/v1',state:'accepted',receipt}},saved,()=>{throw Error('不应生成新nonce')})
 assert.deepEqual(await restored.recover(),{schema:'teloa.group-delivery-recovery-check/v1',state:'accepted',receipt});assert.equal(calls[2]![0],'groups/delivery/receipt');assert.deepEqual(calls[1]![1],calls[2]![1]);assert.equal(saved.read(),null);assert.equal(restored.pending(),undefined)
})
test('回执Task/恢复ID/原dispatch/时间身份损坏均保留原请求',async()=>{
 for(const invalid of [{...receipt,taskId:id(10)},{...receipt,recoveryId:'invalid'},{...receipt,dispatchRequestId:'invalid'},{...receipt,confirmedAt:'invalid'},{...receipt,messageId:id(10)}]){
  const saved=journal(),api=createGroupDeliveryRecoveryApi(async()=>invalid,saved,()=>id(7));await assert.rejects(api.confirm(basis));assert.ok(saved.read());assert.equal(api.pending()?.requestId,id(7))
 }
})
test('未持久保存不能提交；本地清理失败仍按原请求核对',async()=>{
 let calls=0;await assert.rejects(createGroupDeliveryRecoveryApi(async()=>{calls++;return receipt},undefined,()=>id(7)).confirm(basis));assert.equal(calls,0)
 const saved=journal(),api=createGroupDeliveryRecoveryApi(async()=>{calls++;return receipt},{...saved,clear:()=>{throw Error('local clear failed')}},()=>id(7))
 await assert.rejects(api.confirm(basis));assert.ok(api.pending());assert.ok(saved.read());assert.equal(calls,1)
})
test('损坏日志与跨群/重复/无效资料候选不会提交',async()=>{
 let calls=0;const api=createGroupDeliveryRecoveryApi(async()=>{calls++;return basis},{read:()=>'{broken',write:()=>{},clear:()=>{}})
 await assert.rejects(api.confirm(basis));assert.equal(calls,0)
 for(const invalid of [{...basis,target:{...target,groupId:id(10)}},{...basis,taskId:'invalid'},{...basis,materials:[basis.materials[0],basis.materials[0]]},{...basis,materials:[{...basis.materials[0],id:'invalid'}]}])await assert.rejects(createGroupDeliveryRecoveryApi(async()=>invalid,journal()).inspect(target))
})

test('未观察不清原请求，显式重试仍同nonce；权威未受理才结束本条并允许下一Task',async()=>{
 const saved=journal(),sent:unknown[]=[],api=createGroupDeliveryRecoveryApi(async(endpoint,payload)=>{sent.push([endpoint,structuredClone(payload)]);if(endpoint.endsWith('/recover'))throw Error('unknown');return {schema:'teloa.group-delivery-recovery-check/v1',state:'unobserved',command:payload}},saved,()=>id(7))
 await assert.rejects(api.confirm({...basis,materials:[]}));assert.equal((await api.recover()).state,'unobserved');assert.ok(saved.read());await assert.rejects(api.retry());assert.deepEqual((sent[0] as unknown[])[1],(sent[2] as unknown[])[1])
 const cleared=createGroupDeliveryRecoveryApi(async(_endpoint,payload)=>({schema:'teloa.group-delivery-recovery-check/v1',state:'not-accepted',command:payload,recordedAt:'2026-10-26T00:00:00.000Z',reason:'teloa/conflict'}),saved)
 assert.equal((await cleared.recover()).state,'not-accepted');assert.equal(saved.read(),null);assert.equal(cleared.pending(),undefined)
})

test('升级后确认投影必须来自完整planned-restart候选；检查不授予能力也不写journal',async()=>{
 for(const controlRebinding of [{kind:'planned-restart',restartCount:2},{kind:'planned-restart',restartCount:1}]){
  const saved=journal(),projected={...basis,controlRebinding},calls:string[]=[],api=createGroupDeliveryRecoveryApi(async endpoint=>{calls.push(endpoint);return projected},saved)
  assert.deepEqual(await api.inspect(target),projected);assert.equal(saved.read(),null);assert.deepEqual(calls,['groups/delivery/inspect'])
 }
 for(const controlRebinding of [{kind:'ordinary-resume',restartCount:2},{kind:'planned-restart',restartCount:0},{kind:'planned-restart',restartCount:1.5},{kind:'planned-restart',restartCount:2,trusted:true},null]){
  const saved=journal(),api=createGroupDeliveryRecoveryApi(async()=>({...basis,controlRebinding}),saved);await assert.rejects(api.inspect(target));assert.equal(saved.read(),null)
 }
})

test('再次确认必须同时绑定前次确认和planned证明；新nonce提交仍只带原Task来源，不把旧回执改成新授权',async()=>{
 const previous={previousRecoveryId:id(8),previousConfirmedAt:'2026-10-26T00:00:00.000Z'},next={...basis,reason:'text-capability-reconfirmation-required' as const,reconfirmation:previous,controlRebinding:{kind:'planned-restart' as const,restartCount:1}},saved=journal(),calls:Array<[string,unknown]>=[],api=createGroupDeliveryRecoveryApi(async(endpoint,payload)=>{calls.push([endpoint,structuredClone(payload)]);return endpoint.endsWith('/inspect')?next:{...receipt,recoveryId:id(18)}},saved,()=>id(7))
 assert.deepEqual(await api.inspect(target),next);assert.equal(saved.read(),null);assert.equal(calls.length,1)
 assert.equal((await api.confirm(next)).recoveryId,id(18));assert.equal(calls[1]![0],'groups/delivery/recover');assert.equal((calls[1]![1]as {requestId:string}).requestId,id(7));assert.equal(saved.read(),null)
 for(const invalid of [{...next,reconfirmation:undefined},{...next,reconfirmation:{...previous,previousRecoveryId:'invalid'}},{...next,reconfirmation:{...previous,previousConfirmedAt:'invalid'}},{...next,controlRebinding:undefined},{...next,reason:'text-capability-required'}])await assert.rejects(createGroupDeliveryRecoveryApi(async()=>invalid,journal()).inspect(target))
})

test('analysis固定附件独立能力：只读inspect；未知沿同nonce，不能换成text或吞不匹配回执',async()=>{
 const analysis={...basis,reason:'analysis-capability-required' as const,files:[{kind:'attachment' as const,id:'sha256:'+'a'.repeat(64),title:'固定图.png',version:1,sha256:'c'.repeat(64),bytes:20,mime:'image/png'}]},saved=journal(),calls:Array<[string,any]>=[]
 const api=createGroupDeliveryRecoveryApi(async(endpoint,payload)=>{calls.push([endpoint,payload]);if(endpoint.endsWith('/inspect'))return analysis;throw Error('lost')},saved,()=>id(7))
 assert.deepEqual(await api.inspect(target),analysis);assert.equal(saved.read(),null);await assert.rejects(api.confirm(analysis));assert.equal(api.pending()?.capability,'analysis');assert.equal(calls[1]![1].capability,'analysis')
 await assert.rejects(api.confirm(basis));assert.equal(calls.length,2)
 const restored=createGroupDeliveryRecoveryApi(async()=>({schema:'teloa.group-delivery-recovery-check/v1',state:'accepted',receipt:{...receipt,capability:'text'}}),saved);await assert.rejects(restored.recover());assert.ok(saved.read())
 const accepted=createGroupDeliveryRecoveryApi(async()=>({schema:'teloa.group-delivery-recovery-check/v1',state:'accepted',receipt:{...receipt,capability:'analysis'}}),saved);assert.equal((await accepted.recover()).state,'accepted');assert.equal(saved.read(),null)
})

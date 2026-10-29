import test from 'node:test'
import assert from 'node:assert/strict'
import {createResourceAdoptionRecovery,resourceAdoptionJournalKey} from '../src/client/resource-adoption-recovery.ts'
import type {ResourceAdoptionInput,ResourceDraft,WorkResource} from '@teloa/contract'
const id=(n:number)=>`11111111-1111-4111-8111-${String(n).padStart(12,'0')}`,stamp='2026-10-28T00:00:00.000Z',identity={ownerId:'owner',spaceId:id(1)}
const originals:WorkResource[]=Array.from({length:2},(_,n)=>({id:id(n+2),ownerId:'owner',title:'依据'+n,sourceId:'industry_source_'+n,sourceVersion:'a'.repeat(64),scopeIds:['soc'],version:1,status:'active',createdAt:stamp,updatedAt:stamp}))
function fixture(){
 const data=new Map<string,string>(),storage={getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>{data.set(key,value)},removeItem:(key:string)=>{data.delete(key)}},groups=new Map<string,ResourceDraft[]>(),applied=new Map<string,WorkResource>(),calls:ResourceAdoptionInput[]=[],applyCalls:string[]=[]
 const ports={prepareAdoption:async(input:ResourceAdoptionInput)=>{calls.push(structuredClone(input));let drafts=groups.get(input.requestId);if(!drafts){drafts=originals.map((row,n)=>({...row,id:id(n+10+groups.size*100),requestId:id(n+20+groups.size*100),sourceId:'adopted_'+id(n+30+groups.size*100),scopeIds:[input.targetScope],status:'draft'}));groups.set(input.requestId,drafts)}return structuredClone(drafts)},apply:async(draft:ResourceDraft)=>{applyCalls.push(draft.id);let row=applied.get(draft.id);if(!row){const {requestId:_,resourceId:__,...fields}=draft;row={...fields,id:id(1000+applied.size),status:'active'};applied.set(draft.id,row)}return structuredClone(row)},directory:async()=>({resources:[...applied.values()]})}
 return {data,storage,groups,applied,calls,applyCalls,ports}
}
test('服务端prepare已提交但回包未知，重建controller后只显式恢复原id；部分apply未知重建保留进度并幂等完成',async()=>{
 const f=fixture(),base=f.ports.prepareAdoption,baseApply=f.ports.apply
 let losePrepare=true,loseApply=true
 f.ports.prepareAdoption=async input=>{const rows=await base(input);if(losePrepare){losePrepare=false;throw Error('reply lost after commit')}return rows}
 f.ports.apply=async draft=>{const row=await baseApply(draft);if(draft.id===id(11)&&loseApply){loseApply=false;throw Error('apply reply lost')}return row}
 const a=createResourceAdoptionRecovery(f.ports,identity,f.storage,()=>id(99))
 await assert.rejects(a.begin(originals,'business-new'),/reply lost/);assert.equal(a.pending()?.input.requestId,id(99));assert.equal(f.groups.size,1)
 const b=createResourceAdoptionRecovery(f.ports,identity,f.storage,()=>id(100));assert.equal(f.calls.length,1,'重建不自动重放');assert.equal(b.pending()?.input.targetScope,'business-new')
 await assert.rejects(b.begin(originals,'other-business'),{code:'teloa/conflict'});const prepared=await b.recover();assert.equal(prepared.input.requestId,id(99));assert.equal(f.groups.size,1);assert.deepEqual(f.calls[0],f.calls[1]);assert.ok(f.storage.getItem(resourceAdoptionJournalKey(identity)),'prepare成功转为待采用，不丢恢复组')
 await assert.rejects(b.apply(),/apply reply lost/);assert.equal(b.pending()?.applied.length,1);assert.equal(f.applied.size,2)
 const c=createResourceAdoptionRecovery(f.ports,identity,f.storage);assert.equal(c.pending()?.applied.length,1);const receipt=await c.apply();assert.equal(receipt.length,2);assert.equal(f.applied.size,2);assert.equal(f.applyCalls.length,3);assert.equal(c.pending(),undefined);assert.equal(f.storage.getItem(resourceAdoptionJournalKey(identity)),null)
})
test('确定prepare拒绝才清理；暂时存储/网络故障保留固定请求；损坏与不可写记录阻止网络发送',async()=>{
 const f=fixture();f.ports.prepareAdoption=async()=>{throw Object.assign(Error('server unavailable'),{rejected:true,code:'teloa/storage-unavailable'})}
 const a=createResourceAdoptionRecovery(f.ports,identity,f.storage,()=>id(99));await assert.rejects(a.begin(originals,'business-new'));assert.equal(a.pending()?.input.requestId,id(99))
 f.ports.prepareAdoption=async()=>{throw Object.assign(Error('old version'),{rejected:true,code:'teloa/version-conflict'})};await assert.rejects(a.recover());assert.equal(a.pending(),undefined)
 f.storage.setItem(resourceAdoptionJournalKey(identity),'broken');const b=createResourceAdoptionRecovery(f.ports,identity,f.storage);assert.ok(b.recoveryMessage());await assert.rejects(b.begin(originals,'business-new'),{code:'teloa/storage-corrupt'});assert.equal(f.storage.getItem(resourceAdoptionJournalKey(identity)),'broken');assert.equal(b.clearCorrupt(),true)
 const c=createResourceAdoptionRecovery(f.ports,identity,{...f.storage,setItem:()=>{throw Error('quota exceeded')}});await assert.rejects(c.begin(originals,'business-new'),{code:'teloa/storage-unavailable'});assert.equal(c.pending(),undefined)
})
test('日志按本人和个人空间隔离；旧异步回包只能更新原requestId，不能覆盖后来目标业务',async()=>{
 const f=fixture(),base=f.ports.prepareAdoption;let resolveOld!:(rows:ResourceDraft[])=>void,oldRows:ResourceDraft[]=[]
 let first=true;f.ports.prepareAdoption=async input=>{const rows=await base(input);if(first){first=false;oldRows=rows;return new Promise<ResourceDraft[]>(resolve=>{resolveOld=resolve})}return rows}
 const a=createResourceAdoptionRecovery(f.ports,identity,f.storage,()=>id(99)),old=a.begin(originals,'business-new')
 await new Promise(resolve=>setTimeout(resolve,0));assert.equal(createResourceAdoptionRecovery(f.ports,{...identity,spaceId:id(9)},f.storage).pending(),undefined);assert.equal(createResourceAdoptionRecovery(f.ports,{...identity,ownerId:'other'},f.storage).pending(),undefined)
 const b=createResourceAdoptionRecovery(f.ports,identity,f.storage,()=>id(100));await b.recover();await b.apply();await b.begin(originals,'another-business')
 resolveOld(oldRows);await assert.rejects(old,{code:'teloa/conflict'});assert.equal(b.pending()?.input.requestId,id(100));assert.equal(b.pending()?.input.targetScope,'another-business');assert.equal(f.groups.size,2)
})
test('同一请求的迟到prepare不会清空另一窗口已持久化的批量采用进度',async()=>{
 const f=fixture(),basePrepare=f.ports.prepareAdoption,baseApply=f.ports.apply
 let resolvePrepare!:(value:ResourceDraft[])=>void,resolveApply!:(value:WorkResource)=>void,oldRows:ResourceDraft[]=[],first=true
 f.ports.prepareAdoption=async input=>{const rows=await basePrepare(input);if(first){first=false;oldRows=rows;return new Promise<ResourceDraft[]>(resolve=>{resolvePrepare=resolve})}return rows}
 f.ports.apply=async draft=>{const row=await baseApply(draft);if(draft.id===id(11))return new Promise<WorkResource>(resolve=>{resolveApply=resolve});return row}
 const a=createResourceAdoptionRecovery(f.ports,identity,f.storage,()=>id(99)),old=a.begin(originals,'business-new');await new Promise(resolve=>setTimeout(resolve,0))
 const b=createResourceAdoptionRecovery(f.ports,identity,f.storage);await b.recover();const applying=b.apply();await new Promise(resolve=>setTimeout(resolve,0));assert.equal(b.pending()?.applied.length,1)
 resolvePrepare(oldRows);assert.equal((await old).applied.length,1);assert.equal(a.pending()?.applied.length,1)
 resolveApply(f.applied.get(id(11))!);assert.equal((await applying).length,2);assert.equal(b.pending(),undefined)
})
test('旧prepare的确定拒绝迟到时，不能清理另一窗口已经确认成功的同请求草稿',async()=>{
 const f=fixture(),base=f.ports.prepareAdoption;let rejectOld!:(cause:unknown)=>void,first=true
 f.ports.prepareAdoption=async input=>{if(first){first=false;return new Promise<ResourceDraft[]>((_resolve,reject)=>{rejectOld=reject})}return base(input)}
 const a=createResourceAdoptionRecovery(f.ports,identity,f.storage,()=>id(99)),old=a.begin(originals,'business-new');await new Promise(resolve=>setTimeout(resolve,0))
 const b=createResourceAdoptionRecovery(f.ports,identity,f.storage);await b.recover();rejectOld(Object.assign(Error('old scope denied'),{rejected:true,code:'teloa/forbidden'}));await assert.rejects(old,/old scope denied/);assert.equal(b.pending()?.drafts?.length,2)
})

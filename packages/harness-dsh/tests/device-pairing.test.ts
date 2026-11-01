import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {createDevicePairing,type DevicePairingJob} from '../src/device-pairing.ts'

test('USB配置在本人意图和物理确认后固定，回执丢失只查询同一作业',async()=>{
 let stamp=Date.now(),registered=0
 const target={assistantSessionId:randomUUID(),contextVersion:1}
 const records=new Map<string,DevicePairingJob>(),ports:Parameters<typeof createDevicePairing>[0]={now:()=>stamp,secret:Buffer.alloc(32,7),host:'192.168.2.10',port:32101,serverName:'teloa.test',ca:'test-certificate',target:async()=>target,save:async row=>{records.set(row.id,structuredClone(row))},load:async id=>structuredClone(records.get(id)),finish:async(job)=>{registered++;records.set(job.id,structuredClone(job))}}
 const service=createDevicePairing(ports),job=await service.begin({allowApprovals:true})
 await assert.rejects(service.provision(job.id,{nonce:randomUUID(),confirmed:false}))
 const nonce=randomUUID(),one=await service.provision(job.id,{nonce,confirmed:true}),two=await service.provision(job.id,{nonce,confirmed:true})
 assert.equal(one.configuration,two.configuration);assert.equal(one.digest,two.digest)
 assert.equal(registered,0)
 await assert.rejects(service.complete(job.id,'a'.repeat(64)))
 await service.complete(job.id,one.digest);await service.complete(job.id,one.digest)
 assert.equal(registered,1);assert.equal((await service.status(job.id))?.state,'paired')
 await assert.rejects(service.cancel(job.id),{code:'teloa/forbidden'});assert.equal((await service.status(job.id))?.state,'paired')
 const other=await service.begin({allowApprovals:false});stamp+=300001
 await assert.rejects(service.provision(other.id,{nonce:randomUUID(),confirmed:true}))
})

for(const stage of ['provision-target','provision-save','complete-target'] as const)test(`取消${stage}等待中的原作业，不迟到交付配置或登记授权`,async()=>{
 const operation=stage.startsWith('provision')?'provision':'complete'
 const records=new Map<string,DevicePairingJob>(),target={assistantSessionId:randomUUID(),contextVersion:1}
 let registered=0,hold=false,entered!:()=>void,release!:()=>void
 const waiting=new Promise<void>(resolve=>{entered=resolve}),gate=new Promise<void>(resolve=>{release=resolve})
 const service=createDevicePairing({secret:Buffer.alloc(32,9),host:'127.0.0.1',port:32101,serverName:'fixture.test',ca:'synthetic-certificate',
  target:async()=>{if(hold&&stage!=='provision-save'){entered();await gate}return target},load:async id=>structuredClone(records.get(id)),
  save:async row=>{records.set(row.id,structuredClone(row));if(hold&&stage==='provision-save'&&row.state==='ready'){entered();await gate}},finish:async job=>{registered++;records.set(job.id,structuredClone(job))},
 })
 const job=await service.begin({allowApprovals:false}),nonce=randomUUID()
 const prepared=operation==='complete'?await service.provision(job.id,{nonce,confirmed:true}):undefined
 hold=true
 const pending=operation==='provision'?service.provision(job.id,{nonce,confirmed:true}):service.complete(job.id,prepared!.digest)
 const outcome=pending.then(value=>({value,error:undefined}),error=>({value:undefined,error}))
 await waiting
 const cancelled=service.cancel(job.id),cancelOutcome=cancelled.then(value=>({value,error:undefined}),error=>({value:undefined,error}))
 release()
 const result=await outcome,cancel=await cancelOutcome
 assert.equal(result.error?.code,'teloa/forbidden','取消已提出，等待中的操作不能继续交付或完成')
 assert.equal(cancel.error,undefined);assert.equal(cancel.value?.state,'cancelled');assert.equal(registered,0)
 assert.equal((await service.status(job.id))?.state,'cancelled')
 await assert.rejects(service.provision(job.id,{nonce,confirmed:true}),{code:'teloa/forbidden'})
 const next=await service.begin({allowApprovals:true});assert.notEqual(next.id,job.id);assert.equal(next.allowApprovals,true)
})

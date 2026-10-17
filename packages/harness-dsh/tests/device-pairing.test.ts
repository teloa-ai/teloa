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
 const other=await service.begin({allowApprovals:false});stamp+=300001
 await assert.rejects(service.provision(other.id,{nonce:randomUUID(),confirmed:true}))
})

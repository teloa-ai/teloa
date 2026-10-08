import assert from 'node:assert/strict'
import test from 'node:test'
const api=await import('../src/maintenance-capacity.ts').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return {};throw error}) as any
const plan=(input:any)=>{assert.equal(typeof api.planMaintenanceCapacity,'function');return api.planMaintenanceCapacity(input)}

test('同卷所有同时写入需求相加，采用每卷至少256MiB或峰值20%的余量',()=>{
 const result=plan({volumes:[{id:'a',sharedSpaceId:'one',availableBytes:4_000_000_000n}],demands:[{volumeId:'a',bytes:1_500_000_000},{volumeId:'a',bytes:500_000_001n}]})
 assert.equal(result.ok,true)
 assert.deepEqual(result.requirements,[{volumeIds:['a'],demandBytes:2_000_000_001n,reserveBytes:400_000_001n,requiredBytes:2_400_000_002n,availableBytes:4_000_000_000n,shortfallBytes:0n}])
})
test('确定独立的不同卷分别计算不足，不借用另一卷空闲空间',()=>{
 const result=plan({volumes:[{id:'a',sharedSpaceId:'one',availableBytes:100n},{id:'b',sharedSpaceId:'two',availableBytes:500n}],demands:[{volumeId:'a',bytes:200n},{volumeId:'b',bytes:400n}],reserveBytes:0n})
 assert.equal(result.ok,false)
 assert.deepEqual(result.shortfalls.map((r:any)=>[r.volumeIds,r.shortfallBytes]),[[['a'],140n]])
})
test('共享卷按合并峰值和最小可用空间计算，未知共享关系也保守合并',()=>{
 for(const shared of [true,false]){
  const result=plan({volumes:[{id:'a',availableBytes:1200n,...shared?{sharedSpaceId:'pool'}:{}},{id:'b',availableBytes:1000n,...shared?{sharedSpaceId:'pool'}:{}}],demands:[{volumeId:'a',bytes:500n},{volumeId:'b',bytes:500n}],reserveBytes:0n})
  assert.equal(result.ok,false);assert.equal(result.requirements.length,1);assert.equal(result.shortfalls[0].shortfallBytes,200n)
 }
})
test('缺失统计、重复卷、未知需求卷及非法字节停止核对，大整数不损失精度',()=>{
 for(const value of [undefined,-1,-1n,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,'100'])assert.throws(()=>plan({volumes:[{id:'a',availableBytes:value}],demands:[{volumeId:'a',bytes:1}]}))
 for(const value of [undefined,-1,1.5,NaN,Infinity,'100'])assert.throws(()=>plan({volumes:[{id:'a',availableBytes:100}],demands:[{volumeId:'a',bytes:value}]}))
 assert.throws(()=>plan({volumes:[{id:'a',availableBytes:100},{id:'a',availableBytes:100}],demands:[]}))
 assert.throws(()=>plan({volumes:[{id:'a',availableBytes:100}],demands:[{volumeId:'missing',bytes:1}]}))
 const result=plan({volumes:[{id:'a',availableBytes:10n**30n}],demands:[{volumeId:'a',bytes:10n**25n}]})
 assert.equal(result.requirements[0].requiredBytes,12n*10n**24n)
})

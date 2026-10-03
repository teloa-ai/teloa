import test from 'node:test'
import assert from 'node:assert/strict'
import {WorkAccess,type WorkAccessPolicy,type WorkAccessLease} from '../src/work/work-access.ts'
const request={kind:'task-run-start' as const,ownerId:'owner',runId:'run',taskId:'task',sessionId:'session',nativeRequestId:'native'}

test('Free 默认允许；后来要求策略使已取得的默认租约失效',async()=>{
 const access=new WorkAccess(),lease=await access.authorize(request)
 lease.assertCurrent();access.requirePolicy()
 assert.throws(()=>lease.assertCurrent(),{code:'teloa/forbidden'})
 await assert.rejects(access.authorize(request),{code:'teloa/unavailable'})
})
test('唯一策略允许同函数幂等安装，拒绝替换；required 不可退回默认允许',async()=>{
 const access=new WorkAccess(),policy:WorkAccessPolicy=async()=>({assertCurrent:()=>{}})
 access.requirePolicy();access.installPolicy(policy);access.installPolicy(policy)
 assert.throws(()=>access.installPolicy(async()=>({assertCurrent:()=>{}})),{code:'teloa/forbidden'})
 ;(await access.authorize(request)).assertCurrent()
})
test('策略只看到冻结副本；租约固定原函数与receiver，不接受动态替换',async()=>{
 const access=new WorkAccess(),input={...request}
 let seen:Readonly<typeof request>|undefined,allowed=true
 const raw={marker:'bound',assertCurrent(){assert.equal(this.marker,'bound');if(!allowed)throw Error('private failure')}}
 access.installPolicy(async value=>{seen=value as typeof request;await Promise.resolve();return raw})
 const pending=access.authorize(input);input.ownerId='changed'
 const lease=await pending
 assert.equal(seen?.ownerId,'owner');assert.equal(Object.isFrozen(seen),true)
 raw.assertCurrent=()=>{};allowed=false
 assert.throws(()=>lease.assertCurrent(),{code:'teloa/forbidden'})
})
test('pending authorize期间required边界变化不能产生迟到租约',async()=>{
 const access=new WorkAccess();let finish!:()=>void
 const barrier=new Promise<void>(resolve=>{finish=resolve})
 access.installPolicy(async()=>{await barrier;return {assertCurrent:()=>{}}})
 const pending=access.authorize(request);access.requirePolicy();finish()
 await assert.rejects(pending,{code:'teloa/forbidden'})
})
test('JS异步assert或thenable拒绝并接住异步拒绝，不能绕过同步复核',async()=>{
 for(const assertion of [async()=>{throw Error('late reject')},()=>({then(_resolve:unknown,reject:(error:unknown)=>void){reject(Error('thenable reject'))}}),()=>true]){
  const access=new WorkAccess()
  access.installPolicy(async()=>({assertCurrent:assertion} as unknown as WorkAccessLease))
  await assert.rejects(access.authorize(request),{code:'teloa/forbidden'})
 }
 await new Promise<void>(resolve=>setImmediate(resolve))
})
test('缺失lease、恶意getter和策略拒绝只暴露固定泛化说明',async()=>{
 const cases=[async()=>null,async()=>({}),async()=>({get assertCurrent(){throw Error('secret getter')}}),async()=>{throw Error('secret policy')}]
 for(const policy of cases){
  const access=new WorkAccess();access.installPolicy(policy as unknown as WorkAccessPolicy)
  await assert.rejects(access.authorize(request),error=>{
   assert.equal((error as {code:string}).code,'teloa/forbidden')
   assert.equal((error as Error).message,'当前暂不能开始新工作，请核对运行许可后重试。')
   return true
  })
 }
})

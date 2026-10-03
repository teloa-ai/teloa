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

test('政策可仅区分自然到期续作；authorize和原assertCurrent始终要求新工作许可',async()=>{
 const access=new WorkAccess()
 let now=99,identityCurrent=true
 const expiresAt=100
 access.installPolicy(async()=>({
  assertCurrent(){if(!identityCurrent||now>=expiresAt)throw Error('new work denied')},
  assertContinuationCurrent(){if(!identityCurrent)throw Error('identity revoked')},
 }))
 const lease=await access.authorize(request)
 lease.assertCurrent();lease.assertContinuationCurrent?.()
 now=expiresAt
 assert.throws(()=>lease.assertCurrent(),{code:'teloa/forbidden'})
 lease.assertContinuationCurrent?.()
 await assert.rejects(access.authorize(request),{code:'teloa/forbidden'})
 identityCurrent=false
 assert.throws(()=>lease.assertContinuationCurrent?.(),{code:'teloa/forbidden'})
})
test('未提供continuation函数时沿用captured assertCurrent，Free默认租约也有相同复核',async()=>{
 const free=new WorkAccess(),freeLease=await free.authorize(request)
 assert.equal(typeof freeLease.assertContinuationCurrent,'function')
 freeLease.assertContinuationCurrent?.()
 free.requirePolicy()
 assert.throws(()=>freeLease.assertContinuationCurrent?.(),{code:'teloa/forbidden'})
 const access=new WorkAccess();let current=true
 const raw={marker:'fallback',assertCurrent(){assert.equal(this.marker,'fallback');if(!current)throw Error('expired')}}
 access.installPolicy(async()=>raw)
 const lease=await access.authorize(request)
 lease.assertContinuationCurrent?.()
 raw.assertCurrent=()=>{};current=false
 assert.throws(()=>lease.assertContinuationCurrent?.(),{code:'teloa/forbidden'})
})
test('新策略安装或required epoch变化拒绝旧continuation，即使政策续作函数仍允许',async()=>{
 const access=new WorkAccess(),defaultLease=await access.authorize(request)
 access.installPolicy(async()=>({assertCurrent(){},assertContinuationCurrent(){}}))
 assert.throws(()=>defaultLease.assertContinuationCurrent?.(),{code:'teloa/forbidden'})
 const lease=await access.authorize(request)
 access.requirePolicy()
 assert.throws(()=>lease.assertCurrent(),{code:'teloa/forbidden'})
 assert.throws(()=>lease.assertContinuationCurrent?.(),{code:'teloa/forbidden'})
})
test('continuation捕获原函数和this，后改property不能绕过或替换已取得的租约',async()=>{
 const access=new WorkAccess();let current=true,gets=0
 const raw={marker:'bound',assertCurrent(){},get assertContinuationCurrent(){
  gets++
  return function(this:{marker:string}){assert.equal(this.marker,'bound');if(!current)throw Error('revoked')}
 }}
 access.installPolicy(async()=>raw)
 const lease=await access.authorize(request)
 assert.equal(gets,1)
 lease.assertContinuationCurrent?.()
 Object.defineProperty(raw,'assertContinuationCurrent',{get(){throw Error('replacement getter')}})
 lease.assertContinuationCurrent?.()
 assert.equal(gets,1)
 current=false
 assert.throws(()=>lease.assertContinuationCurrent?.(),{code:'teloa/forbidden'})
})
test('读取continuation getter不会覆盖先前捕获的严格assertCurrent',async()=>{
 const access=new WorkAccess();let current=true
 const raw={assertCurrent(){if(!current)throw Error('expired')},get assertContinuationCurrent(){
  raw.assertCurrent=()=>{}
  return ()=>{}
 }}
 access.installPolicy(async()=>raw)
 const lease=await access.authorize(request)
 current=false
 assert.throws(()=>lease.assertCurrent(),{code:'teloa/forbidden'})
 lease.assertContinuationCurrent?.()
})
test('continuation恶意getter、非函数或getter期间epoch变更不能产生有效租约',async()=>{
 const values=[null,false,0,'allow',{},Promise.resolve(undefined)]
 for(const value of values){
  const access=new WorkAccess()
  access.installPolicy(async()=>({assertCurrent(){},assertContinuationCurrent:value} as unknown as WorkAccessLease))
  await assert.rejects(access.authorize(request),{code:'teloa/forbidden'})
 }
 const throwing=new WorkAccess()
 throwing.installPolicy(async()=>({assertCurrent(){},get assertContinuationCurrent():()=>void{throw Error('secret getter')}}))
 await assert.rejects(throwing.authorize(request),error=>{
  assert.equal((error as {code:string}).code,'teloa/forbidden')
  assert.equal((error as Error).message,'当前暂不能开始新工作，请核对运行许可后重试。')
  return true
 })
 const changed=new WorkAccess()
 changed.installPolicy(async()=>({assertCurrent(){},get assertContinuationCurrent(){changed.requirePolicy();return ()=>{}}}))
 await assert.rejects(changed.authorize(request),{code:'teloa/forbidden'})
})
test('continuation Promise、thenable或其他非undefined返回均同步拒绝并接住晚拒绝',async()=>{
 for(const assertion of [async()=>{throw Error('late continuation reject')},()=>Promise.resolve(undefined),()=>({then(_resolve:unknown,reject:(error:unknown)=>void){reject(Error('thenable reject'))}}),()=>true]){
  const access=new WorkAccess()
  access.installPolicy(async()=>({assertCurrent(){},assertContinuationCurrent:assertion} as unknown as WorkAccessLease))
  const lease=await access.authorize(request)
  assert.throws(()=>lease.assertContinuationCurrent?.(),{code:'teloa/forbidden'})
  lease.assertCurrent()
 }
 await new Promise<void>(resolve=>setImmediate(resolve))
})

test('租约调用捕获函数本体，改写函数自有call不能绕过严格或续作复核',async()=>{
 const access=new WorkAccess();let current=true
 const check=function(this:{marker:string}){assert.equal(this.marker,'bound');if(!current)throw Error('revoked')}
 access.installPolicy(async()=>({marker:'bound',assertCurrent:check,assertContinuationCurrent:check}))
 const lease=await access.authorize(request)
 Object.defineProperty(check,'call',{value:()=>{}})
 current=false
 assert.throws(()=>lease.assertCurrent(),{code:'teloa/forbidden'})
 assert.throws(()=>lease.assertContinuationCurrent?.(),{code:'teloa/forbidden'})
})
test('同步复核自身改变WorkAccess epoch也必须当次拒绝，不等待下一次检查',async()=>{
 const access=new WorkAccess()
 access.installPolicy(async()=>({assertCurrent(){access.requirePolicy()},assertContinuationCurrent(){}}))
 await assert.rejects(access.authorize(request),{code:'teloa/forbidden'})
 const continuation=new WorkAccess()
 continuation.installPolicy(async()=>({assertCurrent(){},assertContinuationCurrent(){continuation.requirePolicy()}}))
 const lease=await continuation.authorize(request)
 assert.throws(()=>lease.assertContinuationCurrent?.(),{code:'teloa/forbidden'})
})

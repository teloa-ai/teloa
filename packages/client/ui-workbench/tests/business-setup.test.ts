import test from 'node:test'
import assert from 'node:assert/strict'
import {BusinessSetupController,type BusinessSetupApi,type BusinessSetupSnapshot} from '../src/client/business-setup.ts'

const input={scope:'sales',expectedVersion:2,expectedHash:'a'.repeat(64)}
const snapshot=(scope='sales'):BusinessSetupSnapshot=>({scope,configurationVersion:2,configurationHash:input.expectedHash,observedAt:'2026-09-30T00:00:00.000Z',colleagues:{status:'unavailable'},skills:{status:'unavailable'},knowledge:{status:'unavailable'},connections:{status:'unavailable'}})
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(reason:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject}}
function fixture(scope='sales'){
 const reads:Array<{input:typeof input;signal:AbortSignal|undefined;wait:ReturnType<typeof deferred<BusinessSetupSnapshot>>}>=[]
 const api:BusinessSetupApi={read:(data,signal)=>{const wait=deferred<BusinessSetupSnapshot>();reads.push({input:data,signal,wait});return wait.promise}}
 const controller=new BusinessSetupController(api,{...input,scope});const states:ReturnType<BusinessSetupController['getSnapshot']>[]=[]
 const unsubscribe=controller.subscribe(()=>{states.push(controller.getSnapshot())})
 const request=(index:number)=>{const value=reads[index];assert.ok(value,`缺少第 ${index+1} 次读取请求`);return value}
 return {controller,reads,states,unsubscribe,request}
}
test('首次加载与订阅发布真实状态，刷新清除旧投影',async()=>{
 const f=fixture();assert.deepEqual(f.controller.getSnapshot(),{status:'loading',value:null})
 const first=f.controller.load();assert.deepEqual(f.request(0).input,input);f.request(0).wait.resolve(snapshot());await first
 assert.deepEqual(f.controller.getSnapshot(),{status:'ready',value:snapshot()})
 const second=f.controller.load();assert.equal(f.request(0).signal?.aborted,true);assert.deepEqual(f.controller.getSnapshot(),{status:'loading',value:null})
 f.request(1).wait.resolve(snapshot());await second;assert.deepEqual(f.states.map(row=>row.status),['loading','ready','loading','ready'])
 f.unsubscribe();f.controller.dispose()
})
test('连点只接收最后一轮，前轮迟到成功或失败不覆盖',async()=>{
 for(const late of ['success','failure']){
  const f=fixture(),first=f.controller.load(),second=f.controller.load();assert.equal(f.request(0).signal?.aborted,true)
  f.request(1).wait.resolve(snapshot());await second
  if(late==='success')f.request(0).wait.resolve(snapshot('support'));else f.request(0).wait.reject(Error('late secret'))
  await first;assert.deepEqual(f.controller.getSnapshot(),{status:'ready',value:snapshot()});assert.deepEqual(f.states.map(row=>row.status),['loading','loading','ready']);f.controller.dispose()
 }
})
test('先甲后乙独立实例，甲回包不进入乙且各读固定输入',async()=>{
 const a=fixture(),b=fixture('support'),one=a.controller.load(),two=b.controller.load();a.controller.dispose()
 b.request(0).wait.resolve(snapshot('support'));await two;a.request(0).wait.resolve(snapshot());await one
 assert.equal(a.request(0).input.scope,'sales');assert.equal(b.request(0).input.scope,'support');assert.deepEqual(b.controller.getSnapshot(),{status:'ready',value:snapshot('support')});assert.deepEqual(a.states.map(row=>row.status),['loading']);b.controller.dispose()
})
test('失败不当空，重试先loading再ready且不输出原始错误',async()=>{
 const f=fixture(),first=f.controller.load();f.request(0).wait.reject(Error('secret'));await first
 assert.deepEqual(f.controller.getSnapshot(),{status:'failed',value:null})
 const retry=f.controller.load();assert.deepEqual(f.controller.getSnapshot(),{status:'loading',value:null});f.request(1).wait.resolve(snapshot());await retry
 assert.deepEqual(f.controller.getSnapshot(),{status:'ready',value:snapshot()});assert.equal(JSON.stringify(f.states).includes('secret'),false);f.controller.dispose()
})
test('dispose取消读取，迟到成功或失败均不发布，后续load不再调用',async()=>{
 for(const late of ['success','failure']){
  const f=fixture(),pending=f.controller.load();f.controller.dispose();assert.equal(f.request(0).signal?.aborted,true)
  if(late==='success')f.request(0).wait.resolve(snapshot());else f.request(0).wait.reject(Error('late'))
  await pending;await f.controller.load();assert.deepEqual(f.states.map(row=>row.status),['loading']);assert.equal(f.reads.length,1)
 }
})
test('解除订阅后不再发布给原监听者',async()=>{
 const f=fixture(),pending=f.controller.load();f.unsubscribe();f.request(0).wait.resolve(snapshot());await pending
 assert.deepEqual(f.states.map(row=>row.status),['loading']);assert.equal(f.controller.getSnapshot().status,'ready');f.controller.dispose()
})

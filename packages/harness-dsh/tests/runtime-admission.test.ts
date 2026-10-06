import assert from 'node:assert/strict'
import test from 'node:test'
const api=await import('../src/runtime-admission.ts').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return {};throw error}) as any
test('先关接单再等待在途派发，新请求不能穿过活动查询窗口',async()=>{
 assert.equal(typeof api.RuntimeAdmission,'function')
 const gate=new api.RuntimeAdmission();let finish:()=>void=()=>{},started=false
 const work=gate.run(()=>new Promise<void>(done=>{finish=done}))
 const drain=gate.quiesce(1000)
 await assert.rejects(gate.run(async()=>{started=true}),/停止/)
 assert.equal(started,false);finish();await work;await drain
 await assert.rejects(gate.run(async()=>{}),/停止/)
 gate.resume();await gate.run(async()=>{started=true});assert.equal(started,true)
})
test('已接单操作的嵌套步骤可收尾，超时自动恢复接单',async()=>{
 const gate=new api.RuntimeAdmission();let next:()=>void=()=>{}
 const work=gate.run(async()=>{await new Promise<void>(done=>{next=done});await gate.run(async()=>{})})
 const drain=gate.quiesce(1000);next();await work;await drain;gate.resume()
 let finish:()=>void=()=>{};const busy=gate.run(()=>new Promise<void>(done=>{finish=done}))
 await assert.rejects(gate.quiesce(20),/收尾/);await gate.run(async()=>{});finish();await busy
})
test('关闸后的群接力保留并迫使停止失败，解闸后继续执行',async()=>{
 const gate=new api.RuntimeAdmission();await gate.quiesce(1000)
 let routed=false;const pending=gate.defer(async()=>{routed=true})
 assert.equal(gate.deferred,1);assert.equal(routed,false)
 gate.resume();await pending;assert.equal(routed,true)
})
test('只读观察不授予派发票据；关闸后原观察的新增工作同样拒绝',async()=>{
 const gate=new api.RuntimeAdmission();let continueRead:()=>void=()=>{},started=false
 const observation=gate.observe(async()=>{await new Promise<void>(done=>{continueRead=done});return gate.run(()=>{started=true})})
 await gate.quiesce(0);gate.assertQuiescent()
 await assert.rejects(gate.observe(()=>{started=true}),/停止/)
 continueRead();await assert.rejects(observation,/停止/);assert.equal(started,false)
 gate.resume()
})

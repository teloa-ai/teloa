import test from 'node:test'
import assert from 'node:assert/strict'
import {nativePtcRuntime} from './fixtures/native-ptc-runtime.ts'

test('官方PTC可选内存模式只沿同owner复用，release与冷宿主不保留变量',{timeout:30000},async t=>{
 const {root,runtime}=await nativePtcRuntime(t,'node',true),owner={},another={}
 const run=(program:string,stateOwner=owner)=>runtime.run(runtime.resolve({program,bindings:[],cwd:root,stateOwner}))
 const first=await run('let retainedTeloaValue = 41; retainedTeloaValue');assert.equal(first.error,undefined,JSON.stringify(first));assert.equal(first.value,41)
 assert.equal((await run('++retainedTeloaValue')).value,42)
 assert.equal((await run('typeof retainedTeloaValue',another)).value,'undefined')
 await runtime.release(owner)
 assert.equal((await run('typeof retainedTeloaValue')).value,'undefined')
 const cold=await nativePtcRuntime(t,'node',true)
 assert.equal((await cold.runtime.run(cold.runtime.resolve({program:'typeof retainedTeloaValue',bindings:[],cwd:cold.root,stateOwner:owner}))).value,'undefined')
})

test('官方默认per-call不保留变量，取消真实worker后同owner重新获得干净状态',{timeout:30000},async t=>{
 const fresh=await nativePtcRuntime(t,'node'),owner={}
 assert.equal((await fresh.runtime.run(fresh.runtime.resolve({program:'globalThis.retainedTeloaValue=17; return retainedTeloaValue',bindings:[],cwd:fresh.root,stateOwner:owner}))).value,17)
 assert.equal((await fresh.runtime.run(fresh.runtime.resolve({program:'return typeof retainedTeloaValue',bindings:[],cwd:fresh.root,stateOwner:owner}))).value,'undefined')
 const retained=await nativePtcRuntime(t,'node',true),controller=new AbortController()
 const result=retained.runtime.run(retained.runtime.resolve({program:'let cancelledTeloaValue=9; await new Promise(()=>{})',bindings:[],cwd:retained.root,stateOwner:owner,signal:controller.signal}))
 setTimeout(()=>controller.abort(),200)
 const cancelled=await result;assert.ok(cancelled.error,JSON.stringify(cancelled))
 assert.equal((await retained.runtime.run(retained.runtime.resolve({program:'typeof cancelledTeloaValue',bindings:[],cwd:retained.root,stateOwner:owner}))).value,'undefined')
})

test('同owner不能把旧内存跨会话或文件策略复用，显式release后才可切换',{timeout:30000},async t=>{
 const {root,runtime}=await nativePtcRuntime(t,'node',true),owner={}
 const policy={mode:'workspace-write' as const,workspaceRoot:root,sessionId:'ptc-session-a' as never}
 const run=(program:string,sandboxPolicy=policy)=>runtime.run(runtime.resolve({program,bindings:[],cwd:root,stateOwner:owner,sandboxPolicy}))
 assert.equal((await run('let ownedValue=5; ownedValue')).value,5)
 await assert.rejects(run('ownedValue',{...policy,sessionId:'ptc-session-b' as never}),/release the retained environment/)
 await assert.rejects(run('ownedValue',{...policy,mode:'read-only' as never}),/release the retained environment/)
 assert.equal((await run('ownedValue')).value,5)
 await runtime.release(owner)
 assert.equal((await run('typeof ownedValue',{...policy,sessionId:'ptc-session-b' as never})).value,'undefined')
})

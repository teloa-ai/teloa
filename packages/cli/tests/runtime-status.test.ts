import assert from 'node:assert/strict'
import test from 'node:test'
const runtime=await import('../src/runtime-status.ts').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return {};throw error}) as any
test('运行检查包含未显示在普通目录的 Agent、后台作业和终端',async()=>{
 assert.equal(typeof runtime.readRuntimeActivity,'function')
 const host={agents:{list:()=>[{status:'running',whenIdle:async()=>{}},{status:'idle',whenIdle:async()=>{}}]},jobs:{list:()=>[{status:'running'},{status:'stopping'},{status:'completed'}]},sessions:{list:()=>[{id:'one'}]},terminalController:{list:()=>[{state:'running'},{state:'exited'}]}}
 assert.deepEqual(await runtime.readRuntimeActivity(host),{agents:1,jobs:2,terminals:1,active:4})
 await assert.rejects(async()=>runtime.readRuntimeActivity({...host,jobs:{list:()=>[{status:'unrecognized'}]}}),/无法/)
})
test('公开 idle 的维护工作仍阻止停止',async()=>{
 const host={agents:{list:()=>[{status:'idle',whenIdle:()=>new Promise(()=>{})}]},jobs:{list:()=>[]},sessions:{list:()=>[]},terminalController:{list:()=>[]}}
 assert.equal((await runtime.readRuntimeActivity(host)).active,1)
})
test('后端可用但工作台客户端未注册时，不得报告完整就绪',()=>{
 assert.equal(typeof runtime.assertClientReady,'function')
 assert.throws(()=>runtime.assertClientReady({entries:[{id:'@deepseek-ai/dsh-client-ui-renderer'}]}),/客户端/)
 assert.doesNotThrow(()=>runtime.assertClientReady({entries:[{id:'@teloa/client-ui-workbench'},{id:'@deepseek-ai/dsh-client-ui-conversation'},{id:'@deepseek-ai/dsh-client-ui-workspace'},{id:'@teloa/native-gateway'}]}))
})
test('上游原服务没有被接单闸替换时，就绪检查必须失败',()=>{
 const gate={};assert.throws(()=>runtime.assertRuntimeGuard({webServer:{},typertGateway:{}},gate),/接单闸门/)
 assert.throws(()=>runtime.assertRuntimeGuard({webServer:{teloaAdmissionGuard:gate},typertGateway:{teloaAdmissionGuard:{}}},gate),/接单闸门/)
 assert.doesNotThrow(()=>runtime.assertRuntimeGuard({webServer:{teloaAdmissionGuard:gate},typertGateway:{teloaAdmissionGuard:gate}},gate))
})

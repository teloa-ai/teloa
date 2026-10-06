import test from 'node:test'
import assert from 'node:assert/strict'
import {WorkAccess} from '../../backend/src/work/work-access.ts'

test('真实关联的任务、员工、群和计划不会被prompt降级为基础，cold读取不激活Agent',async()=>{
 const capabilities=await import('../src/native-session-capabilities.ts').catch(()=>({} as typeof import('../src/native-session-capabilities.ts')))
 assert.equal(typeof capabilities.createNativeSessionCapabilities,'function')
 const record={sessionId:'actual',ownerId:'owner',status:'ready',requestedRoleId:'employee'}
 const ctx={agents:{get:()=>undefined}},ports={owner:'owner',conversations:{repository:{read:async()=>[record]}},links:{bySession:async()=>[]},pool:{query:async(sql:string)=>({rows:sql.includes('teloa_task_runs')?[{role_id:'employee',group_context_hash:'group-hash',plan_context_hash:'plan-hash'}]:[]})},isRoutingSession:()=>false}
 const reader=capabilities.createNativeSessionCapabilities(ctx as never,ports as never)
 assert.deepEqual(await reader('actual','prompt'),{ownerId:'owner',capabilities:['people','groups','automation']})
 record.requestedRoleId=undefined as never;ports.pool.query=async()=>({rows:[]})
 assert.deepEqual(await reader('actual','restore'),{ownerId:'owner',capabilities:['general-agent']})
 assert.deepEqual(await reader('actual','subagent'),{ownerId:'owner',capabilities:['parallel-agents']})
 await assert.rejects(reader('unbound','prompt'),{code:'teloa/forbidden'})
 record.ownerId='foreign';await assert.rejects(reader('actual','prompt'),{code:'teloa/forbidden'})
})

test('仅有真实非空会话负责人也按people分类；清空负责人后仍是基础',async()=>{
 const {createNativeSessionCapabilities}=await import('../src/native-session-capabilities.ts')
 let selected=true
 const ports={owner:'owner',conversations:{repository:{read:async()=>[{sessionId:'context-only',ownerId:'owner',status:'ready'}]}},links:{bySession:async()=>[]},pool:{query:async(sql:string)=>({rows:selected&&sql.includes('teloa_conversation_work_contexts')?[{role_id:'actual-employee'}]:[]})},isRoutingSession:()=>false}
 const reader=createNativeSessionCapabilities({agents:{get:()=>undefined}} as never,ports as never)
 assert.deepEqual(await reader('context-only','prompt'),{ownerId:'owner',capabilities:['people']})
 assert.deepEqual(await reader('context-only','restore'),{ownerId:'owner',capabilities:['people']})
 selected=false
 assert.deepEqual(await reader('context-only','prompt'),{ownerId:'owner',capabilities:['general-agent']})
})

test('真实纯读handler覆盖cold已ensure会话与未绑定原生历史，不触发授权或Agent激活',async()=>{
 const module=await import('../src/native-session-capabilities.ts'),read=Reflect.get(module,'readNativeSessionCapabilities') as typeof module.readNativeSessionCapabilities
 assert.equal(typeof read,'function')
 const rows:Array<{sessionId:string;ownerId:string;status:string;requestedRoleId?:string}>=[{sessionId:'cold-employee',ownerId:'owner',status:'ready',requestedRoleId:'real-employee'}]
 const ports={owner:'owner',conversations:{repository:{read:async()=>rows}},links:{bySession:async()=>[]},pool:{query:async()=>({rows:[]})},isRoutingSession:(id:string)=>id==='actual-group'}
 const access=new WorkAccess();access.requireSessionCapabilities();access.installPolicy(async()=>{assert.fail('读取历史不得调用执行准入')})
 access.installSessionCapabilities(module.createNativeSessionCapabilities({agents:{get:()=>undefined}} as never,ports as never))
 assert.deepEqual(await read('owner',{sessionId:'cold-employee'},access),{schema:'teloa.session-capabilities/v1',sessionId:'cold-employee',status:'ready',requiredCapabilities:['people']})
 assert.deepEqual(await read('owner',{sessionId:'actual-group'},access),{schema:'teloa.session-capabilities/v1',sessionId:'actual-group',status:'ready',requiredCapabilities:['groups']})
 assert.deepEqual(await read('owner',{sessionId:'unbound'},access),{schema:'teloa.session-capabilities/v1',sessionId:'unbound',status:'unavailable',requiredCapabilities:null})
 rows.push({sessionId:'unbound',ownerId:'owner',status:'ready'})
 assert.deepEqual(await read('owner',{sessionId:'unbound'},access),{schema:'teloa.session-capabilities/v1',sessionId:'unbound',status:'ready',requiredCapabilities:['general-agent']})
 for(const payload of [{sessionId:'cold-employee',requiredCapabilities:['general-agent']},{sessionId:'cold-employee',producer:'prompt'},{sessionId:'cold-employee',ownerId:'other'}])await assert.rejects(read('owner',payload,access),{code:'teloa/invalid-input'})
})

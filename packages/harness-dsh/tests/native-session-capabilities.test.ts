import test from 'node:test'
import assert from 'node:assert/strict'

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

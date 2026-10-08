import test from 'node:test'
import assert from 'node:assert/strict'
import {createRoleDelegationHandler} from '../src/role-delegations.ts'
import {createTaskHandler,taskEndpoints,confirmedTaskEndpoint} from '../src/tasks.ts'

test('执行授权 RPC 固定本人，拒绝伪造审批者和来源',async()=>{
 const calls:unknown[]=[]
 const handler=createRoleDelegationHandler('local-owner',async()=>({get:async(...args)=>{calls.push(args);return {} as never},change:async()=>({} as never)}),async()=>({confirm:async(...args)=>{calls.push(args);return {} as never},revoke:async()=>({} as never)}))
 await handler('role-delegations/get',{roleId:'role'})
 await handler('twin-execution-consents/confirm',{requestId:'request',roleId:'role',expectedRoleVersion:2,authorization:{kind:'task',taskId:'task',taskContentVersion:1}})
 assert.equal(calls.length,2)
 assert.equal((calls[0] as unknown[])[0],'local-owner')
 assert.equal((calls[1] as unknown[])[0],'local-owner')
 for(const forged of [{ownerId:'someone'},{approver:'self'},{source:'owner'}])await assert.rejects(handler('twin-execution-consents/confirm',{requestId:'request',...forged}),{code:'teloa/invalid-input'})
 assert.equal(calls.length,2)
})

test('单次本人确认不进入公共任务目录，未装配本人端口不能代授',async()=>{
 assert.equal(taskEndpoints.includes(confirmedTaskEndpoint),false)
 const calls:unknown[]=[]
 const plain=createTaskHandler('owner',async()=>({list:async()=>[],create:async()=>({} as never),edit:async()=>({} as never)}))
 const payload={requestId:'request',fields:{title:'工作',goal:'完成工作',scope:'general',groupId:null,skills:[]},assignee:{roleId:'twin',expectedRoleVersion:2}}
 await assert.rejects(plain(confirmedTaskEndpoint,payload),{code:'teloa/forbidden'})
 const confirmed=createTaskHandler('owner',async()=>({list:async()=>[],create:async()=>({} as never),edit:async()=>({} as never),createConfirmed:async(...args)=>{calls.push(args);return {} as never}}))
 await confirmed(confirmedTaskEndpoint,payload)
 assert.deepEqual(calls,[['owner',payload]])
 await assert.rejects(confirmed(confirmedTaskEndpoint,{...payload,consentId:'forged'}),{code:'teloa/invalid-input'})
 assert.equal(calls.length,1)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import {createRoleDelegationApi} from '../src/client/role-delegation-api.ts'
const roleId='11111111-1111-4111-8111-111111111111',delegationId='22222222-2222-4222-8222-222222222222',requestId='33333333-3333-4333-8333-333333333333'
const fields={scope:'general',allowedTools:['read'],knowledgeIds:[],memoryViewId:null,groupIds:[],safeRecovery:false}
const delegation={id:delegationId,ownerId:'owner',roleId,roleVersion:2,version:1,state:'active',...fields,createdAt:'2026-10-09T00:00:00.000Z',updatedAt:'2026-10-09T00:00:00.000Z'}
const read={roleId,roleVersion:2,delegations:[delegation],consents:[],canEditExecution:false}
const command={requestId,roleId,expectedRoleVersion:2,expectedVersion:null,action:'save' as const,fields}
test('仅接受可信 get 回包与严格委托字段；本人范围不被额外字段扩大',async()=>{
 const sent:unknown[]=[];const api=createRoleDelegationApi(async(endpoint,input)=>{sent.push([endpoint,input]);return endpoint.endsWith('/get')?read:delegation})
 assert.deepEqual(await api.get(roleId),read)
 assert.deepEqual(await api.change(command),delegation)
 assert.deepEqual(sent,[['role-delegations/get',{roleId}],['role-delegations/change',command]])
 await assert.rejects(api.change({...command,fields:{...fields,approver:'self'}} as never));assert.equal(sent.length,2)
 for(const patch of [{roleId:delegationId},{canEditExecution:'true'},{consents:[{...delegation}]},{delegations:[{...delegation,ownerId:'other'},delegation]}])await assert.rejects(createRoleDelegationApi(async()=>({...read,...patch})).get(roleId))
})
test('未知委托提交保留同一请求；恢复不会自动确认分身执行',async()=>{
 let raw:string|null=null;const journal={read:()=>raw,write:(value:string)=>{raw=value},clear:()=>{raw=null}},sent:unknown[]=[]
 const first=createRoleDelegationApi(async(endpoint,input)=>{sent.push([endpoint,input]);throw Error('lost')},journal)
 await assert.rejects(first.change(command),/lost/);assert.ok(raw)
 const second=createRoleDelegationApi(async(endpoint,input)=>{sent.push([endpoint,input]);return delegation},journal)
 assert.deepEqual(await second.recover(),delegation);assert.equal(raw,null)
 assert.deepEqual(sent,[['role-delegations/change',command],['role-delegations/change',command]])
})
test('分身执行确认逐字核验角色、版本与授权来源，撤销需本人动作',async()=>{
 const authorization={kind:'delegation' as const,delegationId,delegationVersion:1}
 const receipt={schema:'teloa.twin-execution-consent/v1',id:'44444444-4444-4444-8444-444444444444',ownerId:'owner',roleId,roleVersion:2,version:1,authorization,state:'active',createdAt:'2026-10-09T00:00:00.000Z'}
 const input={requestId,roleId,expectedRoleVersion:2,authorization},sent:unknown[]=[]
 const api=createRoleDelegationApi(async(endpoint,payload)=>{sent.push([endpoint,payload]);return endpoint.endsWith('/revoke')?{...receipt,version:2,state:'revoked'}:receipt})
 assert.deepEqual(await api.confirm(input),receipt)
 assert.equal((await api.revoke({requestId,consentId:receipt.id,expectedVersion:1})).state,'revoked')
 assert.equal(sent.length,2)
 await assert.rejects(createRoleDelegationApi(async()=>({...receipt,roleVersion:3})).confirm(input))
 await assert.rejects(createRoleDelegationApi(async()=>({...receipt,authorization:{...authorization,delegationVersion:2}})).confirm(input))
})

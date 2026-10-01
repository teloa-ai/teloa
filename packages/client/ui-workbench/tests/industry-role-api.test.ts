import test from 'node:test'
import assert from 'node:assert/strict'
import {createIndustryRoleApi} from '../src/client/industry-role-api.ts'
import {industryRoleAction,mergeIndustryRoleInstances} from '../src/client/industry-role-state.ts'

const request={requestId:'11111111-1111-4111-8111-111111111111',loadId:'22222222-2222-4222-8222-222222222222',itemInstanceId:'33333333-3333-4333-8333-333333333333'}
const role={id:'44444444-4444-4444-8444-444444444444',ownerId:'owner',version:3,state:'paused' as const,createdAt:'2026-09-12T00:00:00.000Z',updatedAt:'2026-09-12T00:01:00.000Z',name:'已编辑岗位',kind:'employee' as const,scopes:['general'],duty:'职责',dataScope:'范围',executionScope:'执行',skills:[],knowledge:['55555555-5555-4555-8555-555555555555']}
const paused={id:'66666666-6666-4666-8666-666666666666',ownerId:'owner',loadId:request.loadId,itemInstanceId:request.itemInstanceId,itemLocalId:'analyst-role',scope:'space-77777777-7777-4777-8777-777777777777',definitionHash:'a'.repeat(64),revision:4,state:'paused' as const,role,knowledge:[{itemInstanceId:'88888888-8888-4888-8888-888888888888',instanceId:'99999999-9999-4999-8999-999999999999',resourceId:role.knowledge[0]!,resourceVersion:2}],omittedKnowledge:[{itemInstanceId:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',reason:'not-instantiated' as const}],declarations:[{kind:'skill' as const,itemInstanceId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',status:'pending-adapter' as const},{kind:'mcp' as const,itemInstanceId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',status:'skipped' as const}],failure:null,createdAt:'2026-09-12T00:00:00.000Z',updatedAt:'2026-09-12T00:01:00.000Z'}

test('未知结果保留请求并原样恢复，真实终态才清理',async()=>{let raw:string|null=null,calls:unknown[]=[];const api=createIndustryRoleApi(async(method,payload)=>{calls.push([method,payload]);if(calls.length===1)throw Error('断线');return paused},{read:()=>raw,write:value=>{raw=value},clear:()=>{raw=null}});await assert.rejects(api.instantiate(request),/断线/);assert.deepEqual(api.pending(),request);assert.deepEqual(await api.recover(),paused);assert.equal(raw,null);assert.deepEqual(calls,[['industry-roles/instantiate',request],['industry-roles/instantiate',request]])})
test('pending和failed保留journal，无journal目录记录可继续核对',async()=>{for(const value of [{...paused,state:'pending' as const,role:null},{...paused,state:'failed' as const,role:null,failure:{code:'teloa/dependency-unavailable',message:'知识尚未启用'}}]){let raw:string|null=null;const api=createIndustryRoleApi(async()=>value,{read:()=>raw,write:v=>{raw=v},clear:()=>{raw=null}});await api.instantiate(request);assert.deepEqual(api.pending(),request);assert.ok(raw);assert.equal(industryRoleAction(value,undefined),'continue')}})
test('严格校验岗位、知识引用、遗漏原因、声明与状态组合，同时允许当前岗位合法编辑',async()=>{assert.deepEqual(await createIndustryRoleApi(async()=>paused).get(paused.id),paused);const edited={...paused,role:{...role,knowledge:[],skills:['native-skill'],scopes:['another-scope']}};assert.deepEqual(await createIndustryRoleApi(async()=>edited).get(paused.id),edited);for(const value of [{...paused,revision:0},{...paused,role:{...role,state:'active'}},{...paused,knowledge:[paused.knowledge[0],paused.knowledge[0]]},{...paused,omittedKnowledge:[{...paused.omittedKnowledge[0],reason:'unknown'}]},{...paused,declarations:[{...paused.declarations[0],kind:'tool'}]},{...paused,state:'failed',role:null,failure:null},{...paused,extra:true}])await assert.rejects(createIndustryRoleApi(async()=>value).get(paused.id),/格式/)})
test('目录拒绝重复实例、映射和真实岗位',async()=>{for(const items of [[paused,paused],[paused,{...paused,id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',itemInstanceId:'dddddddd-dddd-4ddd-8ddd-dddddddddddd'}]])await assert.rejects(createIndustryRoleApi(async()=>({items})).list(),/重复/)})
test('实例revision与role.version独立合并，退役不会被旧回包覆盖',()=>{const retired={...paused,revision:6,state:'retired' as const,role:{...role,version:5,state:'retired' as const}};assert.deepEqual(mergeIndustryRoleInstances([retired],[paused]),[retired]);const newerRole={...retired,revision:2,role:{...retired.role!,version:7}};assert.deepEqual(mergeIndustryRoleInstances([paused],[newerRole]),[{...paused,state:'retired',role:newerRole.role,failure:null}]);const pending={...paused,revision:8,state:'pending' as const,role:null};assert.deepEqual(mergeIndustryRoleInstances([retired],[pending]),[{...retired,revision:8,updatedAt:pending.updatedAt}])})

test('行业首次可信拒绝也可能已保存中间实例，只能按原身份恢复',async()=>{
 let raw:string|null=null,calls:unknown[]=[];const journal={read:()=>raw,write:(v:string)=>{raw=v},clear:()=>{raw=null}}
 const call=async(_method:string,payload:unknown)=>{calls.push(payload);if(calls.length===1)throw Object.assign(Error('建岗前预检失败'),{rejected:true,code:'teloa/forbidden'});return paused}
 const api=createIndustryRoleApi(call,journal)
 await assert.rejects(api.instantiate(request),error=>(error as {code?:unknown}).code==='teloa/industry-role-pending');const before=raw
 await assert.rejects(api.instantiate({...request,requestId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}),error=>(error as {code?:unknown}).code==='teloa/industry-role-pending');assert.equal(raw,before);assert.equal(calls.length,1)
 assert.deepEqual(await createIndustryRoleApi(call,journal).recover(),paused);assert.deepEqual(calls,[request,request]);assert.equal(raw,null)
})

test('行业pending和failed禁止更换加载项并有稳定恢复提示',async()=>{
 for(const state of ['pending','failed'] as const){let raw:string|null=null,calls=0;const api=createIndustryRoleApi(async()=>{calls++;return {...paused,state,role:null,failure:state==='failed'?{code:'teloa/dependency-unavailable',message:'依赖未就绪'}:null}},{read:()=>raw,write:v=>{raw=v},clear:()=>{raw=null}})
  await api.instantiate(request);const before=raw
  await assert.rejects(api.instantiate({...request,itemInstanceId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}),error=>(error as {code?:unknown}).code==='teloa/industry-role-pending');assert.equal(raw,before);assert.equal(calls,1)
 }
})

test('行业journal写入失败不发RPC，清理失败仍按原身份核对',async()=>{
 let calls=0;const broken=createIndustryRoleApi(async()=>{calls++;return paused},{read:()=>null,write:()=>{throw Error('配额不足')},clear:()=>{}})
 await assert.rejects(broken.instantiate(request),error=>(error as {code?:unknown}).code==='teloa/recovery-write-failed');assert.equal(calls,0);assert.deepEqual(broken.pending(),request)
 let raw:string|null=null,clearFails=true;const requests:unknown[]=[],api=createIndustryRoleApi(async(_method,input)=>{requests.push(input);return paused},{read:()=>raw,write:v=>{raw=v},clear:()=>{if(clearFails)throw Error('清理失败');raw=null}})
 await assert.rejects(api.instantiate(request),error=>(error as {code?:unknown}).code==='teloa/recovery-clear-failed');assert.ok(raw)
 clearFails=false;await api.recover();assert.deepEqual(requests,[request,request]);assert.equal(raw,null)
})

test('损坏的行业回包显示稳定校验错误，原请求与journal仍保留',async()=>{
 let raw:string|null=null;const api=createIndustryRoleApi(async()=>({...paused,revision:0}),{read:()=>raw,write:v=>{raw=v},clear:()=>{raw=null}})
 await assert.rejects(api.instantiate(request),error=>(error as {code?:unknown}).code==='teloa/invalid-host-response');assert.ok(raw);assert.deepEqual(api.pending(),request)
})

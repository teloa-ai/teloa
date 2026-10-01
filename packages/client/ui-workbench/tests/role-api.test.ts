import test from 'node:test'
import assert from 'node:assert/strict'
import {createRoleApi,readSavedRole} from '../src/client/role-api.ts'
import {WorkError} from '@teloa/contract'
import {createRoleHandler} from '../../../harness-dsh/src/roles.ts'
const legacyFields={name:'调查岗',kind:'employee' as const,scopes:['SOC'],duty:'调查',dataScope:'资料',executionScope:'只读',skills:[],knowledge:[]}
const fields={...legacyFields,responsibility:{triggers:[],autonomousActions:[],confirmationPoints:[],escalationRules:[],deliveryChecks:[]}}
const role={...fields,id:'16057272-ed9d-44a3-abe4-2ab04e056105',ownerId:'local:owner',version:1,state:'active',createdAt:'2026-09-11T00:00:00.000Z',updatedAt:'2026-09-11T00:00:00.000Z'}
test('未知创建结果保留同一请求，修改内容不能偷偷另建',async()=>{
 const requests:unknown[]=[],api=createRoleApi(async(_endpoint,input)=>{requests.push(input);if(requests.length===1)throw Error('断线');return role})
 await assert.rejects(api.create(fields),/断线/)
 await assert.rejects(api.create({...fields,name:'另一岗位'}),/核对/)
 assert.deepEqual(await api.create(fields),role);assert.deepEqual(requests[0],requests[1])
})
test('创建回包必须是 v1 在岗岗位且逐字段对应原请求，异常回包保留 journal',async()=>{
 let saved:string|null=null,attempt=0
 const api=createRoleApi(async()=>{
  attempt++
  if(attempt===1)return {...role,version:2}
  if(attempt===2)return {...role,state:'paused'}
  if(attempt===3)return {...role,duty:'被服务端改写'}
  return role
 },{read:()=>saved,write:value=>{saved=value},clear:()=>{saved=null}})
 await assert.rejects(api.create(fields),/响应与原请求/);assert.ok(saved)
 await assert.rejects(api.create(fields),/响应与原请求/);assert.ok(saved)
 await assert.rejects(api.create(fields),/响应与原请求/);assert.ok(saved)
 await api.create(fields)
 assert.equal(saved,null)
})
test('编辑回包必须保留规范化后的完整字段',async()=>{
 await assert.rejects(createRoleApi(async()=>({...role,version:2,knowledge:['被替换']})).edit(role.id,1,fields),/响应与目标、版本或字段不一致/)
})
test('目录、编辑响应拒绝损坏字段、重复身份和目标错配',async()=>{
 await assert.rejects(createRoleApi(async()=>[role,role]).list(),/格式/)
 await assert.rejects(createRoleApi(async()=>[{...role,state:'unknown'}]).list(),/格式/)
 await assert.rejects(createRoleApi(async()=>({...role,id:'other',version:2})).edit(role.id,1,fields),/格式|不一致/)
})
test('目录保留结构化职责与固定运行配置，旧岗位仍可缺省',async()=>{
 const legacyRole={...role,...legacyFields};delete (legacyRole as Partial<typeof role>).responsibility
 const configured={...role,id:'26057272-ed9d-44a3-abe4-2ab04e056105',responsibility:{triggers:['告警进入队列'],autonomousActions:['关联证据'],confirmationPoints:['提交前'],escalationRules:['证据冲突'],deliveryChecks:['附来源']},runtimeConfig:{agentPresetId:'standard'}}
 const rows=await createRoleApi(async()=>[legacyRole,configured]).list()
 assert.equal(rows[0]?.runtimeConfig,undefined)
 assert.deepEqual(rows[1]?.responsibility,configured.responsibility)
 assert.deepEqual(rows[1]?.runtimeConfig,configured.runtimeConfig)
})
test('重新构造客户端恢复请求与字段，确认成功才清理日志',async()=>{
 let value:string|null=null;const journal={read:()=>value,write:(next:string)=>{value=next},clear:()=>{value=null}},requests:unknown[]=[]
 const first=createRoleApi(async(_endpoint,input)=>{requests.push(input);throw Error('回包丢失')},journal)
 await assert.rejects(first.create(fields),/回包丢失/);assert.ok(value)
 const second=createRoleApi(async(_endpoint,input)=>{requests.push(input);return role},journal)
 assert.deepEqual(second.pendingFields(),fields);await second.create(fields);assert.deepEqual(requests[0],requests[1]);assert.equal(value,null)
})
test('日志写入失败或损坏不得发送新创建；清理失败仍保留原身份',async()=>{
 let calls=0
 const broken=createRoleApi(async()=>{calls++;return role},{read:()=>null,write:()=>{throw Error('配额不足')},clear:()=>{}})
 await assert.rejects(broken.create(fields),/配额不足/);assert.equal(calls,0)
 const corrupt=createRoleApi(async()=>{calls++;return role},{read:()=>'{bad',write:()=>{},clear:()=>{}})
 await assert.rejects(corrupt.create(fields),error=>(error as {code?:unknown}).code==='teloa/storage-corrupt');assert.equal(calls,0)
 let clearFails=true;const requests:unknown[]=[]
 const api=createRoleApi(async(_endpoint,input)=>{requests.push(input);return role},{read:()=>null,write:()=>{},clear:()=>{if(clearFails)throw Error('清理失败')}})
 await assert.rejects(api.create(fields),/清理失败/);clearFails=false;await api.create(fields);assert.deepEqual(requests[0],requests[1])
})
test('损坏创建日志仅阻止新建，不遮蔽已有岗位目录',async()=>{
 const api=createRoleApi(async()=>[role],{read:()=>'{bad',write:()=>{},clear:()=>{}})
 assert.equal(api.recoveryMessage()?.code,'teloa/storage-corrupt');assert.deepEqual(await api.list(),[role]);await assert.rejects(api.create(fields),error=>(error as {code?:unknown}).code==='teloa/storage-corrupt')
})

test('旧创建记录重试被预检拒绝不能证明旧请求未写入，不自动更换身份',async()=>{
 const oldRequestId='26057272-ed9d-44a3-abe4-2ab04e056105',newRequestId='36057272-ed9d-44a3-abe4-2ab04e056105'
 let saved:string|null=JSON.stringify({schema:'teloa.role-create/v1',requestId:oldRequestId,fields:legacyFields}),calls:unknown[]=[]
 const complete={...fields,responsibility:{triggers:['收到调查任务'],autonomousActions:['检索已授权资料'],confirmationPoints:['对外执行前'],escalationRules:['证据冲突'],deliveryChecks:['附上来源']}}
 const created={...role,...complete,id:'46057272-ed9d-44a3-abe4-2ab04e056105'}
 const api=createRoleApi(async(_endpoint,input)=>{
  calls.push(input)
  if(calls.length===1)throw Object.assign(Error('旧格式不能新写入'),{rejected:true,code:'teloa/invalid-input'})
  return created
 },{read:()=>saved,write:value=>{saved=value},clear:()=>{saved=null}},()=>newRequestId)
 assert.deepEqual(api.pendingFields(),fields)
 await assert.rejects(api.create(complete),error=>(error as {code?:unknown}).code==='teloa/role-create-pending')
 assert.deepEqual(calls,[{requestId:oldRequestId,fields:legacyFields}])
 assert.equal(JSON.parse(saved!).requestId,oldRequestId)
 assert.deepEqual(api.pendingFields(),fields)
})

test('旧创建记录的未知失败保留原请求，且不能夹带修改其他岗位字段',async()=>{
 const requestId='26057272-ed9d-44a3-abe4-2ab04e056105'
 let saved:string|null=JSON.stringify({schema:'teloa.role-create/v1',requestId,fields:legacyFields}),calls=0
 const api=createRoleApi(async()=>{calls++;throw Error('断线')},{read:()=>saved,write:value=>{saved=value},clear:()=>{saved=null}})
 const complete=api.pendingFields()!
 await assert.rejects(api.create({...complete,name:'被修改'}),/原内容/)
 await assert.rejects(api.create(complete),/断线/)
 assert.equal(calls,1);assert.ok(saved)
})

test('岗位响应严格拒绝伪 UUID 与非规范 ISO 时间',()=>{
 assert.throws(()=>readSavedRole({...role,id:'------------------------------------'}),/格式/)
 assert.throws(()=>readSavedRole({...role,createdAt:'2026-09-11'}),/格式/)
})

test('首次可信事务拒绝释放本次请求，可以立即添加其他同事并连续成功',async()=>{
 for(const code of ['teloa/invalid-input','teloa/forbidden','teloa/conflict','teloa/version-conflict','teloa/source-unavailable']){
  let saved:string|null=null,next=0
  const calls:Array<{requestId:string;fields:typeof fields}>=[],ids=['26057272-ed9d-44a3-abe4-2ab04e056105','36057272-ed9d-44a3-abe4-2ab04e056105','46057272-ed9d-44a3-abe4-2ab04e056105'] as const
  const api=createRoleApi(async(_endpoint,input)=>{const row=input as typeof calls[number];calls.push(row);if(calls.length===1)throw Object.assign(Error('宿主内部内容'),{rejected:true,code});return {...role,...row.fields,id:row.requestId}},{read:()=>saved,write:v=>{saved=v},clear:()=>{saved=null}},()=>ids[next++]!)
  await assert.rejects(api.create(fields),error=>(error as {code?:unknown}).code===code)
  assert.equal(api.pendingFields(),undefined);assert.equal(saved,null)
  const second={...fields,name:'第二位同事'},third={...fields,name:'第三位同事'}
  assert.equal((await api.create(second)).name,second.name);assert.equal((await api.create(third)).name,third.name)
  assert.deepEqual(calls.map(row=>row.requestId),ids);assert.equal(saved,null)
 }
})

test('成功失回包后预检明确拒绝仍保留原身份，核对成功之前不能另建',async()=>{
 let saved:string|null=null,stored:typeof role|undefined,drop=true,precheckDenied=false;const calls:unknown[]=[],journal={read:()=>saved,write:(v:string)=>{saved=v},clear:()=>{saved=null}},definition={...fields,knowledge:['56057272-ed9d-44a3-abe4-2ab04e056105']}
 // 真实宿主handler执行知识预检；领域存储用受控夹具保存，派发成功后再丢回包。
 const handler=createRoleHandler('local:owner',async()=>({list:async()=>[],edit:async()=>{throw Error('not used')},create:async(_owner,input)=>{stored??={...role,...(input as {fields:typeof fields}).fields};return stored}}),async()=>{if(precheckDenied)throw new WorkError('teloa/invalid-input','当前资料预检拒绝')})
 const call=async(endpoint:string,input:unknown)=>{calls.push(input);try{const result=await handler(endpoint,input);if(drop){drop=false;throw Error('成功回包丢失')}return result}catch(error){if(error instanceof WorkError)throw Object.assign(Error(error.message),{rejected:true,code:error.code});throw error}}
 const first=createRoleApi(call,journal)
 await assert.rejects(first.create(definition),error=>(error as {code?:unknown}).code==='teloa/role-create-pending');assert.deepEqual(stored?.knowledge,definition.knowledge);precheckDenied=true
 const before=saved,restored=createRoleApi(call,journal)
 await assert.rejects(restored.create(definition),error=>(error as {code?:unknown}).code==='teloa/role-create-pending')
 assert.equal(saved,before);assert.deepEqual(calls[0],calls[1]);assert.deepEqual(restored.pendingFields(),definition)
 await assert.rejects(restored.create({...definition,name:'下一位'}),error=>(error as {code?:unknown}).code==='teloa/role-create-pending');assert.equal(calls.length,2)
 precheckDenied=false;await restored.create(definition);assert.deepEqual(calls[2],calls[0]);assert.equal(saved,null)
})

test('仅code或不保证回滚的可信拒绝继续未知，不能释放原内容',async()=>{
 for(const error of [Object.assign(Error('伪拒绝'),{code:'teloa/forbidden'}),Object.assign(Error('回包确认失败'),{rejected:true,code:'teloa/host-unavailable'}),Object.assign(Error('拒绝码格式损坏'),{rejected:true,code:['teloa/forbidden']})]){
  let saved:string|null=null,calls=0;const api=createRoleApi(async()=>{calls++;throw error},{read:()=>saved,write:v=>{saved=v},clear:()=>{saved=null}})
  await assert.rejects(api.create(fields),value=>(value as {code?:unknown}).code==='teloa/role-create-pending');assert.ok(saved)
  await assert.rejects(api.create({...fields,name:'另一位'}),value=>(value as {code?:unknown}).code==='teloa/role-create-pending');assert.equal(calls,1)
 }
})

test('保存与清理恢复记录失败都有稳定code且保留原请求',async()=>{
 let calls=0;const broken=createRoleApi(async()=>{calls++;return role},{read:()=>null,write:()=>{throw Error('配额不足')},clear:()=>{}})
 await assert.rejects(broken.create(fields),error=>(error as {code?:unknown}).code==='teloa/recovery-write-failed');assert.equal(calls,0);assert.deepEqual(broken.pendingFields(),fields)
 let saved:string|null=null,clearFails=true;const requests:unknown[]=[],api=createRoleApi(async(_endpoint,input)=>{requests.push(input);throw Object.assign(Error('未写入'),{rejected:true,code:'teloa/forbidden'})},{read:()=>saved,write:v=>{saved=v},clear:()=>{if(clearFails)throw Error('清理失败');saved=null}})
 await assert.rejects(api.create(fields),error=>(error as {code?:unknown}).code==='teloa/recovery-clear-failed');assert.ok(saved);assert.deepEqual(api.pendingFields(),fields)
 clearFails=false;await assert.rejects(api.create(fields),error=>(error as {code?:unknown}).code==='teloa/role-create-pending');assert.deepEqual(requests[0],requests[1]);assert.ok(saved)
})

test('双击创建仅保留一次RPC并显示正在核对的稳定错误',async()=>{
 let finish!:(value:unknown)=>void,calls=0;const api=createRoleApi(async()=>{calls++;return new Promise(resolve=>{finish=resolve})})
 const first=api.create(fields)
 await assert.rejects(api.create(fields),error=>(error as {code?:unknown}).code==='teloa/role-create-busy');assert.equal(calls,1)
 finish(role);await first
})

test('创建回包错配有稳定提示，随后明确拒绝也不能释放原请求',async()=>{
 let saved:string|null=null,calls=0;const requests:unknown[]=[],api=createRoleApi(async(_endpoint,input)=>{requests.push(input);if(++calls===1)return {...role,duty:'错配'};throw Object.assign(Error('当前预检拒绝'),{rejected:true,code:'teloa/forbidden'})},{read:()=>saved,write:v=>{saved=v},clear:()=>{saved=null}})
 await assert.rejects(api.create(fields),error=>(error as {code?:unknown}).code==='teloa/invalid-host-response');const before=saved
 await assert.rejects(api.create(fields),error=>(error as {code?:unknown}).code==='teloa/role-create-pending');assert.equal(saved,before);assert.deepEqual(requests[0],requests[1])
})

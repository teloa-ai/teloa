import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {createBusinessResponsibilityApi} from '../src/client/business-responsibility-api.ts'
const space=randomUUID(),role=randomUUID()
const request=()=>({requestId:randomUUID(),scope:'sales',expectedVersion:0,role:{id:role,expectedVersion:2}})
const result=(input= request())=>({scope:input.scope,version:input.expectedVersion+1,roleId:input.role?.id??null,selectedRoleVersion:input.role?.expectedVersion??null,currentRoleVersion:input.role?.expectedVersion??null,availability:input.role?'ready':'none'})
const none={scope:'sales',version:0,roleId:null,selectedRoleVersion:null,currentRoleVersion:null,availability:'none'}
function fixture(){const rows=new Map<string,string>(),calls:Array<{method:string;input:any}>=[];let active=true,respond:(method:string,input:any)=>Promise<unknown>=async(method,input)=>method.endsWith('/read')?none:method.endsWith('/receipt')?null:result(input)
 const storage={getItem:(key:string)=>rows.get(key)??null,setItem:(key:string,value:string)=>{rows.set(key,value)},removeItem:(key:string)=>{rows.delete(key)}}
 const options={storage,personalSpaceId:space,isCurrent:()=>active}
 const call=async(method:string,input:unknown)=>{calls.push({method,input});return respond(method,input)}
 return {rows,calls,storage,options,api:createBusinessResponsibilityApi(call,options),recreate:()=>createBusinessResponsibilityApi(call,options),respond:(fn:typeof respond)=>{respond=fn},leave:()=>{active=false}}
}
test('严格read/set/receipt核对scope和固定选择，设置不调用Task或Run',async()=>{
 const f=fixture(),input=request();assert.deepEqual(await f.api.read({scope:'sales'}),none)
 assert.deepEqual(await f.api.set(input),result(input));assert.equal(f.api.pending('sales'),null)
 assert.equal(await f.api.receipt(input),null)
 assert.deepEqual(f.calls.map(row=>row.method),['business-responsibility/read','business-responsibility/set','business-responsibility/receipt'])
 for(const wrong of [{...result(input),scope:'other'},{...result(input),version:2},{...result(input),roleId:randomUUID()},{...result(input),selectedRoleVersion:1}]){
  const g=fixture();g.respond(async()=>wrong);await assert.rejects(g.api.set(input));assert.equal(g.api.pending('sales')?.requestId,input.requestId)
 }
})
test('已提交失回包跨刷新只读核对receipt，原回执后再读当前新版本',async()=>{
 const f=fixture(),input=request();f.respond(async()=>{throw Error('lost')});await assert.rejects(f.api.set(input))
 const current={...result(input),version:3,roleId:null,selectedRoleVersion:null,currentRoleVersion:null,availability:'none'}
 f.respond(async method=>method.endsWith('/receipt')?result(input):current)
 const api=f.recreate();assert.equal(api.pending('sales')?.requestId,input.requestId)
 assert.deepEqual(await api.reconcile({scope:'sales'}),current);assert.equal(api.pending('sales'),null)
 assert.deepEqual(f.calls.map(row=>row.method),['business-responsibility/set','business-responsibility/receipt','business-responsibility/read'])
})
test('receipt为空或失败保留pending，明确recover才重试同一set，不能换ID或选择',async()=>{
 const f=fixture(),input=request();f.respond(async()=>{throw Error('lost')});await assert.rejects(f.api.set(input))
 f.respond(async method=>method.endsWith('/receipt')?null:none)
 const api=f.recreate();assert.deepEqual(await api.reconcile({scope:'sales'}),none);assert.deepEqual(api.pending('sales'),input)
 await assert.rejects(api.set(input));await assert.rejects(api.set({...input,requestId:randomUUID()}));await assert.rejects(api.set({...input,role:null}))
 f.respond(async()=>{throw Error('offline')});await assert.rejects(api.reconcile({scope:'sales'}));assert.deepEqual(api.pending('sales'),input)
 f.respond(async(method,data)=>method.endsWith('/receipt')?null:method.endsWith('/read')?result(input):result(data))
 assert.deepEqual(await api.recover({scope:'sales'}),result(input));assert.equal(api.pending('sales'),null)
 assert.equal(f.calls.filter(row=>row.method.endsWith('/set')).length,2)
 assert.deepEqual(f.calls.filter(row=>row.method.endsWith('/set')).map(row=>row.input),[input,input])
})
test('坏/空journal、写失败或写后读回不一致均零写请求',async()=>{
 for(const bad of ['', '{bad}', JSON.stringify({schema:'wrong',request:request()})]){
  const f=fixture();f.storage.getItem=()=>bad;await assert.rejects(f.api.set(request()));assert.equal(f.calls.length,0)
 }
 for(const kind of ['throw','ignore'] as const){const f=fixture();f.storage.setItem=()=>{if(kind==='throw')throw Error('quota')};await assert.rejects(f.api.set(request()));assert.equal(f.calls.length,0)}
 const f=fixture();f.respond(async()=>{throw Error('lost')});await assert.rejects(f.api.set(request()))
 const [key,value]=f.rows.entries().next().value!;const parsed=JSON.parse(value);parsed.request.scope='other';f.rows.set(key,JSON.stringify(parsed));assert.throws(()=>f.api.pending('sales'))
})
test('scope与personal namespace隔离，不接受失效实例的晚包或新写入',async()=>{
 const f=fixture(),input=request();let resolve!:(value:unknown)=>void;f.respond(()=>new Promise(done=>{resolve=done}))
 const pending=f.api.set(input);f.leave();resolve(result(input));await assert.rejects(pending);assert.equal(f.rows.size,1)
 await assert.rejects(f.api.read({scope:'sales'}));assert.equal(f.calls.length,1)
 const g=createBusinessResponsibilityApi(async()=>none,{...f.options,isCurrent:()=>true,personalSpaceId:randomUUID()});assert.equal(g.pending('sales'),null)
 assert.throws(()=>createBusinessResponsibilityApi(async()=>none,{...f.options,personalSpaceId:'shared'}))
})
test('并发双击单次set；成功清理失败仍保留原pending可恢复',async()=>{
 const f=fixture(),input=request();let resolve!:(value:unknown)=>void;f.respond(()=>new Promise(done=>{resolve=done}))
 const first=f.api.set(input);await assert.rejects(f.api.set(input));assert.equal(f.calls.length,1)
 f.storage.removeItem=()=>{};resolve(result(input));await assert.rejects(first);assert.deepEqual(f.api.pending('sales'),input)
})
test('共享读器拒绝非法输入/缺项回包，规范化请求后保存；读取晚包也失效',async()=>{
 const f=fixture(),input=request()
 await assert.rejects(f.api.read({scope:'general'}));assert.equal(f.calls.length,0)
 f.respond(async()=>({...none,scope:'support'}));await assert.rejects(f.api.read({scope:'sales'}))
 f.respond(async()=>undefined);await assert.rejects(f.api.receipt(input))
 f.respond(async()=>({...result(input),roleId:randomUUID()}));await assert.rejects(f.api.receipt(input))
 f.respond(async(_method,data)=>result(data));await f.api.set({...input,requestId:input.requestId.toUpperCase(),role:{...input.role,id:input.role.id.toUpperCase()}})
 assert.deepEqual(f.calls.at(-1)?.input,input)
 let resolve!:(value:unknown)=>void;f.respond(()=>new Promise(done=>{resolve=done}))
 const read=f.api.read({scope:'sales'});f.leave();resolve(none);await assert.rejects(read)
})
test('服务端明确拒绝后只能显式重新选择，先核原receipt，离线或普通code不能清pending',async()=>{
 const f=fixture(),input=request(),rejection=Object.assign(Error('version changed'),{rejected:true,code:'teloa/version-conflict'})
 const current={...none,version:2}
 f.respond(async method=>{if(method.endsWith('/set'))throw rejection;if(method.endsWith('/receipt'))return null;return current})
 await assert.rejects(f.api.set(input));assert.deepEqual(f.api.pending('sales'),input);assert.equal(f.api.canReselect('sales'),true)
 const api=f.recreate();assert.equal(api.canReselect('sales'),false);await assert.rejects(api.reselect({scope:'sales'}));assert.deepEqual(api.pending('sales'),input)
 await assert.rejects(api.recover({scope:'sales'}));assert.equal(api.canReselect('sales'),true)
 f.respond(async()=>{throw Error('offline')});await assert.rejects(api.reselect({scope:'sales'}));assert.deepEqual(api.pending('sales'),input)
 f.respond(async method=>method.endsWith('/receipt')?null:current);const offset=f.calls.length
 assert.deepEqual(await api.reselect({scope:'sales'}),current);assert.equal(api.pending('sales'),null)
 assert.deepEqual(f.calls.slice(offset).map(row=>row.method),['business-responsibility/receipt','business-responsibility/read'])
 for(const cause of [Error('offline'),Object.assign(Error('not verified'),{code:'teloa/version-conflict'}),Object.assign(Error('forbidden'),{rejected:true,code:'teloa/forbidden'})]){
  const g=fixture();g.respond(async()=>{throw cause});await assert.rejects(g.api.set(request()));assert.equal(g.api.canReselect('sales'),false);await assert.rejects(g.api.reselect({scope:'sales'}));assert.equal(g.calls.length,1)
 }
})
test('重新选择时原成功receipt优先，读取当前值后不能把旧回执作为新选择',async()=>{
 const f=fixture(),input=request();f.respond(async()=>{throw Object.assign(Error('rejected'),{rejected:true,code:'teloa/version-conflict'})});await assert.rejects(f.api.set(input));assert.equal(f.api.canReselect('sales'),true)
 const current={...none,version:3};f.respond(async method=>method.endsWith('/receipt')?result(input):current)
 assert.deepEqual(await f.api.reselect({scope:'sales'}),current);assert.equal(f.api.pending('sales'),null);assert.equal(f.calls.filter(row=>row.method.endsWith('/set')).length,1)
})

test('明确版本拒绝仍需单调证据：同版本/缺角色不清，真实角色版本增长才允许重选',async()=>{
 const f=fixture(),input=request(),roleRow={name:'Mina',kind:'employee',scopes:['sales'],duty:'Follow up',dataScope:'Records',executionScope:'Read',skills:[],knowledge:[],id:input.role.id,ownerId:'local:owner',version:2,state:'active',createdAt:'2026-09-29T00:00:00.000Z',updatedAt:'2026-09-29T00:00:00.000Z'}
 f.respond(async()=>{throw Object.assign(Error('conflict'),{rejected:true,code:'teloa/version-conflict'})});await assert.rejects(f.api.set(input))
 for(const rows of [[],[roleRow]]){
  f.respond(async method=>method==='roles/list'?rows:method.endsWith('/receipt')?null:none)
  await assert.rejects(f.api.reselect({scope:'sales'}));assert.deepEqual(f.api.pending('sales'),input)
 }
 f.respond(async method=>method==='roles/list'?[{...roleRow,version:3}]:method.endsWith('/receipt')?null:none)
 assert.deepEqual(await f.api.reselect({scope:'sales'}),none);assert.equal(f.api.pending('sales'),null)
})
test('重选不与原请求在途竞争，重试变未知时旧拒绝证明立即失效',async()=>{
 const f=fixture(),input=request(),rejection=Object.assign(Error('version'),{rejected:true,code:'teloa/version-conflict'})
 f.respond(async()=>{throw rejection});await assert.rejects(f.api.set(input))
 let finish!:(value:unknown)=>void,entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve})
 f.respond(async method=>{if(method.endsWith('/receipt'))return null;return new Promise(resolve=>{finish=resolve;entered()})})
 const recovering=f.api.recover({scope:'sales'});await started
 await assert.rejects(f.api.reselect({scope:'sales'}));assert.equal(f.api.canReselect('sales'),false)
 finish({...result(input),scope:'other'});await assert.rejects(recovering);assert.equal(f.api.canReselect('sales'),false);assert.deepEqual(f.api.pending('sales'),input)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
const module=await import('../src/business-responsibility.ts').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return {} as typeof import('../src/business-responsibility.ts');throw error})
const input={scope:'sales',requestId:randomUUID(),expectedVersion:0,role:{id:randomUUID(),expectedVersion:1}}
const selected={scope:'sales',version:1,roleId:input.role.id,selectedRoleVersion:1,availability:'ready' as const,currentRoleVersion:1}
function fixture(){
 assert.equal(typeof module.createBusinessResponsibilityHandler,'function')
 let scopes=['sales'],calls=0,value:unknown=selected
 const run=async(actor:unknown,request:unknown)=>{calls++;assert.deepEqual(actor,{ownerId:'self',scopeIds:['sales']});assert.ok(request);return value}
 const services={responsibility:{read:run,set:run,receipt:run}}
 const handler=module.createBusinessResponsibilityHandler('self',async()=>scopes,async()=>services as never)
 return {handler,scopes:(v:string[])=>scopes=v,value:(v:unknown)=>value=v,calls:()=>calls}
}
test('负责人handler复用严格read/set/完整原请求receipt，当前授权每次刷新',async()=>{
 const f=fixture()
 for(const [endpoint,payload] of [['read',{scope:'sales'}],['set',input],['receipt',input]] as const)assert.deepEqual(await f.handler('business-responsibility/'+endpoint,payload),selected)
 f.value(null);assert.equal(await f.handler('business-responsibility/receipt',input),null)
 f.scopes([]);const before=f.calls();await assert.rejects(f.handler('business-responsibility/receipt',input),{code:'teloa/forbidden'});assert.equal(f.calls(),before)
})
test('handler在服务前拒绝额外身份、枚举回执、general、取消及未知端点',async()=>{
 const f=fixture()
 for(const [endpoint,payload] of [['read',{scope:'sales',owner:'foreign'}],['receipt',{requestId:input.requestId}],['set',{...input,scope:'general'}]] as const)await assert.rejects(f.handler('business-responsibility/'+endpoint,payload))
 await assert.rejects(f.handler('business-responsibility/run',input),{code:'teloa/not-found'})
 const abort=new AbortController();abort.abort();await assert.rejects(f.handler('business-responsibility/set',input,abort.signal));assert.equal(f.calls(),0)
})
test('状态不能冒充原回执：set/receipt检查scope、结果版本及选择，read失败不能变未设置',async()=>{
 const f=fixture()
 for(const value of [{...selected,scope:'other'},{...selected,version:2},{...selected,roleId:randomUUID()},{...selected,selectedRoleVersion:2,currentRoleVersion:2},null,undefined]){
  f.value(value);await assert.rejects(f.handler('business-responsibility/set',input),{code:'teloa/invalid-host-response'})
  if(value!==null)await assert.rejects(f.handler('business-responsibility/receipt',input),{code:'teloa/invalid-host-response'})
 }
 f.value(null);await assert.rejects(f.handler('business-responsibility/read',{scope:'sales'}),{code:'teloa/invalid-host-response'})
})

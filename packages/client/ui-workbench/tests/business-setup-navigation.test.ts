import assert from 'node:assert/strict'
import {test} from 'node:test'
import {businessSetupOrigin,businessSetupReturnOrigin,openBusinessSetupDestination,returnToBusinessSetup,createBusinessSetupReader,createGenerationGuardedCall} from '../src/client/business-setup-navigation.ts'
import type {BusinessBuilderApi} from '../src/client/business-builder-api.ts'
const token={} as BusinessBuilderApi
const identity={status:'ready',namespace:'person-a',api:token}
const target={scope:'sales',section:'data' as const,objectType:'order',id:'one',match:{field:'state',value:'new'}}

test('准备导航保留当前本人和精确业务目标；嵌入页优先且不复制别的业务',()=>{
 const origin=businessSetupOrigin({scope:'sales',title:'订单',identity,mainTarget:target})!
 assert.equal(origin.namespace,'person-a');assert.equal(origin.api,token);assert.deepEqual(origin.target,target)
 target.match.value='changed';assert.equal(origin.target.match?.value,'new');target.match.value='new'
 assert.deepEqual(businessSetupOrigin({scope:'sales',title:'订单',identity,mainTarget:{scope:'support',section:'work'},embeddedTarget:target})!.target,target)
 assert.deepEqual(businessSetupOrigin({scope:'sales',title:'订单',identity,mainTarget:{scope:'support',section:'work'}})!.target,{scope:'sales',section:'overview'})
 assert.equal(businessSetupOrigin({scope:'sales',title:'订单',identity:{...identity,status:'loading'},mainTarget:target}),null)
})
test('返回仅在现有配置页可见；换本人、API或进入另一业务清除',()=>{
 const origin=businessSetupOrigin({scope:'sales',title:'订单',identity,mainTarget:target})!
 for(const view of ['team','resources','market','capabilities','settings'])assert.equal(businessSetupReturnOrigin(origin,{identity,view}),origin)
 for(const view of ['home','messages','tasks','spaces'])assert.equal(businessSetupReturnOrigin(origin,{identity,view}),null)
 assert.equal(businessSetupReturnOrigin(origin,{identity:{...identity,namespace:'person-b'},view:'team'}),null)
 assert.equal(businessSetupReturnOrigin(origin,{identity:{...identity,api:{} as BusinessBuilderApi},view:'team'}),null)
 assert.equal(businessSetupReturnOrigin(origin,{identity:{...identity,status:'loading'},view:'team'}),null)
})
test('六种准备动作复用配置入口；具体连接目录使用官方ID，不创建会话或任务',()=>{
 const calls:unknown[]=[]
 const ports={colleagues:(scope:string)=>calls.push(['team',scope]),role:(id:string)=>calls.push(['role',id]),resources:()=>calls.push(['resources']),category:(category:string)=>calls.push(['category',category]),catalogEntry:(catalogId:string)=>calls.push(['entry',catalogId])}
 for(const action of [{kind:'colleagues'},{kind:'role',id:'role-a'},{kind:'resources'},{kind:'skills'},{kind:'connections'},{kind:'connection',catalogId:'official-crm'}] as const)openBusinessSetupDestination('sales',action,ports)
 assert.deepEqual(calls,[['team','sales'],['role','role-a'],['resources'],['category','skill'],['category','connector'],['category','connector'],['entry','official-crm']])
})
test('重复返回只显式进入原业务并刷新内页；失效身份不导航',()=>{
 const origin=businessSetupOrigin({scope:'sales',title:'订单',identity,mainTarget:target})!,calls:unknown[]=[]
 const ports={refresh:()=>calls.push('refresh'),enter:(value:unknown)=>calls.push(value)}
 returnToBusinessSetup(origin,identity,ports);returnToBusinessSetup(origin,identity,ports)
 assert.deepEqual(calls,['refresh',target,'refresh',target]);returnToBusinessSetup(origin,{...identity,namespace:'person-b'},ports);assert.equal(calls.length,4)
})
test('原MCP实例绑定创建代次；旧实例后续调用拒绝，新实例重新读取',async()=>{
 let generation:string|undefined;let calls=0
 const endpoint=async()=>{calls++;return {items:[]}}
 const startup=createGenerationGuardedCall(()=>generation,endpoint)
 await assert.rejects(startup('mcp-connections/list',{}));assert.equal(calls,0)
 generation='one';const old=createGenerationGuardedCall(()=>generation,endpoint)
 assert.deepEqual(await old('mcp-connections/list',{}),{items:[]})
 generation='two';await assert.rejects(old('mcp-connections/list',{}));assert.equal(calls,1)
 const fresh=createGenerationGuardedCall(()=>generation,endpoint);assert.deepEqual(await fresh('mcp-connections/list',{}),{items:[]})

})
test('本人装配只读使用同一token，并在目录及技能前后核验身份',async()=>{
 let currentIdentity=identity,generation='one',calls:string[]=[]
 const guarded=async<T>(name:string,value:T)=>{calls.push(name);return value}
 const currentToken={current:async()=>guarded('current',{scope:'sales',version:1,hash:'a'})} as unknown as BusinessBuilderApi
 currentIdentity={...identity,api:currentToken}
 const reader=createBusinessSetupReader({namespace:'person-a',token:currentToken,identity:()=>currentIdentity,generation:()=>generation,ports:{responsibility:{read:async()=>guarded('responsibility',{roleId:null,currentRoleVersion:null})},roles:{list:async()=>guarded('roles',[])},resources:{directory:async()=>guarded('directory',{resources:[]}),sources:async()=>guarded('sources',[])},skills:async()=>guarded('skills',[]),connections:{list:async()=>guarded('connections',[])}} as any})
 const input={scope:'sales',expectedVersion:1,expectedHash:'a'}
 const value=await reader.read(input);assert.equal(value.connections.status,'observed');assert.equal(calls.filter(name=>name==='current').length,2)
 calls=[];currentIdentity={...currentIdentity,namespace:'person-b'};await assert.rejects(reader.read(input));assert.deepEqual(calls,[])
 currentIdentity={...currentIdentity,namespace:'person-a'};generation='two';await assert.rejects(reader.read(input));assert.deepEqual(calls,[])
})
test('目录调用发生认证切换时迟到数据不能成为可用投影',async()=>{
 let currentIdentity=identity,release:(()=>void)|undefined
 const currentToken={current:async()=>({scope:'sales',version:1,hash:'a'})} as unknown as BusinessBuilderApi;currentIdentity={...identity,api:currentToken}
 const reader=createBusinessSetupReader({namespace:'person-a',token:currentToken,identity:()=>currentIdentity,generation:()=>'one',ports:{responsibility:{read:async()=>({roleId:null,currentRoleVersion:null})},roles:{list:async()=>{await new Promise<void>(r=>release=r);return []}},resources:{directory:async()=>({resources:[]}),sources:async()=>[]},skills:async()=>[],connections:{list:async()=>[]}} as any})
 const pending=reader.read({scope:'sales',expectedVersion:1,expectedHash:'a'});await new Promise(r=>setTimeout(r,0));currentIdentity={...currentIdentity,api:token};release!();await assert.rejects(pending)
})

test('同连接代次换本人/API后旧实例及多步骤后续调用拒绝，不调用宿主',async()=>{
 let current=identity,calls:string[]=[]
 const call=createGenerationGuardedCall(()=>'one',async(endpoint:string)=>{calls.push(endpoint);return {}},()=>current.namespace===identity.namespace&&current.api===identity.api)
 await call('mcp-connections/list',{})
 current={...identity,api:{} as BusinessBuilderApi}
 await assert.rejects(call('mcp-connections/oauth-start',{}));assert.deepEqual(calls,['mcp-connections/list'])
})

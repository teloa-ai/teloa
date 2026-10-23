import test from 'node:test'
import assert from 'node:assert/strict'
import {createSkillInstallationsHandler} from '../src/skill-installations.ts'
import {WorkError} from '@teloa/contract'
const id='12345678-1234-4234-8234-123456789012',source={kind:'atomic' as const,contentId:id},fixed={...source,contentHash:'a'.repeat(64),resourceId:'test',resourceVersion:'1.0.0'},native={name:'test',description:'说明',modelInvocable:true,userInvocable:true,bodyHash:'b'.repeat(64)},record={id,ownerId:'owner',source:fixed,bundleHash:'c'.repeat(64),native,state:'installed' as const,version:2,createdAt:'2026-09-12T00:00:00.000Z',updatedAt:'2026-09-12T00:00:00.000Z'}
test('安装宿主入口绑定本人、拒绝路径和多余字段，真实回执保留',async()=>{
 let calls=0;const methods={preview:async()=>({source:fixed,bundleHash:record.bundleHash,native,files:[{path:'SKILL.md',hash:'d'.repeat(64),size:1}]}),install:async(owner:string)=>{assert.equal(owner,'owner');return {installation:record,source:fixed}},get:async()=>record,list:async()=>({items:[record],usages:[]}),uninstall:async(owner:string,value:unknown)=>{assert.equal(owner,'owner');return {requestId:(value as {requestId:string}).requestId,installationId:id,nativeName:'test',bundleHash:record.bundleHash,removedAt:'2026-09-12T00:00:00.000Z'}}}
 const handler=createSkillInstallationsHandler('owner',async()=>{calls++;return methods})
 for(const extra of [{ownerId:'other'},{path:'/tmp'},{managedRoot:'/tmp'}])await assert.rejects(handler('skill-installations/install',{requestId:id,source,expectedBundleHash:record.bundleHash,...extra}),{code:'teloa/invalid-input'})
 assert.equal(calls,0);assert.deepEqual(await handler('skill-installations/install',{requestId:id,source,expectedBundleHash:record.bundleHash}),{installation:record,source:fixed});assert.deepEqual(await handler('skill-installations/list',{}),{items:[record],usages:[]})
 const wrong=createSkillInstallationsHandler('other',async()=>methods);await assert.rejects(wrong('skill-installations/get',{installationId:id}),{code:'teloa/invalid-host-response'})
 const cause=new WorkError('teloa/storage-corrupt','实际文件变化'),failed=createSkillInstallationsHandler('owner',async()=>{throw cause});await assert.rejects(failed('skill-installations/get',{installationId:id}),error=>error===cause)
})
test('拒绝同摘要串来源与坏元数据，保留public请求复用atomic安装',async()=>{
 const other='22345678-1234-4234-8234-123456789012',request={requestId:id,source,expectedBundleHash:record.bundleHash}
 const make=(value:unknown)=>createSkillInstallationsHandler('owner',async()=>({preview:async()=>value,install:async()=>value,get:async()=>value,list:async()=>value,uninstall:async()=>value}) as never)
 for(const value of [{...record,source:{...fixed,contentId:other}},{...record,native:{bodyHash:native.bodyHash,modelInvocable:true,userInvocable:true,allowedTools:['write']}},{...record,createdAt:undefined},{...record,updatedAt:'bad'},{...record,source:{...fixed,kind:'garbage'}}])await assert.rejects(make({installation:value,source:fixed})('skill-installations/install',request),{code:'teloa/invalid-host-response'})
 const publicSource={kind:'industry-public',loadId:other,itemInstanceId:id,contentId:other,contentHash:'d'.repeat(64),resourceId:'alias',resourceVersion:'1.0.0',sourceContentId:id,sourceContentHash:fixed.contentHash,sourceResourceId:fixed.resourceId,sourceResourceVersion:fixed.resourceVersion};const result={installation:record,source:publicSource}
 assert.deepEqual(await make(result)('skill-installations/install',{...request,source:{kind:'industry',loadId:other,itemInstanceId:id}}),result)
 await assert.rejects(make({source:fixed,bundleHash:record.bundleHash,native:{...native,allowedTools:[]},files:[]})('skill-installations/preview',{source}),{code:'teloa/invalid-host-response'})
 await assert.rejects(make({items:[record],usages:[{loadId:id,itemInstanceId:id,installationId:id},{loadId:id,itemInstanceId:id,installationId:id}]})('skill-installations/list',{}),{code:'teloa/invalid-host-response'})
})
test('默认工作区观测不接受客户端范围，坏身份和缺失结果不冒充可用',async()=>{
 let calls=0;const current={...native,provider:'teloa-market',source:'custom'},result={installationId:id,scope:'default-workspace',state:'available',current}
 const handler=createSkillInstallationsHandler('owner',async()=>{throw Error('不用存储工厂')},async installationId=>{calls++;assert.equal(installationId,id);return result})
 await assert.rejects(handler('skill-installations/observe',{installationId:id,cwd:'/elsewhere'}),{code:'teloa/invalid-input'});assert.equal(calls,0);assert.deepEqual(await handler('skill-installations/observe',{installationId:id}),result)
 const broken=createSkillInstallationsHandler('owner',async()=>{throw Error()},async()=>({...result,current:null}));await assert.rejects(broken('skill-installations/observe',{installationId:id}),{code:'teloa/invalid-host-response'})
})
test('停用观测独立于缺失状态且不能携带可调用定义',async()=>{
 const result={installationId:id,scope:'default-workspace',state:'disabled',current:null}
 const handler=createSkillInstallationsHandler('owner',async()=>{throw Error()},async()=>result)
 assert.deepEqual(await handler('skill-installations/observe',{installationId:id}),result)
 const wrong=createSkillInstallationsHandler('owner',async()=>{throw Error()},async()=>({...result,current:{...native,provider:'teloa-market',source:'custom'}}))
 await assert.rejects(wrong('skill-installations/observe',{installationId:id}),{code:'teloa/invalid-host-response'})
})


test('卸载入口严格校验确认请求与回执，服务错误原样透传不伪装成功',async()=>{
 const request={requestId:id,installationId:id,expectedVersion:2,expectedBundleHash:record.bundleHash,confirm:true},receipt={requestId:id,installationId:id,nativeName:'test',bundleHash:record.bundleHash,removedAt:'2026-09-12T00:00:00.000Z'}
 const handler=createSkillInstallationsHandler('owner',async()=>({preview:async()=>({source:fixed,bundleHash:record.bundleHash,native,files:[{path:'SKILL.md',hash:'d'.repeat(64),size:1}]}),install:async()=>({installation:record,source:fixed}),get:async()=>record,list:async()=>({items:[],usages:[]}),uninstall:async(owner:string,value:unknown)=>{assert.equal(owner,'owner');assert.equal((value as {requestId:string}).requestId,id);return receipt}}))
 assert.deepEqual(await handler('skill-installations/uninstall',request),receipt)
 for(const invalid of [{...request,confirm:false},{...request,confirm:'yes'},{...request,expectedVersion:0},{...request,expectedBundleHash:'x'},{...request,requestId:'x'},{...request,installationId:'x'},{...request,ownerId:'other'},{requestId:id,installationId:id,expectedBundleHash:record.bundleHash,confirm:true}])await assert.rejects(handler('skill-installations/uninstall',invalid),{code:'teloa/invalid-input'})
 // 回执与请求不一致的宿主返回必须视为坏回执
 for(const broken of [{...receipt,bundleHash:'d'.repeat(64)},{...receipt,nativeName:'BAD NAME'},{...receipt,removedAt:'yesterday'},{...receipt,installationId:'99999999-9999-4999-8999-999999999999'},{...receipt,extra:true}]){
  const bad=createSkillInstallationsHandler('owner',async()=>({preview:async()=>({source:fixed,bundleHash:record.bundleHash,native,files:[{path:'SKILL.md',hash:'d'.repeat(64),size:1}]}),install:async()=>({installation:record,source:fixed}),get:async()=>record,list:async()=>({items:[],usages:[]}),uninstall:async()=>broken}))
  await assert.rejects(bad('skill-installations/uninstall',request),{code:'teloa/invalid-host-response'})
 }
 const conflict=new WorkError('teloa/conflict','该技能已被选为当前版本，请先切换/停用。',{reason:'skill-in-use',blockers:['selected']}),blocked=createSkillInstallationsHandler('owner',async()=>({preview:async()=>({source:fixed,bundleHash:record.bundleHash,native,files:[{path:'SKILL.md',hash:'d'.repeat(64),size:1}]}),install:async()=>({installation:record,source:fixed}),get:async()=>record,list:async()=>({items:[],usages:[]}),uninstall:async()=>{throw conflict}}))
 await assert.rejects(blocked('skill-installations/uninstall',request),error=>error===conflict)
 const failed=createSkillInstallationsHandler('owner',async()=>{throw Error('store down')})
 await assert.rejects(failed('skill-installations/uninstall',request),error=>error instanceof Error&&error.message==='store down')
})

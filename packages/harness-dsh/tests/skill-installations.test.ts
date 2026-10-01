import test from 'node:test'
import assert from 'node:assert/strict'
import {createSkillInstallationsHandler} from '../src/skill-installations.ts'
import {WorkError} from '@teloa/contract'
const id='12345678-1234-4234-8234-123456789012',source={kind:'atomic' as const,contentId:id},fixed={...source,contentHash:'a'.repeat(64),resourceId:'test',resourceVersion:'1.0.0'},native={name:'test',description:'说明',modelInvocable:true,userInvocable:true,bodyHash:'b'.repeat(64)},record={id,ownerId:'owner',source:fixed,bundleHash:'c'.repeat(64),native,state:'installed' as const,version:2,createdAt:'2026-09-12T00:00:00.000Z',updatedAt:'2026-09-12T00:00:00.000Z'}
test('安装宿主入口绑定本人、拒绝路径和多余字段，真实回执保留',async()=>{
 let calls=0;const methods={preview:async()=>({source:fixed,bundleHash:record.bundleHash,native,files:[{path:'SKILL.md',hash:'d'.repeat(64),size:1}]}),install:async(owner:string)=>{assert.equal(owner,'owner');return {installation:record,source:fixed}},get:async()=>record,list:async()=>({items:[record],usages:[]})}
 const handler=createSkillInstallationsHandler('owner',async()=>{calls++;return methods})
 for(const extra of [{ownerId:'other'},{path:'/tmp'},{managedRoot:'/tmp'}])await assert.rejects(handler('skill-installations/install',{requestId:id,source,expectedBundleHash:record.bundleHash,...extra}),{code:'teloa/invalid-input'})
 assert.equal(calls,0);assert.deepEqual(await handler('skill-installations/install',{requestId:id,source,expectedBundleHash:record.bundleHash}),{installation:record,source:fixed});assert.deepEqual(await handler('skill-installations/list',{}),{items:[record],usages:[]})
 const wrong=createSkillInstallationsHandler('other',async()=>methods);await assert.rejects(wrong('skill-installations/get',{installationId:id}),{code:'teloa/invalid-host-response'})
 const cause=new WorkError('teloa/storage-corrupt','实际文件变化'),failed=createSkillInstallationsHandler('owner',async()=>{throw cause});await assert.rejects(failed('skill-installations/get',{installationId:id}),error=>error===cause)
})
test('拒绝同摘要串来源与坏元数据，保留public请求复用atomic安装',async()=>{
 const other='22345678-1234-4234-8234-123456789012',request={requestId:id,source,expectedBundleHash:record.bundleHash}
 const make=(value:unknown)=>createSkillInstallationsHandler('owner',async()=>({preview:async()=>value,install:async()=>value,get:async()=>value,list:async()=>value}) as never)
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

import assert from 'node:assert/strict'
import test from 'node:test'
import {registerHooks} from 'node:module'
import {existsSync} from 'node:fs'
import type {IndustryLoadRecord} from '../src/client/industry-load-api.ts'
import type {SkillInstallApi,SkillInstallPreview,SkillInstallSourceIdentity,SkillInstallationRecord,SkillInstallObservation} from '../src/client/skill-install-api.ts'
registerHooks({resolve(specifier,context,next){if(specifier.endsWith('.js')&&specifier.startsWith('.')&&context.parentURL?.includes('/ui-workbench/src/client/')){const source=new URL(specifier.slice(0,-3)+'.ts',context.parentURL);if(existsSync(source))return next(source.href,context)}return next(specifier,context)}})
const {loadCapabilitySkillRuntime}=await import('../src/client/capability-skill-runtime.ts')
const hash='a'.repeat(64),bundleHash='b'.repeat(64),bodyHash='c'.repeat(64),loadId='10000000-0000-4000-8000-000000000001',itemId='20000000-0000-4000-8000-000000000001',contentId='30000000-0000-4000-8000-000000000001',publicId='40000000-0000-4000-8000-000000000001',installationId='50000000-0000-4000-8000-000000000001',at='2026-10-14T00:00:00.000Z'
const source:Extract<SkillInstallSourceIdentity,{kind:'industry-public'}>={kind:'industry-public',loadId,itemInstanceId:itemId,contentId,contentHash:hash,resourceId:'writing-revision',resourceVersion:'1.0.0',sourceContentId:publicId,sourceContentHash:hash,sourceResourceId:'writing-revision',sourceResourceVersion:'1.0.0'}
const native={name:'writing-revision',description:'Revise the original work',modelInvocable:true,userInvocable:true,bodyHash}
const preview:SkillInstallPreview={source,bundleHash,native,files:[{path:'SKILL.md',hash:bodyHash,size:100}]}
const installation:SkillInstallationRecord={id:installationId,ownerId:'local:test-owner',source:{kind:'atomic',contentId:publicId,contentHash:hash,resourceId:'writing-revision',resourceVersion:'1.0.0'},bundleHash,native,state:'installed',version:2,createdAt:at,updatedAt:at}
const load:IndustryLoadRecord={id:loadId,ownerId:'local:test-owner',contentId,contentHash:hash,templateId:'writing-bot',templateVersion:'1.0.0',templateTitle:'Writing bot',domain:'writing',scope:'general',description:'Writing',targetVersion:1,space:{id:'60000000-0000-4000-8000-000000000001',name:'通用工作',version:1,scope:'general'},items:[{localId:'writing-revision',instanceId:itemId,kind:'skill',title:'Writing revision',version:'1.0.0',required:true,status:'pending-adapter'}],relations:[],entrypoints:[],createdAt:at,mappingHash:hash,status:'active'}
const observed:SkillInstallObservation={installationId,scope:'default-workspace',state:'available',current:{...native,source:'fixed-original',provider:'teloa-market'}}
type ReadApi=Pick<SkillInstallApi,'list'|'preview'|'observe'>
const api=(overrides:Partial<ReadApi>={}):ReadApi=>({list:async()=>({items:[installation],usages:[{loadId,itemInstanceId:itemId,installationId}]}),preview:async()=>preview,observe:async()=>observed,...overrides})
const fact=async(port:ReadApi)=>(await loadCapabilitySkillRuntime(port,[load])).facts[0]!

test('固定公共原件安装可供业务usage复用；没usage时只说已安装未关联，读取源身份和安装id均为原值',async()=>{
 const requested:unknown[]=[],observations:string[]=[]
 const value=await fact(api({preview:async input=>{requested.push(input);return preview},observe:async id=>{observations.push(id);return observed}}))
 assert.deepEqual(value,{loadId,itemInstanceId:itemId,status:'installed',installationId,linked:true,nativeName:'writing-revision',nativeSource:'fixed-original',nativeProvider:'teloa-market'});assert.deepEqual(requested,[{kind:'industry',loadId,itemInstanceId:itemId}]);assert.deepEqual(observations,[installationId])
 const unlinked=await fact(api({list:async()=>({items:[installation],usages:[]})}))
 assert.equal(unlinked.status,'unlinked');assert.equal(unlinked.nativeName,undefined)
})
test('业务usage指向同名的错误来源/版本/包/正文/信任版本均拒绝冒认',async()=>{
 const original=installation.source;assert.equal(original.kind,'atomic')
 const rows:SkillInstallationRecord[]=[{...installation,source:{...original,contentHash:'d'.repeat(64)}},{...installation,source:{...original,resourceVersion:'2.0.0'}},{...installation,bundleHash:'d'.repeat(64)},{...installation,native:{...native,bodyHash:'d'.repeat(64)}},{...installation,trustHash:'d'.repeat(64)}]
 for(const record of rows){let observed=false;assert.equal((await fact(api({list:async()=>({items:[record],usages:[{loadId,itemInstanceId:itemId,installationId}]}),observe:async()=>{observed=true;return observedFixture()}}))).status,'mismatch');assert.equal(observed,false)}
})
const observedFixture=()=>observed
test('固定预览错加载/资源/版本/包摘要不得据此关联真实安装；当前原生同名不同正文只表示可用性未核验',async()=>{
 for(const changed of [{...source,loadId:installationId},{...source,contentHash:'d'.repeat(64)},{...source,resourceId:'different-resource'},{...source,resourceVersion:'2.0.0'}])assert.equal((await fact(api({preview:async()=>({...preview,source:changed})}))).status,'mismatch')
 assert.equal((await fact(api({observe:async()=>({...observed,current:{...observed.current!,bodyHash:'d'.repeat(64)}})}))).status,'installed-unverified')
})
test('读取失败与实际无安装分别表示，单次观测失败不丢已安装事实；停用/缺失/遮蔽保留准确状态',async()=>{
 assert.equal((await loadCapabilitySkillRuntime(api({list:async()=>{throw Error('directory unavailable')}}),[load])).state,'error')
 assert.equal((await fact(api({preview:async()=>{throw Error('preview unavailable')}}))).status,'unverified')
 assert.equal((await fact(api({list:async()=>({items:[],usages:[]})}))).status,'not-installed')
 assert.equal((await fact(api({observe:async()=>{throw Error('observation unavailable')}}))).status,'installed-unverified')
 for(const state of ['disabled','missing','shadowed'] as const){const value=await fact(api({observe:async()=>({...observed,state,current:state==='shadowed'?observed.current:null})}));assert.equal(value.status,state);assert.equal(value.nativeName,undefined)}
})

const {createRoleSkillTitleReader,skillDisplayTitle}=await import('../src/client/capability-skill-runtime.ts')
const titleReader=(port:ReadApi,loads:IndustryLoadRecord[],instances:import('../src/client/industry-role-api.ts').IndustryRoleInstance[])=>createRoleSkillTitleReader(port,{list:async()=>loads},{list:async()=>instances})
const roleId='60000000-0000-4000-8000-000000000002',roleItemId='60000000-0000-4000-8000-000000000003'
const role={id:roleId,version:3,skills:[native.name]}
const roleLoad:IndustryLoadRecord={...load,templateVersion:'1.0.1',items:[{localId:'employee',instanceId:roleItemId,kind:'role',title:'原员工',version:'1.0.1',required:true,status:'instantiated'},{...load.items[0]!,title:'固定版本的写作方法'}],relations:[{kind:'role-skill',from:roleItemId,to:itemId}]}
const roleInstance={id:roleId,ownerId:load.ownerId,loadId,itemInstanceId:roleItemId,itemLocalId:'employee',scope:'general',definitionHash:hash,revision:1,state:'paused',role:{...role,ownerId:load.ownerId},knowledge:[],omittedKnowledge:[],declarations:[],failure:null,createdAt:at,updatedAt:at} as unknown as import('../src/client/industry-role-api.ts').IndustryRoleInstance

test('员工标题只取固定1.0.1角色关系；一次读取共享观测且不取新版本或无关技能',async()=>{
 const requests:unknown[]=[],observations:string[]=[]
 const unrelated={...load.items[0]!,localId:'unrelated',instanceId:publicId,title:'无关方法'}
 const later={...roleLoad,id:publicId,templateVersion:'1.0.2',items:roleLoad.items.map(item=>({...item,title:'新版标题'}))}
 const reader=titleReader(api({preview:async input=>{requests.push(input);return preview},observe:async id=>{observations.push(id);return observed}}),[{...roleLoad,items:[...roleLoad.items,unrelated]},later],[roleInstance])
 const [titles,again]=await Promise.all([reader.read(role),reader.read(role)])
 assert.deepEqual(titles,[{name:'writing-revision',source:'fixed-original',provider:'teloa-market',title:'固定版本的写作方法'}]);assert.deepEqual(again,titles)
 assert.deepEqual(requests,[{kind:'industry',loadId,itemInstanceId:itemId}]);assert.deepEqual(observations,[installationId])
 assert.equal(skillDisplayTitle(titles,{name:'writing-revision'}),'固定版本的写作方法')
 assert.equal(skillDisplayTitle(titles,{name:'writing-revision',source:'other',provider:'teloa-market'}),'writing-revision')
 assert.deepEqual(await reader.read({...role,version:4}),[])
})

test('不完整、跨归属、歧义或非当前的角色加载关系不读取安装也不猜技能标题',async()=>{
 let reads=0;const port=api({list:async()=>{reads++;return {items:[installation],usages:[]}}})
 const cases:[IndustryLoadRecord[],import('../src/client/industry-role-api.ts').IndustryRoleInstance[]][]=[
  [[{...roleLoad,status:'superseded'}],[roleInstance]],[[roleLoad],[roleInstance,roleInstance]],[[roleLoad],[{...roleInstance,ownerId:'other-owner'}]],[[{...roleLoad,relations:[]}],[roleInstance]],[[roleLoad],[{...roleInstance,itemLocalId:'other'}]],[[roleLoad,roleLoad],[roleInstance]],
 ]
 for(const [loads,instances] of cases)assert.deepEqual(await titleReader(port,loads,instances).read(role),[])
 assert.equal(reads,0)
})

test('安装未核验与同名不同原生来源不得用于员工名称兜底；三元组仍可精确展示',async()=>{
 assert.deepEqual(await titleReader(api({observe:async()=>({...observed,state:'shadowed'})}),[roleLoad],[roleInstance]).read(role),[])
 const titles=[{name:'same',source:'one',provider:'owner',title:'第一份原方法'},{name:'same',source:'two',provider:'owner',title:'第二份原方法'}]
 assert.equal(skillDisplayTitle(titles,{name:'same'}),'same');assert.equal(skillDisplayTitle(titles,{name:'same',source:'two',provider:'owner'}),'第二份原方法')
 assert.equal(skillDisplayTitle([...titles,titles[1]!],{name:'same',source:'two',provider:'owner'}),'same')
})


test('固定员工标题不能使用另一owner返回的同字节安装记录',async()=>{
 const port=api({list:async()=>({items:[{...installation,ownerId:'other-owner'}],usages:[{loadId,itemInstanceId:itemId,installationId}]})})
 assert.deepEqual(await titleReader(port,[roleLoad],[roleInstance]).read(role),[])
})

test('同角色并发只读一次，已完成后重开重新观测当前原生来源',async()=>{
 let reads=0,observations=0
 const reader=titleReader(api({list:async()=>{reads++;return {items:[installation],usages:[{loadId,itemInstanceId:itemId,installationId}]}},observe:async()=>({...observed,current:{...observed.current!,source:++observations===1?'first-source':'current-source'}})}),[roleLoad],[roleInstance])
 const [first,concurrent]=await Promise.all([reader.read(role),reader.read(role)])
 assert.equal(first[0]?.source,'first-source');assert.deepEqual(concurrent,first);assert.equal(reads,1);assert.equal(observations,1)
 const reopened=await reader.read(role)
 assert.equal(reopened[0]?.source,'current-source');assert.equal(reads,2);assert.equal(observations,2)
})

test('一次读取失败不缓存为永久未知，同角色再次打开可恢复固定标题',async()=>{
 let reads=0
 const reader=titleReader(api({list:async()=>{if(++reads===1)throw Error('temporary unavailable');return {items:[installation],usages:[{loadId,itemInstanceId:itemId,installationId}]}}}),[roleLoad],[roleInstance])
 assert.deepEqual(await reader.read(role),[])
 assert.equal((await reader.read(role))[0]?.title,'固定版本的写作方法');assert.equal(reads,2)
})

test('共享reader按实际员工懒读当前目录，目录错误可重开恢复且版本变化不依赖全局选中态',async()=>{
 let loadReads=0,instanceReads=0,version=3
 const reader=createRoleSkillTitleReader(api(),{list:async()=>{loadReads++;return [roleLoad]}},{list:async()=>{if(++instanceReads===1)throw Error('temporary role directory unavailable');return [{...roleInstance,role:{...roleInstance.role!,version}}]}})
 assert.equal(loadReads,0);assert.equal(instanceReads,0)
 assert.deepEqual(await reader.read(role),[])
 const [a,b]=await Promise.all([reader.read(role),reader.read(role)])
 assert.equal(a[0]?.title,'固定版本的写作方法');assert.deepEqual(a,b);assert.equal(loadReads,2);assert.equal(instanceReads,2)
 version=4
 assert.equal((await reader.read({...role,version:4}))[0]?.title,'固定版本的写作方法');assert.equal(loadReads,3);assert.equal(instanceReads,3)
})

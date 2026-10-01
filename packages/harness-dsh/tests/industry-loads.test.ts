import test from 'node:test'
import assert from 'node:assert/strict'
import {createIndustryLoadsHandler} from '../src/industry-loads.ts'

const id='12345678-1234-4234-8234-123456789012',space='22345678-1234-4234-8234-123456789012',item='32345678-1234-4234-8234-123456789012',hash='a'.repeat(64)
const record={id,ownerId:'owner',contentId:id,contentHash:hash,templateId:'security',templateVersion:'1.0.0',templateTitle:'安全',domain:'security',scope:'SOC',description:'行业定位',targetVersion:1,space:{id:space,name:'安全空间',version:1,scope:'SOC'},items:[{localId:'method',instanceId:item,kind:'skill',title:'方法',version:'1.0.0',required:true,status:'pending-adapter'}],relations:[],entrypoints:[item],createdAt:'2026-09-12T00:00:00.000Z',mappingHash:'b'.repeat(64),status:'active'}
const unloaded={...record,status:'unloaded',unloadedAt:'2026-09-13T00:00:00.000Z'}
const input={requestId:id,contentId:id,contentHash:hash,target:{kind:'new',spaceId:space,name:'安全空间'}}
const noUpgrade=async()=>{throw Error('不应升级')}
test('加载入口使用宿主本人，拒绝外部身份和未知操作，固定创建来源与目标',async()=>{
 const calls:unknown[][]=[]
 const handler=createIndustryLoadsHandler('owner',async()=>({upgrade:noUpgrade,create:async(...args)=>{calls.push(args);return record},get:async()=>record,list:async()=>({items:[record]}),unload:async()=>unloaded}))
 assert.deepEqual(await handler('industry-loads/create',input),record)
 assert.deepEqual(calls,[['owner',input]])
 assert.deepEqual(await handler('industry-loads/get',{loadId:id}),record)
 assert.deepEqual(await handler('industry-loads/list',{}),{items:[record]})
 await assert.rejects(handler('industry-loads/create',{...input,ownerId:'other'}))
 await assert.rejects(handler('industry-loads/delete',{}))
 assert.equal(calls.length,1)
})
test('加载回包拒绝跨本人、已安装伪态、坏映射及重复目录，服务错误原样保留',async()=>{
 for(const bad of [{...record,ownerId:'other'},{...record,space:{...record.space,scope:''}},{...record,items:[{...record.items[0],status:'installed'}]},{...record,entrypoints:[id]},{...record,items:[{...record.items[0],status:'skipped'}]}]){
  const handler=createIndustryLoadsHandler('owner',async()=>({upgrade:noUpgrade,create:async()=>bad,get:async()=>bad,list:async()=>({items:[bad]}),unload:async()=>bad}))
  await assert.rejects(handler('industry-loads/get',{loadId:id}),{code:'teloa/invalid-host-response'})
 }
 const duplicate=createIndustryLoadsHandler('owner',async()=>({upgrade:noUpgrade,create:async()=>record,get:async()=>record,list:async()=>({items:[record,record]}),unload:async()=>unloaded}))
 await assert.rejects(duplicate('industry-loads/list',{}),{code:'teloa/invalid-host-response'})
 const failure=Error('数据库不可用'),failed=createIndustryLoadsHandler('owner',async()=>{throw failure})
 await assert.rejects(failed('industry-loads/list',{}),error=>error===failure)
})
test('加载回包接受实例化后的投影状态，拒绝其它状态',async()=>{
 for(const status of ['pending-adapter','instantiated','active','detached']){
  const projected={...record,items:[{...record.items[0],status}]}
  const handler=createIndustryLoadsHandler('owner',async()=>({upgrade:noUpgrade,create:async()=>projected,get:async()=>projected,list:async()=>({items:[projected]}),unload:async()=>projected}))
  assert.deepEqual(await handler('industry-loads/get',{loadId:id}),projected)
 }
 for(const status of ['pending','instantiating','retired','']){
  const projected={...record,items:[{...record.items[0],status}]}
  const handler=createIndustryLoadsHandler('owner',async()=>({upgrade:noUpgrade,create:async()=>projected,get:async()=>projected,list:async()=>({items:[projected]}),unload:async()=>projected}))
  await assert.rejects(handler('industry-loads/get',{loadId:id}),{code:'teloa/invalid-host-response'})
 }
 const optional={...record,items:[{...record.items[0],required:false,status:'skipped'}]}
 const handler=createIndustryLoadsHandler('owner',async()=>({upgrade:noUpgrade,create:async()=>optional,get:async()=>optional,list:async()=>({items:[optional]}),unload:async()=>optional}))
 assert.deepEqual(await handler('industry-loads/get',{loadId:id}),optional)
})
test('卸载入口固定目标身份与卸载状态，拒绝未卸载或缺卸载时刻的回包',async()=>{
 const calls:unknown[][]=[],request={requestId:id,loadId:id,expectedMappingHash:hash}
 const handler=createIndustryLoadsHandler('owner',async()=>({upgrade:noUpgrade,create:async()=>record,get:async()=>record,list:async()=>({items:[record]}),unload:async(...args)=>{calls.push(args);return unloaded}}))
 assert.deepEqual(await handler('industry-loads/unload',request),unloaded)
 assert.deepEqual(calls,[['owner',request]])
 await assert.rejects(handler('industry-loads/unload',{...request,expectedMappingHash:'z'.repeat(64)}),{code:'teloa/invalid-input'})
 for(const bad of [record,{...unloaded,unloadedAt:undefined},{...unloaded,unloadedAt:'2026-09-11T00:00:00.000Z'},{...unloaded,id:space},{...record,status:'removed'},{...unloaded,mappingHash:'zz'}]){
  const rejected=createIndustryLoadsHandler('owner',async()=>({upgrade:noUpgrade,create:async()=>record,get:async()=>record,list:async()=>({items:[record]}),unload:async()=>bad}))
  await assert.rejects(rejected('industry-loads/unload',request),{code:'teloa/invalid-host-response'})
 }
})
test('目录默认不接受已卸载加载，显式索取时接受',async()=>{
 const other={...unloaded,id:'42345678-1234-4234-8234-123456789012'}
 const handler=createIndustryLoadsHandler('owner',async()=>({upgrade:noUpgrade,create:async()=>record,get:async()=>unloaded,list:async()=>({items:[record,other]}),unload:async()=>unloaded}))
 await assert.rejects(handler('industry-loads/list',{}),{code:'teloa/invalid-host-response'})
 assert.deepEqual(await handler('industry-loads/list',{includeUnloaded:true}),{items:[record,other]})
 await assert.rejects(handler('industry-loads/list',{includeUnloaded:'yes'}),{code:'teloa/invalid-input'})
 assert.deepEqual(await handler('industry-loads/get',{loadId:id}),unloaded)
})

const successorId='52345678-1234-4234-8234-123456789012',successorItem='62345678-1234-4234-8234-123456789012'
const choices={resources:{method:'keep'},roles:{},relations:'keep',entrypoints:'keep',positioning:'candidate'}
const superseded={...record,status:'superseded'}
const successor={...record,id:successorId,templateVersion:'1.1.0',contentId:successorId,items:[{...record.items[0],instanceId:successorItem,carriedFrom:item}],entrypoints:[successorItem],createdAt:'2026-09-14T00:00:00.000Z',upgrade:{loadId:id,templateVersion:'1.0.0',choices,diffDigest:'c'.repeat(64),createdAt:'2026-09-14T00:00:00.000Z'}}
const upgradeRequest={requestId:id,loadId:id,candidateContentId:successorId,expectedMappingHash:hash,choices}
const upgradeHandler=(result:unknown)=>createIndustryLoadsHandler('owner',async()=>({upgrade:async()=>result,create:async()=>record,get:async()=>record,list:async()=>({items:[record]}),unload:async()=>unloaded}))
test('升级入口固定继任链：旧加载已被替代、继任加载在生效且升级血缘指回旧加载',async()=>{
 const calls:unknown[][]=[]
 const handler=createIndustryLoadsHandler('owner',async()=>({upgrade:async(...args)=>{calls.push(args);return {superseded,successor}},create:async()=>record,get:async()=>record,list:async()=>({items:[record]}),unload:async()=>unloaded}))
 assert.deepEqual(await handler('industry-loads/upgrade',upgradeRequest),{superseded,successor})
 assert.deepEqual(calls,[['owner',upgradeRequest]])
 for(const bad of [{...upgradeRequest,choices:{...choices,relations:'detach'}},{...upgradeRequest,choices:{...choices,extra:1}},{...upgradeRequest,candidateContentId:'zz'},{...upgradeRequest,expectedMappingHash:'z'.repeat(64)},{...upgradeRequest,note:'加一个字段'}])
  await assert.rejects(handler('industry-loads/upgrade',bad),{code:'teloa/invalid-input'})
 assert.equal(calls.length,1)
})
test('升级回包缺少替代状态、升级血缘或沿用来源不自洽时判定宿主回包无效',async()=>{
 for(const result of [
  {superseded:record,successor},
  {superseded,successor:{...successor,upgrade:undefined}},
  {superseded,successor:{...successor,upgrade:{...successor.upgrade,loadId:successorId}}},
  {superseded,successor:{...successor,upgrade:{...successor.upgrade,templateVersion:'2.0.0'}}},
  {superseded,successor:{...successor,upgrade:{...successor.upgrade,diffDigest:'zz'}}},
  {superseded,successor:{...successor,upgrade:{...successor.upgrade,createdAt:'2026-09-11T00:00:00.000Z'}}},
  {superseded,successor:{...successor,status:'superseded'}},
  {superseded,successor:{...successor,contentId:id}},
  {superseded,successor:{...successor,space:{...record.space,id:space.replace('2','7'),scope:'space-'+space.replace('2','7')}}},
  // 沿用来源只能出现在继任加载上，且不能指向本加载自己的实例身份。
  {superseded:{...superseded,items:[{...record.items[0],carriedFrom:item}]},successor},
  {superseded,successor:{...successor,items:[{...successor.items[0],carriedFrom:successorItem}]}},
  {superseded,successor:{...successor,items:[{...successor.items[0],carriedFrom:'zz'}]}},
 ])
  await assert.rejects(upgradeHandler(result)('industry-loads/upgrade',upgradeRequest),{code:'teloa/invalid-host-response'})
 // 继任加载可以有未沿用的项：只要升级血缘自洽即接受。
 const fresh={...successor,items:[{...successor.items[0],carriedFrom:undefined}]}
 assert.deepEqual(await upgradeHandler({superseded,successor:fresh})('industry-loads/upgrade',upgradeRequest),{superseded,successor:fresh})
})
test('目录默认不接受已被替代的加载，显式索取时接受',async()=>{
 const handler=createIndustryLoadsHandler('owner',async()=>({upgrade:noUpgrade,create:async()=>record,get:async()=>superseded,list:async()=>({items:[superseded]}),unload:async()=>unloaded}))
 await assert.rejects(handler('industry-loads/list',{}),{code:'teloa/invalid-host-response'})
 assert.deepEqual(await handler('industry-loads/list',{includeUnloaded:true}),{items:[superseded]})
 assert.deepEqual(await handler('industry-loads/get',{loadId:id}),superseded)
})

test('完整业务配置加载项可读取待采用状态，不把加载当成已经采用',async()=>{
 const value={...record,items:[{...record.items[0],kind:'business-configuration'}],entrypoints:[]}
 const handler=createIndustryLoadsHandler('owner',async()=>({upgrade:noUpgrade,create:async()=>value,get:async()=>value,list:async()=>({items:[value]}),unload:async()=>value}))
 assert.deepEqual(await handler('industry-loads/get',{loadId:id}),value)
})

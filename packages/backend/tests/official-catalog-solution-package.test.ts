/**
 * 官方方案产品页的数据来源（无需数据库，使用 stub store）：七行全部从随发行固定、已逐字节核验的方案包 teloa.json 算出，
 * 不在目录条目里另存一份；接入源的「读 / 写」按包内连接声明的工具逐个对照官方连接器目录的 readOnly 判定。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {OfficialCatalogService} from '../src/market/official-catalog.ts'

const stub={import:async()=>{throw Error('unused')},findByIdentity:async()=>null,findByCatalogSources:async()=>new Map<string,string>()}
const service=()=>new OfficialCatalogService(stub as never)
type Manifest={id:string;version:string;resources:{id:string;kind:string}[]}

test('官方方案：回包带原样的方案包清单与条目版本，清单身份与目录条目一致',()=>{
 const result=service().solutionPackage('teloa.soc')
 assert.equal(result.entryId,'teloa.soc')
 const manifest=result.manifest as Manifest
 assert.equal(manifest.id,'soc-operations')
 assert.equal(manifest.version,result.version)
 const kinds=manifest.resources.map(resource=>resource.kind)
 assert.equal(kinds.filter(kind=>kind==='role').length,2)
 assert.ok(kinds.includes('skill')&&kinds.includes('knowledge')&&kinds.includes('work-template')&&kinds.includes('plan'))
 // SOC 包里没有连接声明，没有可判定为只读的接入源
 assert.deepEqual(result.readOnlyResources,[])
})

test('接入源只读判定：包内连接声明的工具在官方连接器目录里全部标为只读才算只读',()=>{
 // 飞书与语雀两个连接只声明了读消息、读文档、搜索这几个工具，官方连接器目录里都标为 readOnly
 assert.deepEqual(service().solutionPackage('teloa.cn-workspace').readOnlyResources,['lark-read','yuque-read'])
})

test('十八个官方方案都能读出清单，版本与目录条目一致',async()=>{
 const catalog=service()
 const listed=await catalog.list({ownerId:'local:owner',kind:'human'},{kind:'solution'})
 assert.ok(listed.items.length>=18)
 for(const {entry} of listed.items){
  const result=catalog.solutionPackage(entry.id)
  assert.equal(result.version,entry.version,entry.id)
  assert.equal((result.manifest as Manifest).version,entry.version,entry.id)
  assert.equal(entry.kind==='solution'&&(result.manifest as Manifest).id,entry.kind==='solution'&&entry.solution.packageId,entry.id)
 }
})

test('不是方案或不存在的条目按无效输入拒绝',()=>{
 assert.throws(()=>service().solutionPackage('anthropic.internal-comms'),{code:'teloa/invalid-input'})
 assert.throws(()=>service().solutionPackage('teloa.no-such-solution'),{code:'teloa/invalid-input'})
})

test('目录列表：官方方案条目带包含计数（按同一份方案包算），其余条目不带这个键',async()=>{
 const listed=await service().list({ownerId:'local:owner',kind:'human'})
 const soc=(await service().list({ownerId:'local:owner',kind:'human'},{kind:'solution'})).items.find(item=>item.entry.id==='teloa.soc')!
 assert.deepEqual(soc.contents,{role:2,knowledge:1,skill:7,'work-template':4,plan:1})
 const cn=(await service().list({ownerId:'local:owner',kind:'human'},{kind:'solution'})).items.find(item=>item.entry.id==='teloa.cn-workspace')!
 assert.deepEqual(cn.contents,{role:1,knowledge:1,skill:5,mcp:2,'work-template':4})
 for(const item of listed.items)if(item.entry.kind!=='solution')assert.equal(Object.hasOwn(item,'contents'),false,item.entry.id)
})

test('单个方案包复核不过：列表里这一条不带包含计数、其余照常，产品页读取按快照损坏拒绝',async()=>{
 const {createHash}=await import('node:crypto')
 const {readFileSync}=await import('node:fs')
 const {marketCatalogTreeHash}=await import('@teloa/contract')
 const sha256=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex')
 const entry=JSON.parse(readFileSync(new URL('../../../tests/fixtures/public-market/catalog/solutions/teloa.soc.json',import.meta.url),'utf8'))
 const bytes={'teloa.json':new TextEncoder().encode('{}'),LICENSE:new TextEncoder().encode('Apache-2.0')}
 const files=Object.entries(bytes).map(([path,value])=>({path,sha256:sha256(value),size:value.byteLength}))
 const index={format:'teloa.market-catalog/v1',catalogVersion:'2026.9.28.99',entries:[{...entry,artifact:{files,treeHash:marketCatalogTreeHash(files,sha256)}}]}
 const snapshot={indexSha256:sha256(JSON.stringify(index)),index,files:Object.fromEntries(Object.entries(bytes).map(([path,value])=>[entry.id+'/'+entry.version+'/'+path,Buffer.from(value).toString('base64')]))}
 const catalog=new OfficialCatalogService(stub as never,snapshot)
 const listed=await catalog.list({ownerId:'local:owner',kind:'human'})
 assert.equal(listed.items.length,1)
 assert.equal(Object.hasOwn(listed.items[0]!,'contents'),false)
 assert.throws(()=>catalog.solutionPackage('teloa.soc'),{code:'teloa/storage-corrupt'})
})

// 新资源夹具仅在测试快照；不改应用受管镜像。
import {createHash,randomUUID} from 'node:crypto'
import {readFileSync} from 'node:fs'
import {marketCatalogTreeHash} from '@teloa/contract'
import {industryContentIdentity,validateManifest,type MarketFileInput,type MarketContentReference,type MarketImportSource} from '../src/market/content-store.ts'
import {dashboardBody,dashboardManifest} from './fixtures/business-dashboard.ts'
const fixedSha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex')
function dashboardSnapshot(includeSource=true,sourceScope='SOC'){
 const base=JSON.parse(readFileSync(new URL('../../../tests/fixtures/public-market/catalog/solutions/teloa.soc.json',import.meta.url),'utf8'))
 const sourceManifest=dashboardManifest(sourceScope),solution={...sourceManifest,id:'soc-combination',scope:'SOC',title:'安全运营组合',resources:[{id:'overview',kind:'business-configuration',title:'告警总览',version:'1.0.0',required:true,source:{kind:'public',id:'soc-overview',version:'1.0.0'}}]}
 const make=(id:string,kind:string,manifest:ReturnType<typeof dashboardManifest>,body?:unknown)=>{
  const bytes={'teloa.json':new TextEncoder().encode(JSON.stringify(manifest)),LICENSE:new TextEncoder().encode('Apache-2.0'),...(body?{'configuration.json':new TextEncoder().encode(JSON.stringify(body))}:{})}
  const files=Object.entries(bytes).map(([path,value])=>({path,sha256:fixedSha(value),size:value.byteLength}))
  const entry={...base,id,kind,version:'1.0.0',compatibility:{...base.compatibility,teloa:'>=0.2.0-alpha.7 <0.3.0'},artifact:{files,treeHash:marketCatalogTreeHash(files,fixedSha)}}
  delete entry.solution;entry[kind==='dashboard'?'dashboard':'solution']={...base.solution,packageId:manifest.id,scope:manifest.scope}
  return {entry,files:Object.fromEntries(Object.entries(bytes).map(([path,value])=>[id+'/1.0.0/'+path,Buffer.from(value).toString('base64')]))}
 }
 const source=make('teloa.dashboard.soc','dashboard',sourceManifest,dashboardBody(sourceScope)),combo=make('teloa.solution.soc-combination','solution',solution as never),entries=includeSource?[source,combo]:[combo]
 const index={format:'teloa.market-catalog/v1',catalogVersion:'2026.10.1.1',entries:entries.map(row=>row.entry)}
 return {indexSha256:fixedSha(JSON.stringify(index)),index,files:Object.assign({},...entries.map(row=>row.files))}
}
function capturingStore(){
 type CapturedImport={kind:'industry-template';requestId:string;manifestPath:string;files:MarketFileInput[];references:MarketContentReference[];source:MarketImportSource}
 const calls:CapturedImport[]=[],contents=new Map<string,{id:string}>()
 return {calls,store:{findByIdentity:async()=>null,findByCatalogSources:async()=>new Map(),import:async(actor:{ownerId:string},input:CapturedImport)=>{
  calls.push(input)
  const identity=industryContentIdentity({...input,sourceLabel:'Teloa 官方目录 '+(input.source.kind==='catalog'?input.source.entryId:'')}),metadata=validateManifest(JSON.parse(new TextDecoder().decode(input.files.find(row=>row.path==='teloa.json')!.bytes)))
  const content={id:contents.get(metadata.id)?.id??randomUUID(),ownerId:actor.ownerId,kind:'industry-template',logicalId:metadata.id,version:metadata.version,hash:identity.contentHash,baseHash:identity.contentHash,manifestPath:'teloa.json',metadata,files:input.files.map(row=>({...row,hash:fixedSha(row.bytes)})),references:input.references,provides:metadata.resources.flatMap(row=>row.source.kind==='local'?[{resourceId:row.id,kind:row.kind,version:row.version,path:row.source.path}]:[])}
  contents.set(metadata.id,content)
  return {receipt:{requestId:input.requestId,contentId:content.id,source:input.source,createdAt:'2026-10-01T00:00:00.000Z'},content}
 }}}
}
test('看板独立添加与方案公共引用固定相同字节，添加只写内容仓',async()=>{
 const capture=capturingStore(),catalog=new OfficialCatalogService(capture.store as never,dashboardSnapshot()),actor={ownerId:'owner',kind:'human' as const}
 const source=await catalog.add(actor,{requestId:randomUUID(),entryId:'teloa.dashboard.soc'})
 assert.deepEqual(catalog.solutionPackage('teloa.dashboard.soc').manifest,dashboardManifest())
 const combination=await catalog.add(actor,{requestId:randomUUID(),entryId:'teloa.solution.soc-combination'})
 assert.equal(combination.content.references.length,1)
 const reference=combination.content.references[0]!
 assert.equal(reference.sourceContentId,source.content.id);assert.equal(reference.sourceHash,source.content.hash);assert.equal(reference.sourceItemId,'directory-'+source.content.hash)
 assert.equal(reference.sourceResourceId,'soc-overview')
 assert.deepEqual(capture.calls[0]?.files,capture.calls[1]?.files)
 assert.deepEqual((catalog.solutionPackage('teloa.solution.soc-combination').manifest as {resources:unknown[]}).resources,combination.content.metadata.resources)
 const listed=await catalog.list(actor,{kind:'dashboard',query:'soc-dashboard',sort:'name'})
 assert.equal(listed.items.length,1);assert.equal(listed.counts.dashboard,1)
 const schemes=await catalog.list(actor,{kind:'solution'})
 assert.deepEqual(schemes.items[0]!.contents,{'business-configuration':1})
})
test('方案公共配置缺少固定目录来源时在内容写入前拒绝',async()=>{
 const capture=capturingStore(),catalog=new OfficialCatalogService(capture.store as never,dashboardSnapshot(false))
 await assert.rejects(catalog.add({ownerId:'owner',kind:'human'},{requestId:randomUUID(),entryId:'teloa.solution.soc-combination'}),{code:'teloa/source-unavailable'})
 assert.equal(capture.calls.length,0)
})
test('通用 template 看板可被 SOC 方案固定引用，其他专用范围不能跨范围冒用',async()=>{
 const capture=capturingStore(),catalog=new OfficialCatalogService(capture.store as never,dashboardSnapshot(true,'template'))
 const added=await catalog.add({ownerId:'owner',kind:'human'},{requestId:randomUUID(),entryId:'teloa.solution.soc-combination'})
 assert.equal(added.content.references.length,1)
 await assert.rejects(new OfficialCatalogService(capturingStore().store as never,dashboardSnapshot(true,'OTHER')).add({ownerId:'owner',kind:'human'},{requestId:randomUUID(),entryId:'teloa.solution.soc-combination'}),{code:'teloa/source-unavailable'})
})

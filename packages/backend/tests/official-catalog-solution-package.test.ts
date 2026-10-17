/**
 * 官方方案产品页的数据来源（无需数据库，使用 stub store）：七行全部从随发行固定、已逐字节核验的方案包 teloa.json 算出，
 * 不在目录条目里另存一份；接入源的「读 / 写」按包内连接声明的工具逐个对照官方连接器目录的 readOnly 判定。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {mcpConnectionReadOnly} from '@teloa/contract'
import {OfficialCatalogService} from '../src/market/official-catalog.ts'
import {officialCatalogFiles} from '../src/market/official-catalog-snapshot.ts'

const stub={import:async()=>{throw Error('unused')},findByIdentity:async()=>null,findByCatalogSources:async()=>new Map<string,string>()}
const service=()=>new OfficialCatalogService(stub as never)
type Manifest={id:string;version:string;resources:{id:string;kind:string;source:{kind:string;path?:string}}[];relations:{kind:string;from:string;to:string}[]}
type ReviewedTeam={packageId:string;version:string;manifestSha256:string;contents:Record<string,number>;methods:string[]
 roles:Record<string,{knowledge:string[];methods:string[];work:string[];connections:string[];coordinates:string[]}>
 connections:{id:string;serverName:string;tools:string[];readOnly:boolean}[];roleEntries:{id:string;path:string}[]}
// 期望来自市场仓已审目录（tests/fixtures/reviewed-catalog-20261014.json 由市场仓固定提交派生），不从本仓快照反推
const reviewed=JSON.parse(readFileSync(new URL('../../../tests/fixtures/reviewed-catalog-20261014.json',import.meta.url),'utf8')) as {solutions:string[];hosted:{byKind:Record<string,string[]>};teams:Record<string,ReviewedTeam>}
const teams=Object.entries(reviewed.teams)
const owner={ownerId:'local:owner',kind:'human' as const}
/** 随发行固定、加载时已逐字节核对的方案包原文件。 */
const packageFile=(entryId:string,version:string,path:string)=>Buffer.from(officialCatalogFiles[`${entryId}/${version}/${path}`]!,'base64')

test('官方团队方案：回包清单与市场仓原件逐字一致，员工、19 个方法与资料/工作/连接/协调关系与已审清单一致',()=>{
 const catalog=service()
 assert.deepEqual(teams.map(([id])=>id),reviewed.solutions)
 assert.equal(teams.flatMap(([,team])=>team.methods).length,19)
 for(const [entryId,team] of teams){
  const result=catalog.solutionPackage(entryId),manifest=result.manifest as Manifest,bytes=packageFile(entryId,team.version,'teloa.json')
  assert.equal(result.entryId,entryId);assert.equal(result.version,team.version,entryId)
  // 回包是原文件解析结果，原文件摘要与市场仓已审原件相同
  assert.equal(createHash('sha256').update(bytes).digest('hex'),team.manifestSha256,entryId)
  assert.deepEqual(manifest,JSON.parse(bytes.toString('utf8')),entryId)
  assert.equal(manifest.id,team.packageId);assert.equal(manifest.version,team.version)
  assert.deepEqual(manifest.resources.filter(row=>row.kind==='skill').map(row=>row.id),team.methods,entryId)
  const linked=(role:string,kind:string)=>manifest.relations.filter(link=>link.kind===kind&&link.from===role).map(link=>link.to)
  assert.deepEqual(manifest.resources.filter(row=>row.kind==='role').map(row=>row.id),Object.keys(team.roles),entryId)
  for(const [role,expected] of Object.entries(team.roles)){
   assert.deepEqual({knowledge:linked(role,'role-knowledge'),methods:linked(role,'role-skill'),work:linked(role,'role-work'),connections:linked(role,'role-connection'),coordinates:linked(role,'role-coordination')},expected,entryId+' '+role)
  }
  // 关系只从员工出发，全部指向本包已声明的资源
  const declared=new Set(manifest.resources.map(row=>row.id))
  assert.ok(manifest.relations.every(link=>Object.hasOwn(team.roles,link.from)&&declared.has(link.to)),entryId)
  // 目录员工条目逐个指回本团队包里唯一的员工文件
  for(const {id,path} of team.roleEntries){
   assert.deepEqual(catalog.getRoleEntry(id)?.role.fromSolution,{packageId:team.packageId,version:team.version,path},id)
   assert.equal(manifest.resources.filter(row=>row.kind==='role'&&row.source.path===path).length,1,id)
  }
 }
 assert.deepEqual(teams.flatMap(([,team])=>team.roleEntries.map(row=>row.id)).sort(),reviewed.hosted.byKind.role)
})

test('接入源只读判定：逐个连接按官方连接器目录核对，全部只读工具才算只读，混入写工具或未知工具即按写处理',()=>{
 const catalog=service(),connectors=reviewed.hosted.byKind.connector!.map(id=>catalog.getConnectorEntry(id)!)
 for(const [entryId,team] of teams){
  const result=catalog.solutionPackage(entryId)
  assert.deepEqual(result.readOnlyResources,team.connections.filter(row=>row.readOnly).map(row=>row.id),entryId)
  for(const connection of team.connections){
   const path=(result.manifest as Manifest).resources.find(row=>row.id===connection.id)!.source.path!
   const definition=JSON.parse(packageFile(entryId,team.version,path).toString('utf8'))
   assert.deepEqual({serverName:definition.serverName,tools:definition.tools},{serverName:connection.serverName,tools:connection.tools},connection.id)
   assert.equal(mcpConnectionReadOnly(definition,connectors),connection.readOnly,connection.id)
   // 同一连接器的写工具或目录未声明的工具一旦加入，判定必须翻转为写
   const writeTools=connectors.find(entry=>entry.connector.serverName===definition.serverName)!.connector.tools.filter(tool=>!tool.readOnly)
   assert.ok(writeTools.length>0,connection.id+' 连接器应同时声明写工具，反例才有意义')
   for(const tool of writeTools)assert.equal(mcpConnectionReadOnly({...definition,tools:[...definition.tools,tool.name]},connectors),false,connection.id+' + '+tool.name)
   assert.equal(mcpConnectionReadOnly({...definition,tools:[...definition.tools,'undeclared-tool']},connectors),false,connection.id)
  }
 }
})

test('三个官方团队方案与三个业务看板都能读出清单，版本与包标识与目录条目一致',async()=>{
 const catalog=service()
 const solutions=await catalog.list(owner,{kind:'solution'}),dashboards=await catalog.list(owner,{kind:'dashboard'})
 assert.deepEqual(solutions.items.map(item=>item.entry.id),reviewed.solutions);assert.equal(solutions.nextCursor,null)
 assert.deepEqual(dashboards.items.map(item=>item.entry.id),reviewed.hosted.byKind.dashboard);assert.equal(dashboards.nextCursor,null)
 for(const {entry} of [...solutions.items,...dashboards.items]){
  const result=catalog.solutionPackage(entry.id),manifest=result.manifest as Manifest
  assert.equal(result.version,entry.version,entry.id);assert.equal(manifest.version,entry.version,entry.id)
  assert.equal(manifest.id,entry.kind==='solution'?entry.solution.packageId:entry.kind==='dashboard'?entry.dashboard.packageId:null,entry.id)
 }
})

test('不是方案或不存在的条目按无效输入拒绝',()=>{
 assert.throws(()=>service().solutionPackage('anthropic.internal-comms'),{code:'teloa/invalid-input'})
 assert.throws(()=>service().solutionPackage('teloa.no-such-solution'),{code:'teloa/invalid-input'})
})

test('目录列表：官方方案条目带包含计数（按同一份方案包算），其余条目不带这个键',async()=>{
 const listed=await service().list(owner)
 assert.equal(listed.nextCursor,null)
 for(const [entryId,team] of teams)assert.deepEqual(listed.items.find(item=>item.entry.id===entryId)?.contents,team.contents,entryId)
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

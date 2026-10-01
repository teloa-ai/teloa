import test,{after,before} from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {readdirSync,readFileSync} from 'node:fs'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {compareIndustryUpdateCore,readIndustryDataSourceDefinition,readIndustryMcpConnectionDefinition} from '@teloa/contract'
import {initializeMarketContents,MarketContentStore,marketPublicationMetadata,validateManifest} from '../src/market/content-store.ts'

let container:StartedPostgreSqlContainer,pool:Pool
const identity={id:randomUUID,now:()=>'2026-09-14T00:00:00.000Z'}
const file=(path:string,text:string)=>({path,bytes:new TextEncoder().encode(text)})
const field=(original:string,en:string)=>({original,defaultLocale:'en',locales:{en,'zh-CN':original,'zh-Hant':{fallback:'zh-CN'}}})
const industryManifest=()=>({
 format:'teloa.business-package/v2',id:'research',title:'研究行业',version:'1.0.0',domain:'general',scope:'general',description:'研究工作资料。',
 localized:{title:field('研究行业','Research industry'),description:field('研究工作资料。','Research materials.')},
 resources:[
  {id:'method',kind:'skill',title:'研究方法',localized:{title:field('研究方法','Research method')},version:'1.0.0',required:true,source:{kind:'local',path:'SKILL.md'}},
  {id:'reference',kind:'knowledge',title:'参考资料',localized:{title:field('参考资料','Reference material')},version:'1.0.0',required:false,source:{kind:'local',path:'reference.md'}},
 ],relations:[],entrypoints:['method'],
})

before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73').start()
 pool=new Pool({connectionString:container.getConnectionUri()})
 await initializeMarketContents(pool)
},{timeout:180_000})
after(async()=>{await pool?.end();await container?.stop()})

test('行业资源本地化经真实存储规范化、重读和请求恢复仍保留，作者正文不变',async()=>{
 const actor={ownerId:randomUUID(),kind:'human' as const},requestId=randomUUID(),manifest=industryManifest()
 const manifestText=JSON.stringify(manifest),body='# 研究方法\n保持作者原文。\n'
 const imported=await new MarketContentStore(pool,identity).import(actor,{kind:'industry-template',requestId,source:{kind:'upload',name:'本地化资源'},manifestPath:'teloa.json',files:[file('teloa.json',manifestText),file('SKILL.md',body)],references:[]})
 const stored=(await pool.query('select metadata from teloa_market_contents where id=$1',[imported.content.id])).rows[0]!.metadata
 assert.deepEqual(stored,manifest)
 const store=new MarketContentStore(pool,identity)
 const content=await store.get(actor,{contentId:imported.content.id})
 const restored=await store.getImport(actor,{requestId})
 const listed=await store.list(actor,{})
 for(const metadata of [imported.content.metadata,content.metadata,restored.content.metadata,listed.items[0]!.metadata])assert.deepEqual(metadata,manifest)
 assert.equal(restored.receipt.contentId,imported.content.id)
 assert.equal(new TextDecoder().decode(content.files.find(value=>value.path==='SKILL.md')!.bytes),body)
 assert.equal(new TextDecoder().decode(content.files.find(value=>value.path==='teloa.json')!.bytes),manifestText)
 assert.deepEqual(marketPublicationMetadata(content).resources,[{id:'method',title:field('研究方法','Research method')},{id:'reference',title:field('参考资料','Reference material')}])
})

test('私有行业资源没有本地化元数据仍可导入重读，公开发布继续阻断',async()=>{
 const actor={ownerId:randomUUID(),kind:'human' as const},manifest=industryManifest()
 const privateManifest={...manifest,localized:undefined,resources:manifest.resources.map(resource=>({...resource,localized:undefined}))}
 const imported=await new MarketContentStore(pool,identity).import(actor,{kind:'industry-template',requestId:randomUUID(),source:{kind:'upload',name:'私有草案'},manifestPath:'teloa.json',files:[file('teloa.json',JSON.stringify(privateManifest)),file('SKILL.md','# 私有原文')],references:[]})
 const content=await new MarketContentStore(pool,identity).get(actor,{contentId:imported.content.id})
 assert.deepEqual(content.metadata,JSON.parse(JSON.stringify(privateManifest)))
 assert.throws(()=>marketPublicationMetadata(content),/公开发布/)
})

test('安全运营示例模板的清单与数据源、MCP、执行工具定义按各自格式校验通过',()=>{
 const root=new URL('../../../examples/industry/安全运营/',import.meta.url)
 const read=(path:string)=>JSON.parse(readFileSync(new URL(path,root),'utf8'))
 const manifest=validateManifest(read('teloa.json'))
 const resource=(id:string)=>manifest.resources.find(value=>value.id===id)!
 const local=(id:string)=>{const found=resource(id);assert.equal(found.source.kind,'local');return read(found.source.kind==='local'?found.source.path:'')}
 assert.deepEqual(readIndustryDataSourceDefinition(local('alert-data')),{format:'teloa.data-source/v1',sourceId:'security-alert-http',scopes:['SOC'],sourceNoun:'告警源'})
 assert.deepEqual(readIndustryMcpConnectionDefinition(local('alert-mcp')),{format:'teloa.mcp-connection/v1',serverName:'teloa_reference',tools:['read_reference']})
 // 第三方插件 dsh-visualize 已整体下线（产品底座只用官方插件），示例模板不再带 plugin 资源。
 assert.equal(manifest.resources.some(value=>value.kind==='plugin'),false)
 assert.deepEqual(local('isolate-tool'),{format:'teloa.execution-tool/v1',adapterId:'security-action-http',tools:['security.endpoint.isolate']})
 assert.deepEqual(manifest.relations.filter(row=>row.kind==='role-connection').map(row=>row.to).sort(),['alert-data','alert-mcp','isolate-tool'])
})

test('安全运营示例模板是七行齐备的合包：台账声明与任务模板都在同一包内自洽',()=>{
 const root=new URL('../../../examples/industry/安全运营/',import.meta.url)
 const read=(path:string)=>JSON.parse(readFileSync(new URL(path,root),'utf8'))
 const manifest=validateManifest(read('teloa.json'))
 const byKind=(kind:string)=>manifest.resources.filter(value=>value.kind===kind)
 const local=(id:string)=>{const found=manifest.resources.find(value=>value.id===id)!;assert.equal(found.source.kind,'local');return read(found.source.kind==='local'?found.source.path:'')}
 assert.deepEqual(byKind('object-type').map(value=>value.id),['alert-ticket','incident-ticket','asset'])
 assert.deepEqual(byKind('business-view').map(value=>value.id),['soc-risk-distribution','soc-pending-board','soc-alert-trend','soc-alert-list','soc-incident-list','soc-asset-list'])
 assert.deepEqual(byKind('business-action').map(value=>value.id),['assign-alert-review','isolate-endpoint'])
 assert.deepEqual(byKind('work-template').map(value=>value.id),['alert-triage-review','endpoint-isolation-record'])
 // 产品文档写这个展品带「1 个自动化」，因此包里必须真有一条 plan，且它引用的任务模板在同一包内。
 assert.deepEqual(byKind('plan').map(value=>value.id),['daily-alert-triage'])
 const plan=local('daily-alert-triage')
 assert.equal(plan.format,'teloa.plan/v1')
 // 持续计划读取器逐字核对 plan.version 与清单资源版本相等，两处写歪一处就整条读不出来。
 assert.equal(plan.version,manifest.resources.find(value=>value.id==='daily-alert-triage')!.version)
 assert.equal(plan.workTemplate,'alert-triage-review')
 assert.deepEqual(plan.trigger,{kind:'schedule',cadence:'daily',weekday:1,time:'08:30',timezone:'Asia/Singapore'})
 // 台账声明只能指向同一包内的接入源与执行工具：夹具里那两条重复声明已经被合并掉了。
 const sourceIds=new Set(byKind('data-source').map(value=>readIndustryDataSourceDefinition(local(value.id)).sourceId))
 for(const objectType of byKind('object-type'))assert.ok(sourceIds.has(local(objectType.id).sourceId),`${objectType.id} 绑定的数据源不在同一包内`)
 const workTemplates=new Set(byKind('work-template').map(value=>value.id)),tools=new Set(byKind('execution-tool').map(value=>value.id))
 for(const action of byKind('business-action')){
  const {target}=local(action.id)
  if(target.kind==='execution-tool'){assert.ok(tools.has(target.localId));assert.ok(workTemplates.has(target.workTemplate))}
  else assert.ok(workTemplates.has(target.localId))
 }
 for(const objectType of byKind('object-type'))assert.equal(local(objectType.id).domain,manifest.scope)
})

/** 示例包读口：清单过正式校验，定义正文按清单里的相对路径取，文件摘要按导入时的同一口径算。 */
function samplePackage(directory:string){
 const root=new URL(directory==='安全运营-v2'?'../../../tests/fixtures/industry-template-upgrade/security-v2/':`../../../examples/industry/${directory}/`,import.meta.url)
 const read=(path:string)=>JSON.parse(readFileSync(new URL(path,root),'utf8'))
 const manifest=validateManifest(read('teloa.json'))
 const walk=(prefix:string):{path:string;hash:string}[]=>readdirSync(new URL(prefix,root),{withFileTypes:true}).flatMap(entry=>
  entry.isDirectory()?walk(`${prefix}${entry.name}/`):[{path:prefix+entry.name,hash:createHash('sha256').update(readFileSync(new URL(prefix+entry.name,root))).digest('hex')}])
 return {
  manifest,read,files:walk(''),
  byKind:(kind:string)=>manifest.resources.filter(value=>value.kind===kind),
  local:(id:string)=>{const found=manifest.resources.find(value=>value.id===id)!;assert.equal(found.source.kind,'local');return read(found.source.kind==='local'?found.source.path:'')},
 }
}

test('应用安全示例模板是只带台账声明的部分包，声明之间在同一包内自洽',()=>{
 const {manifest,byKind,local}=samplePackage('应用安全')
 assert.equal(manifest.id,'application-security')
 // 与安全运营同为 security 行业归类，业务范围各自独立；部分包没有同事、技能与资料，这是正常形态。
 assert.equal(manifest.domain,'security')
 assert.equal(manifest.scope,'AppSec')
 for(const kind of ['role','knowledge','skill','mcp','plugin','execution-tool'])assert.equal(byKind(kind).length,0,`部分包不应带 ${kind}`)
 assert.deepEqual(readIndustryDataSourceDefinition(local('finding-data')),{format:'teloa.data-source/v1',sourceId:'appsec-finding-http',scopes:['AppSec'],sourceNoun:'代码仓库'})
 assert.deepEqual(byKind('object-type').map(value=>value.id),['application','vulnerability','fix-ticket'])
 assert.deepEqual(byKind('business-view').map(value=>value.id),['appsec-risk-level','appsec-sla-trend','appsec-application-list','appsec-vulnerability-list','appsec-fix-ticket-list'])
 assert.deepEqual(byKind('business-action').map(value=>value.id),['open-fix-ticket'])
 assert.deepEqual(byKind('work-template').map(value=>value.id),['vulnerability-fix'])
 const sourceIds=new Set(byKind('data-source').map(value=>readIndustryDataSourceDefinition(local(value.id)).sourceId))
 for(const objectType of byKind('object-type')){
  assert.ok(sourceIds.has(local(objectType.id).sourceId),`${objectType.id} 绑定的数据源不在同一包内`)
  assert.equal(local(objectType.id).domain,manifest.scope)
 }
 const workTemplates=new Set(byKind('work-template').map(value=>value.id))
 for(const action of byKind('business-action')){
  const {target,domain}=local(action.id)
  assert.equal(domain,manifest.scope)
  assert.equal(target.kind,'work-template')
  assert.ok(workTemplates.has(target.localId),`${action.id} 的任务模板不在同一包内`)
 }
 const objectTypes=new Set(byKind('object-type').map(value=>value.id))
 for(const view of byKind('business-view'))assert.ok(objectTypes.has(local(view.id).objectType),`${view.id} 的对象类型不在同一包内`)
})

test('安全运营 v2 是 v1 的全部台账声明加它原有的四处改动，升级预览不再整片移除',()=>{
 const before=samplePackage('安全运营'),after=samplePackage('安全运营-v2')
 const side=(value:ReturnType<typeof samplePackage>)=>({manifest:value.manifest,manifestPath:'teloa.json',files:value.files})
 const diff=compareIndustryUpdateCore(side(before),side(after))
 const ids=(change:string)=>diff.resources.filter(row=>row.change===change).map(row=>row.id).sort()
 // v2 只在四处不同：知识升版、新增参考清单连接、移除执行工具与 Skill。
 assert.deepEqual(ids('added'),['alert-reference-list'])
 // alert-data 一并列为 changed 是 v2 早就存在的差异：它的 data/alerts.json 没有 sourceNoun。
 // 这与本次补齐台账声明无关，原样保留，不在这里顺手改 v2 的接入源语义。
 assert.deepEqual(ids('changed'),['alert-data','security-triage'])
 // 「隔离这台主机」随 isolate-tool 一并移除：它的 target 指向该执行工具，留在 v2 里台账整条读不出来。
 assert.deepEqual(ids('removed'),['alert-triage','isolate-endpoint','isolate-tool'])
 // 三类对象、六张视图、另一个动作、两份任务模板与那条自动化在两版之间逐字未变，升级预览里不出现。
 for(const id of ['alert-ticket','incident-ticket','asset','soc-risk-distribution','soc-pending-board','soc-alert-trend','soc-alert-list','soc-incident-list','soc-asset-list','assign-alert-review','alert-triage-review','endpoint-isolation-record','daily-alert-triage'])
  assert.ok(ids('unchanged').includes(id),`${id} 在 v1 与 v2 之间不应有差异`)
 assert.deepEqual(diff.kindChanges,[])
})

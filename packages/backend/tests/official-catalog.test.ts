import test,{after,before} from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {WorkError,marketCatalogTreeHash} from '@teloa/contract'
import {initializeMarketContents,MarketContentStore,type MarketActor} from '../src/market/content-store.ts'
import {OfficialCatalogService,filterCatalogEntries,sortCatalogEntries,type OfficialCatalogSnapshot} from '../src/market/official-catalog.ts'
import {officialCatalogFiles,officialCatalogIndex,officialCatalogIndexSha256} from '../src/market/official-catalog-snapshot.ts'
import {loadOfficialUpstreamIndex,listUpstreamEntries} from '../src/market/official-upstream.ts'

let container:StartedPostgreSqlContainer,pool:Pool
const identity={id:randomUUID,now:()=>new Date('2026-09-25T12:00:00.000Z').toISOString()}
const human=():MarketActor=>({ownerId:randomUUID(),kind:'human'})
const snapshot=():OfficialCatalogSnapshot=>({indexSha256:officialCatalogIndexSha256,index:structuredClone(officialCatalogIndex),files:{...officialCatalogFiles}})
type Imported={actor:MarketActor;input:Record<string,any>}
const stub=()=>{const calls:Imported[]=[];return {calls,store:{import:async(actor:MarketActor,input:unknown)=>{calls.push({actor,input:input as Record<string,any>});return {receipt:{},content:{}} as never},findByIdentity:async()=>null,findByCatalogSources:async()=>new Map<string,string>()}}}

const sha256=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex')
const enc=new TextEncoder()
function buildSolutionSnapshot():OfficialCatalogSnapshot{
 const manifest={format:'teloa.business-package/v2',id:'test-sol',title:'测试方案',version:'1.0.0',domain:'general',scope:'test',description:'最小测试方案。',
  resources:[{id:'role-1',kind:'role',title:'测试岗',version:'1.0.0',required:true,source:{kind:'local',path:'role.json'}}],relations:[],entrypoints:[]}
 const fileMap:{[path:string]:Uint8Array}={'teloa.json':enc.encode(JSON.stringify(manifest)),'role.json':enc.encode('{}'),'LICENSE':enc.encode('MIT License')}
 const artifactFiles=Object.keys(fileMap).sort().map(p=>({path:p,sha256:sha256(fileMap[p]!),size:fileMap[p]!.byteLength}))
 const entry={format:'teloa.market-catalog-entry/v1',id:'teloa.test-sol',kind:'solution',delivery:'install',version:'1.0.0',upstream:null,
  taxonomy:{functions:['office-docs'],industries:['general']},
  solution:{packageId:'test-sol',title:{'zh-CN':'测试方案',en:'Test solution'},summary:{'zh-CN':'测试。',en:'Test.'},scope:'test',
   capabilities:{now:[{'zh-CN':'测试',en:'Test'}],needs:[{'zh-CN':'无',en:'Nothing'}],permissions:[{'zh-CN':'无',en:'None'}]}},
  modifications:[],license:{spdx:'MIT',files:['LICENSE']},
  compatibility:{status:'content-only',teloa:'>=0.2.0-alpha.6',dsh:'0.1.7-rc.1',conditions:[]},
  requires:{tools:[],network:false,runtimes:[]},review:{status:'approved',reviewedAt:'2026-09-25',reviewer:'Teloa'},
  artifact:{files:artifactFiles,treeHash:marketCatalogTreeHash(artifactFiles,sha256)}}
 const index={format:'teloa.market-catalog/v1',catalogVersion:'test-2026.9.25',entries:[entry]}
 const indexJson=JSON.stringify(index)
 const files:Record<string,string>={}
 for(const [p,bytes] of Object.entries(fileMap))files['teloa.test-sol/1.0.0/'+p]=Buffer.from(bytes).toString('base64')
 return {indexSha256:sha256(indexJson),index,files}
}

before(async()=>{
 await loadOfficialUpstreamIndex()
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73').start()
 pool=new Pool({connectionString:container.getConnectionUri()})
 await initializeMarketContents(pool)
},{timeout:180_000})
after(async()=>{await pool?.end();await container?.stop()})

 test('随发行固定的快照加载成功，十五个技能、十八个方案、十四个 AI 同事与十八个模型，内置创建器与看板设计可取字节',async()=>{
 const {store}=stub(),service=new OfficialCatalogService(store),listed=await service.list(human())
 // 期望值取自同步进来的镜像版本文件，快照版本须与 tests/fixtures/public-market/ 镜像一致
 assert.equal(listed.catalogVersion,(await readFile(new URL('../../../tests/fixtures/public-market/catalog-version.txt',import.meta.url),'utf8')).trim())
 assert.equal(listed.counts.role,14);assert.equal(listed.counts.model,18)
 // 全量超过一页 50 条：方案与技能按 kind 各取一页核对
 const ofKind=async(kind:'solution'|'skill')=>(await service.list(human(),{kind})).items
 assert.deepEqual((await ofKind('solution')).map(item=>item.entry.id),['teloa.appsec','teloa.cn-workspace','teloa.code-review','teloa.detection','teloa.ecommerce','teloa.finance','teloa.grc','teloa.growth','teloa.incident','teloa.marketing','teloa.office','teloa.project','teloa.recruiting','teloa.research','teloa.sales','teloa.soc','teloa.support','teloa.video'])
 assert.deepEqual((await ofKind('skill')).map(item=>[item.entry.id,item.entry.delivery]),[['anthropic.commit','install'],['anthropic.feature-dev','install'],['anthropic.internal-comms','install'],['anthropic.mcp-builder','install'],['anthropic.modernize-assess','install'],['anthropic.modernize-extract-rules','install'],['anthropic.review-pr','install'],['hermes.grounded-citations','install'],['hermes.meeting-action-items','install'],['hermes.simplify-code','install'],['openai.security-best-practices','install'],['openai.security-threat-model','install'],['openai.skill-creator','builtin'],['openclaw.github','install'],['teloa.dashboard-designer','builtin']])
 assert.ok(listed.items.every(item=>item.addedContentId===null&&!('artifact' in item.entry)))
 const creator=service.builtin('teloa-skill-creator')
 assert.equal(creator.entry.id,'openai.skill-creator')
 assert.ok(creator.files.some(file=>file.path==='SKILL.md'&&new TextDecoder().decode(file.bytes).startsWith('---\nname: teloa-skill-creator\n')))
 const designer=service.builtin('teloa-dashboard-designer')
 assert.equal(designer.entry.id,'teloa.dashboard-designer')
 assert.equal(designer.entry.version,'1.1.0')
 assert.ok(designer.files.some(file=>file.path==='SKILL.md'&&new TextDecoder().decode(file.bytes).startsWith('---\nname: teloa-dashboard-designer\n')))
 assert.throws(()=>service.builtin('internal-comms'),{code:'teloa/source-unavailable'})
})

test('快照任何一处被改都让整个目录停用',async()=>{
 const mutations:((value:OfficialCatalogSnapshot)=>void)[]=[
  value=>{const key=Object.keys(value.files)[0]!;const bytes=Buffer.from(value.files[key]!,'base64');bytes[0]=bytes[0]!^1;value.files={...value.files,[key]:bytes.toString('base64')}},
  value=>{(value.index as any).entries[0].skill.summary.en='changed'},
  value=>{(value.index as any).entries[0].artifact.treeHash='0'.repeat(64)},
  value=>{value.files={...value.files,'extra/1.0.0/x.md':Buffer.from('x').toString('base64')}},
  value=>{const {[Object.keys(value.files)[0]!]:_,...rest}=value.files;value.files=rest},
 ]
 for(const mutate of mutations){
  const value=snapshot();mutate(value)
  const service=new OfficialCatalogService(stub().store,value)
  await assert.rejects(service.list(human()),{code:'teloa/storage-corrupt'})
  await assert.rejects(service.add(human(),{requestId:randomUUID(),entryId:'anthropic.internal-comms'}),{code:'teloa/storage-corrupt'})
  assert.throws(()=>service.builtin('teloa-skill-creator'),{code:'teloa/storage-corrupt'})
  assert.equal(service.hasEntry('anthropic.internal-comms'),false)
 }
})

test('添加请求：只接受本人，内置条目与未知条目拒绝，trust 由条目推出',async()=>{
 const {store,calls}=stub(),service=new OfficialCatalogService(store)
 await assert.rejects(service.add({ownerId:'a',kind:'agent'},{requestId:randomUUID(),entryId:'anthropic.internal-comms'}),{code:'teloa/forbidden'})
 await assert.rejects(service.add(human(),{requestId:randomUUID(),entryId:'openai.skill-creator'}),{code:'teloa/invalid-input'})
 await assert.rejects(service.add(human(),{requestId:randomUUID(),entryId:'nobody.none'}),{code:'teloa/invalid-input'})
 await assert.rejects(service.add(human(),{requestId:randomUUID(),entryId:'anthropic.internal-comms',trust:{}}),{code:'teloa/invalid-input'})
 await assert.rejects(service.add(human(),{requestId:'x',entryId:'anthropic.internal-comms'}),{code:'teloa/invalid-input'})
 await service.add(human(),{requestId:randomUUID(),entryId:'anthropic.internal-comms'})
 const input=calls[0]!.input
 assert.equal(input.source.kind,'catalog');assert.equal(input.source.entryId,'anthropic.internal-comms')
 assert.equal(input.trust.review.conclusion,'approved');assert.equal(input.trust.license.value,'Apache-2.0')
 assert.ok(input.files.every((file:{path:string})=>file.path.startsWith('internal-comms/')))
 assert.equal(input.metadata.id,'internal-comms');assert.equal(input.metadata.title,'内部沟通稿')
})

test('真库：添加后以 catalog 来源固定，重放同回执，目录回显已添加',async()=>{
 const self=human(),store=new MarketContentStore(pool,identity),service=new OfficialCatalogService(store),requestId=randomUUID()
 const first=await service.add(self,{requestId,entryId:'hermes.meeting-action-items'})
 assert.equal(first.content.kind,'atomic-skill');assert.equal(first.content.logicalId,'meeting-action-items')
 assert.equal(first.receipt.source.kind,'catalog')
 assert.deepEqual(first.content.provides,[{resourceId:'meeting-action-items',kind:'skill',version:'1.0.0',path:'meeting-action-items/SKILL.md'}])
 const again=await service.add(self,{requestId,entryId:'hermes.meeting-action-items'})
 assert.equal(again.content.id,first.content.id)
 const replayed=await store.getImport(self,{requestId})
 assert.deepEqual(replayed.receipt.source,first.receipt.source)
 const listed=await service.list(self)
 assert.equal(listed.items.find(item=>item.entry.id==='hermes.meeting-action-items')?.addedContentId,first.content.id)
 assert.equal((await service.list(human())).items.find(item=>item.entry.id==='hermes.meeting-action-items')?.addedContentId,null)
})

test('真库：catalog 来源字段不全或多余一律拒绝',async()=>{
 const store=new MarketContentStore(pool,identity),base={kind:'catalog',catalog:'teloa-official',catalogVersion:'2026.9.25',entryId:'x.y',entryVersion:'1.0.0',treeHash:'a'.repeat(64)}
 const files=[{path:'s/SKILL.md',bytes:new TextEncoder().encode('---\nname: s\ndescription: d\n---\nbody\n')}]
 for(const source of [{...base,extra:1},{...base,catalog:'other'},{...base,entryId:'noDot'},{...base,treeHash:'z'},(({treeHash:_,...rest})=>rest)(base)]){
  await assert.rejects(store.import(human(),{kind:'atomic-skill',requestId:randomUUID(),source,metadata:{id:'s',title:'s',version:'1.0.0',categories:[]},files}),{code:'teloa/invalid-input'})
 }
})

test('真库：上传来源不能冒充「Teloa 官方目录」发布者',async()=>{
 const store=new MarketContentStore(pool,identity),files=[{path:'s/SKILL.md',bytes:new TextEncoder().encode('---\nname: spoof\ndescription: d\n---\nbody\n')}]
 const trust={publisher:'Teloa 官方目录',repository:null,license:{status:'declared',value:'MIT'},signature:{status:'unverified',signer:null},compatibility:{teloa:'x',dsh:'x'},plugins:[],externalCapabilities:[],permissions:[],review:{conclusion:'approved',summary:'伪造'}}
 await assert.rejects(store.import(human(),{kind:'atomic-skill',requestId:randomUUID(),source:{kind:'upload',name:'spoof'},metadata:{id:'spoof',title:'spoof',version:'1.0.0',categories:[]},trust,files}),{code:'teloa/invalid-input'})
})

test('方案条目 stub：industry-template 种类、trust 字段正确、repository 为 null',async()=>{
 const {store,calls}=stub(),service=new OfficialCatalogService(store,buildSolutionSnapshot())
 const listed=await service.list(human())
 assert.equal(listed.catalogVersion,'test-2026.9.25')
 assert.equal(listed.items.length,1);assert.equal(listed.items[0]!.entry.kind,'solution')
 assert.equal(listed.items[0]!.addedContentId,null)
 await service.add(human(),{requestId:randomUUID(),entryId:'teloa.test-sol'})
 const input=calls[0]!.input
 assert.equal(input.kind,'industry-template')
 assert.equal(input.manifestPath,'teloa.json')
 assert.equal(input.source.kind,'catalog');assert.equal(input.source.entryId,'teloa.test-sol')
 assert.equal(input.trust.repository,null)
 assert.equal(input.trust.review.conclusion,'approved');assert.equal(input.trust.license.value,'MIT')
 assert.ok(input.files.some((f:{path:string})=>f.path==='teloa.json'))
 assert.ok(input.files.some((f:{path:string})=>f.path==='role.json'))
 assert.deepEqual(input.references,[])
})

test('真库：方案条目添加得到 industry-template，provides 含角色资源，重复添加幂等',async()=>{
 const self=human(),store=new MarketContentStore(pool,identity),service=new OfficialCatalogService(store,buildSolutionSnapshot()),requestId=randomUUID()
 const first=await service.add(self,{requestId,entryId:'teloa.test-sol'})
 assert.equal(first.content.kind,'industry-template');assert.equal(first.content.logicalId,'test-sol')
 assert.equal(first.receipt.source.kind,'catalog')
 assert.ok(first.content.provides.some(p=>p.kind==='role'&&p.resourceId==='role-1'))
 const again=await service.add(self,{requestId,entryId:'teloa.test-sol'})
 assert.equal(again.content.id,first.content.id)
 const listed=await service.list(self)
 assert.equal(listed.items.find(item=>item.entry.id==='teloa.test-sol')?.addedContentId,first.content.id)
})

test('stub：上游条目 compatibility.status=unsupported 被拒绝且未发起下载',async()=>{
 const {store,calls}=stub(),service=new OfficialCatalogService(store)
 // clawhub.byungkyu.gmail 在生成后的上游索引中 status=unsupported
 await assert.rejects(service.add(human(),{requestId:randomUUID(),entryId:'clawhub.byungkyu.gmail'}),{code:'teloa/invalid-input'})
 assert.equal(calls.length,0,'store.import 不应被调用（拒绝应在下载前发生）')
})

test('stub：Teloa 官方快照条目 compatibility.status=unsupported 被拒绝',async()=>{
 // 构建一个含 unsupported 条目的快照
 const enc=new TextEncoder()
 const content=enc.encode('---\nname: blocked-skill\ndescription: test\n---\nbody\n')
 const license=enc.encode('MIT')
 const artifactFiles=[{path:'SKILL.md',sha256:sha256(content),size:content.byteLength},{path:'LICENSE',sha256:sha256(license),size:license.byteLength}]
 const entry={format:'teloa.market-catalog-entry/v1',id:'test.blocked',kind:'skill',delivery:'install',version:'1.0.0',
  taxonomy:{functions:['dev-tools'],industries:['general']},
  upstream:{ecosystem:'test',author:'Test',repository:{host:'github.com',owner:'test',repo:'blocked'},commit:'a'.repeat(40),path:'src',license:'MIT',files:[{path:'SKILL.md',gitBlob:'b'.repeat(40),size:content.byteLength}]},
  modifications:[],license:{spdx:'MIT',files:['LICENSE']},
  compatibility:{status:'unsupported',teloa:'>=0.2.0',dsh:'any',conditions:[{'zh-CN':'测试','en':'test'}]},
  requires:{tools:[],network:false,runtimes:[]},review:{status:'approved',reviewedAt:'2026-09-25',reviewer:'test'},
  skill:{name:'blocked-skill',title:{'zh-CN':'测试','en':'Test'},summary:{'zh-CN':'摘要','en':'Summary'}},
  artifact:{files:artifactFiles,treeHash:marketCatalogTreeHash(artifactFiles,sha256)}}
 const index={format:'teloa.market-catalog/v1',catalogVersion:'test-unsupported',entries:[entry]}
 const indexJson=JSON.stringify(index)
 const snap:OfficialCatalogSnapshot={indexSha256:createHash('sha256').update(indexJson).digest('hex'),index,files:{'test.blocked/1.0.0/SKILL.md':Buffer.from(content).toString('base64'),'test.blocked/1.0.0/LICENSE':Buffer.from(license).toString('base64')}}
 const {store,calls}=stub(),service=new OfficialCatalogService(store,snap)
 await assert.rejects(service.add(human(),{requestId:randomUUID(),entryId:'test.blocked'}),{code:'teloa/invalid-input'})
 assert.equal(calls.length,0,'store.import 不应被调用')
})

test('纯函数：filterCatalogEntries 按 query 与 kind 过滤，sortCatalogEntries 按 installs 降序、Teloa 条目视为 0 并按 id 稳定',async()=>{
 const service=new OfficialCatalogService(stub().store),teloa=(await service.list(human())).items.map(item=>item.entry),upstream=listUpstreamEntries(),all=[...upstream,...teloa]
 const byQuery=filterCatalogEntries(all,{query:'创建器'})
 assert.ok(byQuery.length>=1);assert.ok(byQuery.every(entry=>entry.id==='openai.skill-creator'))
 const connectors=filterCatalogEntries(all,{kind:'connector'})
 assert.ok(connectors.length>=1);assert.ok(connectors.every(entry=>entry.kind==='connector'))
 assert.deepEqual(filterCatalogEntries(all,{query:'不存在的词'}),[])
 assert.deepEqual(filterCatalogEntries(all,{query:'创建器',kind:'solution'}),[])
 const sorted=sortCatalogEntries(all,'installs'),installs=(entry:typeof all[number])=>entry.delivery==='upstream'?entry.origin.installs??0:0
 for(let i=1;i<sorted.length;i++){
  const prev=sorted[i-1]!,next=sorted[i]!
  assert.ok(installs(prev)>installs(next)||installs(prev)===installs(next)&&prev.id<next.id,`${prev.id} 应排在 ${next.id} 之前`)
 }
 const firstTeloa=sorted.findIndex(entry=>entry.delivery!=='upstream'),lastWithInstalls=sorted.map(installs).lastIndexOf(Math.max(...sorted.map(installs).filter(v=>v>0)))
 assert.ok(firstTeloa>lastWithInstalls)
 const byName=sortCatalogEntries(teloa.filter(entry=>entry.kind==='skill'),'name').map(entry=>(entry as {skill:{name:string}}).skill.name)
 assert.deepEqual(byName,[...byName].sort())
})

test('list：Teloa 分支 query / kind / sort 生效，分页在过滤排序之后',async()=>{
 const service=new OfficialCatalogService(stub().store)
 const queried=await service.list(human(),{query:'创建器'})
 assert.deepEqual(queried.items.map(item=>item.entry.id),['openai.skill-creator'])
 const solutions=await service.list(human(),{kind:'solution'})
 assert.equal(solutions.items.length,18);assert.ok(solutions.items.every(item=>item.entry.kind==='solution'))
 const named=await service.list(human(),{kind:'skill',sort:'name'}),names=named.items.map(item=>(item.entry as {skill:{name:string}}).skill.name)
 assert.deepEqual(names,[...names].sort())
 const paged=await service.list(human(),{kind:'solution',limit:3})
 assert.equal(paged.items.length,3);assert.equal(paged.nextCursor,paged.items[2]!.entry.id)
 const rest=await service.list(human(),{kind:'solution',limit:3,cursor:paged.nextCursor!})
 assert.equal(rest.items.length,3);assert.ok(rest.items.every(item=>item.entry.kind==='solution'))
 const upstream=await service.list(human(),{marketplace:'clawhub',kind:'connector'})
 assert.equal(upstream.items.length,0)
})

const roleFixture=()=>({format:'teloa.market-catalog-entry/v1',id:'teloa.role.test-role',kind:'role',delivery:'install',version:'1.0.0',upstream:null,
 taxonomy:{functions:['office-docs'],industries:['general']},
 role:{roleId:'test-role',title:{'zh-CN':'测试岗',en:'Test role'},summary:{'zh-CN':'测试。',en:'Test.'},
  definition:{name:'测试岗',kind:'employee',duty:'核对',dataScope:'获准资料',executionScope:'代拟',responsibility:{triggers:['收到任务'],autonomousActions:['读取'],confirmationPoints:['外发确认'],escalationRules:['冲突升级'],deliveryChecks:['有来源']}},
  skills:['tool-a'],scope:'test',preferredModel:null,fromSolution:{packageId:'test-sol',version:'1.0.0',path:'roles/test-role.json'}},
 modifications:[],license:{spdx:'MIT',files:[],url:'https://opensource.org/license/mit'},
 compatibility:{status:'content-only',teloa:'>=0.2.0-alpha.6',dsh:'0.1.7-rc.1',conditions:[]},
 requires:{tools:[],network:false,runtimes:[]},review:{status:'approved',reviewedAt:'2026-09-25',reviewer:'Teloa'}})
const modelFixture=()=>({format:'teloa.market-catalog-entry/v1',id:'teloa.model.test-model',kind:'model',delivery:'reference',version:'1.0.0',upstream:null,
 taxonomy:{functions:['other'],industries:['general']},
 model:{modelId:'test-model',title:{'zh-CN':'测试模型',en:'Test model'},summary:{'zh-CN':'测试。',en:'Test.'},form:'cloud',usage:['chat'],capabilities:{tools:true,vision:false,reasoning:false,structured:true},contextWindow:32000,
  license:{spdx:'custom',name:'服务条款',url:'https://example.com/terms',tier:'commercial',restrictions:[]},cnReachable:'direct',support:'supported',notes:[],
  cloud:{provider:{kind:'pi-ai',id:'deepseek'},models:[{id:'m1',name:'M1',contextWindow:32000,maxTokens:4096,input:['text']}],priceBand:'low',credentialLabel:{'zh-CN':'密钥',en:'Key'},signupUrl:'https://example.com'},local:null,variants:null},
 modifications:[],license:{spdx:'custom',files:[],url:'https://example.com/terms'},
 compatibility:{status:'needs-configuration',teloa:'>=0.2.0-alpha.6',dsh:'0.1.7-rc.1',conditions:[]},
 requires:{tools:[],network:true,runtimes:[]},review:{status:'approved',reviewedAt:'2026-09-25',reviewer:'Teloa'}})
function buildKindsSnapshot():OfficialCatalogSnapshot{
 const base=buildSolutionSnapshot(),index=base.index as {entries:Record<string,unknown>[];format:string;catalogVersion:string}
 const roleBytes=enc.encode(JSON.stringify({format:'teloa.role/v1',...(roleFixture().role.definition)}))
 const roleFiles=[{path:'role.json',sha256:sha256(roleBytes),size:roleBytes.byteLength}]
 const entries=[...index.entries,{...roleFixture(),artifact:{files:roleFiles,treeHash:marketCatalogTreeHash(roleFiles,sha256)}},{...modelFixture(),artifact:null}].sort((a,b)=>String(a.id)<String(b.id)?-1:1)
 const next={...index,entries},json=JSON.stringify(next)
 return {indexSha256:sha256(json),index:next,files:{...base.files,'teloa.role.test-role/1.0.0/role.json':Buffer.from(roleBytes).toString('base64')}}
}

test('list：counts 在过滤前算全量六类，kind=role / model 可筛，query 命中 roleId / modelId；model 无 artifact',async()=>{
 const service=new OfficialCatalogService(stub().store,buildKindsSnapshot())
 const all=await service.list(human())
 assert.deepEqual(all.counts,{solution:1,dashboard:0,role:1,skill:0,connector:0,model:1})
 assert.deepEqual(all.skipped,{unknownKind:0,newerApp:0})
 const roles=await service.list(human(),{kind:'role'})
 assert.deepEqual(roles.items.map(item=>item.entry.id),['teloa.role.test-role']);assert.deepEqual(roles.counts,all.counts)
 const models=await service.list(human(),{kind:'model'})
 assert.equal(models.items.length,1);assert.equal(models.items[0]!.artifact,null);assert.equal(models.items[0]!.addedContentId,null)
 assert.deepEqual((await service.list(human(),{query:'test-model'})).items.map(item=>item.entry.id),['teloa.model.test-model'])
 // sort:'name' 用 solution.title.en('Test solution'，大写 T 排前) / modelId('test-model') / roleId('test-role')
 assert.deepEqual((await service.list(human(),{sort:'name'})).items.map(item=>item.entry.id),['teloa.test-sol','teloa.model.test-model','teloa.role.test-role'])
 assert.equal(service.getRoleEntry('teloa.role.test-role')?.role.roleId,'test-role')
 assert.equal(service.getRoleEntry('teloa.test-sol'),undefined)
 // 市场二期榜单过滤：任何类型的现存条目都算，不存在的不算
 assert.deepEqual(['teloa.test-sol','teloa.model.test-model','teloa.role.test-role','teloa.gone'].map(id=>service.hasEntry(id)),[true,true,true,false])
 // 上游索引条目（ClawHub 等）与 list/add 同源，同样算现存
 const upstreamId=listUpstreamEntries()[0]!.id
 assert.match(upstreamId,/^clawhub\./)
 assert.equal(service.hasEntry(upstreamId),true)
 assert.equal(service.hasEntry('clawhub.nobody.gone'),false)
 assert.equal(service.roleEntryForAdd('teloa.role.test-role').role.scope,'test')
 assert.throws(()=>service.roleEntryForAdd('teloa.test-sol'),{code:'teloa/source-unavailable'})
 const unsupported=buildKindsSnapshot();const idx=unsupported.index as {entries:Record<string,any>[]};idx.entries.find(e=>e.kind==='role')!.compatibility.status='unsupported';unsupported.indexSha256=sha256(JSON.stringify(unsupported.index))
 assert.throws(()=>new OfficialCatalogService(stub().store,unsupported).roleEntryForAdd('teloa.role.test-role'),(error:unknown)=>error instanceof WorkError&&error.code==='teloa/invalid-input'&&/暂不支持/.test(error.message))
})

test('list：role 条目按（本人, 条目, 版本）一页一次批量回显已建岗位 addedRoleId，其余类型恒为 null；未接岗位端口时全为 null',async()=>{
 const roleId=randomUUID(),seen:unknown[]=[],actor=human()
 const service=new OfficialCatalogService(stub().store,buildKindsSnapshot(),{catalogRoleIds:async(owner,entries)=>{seen.push([owner,entries.map(entry=>[entry.id,entry.version])]);return new Map([['teloa.role.test-role',roleId]])}})
 assert.deepEqual((await service.list(actor)).items.map(item=>[item.entry.id,item.addedRoleId]),[['teloa.model.test-model',null],['teloa.role.test-role',roleId],['teloa.test-sol',null]])
 assert.deepEqual(seen,[[actor.ownerId,[['teloa.role.test-role','1.0.0']]]])
 assert.ok((await new OfficialCatalogService(stub().store,buildKindsSnapshot()).list(human())).items.every(item=>item.addedRoleId===null))
 // 这一页没有 role 条目（按类型筛到模型）：岗位端口一次都不调，不为空列表白查一次库。
 seen.length=0
 assert.deepEqual((await service.list(actor,{kind:'model'})).items.map(item=>[item.entry.id,item.addedRoleId]),[['teloa.model.test-model',null]])
 assert.deepEqual(seen,[])
})

test('add：role 与 model 条目不走内容添加，各给固定文案',async()=>{
 const {calls,store}=stub(),service=new OfficialCatalogService(store,buildKindsSnapshot()),actor=human()
 await assert.rejects(service.add(actor,{requestId:randomUUID(),entryId:'teloa.role.test-role'}),(error:unknown)=>error instanceof WorkError&&error.code==='teloa/invalid-input'&&/kind:"role"/.test(error.message))
 await assert.rejects(service.add(actor,{requestId:randomUUID(),entryId:'teloa.model.test-model'}),(error:unknown)=>error instanceof WorkError&&error.code==='teloa/invalid-input'&&/设置 · 模型/.test(error.message))
 assert.equal(calls.length,0)
})

test('add：expectedTreeHash 不等拒绝、相等导入；连接器条目不能添加为内容',async()=>{
 const {store,calls}=stub(),service=new OfficialCatalogService(store)
 const listed=await service.list(human(),{query:'anthropic.internal-comms'}),treeHash=listed.items[0]!.artifact!.treeHash
 await assert.rejects(service.add(human(),{requestId:randomUUID(),entryId:'anthropic.internal-comms',expectedTreeHash:'0'.repeat(64)}),{code:'teloa/version-conflict'})
 await assert.rejects(service.add(human(),{requestId:randomUUID(),entryId:'anthropic.internal-comms',expectedTreeHash:'zz'}),{code:'teloa/invalid-input'})
 await assert.rejects(service.add(human(),{requestId:randomUUID(),entryId:'anthropic.internal-comms',expectedTreeHash:treeHash,extra:1}),{code:'teloa/invalid-input'})
 assert.equal(calls.length,0)
 await service.add(human(),{requestId:randomUUID(),entryId:'anthropic.internal-comms',expectedTreeHash:treeHash})
 assert.equal(calls.length,1);assert.equal(calls[0]!.input.source.treeHash,treeHash)
 await assert.rejects(service.add(human(),{requestId:randomUUID(),entryId:'teloa.mcp-amap'}),error=>error instanceof Error&&(error as {code?:string}).code==='teloa/invalid-input'&&/teloa_mcp_connect/.test(error.message))
 assert.equal(calls.length,1)
 // 上游条目：treeHash 由 upstream.files 推出，不等时在下载前拒绝
 await assert.rejects(service.add(human(),{requestId:randomUUID(),entryId:'clawhub.ivangdavila.git',expectedTreeHash:'0'.repeat(64)}),{code:'teloa/version-conflict'})
 assert.equal(calls.length,1)
})

test('getConnectorPackageLock：每个 stdio 连接器都随附与配方一致的完整 lock（v3、根只钉配方包、逐条 sha512）；远端连接器、非连接器、目录损坏返回 undefined',()=>{
 const service=new OfficialCatalogService(stub().store,snapshot())
 const stdio=(officialCatalogIndex as {entries:{id:string;kind:string;connector?:{recipe:{transport:string}}}[]}).entries.filter(entry=>entry.kind==='connector'&&entry.connector!.recipe.transport==='stdio')
 assert.ok(stdio.length>=7)
 for(const {id} of stdio){
  const recipe=service.getConnectorEntry(id)!.connector.recipe
  assert.equal(recipe.transport,'stdio')
  if(recipe.transport!=='stdio')continue
  const lock=service.getConnectorPackageLock(id) as {lockfileVersion:number;packages:Record<string,{version?:string;integrity?:string;dependencies?:Record<string,string>}>}
  assert.ok(lock,id+' 缺少随附 lock')
  assert.equal(lock.lockfileVersion,3,id)
  assert.deepEqual(lock.packages['']!.dependencies,{[recipe.package]:recipe.version},id)
  assert.equal(lock.packages[`node_modules/${recipe.package}`]!.integrity,recipe.integrity,id)
  assert.equal(lock.packages[`node_modules/${recipe.package}`]!.version,recipe.version,id)
  for(const [key,entry] of Object.entries(lock.packages))if(key!=='')assert.match(String(entry.integrity),/^sha512-/,id+' '+key)
 }
 assert.equal(service.getConnectorPackageLock('teloa.mcp-deepwiki'),undefined)
 assert.equal(service.getConnectorPackageLock('anthropic.internal-comms'),undefined)
 assert.equal(service.getConnectorPackageLock('missing.entry'),undefined)
 const broken=snapshot();(broken.index as any).entries[0].artifact.treeHash='0'.repeat(64)
 assert.equal(new OfficialCatalogService(stub().store,broken).getConnectorPackageLock(stdio[0]!.id),undefined)
})

test('add：local-specialist 模型条目（语音、嵌入）都不进内容添加，也不指向 设置 · 模型',async()=>{
 const {calls,store}=stub(),actor=human()
 const base=buildKindsSnapshot(),idx=base.index as {entries:Record<string,any>[]}
 const cloud=idx.entries.find(e=>e.kind==='model')!
 const {cloud:_,local:__,variants:___,...specialistFields}=cloud.model
 const local=(id:string,modelId:string,usage:string,native:Record<string,string>)=>({...cloud,id,model:{...specialistFields,modelId,form:'local-specialist',usage:[usage],capabilities:{tools:false,vision:false,reasoning:false,structured:false},contextWindow:null,native}})
 idx.entries.push(local('teloa.model.test-speech','test-speech','speech-to-text',{kind:'dsh-speech',providerId:'sensevoice-local'}))
 idx.entries.push(local('teloa.model.test-embedding','test-embedding','embedding',{kind:'teloa-embedding',providerId:'qwen3-embedding-0.6b'}))
 base.indexSha256=sha256(JSON.stringify(base.index))
 const service=new OfficialCatalogService(store,base)
 for(const [entryId,guidance] of [['teloa.model.test-speech',/本地语音由原生扩展准备/],['teloa.model.test-embedding',/本地检索模型由 Teloa 本地中文检索扩展准备/]] as const)
  await assert.rejects(service.add(actor,{requestId:randomUUID(),entryId}),(error:unknown)=>error instanceof WorkError&&error.code==='teloa/invalid-input'&&guidance.test(error.message)&&!/设置 · 模型/.test(error.message))
 assert.equal(calls.length,0)
})

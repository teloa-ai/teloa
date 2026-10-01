import test,{after,before} from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {initializeMarketContents,MarketContentStore,type MarketActor,type MarketFileInput} from '../src/market/content-store.ts'
import {createIndustryLoadSource} from '../src/work/industry-load-source.ts'
import {IndustryLoadService,initializeIndustryLoads} from '../src/work/industry-loads.ts'
import {useLocalContainerRuntime} from './testcontainers-env.ts'
import {dashboardBody,dashboardManifest} from './fixtures/business-dashboard.ts'
import {readMarketBusinessConfigurationResource} from '../src/market/content-store.ts'

let container:StartedPostgreSqlContainer,pool:Pool
const encoder=new TextEncoder()
const file=(path:string,text:string):MarketFileInput=>({path,bytes:encoder.encode(text)})
const identity={id:randomUUID,now:()=>new Date('2026-09-11T12:00:00.000Z').toISOString()}
const actor=():MarketActor=>({ownerId:randomUUID(),kind:'human'})
const trust=(status:'verified'|'unverified'='verified')=>({publisher:'Teloa Labs',repository:{host:'github.com' as const,owner:'teloa-ai',repo:'skills'},license:{status:'declared' as const,value:'Apache-2.0'},signature:{status,signer:status==='verified'?'release':null},compatibility:{teloa:'>=0.0.1 <1.0.0',dsh:'>=0.1.2-alpha.3 <0.2.0'},plugins:[],externalCapabilities:[],permissions:[{id:status==='verified'?'docs.read':'docs.write',description:'资料权限',required:true}],review:{conclusion:'needs-review' as const,summary:'核对权限'}})

test('行业加载来源读取本人固定清单，缺少的可选项保留，不把公共引用当成本地文件',async()=>{
 const self=actor(),store=new MarketContentStore(pool,identity),source=createIndustryLoadSource(store)
 const atomic=await store.import(self,{kind:'atomic-skill',requestId:randomUUID(),source:{kind:'upload',name:'公共方法'},metadata:{id:'common-method',title:'方法',version:'1.0.0',categories:[]},files:[file('SKILL.md','# 方法')]})
 const manifest={format:'teloa.business-package/v2',id:'source-test',title:'行业来源',version:'1.0.0',domain:'general',description:'固定来源',resources:[{id:'method',kind:'skill',title:'公共方法',version:'1.0.0',required:true,source:{kind:'public',id:'common-method',version:'1.0.0'}},{id:'optional',kind:'knowledge',title:'可选资料',version:'1.0.0',required:false,source:{kind:'local',path:'optional.md'}}],relations:[],entrypoints:['method']}
 const imported=await store.import(self,{kind:'industry-template',requestId:randomUUID(),source:{kind:'upload',name:'来源验收'},manifestPath:'teloa.json',files:[file('teloa.json',JSON.stringify(manifest))],references:[{resourceId:'method',sourceContentId:atomic.content.id,sourceItemId:'atomic-'+atomic.content.hash,sourceResourceId:'common-method',sourceHash:atomic.content.hash}]})
 const result=await source.read(self.ownerId,imported.content.id,imported.content.hash)
 assert.equal(result.templateId,'source-test');assert.deepEqual(result.resources.map(row=>[row.localId,row.available]),[['method',true],['optional',false]])
 assert.deepEqual(result.entrypoints,['method'])
 await initializeIndustryLoads(pool)
 const single=new Pool({connectionString:container.getConnectionUri(),max:1,connectionTimeoutMillis:3000})
 try{
  const actualSource=createIndustryLoadSource(new MarketContentStore(single,identity))
  const loaded=await new IndustryLoadService(single,identity,actualSource).create(self.ownerId,{requestId:randomUUID(),contentId:imported.content.id,contentHash:imported.content.hash,target:{kind:'new',spaceId:randomUUID(),name:'固定来源组合验收'}})
  assert.equal(loaded.contentHash,imported.content.hash);assert.equal(loaded.items.length,2)
  assert.equal(loaded.items.find(item=>item.localId==='optional')?.status,'skipped')
 }finally{await single.end()}
 await assert.rejects(source.read(self.ownerId,imported.content.id,'0'.repeat(64)),{code:'teloa/source-unavailable'})
 await assert.rejects(source.read(randomUUID(),imported.content.id,imported.content.hash))
 await assert.rejects(source.read(self.ownerId,atomic.content.id,atomic.content.hash),{code:'teloa/source-unavailable'})
 await pool.query('update teloa_market_files set bytes=$2 where content_id=$1',[atomic.content.id,Buffer.from('# 变更')])
 await assert.rejects(source.read(self.ownerId,imported.content.id,imported.content.hash),{code:'teloa/storage-corrupt'})
})

before(async()=>{
 useLocalContainerRuntime()
 container=await new PostgreSqlContainer('postgres@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73').start()
 pool=new Pool({connectionString:container.getConnectionUri()})
 await initializeMarketContents(pool)
},{timeout:180_000})
after(async()=>{await pool?.end();await container?.stop()})

test('v4 公共业务配置在真实内容仓固定同主体字节，跨主体、坏身份及循环拒绝，加载仍待采用',async()=>{
 const self=actor(),store=new MarketContentStore(pool,identity),manifest=dashboardManifest()
 const fixed=await store.import(self,{kind:'industry-template',requestId:randomUUID(),source:{kind:'upload',name:'安全运营看板'},manifestPath:'teloa.json',files:[file('teloa.json',JSON.stringify(manifest)),file('configuration.json',JSON.stringify(dashboardBody()))],references:[]})
 const reference={resourceId:'overview',sourceContentId:fixed.content.id,sourceItemId:'directory-'+fixed.content.hash,sourceResourceId:'soc-overview',sourceHash:fixed.content.hash}
 const combination={...manifest,id:'soc-combination',resources:[{id:'overview',kind:'business-configuration',title:'告警总览',version:'1.0.0',required:true,source:{kind:'public',id:'soc-overview',version:'1.0.0'}}]}
 const input={kind:'industry-template' as const,source:{kind:'upload' as const,name:'安全运营组合'},manifestPath:'teloa.json',files:[file('teloa.json',JSON.stringify(combination))],references:[reference]}
 const imported=await store.import(self,{...input,requestId:randomUUID()})
 const repeated=await new MarketContentStore(pool,identity).import(self,{...input,requestId:randomUUID()})
 assert.equal(imported.content.id,repeated.content.id);assert.equal(imported.content.hash,repeated.content.hash)
 assert.equal((await store.get(self,{contentId:imported.content.id})).references[0]?.sourceContentId,fixed.content.id)
 assert.deepEqual(readMarketBusinessConfigurationResource(await store.get(self,{contentId:fixed.content.id}),'soc-overview'),dashboardBody())
 for(const bad of [{...reference,sourceHash:'0'.repeat(64)},{...reference,sourceItemId:'atomic-'+fixed.content.hash},{...reference,sourceResourceId:'missing'},{...reference,sourceContentId:randomUUID()}])await assert.rejects(store.import(self,{...input,requestId:randomUUID(),references:[bad]}),{code:'teloa/source-unavailable'})
 await assert.rejects(store.import(actor(),{...input,requestId:randomUUID()}),{code:'teloa/source-unavailable'})
 const wrongVersion={...combination,resources:combination.resources.map(row=>({...row,version:'2.0.0',source:{...row.source,version:'2.0.0'}}))}
 await assert.rejects(store.import(self,{...input,requestId:randomUUID(),files:[file('teloa.json',JSON.stringify(wrongVersion))]}),{code:'teloa/source-unavailable'})
 await initializeIndustryLoads(pool)
 const load=await new IndustryLoadService(pool,identity,createIndustryLoadSource(store)).create(self.ownerId,{requestId:randomUUID(),contentId:imported.content.id,contentHash:imported.content.hash,target:{kind:'new',spaceId:randomUUID(),name:'配置待采用验收'}})
 assert.deepEqual(load.items.map(row=>[row.kind,row.status]),[['business-configuration','pending-adapter']])
 // 在数据库模拟反向引用成环；读取之前的来源闸必须直接拒绝，不能递归沿环。
 await pool.query('update teloa_market_contents set refs=$2 where id=$1',[fixed.content.id,JSON.stringify([{...reference,sourceContentId:imported.content.id}])])
 await assert.rejects(store.get(self,{contentId:imported.content.id}),{code:'teloa/source-unavailable'})
 await pool.query('update teloa_market_contents set refs=$2 where id=$1',[fixed.content.id,'[]'])
 await pool.query("update teloa_market_files set bytes=$2 where content_id=$1 and path='configuration.json'",[fixed.content.id,Buffer.from('{}')])
 await assert.rejects(store.get(self,{contentId:imported.content.id}),{code:'teloa/storage-corrupt'})
})

test('独立 Skill 的固定字节和服务端摘要可在服务重建后读取',async()=>{
 const self=actor(),requestId=randomUUID(),store=new MarketContentStore(pool,identity)
 const created=await store.import(self,{kind:'atomic-skill',requestId,source:{kind:'upload',name:'报告方法'},metadata:{id:'report-writing',title:'报告方法',version:'1.0.0',categories:['写作']},files:[file('report/SKILL.md','# 报告方法\n'),file('report/reference.md','引用规范')]})
 assert.equal(created.receipt.requestId,requestId)
 assert.equal(created.content.kind,'atomic-skill')
 assert.equal(created.content.logicalId,'report-writing')
 assert.equal(created.content.hash,'74f205ed0658c5f2dce1ff1ea688617bc97662567f3f66831540362b4fe434ad')
 assert.deepEqual(created.content.provides,[{resourceId:'report-writing',kind:'skill',version:'1.0.0',path:'report/SKILL.md'}])
 const restored=await new MarketContentStore(pool,identity).getImport(self,{requestId})
 assert.equal(restored.receipt.contentId,created.content.id)
 assert.equal(new TextDecoder().decode(restored.content.files[0]!.bytes),'# 报告方法\n')
 assert.equal(new TextDecoder().decode(restored.content.files[1]!.bytes),'引用规范')
 assert.equal(restored.content.createdAt,'2026-09-11T12:00:00.000Z')
})

test('市场内容校验并固定可选本地化元数据，旧内容摘要保持不变',async()=>{
 const self=actor(),store=new MarketContentStore(pool,identity)
 const title={original:'报告方法',defaultLocale:'en',locales:{en:'Report writing','zh-Hant':'報告方法','zh-TW':{fallback:'zh-Hant'}}}
 const atomic=await store.import(self,{kind:'atomic-skill',requestId:randomUUID(),source:{kind:'upload',name:'本地化方法'},metadata:{id:'localized-report',title:'报告方法',version:'1.0.0',categories:[],localized:{title}},files:[file('SKILL.md','# 正文保持原样')]})
 assert.deepEqual(atomic.content.metadata.localized,{title})
 assert.equal(new TextDecoder().decode(atomic.content.files[0]!.bytes),'# 正文保持原样')
 await assert.rejects(store.import(self,{kind:'atomic-skill',requestId:randomUUID(),source:{kind:'upload',name:'错误本地化'},metadata:{id:'bad-localized',title:'报告方法',version:'1.0.0',categories:[],localized:{title:{...title,original:'别的标题'}}},files:[file('SKILL.md','# 正文')]}),{code:'teloa/invalid-input'})
 const manifest={format:'teloa.business-package/v2',id:'localized-industry',title:'研究行业',version:'1.0.0',domain:'general',description:'稳定说明',localized:{title:{original:'研究行业',defaultLocale:'en',locales:{en:'Research industry'}},description:{original:'稳定说明',defaultLocale:'en',locales:{en:'Stable description'}}},resources:[{id:'method',kind:'skill',title:'方法',version:'1.0.0',required:true,source:{kind:'local',path:'SKILL.md'}}],relations:[],entrypoints:['method']}
 const imported=await store.import(self,{kind:'industry-template',requestId:randomUUID(),source:{kind:'upload',name:'本地化行业'},manifestPath:'teloa.json',files:[file('teloa.json',JSON.stringify(manifest)),file('SKILL.md','# 方法')],references:[]})
 assert.deepEqual(imported.content.metadata.localized,manifest.localized)
 const oldStyle=await store.import(self,{kind:'atomic-skill',requestId:randomUUID(),source:{kind:'upload',name:'报告方法'},metadata:{id:'report-writing-hash-check',title:'报告方法',version:'1.0.0',categories:['写作']},files:[file('report/SKILL.md','# 报告方法\n'),file('report/reference.md','引用规范')]})
 assert.equal(oldStyle.content.metadata.localized,undefined)
})

test('旧 schema 升级后不改写历史导入身份，缺少 trustHash 的合法回执仍可读',async()=>{
 const schema='legacy_market_'+randomUUID().replaceAll('-',''),legacy=new Pool({connectionString:container.getConnectionUri(),options:`-c search_path=${schema}`}),owner=randomUUID(),contentId=randomUUID(),requestId=randomUUID(),at=new Date(identity.now()),metadata={id:'legacy-skill',title:'旧 Skill',version:'1.0.0',categories:[]},bytes=Buffer.from('# 旧正文'),fileHash=createHash('sha256').update(bytes).digest('hex'),baseHash=createHash('sha256').update(JSON.stringify({metadata,files:[['SKILL.md',fileHash]]})).digest('hex'),source={kind:'upload',name:'旧来源'},provides=[{resourceId:'legacy-skill',kind:'skill',version:'1.0.0',path:'SKILL.md'}],requestSpec={kind:'atomic-skill',source,logicalId:'legacy-skill',version:'1.0.0',hash:baseHash,baseHash,manifestPath:'SKILL.md',metadata,references:[]}
 try{
  await pool.query(`create schema ${schema}`)
  await legacy.query(`create table teloa_market_contents(id uuid primary key,owner_id text not null,kind text not null,logical_id text not null,version text not null,content_hash text not null,base_hash text not null,manifest_path text not null,metadata jsonb not null,provides jsonb not null,refs jsonb not null,created_at timestamptz not null,unique(owner_id,kind,logical_id,version,content_hash));create table teloa_market_files(content_id uuid not null references teloa_market_contents(id),path text not null,file_hash text not null,bytes bytea not null,primary key(content_id,path));create table teloa_market_imports(owner_id text not null,request_id uuid not null,request_spec jsonb not null,content_id uuid not null references teloa_market_contents(id),source jsonb not null,created_at timestamptz not null,primary key(owner_id,request_id))`)
  await legacy.query('insert into teloa_market_contents values($1,$2,$3,$4,$5,$6,$6,$7,$8,$9,$10,$11)',[contentId,owner,'atomic-skill','legacy-skill','1.0.0',baseHash,'SKILL.md',JSON.stringify(metadata),JSON.stringify(provides),'[]',at])
  await legacy.query('insert into teloa_market_files values($1,$2,$3,$4)',[contentId,'SKILL.md',fileHash,bytes])
  await legacy.query('insert into teloa_market_imports values($1,$2,$3,$4,$5,$6)',[owner,requestId,JSON.stringify(requestSpec),contentId,JSON.stringify(source),at])
  await initializeMarketContents(legacy)
  const restored=await new MarketContentStore(legacy,identity).getImport({ownerId:owner,kind:'human'},{requestId})
  assert.equal(restored.content.id,contentId);assert.equal(restored.receipt.requestId,requestId);assert.equal(restored.content.trust.signature.status,'unverified')
  assert.deepEqual((await legacy.query('select request_spec from teloa_market_imports where request_id=$1',[requestId])).rows[0].request_spec,requestSpec)
  const catalogRequestId=randomUUID(),catalogSource={kind:'catalog',catalog:'teloa-official',catalogVersion:'legacy',entryId:'test.legacy',entryVersion:'1.0.0',treeHash:'e'.repeat(64)}
  await legacy.query('insert into teloa_market_imports values($1,$2,$3,$4,$5,$6)',[owner,catalogRequestId,JSON.stringify({...requestSpec,source:catalogSource}),contentId,JSON.stringify(catalogSource),at])
  const store=new MarketContentStore(legacy,identity),self={ownerId:owner,kind:'human' as const},lookup={entryId:catalogSource.entryId,entryVersion:'1.0.0',treeHash:catalogSource.treeHash,logicalId:'legacy-skill',trustHash:restored.content.trustHash}
  assert.equal((await store.getImport(self,{requestId:catalogRequestId})).content.id,contentId)
  assert.equal((await store.findByCatalogSources(self,[lookup])).get(catalogSource.entryId),contentId)
  assert.equal((await store.findByCatalogSources(self,[{...lookup,trustHash:'f'.repeat(64)}])).size,0)
 }finally{await legacy.end();await pool.query(`drop schema if exists ${schema} cascade`)}
})

test('相同内容摘要仅信任声明变化时形成可区分固定来源，不会成功返回旧声明',async()=>{
 const self=actor(),store=new MarketContentStore(pool,identity),base={kind:'atomic-skill' as const,source:{kind:'upload' as const,name:'来源'},metadata:{id:'trust-reimport',title:'信任重导入',version:'1.0.0',categories:[]},files:[file('SKILL.md','# 相同字节')]}
 const first=await store.import(self,{...base,requestId:randomUUID(),trust:trust('verified')}),second=await store.import(self,{...base,requestId:randomUUID(),trust:trust('unverified')})
 assert.equal(first.content.hash,second.content.hash);assert.notEqual(first.content.trustHash,second.content.trustHash);assert.notEqual(first.content.id,second.content.id)
 assert.equal(second.content.trust.signature.status,'unverified');assert.equal(second.content.trust.permissions[0]?.id,'docs.write')
})

test('相同请求和不同请求并发导入同一内容都复用固定快照，同请求不能换内容',async()=>{
 const self=actor(),requestId=randomUUID(),store=new MarketContentStore(pool,identity)
 const input={kind:'atomic-skill' as const,requestId,source:{kind:'upload' as const,name:'调查'},metadata:{id:'investigate',title:'调查',version:'1.0.0',categories:['安全']},files:[file('SKILL.md','# 调查')]}
 const [sameA,sameB]=await Promise.all([store.import(self,input),store.import(self,input)])
 assert.equal(sameA.content.id,sameB.content.id)
 assert.equal(sameA.receipt.requestId,sameB.receipt.requestId)
 const [another,third]=await Promise.all([
  store.import(self,{...input,requestId:randomUUID()}),
  store.import(self,{...input,requestId:randomUUID()}),
 ])
 assert.equal(another.content.id,sameA.content.id)
 assert.equal(third.content.id,sameA.content.id)
 assert.notEqual(another.receipt.requestId,sameA.receipt.requestId)
 assert.notEqual(third.receipt.requestId,another.receipt.requestId)
 await assert.rejects(store.import(self,{...input,metadata:{...input.metadata,title:'另一项 Skill'}}),{code:'teloa/conflict'})
 const counts=await pool.query(`select
  (select count(*)::int from teloa_market_contents where owner_id=$1) contents,
  (select count(*)::int from teloa_market_imports where owner_id=$1) imports`,[self.ownerId])
 assert.deepEqual(counts.rows[0],{contents:1,imports:3})
})

test('行业模板只接受服务端核对过的公共原子 Skill 精确身份、版本和摘要',async()=>{
 const self=actor(),store=new MarketContentStore(pool,identity)
 const atomic=await store.import(self,{kind:'atomic-skill',requestId:randomUUID(),source:{kind:'upload',name:'公共报告'},metadata:{id:'report-writing',title:'报告方法',version:'1.0.0',categories:['写作']},files:[file('report/SKILL.md','# 报告')]})
 const manifest={format:'teloa.business-package/v2',id:'research',title:'研究行业',version:'1.0.0',domain:'general',description:'固定资料形成研究结论。',resources:[{id:'analyst',kind:'role',title:'研究分析员',version:'1.0.0',required:true,source:{kind:'local',path:'roles/analyst.json'}},{id:'report',kind:'skill',title:'报告方法',version:'1.0.0',required:true,source:{kind:'public',id:'report-writing',version:'1.0.0'}}],relations:[{kind:'role-skill',from:'analyst',to:'report'}],entrypoints:['report']}
 const files=[file('research/teloa.json',JSON.stringify(manifest)),file('research/roles/analyst.json','{"format":"teloa.role/v1"}')]
 const reference={resourceId:'report',sourceContentId:atomic.content.id,sourceItemId:'atomic-'+atomic.content.hash,sourceResourceId:'report-writing',sourceHash:atomic.content.hash}
 const imported=await store.import(self,{kind:'industry-template',requestId:randomUUID(),source:{kind:'upload',name:'研究行业'},manifestPath:'research/teloa.json',files,references:[reference]})
 assert.equal(imported.content.logicalId,'research')
 assert.equal(imported.content.references[0]?.sourceContentId,atomic.content.id)
 assert.notEqual(imported.content.hash,imported.content.baseHash)
 assert.deepEqual(imported.content.provides,[{resourceId:'analyst',kind:'role',version:'1.0.0',path:'research/roles/analyst.json'}])
 await assert.rejects(store.import(self,{kind:'industry-template',requestId:randomUUID(),source:{kind:'upload',name:'错误摘要'},manifestPath:'research/teloa.json',files,references:[{...reference,sourceHash:'0'.repeat(64)}]}),{code:'teloa/source-unavailable'})
 await assert.rejects(store.import({...self,ownerId:randomUUID()},{kind:'industry-template',requestId:randomUUID(),source:{kind:'upload',name:'跨本人'},manifestPath:'research/teloa.json',files,references:[reference]}),{code:'teloa/source-unavailable'})
 const otherManifest={...manifest,id:'other-research',title:'另一行业'}
 const otherFiles=[file('research/teloa.json',JSON.stringify(otherManifest)),file('research/roles/analyst.json','{"format":"teloa.role/v1"}')]
 const other=await store.import(self,{kind:'industry-template',requestId:randomUUID(),source:{kind:'upload',name:'另一行业'},manifestPath:'research/teloa.json',files:otherFiles,references:[reference]})
 await pool.query('update teloa_market_contents set refs=$2 where id=$1',[imported.content.id,JSON.stringify([{...reference,sourceContentId:other.content.id}])])
 await pool.query(`update teloa_market_files set bytes=$2 where content_id=$1 and path='research/teloa.json'`,[other.content.id,Buffer.from('已损坏')])
 await assert.rejects(store.get(self,{contentId:imported.content.id}),{code:'teloa/source-unavailable'})
 await pool.query('update teloa_market_contents set refs=$2 where id=$1',[imported.content.id,JSON.stringify([reference])])
 await pool.query(`update teloa_market_files set bytes=$2 where content_id=$1 and path='report/SKILL.md'`,[atomic.content.id,Buffer.from('# 来源已篡改')])
 await assert.rejects(store.get(self,{contentId:imported.content.id}),{code:'teloa/storage-corrupt'})
})

test('服务端拒绝危险路径、缺失必需文件和未经支持的公共来源',async()=>{
 const self=actor(),store=new MarketContentStore(pool,identity)
 await assert.rejects(store.import(self,{kind:'atomic-skill',requestId:randomUUID(),source:{kind:'upload',name:'越界'},metadata:{id:'unsafe',title:'越界',version:'1.0.0',categories:[]},files:[file('../SKILL.md','bad')]}),{code:'teloa/invalid-input'})
 const missing={format:'teloa.business-package/v2',id:'missing',title:'缺文件',version:'1.0.0',domain:'general',description:'缺失内容',resources:[{id:'role',kind:'role',title:'岗位',version:'1.0.0',required:true,source:{kind:'local',path:'role.json'}}],relations:[],entrypoints:[]}
 await assert.rejects(store.import(self,{kind:'industry-template',requestId:randomUUID(),source:{kind:'upload',name:'缺文件'},manifestPath:'teloa.json',files:[file('teloa.json',JSON.stringify(missing))],references:[]}),{code:'teloa/invalid-input'})
 const publicKnowledge={...missing,id:'public-knowledge',resources:[{id:'guide',kind:'knowledge',title:'指南',version:'1.0.0',required:true,source:{kind:'public',id:'guide',version:'1.0.0'}}]}
 await assert.rejects(store.import(self,{kind:'industry-template',requestId:randomUUID(),source:{kind:'upload',name:'未支持来源'},manifestPath:'teloa.json',files:[file('teloa.json',JSON.stringify(publicKnowledge))],references:[]}),{code:'teloa/source-unavailable'})
})

test('目录按本人分页，同时间内容不遗漏，游标不能跨本人',async()=>{
 const self=actor(),other=actor(),store=new MarketContentStore(pool,identity)
 const make=(who:MarketActor,id:string)=>store.import(who,{kind:'atomic-skill',requestId:randomUUID(),source:{kind:'upload',name:id},metadata:{id,title:id,version:'1.0.0',categories:[]},files:[file('SKILL.md','# '+id)]})
 const own=await Promise.all(['list-a','list-b','list-c'].map(id=>make(self,id)))
 const foreign=await make(other,'list-other')
 const first=await store.list(self,{limit:2})
 assert.equal(first.items.length,2);assert.ok(first.nextCursor)
 const last=await new MarketContentStore(pool,identity).list(self,{limit:2,cursor:first.nextCursor})
 assert.equal(last.items.length,1);assert.equal(last.nextCursor,null)
 assert.deepEqual([...first.items,...last.items].map(row=>row.id).sort(),own.map(row=>row.content.id).sort())
 assert.ok(first.items.every(row=>!('files' in row)))
 await assert.rejects(store.list(self,{cursor:foreign.content.id}),{code:'teloa/not-found'})
 await assert.rejects(store.list(self,{limit:101}),{code:'teloa/invalid-input'})
 await assert.rejects(store.list(self,{limit:null}),{code:'teloa/invalid-input'})
 await assert.rejects(store.list(self,{ownerId:other.ownerId}),{code:'teloa/invalid-input'})
})

test('读取重新计算文件和内容摘要，数据库字节被改写时明确报损坏',async()=>{
 const self=actor(),store=new MarketContentStore(pool,identity)
 const created=await store.import(self,{kind:'atomic-skill',requestId:randomUUID(),source:{kind:'upload',name:'待核对'},metadata:{id:'tamper-check',title:'篡改核对',version:'1.0.0',categories:[]},files:[file('SKILL.md','# 原文')]})
 await pool.query(`update teloa_market_files set bytes=$2 where content_id=$1 and path='SKILL.md'`,[created.content.id,Buffer.from('# 已篡改')])
 await assert.rejects(store.get(self,{contentId:created.content.id}),{code:'teloa/storage-corrupt'})
 await assert.rejects(store.get({...self,ownerId:randomUUID()},{contentId:created.content.id}),{code:'teloa/forbidden'})
})

test('目录来源批量读取真实导入回执，按本人及条目版本树摘要固定，多来源共享内容仍各自可查',async()=>{
 const self=actor(),other=actor(),store=new MarketContentStore(pool,identity)
 const sourceA={kind:'catalog' as const,catalog:'teloa-official' as const,catalogVersion:'old-release',entryId:'test.source-a',entryVersion:'1.0.0',treeHash:'a'.repeat(64)}
 const sourceB={...sourceA,entryId:'test.source-b'}
 const content={kind:'atomic-skill' as const,metadata:{id:'fixed-source',title:'固定来源',version:'1.0.0',categories:[]},trust:trust(),files:[file('SKILL.md','# 同一份内容')]}
 const a=await store.import(self,{...content,requestId:randomUUID(),source:sourceA})
 const b=await store.import(self,{...content,requestId:randomUUID(),source:sourceB})
 assert.equal(a.content.id,b.content.id)
 const foreign=await store.import(other,{...content,requestId:randomUUID(),source:sourceA})
 const lookup=(entryId:string)=>({entryId,entryVersion:'1.0.0',treeHash:sourceA.treeHash,logicalId:a.content.logicalId,trustHash:a.content.trustHash})
 const ids=await store.findByCatalogSources(self,[lookup(sourceA.entryId),lookup(sourceB.entryId)])
 assert.deepEqual([...ids].sort(),[[sourceA.entryId,a.content.id],[sourceB.entryId,a.content.id]])
 assert.equal((await store.findByCatalogSources(other,[lookup(sourceA.entryId)])).get(sourceA.entryId),foreign.content.id)
 for(const missing of [{...lookup(sourceA.entryId),entryId:'test.not-added'},{...lookup(sourceA.entryId),entryVersion:'1.0.1'},{...lookup(sourceA.entryId),treeHash:'b'.repeat(64)},{...lookup(sourceA.entryId),trustHash:'c'.repeat(64)}]){
  assert.equal((await store.findByCatalogSources(self,[missing])).size,0)
 }
 await pool.query("update teloa_market_imports set request_spec=jsonb_set(request_spec,'{hash}',to_jsonb($2::text)) where owner_id=$1 and request_id=$3",[self.ownerId,'d'.repeat(64),a.receipt.requestId])
 await assert.rejects(store.findByCatalogSources(self,[lookup(sourceA.entryId)]),{code:'teloa/storage-corrupt'})
})

test('GitHub 来源与信任记录的仓库名按契约共用规则：.github、下划线结尾可入内容仓，.git 结尾与含斜线拒绝',async()=>{
 const self=actor(),store=new MarketContentStore(pool,identity)
 const github=(repo:string)=>({kind:'github' as const,owner:'teloa-ai',repo,requestedRef:'main',resolvedCommit:'0'.repeat(40),archiveHash:'f'.repeat(64)})
 const input=(repo:string,id:string)=>({kind:'atomic-skill' as const,requestId:randomUUID(),source:github(repo),metadata:{id,title:'组织笔记',version:'1.0.0',categories:['写作']},trust:{...trust('unverified'),repository:{host:'github.com' as const,owner:'teloa-ai',repo}},files:[file(id+'/SKILL.md','# 笔记\n')]})
 for(const [repo,id] of [['.github','org-notes'],['notes_','notes-underscore']] as const){
  const created=await store.import(self,input(repo,id))
  assert.equal((created.receipt.source as {repo:string}).repo,repo);assert.equal(created.content.trust.repository?.repo,repo)
 }
 for(const repo of ['skills.git','SKILLS.GIT','a/b','..'])await assert.rejects(store.import(self,input(repo,'bad-repo')),{code:'teloa/invalid-input',message:/仓库身份格式不正确/},repo)
})

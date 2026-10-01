import test,{after,before} from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {initializeMarketContents,MarketContentStore} from '../src/market/content-store.ts'
import {createIndustryLoadSource} from '../src/work/industry-load-source.ts'
import {IndustryLoadService,initializeIndustryLoads} from '../src/work/industry-loads.ts'
import {SkillInstallSource,type SkillInstallSourceInput} from '../src/market/skill-install-source.ts'
import {SkillInstallationService,initializeSkillInstallations,type SkillInstallationFilesPort} from '../src/market/skill-installations.ts'
import {BusinessSpaceService} from '../src/work/business-spaces.ts'
import type {IndustryModelDependency,IndustryModelPhase} from '@teloa/contract'

let container:StartedPostgreSqlContainer,pool:Pool
const enc=new TextEncoder(),identity={id:randomUUID,now:()=>new Date('2026-09-12T10:00:00.000Z').toISOString()}
const file=(path:string,text:string)=>({path,bytes:enc.encode(text)})
const manifest=(source:{kind:'local';path:string}|{kind:'public';id:string;version:string})=>({format:'teloa.business-package/v2',id:'skill-package',title:'Skill 行业包',version:'1.0.0',domain:'general',description:'固定 Skill 来源',resources:[{id:'brief',kind:'skill',title:'研究简报',version:'1.0.0',required:true,source}],relations:[],entrypoints:['brief']})
async function load(owner:string,market:MarketContentStore,content:{id:string;hash:string}){const loads=new IndustryLoadService(pool,identity,createIndustryLoadSource(market)),record=await loads.create(owner,{requestId:randomUUID(),contentId:content.id,contentHash:content.hash,target:{kind:'new',spaceId:randomUUID(),name:'Skill 空间'}});return {loads,record,item:record.items[0]!}}

before(async()=>{process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock');process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock';container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()});await initializeMarketContents(pool);await initializeIndustryLoads(pool);await initializeSkillInstallations(pool)},{timeout:180_000})
after(async()=>{await pool?.end();await container?.stop()})

test('独立原子 Skill 返回以 SKILL.md 为根的固定完整文件树',async()=>{
 const owner=randomUUID(),market=new MarketContentStore(pool,identity),saved=await market.import({ownerId:owner,kind:'human'},{kind:'atomic-skill',requestId:randomUUID(),source:{kind:'upload',name:'简报'},metadata:{id:'brief',title:'研究简报',version:'1.0.0',categories:[]},files:[file('brief/SKILL.md','---\nname: brief\ndescription: 写简报\n---\n正文'),file('brief/references/格式.md','格式')]}),source=new SkillInstallSource(market,{get:async()=>{throw Error('不应读取行业加载')}})
 const value=await source.read(owner,{kind:'atomic',contentId:saved.content.id})
 assert.equal(value.entryPath,'SKILL.md');assert.equal(value.source.kind,'atomic');assert.equal(value.source.contentId,saved.content.id);assert.equal(value.source.contentHash,saved.content.hash)
 assert.deepEqual(value.files.map(row=>[row.path,new TextDecoder().decode(row.bytes)]),[['SKILL.md','---\nname: brief\ndescription: 写简报\n---\n正文'],['references/格式.md','格式']]);assert.match(value.bundleHash,/^[a-f0-9]{64}$/)
 await assert.rejects(source.read(randomUUID(),{kind:'atomic',contentId:saved.content.id}),{code:'teloa/forbidden'})
})

test('行业包内 Skill 只沿真实加载映射读取并保留行业来源身份',async()=>{
 const owner=randomUUID(),market=new MarketContentStore(pool,identity),saved=await market.import({ownerId:owner,kind:'human'},{kind:'industry-template',requestId:randomUUID(),source:{kind:'upload',name:'本地 Skill'},manifestPath:'pkg/teloa.json',files:[file('pkg/teloa.json',JSON.stringify(manifest({kind:'local',path:'skills/brief/SKILL.md'}))),file('pkg/skills/brief/SKILL.md','---\nname: brief\ndescription: 写简报\n---\n正文'),file('pkg/skills/brief/helper.txt','辅助')],references:[]}),loaded=await load(owner,market,saved.content),source=new SkillInstallSource(market,loaded.loads)
 const value=await source.read(owner,{kind:'industry',loadId:loaded.record.id,itemInstanceId:loaded.item.instanceId})
 assert.equal(value.source.kind,'industry-local');assert.equal(value.source.contentId,saved.content.id);assert.equal(value.source.contentHash,saved.content.hash);assert.equal(value.source.loadId,loaded.record.id);assert.equal(value.source.itemInstanceId,loaded.item.instanceId)
 assert.deepEqual(value.files.map(row=>row.path),['SKILL.md','helper.txt'])
 await assert.rejects(source.read(randomUUID(),{kind:'industry',loadId:loaded.record.id,itemInstanceId:loaded.item.instanceId}),{code:'teloa/forbidden'})
 await pool.query('update teloa_industry_load_items set kind=$2 where instance_id=$1',[loaded.item.instanceId,'knowledge']);await assert.rejects(source.read(owner,{kind:'industry',loadId:loaded.record.id,itemInstanceId:loaded.item.instanceId}),{code:'teloa/storage-corrupt'})
})

test('行业公共引用解析为同一个原子固定来源并拒绝引用与字节篡改',async()=>{
 const owner=randomUUID(),market=new MarketContentStore(pool,identity),atomic=await market.import({ownerId:owner,kind:'human'},{kind:'atomic-skill',requestId:randomUUID(),source:{kind:'upload',name:'公共简报'},metadata:{id:'brief',title:'研究简报',version:'1.0.0',categories:[]},files:[file('SKILL.md','---\nname: brief\ndescription: 写简报\n---\n正文')]}),reference={resourceId:'brief',sourceContentId:atomic.content.id,sourceItemId:'atomic-'+atomic.content.hash,sourceResourceId:'brief',sourceHash:atomic.content.hash},saved=await market.import({ownerId:owner,kind:'human'},{kind:'industry-template',requestId:randomUUID(),source:{kind:'upload',name:'公共 Skill 包'},manifestPath:'teloa.json',files:[file('teloa.json',JSON.stringify(manifest({kind:'public',id:'brief',version:'1.0.0'})))],references:[reference]}),loaded=await load(owner,market,saved.content),source=new SkillInstallSource(market,loaded.loads)
 const direct=await source.read(owner,{kind:'atomic',contentId:atomic.content.id}),industry=await source.read(owner,{kind:'industry',loadId:loaded.record.id,itemInstanceId:loaded.item.instanceId})
 assert.equal(industry.source.kind,'industry-public');assert.equal(industry.source.sourceContentId,atomic.content.id);assert.equal(industry.source.sourceContentHash,atomic.content.hash);assert.equal(industry.bundleHash,direct.bundleHash);assert.deepEqual(industry.files,direct.files)
 await pool.query('update teloa_market_files set bytes=$2 where content_id=$1 and path=$3',[atomic.content.id,Buffer.from('篡改'),'SKILL.md']);await assert.rejects(source.read(owner,{kind:'industry',loadId:loaded.record.id,itemInstanceId:loaded.item.instanceId}),{code:'teloa/storage-corrupt'})
})

test('行业本地入口必须精确指向唯一 SKILL.md，不能借同目录另一入口安装',async()=>{
 const owner=randomUUID(),market=new MarketContentStore(pool,identity)
 const wrong=await market.import({ownerId:owner,kind:'human'},{kind:'industry-template',requestId:randomUUID(),source:{kind:'upload',name:'错误入口'},manifestPath:'teloa.json',files:[file('teloa.json',JSON.stringify(manifest({kind:'local',path:'skills/foo.md'}))),file('skills/foo.md','声明文件'),file('skills/SKILL.md','---\nname: wrong\ndescription: 错误入口\n---')],references:[]}),wrongLoad=await load(owner,market,wrong.content),wrongSource=new SkillInstallSource(market,wrongLoad.loads)
 await assert.rejects(wrongSource.read(owner,{kind:'industry',loadId:wrongLoad.record.id,itemInstanceId:wrongLoad.item.instanceId}),{code:'teloa/source-unavailable'})
 const multiple=await market.import({ownerId:owner,kind:'human'},{kind:'industry-template',requestId:randomUUID(),source:{kind:'upload',name:'多入口'},manifestPath:'teloa.json',files:[file('teloa.json',JSON.stringify(manifest({kind:'local',path:'skills/SKILL.md'}))),file('skills/SKILL.md','---\nname: main\ndescription: 主入口\n---'),file('skills/nested/SKILL.md','---\nname: nested\ndescription: 第二入口\n---')],references:[]}),multipleLoad=await load(owner,market,multiple.content),multipleSource=new SkillInstallSource(market,multipleLoad.loads)
 await assert.rejects(multipleSource.read(owner,{kind:'industry',loadId:multipleLoad.record.id,itemInstanceId:multipleLoad.item.instanceId}),{code:'teloa/source-unavailable'})
})

test('已跳过 Skill 不可选择，公共别名同时保留真实原子资源身份',async()=>{
 const owner=randomUUID(),market=new MarketContentStore(pool,identity),atomic=await market.import({ownerId:owner,kind:'human'},{kind:'atomic-skill',requestId:randomUUID(),source:{kind:'upload',name:'真实来源'},metadata:{id:'real-brief',title:'真实简报',version:'2.1.0',categories:[]},files:[file('SKILL.md','---\nname: real-brief\ndescription: 真实简报\n---')]}),publicManifest={...manifest({kind:'public',id:'real-brief',version:'2.1.0'}),resources:[{id:'brief-alias',kind:'skill',title:'行业简报别名',version:'2.1.0',required:true,source:{kind:'public',id:'real-brief',version:'2.1.0'}}],entrypoints:['brief-alias']},reference={resourceId:'brief-alias',sourceContentId:atomic.content.id,sourceItemId:'atomic-'+atomic.content.hash,sourceResourceId:'real-brief',sourceHash:atomic.content.hash},saved=await market.import({ownerId:owner,kind:'human'},{kind:'industry-template',requestId:randomUUID(),source:{kind:'upload',name:'别名包'},manifestPath:'teloa.json',files:[file('teloa.json',JSON.stringify(publicManifest))],references:[reference]}),loaded=await load(owner,market,saved.content),source=new SkillInstallSource(market,loaded.loads),value=await source.read(owner,{kind:'industry',loadId:loaded.record.id,itemInstanceId:loaded.item.instanceId})
 assert.equal(value.source.kind,'industry-public');assert.equal(value.source.resourceId,'brief-alias');assert.equal(value.source.resourceVersion,'2.1.0');assert.equal(value.source.sourceResourceId,'real-brief');assert.equal(value.source.sourceResourceVersion,'2.1.0')
 const optionalManifest={...manifest({kind:'local',path:'missing/SKILL.md'}),resources:[{id:'brief',kind:'skill',title:'可选简报',version:'1.0.0',required:false,source:{kind:'local',path:'missing/SKILL.md'}}]},optional=await market.import({ownerId:owner,kind:'human'},{kind:'industry-template',requestId:randomUUID(),source:{kind:'upload',name:'跳过包'},manifestPath:'teloa.json',files:[file('teloa.json',JSON.stringify(optionalManifest))],references:[]}),optionalLoad=await load(owner,market,optional.content)
 assert.equal(optionalLoad.item.status,'skipped');await assert.rejects(new SkillInstallSource(market,optionalLoad.loads).read(owner,{kind:'industry',loadId:optionalLoad.record.id,itemInstanceId:optionalLoad.item.instanceId}),{code:'teloa/source-unavailable'})
})

for(const first of ['atomic','industry-public'] as const)test(`公共 Skill 首先经 ${first} 安装时，不把方案模型依赖传染给共享安装`,async()=>{
 const owner=randomUUID(),market=new MarketContentStore(pool,identity),loads=new IndustryLoadService(pool,identity,createIndustryLoadSource(market))
 const spaces=new BusinessSpaceService(pool,identity)
 const dependency:IndustryModelDependency={catalogId:'teloa.model.sensevoice',version:'1.0.0',usage:'speech-to-text',required:true}
 const atomic=await market.import({ownerId:owner,kind:'human'},{kind:'atomic-skill',requestId:randomUUID(),source:{kind:'upload',name:'公共简报'},metadata:{id:'brief',title:'研究简报',version:'1.0.0',categories:[]},files:[file('SKILL.md','---\nname: brief\ndescription: 写简报\n---\n正文')]})
 const importScheme=async(id:string,dependencies?:IndustryModelDependency[])=>{
  const raw=manifest({kind:'public',id:'brief',version:'1.0.0'})
  const value={...raw,id,format:'teloa.business-package/v3',resources:raw.resources.map(resource=>({...resource,...(dependencies?{modelDependencies:dependencies}:{})}))}
  const saved=await market.import({ownerId:owner,kind:'human'},{kind:'industry-template',requestId:randomUUID(),source:{kind:'upload',name:id},manifestPath:'teloa.json',files:[file('teloa.json',JSON.stringify(value))],references:[{resourceId:'brief',sourceContentId:atomic.content.id,sourceItemId:'atomic-'+atomic.content.hash,sourceResourceId:'brief',sourceHash:atomic.content.hash}]})
  const personal=await spaces.ensurePersonal(owner)
  return loads.create(owner,{requestId:randomUUID(),contentId:saved.content.id,contentHash:saved.content.hash,target:{kind:'existing',spaceId:personal.id,expectedVersion:personal.version}})
 }
 const required=await importScheme('required-voice',[dependency]),plain=await importScheme('plain-brief')
 let probes=0,published=0
 const source=new SkillInstallSource(market,loads,async()=>{probes++;return 'disabled'})
 const files:SkillInstallationFilesPort={inspect:async()=>({name:'brief',description:'写简报',modelInvocable:true,userInvocable:true,bodyHash:createHash('sha256').update('正文').digest('hex')}),publish:async()=>{published++},verify:async()=>{}}
 const service=new SkillInstallationService(pool,identity,source,files)
 const atomicInput:SkillInstallSourceInput={kind:'atomic',contentId:atomic.content.id},requiredInput:SkillInstallSourceInput={kind:'industry',loadId:required.id,itemInstanceId:required.items[0]!.instanceId},plainInput:SkillInstallSourceInput={kind:'industry',loadId:plain.id,itemInstanceId:plain.items[0]!.instanceId}
 const install=async(input:SkillInstallSourceInput)=>{
  const preview=await service.preview(owner,{source:input})
  return service.install(owner,{requestId:randomUUID(),source:input,expectedBundleHash:preview.bundleHash,expectedTrustHash:preview.trustHash})
 }
 const inputs=first==='atomic'?[atomicInput,requiredInput,plainInput]:[requiredInput,plainInput,atomicInput]
 const installed=[]
 for(const input of inputs)installed.push((await install(input)).installation)
 assert.equal(new Set(installed.map(value=>value.id)).size,1,'公共引用仍复用原子安装，不能因方案入口条件复制正文')
 assert.equal(installed[0]!.source.kind,first,'覆盖首次来源身份为原子或公共方案的两条真实持久路径')
 assert.equal(published,1)
 assert.equal(probes,0,'预览和安装不要求准备模型，也不发起下载')
 const listed=await service.list(owner,{})
 assert.equal(listed.items.length,1)
 assert.deepEqual(listed.usages.map(value=>value.loadId).sort(),[required.id,plain.id].sort())
 for(const installedSource of installed)await source.assertModelsReady(owner,installedSource.source)
 assert.equal(probes,0,'共享原子技能普通调用不继承首个安装方案的模型条件')
 assert.deepEqual((await loads.get(owner,{loadId:required.id})).items[0]!.modelDependencies,[dependency],'当前方案仍保留其必需条件，供该方案执行入口重验')
 assert.equal((await loads.get(owner,{loadId:plain.id})).items[0]!.modelDependencies,undefined)
})

test('包内 Skill 未准备模型也能安装；普通调用按其固定清单阻断并可恢复',async()=>{
 const owner=randomUUID(),market=new MarketContentStore(pool,identity),raw=manifest({kind:'local',path:'skills/brief/SKILL.md'})
 const dependency:IndustryModelDependency={catalogId:'teloa.model.sensevoice',version:'1.0.0',usage:'speech-to-text',required:true}
 const value={...raw,format:'teloa.business-package/v3',resources:raw.resources.map(resource=>({...resource,modelDependencies:[dependency]}))}
 const saved=await market.import({ownerId:owner,kind:'human'},{kind:'industry-template',requestId:randomUUID(),source:{kind:'upload',name:'本地语音简报'},manifestPath:'teloa.json',files:[file('teloa.json',JSON.stringify(value)),file('skills/brief/SKILL.md','---\nname: brief\ndescription: 写简报\n---\n正文')],references:[]}),loaded=await load(owner,market,saved.content)
 let probes=0,phase:IndustryModelPhase='disabled'
 const source=new SkillInstallSource(market,loaded.loads,async fixed=>{assert.deepEqual(fixed,dependency);probes++;return phase}),input:SkillInstallSourceInput={kind:'industry',loadId:loaded.record.id,itemInstanceId:loaded.item.instanceId}
 const files:SkillInstallationFilesPort={inspect:async()=>({name:'brief',description:'写简报',modelInvocable:true,userInvocable:true,bodyHash:createHash('sha256').update('正文').digest('hex')}),publish:async()=>{},verify:async()=>{}}
 const service=new SkillInstallationService(pool,identity,source,files),preview=await service.preview(owner,{source:input})
 const installed=await service.install(owner,{requestId:randomUUID(),source:input,expectedBundleHash:preview.bundleHash,expectedTrustHash:preview.trustHash})
 assert.equal(installed.installation.state,'installed')
 assert.equal(probes,0)
 await assert.rejects(source.assertModelsReady(owner,installed.installation.source),{code:'teloa/dependency-unavailable'})
 assert.equal(probes,1)
 phase='ready'
 await source.assertModelsReady(owner,installed.installation.source)
 assert.equal(probes,2)
 assert.equal((await service.get(owner,{installationId:installed.installation.id})).version,installed.installation.version,'模型准备状态不改写技能安装身份或版本')
})

import test,{after,before,beforeEach} from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from './postgres-test-lifecycle.ts'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {WorkError} from '@teloa/contract'
import {initializeSkillInstallations,SkillInstallationService,type NativeSkillMetadata,type SkillInstallationFilesPort} from '../src/market/skill-installations.ts'
import type {SkillInstallSourceBundle,SkillInstallSourceIdentity,SkillInstallSourceInput} from '../src/market/skill-install-source.ts'
import {SkillAvailabilityService} from '../src/market/skill-availability.ts'
import {SkillSelectionService} from '../src/market/skill-selection-changes.ts'
import {marketTrustHash,normalizeMarketSourceTrust} from '../src/market/content-store.ts'

let container:StartedPostgreSqlContainer,pool:Pool
const at='2026-09-12T21:00:00.000Z',identity={id:randomUUID,now:()=>at},hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex'),encoder=new TextEncoder()
class Reader{
 owner='';values=new Map<string,SkillInstallSourceBundle>()
 async read(owner:string,input:SkillInstallSourceInput){if(owner!==this.owner)throw new WorkError('teloa/forbidden','owner');const value=this.values.get(JSON.stringify(input));if(!value)throw new WorkError('teloa/source-unavailable','missing');return structuredClone(value)}
}
class Files implements SkillInstallationFilesPort{async remove(){}
 metadata=new Map<string,NativeSkillMetadata>()
 async inspect(bundle:SkillInstallSourceBundle){const value=this.metadata.get(bundle.bundleHash);if(!value)throw new WorkError('teloa/source-unavailable','metadata');return value}
 async publish(){}
 async verify(){}
}
const source=(contentId:string,version:string):SkillInstallSourceIdentity=>({kind:'atomic',contentId,contentHash:hash('content-'+version),resourceId:'research-brief',resourceVersion:version})
function bundle(ownerId:string,fixed:SkillInstallSourceIdentity,version:string){const bytes=encoder.encode(`---\nname: research-brief\ndescription: 研究 ${version}\n---\n正文 ${version}`),file={path:'SKILL.md',hash:hash(bytes),bytes},bundleHash=hash(JSON.stringify([[file.path,file.hash]]));return {value:{ownerId,source:fixed,entryPath:'SKILL.md' as const,files:[file],bundleHash},metadata:{name:'research-brief',description:'研究 '+version,modelInvocable:true,userInvocable:true,bodyHash:hash('正文 '+version)}}}
before(async()=>{process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock');process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock';container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()});await initializeSkillInstallations(pool)},{timeout:180_000})
beforeEach(async()=>{await pool.query('truncate teloa_skill_selection_requests,teloa_skill_install_maintenance_requests,teloa_skill_install_availability,teloa_skill_install_usages,teloa_skill_install_requests,teloa_skill_selections,teloa_skill_installations')})
after(async()=>{await pool?.end();await container?.stop()})

test('同文件但信任发布者变化时保留两份安装，本人选择新来源不迁移旧加载引用',async()=>{
 const owner=randomUUID(),reader=new Reader(),files=new Files();reader.owner=owner
 const old={kind:'industry' as const,loadId:randomUUID(),itemInstanceId:randomUUID()},next={kind:'industry' as const,loadId:randomUUID(),itemInstanceId:randomUUID()}
 const fixed=(input:typeof old)=>({kind:'industry-local' as const,loadId:input.loadId,itemInstanceId:input.itemInstanceId,contentId:randomUUID(),contentHash:hash(input.loadId),resourceId:'research-brief',resourceVersion:'1.0.0'})
 const oldBundle=bundle(owner,fixed(old),'1.0.0'),nextBundle={...oldBundle.value,source:fixed(next)}
 const trust=(publisher:string)=>normalizeMarketSourceTrust({publisher,repository:null,license:{status:'declared',value:'MIT'},signature:{status:'unverified',signer:null},compatibility:{teloa:'未声明',dsh:'未声明'},plugins:[],externalCapabilities:[],permissions:[],review:{conclusion:'needs-review',summary:'本人导入，未完成兼容性核对'}})
 const beforeTrust=trust('SOC 1.3.0 导入'),afterTrust=trust('SOC 1.3.1 导入')
 reader.values.set(JSON.stringify(old),{...oldBundle.value,trust:beforeTrust,trustHash:marketTrustHash(beforeTrust)})
 reader.values.set(JSON.stringify(next),{...nextBundle,trust:afterTrust,trustHash:marketTrustHash(afterTrust)})
 files.metadata.set(oldBundle.value.bundleHash,oldBundle.metadata)
 const installs=new SkillInstallationService(pool,identity,reader,files),service=new SkillSelectionService(pool,identity)
 const first=(await installs.install(owner,{requestId:randomUUID(),source:old,expectedBundleHash:oldBundle.value.bundleHash,expectedTrustHash:marketTrustHash(beforeTrust)})).installation
 const target=(await installs.install(owner,{requestId:randomUUID(),source:next,expectedBundleHash:oldBundle.value.bundleHash,expectedTrustHash:marketTrustHash(afterTrust)})).installation
 assert.notEqual(first.id,target.id)
 assert.equal(first.bundleHash,target.bundleHash)
 assert.notEqual(first.trustHash,target.trustHash)
 assert.equal((await service.get(owner,{nativeName:first.native.name})).installationId,first.id,'新来源安装不会自动改本人当前选择')
 const preview=await service.preview(owner,{currentInstallationId:first.id,targetInstallationId:target.id})
 assert.deepEqual(preview.impact.industryUsages,[{loadId:old.loadId,itemInstanceId:old.itemInstanceId}])
 const command={requestId:randomUUID(),nativeName:first.native.name,currentInstallationId:first.id,targetInstallationId:target.id,expectedSelectionVersion:preview.selection.version,expectedCurrentBundleHash:first.bundleHash,expectedTargetBundleHash:target.bundleHash,expectedImpactDigest:preview.impactDigest,industryUsages:[]}
 const selected=await service.change(owner,command)
 assert.equal(selected.current.installationId,target.id)
 assert.deepEqual(selected.receipt.migratedIndustryUsages,[])
 const directory=await installs.list(owner,{})
 assert.equal(directory.items.length,2)
 assert.equal(directory.usages.find(use=>use.loadId===old.loadId)?.installationId,first.id)
 assert.equal(directory.usages.find(use=>use.loadId===next.loadId)?.installationId,target.id)
 assert.deepEqual(await installs.get(owner,{installationId:first.id}),first,'原安装与可信固定记录完整保留')
 assert.deepEqual((await new SkillAvailabilityService(pool,identity).selectedDirectory(owner)).map(row=>row.installation.id),[target.id],'原生默认目录读取本人刚确认的新安装')
 assert.deepEqual(await service.change(owner,command),selected,'未知回包恢复同一请求，不重复推进选择版本')
})

async function fixture(){
 const owner=randomUUID(),reader=new Reader(),files=new Files();reader.owner=owner
 const oldId=randomUUID(),targetId=randomUUID(),thirdId=randomUUID(),oldInput={kind:'atomic' as const,contentId:oldId},targetInput={kind:'atomic' as const,contentId:targetId},thirdInput={kind:'atomic' as const,contentId:thirdId},old=source(oldId,'1.0.0'),target=source(targetId,'2.0.0'),third=source(thirdId,'3.0.0'),oldBundle=bundle(owner,old,'1.0.0'),targetBundle=bundle(owner,target,'2.0.0'),thirdBundle=bundle(owner,third,'3.0.0')
 for(const [input,value] of [[oldInput,oldBundle],[targetInput,targetBundle],[thirdInput,thirdBundle]] as const){reader.values.set(JSON.stringify(input),value.value);files.metadata.set(value.value.bundleHash,value.metadata)}
 const installs=new SkillInstallationService(pool,identity,reader,files),current=(await installs.install(owner,{requestId:randomUUID(),source:oldInput,expectedBundleHash:oldBundle.value.bundleHash})).installation
 const usages=[] as {loadId:string;itemInstanceId:string}[]
 for(const alias of ['a','b']){const loadId=randomUUID(),itemInstanceId=randomUUID(),input={kind:'industry' as const,loadId,itemInstanceId},fixed={kind:'industry-public' as const,loadId,itemInstanceId,contentId:randomUUID(),contentHash:hash('alias-'+alias),sourceContentId:old.contentId,sourceContentHash:old.contentHash,sourceResourceId:old.resourceId,sourceResourceVersion:old.resourceVersion,resourceId:'alias-'+alias,resourceVersion:'1.0.0'};reader.values.set(JSON.stringify(input),{...oldBundle.value,source:fixed});await installs.install(owner,{requestId:randomUUID(),source:input,expectedBundleHash:oldBundle.value.bundleHash});usages.push({loadId,itemInstanceId})}
 const targetInstallation=(await installs.install(owner,{requestId:randomUUID(),source:targetInput,expectedBundleHash:targetBundle.value.bundleHash})).installation,thirdInstallation=(await installs.install(owner,{requestId:randomUUID(),source:thirdInput,expectedBundleHash:thirdBundle.value.bundleHash})).installation
 return {owner,reader,files,installs,current,target:targetInstallation,third:thirdInstallation,usages,targetBundle,oldBundle}
}
function command(f:Awaited<ReturnType<typeof fixture>>,preview:Awaited<ReturnType<SkillSelectionService['preview']>>,industryUsages=preview.impact.industryUsages){return {requestId:randomUUID(),nativeName:'research-brief',currentInstallationId:f.current.id,targetInstallationId:f.target.id,expectedSelectionVersion:preview.selection.version,expectedCurrentBundleHash:f.current.bundleHash,expectedTargetBundleHash:f.target.bundleHash,expectedImpactDigest:preview.impactDigest,industryUsages}}

test('全局切换与行业逐项迁移彼此独立，回执重放不改写后续当前状态',async()=>{
 const f=await fixture(),service=new SkillSelectionService(pool,identity),preview=await service.preview(f.owner,{currentInstallationId:f.current.id,targetInstallationId:f.target.id})
 assert.equal(preview.selection.installationId,f.current.id);assert.deepEqual(preview.impact.industryUsages,f.usages.sort((a,b)=>(a.loadId+':'+a.itemInstanceId).localeCompare(b.loadId+':'+b.itemInstanceId)))
 const migrated=[preview.impact.industryUsages[0]!],input=command(f,preview,migrated),changed=await service.change(f.owner,input)
 assert.equal(changed.current.installationId,f.target.id);assert.equal(changed.current.version,2);assert.deepEqual(changed.receipt.migratedIndustryUsages,migrated)
 const rows=(await pool.query('select load_id,item_instance_id,installation_id from teloa_skill_install_usages where owner_id=$1 order by load_id,item_instance_id',[f.owner])).rows
 assert.equal(rows.find(row=>row.load_id===migrated[0]!.loadId)?.installation_id,f.target.id);assert.equal(rows.find(row=>row.installation_id===f.current.id)?.item_instance_id,preview.impact.industryUsages[1]!.itemInstanceId)
 const selected=await new SkillAvailabilityService(pool,identity).selectedDirectory(f.owner);assert.deepEqual(selected.map(item=>[item.installation.id,item.selectionVersion]),[[f.target.id,2]])
 const secondPreview=await service.preview(f.owner,{currentInstallationId:f.target.id,targetInstallationId:f.third.id}),second=await service.change(f.owner,{...command({...f,current:f.target,target:f.third},secondPreview,[]),requestId:randomUUID()});assert.equal(second.current.version,3)
 const replay=await service.change(f.owner,input);assert.equal(replay.receipt.result.version,2);assert.equal(replay.current.version,3);assert.equal(replay.current.installationId,f.third.id)
})

test('影响变化、停用目标与同请求换参数均拒绝且不留下半次迁移',async()=>{
 const f=await fixture(),service=new SkillSelectionService(pool,identity),preview=await service.preview(f.owner,{currentInstallationId:f.current.id,targetInstallationId:f.target.id}),input=command(f,preview,[preview.impact.industryUsages[0]!])
 const extraLoad=randomUUID(),extraItem=randomUUID(),industry={kind:'industry' as const,loadId:extraLoad,itemInstanceId:extraItem},old=f.oldBundle.value.source as Extract<SkillInstallSourceIdentity,{kind:'atomic'}>,alias={kind:'industry-public' as const,loadId:extraLoad,itemInstanceId:extraItem,contentId:randomUUID(),contentHash:hash('late'),sourceContentId:old.contentId,sourceContentHash:old.contentHash,sourceResourceId:old.resourceId,sourceResourceVersion:old.resourceVersion,resourceId:'late',resourceVersion:'1.0.0'};f.reader.values.set(JSON.stringify(industry),{...f.oldBundle.value,source:alias});await f.installs.install(f.owner,{requestId:randomUUID(),source:industry,expectedBundleHash:f.oldBundle.value.bundleHash})
 await assert.rejects(service.change(f.owner,input),{code:'teloa/version-conflict'});assert.equal((await service.get(f.owner,{nativeName:'research-brief'})).installationId,f.current.id)
 const fresh=await service.preview(f.owner,{currentInstallationId:f.current.id,targetInstallationId:f.target.id});await pool.query("update teloa_skill_install_availability set availability='disabled',version=version+1 where installation_id=$1",[f.target.id])
 await assert.rejects(service.change(f.owner,command(f,fresh,[])),{code:'teloa/conflict'});assert.equal((await service.get(f.owner,{nativeName:'research-brief'})).installationId,f.current.id)
 await pool.query("update teloa_skill_install_availability set availability='enabled',version=version+1 where installation_id=$1",[f.target.id])
 const finalPreview=await service.preview(f.owner,{currentInstallationId:f.current.id,targetInstallationId:f.target.id}),finalInput=command(f,finalPreview,[]);await service.change(f.owner,finalInput);await assert.rejects(service.change(f.owner,{...finalInput,targetInstallationId:f.third.id,expectedTargetBundleHash:f.third.bundleHash}),{code:'teloa/conflict'})
})

test('并发切换只有一个当前版本获胜，另一请求按选择版本冲突退出',async()=>{
 const f=await fixture(),a=new SkillSelectionService(pool,identity),b=new SkillSelectionService(pool,identity),toSecond=await a.preview(f.owner,{currentInstallationId:f.current.id,targetInstallationId:f.target.id}),toThird=await b.preview(f.owner,{currentInstallationId:f.current.id,targetInstallationId:f.third.id}),base={requestId:randomUUID(),nativeName:'research-brief',currentInstallationId:f.current.id,expectedSelectionVersion:1,expectedCurrentBundleHash:f.current.bundleHash,industryUsages:[]}
 const results=await Promise.allSettled([a.change(f.owner,{...base,targetInstallationId:f.target.id,expectedTargetBundleHash:f.target.bundleHash,expectedImpactDigest:toSecond.impactDigest}),b.change(f.owner,{...base,requestId:randomUUID(),targetInstallationId:f.third.id,expectedTargetBundleHash:f.third.bundleHash,expectedImpactDigest:toThird.impactDigest})])
 assert.equal(results.filter(result=>result.status==='fulfilled').length,1);const rejected=results.find(result=>result.status==='rejected');assert.equal((rejected as PromiseRejectedResult).reason.code,'teloa/version-conflict');assert.ok([f.target.id,f.third.id].includes((await a.get(f.owner,{nativeName:'research-brief'})).installationId))
 await assert.rejects(a.preview(randomUUID(),{currentInstallationId:f.current.id,targetInstallationId:f.target.id}),{code:'teloa/forbidden'})
})

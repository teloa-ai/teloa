import test,{after,before} from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {WorkError} from '@teloa/contract'
import {initializeMarketContents,MarketContentStore} from '../src/market/content-store.ts'
import {SkillInstallSource,type SkillInstallSourceBundle} from '../src/market/skill-install-source.ts'
import type {NativeSkillMetadata,SkillInstallation,SkillInstallationFilesPort} from '../src/market/skill-installations.ts'
import type {SkillAvailabilityPreview} from '../src/market/skill-availability.ts'
import {SkillUpgradePreviewService} from '../src/market/skill-upgrade-preview.ts'

let container:StartedPostgreSqlContainer,pool:Pool
const enc=new TextEncoder(),hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex'),identity={id:randomUUID,now:()=>new Date('2026-09-12T18:00:00.000Z').toISOString()}
const file=(path:string,text:string)=>({path,bytes:enc.encode(text)})

class Files implements SkillInstallationFilesPort{
 readonly verified:string[]=[]
 readonly metadata=new Map<string,NativeSkillMetadata>()
 failVerify=false
 async inspect(bundle:SkillInstallSourceBundle){const value=this.metadata.get(bundle.bundleHash);if(!value)throw new WorkError('teloa/source-unavailable','missing native');return value}
 async publish(){}
 async verify(id:string){this.verified.push(id);if(this.failVerify)throw new WorkError('teloa/storage-corrupt','tampered files')}
}

before(async()=>{process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock');process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock';container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()});await initializeMarketContents(pool)},{timeout:180_000})
after(async()=>{await pool?.end();await container?.stop()})

async function fixture(state:'installed'|'preparing'='installed',availability:'enabled'|'disabled'='enabled'){
 const owner=randomUUID(),market=new MarketContentStore(pool,identity)
 const old=await market.import({ownerId:owner,kind:'human'},{kind:'atomic-skill',requestId:randomUUID(),source:{kind:'upload',name:'旧版'},metadata:{id:'research-brief',title:'研究简报',version:'1.0.0',categories:[]},files:[file('skill/SKILL.md','---\nname: research-brief\ndescription: 研究\n---\n旧正文'),file('skill/common.txt','相同'),file('skill/removed.txt','删除')]})
 const target=await market.import({ownerId:owner,kind:'human'},{kind:'atomic-skill',requestId:randomUUID(),source:{kind:'upload',name:'新版'},metadata:{id:'research-brief',title:'研究简报',version:'2.0.0',categories:[]},files:[file('skill/SKILL.md','---\nname: research-brief\ndescription: 研究\n---\n新正文'),file('skill/added.txt','新增'),file('skill/common.txt','相同')]})
 const source=new SkillInstallSource(market,{get:async()=>{throw new WorkError('teloa/source-unavailable','industry unavailable')}}),oldBundle=await source.read(owner,{kind:'atomic',contentId:old.content.id}),targetBundle=await source.read(owner,{kind:'atomic',contentId:target.content.id}),files=new Files(),installation:SkillInstallation={id:randomUUID(),ownerId:owner,source:oldBundle.source,bundleHash:oldBundle.bundleHash,native:{name:'research-brief',description:'研究',modelInvocable:true,userInvocable:true,bodyHash:hash('旧正文')},state,version:2,createdAt:identity.now(),updatedAt:identity.now()}
 files.metadata.set(targetBundle.bundleHash,{name:'research-brief',description:'研究',modelInvocable:true,userInvocable:true,bodyHash:hash('新正文')})
 const preview:SkillAvailabilityPreview={installation,availability:{installationId:installation.id,ownerId:owner,availability,version:availability==='enabled'?1:2,updatedAt:identity.now()},impact:{installation:{id:installation.id,version:2,bundleHash:installation.bundleHash,nativeName:installation.native.name},availability:{value:availability,version:availability==='enabled'?1:2},industryUsages:[],roles:[],plans:[],tasks:[],runs:[],ordinarySessions:{status:'unknown'}},impactDigest:hash('impact'),blockers:state==='installed'?[]:['installation-not-installed']}
 let availabilityCalls=0
 const availabilityPort={preview:async(requestOwner:string,input:unknown)=>{availabilityCalls++;if(requestOwner!==owner)throw new WorkError('teloa/forbidden','wrong owner');assert.deepEqual(input,{installationId:installation.id});return structuredClone(preview)}}
 return {owner,market,source,old,target,oldBundle,targetBundle,files,installation,availabilityPort,get availabilityCalls(){return availabilityCalls}}
}

test('以真实固定来源生成完整有序文件差异，停用状态仍可预览',async()=>{
 const f=await fixture('installed','disabled'),service=new SkillUpgradePreviewService(f.availabilityPort,f.source,f.files),value=await service.preview(f.owner,{installationId:f.installation.id,target:{kind:'atomic',contentId:f.target.content.id}})
 assert.equal(value.current.availability.availability,'disabled');assert.equal(value.target.bundleHash,f.targetBundle.bundleHash);assert.equal(value.sameResourceId,true);assert.deepEqual(value.blockers,[])
 assert.deepEqual(value.files.map(item=>[item.path,item.change]),[['SKILL.md','modified'],['added.txt','added'],['common.txt','unchanged'],['removed.txt','removed']])
 assert.deepEqual(value.files[0],{path:'SKILL.md',change:'modified',before:{hash:f.oldBundle.files[0]!.hash,size:f.oldBundle.files[0]!.bytes.byteLength},after:{hash:f.targetBundle.files[0]!.hash,size:f.targetBundle.files[0]!.bytes.byteLength}})
 assert.deepEqual(f.files.verified,[f.installation.id])
})

test('preparing 安装只返回稳定阻断项，不验证尚未发布的目录',async()=>{
 const f=await fixture('preparing'),metadata={...f.installation.native,name:'other-skill'};f.files.metadata.set(f.oldBundle.bundleHash,metadata)
 const service=new SkillUpgradePreviewService(f.availabilityPort,f.source,f.files),value=await service.preview(f.owner,{installationId:f.installation.id,target:{kind:'atomic',contentId:f.old.content.id}})
 assert.deepEqual(value.blockers,['installation-not-installed','same-source','native-name-mismatch']);assert.deepEqual(f.files.verified,[])
 assert.ok(value.files.every(item=>item.change==='unchanged'))
})

test('跨本人访问在读取来源前拒绝，固定来源字节篡改不会降级成差异',async()=>{
 const f=await fixture(),reads:{count:number}={count:0},reader={read:async(owner:string,input:Parameters<SkillInstallSource['read']>[1])=>{reads.count++;return f.source.read(owner,input)}}
 const service=new SkillUpgradePreviewService(f.availabilityPort,reader,f.files)
 await assert.rejects(service.preview(randomUUID(),{installationId:f.installation.id,target:{kind:'atomic',contentId:f.target.content.id}}),{code:'teloa/forbidden'});assert.equal(reads.count,0)
 await pool.query('update teloa_market_files set bytes=$2 where content_id=$1 and path=$3',[f.old.content.id,Buffer.from('篡改'),'skill/SKILL.md'])
 await assert.rejects(service.preview(f.owner,{installationId:f.installation.id,target:{kind:'atomic',contentId:f.target.content.id}}),{code:'teloa/storage-corrupt'});assert.deepEqual(f.files.verified,[])
})

test('已安装目录的实际文件核验失败时停止预览',async()=>{
 const f=await fixture();f.files.failVerify=true
 await assert.rejects(new SkillUpgradePreviewService(f.availabilityPort,f.source,f.files).preview(f.owner,{installationId:f.installation.id,target:{kind:'atomic',contentId:f.target.content.id}}),{code:'teloa/storage-corrupt'})
 assert.deepEqual(f.files.verified,[f.installation.id])
})

test('行业公共别名按真实 sourceResourceId 判断同资源和同固定来源',async()=>{
 const f=await fixture(),publicSource={kind:'industry-public' as const,loadId:randomUUID(),itemInstanceId:randomUUID(),contentId:randomUUID(),contentHash:hash('industry'),sourceContentId:f.oldBundle.source.contentId,sourceContentHash:f.oldBundle.source.contentHash,sourceResourceId:f.oldBundle.source.resourceId,sourceResourceVersion:f.oldBundle.source.resourceVersion,resourceId:'industry-alias',resourceVersion:'1.0.0'},publicBundle={...f.oldBundle,source:publicSource},installation={...f.installation,source:publicSource},current={...(await f.availabilityPort.preview(f.owner,{installationId:f.installation.id})),installation},availability={preview:async()=>structuredClone(current)},reader={read:async(_owner:string,input:{kind:string})=>input.kind==='industry'?structuredClone(publicBundle):structuredClone(f.oldBundle)}
 f.files.metadata.set(f.oldBundle.bundleHash,f.installation.native)
 const value=await new SkillUpgradePreviewService(availability,reader,f.files).preview(f.owner,{installationId:f.installation.id,target:{kind:'atomic',contentId:f.old.content.id}})
 assert.equal(value.sameResourceId,true);assert.deepEqual(value.blockers,['same-source'])
})

test('目标读取结果必须对应请求中的原子或行业身份',async()=>{
 const f=await fixture();f.files.metadata.set(f.oldBundle.bundleHash,f.installation.native)
 const wrongAtomic={read:async()=>structuredClone(f.oldBundle)},atomicService=new SkillUpgradePreviewService(f.availabilityPort,wrongAtomic,f.files)
 await assert.rejects(atomicService.preview(f.owner,{installationId:f.installation.id,target:{kind:'atomic',contentId:f.target.content.id}}),{code:'teloa/source-unavailable'})

 const loadId=randomUUID(),itemInstanceId=randomUUID(),wrongIndustry={read:async(_owner:string,input:{kind:string})=>input.kind==='atomic'?structuredClone(f.oldBundle):structuredClone(f.targetBundle)},industryService=new SkillUpgradePreviewService(f.availabilityPort,wrongIndustry,f.files)
 await assert.rejects(industryService.preview(f.owner,{installationId:f.installation.id,target:{kind:'industry',loadId,itemInstanceId}}),{code:'teloa/source-unavailable'})
})

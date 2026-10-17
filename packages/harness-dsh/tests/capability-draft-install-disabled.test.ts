import test,{after,before,beforeEach} from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {createRequire} from 'node:module'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {WorkError,type PageCreateDraft} from '@teloa/contract'
import {SkillInstallationService,SkillAvailabilityService,initializeSkillInstallations,initializeRoles,initializePlans,initializeTasks,initializeObjectConversations,initializeTaskRuns,type NativeSkillMetadata,type SkillInstallSourceBundle} from '@teloa/backend'
import {createCapabilityDraftApplication,type CapabilityDraftApplicationPorts} from '../src/capability-draft-tools.ts'
import {createSkillInstallationsHandler} from '../src/skill-installations.ts'
import {createSkillAvailabilityHandler} from '../src/skill-availability.ts'

// NL-03：真实 Postgres + 真实安装/启停服务 + 真实宿主处理器；只把市场导入、来源读取与原生文件替换为隔离桩。
// harness 包不直接依赖 pg；沿用既有生产用例从 backend 解析同一驱动。
type DbPool=ConstructorParameters<typeof SkillInstallationService>[0]
const {Pool}=createRequire(new URL('../../backend/package.json',import.meta.url))('pg') as {Pool:new(config:{connectionString:string})=>DbPool}
let container:StartedPostgreSqlContainer,pool:DbPool
const owner='local:teloa-owner',now='2026-10-15T00:00:00.000Z',sha=(s:string)=>createHash('sha256').update(s).digest('hex')
const native:NativeSkillMetadata={name:'meeting-notes',description:'整理会议纪要',modelInvocable:true,userInvocable:true,bodyHash:sha('body')}
const skill={id:'meeting-notes',title:'会议纪要',version:'1.0.0',categories:[],files:[{path:'SKILL.md',base64:Buffer.from('---\nname: meeting-notes\ndescription: 整理会议纪要\n---\n整理。\n').toString('base64')}]}
before(async()=>{process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock');process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock';container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()});await initializeRoles(pool);await initializePlans(pool);await initializeTasks(pool);await initializeObjectConversations(pool);await initializeTaskRuns(pool);await initializeSkillInstallations(pool)},{timeout:180_000})
after(async()=>{await pool?.end();await container?.stop()})
beforeEach(async()=>{await pool.query('truncate teloa_skill_selection_requests,teloa_skill_install_maintenance_requests,teloa_skill_install_availability,teloa_skill_install_usages,teloa_skill_install_requests,teloa_skill_selections,teloa_skill_installations cascade')})

function setup(){
 const contentId=randomUUID(),bundleHash=sha('bundle'),source={kind:'atomic' as const,contentId,contentHash:sha('content'),resourceId:'meeting-notes',resourceVersion:'1.0.0'}
 const bundle:SkillInstallSourceBundle={ownerId:owner,source,entryPath:'SKILL.md',files:[{path:'SKILL.md',hash:sha('skill'),bytes:new TextEncoder().encode('skill')}],bundleHash}
 // 发布文件时（原生可见之前）记录当时的启停值：未启用必须从这一刻起就是 disabled。
 const atPublish:string[]=[]
 const files={inspect:async()=>native,publish:async(id:string)=>{atPublish.push((await pool.query('select availability from teloa_skill_install_availability where installation_id=$1',[id])).rows[0]?.availability)},verify:async()=>{}}
 const installations=new SkillInstallationService(pool,{id:randomUUID,now:()=>now},{read:async(who,input)=>{if(who!==owner||input.kind!=='atomic'||input.contentId!==contentId)throw new WorkError('teloa/source-unavailable','missing');return structuredClone(bundle)}},files)
 // 启用核验固定来源由文件端口负责，这里沿用同一隔离桩。
 const availability=new SkillAvailabilityService(pool,{now:()=>now},{verify:async()=>{}})
 const availabilityHandler=createSkillAvailabilityHandler(owner,async()=>availability)
 const skills=createSkillInstallationsHandler(owner,async()=>installations,async id=>{const value=await availability.get(owner,{installationId:id});return value.availability==='disabled'?{installationId:id,scope:'default-workspace',state:'disabled',current:null}:{installationId:id,scope:'default-workspace',state:'available',current:{...native,provider:'filesystem',source:'custom'}}})
 const unavailable=async()=>{throw Error('unrelated handler must not run')}
 const drafts=new Map<string,PageCreateDraft>(),applyInputs:unknown[]=[]
 const newDraft=()=>{const id=randomUUID(),draft:PageCreateDraft={id,ownerId:owner,requestId:id,entity:'skill',body:JSON.stringify(skill),bodyHash:sha(id),title:'会议纪要',status:'draft',createdAt:now,updatedAt:now};drafts.set(id,draft);return draft}
 const ports:CapabilityDraftApplicationPorts={owner,scopeIds:async()=>[],services:async()=>({drafts:{read:async(_actor,input)=>drafts.get((input as {draftId:string}).draftId)!,apply:async(_actor,input,write)=>{applyInputs.push(input);const id=(input as {draftId:string}).draftId;let saved=drafts.get(id)!;if(saved.status==='draft'){saved={...saved,status:'applied',appliedRef:await write(saved)};drafts.set(id,saved)}return saved}},preview:{preview:unavailable as never}}),
  marketContentHandler:async()=>({receipt:{},content:{id:contentId,ownerId:owner,hash:source.contentHash}}),skillInstallationsHandler:skills,skillAvailabilityHandler:availabilityHandler,businessSpaceHandler:unavailable,industryLoadsHandler:unavailable,industryMcpConnectionHandler:unavailable,industryDataSourceHandler:unavailable,marketPluginInstallationHandler:unavailable}
 return {app:createCapabilityDraftApplication(ports),installations,availability,availabilityHandler,newDraft,atPublish,applyInputs,contentId,bundleHash}
}
const current=async(availability:SkillAvailabilityService,ref:string)=>(await availability.get(owner,{installationId:ref.slice(6)})).availability

test('NL-03 本人要求「只安装暂不启用」：安装之初即未启用，回执如实读回 disabled',async()=>{
 const {app,availability,newDraft,atPublish,applyInputs}=setup(),draft=newDraft()
 const result=await app.apply({draftId:draft.id,expectedBodyHash:draft.bodyHash,initialAvailability:'disabled'})
 assert.equal(await current(availability,result.appliedRef),'disabled','真实启停记录')
 assert.deepEqual(atPublish,['disabled'],'文件发布、原生可见之前已是 disabled，没有先启用再停用的窗口')
 assert.equal(result.availability,'disabled');assert.equal(result.readiness,'installed-disabled');assert.match(result.next,/未启用/)
 assert.deepEqual(applyInputs,[{draftId:draft.id,expectedBodyHash:draft.bodyHash}],'草案服务只收固定身份与摘要')
})

test('缺省调用保持兼容：安装即启用，回执读回 enabled',async()=>{
 const {app,availability,newDraft}=setup(),draft=newDraft()
 const result=await app.apply({draftId:draft.id,expectedBodyHash:draft.bodyHash})
 assert.equal(await current(availability,result.appliedRef),'enabled');assert.equal(result.availability,'enabled');assert.equal(result.readiness,'installed')
})

test('同请求重试保持原决定，不覆盖本人之后的启停',async()=>{
 const {app,availability,availabilityHandler,newDraft}=setup(),draft=newDraft()
 const first=await app.apply({draftId:draft.id,expectedBodyHash:draft.bodyHash,initialAvailability:'disabled'})
 // 重试（含模型改传 enabled）复用原回执，不改变启停
 const retried=await app.apply({draftId:draft.id,expectedBodyHash:draft.bodyHash,initialAvailability:'enabled'})
 assert.equal(retried.appliedRef,first.appliedRef);assert.equal(retried.availability,'disabled');assert.match(retried.next,/未改动/)
 // 本人随后经既有启停工具（保留 version/impact 守护）启用
 const installationId=first.appliedRef.slice(6),preview=await availabilityHandler('skill-availability/preview',{installationId}) as {availability:{version:number};impactDigest:string;installation:{bundleHash:string}}
 await availabilityHandler('skill-availability/change',{requestId:randomUUID(),installationId,expectedVersion:preview.availability.version,expectedBundleHash:preview.installation.bundleHash,expectedImpactDigest:preview.impactDigest,action:'enable'})
 const later=await app.apply({draftId:draft.id,expectedBodyHash:draft.bodyHash,initialAvailability:'disabled'})
 assert.equal(await current(availability,first.appliedRef),'enabled','重试不把本人后来的启用改回停用');assert.equal(later.availability,'enabled')
})

test('同一安装请求身份不能改投另一初始启停；等价已装且已启用的技能不被误停',async()=>{
 const {installations,availability,contentId,bundleHash}=setup(),source={kind:'atomic' as const,contentId},requestId=randomUUID()
 const used=await installations.install(owner,{requestId,source,expectedBundleHash:bundleHash})
 assert.equal((await availability.get(owner,{installationId:used.installation.id})).availability,'enabled')
 await assert.rejects(installations.install(owner,{requestId,source,expectedBundleHash:bundleHash,initialAvailability:'disabled'}),{code:'teloa/conflict'})
 const again=await installations.install(owner,{requestId:randomUUID(),source,expectedBundleHash:bundleHash,initialAvailability:'disabled'})
 assert.equal(again.installation.id,used.installation.id,'同来源复用原安装')
 assert.equal((await availability.get(owner,{installationId:used.installation.id})).availability,'enabled','不停用别人已在用的安装')
 await assert.rejects(installations.install(owner,{requestId:randomUUID(),source,expectedBundleHash:bundleHash,initialAvailability:'paused'}),{code:'teloa/invalid-input'})
})

test('已停用的同来源再次「只安装不启用」可复用且保持停用；未声明不启用时仍按原规则拒绝',async()=>{
 const {installations,availability,contentId,bundleHash}=setup(),source={kind:'atomic' as const,contentId}
 const first=await installations.install(owner,{requestId:randomUUID(),source,expectedBundleHash:bundleHash,initialAvailability:'disabled'})
 const again=await installations.install(owner,{requestId:randomUUID(),source,expectedBundleHash:bundleHash,initialAvailability:'disabled'})
 assert.equal(again.installation.id,first.installation.id);assert.equal((await availability.get(owner,{installationId:first.installation.id})).availability,'disabled')
 await assert.rejects(installations.install(owner,{requestId:randomUUID(),source,expectedBundleHash:bundleHash}),{code:'teloa/conflict'})
})

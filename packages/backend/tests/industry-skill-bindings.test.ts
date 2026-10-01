import test,{after,before} from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {WorkError,type IndustryModelDependency,type IndustryModelPhase,type IndustryModelProbe} from '@teloa/contract'
import {MarketContentStore,initializeMarketContents} from '../src/market/content-store.ts'
import {IndustryLoadService,initializeIndustryLoads} from '../src/work/industry-loads.ts'
import {createIndustryLoadSource} from '../src/work/industry-load-source.ts'
import {IndustryRoleSource} from '../src/work/industry-role-source.ts'
import {IndustryRoleService,initializeIndustryRoles} from '../src/work/industry-roles.ts'
import {RoleLifecycleService,initializeRoleLifecycle} from '../src/work/role-lifecycle.ts'
import {RoleService,initializeRoles} from '../src/work/roles.ts'
import {TaskService,initializeTasks} from '../src/work/tasks.ts'
import {IndustryWorkSource} from '../src/work/industry-work-source.ts'
import {IndustryTaskService,initializeIndustryTasks} from '../src/work/industry-tasks.ts'
import {PlanService,initializePlans} from '../src/work/plans.ts'
import {IndustryPlanSource} from '../src/work/industry-plan-source.ts'
import {IndustryPlanService,initializeIndustryPlans} from '../src/work/industry-plans.ts'
import {PlanOccurrenceService,initializePlanOccurrences} from '../src/work/plan-occurrences.ts'
import {ObjectConversationService,initializeObjectConversations} from '../src/work/object-conversations.ts'
import {TaskRunService,initializeTaskRuns} from '../src/work/task-runs.ts'
import {readRoleIndustrySkillNames,resolveIndustryRunSkillBindings} from '../src/work/industry-skill-bindings.ts'
import {SkillInstallationService,type NativeSkillMetadata,type SkillInstallation,type SkillInstallationFilesPort} from '../src/market/skill-installations.ts'
import {SkillInstallSource,type SkillInstallSourceBundle,type SkillInstallSourceIdentity,type SkillInstallSourceInput} from '../src/market/skill-install-source.ts'
import {SkillSelectionService} from '../src/market/skill-selection-changes.ts'
import type {RunSkill} from '../src/work/task-run-skills.ts'
import {initializeCollaboration} from '../src/work/collaboration.ts'
import {initializeGroupAgentGrants} from '../src/work/group-agent-grants.ts'

let container:StartedPostgreSqlContainer,pool:Pool
const encoder=new TextEncoder(),hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex')
const identity={id:randomUUID,now:()=>new Date().toISOString()}

before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start()
 pool=new Pool({connectionString:container.getConnectionUri()})
 await initializeMarketContents(pool);await initializeRoles(pool);await initializeCollaboration(pool);await initializeGroupAgentGrants(pool);await initializeTasks(pool);await initializeIndustryLoads(pool);await initializeIndustryRoles(pool);await initializeRoleLifecycle(pool);await initializeIndustryTasks(pool);await initializePlans(pool);await initializeIndustryPlans(pool);await initializePlanOccurrences(pool);await initializeObjectConversations(pool);await initializeTaskRuns(pool)
},{timeout:180_000})
after(async()=>{await pool?.end();await container?.stop()})

type Fixture=Awaited<ReturnType<typeof fixture>>
async function fixture(options:{publicSkill?:boolean;modelDependencies?:IndustryModelDependency[]}={}){
 const owner=randomUUID(),market=new MarketContentStore(pool,identity)
 const atomic=options.publicSkill?await market.import({ownerId:owner,kind:'human'},{kind:'atomic-skill',requestId:randomUUID(),source:{kind:'upload',name:'公共研究简报'},metadata:{id:'research-brief',title:'研究简报',version:'1.0.0',categories:[]},files:[{path:'SKILL.md',bytes:encoder.encode('---\nname: research-brief\ndescription: 形成研究简报\n---\n固定方法')}]}):undefined
 const manifest={format:options.modelDependencies?'teloa.business-package/v3':'teloa.business-package/v2',id:'research',title:'研究工作',version:'1.0.0',domain:'general',description:'研究工作',resources:[
  {id:'work',kind:'work-template',title:'资料核对',version:'1.0.0',required:true,source:{kind:'local',path:'work.json'}},
  {id:'daily',kind:'plan',title:'每日核对',version:'1.0.0',required:true,source:{kind:'local',path:'plan.json'}},
  {id:'analyst',kind:'role',title:'分析岗',version:'1.0.0',required:true,source:{kind:'local',path:'role.json'}},
  {id:'brief',kind:'skill',title:'简报',version:'1.0.0',required:true,source:options.publicSkill?{kind:'public',id:'research-brief',version:'1.0.0'}:{kind:'local',path:'skills/brief/SKILL.md'},...(options.modelDependencies?{modelDependencies:options.modelDependencies}:{})},
 ],relations:[
  {kind:'role-work',from:'analyst',to:'work'},
  {kind:'role-work',from:'analyst',to:'daily'},
  {kind:'role-skill',from:'analyst',to:'brief'},
 ],entrypoints:['work']}
 const work={format:'teloa.work-template/v1',id:'work',title:'资料核对',version:'1.0.0',domain:'general',description:'逐项核对资料',requirements:['资料'],output:'研究简报',skills:[{id:'brief',title:'简报',version:'1.0.0'}]}
 const files=[
  {path:'teloa.json',bytes:encoder.encode(JSON.stringify(manifest))},
  {path:'work.json',bytes:encoder.encode(JSON.stringify(work))},
  {path:'plan.json',bytes:encoder.encode(JSON.stringify({format:'teloa.plan/v1',version:'1.0.0',title:'每日核对',workTemplate:'work',dataScope:'当天资料',trigger:{kind:'schedule',cadence:'daily',weekday:1,time:'09:00',timezone:'Asia/Singapore'}}))},
  {path:'role.json',bytes:encoder.encode(JSON.stringify({format:'teloa.role/v1',name:'分析岗',kind:'employee',duty:'核对',dataScope:'资料',executionScope:'代拟'}))},
  {path:'skills/brief/SKILL.md',bytes:encoder.encode('---\nname: research-brief\ndescription: 形成研究简报\n---\n固定方法')},
 ]
 const saved=await market.import({ownerId:owner,kind:'human'},{kind:'industry-template',requestId:randomUUID(),source:{kind:'upload',name:'研究工作'},manifestPath:'teloa.json',files:options.publicSkill?files.filter(file=>!file.path.startsWith('skills/')):files,references:atomic?[{resourceId:'brief',sourceContentId:atomic.content.id,sourceItemId:'atomic-'+atomic.content.hash,sourceResourceId:'research-brief',sourceHash:atomic.content.hash}]:[]})
 const loads=new IndustryLoadService(pool,identity,createIndustryLoadSource(market)),load=await loads.create(owner,{requestId:randomUUID(),contentId:saved.content.id,contentHash:saved.content.hash,target:{kind:'new',spaceId:randomUUID(),name:'研究空间'}})
 const roleItem=load.items.find(item=>item.localId==='analyst')!,skillItem=load.items.find(item=>item.localId==='brief')!,workItem=load.items.find(item=>item.localId==='work')!,planItem=load.items.find(item=>item.localId==='daily')!
 const roles=new RoleService(pool,identity),industryRoles=new IndustryRoleService(pool,identity,loads,new IndustryRoleSource(market,loads),{get:async()=>{throw Error('没有知识依赖')}},roles),createdRole=await industryRoles.instantiate(owner,{requestId:randomUUID(),loadId:load.id,itemInstanceId:roleItem.instanceId}),role=(await new RoleLifecycleService(pool,identity).change(owner,{roleId:createdRole.role!.id,expectedVersion:createdRole.role!.version,action:'resume',reason:'执行测试'})).role
 const workSource=new IndustryWorkSource(market,loads),tasks=new TaskService(pool,identity),industryTasks=new IndustryTaskService(pool,identity,workSource,tasks),plans=new PlanService(pool,identity,market),industryPlans=new IndustryPlanService(pool,identity,new IndustryPlanSource(market,loads,workSource),plans)
 return {owner,market,load,loads,role,skillItem,workItem,planItem,tasks,industryTasks,plans,industryPlans}
}

class Reader{
 readonly owner:string;readonly values=new Map<string,SkillInstallSourceBundle>()
 constructor(owner:string){this.owner=owner}
 async read(owner:string,input:SkillInstallSourceInput){if(owner!==this.owner)throw new WorkError('teloa/forbidden','本人不匹配');const found=this.values.get(JSON.stringify(input));if(!found)throw new WorkError('teloa/source-unavailable','来源不存在');return structuredClone(found)}
}
class Files implements SkillInstallationFilesPort{
 readonly metadata=new Map<string,NativeSkillMetadata>()
 async inspect(bundle:SkillInstallSourceBundle){const found=this.metadata.get(bundle.bundleHash);if(!found)throw new WorkError('teloa/source-unavailable','元数据不存在');return found}
 async publish(){}async verify(){}
}
function sourceBundle(owner:string,source:SkillInstallSourceIdentity,version:string){
 const content='研究方法 '+version,entry=encoder.encode(`---\nname: research-brief\ndescription: 研究 ${version}\n---\n${content}`),file={path:'SKILL.md',hash:hash(entry),bytes:entry},bundleHash=hash(JSON.stringify([[file.path,file.hash]])),metadata={name:'research-brief',description:'研究 '+version,modelInvocable:true,userInvocable:true,bodyHash:hash(content)}
 return {bundle:{ownerId:owner,source,entryPath:'SKILL.md' as const,files:[file],bundleHash},metadata,content}
}
async function installVersions(f:Fixture){
 const reader=new Reader(f.owner),files=new Files(),industryInput={kind:'industry' as const,loadId:f.load.id,itemInstanceId:f.skillItem.instanceId},industrySource={kind:'industry-local' as const,loadId:f.load.id,itemInstanceId:f.skillItem.instanceId,contentId:f.load.contentId,contentHash:f.load.contentHash,resourceId:'brief',resourceVersion:'1.0.0'},oldBundle=sourceBundle(f.owner,industrySource,'1.0.0')
 reader.values.set(JSON.stringify(industryInput),oldBundle.bundle);files.metadata.set(oldBundle.bundle.bundleHash,oldBundle.metadata)
 const service=new SkillInstallationService(pool,identity,reader,files),old=(await service.install(f.owner,{requestId:randomUUID(),source:industryInput,expectedBundleHash:oldBundle.bundle.bundleHash})).installation
 const targetInput={kind:'atomic' as const,contentId:randomUUID()},targetSource={kind:'atomic' as const,contentId:targetInput.contentId,contentHash:hash('target-content'),resourceId:'research-brief',resourceVersion:'2.0.0'},targetBundle=sourceBundle(f.owner,targetSource,'2.0.0')
 reader.values.set(JSON.stringify(targetInput),targetBundle.bundle);files.metadata.set(targetBundle.bundle.bundleHash,targetBundle.metadata)
 const target=(await service.install(f.owner,{requestId:randomUUID(),source:targetInput,expectedBundleHash:targetBundle.bundle.bundleHash})).installation
 const skills=new Map([[old.id,runSkill(old,oldBundle.content)],[target.id,runSkill(target,targetBundle.content)]])
 return {service,old,target,skills,usage:{loadId:f.load.id,itemInstanceId:f.skillItem.instanceId}}
}
function runSkill(installation:SkillInstallation,content:string):RunSkill{
 const files=[{path:'SKILL.md',hash:hash(encoder.encode(`---\nname: research-brief\ndescription: 研究 ${installation.source.resourceVersion}\n---\n${content}`)),size:encoder.encode(`---\nname: research-brief\ndescription: 研究 ${installation.source.resourceVersion}\n---\n${content}`).byteLength}]
 return {name:installation.native.name,provider:'teloa-market',source:'global',description:installation.native.description,content,sha256:installation.native.bodyHash,resourceBase:{kind:'directory',path:'/skills/'+installation.id},managed:{installationId:installation.id,bundleHash:installation.bundleHash,files}}
}
async function switchVersion(owner:string,current:SkillInstallation,target:SkillInstallation,industryUsages:{loadId:string;itemInstanceId:string}[]){
 const selections=new SkillSelectionService(pool,identity),preview=await selections.preview(owner,{currentInstallationId:current.id,targetInstallationId:target.id})
 return selections.change(owner,{requestId:randomUUID(),nativeName:current.native.name,currentInstallationId:current.id,targetInstallationId:target.id,expectedSelectionVersion:preview.selection.version,expectedCurrentBundleHash:current.bundleHash,expectedTargetBundleHash:target.bundleHash,expectedImpactDigest:preview.impactDigest,industryUsages})
}
async function directTask(f:Fixture){return f.industryTasks.create(f.owner,{requestId:randomUUID(),loadId:f.load.id,itemInstanceId:f.workItem.instanceId,goal:'核对资料',inputs:['当天资料'],assignee:{roleId:f.role.id,expectedVersion:f.role.version}})}
async function resolve(owner:string,taskId:string,roleId:string){const db=await pool.connect();try{return await resolveIndustryRunSkillBindings(db,owner,taskId,roleId)}finally{db.release()}}
async function prepare(f:Fixture,taskId:string,skills:Map<string,RunSkill>,models?:IndustryModelProbe){
 const sessionId=randomUUID(),conversationId=randomUUID(),inspect=async()=>({id:conversationId,sessionId,ownerId:f.owner,status:'ready'})
 await new ObjectConversationService(pool,inspect,identity.now).change(f.owner,{requestId:randomUUID(),kind:'task',objectId:taskId,expectedObjectVersion:1,sessionId,expectedLinkVersion:0,action:'link'})
 const service=new TaskRunService(pool,identity,inspect,{allowedTools:[],industryContext:f.industryTasks.executionContextInTransaction.bind(f.industryTasks),industrySkills:(db,owner,task,role)=>resolveIndustryRunSkillBindings(db,owner,task,role,models)})
 return service.prepare(f.owner,{requestId:randomUUID(),taskId,expectedTaskVersion:1,roleId:f.role.id,expectedRoleVersion:f.role.version,sessionId,expectedLinkVersion:1},async(_session,_role,_db,installationIds=[])=>installationIds.map(id=>skills.get(id)!))
}

test('全局已切新版但行业未迁移时，解析和新执行仍固定行业旧版本',async()=>{
 const f=await fixture(),installed=await installVersions(f),task=await directTask(f)
 const changed=await switchVersion(f.owner,installed.old,installed.target,[])
 assert.equal(changed.current.installationId,installed.target.id)
 assert.deepEqual(await resolve(f.owner,task.task.id,f.role.id),{installationIds:[installed.old.id]})
 const run=await prepare(f,task.task.id,installed.skills)
 assert.equal(run.skills[0]?.managed?.installationId,installed.old.id)
 assert.equal((await pool.query('select installation_id from teloa_task_run_skill_refs where run_id=$1',[run.id])).rows[0].installation_id,installed.old.id)
})

test('行业引用明确迁移后，新任务准备固定新版安装',async()=>{
 const f=await fixture(),installed=await installVersions(f),task=await directTask(f)
 await switchVersion(f.owner,installed.old,installed.target,[installed.usage])
 assert.deepEqual(await resolve(f.owner,task.task.id,f.role.id),{installationIds:[installed.target.id]})
 const run=await prepare(f,task.task.id,installed.skills)
 assert.equal(run.skills[0]?.managed?.installationId,installed.target.id)
 assert.equal((await pool.query('select installation_id from teloa_task_run_skill_refs where run_id=$1',[run.id])).rows[0].installation_id,installed.target.id)
})

test('缺少行业 usage、role-skill 或 role-work 时拒绝绑定',async()=>{
 const missing=await fixture(),missingTask=await directTask(missing)
 await assert.rejects(resolve(missing.owner,missingTask.task.id,missing.role.id),{code:'teloa/dependency-unavailable'})
 const f=await fixture(),task=await directTask(f),original=f.load.relations
 await installVersions(f)
 await pool.query('update teloa_industry_loads set relations=$2 where id=$1',[f.load.id,JSON.stringify(original.filter(link=>link.kind!=='role-skill'))])
 await assert.rejects(resolve(f.owner,task.task.id,f.role.id),{code:'teloa/conflict'})
 await pool.query('update teloa_industry_loads set relations=$2 where id=$1',[f.load.id,JSON.stringify(original.filter(link=>link.kind!=='role-work'||link.to!==f.workItem.instanceId))])
 await assert.rejects(resolve(f.owner,task.task.id,f.role.id),{code:'teloa/conflict'})
})

test('行业计划 occurrence 任务按计划岗位关系解析同一精确安装',async()=>{
 const f=await fixture(),installed=await installVersions(f),created=await f.industryPlans.create(f.owner,{requestId:randomUUID(),loadId:f.load.id,itemInstanceId:f.planItem.instanceId,goal:'每日核对',delivery:'简报',notificationPolicy:'attention',trigger:{kind:'schedule',cadence:'daily',weekday:1,time:'10:00',timezone:'Asia/Singapore'},roleId:f.role.id,expectedRoleVersion:f.role.version}),active=await f.plans.change(f.owner,{planId:created.plan.id,requestId:randomUUID(),expectedVersion:created.plan.version,action:'enable'}),occurrences=new PlanOccurrenceService(pool,{id:randomUUID},f.market),claim=await occurrences.claim(f.owner,{planId:active.id,now:'2030-01-02T02:00:00.000Z'}),dispatched=await occurrences.dispatchTask(f.owner,{claimId:claim.occurrence!.id,taskRequestId:claim.occurrence!.taskRequestId,now:'2030-01-02T02:00:01.000Z'})
 assert.equal((await pool.query('select count(*)::int n from teloa_industry_task_sources where task_id=$1',[dispatched.task.id])).rows[0].n,0)
 assert.deepEqual(await resolve(f.owner,dispatched.task.id,f.role.id),{installationIds:[installed.old.id]})
})

test('公共 Skill 独立调用不继承模型条件，但声明必需模型的方案 Run 按当前加载阻断',async()=>{
 const dependency:IndustryModelDependency={catalogId:'teloa.model.sensevoice',version:'1.0.0',usage:'speech-to-text',required:true}
 const f=await fixture({publicSkill:true,modelDependencies:[dependency]})
 let phase:IndustryModelPhase='disabled',probes=0
 const probe:IndustryModelProbe=async model=>{assert.deepEqual(model,dependency);probes++;return phase}
 const reader=new SkillInstallSource(f.market,f.loads,probe),source:SkillInstallSourceInput={kind:'industry',loadId:f.load.id,itemInstanceId:f.skillItem.instanceId},bundle=await reader.read(f.owner,source)
 const files=new Files()
 files.metadata.set(bundle.bundleHash,{name:'research-brief',description:'形成研究简报',modelInvocable:true,userInvocable:true,bodyHash:hash('固定方法')})
 const installation=(await new SkillInstallationService(pool,identity,reader,files).install(f.owner,{requestId:randomUUID(),source,expectedBundleHash:bundle.bundleHash,expectedTrustHash:bundle.trustHash})).installation
 assert.equal(installation.source.kind,'industry-public')
 await reader.assertModelsReady(f.owner,installation.source)
 assert.equal(probes,0,'共享公共 Skill 的安装与独立调用不强制准备方案依赖')
 const task=await directTask(f),db=await pool.connect()
 try{
  await assert.rejects(resolveIndustryRunSkillBindings(db,f.owner,task.task.id,f.role.id,probe),{code:'teloa/dependency-unavailable'})
  phase='ready'
  assert.deepEqual(await resolveIndustryRunSkillBindings(db,f.owner,task.task.id,f.role.id,probe),{installationIds:[installation.id]})
 }finally{db.release()}
 phase='disabled'
 await assert.rejects(prepare(f,task.task.id,new Map(),probe),{code:'teloa/dependency-unavailable'})
 assert.equal((await pool.query('select count(*)::int n from teloa_task_runs where owner_id=$1',[f.owner])).rows[0].n,0,'必需模型缺失不能创建可提交的执行')
 const before=probes
 await reader.assertModelsReady(f.owner,installation.source)
 assert.equal(probes,before,'方案执行受阻不连坐共享原子技能')
})

test('岗位的行业职责技能（技能代发授权页候选，规格 2026-09-27 §5.1 审查修复 R1）：按 role-skill 关系与已启用 usage 列出技能名；无 usage、无关系、其他岗位、已卸载均不列',async()=>{
 const f=await fixture()
 const names=async(owner:string,roleId:string)=>{const db=await pool.connect();try{return await readRoleIndustrySkillNames(db,owner,roleId)}finally{db.release()}}
 assert.deepEqual(await names(f.owner,f.role.id),[],'还没有行业 usage')
 await installVersions(f)
 assert.deepEqual(await names(f.owner,f.role.id),['research-brief'])
 assert.deepEqual(await names(f.owner,randomUUID()),[],'其他岗位')
 assert.deepEqual(await names(randomUUID(),f.role.id),[],'其他本人')
 const original=f.load.relations
 await pool.query('update teloa_industry_loads set relations=$2 where id=$1',[f.load.id,JSON.stringify(original.filter(link=>link.kind!=='role-skill'))])
 assert.deepEqual(await names(f.owner,f.role.id),[],'没有职责关系')
 await pool.query('update teloa_industry_loads set relations=$2 where id=$1',[f.load.id,JSON.stringify(original)])
 await pool.query("update teloa_industry_loads set status='unloaded' where id=$1",[f.load.id])
 assert.deepEqual(await names(f.owner,f.role.id),[],'已卸载或被替代的加载不再提供')
})

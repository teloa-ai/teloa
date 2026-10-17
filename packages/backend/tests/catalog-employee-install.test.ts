import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {homedir,tmpdir} from 'node:os'
import {join} from 'node:path'
import {mkdtemp,readFile,readdir,realpath,rm} from 'node:fs/promises'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {WorkError,marketCatalogTreeHash} from '@teloa/contract'
import {MarketContentStore,initializeMarketContents} from '../src/market/content-store.ts'
import {OfficialCatalogService,type OfficialCatalogSnapshot} from '../src/market/official-catalog.ts'
import {SkillInstallSource} from '../src/market/skill-install-source.ts'
import {SkillInstallationService,initializeSkillInstallations} from '../src/market/skill-installations.ts'
import {IndustryLoadService,initializeIndustryLoads} from '../src/work/industry-loads.ts'
import {createIndustryLoadSource} from '../src/work/industry-load-source.ts'
import {IndustryReferenceCatalog,combineReferenceCatalogs} from '../src/capabilities/industry-reference-catalog.ts'
import {ResourceService} from '../src/capabilities/resources.ts'
import {initializeResources} from '../src/capabilities/schema.ts'
import {IndustryKnowledgeService,initializeIndustryKnowledge} from '../src/work/industry-knowledge.ts'
import {IndustryRoleSource} from '../src/work/industry-role-source.ts'
import {IndustryRoleService,initializeIndustryRoles} from '../src/work/industry-roles.ts'
import {RoleService,initializeRoles} from '../src/work/roles.ts'
import {initializeTasks} from '../src/work/tasks.ts'
import {RoleLifecycleService,initializeRoleLifecycle} from '../src/work/role-lifecycle.ts'
import {initializeCollaboration} from '../src/work/collaboration.ts'
import {initializeGroupAgentGrants} from '../src/work/group-agent-grants.ts'
import {BusinessSpaceService} from '../src/work/business-spaces.ts'
import {createPublicReferenceCatalog} from '@teloa/mcp-reference/local'
import {createIndustryPrepareHandler} from '../../harness-dsh/src/industry-prepare.ts'
import {createRoleHandler} from '../../harness-dsh/src/roles.ts'
import {ManagedSkillFiles} from '../../harness-dsh/src/managed-skill-files.ts'
import {createCatalogEmployeeInstaller,type CatalogEmployeePorts,type CatalogEmployeeReceipt} from '../../harness-dsh/src/catalog-employee-install.ts'

// 真实 PG 与真实服务：官方目录（测试快照）、固定派生内容、加载、技能安装（industry 来源 + 受管文件落盘）、资料与员工实例化、原一键准备、原 roles/edit。
// 只有 DSH 原生技能发现（SKILL.md 解析与 observe）用按同一字段形状的替身。
let container:StartedPostgreSqlContainer,pool:Pool,root:string
const identity={id:randomUUID,now:()=>new Date().toISOString()},enc=new TextEncoder(),sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex')
before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock');process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()})
 await initializeMarketContents(pool);await initializeIndustryLoads(pool);await initializeResources(pool);await initializeIndustryKnowledge(pool);await initializeRoles(pool);await initializeCollaboration(pool);await initializeGroupAgentGrants(pool);await initializeTasks(pool);await initializeRoleLifecycle(pool);await initializeIndustryRoles(pool);await initializeSkillInstallations(pool)
 root=await realpath(await mkdtemp(join(tmpdir(),'teloa-catalog-employee-')))
},{timeout:180000})
after(async()=>{await pool?.end();await container?.stop();if(root)await rm(root,{recursive:true,force:true})})

const duties=(who:string)=>({triggers:[who+'：收到新工单'],autonomousActions:[who+'：起草回复'],confirmationPoints:[who+'：外发前请本人确认'],escalationRules:[who+'：法律问题升级'],deliveryChecks:[who+'：回复附来源']})
const role=(name:string)=>({format:'teloa.role/v1',name,kind:'employee',duty:name+'负责客户支持。',dataScope:'本人提供的工单。',executionScope:'外发前请本人确认。',responsibility:duties(name)})
const skill=(title:string,native:string)=>`---\nname: ${native}\ndescription: ${title} method\n---\n# ${title}\n`
const routine=(id:string)=>({format:'teloa.work-template/v1',id,title:id,version:'1.0.0',domain:'general',description:'Unscheduled routine.',requirements:['工单'],output:'待审回复草稿。',skills:[]})
/**
 * 两位员工的团队包（与 Grok 团队包同构）：共享团队资料、各自 PROFILE 资料、方法（资源 id 与原生名不同，且带附属文件）、
 * 未排期的工作模板、员工到员工的协调关系，以及根目录的许可、修改说明与说明。
 */
function teamFiles():Record<string,Uint8Array>{
 const manifest={format:'teloa.business-package/v3',id:'acme-support-team',title:'Support team',version:'1.0.0',domain:'general',scope:'general',description:'两位客服员工。',
  resources:[
   {id:'team-definition',kind:'knowledge',title:'Team definition',version:'1.0.0',required:true,source:{kind:'local',path:'references/team.yaml'}},
   {id:'triage',kind:'role',title:'Triage',version:'1.0.0',required:true,source:{kind:'local',path:'roles/triage.json'}},
   {id:'triage-profile',kind:'knowledge',title:'Triage PROFILE',version:'1.0.0',required:true,source:{kind:'local',path:'references/triage/PROFILE.md'}},
   {id:'ticket-triage',kind:'skill',title:'Ticket triage',version:'1.0.0',required:true,source:{kind:'local',path:'skills/ticket-triage/SKILL.md'}},
   {id:'triage-routine',kind:'work-template',title:'Routine (unscheduled): triage',version:'1.0.0',required:false,source:{kind:'local',path:'routines/triage-routine.json'}},
   {id:'escalation',kind:'role',title:'Escalation',version:'1.0.0',required:true,source:{kind:'local',path:'roles/escalation.json'}},
   {id:'escalation-profile',kind:'knowledge',title:'Escalation PROFILE',version:'1.0.0',required:true,source:{kind:'local',path:'references/escalation/PROFILE.md'}},
   {id:'escalation-desk',kind:'skill',title:'Escalation desk',version:'1.0.0',required:true,source:{kind:'local',path:'skills/escalation-desk/SKILL.md'}},
  ],
  relations:[
   {kind:'role-knowledge',from:'triage',to:'triage-profile'},{kind:'role-knowledge',from:'triage',to:'team-definition'},{kind:'role-skill',from:'triage',to:'ticket-triage'},{kind:'role-work',from:'triage',to:'triage-routine'},
   {kind:'role-knowledge',from:'escalation',to:'escalation-profile'},{kind:'role-knowledge',from:'escalation',to:'team-definition'},{kind:'role-skill',from:'escalation',to:'escalation-desk'},
   {kind:'role-coordination',from:'triage',to:'escalation'},
  ],entrypoints:[]}
 const text:Record<string,string>={
  'teloa.json':JSON.stringify(manifest,null,2),'LICENSE':'MIT License\n','MODIFICATIONS.md':'# Modifications\nMapped to Teloa.\n','README.md':'# Support team\n',
  'references/team.yaml':'name: support\n','references/triage/PROFILE.md':'# Triage profile\n','references/escalation/PROFILE.md':'# Escalation profile\n',
  'roles/triage.json':JSON.stringify(role('一线客服')),'roles/escalation.json':JSON.stringify(role('客服主管')),'routines/triage-routine.json':JSON.stringify(routine('triage-routine')),
  'skills/ticket-triage/SKILL.md':skill('Ticket triage','acme-ticket-triage'),'skills/ticket-triage/skill.yaml':'id: ticket-triage\n',
  'skills/escalation-desk/SKILL.md':skill('Escalation desk','acme-escalation-desk'),
 }
 return Object.fromEntries(Object.entries(text).map(([path,value])=>[path,enc.encode(value)]))
}
const artifact=(files:Record<string,Uint8Array>)=>{const list=Object.keys(files).sort().map(path=>({path,sha256:sha(files[path]!),size:files[path]!.byteLength}));return {files:list,treeHash:marketCatalogTreeHash(list,sha)}}
const common={modifications:[],compatibility:{status:'needs-configuration',teloa:'>=0.2.0-alpha.7',dsh:'0.1.7-rc.1',conditions:[]},requires:{tools:[],network:true,runtimes:[]},review:{status:'approved',reviewedAt:'2026-10-14',reviewer:'Teloa'}}
function roleEntry(id:string,roleId:string,path:string,packageId='acme-support-team'){
 const definition=role(roleId==='triage'?'一线客服':'客服主管'),{format:_,...fields}=definition
 return {format:'teloa.market-catalog-entry/v1',id,kind:'role',delivery:'install',version:'1.0.0',upstream:null,taxonomy:{functions:['business-ops'],industries:['general']},
  role:{roleId,title:{'zh-CN':fields.name,en:roleId},summary:{'zh-CN':fields.name+'。',en:roleId+'.'},definition:fields,skills:[roleId==='triage'?'ticket-triage':'escalation-desk'],scope:'general',preferredModel:null,fromSolution:{packageId,version:'1.0.0',path}},
  license:{spdx:'MIT',files:['LICENSE'],url:'https://opensource.org/license/mit'},...common}
}
/** 测试快照：父团队包 + 两个员工条目；`parent:false` 去掉父包（来源不可用）。 */
function snapshot({parent=true}:{parent?:boolean}={}):OfficialCatalogSnapshot{
 const team=teamFiles(),entries:Record<string,unknown>[]=[],files:Record<string,string>={}
 if(parent){
  entries.push({format:'teloa.market-catalog-entry/v1',id:'teloa.acme-support-team',kind:'solution',delivery:'install',version:'1.0.0',upstream:null,taxonomy:{functions:['business-ops'],industries:['general']},
   solution:{packageId:'acme-support-team',title:{'zh-CN':'客服团队',en:'Support team'},summary:{'zh-CN':'两位客服。',en:'Two agents.'},scope:'general',capabilities:{now:[{'zh-CN':'分诊',en:'Triage'}],needs:[{'zh-CN':'工单',en:'Tickets'}],permissions:[{'zh-CN':'无',en:'None'}]}},
   license:{spdx:'MIT',files:['LICENSE']},...common,artifact:artifact(team)})
  for(const [path,bytes] of Object.entries(team))files['teloa.acme-support-team/1.0.0/'+path]=Buffer.from(bytes).toString('base64')
 }
 for(const [id,roleId,path] of [['teloa.acme-triage','triage','roles/triage.json'],['teloa.acme-escalation','escalation','roles/escalation.json']] as const){
  const own={'role.json':team[path]!,'LICENSE':team.LICENSE!}
  entries.push({...roleEntry(id,roleId,path),artifact:artifact(own)})
  for(const [name,bytes] of Object.entries(own))files[id+'/1.0.0/'+name]=Buffer.from(bytes).toString('base64')
 }
 entries.sort((a,b)=>String(a.id)<String(b.id)?-1:1)
 const index={format:'teloa.market-catalog/v1',catalogVersion:'test-2026.10.14',entries}
 return {indexSha256:sha(JSON.stringify(index)),index,files}
}

/** 同一本人的一套服务；每次调用都是新实例，模拟刷新、重启或换新服务后只能从数据库读回。 */
function services(owner:string,snap:OfficialCatalogSnapshot=snapshot()){
 const market=new MarketContentStore(pool,identity),loads=new IndustryLoadService(pool,identity,createIndustryLoadSource(market)),refs=new IndustryReferenceCatalog(pool,market,loads),sources=combineReferenceCatalogs(createPublicReferenceCatalog(),refs),resources=new ResourceService(pool,sources,identity),knowledge=new IndustryKnowledgeService(pool,identity,loads,sources,resources),roles=new RoleService(pool,identity),industryRoles=new IndustryRoleService(pool,identity,loads,new IndustryRoleSource(market,loads),knowledge,roles)
 const catalog=new OfficialCatalogService(market,snap,{catalogRoleIds:(ownerId,entries,contentHash)=>industryRoles.catalogRoleIds(ownerId,entries,contentHash)})
 const files=new ManagedSkillFiles(join(root,owner.replace(/[^a-z0-9]/gi,''),'skills'),async directory=>{const text=await readFile(join(directory,'SKILL.md'),'utf8'),name=/^name:\s*(.+)$/m.exec(text)![1]!.trim(),description=/^description:\s*(.+)$/m.exec(text)![1]!.trim();return {name,description,modelInvocable:true,userInvocable:true,bodyHash:sha(text)}},()=>{})
 const skills=new SkillInstallationService(pool,identity,new SkillInstallSource(market,loads),files)
 const roleHandler=createRoleHandler(owner,async()=>roles),lifecycle=new RoleLifecycleService(pool,identity),spaces=new BusinessSpaceService(pool,identity)
 const skillCall=async(endpoint:string,payload:any)=>{
  if(endpoint==='skill-installations/list')return skills.list(owner,payload)
  if(endpoint==='skill-installations/preview')return skills.preview(owner,payload)
  if(endpoint==='skill-installations/install')return skills.install(owner,payload)
  // 原生发现替身按真实规则：同名只有本人当前选定的那份生效，其余为被遮蔽
  if(endpoint==='skill-installations/observe'){const found=await skills.get(owner,{installationId:payload.installationId}),selected=(await pool.query('select installation_id from teloa_skill_selections where owner_id=$1 and native_name=$2',[owner,found.native.name])).rows[0]?.installation_id;return selected===found.id?{installationId:found.id,scope:'default-workspace',state:'available',current:{...found.native}}:{installationId:found.id,scope:'default-workspace',state:'shadowed',reason:'different-source',current:{...found.native}}}
  throw Error(endpoint)
 }
 const industryRoleCall=async(endpoint:string,payload:unknown)=>endpoint==='industry-roles/list'?industryRoles.list(owner,payload):industryRoles.instantiate(owner,payload)
 const loadCall=async(endpoint:string,payload:unknown)=>endpoint==='industry-loads/create'?loads.create(owner,payload):endpoint==='industry-loads/get'?loads.get(owner,payload):Promise.reject(Error(endpoint))
 const prepare=createIndustryPrepareHandler(owner,async()=>({
  loads:loadCall,knowledge:async(endpoint,payload)=>endpoint==='industry-knowledge/list'?knowledge.list(owner,payload):knowledge.instantiate(owner,payload),
  roles:industryRoleCall,roleRecords:(endpoint,payload)=>roleHandler(endpoint,payload),skills:skillCall,
  mcp:async()=>({items:[]}),dataSources:async()=>({items:[]}),executionTools:async()=>({items:[]}),plugins:async()=>({items:[]}),
  lifecycle:payload=>lifecycle.change(owner,payload),sleep:async()=>{},
 }))
 const ports:CatalogEmployeePorts={
  entry:id=>catalog.roleEntryForAdd(id),
  locate:entry=>industryRoles.catalogEmployee(owner,entry,(id,generation)=>catalog.roleContentHash(id,generation)),
  importContent:async input=>{const {content}=await catalog.addRolePackage({ownerId:owner,kind:'human'},input);return {id:content.id,hash:content.hash}},
  currentSpace:async()=>{await spaces.ensurePersonal(owner);return spaces.current(owner)},
  loads:loadCall,skills:skillCall,roles:industryRoleCall,
  prepare:(endpoint,payload,options)=>prepare(endpoint,payload,undefined,'catalog',options) as Promise<unknown>,
 }
 return {market,loads,catalog,industryRoles,roles,roleHandler,lifecycle,skills,ports,prepare,skillCall,installer:(wrap:(ports:CatalogEmployeePorts)=>CatalogEmployeePorts=value=>value)=>createCatalogEmployeeInstaller(owner,async()=>wrap(ports))}
}
const triage={entryId:'teloa.acme-triage',version:'1.0.0'}
const full=(value:unknown)=>value as CatalogEmployeeReceipt
/** 真实 PG 用例需要较长超时：名称、正文、选项按阅读顺序书写。 */
const slow=(name:string,fn:()=>Promise<void>,options:{timeout:number})=>test(name,options,fn)
const ownerRoles=async(owner:string)=>(await pool.query('select id,state,version,definition from teloa_roles where owner_id=$1 order by created_at',[owner])).rows

test('组成预览只含所选员工及其直接关联资源；父包许可与修改说明随包，员工到员工的关系不进入',()=>{
 const s=services('local:'+randomUUID()),preview=s.catalog.rolePackage('teloa.acme-triage'),manifest=preview.manifest as any
 assert.deepEqual([preview.packageId,preview.packageVersion,preview.version],['acme-support-team','1.0.0','1.0.0'])
 assert.deepEqual(manifest.resources.map((r:any)=>r.id).sort(),['team-definition','ticket-triage','triage','triage-profile','triage-routine'])
 assert.equal(manifest.resources.filter((r:any)=>r.kind==='role').length,1)
 assert.ok(manifest.relations.every((link:any)=>link.from==='triage'&&link.kind!=='role-coordination'))
 assert.equal(manifest.id,'acme-support-team-triage');assert.equal(manifest.scope,'general')
 // 来源不可用：父包缺失时预览与摘要都如实拒绝，不回退到只建空岗位
 const missing=services('local:'+randomUUID(),snapshot({parent:false}))
 assert.throws(()=>missing.catalog.rolePackage('teloa.acme-triage'),{code:'teloa/source-unavailable'})
 assert.equal(missing.catalog.roleContentHash('teloa.acme-triage',1),null)
})

slow('单独添加一位目录员工：真实 PG 固定内容、方法落盘并绑定实际原生名、共享资料为真实资源、只建所选员工且保持暂停',async()=>{
 const owner='local:'+randomUUID(),s=services(owner)
 const receipt=full(await s.installer()(triage))
 assert.equal(receipt.status,'created');assert.ok(receipt.roleId)
 assert.equal(receipt.install.complete,true);assert.equal(receipt.install.roleState,'paused');assert.equal(receipt.install.next,'resume')
 // 方法：资源 id ticket-triage ≠ 原生名 acme-ticket-triage；员工只绑定实际安装回执的原生名
 assert.deepEqual(receipt.skills,['acme-ticket-triage'])
 const method=receipt.install.resources.find(row=>row.kind==='skill')!
 assert.deepEqual([method.title,method.state,method.nativeName],['Ticket triage','done','acme-ticket-triage'])
 const installs=await s.skills.list(owner,{})
 assert.equal(installs.items.length,1);assert.equal(installs.items[0]!.native.name,'acme-ticket-triage');assert.equal(installs.items[0]!.state,'installed')
 const dir=join(root,owner.replace(/[^a-z0-9]/gi,''),'skills')
 const onDisk=await readdir(dir,{recursive:true})
 assert.ok(onDisk.some(path=>String(path).endsWith('SKILL.md')));assert.ok(onDisk.some(path=>String(path).endsWith('skill.yaml')),'技能目录附属文件一并落盘')
 // 只建所选员工：同团队的客服主管没有被建立，也没有安装它的方法
 const rows=await ownerRoles(owner)
 assert.equal(rows.length,1);assert.equal(rows[0].id,receipt.roleId);assert.equal(rows[0].state,'paused');assert.equal(rows[0].definition.name,'一线客服')
 assert.deepEqual(rows[0].definition.responsibility,duties('一线客服'))
 // 资料：团队共享资料与 PROFILE 都实例化为真实资源，员工知识引用它们
 const knowledge=(await pool.query("select id,status from teloa_resources where id=any($1::uuid[])",[rows[0].definition.knowledge])).rows
 assert.equal(knowledge.length,2);assert.ok(knowledge.every(row=>row.status==='active'))
 assert.deepEqual(receipt.install.resources.filter(row=>row.kind==='knowledge').map(row=>row.state),['done','done'])
 assert.deepEqual(receipt.install.resources.filter(row=>row.kind==='work-template').map(row=>row.state),['optional'])
 // 固定内容：来源为员工条目，许可来源保留，父包许可与修改说明随包、其他员工的文件不进入
 const [load]=(await s.loads.list(owner,{})).items
 const content=await s.market.get({ownerId:owner,kind:'human'},{contentId:load!.contentId})
 assert.equal(content.trust.publisher,'Teloa 官方目录');assert.deepEqual(content.trust.license,{status:'declared',value:'MIT'})
 const paths=content.files.map(file=>file.path)
 for(const path of ['LICENSE','MODIFICATIONS.md','roles/triage.json','skills/ticket-triage/SKILL.md','skills/ticket-triage/skill.yaml','references/team.yaml'])assert.ok(paths.includes(path),path)
 assert.ok(!paths.some(path=>path.includes('escalation')),'其他员工的文件不进入员工包')
 assert.equal(load!.space.id,(await new BusinessSpaceService(pool,identity).current(owner)).id,'加载到本人当前空间，不新建业务空间')
 // 目录列表回显：按派生链找回该员工
 assert.equal((await s.industryRoles.catalogRoleIds(owner,[s.catalog.roleEntryForAdd('teloa.acme-triage')],(id,g)=>s.catalog.roleContentHash(id,g))).get('teloa.acme-triage'),receipt.roleId)
 // 再添加：同一员工 existing，不重复建、不改员工
 const again=full(await services(owner).installer()(triage))
 assert.equal(again.status,'existing');assert.equal(again.roleId,receipt.roleId);assert.equal((await ownerRoles(owner)).length,1);assert.equal((await ownerRoles(owner))[0].version,rows[0].version)
},{timeout:120000})

slow('回执丢失跨新服务恢复：加载已写入但回包丢失、准备已执行但回包丢失，再添加都落到同一加载与同一员工',async()=>{
 const owner='local:'+randomUUID()
 const lose=(ports:CatalogEmployeePorts):CatalogEmployeePorts=>({...ports,loads:async(endpoint,payload)=>{const value=await ports.loads(endpoint,payload);if(endpoint==='industry-loads/create')throw new WorkError('teloa/storage-unavailable','回包丢失');return value}})
 await assert.rejects(services(owner).installer(lose)(triage),{code:'teloa/storage-unavailable'})
 assert.equal((await services(owner).loads.list(owner,{})).items.length,1)
 const losePrepare=(ports:CatalogEmployeePorts):CatalogEmployeePorts=>({...ports,prepare:async(endpoint,payload,options)=>{const value=await ports.prepare(endpoint,payload,options);if(endpoint==='industry-loads/prepare')throw new WorkError('teloa/storage-unavailable','回包丢失');return value}})
 await assert.rejects(services(owner).installer(losePrepare)(triage),{code:'teloa/storage-unavailable'})
 const roles=await ownerRoles(owner)
 assert.equal(roles.length,1)
 const recovered=full(await services(owner).installer()(triage))
 assert.equal(recovered.roleId,roles[0].id);assert.equal(recovered.status,'existing');assert.equal(recovered.install.complete,true);assert.deepEqual(recovered.skills,['acme-ticket-triage'])
 assert.equal((await services(owner).loads.list(owner,{})).items.length,1);assert.equal((await ownerRoles(owner)).length,1);assert.equal((await services(owner).skills.list(owner,{})).items.length,1)
},{timeout:120000})

slow('并发：同一安装器与两套独立服务同时添加，只建一位员工、一份加载与一份安装；他人互不可见',async()=>{
 const owner='local:'+randomUUID(),other='local:'+randomUUID(),shared=services(owner).installer()
 const results=(await Promise.all([shared(triage),shared(triage),services(owner).installer()(triage),services(owner).installer()(triage)])).map(full)
 const ids=new Set(results.map(row=>row.roleId))
 assert.equal(ids.size,1);assert.ok(results.every(row=>row.install.complete))
 assert.equal((await ownerRoles(owner)).length,1);assert.equal((await services(owner).loads.list(owner,{})).items.length,1);assert.equal((await services(owner).skills.list(owner,{})).items.length,1)
 // 他人：各自独立派生，不读到本人的员工
 const theirs=full(await services(other).installer()(triage))
 assert.equal(theirs.status,'created');assert.ok(!ids.has(theirs.roleId));assert.equal((await ownerRoles(other)).length,1)
},{timeout:180000})

slow('未知条目、漂移版本与来源不可用拒绝：不建员工、不留下加载',async()=>{
 const owner='local:'+randomUUID()
 await assert.rejects(services(owner).installer()({entryId:'teloa.acme-unknown',version:'1.0.0'}),{code:'teloa/source-unavailable'})
 await assert.rejects(services(owner).installer()({...triage,version:'1.0.1'}),{code:'teloa/version-conflict'})
 await assert.rejects(services(owner,snapshot({parent:false})).installer()(triage),{code:'teloa/source-unavailable'})
 assert.equal((await ownerRoles(owner)).length,0);assert.equal((await services(owner).loads.list(owner,{})).items.length,0)
},{timeout:60000})

slow('方法安装失败：员工不建、如实回 pending 与失败项且不 complete；再添加续做后才建立员工并绑定方法',async()=>{
 const owner='local:'+randomUUID()
 const fail=(ports:CatalogEmployeePorts):CatalogEmployeePorts=>({...ports,skills:async(endpoint,payload)=>{if(endpoint==='skill-installations/install')throw new WorkError('teloa/dependency-unavailable','技能安装暂不可用。');return ports.skills(endpoint,payload)}})
 const first=full(await services(owner).installer(fail)(triage))
 assert.equal(first.roleId,null);assert.equal(first.status,'pending');assert.equal(first.install.complete,false);assert.equal(first.install.next,'retry');assert.deepEqual(first.skills,[])
 assert.equal(first.install.resources.find(row=>row.kind==='skill')!.state,'failed');assert.equal(first.install.resources.find(row=>row.kind==='skill')!.nativeName,undefined)
 assert.equal((await ownerRoles(owner)).length,0)
 const second=full(await services(owner).installer()(triage))
 assert.equal(second.status,'created');assert.equal(second.install.complete,true);assert.deepEqual(second.skills,['acme-ticket-triage'])
},{timeout:120000})

slow('不覆盖本人编辑，旧 v1 员工兼容不替换，退役后重新添加建立新员工',async()=>{
 const owner='local:'+randomUUID(),s=services(owner)
 const created=full(await s.installer()(triage))
 const [row]=await ownerRoles(owner)
 const {format:_,...fields}={...row.definition,duty:'本人改过的职责。'}
 await s.roleHandler('roles/edit',{roleId:created.roleId,expectedVersion:row.version,fields,expectedProfile:{name:row.definition.name}})
 const again=full(await services(owner).installer()(triage))
 const [edited]=await ownerRoles(owner)
 assert.equal(again.roleId,created.roleId);assert.equal(edited.definition.duty,'本人改过的职责。');assert.equal(edited.version,row.version+1)
 // 退役后重新添加：派生链进入下一代，建立新员工，旧员工保持退役
 await s.lifecycle.change(owner,{roleId:created.roleId,expectedVersion:edited.version,action:'retire',reason:'测试退役'})
 const next=full(await services(owner).installer()(triage))
 assert.equal(next.status,'created');assert.notEqual(next.roleId,created.roleId);assert.equal(next.install.complete,true)
 assert.deepEqual((await ownerRoles(owner)).map(value=>value.state),['retired','paused'])
 // 旧 v1：本人此前直接建的岗位原样返回旧三键回执，不加载、不替换
 const legacyOwner='local:'+randomUUID(),legacy=services(legacyOwner),entry=legacy.catalog.roleEntryForAdd('teloa.acme-escalation')
 const old=await legacy.industryRoles.createFromCatalog(legacyOwner,{entryId:entry.id,version:entry.version},entry)
 const kept=await legacy.installer()({entryId:entry.id,version:entry.version})
 assert.deepEqual(kept,{roleId:old.roleId,status:'existing',skills:['escalation-desk']})
 assert.equal((await legacy.loads.list(legacyOwner,{})).items.length,0);assert.equal((await ownerRoles(legacyOwner)).length,1)
},{timeout:180000})

/** 原团队添加流程：官方目录添加方案 → 加载到本人当前空间 → 逐个安装方法 → 原一键准备（含上岗）。 */
async function addTeam(owner:string,s=services(owner)){
 const {content}=await s.catalog.add({ownerId:owner,kind:'human'},{requestId:randomUUID(),entryId:'teloa.acme-support-team'}),space=await s.ports.currentSpace()
 const load=await s.loads.create(owner,{requestId:randomUUID(),contentId:content.id,contentHash:content.hash,target:{kind:'existing',spaceId:space.id,expectedVersion:space.version}})
 for(const item of load.items.filter(row=>row.kind==='skill')){const source={kind:'industry',loadId:load.id,itemInstanceId:item.instanceId},preview:any=await s.skillCall('skill-installations/preview',{source});await s.skillCall('skill-installations/install',{requestId:randomUUID(),source,expectedBundleHash:preview.bundleHash,...(preview.trustHash?{expectedTrustHash:preview.trustHash}:{})})}
 const readiness:any=await s.prepare('industry-loads/readiness',{loadId:load.id});if(readiness.counts.auto)await s.prepare('industry-loads/prepare',{loadId:load.id,expectedDigest:readiness.digest})
 const roles=(await s.industryRoles.list(owner,{})).items.filter(row=>row.loadId===load.id)
 return {load,roles:Object.fromEntries(roles.map(row=>[row.itemLocalId,row.role]))}
}
const installsNamed=async(owner:string,name:string)=>(await pool.query('select id from teloa_skill_installations where owner_id=$1 and native_name=$2',[owner,name])).rows.map(row=>row.id)
const usagesOf=async(owner:string,installationId:string)=>(await pool.query('select load_id from teloa_skill_install_usages where owner_id=$1 and installation_id=$2 order by load_id',[owner,installationId])).rows.map(row=>row.load_id)

slow('共用方法：先加团队再加单员工，复用同一份已安装方法（同来源、版本、摘要），两边员工都绑定同一原生名',async()=>{
 const owner='local:'+randomUUID(),team=await addTeam(owner)
 assert.deepEqual(team.roles.triage!.skills,['acme-ticket-triage']);assert.deepEqual(team.roles.escalation!.skills,['acme-escalation-desk'])
 const [installation]=await installsNamed(owner,'acme-ticket-triage')
 const receipt=full(await services(owner).installer()(triage))
 assert.equal(receipt.status,'created');assert.equal(receipt.install.complete,true);assert.deepEqual(receipt.skills,['acme-ticket-triage'])
 assert.deepEqual(await installsNamed(owner,'acme-ticket-triage'),[installation],'不另装一份同名方法')
 assert.equal((await usagesOf(owner,installation!)).length,2,'团队与单员工两个加载都使用同一份安装')
 // 团队员工不受影响
 assert.deepEqual((await services(owner).industryRoles.list(owner,{})).items.find(row=>row.loadId===team.load.id&&row.itemLocalId==='triage')!.role!.skills,['acme-ticket-triage'])
},{timeout:180000})

slow('共用方法：先加单员工再加团队，团队复用员工已安装的方法并完成绑定',async()=>{
 const owner='local:'+randomUUID()
 const receipt=full(await services(owner).installer()(triage))
 assert.equal(receipt.install.complete,true)
 const [installation]=await installsNamed(owner,'acme-ticket-triage')
 const team=await addTeam(owner)
 assert.deepEqual(team.roles.triage!.skills,['acme-ticket-triage']);assert.deepEqual(team.roles.escalation!.skills,['acme-escalation-desk'])
 assert.deepEqual(await installsNamed(owner,'acme-ticket-triage'),[installation])
 assert.equal((await usagesOf(owner,installation!)).length,2)
 // 再添加单员工仍是同一员工、同一安装
 const again=full(await services(owner).installer()(triage))
 assert.equal(again.roleId,receipt.roleId);assert.equal(again.install.complete,true)
},{timeout:180000})

slow('异源同名：本人已有内容不同的同名方法时明确冲突，不另装、不覆盖、不改本人选择；本人处理后再添加可续做',async()=>{
 const owner='local:'+randomUUID(),s=services(owner),actor={ownerId:owner,kind:'human' as const}
 const mine=await s.market.import(actor,{kind:'atomic-skill',requestId:randomUUID(),source:{kind:'upload',name:'本人技能'},metadata:{id:'acme-ticket-triage',title:'My triage',version:'1.0.0',categories:[]},files:[{path:'acme-ticket-triage/SKILL.md',bytes:enc.encode(skill('My own triage','acme-ticket-triage'))}]})
 const source={kind:'atomic',contentId:mine.content.id},preview:any=await s.skillCall('skill-installations/preview',{source})
 const own:any=await s.skillCall('skill-installations/install',{requestId:randomUUID(),source,expectedBundleHash:preview.bundleHash,...(preview.trustHash?{expectedTrustHash:preview.trustHash}:{})})
 const first=full(await services(owner).installer()(triage))
 assert.equal(first.roleId,null);assert.equal(first.install.complete,false);assert.equal(first.install.next,'review')
 const method=first.install.resources.find(row=>row.kind==='skill')!
 assert.equal(method.state,'conflict');assert.equal(method.nativeName,undefined)
 assert.deepEqual(await installsNamed(owner,'acme-ticket-triage'),[own.installation.id],'不另装一份同名方法')
 assert.equal((await pool.query('select installation_id from teloa_skill_selections where owner_id=$1 and native_name=$2',[owner,'acme-ticket-triage'])).rows[0].installation_id,own.installation.id,'本人选择不变')
 assert.equal((await ownerRoles(owner)).length,0)
 // 换新服务再添加：仍落到同一加载、同样明确冲突，没有副作用（不另装、不建员工、不改本人选择）
 const again=full(await services(owner).installer()(triage))
 assert.equal(again.install.loadId,first.install.loadId);assert.equal(again.roleId,null);assert.equal(again.install.resources.find(row=>row.kind==='skill')!.state,'conflict')
 assert.deepEqual(await installsNamed(owner,'acme-ticket-triage'),[own.installation.id]);assert.equal((await ownerRoles(owner)).length,0)
 // 另一位不含这个方法的员工不受影响，照常完整添加
 const escalation=full(await services(owner).installer()({entryId:'teloa.acme-escalation',version:'1.0.0'}))
 assert.equal(escalation.install.complete,true);assert.deepEqual(escalation.skills,['acme-escalation-desk'])
},{timeout:180000})

slow('授权隔离与可恢复：他人的同名安装不被复用；共用安装后回包丢失，换新服务再添加落到同一员工与同一安装',async()=>{
 const owner='local:'+randomUUID(),other='local:'+randomUUID()
 await addTeam(other)
 const [theirs]=await installsNamed(other,'acme-ticket-triage')
 await addTeam(owner)
 const [mine]=await installsNamed(owner,'acme-ticket-triage')
 assert.notEqual(mine,theirs)
 const losePrepare=(ports:CatalogEmployeePorts):CatalogEmployeePorts=>({...ports,prepare:async(endpoint,payload,options)=>{const value=await ports.prepare(endpoint,payload,options);if(endpoint==='industry-loads/prepare')throw new WorkError('teloa/storage-unavailable','回包丢失');return value}})
 await assert.rejects(services(owner).installer(losePrepare)(triage),{code:'teloa/storage-unavailable'})
 const recovered=full(await services(owner).installer()(triage))
 assert.equal(recovered.status,'existing');assert.equal(recovered.install.complete,true);assert.deepEqual(recovered.skills,['acme-ticket-triage'])
 assert.deepEqual(await installsNamed(owner,'acme-ticket-triage'),[mine]);assert.deepEqual(await installsNamed(other,'acme-ticket-triage'),[theirs])
 assert.equal((await usagesOf(other,theirs!)).length,1,'他人的安装没有被本人加载使用')
 assert.equal((await ownerRoles(owner)).filter(row=>row.definition.name==='一线客服').length,2,'团队一位 + 单员工一位，回包丢失未多建')
},{timeout:180000})

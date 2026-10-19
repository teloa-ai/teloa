import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {homedir,tmpdir} from 'node:os'
import {join} from 'node:path'
import {mkdtemp,readFile,realpath,rm} from 'node:fs/promises'
import {Pool} from './postgres-test-lifecycle.ts'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {MarketContentStore,initializeMarketContents} from '../src/market/content-store.ts'
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
import {CollaborationService,initializeCollaboration} from '../src/work/collaboration.ts'
import {initializeGroupAgentGrants} from '../src/work/group-agent-grants.ts'
import {createPublicReferenceCatalog} from '@teloa/mcp-reference/local'
import {readTemplateSharePackageV2} from '@teloa/contract'
import {createIndustryPrepareHandler} from '../../harness-dsh/src/industry-prepare.ts'
import {createRoleHandler} from '../../harness-dsh/src/roles.ts'
import {ManagedSkillFiles} from '../../harness-dsh/src/managed-skill-files.ts'
import {buildSharePlan} from '../../client/ui-workbench/src/client/share-package-plan.ts'
import {createShareAcceptance,teamCoordination,type ShareAcceptPorts} from '../../client/ui-workbench/src/client/template-share-accept.ts'
import {findIndustryTeam,industryTeamSeed} from '../../client/ui-workbench/src/client/industry-team.ts'

// 真实 PG 与真实服务：固定内容、加载、技能安装（industry 来源 + 受管文件）、资料与岗位实例化、一键准备、原 roles/edit。
// 只有 DSH 原生技能发现（SKILL.md 解析与 observe）用按同一字段形状的替身。
let container:StartedPostgreSqlContainer,pool:Pool,root:string
const identity={id:randomUUID,now:()=>new Date().toISOString()},sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex')
const duties=(who:string)=>({triggers:[who+'：收到新工单'],autonomousActions:[who+'：起草回复'],confirmationPoints:[who+'：退款前请本人确认'],escalationRules:[who+'：法律问题升级'],deliveryChecks:[who+'：回复附来源']})
before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock');process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()})
 await initializeMarketContents(pool);await initializeIndustryLoads(pool);await initializeResources(pool);await initializeIndustryKnowledge(pool);await initializeRoles(pool);await initializeCollaboration(pool);await initializeGroupAgentGrants(pool);await initializeTasks(pool);await initializeRoleLifecycle(pool);await initializeIndustryRoles(pool);await initializeSkillInstallations(pool)
 // 受管技能根拒绝任何符号链接层级；macOS 的 /var 是链接，取真实路径。
 root=await realpath(await mkdtemp(join(tmpdir(),'teloa-share-receive-')))
},{timeout:180000})
after(async()=>{await pool?.end();await container?.stop();if(root)await rm(root,{recursive:true,force:true})})

/** 同一本人的一套服务；每次调用都是新实例，模拟刷新/重启后只能从数据库读回。 */
function services(owner:string){
 const market=new MarketContentStore(pool,identity),loads=new IndustryLoadService(pool,identity,createIndustryLoadSource(market)),catalog=new IndustryReferenceCatalog(pool,market,loads),sources=combineReferenceCatalogs(createPublicReferenceCatalog(),catalog),resources=new ResourceService(pool,sources,identity),knowledge=new IndustryKnowledgeService(pool,identity,loads,sources,resources),roles=new RoleService(pool,identity),industryRoles=new IndustryRoleService(pool,identity,loads,new IndustryRoleSource(market,loads),knowledge,roles)
 // DSH 原生发现替身：读 SKILL.md 前言里的 name/description，正文摘要按字节计算。
 const files=new ManagedSkillFiles(join(root,owner.replace(/[^a-z0-9]/gi,''),'skills'),async directory=>{const text=await readFile(join(directory,'SKILL.md'),'utf8'),name=/^name:\s*(.+)$/m.exec(text)![1]!.trim(),description=/^description:\s*(.+)$/m.exec(text)![1]!.trim();return {name,description,modelInvocable:true,userInvocable:true,bodyHash:sha(text)}},()=>{})
 const skills=new SkillInstallationService(pool,identity,new SkillInstallSource(market,loads),files)
 const roleHandler=createRoleHandler(owner,async()=>roles)
 const lifecycle=new RoleLifecycleService(pool,identity)
 const prepare=createIndustryPrepareHandler(owner,async()=>({
  loads:async(endpoint,payload)=>{if(endpoint!=='industry-loads/get')throw Error(endpoint);return loads.get(owner,payload)},
  knowledge:async(endpoint,payload)=>endpoint==='industry-knowledge/list'?knowledge.list(owner,payload):knowledge.instantiate(owner,payload),
  roles:async(endpoint,payload)=>endpoint==='industry-roles/list'?industryRoles.list(owner,payload):industryRoles.instantiate(owner,payload),
  roleRecords:(endpoint,payload)=>roleHandler(endpoint,payload),
  skills:async(endpoint,payload:any)=>{
   if(endpoint==='skill-installations/list')return skills.list(owner,payload)
   if(endpoint==='skill-installations/preview')return skills.preview(owner,payload)
   if(endpoint==='skill-installations/observe'){const found=await skills.get(owner,{installationId:payload.installationId});return {installationId:found.id,scope:'default-workspace',state:'available',current:{...found.native}}}
   throw Error(endpoint)
  },
  mcp:async()=>({items:[]}),dataSources:async()=>({items:[]}),executionTools:async()=>({items:[]}),plugins:async()=>({items:[]}),
  lifecycle:payload=>lifecycle.change(owner,payload),sleep:async()=>{},
 }))
 return {market,loads,knowledge,roles,industryRoles,skills,prepare,groups:new CollaborationService(pool,identity)}
}

/** 客户端接收流程的端口全部落到上面的真实服务；`lose` 模拟加载已写入但回包丢失。 */
function ports(owner:string,target:()=>Promise<any>,lose={load:false}):NonNullable<ShareAcceptPorts['industry']>{
 const s=services(owner)
 return {
  publicSkill:async()=>{throw Error('not used')},
  target,
  importContent:async(item,requestId)=>{const saved=await s.market.import({ownerId:owner,kind:'human'},{kind:'industry-template',requestId,source:{kind:'upload',name:'share'},manifestPath:item.packageContent!.manifestPath,files:item.packageContent!.files.map(f=>({path:f.path,bytes:f.bytes})),references:[]});return {...item,contentStorage:{contentId:saved.content.id,createdAt:saved.content.createdAt,loaded:true},packageContent:{...item.packageContent!,hash:saved.content.hash}}},
  load:async request=>{const row=await s.loads.create(owner,request);if(lose.load){lose.load=false;throw Error('Lost reply')}return row as never},
  getLoad:async loadId=>s.loads.get(owner,{loadId}) as never,
  installSkill:async(source,requestId)=>{const input={kind:'industry' as const,...source},preview=await s.skills.preview(owner,{source:input}),{installation}=await s.skills.install(owner,{requestId,source:input,expectedBundleHash:preview.bundleHash,...(preview.trustHash?{expectedTrustHash:preview.trustHash}:{})});return {state:'installed',installationId:installation.id,nativeName:installation.native.name}},
  prepare:async loadId=>{const r:any=await s.prepare('industry-loads/readiness',{loadId});if(!r.counts.auto)return r;const receipt:any=await s.prepare('industry-loads/prepare',{loadId,expectedDigest:r.digest,activate:false});return receipt.readiness??s.prepare('industry-loads/readiness',{loadId})},
  roles:async loadId=>(await s.industryRoles.list(owner,{})).items.filter(row=>row.loadId===loadId).map(row=>({itemInstanceId:row.itemInstanceId,state:row.state,...(row.role?{roleId:row.role.id}:{})})),
  team:async seed=>{const found=await findIndustryTeam({list:async()=>({items:await s.groups.list(owner,{})}),get:groupId=>s.groups.get(owner,{groupId})},seed);return found?{groupId:found.group.id}:undefined},
 }
}
const memory=()=>{const values=new Map<string,string>();return {getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>void values.set(k,v),removeItem:(k:string)=>void values.delete(k)}}
const skill=(name:string,native:string)=>`---\nname: ${native}\ndescription: ${name} method\n---\n# ${name}\n`

/** 两位员工、各自技能（资源 id 与原生名不同）、共享静态资料、结构化职责、明确协调者。 */
function teamPackage(){
 const role=(id:string,name:string,skills:string[])=>({id,name,kind:'employee' as const,duty:name+'负责客户支持。',dataScope:'本人提供的工单。',executionScope:'外发前请本人确认。',skills,knowledge:[],responsibility:duties(name)})
 const built=buildSharePlan({subject:'team',title:'客服团队',publisher:'Max',license:'MIT',roles:[role('a','一线客服',['triage']),role('b','客服主管',['escalation'])],coordinatorRoleId:'b',
  skills:[{name:'triage',title:'Triage',resourceId:'triage',version:'1.0.0',text:skill('Triage','acme-ticket-triage'),license:'MIT'},{name:'escalation',title:'Escalation',resourceId:'escalation',version:'2.1.0',text:skill('Escalation','acme-escalation-desk'),license:'MIT'}]})
 // 共享静态资料：两个员工都经 role-knowledge 引用同一份正文。
 const manifest=JSON.parse(built.files.find(f=>f.path==='teloa.json')!.text),roles=manifest.resources.filter((r:any)=>r.kind==='role').map((r:any)=>r.id)
 manifest.resources.push({id:'support-guide',kind:'knowledge',title:'客服手册',version:'1.0.0',required:true,source:{kind:'local',path:'support-guide.md'}})
 manifest.relations.push(...roles.map((from:string)=>({kind:'role-knowledge',from,to:'support-guide'})))
 return readTemplateSharePackageV2({...built,files:[...built.files.map(f=>f.path==='teloa.json'?{path:f.path,text:JSON.stringify(manifest,null,2)}:f),{path:'support-guide.md',text:'# 客服手册\n\n退款需本人确认。'}]})
}

for(const scope of ['general','support']){
 test(`团队添加到${scope==='general'?'通用':'已有业务'}：两位员工各自绑定实际原生技能名、共享资料、结构化职责，协调关系从加载真源读回且恢复不重复`,async()=>{
  const owner='local:'+randomUUID(),space=randomUUID(),pkg=teamPackage(),storage=memory(),lose={load:true}
  let target=async():Promise<any>=>({kind:'new',spaceId:space,name:'工作空间'})
  if(scope!=='general'){
   // 先由另一份员工模板建立该业务，团队再加入这个已有业务与同一工作空间。
   const solo=buildSharePlan({subject:'employee',publisher:'Max',license:'MIT',roles:[{id:'x',name:'值班员',kind:'employee',duty:'值班。',dataScope:'工单。',executionScope:'只读。',skills:[],knowledge:[],responsibility:duties('值班员')}],skills:[]})
   assert.equal((await createShareAcceptance(memory(),{createRole:async()=>{throw Error('no')},industry:ports(owner,target)}).accept(solo,{skills:[],scope})).complete,true)
   const [existing]=(await services(owner).loads.list(owner,{})).items
   target=async()=>({kind:'existing',spaceId:space,expectedVersion:existing!.space.version})
  }
  const accept=()=>createShareAcceptance(storage,{createRole:async()=>{throw Error('v2 must not create roles directly')},industry:ports(owner,target,lose)})
  await assert.rejects(accept().accept(pkg,{skills:['triage','escalation'],scope}),/Lost reply/)
  const prepared=await accept().accept(pkg,{skills:['triage','escalation'],scope}),teamServices=services(owner)
  assert.equal(prepared.complete,false);assert.equal(prepared.coordinator,'pending')
  assert.equal((await teamServices.groups.list(owner,{})).length,0,'接收与准备岗位不会自动建群')
  assert.ok(prepared.loadId)
  const preparedLoad=await teamServices.loads.get(owner,{loadId:prepared.loadId})
  const preparedRoles=(await teamServices.industryRoles.list(owner,{})).items.map(row=>({itemInstanceId:row.itemInstanceId,state:row.state,...(row.role?{roleId:row.role.id}:{})}))
  const seed=industryTeamSeed(preparedLoad,preparedRoles);assert.ok(seed)
  const groupRequest={requestId:randomUUID(),expectedVersion:0,fields:{...seed,announcement:'',rules:{historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true}}}
  const group=await teamServices.groups.create(owner,groupRequest)
  assert.deepEqual(group.source,seed.source);assert.equal(group.coordinatorRoleId,seed.coordinatorRoleId)
  const result=await accept().accept(pkg,{skills:['triage','escalation'],scope})
  assert.equal(result.complete,true,JSON.stringify(result))
  assert.equal(result.groupId,group.id,'只有真实同来源群回读才完成')
  assert.deepEqual(result.skills.map(s=>[s.resourceId,s.nativeName]),[['triage','acme-ticket-triage'],['escalation','acme-escalation-desk']])
  const loadCount=async()=>(await pool.query('select count(*)::int n from teloa_industry_loads where owner_id=$1',[owner])).rows[0].n,expectedLoads=scope==='general'?1:2
  assert.equal(await loadCount(),expectedLoads,'the lost load reply is resumed, not loaded twice')

  // 刷新后：全新服务实例只读数据库。
  const s=services(owner),load=(await s.loads.list(owner,{})).items.find(row=>row.id===result.loadId),roles=(await s.roles.list(owner,{})).filter(r=>r.name!=='值班员')
  assert.equal(load!.scope,scope);assert.equal(load!.space.id,space);assert.equal(roles.length,2,'each employee exists exactly once')
  const byName=(name:string)=>roles.find(r=>r.name===name)!
  assert.deepEqual(byName('一线客服').skills,['acme-ticket-triage'],'bound to the installed native name, not the resource id')
  assert.deepEqual(byName('客服主管').skills,['acme-escalation-desk'])
  assert.deepEqual(byName('一线客服').responsibility,duties('一线客服'));assert.deepEqual(byName('客服主管').responsibility,duties('客服主管'))
  assert.ok(roles.every(r=>r.scopes.length===1&&r.scopes[0]===scope&&r.kind==='employee'))
  assert.ok(roles.every(r=>r.state==='paused'),'显式建群不激活员工')
  const knowledgeIds=new Set(roles.flatMap(r=>r.knowledge));assert.equal(knowledgeIds.size,1,'the shared guide is one real resource');assert.ok(roles.every(r=>r.knowledge.length===1))
  const instances=(await s.industryRoles.list(owner,{})).items.map(row=>({itemInstanceId:row.itemInstanceId,state:row.state,...(row.role?{roleId:row.role.id}:{})}))
  assert.deepEqual(teamCoordination(load!,instances),{coordinatorRoleId:byName('客服主管').id,memberRoleIds:[byName('一线客服').id]})
  assert.equal(result.coordinatorRoleId,byName('客服主管').id)
  const stored=(await pool.query('select relations from teloa_industry_loads where id=$1',[load!.id])).rows[0].relations
  assert.equal(stored.filter((l:any)=>l.kind==='role-coordination').length,1,'the coordination is persisted on the load itself')
  const usages=(await s.skills.list(owner,{})).usages.filter(u=>u.loadId===load!.id);assert.equal(usages.length,2,'each installed skill is bound to its load item')

  // 不同选择拒绝；原选择沿同一持久回执恢复，不重复创建。
  await assert.rejects(accept().accept(pkg,{skills:[],scope:'other'}),{code:'acceptance-choice-conflict'})
  const again=await accept().accept(pkg,{skills:['triage','escalation'],scope})
  assert.deepEqual(again.roleIds.sort(),result.roleIds.sort());assert.equal((await s.roles.list(owner,{})).filter(r=>r.name!=='值班员').length,2)
  assert.equal(again.groupId,group.id)
  assert.deepEqual(await s.groups.create(owner,groupRequest),group,'同请求冷恢复返回原群')
  assert.equal((await s.groups.list(owner,{})).length,1)
  assert.equal(await loadCount(),expectedLoads)
 })
}

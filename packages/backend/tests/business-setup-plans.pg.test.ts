import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {Pool,stopTestContainer} from './postgres-test-lifecycle.ts'
import {initializeTeloaDatabase} from '../src/work/initialize-database.ts'
import {BusinessSetupPlanService,businessSetupRequestId} from '../src/work/business-setup-plans.ts'
import {BusinessConfigurationDraftService} from '../src/work/business-configuration-drafts.ts'
import {BusinessConfigurationStore} from '../src/work/business-configuration-store.ts'
import {BusinessConfigurationService} from '../src/work/business-configuration.ts'
import {BusinessConfigurationPreviewService} from '../src/work/business-configuration-preview.ts'
import {BusinessDefinitionSourceReader} from '../src/work/business-definition-source.ts'
import {BusinessRuntimeService} from '../src/work/business-runtime.ts'
import {BusinessSpaceService} from '../src/work/business-spaces.ts'
import {MarketContentStore,readMarketBusinessConfigurationResource} from '../src/market/content-store.ts'
import {IndustryLoadService} from '../src/work/industry-loads.ts'
import {createIndustryLoadSource} from '../src/work/industry-load-source.ts'
import {IndustryRoleService} from '../src/work/industry-roles.ts'
import {IndustryRoleSource} from '../src/work/industry-role-source.ts'
import {RoleService} from '../src/work/roles.ts'
import {IndustryPlanService} from '../src/work/industry-plans.ts'
import {IndustryPlanSource} from '../src/work/industry-plan-source.ts'
import {IndustryWorkSource} from '../src/work/industry-work-source.ts'
import {PlanService} from '../src/work/plans.ts'
import {PlanOccurrenceService} from '../src/work/plan-occurrences.ts'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {BusinessConversationBindingService} from '../src/work/business-conversation-bindings.ts'
import {ConversationService,FileConversationRepository} from '../src/work/conversations.ts'
import {createBusinessSetupPlanHandler} from '../../harness-dsh/src/business-setup-plan.ts'

let pool:Pool,container:StartedPostgreSqlContainer
const identity={id:randomUUID,now:()=>new Date().toISOString()},unavailable=async():Promise<never>=>{throw Error('禁止真实模型或外部请求')}
before(async()=>{process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock');process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock';container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()});await initializeTeloaDatabase(pool)},{timeout:120000})
after(async()=>{await pool?.end();await stopTestContainer(container)})
function services(){
 const drafts=new BusinessConfigurationDraftService(pool,identity),store=new BusinessConfigurationStore(pool),market=new MarketContentStore(pool,identity),loads=new IndustryLoadService(pool,identity,createIndustryLoadSource(market)),roles=new RoleService(pool,identity)
 const definitions=new BusinessDefinitionSourceReader({get:unavailable,getInTransaction:unavailable},{get:unavailable,getInTransaction:unavailable,listInTransaction:async()=>({items:[],hasMore:false})},{activeSourceIds:unavailable},undefined,store)
 const configuration=new BusinessConfigurationService(pool,identity,{drafts,store,definitions,runtime:new BusinessRuntimeService(pool,identity),spaces:new BusinessSpaceService(pool,identity)}),preview=new BusinessConfigurationPreviewService(pool,drafts,definitions,identity)
 const industryRoles=new IndustryRoleService(pool,identity,loads,new IndustryRoleSource(market,loads),{get:unavailable},roles),planEngine=new PlanService(pool,identity,market),plans=new IndustryPlanService(pool,identity,new IndustryPlanSource(market,loads,new IndustryWorkSource(market,loads)),planEngine)
 let prepared=0,failRole=false,losePrepare=false
 const readiness=async(loadId:string)=>{const load=await loads.get(actor.ownerId,{loadId});return {loadId,digest:'a'.repeat(64),rows:load.items.filter(i=>i.kind!=='business-configuration').map(item=>({itemInstanceId:item.instanceId,kind:item.kind,title:item.title,state:item.kind==='plan'?'optional':'auto'}))}}
 const actor={ownerId:'setup:'+randomUUID(),scopeIds:[] as string[]}
 const setup=new BusinessSetupPlanService(pool,{drafts,configuration,preview,market,roles:{get:roles.get.bind(roles),editInTransaction:async(...args)=>{if(failRole)throw Error('模拟员工写入失败');return roles.editInTransaction(...args)}},loads,industryRoles,plans,readiness,prepare:async(loadId,_digest,options)=>{assert.equal(options.activate,false);prepared++;const load=await loads.get(actor.ownerId,{loadId});for(const item of load.items.filter(i=>i.kind==='role'))await industryRoles.instantiate(actor.ownerId,{requestId:businessSetupRequestId(loadId,item.instanceId),loadId,itemInstanceId:item.instanceId});if(losePrepare){losePrepare=false;throw Error('准备成功后模拟丢回包')}return {results:[],readiness:await readiness(loadId)}}},identity)
 return {actor,drafts,configuration,preview,setup,roles,loads,market,plans,planEngine,prepared:()=>prepared,losePrepare:()=>{losePrepare=true},failRole:(value=true)=>{failRole=value}}
}
const field={name:'name',label:'名称',from:'名称',type:'text',required:true},extra={name:'date',label:'上线日期',from:'上线日期',type:'datetime',required:false}
const responsibility={triggers:[],autonomousActions:[],confirmationPoints:[],escalationRules:[],deliveryChecks:[]}
async function fixture(withResources=true){
 const s=services(),draft=await s.drafts.begin(s.actor,{requestId:randomUUID(),title:'客户支持',format:'teloa.business-configuration/v2'})
 const definition={format:'teloa.business-object-type/v2',id:'ticket',version:'1.0.0',domain:draft.scope,title:'工单',unit:'条',lead:'跟进',sourceId:draft.candidate.sources[0]!.sourceId,fields:[field,extra]}
 const saved=await s.drafts.revise(s.actor,{requestId:randomUUID(),draftId:draft.id,expectedRevision:1,patch:{upsertDefinitions:[{kind:'object-type',definition}],upsertPages:[{id:'tickets',title:'工单',kind:'records',objectType:'ticket',fields:['name'],allowCreate:true,allowEdit:true,allowArchive:true}],homePageId:'tickets'}})
 const resources=withResources?[{id:'operator',kind:'role',title:'工单员',version:'1.0.0',required:true,source:{kind:'local',path:'role.json'}},{id:'work',kind:'work-template',title:'核对工单',version:'1.0.0',required:true,source:{kind:'local',path:'work.json'}},{id:'daily',kind:'plan',title:'每日汇总',version:'1.0.0',required:true,source:{kind:'local',path:'plan.json'}}]:[]
 const manifest={format:'teloa.business-package/v4',id:'support',title:'客户支持',version:'1.0.0',domain:'support',scope:draft.scope,description:'核对客户工单，待本人授权连接。',resources,relations:withResources?[{kind:'role-work',from:'operator',to:'work'},{kind:'role-work',from:'operator',to:'daily'}]:[],entrypoints:withResources?['work']:[]}
 // 至少一个配置资源会由宿主补入；包校验前可直接提供当前页面。
 const config={format:'teloa.business-dashboard-resource/v1',id:'configuration',version:'1.0.0',configuration:saved.candidate}
 manifest.resources.push({id:'configuration',kind:'business-configuration',title:'工单页面',version:'1.0.0',required:true,source:{kind:'local',path:'configuration.json'}})
 const files=[{path:'teloa.json',text:JSON.stringify(manifest)},{path:'configuration.json',text:JSON.stringify(config)},...(withResources?[
  {path:'role.json',text:JSON.stringify({format:'teloa.role/v1',name:'工单员',kind:'employee',duty:'核对工单',dataScope:'资料',executionScope:'代拟',responsibility})},
  {path:'work.json',text:JSON.stringify({format:'teloa.work-template/v1',id:'work',title:'核对工单',version:'1.0.0',domain:draft.scope,description:'核对未结工单',requirements:['资料'],output:'工单简报',skills:[]})},
  {path:'plan.json',text:JSON.stringify({format:'teloa.plan/v1',version:'1.0.0',title:'每日汇总',workTemplate:'work',dataScope:'资料',trigger:{kind:'schedule',cadence:'daily',weekday:1,time:'09:00',timezone:'Asia/Singapore'}})}]:[])]
 const request={requestId:randomUUID(),draftId:draft.id,expectedRevision:0,package:{manifestPath:'teloa.json',files},roleEdits:[]}
 const plan=await s.setup.revise(s.actor,request)
 return {...s,draft:saved,plan,request}
}
const applyInput=(preview:Awaited<ReturnType<BusinessSetupPlanService['preview']>>)=>({requestId:randomUUID(),draftId:preview.draftId,expectedRevision:preview.revision,expectedDigest:preview.digest,previewReceipt:preview.receipt})
test('E05：方案列表按本人/范围/已绑定未采用状态过滤，旧库超过16份仍限制回包且零写入',async()=>{
 const f=await fixture(false),scope=f.draft.scope,actor={...f.actor,scopeIds:[scope]}
 const stored=(await pool.query('select body from teloa_business_setup_plans where owner_id=$1 and draft_id=$2',[actor.ownerId,f.draft.id])).rows[0].body
 // 这是恢复后已有行的目录夹具；正常 begin 的16份限制已有独立契约，不在此绕过它发起业务创建。
 const seed=async(i:number,options:{owner?:string;scope?:string;bound?:boolean;planState?:string;draftState?:string}={})=>{
  const owner=options.owner??actor.ownerId,id=randomUUID(),sessionId='setup-list-'+randomUUID(),targetScope=options.scope??scope
  const body=structuredClone(stored);body.plan={...body.plan,draftId:id,title:'目录合成方案 '+i,state:options.planState??'draft',updatedAt:new Date(Date.UTC(2030,0,1,0,0,i)).toISOString()}
  await pool.query('insert into teloa_business_configuration_drafts(owner_id,id,scope_id,revision,base_version,candidate,hash,status,created_at,updated_at) select $1,$2,$3,revision,base_version,candidate,hash,$4,created_at,updated_at from teloa_business_configuration_drafts where owner_id=$5 and id=$6',[owner,id,targetScope,options.draftState??'draft',actor.ownerId,f.draft.id])
  await pool.query('insert into teloa_business_setup_plans values($1,$2,$3)',[owner,id,JSON.stringify(body)])
  await pool.query("insert into teloa_business_conversation_bindings(owner_id,request_id,kind,title,draft_id,session_id,created_at,updated_at) values($1,$2,'builder',$3,$4,$5,now(),now())",[owner,randomUUID(),body.plan.title,id,options.bound===false?null:sessionId])
  return {draftId:id,scope,title:body.plan.title,revision:body.plan.revision,sessionId}
 }
 const included=[];for(let i=0;i<18;i++)included.push(await seed(i))
 for(const [i,options] of [[30,{bound:false}],[31,{planState:'applied'}],[32,{draftState:'applied'}],[33,{scope:'other-scope'}],[34,{owner:'other-owner'}]] as const)await seed(i,options)
 const handler=createBusinessSetupPlanHandler(actor.ownerId,async()=>actor.scopeIds,async()=>({setup:f.setup,bindings:{bySession:unavailable}}))
 const snapshot=async()=>({plans:(await pool.query('select * from teloa_business_setup_plans order by owner_id,draft_id')).rows,requests:(await pool.query('select * from teloa_business_setup_requests order by owner_id,request_id')).rows})
 const before=await snapshot()
 assert.deepEqual(await handler('business-setup-plan/list',{scope}),{items:included.slice(-16).reverse()})
 await assert.rejects(handler('business-setup-plan/list',{scope:'other-scope'}),{code:'teloa/forbidden'})
 await assert.rejects(handler('business-setup-plan/list',{scope,ownerId:'other-owner'}),{code:'teloa/invalid-input'})
 assert.deepEqual(await snapshot(),before);assert.equal(f.prepared(),0)
})
test('E05：原会话就绪查询无加载时为空，有加载时只读当前readiness，拒绝错归属且不准备',async t=>{
 const f=await fixture(),root=await mkdtemp(join(tmpdir(),'teloa-setup-readiness-'))
 t.after(()=>rm(root,{recursive:true,force:true}))
 const conversations=new ConversationService(new FileConversationRepository(join(root,'conversations.json')),{create:async id=>id,inspect:async()=>{}},identity)
 const requestId=randomUUID(),title='就绪查询合成会话',native=await conversations.create(f.actor.ownerId,{requestId,title})
 // 复用真实已创建草案固定会话行；bySession 仍经过正式绑定服务、目录归属及草案校验。
 await pool.query("insert into teloa_business_conversation_bindings(owner_id,request_id,kind,title,draft_id,session_id,created_at,updated_at) values($1,$2,'builder',$3,$4,$5,now(),now())",[f.actor.ownerId,requestId,title,f.draft.id,native.sessionId])
 const bindings=new BusinessConversationBindingService(pool,identity,{drafts:f.drafts,conversations,contexts:{context:unavailable}})
 const handler=createBusinessSetupPlanHandler(f.actor.ownerId,async()=>f.actor.scopeIds,async()=>({setup:f.setup,bindings}))
 const input={sessionId:native.sessionId,draftId:f.draft.id}
 const snapshot=async()=>({plan:await f.setup.read(f.actor,{draftId:f.draft.id}),requests:(await pool.query('select count(*)::int n from teloa_business_setup_requests where owner_id=$1',[f.actor.ownerId])).rows[0].n,loads:(await pool.query('select count(*)::int n from teloa_industry_loads where owner_id=$1',[f.actor.ownerId])).rows[0].n,prepared:f.prepared()})
 const before=await snapshot();assert.equal(await handler('business-setup-plan/readiness',input),null);assert.deepEqual(await snapshot(),before)
 const preview=await f.setup.preview(f.actor,{draftId:f.draft.id,expectedRevision:f.plan.revision,rejected:[]})
 await f.setup.apply(f.actor,applyInput(preview));f.actor.scopeIds=[f.draft.scope]
 const loaded=await f.setup.prepare(f.actor,{draftId:f.draft.id}),loadId=loaded.adoption!.loadId!
 const afterLoad=await snapshot(),value=await handler('business-setup-plan/readiness',input)
 assert.deepEqual(value,await f.setup.ports.readiness(loadId));assert.equal(f.prepared(),0);assert.deepEqual(await snapshot(),afterLoad)
 const other=await conversations.create(f.actor.ownerId,{requestId:randomUUID(),title:'未绑定合成会话'})
 for(const bad of [{...input,sessionId:other.sessionId},{...input,draftId:randomUUID()},{...input,ownerId:'other-owner'}])await assert.rejects(handler('business-setup-plan/readiness',bad))
 const foreign=createBusinessSetupPlanHandler('other-owner',async()=>f.actor.scopeIds,async()=>({setup:f.setup,bindings}))
 await assert.rejects(foreign('business-setup-plan/readiness',input),{code:'teloa/forbidden'})
 t.mock.method(f.setup.ports,'readiness',async()=>{throw Error('合成就绪服务故障')})
 await assert.rejects(handler('business-setup-plan/readiness',input),/合成就绪服务故障/)
 assert.deepEqual(await snapshot(),afterLoad)
})
test('原草案完整采用后才加载scope；员工和自动化真实落地且保持暂停，恢复不重复',async()=>{
 const f=await fixture(),preview=await f.setup.preview(f.actor,{draftId:f.draft.id,expectedRevision:f.plan.revision,rejected:[]}),input=applyInput(preview)
 assert.equal((await pool.query('select 1 from teloa_industry_loads where owner_id=$1',[f.actor.ownerId])).rowCount,0)
 const adopted=await f.setup.apply(f.actor,input);f.actor.scopeIds=[f.draft.scope]
 assert.deepEqual(await f.setup.apply(f.actor,input),adopted)
 assert.equal(adopted.configuration.version,1)
 const space=(await pool.query('select s.id,s.version from teloa_business_scopes c join teloa_business_spaces s on s.id=c.space_id where c.owner_id=$1 and c.scope=$2',[f.actor.ownerId,f.draft.scope])).rows[0],loadInput={requestId:randomUUID(),contentId:adopted.contentId,contentHash:adopted.contentHash,target:{kind:'existing',spaceId:space.id,expectedVersion:space.version}}
 await assert.rejects(f.loads.create(f.actor.ownerId,loadInput),{code:'teloa/conflict'})
 await assert.rejects(f.loads.createForConfiguration(f.actor.ownerId,{...loadInput,requestId:randomUUID()},{scope:f.draft.scope,version:99,hash:adopted.configuration.configurationHash}),{code:'teloa/version-conflict'})
 assert.equal((await pool.query('select 1 from teloa_industry_loads where owner_id=$1',[f.actor.ownerId])).rowCount,0)
 const loaded=await f.setup.prepare(f.actor,{draftId:f.draft.id});assert.ok(loaded.adoption!.loadId);assert.equal(f.prepared(),0)
 const prepared=await f.setup.prepare(f.actor,{draftId:f.draft.id,expectedDigest:'a'.repeat(64)})
 assert.equal(f.prepared(),1)
 const employees=(await pool.query('select state from teloa_roles where owner_id=$1',[f.actor.ownerId])).rows
 assert.deepEqual(employees.map(r=>r.state),['paused'])
 const plans=(await pool.query('select state from teloa_plans where owner_id=$1',[f.actor.ownerId])).rows
 assert.deepEqual(plans.map(r=>r.state),['paused'])
 assert.equal(prepared.adoption!.steps.find(s=>s.kind==='plan')!.state,'done')
 await f.setup.prepare(f.actor,{draftId:f.draft.id,expectedDigest:'a'.repeat(64)})
 assert.equal((await pool.query('select 1 from teloa_roles where owner_id=$1',[f.actor.ownerId])).rowCount,1)
 assert.equal((await pool.query('select 1 from teloa_plans where owner_id=$1',[f.actor.ownerId])).rowCount,1)
})
test('逐项拒绝后固定内容与正式配置一致，旧预览不可采用，跨本人不可读',async()=>{
 const f=await fixture(false),first=await f.setup.preview(f.actor,{draftId:f.draft.id,expectedRevision:f.plan.revision,rejected:[]}),fieldChange=first.changes.find(c=>c.entity==='definition')!
 await assert.rejects(f.setup.preview(f.actor,{draftId:f.draft.id,expectedRevision:first.revision,rejected:[fieldChange.id]}),{code:'teloa/invalid-input'})
 const second=await f.setup.preview(f.actor,{draftId:f.draft.id,expectedRevision:first.revision,rejected:[]})
 assert.ok(second.revision>first.revision)
 await assert.rejects(f.setup.apply(f.actor,applyInput(first)),{code:'teloa/conflict'})
 await assert.rejects(f.setup.read({...f.actor,ownerId:'other'},{draftId:f.draft.id}),{code:'teloa/forbidden'})
})
test('字段子集与现有员工职责同事务采用；员工写失败回滚配置、决定和回执',async()=>{
 const f=await fixture(false),first=await f.setup.preview(f.actor,{draftId:f.draft.id,expectedRevision:f.plan.revision,rejected:[]})
 await f.setup.apply(f.actor,applyInput(first));f.actor.scopeIds=[f.draft.scope]
 const role=await f.roles.create(f.actor.ownerId,{requestId:randomUUID(),fields:{name:'质检员',kind:'employee',scopes:[f.draft.scope],duty:'核对',dataScope:'业务记录',executionScope:'代拟',skills:[],knowledge:[],responsibility}},{state:'paused'})
 let next=await f.drafts.begin(f.actor,{requestId:randomUUID(),scope:f.draft.scope,title:'调整'})
 const object=next.candidate.definitions.find(d=>d.kind==='object-type')!,definition={...object.definition,fields:[field,{...extra,label:'上线检查日期'},{name:'priority',label:'优先级',from:'优先级',type:'text',required:false}]}
 next=await f.drafts.revise(f.actor,{requestId:randomUUID(),draftId:next.id,expectedRevision:next.revision,patch:{upsertDefinitions:[{kind:'object-type',definition}]}})
 const pkg=structuredClone(f.request.package);pkg.files.find(file=>file.path==='configuration.json')!.text=JSON.stringify({format:'teloa.business-dashboard-resource/v1',id:'configuration',version:'1.0.0',configuration:next.candidate})
 const plan=await f.setup.revise(f.actor,{requestId:randomUUID(),draftId:next.id,expectedRevision:0,package:pkg,roleEdits:[{roleId:role.id,expectedVersion:role.version,duty:'核对并负责上线检查',responsibility:{...responsibility,deliveryChecks:['上线检查']}}]})
 const preview=await f.setup.preview(f.actor,{draftId:next.id,expectedRevision:plan.revision,rejected:[]}),rejected=preview.changes.find(c=>c.label.includes('优先级'))!
 const selected=await f.setup.preview(f.actor,{draftId:next.id,expectedRevision:preview.revision,rejected:[rejected.id]}),fixed=await f.setup.read(f.actor,{draftId:next.id})
 const content=await f.market.get({ownerId:f.actor.ownerId,kind:'human'},{contentId:fixed!.contentId}),configuration=readMarketBusinessConfigurationResource(content,'configuration').configuration
 assert.equal((configuration.definitions.find(d=>d.kind==='object-type')!.definition as any).fields.some((field:any)=>field.name==='priority'),false)
 const input=applyInput(selected);f.failRole()
 await assert.rejects(f.setup.apply(f.actor,input),/模拟员工写入失败/)
 assert.equal((await f.configuration.current(f.actor,{scope:f.draft.scope}))!.version,1)
 assert.equal((await f.roles.get(f.actor.ownerId,role.id))!.version,1)
 assert.equal((await f.setup.read(f.actor,{draftId:next.id}))!.state,'draft')
 assert.equal(await f.setup.receiptByRequest(f.actor,{requestId:input.requestId}),null)
 f.failRole(false);const saved=await f.setup.apply(f.actor,input)
 assert.equal(saved.configuration.version,2);assert.equal((await f.roles.get(f.actor.ownerId,role.id))!.version,2)
 assert.deepEqual(await f.setup.apply(f.actor,input),saved)
})
test('无有效变更的采用在首写前拒绝并给同请求同revision预览；全拒绝与仅新增资源分开',async()=>{
 const f=await fixture(false),first=await f.setup.preview(f.actor,{draftId:f.draft.id,expectedRevision:f.plan.revision,rejected:[]})
 await f.setup.apply(f.actor,applyInput(first));f.actor.scopeIds=[f.draft.scope]
 const next=await f.drafts.begin(f.actor,{requestId:randomUUID(),scope:f.draft.scope,title:'继续编辑'}),manual=await f.setup.manual(f.actor,{draftId:next.id})
 const unchanged=await f.setup.edit(f.actor,{requestId:randomUUID(),draftId:next.id,expectedRevision:0,configurationRevision:manual.configurationRevision,configurationHash:manual.configurationHash,candidate:manual.candidate,description:'只保存方案说明，不改变定义',roleEdits:[]})
 const preview=await f.setup.preview(f.actor,{draftId:next.id,expectedRevision:unchanged.revision,rejected:[]});assert.deepEqual(preview.changes,[])
 const check=async(value:typeof preview)=>{
  const input=applyInput(value),before=await f.configuration.current(f.actor,{scope:f.draft.scope}),draft=await f.drafts.get(f.actor,{draftId:next.id}),plan=await f.setup.read(f.actor,{draftId:next.id})
  await assert.rejects(f.setup.apply(f.actor,input),{code:'teloa/conflict',details:{reason:'setup-no-effective-changes',requestId:input.requestId,noWrites:true,preview:value}})
  assert.deepEqual(await f.configuration.current(f.actor,{scope:f.draft.scope}),before)
  assert.deepEqual(await f.drafts.get(f.actor,{draftId:next.id}),draft);assert.deepEqual(await f.setup.read(f.actor,{draftId:next.id}),plan)
  assert.equal(await f.setup.receiptByRequest(f.actor,{requestId:input.requestId}),null)
  assert.equal((await pool.query('select count(*)::int as n from teloa_business_setup_requests where owner_id=$1 and request_id=$2',[f.actor.ownerId,input.requestId])).rows[0].n,0)
 }
 await check(preview)
 const input=await f.setup.manual(f.actor,{draftId:next.id}),candidate={...input.candidate,title:'拟改名'}
 const changed=await f.setup.edit(f.actor,{requestId:randomUUID(),draftId:next.id,expectedRevision:input.revision,configurationRevision:input.configurationRevision,configurationHash:input.configurationHash,candidate,description:input.description,roleEdits:[]})
 const all=await f.setup.preview(f.actor,{draftId:next.id,expectedRevision:changed.revision,rejected:[]}),rejected=await f.setup.preview(f.actor,{draftId:next.id,expectedRevision:all.revision,rejected:all.changes.map(change=>change.id)})
 assert.ok(rejected.changes.length);await check(rejected)
 const current=await f.drafts.get(f.actor,{draftId:next.id}),pkg=structuredClone(f.request.package),manifest=JSON.parse(pkg.files.find(file=>file.path==='teloa.json')!.text)
 manifest.resources.push({id:'new-work',kind:'work-template',title:'新增分工',version:'1.0.0',required:true,source:{kind:'local',path:'new-work.json'}});manifest.entrypoints=['new-work']
 pkg.files.find(file=>file.path==='teloa.json')!.text=JSON.stringify(manifest);pkg.files.find(file=>file.path==='configuration.json')!.text=JSON.stringify({format:'teloa.business-dashboard-resource/v1',id:'configuration',version:'1.0.0',configuration:current.candidate})
 pkg.files.push({path:'new-work.json',text:JSON.stringify({format:'teloa.work-template/v1',id:'new-work',title:'新增分工',version:'1.0.0',domain:current.scope,description:'仅准备分工',requirements:['本轮资料'],output:'未发送草稿',skills:[]})})
 const withResource=await f.setup.revise(f.actor,{requestId:randomUUID(),draftId:next.id,expectedRevision:rejected.revision,package:pkg,roleEdits:[]}),resourcePreview=await f.setup.preview(f.actor,{draftId:next.id,expectedRevision:withResource.revision,rejected:[]})
 assert.deepEqual(resourcePreview.changes,[]);const adoption=await f.setup.apply(f.actor,applyInput(resourcePreview));assert.equal(adoption.configuration.version,2);assert.ok(adoption.steps.some(step=>step.kind==='work-template'&&step.state==='pending'))
})

test('宿主暂停计划不授予启用或调度；公共创建不可开启选项，过期/退休/跨业务岗位及损坏来源拒绝',async()=>{
 const f=await fixture(),preview=await f.setup.preview(f.actor,{draftId:f.draft.id,expectedRevision:f.plan.revision,rejected:[]})
 await f.setup.apply(f.actor,applyInput(preview));f.actor.scopeIds=[f.draft.scope]
 await f.setup.prepare(f.actor,{draftId:f.draft.id});const prepared=await f.setup.prepare(f.actor,{draftId:f.draft.id,expectedDigest:'a'.repeat(64)})
 const planId=prepared.adoption!.steps.find(s=>s.kind==='plan')!.objectId!,body=(await pool.query('select body from teloa_business_setup_plans where owner_id=$1 and draft_id=$2',[f.actor.ownerId,f.draft.id])).rows[0].body,input=body.planInputs.daily
 await assert.rejects(f.planEngine.change(f.actor.ownerId,{requestId:randomUUID(),planId,expectedVersion:1,action:'enable'}),{code:'teloa/conflict'})
 await assert.rejects(new PlanOccurrenceService(pool,{id:randomUUID},f.market).claim(f.actor.ownerId,{planId,now:'2030-01-02T02:00:00.000Z'}),{code:'teloa/conflict'})
 await assert.rejects(f.plans.create(f.actor.ownerId,{...input,requestId:randomUUID()}),{code:'teloa/conflict'})
 await assert.rejects(f.plans.create(f.actor.ownerId,{...input,requestId:randomUUID(),pausedEmployeeDraft:true}),{code:'teloa/invalid-input'})
 await assert.rejects(f.plans.createPaused(f.actor.ownerId,{...input,requestId:randomUUID(),expectedRoleVersion:input.expectedRoleVersion+1}),{code:'teloa/version-conflict'})
 await pool.query("update teloa_roles set state='retired' where id=$1",[input.roleId])
 await assert.rejects(f.plans.createPaused(f.actor.ownerId,{...input,requestId:randomUUID()}),{code:'teloa/conflict'})
 await pool.query("update teloa_roles set state='paused',definition=jsonb_set(definition,'{scopes}','[\"other\"]'::jsonb) where id=$1",[input.roleId])
 await assert.rejects(f.plans.createPaused(f.actor.ownerId,{...input,requestId:randomUUID()}),{code:'teloa/conflict'})
 await pool.query('update teloa_roles set definition=jsonb_set(definition,\'{scopes}\',$2::jsonb) where id=$1',[input.roleId,JSON.stringify([f.draft.scope])])
 await pool.query("update teloa_market_files set bytes=$2 where content_id=$1 and path='plan.json'",[prepared.contentId,Buffer.from('{}')])
 await assert.rejects(f.plans.createPaused(f.actor.ownerId,{...input,requestId:randomUUID()}))
 assert.equal((await pool.query('select 1 from teloa_plans where owner_id=$1',[f.actor.ownerId])).rowCount,1)
})

test('手动候选编辑绑定原草案与配置版本；保存不生效，旧预览失效后逐项复核采用',async()=>{
 const f=await fixture(false),first=await f.setup.preview(f.actor,{draftId:f.draft.id,expectedRevision:f.plan.revision,rejected:[]})
 const manual=await f.setup.manual(f.actor,{draftId:f.draft.id})
 const candidate=structuredClone(manual.candidate);candidate.title='人工调整客户支持'
 const object=candidate.definitions.find(d=>d.kind==='object-type')!;object.definition.fields.push({name:'priority',label:'优先级',from:'优先级',type:'enum',required:false,values:['普通','紧急']})
 candidate.pages[0]!.title='人工工单页'
 const request={requestId:randomUUID(),draftId:f.draft.id,expectedRevision:manual.revision,configurationRevision:manual.configurationRevision,configurationHash:manual.configurationHash,candidate,description:'人工调整业务说明',roleEdits:manual.roleEdits}
 const saved=await f.setup.edit(f.actor,request)
 assert.equal(saved.revision,manual.revision+1);assert.equal(saved.description,request.description)
 assert.equal((await pool.query('select 1 from teloa_business_configuration_heads where owner_id=$1',[f.actor.ownerId])).rowCount,0)
 assert.deepEqual(await f.setup.edit(f.actor,request),saved)
 await assert.rejects(f.setup.apply(f.actor,applyInput(first)),{code:'teloa/conflict'})
 await assert.rejects(f.setup.edit(f.actor,{...request,requestId:randomUUID()}),{code:'teloa/version-conflict'})
 const current=await f.setup.manual(f.actor,{draftId:f.draft.id});assert.equal(current.candidate.pages[0]!.title,'人工工单页')
 assert.equal((current.candidate.definitions.find(d=>d.kind==='object-type')!.definition as any).fields.at(-1).values[1],'紧急')
 const preview=await f.setup.preview(f.actor,{draftId:f.draft.id,expectedRevision:saved.revision,rejected:[]})
 assert.ok(preview.changes.some(c=>c.entity==='page'&&String((c.after as any).title)==='人工工单页'))
 await f.setup.apply(f.actor,applyInput(preview));f.actor.scopeIds=[f.draft.scope]
 assert.equal((await f.configuration.current(f.actor,{scope:f.draft.scope}))!.manifest.title,'人工调整客户支持')
})

test('正式配置固定历史回到新草案；重新采用追加版本且旧版本不变，不恢复运行授权',async()=>{
 const f=await fixture(false),first=await f.setup.preview(f.actor,{draftId:f.draft.id,expectedRevision:f.plan.revision,rejected:[]})
 await f.setup.apply(f.actor,applyInput(first));f.actor.scopeIds=[f.draft.scope]
 const second=await f.drafts.begin(f.actor,{requestId:randomUUID(),scope:f.draft.scope,title:'修改'})
 const manual=await f.setup.manual(f.actor,{draftId:second.id}),candidate={...manual.candidate,title:'新版业务名称'}
 const edited=await f.setup.edit(f.actor,{requestId:randomUUID(),draftId:second.id,expectedRevision:0,configurationRevision:manual.configurationRevision,configurationHash:manual.configurationHash,candidate,description:'第二版',roleEdits:[]})
 await f.setup.apply(f.actor,applyInput(await f.setup.preview(f.actor,{draftId:second.id,expectedRevision:edited.revision,rejected:[]})))
 const history=await f.setup.history(f.actor,{scope:f.draft.scope});assert.deepEqual(history.items.map(v=>v.version),[2,1]);assert.equal(history.currentVersion,2)
 const old=history.items[1]!,third=await f.drafts.begin(f.actor,{requestId:randomUUID(),scope:f.draft.scope,title:'回到旧版'}),snapshot=await f.setup.manual(f.actor,{draftId:third.id})
 const input={requestId:randomUUID(),draftId:third.id,expectedRevision:0,configurationRevision:snapshot.configurationRevision,configurationHash:snapshot.configurationHash,version:old.version,expectedHash:old.hash}
 await assert.rejects(f.setup.restore(f.actor,{...input,expectedHash:'f'.repeat(64)}),{code:'teloa/version-conflict'})
 const restored=await f.setup.restore(f.actor,input);assert.deepEqual(await f.setup.restore(f.actor,input),restored)
 assert.equal((await f.configuration.current(f.actor,{scope:f.draft.scope}))!.version,2)
 const preview=await f.setup.preview(f.actor,{draftId:third.id,expectedRevision:restored.revision,rejected:[]})
 assert.equal((await f.setup.apply(f.actor,applyInput(preview))).configuration.version,3)
 const after=await f.setup.history(f.actor,{scope:f.draft.scope});assert.equal(after.items[2]!.hash,old.hash);assert.equal(after.items[0]!.title,'客户支持')
 assert.equal((await pool.query('select 1 from teloa_roles where owner_id=$1',[f.actor.ownerId])).rowCount,0)
 assert.equal((await pool.query('select 1 from teloa_industry_loads where owner_id=$1',[f.actor.ownerId])).rowCount,0)
 await assert.rejects(f.setup.history({...f.actor,scopeIds:[]},{scope:f.draft.scope}),{code:'teloa/forbidden'})
})

test('准备阶段落地后丢回包保存unknown；沿原load恢复不重复员工与暂停计划',async()=>{
 const f=await fixture(),preview=await f.setup.preview(f.actor,{draftId:f.draft.id,expectedRevision:f.plan.revision,rejected:[]})
 await f.setup.apply(f.actor,applyInput(preview));f.actor.scopeIds=[f.draft.scope]
 const loaded=await f.setup.prepare(f.actor,{draftId:f.draft.id});f.losePrepare()
 await assert.rejects(f.setup.prepare(f.actor,{draftId:f.draft.id,expectedDigest:'a'.repeat(64)}),/模拟丢回包/)
 const unknown=await f.setup.read(f.actor,{draftId:f.draft.id});assert.equal(unknown!.adoption!.preparation!.state,'unknown');assert.equal(unknown!.adoption!.loadId,loaded.adoption!.loadId)
 assert.equal((await pool.query('select 1 from teloa_roles where owner_id=$1',[f.actor.ownerId])).rowCount,1)
 const restored=await f.setup.prepare(f.actor,{draftId:f.draft.id,expectedDigest:'a'.repeat(64)})
 assert.equal(restored.adoption!.preparation!.state,'finished');assert.equal(restored.adoption!.loadId,loaded.adoption!.loadId)
 assert.equal((await pool.query('select 1 from teloa_roles where owner_id=$1',[f.actor.ownerId])).rowCount,1)
 assert.equal((await pool.query("select 1 from teloa_plans where owner_id=$1 and state='paused'",[f.actor.ownerId])).rowCount,1)
})

function localSourceMapping(scope:string){return {kind:'source-mapping' as const,definition:{format:'teloa.business-source-mapping/v1' as const,id:'local-ordered',version:'1.0.0',domain:scope,title:'本人本地同步',objectType:'ticket',source:{kind:'mcp-tool' as const,serverName:'local-owner-only',tool:'list_records',arguments:{syntheticPrivate:'local-only-not-a-credential'},itemsPath:'$.items'},mapping:[{path:'$.name',field:'name'}],primaryKey:['name'],incrementalCursor:{kind:'timestamp' as const,path:'$.updatedAt'},deletionSemantics:'tombstone' as const,deletedAtPath:'$.deletedAt',schedule:{kind:'every' as const,seconds:86400},acknowledgeShortInterval:false}}}

test('F13 local-owner：正式绑定handler手动映射保留完整候选，portable投影无绑定，逐项预览采用及准备仍绑定完整配置',async t=>{
 const f=services(),root=await mkdtemp(join(tmpdir(),'teloa-local-configuration-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const conversations=new ConversationService(new FileConversationRepository(join(root,'conversations.json')),{create:async id=>id,inspect:async()=>{}},identity)
 const bindings=new BusinessConversationBindingService(pool,identity,{drafts:f.drafts,conversations,contexts:{context:unavailable}}),requestId=randomUUID(),title='本人本地配置'
 const reserved=await bindings.reserve(f.actor,{requestId,kind:'builder',title}),native=await conversations.create(f.actor.ownerId,{requestId,title}),binding=await bindings.bind(f.actor,{requestId,sessionId:native.sessionId})
 assert.equal(binding.draftId,reserved.draftId);const draft=await f.drafts.get(f.actor,{draftId:binding.draftId!});f.actor.scopeIds=[draft.scope]
 const handler=createBusinessSetupPlanHandler(f.actor.ownerId,async()=>f.actor.scopeIds,async()=>({setup:f.setup,bindings})),target={sessionId:native.sessionId,draftId:draft.id},manual=await handler('business-setup-plan/manual',target) as Awaited<ReturnType<typeof f.setup.manual>>
 const mapping=localSourceMapping(draft.scope),candidate={...manual.candidate,definitions:[{kind:'object-type' as const,definition:{format:'teloa.business-object-type/v2' as const,id:'ticket',version:'1.0.0',domain:draft.scope,title:'工单',unit:'条',lead:'本地',sourceId:manual.candidate.sources[0]!.sourceId,fields:[field]}},mapping],pages:[{id:'records',title:'工单',kind:'records' as const,objectType:'ticket',fields:['name'],allowCreate:false,allowEdit:false,allowArchive:false}],homePageId:'records'}
 const input={...target,requestId:randomUUID(),expectedRevision:manual.revision,configurationRevision:manual.configurationRevision,configurationHash:manual.configurationHash,candidate,description:'本人显式准备，未授任何读取权限',roleEdits:[]},saved=await handler('business-setup-plan/edit',input) as Awaited<ReturnType<typeof f.setup.edit>>
 assert.deepEqual(await handler('business-setup-plan/edit',input),saved)
 const currentManual=await f.setup.manual(f.actor,{draftId:draft.id});assert.deepEqual(currentManual.candidate.definitions.find(d=>d.kind==='source-mapping'),mapping)
 const content=await f.market.get({ownerId:f.actor.ownerId,kind:'human'},{contentId:saved.contentId}),portable=readMarketBusinessConfigurationResource(content,'business-configuration').configuration
 assert.ok(!portable.definitions.some(d=>d.kind==='source-mapping'));assert.ok(portable.definitions.every(d=>d.kind!=='object-type'||d.definition.defaultAction===undefined));assert.ok(!content.files.some(f=>Buffer.from(f.bytes).includes(Buffer.from('local-only-not-a-credential'))))
 assert.equal((await pool.query('select 1 from teloa_business_configuration_heads where owner_id=$1',[f.actor.ownerId])).rowCount,0)
 await assert.rejects(handler('business-setup-plan/edit',{...input,requestId:randomUUID()}),{code:'teloa/version-conflict'})
 const wrongSource=structuredClone(currentManual.candidate);wrongSource.sources[0]!.sourceId='unrelated-source';wrongSource.definitions.find(d=>d.kind==='object-type')!.definition.sourceId='unrelated-source'
 await assert.rejects(handler('business-setup-plan/edit',{...input,requestId:randomUUID(),expectedRevision:currentManual.revision,configurationRevision:currentManual.configurationRevision,configurationHash:currentManual.configurationHash,candidate:wrongSource}),{code:'teloa/forbidden'})
 const foreign=createBusinessSetupPlanHandler('foreign-owner',async()=>[draft.scope],async()=>({setup:f.setup,bindings}));await assert.rejects(foreign('business-setup-plan/manual',target),{code:'teloa/forbidden'})
 const preview=await handler('business-setup-plan/preview',{...target,expectedRevision:saved.revision,rejected:[]}) as Awaited<ReturnType<typeof f.setup.preview>>
 assert.ok(preview.changes.some(c=>c.id==='definition:source-mapping:local-ordered'))
 await assert.rejects(handler('business-setup-plan/apply',{...target,...applyInput(preview),previewReceipt:'f'.repeat(64)}),{code:'teloa/conflict'})
 const applied=await handler('business-setup-plan/apply',{...target,...applyInput(preview)}) as Awaited<ReturnType<typeof f.setup.apply>>
 const full=await f.configuration.current(f.actor,{scope:draft.scope});assert.equal(full!.version,applied.configuration.version);assert.ok(full!.leaves.some(l=>l.kind==='source-mapping'&&JSON.parse(l.body).source.arguments.syntheticPrivate==='local-only-not-a-credential'))
 const loaded=await f.setup.prepare(f.actor,{draftId:draft.id});assert.ok(loaded.adoption!.loadId);assert.equal(f.prepared(),0)
 assert.equal((await pool.query('select 1 from teloa_plans where owner_id=$1',[f.actor.ownerId])).rowCount,0)
})

test('F13 local-owner：foreign portable包仍拒绝同步绑定，不能借本地标记绕过',async()=>{
 const f=await fixture(false),pkg=structuredClone(f.request.package),config=JSON.parse(pkg.files.find(f=>f.path==='configuration.json')!.text);config.configuration.definitions.push(localSourceMapping(f.draft.scope));pkg.files.find(f=>f.path==='configuration.json')!.text=JSON.stringify(config)
 await assert.rejects(f.setup.revise(f.actor,{requestId:randomUUID(),draftId:f.draft.id,expectedRevision:f.plan.revision,package:pkg,roleEdits:[]}),{code:'teloa/invalid-input'})
 const actionPackage=structuredClone(f.request.package),actionConfig=JSON.parse(actionPackage.files.find(f=>f.path==='configuration.json')!.text);actionConfig.configuration.definitions.find((d:any)=>d.kind==='object-type').definition.defaultAction='foreign-private-action';actionPackage.files.find(f=>f.path==='configuration.json')!.text=JSON.stringify(actionConfig)
 await assert.rejects(f.setup.revise(f.actor,{requestId:randomUUID(),draftId:f.draft.id,expectedRevision:f.plan.revision,package:actionPackage,roleEdits:[]}),{code:'teloa/invalid-input'})
 const manual=await f.setup.manual(f.actor,{draftId:f.draft.id})
 await assert.rejects(f.setup.edit(f.actor,{requestId:randomUUID(),draftId:f.draft.id,expectedRevision:manual.revision,configurationRevision:manual.configurationRevision,configurationHash:manual.configurationHash,candidate:manual.candidate,description:'不能提供本地内部标记',roleEdits:[],localOwnerConfiguration:true}),{code:'teloa/invalid-input'})
 assert.equal((await pool.query('select 1 from teloa_business_configuration_heads where owner_id=$1',[f.actor.ownerId])).rowCount,0)
})

test('F13 local-owner：默认动作保存保留而portable剥离，未绑定动作仍由原来源校验拒绝采用',async()=>{
 const f=await fixture(false),manual=await f.setup.manual(f.actor,{draftId:f.draft.id}),candidate=structuredClone(manual.candidate)
 candidate.definitions.find(d=>d.kind==='object-type')!.definition.defaultAction='owner-private-action'
 const edited=await f.setup.edit(f.actor,{requestId:randomUUID(),draftId:f.draft.id,expectedRevision:manual.revision,configurationRevision:manual.configurationRevision,configurationHash:manual.configurationHash,candidate,description:'保留本地动作，不执行或授予',roleEdits:[]})
 const content=await f.market.get({ownerId:f.actor.ownerId,kind:'human'},{contentId:edited.contentId}),portable=readMarketBusinessConfigurationResource(content,'configuration').configuration
 assert.ok(portable.definitions.every(d=>d.kind!=='object-type'||d.definition.defaultAction===undefined))
 assert.equal((await f.setup.manual(f.actor,{draftId:f.draft.id})).candidate.definitions.find(d=>d.kind==='object-type')!.definition.defaultAction,'owner-private-action')
 await assert.rejects(f.setup.preview(f.actor,{draftId:f.draft.id,expectedRevision:edited.revision,rejected:[]}),(error:unknown)=>error instanceof Error&&'code'in error&&error.code==='teloa/source-unavailable')
 assert.equal((await pool.query('select 1 from teloa_business_configuration_heads where owner_id=$1',[f.actor.ownerId])).rowCount,0)
})

test('F13 local-owner：仅绑定变化时portable摘要相同但完整候选与旧预览不可混用',async()=>{
 const f=await fixture(false),first=await f.setup.manual(f.actor,{draftId:f.draft.id}),candidate=structuredClone(first.candidate);candidate.definitions.push(localSourceMapping(f.draft.scope))
 const edit={requestId:randomUUID(),draftId:f.draft.id,expectedRevision:first.revision,configurationRevision:first.configurationRevision,configurationHash:first.configurationHash,candidate,description:'同一静态页面的本地来源修订',roleEdits:[]},one=await f.setup.edit(f.actor,edit),oldPreview=await f.setup.preview(f.actor,{draftId:f.draft.id,expectedRevision:one.revision,rejected:[]})
 const next=await f.setup.manual(f.actor,{draftId:f.draft.id}),changed=structuredClone(next.candidate),mapping=changed.definitions.find(d=>d.kind==='source-mapping')!;mapping.definition.source={kind:'mcp-tool',serverName:'another-local-only',tool:'list_records',arguments:{syntheticPrivate:'second-local-only'},itemsPath:'$.items'}
 const two=await f.setup.edit(f.actor,{...edit,requestId:randomUUID(),expectedRevision:next.revision,configurationRevision:next.configurationRevision,configurationHash:next.configurationHash,candidate:changed})
 assert.equal(two.contentHash,one.contentHash);assert.notEqual(two.configurationHash,one.configurationHash)
 await assert.rejects(f.setup.apply(f.actor,applyInput(oldPreview)),{code:'teloa/conflict'})
 const fresh=await f.setup.preview(f.actor,{draftId:f.draft.id,expectedRevision:two.revision,rejected:[]});assert.notEqual(fresh.digest,oldPreview.digest)
 await assert.rejects(f.setup.apply(f.actor,{...applyInput(fresh),previewReceipt:oldPreview.receipt}),{code:'teloa/conflict'})
 await f.setup.apply(f.actor,applyInput(fresh));f.actor.scopeIds=[f.draft.scope]
 const full=await f.configuration.current(f.actor,{scope:f.draft.scope});assert.equal(JSON.parse(full!.leaves.find(l=>l.kind==='source-mapping')!.body).source.serverName,'another-local-only')
 assert.equal(f.prepared(),0);assert.equal((await pool.query('select 1 from teloa_task_runs where owner_id=$1',[f.actor.ownerId])).rowCount,0)
})

for(const mode of ['empty','work-only','portable-and-work'] as const)test('F13 revise-after-local：'+mode+' 正常public续完整方案保持本地绑定及原actor/版本',async t=>{
 const f=services(),root=await mkdtemp(join(tmpdir(),'teloa-local-revise-'));t.after(()=>rm(root,{recursive:true,force:true}));const conversations=new ConversationService(new FileConversationRepository(join(root,'conversations.json')),{create:async id=>id,inspect:async()=>{}},identity),bindings=new BusinessConversationBindingService(pool,identity,{drafts:f.drafts,conversations,contexts:{context:unavailable}}),requestId=randomUUID(),title='本地编辑后追加分工'
 const reserved=await bindings.reserve(f.actor,{requestId,kind:'builder',title}),native=await conversations.create(f.actor.ownerId,{requestId,title});await bindings.bind(f.actor,{requestId,sessionId:native.sessionId});const draft=await f.drafts.get(f.actor,{draftId:reserved.draftId!});f.actor.scopeIds=[draft.scope]
 const handler=createBusinessSetupPlanHandler(f.actor.ownerId,async()=>f.actor.scopeIds,async()=>({setup:f.setup,bindings})),target={sessionId:native.sessionId,draftId:draft.id},manual=await f.setup.manual(f.actor,{draftId:draft.id}),mapping=localSourceMapping(draft.scope),candidate={...manual.candidate,definitions:[{kind:'object-type' as const,definition:{format:'teloa.business-object-type/v2' as const,id:'ticket',version:'1.0.0',domain:draft.scope,title:'工单',unit:'条',lead:'本地',sourceId:manual.candidate.sources[0]!.sourceId,fields:[field]}},mapping],pages:[{id:'records',title:'工单',kind:'records' as const,objectType:'ticket',fields:['name'],allowCreate:false,allowEdit:false,allowArchive:false}],homePageId:'records'}
 const saved=await f.setup.edit(f.actor,{requestId:randomUUID(),draftId:draft.id,expectedRevision:0,configurationRevision:manual.configurationRevision,configurationHash:manual.configurationHash,candidate,description:'保持本人原本地来源',roleEdits:[]}),content=await f.market.get({ownerId:f.actor.ownerId,kind:'human'},{contentId:saved.contentId}),manifest=structuredClone(content.metadata) as any
 manifest.resources=mode==='portable-and-work'?manifest.resources:[];manifest.relations=[];manifest.entrypoints=[]
 const files=mode==='portable-and-work'?content.files.map(f=>({path:f.path,text:new TextDecoder().decode(f.bytes)})):[]
 if(mode!=='empty'){manifest.resources.push({id:'new-work',kind:'work-template',title:'新增分工',version:'1.0.0',required:true,source:{kind:'local',path:'new-work.json'}});manifest.entrypoints=['new-work'];files.push({path:'new-work.json',text:JSON.stringify({format:'teloa.work-template/v1',id:'new-work',title:'新增分工',version:'1.0.0',domain:draft.scope,description:'只准备不执行',requirements:['本轮合成材料'],output:'未发送草稿',skills:[]})})}
 const priorManifest=files.find(f=>f.path===content.manifestPath);if(priorManifest)priorManifest.text=JSON.stringify(manifest);else files.push({path:content.manifestPath,text:JSON.stringify(manifest)})
 const input={...target,requestId:randomUUID(),expectedRevision:saved.revision,package:{manifestPath:content.manifestPath,files},roleEdits:[]}
 if(mode==='portable-and-work')for(const forbiddenKind of ['mapping','defaultAction']){
  const attack=structuredClone(input),configurationFile=attack.package.files.find(f=>f.path===manifest.resources.find((r:any)=>r.kind==='business-configuration').source.path)!,resource=JSON.parse(configurationFile.text),unsafe=structuredClone(candidate)
  if(forbiddenKind==='defaultAction'){unsafe.definitions=unsafe.definitions.filter(d=>d.kind!=='source-mapping') as typeof unsafe.definitions;Object.assign(unsafe.definitions.find(d=>d.kind==='object-type')!.definition,{defaultAction:'foreign-host-action'})}
  resource.configuration=unsafe;configurationFile.text=JSON.stringify(resource);attack.requestId=randomUUID()
  await assert.rejects(handler('business-setup-plan/revise',attack),{code:'teloa/invalid-input'})
 }
 const revised=await handler('business-setup-plan/revise',input) as Awaited<ReturnType<typeof f.setup.revise>>
 assert.deepEqual(await handler('business-setup-plan/revise',input),revised);assert.equal(revised.revision,saved.revision+1)
 const full=await f.setup.manual(f.actor,{draftId:draft.id});assert.deepEqual(full.candidate.definitions.find(d=>d.kind==='source-mapping'),mapping)
 await assert.rejects(handler('business-setup-plan/revise',{...input,requestId:randomUUID()}),{code:'teloa/version-conflict'})
 const foreign=createBusinessSetupPlanHandler('foreign-owner',async()=>[draft.scope],async()=>({setup:f.setup,bindings}));await assert.rejects(foreign('business-setup-plan/revise',{...input,requestId:randomUUID(),expectedRevision:revised.revision}),{code:'teloa/forbidden'})
 const preview=await handler('business-setup-plan/preview',{...target,expectedRevision:revised.revision,rejected:[]}) as Awaited<ReturnType<typeof f.setup.preview>>;assert.ok(preview.changes.some(c=>c.id==='definition:source-mapping:local-ordered'))
 await handler('business-setup-plan/apply',{...target,...applyInput(preview)});const current=await f.configuration.current(f.actor,{scope:draft.scope});assert.equal(JSON.parse(current!.leaves.find(l=>l.kind==='source-mapping')!.body).source.serverName,'local-owner-only')
 if(mode!=='empty')assert.ok((await f.setup.read(f.actor,{draftId:draft.id}))!.adoption!.steps.some(s=>s.kind==='work-template'&&s.state==='pending'))
 assert.equal(f.prepared(),0);assert.equal((await pool.query('select 1 from teloa_task_runs where owner_id=$1',[f.actor.ownerId])).rowCount,0)
})

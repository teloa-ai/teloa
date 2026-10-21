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

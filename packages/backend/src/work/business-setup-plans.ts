import {createHash,createHmac,randomBytes} from 'node:crypto'
import type {Pool,PoolClient} from 'pg'
import {WorkError,taskInput,readRoleTemplateDefinition,readIndustryDataSourceDefinition,readIndustryMcpConnectionDefinition,readIndustryPluginDefinition,readScheduleTrigger,readBusinessConfigurationCandidateV2,type BusinessConfigurationCandidate,type BusinessConfigurationCandidateV2} from '@teloa/contract'
import {businessSetupUuid,readBusinessSetupPackage,readBusinessSetupRoleEdit,type BusinessSetupPlan,type BusinessSetupPreview,type BusinessSetupAdoption,type BusinessSetupRoleEdit,type BusinessSetupResource,type BusinessSetupStep,type BusinessSetupManual,type BusinessSetupHistory} from '@teloa/contract'
import {validateManifest,readMarketBusinessConfigurationResource,type MarketContent,type MarketContentStore} from '../market/content-store.ts'
import {BusinessConfigurationStore,businessConfigurationHash} from './business-configuration-store.ts'
import {lockBusinessConfigurationRequests,type BusinessConfigurationActor,type BusinessConfigurationDraftService} from './business-configuration-drafts.ts'
import type {BusinessConfigurationService} from './business-configuration.ts'
import type {BusinessConfigurationPreviewService} from './business-configuration-preview.ts'
import {readStoredRole,type RoleService} from './roles.ts'
import type {IndustryLoadService} from './industry-loads.ts'
import type {IndustryRoleService} from './industry-roles.ts'
import type {IndustryPlanService} from './industry-plans.ts'
import {businessSetupConfigurationChanges,selectBusinessSetupConfiguration} from './business-setup-plan-selection.ts'

type Candidate=BusinessConfigurationCandidate|BusinessConfigurationCandidateV2
type Stored={descriptionChange?:{before:string;after:string};plan:BusinessSetupPlan;baseline:Candidate;candidate:Candidate;originalContentId:string;originalContentHash:string;roleNames:Record<string,string>;preview?:BusinessSetupPreview;target?:{kind:'existing';spaceId:string;expectedVersion:number};planInputs:Record<string,unknown>}
export type BusinessSetupReadiness={loadId:string;digest:string;rows:{itemInstanceId:string;kind:string;title:string;state:string;entry?:string|null}[]}
export type BusinessSetupPlanPorts={
 drafts:Pick<BusinessConfigurationDraftService,'get'|'draftInTransaction'|'reviseInTransaction'|'upgradeFormatInTransaction'>
 configuration:Pick<BusinessConfigurationService,'applyInTransaction'>
 preview:Pick<BusinessConfigurationPreviewService,'previewInTransaction'>
 market:Pick<MarketContentStore,'import'|'get'|'getInTransaction'>
 roles:Pick<RoleService,'editInTransaction'|'get'>
 loads:Pick<IndustryLoadService,'createForConfiguration'|'get'>
 industryRoles:Pick<IndustryRoleService,'list'>
 plans:Pick<IndustryPlanService,'preview'|'createPaused'>
 readiness:(loadId:string)=>Promise<BusinessSetupReadiness>
 prepare:(loadId:string,digest:string,options:{activate:false})=>Promise<{readiness:BusinessSetupReadiness|null;results:{itemInstanceId:string;title:string;step:string;outcome:string;code:string|null}[]}>
}
const secret=randomBytes(32),stable=(v:unknown)=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x)
const hash=(v:unknown)=>createHash('sha256').update(stable(v)).digest('hex')
const sign=(owner:string,v:unknown)=>createHmac('sha256',secret).update(stable(['business-setup-plan/v1',owner,v])).digest('hex')
const fail=(message:string,code:'teloa/conflict'|'teloa/forbidden'|'teloa/version-conflict'|'teloa/invalid-input'|'teloa/source-unavailable'='teloa/conflict')=>new WorkError(code,message)
const id=(v:unknown)=>{if(!businessSetupUuid(v))throw fail('需要真实的方案请求身份。','teloa/invalid-input');return v.toLowerCase()}
const positive=(v:unknown)=>{if(!Number.isSafeInteger(v)||Number(v)<1)throw fail('方案版本不正确。','teloa/invalid-input');return Number(v)}
export function businessSetupRequestId(parent:string,step:string){const h=hash([parent,step]);return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`}
export async function initializeBusinessSetupPlans(pool:Pool){await pool.query(`
 create table if not exists teloa_business_setup_plans(owner_id text not null,draft_id uuid not null,body jsonb not null,primary key(owner_id,draft_id));
 create table if not exists teloa_business_setup_requests(owner_id text not null,request_id uuid not null,kind text not null,spec_hash text not null,result jsonb not null,primary key(owner_id,request_id));
 `)}
/** 方案只编排既有版本/实例服务。数据库采用原子提交；资源准备持久分阶段恢复。 */
export class BusinessSetupPlanService{
 readonly pool:Pool
 readonly ports:BusinessSetupPlanPorts
 readonly identity:{now:()=>string}
 constructor(pool:Pool,ports:BusinessSetupPlanPorts,identity:{now:()=>string}){this.pool=pool;this.ports=ports;this.identity=identity}
 private async transaction<T>(owner:string,work:(db:PoolClient)=>Promise<T>){
  if(!owner||owner.length>128)throw fail('需要当前本人身份。','teloa/forbidden')
  const db=await this.pool.connect()
  try{await db.query('begin');await lockBusinessConfigurationRequests(db,owner);const result=await work(db);await db.query('commit');return result}catch(error){await db.query('rollback').catch(()=>{});throw error}finally{db.release()}
 }
 private async stored(db:PoolClient,actor:BusinessConfigurationActor,draftId:string,lock=true):Promise<Stored|undefined>{
  await this.ports.drafts.draftInTransaction(db,actor,draftId)
  const row=(await db.query('select body from teloa_business_setup_plans where owner_id=$1 and draft_id=$2'+(lock?' for update':''),[actor.ownerId,draftId])).rows[0]
  return row?.body as Stored|undefined
 }
 private async put(db:PoolClient,owner:string,body:Stored){await db.query('insert into teloa_business_setup_plans values($1,$2,$3) on conflict(owner_id,draft_id) do update set body=excluded.body',[owner,body.plan.draftId,JSON.stringify(body)])}
 private async prior<T>(db:PoolClient,owner:string,requestId:string,kind:string,specHash:string):Promise<T|undefined>{const r=(await db.query('select * from teloa_business_setup_requests where owner_id=$1 and request_id=$2',[owner,requestId])).rows[0];if(!r)return;if(r.kind!==kind||r.spec_hash!==specHash)throw fail('原请求不能更换方案内容或操作。');return r.result as T}
 private async receipt(db:PoolClient,owner:string,requestId:string,kind:string,specHash:string,result:unknown){await db.query('insert into teloa_business_setup_requests values($1,$2,$3,$4,$5)',[owner,requestId,kind,specHash,JSON.stringify(result)])}
 async read(actor:BusinessConfigurationActor,input:unknown):Promise<BusinessSetupPlan|null>{const r=taskInput(input,['draftId']);return this.transaction(actor.ownerId,async db=>(await this.stored(db,actor,id(r.draftId)))?.plan??null)}
 async list(actor:BusinessConfigurationActor,input:unknown){
  const r=taskInput(input,['scope']);if(typeof r.scope!=='string'||!actor.scopeIds.includes(r.scope))throw fail('当前本人不能读取此业务方案。','teloa/forbidden')
  const rows=(await this.pool.query("select p.body,b.session_id from teloa_business_setup_plans p join teloa_business_configuration_drafts d on d.owner_id=p.owner_id and d.id=p.draft_id join teloa_business_conversation_bindings b on b.owner_id=p.owner_id and b.draft_id=p.draft_id where p.owner_id=$1 and d.scope_id=$2 and d.status='draft' and p.body->'plan'->>'state'='draft' and b.session_id is not null order by p.body->'plan'->>'updatedAt' desc limit 16",[actor.ownerId,r.scope])).rows
  return {items:rows.map(row=>({draftId:row.body.plan.draftId,scope:r.scope,title:row.body.plan.title,revision:row.body.plan.revision,sessionId:row.session_id}))}
 }
 async directory(actor:BusinessConfigurationActor,input:unknown){
  const r=taskInput(input,['draftId']),draftId=id(r.draftId)
  return this.transaction(actor.ownerId,async db=>{const draft=await this.ports.drafts.draftInTransaction(db,actor,draftId),rows=(await db.query("select * from teloa_roles where owner_id=$1 and definition->>'kind'='employee' and definition->'scopes' ? $2 and state<>'retired' order by id limit 100",[actor.ownerId,draft.scope])).rows
   return {plan:(await this.stored(db,actor,draftId))?.plan??null,employees:rows.map(row=>{const role=readStoredRole(row);return {roleId:role.id,expectedVersion:role.version,name:role.name,duty:role.duty,responsibility:role.responsibility,state:role.state}}),rules:'保留原scope/source，先修订记录与看板配置v2；再用完整v4静态包保存员工、工作模板、连接及暂停计划。宿主附加原配置，禁止复制凭据。没有方案时expectedRevision为0。现有员工权限/技能/范围保持不变；新员工与计划采用后仍暂停。'}
  })
 }
 async history(actor:BusinessConfigurationActor,input:unknown):Promise<BusinessSetupHistory>{
  const r=taskInput(input,['scope','beforeVersion'])
  if(typeof r.scope!=='string'||!actor.scopeIds.includes(r.scope))throw fail('当前本人不能读取此业务历史。','teloa/forbidden')
  const before=r.beforeVersion===undefined?null:positive(r.beforeVersion)
  return this.transaction(actor.ownerId,async db=>{
   const current=await new BusinessConfigurationStore(this.pool).currentInTransaction(db,actor.ownerId,String(r.scope));if(!current)throw fail('此业务尚未采用整体配置。')
   const rows=(await db.query('select version,manifest,hash,created_at from teloa_business_configuration_versions where owner_id=$1 and scope_id=$2 and ($3::integer is null or version<$3) order by version desc limit 26',[actor.ownerId,r.scope,before])).rows
   const items=rows.slice(0,25).map(row=>({version:row.version,hash:row.hash,title:row.manifest.title,pages:row.manifest.pages.length,createdAt:new Date(row.created_at).toISOString()}))
   return {scope:String(r.scope),currentVersion:current.version,items,beforeVersion:rows.length>25?items.at(-1)!.version:null}
  })
 }
 async restore(actor:BusinessConfigurationActor,input:unknown):Promise<BusinessSetupPlan>{
  const r=taskInput(input,['requestId','draftId','expectedRevision','configurationRevision','configurationHash','version','expectedHash']),requestId=id(r.requestId),draftId=id(r.draftId),version=positive(r.version)
  if(r.expectedRevision!==0||typeof r.expectedHash!=='string'||!/^[a-f0-9]{64}$/.test(r.expectedHash))throw fail('历史版本须在新编辑草案中复核。','teloa/invalid-input')
  const draft=await this.ports.drafts.get(actor,{draftId})
  const fixed=await this.transaction(actor.ownerId,db=>new BusinessConfigurationStore(this.pool).versionInTransaction(db,actor.ownerId,draft.scope,version))
  if(!fixed||fixed.hash!==r.expectedHash)throw fail('历史版本身份已变化。','teloa/version-conflict')
  const candidate=readBusinessConfigurationCandidateV2({...fixed.manifest,format:'teloa.business-configuration/v2',definitions:fixed.leaves.map(leaf=>({kind:leaf.kind,definition:{...JSON.parse(leaf.body),...(leaf.kind==='object-type'?{format:'teloa.business-object-type/v2'}:{})}}))})
  // 重用新草案编辑和固定请求回执；只恢复声明，不恢复岗位、连接或运行授权。
  return this.edit(actor,{requestId,draftId,expectedRevision:0,configurationRevision:r.configurationRevision,configurationHash:r.configurationHash,candidate,description:'本地配置版本 v'+version,roleEdits:[]})
 }
 private async inspect(content:MarketContent,scope:string,candidate:Candidate):Promise<BusinessSetupResource[]>{
  const manifest=validateManifest(content.metadata)
  if(manifest.format!=='teloa.business-package/v4'||manifest.scope!==scope||content.references.length)throw fail('完整方案须使用当前业务范围的固定 v4 包，公共资源请先取得并核对固定版本正文。','teloa/invalid-input')
  const configs=manifest.resources.filter(r=>r.kind==='business-configuration')
  if(configs.length!==1)throw fail('完整方案须包含一份当前业务页面配置。','teloa/invalid-input')
  const configuration=readMarketBusinessConfigurationResource(content,configs[0]!.id).configuration
  if(hash(configuration)!==hash(candidate))throw fail('方案页面与原搭建草案不一致，请先读取原草案并保存同一份配置。','teloa/version-conflict')
  const root=content.manifestPath.includes('/')?content.manifestPath.slice(0,content.manifestPath.lastIndexOf('/')+1):''
  const resources:BusinessSetupResource[]=[]
  for(const resource of manifest.resources){
   if(resource.source.kind!=='local')throw fail('资源固定正文尚未取得。','teloa/source-unavailable')
   const sourcePath=resource.source.path,file=content.files.find(f=>f.path===root+sourcePath);if(!file)throw fail('方案缺少固定资源。','teloa/source-unavailable')
   const raw=new TextDecoder('utf-8',{fatal:true}).decode(file.bytes);let description='已固定内容，采用后仍须准备。'
   if(resource.kind==='role'){const role=readRoleTemplateDefinition(JSON.parse(raw));if(role.definition.kind!=='employee'||role.ignoredModelSelection)throw fail('业务员工模板不能指定分身或他人的模型账户。','teloa/invalid-input');description=role.definition.duty}
   else if(resource.kind==='mcp'){const d=readIndustryMcpConnectionDefinition(JSON.parse(raw));description='连接声明 · 需要本人另行连接与授权';void d}
   else if(resource.kind==='data-source'){readIndustryDataSourceDefinition(JSON.parse(raw));description='数据来源声明 · 尚未授予读取权限'}
   else if(resource.kind==='plugin'){readIndustryPluginDefinition(JSON.parse(raw));description='应用声明 · 安装及权限需在准备清单核对'}
   else if(resource.kind==='plan'){
    const p=taskInput(JSON.parse(raw),['format','version','title','workTemplate','dataScope','trigger'])
    if(p.format!=='teloa.plan/v1'||p.version!==resource.version||typeof p.workTemplate!=='string'||!manifest.resources.some(r=>r.id===p.workTemplate&&r.kind==='work-template')||manifest.relations.filter(r=>r.kind==='role-work'&&r.to===resource.id).length!==1||typeof p.dataScope!=='string'||!p.dataScope.trim())throw fail('计划必须引用真实工作模板与唯一负责员工。','teloa/invalid-input')
    const trigger=readScheduleTrigger(p.trigger);description='保存后暂停 · '+(trigger.cadence==='daily'?'每天':'每周 '+trigger.weekday)+' '+trigger.time+'（'+trigger.timezone+'）'
   }else if(resource.kind==='work-template'){
    const w=taskInput(JSON.parse(raw),['format','id','version','title','domain','description','localized','requirements','output','skills'])
    if(w.format!=='teloa.work-template/v1'||w.id!==resource.id||w.version!==resource.version||w.domain!==scope&&w.domain!=='general'||typeof w.description!=='string'||!w.description.trim()||typeof w.output!=='string'||!w.output.trim()||!Array.isArray(w.requirements)||!w.requirements.length||!Array.isArray(w.skills))throw fail('工作流程必须使用有效的既有工作模板。','teloa/invalid-input')
    description=w.description
   }else if(resource.kind==='business-configuration')description='记录与看板页面 · 随本地配置采用'
   else if(['object-type','business-view','business-action','execution-tool'].includes(resource.kind))throw fail('业务定义请放入整份页面配置；执行工具请从现有真实连接入口配置。','teloa/invalid-input')
   resources.push({id:resource.id,kind:resource.kind,title:resource.title,version:resource.version,description})
  }
  return resources
 }
 async manual(actor:BusinessConfigurationActor,input:unknown):Promise<BusinessSetupManual>{
  const r=taskInput(input,['draftId']),draftId=id(r.draftId)
  return this.transaction(actor.ownerId,async db=>{
   const draft=await this.ports.drafts.draftInTransaction(db,actor,draftId),body=await this.stored(db,actor,draftId)
   if(draft.status!=='draft'||body?.plan.state==='applied')throw fail('请从当前业务打开新的编辑草案。')
   const source=body?.candidate??draft.candidate,candidate=readBusinessConfigurationCandidateV2({...source,format:'teloa.business-configuration/v2',definitions:source.definitions.map(d=>d.kind==='object-type'?{...d,definition:{...d.definition,format:'teloa.business-object-type/v2'}}:d)})
   const rows=(await db.query("select * from teloa_roles where owner_id=$1 and definition->>'kind'='employee' and definition->'scopes' ? $2 and state<>'retired' order by id limit 100",[actor.ownerId,draft.scope])).rows
   const employees=rows.map(row=>{const role=readStoredRole(row);return {roleId:role.id,expectedVersion:role.version,name:role.name,duty:role.duty,responsibility:role.responsibility??{triggers:[],autonomousActions:[],confirmationPoints:[],escalationRules:[],deliveryChecks:[]},state:role.state as 'active'|'paused'}})
   return {draftId,revision:body?.plan.revision??0,configurationRevision:draft.revision,configurationHash:draft.hash,candidate,description:body?.descriptionChange?.after??body?.plan.description??candidate.title,roleEdits:body?.plan.roleEdits??[],employees}
  })
 }
 async edit(actor:BusinessConfigurationActor,input:unknown):Promise<BusinessSetupPlan>{
  const r=taskInput(input,['requestId','draftId','expectedRevision','configurationRevision','configurationHash','candidate','description','roleEdits']),requestId=id(r.requestId),draftId=id(r.draftId),specHash=hash(r)
  const prior=await this.transaction(actor.ownerId,db=>this.prior<BusinessSetupPlan>(db,actor.ownerId,requestId,'edit',specHash));if(prior){await this.ports.drafts.get(actor,{draftId});return prior}
  if(!Number.isSafeInteger(r.expectedRevision)||Number(r.expectedRevision)<0||typeof r.configurationHash!=='string'||!/^[a-f0-9]{64}$/.test(r.configurationHash)||typeof r.description!=='string'||!r.description.trim()||r.description.length>2000)throw fail('候选编辑内容不正确。','teloa/invalid-input')
  const candidate=readBusinessConfigurationCandidateV2(r.candidate),configurationRevision=positive(r.configurationRevision)
  const snapshot=await this.transaction(actor.ownerId,async db=>{const draft=await this.ports.drafts.draftInTransaction(db,actor,draftId),body=await this.stored(db,actor,draftId);if(draft.status!=='draft'||body?.plan.state==='applied'||(body?.plan.revision??0)!==r.expectedRevision||draft.revision!==configurationRevision||draft.hash!==r.configurationHash)throw fail('候选编辑版本已变化，请读取原稿。','teloa/version-conflict');if(candidate.scope!==draft.scope||hash(candidate.sources)!==hash(draft.candidate.sources))throw fail('候选编辑不能更换原业务或记录来源。','teloa/forbidden');return body?await this.ports.market.getInTransaction(db,{ownerId:actor.ownerId,kind:'human'},{contentId:body.originalContentId}):null})
  const configId='business-configuration',configPath='business-configuration.json',manifest=snapshot?validateManifest(snapshot.metadata):{format:'teloa.business-package/v4' as const,id:'business-setup',title:candidate.title,version:'1.0.0',domain:candidate.scope,scope:candidate.scope,description:r.description,resources:[{id:configId,kind:'business-configuration' as const,title:candidate.title,version:'1.0.0',required:true,source:{kind:'local' as const,path:configPath}}],relations:[],entrypoints:[]}
  manifest.title=candidate.title;manifest.description=r.description.trim()
  const config=manifest.resources.find(resource=>resource.kind==='business-configuration')!;if(config.source.kind!=='local')throw fail('原配置正文不可编辑。','teloa/source-unavailable')
  const root=snapshot?.manifestPath.includes('/')?snapshot.manifestPath.slice(0,snapshot.manifestPath.lastIndexOf('/')+1):'',manifestPath=snapshot?.manifestPath??'teloa.json',resourcePath=root+config.source.path
  const files=snapshot?snapshot.files.map(f=>({path:f.path,text:new TextDecoder('utf-8',{fatal:true}).decode(f.bytes)})):[]
  const set=(path:string,text:string)=>{const found=files.find(f=>f.path===path);if(found)found.text=text;else files.push({path,text})}
  set(manifestPath,JSON.stringify(manifest));set(resourcePath,JSON.stringify({format:'teloa.business-dashboard-resource/v1',id:config.id,version:config.version,configuration:candidate}))
  return this.reviseWithConfiguration(actor,{requestId,draftId,expectedRevision:r.expectedRevision,package:{manifestPath,files},roleEdits:r.roleEdits},{candidate,revision:configurationRevision,hash:r.configurationHash},{kind:'edit',specHash})
 }
 async revise(actor:BusinessConfigurationActor,input:unknown):Promise<BusinessSetupPlan>{return this.reviseWithConfiguration(actor,input)}
 private async reviseWithConfiguration(actor:BusinessConfigurationActor,input:unknown,configuration?:{candidate:BusinessConfigurationCandidateV2;revision:number;hash:string},operation?:{kind:'edit';specHash:string}):Promise<BusinessSetupPlan>{
  const r=taskInput(input,['requestId','draftId','expectedRevision','package','roleEdits']),requestId=id(r.requestId),draftId=id(r.draftId)
  if(!Number.isSafeInteger(r.expectedRevision)||Number(r.expectedRevision)<0||!Array.isArray(r.roleEdits)||r.roleEdits.length>100)throw fail('方案修订格式不正确。','teloa/invalid-input')
  const pkg=readBusinessSetupPackage(r.package),edits=r.roleEdits.map(readBusinessSetupRoleEdit)
  const originalDraft=await this.ports.drafts.get(actor,{draftId})
  const manifestFile=pkg.files.find(f=>f.path===pkg.manifestPath)!,rawManifest=JSON.parse(manifestFile.text)
  // 配置附入后才做完整包验证；纯页面或已有员工方案不需要虚构一个资源。
  if(rawManifest&&rawManifest.format==='teloa.business-package/v4'&&Array.isArray(rawManifest.resources)&&!rawManifest.resources.length){
   const resourceId='business-configuration',path='business-configuration.json',root=pkg.manifestPath.includes('/')?pkg.manifestPath.slice(0,pkg.manifestPath.lastIndexOf('/')+1):''
   if(pkg.files.some(f=>f.path===root+path))throw fail('配置资源保留路径已被占用。','teloa/invalid-input')
   rawManifest.resources.push({id:resourceId,kind:'business-configuration',title:originalDraft.candidate.title,version:'1.0.0',required:true,source:{kind:'local',path}})
   pkg.files.push({path:root+path,text:JSON.stringify({format:'teloa.business-dashboard-resource/v1',id:resourceId,version:'1.0.0',configuration:configuration?.candidate??originalDraft.candidate})})
  }
  const manifest=validateManifest(rawManifest);manifestFile.text=JSON.stringify(manifest)
  if(!manifest.resources.some(resource=>resource.kind==='business-configuration')){
   if(originalDraft.candidate.format!=='teloa.business-configuration/v2')throw fail('请先升级原配置草案再保存完整方案。','teloa/invalid-input')
   const resourceId='business-configuration',path='business-configuration.json',root=pkg.manifestPath.includes('/')?pkg.manifestPath.slice(0,pkg.manifestPath.lastIndexOf('/')+1):''
   if(manifest.resources.some(resource=>resource.id===resourceId)||pkg.files.some(f=>f.path===root+path))throw fail('完整方案保留的页面资源标识已被占用。','teloa/invalid-input')
   manifest.resources.push({id:resourceId,kind:'business-configuration',title:originalDraft.candidate.title,version:'1.0.0',required:true,source:{kind:'local',path}})
   manifestFile.text=JSON.stringify(manifest)
   pkg.files.push({path:root+path,text:JSON.stringify({format:'teloa.business-dashboard-resource/v1',id:resourceId,version:'1.0.0',configuration:originalDraft.candidate})})
  }
  if(new Set(edits.map(e=>e.roleId)).size!==edits.length)throw fail('同一员工不能重复修改。','teloa/invalid-input')
  const specHash=operation?.specHash??hash(r),requestKind=operation?.kind??'revise'
  const recovered=await this.transaction(actor.ownerId,db=>this.prior<BusinessSetupPlan>(db,actor.ownerId,requestId,requestKind,specHash));if(recovered){await this.ports.drafts.get(actor,{draftId});return recovered}
  const imported=await this.ports.market.import({ownerId:actor.ownerId,kind:'human'},{kind:'industry-template',requestId:businessSetupRequestId(requestId,'content'),source:{kind:'upload',name:'业务搭建草案'},manifestPath:pkg.manifestPath,files:pkg.files.map(f=>({path:f.path,bytes:new TextEncoder().encode(f.text)})),references:[]})
  return this.transaction(actor.ownerId,async db=>{
   const prior=await this.prior<BusinessSetupPlan>(db,actor.ownerId,requestId,requestKind,specHash);if(prior)return prior
   let draft=await this.ports.drafts.draftInTransaction(db,actor,draftId);const previous=await this.stored(db,actor,draftId)
   if(draft.status!=='draft'||previous?.plan.state==='applied'||(previous?.plan.revision??0)!==r.expectedRevision)throw fail('方案已变化，请读取原稿。','teloa/version-conflict')
   if(configuration){
    if(draft.revision!==configuration.revision||draft.hash!==configuration.hash)throw fail('原配置草案已变化。','teloa/version-conflict')
    if(draft.candidate.format!=='teloa.business-configuration/v2')draft=await this.ports.drafts.upgradeFormatInTransaction(db,actor,{requestId:businessSetupRequestId(requestId,'manual-upgrade'),draftId,expectedRevision:draft.revision})
    const candidate=configuration.candidate
    draft=await this.ports.drafts.reviseInTransaction(db,actor,{requestId:businessSetupRequestId(requestId,'manual-configuration'),draftId,expectedRevision:draft.revision,patch:{title:candidate.title,upsertDefinitions:candidate.definitions,removeDefinitions:draft.candidate.definitions.filter(d=>!candidate.definitions.some(c=>c.kind===d.kind&&c.definition.id===d.definition.id)).map(d=>({kind:d.kind,localId:d.definition.id})),upsertPages:candidate.pages,removePageIds:draft.candidate.pages.filter(p=>!candidate.pages.some(c=>c.id===p.id)).map(p=>p.id),pageOrder:candidate.pages.map(p=>p.id),...(candidate.homePageId?{homePageId:candidate.homePageId}:{})}})
   }
   if(draft.candidate.format!=='teloa.business-configuration/v2')throw fail('请先在原搭建草案升级业务配置，再保存完整方案。','teloa/invalid-input')
   const resources=await this.inspect(imported.content,draft.scope,draft.candidate),current=await new BusinessConfigurationStore(this.pool).currentInTransaction(db,actor.ownerId,draft.scope)
   const baseline=current?{...current.manifest,definitions:current.leaves.map(l=>({kind:l.kind,definition:JSON.parse(l.body)}))} as Candidate:{...draft.candidate,definitions:[],pages:[]};if(!current)delete baseline.homePageId
   const roleNames:Record<string,string>={}
   for(const edit of edits){const row=(await db.query('select * from teloa_roles where owner_id=$1 and id=$2',[actor.ownerId,edit.roleId])).rows[0];if(!row)throw fail('员工不存在或不属于当前本人。','teloa/forbidden');const role=readStoredRole(row);if(role.kind!=='employee'||!role.scopes.includes(draft.scope)||role.state==='retired')throw fail('只能调整当前业务的真实员工职责。','teloa/forbidden');if(role.version!==edit.expectedVersion)throw fail('员工版本已变化。','teloa/version-conflict');roleNames[role.id]=role.name}
   const manifest=validateManifest(imported.content.metadata),plan:BusinessSetupPlan={format:'teloa.business-setup-plan/v1',draftId,scope:draft.scope,revision:Number(r.expectedRevision)+1,configurationRevision:draft.revision,configurationHash:draft.hash,contentId:imported.content.id,contentHash:imported.content.hash,title:draft.candidate.title,description:manifest.description,resources,roleEdits:edits,roleNames,rejected:[],state:'draft',updatedAt:this.identity.now()}
   await this.put(db,actor.ownerId,{plan,baseline,candidate:draft.candidate,originalContentId:plan.contentId,originalContentHash:plan.contentHash,roleNames,planInputs:{},...(configuration&&previous?{descriptionChange:{before:previous.descriptionChange?.before??previous.plan.description,after:manifest.description}}:{})})
   await this.receipt(db,actor.ownerId,requestId,requestKind,specHash,plan);return plan
  })
 }
 private async roleChanges(db:PoolClient,actor:BusinessConfigurationActor,body:Stored){
  const changes=[]
  for(const edit of body.plan.roleEdits){const row=(await db.query('select * from teloa_roles where owner_id=$1 and id=$2',[actor.ownerId,edit.roleId])).rows[0];if(!row)throw fail('负责员工不可用。','teloa/forbidden');const role=readStoredRole(row);if(role.version!==edit.expectedVersion||role.kind!=='employee'||!role.scopes.includes(body.plan.scope))throw fail('员工职责或版本已变化，请重新准备方案。','teloa/version-conflict');changes.push({id:'role:'+edit.roleId,entity:'role' as const,label:role.name+' · 职责',before:{duty:role.duty,responsibility:role.responsibility},after:{duty:edit.duty,responsibility:edit.responsibility}})}
  return changes
 }
 async preview(actor:BusinessConfigurationActor,input:unknown):Promise<BusinessSetupPreview>{
  const r=taskInput(input,['draftId','expectedRevision','rejected']),draftId=id(r.draftId),revision=positive(r.expectedRevision)
  if(!Array.isArray(r.rejected)||r.rejected.some(v=>typeof v!=='string')||new Set(r.rejected).size!==r.rejected.length)throw fail('逐项决定格式不正确。','teloa/invalid-input')
  const prepared=await this.transaction(actor.ownerId,async db=>{
   const body=await this.stored(db,actor,draftId);if(!body||body.plan.state!=='draft'||body.plan.revision!==revision)throw fail('方案已变化。','teloa/version-conflict')
   const candidate=selectBusinessSetupConfiguration(body.baseline,body.candidate,r.rejected as string[]),content=await this.ports.market.getInTransaction(db,{ownerId:actor.ownerId,kind:'human'},{contentId:body.originalContentId})
   if(content.hash!==body.originalContentHash)throw fail('原方案固定内容已变化。','teloa/source-unavailable')
   const manifest=validateManifest(content.metadata),resource=manifest.resources.find(r=>r.kind==='business-configuration')!,source=resource.source
   if(source.kind!=='local')throw fail('页面配置正文不可用。','teloa/source-unavailable')
   const root=content.manifestPath.includes('/')?content.manifestPath.slice(0,content.manifestPath.lastIndexOf('/')+1):'',resourcePath=root+source.path
   const description=body.descriptionChange&&(r.rejected as string[]).includes('business:description')?body.descriptionChange.before:manifest.description
   return {description,planHash:hash(body.plan),manifestPath:content.manifestPath,files:content.files.map(file=>file.path===content.manifestPath?{path:file.path,bytes:new TextEncoder().encode(JSON.stringify({...manifest,description}))}:file.path===resourcePath?{path:file.path,bytes:new TextEncoder().encode(JSON.stringify({format:'teloa.business-dashboard-resource/v1',id:resource.id,version:resource.version,configuration:candidate}))}:{path:file.path,bytes:file.bytes})}
  })
  // 仅固定静态内容，事务外复用市场导入，避免小连接池嵌套事务自锁。
  const selected=await this.ports.market.import({ownerId:actor.ownerId,kind:'human'},{kind:'industry-template',requestId:businessSetupRequestId(draftId,'selection-content:'+hash([prepared.planHash,r.rejected])),source:{kind:'upload',name:'已复核业务方案'},manifestPath:prepared.manifestPath,files:prepared.files,references:[]})
  return this.transaction(actor.ownerId,async db=>{
   const body=await this.stored(db,actor,draftId);if(!body||body.plan.state!=='draft'||body.plan.revision!==revision||hash(body.plan)!==prepared.planHash)throw fail('方案已变化。','teloa/version-conflict')
   let draft=await this.ports.drafts.draftInTransaction(db,actor,draftId)
   if(draft.revision!==body.plan.configurationRevision||draft.hash!==body.plan.configurationHash)throw fail('页面配置已调整，请在原会话重新保存完整方案。','teloa/version-conflict')
   const changes=[...businessSetupConfigurationChanges(body.baseline,body.candidate),...await this.roleChanges(db,actor,body),...(body.descriptionChange&&body.descriptionChange.before!==body.descriptionChange.after?[{id:'business:description',entity:'business' as const,label:'业务说明',before:body.descriptionChange.before,after:body.descriptionChange.after}]:[])]
   if((r.rejected as string[]).some(id=>!changes.some(c=>c.id===id)))throw fail('决定包含不属于当前预览的变更。','teloa/invalid-input')
   const rejected=[...r.rejected as string[]].sort(),candidate=selectBusinessSetupConfiguration(body.baseline,body.candidate,rejected)
   if(hash(candidate)!==hash(draft.candidate)){
    draft=await this.ports.drafts.reviseInTransaction(db,actor,{requestId:businessSetupRequestId(draftId,'selection:'+hash([revision,rejected,draft.revision])),draftId,expectedRevision:draft.revision,patch:{title:candidate.title,upsertDefinitions:candidate.definitions,removeDefinitions:draft.candidate.definitions.filter(d=>!candidate.definitions.some(c=>c.kind===d.kind&&c.definition.id===d.definition.id)).map(d=>({kind:d.kind,localId:d.definition.id})),upsertPages:candidate.pages,removePageIds:draft.candidate.pages.filter(p=>!candidate.pages.some(c=>c.id===p.id)).map(p=>p.id),pageOrder:candidate.pages.map(p=>p.id),...(candidate.homePageId?{homePageId:candidate.homePageId}:{})}})
   }
   body.plan={...body.plan,description:prepared.description,revision:revision+1,configurationRevision:draft.revision,configurationHash:draft.hash,contentId:selected.content.id,contentHash:selected.content.hash,rejected,updatedAt:this.identity.now()}
   const configuration=await this.ports.preview.previewInTransaction(db,actor,{draftId,expectedRevision:draft.revision}),digest=hash(body.plan)
   const unsigned={draftId,revision:body.plan.revision,digest,configurationReceipt:configuration.receipt,configurationRevision:draft.revision,baseVersion:draft.baseVersion,changes,rejected,blocked:configuration.impact.blocked||!candidate.pages.length}
   body.preview={...unsigned,receipt:sign(actor.ownerId,unsigned)}
   await this.put(db,actor.ownerId,body);return body.preview
  })
 }
 async apply(actor:BusinessConfigurationActor,input:unknown):Promise<BusinessSetupAdoption>{
  const r=taskInput(input,['requestId','draftId','expectedRevision','expectedDigest','previewReceipt']),requestId=id(r.requestId),draftId=id(r.draftId),specHash=hash(r)
  return this.transaction(actor.ownerId,async db=>{
   const prior=await this.prior<BusinessSetupAdoption>(db,actor.ownerId,requestId,'apply',specHash);if(prior){await this.ports.drafts.draftInTransaction(db,actor,draftId);return prior}
   const body=await this.stored(db,actor,draftId),preview=body?.preview
   if(!body||!preview||body.plan.state!=='draft'||body.plan.revision!==r.expectedRevision||preview.digest!==r.expectedDigest||preview.digest!==hash(body.plan)||preview.receipt!==r.previewReceipt||preview.blocked)throw fail('请由本人重新预览当前完整方案。')
   const {receipt,...unsigned}=preview;if(sign(actor.ownerId,unsigned)!==receipt)throw new WorkError('teloa/conflict','预览已过期，请重新审阅后采用。',{reason:'preview-receipt-invalid'})
   const content=await this.ports.market.getInTransaction(db,{ownerId:actor.ownerId,kind:'human'},{contentId:body.plan.contentId})
   if(content.hash!==body.plan.contentHash)throw fail('方案固定来源已变化。','teloa/source-unavailable')
   await this.roleChanges(db,actor,body)
   if(!preview.changes.some(c=>!body.plan.rejected.includes(c.id))&&!body.plan.resources.some(r=>r.kind!=='business-configuration'))throw fail('所有变更均已拒绝，无需采用。')
   const configuration=await this.ports.configuration.applyInTransaction(db,actor,{requestId:businessSetupRequestId(requestId,'configuration'),draftId,expectedRevision:preview.configurationRevision,expectedBaseVersion:preview.baseVersion,previewReceipt:preview.configurationReceipt})
   const roleIds=[]
   for(const edit of [...body.plan.roleEdits].sort((a,b)=>a.roleId.localeCompare(b.roleId))){
    if(body.plan.rejected.includes('role:'+edit.roleId))continue
    const row=(await db.query('select * from teloa_roles where owner_id=$1 and id=$2 for update',[actor.ownerId,edit.roleId])).rows[0],role=readStoredRole(row)
    const {id:_,ownerId:__,version:___,state:____,createdAt:_____,updatedAt:______,...fields}=role
    const saved=await this.ports.roles.editInTransaction(db,actor.ownerId,{roleId:role.id,expectedVersion:edit.expectedVersion,expectedProfile:{name:role.name,...(role.avatarKey?{avatarKey:role.avatarKey}:{})},fields:{...fields,duty:edit.duty,responsibility:edit.responsibility}});roleIds.push(saved.id)
   }
   const adoption:BusinessSetupAdoption={requestId,configuration,roleIds,contentId:body.plan.contentId,contentHash:body.plan.contentHash,steps:body.plan.resources.map(r=>({id:r.id,kind:r.kind,title:r.title,state:r.kind==='business-configuration'?'done':'pending'}))}
   body.plan={...body.plan,state:'applied',adoption,updatedAt:this.identity.now()};delete body.preview
   await this.put(db,actor.ownerId,body);await this.receipt(db,actor.ownerId,requestId,'apply',specHash,adoption);return adoption
  })
 }
 async receiptByRequest(actor:BusinessConfigurationActor,input:unknown):Promise<BusinessSetupAdoption|null>{const r=taskInput(input,['requestId']),requestId=id(r.requestId);return this.transaction(actor.ownerId,async db=>{const row=(await db.query("select result from teloa_business_setup_requests where owner_id=$1 and request_id=$2 and kind='apply'",[actor.ownerId,requestId])).rows[0];if(!row)return null;const adoption=row.result as BusinessSetupAdoption;if(!actor.scopeIds.includes(adoption.configuration.scope))throw fail('当前本人不能读取此业务。','teloa/forbidden');return adoption})}
 async prepare(actor:BusinessConfigurationActor,input:unknown):Promise<BusinessSetupPlan>{
  const r=taskInput(input,['draftId','expectedDigest']),draftId=id(r.draftId)
  let body=await this.transaction(actor.ownerId,async db=>{const b=await this.stored(db,actor,draftId);if(!b?.plan.adoption||b.plan.state!=='applied')throw fail('请先采用完整方案。');if(!b.target){const space=(await db.query('select s.id,s.version from teloa_business_scopes c join teloa_business_spaces s on s.id=c.space_id and s.owner_id=c.owner_id where c.owner_id=$1 and c.scope=$2',[actor.ownerId,b.plan.scope])).rows[0];if(!space)throw fail('正式业务归属不可用。');b.target={kind:'existing',spaceId:space.id,expectedVersion:space.version};await this.put(db,actor.ownerId,b)}return b})
  const adoption=body.plan.adoption!,save=async(update:(stored:Stored)=>void)=>{body=await this.transaction(actor.ownerId,async db=>{const latest=(await this.stored(db,actor,draftId))!;if(latest.plan.adoption?.requestId!==adoption.requestId)throw fail('采用身份已变化。');update(latest);latest.plan.updatedAt=this.identity.now();await this.put(db,actor.ownerId,latest);return latest})}
  if(!body.plan.adoption!.loadId){const load=await this.ports.loads.createForConfiguration(actor.ownerId,{requestId:businessSetupRequestId(adoption.requestId,'load'),contentId:adoption.contentId,contentHash:adoption.contentHash,target:body.target},{scope:adoption.configuration.scope,version:adoption.configuration.version,hash:adoption.configuration.configurationHash});await save(b=>{b.plan.adoption!.loadId=load.id})}
  const loadId=body.plan.adoption!.loadId!,load=await this.ports.loads.get(actor.ownerId,{loadId}),readiness=await this.ports.readiness(loadId)
  const project=(rows:BusinessSetupReadiness['rows']):BusinessSetupStep[]=>body.plan.resources.map(resource=>{
   if(resource.kind==='business-configuration')return {id:resource.id,kind:resource.kind,title:resource.title,state:'done'}
   if(resource.kind==='work-template')return {id:resource.id,kind:resource.kind,title:resource.title,state:'done'}
   const item=load.items.find(i=>i.localId===resource.id),row=rows.find(r=>r.itemInstanceId===item?.instanceId),existing=body.plan.adoption?.steps.find(s=>s.id===resource.id)
   if(resource.kind==='plan'&&existing?.state==='done')return existing
   return {id:resource.id,kind:resource.kind,title:resource.title,state:row?.state==='ready'?'done':row?.state==='needs-user'?'needs-user':'pending'}
  })
  await save(b=>{b.plan.adoption!.steps=project(readiness.rows)})
  // 首次只登记加载并返回真实准备清单；必须本人核对摘要后再次确认，禁止隐式安装/启用应用。
  if(r.expectedDigest===undefined)return body.plan
  if(r.expectedDigest!==readiness.digest)throw fail('准备清单已变化，请重新核对。','teloa/version-conflict')
  await save(b=>{b.plan.adoption!.preparation={digest:readiness.digest,state:'unknown'}})
  let prepared:Awaited<ReturnType<BusinessSetupPlanPorts['prepare']>>
  try{prepared=await this.ports.prepare(loadId,readiness.digest,{activate:false})}
  catch(error){await save(b=>{b.plan.adoption!.preparation={digest:readiness.digest,state:'unknown',code:error instanceof WorkError?error.code:'teloa/dependency-unavailable'}});throw error}
  await save(b=>{b.plan.adoption!.preparation={digest:readiness.digest,state:'finished'}})
  await save(b=>{b.plan.adoption!.steps=prepared.readiness?project(prepared.readiness.rows):b.plan.adoption!.steps;for(const result of prepared.results)if(result.outcome==='failed'){const item=load.items.find(i=>i.instanceId===result.itemInstanceId),step=b.plan.adoption!.steps.find(s=>s.id===item?.localId);if(step){step.state='failed';if(result.code)step.code=result.code}}})
  const rolePage=await this.ports.industryRoles.list(actor.ownerId,{})
  await save(b=>{for(const instance of rolePage.items){if(instance.role&&instance.role.state==='paused'){const item=load.items.find(i=>i.instanceId===instance.itemInstanceId),step=b.plan.adoption!.steps.find(s=>s.id===item?.localId);if(step){step.state='done';step.objectId=instance.role.id}}}})
  for(const resource of body.plan.resources.filter(r=>r.kind==='plan')){
   const item=load.items.find(i=>i.localId===resource.id),link=load.relations.find(l=>l.kind==='role-work'&&l.to===item?.instanceId),roleInstance=rolePage.items.find(i=>i.itemInstanceId===link?.from)
   if(!item||!roleInstance?.role){await save(b=>{const step=b.plan.adoption!.steps.find(s=>s.id===resource.id)!;step.state='needs-user'});continue}
   try{
    if(!body.planInputs[resource.id]){const snapshot=await this.ports.plans.preview(actor.ownerId,{loadId,itemInstanceId:item.instanceId}),role=await this.ports.roles.get(actor.ownerId,roleInstance.role.id);if(!role||role.state!=='paused')throw fail('新方案负责员工必须保持暂停。');const request={requestId:businessSetupRequestId(adoption.requestId,'plan:'+resource.id),loadId,itemInstanceId:item.instanceId,roleId:role.id,expectedRoleVersion:role.version,goal:snapshot.work.method,delivery:snapshot.work.output,notificationPolicy:'attention',trigger:snapshot.trigger};await save(b=>{b.planInputs[resource.id]??=request})}
    const result=await this.ports.plans.createPaused(actor.ownerId,body.planInputs[resource.id]);if(result.plan.state!=='paused')throw fail('计划状态未保持暂停。')
    await save(b=>{const step=b.plan.adoption!.steps.find(s=>s.id===resource.id)!;step.state='done';step.objectId=result.plan.id})
   }catch(error){await save(b=>{const step=b.plan.adoption!.steps.find(s=>s.id===resource.id)!;step.state='failed';step.code=error instanceof WorkError?error.code:'teloa/dependency-unavailable'})}
  }
  return body.plan
 }
 async readiness(actor:BusinessConfigurationActor,input:unknown){const plan=await this.read(actor,input);if(!plan?.adoption?.loadId)return null;return this.ports.readiness(plan.adoption.loadId)}
}

import {createHash} from 'node:crypto'
import type {Pool,PoolClient} from 'pg'
import {WorkError,isRecord,readRoleRuntimeConfig,roleDefinition,type DigitalRole,type MarketCatalogRoleEntry,type RoleDefinition,type RoleRuntimeConfig} from '@teloa/contract'
import type {IndustryLoadService} from './industry-loads.ts'
import type {IndustryKnowledgeInstance,IndustryKnowledgeService} from './industry-knowledge.ts'
import type {IndustryRoleSnapshot,IndustryRoleSource} from './industry-role-source.ts'
import type {RoleService} from './roles.ts'
import {industryReferenceId} from '../capabilities/industry-reference-catalog.ts'

export type IndustryRoleKnowledge={itemInstanceId:string;instanceId:string;resourceId:string;resourceVersion:number}
/** `kind:'model'` 不是资源关联：表示模板 `runtimeConfig` 里的首选/备用模型声明已忽略（终审 I-2），`itemInstanceId` 为岗位项自身，`status` 恒为 `skipped`；模型须由本人在岗位设置中选择。 */
export type IndustryRoleDeclaration={kind:'skill'|'mcp'|'data-source'|'execution-tool'|'model';itemInstanceId:string;status:'pending-adapter'|'skipped'}
/** 从目录 role 条目直接建岗位的回执（规格 §5）；skills 只列此岗位需要的技能名，一期不导入技能包。 */
export type CatalogRoleReceipt={roleId:string;status:'created'|'existing';skills:string[]}
/** 建岗 requestId 由 (ownerId, entryId, version) 派生：同一人重复添加同一条目版本落到同一条岗位记录。与 plan-tools.ts requestIdentity 同法。 */
export function catalogRoleRequestId(ownerId:string,entryId:string,version:string):string{return derivedRequestId(['teloa-catalog-role/v1',ownerId,entryId,version])}
/** 该请求建的岗位已退役时，同一条目版本的下一代请求 id：由上一代请求 id 与退役岗位 id 派生，并发重新添加仍收敛到同一请求。 */
const nextCatalogRoleRequestId=(requestId:string,retiredRoleId:string)=>derivedRequestId(['teloa-catalog-role/v1/next',requestId,retiredRoleId])
function derivedRequestId(parts:string[]):string{
 const digest=createHash('sha256').update(parts.join('\0')).digest('hex')
 return `${digest.slice(0,8)}-${digest.slice(8,12)}-5${digest.slice(13,16)}-a${digest.slice(17,20)}-${digest.slice(20,32)}`
}
/** 执行态复用的严读：行业岗位的资源关联只接受实例化时冻结的四类声明。 */
export function readIndustryRoleDeclarations(value:unknown):IndustryRoleDeclaration[]{
 if(!Array.isArray(value)||value.some(item=>!isRecord(item)||!['skill','mcp','data-source','execution-tool','model'].includes(item.kind as string)||!uuid(item.itemInstanceId)||!['pending-adapter','skipped'].includes(item.status as string)||item.kind==='model'&&item.status!=='skipped'))throw corrupt()
 return value as IndustryRoleDeclaration[]
}
export type IndustryRoleOmittedKnowledge={itemInstanceId:string;reason:'not-instantiated'|'pending'|'failed'|'withdrawn'|'skipped'}
export type IndustryRoleInstance={id:string;ownerId:string;loadId:string;itemInstanceId:string;itemLocalId:string;scope:string;definitionHash:string;revision:number;state:'pending'|'paused'|'active'|'retired'|'failed';role:DigitalRole|null;knowledge:IndustryRoleKnowledge[];omittedKnowledge:IndustryRoleOmittedKnowledge[];declarations:IndustryRoleDeclaration[];failure:{code:string;message:string}|null;createdAt:string;updatedAt:string}
export type IndustryRolePage={items:IndustryRoleInstance[]}
type Stored={id:string;ownerId:string;loadId:string;itemInstanceId:string;itemLocalId:string;scope:string;definition:RoleDefinition;definitionHash:string;knowledge:IndustryRoleKnowledge[];omittedKnowledge:IndustryRoleOmittedKnowledge[];declarations:IndustryRoleDeclaration[];downstreamRequestId:string;mappingDigest:string;roleId:string|null;phase:'prepared'|'needs-recovery'|'failed';revision:number;failureCode:string|null;failureMessage:string|null;createdAt:string;updatedAt:string}
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
const invalid=()=>new WorkError('teloa/invalid-input','行业员工实例化请求格式不正确。'),corrupt=()=>new WorkError('teloa/storage-corrupt','行业员工实例化记录损坏，已停止读取。')
const exact=(value:unknown,keys:readonly string[])=>{if(!isRecord(value)||Object.keys(value).some(key=>!keys.includes(key)))throw invalid();return value}
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
const stamp=(value:unknown)=>{if(!(value instanceof Date)||!Number.isFinite(value.getTime()))throw corrupt();return value.toISOString()}
const mappingHash=(value:{id:string;ownerId:string;loadId:string;itemInstanceId:string;downstreamRequestId:string;definitionHash:string;knowledge:IndustryRoleKnowledge[];omittedKnowledge:IndustryRoleOmittedKnowledge[];declarations:IndustryRoleDeclaration[]})=>hash([value.id,value.ownerId,value.loadId,value.itemInstanceId,value.downstreamRequestId,value.definitionHash,value.knowledge.map(row=>[row.itemInstanceId,row.instanceId,row.resourceId,row.resourceVersion]),value.omittedKnowledge.map(row=>[row.itemInstanceId,row.reason]),value.declarations.map(row=>[row.kind,row.itemInstanceId,row.status])])
const own=(owner:string)=>{if(typeof owner!=='string'||!owner)throw new WorkError('teloa/forbidden','需要有效的本人身份。')}

export async function initializeIndustryRoles(pool:Pool):Promise<void>{await pool.query(`
 create table if not exists teloa_industry_role_instances(id uuid primary key,owner_id text not null,load_id uuid not null,item_instance_id uuid not null,item_local_id text not null,scope text not null,definition jsonb not null,definition_hash text not null,knowledge jsonb not null,omitted_knowledge jsonb not null,declarations jsonb not null,downstream_request_id uuid not null,mapping_digest text not null,role_id uuid,phase text not null check(phase in ('prepared','needs-recovery','failed')),revision integer not null check(revision between 1 and 2147483647),failure_code text,failure_message text,created_at timestamptz not null,updated_at timestamptz not null,unique(owner_id,load_id,item_instance_id),check(jsonb_typeof(definition)='object'),check(jsonb_typeof(knowledge)='array'),check(jsonb_typeof(omitted_knowledge)='array'),check(jsonb_typeof(declarations)='array'),check(definition_hash ~ '^[0-9a-f]{64}$'),check(mapping_digest ~ '^[0-9a-f]{64}$'),check((phase='failed' and failure_code is not null and failure_message is not null) or (phase<>'failed' and failure_code is null and failure_message is null)));
 create table if not exists teloa_industry_role_requests(owner_id text not null,request_id uuid not null,request_spec jsonb not null check(jsonb_typeof(request_spec)='object'),instance_id uuid not null references teloa_industry_role_instances(id),primary key(owner_id,request_id));
 `)}

export class IndustryRoleService{
 private readonly pool:Pool;private readonly identity:{id:()=>string;now:()=>string};private readonly loads:Pick<IndustryLoadService,'get'|'storedItemStatus'>;private readonly roleSource:Pick<IndustryRoleSource,'read'|'readTemplate'>;private readonly knowledge:Pick<IndustryKnowledgeService,'get'>;private readonly roles:Pick<RoleService,'create'|'createOrExisting'|'findByRequest'|'editInTransaction'>
 constructor(pool:Pool,identity:{id:()=>string;now:()=>string},loads:Pick<IndustryLoadService,'get'|'storedItemStatus'>,roleSource:Pick<IndustryRoleSource,'read'|'readTemplate'>,knowledge:Pick<IndustryKnowledgeService,'get'>,roles:Pick<RoleService,'create'|'createOrExisting'|'findByRequest'|'editInTransaction'>){this.pool=pool;this.identity=identity;this.loads=loads;this.roleSource=roleSource;this.knowledge=knowledge;this.roles=roles}
 private read(row:Record<string,unknown>):Stored{try{const definition=roleDefinition(row.definition),knowledge=row.knowledge as IndustryRoleKnowledge[],omittedKnowledge=row.omitted_knowledge as IndustryRoleOmittedKnowledge[],declarations=readIndustryRoleDeclarations(row.declarations),base={id:row.id as string,ownerId:row.owner_id as string,loadId:row.load_id as string,itemInstanceId:row.item_instance_id as string,downstreamRequestId:row.downstream_request_id as string,definitionHash:row.definition_hash as string,knowledge,omittedKnowledge,declarations};if(!uuid(base.id)||!base.ownerId||!uuid(base.loadId)||!uuid(base.itemInstanceId)||!uuid(base.downstreamRequestId)||typeof row.item_local_id!=='string'||typeof row.scope!=='string'||base.definitionHash!==hash(definition)||!Array.isArray(knowledge)||knowledge.some(item=>!isRecord(item)||!uuid(item.itemInstanceId)||!uuid(item.instanceId)||!uuid(item.resourceId)||!Number.isInteger(item.resourceVersion)||(item.resourceVersion as number)<1)||!Array.isArray(omittedKnowledge)||omittedKnowledge.some(item=>!isRecord(item)||!uuid(item.itemInstanceId)||!['not-instantiated','pending','failed','withdrawn','skipped'].includes(item.reason))||row.mapping_digest!==mappingHash(base)||!['prepared','needs-recovery','failed'].includes(String(row.phase))||!Number.isInteger(row.revision)||(row.revision as number)<1||(row.role_id!==null&&!uuid(row.role_id))||(row.phase==='failed'?(typeof row.failure_code!=='string'||typeof row.failure_message!=='string'):(row.failure_code!==null||row.failure_message!==null)))throw Error();return {...base,itemLocalId:row.item_local_id,scope:row.scope,definition,roleId:row.role_id as string|null,mappingDigest:row.mapping_digest as string,phase:row.phase as Stored['phase'],revision:row.revision as number,failureCode:row.failure_code as string|null,failureMessage:row.failure_message as string|null,createdAt:stamp(row.created_at),updatedAt:stamp(row.updated_at)}}catch{throw corrupt()}}
 private async row(owner:string,id:string){const row=(await this.pool.query('select * from teloa_industry_role_instances where id=$1 and owner_id=$2',[id,owner])).rows[0];if(!row)throw new WorkError('teloa/forbidden','行业员工实例不存在或不属于当前本人。');return this.read(row)}
 private request(value:Stored){return {loadId:value.loadId,itemInstanceId:value.itemInstanceId,downstreamRequestId:value.downstreamRequestId,definitionHash:value.definitionHash,mappingDigest:value.mappingDigest}}
 private receiptTarget(row:Record<string,unknown>,input:{loadId:string;itemInstanceId:string}){const spec=row.request_spec;if(!isRecord(spec)||Object.keys(spec).length!==5||Object.keys(spec).some(key=>!['loadId','itemInstanceId','downstreamRequestId','definitionHash','mappingDigest'].includes(key))||!uuid(spec.loadId)||!uuid(spec.itemInstanceId)||!uuid(spec.downstreamRequestId)||typeof spec.definitionHash!=='string'||typeof spec.mappingDigest!=='string')throw corrupt();if(spec.loadId!==input.loadId||spec.itemInstanceId!==input.itemInstanceId)throw new WorkError('teloa/conflict','同一实例化请求不能更换加载项。')}
 private verifyReceipt(row:Record<string,unknown>,value:Stored,input:{loadId:string;itemInstanceId:string}){const spec=row.request_spec;if(!isRecord(spec)||Object.keys(spec).length!==5||spec.loadId!==input.loadId||spec.itemInstanceId!==input.itemInstanceId||spec.loadId!==value.loadId||spec.itemInstanceId!==value.itemInstanceId||spec.downstreamRequestId!==value.downstreamRequestId||spec.definitionHash!==value.definitionHash||spec.mappingDigest!==value.mappingDigest||row.owner_id!==value.ownerId||row.instance_id!==value.id)throw corrupt()}
 private async validate(value:Stored){const load=await this.loads.get(value.ownerId,{loadId:value.loadId}),item=load.items.find(item=>item.instanceId===value.itemInstanceId);if(!item||item.kind!=='role'||await this.loads.storedItemStatus(this.pool,value.ownerId,value.itemInstanceId)!=='pending-adapter'||item.localId!==value.itemLocalId||load.space.scope!==value.scope)throw corrupt()}
 private base(value:Stored){return {id:value.id,ownerId:value.ownerId,loadId:value.loadId,itemInstanceId:value.itemInstanceId,itemLocalId:value.itemLocalId,scope:value.scope,definitionHash:value.definitionHash,revision:value.revision,knowledge:value.knowledge,omittedKnowledge:value.omittedKnowledge,declarations:value.declarations,createdAt:value.createdAt,updatedAt:value.updatedAt}}
 private async project(value:Stored):Promise<IndustryRoleInstance>{await this.validate(value);const role=await this.roles.findByRequest(value.ownerId,{requestId:value.downstreamRequestId,expectedFields:value.definition});if(value.roleId&&!role)throw corrupt();if(role){if(value.roleId&&role.id!==value.roleId||role.ownerId!==value.ownerId)throw corrupt();return {...this.base(value),state:role.state,role,failure:null}}if(value.phase==='failed')return {...this.base(value),state:'failed',role:null,failure:{code:value.failureCode!,message:value.failureMessage!}};return {...this.base(value),state:'pending',role:null,failure:null}}
 private async update(value:Stored,phase:Stored['phase'],roleId?:string,failure?:{code:string;message:string}){const row=(await this.pool.query('update teloa_industry_role_instances set phase=$3,role_id=coalesce($4,role_id),failure_code=$5,failure_message=$6,revision=revision+1,updated_at=$7 where id=$1 and owner_id=$2 and revision=$8 and revision<2147483647 returning *',[value.id,value.ownerId,phase,roleId??null,failure?.code??null,failure?.message??null,this.identity.now(),value.revision])).rows[0];return row?this.read(row):this.row(value.ownerId,value.id)}
 private async coordinate(value:Stored){try{await this.validate(value);if(value.roleId)return this.project(value);let role=await this.roles.findByRequest(value.ownerId,{requestId:value.downstreamRequestId,expectedFields:value.definition});role??=await this.roles.create(value.ownerId,{requestId:value.downstreamRequestId,fields:value.definition},{state:'paused'});value=await this.update(value,'prepared',role.id);return this.project(value)}catch(error){if(error instanceof WorkError&&!['teloa/storage-unavailable','teloa/cancelled'].includes(error.code))throw error;value=await this.update(value,'needs-recovery');try{return await this.project(value)}catch(probe){if(probe instanceof WorkError&&['teloa/storage-unavailable','teloa/cancelled'].includes(probe.code))return {...this.base(value),state:'pending' as const,role:null,failure:null};throw probe}}}
 async instantiate(owner:string,input:unknown):Promise<IndustryRoleInstance>{own(owner);const data=exact(input,['requestId','loadId','itemInstanceId']);if(!uuid(data.requestId)||!uuid(data.loadId)||!uuid(data.itemInstanceId))throw invalid();const target={loadId:data.loadId.toLowerCase(),itemInstanceId:data.itemInstanceId.toLowerCase()},prior=(await this.pool.query('select * from teloa_industry_role_requests where owner_id=$1 and request_id=$2',[owner,data.requestId])).rows[0];if(prior){this.receiptTarget(prior,target);let value:Stored;try{value=await this.row(owner,prior.instance_id)}catch{throw corrupt()}this.verifyReceipt(prior,value,target);return this.coordinate(value)}
  const load=await this.loads.get(owner,{loadId:target.loadId}),item=load.items.find(item=>item.instanceId.toLowerCase()===target.itemInstanceId);if(!item||item.kind!=='role'||await this.loads.storedItemStatus(this.pool,owner,item.instanceId)!=='pending-adapter')throw new WorkError('teloa/conflict','目标不是可实例化的行业员工。');const existing=(await this.pool.query('select * from teloa_industry_role_instances where owner_id=$1 and load_id=$2 and item_instance_id=$3',[owner,target.loadId,target.itemInstanceId])).rows[0];if(existing){const value=this.read(existing);await this.pool.query('insert into teloa_industry_role_requests values($1,$2,$3,$4) on conflict(owner_id,request_id) do nothing',[owner,data.requestId,JSON.stringify(this.request(value)),value.id]);const receipt=(await this.pool.query('select * from teloa_industry_role_requests where owner_id=$1 and request_id=$2',[owner,data.requestId])).rows[0];this.receiptTarget(receipt,target);this.verifyReceipt(receipt,value,target);return this.coordinate(value)}
  const source=await this.roleSource.read(this.pool,owner,load.id,item.instanceId),scope=load.space.scope;const knowledge:IndustryRoleKnowledge[]=[],omittedKnowledge:IndustryRoleOmittedKnowledge[]=[];for(const relation of load.relations.filter(link=>link.kind==='role-knowledge'&&link.from===item.instanceId)){const targetItem=load.items.find(row=>row.instanceId===relation.to);if(!targetItem||targetItem.kind!=='knowledge')throw corrupt();const targetStatus=await this.loads.storedItemStatus(this.pool,owner,targetItem.instanceId);let instance:IndustryKnowledgeInstance|undefined;if(targetStatus==='pending-adapter'){const mapped=(await this.pool.query('select id from teloa_industry_knowledge_instances where owner_id=$1 and load_id=$2 and item_instance_id=$3',[owner,load.id,targetItem.instanceId])).rows[0];if(mapped)instance=await this.knowledge.get(owner,{instanceId:mapped.id})}if(instance?.state==='active'&&instance.resource){const expectedSource=industryReferenceId(load.id,targetItem.instanceId);if(instance.ownerId!==owner||instance.loadId!==load.id||instance.itemInstanceId!==targetItem.instanceId||instance.scope!==scope||instance.sourceId!==expectedSource||instance.resource.ownerId!==owner||instance.resource.sourceId!==expectedSource||instance.resource.sourceVersion!==instance.sourceVersion||JSON.stringify(instance.resource.scopeIds)!==JSON.stringify([scope]))throw corrupt();knowledge.push({itemInstanceId:targetItem.instanceId,instanceId:instance.id,resourceId:instance.resource.id,resourceVersion:instance.resource.version})}else{const reason:IndustryRoleOmittedKnowledge['reason']=targetStatus==='skipped'?'skipped':instance?.state==='pending'?'pending':instance?.state==='failed'?'failed':instance?.state==='withdrawn'?'withdrawn':'not-instantiated';omittedKnowledge.push({itemInstanceId:targetItem.instanceId,reason});if(targetItem.required)throw new WorkError('teloa/dependency-unavailable','请先启用员工所需的行业知识。')}}
  const declarationKinds=['skill','mcp','data-source','execution-tool'] as const,declarations:IndustryRoleDeclaration[]=[]
  for(const row of load.relations.filter(link=>link.from===item.instanceId).map(link=>load.items.find(row=>row.instanceId===link.to)).filter((row):row is NonNullable<typeof row>=>!!row&&declarationKinds.includes(row.kind as typeof declarationKinds[number])))declarations.push({kind:row.kind as IndustryRoleDeclaration['kind'],itemInstanceId:row.instanceId,status:await this.loads.storedItemStatus(this.pool,owner,row.instanceId)})
  if(source.ignoredModelSelection)declarations.push({kind:'model',itemInstanceId:item.instanceId,status:'skipped'})
  const definition=roleDefinition({...source.definition,scopes:[scope],skills:[],knowledge:knowledge.map(row=>row.resourceId)}),definitionHash=hash(definition),client=await this.pool.connect();let value:Stored
  try{await client.query('begin');await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['industry-role',owner,load.id,item.instanceId])]);let row=(await client.query('select * from teloa_industry_role_instances where owner_id=$1 and load_id=$2 and item_instance_id=$3',[owner,load.id,item.instanceId])).rows[0];if(!row){const id=this.identity.id(),downstream=this.identity.id(),now=this.identity.now(),base={id,ownerId:owner,loadId:load.id,itemInstanceId:item.instanceId,downstreamRequestId:downstream,definitionHash,knowledge,omittedKnowledge,declarations},mappingDigest=mappingHash(base);row=(await client.query(`insert into teloa_industry_role_instances(id,owner_id,load_id,item_instance_id,item_local_id,scope,definition,definition_hash,knowledge,omitted_knowledge,declarations,downstream_request_id,mapping_digest,role_id,phase,revision,failure_code,failure_message,created_at,updated_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,null,'prepared',1,null,null,$14,$14) returning *`,[id,owner,load.id,item.instanceId,item.localId,scope,JSON.stringify(definition),definitionHash,JSON.stringify(knowledge),JSON.stringify(omittedKnowledge),JSON.stringify(declarations),downstream,mappingDigest,now])).rows[0]}value=this.read(row);await client.query('insert into teloa_industry_role_requests values($1,$2,$3,$4) on conflict(owner_id,request_id) do nothing',[owner,data.requestId,JSON.stringify(this.request(value)),value.id]);const receipt=(await client.query('select * from teloa_industry_role_requests where owner_id=$1 and request_id=$2',[owner,data.requestId])).rows[0];this.receiptTarget(receipt,target);this.verifyReceipt(receipt,value,target);await client.query('commit')}catch(error){await client.query('rollback');throw error}finally{client.release()}return this.coordinate(value)}
 /**
  * 升级按 `use-template` 重放模板字段：把候选内容里的岗位定义原样写回真实岗位，本地修改一律被覆盖
  * （`keep-local` 的岗位根本不会进入这里）。空间范围、能力与知识仍取实例化当时固定下来的那份，
  * 它们不是模板字段。走 `RoleService.editInTransaction`，因此岗位版本 +1 且编辑回执照常落库。
  * 实例行上冻结的创建定义与下游请求身份一律不动：改了它，创建回执核对会失配。
  * 事务由调用方提供，任一步失败整笔升级回滚。
  * 此处故意不做乐观并发控制：调用方已持有旧加载的行锁，本方法再 `for update` 锁住岗位行后才读版本，
  * 两次读都在同一把锁内，因此不需要也不接受调用方传入 `expectedVersion`。
  */
 async applyTemplateInTransaction(db:PoolClient,owner:string,input:unknown):Promise<DigitalRole>{
  own(owner);const data=exact(input,['loadId','itemInstanceId','contentId','contentHash','itemLocalId','itemVersion'])
  if(!uuid(data.loadId)||!uuid(data.itemInstanceId)||!uuid(data.contentId)||typeof data.contentHash!=='string'||typeof data.itemLocalId!=='string'||typeof data.itemVersion!=='string')throw invalid()
  const row=(await db.query('select * from teloa_industry_role_instances where owner_id=$1 and load_id=$2 and item_instance_id=$3',[owner,data.loadId.toLowerCase(),data.itemInstanceId.toLowerCase()])).rows[0]
  if(!row)throw new WorkError('teloa/conflict','员工尚未实例化，不能按模板重放定义。')
  const value=this.read(row)
  if(!value.roleId)throw new WorkError('teloa/conflict','员工尚未建立，不能按模板重放定义。')
  // 模板读取复用本事务的连接：升级持有写事务，另取一条池连接在上限为 1 的部署上会自锁。
  const template=await this.roleSource.readTemplate(owner,{contentId:data.contentId,contentHash:data.contentHash,itemLocalId:data.itemLocalId,itemVersion:data.itemVersion},db)
  const current=(await db.query('select version,definition from teloa_roles where id=$1 and owner_id=$2 for update',[value.roleId,owner])).rows[0]
  if(!current||!Number.isSafeInteger(Number(current.version)))throw corrupt()
  // 复审 M-a：模板不能指定岗位模型，因此重放模板也不能清掉本人已为该岗位选择的首选/备用模型；其余运行配置按模板。
  let chosen:RoleRuntimeConfig|undefined
  try{const stored=isRecord(current.definition)?current.definition.runtimeConfig:undefined;chosen=stored===undefined?undefined:readRoleRuntimeConfig(stored)}catch{throw corrupt()}
  const {runtimeConfig:templateRuntime,...templateRest}=template.definition
  const runtimeConfig={...templateRuntime,...(chosen?.model?{model:chosen.model}:{}),...(chosen?.fallbackModel?{fallbackModel:chosen.fallbackModel}:{})}
  const fields=roleDefinition({...templateRest,...(Object.keys(runtimeConfig).length?{runtimeConfig}:{}),scopes:[value.scope],skills:[],knowledge:value.knowledge.map(item=>item.resourceId)})
  const role=await this.roles.editInTransaction(db,owner,{roleId:value.roleId,expectedVersion:Number(current.version),fields})
  // 复审 M-b：升级候选模板带模型指定时同样给出可见提示——补记 model/skipped 声明并同步映射摘要与创建回执里的摘要（不动创建定义与下游请求身份）。
  if(template.ignoredModelSelection&&!value.declarations.some(row=>row.kind==='model')){
   const declarations=[...value.declarations,{kind:'model' as const,itemInstanceId:value.itemInstanceId,status:'skipped' as const}]
   const mappingDigest=mappingHash({id:value.id,ownerId:value.ownerId,loadId:value.loadId,itemInstanceId:value.itemInstanceId,downstreamRequestId:value.downstreamRequestId,definitionHash:value.definitionHash,knowledge:value.knowledge,omittedKnowledge:value.omittedKnowledge,declarations})
   const updated=await db.query('update teloa_industry_role_instances set declarations=$3,mapping_digest=$4,revision=revision+1,updated_at=$5 where id=$1 and owner_id=$2 and revision=$6 and revision<2147483647',[value.id,owner,JSON.stringify(declarations),mappingDigest,this.identity.now(),value.revision])
   if(updated.rowCount!==1)throw corrupt()
   await db.query("update teloa_industry_role_requests set request_spec=jsonb_set(request_spec,'{mappingDigest}',to_jsonb($3::text)) where owner_id=$1 and instance_id=$2",[owner,value.id,mappingDigest])
  }
  return role
 }
 async get(owner:string,input:unknown){own(owner);const data=exact(input,['instanceId']);if(!uuid(data.instanceId))throw invalid();return this.project(await this.row(owner,data.instanceId))}
 async list(owner:string,input:unknown):Promise<IndustryRolePage>{own(owner);exact(input,[]);const rows=(await this.pool.query('select * from teloa_industry_role_instances where owner_id=$1 order by created_at,id',[owner])).rows,items=[];for(const row of rows)items.push(await this.project(this.read(row)));return {items}}
 /** 本人按条目版本已建且未退役的岗位 id，按条目 id 归组；未建或已退役的条目不在结果里。供目录列表回显「已添加」。 */
 async catalogRoleIds(owner:string,entries:readonly Pick<MarketCatalogRoleEntry,'id'|'version'>[]):Promise<Map<string,string>>{
  own(owner);const result=new Map<string,string>()
  for(const [entryId,found] of await this.catalogRoleRequests(owner,entries))if(found.roleId)result.set(entryId,found.roleId)
  return result
 }
 /**
  * 按请求 id 一次批量查本人目录岗位；命中退役岗位的条目沿下一代请求 id 再查一轮，
  * 因此没有退役记录时只有一次查询。结果给出每个条目当前应使用的请求 id 与其未退役岗位。
  * 轮数上限：每进一轮，链上都必须真有一行已退役岗位（下一代 id 由上一代 id 与该岗位 id 散列派生，不会成环），
  * 所以总轮数 = 本页最长退役链长度 + 1，受本人为同一条目版本「添加后又退役」的次数约束；各条目同轮批量查，不按条目叠加。
  */
 private async catalogRoleRequests(owner:string,entries:readonly Pick<MarketCatalogRoleEntry,'id'|'version'>[]):Promise<Map<string,{requestId:string;roleId:string|null}>>{
  const result=new Map<string,{requestId:string;roleId:string|null}>()
  let pending=new Map(entries.map(entry=>[catalogRoleRequestId(owner,entry.id,entry.version),entry.id]))
  while(pending.size){
   const rows=(await this.pool.query('select id,request_id,state from teloa_roles where owner_id=$1 and request_id=any($2::uuid[])',[owner,[...pending.keys()]])).rows
   const byRequest=new Map(rows.map(row=>[String(row.request_id),row])),next=new Map<string,string>()
   for(const [requestId,entryId] of pending){
    const row=byRequest.get(requestId)
    if(row?.state==='retired')next.set(nextCatalogRoleRequestId(requestId,String(row.id)),entryId)
    else result.set(entryId,{requestId,roleId:row?String(row.id):null})
   }
   pending=next
  }
  return result
 }
 /**
  * 从目录 role 条目建岗位：不创建方案加载、不经 teloa_industry_load。
  * 幂等：requestId 由 (owner, entryId, version) 派生，同一人重复添加同一条目版本落到同一条岗位并回 existing；
  * created/existing 由 `RoleService.createOrExisting` 在创建锁内判定，并发同时添加也恰有一个 created。
  * 该岗位退役后不再算已添加：改用下一代请求 id，同一条目版本可重新建一条新岗位。
  * 目录未升版本却改了内容时，同一 requestId 对应的定义不再一致，按冲突提示刷新，而不是当作存储损坏。
  * scopes 继承条目 scope（= 所属方案 scope）。
  */
 async createFromCatalog(owner:string,input:unknown,entry:MarketCatalogRoleEntry):Promise<CatalogRoleReceipt>{
  own(owner);const data=exact(input,['entryId','version'])
  if(typeof data.entryId!=='string'||typeof data.version!=='string')throw invalid()
  if(data.entryId!==entry.id||data.version!==entry.version)throw new WorkError('teloa/version-conflict','目录条目已更新，请重新预览后再添加。')
  const fields=roleDefinition({...entry.role.definition,scopes:[entry.role.scope],skills:entry.role.skills,knowledge:[]})
  let result:{role:DigitalRole;existing:boolean}
  // 查到请求 id 与创建之间岗位恰被退役时，重新沿下一代请求 id 创建。
  do{
   const requestId=(await this.catalogRoleRequests(owner,[entry])).get(entry.id)!.requestId
   try{result=await this.roles.createOrExisting(owner,{requestId,fields},{state:'paused'})}
   catch(error){if(error instanceof WorkError&&error.code==='teloa/conflict')throw new WorkError('teloa/conflict','目录条目已变化，请刷新后重试。');throw error}
  }while(result.existing&&result.role.state==='retired')
  return {roleId:result.role.id,status:result.existing?'existing':'created',skills:[...entry.role.skills]}
 }
}

/**
 * 供业务空间迁移重算存量行上的两个派生列：`definition_hash` 由固定岗位定义（含 `scopes`）算出，
 * `mapping_digest` 再由 `definition_hash` 算出。迁移改写范围取值后按同一份算法回填。
 */
export const industryRoleDigests={definition:(value:RoleDefinition)=>hash(value),mapping:mappingHash}

import {createHash} from 'node:crypto'
import type {Pool,PoolClient} from 'pg'
import {WorkError,isRecord} from '@teloa/contract'
import type {SkillInstallSourceBundle,SkillInstallSourceIdentity,SkillInstallSourceInput} from './skill-install-source.ts'
import {createSkillAvailability,initializeSkillAvailabilities,readSkillAvailability,type SkillAvailabilityValue} from './skill-availability.ts'
import {ensureInitialSkillSelection,initializeSkillSelections} from './skill-selections.ts'
import {marketTrustHash,normalizeMarketSourceTrust,type MarketSourceTrust} from './content-store.ts'

export type NativeSkillMetadata={name:string;description:string;modelInvocable:boolean;userInvocable:boolean;bodyHash:string}
export type SkillInstallationPlan={skills:{id:string;version:string;path:'SKILL.md'}[];plugins:MarketSourceTrust['plugins'];connections:MarketSourceTrust['externalCapabilities'];permissions:MarketSourceTrust['permissions']}
export type SkillInstallPreview={source:SkillInstallSourceIdentity;bundleHash:string;native:NativeSkillMetadata;files:{path:string;hash:string;size:number}[];trust?:MarketSourceTrust;trustHash?:string;installationPlan?:SkillInstallationPlan}
export type SkillInstallation={id:string;ownerId:string;source:SkillInstallSourceIdentity;bundleHash:string;native:NativeSkillMetadata;trust?:MarketSourceTrust;trustHash?:string;state:'preparing'|'installed';version:number;createdAt:string;updatedAt:string}
export type SkillInstallationFilesPort={inspect:(bundle:SkillInstallSourceBundle)=>Promise<NativeSkillMetadata>;publish:(id:string,bundle:SkillInstallSourceBundle,native:NativeSkillMetadata)=>Promise<void>;verify:(id:string,bundle:SkillInstallSourceBundle,native:NativeSkillMetadata)=>Promise<void>;remove:(id:string)=>Promise<void>}
/** 硬卸载输入：必须二次确认；版本与包摘要匹配当前安装，避免误删另一份版本。 */
export type SkillUninstallRequest={requestId:string;installationId:string;expectedVersion:number;expectedBundleHash:string;confirm:true}
export type SkillUninstallBlocker='selected'|'industry-usage'|'run-history'
/** 硬卸载回执：只含本人可读的安装身份与时间，不暴露原生路径。 */
export type SkillUninstallReceipt={requestId:string;installationId:string;nativeName:string;bundleHash:string;removedAt:string}
type Reader={read:(owner:string,input:SkillInstallSourceInput)=>Promise<SkillInstallSourceBundle>}

const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v),hex=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v),text=(v:unknown,n:number):v is string=>typeof v==='string'&&!!v.trim()&&v.length<=n,positive=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0&&Number(v)<=2147483647
const exact=(v:unknown,keys:readonly string[])=>{if(!isRecord(v)||Object.keys(v).some(k=>!keys.includes(k)))throw invalid();return v}
const invalid=()=>new WorkError('teloa/invalid-input','技能安装请求格式不正确。'),corrupt=()=>new WorkError('teloa/storage-corrupt','技能安装记录损坏，已停止读取。')
const stable=(v:unknown):string=>JSON.stringify(v,(_,x)=>isRecord(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a<b?-1:a>b?1:0)):x)
const sha=(v:string)=>createHash('sha256').update(v).digest('hex'),stamp=(v:unknown)=>{if(!(v instanceof Date)||!Number.isFinite(v.getTime()))throw corrupt();return v.toISOString()}
function input(v:unknown):SkillInstallSourceInput{const row=exact(v,['kind','contentId','loadId','itemInstanceId']);if(row.kind==='atomic'){exact(row,['kind','contentId']);if(!uuid(row.contentId))throw invalid();return {kind:'atomic',contentId:row.contentId.toLowerCase()}}exact(row,['kind','loadId','itemInstanceId']);if(row.kind!=='industry'||!uuid(row.loadId)||!uuid(row.itemInstanceId))throw invalid();return {kind:'industry',loadId:row.loadId.toLowerCase(),itemInstanceId:row.itemInstanceId.toLowerCase()}}
/** teloa- 前缀保留给 Teloa 内置技能：新安装一律拒绝，避免本人技能被内置创建器在会话里静默遮住（验收 A6）。 */
function reservedName(metadata:NativeSkillMetadata):NativeSkillMetadata{if(metadata.name.startsWith('teloa-'))throw new WorkError('teloa/invalid-input','以 teloa- 开头的技能名保留给 Teloa 内置技能，请换一个名称。');return metadata}
function native(v:unknown,stored=false):NativeSkillMetadata{if(!isRecord(v)||Object.keys(v).some(key=>!['name','description','modelInvocable','userInvocable','bodyHash'].includes(key))||typeof v.name!=='string'||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(v.name)||typeof v.description!=='string'||v.description.length===0||typeof v.modelInvocable!=='boolean'||typeof v.userInvocable!=='boolean'||!hex(v.bodyHash))throw stored?corrupt():new WorkError('teloa/source-unavailable','原生技能元数据无效。');return {name:v.name,description:v.description,modelInvocable:v.modelInvocable,userInvocable:v.userInvocable,bodyHash:v.bodyHash}}
function source(v:unknown):SkillInstallSourceIdentity{try{if(!isRecord(v))throw Error();const common=()=>{if(!uuid(v.contentId)||!hex(v.contentHash)||!text(v.resourceId,120)||!text(v.resourceVersion,80))throw Error()};if(v.kind==='atomic'){exact(v,['kind','contentId','contentHash','resourceId','resourceVersion']);common();return v as unknown as SkillInstallSourceIdentity}if(v.kind==='industry-local'){exact(v,['kind','loadId','itemInstanceId','contentId','contentHash','resourceId','resourceVersion']);common();if(!uuid(v.loadId)||!uuid(v.itemInstanceId))throw Error();return v as unknown as SkillInstallSourceIdentity}if(v.kind==='industry-public'){exact(v,['kind','loadId','itemInstanceId','contentId','contentHash','sourceContentId','sourceContentHash','sourceResourceId','sourceResourceVersion','resourceId','resourceVersion']);common();if(!uuid(v.loadId)||!uuid(v.itemInstanceId)||!uuid(v.sourceContentId)||!hex(v.sourceContentHash)||!text(v.sourceResourceId,120)||!text(v.sourceResourceVersion,80))throw Error();return v as unknown as SkillInstallSourceIdentity}throw Error()}catch{throw corrupt()}}
function sourceIdentity(v:SkillInstallSourceIdentity){return v.kind==='atomic'?['atomic',v.contentId,v.contentHash,v.resourceId,v.resourceVersion]:v.kind==='industry-public'?['atomic',v.sourceContentId,v.sourceContentHash,v.sourceResourceId,v.sourceResourceVersion]:['industry-local',v.contentId,v.contentHash,v.resourceId,v.resourceVersion]}
function sourceKey(v:SkillInstallSourceIdentity,trustHash?:string){const identity=sourceIdentity(v);return sha(stable(trustHash?[identity,{trustHash}]:identity))}
function recordHash(id:string,ownerId:string,v:SkillInstallSourceIdentity,bundleHash:string,metadata:NativeSkillMetadata,trust?:MarketSourceTrust,trustHash?:string){return sha(stable(trust?[id,ownerId,v,bundleHash,metadata,trust,trustHash]:[id,ownerId,v,bundleHash,metadata]))}
function fixedTrust(bundle:SkillInstallSourceBundle):{trust:MarketSourceTrust;trustHash:string}|undefined{if(bundle.trust===undefined&&bundle.trustHash===undefined)return undefined;if(bundle.trust===undefined||!hex(bundle.trustHash))throw corrupt();let trust:MarketSourceTrust;try{trust=normalizeMarketSourceTrust(bundle.trust)}catch{throw corrupt()}if(marketTrustHash(trust)!==bundle.trustHash)throw corrupt();return {trust,trustHash:bundle.trustHash}}
/**
 * 行业方法的等价安装：同一本人已装的另一加载的同名方法，若资源标识与版本、整包字节摘要、原生元数据与信任说明都相同，
 * 就是同一份固定方法（例如团队包与从它派生的单员工包），新加载直接引用它而不再另装一份。来源内容不同的同名安装不算等价。
 */
function equivalentIndustry(found:SkillInstallation,fixed:SkillInstallSourceIdentity,bundleHash:string,metadata:NativeSkillMetadata,trustHash:string|undefined){
 return fixed.kind!=='atomic'&&found.source.kind!=='atomic'&&found.source.resourceId===fixed.resourceId&&found.source.resourceVersion===fixed.resourceVersion&&found.bundleHash===bundleHash&&stable(found.native)===stable(metadata)&&found.trustHash===trustHash
}
function usageHash(ownerId:string,loadId:string,itemInstanceId:string,installationId:string){return sha(stable([ownerId,loadId,itemInstanceId,installationId]))}
/** initialAvailability 缺省为 enabled（兼容既有调用）；disabled 写入请求指纹，同一请求身份不能改投另一初始启停。 */
function request(v:unknown){const row=exact(v,['requestId','source','expectedBundleHash','expectedTrustHash','initialAvailability']);if(!uuid(row.requestId)||!hex(row.expectedBundleHash)||row.expectedTrustHash!==undefined&&!hex(row.expectedTrustHash)||row.initialAvailability!==undefined&&row.initialAvailability!=='enabled'&&row.initialAvailability!=='disabled')throw invalid();const fixed=input(row.source),initialAvailability:SkillAvailabilityValue=row.initialAvailability==='disabled'?'disabled':'enabled';return {requestId:row.requestId.toLowerCase(),source:fixed,expectedBundleHash:row.expectedBundleHash,expectedTrustHash:row.expectedTrustHash as string|undefined,initialAvailability,spec:{source:fixed,expectedBundleHash:row.expectedBundleHash,...(row.expectedTrustHash?{expectedTrustHash:row.expectedTrustHash}:{}),...(initialAvailability==='disabled'?{initialAvailability}:{})}}}

export async function initializeSkillInstallations(pool:Pool){await pool.query(`create table if not exists teloa_skill_installations(id uuid primary key,owner_id text not null,source jsonb not null check(jsonb_typeof(source)='object'),source_key text not null check(source_key ~ '^[a-f0-9]{64}$'),bundle_hash text not null check(bundle_hash ~ '^[a-f0-9]{64}$'),record_hash text not null check(record_hash ~ '^[a-f0-9]{64}$'),native jsonb not null check(jsonb_typeof(native)='object'),native_name text not null,state text not null check(state in ('preparing','installed')),version integer not null check(version>0),created_at timestamptz not null,updated_at timestamptz not null,trust jsonb,trust_hash text,unique(owner_id,source_key),unique(owner_id,native_name));create table if not exists teloa_skill_install_requests(owner_id text not null,request_id uuid not null,request_spec jsonb not null check(jsonb_typeof(request_spec)='object'),resolved_source jsonb not null check(jsonb_typeof(resolved_source)='object'),installation_id uuid not null references teloa_skill_installations(id),primary key(owner_id,request_id));create table if not exists teloa_skill_install_usages(owner_id text not null,load_id uuid not null,item_instance_id uuid not null,installation_id uuid not null references teloa_skill_installations(id),usage_hash text not null check(usage_hash ~ '^[a-f0-9]{64}$'),primary key(owner_id,load_id,item_instance_id))`);await pool.query('alter table teloa_skill_installations add column if not exists trust jsonb; alter table teloa_skill_installations add column if not exists trust_hash text');await pool.query(`create table if not exists teloa_skill_uninstall_requests(owner_id text not null,request_id uuid not null,installation_id uuid not null,request_spec jsonb not null check(jsonb_typeof(request_spec)='object'),result jsonb not null check(jsonb_typeof(result)='object'),created_at timestamptz not null,primary key(owner_id,request_id))`);await initializeSkillSelections(pool);await initializeSkillAvailabilities(pool)}

export function readStoredSkillInstallation(row:Record<string,unknown>,ownerId:string):SkillInstallation{if(row.owner_id!==ownerId||!uuid(row.id)||!hex(row.source_key)||!hex(row.bundle_hash)||!hex(row.record_hash)||!['preparing','installed'].includes(String(row.state))||!positive(row.version))throw corrupt();const fixed=source(row.source),metadata=native(row.native,true);let trust:MarketSourceTrust|undefined,trustHash:string|undefined;if(row.trust!==null&&row.trust!==undefined||row.trust_hash!==null&&row.trust_hash!==undefined){if(!isRecord(row.trust)||!hex(row.trust_hash))throw corrupt();try{trust=normalizeMarketSourceTrust(row.trust)}catch{throw corrupt()}trustHash=row.trust_hash;if(marketTrustHash(trust)!==trustHash)throw corrupt()}const currentKey=sourceKey(fixed,trustHash),legacyKey=sourceKey(fixed);if(row.source_key!==currentKey&&(trustHash===undefined||row.source_key!==legacyKey)||recordHash(row.id,ownerId,fixed,row.bundle_hash as string,metadata,trust,trustHash)!==row.record_hash||metadata.name!==row.native_name)throw corrupt();return {id:row.id,ownerId,source:fixed,bundleHash:row.bundle_hash,native:metadata,...(trust&&trustHash?{trust,trustHash}:{}),state:row.state as SkillInstallation['state'],version:row.version,createdAt:stamp(row.created_at),updatedAt:stamp(row.updated_at)}}
export async function readInstalledSkillInstallation(db:PoolClient,ownerId:string,installationId:string):Promise<SkillInstallation>{
 const row=(await db.query('select * from teloa_skill_installations where id=$1',[installationId])).rows[0]
 if(!row||row.owner_id!==ownerId)throw new WorkError('teloa/forbidden','技能安装不存在或不属于当前本人。')
 const installation=readStoredSkillInstallation(row,ownerId)
 if(installation.state!=='installed')throw new WorkError('teloa/conflict','技能安装尚未完成，不能固定到执行。')
 return installation
}
export async function readEnabledSkillInstallation(db:PoolClient,ownerId:string,installationId:string):Promise<SkillInstallation>{
 const installation=await readInstalledSkillInstallation(db,ownerId,installationId)
 if((await readSkillAvailability(db,ownerId,installationId)).availability!=='enabled')throw new WorkError('teloa/conflict','技能已停用，不能固定到新执行。')
 return installation
}

/** 行业使用关系只按加载项身份读取；缺失时由调用方决定是否为必需依赖。 */
export async function readEnabledIndustrySkillUsage(db:PoolClient,ownerId:string,loadId:string,itemInstanceId:string):Promise<SkillInstallation|null>{
 const row=(await db.query('select * from teloa_skill_install_usages where owner_id=$1 and load_id=$2 and item_instance_id=$3 for share',[ownerId,loadId,itemInstanceId])).rows[0]
 if(!row)return null
 if(row.owner_id!==ownerId||row.load_id!==loadId||row.item_instance_id!==itemInstanceId||!uuid(row.installation_id)||!hex(row.usage_hash)||row.usage_hash!==usageHash(ownerId,loadId,itemInstanceId,row.installation_id))throw corrupt()
 try{return await readEnabledSkillInstallation(db,ownerId,row.installation_id)}catch(error){
  if(error instanceof WorkError&&error.code==='teloa/forbidden')throw corrupt()
  throw error
 }
}

const uninstallBlockerMessages:Record<SkillUninstallBlocker,string>={selected:'该技能还有其他版本，请先切换到要保留的版本再卸载。','industry-usage':'该技能仍被加载包引用，请先卸载加载包。','run-history':'该技能已被历史运行引用，保留运行证据，只可停用。'}
const uninstallBlockerOrder:readonly SkillUninstallBlocker[]=['selected','industry-usage','run-history']
function uninstallInput(value:unknown):SkillUninstallRequest{
 const row=exact(value,['requestId','installationId','expectedVersion','expectedBundleHash','confirm'])
 if(!uuid(row.requestId)||!uuid(row.installationId)||!positive(row.expectedVersion)||!hex(row.expectedBundleHash)||row.confirm!==true)throw invalid()
 return {requestId:(row.requestId as string).toLowerCase(),installationId:(row.installationId as string).toLowerCase(),expectedVersion:row.expectedVersion as number,expectedBundleHash:row.expectedBundleHash as string,confirm:true}
}
function uninstallSpec(input:SkillUninstallRequest):Record<string,unknown>{return {installationId:input.installationId,expectedVersion:input.expectedVersion,expectedBundleHash:input.expectedBundleHash,confirm:true}}
function uninstallInUse(blockers:readonly SkillUninstallBlocker[]):WorkError{return new WorkError('teloa/conflict',blockers.map(blocker=>uninstallBlockerMessages[blocker]).join(' '),{reason:'skill-in-use',blockers:[...blockers]})}
function readUninstallReceipt(row:Record<string,unknown>,ownerId:string,requestId:string):{requestSpec:unknown;result:SkillUninstallReceipt}{
 if(row.owner_id!==ownerId||row.request_id!==requestId||!uuid(row.installation_id)||!isRecord(row.request_spec)||!isRecord(row.result))throw corrupt()
 const result=row.result
 if(Object.keys(result).length!==5||!('requestId' in result)||!('installationId' in result)||!('nativeName' in result)||!('bundleHash' in result)||!('removedAt' in result))throw corrupt()
 if(result.requestId!==requestId||result.installationId!==row.installation_id||typeof result.nativeName!=='string'||!result.nativeName||!hex(result.bundleHash)||typeof result.removedAt!=='string'||!Number.isFinite(Date.parse(result.removedAt))||new Date(result.removedAt).toISOString()!==result.removedAt)throw corrupt()
 return {requestSpec:row.request_spec,result:{requestId:result.requestId as string,installationId:result.installationId as string,nativeName:result.nativeName as string,bundleHash:result.bundleHash as string,removedAt:result.removedAt as string}}
}
/** 只检查真实存在的表：历史运行引用表在部分环境尚未初始化时不能把卸载变成不可用。 */
async function tablePresent(db:PoolClient,name:string):Promise<boolean>{return (await db.query('select to_regclass($1) is not null present',[name])).rows[0]?.present===true}

/** 卸载行业模板时解除该加载的全部 Skill 使用关系：安装记录本身与其它加载的使用方都不受影响。 */
export async function deleteIndustryUsages(db:PoolClient,ownerId:string,loadId:string):Promise<number>{
 return (await db.query('delete from teloa_skill_install_usages where owner_id=$1 and load_id=$2',[ownerId,loadId])).rowCount??0
}

export class SkillInstallationService{
 private readonly pool:Pool;private readonly identity:{id:()=>string;now:()=>string};private readonly sourceReader:Reader;private readonly files:SkillInstallationFilesPort;private readonly queues=new Map<string,Promise<void>>()
 constructor(pool:Pool,identity:{id:()=>string;now:()=>string},sourceReader:Reader,files:SkillInstallationFilesPort){this.pool=pool;this.identity=identity;this.sourceReader=sourceReader;this.files=files}
 private async tx<T>(fn:(db:PoolClient)=>Promise<T>){const db=await this.pool.connect();try{await db.query('begin');const value=await fn(db);await db.query('commit');return value}catch(e){await db.query('rollback').catch(()=>{});if(e instanceof WorkError)throw e;throw new WorkError('teloa/storage-unavailable','技能安装存储操作未完成。')}finally{db.release()}}
 private async serial<T>(key:string,fn:()=>Promise<T>):Promise<T>{const prior=this.queues.get(key)??Promise.resolve(),gate=prior.catch(()=>{}).then(fn),marker=gate.then(()=>{},()=>{});this.queues.set(key,marker);try{return await gate}finally{if(this.queues.get(key)===marker)this.queues.delete(key)}}
 private async find(db:PoolClient,ownerId:string,id:string){const row=(await db.query('select * from teloa_skill_installations where id=$1',[id])).rows[0];if(!row)throw new WorkError('teloa/forbidden','技能安装不存在或不属于当前本人。');if(row.owner_id!==ownerId)throw new WorkError('teloa/forbidden','技能安装不存在或不属于当前本人。');return readStoredSkillInstallation(row,ownerId)}
 async preview(ownerId:string,v:unknown):Promise<SkillInstallPreview>{const row=exact(v,['source']),fixed=input(row.source),bundle=await this.sourceReader.read(ownerId,fixed),metadata=reservedName(native(await this.files.inspect(bundle))),trust=fixedTrust(bundle);return {source:source(bundle.source),bundleHash:bundle.bundleHash,native:metadata,files:bundle.files.map(x=>({path:x.path,hash:x.hash,size:x.bytes.byteLength})),...(trust?{...trust,installationPlan:{skills:[{id:bundle.source.resourceId,version:bundle.source.resourceVersion,path:'SKILL.md' as const}],plugins:trust.trust.plugins,connections:trust.trust.externalCapabilities,permissions:trust.trust.permissions}}:{})}}
 async install(ownerId:string,v:unknown):Promise<{installation:SkillInstallation;source:SkillInstallSourceIdentity}>{
  if(!text(ownerId,128))throw new WorkError('teloa/forbidden','需要有效的本人身份。');const data=request(v)
  let initial:Record<string,unknown>|undefined
  try{initial=(await this.pool.query('select request_spec,resolved_source from teloa_skill_install_requests where owner_id=$1 and request_id=$2',[ownerId,data.requestId])).rows[0]}catch{throw new WorkError('teloa/storage-unavailable','技能安装存储当前不可读取。')}
  if(initial&&stable(initial.request_spec)!==stable(data.spec))throw new WorkError('teloa/conflict','同一技能安装请求不能更换来源、校验值或启用选择。')
  const initialSource=initial?source(initial.resolved_source):undefined,bundle=await this.sourceReader.read(ownerId,data.source)
  if(bundle.ownerId!==ownerId||bundle.bundleHash!==data.expectedBundleHash)throw new WorkError('teloa/source-unavailable','技能锁定来源的校验值已变化。')
  const trust=fixedTrust(bundle);if(trust&&data.expectedTrustHash!==trust.trustHash)throw new WorkError('teloa/source-unavailable','来源的信任说明已变化，请重新预览并核对。');if(!trust&&data.expectedTrustHash!==undefined)throw new WorkError('teloa/source-unavailable','来源的信任说明与安装请求不一致。');if(trust?.trust.signature.status==='invalid'||trust?.trust.review.conclusion==='rejected')throw new WorkError('teloa/source-unavailable','来源签名或审查结论无效，拒绝安装。')
  const fixed=source(bundle.source),metadata=reservedName(native(await this.files.inspect(bundle))),key=sourceKey(fixed,trust?.trustHash),legacyKey=sourceKey(fixed);if(initialSource&&stable(initialSource)!==stable(fixed))throw corrupt()
  return this.serial(ownerId+':'+key,async()=>{
   const prepared=await this.tx(async db=>{
    await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[stable(['skill-install-request',ownerId,data.requestId])])
    const receipt=(await db.query('select * from teloa_skill_install_requests where owner_id=$1 and request_id=$2',[ownerId,data.requestId])).rows[0]
    if(receipt){
     if(stable(receipt.request_spec)!==stable(data.spec))throw new WorkError('teloa/conflict','同一技能安装请求不能更换来源、校验值或启用选择。')
     if(stable(source(receipt.resolved_source))!==stable(fixed)||!uuid(receipt.installation_id))throw corrupt()
     const found=await this.find(db,ownerId,receipt.installation_id);if(sourceKey(found.source,found.trustHash)!==key&&!equivalentIndustry(found,fixed,bundle.bundleHash,metadata,trust?.trustHash)||found.bundleHash!==bundle.bundleHash||stable(found.native)!==stable(metadata)||found.trustHash!==trust?.trustHash)throw corrupt();return found
    }
    await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[stable(['skill-install-source',ownerId,key])]);await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[stable(['skill-install-name',ownerId,metadata.name])])
    let foundRow=(await db.query('select * from teloa_skill_installations where owner_id=$1 and (source_key=$2 or (source_key=$3 and trust_hash is not distinct from $4)) order by (source_key=$2) desc for update',[ownerId,key,legacyKey,trust?.trustHash??null])).rows[0],found:SkillInstallation,shared=false
    // 本来源尚无安装时，在同名锁内找本人已装的等价行业方法（只按本人、同名、同字节摘要与信任说明筛选，再逐项核对）
    if(!foundRow&&fixed.kind!=='atomic'){
     const candidates=(await db.query('select * from teloa_skill_installations where owner_id=$1 and native_name=$2 and bundle_hash=$3 and trust_hash is not distinct from $4 order by created_at,id for update',[ownerId,metadata.name,bundle.bundleHash,trust?.trustHash??null])).rows
     foundRow=candidates.find(row=>equivalentIndustry(readStoredSkillInstallation(row,ownerId),fixed,bundle.bundleHash,metadata,trust?.trustHash));shared=!!foundRow
    }
    if(foundRow){found=readStoredSkillInstallation(foundRow,ownerId);if(found.bundleHash!==bundle.bundleHash||stable(found.native)!==stable(metadata)||found.trustHash!==trust?.trustHash)throw corrupt();if(!shared&&foundRow.source_key!==key){foundRow=(await db.query('update teloa_skill_installations set source_key=$3 where id=$1 and owner_id=$2 returning *',[found.id,ownerId,key])).rows[0];found=readStoredSkillInstallation(foundRow,ownerId)}// 复用已有安装从不改动其启停：要求不启用时保留本人或其他引用方的现状，回执按实际值读回。
    if((await readSkillAvailability(db,ownerId,found.id)).availability!=='enabled'&&data.initialAvailability!=='disabled')throw new WorkError('teloa/conflict','技能已停用，请先恢复后再新增安装引用。')}
    else{
     const id=this.identity.id(),at=this.identity.now();if(!uuid(id)||!Number.isFinite(Date.parse(at)))throw invalid()
     foundRow=(await db.query('insert into teloa_skill_installations(id,owner_id,source,source_key,bundle_hash,record_hash,native,native_name,trust,trust_hash,state,version,created_at,updated_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1,$12,$12) returning *',[id,ownerId,JSON.stringify(fixed),key,bundle.bundleHash,recordHash(id,ownerId,fixed,bundle.bundleHash,metadata,trust?.trust,trust?.trustHash),JSON.stringify(metadata),metadata.name,trust?JSON.stringify(trust.trust):null,trust?.trustHash??null,'preparing',at])).rows[0];found=readStoredSkillInstallation(foundRow,ownerId);await createSkillAvailability(db,ownerId,found.id,at,data.initialAvailability)
    }
    await db.query('insert into teloa_skill_install_requests values($1,$2,$3,$4,$5)',[ownerId,data.requestId,JSON.stringify(data.spec),JSON.stringify(fixed),found.id])
    if(fixed.kind!=='atomic'){await db.query('insert into teloa_skill_install_usages values($1,$2,$3,$4,$5) on conflict(owner_id,load_id,item_instance_id) do update set installation_id=excluded.installation_id,usage_hash=excluded.usage_hash',[ownerId,fixed.loadId,fixed.itemInstanceId,found.id,usageHash(ownerId,fixed.loadId,fixed.itemInstanceId,found.id)]);const usage=(await db.query('select installation_id from teloa_skill_install_usages where owner_id=$1 and load_id=$2 and item_instance_id=$3',[ownerId,fixed.loadId,fixed.itemInstanceId])).rows[0];if(usage?.installation_id!==found.id)throw corrupt()}
    return found
   })
   const installation=await this.tx(async db=>{await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[stable(['skill-install-publish',ownerId,prepared.id])]);const current=await this.find(db,ownerId,prepared.id);let installed:SkillInstallation;if(current.state==='installed'){await this.files.verify(current.id,bundle,metadata);installed=current}else{await this.files.publish(current.id,bundle,metadata);const row=(await db.query("update teloa_skill_installations set state='installed',version=version+1,updated_at=$3 where id=$1 and owner_id=$2 and state='preparing' returning *",[current.id,ownerId,this.identity.now()])).rows[0];if(!row)throw corrupt();installed=readStoredSkillInstallation(row,ownerId)}await ensureInitialSkillSelection(db,ownerId,installed,this.identity.now());return installed})
   return {installation,source:fixed}
  })
 }
 async get(ownerId:string,v:unknown){const row=exact(v,['installationId']);if(!uuid(row.installationId)||!text(ownerId,128))throw invalid();return this.tx(db=>this.find(db,ownerId,row.installationId as string))}
 async list(ownerId:string,v:unknown):Promise<{items:SkillInstallation[];usages:{loadId:string;itemInstanceId:string;installationId:string}[]}>{exact(v,[]);if(!text(ownerId,128))throw new WorkError('teloa/forbidden','需要有效的本人身份。');return this.tx(async db=>{const rows=(await db.query('select * from teloa_skill_installations where owner_id=$1 order by created_at,id',[ownerId])).rows,items=rows.map(row=>readStoredSkillInstallation(row,ownerId)),ids=new Set(items.map(x=>x.id)),usageRows=(await db.query('select * from teloa_skill_install_usages where owner_id=$1 order by load_id,item_instance_id',[ownerId])).rows,usages=usageRows.map(row=>{if(!uuid(row.load_id)||!uuid(row.item_instance_id)||!uuid(row.installation_id)||!hex(row.usage_hash)||row.usage_hash!==usageHash(ownerId,row.load_id,row.item_instance_id,row.installation_id)||!ids.has(row.installation_id))throw corrupt();return {loadId:row.load_id,itemInstanceId:row.item_instance_id,installationId:row.installation_id}});return {items,usages}})}
 /**
  * 硬卸载：先锁校验当前选中/加载使用/历史运行引用，再删原生文件，第二次锁校验后按依赖顺序删除记录与安装行并写幂等回执。
  * 文件已删而事务失败时不写回执，同一 requestId 重试会再次做幂等的文件删除并继续完成；服务异常不伪装成功。
  */
 async uninstall(ownerId:string,v:unknown):Promise<SkillUninstallReceipt>{
  if(!text(ownerId,128))throw new WorkError('teloa/forbidden','需要有效的本人身份。')
  const input=uninstallInput(v),spec=uninstallSpec(input),key=stable(['skill-uninstall',ownerId,input.installationId])
  return this.serial(ownerId+':uninstall:'+input.installationId,async()=>{
   let db:PoolClient;try{db=await this.pool.connect()}catch{throw new WorkError('teloa/storage-unavailable','技能卸载存储当前不可用。')}
   let locked=false
   try{
    const prior=await this.readUninstall(db,ownerId,input.requestId)
    if(prior){if(stable(prior.requestSpec)!==stable(spec))throw new WorkError('teloa/conflict','同一技能卸载请求不能更换安装、版本或包摘要。');return prior.result}
    try{await db.query('select pg_advisory_lock(hashtextextended($1,0))',[key])}catch{throw new WorkError('teloa/storage-unavailable','技能卸载锁获取失败。')}
    locked=true
    // 第一段：锁内再次核对幂等回执、安装身份及阻塞项；不删任何记录。
    const prepared=await this.txOn(db,async tx=>{
     const again=await this.readUninstall(tx,ownerId,input.requestId)
     if(again){if(stable(again.requestSpec)!==stable(spec))throw new WorkError('teloa/conflict','同一技能卸载请求不能更换安装、版本或包摘要。');return {receipt:again.result} as const}
     const installation=await this.find(tx,ownerId,input.installationId)
     this.assertUninstallTarget(installation,input)
     const blockers=await this.uninstallBlockers(tx,ownerId,installation)
     if(blockers.length)throw uninstallInUse(blockers)
     return {installation,removedAt:this.identity.now()} as const
    })
    if('receipt' in prepared)return prepared.receipt
    // 文件删除是独立、可重放的副作用：目录不存在视为已成功，数据库失败后允许重新执行本请求。
    try{await this.files.remove(prepared.installation.id)}catch(error){if(error instanceof WorkError)throw error;throw new WorkError('teloa/storage-unavailable','技能原生文件未能删除，请稍后重试。')}
    // 第二段：锁内重新核对（期间可能新增依赖），再按外键依赖顺序删除记录与安装行，最后写回执。
    return await this.txOn(db,async tx=>{
     const installation=await this.find(tx,ownerId,input.installationId)
     this.assertUninstallTarget(installation,input)
     const blockers=await this.uninstallBlockers(tx,ownerId,installation)
     if(blockers.length)throw uninstallInUse(blockers)
     await tx.query('delete from teloa_skill_selection_requests where owner_id=$1 and (current_installation_id=$2 or target_installation_id=$2)',[ownerId,installation.id])
     await tx.query('delete from teloa_skill_install_maintenance_requests where owner_id=$1 and installation_id=$2',[ownerId,installation.id])
     await tx.query('delete from teloa_skill_install_availability where owner_id=$1 and installation_id=$2',[ownerId,installation.id])
     await tx.query('delete from teloa_skill_install_requests where owner_id=$1 and installation_id=$2',[ownerId,installation.id])
     // 唯一版本的当前选择行随安装一并删除（外键先于安装行）；之后同名新安装会重新固定初始选择。
     await tx.query('delete from teloa_skill_selections where owner_id=$1 and installation_id=$2',[ownerId,installation.id])
     const removed=await tx.query('delete from teloa_skill_installations where owner_id=$1 and id=$2 returning id',[ownerId,installation.id])
     if(removed.rowCount!==1)throw corrupt()
     const result:SkillUninstallReceipt={requestId:input.requestId,installationId:installation.id,nativeName:installation.native.name,bundleHash:installation.bundleHash,removedAt:prepared.removedAt}
     await tx.query('insert into teloa_skill_uninstall_requests(owner_id,request_id,installation_id,request_spec,result,created_at) values($1,$2,$3,$4,$5,$6)',[ownerId,input.requestId,installation.id,JSON.stringify(spec),JSON.stringify(result),prepared.removedAt])
     return result
    })
   }finally{
    if(locked)await db.query('select pg_advisory_unlock(hashtextextended($1,0))',[key]).catch(()=>{/* 连接关闭时锁自动释放；解锁失败不能吞掉原结果。 */})
    db.release()
   }
  })
 }
 private assertUninstallTarget(installation:SkillInstallation,input:SkillUninstallRequest){
  if(installation.version!==input.expectedVersion||installation.bundleHash!==input.expectedBundleHash)throw new WorkError('teloa/version-conflict','技能安装已变化，请刷新后重试。')
  if(installation.state!=='installed')throw new WorkError('teloa/conflict','技能安装尚未完成，不能卸载；请先完成安装或继续核对。')
 }
 private async readUninstall(db:PoolClient,ownerId:string,requestId:string){const row=(await db.query('select * from teloa_skill_uninstall_requests where owner_id=$1 and request_id=$2',[ownerId,requestId])).rows[0];return row?readUninstallReceipt(row,ownerId,requestId):undefined}
 private async uninstallBlockers(db:PoolClient,ownerId:string,installation:SkillInstallation):Promise<SkillUninstallBlocker[]>{
  const installationId=installation.id,nativeName=installation.native.name
  const found=new Set<SkillUninstallBlocker>()
  // 当前选中的唯一版本不阻塞硬卸载：否则单版本技能永远卸不掉。只有还存在同 native 名的其它版本时，
  // 才要求本人先切换要保留的版本；卸载成功会连带删除指向本安装的选择行。
  const selected=((await db.query('select 1 from teloa_skill_selections where owner_id=$1 and installation_id=$2 limit 1',[ownerId,installationId])).rowCount??0)>0
  if(selected&&((await db.query('select 1 from teloa_skill_installations where owner_id=$1 and native_name=$2 and id<>$3 limit 1',[ownerId,nativeName,installationId])).rowCount??0)>0)found.add('selected')
  if((await db.query('select 1 from teloa_skill_install_usages where owner_id=$1 and installation_id=$2 limit 1',[ownerId,installationId])).rowCount)found.add('industry-usage')
  if(await tablePresent(db,'teloa_task_run_skill_refs')&&(await db.query('select 1 from teloa_task_run_skill_refs where owner_id=$1 and installation_id=$2 limit 1',[ownerId,installationId])).rowCount)found.add('run-history')
  return uninstallBlockerOrder.filter(blocker=>found.has(blocker))
 }
 private async txOn<T>(db:PoolClient,fn:(db:PoolClient)=>Promise<T>):Promise<T>{
  try{await db.query('begin');const value=await fn(db);await db.query('commit');return value}catch(error){await db.query('rollback').catch(()=>{});if(error instanceof WorkError)throw error;throw new WorkError('teloa/storage-unavailable','技能卸载存储操作未完成。')}
 }
}


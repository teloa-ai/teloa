import {createHash} from 'node:crypto'
import type {Pool,PoolClient} from 'pg'
import {WorkError,isRecord} from '@teloa/contract'
import {readStoredSkillAvailability,type SkillAvailability} from './skill-availability.ts'
import {readStoredSkillInstallation,type SkillInstallation} from './skill-installations.ts'
import {readStoredSkillSelection,type SkillSelection} from './skill-selections.ts'

export type SkillSelectionUsage={loadId:string;itemInstanceId:string}
export type SkillSelectionImpact={
 nativeName:string
 selection:{installationId:string;version:number}
 current:{installationId:string;installationVersion:number;bundleHash:string;availability:SkillAvailability['availability'];availabilityVersion:number}
 target:{installationId:string;installationVersion:number;bundleHash:string;availability:SkillAvailability['availability'];availabilityVersion:number}
 industryUsages:SkillSelectionUsage[]
}
export type SkillSelectionPreview={selection:SkillSelection;current:SkillInstallation;target:SkillInstallation;impact:SkillSelectionImpact;impactDigest:string}
export type SkillSelectionChangeInput={
 requestId:string;nativeName:string;currentInstallationId:string;targetInstallationId:string;expectedSelectionVersion:number;
 expectedCurrentBundleHash:string;expectedTargetBundleHash:string;expectedImpactDigest:string;industryUsages:SkillSelectionUsage[]
}
export type SkillSelectionReceipt={requestId:string;nativeName:string;before:SkillSelection;result:SkillSelection;migratedIndustryUsages:SkillSelectionUsage[];impact:SkillSelectionImpact;impactDigest:string;createdAt:string}
export type SkillSelectionChange={receipt:SkillSelectionReceipt;current:SkillSelection}

const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
const hex=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)
const name=(value:unknown):value is string=>typeof value==='string'&&/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
const positive=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>0&&Number(value)<=2147483647
const order=(a:string,b:string)=>a<b?-1:a>b?1:0
const stable=(value:unknown):string=>JSON.stringify(value,(_,item)=>isRecord(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>order(a,b))):item)
const sha=(value:string)=>createHash('sha256').update(value).digest('hex')
const invalid=()=>new WorkError('teloa/invalid-input','技能版本切换请求格式不正确。')
const corrupt=()=>new WorkError('teloa/storage-corrupt','技能版本选择或切换回执损坏，已停止读取。')
const exact=(value:unknown,keys:readonly string[],stored=false):Record<string,unknown>=>{if(!isRecord(value)||Object.keys(value).some(key=>!keys.includes(key)))throw stored?corrupt():invalid();return value}
const owner=(value:string)=>{if(typeof value!=='string'||!value.trim()||value.length>128)throw new WorkError('teloa/forbidden','需要有效的本人身份。')}
const jsonStamp=(value:unknown)=>{if(typeof value!=='string'||!Number.isFinite(Date.parse(value))||new Date(value).toISOString()!==value)throw corrupt();return value}
const dbStamp=(value:unknown)=>{if(!(value instanceof Date)||!Number.isFinite(value.getTime()))throw corrupt();return value.toISOString()}
const usageKey=(value:SkillSelectionUsage)=>value.loadId+':'+value.itemInstanceId
const usageHash=(ownerId:string,value:SkillSelectionUsage,installationId:string)=>sha(stable([ownerId,value.loadId,value.itemInstanceId,installationId]))

function usage(value:unknown,stored=false):SkillSelectionUsage{
 const row=exact(value,['loadId','itemInstanceId'],stored)
 if(!uuid(row.loadId)||!uuid(row.itemInstanceId))throw stored?corrupt():invalid()
 return {loadId:row.loadId.toLowerCase(),itemInstanceId:row.itemInstanceId.toLowerCase()}
}
function usageList(value:unknown,stored=false):SkillSelectionUsage[]{
 if(!Array.isArray(value)||value.length>1000)throw stored?corrupt():invalid()
 const result=value.map(item=>usage(item,stored)).sort((a,b)=>order(usageKey(a),usageKey(b)))
 if(result.some((item,index)=>index>0&&usageKey(result[index-1]!)===usageKey(item)))throw stored?corrupt():invalid()
 return result
}
function previewInput(value:unknown){const row=exact(value,['currentInstallationId','targetInstallationId']);if(!uuid(row.currentInstallationId)||!uuid(row.targetInstallationId))throw invalid();return {currentInstallationId:row.currentInstallationId.toLowerCase(),targetInstallationId:row.targetInstallationId.toLowerCase()}}
function changeInput(value:unknown):SkillSelectionChangeInput{
 const row=exact(value,['requestId','nativeName','currentInstallationId','targetInstallationId','expectedSelectionVersion','expectedCurrentBundleHash','expectedTargetBundleHash','expectedImpactDigest','industryUsages'])
 if(!uuid(row.requestId)||!name(row.nativeName)||!uuid(row.currentInstallationId)||!uuid(row.targetInstallationId)||!positive(row.expectedSelectionVersion)||!hex(row.expectedCurrentBundleHash)||!hex(row.expectedTargetBundleHash)||!hex(row.expectedImpactDigest))throw invalid()
 return {requestId:row.requestId.toLowerCase(),nativeName:row.nativeName,currentInstallationId:row.currentInstallationId.toLowerCase(),targetInstallationId:row.targetInstallationId.toLowerCase(),expectedSelectionVersion:row.expectedSelectionVersion,expectedCurrentBundleHash:row.expectedCurrentBundleHash,expectedTargetBundleHash:row.expectedTargetBundleHash,expectedImpactDigest:row.expectedImpactDigest,industryUsages:usageList(row.industryUsages)}
}
async function installations(db:PoolClient,ownerId:string,ids:readonly string[],lock=''):Promise<Map<string,SkillInstallation>>{
 const rows=(await db.query(`select * from teloa_skill_installations where id=any($1::uuid[]) order by id ${lock}`,[ids])).rows,result=new Map<string,SkillInstallation>()
 for(const row of rows){if(row.owner_id!==ownerId)throw new WorkError('teloa/forbidden','技能安装不存在或不属于当前本人。');const fixed=readStoredSkillInstallation(row,ownerId);result.set(fixed.id,fixed)}
 if(result.size!==new Set(ids).size)throw new WorkError('teloa/forbidden','技能安装不存在或不属于当前本人。')
 return result
}
async function availabilities(db:PoolClient,ownerId:string,ids:readonly string[],lock=''):Promise<Map<string,SkillAvailability>>{
 const rows=(await db.query(`select * from teloa_skill_install_availability where installation_id=any($1::uuid[]) and owner_id=$2 order by installation_id ${lock}`,[ids,ownerId])).rows,result=new Map<string,SkillAvailability>()
 for(const row of rows){const fixed=readStoredSkillAvailability(row,ownerId);result.set(fixed.installationId,fixed)}
 if(result.size!==new Set(ids).size)throw corrupt()
 return result
}
function readUsageRow(row:Record<string,unknown>,ownerId:string,installationId:string):SkillSelectionUsage{
 if(row.owner_id!==ownerId||row.installation_id!==installationId||!uuid(row.load_id)||!uuid(row.item_instance_id)||!hex(row.usage_hash))throw corrupt()
 const fixed={loadId:row.load_id,itemInstanceId:row.item_instance_id};if(row.usage_hash!==usageHash(ownerId,fixed,installationId))throw corrupt();return fixed
}
async function usageRows(db:PoolClient,ownerId:string,installationId:string,lock=''):Promise<SkillSelectionUsage[]>{
 const rows=(await db.query(`select * from teloa_skill_install_usages where owner_id=$1 and installation_id=$2 order by load_id,item_instance_id limit 1001 ${lock}`,[ownerId,installationId])).rows
 if(rows.length>1000)throw new WorkError('teloa/conflict','技能行业引用超过单次切换上限。')
 return rows.map(row=>readUsageRow(row,ownerId,installationId))
}
function fixedImpact(selection:SkillSelection,current:SkillInstallation,target:SkillInstallation,currentAvailability:SkillAvailability,targetAvailability:SkillAvailability,industryUsages:SkillSelectionUsage[]):SkillSelectionImpact{
 return {nativeName:selection.nativeName,selection:{installationId:selection.installationId,version:selection.version},current:{installationId:current.id,installationVersion:current.version,bundleHash:current.bundleHash,availability:currentAvailability.availability,availabilityVersion:currentAvailability.version},target:{installationId:target.id,installationVersion:target.version,bundleHash:target.bundleHash,availability:targetAvailability.availability,availabilityVersion:targetAvailability.version},industryUsages}
}
export function skillSelectionImpactDigest(value:SkillSelectionImpact){return sha(stable(value))}
function readImpact(value:unknown):SkillSelectionImpact{
 const row=exact(value,['nativeName','selection','current','target','industryUsages'],true),selection=exact(row.selection,['installationId','version'],true),current=exact(row.current,['installationId','installationVersion','bundleHash','availability','availabilityVersion'],true),target=exact(row.target,['installationId','installationVersion','bundleHash','availability','availabilityVersion'],true)
 if(!name(row.nativeName)||!uuid(selection.installationId)||!positive(selection.version))throw corrupt()
 for(const item of [current,target])if(!uuid(item.installationId)||!positive(item.installationVersion)||!hex(item.bundleHash)||!['enabled','disabled'].includes(String(item.availability))||!positive(item.availabilityVersion))throw corrupt()
 const fixedCurrent={installationId:current.installationId as string,installationVersion:current.installationVersion as number,bundleHash:current.bundleHash as string,availability:current.availability as SkillAvailability['availability'],availabilityVersion:current.availabilityVersion as number}
 const fixedTarget={installationId:target.installationId as string,installationVersion:target.installationVersion as number,bundleHash:target.bundleHash as string,availability:target.availability as SkillAvailability['availability'],availabilityVersion:target.availabilityVersion as number}
 return {nativeName:row.nativeName,selection:{installationId:selection.installationId,version:selection.version},current:fixedCurrent,target:fixedTarget,industryUsages:usageList(row.industryUsages,true)}
}
function selectionFromJson(value:unknown,ownerId:string):SkillSelection{
 const row=exact(value,['ownerId','nativeName','installationId','version','updatedAt'],true)
 if(row.ownerId!==ownerId||!name(row.nativeName)||!uuid(row.installationId)||!positive(row.version))throw corrupt()
 return {ownerId,nativeName:row.nativeName,installationId:row.installationId,version:row.version,updatedAt:jsonStamp(row.updatedAt)}
}
function readReceipt(row:Record<string,unknown>,ownerId:string,spec:SkillSelectionChangeInput):SkillSelectionReceipt{
 let stored:SkillSelectionChangeInput;try{stored=changeInput(row.request_spec)}catch{throw corrupt()}
 if(stable(stored)!==stable(spec))throw new WorkError('teloa/conflict','同一技能版本切换请求不能更换目标或行业引用。')
 const impact=readImpact(row.impact_snapshot),resultRow=exact(row.result,['before','result','migratedIndustryUsages'],true),before=selectionFromJson(resultRow.before,ownerId),result=selectionFromJson(resultRow.result,ownerId),migratedIndustryUsages=usageList(resultRow.migratedIndustryUsages,true),createdAt=dbStamp(row.created_at)
 if(row.owner_id!==ownerId||row.request_id!==spec.requestId||row.native_name!==spec.nativeName||row.current_installation_id!==spec.currentInstallationId||row.target_installation_id!==spec.targetInstallationId||!hex(row.impact_digest)||row.impact_digest!==spec.expectedImpactDigest||row.impact_digest!==skillSelectionImpactDigest(impact)||impact.nativeName!==spec.nativeName||impact.selection.installationId!==spec.currentInstallationId||impact.selection.version!==spec.expectedSelectionVersion||impact.current.bundleHash!==spec.expectedCurrentBundleHash||impact.target.installationId!==spec.targetInstallationId||impact.target.bundleHash!==spec.expectedTargetBundleHash||before.installationId!==spec.currentInstallationId||before.version!==spec.expectedSelectionVersion||result.installationId!==spec.targetInstallationId||result.version!==spec.expectedSelectionVersion+1||stable(migratedIndustryUsages)!==stable(spec.industryUsages)||!hex(row.receipt_digest))throw corrupt()
 const receipt={requestId:spec.requestId,nativeName:spec.nativeName,before,result,migratedIndustryUsages,impact,impactDigest:row.impact_digest,createdAt}
 if(row.receipt_digest!==sha(stable([ownerId,receipt])))throw corrupt();return receipt
}

export class SkillSelectionService{
 private readonly pool:Pool
 private readonly identity:{now:()=>string}
 constructor(pool:Pool,identity:{now:()=>string}){this.pool=pool;this.identity=identity}
 private async tx<T>(readOnly:boolean,fn:(db:PoolClient)=>Promise<T>):Promise<T>{const db=await this.pool.connect();try{await db.query(readOnly?'begin isolation level repeatable read read only':'begin');const value=await fn(db);await db.query('commit');return value}catch(error){await db.query('rollback').catch(()=>{});if(error instanceof WorkError)throw error;throw new WorkError('teloa/storage-unavailable','技能版本选择存储操作未完成。')}finally{db.release()}}
 async get(ownerId:string,value:unknown):Promise<SkillSelection>{owner(ownerId);const row=exact(value,['nativeName']);if(!name(row.nativeName))throw invalid();return this.tx(true,async db=>{const found=(await db.query('select * from teloa_skill_selections where owner_id=$1 and native_name=$2',[ownerId,row.nativeName])).rows[0];if(!found)throw new WorkError('teloa/not-found','技能当前版本选择不存在。');return readStoredSkillSelection(found,ownerId)})}
 async preview(ownerId:string,value:unknown):Promise<SkillSelectionPreview>{owner(ownerId);const input=previewInput(value);if(input.currentInstallationId===input.targetInstallationId)throw new WorkError('teloa/conflict','技能目标版本与当前版本相同。');return this.tx(true,async db=>{
  const fixed=await installations(db,ownerId,[input.currentInstallationId,input.targetInstallationId]),current=fixed.get(input.currentInstallationId)!,target=fixed.get(input.targetInstallationId)!
  if(current.native.name!==target.native.name)throw new WorkError('teloa/conflict','技能目标版本的原生名称与当前版本不一致。')
  const row=(await db.query('select * from teloa_skill_selections where owner_id=$1 and native_name=$2',[ownerId,current.native.name])).rows[0];if(!row)throw corrupt();const selection=readStoredSkillSelection(row,ownerId)
  if(selection.installationId!==current.id)throw new WorkError('teloa/version-conflict','技能当前选择已变化，请刷新后重试。')
  const states=await availabilities(db,ownerId,[current.id,target.id]);if(current.state!=='installed'||target.state!=='installed')throw new WorkError('teloa/conflict','技能当前版本或目标版本尚未完成安装。');if(states.get(target.id)!.availability!=='enabled')throw new WorkError('teloa/conflict','技能目标版本已停用，请先恢复后再切换。')
  const impact=fixedImpact(selection,current,target,states.get(current.id)!,states.get(target.id)!,await usageRows(db,ownerId,current.id));return {selection,current,target,impact,impactDigest:skillSelectionImpactDigest(impact)}
 })}
 async change(ownerId:string,value:SkillSelectionChangeInput):Promise<SkillSelectionChange>{owner(ownerId);const spec=changeInput(value),now=this.identity.now();if(!Number.isFinite(Date.parse(now))||new Date(now).toISOString()!==now)throw invalid();if(spec.currentInstallationId===spec.targetInstallationId)throw new WorkError('teloa/conflict','技能目标版本与当前版本相同。');return this.tx(false,async db=>{
  await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[stable(['skill-selection-request',ownerId,spec.requestId])])
  const prior=(await db.query('select * from teloa_skill_selection_requests where owner_id=$1 and request_id=$2',[ownerId,spec.requestId])).rows[0]
  if(prior){const receipt=readReceipt(prior,ownerId,spec),row=(await db.query('select * from teloa_skill_selections where owner_id=$1 and native_name=$2',[ownerId,spec.nativeName])).rows[0];if(!row)throw corrupt();const current=readStoredSkillSelection(row,ownerId);if(current.version<receipt.result.version||current.version===receipt.result.version&&stable(current)!==stable(receipt.result))throw corrupt();return {receipt,current}}
  await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[stable(['skill-install-name',ownerId,spec.nativeName])])
  const selectionRow=(await db.query('select * from teloa_skill_selections where owner_id=$1 and native_name=$2 for update',[ownerId,spec.nativeName])).rows[0];if(!selectionRow)throw corrupt();const selection=readStoredSkillSelection(selectionRow,ownerId)
  if(selection.installationId!==spec.currentInstallationId||selection.version!==spec.expectedSelectionVersion)throw new WorkError('teloa/version-conflict','技能当前选择已变化，请重新预览。')
  if(selection.version===2147483647)throw new WorkError('teloa/conflict','技能选择版本已达到上限。')
  const fixed=await installations(db,ownerId,[spec.currentInstallationId,spec.targetInstallationId],'for share'),current=fixed.get(spec.currentInstallationId)!,target=fixed.get(spec.targetInstallationId)!
  if(current.native.name!==spec.nativeName||target.native.name!==spec.nativeName)throw new WorkError('teloa/conflict','技能版本原生名称与选择名称不一致。')
  if(current.state!=='installed'||target.state!=='installed')throw new WorkError('teloa/conflict','技能当前版本或目标版本尚未完成安装。')
  if(current.bundleHash!==spec.expectedCurrentBundleHash||target.bundleHash!==spec.expectedTargetBundleHash)throw new WorkError('teloa/version-conflict','技能安装包摘要已变化，请重新预览。')
  const states=await availabilities(db,ownerId,[current.id,target.id],'for share');if(states.get(target.id)!.availability!=='enabled')throw new WorkError('teloa/conflict','技能目标版本已停用，请先恢复后再切换。')
  const allUsages=await usageRows(db,ownerId,current.id,'for update'),impact=fixedImpact(selection,current,target,states.get(current.id)!,states.get(target.id)!,allUsages),impactDigest=skillSelectionImpactDigest(impact)
  if(impactDigest!==spec.expectedImpactDigest)throw new WorkError('teloa/version-conflict','技能版本或行业引用已变化，请重新预览。')
  const available=new Set(allUsages.map(usageKey));if(spec.industryUsages.some(item=>!available.has(usageKey(item))))throw new WorkError('teloa/version-conflict','待迁移的行业引用已变化，请重新预览。')
  const updated=(await db.query('update teloa_skill_selections set installation_id=$3,version=version+1,updated_at=$4 where owner_id=$1 and native_name=$2 and installation_id=$5 and version=$6 returning *',[ownerId,spec.nativeName,target.id,now,current.id,selection.version])).rows[0];if(!updated)throw new WorkError('teloa/version-conflict','技能当前选择已变化，请重新预览。');const result=readStoredSkillSelection(updated,ownerId)
  for(const item of spec.industryUsages){const changed=await db.query('update teloa_skill_install_usages set installation_id=$4,usage_hash=$5 where owner_id=$1 and load_id=$2 and item_instance_id=$3 and installation_id=$6',[ownerId,item.loadId,item.itemInstanceId,target.id,usageHash(ownerId,item,target.id),current.id]);if(changed.rowCount!==1)throw new WorkError('teloa/version-conflict','待迁移的行业引用已变化，请重新预览。')}
  const receipt:SkillSelectionReceipt={requestId:spec.requestId,nativeName:spec.nativeName,before:selection,result,migratedIndustryUsages:spec.industryUsages,impact,impactDigest,createdAt:now},receiptDigest=sha(stable([ownerId,receipt]))
  await db.query('insert into teloa_skill_selection_requests(owner_id,request_id,native_name,current_installation_id,target_installation_id,request_spec,impact_snapshot,impact_digest,result,receipt_digest,created_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[ownerId,spec.requestId,spec.nativeName,current.id,target.id,JSON.stringify(spec),JSON.stringify(impact),impactDigest,JSON.stringify({before:selection,result,migratedIndustryUsages:spec.industryUsages}),receiptDigest,now])
  return {receipt,current:result}
 })}
}

import type {SkillSelectionService} from '@teloa/backend'
import {WorkError,taskInput} from '@teloa/contract'

export const skillSelectionEndpoints=['skill-selections/get','skill-selections/preview','skill-selections/change'] as const
type Ports=Pick<SkillSelectionService,'get'|'preview'|'change'>
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
const hash=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)
const name=(value:unknown):value is string=>typeof value==='string'&&/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
const positive=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>0&&Number(value)<=2147483647
const invalid=()=>new WorkError('teloa/invalid-input','技能版本选择请求格式不正确。')
const bad=()=>new WorkError('teloa/invalid-host-response','技能版本选择返回身份不一致。')
const usage=(value:unknown)=>{const row=taskInput(value,['loadId','itemInstanceId']);if(!uuid(row.loadId)||!uuid(row.itemInstanceId))throw invalid();return {loadId:row.loadId.toLowerCase(),itemInstanceId:row.itemInstanceId.toLowerCase()}}
type Selection={ownerId:string;nativeName:string;installationId:string;version:number;updatedAt:string}
function selection(value:unknown,owner:string,nativeName:string):Selection{const row=taskInput(value,['ownerId','nativeName','installationId','version','updatedAt']);if(row.ownerId!==owner||row.nativeName!==nativeName||!uuid(row.installationId)||!positive(row.version)||typeof row.updatedAt!=='string'||!Number.isFinite(Date.parse(row.updatedAt)))throw bad();return {ownerId:row.ownerId,nativeName:row.nativeName,installationId:row.installationId,version:row.version,updatedAt:row.updatedAt}}

export function createSkillSelectionHandler(owner:string,get:()=>Promise<Ports>){return async(method:string,payload:unknown)=>{
 if(!(skillSelectionEndpoints as readonly string[]).includes(method))throw new WorkError('teloa/not-found','未提供此技能版本选择接口。')
 if(method==='skill-selections/get'){
  const row=taskInput(payload,['nativeName']);if(!name(row.nativeName))throw invalid();const result=await(await get()).get(owner,{nativeName:row.nativeName});selection(result,owner,row.nativeName);return result
 }
 if(method==='skill-selections/preview'){
  const row=taskInput(payload,['currentInstallationId','targetInstallationId']);if(!uuid(row.currentInstallationId)||!uuid(row.targetInstallationId))throw invalid();const currentInstallationId=row.currentInstallationId.toLowerCase(),targetInstallationId=row.targetInstallationId.toLowerCase(),result=await(await get()).preview(owner,{currentInstallationId,targetInstallationId})
  const selected=selection(result.selection,owner,result.current.native.name)
  if(result.current.id!==currentInstallationId||result.current.ownerId!==owner||result.target.id!==targetInstallationId||result.target.ownerId!==owner||result.current.native.name!==result.target.native.name||selected.installationId!==currentInstallationId||result.impact.nativeName!==selected.nativeName||result.impact.selection.installationId!==currentInstallationId||result.impact.selection.version!==selected.version||result.impact.current.installationId!==currentInstallationId||result.impact.current.bundleHash!==result.current.bundleHash||result.impact.target.installationId!==targetInstallationId||result.impact.target.bundleHash!==result.target.bundleHash||!hash(result.impactDigest))throw bad()
  return result
 }
 const row=taskInput(payload,['requestId','nativeName','currentInstallationId','targetInstallationId','expectedSelectionVersion','expectedCurrentBundleHash','expectedTargetBundleHash','expectedImpactDigest','industryUsages'])
 if(!uuid(row.requestId)||!name(row.nativeName)||!uuid(row.currentInstallationId)||!uuid(row.targetInstallationId)||!positive(row.expectedSelectionVersion)||!hash(row.expectedCurrentBundleHash)||!hash(row.expectedTargetBundleHash)||!hash(row.expectedImpactDigest)||!Array.isArray(row.industryUsages)||row.industryUsages.length>1000)throw invalid()
 const request={requestId:row.requestId.toLowerCase(),nativeName:row.nativeName,currentInstallationId:row.currentInstallationId.toLowerCase(),targetInstallationId:row.targetInstallationId.toLowerCase(),expectedSelectionVersion:row.expectedSelectionVersion,expectedCurrentBundleHash:row.expectedCurrentBundleHash,expectedTargetBundleHash:row.expectedTargetBundleHash,expectedImpactDigest:row.expectedImpactDigest,industryUsages:row.industryUsages.map(usage)},result=await(await get()).change(owner,request),receipt=result.receipt,before=selection(receipt.before,owner,request.nativeName),changed=selection(receipt.result,owner,request.nativeName),current=selection(result.current,owner,request.nativeName)
 if(receipt.requestId!==request.requestId||receipt.nativeName!==request.nativeName||before.installationId!==request.currentInstallationId||before.version!==request.expectedSelectionVersion||changed.installationId!==request.targetInstallationId||changed.version!==request.expectedSelectionVersion+1||receipt.impactDigest!==request.expectedImpactDigest||receipt.impact.current.bundleHash!==request.expectedCurrentBundleHash||receipt.impact.target.bundleHash!==request.expectedTargetBundleHash||JSON.stringify(receipt.migratedIndustryUsages)!==JSON.stringify([...request.industryUsages].sort((a,b)=>(a.loadId+':'+a.itemInstanceId).localeCompare(b.loadId+':'+b.itemInstanceId)))||current.version<changed.version)throw bad()
 return result
}}

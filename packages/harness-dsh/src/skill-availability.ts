import type {SkillAvailabilityService} from '@teloa/backend'
import {WorkError,taskInput} from '@teloa/contract'
export const skillAvailabilityEndpoints=['skill-availability/get','skill-availability/preview','skill-availability/change'] as const
type Ports=Pick<SkillAvailabilityService,'get'|'preview'|'change'>
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
const hash=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)
const positive=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>0&&Number(value)<=2147483647
const invalid=()=>new WorkError('teloa/invalid-input','技能启停请求格式不正确。')
const bad=()=>new WorkError('teloa/invalid-host-response','技能启停返回身份不一致。')
const validState=(value:Awaited<ReturnType<Ports['get']>>,owner:string,id:string)=>{
 if(value.installationId!==id||value.ownerId!==owner||!['enabled','disabled'].includes(value.availability)||!positive(value.version)||typeof value.updatedAt!=='string'||!Number.isFinite(Date.parse(value.updatedAt)))throw bad()
}
export function createSkillAvailabilityHandler(owner:string,get:()=>Promise<Ports>){return async(method:string,payload:unknown)=>{
 if(!(skillAvailabilityEndpoints as readonly string[]).includes(method))throw new WorkError('teloa/not-found','未提供此技能启停接口。')
 const row=taskInput(payload,method==='skill-availability/change'?['requestId','installationId','expectedVersion','expectedBundleHash','expectedImpactDigest','action','reason']:['installationId'])
 if(!uuid(row.installationId))throw invalid()
 const installationId=row.installationId.toLowerCase()
 if(method==='skill-availability/get'){const result=await(await get()).get(owner,{installationId});validState(result,owner,installationId);return result}
 if(method==='skill-availability/preview'){
  const result=await(await get()).preview(owner,{installationId});validState(result.availability,owner,installationId)
  if(result.installation.id!==installationId||result.installation.ownerId!==owner||result.impact.installation.id!==installationId||result.impact.installation.version!==result.installation.version||result.impact.installation.nativeName!==result.installation.native.name||result.impact.installation.bundleHash!==result.installation.bundleHash||result.impact.availability.version!==result.availability.version||result.impact.availability.value!==result.availability.availability||!hash(result.impactDigest))throw bad()
  return result
 }
 if(!uuid(row.requestId)||!positive(row.expectedVersion)||!hash(row.expectedBundleHash)||!hash(row.expectedImpactDigest)||!['disable','enable'].includes(String(row.action))||row.reason!==undefined&&(typeof row.reason!=='string'||row.reason.trim().length>4000))throw invalid()
 const request={requestId:row.requestId.toLowerCase(),installationId,expectedVersion:row.expectedVersion,expectedBundleHash:row.expectedBundleHash,expectedImpactDigest:row.expectedImpactDigest,action:row.action as 'disable'|'enable',...(typeof row.reason==='string'?{reason:row.reason.trim()}:{})}
 const result=await(await get()).change(owner,request),receipt=result.receipt
 validState(result.current,owner,installationId);validState(receipt.result,owner,installationId)
 if(receipt.requestId!==request.requestId||receipt.installationId!==installationId||receipt.action!==request.action||receipt.reason!==(request.reason??'')||receipt.impactDigest!==request.expectedImpactDigest||receipt.impact.installation.id!==installationId||receipt.impact.installation.bundleHash!==request.expectedBundleHash||receipt.impact.availability.version!==request.expectedVersion||receipt.result.version!==request.expectedVersion+1||receipt.result.availability!==(request.action==='disable'?'disabled':'enabled')||result.current.version<receipt.result.version||result.current.version===receipt.result.version&&(result.current.availability!==receipt.result.availability||result.current.updatedAt!==receipt.result.updatedAt))throw bad()
 return result
}}
